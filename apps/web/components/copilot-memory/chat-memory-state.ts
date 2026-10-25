import type { PublicPilotConfig, WalletSessionStatus } from "../../lib/harbor-browser";

import type { RememberedContextState } from "./remembered-context";

export function rememberedStateForChat(
  publicConfig: PublicPilotConfig | null | undefined,
  walletSession: WalletSessionStatus | null | undefined,
): RememberedContextState {
  if (publicConfig === undefined || walletSession === undefined) return { kind: "checking" };
  if (publicConfig === null || walletSession === null) {
    return { kind: "unavailable", reason: "Pilot could not verify the wallet-bound memory scope." };
  }
  if (!walletSession.authenticated) return { kind: "signed-out" };
  if (walletSession.network !== publicConfig.network) {
    return {
      kind: "unavailable",
      reason: `Memory is scoped to ${walletSession.network}, while this workspace is configured for ${publicConfig.network}. Reconnect on the matching network.`,
    };
  }
  return { kind: "ready", owner: walletSession.account, network: walletSession.network };
}
