import {
  test as base,
  expect,
  type TestInfo,
} from "@playwright/test";

import {
  createEvidenceCollector,
  type EvidenceCollector,
} from "../support/evidence";
import {
  resolveE2ELane,
  type E2ELane,
  type E2ELaneId,
} from "../support/lanes";

type PilotFixtures = {
  lane: E2ELane;
  evidence: EvidenceCollector;
};

const configuredLane = resolveE2ELane();

export const test = base.extend<PilotFixtures>({
  lane: async ({}, use) => {
    await use(configuredLane);
  },
  evidence: async ({ lane }, use, testInfo: TestInfo) => {
    const collector = createEvidenceCollector(lane, testInfo);
    await use(collector);
    await testInfo.attach(`pilot-${lane.evidenceKind}-evidence`, {
      body: Buffer.from(`${JSON.stringify(collector.snapshot(), null, 2)}\n`),
      contentType: "application/json",
    });
  },
});

export { expect };
export type { EvidenceCollector, E2ELane, E2ELaneId };

export function requireLane(actual: E2ELane, expected: E2ELaneId): void {
  if (actual.id !== expected) {
    throw new Error(`This spec requires the ${expected} lane, not ${actual.id}.`);
  }
}
