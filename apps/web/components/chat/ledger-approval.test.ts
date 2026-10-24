import { describe, expect, it, vi } from "vitest";

import { executeFreshLedgerBuild } from "./ledger-approval";

describe("Ledger approval rebuild", () => {
  it("executes only the fresh build under the newly generated idempotency key", async () => {
    const execute = vi.fn(async (buildId: string, idempotencyKey: string) => ({
      buildId,
      idempotencyKey,
    }));

    await expect(executeFreshLedgerBuild({
      deviceReady: true,
      priorBuildId: "build-expired",
      freshBuildId: "build-fresh",
      createIdempotencyKey: () => "ui-ledger-rebuild:fresh",
      execute,
    })).resolves.toEqual({
      buildId: "build-fresh",
      idempotencyKey: "ui-ledger-rebuild:fresh",
    });
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      "build-fresh",
      "ui-ledger-rebuild:fresh",
    );
  });

  it("rejects a reused build before tx.execute", async () => {
    const execute = vi.fn(async () => ({ status: "needs_approval" }));
    await expect(executeFreshLedgerBuild({
      deviceReady: true,
      priorBuildId: "build-expired",
      freshBuildId: "build-expired",
      createIdempotencyKey: () => "ui-ledger-rebuild:unused",
      execute,
    })).rejects.toThrow("expired tuple was not reused");
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed before tx.execute when the fresh identity is unavailable", async () => {
    const execute = vi.fn(async () => ({ status: "needs_approval" }));
    await expect(executeFreshLedgerBuild({
      deviceReady: true,
      freshBuildId: "build-fresh",
      createIdempotencyKey: () => "",
      execute,
    })).rejects.toThrow("fresh approval identity");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not start the fresh approval clock before the device is ready", async () => {
    const execute = vi.fn(async () => ({ status: "needs_approval" }));
    await expect(executeFreshLedgerBuild({
      deviceReady: false,
      priorBuildId: "build-old",
      freshBuildId: "build-fresh",
      createIdempotencyKey: () => "ui-ledger-rebuild:fresh",
      execute,
    })).rejects.toThrow("connected, idle, and running the XRP app");
    expect(execute).not.toHaveBeenCalled();
  });
});
