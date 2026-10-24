import type { Envelope } from "../contracts";
import type { OpContext, OpRegistry } from "../catalog/registry";
import { DocsMcpError } from "../adapters/docs-mcp";
import { XrplRpcError, type XrplRpc } from "../adapters/xrpl-rpc";
import type { GuardrailsEnv } from "../aws/guardrails";
import { BuildValidationError } from "../exec/build";
import { SubmitValidationError } from "../exec/submit";
import { errorEnvelope, GuardError, invokeOp } from "../guard";
import { screenEnvelope } from "../guard/screen";
import { ApprovalExpiredError, ExecutionLifetimeError } from "./errors";
import { X402OperationError } from "../ops/x402";
import { Ap4mPurchaseError } from "../ops/ap4m";
import {
  isReviewedLocalTradingContext,
  localTradingMarkersPresent,
} from "../local-trading";
import {
  isReviewedLocalTradingIsolatedV1Context,
  localTradingIsolatedV1MarkersPresent,
} from "../local-trading-isolated-v1";
import {
  isReviewedLocalTradingIsolatedOnboardingV1Context,
  localTradingIsolatedOnboardingV1MarkersPresent,
} from "../local-trading-isolated-onboarding-v1";
import {
  isReviewedLocalTradingOnboardingContext,
  localTradingOnboardingMarkersPresent,
} from "../local-trading-onboarding";
import {
  createQuickNodeRoutedRpc,
  type RpcTrust,
  type QuickNodeRpcEnv,
} from "../quicknode/rpc";
import { D1QuickNodeRpcCounterStore } from "../quicknode/kv-registry";

export type ProviderCall = (
  operationName: string,
  args?: unknown,
) => Promise<Envelope<unknown>>;

export type HarborMethod = (args?: unknown) => Promise<Envelope<unknown>>;

export type HarborNamespace = {
  readonly [segment: string]: HarborNamespace | HarborMethod;
};

export type HarborProvider = {
  /** The object exposed to user code as `harbor`. */
  readonly harbor: HarborNamespace;
  /** Flat bridge used by Dynamic Worker RPC and the QuickJS host callback. */
  readonly invoke: ProviderCall;
};

export type ProviderRegistry = Pick<OpRegistry, "get" | "list">;

export type ProviderBudget = {
  consume(operationName: string): void;
};

export const LOCAL_EXTERNAL_MUTATION_DISABLED =
  "LOCAL_EXTERNAL_MUTATION_DISABLED";
export const LOCAL_X402_OPERATION_DISABLED = "LOCAL_X402_OPERATION_DISABLED";
export const LOCAL_TRADING_OPERATION_DISABLED =
  "LOCAL_TRADING_OPERATION_DISABLED";
export const LOCAL_TRADING_NETWORK_DISABLED = "LOCAL_TRADING_NETWORK_DISABLED";
export const LOCAL_TRADING_ONBOARDING_OPERATION_DISABLED =
  "LOCAL_TRADING_ONBOARDING_OPERATION_DISABLED";
export const LOCAL_TRADING_ONBOARDING_NETWORK_DISABLED =
  "LOCAL_TRADING_ONBOARDING_NETWORK_DISABLED";

const LOCAL_EXTERNAL_MUTATION_MESSAGE =
  "External mutations are disabled in local read-only mode";
