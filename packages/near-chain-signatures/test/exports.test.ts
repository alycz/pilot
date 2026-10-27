import { describe, expect, it, vi } from "vitest";

vi.mock("chainsig.js", () => {
  throw new Error("the safe root entry must not load chainsig.js");
});

import * as api from "../src/index.js";

describe("public API", () => {
  it("does not expose generic sign, broadcast, wallet, or submit operations", () => {
    expect(Object.keys(api).sort()).toEqual([
      "NEAR_CHAIN_SIGNATURES_TESTNET",
      "bindReviewedXrpPayment",
      "classifyNearSignatureStatus",
      "createNearXrpChainSignaturesAdapter",
      "formatXrpSignatureRequest",
    ]);
  });
});
