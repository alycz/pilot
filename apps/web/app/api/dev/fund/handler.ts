import {
  Client,
  Wallet,
  isValidClassicAddress,
  type AccountLinesRequest,
  type AccountLinesResponse,
  type Payment,
  type ServerInfoRequest,
  type ServerInfoResponse,
} from "xrpl";

import { authorizeDevFundingRequest } from "../authorize";
import {
  resolveStableAsset,
  toLedgerCurrencyCode as sharedToLedgerCurrencyCode,
} from "../../../../lib/stable-asset";

const FUNDING_AMOUNT = "1000";
const RATE_LIMIT_MS = 10 * 60 * 1000;

const DEFAULT_ENDPOINTS = {
  testnet: "wss://s.altnet.rippletest.net:51233",
  devnet: "wss://s.devnet.rippletest.net:51233",
} as const;

const EXPECTED_NETWORK_IDS: Record<FundingNetwork, number> = {
  testnet: 1,
  devnet: 2,
};

type FundingNetwork = keyof typeof DEFAULT_ENDPOINTS;

interface FundingConfig {
  currency: string;
  displayCurrency: string;
  endpoint: string;
  issuer: string;
  network: FundingNetwork;
  seed: string;
}
interface FundingWallet {
  classicAddress: string;
  sign(transaction: Payment): { hash: string; tx_blob: string };
}

export interface FundingClient {
  autofill(transaction: Payment): Promise<Payment>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  request(request: AccountLinesRequest): Promise<AccountLinesResponse>;
  request(request: ServerInfoRequest): Promise<ServerInfoResponse>;
  submitAndWait(transaction: string): Promise<{
    result: {
      hash: string;
      meta?: string | { TransactionResult: string };
      validated?: boolean;
    };
  }>;
}

export interface FundHandlerDependencies {
  authorize(request: Request, address: string, network: FundingNetwork): boolean;
  createClient(endpoint: string): FundingClient;
  env: NodeJS.ProcessEnv;
  isValidAddress(address: string): boolean;
  now(): number;
  walletFromSeed(seed: string): FundingWallet;
}

class FundRouteError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface LimitState {
  inFlight: boolean;
  lastCallAt: number;
}

class FundingRateLimiter {
  private readonly entries = new Map<string, LimitState>();

  acquire(address: string, now: number):
    | { acquired: false; retryAfterSeconds: number }
    | { acquired: true; release: () => void } {
    for (const [key, entry] of this.entries) {
      if (!entry.inFlight && now - entry.lastCallAt >= RATE_LIMIT_MS) this.entries.delete(key);
    }
    const current = this.entries.get(address);
    if (current?.inFlight) {
      return { acquired: false, retryAfterSeconds: 1 };
    }

    if (current !== undefined) {
      const elapsed = now - current.lastCallAt;
      if (elapsed < RATE_LIMIT_MS) {
        return {
          acquired: false,
          retryAfterSeconds: Math.max(1, Math.ceil((RATE_LIMIT_MS - elapsed) / 1000)),
        };
      }
    }

    const state: LimitState = { inFlight: true, lastCallAt: now };
    this.entries.set(address, state);

    let released = false;
    return {
      acquired: true,
      release: () => {
        if (released) return;
        released = true;
        this.entries.set(address, { ...state, inFlight: false });
      },
    };
  }
}

const defaultDependencies: FundHandlerDependencies = {
  authorize: authorizeDevFundingRequest,
  createClient: (endpoint) => new Client(endpoint) as unknown as FundingClient,
  env: process.env,
  isValidAddress: isValidClassicAddress,
  now: Date.now,
  walletFromSeed: (seed) => Wallet.fromSeed(seed),
};

function errorResponse(
  code: string,
  message: string,
  status: number,
  extraHeaders?: HeadersInit,
): Response {
  return Response.json(
    { error: { code, message } },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        ...extraHeaders,
      },
    },
  );
}