const SAFE_EXECUTION_LIFETIME_CODES = new Set([
  "EXECUTION_CONTRACT_UNSUPPORTED",
  "EXECUTION_CONTRACT_MISMATCH",
  "EXECUTION_SNAPSHOT_STALE",
  "EXECUTION_SNAPSHOT_INVALID",
  "TRANSACTION_WINDOW_TOO_SHORT",
  "APPROVAL_EXPIRED",
  "QUOTE_EXPIRED",
  "FEE_LOAD_UNSAFE",
  "ACCOUNT_SEQUENCE_CHANGED",
  "BALANCE_INVARIANT_CHANGED",
  "APPROVAL_PREFLIGHT_REQUIRED",
  "APPROVAL_ALREADY_PREFLIGHTED",
  "APPROVAL_INVALIDATED",
  "APPROVAL_RECOVERY_NOT_READY",
  "APPROVAL_RECOVERY_STATE_CHANGED",
  "APPROVAL_RECOVERY_INCOMPLETE",
  "APPROVAL_RECOVERY_CONFLICT",
  "APPROVAL_TRANSACTION_MISMATCH",
  "RELAY_ALREADY_ATTEMPTED",
  "SUBMISSION_PENDING",
]);
const LOCAL_X402_OPERATION_MESSAGE =
  "Operation is disabled in the local x402 signing profile";
const LOCAL_TRADING_OPERATION_MESSAGE =
  "Operation is disabled in the local trading signing profile";
const LOCAL_TRADING_NETWORK_MESSAGE =
  "Only testnet operations are allowed in the local trading signing profile";
const LOCAL_TRADING_ONBOARDING_OPERATION_MESSAGE =
  "Operation is disabled in the local trading onboarding profile";
const LOCAL_TRADING_ONBOARDING_NETWORK_MESSAGE =
  "Only testnet operations are allowed in the local trading onboarding profile";
const LOCAL_EXTERNAL_MUTATION_OPS = new Set([
  "account.link",
  "account.revoke",
  "tx.approvalPreflight",
  "tx.approvalReconcile",
  "tx.execute",
  "tx.submit",
]);
// Health and the x402 connectivity probe are unauthenticated HTTP routes, not
// operations. Keep the signing principal's operation capability to this one
// reviewed payment path so newly registered operations remain denied by default.
const LOCAL_X402_OPERATION_ALLOWLIST = new Set(["x402.pay"]);
// This is the complete externally callable surface needed for the reviewed
// trading flow. tx.swap performs its own quote, preflight, and simulation;
// tx.execute performs the policy read internally. Keeping those implementation
// details out of this set prevents newly registered read or mutation operations
// from inheriting a signing capability.
export const LOCAL_TRADING_OPERATION_ALLOWLIST = new Set([
  "tx.swap",
  "tx.approvalPreflight",
  "tx.approvalReconcile",
  "tx.execute",
  "tx.submit",
  "tx.status",
]);
export const LOCAL_TRADING_ONBOARDING_OPERATION_ALLOWLIST = new Set([
  "onboarding.readiness",
  "account.link",
  "account.status",
  "account.revoke",
  "ledger.account.info",
  "ledger.account.lines",
  "ledger.account.tx",
  "policy.get",
  "policy.set",
  "tx.trustSet",
  "tx.approvalPreflight",
  "tx.execute",
  "tx.submit",
  "tx.status",
]);

const SAFE_XRPL_ERROR_CODES = new Set([
  "MAINNET_EXECUTION_DISABLED",
  "XRPL_ERROR",
  "XRPL_INVALID_COMMAND",
  "XRPL_INVALID_ENDPOINT",
  "XRPL_MALFORMED_RESPONSE",
  "XRPL_PROTOCOL_ERROR",
  "XRPL_RESPONSE_TOO_LARGE",
  "XRPL_TIMEOUT",
  "XRPL_TRANSPORT_ERROR",
  "XRPL_UNSAFE_COMMAND",
  "actNotFound",
  "entryNotFound",
  "noCurrent",
  "noNetwork",
  "objectNotFound",
  "srcCurMalformed",
  "tooBusy",
  "txnNotFound",
]);

const SAFE_XRPL_SOFT_EMPTY_CODES = new Set([
  "actNotFound",
  "entryNotFound",
  "objectNotFound",
  "txnNotFound",
]);

