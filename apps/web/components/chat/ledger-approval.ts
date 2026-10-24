export async function executeFreshLedgerBuild<T>(input: {
  deviceReady: boolean;
  priorBuildId?: string;
  freshBuildId: string;
  createIdempotencyKey(): string;
  execute(buildId: string, idempotencyKey: string): Promise<T>;
}): Promise<T> {
  if (!input.deviceReady) {
    throw new Error("The Ledger must be connected, idle, and running the XRP app before the approval is built.");
  }
  if (!input.freshBuildId || input.freshBuildId === input.priorBuildId) {
    throw new Error("Harbor did not create a fresh approval build. The expired tuple was not reused.");
  }
  const idempotencyKey = input.createIdempotencyKey();
  if (!idempotencyKey) {
    throw new Error("A fresh approval identity could not be created.");
  }
  return input.execute(input.freshBuildId, idempotencyKey);
}
