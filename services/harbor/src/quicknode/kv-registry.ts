import { isValidClassicAddress } from "xrpl";
import { z } from "zod";

import { PolicySchema } from "../contracts";
import { validatePermissions } from "../exec/delegation";
import {
  QuickNodeError,
  qnRest,
  type QuickNodeEnv,
  type QnRestOptions,
} from "./client";

const RegistryNetworkSchema = z.enum(["testnet", "devnet"]);
const RegistryModeSchema = z.enum(["off", "mock", "live"]);
const RegistryListSchema = z.enum([
  "accounts",
  "delegates",
  "frozen",
  "tx_types",
  "issuers",
]);
const RunTagSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/);
const KvItemSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "invalid KV item");
const KvListResponseSchema = z
  .object({
    key: z.string().min(1).max(200),
    items: z.array(KvItemSchema).max(20_000),
  })
  .strict();
const RpcCountsSchema = z
  .object({
    calls_quicknode: z.number().int().nonnegative(),
    calls_fallback: z.number().int().nonnegative(),
  })
  .strict();
const RunCountersSchema = RpcCountsSchema.extend({
  webhook_confirmations: z.number().int().nonnegative(),
  webhook_last_at: z.string().datetime().nullable(),
  watchdog_ledgers_seen: z.number().int().nonnegative(),
  watchdog_last_ledger: z.number().int().nonnegative().nullable(),
  watchdog_events: z.number().int().nonnegative(),
  watchdog_frozen_count: z.number().int().nonnegative(),
}).strict();

export type RegistryNetwork = z.infer<typeof RegistryNetworkSchema>;
export type RegistryMode = z.infer<typeof RegistryModeSchema>;
export type RegistryList = z.infer<typeof RegistryListSchema>;

export type QuickNodeRegistryEnv = QuickNodeEnv & {
  QN_MODE?: string;
  QN_RUN_TAG?: string;
};

export type QuickNodeRegistryLog = Readonly<{
  evt: "kv_sync_failed";
  action: "patch" | "replace";
  list: RegistryList;
  code: string;
}>;

export type QuickNodeRegistryOptions = Readonly<{
  env: QuickNodeRegistryEnv;
  runtimeLocal: boolean;
  requestLocal: boolean;
  fetcher?: typeof fetch;
  log?: (entry: QuickNodeRegistryLog) => void;
}>;

export type QuickNodeRegistryRequestContext = Readonly<{
  env?: QuickNodeRegistryEnv;
  request?: Request;
  fetcher?: typeof fetch;
  log?: (entry: QuickNodeRegistryLog) => void;
}>;

export type QuickNodeRegistryMutation = Readonly<{
  ok: boolean;
  skipped: boolean;
}>;

export type QuickNodeRegistrySnapshot = Readonly<{
  accounts: readonly string[];
  delegates: readonly string[];
  frozen: readonly string[];
  tx_types: readonly string[];
  issuers: readonly string[];
}>;

export type QuickNodeLinkSnapshot = Readonly<{
  owner: string;
  delegate: string;
  permissions: readonly string[];
  status: "pending" | "active" | "suspended" | "revoked";
  revokePending?: boolean;
  frozen?: boolean;
}>;

export type QuickNodePolicySnapshot = Readonly<{
  allowed_tx_types: readonly string[];
  issuer_allowlist: readonly string[];
}>;

export type QuickNodeRpcCounts = z.infer<typeof RpcCountsSchema>;
export type QuickNodeRunCounters = z.infer<typeof RunCountersSchema>;

export interface QuickNodeRegistrySource {
  links(network: RegistryNetwork): Promise<readonly QuickNodeLinkSnapshot[]>;
  policies(network: RegistryNetwork): Promise<readonly QuickNodePolicySnapshot[]>;
  payerAccounts(network: RegistryNetwork): Promise<readonly string[]>;
  frozenPayerAccounts?(network: RegistryNetwork): Promise<readonly string[]>;
  catalog(): Promise<unknown> | unknown;
}

type RawLinkRow = {
  owner: string;
  delegate: string;
  permissions: string;
  status: string;
  revoke_tx: string | null;
  frozen_at: string | null;
};

