"use client";

import type { Caveat, Network, Venue } from "@pilot/contracts";
import {
  Activity,
  ArrowUpRight,
  BookOpen,
  Braces,
  CircleAlert,
  RadioTower,
  ShieldAlert,
  X,
} from "lucide-react";
import { useEffect, useRef } from "react";

import { StatusBadge } from "@/components/map/status-badge";
import { safeVenueReferenceLinks } from "@/components/map/map-data";
import {
  labelToken,
  NETWORKS,
  snapshotLabel,
  venueAvailability,
} from "@/components/map/venue-utils";

type VenueDetailDialogProps = {
  venueId: string | null;
  venueName?: string;
  venue: Venue | null;
  loading: boolean;
  error: string | null;
  activeNetwork: Network;
  asOf: string | null;
  asOfBasis: string | null;
  caveats: Caveat[];
  onClose: () => void;
};

function DetailList({
  empty,
  items,
  tone = "neutral",
}: {
  empty: string;
  items: string[];
  tone?: "neutral" | "risk";
}) {
  if (items.length === 0) {
    return <p className="text-sm leading-6 text-muted-foreground">{empty}</p>;
  }

  return (
    <ul>
      {items.map((item) => (
        <li
          key={item}
          className={`flex min-w-0 items-start gap-2.5 border-b px-0 py-2.5 text-sm leading-5 last:border-b-0 ${
            tone === "risk"
              ? "border-approval/20 text-foreground"
              : "border-border text-secondary-foreground"
          }`}
        >
          {tone === "risk" ? (
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))]" />
          ) : (
            <Activity aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 break-words">{item}</span>
        </li>
      ))}
    </ul>
  );
}

