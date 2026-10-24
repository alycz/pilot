import type { Envelope } from "../contracts";
import type { OpContext, OpRegistry } from "../catalog/registry";
import { XrplRpcError } from "../adapters/xrpl-rpc";
import { errorEnvelope, GuardError, invokeOp } from "../guard";

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

const SAFE_XRPL_ERROR_CODES = new Set([
  "MAINNET_EXECUTION_DISABLED",
  "XRPL_ERROR",
  "XRPL_INVALID_COMMAND",
  "XRPL_INVALID_ENDPOINT",
  "XRPL_MALFORMED_RESPONSE",
  "XRPL_PROTOCOL_ERROR",
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

    const op = registry.get(operationName);
    if (op === undefined) {
      return errorEnvelope(
        "harbor",
        new Error(`Unknown operation: ${operationName}`),
        { code: "UNKNOWN_OPERATION" },
      );
    }

    try {
      return await invokeOp(op, ctx, args, {
        asOf: new Date(),
        asOfBasis: "server-time",
      });
    } catch (error) {
      if (error instanceof GuardError) {
        return errorEnvelope(op.name, error, { code: error.code });
      }
      if (error instanceof XrplRpcError) {
        return xrplErrorEnvelope(error);
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