type RawPolicyRow = { json: string };

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => KvItemSchema.parse(value)))].sort();
}

function resultCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^QN_[A-Z0-9_]+$/.test(error.code)
  ) {
    return error.code;
  }
  return "QN_KV_SYNC_FAILED";
}

function mode(env: QuickNodeRegistryEnv): RegistryMode {
  return RegistryModeSchema.parse(env.QN_MODE?.trim() || "off");
}

function runTag(env: QuickNodeRegistryEnv): string {
  return RunTagSchema.parse(env.QN_RUN_TAG?.trim() || "run1");
}

function effectiveRestOptions(options: QuickNodeRegistryOptions): QnRestOptions {
  const configuredMode = mode(options.env);
  if (configuredMode === "mock") {
    let configuredBase: URL;
    try {
      configuredBase = new URL(options.env.QN_API_BASE ?? "");
    } catch {
      throw new QuickNodeError("QN_API_BASE_FORBIDDEN");
    }
    if (
      configuredBase.origin === "https://api.quicknode.com" ||
      !options.runtimeLocal ||
      !options.requestLocal
    ) {
      throw new QuickNodeError("QN_API_BASE_FORBIDDEN");
    }
  }
  const env =
    configuredMode === "mock" && !options.env.QN_API_KEY
      ? { ...options.env, QN_API_KEY: "qn-local-standin" }
      : options.env;
  return {
    env,
    runtimeLocal: options.runtimeLocal,
    requestLocal: options.requestLocal,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  };
}

/** Deterministic list key used by QuickNode filters and the local stand-in. */
export function quickNodeRegistryKey(
  network: RegistryNetwork,
  tag: string,
  list: RegistryList,
): string {
  return `harbor_${RegistryNetworkSchema.parse(network)}_${RunTagSchema.parse(tag)}_${RegistryListSchema.parse(list)}`;
}

export class QuickNodeKvRegistry {
  readonly #mode: RegistryMode;
  readonly #runTag: string;
  readonly #log: (entry: QuickNodeRegistryLog) => void;

  constructor(private readonly options: QuickNodeRegistryOptions) {
    this.#mode = mode(options.env);
    this.#runTag = runTag(options.env);
    this.#log =
      options.log ??
      ((entry) => {
        console.warn("kv_sync_failed", entry);
      });
  }

  get configuredMode(): RegistryMode {
    return this.#mode;
  }

  get configuredRunTag(): string {
    return this.#runTag;
  }

  async replace(
    network: RegistryNetwork,
    list: RegistryList,
    items: readonly string[],
  ): Promise<QuickNodeRegistryMutation> {
    if (this.#mode === "off") return { ok: true, skipped: true };
    const key = quickNodeRegistryKey(network, this.#runTag, list);
    try {
      const desired = sortedUnique(items);
      const restOptions = effectiveRestOptions(this.options);
      let current: string[] | undefined;
      try {
        const payload = await qnRest(
          "GET",
          `/kv/rest/v1/lists/${encodeURIComponent(key)}`,
          undefined,
          restOptions,
        );
        const parsed = KvListResponseSchema.parse(payload);
        if (parsed.key !== key) throw new Error("QuickNode KV key mismatch");
        current = sortedUnique(parsed.items);
      } catch (error) {
        if (!(error instanceof QuickNodeError) || error.code !== "QN_HTTP_404") {
          throw error;
        }
      }
      if (current === undefined) {
        const payload = await qnRest(
          "POST",
          "/kv/rest/v1/lists",
          { key, items: desired },
          restOptions,
        );
        const parsed = KvListResponseSchema.parse(payload);
        if (parsed.key !== key) throw new Error("QuickNode KV key mismatch");
        return { ok: true, skipped: false };
      }
      const currentSet = new Set(current);
      const desiredSet = new Set(desired);
      const addItems = desired.filter((item) => !currentSet.has(item));
      const removeItems = current.filter((item) => !desiredSet.has(item));
      if (addItems.length === 0 && removeItems.length === 0) {
        return { ok: true, skipped: false };
      }
      const payload = await qnRest(
        "PATCH",
        `/kv/rest/v1/lists/${encodeURIComponent(key)}`,
        { addItems, removeItems },
        restOptions,
      );
      const parsed = KvListResponseSchema.parse(payload);
      if (parsed.key !== key) throw new Error("QuickNode KV key mismatch");
      return { ok: true, skipped: false };
    } catch (error) {
      this.#log({
        evt: "kv_sync_failed",
        action: "replace",
        list,
        code: resultCode(error),
      });
      return { ok: false, skipped: false };
    }
  }

