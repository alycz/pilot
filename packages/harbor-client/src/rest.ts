import { EnvelopeSchema, type Envelope } from "@pilot/contracts";
import { z } from "zod";

import { createMockHarborClient } from "./mock.js";
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
};

type ServerEnvironment = {
  HARBOR_API_KEY?: string;
  HARBOR_MOCK?: string;
  HARBOR_URL?: string;
};

const ResponseEnvelopeSchema = EnvelopeSchema(z.unknown());

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

  constructor(config: HarborRestClientConfig = {}) {
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

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    headers.authorization = `Bearer ${this.apiKey!}`;

    const response = await this.fetchImpl!(
      `${this.baseUrl!}/api/ops/${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(args),
      },
    );
    const body = await response.text();

    if (!response.ok) {
      throw new HarborHttpError({
        op: name,
        status: response.status,
        statusText: response.statusText,
        responseBody: body ? redact(body, this.apiKey) : undefined,
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

    const parsed = ResponseEnvelopeSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(
        `Harbor REST ${name} returned an invalid Envelope: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`)
          .join("; ")}`,
      );
    }

    return parsed.data as Envelope<ResultFor<K>>;
  }
}

export function createHarborRestClient(
  config: HarborRestClientConfig = {},
): HarborRestClient {
  return new HarborRestClient(config);
}
