import { z } from "zod";

import catalogManifest from "../../catalog/manifest.json";
import type { OpDef } from "../catalog/registry";
import { MerchantSchema, type Merchant } from "../contracts";

const catalogMerchants: readonly Merchant[] = Object.freeze(
  MerchantSchema.array().parse(
    (catalogManifest as { merchants?: unknown }).merchants ?? [],
  ),
);

const merchantsById = new Map(
  catalogMerchants.map((merchant) => [merchant.id, merchant]),
);

if (merchantsById.size !== catalogMerchants.length) {
  throw new Error("Generated catalog manifest contains duplicate merchant ids");
}

function copyMerchant(merchant: Merchant): Merchant {
  return MerchantSchema.parse(merchant);
}

export function listCatalogMerchants(): readonly Merchant[] {
  return catalogMerchants.map(copyMerchant);
}

export function getCatalogMerchant(id: string): Merchant | undefined {
  const merchant = merchantsById.get(id);
  return merchant === undefined ? undefined : copyMerchant(merchant);
}

export const ops: OpDef[] = [
  {
    name: "merchants.list",
    family: "merchants",
    summary:
      "List the allowlisted AP4M demo merchants, products, prices, settlement schemes, and credential requirements.",
    tags: ["merchants", "catalog", "discovery", "ap4m", "x402", "requires-credential"],
    args: z.object({}).strict(),
    returns: "Merchant[]",
    caveats: [],
    example: "await harbor.merchants.list({})",
    handler: () => listCatalogMerchants(),
  },
  {
    name: "merchants.get",
    family: "merchants",
    summary:
      "Get one allowlisted AP4M demo merchant with its products, prices, schemes, and required credential.",
    tags: ["merchants", "catalog", "discovery", "ap4m", "x402", "requires-credential"],
    args: z
      .object({
        id: z.string().trim().min(1),
      })
      .strict(),
    returns: "Merchant",
    caveats: [],
    example: 'await harbor.merchants.get({ id: "venue-yield-desk" })',
    handler: (_ctx, rawArgs) => {
      const { id } = rawArgs as { id: string };
      const merchant = getCatalogMerchant(id);
      if (!merchant) throw new Error(`Unknown merchant: ${id}`);
      return merchant;
    },
  },
];
