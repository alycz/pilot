import { EnvelopeSchema, type Envelope } from "@pilot/contracts";
import { hashes } from "xrpl";

import { createMockHarborClient } from "./mock.js";
import { createHarborRestDispatch } from "./request.js";
import {
  MAX_HARBOR_RESPONSE_BYTES,
  MAX_X402_RESPONSE_BYTES,
  readBoundedResponseText,
} from "./response.js";
import { HarborArgsSchemas, HarborResultSchemas } from "./types.js";
import { compareX402IssuedAmounts } from "./x402-issued.js";
import type {
  ArgsFor,
  HarborClient,
  HarborOpName,
  ResultFor,
} from "./types.js";

export type HarborRestClientConfig = {
  baseUrl?: string;
  apiKey?: string;
  mock?: boolean;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
};

type ServerEnvironment = {
  HARBOR_API_KEY?: string;
  HARBOR_MOCK?: string;
  HARBOR_URL?: string;
};

function serverEnvironment(): ServerEnvironment {
  if (
    typeof window !== "undefined" ||
    typeof process === "undefined" ||
    process.env === undefined
  ) {
    return {};
  }

  return process.env;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function redact(value: string, secret: string | undefined): string {
  const compact = value.replace(/\s+/g, " ").trim().slice(0, 1_024);
  return secret ? compact.split(secret).join("[redacted]") : compact;
}

export class HarborHttpError extends Error {
  readonly op: HarborOpName;
  readonly status: number;
  readonly statusText: string;
  readonly responseBody?: string;

  constructor(options: {
    op: HarborOpName;
    status: number;
    statusText: string;
    responseBody?: string;
  }) {
    const detail = options.responseBody ? `: ${options.responseBody}` : "";
    super(
      `Harbor REST ${options.op} failed with HTTP ${options.status} ${options.statusText}${detail}`,
    );
    this.name = "HarborHttpError";
    this.op = options.op;
    this.status = options.status;
    this.statusText = options.statusText;
    this.responseBody = options.responseBody;
  }
}

/**
 * Typed REST mirror for Harbor operations. Mock mode is the safe default: live
 * requests require either `mock: false`, `HARBOR_MOCK=0`, or an explicit live
 * URL when no mock setting is present.
 */
export class HarborRestClient implements HarborClient {
  private readonly apiKey?: string;
  private readonly baseUrl?: string;
  private readonly fetchImpl?: typeof globalThis.fetch;
  private readonly mockClient?: HarborClient;
  private readonly signal?: AbortSignal;
  private readonly timeoutMs: number;

  constructor(config: HarborRestClientConfig = {}) {
    this.signal = config.signal;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("Harbor live timeoutMs must be a positive integer");
    }
    const environment = serverEnvironment();
    const baseUrl = config.baseUrl ?? environment.HARBOR_URL;
    const useMock =
      config.mock ??
      (environment.HARBOR_MOCK === "1"
        ? true
        : environment.HARBOR_MOCK === "0"
          ? false
          : baseUrl === undefined);

    if (useMock) {
      this.mockClient = createMockHarborClient();
      return;
    }

    if (!baseUrl) {
      throw new Error(
        "Harbor live mode requires a baseUrl or the server-side HARBOR_URL environment variable",
      );
    }

    const fetchImpl = config.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new Error("Harbor live mode requires a fetch implementation");
    }

    const apiKey = config.apiKey ?? environment.HARBOR_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Harbor live mode requires an apiKey or the server-side HARBOR_API_KEY environment variable",
      );
    }

    this.baseUrl = trimTrailingSlashes(baseUrl);
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async op<K extends HarborOpName>(
    name: K,
    args: ArgsFor<K>,
  ): Promise<Envelope<ResultFor<K>>> {
    if (this.mockClient) {
      return this.mockClient.op(name, args);
    }

    const validatedArgs = HarborArgsSchemas[name].parse(args) as ArgsFor<K>;

    if (this.signal?.aborted) {
      throw new Error(`Harbor REST ${name} was cancelled before dispatch`);
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, this.timeoutMs);
    let response: Response;
    let body: string;
    let dispatched = false;
    try {
      dispatched = true;
      const dispatch = createHarborRestDispatch(
        this.baseUrl!,
        this.apiKey!,
        name,
        validatedArgs,
        controller.signal,
      );
      response = await this.fetchImpl!(dispatch.url, dispatch.init);
      body = await readBoundedResponseText(
        response,
        name === "x402.pay" || name === "x402.payIssuedFixture"
          ? MAX_X402_RESPONSE_BYTES
          : MAX_HARBOR_RESPONSE_BYTES,
      );
    } catch (error) {
      if (
        (name === "x402.pay" || name === "x402.payIssuedFixture") &&
        dispatched &&
        controller.signal.aborted
      ) {
        throw new Error(
          `Harbor REST ${name} was interrupted after dispatch; settlement outcome is unknown and recovery must reuse the same idempotency key`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      this.signal?.removeEventListener("abort", abort);
    }

    if (!response.ok) {
      throw new HarborHttpError({
        op: name,
        status: response.status,
        statusText: name === "x402.pay" || name === "x402.payIssuedFixture"
          ? "Upstream x402 error"
          : redact(response.statusText, this.apiKey),
        responseBody: name === "x402.pay" || name === "x402.payIssuedFixture"
          ? undefined
          : body ? redact(body, this.apiKey) : undefined,
      });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      throw new Error(
        `Harbor REST ${name} returned invalid JSON: ${error instanceof Error ? error.message : "parse failed"}`,
      );
    }

    const parsed = EnvelopeSchema(HarborResultSchemas[name]).safeParse(payload);
    if (!parsed.success) {
      throw new Error(
        `Harbor REST ${name} returned an invalid Envelope: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`)
          .join("; ")}`,
      );
    }

    if (parsed.data.ok) {
      const data = parsed.data.data as { hash?: unknown };
      if (
        name === "tx.status" && typeof data.hash === "string" &&
        data.hash.toUpperCase() !== String((validatedArgs as ArgsFor<"tx.status">).hash).toUpperCase()
      ) {
        throw new Error("Harbor REST tx.status returned a hash that does not match the request");
      }
      if (name === "tx.submit" && typeof data.hash === "string") {
        let expectedHash: string;
        try {
          expectedHash = hashes.hashSignedTx((validatedArgs as ArgsFor<"tx.submit">).tx_blob).toUpperCase();
        } catch {
          throw new Error("Harbor REST tx.submit could not bind the response to the signed transaction");
        }
        if (data.hash.toUpperCase() !== expectedHash) {
          throw new Error("Harbor REST tx.submit returned a hash that does not match the signed transaction");
        }
      }
      if (name === "x402.pay") {
        const request = validatedArgs as ArgsFor<"x402.pay">;
        const result = parsed.data.data as ResultFor<"x402.pay">;
        if (
          result.idempotency_key !== request.idempotency_key ||
          result.network !== request.network ||
          (result.status === "settlement_unknown" && (
            result.owner !== request.owner ||
            result.resource !== request.resource
          )) ||
          (result.status === "delivered" && (
            result.owner !== request.owner ||
            result.resource !== request.resource ||
            result.pay_to !== request.pay_to ||
            BigInt(result.amount_drops) !== BigInt(request.max_price_drops) ||
            BigInt(result.fee_drops) > 100n ||
            BigInt(result.amount_drops) + BigInt(result.fee_drops) > 5_100n
          ))
        ) {
          throw new Error("Harbor REST x402.pay returned a result outside the requested owner, network, resource, idempotency, merchant, or exact price binding");
        }
      }
      if (name === "x402.payIssuedFixture") {
        const request = validatedArgs as ArgsFor<"x402.payIssuedFixture">;
        const result = parsed.data.data as ResultFor<"x402.payIssuedFixture">;
        if (
          result.session_scope !== request.session_scope ||
          result.merchant.id !== request.merchant.id ||
          result.merchant.resource_method !== request.merchant.resource_method ||
          result.merchant.resource_url !== request.merchant.resource_url ||
          result.idempotency_key !== request.idempotency_key ||
          result.asset.network !== request.asset.network ||
          result.asset.currency !== request.asset.currency ||
          result.asset.issuer !== request.asset.issuer ||
          result.payer !== request.owner ||
          result.pay_to !== request.pay_to ||
          compareX402IssuedAmounts(result.amount, request.max_amount) > 0
        ) {
          throw new Error("Harbor REST x402.payIssuedFixture returned fixture evidence outside the authorized binding");
        }
      }
    }

    return parsed.data as Envelope<ResultFor<K>>;
  }
}

export function createHarborRestClient(
  config: HarborRestClientConfig = {},
): HarborRestClient {
  return new HarborRestClient(config);
}
