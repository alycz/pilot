import { describe, expect, it } from "vitest";

import { createEvidenceGenerationGuard } from "./evidence-generation";

describe("backtest evidence generation guard", () => {
  it("rejects an in-flight result after wallet-session invalidation", () => {
    const guard = createEvidenceGenerationGuard();
    const inFlightGeneration = guard.capture();
    expect(guard.accepts(inFlightGeneration)).toBe(true);
    guard.invalidate();
    expect(guard.accepts(inFlightGeneration)).toBe(false);
    expect(guard.accepts(guard.capture())).toBe(true);
  });
});