function successResponse(body: unknown): Response {
  return Response.json(body, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}

function isFundingNetwork(value: unknown): value is FundingNetwork {
  return value === "testnet" || value === "devnet";
}

/** Convert a human-readable 4-20 byte code (for example RLUSD or tUSD) to XRPL's 160-bit hex form. */
export function toLedgerCurrencyCode(code: string): string {
  try {
    return sharedToLedgerCurrencyCode(code);
  } catch {
    throw new FundRouteError(
      "FUNDING_NOT_CONFIGURED",
      503,
      "The stablecoin configuration is unavailable.",
    );
  }
}

function resolveConfig(
  network: FundingNetwork,
  env: NodeJS.ProcessEnv,
  validateAddress: (address: string) => boolean,
): FundingConfig {
  const seed = env.MM_WALLET_SEED?.trim();
  const stableAsset = resolveStableAsset(env, network);
  const displayCurrency = stableAsset.displayCurrency;
  const issuer = stableAsset.issuer;
  const endpoint =
    env[`XRPL_${network.toUpperCase()}_URL`]?.trim() || DEFAULT_ENDPOINTS[network];

  if (!seed || !issuer || !validateAddress(issuer) || !endpoint) {
    throw new FundRouteError(
      "FUNDING_NOT_CONFIGURED",
      503,
      "The stablecoin funding service is not configured for this network.",
    );
  }

  return {
    currency: stableAsset.currency,
    displayCurrency,
    endpoint,
    issuer,
    network,
    seed,
  };
}
function hasUsableTrustLine(
  response: AccountLinesResponse,
  currency: string,
  issuer: string,
): boolean {
  return response.result.lines.some(
    (line) =>
      line.account === issuer &&
      line.currency.toUpperCase() === currency.toUpperCase() &&
      /^\+?\d+(?:\.\d+)?$/.test(line.limit) &&
      /[1-9]/.test(line.limit),
  );
}

async function fundAddress(
  address: string,
  config: FundingConfig,
  dependencies: FundHandlerDependencies,
): Promise<string> {
  let wallet: FundingWallet;
  try {
    wallet = dependencies.walletFromSeed(config.seed);
  } catch {
    throw new FundRouteError(
      "FUNDING_NOT_CONFIGURED",
      503,
      "The stablecoin funding service is not configured for this network.",
    );
  }

  const client = dependencies.createClient(config.endpoint);
  let connected = false;

  try {
    try {
      await client.connect();
      connected = true;

      // server_info exposes network_id: https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/server-info-methods/server_info
      const serverInfo = await client.request({ command: "server_info" });
      if (serverInfo.result.info.network_id !== EXPECTED_NETWORK_IDS[config.network]) {
        throw new FundRouteError(
          "LEDGER_NETWORK_MISMATCH",
          502,
          "The configured XRPL endpoint is not connected to the requested test network.",
        );
      }

      // account_lines request fields: https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/account-methods/account_lines
      const lines = await client.request({
        command: "account_lines",
        account: address,
        peer: config.issuer,
        ledger_index: "validated",
        limit: 400,
      });

      if (!hasUsableTrustLine(lines, config.currency, config.issuer)) {
        throw new FundRouteError(
          "TRUST_LINE_REQUIRED",
          409,
          "Create a trust line to the configured stablecoin before requesting funds.",
        );
      }
    } catch (error) {
      if (error instanceof FundRouteError) throw error;
      throw new FundRouteError(
        "LEDGER_UNAVAILABLE",
        502,
        "The test ledger is temporarily unavailable.",
      );
    }

    try {
      // Payment fields: https://xrpl.org/docs/references/protocol/transactions/types/payment
      const payment: Payment = {
        TransactionType: "Payment",
        Account: wallet.classicAddress,
        Destination: address,
        Amount: {
          currency: config.currency,
          issuer: config.issuer,
          value: FUNDING_AMOUNT,
        },
      };

      const prepared = await client.autofill(payment);
      const signed = wallet.sign(prepared);
      const submitted = await client.submitAndWait(signed.tx_blob);
      const meta = submitted.result.meta;
      const resultCode = typeof meta === "string" ? undefined : meta?.TransactionResult;

      if (submitted.result.validated !== true || resultCode !== "tesSUCCESS") {
        throw new FundRouteError(
          "FUNDING_FAILED",
          502,
          "The stablecoin funding transaction did not validate successfully.",
        );
      }

      return submitted.result.hash;
    } catch (error) {
      if (error instanceof FundRouteError) throw error;
      throw new FundRouteError(
        "FUNDING_FAILED",
        502,
        "The stablecoin funding transaction could not be completed.",
      );
    }
  } finally {
    if (connected) {
      try {
        await client.disconnect();
      } catch {
        // The transaction result is authoritative; a disconnect failure must not change it.
      }
    }
  }
}

export function createFundHandler(
  overrides: Partial<FundHandlerDependencies> = {},
): (request: Request) => Promise<Response> {
  const dependencies: FundHandlerDependencies = { ...defaultDependencies, ...overrides };
  const rateLimiter = new FundingRateLimiter();

  return async (request: Request): Promise<Response> => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse("INVALID_JSON", "The request body must be valid JSON.", 400);
    }

    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return errorResponse(
        "INVALID_REQUEST",
        "The request body must contain address and network strings.",
        400,
      );
    }

    const value = body as Record<string, unknown>;
    if (Object.keys(value).some((key) => key !== "address" && key !== "network")) {
      return errorResponse("INVALID_REQUEST", "Unsupported funding request field.", 400);
    }
    const { address, network } = value;
    if (typeof address !== "string" || typeof network !== "string") {
      return errorResponse(
        "INVALID_REQUEST",
        "The request body must contain address and network strings.",
        400,
      );
    }

    if (!isFundingNetwork(network)) {
      return errorResponse(
        "UNSUPPORTED_NETWORK",
        "Funding is available only on testnet and devnet.",
        400,
      );
    }
    if (!dependencies.authorize(request, address, network)) {
      return errorResponse(
        "UNAUTHORIZED",
        "Wallet authorization for this test-network account is required for test funding.",
        401,
      );
    }

    if (!dependencies.isValidAddress(address)) {
      return errorResponse("INVALID_ADDRESS", "A valid XRPL classic address is required.", 400);
    }

    let config: FundingConfig;
    try {
      config = resolveConfig(network, dependencies.env, dependencies.isValidAddress);
    } catch (error) {
      if (error instanceof FundRouteError) {
        return errorResponse(error.code, error.message, error.status);
      }
      return errorResponse(
        "FUNDING_NOT_CONFIGURED",
        "The stablecoin funding service is not configured for this network.",
        503,
      );
    }

    const limit = rateLimiter.acquire(address, dependencies.now());
    if (!limit.acquired) {
      return errorResponse(
        "RATE_LIMITED",
        "This address can be funded once every 10 minutes.",
        429,
        { "Retry-After": String(limit.retryAfterSeconds) },
      );
    }

    try {
      const txHash = await fundAddress(address, config, dependencies);
      return successResponse({
        funded: true,
        address,
        network,
        amount: {
          currency: config.displayCurrency,
          issuer: config.issuer,
          value: FUNDING_AMOUNT,
        },
        txHash,
      });
    } catch (error) {
      if (error instanceof FundRouteError) {
        return errorResponse(error.code, error.message, error.status);
      }
      return errorResponse(
        "FUNDING_FAILED",
        "The stablecoin funding transaction could not be completed.",
        502,
      );
    } finally {
      limit.release();
    }
  };
}
