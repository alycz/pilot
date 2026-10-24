import { describe, expect, it } from "vitest";

import { createReproducibilityReport } from "./report";
import {
  InMemorySavedRunStorage,
  MAX_SAVED_RUNS,
  SavedRunRepository,
  type SavedRunStorage,
} from "./storage";
import { reportInput } from "./test-fixtures";

describe("local saved-run repository", () => {
  it("persists through an injected adapter, upserts by deterministic run id, and removes", async () => {
    const storage = new InMemorySavedRunStorage();
    const repository = new SavedRunRepository(storage);
    const report = createReproducibilityReport(reportInput());
    await repository.save(report, { label: "First review", savedAt: "2026-10-24T12:00:00.000Z" });
    await repository.save(report, { label: "Renamed review", savedAt: "2026-10-24T13:00:00.000Z" });

    expect(await repository.list()).toMatchObject([{
      scope: "local_research_only",
      label: "Renamed review",
      report: { runId: report.runId },
    }]);
    expect(await repository.remove(report.runId)).toBe(true);
    expect(await repository.remove(report.runId)).toBe(false);
    expect(await repository.list()).toEqual([]);
  });

  it("fails closed when persisted report evidence was modified", async () => {
    const report = structuredClone(createReproducibilityReport(reportInput()));
    report.result.full.totalCostsQuote = "0";
    const storage: SavedRunStorage = {
      load: async () => [{
        scope: "local_research_only",
        label: "Tampered",
        savedAt: "2026-10-24T12:00:00.000Z",
        report,
      }],
      replace: async () => undefined,
    };
    await expect(new SavedRunRepository(storage).list()).rejects.toThrow(/result fingerprint/);
  });

  it("keeps only the eight most recently saved distinct runs", async () => {
    const repository = new SavedRunRepository(new InMemorySavedRunStorage());
    for (let index = 0; index < MAX_SAVED_RUNS + 1; index += 1) {
      const input = reportInput();
      input.strategy.parameters.variant = index;
      const report = createReproducibilityReport(input);
      await repository.save(report, {
        label: `Run ${index}`,
        savedAt: `2026-10-24T${String(index).padStart(2, "0")}:00:00.000Z`,
      });
    }
    const records = await repository.list();
    expect(records).toHaveLength(MAX_SAVED_RUNS);
    expect(records.map(({ label }) => label)).not.toContain("Run 0");
  });

  it("rejects loaded or newly saved records above the 1 MiB serialized limit", async () => {
    const oversizedStorage: SavedRunStorage = {
      load: async () => ["x".repeat(1_048_576)],
      replace: async () => undefined,
    };
    await expect(new SavedRunRepository(oversizedStorage).list()).rejects.toThrow(/1 MiB/);

    const repository = new SavedRunRepository(new InMemorySavedRunStorage());
    for (let index = 0; index < 2; index += 1) {
      const input = reportInput();
      input.strategy.parameters.variant = index;
      input.strategy.parameters.padding = Array.from({ length: 200 }, () => "x".repeat(2_000));
      await repository.save(createReproducibilityReport(input), {
        label: `Large ${index}`,
        savedAt: `2026-10-24T0${index}:00:00.000Z`,
      });
    }
    const third = reportInput();
    third.strategy.parameters.variant = 2;
    third.strategy.parameters.padding = Array.from({ length: 200 }, () => "x".repeat(2_000));
    await expect(repository.save(createReproducibilityReport(third), {
      label: "Large 2",
      savedAt: "2026-10-24T02:00:00.000Z",
    })).rejects.toThrow(/1 MiB/);
    expect(await repository.list()).toHaveLength(2);
  });
});
