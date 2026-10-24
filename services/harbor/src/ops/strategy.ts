import { isValidClassicAddress } from "xrpl";
import { z } from "zod";

import type { OpContext, OpDef } from "../catalog/registry";
import {
  StrategyAuditEventSchema,
  StrategyAuthorizeArgsSchema,
  StrategyCreateArgsSchema,
  StrategyKillSwitchSchema,
  StrategyOwnerAuthorizationSchema,
  StrategySchema,
  type Strategy,
  type StrategyAuditEvent,
  type StrategyAuthorizeArgs,
  type StrategyCreateArgs,
  type StrategyKillSwitch,
  type StrategyOwnerAuthorization,
} from "../contracts";
import { StrategyStore } from "../strategy/store";

const OwnerSchema = z
  .string()
  .refine(isValidClassicAddress, "owner must be a valid XRPL classic address");
const NetworkSchema = z.literal("testnet");
const StrategyIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const RequestIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const MandateDigestSchema = z
  .string()
  .regex(/^[A-Fa-f0-9]{64}$/)
  .transform((value) => value.toUpperCase());
const ReasonSchema = z.string().trim().min(1).max(240);

export const StrategyListOperationArgsSchema = z
  .object({ owner: OwnerSchema, network: NetworkSchema })
  .strict();
export const StrategyCreateOperationArgsSchema = StrategyCreateArgsSchema.extend({
  request_id: RequestIdSchema,
}).strict();
export const StrategyScopedOperationArgsSchema = z
  .object({
    strategy_id: StrategyIdSchema,
    owner: OwnerSchema,
    network: NetworkSchema,
  })
  .strict();
