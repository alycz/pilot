import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Network } from "../src/contracts";
import {
  BuildValidationError,
  MAINNET_RLUSD_ISSUER,
  RLUSD_HEX_CURRENCY,
  TESTNET_RLUSD_ISSUER,
  autofillUnsignedTransaction,
  buildTransaction,
  checkExpiry,
  checkFlagConflicts,
  checkReserve,
  clearUsdMidCache,
  estimateUsdValue,
  hasPreflightFailures,
  revalidateStoredBuild,
  tagPreparedTransaction,
  type BuildContext,
  type BuildStore,
} from "../src/exec/build";
import type { BuildInsert } from "../src/exec/store";

const OWNER = "rBuildOwnerFixture";
const ISSUER = "rIssuerFixture";

type FixtureOptions = {
  lines?: Record<string, unknown>[];
  issuerFlags?: number;
  ownerBalance?: string;
  ownerCount?: number;
  permissions?: string[];
  simulateEngine?: string;
};

function fixtures(options: FixtureOptions = {}) {
  const inserted: BuildInsert[] = [];
  const store: BuildStore = {
    insertBuild: vi.fn(async (row: BuildInsert) => {
      inserted.push(row);
      return row;
    }),
    getLink: vi.fn(async () => ({
      permissions: options.permissions ?? ["OfferCreate"],
    })),
  };
  const request = vi.fn(
    async (
      network: Network,
      command: string,
      params: Readonly<Record<string, unknown>> = {},
    ): Promise<Record<string, unknown>> => {
      if (command === "account_info") {
        const account = params.account;
        if (account === ISSUER) {
          return {
            account_data: {
              Account: ISSUER,
              Balance: "100000000",
              OwnerCount: 0,
              Sequence: 2,
              Flags: options.issuerFlags ?? 0,
            },
            ledger_index: 100,
          };
        }
        return {
          account_data: {
            Account: OWNER,
            Balance: options.ownerBalance ?? "50000000",
            OwnerCount: options.ownerCount ?? 1,
            Sequence: 7,
            Flags: 0,
          },
          ledger_index: 100,
        };
      }
      if (command === "server_info") {
        return {
          info: {
            validated_ledger: {
              seq: 100,
              reserve_base_xrp: 10,
              reserve_inc_xrp: 2,
            },
          },
        };
      }
      if (command === "account_lines") {
        return {
          account: OWNER,
          lines:
            options.lines ??
            [{ account: ISSUER, currency: "USD", peer_authorized: true }],
        };
      }
      if (command === "fee") {
        return {
          drops: { open_ledger_fee: "12" },
          ledger_current_index: 101,
        };
      }
      if (command === "simulate") {
        expect(params).toHaveProperty("tx_json");
        expect(params).not.toHaveProperty("tx_blob");
        return {
          engine_result: options.simulateEngine ?? "tesSUCCESS",
          engine_result_message: "The simulated transaction would apply.",
          applied: false,
          tx_blob: "fixture response blob that must never escape",
        };
      }
      if (command === "book_offers") {
        expect(network).toBe("mainnet");
        const gets = params.taker_gets as Record<string, unknown>;
        return gets.currency === "XRP"
          ? {
              offers: [
                {
                  TakerGets: "1000000",
                  TakerPays: {
                    currency: RLUSD_HEX_CURRENCY,
                    issuer: MAINNET_RLUSD_ISSUER,
                    value: "0.51",
                  },
                },
              ],
            }
          : {
              offers: [
                {
                  TakerGets: {
                    currency: RLUSD_HEX_CURRENCY,
                    issuer: MAINNET_RLUSD_ISSUER,
                    value: "0.49",
                  },
                  TakerPays: "1000000",
                },
              ],
            };
      }
      throw new Error(`unexpected fixture command ${command}`);
    },
  );
  const ctx: BuildContext = {
    principal: "build-core-unit-test",
    sourceTag: 3_141_592,
    xrplRpc: { request },
    store,
  };
  return { ctx, request, store, inserted };
}

function offerTx() {
  return {
    TransactionType: "OfferCreate",
    Account: OWNER,
    TakerGets: "2000000",
    TakerPays: { currency: "USD", issuer: ISSUER, value: "1" },
    Flags: 0x0002_0000,
  };
}