const SAFE_DOCS_ERROR_CODES = Object.freeze({
  INVALID_QUERY: "DOCS_INVALID_QUERY",
  INVALID_RESPONSE: "DOCS_INVALID_RESPONSE",
  TRANSPORT_ERROR: "DOCS_TRANSPORT_ERROR",
  UPSTREAM_ERROR: "DOCS_UPSTREAM_ERROR",
} satisfies Record<DocsMcpError["code"], string>);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isXrplRpc(value: unknown): value is XrplRpc {
  return isRecord(value) && typeof value.request === "function";
}

function isD1Database(value: unknown): value is D1Database {
  return isRecord(value) && typeof value.prepare === "function";
}

async function persistRpcTrustBestEffort(
  ctx: OpContext,
  env: QuickNodeRpcEnv & { QN_RUN_TAG?: string },
  trust: RpcTrust,
): Promise<void> {
  if (trust.methods_quicknode === 0 && trust.methods_fallback === 0) return;
  const db = isD1Database(ctx.db)
    ? ctx.db
    : isRecord(ctx.env) && isD1Database(ctx.env.DB)
      ? ctx.env.DB
      : undefined;
  if (!db) return;
  try {
    await new D1QuickNodeRpcCounterStore(db).increment(
      env.QN_RUN_TAG?.trim() || "run1",
      {
        calls_quicknode: trust.methods_quicknode,
        calls_fallback: trust.methods_fallback,
      },
    );
  } catch {
    // Observability is deliberately best-effort: a D1/configuration failure
    // must never change an operation result or its XRPL routing semantics.
    console.warn("qn_rpc_counter_failed", {
      evt: "qn_rpc_counter_failed",
      code: "QN_RPC_COUNTER_WRITE_FAILED",
    });
  }
}

function xrplErrorEnvelope(error: XrplRpcError): Envelope<never> {
  const code = SAFE_XRPL_ERROR_CODES.has(error.code)
    ? error.code
    : "XRPL_ERROR";
  return errorEnvelope("xrpl", new Error("XRPL request failed"), {
    code,
    kind:
      error.kind === "soft-empty" && SAFE_XRPL_SOFT_EMPTY_CODES.has(code)
        ? "soft-empty"
        : "error",
  });
}

function docsErrorEnvelope(error: DocsMcpError): Envelope<never> {
  return errorEnvelope("docs", new Error("XRPL docs request failed"), {
    code: SAFE_DOCS_ERROR_CODES[error.code],
    ...(error.diagnostic
      ? {
          hint: [
            `stage=${error.diagnostic.stage}`,
            `status=${error.diagnostic.status}`,
            `content_type=${error.diagnostic.contentType}`,
            `elapsed_ms=${Math.min(60_000, Math.round(error.diagnostic.elapsedMs))}`,
          ].join(";"),
        }
      : {}),
  });
}

export class ProviderCallLimitError extends Error {
  readonly code = "OP_CALL_LIMIT";

  constructor(readonly limit: number) {
    super(`Operation call limit exceeded (${limit} per script)`);
    this.name = "ProviderCallLimitError";
  }
}

/**
 * Creates a stateful budget that can be shared by every bridge serving one
 * script execution. The outer executor normally owns this limit; accepting a
 * budget here keeps direct and fallback integrations equivalent.
 */
export function createProviderBudget(maxCalls: number): ProviderBudget {
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 0) {
    throw new RangeError("maxCalls must be a non-negative safe integer");
  }

  let calls = 0;
  return {
    consume(): void {
      calls += 1;
      if (calls > maxCalls) {
        throw new ProviderCallLimitError(maxCalls);
      }
    },
  };
}

function normalizeBudget(
  budget: ProviderBudget | number | undefined,
): ProviderBudget | undefined {
  return typeof budget === "number" ? createProviderBudget(budget) : budget;
}

function isLocalReadOnly(ctx: OpContext): boolean {
  const env = ctx.env;
  return (
    typeof env === "object" &&
    env !== null &&
    (env as Record<string, unknown>).HARBOR_LOCAL_READ_ONLY === "true"
  );
}

