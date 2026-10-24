import type { Observable } from "rxjs";

import type { LedgerDeviceState } from "../types.js";

type DeviceActionState<T> =
  | { status: "not-started" }
  | {
      status: "pending";
      intermediateValue?: { requiredUserInteraction?: unknown };
    }
  | { status: "stopped" }
  | { status: "completed"; output: T }
  | { status: "error"; error: unknown };

export type LedgerDeviceAction<T> = Readonly<{
  observable: Observable<DeviceActionState<T>>;
  cancel?: () => void;
}>;

const INTERACTIONS = new Set<LedgerDeviceState["interaction"]>([
  "none",
  "unlock-device",
  "confirm-open-app",
  "verify-address",
  "sign-transaction",
]);

function interaction(value: unknown): LedgerDeviceState["interaction"] {
  return typeof value === "string" &&
      INTERACTIONS.has(value as LedgerDeviceState["interaction"])
    ? (value as LedgerDeviceState["interaction"])
    : "none";
}

export function runLedgerDeviceAction<T>(
  action: LedgerDeviceAction<T>,
  onState: (state: LedgerDeviceState) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let subscription: { unsubscribe(): void } | undefined;
    subscription = action.observable.subscribe({
      next(state) {
        if (state.status === "pending") {
          onState({
            interaction: interaction(
              state.intermediateValue?.requiredUserInteraction,
            ),
            busy: true,
          });
          return;
        }
        if (state.status === "completed") {
          settled = true;
          onState({ interaction: "none", busy: false });
          resolve(state.output);
          subscription?.unsubscribe();
          return;
        }
        if (state.status === "error") {
          settled = true;
          onState({ interaction: "none", busy: false });
          reject(state.error);
          subscription?.unsubscribe();
          return;
        }
        if (state.status === "stopped") {
          settled = true;
          onState({ interaction: "none", busy: false });
          reject(new Error("Ledger device action stopped."));
          subscription?.unsubscribe();
        }
      },
      error(error) {
        if (settled) return;
        settled = true;
        onState({ interaction: "none", busy: false });
        reject(error);
      },
      complete() {
        if (settled) return;
        settled = true;
        onState({ interaction: "none", busy: false });
        reject(new Error("Ledger device action ended without a result."));
      },
    });
  });
}

export function ledgerDerivationPath(accountIndex = 0): string {
  if (!Number.isSafeInteger(accountIndex) || accountIndex < 0 || accountIndex > 9) {
    throw new Error("Ledger account index must be between 0 and 9.");
  }
  return `44'/144'/${accountIndex}'/0/0`;
}

export function bytesFromHex(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[A-Fa-f0-9]+$/.test(value)) {
    throw new Error("Invalid hexadecimal bytes.");
  }
  return Uint8Array.from(value.match(/../g) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );
}

export function hexFromBytes(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}
