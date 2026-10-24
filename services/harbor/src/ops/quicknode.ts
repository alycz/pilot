import catalogManifest from "../../catalog/manifest.json";
import { isValidClassicAddress } from "xrpl";
import { z } from "zod";

import type { OpContext, OpDef } from "../catalog/registry";
import {
  WatchdogEventSchema,
  type WatchdogEvent,
} from "../contracts";
import {
  DEFAULT_DELEGATED_PERMISSIONS,
  validatePermissions,
} from "../exec/delegation";
import {
  buildQuickNodeRegistrySnapshot,
  D1QuickNodeRpcCounterStore,
  D1QuickNodeRegistrySource,
  QuickNodeKvRegistry,
  type QuickNodeRegistryEnv,
  type QuickNodeRegistrySource,
  type RegistryMode,
  type RegistryNetwork,
} from "../quicknode/kv-registry";
import {
  QuickNodeWebhookEvidenceSchema,
  readQuickNodeWebhookEvidence,
  type QuickNodeWebhookEvidence,
} from "../quicknode/webhook";
import { readQuickNodeWatchdogEvents } from "../quicknode/watchdog";

const RegistryNetworkSchema = z.enum(["testnet", "devnet"]);
const MAX_SQLITE_INTEGER = 9_223_372_036_854_775_807n;
const AccountSchema = z
  .string()
  .refine(isValidClassicAddress, "account must be a valid XRPL classic address");
