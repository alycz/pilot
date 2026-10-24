import { z } from "zod";

export const NetworkSchema = z.enum([
  "mainnet",
  "testnet",
  "devnet",
  "lending-devnet",
]);
export type Network = z.infer<typeof NetworkSchema>;

export const CaveatSchema = z.enum([
  "no-rows",
  "unverified-match",
  "devnet-only",
  "off-ledger",
  "amendment-pending",
]);
export type Caveat = z.infer<typeof CaveatSchema>;

export const OkSchema = <TSchema extends z.ZodTypeAny>(data: TSchema) =>
  z
    .object({
      ok: z.literal(true),
      data,
      asOf: z.string(),
      asOfBasis: z.string(),
      caveat: z.array(CaveatSchema).optional(),
    })
    .strict();
export type Ok<T> = z.infer<
  ReturnType<typeof OkSchema<z.ZodType<T>>>
>;

export const ErrorDetailSchema = z
  .object({
    service: z.string(),
    kind: z.enum(["error", "soft-empty"]),
    message: z.string(),
    code: z.string().optional(),
    hint: z.string().optional(),
  })
  .strict();
export type ErrorDetail = z.infer<typeof ErrorDetailSchema>;

export const ErrSchema = z
  .object({
    ok: z.literal(false),
    error: ErrorDetailSchema,
  })
  .strict();
export type Err = z.infer<typeof ErrSchema>;

export const EnvelopeSchema = <TSchema extends z.ZodTypeAny>(data: TSchema) =>
  z.discriminatedUnion("ok", [OkSchema(data), ErrSchema]);
export type Envelope<T> = z.infer<
  ReturnType<typeof EnvelopeSchema<z.ZodType<T>>>
>;

const UnknownRecordSchema = z.record(z.string(), z.unknown());

export const TxBuildSchema = z
  .object({
    build_id: z.string(),
    network: NetworkSchema,
    tx_json: UnknownRecordSchema,
    delegable: z.boolean(),
    simulate: z
      .object({
        engine_result: z.string(),
        engine_result_message: z.string(),
        applied: z.literal(false),
      })
      .strict(),
    preflight: z.array(
      z
        .object({
          check: z.string(),
          pass: z.boolean(),
          detail: z.string().optional(),
        })
        .strict(),
    ),
    summary: z
      .object({
        action: z.string(),
        account: z.string(),
        amounts: z.array(z.string()),
        fee_drops: z.string(),
        reserve_delta_drops: z.string(),
        est_slippage_bps: z.number().optional(),
        usd_value: z.string().optional(),
      })
      .strict(),
  })
  .strict();
export type TxBuild = z.infer<typeof TxBuildSchema>;

export const PolicySchema = z
  .object({
    max_per_tx_usd: z.number(),
    daily_cap_usd: z.number(),
    execute_under_usd: z.number(),
    max_slippage_bps: z.number(),
    allowed_tx_types: z.array(z.string()),
    issuer_allowlist: z.array(z.string()),
    block_requireauth_issuers: z.boolean(),
    networks: z.array(NetworkSchema),
    x402_max_per_call_drops: z.string(),
    x402_daily_cap_drops: z.string(),
  })
  .strict();
export type Policy = z.infer<typeof PolicySchema>;

export const DEFAULT_POLICY: Policy = {
  max_per_tx_usd: 2000,
  daily_cap_usd: 5000,
  execute_under_usd: 250,
  max_slippage_bps: 100,
  allowed_tx_types: [
    "OfferCreate",
    "OfferCancel",
    "TrustSet",
    "AMMDeposit",
    "AMMWithdraw",
    "EscrowFinish",
    "CheckCash",
  ],
  issuer_allowlist: ["RLUSD"],
  block_requireauth_issuers: true,
  networks: ["testnet", "devnet"],
  x402_max_per_call_drops: "10000",
  x402_daily_cap_drops: "1000000",
};

export const PolicyResultSchema = z
  .object({
    verdict: z.enum(["execute", "needs_approval", "block"]),
    reasons: z.array(
      z
        .object({
          rule: z.string(),
          pass: z.boolean(),
          detail: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type PolicyResult = z.infer<typeof PolicyResultSchema>;

export const AccountLinkSchema = z
  .object({
    owner: z.string(),
    network: NetworkSchema,
    delegate: z.string(),
    permissions: z.array(z.string()).max(10),
    status: z.enum(["pending", "active", "suspended", "revoked"]),
    delegate_set_tx: UnknownRecordSchema.optional(),
    revoke_tx: UnknownRecordSchema.optional(),
  })
  .strict();
export type AccountLink = z.infer<typeof AccountLinkSchema>;

export const ExecResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("executed"),
      hash: z.string(),
      ledger_index: z.number(),
      result: z.enum(["filled", "partial", "resting", "success"]),
      signed_by: z.literal("delegate"),
    })
    .strict(),
  z
    .object({
      status: z.literal("needs_approval"),
      approval_id: z.string(),
      tx_json: UnknownRecordSchema,
      expires_at: z.string(),
      policy: PolicyResultSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("blocked"),
      policy: PolicyResultSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      engine_result: z.string(),
      detail: z.string(),
    })
    .strict(),
]);
export type ExecResult = z.infer<typeof ExecResultSchema>;

export const VenueSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(["execution-primitive", "discovery-venue"]),
    layer: z.enum(["xrpl-l1", "xrpl-evm", "off-ledger"]),
    category: z.array(
      z.enum([
        "spot",
        "liquidity",
        "payments",
        "yield",
        "lending",
        "perps",
        "bridge",
        "analytics",
      ]),
    ),
    status: z
      .object({
        mainnet: z
          .enum(["live", "voting", "devnet-only", "unavailable"])
          .optional(),
        testnet: z
          .enum(["live", "voting", "devnet-only", "unavailable"])
          .optional(),
        devnet: z
          .enum(["live", "voting", "devnet-only", "unavailable"])
          .optional(),
        "lending-devnet": z
          .enum(["live", "voting", "devnet-only", "unavailable"])
          .optional(),
      })
      .strict(),
    execution: z
      .object({
        transactions: z.array(z.string()),
        builders: z.array(z.string()),
      })
      .strict()
      .optional(),
    reads: z.array(z.string()),
    risks: z.array(z.string()),
    links: z
      .object({
        site: z.string().optional(),
        docs: z.string().optional(),
        api: z.string().optional(),
      })
      .strict(),
  })
  .strict();