  async patch(
    network: RegistryNetwork,
    list: RegistryList,
    addItems: readonly string[],
    removeItems: readonly string[],
  ): Promise<QuickNodeRegistryMutation> {
    if (this.#mode === "off") return { ok: true, skipped: true };
    const key = quickNodeRegistryKey(network, this.#runTag, list);
    const additions = sortedUnique(addItems);
    const removals = sortedUnique(removeItems).filter(
      (item) => !additions.includes(item),
    );
    try {
      const payload = await qnRest(
        "PATCH",
        `/kv/rest/v1/lists/${key}`,
        { addItems: additions, removeItems: removals },
        effectiveRestOptions(this.options),
      );
      const parsed = KvListResponseSchema.parse(payload);
      if (parsed.key !== key) throw new Error("QuickNode KV key mismatch");
      return { ok: true, skipped: false };
    } catch (error) {
      this.#log({
        evt: "kv_sync_failed",
        action: "patch",
        list,
        code: resultCode(error),
      });
      return { ok: false, skipped: false };
    }
  }

  async link(
    network: RegistryNetwork,
    owner: string,
    delegate: string,
  ): Promise<readonly QuickNodeRegistryMutation[]> {
    assertAddress(owner);
    assertAddress(delegate);
    return await Promise.all([
      this.patch(network, "accounts", [owner], []),
      this.patch(network, "delegates", [delegate], []),
    ]);
  }

  async revoke(
    network: RegistryNetwork,
    owner: string,
    delegate: string,
  ): Promise<readonly QuickNodeRegistryMutation[]> {
    assertAddress(owner);
    assertAddress(delegate);
    return await Promise.all([
      this.patch(network, "accounts", [], [owner]),
      this.patch(network, "delegates", [], [delegate]),
      this.patch(network, "frozen", [], [owner]),
    ]);
  }

  async freeze(
    network: RegistryNetwork,
    account: string,
    frozen: boolean,
  ): Promise<QuickNodeRegistryMutation> {
    assertAddress(account);
    return await this.patch(
      network,
      "frozen",
      frozen ? [account] : [],
      frozen ? [] : [account],
    );
  }

  async reconcile(
    network: RegistryNetwork,
    snapshot: QuickNodeRegistrySnapshot,
  ): Promise<Readonly<Record<RegistryList, QuickNodeRegistryMutation>>> {
    const results = await Promise.all(
      RegistryListSchema.options.map(
        async (list) => [list, await this.replace(network, list, snapshot[list])] as const,
      ),
    );
    return Object.fromEntries(results) as Record<
      RegistryList,
      QuickNodeRegistryMutation
    >;
  }

  async refreshPolicyCatalog(
    network: RegistryNetwork,
    snapshot: Pick<QuickNodeRegistrySnapshot, "tx_types" | "issuers">,
  ): Promise<Readonly<Record<"tx_types" | "issuers", QuickNodeRegistryMutation>>> {
    const [txTypes, issuers] = await Promise.all([
      this.replace(network, "tx_types", snapshot.tx_types),
      this.replace(network, "issuers", snapshot.issuers),
    ]);
    return Object.freeze({ tx_types: txTypes, issuers });
  }
}

