"use client";

import type { Caveat, Network, Venue } from "@pilot/contracts";
import { createMockHarborClient } from "@pilot/harbor-client";
import {
  Activity,
  Database,
  Map as MapIcon,
  RadioTower,
  RefreshCw,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { VenueCard } from "@/components/map/venue-card";
import { SelectMenu } from "../ui/select-menu";
import {
  createLatestRequestGuard,
  fetchVenueCatalog,
  fetchVenueDetail,
  mapErrorMessage,
  resolveMapRuntimeContext,
  selectMapHarborClient,
  type VenueSnapshot,
} from "@/components/map/map-data";
import { VenueDetailDialog } from "@/components/map/venue-detail-dialog";
import {
  CATEGORIES,
  countLiveVenues,
  filterVenues,
  labelToken,
  NETWORKS,
  snapshotLabel,
  type CategoryFilter,
  type LayerFilter,
} from "@/components/map/venue-utils";
import {
  createBrowserHarborClient,
  loadPublicPilotConfig,
  loadWalletSessionStatus,
  type PublicPilotConfig,
  type WalletSessionStatus,
} from "@/lib/harbor-browser";

type CatalogState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; snapshot: VenueSnapshot<Venue[]> };

type DetailState =
  | { kind: "closed" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; snapshot: VenueSnapshot<Venue> };

const LAYERS = ["xrpl-l1", "xrpl-evm", "off-ledger"] as const satisfies readonly Venue["layer"][];

function shortAccount(account: string): string {
  return `${account.slice(0, 6)}…${account.slice(-6)}`;
}

const secondaryButton =
  "bracket bracket-light inline-flex h-9 pointer-coarse:h-11 items-center gap-2 border border-border bg-white/[0.03] px-3 text-[13px] font-medium text-foreground transition hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-45 rounded-md";
const fieldBase =
  "h-10 w-full min-w-0 border border-input bg-background/60 text-sm text-foreground placeholder:text-muted-foreground focus:border-border-strong disabled:cursor-not-allowed disabled:opacity-60 pointer-coarse:h-11 pointer-coarse:text-base rounded-md";

