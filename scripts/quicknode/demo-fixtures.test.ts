import { describe, expect, it } from "vitest";

import { verifyPilotQuickNodeDemoFixtures } from "./demo-fixtures";

describe("QN-6 Pilot demo fixture probe", () => {
  it("accepts the bounded mock-only QuickNode demo evidence", () => {
    expect(verifyPilotQuickNodeDemoFixtures()).toEqual({
      result: "pass",
      evidence: "local-mock",
      rpc: "quicknode-mock",
      confirmation: "quicknode-mock",
      watch: "quicknode-mock",
      freeze_notice_fields: ["tx_hash", "ledger_index", "network"],
    });
  });
});
