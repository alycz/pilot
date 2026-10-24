import { describe, expect, it } from "vitest";

import catalogManifest from "../catalog/manifest.json";
import type { Venue } from "../src/contracts";
import { ops as venueOps } from "../src/ops/venues";

const NON_VENUE_TX_BUILDERS = new Set([
  // tx.simulate is the generic raw-transaction entry point, not a venue-specific
  // builder. tx.trustSet manages an account trust line and is a prerequisite for
  // some token venues, rather than execution on one of them.
  "tx.simulate",
  "tx.trustSet",
]);

async function listedVenues(): Promise<Venue[]> {
  const list = venueOps.find((op) => op.name === "venues.list");
  if (!list) throw new Error("Missing venues.list operation");
  return (await list.handler(
    { principal: "venue-builder-consistency" },
    {},
  )) as Venue[];
}

function venueTransactionBuilders(): string[] {
  return catalogManifest.ops
    .filter(
      (op) =>
        op.family === "tx" &&
        op.returns.includes("TxBuild") &&
        !NON_VENUE_TX_BUILDERS.has(op.name),
    )
    .map((op) => op.name);
}

describe("venue builder catalog consistency", () => {
  it("venues.list only advertises registered transaction-builder operations", async () => {
    const operations = new Map(catalogManifest.ops.map((op) => [op.name, op]));

    for (const venue of await listedVenues()) {
      const builders = venue.execution?.builders ?? [];
      expect(new Set(builders).size, `${venue.id} has duplicate builders`).toBe(
        builders.length,
      );

      for (const builder of builders) {
        const operation = operations.get(builder);
        expect(
          operation,
          `${venue.id} advertises missing op ${builder}`,
        ).toBeDefined();
        expect(operation?.family, `${builder} is not a tx op`).toBe("tx");
        expect(operation?.returns, `${builder} does not return a TxBuild`).toContain(
          "TxBuild",
        );
      }
    }
  });

  it("venues.list advertises every venue-scoped TxBuild operation", async () => {
    const advertised = new Set(
      (await listedVenues()).flatMap(
        (venue) => venue.execution?.builders ?? [],
      ),
    );
    const missing = venueTransactionBuilders().filter(
      (builder) => !advertised.has(builder),
    );

    expect(missing).toEqual([]);
  });
});