export const StrategyAuditOperationArgsSchema = z
  .object({
    strategy_id: StrategyIdSchema,
    owner: OwnerSchema,
    network: NetworkSchema,
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();
export const StrategyAuthorizeOperationArgsSchema = StrategyAuthorizeArgsSchema.extend({
  owner: OwnerSchema,
  network: NetworkSchema,
  request_id: RequestIdSchema,
}).strict();
export const StrategyControlOperationArgsSchema = StrategyScopedOperationArgsSchema.extend({
  reason: ReasonSchema,
  request_id: RequestIdSchema,
}).strict();
export const StrategyResumeOperationArgsSchema = StrategyScopedOperationArgsSchema.extend({
  mandate_version: z.number().int().positive(),
  mandate_digest: MandateDigestSchema,
  authorization: StrategyOwnerAuthorizationSchema,
  request_id: RequestIdSchema,
}).strict();
export const StrategyGlobalKillSetArgsSchema = z
  .object({
    owner: OwnerSchema,
    network: NetworkSchema,
    enabled: z.boolean(),
    reason: ReasonSchema,
    strategy_id: StrategyIdSchema.optional(),
    mandate_version: z.number().int().positive().optional(),
    mandate_digest: MandateDigestSchema.optional(),
    authorization: StrategyOwnerAuthorizationSchema.optional(),
    request_id: RequestIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.enabled) return;
    for (const field of [
      "strategy_id",
      "mandate_version",
      "mandate_digest",
      "authorization",
    ] as const) {
      if (value[field] === undefined) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is required to clear the global kill switch`,
        });
      }
    }
  });

export interface StrategyOpsStore {
  runControlOnce<T>(
    requestId: string,
    operation: string,
    requestDigest: string,
    action: () => Promise<T>,
  ): Promise<T>;
  createDraft(args: StrategyCreateArgs, now: Date): Promise<Strategy>;
  getStrategy(strategyId: string): Promise<Strategy | null>;
  listStrategies(owner?: string): Promise<Strategy[]>;
  authorizeAndActivate(
    args: StrategyAuthorizeArgs,
    now: Date,
  ): Promise<Strategy>;
  pause(strategyId: string, now: Date, reason?: string): Promise<Strategy>;
  resume(strategyId: string, now: Date): Promise<Strategy>;
  stop(strategyId: string, now: Date, reason?: string): Promise<Strategy>;
  kill(strategyId: string, now: Date, reason: string): Promise<Strategy>;
  getGlobalKill(
    owner: string,
    network: "testnet",
  ): Promise<StrategyKillSwitch>;
  setGlobalKill(
    owner: string,
    network: "testnet",
    enabled: boolean,
    reason: string,
    now: Date,
  ): Promise<StrategyKillSwitch>;
  listAudit(
    strategyId: string,
    limit?: number,
  ): Promise<StrategyAuditEvent[]>;
}

export interface StrategyOpsServices {
  store?: StrategyOpsStore;
  now?: () => Date;
}

type StrategyContext = OpContext & {
  db?: D1Database;
  env?: { DB?: D1Database };
  strategyServices?: StrategyOpsServices;
};

function services(input: OpContext): StrategyOpsServices {
  return (input as StrategyContext).strategyServices ?? {};
}

function database(input: OpContext): D1Database {
  const context = input as StrategyContext;
  const db = context.db ?? context.env?.DB;
  if (!db) throw new Error("strategy store is not configured");
  return db;
}

function storeFor(input: OpContext): StrategyOpsStore {
  return services(input).store ?? new StrategyStore(database(input), input.principal);
}

function nowFor(input: OpContext): Date {
  const now = (services(input).now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) throw new Error("strategy clock is invalid");
  return now;
}

function exactStrategy(value: Strategy): Strategy {
  return StrategySchema.parse(value);
}

function exactAudit(value: readonly StrategyAuditEvent[]): StrategyAuditEvent[] {
  return value.map((event) => StrategyAuditEventSchema.parse(event));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("control request is not canonical");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("control request is not canonical");
}

async function controlDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

async function runControlOnce<T>(
  store: StrategyOpsStore,
  requestId: string,
  scope: { owner: string; network: "testnet" },
  operation: string,
  payload: unknown,
  action: () => Promise<T>,
): Promise<T> {
  // Pilot intentionally uses one Harbor principal for many isolated wallet
  // sessions. Namespace the durable receipt key so caller-selected request IDs
  // cannot collide with or replay another wallet's result.
  const receiptId = await controlDigest({
    owner: scope.owner,
    network: scope.network,
    request_id: requestId,
  });
  return store.runControlOnce(
    receiptId,
    operation,
    await controlDigest(payload),
    action,
  );
}

function assertScope(strategy: Strategy, owner: string, network: "testnet"): void {
  if (
    strategy.mandate.account !== owner ||
    strategy.mandate.network !== network
  ) {
    // Deliberately indistinguishable from a missing record so one wallet
    // session cannot use Harbor's shared Pilot principal as an oracle.
    throw new Error("strategy not found");
  }
}

async function scopedStrategy(
  store: StrategyOpsStore,
  strategyId: string,
  owner: string,
  network: "testnet",
): Promise<Strategy> {
  const strategy = await store.getStrategy(strategyId);
  if (!strategy) throw new Error("strategy not found");
  const parsed = exactStrategy(strategy);
  assertScope(parsed, owner, network);
  return parsed;
}

function assertFreshAuthorization(
  authorization: StrategyOwnerAuthorization,
  strategy: Strategy,
  mandateVersion: number,
  mandateDigest: string,
  now: Date,
): void {
  const parsed = StrategyOwnerAuthorizationSchema.parse(authorization);
  if (
    parsed.owner !== strategy.mandate.account ||
    parsed.mandate_version !== mandateVersion ||
    parsed.mandate_digest !== mandateDigest ||
    strategy.mandate.version !== mandateVersion ||
    strategy.mandate.digest !== mandateDigest
  ) {
    throw new Error("owner authorization does not bind the current mandate");
  }
  if (Date.parse(parsed.approved_at) > now.getTime()) {
    throw new Error("owner authorization approval is in the future");
  }
  if (Date.parse(parsed.expires_at) <= now.getTime()) {
    throw new Error("owner authorization has expired");
  }
  if (
    now.getTime() < Date.parse(strategy.mandate.not_before) ||
    now.getTime() >= Date.parse(strategy.mandate.expires_at)
  ) {
    throw new Error("strategy mandate is not currently valid");
  }
}

async function requireOwnedStrategy(
  store: StrategyOpsStore,
  owner: string,
  network: "testnet",
): Promise<Strategy[]> {
  const strategies = (await store.listStrategies(owner)).map(exactStrategy);
  const scoped = strategies.filter(
    (strategy) => strategy.mandate.network === network,
  );
  if (scoped.length === 0) throw new Error("strategy not found");
  return scoped;
}

export async function handleStrategyCreate(
  input: OpContext,
  rawArgs: z.infer<typeof StrategyCreateOperationArgsSchema>,
): Promise<Strategy> {
  const args = StrategyCreateOperationArgsSchema.parse(rawArgs);
  const { request_id: requestId, ...draft } = args;
  const now = nowFor(input);
  const store = storeFor(input);
  return exactStrategy(
    await runControlOnce(store, requestId, { owner: draft.account, network: draft.network }, "strategy.create", args, async () => {
      if (Date.parse(draft.expires_at) <= now.getTime()) {
        throw new Error("mandate expiry must be in the future");
      }
      return store.createDraft(draft, now);
    }),
  );
}

export async function handleStrategyList(
  input: OpContext,
  rawArgs: z.infer<typeof StrategyListOperationArgsSchema>,
): Promise<Strategy[]> {
  const args = StrategyListOperationArgsSchema.parse(rawArgs);
  return (await storeFor(input).listStrategies(args.owner))
    .map(exactStrategy)
    .filter(
      (strategy) =>
        strategy.mandate.account === args.owner &&
        strategy.mandate.network === args.network,
    );
}

export async function handleStrategyGet(
  input: OpContext,
  rawArgs: z.infer<typeof StrategyScopedOperationArgsSchema>,
): Promise<Strategy> {
  const args = StrategyScopedOperationArgsSchema.parse(rawArgs);
  return scopedStrategy(
    storeFor(input),
    args.strategy_id,
    args.owner,
    args.network,
  );
}

export async function handleStrategyAudit(
  input: OpContext,
  rawArgs: z.infer<typeof StrategyAuditOperationArgsSchema>,
): Promise<StrategyAuditEvent[]> {
  const args = StrategyAuditOperationArgsSchema.parse(rawArgs);
  const store = storeFor(input);
  await scopedStrategy(store, args.strategy_id, args.owner, args.network);
  return exactAudit(await store.listAudit(args.strategy_id, args.limit));
}

export async function handleStrategyAuthorize(
  input: OpContext,
  rawArgs: z.infer<typeof StrategyAuthorizeOperationArgsSchema>,
): Promise<Strategy> {
  const args = StrategyAuthorizeOperationArgsSchema.parse(rawArgs);
  const store = storeFor(input);
  const strategy = await scopedStrategy(
    store,
    args.strategy_id,
    args.owner,
    args.network,
  );
  const now = nowFor(input);
  const requestId = args.request_id;
  return exactStrategy(await runControlOnce(
    store,
    requestId,
    { owner: args.owner, network: args.network },
    "strategy.authorize",
    args,
    async () => {
      assertFreshAuthorization(
        args.authorization,
        strategy,
        args.mandate_version,
        args.mandate_digest,
        now,
      );
      return store.authorizeAndActivate(
        {
          strategy_id: args.strategy_id,
          mandate_version: args.mandate_version,
          mandate_digest: args.mandate_digest,
          authorization: args.authorization,
        },
        now,
      );
    },
  ));
}

export async function handleStrategyPause(
  input: OpContext,
  rawArgs: z.infer<typeof StrategyControlOperationArgsSchema>,
): Promise<Strategy> {
  const args = StrategyControlOperationArgsSchema.parse(rawArgs);
  const store = storeFor(input);
  await scopedStrategy(store, args.strategy_id, args.owner, args.network);
  return exactStrategy(await runControlOnce(
    store,
    args.request_id,
    { owner: args.owner, network: args.network },
    "strategy.pause",
    args,
    () => store.pause(args.strategy_id, nowFor(input), args.reason),
  ));
}

export async function handleStrategyResume(
  input: OpContext,
  rawArgs: z.infer<typeof StrategyResumeOperationArgsSchema>,
): Promise<Strategy> {
  const args = StrategyResumeOperationArgsSchema.parse(rawArgs);
  const store = storeFor(input);
  const strategy = await scopedStrategy(
    store,
    args.strategy_id,
    args.owner,
    args.network,
  );
  const now = nowFor(input);
  return exactStrategy(await runControlOnce(
    store,
    args.request_id,
    { owner: args.owner, network: args.network },
    "strategy.resume",
    args,
    async () => {
      assertFreshAuthorization(
        args.authorization,
        strategy,
        args.mandate_version,
        args.mandate_digest,
        now,
      );
      return store.resume(args.strategy_id, now);
    },
  ));
}

export async function handleStrategyStop(
  input: OpContext,
  rawArgs: z.infer<typeof StrategyControlOperationArgsSchema>,
): Promise<Strategy> {
  const args = StrategyControlOperationArgsSchema.parse(rawArgs);
  const store = storeFor(input);
  await scopedStrategy(store, args.strategy_id, args.owner, args.network);
  return exactStrategy(await runControlOnce(
    store,
    args.request_id,
    { owner: args.owner, network: args.network },
    "strategy.stop",
    args,
    () => store.stop(args.strategy_id, nowFor(input), args.reason),
  ));
}

export async function handleStrategyKill(
  input: OpContext,
  rawArgs: z.infer<typeof StrategyControlOperationArgsSchema>,
): Promise<Strategy> {
  const args = StrategyControlOperationArgsSchema.parse(rawArgs);
  const store = storeFor(input);
  await scopedStrategy(store, args.strategy_id, args.owner, args.network);
  return exactStrategy(await runControlOnce(
    store,
    args.request_id,
    { owner: args.owner, network: args.network },
    "strategy.kill",
    args,
    () => store.kill(args.strategy_id, nowFor(input), args.reason),
  ));
}

export async function handleStrategyGlobalKillGet(
  input: OpContext,
  rawArgs: z.infer<typeof StrategyListOperationArgsSchema>,
): Promise<StrategyKillSwitch> {
  const args = StrategyListOperationArgsSchema.parse(rawArgs);
  const store = storeFor(input);
  await requireOwnedStrategy(store, args.owner, args.network);
  return StrategyKillSwitchSchema.parse(
    await store.getGlobalKill(args.owner, args.network),
  );
}

export async function handleStrategyGlobalKillSet(
  input: OpContext,
  rawArgs: z.infer<typeof StrategyGlobalKillSetArgsSchema>,
): Promise<StrategyKillSwitch> {
  const args = StrategyGlobalKillSetArgsSchema.parse(rawArgs);
  const store = storeFor(input);
  await requireOwnedStrategy(store, args.owner, args.network);
  const now = nowFor(input);
  return StrategyKillSwitchSchema.parse(await runControlOnce(
    store,
    args.request_id,
    { owner: args.owner, network: args.network },
    "strategy.globalKill.set",
    args,
    async () => {
      if (!args.enabled) {
        const strategy = await scopedStrategy(
          store,
          args.strategy_id!,
          args.owner,
          args.network,
        );
        assertFreshAuthorization(
          args.authorization!,
          strategy,
          args.mandate_version!,
          args.mandate_digest!,
          now,
        );
      }
      return store.setGlobalKill(
        args.owner,
        args.network,
        args.enabled,
        args.reason,
        now,
      );
    },
  ));
}

export const ops: OpDef[] = [
  {
    name: "strategy.create",
    family: "strategy",
    summary: "Create a non-authorizing Testnet rebalancer draft with immutable bounded limits.",
    tags: ["strategy", "testnet", "draft", "deterministic"],
    args: StrategyCreateOperationArgsSchema,
    returns: "a draft Strategy",
    caveats: [],
    example:
      'await harbor.strategy.create({ request_id: "request:create:1", kind: "xrp_issued_rebalancer_v1", network: "testnet", account: "r...", issued_asset: { currency: "524C555344000000000000000000000000000000", issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" }, allocation: { target_xrp_bps: 5000, lower_xrp_bps: 4500, upper_xrp_bps: 5500 }, limits: { max_order_value: "25", max_daily_value: "100", min_order_value: "1", max_fee_drops: "20", max_slippage_bps: 100, max_price_impact_bps: 100, min_xrp_reserve_drops: "12000000", fee_buffer_drops: "1000", max_xrp_exposure_drops: "1000000000", max_issued_exposure: "1000", min_liquidity_value: "50", cooldown_seconds: 300, max_quote_age_seconds: 20, max_ledger_gap: 1 }, interval_seconds: 300, execution_mode: "offer_create_fok", not_before: "2026-10-22T00:00:00.000Z", expires_at: "2026-10-23T00:00:00.000Z" })',
    handler: (ctx, args) =>
      handleStrategyCreate(
        ctx,
        args as z.infer<typeof StrategyCreateOperationArgsSchema>,
      ),
  },
  {
    name: "strategy.list",
    family: "strategy",
    summary: "List strategies for one exact owner and Testnet scope.",
    tags: ["strategy", "status", "testnet"],
    args: StrategyListOperationArgsSchema,
    returns: "owner-scoped Strategy records",
    caveats: [],
    example:
      'await harbor.strategy.list({ owner: "r...", network: "testnet" })',
    handler: (ctx, args) =>
      handleStrategyList(
        ctx,
        args as z.infer<typeof StrategyListOperationArgsSchema>,
      ),
  },
  {
    name: "strategy.get",
    family: "strategy",
    summary: "Read one exact owner-scoped Testnet strategy.",
    tags: ["strategy", "status", "testnet"],
    args: StrategyScopedOperationArgsSchema,
    returns: "a Strategy",
    caveats: [],
    example:
      'await harbor.strategy.get({ strategy_id: "strategy:...", owner: "r...", network: "testnet" })',
    handler: (ctx, args) =>
      handleStrategyGet(
        ctx,
        args as z.infer<typeof StrategyScopedOperationArgsSchema>,
      ),
  },
  {
    name: "strategy.audit",
    family: "strategy",
    summary: "Read a bounded owner-scoped decision and transaction audit trail.",
    tags: ["strategy", "audit", "testnet"],
    args: StrategyAuditOperationArgsSchema,
    returns: "StrategyAuditEvent records",
    caveats: [],
    example:
      'await harbor.strategy.audit({ strategy_id: "strategy:...", owner: "r...", network: "testnet", limit: 50 })',
    handler: (ctx, args) =>
      handleStrategyAudit(
        ctx,
        args as z.infer<typeof StrategyAuditOperationArgsSchema>,
      ),
  },
  {
    name: "strategy.authorize",
    family: "strategy",
    summary: "Activate an exact immutable mandate using fresh owner-approved authorization.",
    tags: ["strategy", "authorization", "activation", "testnet"],
    args: StrategyAuthorizeOperationArgsSchema,
    returns: "an active Strategy",
    caveats: [],
    example:
      'await harbor.strategy.authorize({ request_id: "request:authorize:1", strategy_id: "strategy:...", owner: "r...", network: "testnet", mandate_version: 1, mandate_digest: "64_HEX", authorization: { authorization_id: "authorization:...", method: "wallet_action_proof_v1", owner: "r...", mandate_digest: "64_HEX", mandate_version: 1, approved_at: "2026-10-22T00:00:00.000Z", expires_at: "2026-10-22T00:05:00.000Z" } })',
    handler: (ctx, args) =>
      handleStrategyAuthorize(
        ctx,
        args as z.infer<typeof StrategyAuthorizeOperationArgsSchema>,
      ),
  },
  {
    name: "strategy.pause",
    family: "strategy",
    summary: "Pause new strategy evaluations and submissions without cancelling in-flight work.",
    tags: ["strategy", "control", "pause", "testnet"],
    args: StrategyControlOperationArgsSchema,
    returns: "a paused Strategy",
    caveats: [],
    example:
      'await harbor.strategy.pause({ request_id: "request:pause:1", strategy_id: "strategy:...", owner: "r...", network: "testnet", reason: "Owner paused" })',
    handler: (ctx, args) =>
      handleStrategyPause(
        ctx,
        args as z.infer<typeof StrategyControlOperationArgsSchema>,
      ),
  },
  {
    name: "strategy.resume",
    family: "strategy",
    summary: "Resume an unchanged valid mandate using fresh owner authorization.",
    tags: ["strategy", "control", "resume", "authorization", "testnet"],
    args: StrategyResumeOperationArgsSchema,
    returns: "an active Strategy",
    caveats: [],
    example:
      'await harbor.strategy.resume({ request_id: "request:resume:1", strategy_id: "strategy:...", owner: "r...", network: "testnet", mandate_version: 1, mandate_digest: "64_HEX", authorization: { authorization_id: "authorization:...", method: "wallet_action_proof_v1", owner: "r...", mandate_digest: "64_HEX", mandate_version: 1, approved_at: "2026-10-22T00:00:00.000Z", expires_at: "2026-10-22T00:05:00.000Z" } })',
    handler: (ctx, args) =>
      handleStrategyResume(
        ctx,
        args as z.infer<typeof StrategyResumeOperationArgsSchema>,
      ),
  },
  {
    name: "strategy.stop",
    family: "strategy",
    summary: "Terminally stop this mandate version while preserving unresolved transaction state.",
    tags: ["strategy", "control", "stop", "testnet"],
    args: StrategyControlOperationArgsSchema,
    returns: "a stopped Strategy",
    caveats: [],
    example:
      'await harbor.strategy.stop({ request_id: "request:stop:1", strategy_id: "strategy:...", owner: "r...", network: "testnet", reason: "Owner stopped" })',
    handler: (ctx, args) =>
      handleStrategyStop(
        ctx,
        args as z.infer<typeof StrategyControlOperationArgsSchema>,
      ),
  },
  {
    name: "strategy.kill",
    family: "strategy",
    summary: "Kill new work for one strategy without promising cancellation of in-flight ledger work.",
    tags: ["strategy", "control", "kill", "testnet"],
    args: StrategyControlOperationArgsSchema,
    returns: "a terminally stopped Strategy",
    caveats: [],
    example:
      'await harbor.strategy.kill({ request_id: "request:kill:1", strategy_id: "strategy:...", owner: "r...", network: "testnet", reason: "Emergency stop" })',
    handler: (ctx, args) =>
      handleStrategyKill(
        ctx,
        args as z.infer<typeof StrategyControlOperationArgsSchema>,
      ),
  },
  {
    name: "strategy.globalKill.get",
    family: "strategy",
    summary: "Read the fail-closed owner-scoped Testnet strategy kill switch.",
    tags: ["strategy", "control", "kill", "status"],
    args: StrategyListOperationArgsSchema,
    returns: "StrategyKillSwitch",
    caveats: [],
    example:
      'await harbor.strategy.globalKill.get({ owner: "r...", network: "testnet" })',
    handler: (ctx, args) =>
      handleStrategyGlobalKillGet(
        ctx,
        args as z.infer<typeof StrategyListOperationArgsSchema>,
      ),
  },
  {
    name: "strategy.globalKill.set",
    family: "strategy",
    summary: "Set the global strategy kill switch; clearing it requires fresh owner authorization.",
    tags: ["strategy", "control", "kill", "authorization"],
    args: StrategyGlobalKillSetArgsSchema,
    returns: "StrategyKillSwitch",
    caveats: [],
    example:
      'await harbor.strategy.globalKill.set({ request_id: "request:global-kill:1", owner: "r...", network: "testnet", enabled: true, reason: "Emergency stop" })',
    handler: (ctx, args) =>
      handleStrategyGlobalKillSet(
        ctx,
        args as z.infer<typeof StrategyGlobalKillSetArgsSchema>,
      ),
  },
];
