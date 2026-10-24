import { describe, expect, it } from "vitest";

import {
  LedgerManagerError,
  normalizeLedgerFailure,
} from "../src/ledger/errors.js";

describe("Ledger sanitized errors", () => {
  it.each([
    [{ errorCode: "6985", private: "secret" }, "sign", "blind", "LEDGER_BLIND_SIGNING_DISABLED"],
    [{ errorCode: "6985" }, "sign", "clear", "SIGN_CANCELLED"],
    [{ originalError: { errorCode: "5515" } }, "sign", "clear", "LEDGER_LOCKED"],
    [{ _tag: "DeviceLockedError" }, "connect", "clear", "LEDGER_LOCKED"],
    [{ errorCode: "6e00" }, "connect", "clear", "LEDGER_APP_NOT_OPEN"],
    [{ errorCode: "6d00" }, "connect", "clear", "LEDGER_APP_NOT_OPEN"],
    [{ errorCode: "6511" }, "connect", "clear", "LEDGER_APP_NOT_OPEN"],
    [{ name: "NotFoundError" }, "connect", "clear", "CONNECT_CANCELLED"],
    [{ _tag: "NoAccessibleDeviceError" }, "connect", "clear", "CONNECT_CANCELLED"],
    [new Error("private bytes"), "connect", "clear", "CONNECT_FAILED"],
    [new Error("private bytes"), "sign", "clear", "SIGN_FAILED"],
  ] as const)("maps a device failure to %s", (error, phase, mode, code) => {
    const result = normalizeLedgerFailure(error, phase, mode);
    expect(result.code).toBe(code);
    expect(result.message).not.toMatch(/secret|private bytes/i);
  });

  it.each([
    ["unsupported", "LEDGER_UNSUPPORTED_BROWSER"],
    ["cancelled", "CONNECT_CANCELLED"],
    ["virtual-unavailable", "LEDGER_VIRTUAL_UNAVAILABLE"],
  ] as const)("maps manager %s", (kind, code) => {
    expect(normalizeLedgerFailure(new LedgerManagerError(kind), "connect").code)
      .toBe(code);
  });
});
