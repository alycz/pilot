import type { Network, Venue } from "@pilot/contracts";
import { Braces, ChevronRight, RadioTower } from "lucide-react";

import { StatusBadge } from "@/components/map/status-badge";
import {
  labelToken,
  venueAvailability,
} from "@/components/map/venue-utils";

type VenueCardProps = {
  venue: Venue;
  network: Network;
  onSelect: (venue: Venue) => void;
};

export function VenueCard({ venue, network, onSelect }: VenueCardProps) {
  const status = venueAvailability(venue, network);
  const builderCount = venue.execution?.builders.length ?? 0;
  // A ledger primitive only executes where it's enabled on the focused network.
  const executable = venue.kind === "execution-primitive" && status !== "unavailable" && status !== "unlisted";

  return (
    <article className="bracket bracket-hover bracket-accent group min-w-0 border-b border-r border-border bg-card transition-colors hover:bg-secondary focus-within:bg-secondary">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={`Open catalog detail for ${venue.name}`}
        onClick={() => onSelect(venue)}
        className="flex h-full w-full min-w-0 flex-col text-left focus-visible:outline-offset-[-1px]"
      >
        <div className="flex w-full min-w-0 items-center justify-between gap-3 px-4 pt-3.5">
          <p className="label-mono flex items-center gap-1.5">
            {executable ? (
              <Braces aria-hidden="true" className="size-3.5 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]" />
            ) : (
              <RadioTower aria-hidden="true" className="size-3.5 text-info" />
            )}
            {executable ? "Executable" : venue.kind === "discovery-venue" ? "Discovery" : "Not enabled here"}
          </p>
          <ChevronRight
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-foreground motion-reduce:group-hover:translate-x-0"
          />
        </div>

        <div className="flex w-full min-w-0 flex-1 flex-col px-4 pb-4 pt-2.5 sm:min-h-44">
          <h3 className="text-balance text-sm font-medium leading-snug tracking-tight text-foreground">
            {venue.name}
          </h3>
          <p className="mt-1 break-words font-mono text-[11px] text-muted-foreground">
            {venue.id}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <StatusBadge status={status} compact discovery={venue.kind === "discovery-venue"} />
            <span className="border border-border px-1.5 py-0.5 text-xs font-medium text-muted-foreground rounded capitalize">
              {labelToken(venue.layer)}
            </span>
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Venue categories">
            {venue.category.map((category) => (
              <span
                key={category}
                className="bg-white/[0.05] px-1.5 py-0.5 text-xs text-foreground/80"
              >
                {labelToken(category)}
              </span>
            ))}
          </div>

          <div aria-hidden="true" className="min-h-4 flex-1" />
          <div className="grid w-full grid-cols-2 border-t border-border pt-3">
            <div className="min-w-0">
              <p className="label-mono">Read surfaces</p>
              <p className="mt-1 font-mono text-[13px] text-foreground">{venue.reads.length}</p>
            </div>
            <div className="min-w-0 border-l border-border pl-3">
              <p className="label-mono">Builders</p>
              <p className="mt-1 font-mono text-[13px] text-foreground">{builderCount}</p>
            </div>
          </div>

        </div>
      </button>
    </article>
  );
}
