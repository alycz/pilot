import { describe, expect, it, vi } from "vitest";

import {
  PILOT_WALLET_STORAGE_KEY,
  signOutPilotWallet,
} from "./wallet-sign-out";

describe("signOutPilotWallet", () => {
  it("clears only local wallet metadata after the server confirms sign-out", async () => {
    const clearServerSession = vi.fn(async () => undefined);
    const removeItem = vi.fn();
    const disconnect = vi.fn(async () => undefined);

    await signOutPilotWallet({
      clearServerSession,
      storage: { removeItem },
      disconnect,
    });

    expect(clearServerSession).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(removeItem).toHaveBeenCalledOnce();
    expect(removeItem).toHaveBeenCalledWith(PILOT_WALLET_STORAGE_KEY);
    expect(removeItem).not.toHaveBeenCalledWith("pilot:onboarding");
    expect(removeItem).not.toHaveBeenCalledWith("pilot:onboarding-pending");
  });

  it("retains local identity and does not disconnect when server sign-out fails", async () => {
    const removeItem = vi.fn();
    const disconnect = vi.fn(async () => undefined);

    await expect(signOutPilotWallet({
      clearServerSession: async () => {
        throw new Error("session delete failed");
      },
      storage: { removeItem },
      disconnect,
    })).rejects.toThrow("session delete failed");

    expect(disconnect).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });

  it("finishes local cleanup when an optional provider disconnect fails", async () => {
    const removeItem = vi.fn();

    await expect(signOutPilotWallet({
      clearServerSession: async () => undefined,
      storage: { removeItem },
      disconnect: async () => {
        throw new Error("extension stayed connected");
      },
    })).resolves.toBeUndefined();

    expect(removeItem).toHaveBeenCalledWith(PILOT_WALLET_STORAGE_KEY);
  });
});