function requiresLocalX402OperationAllowlist(ctx: OpContext): boolean {
  const env = ctx.env;
  if (typeof env !== "object" || env === null) return false;
  const values = env as Record<string, unknown>;
  // A malformed signing profile must disable x402.pay without reopening the
  // general Harbor surface in a process that may still hold signing material.
  return (
    values.HARBOR_LOCAL_X402_RUNTIME_ENABLED === "true" ||
    values.HARBOR_LOCAL_X402_SIGNING_PROFILE !== undefined
  );
}

function requiresLocalTradingOperationAllowlist(ctx: OpContext): boolean {
  return localTradingMarkersPresent(ctx.env);
}

function requiresLocalTradingIsolatedV1OperationAllowlist(
  ctx: OpContext,
): boolean {
  return localTradingIsolatedV1MarkersPresent(ctx.env);
}

function requiresLocalTradingIsolatedOnboardingV1OperationAllowlist(
  ctx: OpContext,
): boolean {
  return localTradingIsolatedOnboardingV1MarkersPresent(ctx.env);
}

function requiresLocalTradingOnboardingOperationAllowlist(ctx: OpContext): boolean {
  return localTradingOnboardingMarkersPresent(ctx.env);
}

function localTradingRequestTargetsTestnet(
  operationName: string,
  args: unknown,
): boolean {
  const optionalNetwork =
    operationName === "tx.approvalPreflight" ||
    operationName === "tx.approvalReconcile" ||
    operationName === "tx.execute" ||
    operationName === "tx.submit" ||
    operationName === "tx.status";
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return optionalNetwork;
  }
  const network = (args as Record<string, unknown>).network;
  // Approval-backed submit/status calls may omit the network because their
  // principal-scoped stored build supplies it. Any explicit route is testnet.
  return (optionalNetwork && network === undefined) || network === "testnet";
}

function freezeNamespace(namespace: HarborNamespace): HarborNamespace {
  for (const value of Object.values(namespace)) {
    if (typeof value === "object") {
      freezeNamespace(value);
    }
  }
  return Object.freeze(namespace);
}

function buildHarborNamespace(
  operationNames: readonly string[],
  invoke: ProviderCall,
): HarborNamespace {
  const root = Object.create(null) as Record<
    string,
    HarborNamespace | HarborMethod
  >;

  for (const operationName of operationNames) {
    const segments = operationName.split(".");
    let namespace = root;

    for (const segment of segments.slice(0, -1)) {
      const current = namespace[segment];
      if (typeof current === "function") {
        throw new Error(
          `Operation namespace conflicts with operation: ${operationName}`,
        );
      }
      if (current === undefined) {
        namespace[segment] = Object.create(null) as HarborNamespace;
      }
      namespace = namespace[segment] as Record<
        string,
        HarborNamespace | HarborMethod
      >;
    }

    const leaf = segments.at(-1);
    if (leaf === undefined || namespace[leaf] !== undefined) {
      throw new Error(`Operation namespace conflict: ${operationName}`);
    }
    namespace[leaf] = (args: unknown = {}) => invoke(operationName, args);
  }

  return freezeNamespace(root);
}

/**
 * Builds both forms of the operation provider from the registry: a nested
 * `harbor.*` API for direct execution and a flat `invoke` bridge for sandbox
 * RPC. Both paths use the same guards and preserve the caller's principal in
 * the operation context.
 */
