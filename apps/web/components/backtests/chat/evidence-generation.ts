export function createEvidenceGenerationGuard() {
  let generation = 0;
  return {
    capture: () => generation,
    accepts: (candidate: number) => candidate === generation,
    invalidate: () => { generation += 1; },
  } as const;
}
