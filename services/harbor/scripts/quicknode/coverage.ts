import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type CoverageStatus =
  | "supported"
  | "supported_business_error"
  | "unsupported";

export const XRPL_COVERAGE_METHODS = Object.freeze([
  "account_info",
  "account_lines",
  "account_objects",
  "account_tx",
  "amm_info",
  "book_changes",
  "book_offers",
  "feature",
  "fee",
  "get_aggregate_price",
  "ledger",
  "ledger_current",
  "ledger_data",
  "ledger_entry",
  "path_find",
  "ripple_path_find",
  "server_info",
  "simulate",
  "submit",
  "tx",
  "vault_info",
] as const);

const CAPABILITY_ERRORS = new Set([
  "unknownCmd",
  "notSupported",
  "notImpl",
  "reportingUnsupported",
]);

const BUSINESS_OR_ARGUMENT_ERRORS = new Set([
  "actNotFound",
  "entryNotFound",
  "invalidParams",
  "invalidTransaction",
  "objectNotFound",
  "srcCurMalformed",
  "txnNotFound",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseError(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const result = isRecord(value.result) ? value.result : value;
  const standardError = isRecord(value.error) ? value.error : undefined;
  if (typeof result.error === "string") return result.error;
  if (typeof standardError?.code === "string") return standardError.code;
  if (typeof standardError?.code === "number") return String(standardError.code);
  return undefined;
}

export function classifyCoverageResponse(value: unknown): CoverageStatus {
  const code = responseError(value);
  if (code === undefined) return "supported";
  if (CAPABILITY_ERRORS.has(code)) return "unsupported";
  if (
    BUSINESS_OR_ARGUMENT_ERRORS.has(code) ||
    /^(?:tec|tef|tem)[A-Z0-9_]+$/.test(code)
  ) {
    return "supported_business_error";
  }
  throw new Error("Coverage probe returned an unrecognized XRPL error");
}

function probeParams(method: string): Readonly<Record<string, unknown>> {
  if (method === "path_find") return { subcommand: "status" };
  if (method === "ledger") {
    return { ledger_index: "validated", transactions: false };
  }
  if (method === "ledger_data") return { ledger_index: "validated", limit: 1 };
  if (method === "fee" || method === "ledger_current" || method === "server_info") {
    return {};
  }
  // Invalid placeholders are deliberate: a documented business/argument error
  // proves the method exists without submitting or mutating a transaction.
  return {};
}

function checkedEndpoint(raw: string, cli: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Coverage endpoint is invalid");
  }
  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]";
  if (
    url.username ||
    url.password ||
    (cli && !loopback) ||
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
  ) {
    throw new Error("Coverage endpoint must be HTTPS or loopback HTTP");
  }
  return url.href;
}

export function resolveCoverageEndpoint(
  cliEndpoint: string | undefined,
  environmentEndpoint: string | undefined,
): string {
  const endpoint = cliEndpoint ?? environmentEndpoint;
  if (!endpoint) {
    throw new Error(
      "Set QN_XRPL_TESTNET_HTTP, or use --url with a loopback fixture endpoint",
    );
  }
  return checkedEndpoint(endpoint, cliEndpoint !== undefined);
}

async function probeMethod(
  endpoint: string,
  method: string,
): Promise<CoverageStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params: [probeParams(method)] }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Coverage probe HTTP ${response.status}`);
    }
    return classifyCoverageResponse(await response.json());
  } finally {
    clearTimeout(timer);
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

export async function runCoverageProbe(): Promise<void> {
  const cliEndpoint = argument("--url");
  const endpoint = resolveCoverageEndpoint(
    cliEndpoint,
    process.env.QN_XRPL_TESTNET_HTTP,
  );
  const output = resolve(
    argument("--output") ?? "src/quicknode/coverage.testnet.json",
  );
  const methods: Record<string, CoverageStatus> = {};
  for (const method of XRPL_COVERAGE_METHODS) {
    methods[method] = await probeMethod(endpoint, method);
  }
  const document = {
    network: "testnet",
    source: "endpoint-probe",
    generated_at: new Date().toISOString(),
    methods,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  process.stdout.write(`Wrote ${XRPL_COVERAGE_METHODS.length} method results.\n`);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  runCoverageProbe().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Coverage probe failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