const EventsArgsSchema = z
  .object({
    account: AccountSchema.optional(),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();
const WebhookEvidenceArgsSchema = z
  .object({
    hash: z
      .string()
      .regex(/^[A-Fa-f0-9]{64}$/)
      .transform((value) => value.toUpperCase()),
  })
  .strict();
const UnfreezeArgsSchema = z.object({ account: AccountSchema }).strict();
const TestRegisterLinkArgsSchema = z
  .object({
    owner: AccountSchema,
    delegate: AccountSchema,
    network: RegistryNetworkSchema,
    permissions: z.array(z.string()).max(10).default([...DEFAULT_DELEGATED_PERMISSIONS]),
  })
  .strict();
const TestDeleteLinkArgsSchema = z
  .object({ owner: AccountSchema, network: RegistryNetworkSchema })
  .strict();
const StatusSchema = z
  .object({
    mode: z.enum(["off", "mock", "live"]),
    rpc: z
      .object({
        calls_quicknode: z.number().int().nonnegative(),
        calls_fallback: z.number().int().nonnegative(),
        share: z.number().finite().min(0).max(1),
      })
      .strict(),
    webhook: z
      .object({
        confirmations: z.number().int().nonnegative(),
        last_at: z.string().datetime().nullable(),
      })
      .strict(),
    watchdog: z
      .object({
        ledgers_seen: z.number().int().nonnegative(),
        last_ledger: z.number().int().nonnegative().nullable(),
        events: z.number().int().nonnegative(),
        frozen_count: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type QuickNodeStatus = z.infer<typeof StatusSchema>;

export interface QuickNodeStatusReader {
  read(mode: RegistryMode, runTag: string): Promise<QuickNodeStatus>;
}

export type QuickNodeOpsServices = Readonly<{
  registry?: QuickNodeKvRegistry;
  source?: QuickNodeRegistrySource;
  status?: QuickNodeStatusReader;
  authorizeAdmin?: (ctx: OpContext) => boolean | Promise<boolean>;
  events?: (
    principal: string,
    account: string | undefined,
    limit: number,
  ) => Promise<readonly WatchdogEvent[]>;
  webhookEvidence?: (
    principal: string,
    hash: string,
  ) => Promise<QuickNodeWebhookEvidence>;
  unfreeze?: (
    principal: string,
    account: string,
    network: RegistryNetwork,
  ) => Promise<{ scope: "link" | "payer"; unfrozen: boolean }>;
  registerTestLink?: (input: {
    principal: string;
    owner: string;
    delegate: string;
    network: RegistryNetwork;
    permissions: readonly string[];
  }) => Promise<void>;
  deleteTestLink?: (input: {
    principal: string;
    owner: string;
    network: RegistryNetwork;
  }) => Promise<boolean>;
  now?: () => Date;
  randomUUID?: () => string;
}>;

type QuickNodeOpContext = OpContext & {
  db?: D1Database;
  env?: QuickNodeRegistryEnv;
  request?: Request;
  quickNodeServices?: QuickNodeOpsServices;
};

export class D1QuickNodeStatusReader implements QuickNodeStatusReader {
  constructor(private readonly db: D1Database) {}

  async read(mode: RegistryMode, runTag: string): Promise<QuickNodeStatus> {
    const counters = await new D1QuickNodeRpcCounterStore(this.db).read(runTag);
    const totalRpcCalls =
      counters.calls_quicknode + counters.calls_fallback;
    return StatusSchema.parse({
      mode,
      rpc: {
        calls_quicknode: counters.calls_quicknode,
        calls_fallback: counters.calls_fallback,
        share:
          totalRpcCalls === 0 ? 0 : counters.calls_quicknode / totalRpcCalls,
      },
      webhook: {
        confirmations: counters.webhook_confirmations,
        last_at: counters.webhook_last_at,
      },
      watchdog: {
        ledgers_seen: counters.watchdog_ledgers_seen,
        last_ledger: counters.watchdog_last_ledger,
        events: counters.watchdog_events,
        frozen_count: counters.watchdog_frozen_count,
      },
    });
  }
}

function opContext(input: OpContext): QuickNodeOpContext {
  return input as QuickNodeOpContext;
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

function localRequest(input: QuickNodeOpContext): boolean {
  if (input.env?.HARBOR_LOCAL_DEV !== "true" || input.principal !== "local-dev") {
    return false;
  }
  if (!(input.request instanceof Request)) return false;
  return isLoopback(new URL(input.request.url).hostname);
}

function mode(environment: QuickNodeRegistryEnv): RegistryMode {
  const value = environment.QN_MODE?.trim() || "off";
  return z.enum(["off", "mock", "live"]).parse(value);
}

function runTag(environment: QuickNodeRegistryEnv): string {
  return z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/)
    .parse(environment.QN_RUN_TAG?.trim() || "run1");
}

function registryFor(input: QuickNodeOpContext): QuickNodeKvRegistry {
  if (input.quickNodeServices?.registry) return input.quickNodeServices.registry;
  const environment = input.env ?? {};
  return new QuickNodeKvRegistry({
    env: environment,
    runtimeLocal: environment.HARBOR_LOCAL_DEV === "true",
    requestLocal: localRequest(input),
  });
}

function sourceFor(input: QuickNodeOpContext): QuickNodeRegistrySource {
  if (input.quickNodeServices?.source) return input.quickNodeServices.source;
  if (!input.db) throw new Error("QuickNode registry source is not configured");
  return new D1QuickNodeRegistrySource(input.db, catalogManifest);
}

function statusFor(input: QuickNodeOpContext): QuickNodeStatusReader {
  if (input.quickNodeServices?.status) return input.quickNodeServices.status;
  if (!input.db) throw new Error("QuickNode status store is not configured");
  return new D1QuickNodeStatusReader(input.db);
}

async function requireReconcileAuthority(input: QuickNodeOpContext): Promise<void> {
  if (localRequest(input)) return;
  if (await input.quickNodeServices?.authorizeAdmin?.(input)) return;
  throw new Error("QuickNode KV reconcile requires local or admin authorization");
}

async function requireLocalOrAdmin(
  input: QuickNodeOpContext,
  operation: string,
): Promise<void> {
  if (localRequest(input)) return;
  if (await input.quickNodeServices?.authorizeAdmin?.(input)) return;
  throw new Error(`${operation} requires local or admin authorization`);
}

function database(input: QuickNodeOpContext): D1Database {
  if (!input.db) throw new Error("QuickNode database is not configured");
  return input.db;
}

function executionNetwork(input: QuickNodeOpContext): RegistryNetwork {
  return RegistryNetworkSchema.parse(input.env?.EXEC_NETWORK ?? "testnet");
}

export async function handleQuickNodeStatus(
  input: OpContext,
): Promise<QuickNodeStatus> {
  const ctx = opContext(input);
  const environment = ctx.env ?? {};
  return StatusSchema.parse(
    await statusFor(ctx).read(mode(environment), runTag(environment)),
  );
}

export async function handleQuickNodeReconcile(
  input: OpContext,
  rawArgs: { network: RegistryNetwork },
): Promise<{
  network: RegistryNetwork;
  run_tag: string;
  lists: Record<
    "accounts" | "delegates" | "frozen" | "tx_types" | "issuers",
    { count: number; ok: boolean; skipped: boolean }
  >;
}> {
  const ctx = opContext(input);
  await requireReconcileAuthority(ctx);
  const network = RegistryNetworkSchema.parse(rawArgs.network);
  const registry = registryFor(ctx);
  const snapshot = await buildQuickNodeRegistrySnapshot(sourceFor(ctx), network);
  const mutations = await registry.reconcile(network, snapshot);
  if (ctx.db && mutations.frozen.ok && !mutations.frozen.skipped) {
    try {
      await new D1QuickNodeRpcCounterStore(ctx.db).setWatchdogFrozenCount(
        registry.configuredRunTag,
        snapshot.frozen.length,
      );
    } catch {
      console.warn("qn_status_counter_failed", {
        evt: "qn_status_counter_failed",
        code: "QN_STATUS_COUNTER_WRITE_FAILED",
      });
    }
  }
  return {
    network,
    run_tag: registry.configuredRunTag,
    lists: {
      accounts: { count: snapshot.accounts.length, ...mutations.accounts },
      delegates: { count: snapshot.delegates.length, ...mutations.delegates },
      frozen: { count: snapshot.frozen.length, ...mutations.frozen },
      tx_types: { count: snapshot.tx_types.length, ...mutations.tx_types },
      issuers: { count: snapshot.issuers.length, ...mutations.issuers },
    },
  };
}

export async function handleQuickNodeEvents(
  input: OpContext,
  rawArgs: unknown,
): Promise<readonly WatchdogEvent[]> {
  const ctx = opContext(input);
  const args = EventsArgsSchema.parse(rawArgs);
  const events = ctx.quickNodeServices?.events
    ? await ctx.quickNodeServices.events(
        ctx.principal,
        args.account,
        args.limit,
      )
    : await readQuickNodeWatchdogEvents(
        database(ctx),
        ctx.principal,
        args.account,
        args.limit,
      );
  return Object.freeze(events.map((event) => WatchdogEventSchema.parse(event)));
}

export async function handleQuickNodeWebhookEvidence(
  input: OpContext,
  rawArgs: unknown,
): Promise<QuickNodeWebhookEvidence> {
  const ctx = opContext(input);
  const args = WebhookEvidenceArgsSchema.parse(rawArgs);
  const evidence = ctx.quickNodeServices?.webhookEvidence
    ? await ctx.quickNodeServices.webhookEvidence(ctx.principal, args.hash)
    : await readQuickNodeWebhookEvidence(
        database(ctx),
        ctx.principal,
        args.hash,
      );
  return QuickNodeWebhookEvidenceSchema.parse(evidence);
}

async function unfreezePrincipalAccount(
  ctx: QuickNodeOpContext,
  account: string,
  network: RegistryNetwork,
): Promise<{ scope: "link" | "payer"; unfrozen: boolean }> {
  if (ctx.quickNodeServices?.unfreeze) {
    return ctx.quickNodeServices.unfreeze(ctx.principal, account, network);
  }
  const db = database(ctx);
  const links = await db
    .prepare(
      `SELECT id, frozen_at FROM links
        WHERE principal = ? AND owner = ? AND network = ?
          AND status = 'active' AND revoke_tx IS NULL
        ORDER BY id LIMIT 2`,
    )
    .bind(ctx.principal, account, network)
    .all<{ id: string; frozen_at: string | null }>();
  if (links.results.length > 1) {
    throw new Error("account unfreeze target is ambiguous");
  }
  const link = links.results[0];
  if (link) {
    if (link.frozen_at === null) return { scope: "link", unfrozen: false };
    const result = await db
      .prepare(
        `UPDATE links SET frozen_at = NULL, frozen_reason = NULL
          WHERE id = ? AND principal = ? AND owner = ? AND network = ?
            AND frozen_at IS NOT NULL`,
      )
      .bind(link.id, ctx.principal, account, network)
      .run();
    return {
      scope: "link",
      unfrozen: Number(result.meta.changes ?? 0) === 1,
    };
  }

  const payers = await db
    .prepare(
      `SELECT owner, status, funded_balance_drops, funded_ledger_index
         FROM x402_payers
        WHERE principal = ? AND payer = ? AND network = ?
        ORDER BY owner LIMIT 2`,
    )
    .bind(ctx.principal, account, network)
    .all<{
      owner: string;
      status: string;
      funded_balance_drops: string | null;
      funded_ledger_index: number | null;
    }>();
  if (payers.results.length !== 1) {
    throw new Error(
      payers.results.length === 0
        ? "principal-scoped account not found"
        : "account unfreeze target is ambiguous",
    );
  }
  const payer = payers.results[0]!;
  if (payer.status === "ready") {
    return { scope: "payer", unfrozen: false };
  }
  if (
    payer.status !== "disabled" ||
    payer.funded_ledger_index === null ||
    !Number.isSafeInteger(payer.funded_ledger_index) ||
    payer.funded_ledger_index <= 0 ||
    payer.funded_balance_drops === null ||
    !/^[1-9][0-9]{0,18}$/.test(payer.funded_balance_drops) ||
    BigInt(payer.funded_balance_drops) > MAX_SQLITE_INTEGER
  ) {
    throw new Error("payer cannot be safely re-enabled");
  }
  const updatedAt = (ctx.quickNodeServices?.now ?? (() => new Date()))()
    .toISOString();
  const result = await db
    .prepare(
      `UPDATE x402_payers SET status = 'ready', updated_at = ?
        WHERE principal = ? AND owner = ? AND payer = ? AND network = ?
          AND status = 'disabled'
          AND funded_balance_drops = ?
          AND funded_ledger_index = ?`,
    )
    .bind(
      updatedAt,
      ctx.principal,
      payer.owner,
      account,
      network,
      payer.funded_balance_drops,
      payer.funded_ledger_index,
    )
    .run();
  if (Number(result.meta.changes ?? 0) !== 1) {
    throw new Error("payer state changed during recovery");
  }
  return {
    scope: "payer",
    unfrozen: true,
  };
}

export async function handleQuickNodeUnfreeze(
  input: OpContext,
  rawArgs: unknown,
): Promise<{
  account: string;
  network: RegistryNetwork;
  scope: "link" | "payer";
  status: "watching";
  unfrozen: boolean;
}> {
  const ctx = opContext(input);
  const args = UnfreezeArgsSchema.parse(rawArgs);
  const network = executionNetwork(ctx);
  const result = await unfreezePrincipalAccount(ctx, args.account, network);
  try {
    await registryFor(ctx).freeze(network, args.account, false);
  } catch {
    console.warn("kv_sync_failed", {
      evt: "kv_sync_failed",
      action: "patch",
      list: "frozen",
      code: "QN_KV_SYNC_FAILED",
    });
  }
  if (ctx.db) {
    try {
      const snapshot = await buildQuickNodeRegistrySnapshot(
        sourceFor(ctx),
        network,
      );
      await new D1QuickNodeRpcCounterStore(ctx.db).setWatchdogFrozenCount(
        runTag(ctx.env ?? {}),
        snapshot.frozen.length,
      );
    } catch {
      console.warn("qn_status_counter_failed", {
        evt: "qn_status_counter_failed",
        code: "QN_STATUS_COUNTER_WRITE_FAILED",
      });
    }
  }
  return {
    account: args.account,
    network,
    scope: result.scope,
    status: "watching",
    unfrozen: result.unfrozen,
  };
}

async function registerLocalTestLink(
  ctx: QuickNodeOpContext,
  input: z.output<typeof TestRegisterLinkArgsSchema>,
  permissions: readonly string[],
): Promise<void> {
  if (ctx.quickNodeServices?.registerTestLink) {
    await ctx.quickNodeServices.registerTestLink({
      principal: ctx.principal,
      owner: input.owner,
      delegate: input.delegate,
      network: input.network,
      permissions,
    });
    return;
  }
  const identifier = `qn-test:${
    (ctx.quickNodeServices?.randomUUID ?? (() => crypto.randomUUID()))()
  }`;
  const createdAt = (ctx.quickNodeServices?.now ?? (() => new Date()))().toISOString();
  // This deliberately invalid one-byte ciphertext is not a key. The local-only
  // watchdog fixture can be classified and frozen, while any accidental sign
  // attempt fails closed during AES-GCM unwrap.
  const invalidCiphertext = new Uint8Array([0]).buffer;
  const invalidIv = new Uint8Array(12).buffer;
  await database(ctx)
    .prepare(
      `INSERT INTO links
        (id, principal, owner, network, delegate, delegate_seed_enc, iv,
         key_backend, kms_key_id, kms_alias, permissions, status, last_ledger,
         revoke_tx, created_at, frozen_at, frozen_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'local', NULL, NULL, ?, 'active', NULL,
               NULL, ?, NULL, NULL)`,
    )
    .bind(
      identifier,
      ctx.principal,
      input.owner,
      input.network,
      input.delegate,
      invalidCiphertext,
      invalidIv,
      JSON.stringify(permissions),
      createdAt,
    )
    .run();
}

export async function handleQuickNodeTestRegisterLink(
  input: OpContext,
  rawArgs: unknown,
): Promise<{
  owner: string;
  delegate: string;
  network: RegistryNetwork;
  status: "active";
}> {
  const ctx = opContext(input);
  if (!localRequest(ctx)) {
    throw new Error("QuickNode test link registration is local-only");
  }
  const args = TestRegisterLinkArgsSchema.parse(rawArgs);
  const permissions = validatePermissions(args.permissions);
  await registerLocalTestLink(ctx, args, permissions);
  try {
    await registryFor(ctx).link(args.network, args.owner, args.delegate);
  } catch {
    console.warn("kv_sync_failed", {
      evt: "kv_sync_failed",
      action: "patch",
      list: "accounts",
      code: "QN_KV_SYNC_FAILED",
    });
  }
  return {
    owner: args.owner,
    delegate: args.delegate,
    network: args.network,
    status: "active",
  };
}

async function deleteLocalTestLink(
  ctx: QuickNodeOpContext,
  owner: string,
  network: RegistryNetwork,
): Promise<boolean> {
  if (ctx.quickNodeServices?.deleteTestLink) {
    return ctx.quickNodeServices.deleteTestLink({
      principal: ctx.principal,
      owner,
      network,
    });
  }
  const result = await database(ctx)
    .prepare(
      `DELETE FROM links
        WHERE principal = ? AND owner = ? AND network = ?
          AND id LIKE 'qn-test:%'
          AND key_backend = 'local'
          AND length(delegate_seed_enc) = 1
          AND length(iv) = 12`,
    )
    .bind(ctx.principal, owner, network)
    .run();
  return Number(result.meta.changes ?? 0) === 1;
}

export async function handleQuickNodeTestDeleteLink(
  input: OpContext,
  rawArgs: unknown,
): Promise<{
  owner: string;
  network: RegistryNetwork;
  deleted: boolean;
}> {
  const ctx = opContext(input);
  if (!localRequest(ctx)) {
    throw new Error("QuickNode test link cleanup is local-only");
  }
  const args = TestDeleteLinkArgsSchema.parse(rawArgs);
  const deleted = await deleteLocalTestLink(ctx, args.owner, args.network);
  if (deleted) {
    try {
      await handleQuickNodeReconcile(ctx, { network: args.network });
    } catch {
      console.warn("kv_sync_failed", {
        evt: "kv_sync_failed",
        action: "reconcile",
        list: "accounts",
        code: "QN_KV_SYNC_FAILED",
      });
    }
  }
  return { owner: args.owner, network: args.network, deleted };
}

export const ops: OpDef[] = [
  {
    name: "quicknode.status",
    family: "quicknode",
    summary: "Read structured QuickNode routing, confirmation, and watchdog counters.",
    tags: ["quicknode", "rpc", "webhook", "watchdog", "status"],
    args: z.object({}).strict(),
    returns: "QuickNodeStatus",
    caveats: [],
    example: "await harbor.quicknode.status({})",
    handler: (ctx) => handleQuickNodeStatus(ctx),
  },
  {
    name: "quicknode.kv.reconcile",
    family: "quicknode",
    summary: "Rebuild the QuickNode KV registry from Harbor state and the catalog.",
    tags: ["quicknode", "kv", "registry", "admin"],
    args: z.object({ network: RegistryNetworkSchema }).strict(),
    returns: "QuickNodeKvReconcileResult",
    caveats: [],
    example: 'await harbor.quicknode.kv.reconcile({ network: "testnet" })',
    handler: (ctx, args) =>
      handleQuickNodeReconcile(
        ctx,
        args as { network: RegistryNetwork },
      ),
  },
  {
    name: "quicknode.events",
    family: "quicknode",
    summary: "Read recent principal-scoped QuickNode watchdog events.",
    tags: ["quicknode", "streams", "watchdog", "events"],
    args: EventsArgsSchema,
    returns: "WatchdogEvent[]",
    caveats: [],
    example:
      'await harbor.quicknode.events({ account: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", limit: 20 })',
    handler: (ctx, args) => handleQuickNodeEvents(ctx, args),
  },
  {
    name: "quicknode.webhookEvidence",
    family: "quicknode",
    summary: "Read one principal-scoped fixed-field webhook confirmation proof.",
    tags: ["quicknode", "webhook", "evidence", "principal-scoped"],
    args: WebhookEvidenceArgsSchema,
    returns: "QuickNodeWebhookEvidence",
    caveats: [],
    example:
      'await harbor.quicknode.webhookEvidence({ hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })',
    handler: (ctx, args) => handleQuickNodeWebhookEvidence(ctx, args),
  },
  {
    name: "quicknode.unfreeze",
    family: "quicknode",
    summary: "Remove a Harbor-local freeze from an authorized account link.",
    tags: ["quicknode", "watchdog", "admin", "unfreeze"],
    args: UnfreezeArgsSchema,
    returns: "QuickNodeUnfreezeResult",
    caveats: [],
    example:
      'await harbor.quicknode.unfreeze({ account: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh" })',
    handler: (ctx, args) => handleQuickNodeUnfreeze(ctx, args),
  },
  {
    name: "quicknode.test.registerLink",
    family: "quicknode",
    summary: "Register a fail-closed local-only watchdog test link.",
    tags: ["quicknode", "watchdog", "test", "local-only"],
    args: TestRegisterLinkArgsSchema,
    returns: "QuickNodeTestLink",
    caveats: [],
    example:
      'await harbor.quicknode.test.registerLink({ owner: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", delegate: "rJdYtgaiEgzL7xD2QdPKg5xoHkWc7CZjvm", network: "testnet" })',
    handler: (ctx, args) => handleQuickNodeTestRegisterLink(ctx, args),
  },
  {
    name: "quicknode.test.deleteLink",
    family: "quicknode",
    summary: "Delete only a synthetic local watchdog test link.",
    tags: ["quicknode", "watchdog", "test", "local-only", "cleanup"],
    args: TestDeleteLinkArgsSchema,
    returns: "QuickNodeTestLinkCleanup",
    caveats: [],
    example:
      'await harbor.quicknode.test.deleteLink({ owner: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", network: "testnet" })',
    handler: (ctx, args) => handleQuickNodeTestDeleteLink(ctx, args),
  },
];