export type Venue = z.infer<typeof VenueSchema>;

export const AssetSchema = z
  .object({
    currency: z.string(),
    issuer: z.string().optional(),
  })
  .strict();
export type Asset = z.infer<typeof AssetSchema>;

const IntentBaseSchema = z.object({
  id: z.string(),
  network: NetworkSchema,
});

export const IntentKindSchema = z.enum([
  "swap",
  "limit",
  "cancel",
  "lp_deposit",
  "lp_withdraw",
  "vault_deposit",
  "pay",
  "fund_budget",
  "x402_call",
]);
export type IntentKind = z.infer<typeof IntentKindSchema>;

export const IntentSchema = z.discriminatedUnion("kind", [
  IntentBaseSchema.extend({
    kind: z.literal("swap"),
    sell: AssetSchema,
    buy: AssetSchema,
    amount: z.string(),
    side: z.enum(["sell", "buy"]),
    max_slippage_bps: z.number(),
  }).strict(),
  IntentBaseSchema.extend({
    kind: z.literal("limit"),
    sell: AssetSchema,
    buy: AssetSchema,
    sell_amount: z.string(),
    buy_amount: z.string(),
    expires_at: z.string().optional(),
  }).strict(),
  IntentBaseSchema.extend({
    kind: z.literal("cancel"),
    offer_sequence: z.number(),
  }).strict(),
  IntentBaseSchema.extend({
    kind: z.literal("lp_deposit"),
    asset: AssetSchema,
    asset2: AssetSchema,
    amount: z.string(),
    amount2: z.string().optional(),
  }).strict(),
  IntentBaseSchema.extend({
    kind: z.literal("lp_withdraw"),
    asset: AssetSchema,
    asset2: AssetSchema,
    amount: z.string(),
    amount2: z.string().optional(),
  }).strict(),
  IntentBaseSchema.extend({
    kind: z.literal("vault_deposit"),
    vault_id: z.string(),
    amount: z.string(),
    asset: AssetSchema,
  }).strict(),
  IntentBaseSchema.extend({
    kind: z.literal("pay"),
    to: z.string(),
    asset: AssetSchema,
    amount: z.string(),
    memo: z.string().optional(),
  }).strict(),
  IntentBaseSchema.extend({
    kind: z.literal("fund_budget"),
    asset: AssetSchema,
    amount: z.string(),
  }).strict(),
  IntentBaseSchema.extend({
    kind: z.literal("x402_call"),
    url: z.string(),
    max_price_drops: z.string(),
  }).strict(),
]);
export type Intent = z.infer<typeof IntentSchema>;

export const ProfileSchema = z
  .object({
    main_account: z.string(),
    budget_account: z.string(),
    network: NetworkSchema,
    risk: z.enum(["low", "medium", "high"]),
    preferences: z.array(z.string()),
  })
  .strict();
export type Profile = z.infer<typeof ProfileSchema>;

// Pilot/Policy.md uses the Policy contract directly.
export const PolicyFrontmatterSchema = PolicySchema;
export type PolicyFrontmatter = z.infer<typeof PolicyFrontmatterSchema>;

export const TradeSchema = z
  .object({
    type: z.literal("trade"),
    intent_id: z.string(),
    kind: IntentKindSchema,
    network: NetworkSchema,
    hash: z.string(),
    venue: z.string(),
    assets: z.array(z.string()),
    result: z.enum(["filled", "partial", "resting", "success", "failed"]),
    fill_price: z.string(),
    slippage_bps: z.number(),
    signed_by: z.enum(["delegate", "owner"]),
    explorer: z.string(),
    created: z.string(),
  })
  .strict();
export type Trade = z.infer<typeof TradeSchema>;

export const CardStateSchema = z.enum([
  "drafting",
  "planned",
  "simulated",
  "policy_checked",
  "executing",
  "awaiting_approval",
  "blocked",
  "submitted",
  "validated",
  "failed",
]);
export type CardState = z.infer<typeof CardStateSchema>;

export const CardEventSchema = z
  .object({
    intent_id: z.string(),
    state: CardStateSchema,
    at: z.string(),
    intent: IntentSchema,
    build: TxBuildSchema.optional(),
    policy: PolicyResultSchema.optional(),
    exec: ExecResultSchema.optional(),
    hash: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();
export type CardEvent = z.infer<typeof CardEventSchema>;
