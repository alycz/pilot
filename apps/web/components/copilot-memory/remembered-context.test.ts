import { describe, expect, it } from "vitest";

import {
  REMEMBERED_CONTEXT_BOUNDARY,
  abbreviatedRememberedOwner,
  rememberedContextScope,
  type RememberedContextState,
} from "./remembered-context";

const OWNER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const OTHER_OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

function ready(overrides: Partial<Extract<RememberedContextState, { kind: "ready" }>> = {}) {
  return {
    kind: "ready" as const,
    owner: OWNER,
    network: "testnet" as const,
    modelId: "provider/model-a",
    ...overrides,
  };
}

describe("rememberedContextScope", () => {
  it("preserves the same wallet scope when the selected model changes", () => {
    expect(rememberedContextScope(ready({ modelId: "provider/model-a" }))).toEqual(
      rememberedContextScope(ready({ modelId: "provider/model-b" })),
    );
  });

  it("isolates memory when the wallet or network changes", () => {
    const original = rememberedContextScope(ready());
    expect(rememberedContextScope(ready({ owner: OTHER_OWNER }))).not.toEqual(original);
    expect(rememberedContextScope(ready({ network: "devnet" }))).not.toEqual(original);
  });

  it("does not expose a scope while checking, signed out, or unavailable", () => {
    expect(rememberedContextScope({ kind: "checking" })).toBeUndefined();
    expect(rememberedContextScope({ kind: "signed-out" })).toBeUndefined();
    expect(rememberedContextScope({ kind: "unavailable" })).toBeUndefined();
  });

  it("generates no permission, signing, spending, or risk authority fields", () => {
    const adapted = rememberedContextScope(ready())!;
    expect(Object.keys(adapted).sort()).toEqual(["network", "owner", "scopeKey"]);
    const serialized = JSON.stringify(adapted);
    for (const forbidden of [
      "allowed_tx_types",
      "execute_under_usd",
      "max_per_tx_usd",
      "max_slippage_bps",
      "permission",
      "risk",
      "sign",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(REMEMBERED_CONTEXT_BOUNDARY.authority).toContain("cannot expand permissions");
    expect(REMEMBERED_CONTEXT_BOUNDARY.authority).toContain("risk limits");
  });
});
describe("abbreviatedRememberedOwner", () => {
  it("keeps short labels intact and abbreviates long wallet addresses", () => {
    expect(abbreviatedRememberedOwner("fixture-owner")).toBe("fixture-owner");
    expect(abbreviatedRememberedOwner(OWNER)).toBe("r9cZA1mL…nfk59");
  });
});
