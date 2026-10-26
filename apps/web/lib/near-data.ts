import {
  Near1ClickAssetIdSchema,
  type Near1ClickAssetId,
} from "@pilot/contracts";

export const OFFICIAL_NEAR_RPC_ENDPOINTS = Object.freeze({
  mainnet: "https://rpc.mainnet.near.org",
  testnet: "https://rpc.testnet.near.org",
} as const);

export type NearNetwork = keyof typeof OFFICIAL_NEAR_RPC_ENDPOINTS;
export type NearReadOnlyRpcConfig =
  | Readonly<{ enabled: false }>
  | Readonly<{
      enabled: true;
      network: NearNetwork;
      endpoint: (typeof OFFICIAL_NEAR_RPC_ENDPOINTS)[NearNetwork];
    }>;

export type NearAccountView = Readonly<{
  amount: string;
  locked: string;
  code_hash: string;
  storage_usage: number;
  storage_paid_at: number;
  block_height: number;
  block_hash: string;
}>;

type Environment = Readonly<Record<string, string | undefined>>;
type Fetch = typeof globalThis.fetch;

function exactRpcEndpoint(network: NearNetwork, value: string | undefined): string {
  const expected = OFFICIAL_NEAR_RPC_ENDPOINTS[network];
  if (!value?.trim()) return expected;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("NEAR_RPC_URL is invalid");
  }
  if (
    parsed.username || parsed.password || parsed.search || parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.origin !== new URL(expected).origin
  ) {
    throw new Error(`NEAR_RPC_URL must be exactly ${expected}`);
  }
  return expected;
}

export function readNearReadOnlyRpcConfig(environment: Environment = process.env): NearReadOnlyRpcConfig {
  const enabled = environment.NEAR_RPC_READ_ENABLED;
  if (enabled === undefined || enabled === "" || enabled === "0") return Object.freeze({ enabled: false });
  if (enabled !== "1") throw new Error("NEAR_RPC_READ_ENABLED must be exactly 0 or 1");
  const network = environment.NEAR_RPC_NETWORK;
  if (network !== "mainnet" && network !== "testnet") {
    throw new Error("NEAR_RPC_NETWORK must be mainnet or testnet");
  }
  return Object.freeze({
    enabled: true,
    network,
    endpoint: exactRpcEndpoint(network, environment.NEAR_RPC_URL) as
      (typeof OFFICIAL_NEAR_RPC_ENDPOINTS)[typeof network],
  });
}

function assertAccountId(value: string): string {
  if (value.length < 2 || value.length > 64 || !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(value)) {
    throw new Error("A valid NEAR account id is required");
  }
  return value;
}

async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("NEAR RPC response exceeded the configured byte limit");
  }
  if (!response.body) throw new Error("NEAR RPC returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new Error("NEAR RPC response exceeded the configured byte limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("NEAR RPC returned invalid JSON");
  }
}

function requestSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([external, timeout]) : timeout;
}

export type NearReadOnlyRpcClient = Readonly<{
  status(signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>;
  viewAccount(accountId: string, signal?: AbortSignal): Promise<NearAccountView>;
}>;

export function createNearReadOnlyRpcClient(
  config: Extract<NearReadOnlyRpcConfig, { enabled: true }>,
  options: Readonly<{ fetch?: Fetch; timeoutMs?: number; maxResponseBytes?: number }> = {},
): NearReadOnlyRpcClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error("NEAR RPC timeout must be between 1 and 30000 milliseconds");
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1_024 || maxResponseBytes > 4_194_304) {
    throw new Error("NEAR RPC response limit must be between 1024 and 4194304 bytes");
  }

  let nextId = 0;
  const request = async (
    method: "status" | "query",
    params: readonly unknown[] | Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const id = `pilot-near-read-${++nextId}`;
    const response = await fetchImpl(config.endpoint, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      redirect: "error",
      cache: "no-store",
      signal: requestSignal(timeoutMs, signal),
    });
    if (!response.ok) throw new Error(`NEAR RPC request failed with HTTP ${response.status}`);
    const payload = await boundedJson(response, maxResponseBytes);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("NEAR RPC returned an invalid envelope");
    }
    const envelope = payload as Record<string, unknown>;
    if (envelope.jsonrpc !== "2.0" || envelope.id !== id) {
      throw new Error("NEAR RPC response did not match its request");
    }
    if (envelope.error !== undefined) throw new Error("NEAR RPC returned an error");
    if (!("result" in envelope)) throw new Error("NEAR RPC response is missing a result");
    return envelope.result;
  };

  return Object.freeze({
    async status(signal) {
      const result = await request("status", [], signal);
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new Error("NEAR RPC status result is invalid");
      }
      return Object.freeze({ ...(result as Record<string, unknown>) });
    },
    async viewAccount(accountId, signal) {
      const result = await request("query", {
        request_type: "view_account",
        finality: "final",
        account_id: assertAccountId(accountId),
      }, signal);
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new Error("NEAR account result is invalid");
      }
      const account = result as Record<string, unknown>;
      if (
        typeof account.amount !== "string" || !/^\d+$/.test(account.amount) ||
        typeof account.locked !== "string" || !/^\d+$/.test(account.locked) ||
        typeof account.code_hash !== "string" ||
        !Number.isSafeInteger(account.storage_usage) || !Number.isSafeInteger(account.storage_paid_at) ||
        !Number.isSafeInteger(account.block_height) || typeof account.block_hash !== "string"
      ) {
        throw new Error("NEAR account result is invalid");
      }
      return Object.freeze(account as unknown as NearAccountView);
    },
  });
}

