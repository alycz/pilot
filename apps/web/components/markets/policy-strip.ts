import type { Network, Policy } from "@pilot/contracts";

import type { LedgerNetwork } from "./ledger-client";

export type PolicyCell = { label: string; value: string };

export type PolicyStrip = {
  cells: PolicyCell[];
  /** Short, honest note when the market's network isn't one Pilot trades on. */
  networkNote: string | null;
};

const NETWORK_NAMES: Record<Network, string> = {
  mainnet: "Mainnet",
  testnet: "Testnet",
  devnet: "Devnet",
  "lending-devnet": "Lending Devnet",
} as Record<Network, string>;

function usd(value: number): string {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function networkName(network: string): string {
  return (NETWORK_NAMES as Record<string, string>)[network] ?? network;
}

/** Read-only summary of the execution policy (Pilot/Policy.md) for a market pop-up. */
export function policyStrip(policy: Policy, marketNetwork: LedgerNetwork): PolicyStrip {
  const networks = policy.networks.length ? policy.networks.map(networkName).join(" · ") : "None";
  const issuers = policy.issuer_allowlist.length ? policy.issuer_allowlist.join(" · ") : "None";
  const cells: PolicyCell[] = [
    { label: "Auto-execute under", value: usd(policy.execute_under_usd) },
    { label: "Per transaction", value: usd(policy.max_per_tx_usd) },
    { label: "Daily cap", value: usd(policy.daily_cap_usd) },
    { label: "Max slippage", value: `${policy.max_slippage_bps.toLocaleString("en-US")} bps` },
    { label: "Networks", value: networks },
    { label: "Issuer allowlist", value: issuers },
  ];
  const tradable = (policy.networks as string[]).includes(marketNetwork);
  const pilotNetworks = policy.networks.filter((network) => network !== "mainnet").map(networkName);
  const networkNote = tradable
    ? null
    : `Pilot trades ${pilotNetworks.length ? pilotNetworks.join(" and ") : "only on allowed networks"}; this ${networkName(marketNetwork)} market is for research.`;
  return { cells, networkNote };
}

/** `?market=` deep-link value for a market row key (`pairId:route`). */
export function marketParam(key: string | null): string | null {
  return key && /^[a-z]+:[a-z0-9-]+:(order-book|amm)$/.test(key) ? key : null;
}
