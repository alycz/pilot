import { clearWalletSession } from "./harbor-browser";

export const PILOT_WALLET_STORAGE_KEY = "pilot:wallet";

export type PilotWalletSignOutDependencies = {
  clearServerSession?: () => Promise<void>;
  storage?: Pick<Storage, "removeItem">;
  disconnect?: () => Promise<void> | void;
};

/**
 * End Pilot's browser authorization without changing on-ledger authority.
 *
 * The server session is cleared first. Local wallet metadata is retained when
 * that request fails so the UI cannot falsely claim that the user signed out.
 * Active-onboarding and pending-submission recovery records are deliberately
 * left intact: signing out of Pilot is not delegation revocation.
 */
export async function signOutPilotWallet({
  clearServerSession = () => clearWalletSession(),
  storage = globalThis.sessionStorage,
  disconnect,
}: PilotWalletSignOutDependencies = {}): Promise<void> {
  await clearServerSession();

  // The server session is already gone. A best-effort extension disconnect
  // must not strand stale Pilot metadata if a provider rejects local cleanup.
  try {
    await disconnect?.();
  } catch {
    // Provider disconnect is local convenience only; it never revokes XRPL
    // authority and does not change the successful server-side sign-out.
  }

  storage.removeItem(PILOT_WALLET_STORAGE_KEY);
}
