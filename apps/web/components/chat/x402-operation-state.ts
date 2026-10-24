export const X402_RESOURCE = "compare" as const;
export const X402_MAX_PRICE_DROPS = "5000" as const;
export const X402_APPROVED_RECEIVER = "rnSXTVWEhMKhECNUEENzUi9QuMFoFpKghr" as const;

// Keep the existing slot stable so incompatible v1 receiver-less records are
// found and rejected instead of being bypassed by a freshly minted operation.
const STORAGE_SLOT = "pilot:x402:pending:v1";
const RECORD_VERSION = 2 as const;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const CLASSIC_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

export type X402OperationScope = {
  owner: string;
  network: "testnet";
  resource: typeof X402_RESOURCE;
  max_price_drops: typeof X402_MAX_PRICE_DROPS;
  receiver: typeof X402_APPROVED_RECEIVER;
};

export type PendingX402Operation = X402OperationScope & {
  version: 2;
  operation_id: string;
  payload_fingerprint: string;
  phase: "reserved" | "recovering" | "paid_journal_pending";
  created_at: string;
};

export type CompletedX402Operation = X402OperationScope & {
  version: 2;
  operation_id: string;
  payload_fingerprint: string;
  phase: "completed";
  created_at: string;
  completed_at: string;
  terminal: {
    result_status: "delivered";
    mode: "fixture" | "live-local";
    journal_status: "fixture" | "recorded";
  };
};

export type X402OperationRecord = PendingX402Operation | CompletedX402Operation;

export type PublicOperationStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type PublicOperationLockManager = {
  request<T>(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: unknown | null) => T | PromiseLike<T>,
  ): Promise<T>;
};

export type X402DispatchOptions = {
  createOperationId: () => string;
  expectedOperationId?: string;
  now?: () => Date;
};

export type X402DispatchOutcome<T> =
  | { kind: "dispatched"; operation: PendingX402Operation; value: T }
  | { kind: "contended"; operation: PendingX402Operation }
  | { kind: "completed"; operation: CompletedX402Operation };

export type X402TerminalSummary = CompletedX402Operation["terminal"];

function validateScope(scope: X402OperationScope): X402OperationScope {
  if (
    !CLASSIC_ADDRESS.test(scope.owner) ||
    scope.network !== "testnet" ||
    scope.resource !== X402_RESOURCE ||
    scope.max_price_drops !== X402_MAX_PRICE_DROPS ||
    scope.receiver !== X402_APPROVED_RECEIVER
  ) {
    throw new Error("The x402 operation scope is invalid.");
  }
  return scope;
}

export function x402PayloadFingerprint(scope: X402OperationScope): string {
  const valid = validateScope(scope);
  return JSON.stringify({
    owner: valid.owner,
    network: valid.network,
    resource: valid.resource,
    max_price_drops: valid.max_price_drops,
    receiver: valid.receiver,
  });
}

function storageKey(scope: X402OperationScope): string {
  const valid = validateScope(scope);
  return `${STORAGE_SLOT}:${valid.network}:${valid.owner}:${valid.resource}`;
}

function dispatchLockName(scope: X402OperationScope): string {
  const valid = validateScope(scope);
  return `${STORAGE_SLOT}:dispatch:${valid.network}:${valid.owner}:${valid.resource}`;
}

function parseRecord(value: string | null, scope: X402OperationScope): X402OperationRecord | undefined {
  if (!value) return undefined;
  let candidate: unknown;
  try {
    candidate = JSON.parse(value);
  } catch {
    throw new Error("The saved x402 recovery record is invalid.");
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("The saved x402 recovery record is invalid.");
  }
  const entry = candidate as Record<string, unknown>;
  const fingerprint = x402PayloadFingerprint(scope);
  if (
    entry.version !== RECORD_VERSION ||
    entry.owner !== scope.owner ||
    entry.network !== scope.network ||
    entry.resource !== scope.resource ||
    entry.max_price_drops !== scope.max_price_drops ||
    entry.receiver !== scope.receiver ||
    entry.payload_fingerprint !== fingerprint ||
    typeof entry.operation_id !== "string" ||
    !OPERATION_ID.test(entry.operation_id) ||
    typeof entry.created_at !== "string" ||
    !Number.isFinite(Date.parse(entry.created_at))
  ) {
    throw new Error("The saved x402 recovery record does not match this owner and payload.");
  }
  if (entry.phase === "completed") {
    const terminal = entry.terminal as Record<string, unknown> | undefined;
    if (
      typeof entry.completed_at !== "string" ||
      !Number.isFinite(Date.parse(entry.completed_at)) ||
      !terminal ||
      terminal.result_status !== "delivered" ||
      (terminal.mode !== "fixture" && terminal.mode !== "live-local") ||
      (terminal.journal_status !== "fixture" && terminal.journal_status !== "recorded") ||
      (terminal.mode === "fixture") !== (terminal.journal_status === "fixture")
    ) {
      throw new Error("The saved x402 completion record is invalid.");
    }
    return entry as unknown as CompletedX402Operation;
  }
  if (entry.phase !== "reserved" && entry.phase !== "recovering" && entry.phase !== "paid_journal_pending") {
    throw new Error("The saved x402 recovery record does not match this owner and payload.");
  }
  return entry as unknown as PendingX402Operation;
}