function isLoopbackRequest(request: Request | undefined): boolean {
  if (!(request instanceof Request)) return false;
  const hostname = new URL(request.url).hostname;
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

/** Build the registry with both runtime-local and request-local proof. */
export function createQuickNodeKvRegistryForRequest(
  context: QuickNodeRegistryRequestContext,
): QuickNodeKvRegistry {
  const env = context.env ?? {};
  return new QuickNodeKvRegistry({
    env,
    runtimeLocal: env.HARBOR_LOCAL_DEV === "true",
    requestLocal: isLoopbackRequest(context.request),
    ...(context.fetcher ? { fetcher: context.fetcher } : {}),
    ...(context.log ? { log: context.log } : {}),
  });
}

function assertAddress(value: string): void {
  if (!isValidClassicAddress(value)) throw new Error("invalid XRPL address");
}

function parsePermissions(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return delegablePolicyTypes(
    z.array(z.string().min(1).max(64)).max(10).parse(parsed),
  );
}

/** D1-backed source used by the local/admin reconcile operation. */
export class D1QuickNodeRegistrySource implements QuickNodeRegistrySource {
  constructor(
    private readonly db: D1Database,
    private readonly catalogManifest: unknown,
    private readonly configuredPayerAccounts: Readonly<
      Partial<Record<RegistryNetwork, readonly string[]>>
    > = {},
    private readonly configuredFrozenPayerAccounts: Readonly<
      Partial<Record<RegistryNetwork, readonly string[]>>
    > = {},
  ) {}

  async links(network: RegistryNetwork): Promise<readonly QuickNodeLinkSnapshot[]> {
    const result = await this.db
      .prepare(
        "SELECT owner, delegate, permissions, status, revoke_tx, frozen_at FROM links WHERE network = ?",
      )
      .bind(RegistryNetworkSchema.parse(network))
      .all<RawLinkRow>();
    return result.results.map((row) => {
      assertAddress(row.owner);
      assertAddress(row.delegate);
      const status = z
        .enum(["pending", "active", "suspended", "revoked"])
        .parse(row.status);
      return {
        owner: row.owner,
        delegate: row.delegate,
        permissions: parsePermissions(row.permissions),
        status,
        revokePending: row.revoke_tx !== null,
        frozen: row.frozen_at !== null,
      };
    });
  }

  async policies(network: RegistryNetwork): Promise<readonly QuickNodePolicySnapshot[]> {
    const result = await this.db
      .prepare("SELECT json FROM policies WHERE network = ?")
      .bind(RegistryNetworkSchema.parse(network))
      .all<RawPolicyRow>();
    return result.results.map((row) => {
      const parsed = PolicySchema.parse(JSON.parse(row.json) as unknown);
      return {
        allowed_tx_types: parsed.allowed_tx_types,
        issuer_allowlist: parsed.issuer_allowlist,
      };
    });
  }

  async payerAccounts(network: RegistryNetwork): Promise<readonly string[]> {
    const accounts = this.configuredPayerAccounts[network] ?? [];
    for (const account of accounts) assertAddress(account);
    return accounts;
  }

  async frozenPayerAccounts(
    network: RegistryNetwork,
  ): Promise<readonly string[]> {
    const accounts = this.configuredFrozenPayerAccounts[network] ?? [];
    for (const account of accounts) assertAddress(account);
    return accounts;
  }

  catalog(): unknown {
    return this.catalogManifest;
  }
}

/** Durable per-run RPC totals. Callers keep writes best-effort. */
export class D1QuickNodeRpcCounterStore {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async increment(run: string, rawCounts: QuickNodeRpcCounts): Promise<void> {
    const tag = RunTagSchema.parse(run);
    const counts = RpcCountsSchema.parse(rawCounts);
    if (counts.calls_quicknode === 0 && counts.calls_fallback === 0) return;
    await this.db
      .prepare(
        `INSERT INTO qn_rpc_counters
          (run_tag, calls_quicknode, calls_fallback, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(run_tag) DO UPDATE SET
          calls_quicknode = calls_quicknode + excluded.calls_quicknode,
          calls_fallback = calls_fallback + excluded.calls_fallback,
          updated_at = excluded.updated_at`,
      )
      .bind(
        tag,
        counts.calls_quicknode,
        counts.calls_fallback,
        this.now().toISOString(),
      )
      .run();
  }

  async setWatchdogFrozenCount(run: string, rawCount: number): Promise<void> {
    const tag = RunTagSchema.parse(run);
    const count = z.number().int().nonnegative().parse(rawCount);
    await this.db
      .prepare(
        `INSERT INTO qn_rpc_counters
          (run_tag, watchdog_frozen_count, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(run_tag) DO UPDATE SET
          watchdog_frozen_count = excluded.watchdog_frozen_count,
          updated_at = excluded.updated_at`,
      )
      .bind(tag, count, this.now().toISOString())
      .run();
  }

  async read(run: string): Promise<QuickNodeRunCounters> {
    const tag = RunTagSchema.parse(run);
    const row = await this.db
      .prepare(
        `SELECT calls_quicknode, calls_fallback,
          webhook_confirmations, webhook_last_at,
          watchdog_ledgers_seen, watchdog_last_ledger, watchdog_events,
          watchdog_frozen_count
         FROM qn_rpc_counters WHERE run_tag = ?`,
      )
      .bind(tag)
      .first<QuickNodeRunCounters>();
    return RunCountersSchema.parse(
      row ?? {
        calls_quicknode: 0,
        calls_fallback: 0,
        webhook_confirmations: 0,
        webhook_last_at: null,
        watchdog_ledgers_seen: 0,
        watchdog_last_ledger: null,
        watchdog_events: 0,
        watchdog_frozen_count: 0,
      },
    );
  }
}

function decodedCurrency(value: string): string | undefined {
  if (value === "XRP") return undefined;
  if (/^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3}$/.test(value)) return value;
  if (!/^[A-Fa-f0-9]{40}$/.test(value)) return undefined;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })
      .decode(bytes)
      .replace(/\0+$/u, "");
  } catch {
    return undefined;
  }
  return /^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{1,20}$/.test(decoded)
    ? decoded
    : undefined;
}

