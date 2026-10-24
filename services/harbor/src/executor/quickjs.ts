import {
  getQuickJS,
  newQuickJSWASMModule,
  newVariant,
  RELEASE_SYNC,
  shouldInterruptAfterDeadline,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from "quickjs-emscripten";

import { guardCode } from "../guard";
import type { ProviderCall } from "./providers";

export const EXECUTION_TIMEOUT_MS = 10_000;
export const MAX_OP_CALLS = 30;

let quickJsModule: Promise<QuickJSWASMModule> | undefined;

function isWorkerd(): boolean {
  return (
    typeof navigator !== "undefined" &&
    navigator.userAgent.toLocaleLowerCase().includes("cloudflare")
  );
}

function loadQuickJS(): Promise<QuickJSWASMModule> {
  if (quickJsModule) return quickJsModule;
  if (!isWorkerd()) {
    quickJsModule = getQuickJS();
    return quickJsModule;
  }

  // Workerd cannot fetch a package-relative .wasm URL at runtime. Supplying a
  // Wrangler-bundled module directly keeps the fallback fully offline there.
  // https://github.com/justjake/quickjs-emscripten#webassembly-loading
  quickJsModule = import(
    "../../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm?module"
  ).then(({ default: wasmModule }) =>
    newQuickJSWASMModule(newVariant(RELEASE_SYNC, { wasmModule })),
  );
  return quickJsModule;
}

export type QuickJsExecutionOptions = {
  invoke: ProviderCall;
  operations: readonly string[];
  timeoutMs?: number;
  maxCalls?: number;
};

function validateLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function guestBootstrap(operations: readonly string[]): string {
  return `
const __harbor = Object.create(null);
for (const __name of ${JSON.stringify(operations)}) {
  const __parts = __name.split(".");
  let __cursor = __harbor;
  for (let __index = 0; __index < __parts.length - 1; __index++) {
    const __part = __parts[__index];
    __cursor = __cursor[__part] ??= Object.create(null);
  }
  const __method = __parts[__parts.length - 1];
  __cursor[__method] = async (__args = {}) =>
    JSON.parse(await __harborCall(__name, JSON.stringify(__args)));
}
Object.freeze(__harbor);
globalThis.harbor = __harbor;
globalThis.fetch = () => { throw new Error("Outbound network access is disabled"); };
`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run a Harbor script in an isolated QuickJS VM.
 *
 * The only host capability installed in the VM is `__harborCall`; QuickJS does
 * not inherit host globals, bindings, or network access. Calls cross the bridge
 * as JSON so guest objects cannot retain references into the loader Worker.
 */
export async function executeQuickJS(
  source: string,
  options: QuickJsExecutionOptions,
): Promise<unknown> {
  const code = guardCode(source);
  const timeoutMs = validateLimit(
    options.timeoutMs ?? EXECUTION_TIMEOUT_MS,
    "timeoutMs",
  );
  const maxCalls = validateLimit(options.maxCalls ?? MAX_OP_CALLS, "maxCalls");
  const deadline = Date.now() + timeoutMs;
  const QuickJS = await loadQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(64 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
  const context = runtime.newContext();
  const pending = new Set<QuickJSDeferredPromise>();
  const hostCalls = new Set<Promise<void>>();
  let active = true;
  let calls = 0;

  const settle = (
    deferred: QuickJSDeferredPromise,
    kind: "resolve" | "reject",
    value: QuickJSHandle,
  ): void => {
    if (!active || !deferred.alive) {
      value.dispose();
      return;
    }
    deferred[kind](value);
    value.dispose();
  };

  const callHandle = context.newFunction(
    "__harborCall",
    (nameHandle, argsHandle) => {
      const deferred = context.newPromise();
      pending.add(deferred);

      const name = context.getString(nameHandle);
      const argsJson = context.getString(argsHandle);
      const operation = async (): Promise<void> => {
        if (++calls > maxCalls) {
          throw new Error(`Operation call limit exceeded (${maxCalls})`);
        }
        if (Date.now() >= deadline) {
          throw new Error(`Script execution timed out after ${timeoutMs}ms`);
        }
        const args = JSON.parse(argsJson) as unknown;
        const result = await options.invoke(name, args);
        const serialized = JSON.stringify(result);
        if (serialized === undefined) {
          throw new Error("Operation result is not JSON serializable");
        }
        if (!active || !deferred.alive) return;
        settle(deferred, "resolve", context.newString(serialized));
      };

      const hostCall = operation()
        .catch((error: unknown) => {
          if (!active || !deferred.alive) return;
          settle(deferred, "reject", context.newError(errorMessage(error)));
        })
        .finally(() => {
          pending.delete(deferred);
          hostCalls.delete(hostCall);
        });
      hostCalls.add(hostCall);
      // Once the host promise settles, resume all guest promise continuations.
      void deferred.settled.then(() => {
        if (active && runtime.alive) {
          const jobs = runtime.executePendingJobs();
          if ("error" in jobs && jobs.error) jobs.error.dispose();
        }
      });
      return deferred.handle;
    },
  );

  context.setProp(context.global, "__harborCall", callHandle);
  callHandle.dispose();

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const evaluation = context.evalCode(
      `${guestBootstrap(options.operations)}\n(async () => {\n${code}\n})()`,
      "harbor-script.js",
    );
    const promiseHandle = context.unwrapResult(evaluation);
    try {
      const resolvedPromise = context.resolvePromise(promiseHandle);
      // Start the async IIFE immediately. If it reaches a host call, that
      // bridge schedules another drain when it settles; scripts without host
      // calls can finish entirely in this first drain.
      context.unwrapResult(runtime.executePendingJobs());
      const resolved = await Promise.race([
        resolvedPromise,
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`Script execution timed out after ${timeoutMs}ms`)),
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]);
      return context.unwrapResult(resolved).consume((handle) =>
        context.dump(handle),
      );
    } finally {
      promiseHandle.dispose();
    }
  } catch (error) {
    // Dispose guest continuations before waiting, then do not report failure
    // until every admitted host call has settled. This prevents an unsafe
    // retry racing a late mutation.
    active = false;
    for (const deferred of pending) deferred.dispose();
    pending.clear();
    await Promise.allSettled([...hostCalls]);
    throw error;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    active = false;
    for (const deferred of pending) deferred.dispose();
    pending.clear();
    context.dispose();
    runtime.dispose();
  }
}

export const runQuickJS = executeQuickJS;
