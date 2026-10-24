import { isValidClassicAddress } from "xrpl";
import { z } from "zod";

import type { OpDef } from "../catalog/registry";
import { NetworkSchema, type Network } from "../contracts";
import { requestXrpl } from "../adapters/xrpl-rpc";

const AccountSchema = z
  .string()
  .refine(isValidClassicAddress, "Expected an XRPL classic address");
const LedgerHashSchema = z
  .string()
  .regex(/^[A-Fa-f0-9]{64}$/, "Expected a 64-character ledger hash");
const LedgerIndexSchema = z.union([
  z.number().int().nonnegative(),
  z.enum(["validated", "closed", "current"]),
]);
const MarkerSchema = z.union([
  z.string().min(1),
  z.number().int().nonnegative(),
  z.record(z.string(), z.unknown()),
]);

function splitNetwork(args: unknown): {
  network: Network;
  params: Record<string, unknown>;
} {
  const { network, ...params } = args as Record<string, unknown> & {
    network: Network;
  };
  return { network, params };
}

function ensureRows(
  result: Record<string, unknown>,
  key: "lines" | "account_objects" | "transactions",
): Record<string, unknown> {
  const rows = result[key];
  if (rows === undefined || rows === null) {
    return { ...result, [key]: [] };
  }
  if (!Array.isArray(rows)) {
    throw new TypeError(`XRPL response field ${key} must be an array`);
  }
  return result;
}

export const ops: OpDef[] = [
  {
    name: "ledger.account.info",
    family: "ledger",
    summary: "Read an XRPL account root, flags, and optional queue or signer-list data.",
    tags: ["account", "balance", "flags", "xrpl"],
    // https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/account-methods/account_info
    args: z
      .object({
        network: NetworkSchema,
        account: AccountSchema,
        ledger_hash: LedgerHashSchema.optional(),
        ledger_index: LedgerIndexSchema.optional(),
        queue: z.boolean().optional(),
        signer_lists: z.boolean().optional(),
      })
      .strict(),
    returns: "the raw account_info result",
    caveats: [],
    example:
      "await harbor.ledger.account.info({ network: 'testnet', account: 'r...' })",
    handler: async (ctx, args) => {
      const { network, params } = splitNetwork(args);
      return requestXrpl(ctx, network, "account_info", params);
    },
  },
  {
    name: "ledger.account.lines",
    family: "ledger",
    summary: "Read an XRPL account's trust lines with optional peer filtering and pagination.",
    tags: ["account", "trust-lines", "balances", "pagination", "xrpl"],
    // https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/account-methods/account_lines
    args: z
      .object({
        network: NetworkSchema,
        account: AccountSchema,
        peer: AccountSchema.optional(),
        ignore_default: z.boolean().optional(),
        ledger_hash: LedgerHashSchema.optional(),
        ledger_index: LedgerIndexSchema.optional(),
        limit: z.number().int().min(10).max(400).optional(),
        marker: MarkerSchema.optional(),
      })
      .strict(),
    returns: "the raw account_lines result with lines always present",
    caveats: [],
    example:
      "await harbor.ledger.account.lines({ network: 'testnet', account: 'r...', limit: 200 })",
    handler: async (ctx, args) => {
      const { network, params } = splitNetwork(args);
      return ensureRows(
        await requestXrpl(ctx, network, "account_lines", params),
        "lines",
      );
    },
  },
  {
    name: "ledger.account.objects",
    family: "ledger",
    summary: "Read raw XRPL ledger objects owned by an account with filtering and pagination.",
    tags: ["account", "ledger-objects", "owner-directory", "pagination", "xrpl"],
    // https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/account-methods/account_objects
    args: z
      .object({
        network: NetworkSchema,
        account: AccountSchema,
        deletion_blockers_only: z.boolean().optional(),
        ledger_hash: LedgerHashSchema.optional(),
        ledger_index: LedgerIndexSchema.optional(),
        limit: z.number().int().min(10).max(400).optional(),
        marker: MarkerSchema.optional(),
        sponsored: z.boolean().optional(),
        type: z.string().trim().min(1).max(64).optional(),
      })
      .strict(),
    returns: "the raw account_objects result with account_objects always present",
    caveats: [],
    example:
      "await harbor.ledger.account.objects({ network: 'testnet', account: 'r...', type: 'offer' })",
    handler: async (ctx, args) => {
      const { network, params } = splitNetwork(args);
      return ensureRows(
        await requestXrpl(ctx, network, "account_objects", params),
        "account_objects",
      );
    },
  },
  {
    name: "ledger.account.tx",
    family: "ledger",
    summary: "Read validated XRPL transactions involving an account, with range filters and pagination.",
    tags: ["account", "transactions", "history", "pagination", "xrpl"],
    // https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/account-methods/account_tx
    args: z
      .object({
        network: NetworkSchema,
        account: AccountSchema,
        tx_type: z.string().trim().min(1).max(64).optional(),
        mpt_issuance_id: z
          .string()
          .regex(/^[A-Fa-f0-9]{48}$/, "Expected a 192-bit hexadecimal ID")
          .optional(),
        ledger_index_min: z.number().int().min(-1).optional(),
        ledger_index_max: z.number().int().min(-1).optional(),
        binary: z.boolean().optional(),
        forward: z.boolean().optional(),
        limit: z.number().int().positive().max(1000).optional(),
        marker: MarkerSchema.optional(),
        delegate: z
          .object({
            delegate_filter: z.enum(["actor", "authorizer"]),
            counter_party: AccountSchema.optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    returns: "the raw account_tx result with transactions always present",
    caveats: [],
    example:
      "await harbor.ledger.account.tx({ network: 'testnet', account: 'r...', limit: 20 })",
    handler: async (ctx, args) => {
      const { network, params } = splitNetwork(args);
      return ensureRows(
        await requestXrpl(ctx, network, "account_tx", params),
        "transactions",
      );
    },
  },
  {
    name: "ledger.fee",
    family: "ledger",
    summary: "Read current XRPL open-ledger transaction fee and queue metrics.",
    tags: ["fee", "transaction-cost", "queue", "xrpl"],
    // https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/server-info-methods/fee
    args: z.object({ network: NetworkSchema }).strict(),
    returns: "the raw fee result in drops and fee levels",
    caveats: [],
    example: "await harbor.ledger.fee({ network: 'testnet' })",
    handler: async (ctx, args) => {
      const { network } = splitNetwork(args);
      return requestXrpl(ctx, network, "fee");
    },
  },
];
