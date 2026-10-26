import { describe, expect, it } from "vitest";

import { createOfficialNearXrpTestnetAdapter } from "@pilot/near-chain-signatures/official";

describe("opt-in official adapter export", () => {
  it("exposes the pinned chainsig.js adapter only from the explicit subpath", () => {
    expect(createOfficialNearXrpTestnetAdapter).toBeTypeOf("function");
  });
});
