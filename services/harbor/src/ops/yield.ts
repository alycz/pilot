import { z } from "zod";

import catalogManifest from "../../catalog/manifest.json";
import {
  createIndexer,
  type Indexer,
  type IndexerEnv,
} from "../adapters/indexer";
import type { OpContext, OpDef } from "../catalog/registry";
import { VenueSchema } from "../contracts";
import {
  readVaultInfo,
  type DevVaultNetwork,
} from "./vault";

const XRPL_AMM_FEE_DIVISOR = 100_000;
const DevVaultNetworkSchema = z.enum(["devnet", "lending-devnet"]);
const Hash256Schema = z
  .string()
  .regex(/^[A-Fa-f0-9]{64}$/, "must be a 64-character hexadecimal hash");
const AssetSchema = z
  .object({
    currency: z.string().min(1),
    issuer: z.string().min(1).optional(),
  })
  .strict();

const IndexerPoolSchema = z
  .object({
    account: z.string().min(1).optional(),
    apy7d: z.number().finite().optional(),
    asset1: AssetSchema,
    asset2: AssetSchema,
    fees24hXrp: z.number().finite().nonnegative().optional(),
    id: z.string().min(1),
    liquidityXrp: z.number().finite().nonnegative().optional(),
    tradingFee: z.number().int().min(0).max(1_000).optional(),
    volume24hXrp: z.number().finite().nonnegative().optional(),
    volume7dXrp: z.number().finite().nonnegative().optional(),
  })
  .strict();
const IndexerPoolResultSchema = z
  .object({
    data: z.array(IndexerPoolSchema),
    source: z.enum(["xrpl.to", "xrpscan", "bithomp"]),
  })
  .strict();

const AvailableAmmRateSchema = z
  .object({
    annualized: z.literal(false),
    availability: z.literal("available"),
    basis: z.literal("trailing-24h-volume"),
    fee_fraction: z.number().finite().nonnegative(),
    fee_return_ratio: z.number().finite().nonnegative(),
    formula: z.literal("volume24hXrp * feeFraction / tvlXrp"),
    period: z.literal("24h-input-unannualized"),
    trading_fee_xrpl_units: z.number().int().min(0).max(1_000),
    tvl_xrp: z.number().finite().positive(),
    volume_24h_xrp: z.number().finite().nonnegative(),
  })
  .strict();
const UnavailableRateSchema = z
  .object({
    availability: z.literal("unavailable"),
    reason: z.string().min(1),
  })
  .strict();
const RateSchema = z.union([AvailableAmmRateSchema, UnavailableRateSchema]);

const YieldOptionSchema = z
  .object({
    asset: AssetSchema.optional(),
    asset2: AssetSchema.optional(),
    id: z.string().min(1),
    kind: z.enum(["amm-fees", "single-asset-vault", "registry-vault"]),
    name: z.string().min(1),
    network: z.enum(["mainnet", "devnet", "lending-devnet"]),
    rate: RateSchema,
    risks: z.array(z.string().min(1)),
    source: z
      .object({
        kind: z.enum(["indexer", "xrpl-ledger", "venue-registry"]),
        provider: z.string().min(1),
      })
      .strict(),
    vault: z
      .object({
        account: z.string().min(1),
        asset: z.unknown(),
        owner: z.string().min(1),
        vault_id: Hash256Schema,
      })
      .strict()
      .optional(),
  })
  .strict();
const YieldOptionsResultSchema = z
  .object({ options: z.array(YieldOptionSchema) })
  .strict();

const YieldOptionsArgsSchema = z
  .object({
    amm_limit: z.number().int().min(1).max(100).optional(),
    vault_ids: z.array(Hash256Schema).max(20).optional(),
    vault_network: DevVaultNetworkSchema.optional(),
  })
  .strict()
  .superRefine(({ vault_ids, vault_network }, issueContext) => {
    const hasIds = vault_ids !== undefined && vault_ids.length > 0;
    if (hasIds !== (vault_network !== undefined)) {
      issueContext.addIssue({
        code: "custom",
        message:
          "vault_ids and vault_network must be provided together; omit both to skip vault reads",
      });
    }
    if (vault_ids && new Set(vault_ids).size !== vault_ids.length) {
      issueContext.addIssue({
        code: "custom",
        message: "vault_ids must not contain duplicates",
      });
    }
  });

type YieldOption = z.infer<typeof YieldOptionSchema>;

const registryVenues = VenueSchema.array().parse(catalogManifest.venues);
const registryYieldVenues = registryVenues.filter(({ id }) =>
  ["doppler-finance", "soil"].includes(id),
);

