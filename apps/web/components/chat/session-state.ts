import type { PublicPilotConfig, WalletSessionStatus } from "@/lib/harbor-browser";

export type ChatSessionUi = {
  ready: boolean;
  label: string;
  modeLabel: string;
  placeholder: string;
  notice: "configuration" | "onboarding" | "proof" | "unavailable" | null;
};

export function chatWalletActionProofRequired(
  config: PublicPilotConfig | null | undefined,
): boolean {
  return config?.walletActionProofRequired === true;
}

export function chatSessionUi(
  config: PublicPilotConfig | null | undefined,
  session: WalletSessionStatus | null | undefined,
): ChatSessionUi {
  if (config === undefined) {
    return {
      ready: false,
      label: "Waiting for configuration",
      modeLabel: "Checking configuration",
      placeholder: "Checking Pilot configuration…",
      notice: null,
    };
  }
  if (config === null) {
    return {
      ready: false,
      label: "Unavailable",
      modeLabel: "Configuration unavailable",
      placeholder: "Pilot configuration unavailable—reload to retry.",
      notice: "configuration",
    };
  }
  const modeLabel = config.mockMode ? "Explicit mock" : "Live Harbor";
  if (config.walletActionProofRequired && !config.walletActionProofConfigured) {
    return {
      ready: false,
      label: "Proof unavailable",
      modeLabel,
      placeholder: "Local wallet proof is not configured.",
      notice: "proof",
    };
  }
  if (config.walletActionProofRequired) {
    if (session === undefined) {
      return {
        ready: false,
        label: "Checking…",
        modeLabel,
        placeholder: "Checking wallet session…",
        notice: null,
      };
    }
    if (session === null) {
      return {
        ready: false,
        label: "Unavailable",
        modeLabel,
        placeholder: "Wallet session unavailable—reload to retry.",
        notice: "unavailable",
      };
    }
    if (!session.authenticated) {
      return {
        ready: false,
        label: "Not connected",
        modeLabel,
        placeholder: "Complete onboarding to connect a wallet…",
        notice: "onboarding",
      };
    }
    return {
      ready: true,
      label: `${session.account.slice(0, 6)}…${session.account.slice(-5)}`,
      modeLabel,
      placeholder: "Ask Pilot to plan an XRPL action…",
      notice: null,
    };
  }
  if (config.mockMode) {
    return {
      ready: true,
      label: "Mock session",
      modeLabel: "Explicit mock",
      placeholder: "Ask Pilot to plan an XRPL action…",
      notice: null,
    };
  }
  if (session === undefined) {
    return {
      ready: false,
      label: "Checking…",
      modeLabel,
      placeholder: "Checking wallet session…",
      notice: null,
    };
  }
  if (session === null) {
    return {
      ready: false,
      label: "Unavailable",
      modeLabel,
      placeholder: "Wallet session unavailable—reload to retry.",
      notice: "unavailable",
    };
  }
  if (!session.authenticated) {
    return {
      ready: false,
      label: "Not connected",
      modeLabel,
      placeholder: "Complete onboarding to connect a wallet…",
      notice: "onboarding",
    };
  }
  return {
    ready: true,
    label: `${session.account.slice(0, 6)}…${session.account.slice(-5)}`,
    modeLabel,
    placeholder: "Ask Pilot to plan an XRPL action…",
    notice: null,
  };
}