/** Extract strict `CURRENCY.rIssuer` values without exposing catalog text. */
export function catalogIssuerItems(value: unknown): string[] {
  const issuers = new Set<string>();
  const seen = new Set<object>();
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object") return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    const record = candidate as Record<string, unknown>;
    if (
      typeof record.currency === "string" &&
      typeof record.issuer === "string" &&
      isValidClassicAddress(record.issuer)
    ) {
      const currency = decodedCurrency(record.currency);
      if (currency) issuers.add(`${currency}.${record.issuer}`);
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return [...issuers].sort();
}

function delegablePolicyTypes(values: readonly string[]): string[] {
  const items: string[] = [];
  for (const value of values) {
    try {
      items.push(...validatePermissions([value]));
    } catch {
      // A policy can constrain owner-signed transaction types that Harbor must
      // never delegate. Such entries must not weaken the watchdog allowlist.
    }
  }
  return sortedUnique(items);
}

export async function buildQuickNodeRegistrySnapshot(
  source: QuickNodeRegistrySource,
  network: RegistryNetwork,
): Promise<QuickNodeRegistrySnapshot> {
  const [links, policies, payerAccounts, frozenPayerAccounts, catalog] = await Promise.all([
    source.links(network),
    source.policies(network),
    source.payerAccounts(network),
    source.frozenPayerAccounts?.(network) ?? Promise.resolve([]),
    source.catalog(),
  ]);
  const linked = links.filter(
    (link) => link.status !== "revoked" && !link.revokePending,
  );
  const accounts = linked.map((link) => link.owner);
  const delegates = linked.map((link) => link.delegate);
  const frozen = linked
    .filter((link) => link.frozen)
    .map((link) => link.owner);
  const txTypes = [
    ...linked.flatMap((link) => link.permissions),
    ...delegablePolicyTypes(
      policies.flatMap((policy) => policy.allowed_tx_types),
    ),
  ];
  const issuers = catalogIssuerItems(catalog);
  return Object.freeze({
    accounts: Object.freeze(
      sortedUnique([...accounts, ...payerAccounts, ...frozenPayerAccounts]),
    ),
    delegates: Object.freeze(sortedUnique(delegates)),
    frozen: Object.freeze(sortedUnique([...frozen, ...frozenPayerAccounts])),
    tx_types: Object.freeze(sortedUnique(txTypes)),
    issuers: Object.freeze(sortedUnique(issuers)),
  });
}