export function loadPendingX402Operation(
  storage: PublicOperationStorage,
  scope: X402OperationScope,
): PendingX402Operation | undefined {
  const record = parseRecord(storage.getItem(storageKey(scope)), scope);
  return record?.phase === "completed" ? undefined : record;
}

function reserveX402Operation(
  storage: PublicOperationStorage,
  scope: X402OperationScope,
  createOperationId: () => string,
  now: () => Date = () => new Date(),
  expectedOperationId?: string,
): PendingX402Operation {
  const existingRecord = parseRecord(storage.getItem(storageKey(scope)), scope);
  if (expectedOperationId) {
    if (!existingRecord || existingRecord.operation_id !== expectedOperationId) {
      throw new Error("The requested x402 recovery operation is no longer pending for this owner.");
    }
    if (existingRecord.phase === "completed") {
      throw new Error("The requested x402 operation is already complete.");
    }
    return existingRecord;
  }
  if (existingRecord?.phase === "completed") storage.removeItem(storageKey(scope));
  const existing = existingRecord?.phase === "completed" ? undefined : existingRecord;
  if (existing) return existing;
  const operationId = createOperationId();
  if (!OPERATION_ID.test(operationId)) throw new Error("The x402 operation identity is invalid.");
  const record: PendingX402Operation = {
    version: RECORD_VERSION,
    ...validateScope(scope),
    operation_id: operationId,
    payload_fingerprint: x402PayloadFingerprint(scope),
    phase: "reserved",
    created_at: now().toISOString(),
  };
  storage.setItem(storageKey(scope), JSON.stringify(record));
  return record;
}

/**
 * Serialize reservation and the complete request/stream lifetime across tabs.
 * A contending tab fails immediately instead of queuing a second initial
 * dispatch after the first tab reaches a terminal result.
 */
export async function withLockedX402OperationDispatch<T>(
  locks: PublicOperationLockManager | undefined,
  storage: PublicOperationStorage,
  scope: X402OperationScope,
  options: X402DispatchOptions,
  dispatch: (operation: PendingX402Operation) => T | PromiseLike<T>,
): Promise<X402DispatchOutcome<T>> {
  if (!locks || typeof locks.request !== "function") {
    throw new Error("This browser cannot safely lock x402 dispatch across tabs. x402 is blocked.");
  }
  let callbackRan = false;
  const result = await locks.request(
    dispatchLockName(scope),
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      callbackRan = true;
      if (!lock) {
        const operation = parseRecord(storage.getItem(storageKey(scope)), scope);
        if (!operation) {
          throw new Error("Another tab is handling x402, but its durable operation identity is unavailable.");
        }
        return operation.phase === "completed"
          ? { kind: "completed" as const, operation }
          : { kind: "contended" as const, operation };
      }
      const record = parseRecord(storage.getItem(storageKey(scope)), scope);
      if (
        options.expectedOperationId &&
        record?.phase === "completed" &&
        record.operation_id === options.expectedOperationId
      ) {
        return { kind: "completed" as const, operation: record };
      }
      const operation = reserveX402Operation(
        storage,
        scope,
        options.createOperationId,
        options.now,
        options.expectedOperationId,
      );
      const value = await dispatch(operation);
      return { kind: "dispatched" as const, operation, value };
    },
  );
  if (!callbackRan) {
    throw new Error("The browser did not confirm the x402 dispatch lock. x402 is blocked.");
  }
  return result;
}

export function markX402OperationRecovering(
  storage: PublicOperationStorage,
  scope: X402OperationScope,
  operationId: string,
): PendingX402Operation {
  const current = loadPendingX402Operation(storage, scope);
  if (!current || current.operation_id !== operationId) {
    throw new Error("The x402 recovery identity does not match the pending operation.");
  }
  const next = current.phase === "paid_journal_pending"
    ? current
    : { ...current, phase: "recovering" as const };
  storage.setItem(storageKey(scope), JSON.stringify(next));
  return next;
}

export function markX402OperationJournalPending(
  storage: PublicOperationStorage,
  scope: X402OperationScope,
  operationId: string,
): PendingX402Operation {
  const current = loadPendingX402Operation(storage, scope);
  if (!current || current.operation_id !== operationId) {
    throw new Error("The paid x402 journal recovery identity does not match the pending operation.");
  }
  const next = { ...current, phase: "paid_journal_pending" as const };
  storage.setItem(storageKey(scope), JSON.stringify(next));
  return next;
}

export function completeX402Operation(
  storage: PublicOperationStorage,
  scope: X402OperationScope,
  operationId: string,
  terminal: X402TerminalSummary,
  now: () => Date = () => new Date(),
): CompletedX402Operation {
  const current = loadPendingX402Operation(storage, scope);
  if (!current || current.operation_id !== operationId) {
    throw new Error("The x402 terminal proof does not match the pending operation.");
  }
  if (
    terminal.result_status !== "delivered" ||
    (terminal.mode === "fixture") !== (terminal.journal_status === "fixture")
  ) {
    throw new Error("The x402 terminal summary is invalid.");
  }
  const completed: CompletedX402Operation = {
    ...current,
    phase: "completed",
    completed_at: now().toISOString(),
    terminal,
  };
  storage.setItem(storageKey(scope), JSON.stringify(completed));
  return completed;
}
