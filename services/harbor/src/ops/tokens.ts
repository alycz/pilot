import { isValidClassicAddress } from "xrpl";
import { z } from "zod";

import { createIndexer, type Indexer, type IndexerEnv } from "../adapters/indexer";
import { requestXrpl } from "../adapters/xrpl-rpc";
import type { OpContext, OpDef } from "../catalog/registry";
import { NetworkSchema } from "../contracts";

const ClassicAddressSchema = z
  .string()
  .refine(isValidClassicAddress, "must be a valid XRPL classic address");
const CurrencySchema = z
  .string()
  .trim()
  .min(3)
  .max(40)
  .refine(
    (currency) =>
      /^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3,20}$/.test(currency) ||
      /^[A-Fa-f0-9]{40}$/.test(currency),
    "must be a 3-20 character token code or 40 hexadecimal characters",
  );
const LimitSchema = z.number().int().min(1).max(100).optional();
const LedgerHashSchema = z.string().regex(/^[A-Fa-f0-9]{64}$/);
const MarkerSchema = z.union([
  z.string().max(512),
  z
    .record(
      z.string().max(64),
      z.union([z.string().max(512), z.number().finite().safe()]),
    )
    .refine((marker) => Object.keys(marker).length <= 8),
]);

const AccountInfoSchema = z
  .object({
    account_data: z
      .object({
        Account: ClassicAddressSchema,
        Flags: z.number().int().min(0).max(0xffff_ffff),
        RegularKey: ClassicAddressSchema.optional(),
      })
      .passthrough(),
    // rippled may omit this field when the requested account has no signer
    // list, even when signer_lists:true was supplied.
    signer_lists: z.array(z.record(z.string(), z.unknown())).max(1).default([]),
    ledger_hash: LedgerHashSchema,
    validated: z.literal(true),
  })
  .passthrough();

const DelegateObjectsSchema = z
  .object({
    account_objects: z.array(
      z
        .object({
          LedgerEntryType: z.literal("Delegate"),
        })
        .passthrough(),
    ).max(400),
    ledger_hash: LedgerHashSchema,
    marker: MarkerSchema.optional(),
    validated: z.literal(true),
  })
  .passthrough();

const LSF_REQUIRE_AUTH = 0x0004_0000;
const LSF_DISABLE_MASTER = 0x0010_0000;
const LSF_GLOBAL_FREEZE = 0x0040_0000;
const LSF_ALLOW_TRUST_LINE_CLAWBACK = 0x8000_0000;
const BLACKHOLE_ADDRESSES = new Set([
  "rrrrrrrrrrrrrrrrrrrrrhoLvTp",
  "rrrrrrrrrrrrrrrrrrrrBZbvji",
]);
const MAX_DELEGATE_PAGES = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envFromContext(ctx: OpContext): IndexerEnv {
  return isRecord(ctx.env) ? (ctx.env as IndexerEnv) : {};
}

function isIndexer(value: unknown): value is Indexer {
  return (
    isRecord(value) &&
    typeof value.lookupToken === "function" &&
    typeof value.trendingTokens === "function" &&
    typeof value.flaggedTokens === "function" &&
    typeof value.ammPools === "function"
  );
}

function indexerFor(ctx: OpContext): Indexer {
  return isIndexer(ctx.indexer)
    ? ctx.indexer
    : createIndexer({ env: envFromContext(ctx) });
}

function hasFlag(flags: number, flag: number): boolean {
  return ((flags >>> 0) & (flag >>> 0)) !== 0;
}

