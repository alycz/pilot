import { z } from "zod";

import {
  ReproducibilityReportSchema,
  verifyReproducibilityReport,
  type ReproducibilityReport,
} from "./report";

export const SavedRunRecordSchema = z.object({
  scope: z.literal("local_research_only"),
  label: z.string().trim().min(1).max(80),
  savedAt: z.string().datetime({ offset: true }),
  report: ReproducibilityReportSchema,
}).strict().refine((record) => !/\br[1-9A-HJ-NP-Za-km-z]{24,34}\b/.test(record.label), {
  path: ["label"],
  message: "saved-run labels must not contain wallet addresses",
});

export type SavedRunRecord = z.infer<typeof SavedRunRecordSchema>;

export const MAX_SAVED_RUNS = 8;
export const MAX_SAVED_RUN_STORAGE_BYTES = 1_048_576;

function assertBoundedStorage(records: readonly unknown[]): void {
  if (records.length > MAX_SAVED_RUNS) {
    throw new RangeError(`saved-run storage exceeds ${MAX_SAVED_RUNS} entries`);
  }
  const bytes = new TextEncoder().encode(JSON.stringify(records)).byteLength;
  if (bytes > MAX_SAVED_RUN_STORAGE_BYTES) {
    throw new RangeError("saved-run storage exceeds 1 MiB");
  }
}

/** Persistence remains caller-injected; this module never reads browser or wallet storage directly. */
export interface SavedRunStorage {
  load(): Promise<readonly unknown[]>;
  replace(records: readonly SavedRunRecord[]): Promise<void>;
}

export class SavedRunRepository {
  constructor(private readonly storage: SavedRunStorage) {}

  async list(): Promise<readonly SavedRunRecord[]> {
    const raw = await this.storage.load();
    assertBoundedStorage(raw);
    return raw.map((entry) => {
      const record = SavedRunRecordSchema.parse(entry);
      const report = verifyReproducibilityReport(record.report);
      return freezeRecord({ ...record, report });
    }).sort((left, right) => right.savedAt.localeCompare(left.savedAt));
  }

  async save(reportInput: unknown, options: { label: string; savedAt: string }): Promise<SavedRunRecord> {
    const report = verifyReproducibilityReport(reportInput);
    const parsedRecord = SavedRunRecordSchema.parse({
      scope: "local_research_only",
      label: options.label,
      savedAt: options.savedAt,
      report,
    });
    const record = freezeRecord({
      ...parsedRecord,
      report: verifyReproducibilityReport(parsedRecord.report),
    });
    const existing = await this.list();
    const withoutSameRun = existing.filter((entry) => entry.report.runId !== report.runId);
    const next = [record, ...withoutSameRun].slice(0, MAX_SAVED_RUNS);
    assertBoundedStorage(next);
    await this.storage.replace(next);
    return freezeRecord(record);
  }

  async remove(runId: ReproducibilityReport["runId"]): Promise<boolean> {
    const existing = await this.list();
    const next = existing.filter((entry) => entry.report.runId !== runId);
    if (next.length === existing.length) return false;
    await this.storage.replace(next);
    return true;
  }
}

function freezeRecord(record: SavedRunRecord): SavedRunRecord {
  return Object.freeze(record);
}

export class InMemorySavedRunStorage implements SavedRunStorage {
  private records: readonly SavedRunRecord[] = [];

  async load(): Promise<readonly unknown[]> {
    return structuredClone(this.records);
  }

  async replace(records: readonly SavedRunRecord[]): Promise<void> {
    this.records = structuredClone(records);
  }
}
