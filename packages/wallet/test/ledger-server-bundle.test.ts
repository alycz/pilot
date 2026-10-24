import { describe, expect, it, vi } from "vitest";

vi.mock("@ledgerhq/device-management-kit", () => {
  throw new Error("Ledger runtime loaded eagerly");
});
vi.mock("@ledgerhq/device-signer-kit-xrp", () => {
  throw new Error("Ledger runtime loaded eagerly");
});
vi.mock("@ledgerhq/device-transport-kit-web-hid", () => {
  throw new Error("Ledger runtime loaded eagerly");
});
vi.mock("@ledgerhq/device-transport-kit-speculos", () => {
  throw new Error("Ledger runtime loaded eagerly");
});

describe("wallet server bundle boundary", () => {
  it("imports the wallet package without loading Ledger runtime modules", async () => {
    await expect(import("../src/index.js")).resolves.toMatchObject({
      createWallet: expect.any(Function),
    });
  });
});
