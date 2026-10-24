import { describe, expect, it } from "vitest";

import builderFixtures from "../fixtures/builders.json";
import readFixtures from "../fixtures/reads.json";
import {
  HarborArgsSchemas,
  HarborResultSchemas,
  type HarborOpName,
} from "../src/index.js";

type FixtureVenue = (typeof readFixtures)["venues.list"]["data"][number];

function venue(id: string): FixtureVenue {
  const match = readFixtures["venues.list"].data.find((candidate) => candidate.id === id);
  if (!match) throw new Error(`missing venue fixture ${id}`);
  return match;
}

describe("venue builder catalog consistency", () => {
  it("registers every advertised builder in fixtures and both runtime schema maps", () => {
    for (const candidate of readFixtures["venues.list"].data) {
      const builders = "execution" in candidate ? candidate.execution?.builders ?? [] : [];
      expect(new Set(builders).size, candidate.id).toBe(builders.length);
      for (const builder of builders) {
        expect(builder, candidate.id).toBeTypeOf("string");
        expect(builder in builderFixtures, `${candidate.id}: ${builder} fixture`).toBe(true);
        expect(builder in HarborArgsSchemas, `${candidate.id}: ${builder} args`).toBe(true);
        expect(builder in HarborResultSchemas, `${candidate.id}: ${builder} result`).toBe(true);
      }
    }
  });

  it("advertises every venue-scoped TxBuild fixture", () => {
    const advertised = new Set(
      readFixtures["venues.list"].data.flatMap((candidate) =>
        "execution" in candidate ? candidate.execution?.builders ?? [] : []),
    );
    const venueIndependent = new Set<HarborOpName>(["tx.simulate", "tx.trustSet"]);
    for (const builder of Object.keys(builderFixtures) as HarborOpName[]) {
      if (venueIndependent.has(builder)) continue;
      expect(advertised.has(builder), builder).toBe(true);
    }
  });

  it("matches the six required Harbor handoff fields without unsafe builders", () => {
    expect(venue("xrpl-escrow").execution).toEqual({
      transactions: ["EscrowCreate", "EscrowFinish", "EscrowCancel"],
      builders: ["tx.escrowCreate", "tx.escrowFinish", "tx.escrowCancel"],
    });
    expect(venue("xrpl-checks").execution).toEqual({
      transactions: ["CheckCreate", "CheckCash", "CheckCancel"],
      builders: ["tx.checkCreate", "tx.checkCash", "tx.checkCancel"],
    });
    expect(venue("xrpl-single-asset-vault").execution).toEqual({
      transactions: ["VaultDeposit", "VaultWithdraw"],
      builders: ["tx.vaultDeposit", "tx.vaultWithdraw"],
    });
    expect(venue("xrpl-single-asset-vault").status).toEqual({
      mainnet: "voting",
      testnet: "unavailable",
      devnet: "devnet-only",
      "lending-devnet": "live",
    });

    const lending = venue("xrpl-lending");
    expect(lending.status).toEqual({
      mainnet: "voting",
      testnet: "unavailable",
      devnet: "live",
      "lending-devnet": "live",
    });
    expect(lending.reads).toEqual(["lending.brokers"]);
    expect("lending.brokers" in readFixtures).toBe(true);
    expect("execution" in lending && lending.execution).toBeFalsy();

    const permissionedDex = venue("xrpl-permissioned-dex");
    expect(permissionedDex.status).toEqual({
      mainnet: "live",
      testnet: "live",
      devnet: "live",
    });
    expect("execution" in permissionedDex && permissionedDex.execution).toBeFalsy();
    const x402 = venue("xrpl-x402");
    expect(x402.status).toEqual({ testnet: "live" });
    expect("execution" in x402 && x402.execution).toBeFalsy();

    for (const id of ["xrpl-escrow", "xrpl-checks"]) {
      expect(venue(id).risks.join(" ")).toMatch(/mainnet execution remains disabled/i);
    }
  });
});
