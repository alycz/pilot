import { describe, expect, it } from "vitest";

import {
  ONBOARDING_STEPS,
  onboardingProgressSteps,
  stepIndex,
} from "./onboarding-steps";

describe("onboarding steps", () => {
  it("keeps the mandated flow order", () => {
    expect(ONBOARDING_STEPS.map(({ id }) => id)).toEqual([
      "wallet",
      "ai",
      "access",
      "fund",
      "acquire",
      "delegate",
      "verify",
      "mandate",
      "ready",
    ]);
  });

  it("separates basic readiness from optional trading progress", () => {
    expect(onboardingProgressSteps("access").map(({ id }) => id)).toEqual([
      "wallet", "ai", "access",
    ]);
    expect(onboardingProgressSteps("fund", false).map(({ id }) => id)).toEqual([
      "fund", "delegate", "verify", "mandate", "ready",
    ]);
    expect(onboardingProgressSteps("fund", true).map(({ id }) => id)).toEqual([
      "fund", "acquire", "delegate", "verify", "mandate", "ready",
    ]);
  });

  it("maps every step to a stable progress index", () => {
    expect(ONBOARDING_STEPS.map(({ id }) => stepIndex(id))).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(stepIndex("delegate", false)).toBe(4);
    expect(stepIndex("ready", false)).toBe(7);
  });
});