export function createHarborProvider(
  registry: ProviderRegistry,
  ctx: OpContext,
  budget?: ProviderBudget | number,
): HarborProvider {
  if (!ctx.principal.trim()) {
    throw new Error("Operation context requires a principal");
  }

  const callBudget = normalizeBudget(budget);
  const invoke: ProviderCall = async (operationName, args = {}) => {
    callBudget?.consume(operationName);

    if (
      requiresLocalX402OperationAllowlist(ctx) &&
      !LOCAL_X402_OPERATION_ALLOWLIST.has(operationName)
    ) {
      return errorEnvelope(
        operationName,
        new Error(LOCAL_X402_OPERATION_MESSAGE),
        { code: LOCAL_X402_OPERATION_DISABLED },
      );
    }

    if (
      requiresLocalTradingOperationAllowlist(ctx) &&
      (!isReviewedLocalTradingContext(ctx) ||
        !LOCAL_TRADING_OPERATION_ALLOWLIST.has(operationName))
    ) {
      return errorEnvelope(
        operationName,
        new Error(LOCAL_TRADING_OPERATION_MESSAGE),
        { code: LOCAL_TRADING_OPERATION_DISABLED },
      );
    }

    if (
      requiresLocalTradingIsolatedV1OperationAllowlist(ctx) &&
      (!isReviewedLocalTradingIsolatedV1Context(ctx) ||
        !LOCAL_TRADING_OPERATION_ALLOWLIST.has(operationName))
    ) {
      return errorEnvelope(
        operationName,
        new Error(LOCAL_TRADING_OPERATION_MESSAGE),
        { code: LOCAL_TRADING_OPERATION_DISABLED },
      );
    }

    if (
      requiresLocalTradingOnboardingOperationAllowlist(ctx) &&
      (!isReviewedLocalTradingOnboardingContext(ctx) ||
        !LOCAL_TRADING_ONBOARDING_OPERATION_ALLOWLIST.has(operationName))
    ) {
      return errorEnvelope(
        operationName,
        new Error(LOCAL_TRADING_ONBOARDING_OPERATION_MESSAGE),
        { code: LOCAL_TRADING_ONBOARDING_OPERATION_DISABLED },
      );
    }

    if (
      requiresLocalTradingIsolatedOnboardingV1OperationAllowlist(ctx) &&
      (!isReviewedLocalTradingIsolatedOnboardingV1Context(ctx) ||
        !LOCAL_TRADING_ONBOARDING_OPERATION_ALLOWLIST.has(operationName))
    ) {
      return errorEnvelope(
        operationName,
        new Error(LOCAL_TRADING_ONBOARDING_OPERATION_MESSAGE),
        { code: LOCAL_TRADING_ONBOARDING_OPERATION_DISABLED },
      );
    }

    if (
      requiresLocalTradingOperationAllowlist(ctx) &&
      !localTradingRequestTargetsTestnet(operationName, args)
    ) {
      return errorEnvelope(
        operationName,
        new Error(LOCAL_TRADING_NETWORK_MESSAGE),
        { code: LOCAL_TRADING_NETWORK_DISABLED },
      );
    }

    if (
      requiresLocalTradingIsolatedV1OperationAllowlist(ctx) &&
      !localTradingRequestTargetsTestnet(operationName, args)
    ) {
      return errorEnvelope(
        operationName,
        new Error(LOCAL_TRADING_NETWORK_MESSAGE),
        { code: LOCAL_TRADING_NETWORK_DISABLED },
      );
    }

    if (
      requiresLocalTradingOnboardingOperationAllowlist(ctx) &&
      !localTradingRequestTargetsTestnet(operationName, args)
    ) {
      return errorEnvelope(
        operationName,
        new Error(LOCAL_TRADING_ONBOARDING_NETWORK_MESSAGE),
        { code: LOCAL_TRADING_ONBOARDING_NETWORK_DISABLED },
      );
    }

    if (
      requiresLocalTradingIsolatedOnboardingV1OperationAllowlist(ctx) &&
      !localTradingRequestTargetsTestnet(operationName, args)
    ) {
      return errorEnvelope(
        operationName,
        new Error(LOCAL_TRADING_ONBOARDING_NETWORK_MESSAGE),
        { code: LOCAL_TRADING_ONBOARDING_NETWORK_DISABLED },
      );
    }

    const op = registry.get(operationName);
    if (op === undefined) {
      return errorEnvelope(
        "harbor",
        new Error(`Unknown operation: ${operationName}`),
        { code: "UNKNOWN_OPERATION" },
      );
    }

    if (
      isLocalReadOnly(ctx) &&
      LOCAL_EXTERNAL_MUTATION_OPS.has(operationName)
    ) {
      return errorEnvelope(
        op.name,
        new Error(LOCAL_EXTERNAL_MUTATION_MESSAGE),
        { code: LOCAL_EXTERNAL_MUTATION_DISABLED },
      );
    }

    try {
      const env = isRecord(ctx.env)
        ? (ctx.env as QuickNodeRpcEnv & { QN_RUN_TAG?: string })
        : {};
      const injectedRpc = isXrplRpc(ctx.xrplRpc) ? ctx.xrplRpc : undefined;
      const routed = createQuickNodeRoutedRpc({
        env,
        operationName,
        quickNodeRpc: isXrplRpc(ctx.quickNodeRpc)
          ? ctx.quickNodeRpc
          : injectedRpc,
        fallbackRpc: isXrplRpc(ctx.fallbackXrplRpc)
          ? ctx.fallbackXrplRpc
          : injectedRpc,
      });
      const operationContext: OpContext = { ...ctx, xrplRpc: routed.rpc };
      let envelope: Envelope<unknown>;
      try {
        envelope = await invokeOp(op, operationContext, args, {
          asOf: new Date(),
          asOfBasis: "server-time",
        });
      } finally {
        await persistRpcTrustBestEffort(ctx, env, routed.trust());
      }
      const withRpcTrust: Envelope<unknown> = envelope.ok
        ? {
            ...envelope,
            trust: { ...(envelope.trust ?? {}), rpc: routed.trust() },
          }
        : envelope;
      return await screenEnvelope(operationName, withRpcTrust, {
        env:
          typeof ctx.env === "object" && ctx.env !== null
            ? (ctx.env as GuardrailsEnv)
            : undefined,
      });
    } catch (error) {
      if (error instanceof GuardError) {
        return errorEnvelope(op.name, error, { code: error.code });
      }
      if (error instanceof XrplRpcError) {
        return xrplErrorEnvelope(error);
      }
      if (error instanceof DocsMcpError) {
        return docsErrorEnvelope(error);
      }
      if (error instanceof ApprovalExpiredError) {
        return errorEnvelope(op.name, error, { code: error.code });
      }
      if (error instanceof X402OperationError) {
        return errorEnvelope(op.name, error, { code: error.code });
      }
      // `payer_frozen` is a reviewed policy gate, not a handler detail. Keep
      // every other AP4M error behind the generic provider boundary because
      // signing/decryption failures may contain sensitive context.
      if (
        error instanceof Ap4mPurchaseError &&
        error.code === "PAYER_FROZEN"
      ) {
        return errorEnvelope(op.name, new Error("AP4M payer is frozen"), {
          code: "PAYER_FROZEN",
        });
      }
      const safeExecutionCode =
        error instanceof ExecutionLifetimeError ||
        (error instanceof BuildValidationError &&
          SAFE_EXECUTION_LIFETIME_CODES.has(error.code))
          ? error.code
          : null;
      if (safeExecutionCode !== null) {
        return errorEnvelope(op.name, error, { code: safeExecutionCode });
      }
      if (
        error instanceof SubmitValidationError &&
        error.code === "APPROVAL_TRANSACTION_MISMATCH"
      ) {
        return errorEnvelope(op.name, error, { code: error.code });
      }
      // Handler/library errors are not trusted for disclosure: signing and
      // decryption failures can contain credentials in their messages.
      return errorEnvelope(op.name, new Error("Operation failed"), {
        code: "OPERATION_FAILED",
      });
    }
  };

  const operationNames = registry.list().map(({ name }) => name);
  return Object.freeze({
    harbor: buildHarborNamespace(operationNames, invoke),
    invoke,
  });
}