export function MapExplorer() {
  const liveHarbor = useMemo(() => createBrowserHarborClient(), []);
  const mockHarbor = useMemo(() => createMockHarborClient(), []);
  const contextGuard = useRef(createLatestRequestGuard());
  const detailGuard = useRef(createLatestRequestGuard());
  const [publicConfig, setPublicConfig] = useState<PublicPilotConfig | null>();
  const [walletSession, setWalletSession] = useState<WalletSessionStatus | null>();
  const [contextRefresh, setContextRefresh] = useState(0);
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const [catalog, setCatalog] = useState<CatalogState>({ kind: "idle" });
  const [query, setQuery] = useState("");
  const [network, setNetwork] = useState<Network>("testnet");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [layer, setLayer] = useState<LayerFilter>("all");
  const [selectedVenueId, setSelectedVenueId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState>({ kind: "closed" });

  const runtime = resolveMapRuntimeContext(publicConfig, walletSession);
  const harbor = selectMapHarborClient(publicConfig, {
    live: liveHarbor,
    mock: mockHarbor,
  });

  const refreshContext = useCallback(() => {
    setContextRefresh((value) => value + 1);
  }, []);

  useEffect(() => {
    const request = contextGuard.current.begin();
    const controller = new AbortController();
    setPublicConfig(undefined);
    setWalletSession(undefined);

    void Promise.allSettled([
      loadPublicPilotConfig(globalThis.fetch, controller.signal),
      loadWalletSessionStatus(globalThis.fetch, controller.signal),
    ]).then(([configResult, sessionResult]) => {
      if (!contextGuard.current.isCurrent(request)) return;
      setPublicConfig(configResult.status === "fulfilled" ? configResult.value : null);
      setWalletSession(sessionResult.status === "fulfilled" ? sessionResult.value : null);
    });

    return () => {
      controller.abort();
      contextGuard.current.invalidate();
    };
  }, [contextRefresh]);

  useEffect(() => {
    const handleFocus = () => refreshContext();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [refreshContext]);

  useEffect(() => {
    if (runtime.network) setNetwork(runtime.network);
  }, [runtime.key, runtime.network]);

  useEffect(() => {
    let current = true;
    setSelectedVenueId(null);
    setDetail({ kind: "closed" });

    if (!runtime.canLoadCatalog || !harbor) {
      setCatalog({ kind: "idle" });
      return () => {
        current = false;
      };
    }

    setCatalog({ kind: "loading" });
    void fetchVenueCatalog(harbor)
      .then((snapshot) => {
        if (current) setCatalog({ kind: "ready", snapshot });
      })
      .catch((error: unknown) => {
        if (current) {
          setCatalog({
            kind: "error",
            message: mapErrorMessage(error, "Harbor could not load the venue catalog."),
          });
        }
      });

    return () => {
      current = false;
    };
  }, [catalogRefresh, harbor, runtime.canLoadCatalog, runtime.key]);

  useEffect(() => {
    if (!selectedVenueId || !runtime.canLoadCatalog || !harbor) {
      detailGuard.current.invalidate();
      setDetail({ kind: "closed" });
      return;
    }

    const request = detailGuard.current.begin();
    setDetail({ kind: "loading" });
    void fetchVenueDetail(harbor, selectedVenueId)
      .then((snapshot) => {
        if (detailGuard.current.isCurrent(request)) {
          setDetail({ kind: "ready", snapshot });
        }
      })
      .catch((error: unknown) => {
        if (detailGuard.current.isCurrent(request)) {
          setDetail({
            kind: "error",
            message: mapErrorMessage(error, "Harbor could not load this venue."),
          });
        }
      });

    return () => detailGuard.current.invalidate();
  }, [harbor, runtime.canLoadCatalog, runtime.key, selectedVenueId]);

  const snapshot = catalog.kind === "ready" ? catalog.snapshot : null;
  const venues = snapshot?.data ?? [];
  const filteredVenues = useMemo(
    () => filterVenues(venues, { query, network, category, layer }),
    [venues, query, network, category, layer],
  );
  const liveCount = useMemo(() => countLiveVenues(venues, network), [venues, network]);
  const executionCount = useMemo(
    () => venues.filter((venue) => venue.kind === "execution-primitive").length,
    [venues],
  );
  const selectedSummary = venues.find((venue) => venue.id === selectedVenueId);
  const filtersActive = query.trim().length > 0 || category !== "all" || layer !== "all";
  const controlsDisabled = catalog.kind !== "ready";
  const statusError = runtime.kind === "configuration-error"
    ? runtime.detail
    : catalog.kind === "error"
      ? catalog.message
      : null;

  function resetFilters() {
    setQuery("");
    setCategory("all");
    setLayer("all");
  }

  function closeDetail() {
    detailGuard.current.invalidate();
    setSelectedVenueId(null);
    setDetail({ kind: "closed" });
  }

  return (
    <div className="min-h-[calc(100dvh-4rem)] w-full min-w-0">
      <header className="relative min-w-0 overflow-hidden border-b border-border">
        <div className="relative grid min-w-0 gap-6 px-4 py-8 sm:px-6 sm:py-10 lg:px-8 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-end">
          <div className="min-w-0">
            <p className="label-mono flex items-center gap-2">
              <MapIcon aria-hidden="true" className="size-3.5 text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" />
              XRPL ecosystem map
            </p>
            <h1 className="mt-3 max-w-3xl text-balance text-[1.75rem] font-semibold leading-tight tracking-[-0.02em] text-foreground font-display">
              Find the right venue before you move.
            </h1>
            <p className="label-mono mt-3 max-w-2xl leading-6">
              Explore Harbor's public venue catalog, compare its listed network statuses, and inspect each venue's published detail record.
            </p>
          </div>

          <dl className="flex min-w-0 flex-wrap items-center gap-y-2">
            <div className="flex items-baseline gap-2.5 pr-5">
              <dt className="label-mono">Venues</dt>
              <dd className="font-mono text-sm text-foreground">{snapshot ? venues.length : "—"}</dd>
            </div>
            <div className="flex items-baseline gap-2.5 border-l border-border px-5">
              <dt className="label-mono flex items-center gap-1.5"><span aria-hidden="true" className="size-1.5 shrink-0 bg-executed" />Live</dt>
              <dd className="font-mono text-sm text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]">{snapshot ? liveCount : "—"}</dd>
            </div>
            <div className="flex items-baseline gap-2.5 border-l border-border pl-5">
              <dt className="label-mono flex items-center gap-1.5"><span aria-hidden="true" className="size-1.5 shrink-0 bg-info" />Build</dt>
              <dd className="font-mono text-sm text-info">{snapshot ? executionCount : "—"}</dd>
            </div>
          </dl>
        </div>
      </header>

      <section aria-labelledby="map-controls-heading" className="min-w-0 border-b border-border">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-baseline gap-3">
            <h2 id="map-controls-heading" className="flex items-center gap-2 text-sm font-medium text-foreground">
              <SlidersHorizontal aria-hidden="true" className="size-4 text-muted-foreground" />
              Map controls
            </h2>
            <p className="label-mono">Availability focus: {labelToken(network)}</p>
          </div>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            <span
              role={statusError ? "alert" : "status"}
              aria-label={statusError ?? `${runtime.modeLabel}. ${runtime.owner ? `${shortAccount(runtime.owner)}. ` : ""}${runtime.detail}`}
              className={`inline-flex min-h-7 items-center border px-2 py-1 text-[12px] rounded-md ${statusError ? "border-destructive/35 bg-destructive/10 text-destructive" : "border-border bg-surface text-muted-foreground"}`}
            >
              {statusError ?? runtime.modeLabel}
            </span>
            {statusError ? (
              <button
                type="button"
                onClick={runtime.kind === "configuration-error" ? refreshContext : () => setCatalogRefresh((value) => value + 1)}
                className={secondaryButton}
              >
                <RefreshCw aria-hidden="true" className="size-3.5" />
                Retry
              </button>
            ) : null}
            <span className="inline-flex items-center gap-1.5 border border-border px-2 py-1 text-[13px] text-muted-foreground rounded-xl">
              <Database aria-hidden="true" className="size-3.5" />
              {snapshot ? snapshotLabel(snapshot.asOf) : catalog.kind === "loading" ? "Loading catalog" : "No catalog snapshot"}
            </span>
          </div>
        </div>
        <div className="grid min-w-0 gap-3 px-4 py-4 sm:px-6 lg:px-8 md:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,0.7fr))]">
          <label className="bracket bracket-focus relative block min-w-0">
            <span className="sr-only">Search venues</span>
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input type="search" value={query} disabled={controlsDisabled} onChange={(event) => setQuery(event.target.value)} placeholder="Search venues, builders, or reads" className={`${fieldBase} pl-9 pr-10`} />
            {query ? <button type="button" onClick={() => setQuery("")} aria-label="Clear venue search" className="absolute right-1 top-1 grid size-8 place-items-center text-muted-foreground transition hover:bg-white/[0.06] hover:text-foreground"><X aria-hidden="true" className="size-4" /></button> : null}
          </label>

          <SelectMenu
            className="bracket bracket-focus"
            label="Network focus"
            value={network}
            disabled={controlsDisabled}
            onChange={(value) => setNetwork(value)}
            display={`Network · ${labelToken(network)}`}
            options={NETWORKS.map((value) => ({ value, label: labelToken(value) }))}
          />
          <SelectMenu
            className="bracket bracket-focus"
            label="Category"
            value={category}
            disabled={controlsDisabled}
            onChange={(value) => setCategory(value)}
            options={[{ value: "all" as CategoryFilter, label: "All categories" }, ...CATEGORIES.map((value) => ({ value: value as CategoryFilter, label: labelToken(value) }))]}
          />
          <SelectMenu
            className="bracket bracket-focus"
            label="Layer"
            value={layer}
            disabled={controlsDisabled}
            onChange={(value) => setLayer(value)}
            options={[{ value: "all" as LayerFilter, label: "All layers" }, ...LAYERS.map((value) => ({ value: value as LayerFilter, label: labelToken(value) }))]}
          />
        </div>

        {snapshot && snapshot.caveats.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3 text-xs text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))] sm:px-6 lg:px-8">
            <Activity aria-hidden="true" className="size-4" />
            <span className="text-[13px]">Snapshot caveats:</span>
            {snapshot.caveats.map((caveat: Caveat) => <span key={caveat} className="border border-approval/30 bg-approval/10 px-1.5 py-0.5 text-[13px] rounded">{labelToken(caveat)}</span>)}
          </div>
        ) : null}
      </section>

      <div className="px-4 py-8 sm:px-6 lg:px-8">
      <section aria-labelledby="venue-grid-heading" aria-live="polite" className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h2 id="venue-grid-heading" className="text-sm font-medium tracking-tight text-foreground">Venue network</h2>
            <p className="label-mono mt-1.5">
              {snapshot ? `Showing ${filteredVenues.length} of ${venues.length}, sorted by ${labelToken(network)} availability.` : "Waiting for a Harbor catalog response."}
            </p>
          </div>
          {filtersActive && snapshot && filteredVenues.length > 0 ? <button type="button" onClick={resetFilters} className={secondaryButton}><X aria-hidden="true" className="size-3.5" />Reset filters</button> : null}
        </div>

        {catalog.kind === "loading" || catalog.kind === "idle" ? (
          <div className="mt-4 flex min-h-64 flex-col items-center justify-center border border-dashed border-border-strong bg-card px-5 py-10 text-center rounded-xl">
            <RefreshCw aria-hidden="true" className={`size-6 text-muted-foreground ${catalog.kind === "loading" ? "animate-spin" : ""}`} />
            <h3 className="mt-4 text-sm font-medium text-foreground">{catalog.kind === "loading" ? "Loading Harbor venues" : "Venue catalog not loaded"}</h3>
            <p className="label-mono mt-2 max-w-md leading-5">{runtime.detail}</p>
          </div>
        ) : catalog.kind === "error" ? (
          <div className="mt-4 flex min-h-64 flex-col items-center justify-center border border-destructive/35 bg-destructive/10 px-5 py-10 text-center rounded-xl">
            <RadioTower aria-hidden="true" className="size-6 text-destructive" />
            <h3 className="mt-4 text-sm font-medium text-foreground">Harbor venue catalog unavailable</h3>
            <p className="mt-2 max-w-md break-words text-[13px] leading-5 text-muted-foreground">{catalog.message}</p>
          </div>
        ) : filteredVenues.length > 0 ? (
          <div className="mt-4 grid min-w-0 border-l border-t border-border sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filteredVenues.map((venue) => <VenueCard key={venue.id} venue={venue} network={network} onSelect={(selected) => setSelectedVenueId(selected.id)} />)}
          </div>
        ) : (
          <div className="mt-4 flex min-h-64 flex-col items-center justify-center border border-dashed border-border-strong bg-card px-5 py-10 text-center rounded-xl">
            <RadioTower aria-hidden="true" className="size-6 text-muted-foreground" />
            <h3 className="mt-4 text-sm font-medium text-foreground">No venues match these filters</h3>
            <p className="label-mono mt-2 max-w-md leading-5">Try another category, layer, or search term. Changing the network focus only changes status and ordering.</p>
            <button type="button" onClick={resetFilters} className="mt-5 inline-flex h-9 items-center bg-primary px-4 text-[13px] font-medium text-primary-foreground transition hover:bg-primary/90 rounded-md">Show all venues</button>
          </div>
        )}
      </section>

      </div>

      <VenueDetailDialog
        venueId={selectedVenueId}
        venueName={selectedSummary?.name}
        venue={detail.kind === "ready" ? detail.snapshot.data : null}
        loading={detail.kind === "loading"}
        error={detail.kind === "error" ? detail.message : null}
        activeNetwork={network}
        asOf={detail.kind === "ready" ? detail.snapshot.asOf : null}
        asOfBasis={detail.kind === "ready" ? displayBasis(detail.snapshot.asOfBasis) : null}
        caveats={detail.kind === "ready" ? detail.snapshot.caveats : []}
        onClose={closeDetail}
      />
    </div>
  );
}

/** Harbor's mock registry labels itself "mock"; visitors see it as the demo registry. */
function displayBasis(basis: string): string {
  return basis.replace(/\bmock\b/gi, "demo");
}
