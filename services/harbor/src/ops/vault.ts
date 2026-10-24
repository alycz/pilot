import { isValidClassicAddress } from "xrpl";
import { z } from "zod";

import { requestXrpl } from "../adapters/xrpl-rpc";
import type { OpContext, OpDef } from "../catalog/registry";

const DevVaultNetworkSchema = z.enum(["devnet", "lending-devnet"]);
export type DevVaultNetwork = z.infer<typeof DevVaultNetworkSchema>;

const ClassicAddressSchema = z
  .string()
  .refine(isValidClassicAddress, "must be a valid XRPL classic address");
const Hash256Schema = z
  .string()
  .regex(/^[A-Fa-f0-9]{64}$/, "must be a 64-character hexadecimal hash");
const MptIssuanceIdSchema = z
  .string()
  .regex(/^[A-Fa-f0-9]{48}$/, "must be a 48-character hexadecimal MPT issuance ID");
const HexSchema = z.string().regex(/^(?:[A-Fa-f0-9]{2})*$/, "must be hexadecimal");
const UnsignedIntegerStringSchema = z.string().regex(/^\d+$/);
const DecimalStringSchema = z
  .string()
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/);
const CurrencyCodeSchema = z
  .string()
  .refine(
    (currency) =>
      currency === "XRP" ||
      /^[A-Za-z0-9?!@#$%^&*<>(){}\[\]|]{3}$/.test(currency) ||
      /^[A-Fa-f0-9]{40}$/.test(currency),
    "must be XRP, a 3-character currency code, or 40 hexadecimal characters",
  );

const VaultAssetSchema = z.union([
  z.object({ currency: z.literal("XRP") }).strict(),
  z
    .object({
      currency: CurrencyCodeSchema.refine((currency) => currency !== "XRP"),
      issuer: ClassicAddressSchema,
    })
    .strict(),
  z.object({ mpt_issuance_id: MptIssuanceIdSchema }).strict(),
]);

const VaultSharesSchema = z
  .object({
    AssetScale: z.number().int().min(0).max(18).optional(),
    DomainID: Hash256Schema.optional(),
    Flags: z.number().int().nonnegative(),
    Issuer: ClassicAddressSchema,
    LedgerEntryType: z.literal("MPTokenIssuance"),
    LockedAmount: UnsignedIntegerStringSchema.optional(),
    MaximumAmount: UnsignedIntegerStringSchema.optional(),
    MPTokenMetadata: HexSchema.optional(),
    OutstandingAmount: UnsignedIntegerStringSchema,
    OwnerNode: z.string(),
    PreviousTxnID: Hash256Schema,
    PreviousTxnLgrSeq: z.number().int().nonnegative(),
    ReferenceHolding: Hash256Schema.optional(),
    Sequence: z.number().int().nonnegative(),
    TransferFee: z.number().int().min(0).max(50_000).optional(),
    index: Hash256Schema,
    mpt_issuance_id: MptIssuanceIdSchema.optional(),
  })
  .strict();

const VaultDescriptionSchema = z
  .object({
    Account: ClassicAddressSchema,
    Asset: VaultAssetSchema,
    AssetsAvailable: DecimalStringSchema.optional(),
    AssetsMaximum: DecimalStringSchema.optional(),
    AssetsTotal: DecimalStringSchema.optional(),
    Data: HexSchema.optional(),
    Flags: z.number().int().nonnegative(),
    LedgerEntryType: z.literal("Vault"),
    LEVersion: z.number().int().nonnegative().optional(),
    LossUnrealized: DecimalStringSchema.optional(),
    Owner: ClassicAddressSchema,
    OwnerNode: z.string(),
    PreviousTxnID: Hash256Schema,
    PreviousTxnLgrSeq: z.number().int().nonnegative(),
    RedemptionDate: z.number().int().nonnegative().optional(),
    Scale: z.number().int().min(0).max(18).optional(),
    Sequence: z.number().int().nonnegative(),
    ShareMPTID: MptIssuanceIdSchema,
    SubscriptionDate: z.number().int().nonnegative().optional(),
    VaultKind: z.number().int().min(0).max(1).optional(),
    WithdrawalPolicy: z.number().int().nonnegative(),
    index: Hash256Schema,
    shares: VaultSharesSchema,
  })
  .strict();

const VaultInfoRpcResultSchema = z
  .object({
    ledger_current_index: z.number().int().nonnegative().optional(),
    ledger_hash: Hash256Schema.optional(),
    ledger_index: z.number().int().nonnegative().optional(),
    validated: z.boolean().optional(),
    vault: VaultDescriptionSchema,
  })
  .strict();

const VaultSelectorSchema = z
  .object({
    network: DevVaultNetworkSchema,
    owner: ClassicAddressSchema.optional(),
    seq: z.number().int().nonnegative().optional(),
    vault_id: Hash256Schema.optional(),
  })
  .strict()
  .superRefine(({ owner, seq, vault_id }, issueContext) => {
    const byId = vault_id !== undefined;
    const byOwnerAndSequence = owner !== undefined && seq !== undefined;
    if (byId === byOwnerAndSequence) {
      issueContext.addIssue({
        code: "custom",
        message: "provide vault_id, or both owner and seq",
      });
    }
    if (vault_id !== undefined && (owner !== undefined || seq !== undefined)) {
      issueContext.addIssue({
        code: "custom",
        message: "vault_id cannot be combined with owner or seq",
      });
    }
    if (!vault_id && ((owner === undefined) !== (seq === undefined))) {
      issueContext.addIssue({
        code: "custom",
        message: "owner and seq must be provided together",
      });
    }
  });

export type VaultInfo = z.infer<typeof VaultInfoRpcResultSchema> & {
  network: DevVaultNetwork;
  risks: string[];
};

export const VAULT_RISKS = Object.freeze([
  "Single Asset Vaults are amendment-gated and this read is limited to Devnet or Lending-Devnet test assets.",
  "Vault shares are not a fixed-interest promise; share value can fall when the vault records losses.",
  "Verify the vault owner, asset, access controls, lifecycle dates, and withdrawal policy before depositing; a public vault is not an endorsement.",
]);

/**
 * Read a vault through the merged XRPL adapter. Tests inject ctx.xrplRpc; the
 * production path uses the configured Devnet endpoint. `vault_info` supports
 * either vault_id or owner+seq selectors:
 * https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/vault-methods/vault_info
 */
export async function readVaultInfo(
  ctx: OpContext,
  network: DevVaultNetwork,
  selector: { vault_id: string } | { owner: string; seq: number },
): Promise<VaultInfo> {
  const raw = await requestXrpl(ctx, network, "vault_info", selector);
  const parsed = VaultInfoRpcResultSchema.parse(raw);
  return {
    network,
    ...parsed,
    risks: [...VAULT_RISKS],
  };
}

export const ops: OpDef[] = [
  {
    name: "vault.info",
    family: "vault",
    summary:
      "Read current Single Asset Vault state on Devnet or Lending-Devnet.",
    tags: ["vault", "yield", "single-asset", "devnet", "lending"],
    args: VaultSelectorSchema,
    returns: "VaultInfo",
    caveats: ["devnet-only", "amendment-pending"],
    example:
      'await harbor.vault.info({ network: "devnet", vault_id: "9E48171960CD9F62C3A7B6559315A510AE544C3F51E02947B5D4DAC8AA66C3BA" })',
    handler: async (ctx, rawArgs) => {
      const { network, owner, seq, vault_id } = rawArgs as z.infer<
        typeof VaultSelectorSchema
      >;
      const selector =
        vault_id !== undefined
          ? { vault_id }
          : { owner: owner as string, seq: seq as number };
      return readVaultInfo(ctx, network, selector);
    },
  },
];