describe("transaction build core", () => {
  beforeEach(() => clearUsdMidCache());

  it("validates, preflights, autofills, simulates, tags, and principal-stores an unsigned build", async () => {
    const { ctx, request, inserted } = fixtures();
    const result = await buildTransaction(ctx, {
      network: "testnet",
      owner: OWNER,
      tx_json: offerTx(),
      action: "sell XRP for USD",
      amounts: ["2000000", "1 USD"],
      intent_id: "intent-42",
      build_id: "build-42",
      valuation_amounts: ["2000000"],
      preflight: {
        trustLines: [{ currency: "USD", issuer: ISSUER }],
        reserveDeltaDrops: "2000000",
      },
    });

    expect(result).toMatchObject({
      build_id: "build-42",
      network: "testnet",
      delegable: true,
      simulate: {
        engine_result: "tesSUCCESS",
        applied: false,
      },
      summary: {
        fee_drops: "12",
        reserve_delta_drops: "2000000",
        usd_value: "1",
      },
    });
    expect(result.tx_json).toMatchObject({
      Sequence: 7,
      Fee: "12",
      LastLedgerSequence: 104,
      SourceTag: 3_141_592,
      Memos: [
        {
          Memo: {
            MemoType: "70696C6F742F696E74656E74",
            MemoData: "696E74656E742D3432",
          },
        },
      ],
    });
    expect(hasPreflightFailures(result.preflight)).toBe(false);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      id: "build-42",
      owner: OWNER,
      network: "testnet",
      lastLedgerSeq: 104,
      summary: { reserve_delta_drops: "2000000" },
    });
    const serialized = JSON.stringify({ result, inserted });
    expect(serialized).not.toMatch(
      /SigningPubKey|TxnSignature|Signers|tx_blob|txBlob|Delegate/,
    );
    expect(
      request.mock.calls.filter((call) => call[1] === "book_offers"),
    ).toHaveLength(2);
  });

  it("returns a typed missing-trust-line preflight failure and still simulates and stores", async () => {
    const { ctx, inserted } = fixtures({ lines: [] });
    const build = await buildTransaction(ctx, {
      network: "testnet",
      owner: OWNER,
      tx_json: offerTx(),
      action: "offer",
      amounts: ["2000000", "1 USD"],
      build_id: "missing-line",
      preflight: {
        trustLines: [{ currency: "USD", issuer: ISSUER }],
      },
    });

    expect(build.preflight).toContainEqual({
      check: "trust-line",
      pass: false,
      detail: `MISSING_TRUST_LINE: USD:${ISSUER}`,
    });
    expect(hasPreflightFailures(build.preflight)).toBe(true);
    expect(build.simulate.engine_result).toBe("tesSUCCESS");
    expect(inserted).toHaveLength(1);
  });

  it("represents a RequireAuth issuer without peer authorization as preflight data", async () => {
    const { ctx } = fixtures({
      issuerFlags: 0x0004_0000,
      lines: [{ account: ISSUER, currency: "USD" }],
    });
    const build = await buildTransaction(ctx, {
      network: "testnet",
      owner: OWNER,
      tx_json: offerTx(),
      action: "offer",
      amounts: [],
      build_id: "require-auth",
      preflight: {
        trustLines: [{ currency: "USD", issuer: ISSUER }],
      },
    });
    expect(build.preflight).toContainEqual({
      check: "require-auth",
      pass: false,
      detail: `REQUIRE_AUTH_NOT_AUTHORIZED: USD:${ISSUER}`,
    });
  });

  it("derives delegability from the stored link, not requested booleans or permissions", async () => {
    const { ctx } = fixtures({ permissions: [] });
    const build = await buildTransaction(ctx, {
      network: "testnet",
      owner: OWNER,
      tx_json: offerTx(),
      action: "offer",
      amounts: [],
      build_id: "not-granted",
      delegable: true,
      permissions: ["OfferCreate"],
      preflight: { trustLines: [] },
    });
    expect(build.delegable).toBe(false);
  });

  it("keeps inherently non-delegable transactions false even if a link claims permission", async () => {
    const { ctx } = fixtures({ permissions: ["Payment"] });
    const build = await buildTransaction(ctx, {
      network: "testnet",
      owner: OWNER,
      tx_json: {
        TransactionType: "Payment",
        Account: OWNER,
        Destination: "rDestinationFixture",
        Amount: "1",
      },
      action: "payment",
      amounts: ["1"],
      build_id: "payment",
      preflight: { trustLines: [] },
    });
    expect(build.delegable).toBe(false);
  });

  it("rejects mainnet builder input without making RPC or store calls", async () => {
    const { ctx, request, store } = fixtures();
    await expect(
      buildTransaction(ctx, {
        network: "mainnet",
        owner: OWNER,
        tx_json: offerTx(),
        action: "offer",
        amounts: [],
      }),
    ).rejects.toMatchObject({
      name: "BuildValidationError",
      code: "MAINNET_EXECUTION_DISABLED",
    });
    expect(request).not.toHaveBeenCalled();
    expect(store.insertBuild).not.toHaveBeenCalled();
  });

  it.each([
    ["SigningPubKey", ""],
    ["TxnSignature", "00"],
    ["Signers", []],
    ["Signature", "00"],
    ["SponsorSignature", {}],
    ["CounterpartySignature", "00"],
    ["tx_blob", "00"],
    ["txBlob", "00"],
    ["Delegate", "rDelegateFixture"],
  ])("rejects forbidden unsigned-build field %s", async (field, value) => {
    const { ctx, request } = fixtures();
    await expect(
      buildTransaction(ctx, {
        network: "testnet",
        owner: OWNER,
        tx_json: { ...offerTx(), [field]: value },
        action: "offer",
        amounts: [],
      }),
    ).rejects.toBeInstanceOf(BuildValidationError);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects sensitive keys recursively and bounds the canonical intent memo", async () => {
    const { ctx } = fixtures();
    await expect(
      buildTransaction(ctx, {
        network: "testnet",
        owner: OWNER,
        tx_json: { ...offerTx(), nested: { private_note: "x" } },
        action: "offer",
        amounts: [],
      }),
    ).rejects.toMatchObject({ code: "SENSITIVE_ARGUMENT" });
    expect(() =>
      tagPreparedTransaction(offerTx(), 1, "x".repeat(257)),
    ).toThrow(/256 UTF-8 bytes/);
  });

  it("reads network reserve values and reports insufficient reserve", async () => {
    const { ctx } = fixtures({ ownerBalance: "11999999", ownerCount: 1 });
    const check = await checkReserve(ctx, "testnet", OWNER, "0");
    expect(check).toEqual({
      check: "reserve",
      pass: false,
      detail: "INSUFFICIENT_RESERVE: requires 12000012 drops; balance 11999999",
    });
  });

  it("includes XRP spend and the open-ledger fee in reserve preflight", async () => {
    const { ctx } = fixtures({ ownerBalance: "13000011", ownerCount: 1 });
    const check = await checkReserve(
      ctx,
      "testnet",
      OWNER,
      "0",
      "1000000",
    );
    expect(check).toMatchObject({
      check: "reserve",
      pass: false,
      detail: expect.stringContaining("requires 13000012 drops"),
    });
  });

  it("checks expiration and conflicting flags deterministically", () => {
    const now = new Date("2026-10-18T00:00:00.000Z");
    expect(checkExpiry("2026-10-17T23:59:59.000Z", now)).toMatchObject({
      check: "expiry",
      pass: false,
    });
    expect(
      checkFlagConflicts([
        {
          name: "exclusive modes",
          flags: 0x0006_0000,
          masks: [0x0002_0000, 0x0004_0000],
        },
      ]),
    ).toEqual({
      check: "flag-conflicts",
      pass: false,
      detail: "FLAG_CONFLICT: exclusive modes",
    });
  });

  it("autofills only missing common fields from account and fee reads", async () => {
    const { ctx, request } = fixtures();
    const filled = await autofillUnsignedTransaction(ctx, "testnet", {
      TransactionType: "OfferCancel",
      Account: OWNER,
      OfferSequence: 3,
      Sequence: 9,
      Fee: "20",
      LastLedgerSequence: 222,
    });
    expect(filled).toMatchObject({ Sequence: 9, Fee: "20", LastLedgerSequence: 222 });
    expect(request).not.toHaveBeenCalled();
  });

  it("caches fixture-backed mainnet XRP/RLUSD mid for 60 seconds and values RLUSD at one dollar", async () => {
    expect(RLUSD_HEX_CURRENCY).toMatch(/^[A-F0-9]{40}$/);
    const { ctx, request } = fixtures();
    const first = await estimateUsdValue(ctx, {
      amounts: ["3000000"],
      now: new Date("2026-10-18T00:00:00.000Z"),
    });
    const second = await estimateUsdValue(ctx, {
      amounts: ["1000000"],
      now: new Date("2026-10-18T00:00:59.999Z"),
    });
    const expired = await estimateUsdValue(ctx, {
      amounts: ["1000000"],
      now: new Date("2026-10-18T00:01:00.000Z"),
    });
    const stable = await estimateUsdValue(ctx, {
      amounts: [
        {
          currency: RLUSD_HEX_CURRENCY,
          issuer: MAINNET_RLUSD_ISSUER,
          value: "12.5",
        },
      ],
    });
    expect(first).toBe("1.5");
    expect(second).toBe("0.5");
    expect(expired).toBe("0.5");
    expect(stable).toBe("12.5");
    expect(
      request.mock.calls.filter((call) => call[1] === "book_offers"),
    ).toHaveLength(4);
  });

  it("coalesces concurrent midpoint reads", async () => {
    const { ctx, request } = fixtures();
    const [first, second] = await Promise.all([
      estimateUsdValue(ctx, { amounts: ["1000000"] }),
      estimateUsdValue(ctx, { amounts: ["2000000"] }),
    ]);
    expect(first).toBe("0.5");
    expect(second).toBe("1");
    expect(
      request.mock.calls.filter((call) => call[1] === "book_offers"),
    ).toHaveLength(2);
  });

  it("recognizes fixed and configured stable issuers only on their own networks", async () => {
    const { ctx, request } = fixtures();
    const mainnetOnTestnet = await estimateUsdValue(ctx, {
      network: "testnet",
      amounts: [{
        currency: RLUSD_HEX_CURRENCY,
        issuer: MAINNET_RLUSD_ISSUER,
        value: "1",
      }],
    });
    const testnetOnDevnet = await estimateUsdValue(ctx, {
      network: "devnet",
      amounts: [{
        currency: RLUSD_HEX_CURRENCY,
        issuer: TESTNET_RLUSD_ISSUER,
        value: "1",
      }],
    });
    const testnet = await estimateUsdValue(ctx, {
      network: "testnet",
      amounts: [{
        currency: RLUSD_HEX_CURRENCY,
        issuer: TESTNET_RLUSD_ISSUER,
        value: "1",
      }],
    });
    expect(mainnetOnTestnet).toBeUndefined();
    expect(testnetOnDevnet).toBeUndefined();
    expect(testnet).toBe("1");
    expect(
      request.mock.calls.filter((call) => call[1] === "book_offers"),
    ).toHaveLength(0);
  });

  it("values the configured network stable fallback at one dollar", async () => {
    const { ctx, request } = fixtures();
    ctx.env = {
      STABLE_CODE: "tUSD",
      STABLE_ISSUER_TESTNET: ISSUER,
    };
    const stable = await estimateUsdValue(ctx, {
      network: "testnet",
      amounts: [
        {
          currency: "7455534400000000000000000000000000000000",
          issuer: ISSUER,
          value: "12.5",
        },
      ],
    });
    expect(stable).toBe("12.5");
    expect(
      request.mock.calls.filter((call) => call[1] === "book_offers"),
    ).toHaveLength(0);
  });

  it("does not recognize a configured stable issuer on another network", async () => {
    const { ctx, request } = fixtures();
    ctx.env = {
      STABLE_CODE: "tUSD",
      STABLE_ISSUER_DEVNET: ISSUER,
    };
    const amount = {
      currency: "7455534400000000000000000000000000000000",
      issuer: ISSUER,
      value: "1",
    };
    await expect(
      estimateUsdValue(ctx, { network: "testnet", amounts: [amount] }),
    ).resolves.toBeUndefined();
    await expect(
      estimateUsdValue(ctx, { network: "devnet", amounts: [amount] }),
    ).resolves.toBe("1");
    expect(
      request.mock.calls.filter((call) => call[1] === "book_offers"),
    ).toHaveLength(0);
  });

  it("does not convert a simulation transport failure into a fabricated engine result", async () => {
    const { ctx } = fixtures();
    const baseRequest = ctx.xrplRpc!.request.bind(ctx.xrplRpc);
    ctx.xrplRpc = {
      request: async (network, command, params, options) => {
        if (command === "simulate") throw new Error("fixture transport failure");
        return baseRequest(network, command, params, options);
      },
    };
    await expect(
      buildTransaction(ctx, {
        network: "testnet",
        owner: OWNER,
        tx_json: offerTx(),
        action: "offer",
        amounts: [],
        build_id: "simulation-error",
        preflight: { trustLines: [] },
      }),
    ).rejects.toThrow("fixture transport failure");
  });

  it("re-preflights and re-simulates a stored row through the execution seam", async () => {
    const { ctx } = fixtures({ lines: [] });
    const revalidated = await revalidateStoredBuild(
      ctx,
      {
        network: "testnet",
        owner: OWNER,
        txJson: {
          ...offerTx(),
          Sequence: 7,
          Fee: "12",
          LastLedgerSequence: 104,
        },
      },
      { trustLines: [{ currency: "USD", issuer: ISSUER }] },
    );
    expect(revalidated.preflight).toContainEqual({
      check: "trust-line",
      pass: false,
      detail: `MISSING_TRUST_LINE: USD:${ISSUER}`,
    });
    expect(revalidated.simulate.engine_result).toBe("tesSUCCESS");
  });
});
