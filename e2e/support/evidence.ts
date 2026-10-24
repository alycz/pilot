import type { TestInfo } from "@playwright/test";

import type { E2ELane, EvidenceKind } from "./lanes";

export type EvidenceValue =
  | null
  | boolean
  | number
  | string
  | EvidenceValue[]
  | { [key: string]: EvidenceValue };

export type EvidenceEntry = Readonly<{
  label: string;
  observedAt: string;
  value: EvidenceValue;
}>;

export type EvidenceRecord = Readonly<{
  schema: "pilot-e2e-evidence/v1";
  kind: EvidenceKind;
  lane: E2ELane["id"];
  authority: E2ELane["authority"];
  baseURL: string;
  testId: string;
  entries: readonly EvidenceEntry[];
}>;

export type EvidenceCollector = Readonly<{
  kind: EvidenceKind;
  record(label: string, value: EvidenceValue): void;
  snapshot(): EvidenceRecord;
}>;

const SENSITIVE_KEY = /(api[-_]?key|authorization|cookie|mnemonic|password|private[-_]?key|secret|seed|token)/i;

function assertSafeEvidence(value: EvidenceValue, path = "evidence"): void {
  if (typeof value === "string") {
    if (/\bs[A-Za-z0-9]{20,}\b/.test(value)) {
      throw new Error(`${path} resembles an XRPL secret and cannot be attached.`);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeEvidence(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      throw new Error(`${path}.${key} is credential-shaped and cannot be attached.`);
    }
    assertSafeEvidence(entry, `${path}.${key}`);
  }
}

export function createEvidenceCollector(
  lane: E2ELane,
  testInfo: TestInfo,
): EvidenceCollector {
  const entries: EvidenceEntry[] = [];
  const snapshot = (): EvidenceRecord => ({
    schema: "pilot-e2e-evidence/v1",
    kind: lane.evidenceKind,
    lane: lane.id,
    authority: lane.authority,
    baseURL: lane.baseURL,
    testId: testInfo.testId,
    entries: [...entries],
  });

  return {
    kind: lane.evidenceKind,
    record(label, value) {
      if (!label.trim()) throw new Error("Evidence labels cannot be empty.");
      assertSafeEvidence(value);
      entries.push({ label, observedAt: new Date().toISOString(), value });
    },
    snapshot,
  };
}
