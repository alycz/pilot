import {
  registry as defaultRegistry,
  type OpContext,
  type OpRegistry,
} from "../catalog/registry";
import { guardCode, truncateOutput } from "../guard";
import {
  EXECUTION_TIMEOUT_MS,
  executeQuickJS,
  MAX_OP_CALLS,
} from "./quickjs";
import { createHarborProvider } from "./providers";

const COMPATIBILITY_DATE = "2026-10-06";
const MAIN_MODULE = "agent.js";
const USER_MODULE = "user.js";

export type ExecutorRuntime = "auto" | "dynamic" | "quickjs";

export type DynamicHarborBinding = {
  invoke(operationName: string, args?: unknown): Promise<unknown>;
};

export type ExecuteOptions = {
  ctx: OpContext;
  registry?: OpRegistry;
  runtime?: ExecutorRuntime;
  loader?: Pick<WorkerLoader, "load">;
  /**
   * Workers RPC stub scoped to this execution's principal. A plain host object
   * is sufficient for unit fakes; deployed Workers should pass a loopback
   * WorkerEntrypoint stub.
   */
  rpc?: DynamicHarborBinding;
  timeoutMs?: number;
  maxCalls?: number;
};

type DynamicWorkerReply =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

class DynamicLoaderUnavailableError extends Error {
  constructor(cause: unknown) {
    super("Dynamic Worker Loader is unavailable", { cause });
    this.name = "DynamicLoaderUnavailableError";
  }
}

function validateLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function dynamicWorkerSource(
  operations: readonly string[],
  timeoutMs: number,
  maxCalls: number,
): string {
  return `
import { runUserScript } from "./${USER_MODULE}";

const OPERATIONS = ${JSON.stringify(operations)};

function makeHarbor(binding, inFlight) {
  const harbor = Object.create(null);
  let calls = 0;
  const deadline = Date.now() + ${timeoutMs};
  for (const name of OPERATIONS) {
    const parts = name.split(".");
    let cursor = harbor;
    for (let index = 0; index < parts.length - 1; index++) {
      const part = parts[index];
      cursor = cursor[part] ??= Object.create(null);
    }
    cursor[parts[parts.length - 1]] = async (args = {}) => {
      calls += 1;
      if (calls > ${maxCalls}) {
        throw new Error("Operation call limit exceeded (${maxCalls})");
      }
      if (Date.now() >= deadline) {
        throw new Error("Script execution timed out after ${timeoutMs}ms");
      }
      const call = Promise.resolve().then(() => binding.invoke(name, args));
      inFlight.add(call);
      try {
        return await call;
      } finally {
        inFlight.delete(call);
      }
    };
  }
  return harbor;
}

export default {
  async fetch(_request, env) {
    const inFlight = new Set();
    try {
      const harbor = makeHarbor(env.HARBOR, inFlight);
      const fetch = () => {
        throw new Error("Outbound network access is disabled");
      };
      const value = await Promise.race([
        runUserScript(harbor, fetch),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error("Script execution timed out after ${timeoutMs}ms")),
          ${timeoutMs},
        )),
      ]);
      return Response.json({ ok: true, value: value === undefined ? null : value });
    } catch (error) {
      // Never report a timeout while an admitted operation may still mutate
      // state. Waiting makes client retries safe; operation handlers own their
      // own upstream timeouts and idempotency controls.
      await Promise.allSettled([...inFlight]);
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ ok: false, error: message }, { status: 400 });
    }
  },
};
`;
}

function userWorkerSource(code: string): string {
  // Keep untrusted source in a non-entrypoint module. Even malformed source
  // that escapes this wrapper cannot receive the main module's `env` argument
  // or obtain the HARBOR RPC capability except through the budgeted methods.
  return `export async function runUserScript(harbor, fetch) {\n${code}\n}`;
}

function parseDynamicReply(value: unknown): DynamicWorkerReply {
  if (value === null || typeof value !== "object" || !("ok" in value)) {
    throw new Error("Dynamic Worker returned an invalid response");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.ok === true && "value" in candidate) {
    return { ok: true, value: candidate.value };
  }
  if (candidate.ok === false && typeof candidate.error === "string") {
    return { ok: false, error: candidate.error };
  }
  throw new Error("Dynamic Worker returned an invalid response");
}

async function executeDynamic(
  loader: Pick<WorkerLoader, "load">,
  rpc: DynamicHarborBinding,
  code: string,
  operations: readonly string[],
  timeoutMs: number,
  maxCalls: number,
): Promise<unknown> {
  // Dynamic Workers are capability-based: the only binding supplied is the
  // Harbor RPC stub, and globalOutbound:null blocks all network egress.
  // https://developers.cloudflare.com/dynamic-workers/usage/bindings/
  // https://developers.cloudflare.com/dynamic-workers/usage/egress-control/
  let worker: WorkerStub;
  try {
    worker = loader.load({
      compatibilityDate: COMPATIBILITY_DATE,
      mainModule: MAIN_MODULE,
      modules: {
        [MAIN_MODULE]: dynamicWorkerSource(operations, timeoutMs, maxCalls),
        [USER_MODULE]: userWorkerSource(code),
      },
      env: { HARBOR: rpc },
      globalOutbound: null,
      limits: { cpuMs: timeoutMs, subRequests: maxCalls },
    });
  } catch (cause) {
    // No guest code has run yet, so falling back cannot duplicate an op call.
    throw new DynamicLoaderUnavailableError(cause);
  }
  const entrypoint = worker.getEntrypoint(undefined, {
    limits: { cpuMs: timeoutMs, subRequests: maxCalls },
  });
  // The guest enforces the deadline and waits for any already-admitted RPC
  // call before returning an error. The Loader CPU limit stops synchronous
  // runaway code without racing a host-side mutation.
  const response = await entrypoint.fetch(
    new Request("https://harbor.invalid/execute"),
  );
  const reply = parseDynamicReply(await response.json());
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

/**
 * Execute a model-written script against the registry-backed `harbor` API.
 * Returns serialized, 24 KiB-capped output suitable for MCP text content.
 */
export async function execute(
  source: string,
  options: ExecuteOptions,
): Promise<string> {
  const code = guardCode(source);
  const timeoutMs = validateLimit(
    options.timeoutMs ?? EXECUTION_TIMEOUT_MS,
    "timeoutMs",
  );
  const maxCalls = validateLimit(options.maxCalls ?? MAX_OP_CALLS, "maxCalls");
  const registry = options.registry ?? defaultRegistry;
  const operations = registry.list().map(({ name }) => name);
  const provider = createHarborProvider(registry, options.ctx, maxCalls);
  const runtime = options.runtime ?? "auto";

  let value: unknown;
  if (runtime !== "quickjs" && options.loader && options.rpc) {
    try {
      value = await executeDynamic(
        options.loader,
        options.rpc,
        code,
        operations,
        timeoutMs,
        maxCalls,
      );
    } catch (error) {
      if (!(error instanceof DynamicLoaderUnavailableError)) throw error;
      // Loader construction failed before guest code could run. It is safe to
      // degrade to QuickJS without repeating a mutating operation.
      value = await executeQuickJS(code, {
        invoke: provider.invoke,
        operations,
        timeoutMs,
        maxCalls,
      });
    }
  } else {
    value = await executeQuickJS(code, {
      invoke: provider.invoke,
      operations,
      timeoutMs,
      maxCalls,
    });
  }

  return truncateOutput(value);
}

export const run = execute;