async function issuerFlags(
  ctx: OpContext,
  network: z.infer<typeof NetworkSchema>,
  issuer: string,
) {
  // AccountRoot flag values and meanings:
  // https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/accountroot#accountroot-flags
  // A verifiable blackhole also requires no signer list and no delegates:
  // https://xrpl.org/docs/concepts/accounts/blackholed-accounts#checking-whether-an-account-is-blackholed
  const accountInfoRaw = await requestXrpl(ctx, network, "account_info", {
    account: issuer,
    ledger_index: "validated",
    signer_lists: true,
  });
  const accountInfo = AccountInfoSchema.parse(accountInfoRaw);
  if (accountInfo.account_data.Account !== issuer) {
    throw new Error("XRPL account_info returned a different account");
  }

  const { Flags: flags, RegularKey: regularKey } = accountInfo.account_data;
  const baseFlags = {
    requireAuth: hasFlag(flags, LSF_REQUIRE_AUTH),
    freeze: hasFlag(flags, LSF_GLOBAL_FREEZE),
    clawback: hasFlag(flags, LSF_ALLOW_TRUST_LINE_CLAWBACK),
  };
  const canBeBlackholed =
    hasFlag(flags, LSF_DISABLE_MASTER) &&
    regularKey !== undefined &&
    BLACKHOLE_ADDRESSES.has(regularKey) &&
    accountInfo.signer_lists.length === 0;
  // Delegates can only change the result after every cheaper blackhole
  // prerequisite has been proven. Avoid enumerating an issuer's unrelated
  // ledger objects when any prerequisite is absent.
  if (!canBeBlackholed) {
    return { ...baseFlags, blackholed: false };
  }

  let marker: z.infer<typeof MarkerSchema> | undefined;
  let hasDelegate = false;
  const seenMarkers = new Set<string>();
  for (let page = 0; page < MAX_DELEGATE_PAGES; page += 1) {
    const delegateObjectsRaw = await requestXrpl(
      ctx,
      network,
      "account_objects",
      {
        account: issuer,
        ledger_hash: accountInfo.ledger_hash,
        limit: 400,
        type: "delegate",
        ...(marker === undefined ? {} : { marker }),
      },
    );
    const delegateObjects = DelegateObjectsSchema.parse(delegateObjectsRaw);
    if (
      delegateObjects.ledger_hash.toUpperCase() !==
      accountInfo.ledger_hash.toUpperCase()
    ) {
      throw new Error("XRPL account_objects returned a different ledger");
    }
    if (delegateObjects.account_objects.length > 0) {
      hasDelegate = true;
      break;
    }
    marker = delegateObjects.marker;
    if (marker === undefined) break;
    const markerKey = JSON.stringify(marker);
    if (seenMarkers.has(markerKey)) {
      throw new Error("XRPL account_objects repeated a pagination marker");
    }
    seenMarkers.add(markerKey);
    if (page === MAX_DELEGATE_PAGES - 1) {
      throw new Error("XRPL delegate pagination exceeded its safe page limit");
    }
  }
  return {
    ...baseFlags,
    blackholed: !hasDelegate,
  };
}

export const ops: OpDef[] = [
  {
    name: "tokens.lookup",
    family: "tokens",
    summary:
      "Look up token metadata and merge it with validated on-ledger issuer controls.",
    tags: ["tokens", "issuer", "metadata", "risk", "flags"],
    args: z
      .object({
        network: NetworkSchema,
        currency: CurrencySchema,
        issuer: ClassicAddressSchema,
      })
      .strict(),
    returns: "indexer token metadata plus RequireAuth, freeze, clawback, and blackhole flags",
    caveats: ["off-ledger"],
    example:
      'await harbor.tokens.lookup({ network: "testnet", currency: "RLUSD", issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" })',
    handler: async (ctx, rawArgs) => {
      const args = rawArgs as {
        network: z.infer<typeof NetworkSchema>;
        currency: string;
        issuer: string;
      };
      const [indexer, ledgerFlags] = await Promise.all([
        indexerFor(ctx).lookupToken({
          currency: args.currency,
          issuer: args.issuer,
          network: args.network,
        }),
        issuerFlags(ctx, args.network, args.issuer),
      ]);
      return {
        currency: indexer.data.currency,
        issuer: args.issuer,
        metadata: indexer.data,
        metadataSource: indexer.source,
        ledgerFlags,
        trust: {
          metadata: "external-reference" as const,
          ledgerFlags: "validated-ledger" as const,
        },
      };
    },
  },
  {
    name: "tokens.trending",
    family: "tokens",
    summary:
      "List provider-ranked XRPL tokens, preferring XRPL.to's trend score.",
    tags: ["tokens", "trending", "discovery", "volume"],
    args: z
      .object({
        limit: LimitSchema,
      })
      .strict(),
    returns: "ranked normalized token metadata with the indexer source",
    caveats: ["off-ledger"],
    example: "await harbor.tokens.trending({ limit: 10 })",
    handler: async (ctx, rawArgs) => {
      const { limit = 10 } = rawArgs as { limit?: number };
      const result = await indexerFor(ctx).trendingTokens({ limit });
      return { ...result, trust: "external-reference" as const };
    },
  },
  {
    name: "tokens.flagged",
    family: "tokens",
    summary: "List issuer accounts on XRPL.to's verified scam blocklist.",
    tags: ["tokens", "scam", "blocklist", "risk"],
    args: z
      .object({
        limit: LimitSchema,
      })
      .strict(),
    returns: "verified-blocklist issuer accounts with the indexer source",
    caveats: ["off-ledger"],
    example: "await harbor.tokens.flagged({ limit: 25 })",
    handler: async (ctx, rawArgs) => {
      const { limit = 25 } = rawArgs as { limit?: number };
      const result = await indexerFor(ctx).flaggedTokens({ limit });
      return { ...result, trust: "external-reference" as const };
    },
  },
  {
    name: "amm.pools",
    family: "amm",
    summary:
      "List normalized XRPL AMM pools with provider liquidity and activity metrics when available.",
    tags: ["amm", "pools", "liquidity", "indexer"],
    args: z
      .object({
        limit: LimitSchema,
      })
      .strict(),
    returns: "normalized AMM pools and the indexer source",
    caveats: ["off-ledger"],
    example: "await harbor.amm.pools({ limit: 25 })",
    handler: async (ctx, rawArgs) => {
      const { limit = 25 } = rawArgs as { limit?: number };
      const result = await indexerFor(ctx).ammPools({ limit });
      return { ...result, trust: "external-reference" as const };
    },
  },
];
