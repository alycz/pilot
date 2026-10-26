import { describe, expect, it } from "vitest";

import { createNearLiveRunCoordinator } from "./near-live-run-coordinator";

describe("NEAR live UI run coordinator", () => {
  it("aborts a predecessor and ignores all late completions", () => {
    const coordinator = createNearLiveRunCoordinator();
    const first = coordinator.begin();
    const second = coordinator.begin();

    expect(first.signal.aborted).toBe(true);
    expect(coordinator.isCurrent(first)).toBe(false);
    expect(coordinator.finish(first)).toBe(false);
    expect(coordinator.isCurrent(second)).toBe(true);
    expect(coordinator.finish(second)).toBe(true);
  });

  it("explicit cancellation aborts and invalidates the active run", () => {
    const coordinator = createNearLiveRunCoordinator();
    const run = coordinator.begin();

    coordinator.cancel();
    expect(run.signal.aborted).toBe(true);
    expect(coordinator.isCurrent(run)).toBe(false);
    expect(coordinator.finish(run)).toBe(false);
  });
});
