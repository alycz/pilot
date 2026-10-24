import { describe, expect, it } from "vitest";

import {
  architectureCallouts,
  explainerBadges,
  explainerStages,
  getExplainerStage,
  modelSwitchDemo,
  privacyBoundaries,
} from "./explainer-data";

describe("harness explainer content model", () => {
  it("models the complete twelve-stage loop in order", () => {
    expect(explainerStages).toHaveLength(12);
    expect(explainerStages.map((stage) => stage.order)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect(explainerStages.map((stage) => stage.id)).toEqual([
      "conversation",
      "scoped-memory",
      "context-retrieval",
      "chosen-model",
      "research-proposal",
      "policy-approval",
      "xrpl-execution",
      "verified-result",
      "proposed-learning",
      "user-review",
      "retained-learning",
      "next-conversation",
    ]);
  });

  it("provides a complete, unique interaction record for every stage", () => {
    expect(new Set(explainerStages.map((stage) => stage.id)).size).toBe(12);
    for (const stage of explainerStages) {
      expect(stage.title.length).toBeGreaterThan(3);
      expect(stage.summary.length).toBeGreaterThan(12);
      expect(stage.detail.length).toBeGreaterThan(40);
      expect(stage.input).toBeTruthy();
      expect(stage.output).toBeTruthy();
      expect(stage.status).toBe("implemented");
    }
    expect(getExplainerStage("policy-approval")?.title).toContain("Harbor");
    expect(getExplainerStage("unknown")).toBeUndefined();
  });

  it("keeps implementation, inspiration, and optional status meanings distinct", () => {
    expect(explainerBadges.map((badge) => badge.status)).toEqual([
      "implemented",
      "inspired",
      "optional",
    ]);
    expect(architectureCallouts.map((callout) => [callout.id, callout.status])).toEqual([
      ["pilot-harbor", "implemented"],
      ["hermes", "optional"],
      ["harness", "inspired"],
      ["vault", "implemented"],
    ]);
  });

  it("describes integrations and memory without overstating them", () => {
    const hermes = architectureCallouts.find((callout) => callout.id === "hermes")!;
    expect(`${hermes.summary} ${hermes.detail}`).toMatch(/default-off/i);
    expect(`${hermes.summary} ${hermes.detail}`).toMatch(/not running|not.*live/i);

    const harness = architectureCallouts.find((callout) => callout.id === "harness")!;
    expect(`${harness.summary} ${harness.detail}`).toMatch(/inspire/i);
    expect(harness.detail).toMatch(/no installed Harness² package/i);
    expect(harness.detail).toMatch(/no.*live Google integration/i);

    const vault = architectureCallouts.find((callout) => callout.id === "vault")!;
    expect(`${vault.summary} ${vault.detail}`).toMatch(/Obsidian-compatible/i);
    expect(vault.detail).toMatch(/does not claim Obsidian sync/i);
    expect(vault.detail).toMatch(/universal import/i);
  });

  it("demonstrates reviewed context surviving a synthetic model switch", () => {
    expect(modelSwitchDemo.steps).toHaveLength(2);
    expect(modelSwitchDemo.steps[0].model).not.toBe(modelSwitchDemo.steps[1].model);
    expect(modelSwitchDemo.steps[0].retrievedContext).toBe(
      modelSwitchDemo.steps[1].retrievedContext,
    );
    expect(modelSwitchDemo.confirmedPreference).toMatch(/risk caveats/i);
    expect(modelSwitchDemo.confirmedPreference).not.toMatch(/\d|amount|balance|limit/i);
    expect(modelSwitchDemo.preferenceState).toMatch(/confirmed/i);
    expect(modelSwitchDemo.explanation).toMatch(/do not share hidden state/i);
    expect(modelSwitchDemo.explanation).toMatch(/not trained/i);
  });

  it("states privacy, review, correction, immutability, and outcome boundaries", () => {
    const copy = privacyBoundaries.join(" ");
    expect(copy).toMatch(/no real conversations/i);
    expect(copy).toMatch(/Relevant authorized context only/i);
    expect(copy).toMatch(/require user review/i);
    expect(copy).toMatch(/corrected or forgotten/i);
    expect(copy).toMatch(/ledger history remains immutable/i);
    expect(copy).toMatch(/not guaranteed.*profitability/i);
  });
});