export function VenueDetailDialog({
  venueId,
  venueName,
  venue,
  loading,
  error,
  activeNetwork,
  asOf,
  asOfBasis,
  caveats,
  onClose,
}: VenueDetailDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // The dialog unmounts when closed, so restore focus to whatever opened it.
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (venueId && !dialog.open) {
      if (document.activeElement instanceof HTMLElement && !dialog.contains(document.activeElement)) {
        openerRef.current = document.activeElement;
      }
      dialog.showModal();
    }
    if (!venueId && dialog.open) dialog.close();
  }, [venueId]);

  if (!venueId) return null;

  const currentStatus = venue ? venueAvailability(venue, activeNetwork) : null;
  const links = safeVenueReferenceLinks(venue?.links);

  function closeDialog() {
    dialogRef.current?.close();
  }

  return (
    <dialog
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        closeDialog();
      }}
      onClose={() => {
        const opener = openerRef.current;
        onClose();
        if (opener) window.requestAnimationFrame(() => opener.focus());
      }}
      aria-labelledby="venue-dialog-title"
      aria-describedby="venue-dialog-description"
      className="m-auto max-h-[calc(100dvh-1.5rem)] w-[calc(100%-1.5rem)] max-w-4xl overflow-hidden border border-border-strong bg-card p-0 text-foreground shadow-2xl shadow-black/[0.14] backdrop:bg-black/45 sm:max-h-[calc(100dvh-3rem)] sm:w-[calc(100%-3rem)]"
    >
      <div className="max-h-[inherit] overflow-y-auto overscroll-contain">
        <header className="sticky top-0 z-10 flex min-w-0 items-center justify-between gap-3 border-b border-border bg-[color-mix(in_srgb,var(--sidebar)_60%,var(--card))] px-4 py-4 sm:px-6">
          <div className="min-w-0">
            {currentStatus ? null : (
              <span className="mb-3 inline-block border border-border px-2 py-1 font-mono text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {loading ? "Loading catalog detail" : "Catalog detail unavailable"}
              </span>
            )}
            <h2 id="venue-dialog-title" className="min-w-0 text-balance text-2xl font-normal tracking-[-0.02em] sm:text-[1.875rem]">
              {venue?.name ?? venueName ?? venueId}
            </h2>
            <p
              id="venue-dialog-description"
              className="label-mono mt-1.5 break-words"
            >
              {venue ? `${venue.id} · ${labelToken(venue.kind)}` : venueId}
            </p>
          </div>
          <button
            type="button"
            onClick={closeDialog}
            aria-label={`Close ${venue?.name ?? venueName ?? venueId} details`}
            className="bracket bracket-light grid size-9 shrink-0 place-items-center border border-border bg-white/[0.03] text-foreground transition hover:bg-white/[0.06] pointer-coarse:size-11"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </header>

        {loading ? (
          <div className="flex min-h-72 flex-col items-center justify-center p-6 text-center">
            <Activity aria-hidden="true" className="size-6 animate-pulse text-muted-foreground" />
            <h3 className="mt-4 text-sm font-medium text-foreground">Loading venue catalog detail</h3>
            <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
              Harbor is reading <span className="font-mono">venues.get</span> for this exact venue ID.
            </p>
          </div>
        ) : error ? (
          <div className="flex min-h-72 flex-col items-center justify-center p-6 text-center">
            <CircleAlert aria-hidden="true" className="size-6 text-destructive" />
            <h3 className="mt-4 text-sm font-medium text-foreground">Venue catalog detail unavailable</h3>
            <p className="mt-2 max-w-md break-words text-sm leading-6 text-muted-foreground">{error}</p>
            <p className="mt-3 max-w-md text-xs leading-5 text-muted-foreground">
              Pilot did not substitute the catalog-list card for the failed detail response.
            </p>
          </div>
        ) : venue ? (
        <div className="grid min-w-0 gap-4 p-4 sm:p-6 lg:grid-cols-2">
            {/* Paired rows: each row's two sections stretch to the same height. */}
            <section aria-labelledby="network-availability-heading" className="border border-border bg-background/50 p-4">
              <div className="flex items-center justify-between gap-3">
                <h3 id="network-availability-heading" className="label-mono text-foreground/80">
                  Network availability
                </h3>
                <RadioTower aria-hidden="true" className="size-4 text-muted-foreground" />
              </div>
              <div className="mt-3 grid grid-cols-1 border-l border-t border-border">
                {NETWORKS.map((network) => (
                  <div
                    key={network}
                    className={`flex min-w-0 items-center justify-between gap-2 border-b border-r border-border p-2.5 ${
                      network === activeNetwork
                        ? "bracket bracket-accent bg-primary/[0.06]"
                        : ""
                    }`}
                  >
                    <span className="label-mono min-w-0 truncate">
                      {labelToken(network)}
                    </span>
                    <StatusBadge status={venueAvailability(venue, network)} compact />
                  </div>
                ))}
              </div>
            </section>

            <section aria-labelledby="builders-heading" className="border border-border bg-background/50 p-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <h3 id="builders-heading" className="label-mono text-foreground/80">Execution builders</h3>
                <Braces aria-hidden="true" className="size-4 text-muted-foreground" />
              </div>
              <DetailList
                items={venue.execution?.builders ?? []}
                empty={venue.kind === "discovery-venue" ? "Discovery only — no Harbor transaction builder is advertised." : `No Harbor builder for this venue on ${labelToken(activeNetwork)} yet.`}
              />
              {venue.execution?.transactions.length ? (
                <div className="mt-4 border-t border-border pt-4">
                  <p className="label-mono">
                    Transaction types
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {venue.execution.transactions.map((transaction) => (
                      <span
                        key={transaction}
                        className="break-all border border-executed/30 bg-executed/10 px-1.5 py-0.5 font-mono text-[11px] text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]"
                      >
                        {transaction}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </section>

            <section aria-labelledby="reads-heading" className="border border-border bg-background/50 p-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <h3 id="reads-heading" className="label-mono text-foreground/80">Read surfaces</h3>
                <BookOpen aria-hidden="true" className="size-4 text-muted-foreground" />
              </div>
              <DetailList
                items={venue.reads}
                empty="No direct Harbor read surface is listed for this venue."
              />
            </section>

            <section aria-labelledby="risks-heading" className="border border-approval/25 bg-approval/[0.04] p-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <h3 id="risks-heading" className="label-mono text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))]">Risks &amp; caveats</h3>
                <ShieldAlert aria-hidden="true" className="size-4 text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))]" />
              </div>
              <DetailList
                items={venue.risks}
                empty="No venue-specific risk note is available. Verify independently before acting."
                tone="risk"
              />
            </section>

            <section aria-labelledby="links-heading" className="border border-border bg-background/50 p-4">
              <h3 id="links-heading" className="label-mono text-foreground/80">References</h3>
              {links.length > 0 ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  {links.map(([label, url]) => (
                    <a
                      key={label}
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="bracket bracket-light inline-flex h-9 items-center gap-1.5 border border-border bg-white/[0.03] px-3 font-mono text-[11px] font-medium uppercase tracking-wide text-foreground transition hover:bg-white/[0.06]"
                    >
                      {labelToken(label)}
                      <ArrowUpRight aria-hidden="true" className="size-3.5" />
                    </a>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  No external references are attached to this venue card.
                </p>
              )}
            </section>

            <footer className="border border-dashed border-border-strong p-4 font-mono text-[11px] uppercase leading-5 tracking-[0.04em] text-muted-foreground">
              <p className="text-foreground/80">Catalog detail provenance</p>
              <p className="mt-1">
                Snapshot {asOf ? snapshotLabel(asOf) : "unavailable"} · {asOfBasis ?? "basis unavailable"}
              </p>
              {caveats.length > 0 ? (
                <p className="mt-2 text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))]">Caveats: {caveats.map(labelToken).join(", ")}</p>
              ) : null}
              <p className="mt-2">
                Availability describes the catalog snapshot, not a promise of liquidity or execution.
              </p>
            </footer>
        </div>
        ) : null}
      </div>
    </dialog>
  );
}
