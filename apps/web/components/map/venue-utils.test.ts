import type { Venue } from "@pilot/contracts";
import { describe, expect, it } from "vitest";

import {
  countLiveVenues,
  filterVenues,
  snapshotLabel,
  venueAvailability,
} from "./venue-utils";

const venues: Venue[] = [
  {
    id: "discovery",
    name: "Discovery Analytics",
    kind: "discovery-venue",
    layer: "off-ledger",
    category: ["analytics"],
    status: { mainnet: "live" },
    reads: ["tokens.lookup"],
    risks: ["External data can be stale."],
    links: {},
  },
  {
    id: "amm",
    name: "XRPL AMM",
    kind: "execution-primitive",
    layer: "xrpl-l1",
    category: ["liquidity", "yield"],
    status: { testnet: "live", devnet: "live" },
    execution: {
      transactions: ["AMMDeposit"],
      builders: ["tx.ammDeposit"],
    },
    reads: ["amm.info"],
    risks: ["Pool prices move."],
    links: {},
  },
  {
    id: "vault",
    name: "Single Asset Vault",
    kind: "execution-primitive",
    layer: "xrpl-l1",
    category: ["yield"],
    status: { testnet: "unavailable", devnet: "devnet-only" },
    reads: ["vault.info"],
    risks: ["Development network feature."],
    links: {},
  },
];

describe("venue map filters", () => {
  it("searches across names, reads, and builders", () => {
    expect(
      filterVenues(venues, {
        query: "ammDeposit",
        network: "testnet",
        category: "all",
        layer: "all",
      }).map((venue) => venue.id),
    ).toEqual(["amm"]);

    expect(
      filterVenues(venues, {
        query: "tokens.lookup",
        network: "testnet",
        category: "all",
        layer: "all",
      }).map((venue) => venue.id),
    ).toEqual(["discovery"]);
  });

  it("combines category and layer filters", () => {
    expect(
      filterVenues(venues, {
        query: "",
        network: "devnet",
        category: "yield",
        layer: "xrpl-l1",
      }).map((venue) => venue.id),
    ).toEqual(["amm", "vault"]);
  });

  it("sorts venues by availability on the focused network", () => {
    expect(
      filterVenues(venues, {
        query: "",
        network: "testnet",
        category: "all",
        layer: "all",
      }).map((venue) => venue.id),
    ).toEqual(["amm", "vault", "discovery"]);
  });
});

describe("venue map metadata", () => {
  it("treats absent network status as unlisted", () => {
    expect(venueAvailability(venues[0]!, "testnet")).toBe("unlisted");
    expect(countLiveVenues(venues, "testnet")).toBe(1);
  });

  it("formats a stable UTC snapshot label", () => {
    expect(snapshotLabel("2026-10-18T00:00:00.000Z")).toBe("2026-10-18 00:00 UTC");
    expect(snapshotLabel("fixture-clock")).toBe("fixture-clock");
  });
});
