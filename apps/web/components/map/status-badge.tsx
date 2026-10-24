import type { Network } from "@pilot/contracts";

import {
  labelToken,
  type VenueAvailability,
} from "@/components/map/venue-utils";

const STATUS_STYLES: Record<VenueAvailability, string> = {
  live: "border-executed/30 bg-executed/10 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]",
  voting: "border-approval/30 bg-approval/10 text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))]",
  "devnet-only": "border-info/30 bg-info/10 text-info",
  unavailable: "border-border bg-white/[0.02] text-muted-foreground",
  unlisted: "border-border bg-white/[0.02] text-muted-foreground",
};

const DOT_STYLES: Record<VenueAvailability, string> = {
  live: "bg-executed",
  voting: "bg-approval",
  "devnet-only": "bg-info",
  unavailable: "border border-muted-foreground rounded-xl",
  unlisted: "border border-muted-foreground rounded-xl",
};

type StatusBadgeProps = {
  status: VenueAvailability;
  network?: Network;
  compact?: boolean;
  /** Discovery venues have no per-network status in Harbor's catalog. */
  discovery?: boolean;
};

/** Same wording as the Markets catalog, so a venue reads the same on both pages. */
export function statusLabel(status: VenueAvailability, discovery = false): string {
  switch (status) {
    case "live":
      return "Live";
    case "devnet-only":
      return "Devnet only";
    case "voting":
      return "Amendment voting";
    case "unavailable":
      return "Not enabled";
    default:
      return discovery ? "Discovery only" : "Not listed";
  }
}

export function StatusBadge({ status, network, compact = false, discovery = false }: StatusBadgeProps) {
  const label = statusLabel(status, discovery);
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1.5 border font-medium rounded-xl ${STATUS_STYLES[status]} ${compact ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-1 text-[11px]"}`}
      title={network ? `${labelToken(network)}: ${label}` : label}
    >
      <span aria-hidden="true" className={`size-1.5 shrink-0 ${DOT_STYLES[status]}`} />
      {network ? <span className="truncate">{labelToken(network)}</span> : null}
      <span className={network && compact ? "sr-only" : "truncate"}>
        {label}
      </span>
    </span>
  );
}
