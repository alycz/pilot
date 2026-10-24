import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AccountLinesRequest,
  AccountLinesResponse,
  Payment,
  ServerInfoRequest,
  ServerInfoResponse,
} from "xrpl";

import {
  createFundHandler,
  toLedgerCurrencyCode,
  type FundingClient,
  type FundHandlerDependencies,
} from "./handler";

const RECIPIENT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const OTHER_RECIPIENT = "r3vi7mWxru9rJCxETCyA1CHvzL96eZWx5z";
const ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const MARKET_MAKER = "rHpXfibHgSb64n8kK9QWDpdbfqSpYbM9a4";
const RLUSD_HEX = "524C555344000000000000000000000000000000";

function request(body: unknown): Request {
  return new Request("http://localhost/api/dev/fund", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

function accountLines(lines: AccountLinesResponse["result"]["lines"]): AccountLinesResponse {
  return {
    id: 1,
    type: "response",
    result: { account: RECIPIENT, lines },
  } as AccountLinesResponse;
}

function makeHarness(options?: {
  accountLines?: AccountLinesResponse;
  env?: NodeJS.ProcessEnv;
  networkId?: number;
  now?: () => number;
  submitGate?: Promise<void>;
}) {
  let payment: Payment | undefined;
  let accountLinesReads = 0;
  let submitCalls = 0;
  let signingCalls = 0;
  let clientCreations = 0;
  let clientEndpoint: string | undefined;

  const response =
    options?.accountLines ??
    accountLines([
      {
        account: ISSUER,
        balance: "0",
        currency: RLUSD_HEX,
        limit: "100000",
        limit_peer: "0",
        quality_in: 0,
        quality_out: 0,
      },
    ]);

  const dependencies: Partial<FundHandlerDependencies> = {
    authorize: () => true,
    env:
      options?.env ??
      {
        NODE_ENV: "test",
        MM_WALLET_SEED: "test-only-seed",
        STABLE_CODE: "RLUSD",
        STABLE_ISSUER_TESTNET: ISSUER,
        XRPL_TESTNET_URL: "wss://configured-testnet.example",
      },
    isValidAddress: (value) => value.startsWith("r"),
    now: options?.now ?? (() => 1_000_000),
    walletFromSeed: () => ({
      classicAddress: MARKET_MAKER,
      sign: () => {
        signingCalls += 1;
        return { hash: "SIGNED_HASH", tx_blob: "signed-blob" };
      },
    }),
    createClient: (endpoint) => {
      clientCreations += 1;
      clientEndpoint = endpoint;
      return {
        connect: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => undefined),
        request: vi.fn(
          async (request: AccountLinesRequest | ServerInfoRequest) => {
            if (request.command === "server_info") {
              return {
                result: { info: { network_id: options?.networkId ?? 1 } },
              } as ServerInfoResponse;
            }

            accountLinesReads += 1;
            return response;
          },
        ) as FundingClient["request"],
        autofill: vi.fn(async (transaction: Payment) => {
          payment = transaction;
          return transaction;
        }),
        submitAndWait: vi.fn(async () => {
          submitCalls += 1;
          await options?.submitGate;
          return {
            result: {
              hash: "VALIDATED_HASH",
              validated: true,
              meta: { TransactionResult: "tesSUCCESS" },
            },
          };
        }),
      };
    },
  };

  return {
    handler: createFundHandler(dependencies),
    get accountLinesReads() {
      return accountLinesReads;
    },
    get clientCreations() {
      return clientCreations;
    },
    get clientEndpoint() {
      return clientEndpoint;
    },
    get payment() {
      return payment;
    },
    get submitCalls() {
      return submitCalls;
    },
    get signingCalls() {
      return signingCalls;
    },
  };
}

describe("POST /api/dev/fund", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("requires authorization before reading configuration or signing", async () => {
    const harness = makeHarness();
    const handler = createFundHandler({
      authorize: () => false,
      createClient: () => {
        throw new Error("must not create client");
      },
    });

    const response = await handler(request({ address: RECIPIENT, network: "testnet" }));

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("UNAUTHORIZED");
    expect(harness.signingCalls).toBe(0);
  });

  it("refuses mainnet before creating an XRPL client", async () => {
    const harness = makeHarness();
    const response = await harness.handler(request({ address: RECIPIENT, network: "mainnet" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "UNSUPPORTED_NETWORK",
        message: "Funding is available only on testnet and devnet.",
      },
    });
    expect(harness.clientCreations).toBe(0);
  });

  it("requires a valid classic address", async () => {
    const harness = makeHarness();
    const response = await harness.handler(request({ address: "not-an-address", network: "testnet" }));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_ADDRESS");
    expect(harness.clientCreations).toBe(0);
  });

  it("requires explicit devnet stablecoin configuration", async () => {
    const harness = makeHarness();
    const response = await harness.handler(request({ address: RECIPIENT, network: "devnet" }));

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("FUNDING_NOT_CONFIGURED");
    expect(harness.clientCreations).toBe(0);
  });

  it("prefers the network-specific stablecoin code", async () => {
    const harness = makeHarness({
      env: {
        NODE_ENV: "test",
        MM_WALLET_SEED: "test-only-seed",
        STABLE_CODE: "tUSD",
        STABLE_CODE_TESTNET: "RLUSD",
        STABLE_ISSUER_TESTNET: ISSUER,
      },
    });
    const response = await harness.handler(request({ address: RECIPIENT, network: "testnet" }));

    expect(response.status).toBe(200);
    expect((await response.json()).amount.currency).toBe("RLUSD");
  });

  it.each([0, 2])(
    "rejects testnet endpoint network_id %s before trust-line reads or signing",
    async (networkId) => {
      const harness = makeHarness({ networkId });
      const response = await harness.handler(
        request({ address: RECIPIENT, network: "testnet" }),
      );

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: {
          code: "LEDGER_NETWORK_MISMATCH",
          message:
            "The configured XRPL endpoint is not connected to the requested test network.",
        },
      });
      expect(harness.accountLinesReads).toBe(0);
      expect(harness.clientEndpoint).toBe("wss://configured-testnet.example");
      expect(harness.signingCalls).toBe(0);
      expect(harness.submitCalls).toBe(0);
    },
  );

  it("requires the recipient to have the configured stablecoin trust line", async () => {
    const harness = makeHarness({ accountLines: accountLines([]) });
    const response = await harness.handler(request({ address: RECIPIENT, network: "testnet" }));

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("TRUST_LINE_REQUIRED");
    expect(harness.submitCalls).toBe(0);

    const repeated = await harness.handler(
      request({ address: RECIPIENT, network: "testnet" }),
    );
    expect(repeated.status).toBe(429);
  });

  it("sends exactly 1,000 issued tokens and returns only public transaction data", async () => {
    const harness = makeHarness();
    const response = await harness.handler(request({ address: RECIPIENT, network: "testnet" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(harness.payment).toEqual({
      TransactionType: "Payment",
      Account: MARKET_MAKER,
      Destination: RECIPIENT,
      Amount: {
        currency: RLUSD_HEX,
        issuer: ISSUER,
        value: "1000",
      },
    });
    expect(body).toEqual({
      funded: true,
      address: RECIPIENT,
      network: "testnet",
      amount: { currency: "RLUSD", issuer: ISSUER, value: "1000" },
      txHash: "VALIDATED_HASH",
    });
    expect(JSON.stringify(body)).not.toContain("test-only-seed");
  });

  it("rate limits a funded address for ten minutes", async () => {
    let now = 1_000_000;
    const harness = makeHarness({ now: () => now });

    expect(
      (await harness.handler(request({ address: RECIPIENT, network: "testnet" }))).status,
    ).toBe(200);

    now += 1000;
    const limited = await harness.handler(request({ address: RECIPIENT, network: "testnet" }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("599");
    expect((await limited.json()).error.code).toBe("RATE_LIMITED");
    expect(harness.submitCalls).toBe(1);

    now += 599_000;
    expect(
      (await harness.handler(request({ address: RECIPIENT, network: "testnet" }))).status,
    ).toBe(200);
    expect(harness.submitCalls).toBe(2);
  });

  it("atomically rejects a concurrent request for the same address", async () => {
    let releaseSubmit!: () => void;
    const submitGate = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });
    const harness = makeHarness({ submitGate });

    const first = harness.handler(request({ address: OTHER_RECIPIENT, network: "testnet" }));
    await vi.waitFor(() => expect(harness.submitCalls).toBe(1));

    const second = await harness.handler(
      request({ address: OTHER_RECIPIENT, network: "testnet" }),
    );
    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).toBe("1");
    expect(harness.submitCalls).toBe(1);

    releaseSubmit();
    expect((await first).status).toBe(200);
  });
});

describe("toLedgerCurrencyCode", () => {
  it("encodes non-standard currency codes as 160-bit uppercase hex", () => {
    expect(toLedgerCurrencyCode("RLUSD")).toBe(RLUSD_HEX);
    expect(toLedgerCurrencyCode("tUSD")).toBe(
      "7455534400000000000000000000000000000000",
    );
  });

  it("preserves standard three-character codes", () => {
    expect(toLedgerCurrencyCode("USD")).toBe("USD");
  });
});
