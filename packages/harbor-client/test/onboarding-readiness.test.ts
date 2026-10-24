import { describe, expect, it } from "vitest";

import { OnboardingReadinessResultSchema } from "../src/types.js";

const finalizedHarborOutput = {
  ready: true,
  scope: {
    owner: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
    network: "testnet",
  },
  checks: {
    reviewed_runtime: true,
    exact_active_link: true,
    exact_persisted_policy: true,
    usable_encrypted_delegate: true,
    validated_trust_set: true,
    usable_trust_line: true,
  },
  evidence: {
    delegate: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
    link_ledger_index: 801,
    trust_set_hash:
      "C100000000000000000000000000000000000000000000000000000000000002",
    trust_set_ledger_index: 802,
    trust_line_ledger_index: 803,
  },
} as const;

describe("OnboardingReadinessResultSchema", () => {
  it("accepts the exact finalized Harbor readiness output", () => {
    expect(OnboardingReadinessResultSchema.parse(finalizedHarborOutput)).toEqual(
      finalizedHarborOutput,
    );
  });

  it("rejects the legacy shape without trust-line usability evidence", () => {
    const { usable_trust_line: _check, ...legacyChecks } =
      finalizedHarborOutput.checks;
    const { trust_line_ledger_index: _ledger, ...legacyEvidence } =
      finalizedHarborOutput.evidence;

    expect(() => OnboardingReadinessResultSchema.parse({
      ...finalizedHarborOutput,
      checks: legacyChecks,
      evidence: legacyEvidence,
    })).toThrow();
  });
});