export type NearEarnStatusReference = Readonly<{ depositAddress: string; depositMemo?: string }>;
export type NearEarnDiscoveryPlan = Readonly<{
  adapter: "near-intents-1click-earn";
  executable: false;
  assetIn: Near1ClickAssetId;
  assetOut: Near1ClickAssetId;
  amountIn: string;
  steps: readonly (
    | Readonly<{ operation: "tokens"; purpose: "resolve-exact-asset-ids" }>
    | Readonly<{ operation: "quote"; dry: true; purpose: "read-only-opportunity-preview" }>
    | Readonly<{ operation: "status"; reference: NearEarnStatusReference; purpose: "observe-existing-executable-quote-only" }>
  )[];
  caveats: readonly string[];
}>;

function exactAssetId(value: string, name: string): Near1ClickAssetId {
  const parsed = Near1ClickAssetIdSchema.safeParse(value.trim());
  if (!parsed.success) throw new Error(`${name} must be an exact supported 1Click asset id`);
  return parsed.data;
}

/** Describe tokens -> dry quote -> optional existing-settlement status. */
export function createNearEarnDiscoveryPlan(input: Readonly<{
  assetIn: string;
  assetOut: string;
  amountIn: string;
  statusReference?: NearEarnStatusReference;
}>): NearEarnDiscoveryPlan {
  if (!/^[1-9]\d*$/.test(input.amountIn)) {
    throw new Error("amountIn must be a positive integer in the asset's smallest unit");
  }
  const steps: Array<NearEarnDiscoveryPlan["steps"][number]> = [
    Object.freeze({ operation: "tokens", purpose: "resolve-exact-asset-ids" }),
    Object.freeze({ operation: "quote", dry: true, purpose: "read-only-opportunity-preview" }),
  ];
  if (input.statusReference) {
    const depositAddress = input.statusReference.depositAddress.trim();
    const depositMemo = input.statusReference.depositMemo?.trim();
    if (!depositAddress || depositAddress.length > 512) throw new Error("statusReference.depositAddress is invalid");
    if (depositMemo !== undefined && (!depositMemo || depositMemo.length > 512)) {
      throw new Error("statusReference.depositMemo is invalid");
    }
    steps.push(Object.freeze({
      operation: "status",
      reference: Object.freeze({ depositAddress, ...(depositMemo ? { depositMemo } : {}) }),
      purpose: "observe-existing-executable-quote-only",
    }));
  }
  return Object.freeze({
    adapter: "near-intents-1click-earn",
    executable: false,
    assetIn: exactAssetId(input.assetIn, "assetIn"),
    assetOut: exactAssetId(input.assetOut, "assetOut"),
    amountIn: input.amountIn,
    steps: Object.freeze(steps),
    caveats: Object.freeze([
      "The preview quote is dry and is not an executable authorization.",
      "An executable quote requires fresh provider-signature verification and separate exact approval.",
      "1Click settlement status applies only to an existing executable quote reference.",
    ]),
  });
}

