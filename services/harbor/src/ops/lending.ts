import { isValidClassicAddress } from "xrpl";
import { z } from "zod";

import { requestXrpl } from "../adapters/xrpl-rpc";
import type { OpDef } from "../catalog/registry";

const HASH_256 = /^[A-Fa-f0-9]{64}$/;
const UNSIGNED_INTEGER = /^(?:0|[1-9][0-9]*)$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

const Hash256Schema = z.string().regex(HASH_256);
const ClassicAddressSchema = z
  .string()
  .refine(isValidClassicAddress, "must be a valid XRPL classic address");
const UInt64Schema = z.union([
  z.number().int().nonnegative(),
  z.string().regex(UNSIGNED_INTEGER),
]);
const MarkerSchema = z.string().min(1).max(256);

const LendingBrokersArgsSchema = z
  .object({
    network: z.literal("lending-devnet"),
    limit: z.number().int().min(1).max(256).optional(),
    marker: MarkerSchema.optional(),
  })
  .strict();

const LoanBrokerSchema = z
  .object({
    LedgerEntryType: z.literal("LoanBroker"),
    index: Hash256Schema,
    Flags: z.number().int().nonnegative(),
    Account: ClassicAddressSchema,
    CoverAvailable: z.string().regex(DECIMAL).optional(),
    CoverRateMinimum: z.number().int().min(0).max(100_000).optional(),
    CoverRateLiquidation: z.number().int().min(0).max(100_000).optional(),
    Data: z.string().regex(/^(?:[A-Fa-f0-9]{2}){0,256}$/).optional(),
    DebtMaximum: z.string().regex(DECIMAL),
    DebtTotal: z.string().regex(DECIMAL).optional(),
    LoanSequence: z.number().int().nonnegative(),
    ManagementFeeRate: z.number().int().min(0).max(10_000).optional(),
    Owner: ClassicAddressSchema,
    OwnerCount: z.number().int().nonnegative().optional(),
    OwnerNode: UInt64Schema,
    PreviousTxnID: Hash256Schema,
    PreviousTxnLgrSeq: z.number().int().nonnegative(),
    Sequence: z.number().int().nonnegative(),
    VaultNode: UInt64Schema,
    VaultID: Hash256Schema,
  })
  .strict();

const LendingBrokersResponseSchema = z
  .object({
    ledger: z.record(z.string(), z.unknown()).optional(),
    ledger_hash: Hash256Schema,
    ledger_index: z.number().int().nonnegative(),
    marker: MarkerSchema.optional(),
    state: z.array(LoanBrokerSchema),
    status: z.literal("success").optional(),
    validated: z.literal(true),
  })
  .strict();

// `ledger_data` can filter validated ledger state by canonical entry type and
// paginate the result. LoanBroker entries require LendingProtocol and
// LendingProtocolV1_1, so this discovery read is confined to Lending-Devnet.
// https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/ledger-methods/ledger_data
// https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/loanbroker
export const ops: OpDef[] = [
  {
    name: "lending.brokers",
    family: "lending",
    summary: "List validated XRPL Lending Protocol loan brokers on Lending-Devnet.",
    tags: ["lending", "loan-broker", "vault", "devnet"],
    args: LendingBrokersArgsSchema,
    returns: "a validated page of LoanBroker ledger entries and its pagination marker",
    caveats: ["devnet-only", "amendment-pending"],
    example:
      'await harbor.lending.brokers({ network: "lending-devnet", limit: 100 })',
    handler: async (ctx, rawArgs) => {
      const args = rawArgs as z.infer<typeof LendingBrokersArgsSchema>;
      const result = LendingBrokersResponseSchema.parse(
        await requestXrpl(ctx, args.network, "ledger_data", {
          ledger_index: "validated",
          type: "LoanBroker",
          ...(args.limit === undefined ? {} : { limit: args.limit }),
          ...(args.marker === undefined ? {} : { marker: args.marker }),
        }),
      );

      return {
        network: args.network,
        ledger_hash: result.ledger_hash,
        ledger_index: result.ledger_index,
        validated: result.validated,
        brokers: result.state,
        ...(result.marker === undefined ? {} : { marker: result.marker }),
      };
    },
  },
];