if (registryYieldVenues.length !== 2) {
  throw new Error("Yield registry must include Doppler Finance and SOIL");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function indexerForContext(ctx: OpContext): Indexer {
  const injected = ctx.indexer;
  if (isRecord(injected) && typeof injected.ammPools === "function") {
    return injected as unknown as Indexer;
  }
  const env = isRecord(ctx.env) ? (ctx.env as IndexerEnv) : {};
  return createIndexer({ env });
}

function ammRate(pool: z.infer<typeof IndexerPoolSchema>) {
  const { liquidityXrp, tradingFee, volume24hXrp } = pool;
  if (
    tradingFee === undefined ||
    volume24hXrp === undefined ||
    liquidityXrp === undefined ||
    liquidityXrp <= 0
  ) {
    return {
      availability: "unavailable" as const,
      reason:
        "The selected indexer did not provide all of tradingFee, volume24hXrp, and positive liquidityXrp; no fee return is claimed.",
    };
  }

  // XRPL TradingFee values are thousandths of a percentage point, so the
  // decimal fee fraction is TradingFee / 100,000. The Blueprint specifies the
  // literal 24-hour input calculation below; it is deliberately not projected
  // to an annual rate.
  // https://xrpl.org/docs/references/protocol/transactions/types/ammcreate#ammcreate-fields
  const feeFraction = tradingFee / XRPL_AMM_FEE_DIVISOR;
  return {
    annualized: false as const,
    availability: "available" as const,
    basis: "trailing-24h-volume" as const,
    fee_fraction: feeFraction,
    fee_return_ratio: (volume24hXrp * feeFraction) / liquidityXrp,
    formula: "volume24hXrp * feeFraction / tvlXrp" as const,
    period: "24h-input-unannualized" as const,
    trading_fee_xrpl_units: tradingFee,
    tvl_xrp: liquidityXrp,
    volume_24h_xrp: volume24hXrp,
  };
}

function ammOptions(
  response: z.infer<typeof IndexerPoolResultSchema>,
): YieldOption[] {
  return response.data.map((pool) => ({
    asset: pool.asset1,
    asset2: pool.asset2,
    id: `amm:${pool.id}`,
    kind: "amm-fees",
    name: `${pool.asset1.currency}/${pool.asset2.currency} AMM fees`,
    network: "mainnet",
    rate: ammRate(pool),
    risks: [
      "The fee return uses indexer-reported trailing volume and liquidity, which can be incomplete or stale.",
      "This 24-hour input ratio is not annualized, guaranteed yield, or an execution quote.",
      "Liquidity providers remain exposed to asset, issuer, pool-price, and withdrawal risks.",
    ],
    source: { kind: "indexer", provider: response.source },
  }));
}

async function vaultOptions(
  ctx: OpContext,
  network: DevVaultNetwork,
  vaultIds: readonly string[],
): Promise<YieldOption[]> {
  const vaults = await Promise.all(
    vaultIds.map((vault_id) => readVaultInfo(ctx, network, { vault_id })),
  );
  return vaults.map(({ vault, risks }) => ({
    id: `vault:${vault.index}`,
    kind: "single-asset-vault",
    name: `XRPL vault ${vault.index}`,
    network,
    rate: {
      availability: "unavailable",
      reason:
        "A current vault_info snapshot does not provide a verified time-based yield rate; no rate is estimated.",
    },
    risks,
    source: { kind: "xrpl-ledger", provider: "rippled:vault_info" },
    vault: {
      account: vault.Account,
      asset: vault.Asset,
      owner: vault.Owner,
      vault_id: vault.index,
    },
  }));
}

function registryOptions(): YieldOption[] {
  return registryYieldVenues.map((venue) => ({
    id: `registry:${venue.id}`,
    kind: "registry-vault",
    name: venue.name,
    network: "mainnet",
    rate: {
      availability: "unavailable",
      reason:
        "The static venue registry does not contain a verified live rate; consult the venue's current terms independently.",
    },
    risks: [...venue.risks],
    source: { kind: "venue-registry", provider: venue.id },
  }));
}

export const ops: OpDef[] = [
  {
    name: "yield.options",
    family: "yield",
    summary:
      "Compare AMM fee-return inputs, requested Devnet vaults, and catalogued off-ledger yield venues without inventing missing rates.",
    tags: ["yield", "amm", "vault", "doppler", "soil", "risk"],
    args: YieldOptionsArgsSchema,
    returns: "YieldOptions",
    caveats: ["devnet-only", "off-ledger", "amendment-pending"],
    example:
      'await harbor.yield.options({ amm_limit: 10, vault_network: "devnet", vault_ids: ["9E48171960CD9F62C3A7B6559315A510AE544C3F51E02947B5D4DAC8AA66C3BA"] })',
    handler: async (ctx, rawArgs) => {
      const { amm_limit = 20, vault_ids = [], vault_network } =
        rawArgs as z.infer<typeof YieldOptionsArgsSchema>;
      const indexerResponse = IndexerPoolResultSchema.parse(
        await indexerForContext(ctx).ammPools({ limit: amm_limit }),
      );
      const options = [
        ...ammOptions(indexerResponse),
        ...(vault_network
          ? await vaultOptions(ctx, vault_network, vault_ids)
          : []),
        ...registryOptions(),
      ];
      return YieldOptionsResultSchema.parse({ options });
    },
  },
];
