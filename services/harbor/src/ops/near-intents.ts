import { z } from "zod";

import type { OpContext, OpDef } from "../catalog/registry";
import { createOneClickClient, type OneClickClient } from "../near/one-click";

const VisibleTextSchema = z.string().trim().min(1).max(512)
  .regex(/^[\x21-\x7e]+$/, "must contain only visible ASCII characters");
const AssetIdSchema = z.string().trim().min(3).max(320)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*:\S+$/, "must be a namespaced 1Click asset ID");
const BlockchainSchema = z.enum([
  "near", "eth", "base", "arb", "btc", "sol", "ton", "dash", "doge",
  "xrp", "zec", "gnosis", "bera", "bsc", "pol", "tron", "sui",
  "movement", "op", "avax", "stellar", "aptos", "cardano", "ltc",
  "xlayer", "monad", "bch", "adi", "plasma", "scroll", "starknet",
  "aleo", "hypercore", "fogo", "hood", "hlevm", "qtc", "abs",
]);
const AtomicAmountSchema = z.string().max(128)
  .regex(/^[1-9][0-9]*$/, "must be a positive atomic-unit integer string");
const DateTimeSchema = z.string().datetime({ offset: true });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOneClickClient(value: unknown): value is OneClickClient {
  return isRecord(value) &&
    typeof value.tokens === "function" &&
    typeof value.quote === "function" &&
    typeof value.status === "function";
}

function clientFor(ctx: OpContext): OneClickClient {
  if (isOneClickClient(ctx.nearOneClickClient)) return ctx.nearOneClickClient;
  const env = isRecord(ctx.env) ? ctx.env : {};
  const apiKey = typeof env.NEAR_INTENTS_API_KEY === "string"
    ? env.NEAR_INTENTS_API_KEY
    : undefined;
  return createOneClickClient({ apiKey, allowExecutableQuotes: false });
}

export const ops: OpDef[] = [
  {
    name: "near.intents.tokens",
    family: "near",
    summary: "Read current 1Click-supported asset identifiers without assuming chain or token support.",
    tags: ["near", "intents", "1click", "tokens", "discovery", "earn"],
    args: z.object({
      blockchain: BlockchainSchema.optional(),
      symbol: z.string().trim().min(1).max(32).optional(),
      include_ondo: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }).strict(),
    returns: "live 1Click token metadata with exact asset IDs",
    caveats: ["off-ledger"],
    example: 'await harbor.near.intents.tokens({ blockchain: "near", limit: 100 })',
    handler: async (ctx, rawArgs) => {
      const args = rawArgs as {
        blockchain?: string;
        symbol?: string;
        include_ondo?: boolean;
        limit?: number;
      };
      const tokens = await clientFor(ctx).tokens({ includeOndo: args.include_ondo });
      const symbol = args.symbol?.toLocaleLowerCase();
      const filtered = tokens.filter((token) =>
        (args.blockchain === undefined || token.blockchain === args.blockchain) &&
        (symbol === undefined || token.symbol.toLocaleLowerCase() === symbol)
      ).sort((left, right) =>
        left.blockchain.localeCompare(right.blockchain) ||
        left.symbol.localeCompare(right.symbol) ||
        left.assetId.localeCompare(right.assetId)
      ).slice(0, args.limit ?? 100);
      return {
        provider: "near-intents-1click",
        source: "live",
        live: true,
        execution_enabled: false,
        count: filtered.length,
        tokens: filtered,
      };
    },
  },
  {
    name: "near.intents.quote",
    family: "near",
    summary: "Request and verify a dry EXACT_INPUT 1Click quote; this operation cannot create a deposit address.",
    tags: ["near", "intents", "1click", "quote", "dry-run", "verified"],
    args: z.object({
      dry: z.literal(true).default(true),
      origin_asset_id: AssetIdSchema,
      destination_asset_id: AssetIdSchema,
      amount: AtomicAmountSchema,
      slippage_bps: z.number().int().min(0).max(10_000),
      deposit_type: z.literal("ORIGIN_CHAIN"),
      recipient: VisibleTextSchema,
      recipient_type: z.literal("DESTINATION_CHAIN"),
      refund_to: VisibleTextSchema,
      refund_type: z.literal("ORIGIN_CHAIN"),
      refund_deadline: DateTimeSchema,
      quote_waiting_time_ms: z.number().int().min(0).max(30_000).optional(),
    }).strict().refine((request) => request.origin_asset_id !== request.destination_asset_id, {
      path: ["destination_asset_id"],
      message: "origin and destination assets must differ",
    }),
    returns: "provider-signed dry quote with canonical quote hash and no execution address",
    caveats: ["off-ledger"],
    example: 'await harbor.near.intents.quote({ dry: true, origin_asset_id: "asset-id-from-near.intents.tokens", destination_asset_id: "another-live-asset-id", amount: "1000000", slippage_bps: 100, deposit_type: "ORIGIN_CHAIN", recipient: "destination-address", recipient_type: "DESTINATION_CHAIN", refund_to: "refund-address", refund_type: "ORIGIN_CHAIN", refund_deadline: "2027-01-01T00:00:00.000Z" })',
    handler: async (ctx, rawArgs) => {
      const args = rawArgs as {
        dry: true;
        origin_asset_id: string;
        destination_asset_id: string;
        amount: string;
        slippage_bps: number;
        deposit_type: "ORIGIN_CHAIN";
        recipient: string;
        recipient_type: "DESTINATION_CHAIN";
        refund_to: string;
        refund_type: "ORIGIN_CHAIN";
        refund_deadline: string;
        quote_waiting_time_ms?: number;
      };
      if (Date.parse(args.refund_deadline) <= Date.now()) {
        throw new Error("NEAR Intents refund deadline must be in the future");
      }
      const quote = await clientFor(ctx).quote({
        dry: true,
        swapType: "EXACT_INPUT",
        slippageTolerance: args.slippage_bps,
        originAsset: args.origin_asset_id,
        depositType: args.deposit_type,
        destinationAsset: args.destination_asset_id,
        amount: args.amount,
        refundTo: args.refund_to,
        refundType: args.refund_type,
        recipient: args.recipient,
        recipientType: args.recipient_type,
        deadline: args.refund_deadline,
        depositMode: "SIMPLE",
        confidentiality: "public",
        quoteWaitingTimeMs: args.quote_waiting_time_ms ?? 0,
        insured: false,
      });
      return {
        provider: "near-intents-1click",
        source: "live",
        mode: "dry",
        signature_verified: true,
        execution_enabled: false,
        quote_hash: quote.quoteHash,
        quote: quote.response,
      };
    },
  },
  {
    name: "near.intents.status",
    family: "near",
    summary: "Read 1Click settlement status using the exact deposit address and required memo.",
    tags: ["near", "intents", "1click", "status", "settlement", "verified"],
    args: z.object({
      deposit_address: VisibleTextSchema,
      deposit_memo: VisibleTextSchema.optional(),
    }).strict(),
    returns: "verified 1Click quote binding and current provider settlement state",
    caveats: ["off-ledger"],
    example: 'await harbor.near.intents.status({ deposit_address: "address-from-verified-quote", deposit_memo: "memo-when-present" })',
    handler: async (ctx, rawArgs) => {
      const args = rawArgs as { deposit_address: string; deposit_memo?: string };
      const status = await clientFor(ctx).status({
        depositAddress: args.deposit_address,
        ...(args.deposit_memo === undefined ? {} : { depositMemo: args.deposit_memo }),
      });
      return {
        provider: "near-intents-1click",
        source: "live",
        signature_verified: true,
        execution_enabled: false,
        status,
      };
    },
  },
];
