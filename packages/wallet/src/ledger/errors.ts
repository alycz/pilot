import type { LedgerSigningMode } from "./clear-sign.js";

export type LedgerFailurePhase = "connect" | "sign";
export type LedgerFailureCode =
  | "LEDGER_BLIND_SIGNING_DISABLED"
  | "LEDGER_LOCKED"
  | "LEDGER_APP_NOT_OPEN"
  | "LEDGER_UNSUPPORTED_BROWSER"
  | "LEDGER_VIRTUAL_UNAVAILABLE"
  | "CONNECT_CANCELLED"
  | "CONNECT_FAILED"
  | "SIGN_CANCELLED"
  | "SIGN_FAILED";

export type LedgerFailure = Readonly<{
  code: LedgerFailureCode;
  message: string;
}>;

export class LedgerManagerError extends Error {
  constructor(readonly kind: "unsupported" | "cancelled" | "virtual-unavailable") {
    super("Ledger device operation failed.");
    this.name = "LedgerManagerError";
  }
}

function records(error: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const queue = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0 && found.length < 8) {
    const current = queue.shift();
    if (current === null || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const record = current as Record<string, unknown>;
    found.push(record);
    queue.push(record.originalError, record.error, record.cause);
  }
  return found;
}

function hasStatus(error: unknown, expected: string): boolean {
  const lower = expected.toLowerCase();
  return records(error).some((record) =>
    [record.errorCode, record.statusCode, record.code].some(
      (value) => typeof value === "string" && value.toLowerCase() === lower,
    ),
  );
}

function hasTag(error: unknown, expected: RegExp): boolean {
  return records(error).some((record) =>
    [record._tag, record.name].some(
      (value) => typeof value === "string" && expected.test(value),
    ),
  );
}

export function normalizeLedgerFailure(
  error: unknown,
  phase: LedgerFailurePhase,
  signingMode: LedgerSigningMode = "clear",
): LedgerFailure {
  if (error instanceof LedgerManagerError) {
    if (error.kind === "unsupported") {
      return {
        code: "LEDGER_UNSUPPORTED_BROWSER",
        message: "Ledger requires a Chromium browser with WebHID support.",
      };
    }
    if (error.kind === "cancelled") {
      return {
        code: "CONNECT_CANCELLED",
        message: "The Ledger device picker was closed.",
      };
    }
    return {
      code: "LEDGER_VIRTUAL_UNAVAILABLE",
      message: "The Virtual Ledger is unavailable.",
    };
  }

  if (hasStatus(error, "6985")) {
    return signingMode === "blind"
      ? {
          code: "LEDGER_BLIND_SIGNING_DISABLED",
          message: "Enable blind signing on the Ledger before approving this transaction.",
        }
      : {
          code: "SIGN_CANCELLED",
          message: "The Ledger signing request was cancelled.",
        };
  }
  if (hasStatus(error, "5515") || hasTag(error, /DeviceLocked/i)) {
    return {
      code: "LEDGER_LOCKED",
      message: "Unlock the Ledger before continuing.",
    };
  }
  if (
    ["6e00", "6d00", "6511"].some((status) => hasStatus(error, status)) ||
    hasTag(error, /AppNotOpen|OpenApp.*Error/i)
  ) {
    return {
      code: "LEDGER_APP_NOT_OPEN",
      message: "Open the XRP app on the Ledger before continuing.",
    };
  }
  if (
    phase === "connect" &&
    (hasTag(
      error,
      /NoAccessibleDeviceError|NotFoundError|User.*Refus|User.*Reject|Cancelled/i,
    ) ||
      hasStatus(error, "USER_ACTION"))
  ) {
    return {
      code: "CONNECT_CANCELLED",
      message: "The Ledger connection request was cancelled.",
    };
  }
  return phase === "connect"
    ? { code: "CONNECT_FAILED", message: "The Ledger connection failed." }
    : { code: "SIGN_FAILED", message: "The Ledger could not sign the transaction." };
}
