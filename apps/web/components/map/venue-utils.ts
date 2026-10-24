import type { Network, Venue } from "@pilot/contracts";

export const NETWORKS = [
  "mainnet",
  "testnet",
  "devnet",
  "lending-devnet",
] as const satisfies readonly Network[];

export const CATEGORIES = [
  "spot",
  "liquidity",
  "payments",
  "yield",
  "lending",
  "perps",
  "bridge",
  "analytics",
] as const satisfies readonly Venue["category"][number][];

export type CategoryFilter = "all" | Venue["category"][number];
export type LayerFilter = "all" | Venue["layer"];
export type VenueAvailability = NonNullable<Venue["status"][Network]> | "unlisted";

export type VenueFilters = {
  query: string;
  category: CategoryFilter;
  layer: LayerFilter;
  network: Network;
};

const STATUS_RANK: Record<VenueAvailability, number> = {
  live: 0,
  "devnet-only": 1,
  voting: 2,
  unavailable: 3,
  unlisted: 4,
};

export function venueAvailability(venue: Venue, network: Network): VenueAvailability {
  return venue.status[network] ?? "unlisted";
}

function searchableText(venue: Venue): string {
  return [
    venue.name,
    venue.id,
    venue.kind,
    venue.layer,
    ...venue.category,
    ...venue.reads,
    ...(venue.execution?.builders ?? []),
    ...(venue.execution?.transactions ?? []),
  ]
    .join(" ")
    .toLocaleLowerCase();
}

export function filterVenues(venues: Venue[], filters: VenueFilters): Venue[] {
  const query = filters.query.trim().toLocaleLowerCase();

  return venues
    .filter((venue) => {
      if (filters.category !== "all" && !venue.category.includes(filters.category)) {
        return false;
      }
      if (filters.layer !== "all" && venue.layer !== filters.layer) return false;
      return query.length === 0 || searchableText(venue).includes(query);
    })
    .sort((left, right) => {
      const statusDifference =
        STATUS_RANK[venueAvailability(left, filters.network)] -
        STATUS_RANK[venueAvailability(right, filters.network)];
      if (statusDifference !== 0) return statusDifference;
      if (left.kind !== right.kind) return left.kind === "execution-primitive" ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
}

export function countLiveVenues(venues: Venue[], network: Network): number {
  return venues.filter((venue) => venueAvailability(venue, network) === "live").length;
}

export function labelToken(value: string): string {
  return value
    .split("-")
    .map((token) => token.charAt(0).toLocaleUpperCase() + token.slice(1))
    .join(" ");
}

export function snapshotLabel(asOf: string): string {
  const match = asOf.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return asOf;
  const [, year, month, day, hour, minute] = match;
  return `${year}-${month}-${day} ${hour}:${minute} UTC`;
}
