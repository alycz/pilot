import { AwsClient } from "aws4fetch";

import type { Network } from "../contracts";

export const AWS_DEFAULT_REGION = "us-east-1";

export type AwsFetchEnv = {
  AWS_REGION?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_SESSION_TOKEN?: string;
  AWS_ENDPOINT_OVERRIDE?: string;
  EXEC_NETWORK?: Network;
  HARBOR_LOCAL_DEV?: string;
};

export type AwsRequestBody = Readonly<Record<string, unknown>>;

export interface AwsSigningClient {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export type AwsSigningClientOptions = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service: string;
};

export type AwsSigningClientFactory = (
  options: AwsSigningClientOptions,
) => AwsSigningClient;

export type AwsFetchOptions = {
  /** Worker bindings are passed explicitly; this module never discovers credentials. */
  env: AwsFetchEnv;
  clientFactory?: AwsSigningClientFactory;
};

export type AwsErrorCode =
  | "AWS_INVALID_REQUEST"
  | "AWS_UNSUPPORTED_REGION"
  | "AWS_ENDPOINT_OVERRIDE_FORBIDDEN"
  | "AWS_ENDPOINT_OVERRIDE_INVALID"
  | "AWS_CREDENTIALS_MISSING"
  | "AWS_TRANSPORT_ERROR"
  | "AWS_MALFORMED_RESPONSE"
  | `AWS_HTTP_${number}`
  | `AWS_SERVICE_${string}`;

/**
 * A normalized AWS error safe to return through Harbor envelopes.
 *
 * It intentionally retains neither the request body, credentials, signed
 * headers, endpoint, nor upstream error message.
 */
export class AwsError extends Error {
  readonly service = "aws";

  constructor(
    readonly code: AwsErrorCode,
    readonly retryable = false,
  ) {
    super(messageFor(code));
    this.name = "AwsError";
  }
}

const defaultClientFactory: AwsSigningClientFactory = (options) =>
  new AwsClient(options);

function messageFor(code: AwsErrorCode): string {
  if (code === "AWS_INVALID_REQUEST") {
    return "AWS request configuration is invalid";
  }
  if (code === "AWS_UNSUPPORTED_REGION") return "AWS region is not allowed";
  if (code === "AWS_ENDPOINT_OVERRIDE_FORBIDDEN") {
    return "AWS endpoint override is not allowed in this environment";
  }
  if (code === "AWS_ENDPOINT_OVERRIDE_INVALID") {
    return "AWS endpoint override must be a loopback URL";
  }
  if (code === "AWS_CREDENTIALS_MISSING") {
    return "AWS signing credentials are unavailable";
  }
  if (code === "AWS_TRANSPORT_ERROR") return "AWS request failed";
  if (code === "AWS_MALFORMED_RESPONSE") return "AWS returned malformed JSON";
  if (code.startsWith("AWS_HTTP_")) return "AWS returned an HTTP error";
  return "AWS service rejected the request";
}

function isSafeToken(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,128}$/.test(value);
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

function endpointFor(service: string, env: AwsFetchEnv): string {
  if (!isSafeToken(service)) throw new AwsError("AWS_INVALID_REQUEST");

  const region = env.AWS_REGION ?? AWS_DEFAULT_REGION;
  if (region !== AWS_DEFAULT_REGION) {
    throw new AwsError("AWS_UNSUPPORTED_REGION");
  }

  if (!env.AWS_ENDPOINT_OVERRIDE) {
    return `https://${service}.${region}.amazonaws.com/`;
  }

  if (
    env.HARBOR_LOCAL_DEV !== "true" ||
    (env.EXEC_NETWORK !== "testnet" && env.EXEC_NETWORK !== "devnet")
  ) {
    throw new AwsError("AWS_ENDPOINT_OVERRIDE_FORBIDDEN");
  }

  let endpoint: URL;
  try {
    endpoint = new URL(env.AWS_ENDPOINT_OVERRIDE);
  } catch {
    throw new AwsError("AWS_ENDPOINT_OVERRIDE_INVALID");
  }
  if (
    !isLoopback(endpoint.hostname) ||
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    endpoint.username !== "" ||
    endpoint.password !== ""
  ) {
    throw new AwsError("AWS_ENDPOINT_OVERRIDE_INVALID");
  }
  return endpoint.toString();
}

function clientOptions(
  service: string,
  env: AwsFetchEnv,
): AwsSigningClientOptions {
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new AwsError("AWS_CREDENTIALS_MISSING");
  }
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: env.AWS_SESSION_TOKEN,
    region: env.AWS_REGION ?? AWS_DEFAULT_REGION,
    service,
  };
}

function serviceErrorCode(value: unknown): AwsErrorCode | undefined {
  if (typeof value !== "string") return undefined;
  const tail = value.split("#").at(-1)?.replace(/[^A-Za-z0-9_.-]/g, "_");
  if (!tail || tail.length > 64) return undefined;
  return `AWS_SERVICE_${tail}`;
}

function requestFor(
  service: string,
  target: string,
  endpoint: string,
): { url: string; headers: Record<string, string> } {
  if (
    service === "bedrock-runtime" &&
    (target === "InvokeGuardrailChecks" ||
      target === "BedrockRuntime.InvokeGuardrailChecks")
  ) {
    return {
      url: new URL("/guardrail-checks/invoke", endpoint).toString(),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
    };
  }

  return {
    url: endpoint,
    headers: {
      accept: "application/json",
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": target,
    },
  };
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new AwsError("AWS_MALFORMED_RESPONSE");
  }
}

/**
 * Send one SigV4-authenticated AWS JSON request.
 *
 * Callers must pass Worker bindings explicitly. Tests can inject a signing
 * client, and the local stand-in still receives a real SigV4 Authorization
 * header produced with clearly fake, test-only credentials.
 */
export async function awsFetch(
  service: string,
  target: string,
  body: AwsRequestBody,
  options: AwsFetchOptions = { env: {} },
): Promise<unknown> {
  if (!isSafeToken(target)) throw new AwsError("AWS_INVALID_REQUEST");

  const endpoint = endpointFor(service, options.env);
  const request = requestFor(service, target, endpoint);
  const client = (options.clientFactory ?? defaultClientFactory)(
    clientOptions(service, options.env),
  );

  let response: Response;
  try {
    response = await client.fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(body),
    });
  } catch {
    throw new AwsError("AWS_TRANSPORT_ERROR", true);
  }

  const payload = await parseJson(response);
  if (!response.ok) {
    const record =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>)
        : undefined;
    const code =
      serviceErrorCode(record?.__type) ??
      serviceErrorCode(record?.code) ??
      serviceErrorCode(record?.Code) ??
      (`AWS_HTTP_${response.status}` as const);
    throw new AwsError(
      code,
      response.status === 408 || response.status === 429 || response.status >= 500,
    );
  }

  return payload;
}
