import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import catalogManifest from "../catalog/manifest.json";
import { OpRegistry, type CatalogManifestInput } from "../src/catalog/registry";
import { MerchantSchema, type Merchant } from "../src/contracts";
import generatedOps from "../src/ops/index.gen";
import {
  getCatalogMerchant,
  listCatalogMerchants,
  ops,
} from "../src/ops/merchants";

const execFileAsync = promisify(execFile);
const expectedIds = ["risk-oracle", "venue-yield-desk"];

function operation(name: "merchants.list" | "merchants.get") {
  const op = ops.find((candidate) => candidate.name === name);
  if (!op) throw new Error(`Missing operation: ${name}`);
  return op;
}

describe("merchant operations", () => {
  it("lists both strict merchant records in stable id order", async () => {
    const list = operation("merchants.list");
    expect(list.args.safeParse({}).success).toBe(true);
    expect(list.args.safeParse({ extra: true }).success).toBe(false);

    const first = (await list.handler(
      { principal: "merchant-test" },
      {},
    )) as Merchant[];
    const second = listCatalogMerchants();

    expect(first.map(({ id }) => id)).toEqual(expectedIds);
    expect(MerchantSchema.array().parse(first)).toEqual(first);
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
  });

  it("gets an exact merchant and returns defensive copies", async () => {
    const get = operation("merchants.get");
    expect(get.args.safeParse({ id: "venue-yield-desk" }).success).toBe(true);
    expect(get.args.safeParse({ id: "" }).success).toBe(false);
    expect(
      get.args.safeParse({ id: "venue-yield-desk", extra: true }).success,
    ).toBe(false);

    const fromOp = (await get.handler(
      { principal: "merchant-test" },
      { id: "venue-yield-desk" },
    )) as Merchant;
    const fromLookup = getCatalogMerchant("venue-yield-desk");

    expect(fromOp).toMatchObject({
      id: "venue-yield-desk",
      schemes: ["exact", "xrpl-paychan"],
      required_credential: {
        credential_type_hex: "4150344D2D4167656E74",
      },
      products: [
        {
          sku: "yield-report",
          price: { value: "1" },
        },
      ],
    });
    expect(fromOp).toEqual(fromLookup);
    expect(fromOp).not.toBe(fromLookup);
  });

  it("fails clearly for an unknown merchant", () => {
    expect(() =>
      operation("merchants.get").handler(
        { principal: "merchant-test" },
        { id: "not-a-merchant" },
      ),
    ).toThrow("Unknown merchant: not-a-merchant");
    expect(getCatalogMerchant("not-a-merchant")).toBeUndefined();
  });

  it("makes the yield merchant discoverable with price, schemes, and credential", () => {
    const registry = new OpRegistry(generatedOps).loadCatalogManifest(
      catalogManifest as CatalogManifestInput,
    );
    const result = registry
      .search("pay for yield report")
      .find(({ id }) => id === "merchant:venue-yield-desk");

    expect(result).toMatchObject({
      kind: "merchant",
      family: "merchants",
      name: "Venue Yield Desk",
      tags: expect.arrayContaining([
        "ap4m",
        "x402",
        "requires-credential",
        "exact",
        "xrpl-paychan",
      ]),
      signature: expect.stringContaining("venue-yield-desk"),
    });
    expect(result?.summary).toContain("price 1 RLUSD:");
    expect(result?.summary).toContain("schemes exact, xrpl-paychan");
    expect(result?.summary).toContain("requires credential");
  });

  it("rejects unknown merchant YAML fields during catalog generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "harbor-merchants-"));
    try {
      await mkdir(join(root, "catalog/merchants"), { recursive: true });
      await writeFile(
        join(root, "catalog/merchants/invalid.yaml"),
        [
          "id: invalid",
          "name: Invalid",
          "network: testnet",
          "base_url: http://127.0.0.1:8794/m/invalid",
          "xrpl_address: rInvalid",
          "src_dpa_id: demo-invalid",
          "schemes: [exact]",
          "settle_asset: { kind: xrp }",
          "required_credential:",
          "  issuer: rIssuer",
          "  credential_type_hex: 4150344D2D4167656E74",
          "products:",
          "  - sku: report",
          "    name: Report",
          "    description: Invalid fixture",
          "    price: { asset: { kind: xrp }, value: '1' }",
          "    response_schema_id: report_v1",
          "wba_required: true",
          "unexpected: true",
        ].join("\n"),
        "utf8",
      );

      await expect(
        execFileAsync(process.execPath, ["scripts/build-catalog.mjs", "--root", root], {
          cwd: process.cwd(),
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("unknown key unexpected"),
      });

      await expect(
        readFile(join(root, "catalog/manifest.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
