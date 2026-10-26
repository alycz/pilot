import { describe, expect, it } from "vitest";

import * as api from "../src/index.js";

describe("public API", () => {
  it("does not expose generic sign, broadcast, wallet, or submit operations", () => {
    expect(Object.keys(api).sort()).toEqual([
      "NEAR_CHAIN_SIGNATURES_TESTNET",
      "bindReviewedXrpPayment",
      "classifyNearSignatureStatus",
      "createNearXrpChainSignaturesAdapter",
      "createOfficialNearXrpTestnetAdapter",
      "formatXrpSignatureRequest",
    ]);
  });
});
