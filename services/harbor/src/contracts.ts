import { z } from "zod";

// Shared contracts must stay dependency-free beyond zod so this source can be
// byte-synced into @pilot/contracts. This bounded Ripple base58 shape keeps
// model-facing watchdog fields free of arbitrary text; operation boundaries
// perform the checksum-valid classic-address authorization.
const ClassicAddressSchema = z
  .string()
  .min(25)
  .max(35)
  .regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/);

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
  "screened-redacted",
]);
export type Caveat = z.infer<typeof CaveatSchema>;

/**
 * Fixed presentation-safe labels for screened fields. These values describe
 * field categories only; concrete paths, property names and field values must
 * never be copied into trust metadata.
 */
export const BlockedFieldKindSchema = z.enum([
  "amendment-name",
  "asset-class",
  "credential-type",
  "ledger-data",
  "did-document",
  "domain",
  "memo-data",
  "memo-type",
  "mptoken-metadata",
  "provider",
  "uri",
  "purchase-data",
  "document-title",
  "document-snippet",
  "document-source",
  "document-url",
  "mastercard-content",
  "market-coin",
  "margin-mode",
  "token-name",
  "token-description",
  "token-domain",
  "token-icon",
  "merchant-response",
]);
export type BlockedFieldKind = z.infer<typeof BlockedFieldKindSchema>;

export const BLOCKED_FIELD_KIND_LIMIT = BlockedFieldKindSchema.options.length;

export const TrustScreenSchema = z
  .object({
    provider: z.enum([
      "aws-bedrock-guardrails",
      "mock",
      "off",
      "unavailable",
    ]),
    fields_checked: z.number().int().nonnegative(),
    fields_blocked: z.number().int().nonnegative(),
    max_score: z.number().optional(),
    blocked_field_kinds: z
      .array(BlockedFieldKindSchema)
      .min(1)
      .max(BLOCKED_FIELD_KIND_LIMIT)
      .refine((kinds) => new Set(kinds).size === kinds.length, {
        message: "blocked field kinds must be unique",
      })
      .optional(),
  })
  .strict()
  .superRefine((screen, context) => {
    if (
      screen.fields_blocked === 0 &&
      screen.blocked_field_kinds !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["blocked_field_kinds"],
        message: "blocked field kinds require at least one blocked field",
      });
    }
  });
export type TrustScreen = z.infer<typeof TrustScreenSchema>;

export const RpcRouteSchema = z.enum([
  "quicknode",
  "quicknode-mock",
  "fallback",
]);
export type RpcRoute = z.infer<typeof RpcRouteSchema>;

export const ConfirmationSchema = z
  .object({
    provider: z.enum(["quicknode-webhook", "quicknode-mock", "poll"]),
    at: z.string(),
    latency_ms: z.number().int().nonnegative(),
  })
  .strict();
export type Confirmation = z.infer<typeof ConfirmationSchema>;

export const OkSchema = <TSchema extends z.ZodTypeAny>(data: TSchema) =>
  z
    .object({
      ok: z.literal(true),
      data,
      asOf: z.string(),
      asOfBasis: z.string(),
      caveat: z.array(CaveatSchema).optional(),
      trust: z
        .object({
          screen: TrustScreenSchema.optional(),
          rpc: z
            .object({
              route: RpcRouteSchema,
              methods_quicknode: z.number().int().nonnegative(),
              methods_fallback: z.number().int().nonnegative(),
            })
            .strict()
            .optional(),
        })
        .strict()
        .optional(),
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

export const ExecutionContractSchema = z.enum([
  "xrpl_execution_v1",
  "xrpl_execution_v2",
]);
export type ExecutionContract = z.infer<typeof ExecutionContractSchema>;

export const ExecutionCapabilitySchema = z
  .object({
    execution_contract: z.literal("xrpl_execution_v2"),
    build_revision: z.number().int().positive(),
    unsigned_tx_digest: z.string().regex(/^[A-F0-9]{64}$/),
    unsigned_tx_digest_alg: z.literal("sha256-jcs-v1"),
    economic_fingerprint: z.string().regex(/^[A-F0-9]{64}$/),
    economic_fingerprint_alg: z.literal("sha256-jcs-economic-v1"),
    build_ledger: z.number().int().positive(),
    first_inclusion_ledger: z.number().int().positive(),
    last_ledger_sequence: z.number().int().positive(),
    minimum_remaining_ledgers: z.literal(8),
    approval_expires_in_seconds: z.literal(90),
    quote_ledger: z.number().int().positive().optional(),
    quote_valid_through_ledger: z.number().int().positive().optional(),
    acquisition_balance_invariant: z
      .object({
        kind: z.literal("issued_balance_unchanged"),
        currency: z.string(),
        issuer: z.string(),
        balance: z.string(),
        ledger_index: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((capability, ctx) => {
    if (capability.first_inclusion_ledger !== capability.build_ledger + 1) {
      ctx.addIssue({ code: "custom", path: ["first_inclusion_ledger"], message: "must equal build_ledger + 1" });
    }
    if (capability.last_ledger_sequence !== capability.build_ledger + 64) {
      ctx.addIssue({ code: "custom", path: ["last_ledger_sequence"], message: "must equal build_ledger + 64" });
    }
    const hasQuote = capability.quote_ledger !== undefined;
    const hasQuoteThrough = capability.quote_valid_through_ledger !== undefined;
    if (hasQuote !== hasQuoteThrough) {
      ctx.addIssue({ code: "custom", path: ["quote_ledger"], message: "quote ledger fields must be present or absent together" });
    } else if (
      capability.quote_ledger !== undefined &&
      (capability.quote_valid_through_ledger !== capability.quote_ledger + 1 ||
        capability.build_ledger < capability.quote_ledger ||
        capability.build_ledger > capability.quote_ledger + 1)
    ) {
      ctx.addIssue({ code: "custom", path: ["quote_valid_through_ledger"], message: "quote must be valid through quote_ledger + 1 at build time" });
    }
    const invariantLedger = capability.acquisition_balance_invariant?.ledger_index;
    if (
      invariantLedger !== undefined &&
      (invariantLedger > capability.build_ledger ||
        capability.build_ledger - invariantLedger > 1)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["acquisition_balance_invariant", "ledger_index"],
        message: "must equal build_ledger or build_ledger - 1",
      });
    }
  });
export type ExecutionCapability = z.infer<typeof ExecutionCapabilitySchema>;

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
    execution_capability: ExecutionCapabilitySchema.optional(),
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
    ap4m_enabled: z.boolean(),
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
  ap4m_enabled: false,
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

export const SignerSchema = z
  .object({
    kind: z.enum(["aws-kms", "aws-kms-kek", "local"]),
    key_ref: z.string().startsWith("alias/").optional(),
  })
  .strict();
export type Signer = z.infer<typeof SignerSchema>;

export const ExecResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("executed"),
      hash: z.string(),
      ledger_index: z.number(),
      result: z.enum(["filled", "partial", "resting", "success"]),
      signed_by: z.literal("delegate"),
      signer: SignerSchema.optional(),
      confirmation: ConfirmationSchema.optional(),
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

// ---- AP4M / Mastercard additions ----
export const Ap4mAssetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("xrp") }).strict(),
  z
    .object({
      kind: z.literal("iou"),
      currency: z.string(),
      issuer: z.string(),
    })
    .strict(),
]);

export const MerchantSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    network: NetworkSchema,
    base_url: z.string().url(),
    xrpl_address: z.string(),
    src_dpa_id: z.string(),
    schemes: z.array(z.enum(["exact", "xrpl-paychan"])).min(1),
    settle_asset: Ap4mAssetSchema,
    required_credential: z
      .object({ issuer: z.string(), credential_type_hex: z.string() })
      .strict(),
    products: z
      .array(
        z
          .object({
            sku: z.string(),
            name: z.string(),
            description: z.string(),
            price: z
              .object({ asset: Ap4mAssetSchema, value: z.string() })
              .strict(),
            response_schema_id: z.string(),
          })
          .strict(),
      )
      .min(1),
    wba_required: z.boolean(),
  })
  .strict();
export type Merchant = z.infer<typeof MerchantSchema>;

export const MandateConstraintsSchema = z
  .object({
    currency: z.literal("USD"),
    per_payment_max: z.string(),
    total_max: z.string(),
    daily_max: z.string(),
    payees: z.array(z.string()).min(1),
    skus: z.array(z.string()).optional(),
  })
  .strict();

export const MandateSchema = z
  .object({
    id: z.string(),
    owner: z.string(),
    network: NetworkSchema,
    status: z.enum(["PENDING", "ACTIVE", "REVOKED", "EXPIRED"]),
    execution_type: z.literal("DEFERRED"),
    not_before: z.string(),
    expires_at: z.string(),
    constraints: MandateConstraintsSchema,
    agent_public_jwk: z.record(z.string(), z.unknown()),
    l1_digest: z.string(),
    l2_digest: z.string(),
    setup_batch_hash: z.string().optional(),
    channels: z.array(
      z
        .object({
          merchant_id: z.string(),
          channel_id: z.string(),
          amount_drops: z.string(),
        })
        .strict(),
    ),
    spent_usd: z.string(),
  })
  .strict();
export type Mandate = z.infer<typeof MandateSchema>;

export const McIntentSchema = z
  .object({
    intentId: z.string(),
    intentSummary: z.string(),
    intentStatus: z.enum(["ACTIVE", "REVOKED", "EXPIRED"]),
    orders: z
      .array(
        z
          .object({
            orderId: z.string(),
            orderExecutionType: z.enum(["IMMEDIATE", "DEFERRED"]),
            orderExpiry: z.number().int(),
            orderTotalAmount: z
              .object({ amount: z.string(), currency: z.string() })
              .strict(),
            items: z
              .array(
                z
                  .object({
                    itemId: z.string(),
                    itemName: z.string(),
                    itemUnitPrice: z
                      .object({ amount: z.string(), currency: z.string() })
                      .strict(),
                    itemQuantity: z.number().int().positive(),
                    itemDeliveryMethod: z.literal("DIGITAL"),
                  })
                  .strict(),
              )
              .min(1),
            merchants: z
              .array(
                z
                  .object({
                    srcDpaId: z.string(),
                    merchantName: z.string(),
                    merchantUrl: z.string().url().optional(),
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type McIntent = z.infer<typeof McIntentSchema>;

const Ap4mEvidenceDigestSchema = z.string().regex(/^[A-F0-9]{64}$/);

const Ap4mL1EvidenceArtifactSchema = z.object({
    kind: z.literal("l1"),
    digest: Ap4mEvidenceDigestSchema,
    digest_basis: z.literal("sha256-utf8/vi-l1-presentation"),
  }).strict();
const Ap4mL2EvidenceArtifactSchema = z.object({
    kind: z.literal("l2"),
    digest: Ap4mEvidenceDigestSchema,
    digest_basis: z.literal("sha256-utf8/vi-l2-merchant-presentation"),
  }).strict();
const Ap4mL3aEvidenceArtifactSchema = z.object({
    kind: z.literal("l3a"),
    digest: Ap4mEvidenceDigestSchema,
    digest_basis: z.literal("sha256-utf8/vi-l3a-presentation"),
  }).strict();
const Ap4mL3bEvidenceArtifactSchema = z.object({
    kind: z.literal("l3b"),
    digest: Ap4mEvidenceDigestSchema,
    digest_basis: z.literal("sha256-utf8/vi-l3b-presentation"),
  }).strict();
const Ap4mPaymentEvidenceArtifactSchema = z.object({
    kind: z.literal("payment"),
    digest: Ap4mEvidenceDigestSchema,
    digest_basis: z.literal("xrpl/signed-transaction-hash"),
  }).strict();

export const Ap4mPublicEvidenceArtifactSchema = z.discriminatedUnion("kind", [
  Ap4mL1EvidenceArtifactSchema,
  Ap4mL2EvidenceArtifactSchema,
  Ap4mL3aEvidenceArtifactSchema,
  Ap4mL3bEvidenceArtifactSchema,
  Ap4mPaymentEvidenceArtifactSchema,
]);
export type Ap4mPublicEvidenceArtifact = z.infer<
  typeof Ap4mPublicEvidenceArtifactSchema
>;

/**
 * Bounded public references for one finalized exact-rail AP4M purchase.
 * Raw VI presentations, disclosures, signed blobs and credentials are never
 * part of this contract. Pay-channel purchases do not emit this bundle.
 */
export const Ap4mPublicEvidenceSchema = z.object({
  version: z.literal("ap4m-public-evidence-v1"),
  provenance: z.literal("live-testnet"),
  network: z.literal("testnet"),
  rail: z.literal("exact"),
  intent: McIntentSchema,
  artifacts: z.tuple([
    Ap4mL1EvidenceArtifactSchema,
    Ap4mL2EvidenceArtifactSchema,
    Ap4mL3aEvidenceArtifactSchema,
    Ap4mL3bEvidenceArtifactSchema,
    Ap4mPaymentEvidenceArtifactSchema,
  ]),
}).strict();
export type Ap4mPublicEvidence = z.infer<typeof Ap4mPublicEvidenceSchema>;

export const XrplPaymentProofSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("xrpl_exact"),
      tx_blob: z.string(),
      credential_ids: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      type: z.literal("xrpl_paychan_claim"),
      channel_id: z.string(),
      cumulative_drops: z.string(),
      signature: z.string(),
      public_key: z.string(),
    })
    .strict(),
]);

export const IntentValidationSchema = z
  .object({
    intentId: z.string(),
    validated: z.boolean(),
    checks: z
      .object({
        agent_identity: z.enum(["pass", "fail", "skipped"]),
        intent: z.enum(["pass", "fail"]),
        payment: z.enum(["pass", "fail"]),
        credential: z.enum(["pass", "fail"]),
      })
      .strict(),
    validation_errors: z.array(z.string()),
  })
  .strict();

export const Ap4mReceiptSchema = z
  .object({
    receipt_id: z.string(),
    mandate_id: z.string(),
    merchant_id: z.string(),
    sku: z.string(),
    intent_id: z.string(),
    l3a_digest: z.string(),
    l3b_digest: z.string(),
    scheme: z.enum(["exact", "xrpl-paychan"]),
    amount: z
      .object({ asset: Ap4mAssetSchema, value: z.string() })
      .strict(),
    proof: z
      .object({
        tx_hash: z.string().optional(),
        channel_id: z.string().optional(),
        cumulative_drops: z.string().optional(),
      })
      .strict(),
    merchant_validation: IntentValidationSchema,
    settlement: z.enum([
      "validated",
      "claim_accepted",
      "redeemed",
      "settlement_unknown",
    ]),
    at: z.string(),
  })
  .strict();
export type Ap4mReceipt = z.infer<typeof Ap4mReceiptSchema>;

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
  "ap4m_purchase",
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
  IntentBaseSchema.extend({
    kind: z.literal("ap4m_purchase"),
    merchant_id: z.string(),
    sku: z.string(),
    mandate_id: z.string(),
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

export const NearAiPrivacyDisclosureSchema = z
  .object({
    tier: z.enum([
      "confidential-tee",
      "third-party-confidential-tee",
      "incognito",
    ]),
    declaredBy: z.literal("operator-configuration"),
    // This receipt schema intentionally cannot claim runtime attestation.
    attestationVerified: z.literal(false),
    summary: z.string().min(1).max(500),
  })
  .strict();
export type NearAiPrivacyDisclosure = z.infer<typeof NearAiPrivacyDisclosureSchema>;

export const TrustModelSchema = z.union([
  z
    .object({
      provider: z.enum(["bedrock", "bedrock-mock", "openrouter"]),
      id: z.string(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("near-ai"),
      id: z.string(),
      privacy: NearAiPrivacyDisclosureSchema,
    })
    .strict(),
]);
export type TrustModel = z.infer<typeof TrustModelSchema>;

export const CardTrustSchema = z
  .object({
    model: TrustModelSchema.optional(),
    screen: TrustScreenSchema.optional(),
    signer: SignerSchema.optional(),
    rpc: RpcRouteSchema.optional(),
    confirmation: ConfirmationSchema.optional(),
    watch: z
      .object({
        provider: z.enum([
          "quicknode-streams",
          "quicknode-mock",
          "off",
        ]),
        status: z.enum(["watching", "frozen"]),
      })
      .strict()
      .optional(),
  })
  .strict();
export type CardTrust = z.infer<typeof CardTrustSchema>;

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
    trust: CardTrustSchema.optional(),
  })
  .strict();
export type CardEvent = z.infer<typeof CardEventSchema>;

export const WatchdogEventSchema = z
  .object({
    tx_hash: z
      .string()
      .regex(/^[A-Fa-f0-9]{64}$/)
      .transform((value) => value.toUpperCase()),
    account: ClassicAddressSchema,
    delegate: ClassicAddressSchema.optional(),
    class: z.enum([
      "harbor",
      "owner",
      "out_of_band_delegate",
      "out_of_band_payer",
    ]),
    flags: z
      .array(
        z.enum([
          "frozen_account",
          "tx_type_not_delegated",
          "issuer_not_allowlisted",
        ]),
      )
      .max(3)
      .refine((flags) => new Set(flags).size === flags.length),
    ledger_index: z.number().int().nonnegative(),
    close_time: z.string().max(35).refine(
      (value) =>
        /^\d{1,12}$/.test(value) ||
        z.string().datetime().safeParse(value).success,
      "close_time must be a bounded ledger time",
    ),
    action: z.enum(["none", "frozen", "alerted"]),
    next_step: z.literal("owner_revoke_onledger").optional(),
  })
  .strict()
  .superRefine((event, issue) => {
    const needsOwnerRevoke =
      event.class === "out_of_band_delegate" ||
      event.class === "out_of_band_payer";
    if (needsOwnerRevoke !== (event.next_step === "owner_revoke_onledger")) {
      issue.addIssue({
        code: "custom",
        path: ["next_step"],
        message:
          "next_step is required exactly for out-of-band watchdog events",
      });
    }
  });
export type WatchdogEvent = z.infer<typeof WatchdogEventSchema>;

// ---- Deterministic autonomous rebalancer ---------------------------------
// These contracts intentionally contain no discretionary/model inputs. An
// activated strategy is bound to one Testnet account, XRP, and one exact
// issued currency/issuer pair by an immutable, owner-approved mandate digest.

const StrategyIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const StrategyDigestSchema = z
  .string()
  .regex(/^[A-Fa-f0-9]{64}$/)
  .transform((value) => value.toUpperCase());
const CanonicalUnsignedDecimalSchema = z
  .string()
  .max(64)
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,15})?$/)
  .refine((value) => Number(value) > 0, "must be greater than zero");
const CanonicalNonnegativeDecimalSchema = z
  .string()
  .max(64)
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,15})?$/);
const CanonicalDropsSchema = z
  .string()
  .max(32)
  .regex(/^(?:0|[1-9]\d*)$/)
  .refine((value) => BigInt(value) > 0n, "must be greater than zero");
const CanonicalNonnegativeDropsSchema = z
  .string()
  .max(32)
  .regex(/^(?:0|[1-9]\d*)$/);
const IsoDateTimeSchema = z.string().datetime({ offset: true });

function compareCanonicalDecimals(left: string, right: string): number {
  const [leftWhole, leftFraction = ""] = left.split(".");
  const [rightWhole, rightFraction = ""] = right.split(".");
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const leftValue = BigInt(`${leftWhole}${leftFraction.padEnd(scale, "0")}`);
  const rightValue = BigInt(`${rightWhole}${rightFraction.padEnd(scale, "0")}`);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

export const StrategyLifecycleSchema = z.enum([
  "draft",
  "paused",
  "active",
  "stopped",
  "error",
]);
export type StrategyLifecycle = z.infer<typeof StrategyLifecycleSchema>;

export const StrategyMandateStatusSchema = z.enum([
  "draft",
  "approved",
  "revoked",
  "expired",
]);
export type StrategyMandateStatus = z.infer<
  typeof StrategyMandateStatusSchema
>;

export const StrategyIssuedAssetSchema = z
  .object({
    currency: z
      .string()
      .min(3)
      .max(40)
      .regex(/^(?:[A-Z0-9]{3}|[A-F0-9]{40})$/),
    issuer: ClassicAddressSchema,
  })
  .strict();
export type StrategyIssuedAsset = z.infer<typeof StrategyIssuedAssetSchema>;

export const TESTNET_RLUSD_CURRENCY =
  "524C555344000000000000000000000000000000" as const;
export const TESTNET_RLUSD_ISSUER =
  "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" as const;
export const DECLARATIVE_STRATEGY_SEMANTICS_VERSION =
  "harbor.declarative-strategy/1" as const;

/** The first declarative engine deliberately supports one reviewed market. */
export const DeclarativeStrategyIssuedAssetSchema = z
  .object({
    currency: z.literal(TESTNET_RLUSD_CURRENCY),
    issuer: z.literal(TESTNET_RLUSD_ISSUER),
  })
  .strict();
export type DeclarativeStrategyIssuedAsset = z.infer<
  typeof DeclarativeStrategyIssuedAssetSchema
>;

export const StrategyAllocationSchema = z
  .object({
    target_xrp_bps: z.number().int().min(1).max(9_999),
    lower_xrp_bps: z.number().int().min(0).max(9_998),
    upper_xrp_bps: z.number().int().min(2).max(10_000),
  })
  .strict()
  .superRefine((allocation, context) => {
    if (
      allocation.lower_xrp_bps >= allocation.target_xrp_bps ||
      allocation.target_xrp_bps >= allocation.upper_xrp_bps
    ) {
      context.addIssue({
        code: "custom",
        path: ["target_xrp_bps"],
        message: "target must be strictly inside the allocation band",
      });
    }
  });
export type StrategyAllocation = z.infer<typeof StrategyAllocationSchema>;

export const StrategyLimitsSchema = z
  .object({
    max_order_value: CanonicalUnsignedDecimalSchema,
    max_daily_value: CanonicalUnsignedDecimalSchema,
    min_order_value: CanonicalUnsignedDecimalSchema,
    max_fee_drops: CanonicalDropsSchema,
    max_slippage_bps: z.number().int().min(1).max(1_000),
    max_price_impact_bps: z.number().int().min(1).max(1_000),
    min_xrp_reserve_drops: CanonicalDropsSchema,
    fee_buffer_drops: CanonicalDropsSchema,
    max_xrp_exposure_drops: CanonicalDropsSchema,
    max_issued_exposure: CanonicalUnsignedDecimalSchema,
    min_liquidity_value: CanonicalUnsignedDecimalSchema,
    cooldown_seconds: z.number().int().min(60).max(86_400),
    max_quote_age_seconds: z.number().int().min(1).max(300),
    max_ledger_gap: z.number().int().min(0).max(4),
  })
  .strict()
  .superRefine((limits, context) => {
    if (
      compareCanonicalDecimals(
        limits.min_order_value,
        limits.max_order_value,
      ) > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["min_order_value"],
        message: "minimum order value cannot exceed maximum order value",
      });
    }
    if (
      compareCanonicalDecimals(
        limits.max_order_value,
        limits.max_daily_value,
      ) > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["max_order_value"],
        message: "maximum order value cannot exceed daily value",
      });
    }
  });
export type StrategyLimits = z.infer<typeof StrategyLimitsSchema>;

// Keep this shape explicit instead of extending StrategyLimitsSchema. The
// latter is refined (ZodEffects in Pilot's pinned Zod 3), and refined-object
// extension is not byte-compatible across the two pinned Zod majors.
export const DeclarativeStrategyLimitsSchema = z.object({
  max_order_value: CanonicalUnsignedDecimalSchema,
  max_daily_value: CanonicalUnsignedDecimalSchema,
  min_order_value: CanonicalUnsignedDecimalSchema,
  max_fee_drops: CanonicalDropsSchema,
  max_slippage_bps: z.number().int().min(1).max(1_000),
  max_price_impact_bps: z.number().int().min(1).max(1_000),
  min_xrp_reserve_drops: CanonicalDropsSchema,
  fee_buffer_drops: CanonicalDropsSchema,
  max_xrp_exposure_drops: CanonicalDropsSchema,
  max_issued_exposure: CanonicalUnsignedDecimalSchema,
  min_liquidity_value: CanonicalUnsignedDecimalSchema,
  cooldown_seconds: z.number().int().min(60).max(86_400),
  max_quote_age_seconds: z.number().int().min(1).max(300),
  max_ledger_gap: z.number().int().min(0).max(4),
  max_cumulative_value: CanonicalUnsignedDecimalSchema,
  max_daily_fee_drops: CanonicalDropsSchema,
  max_cumulative_fee_drops: CanonicalDropsSchema,
  max_daily_trades: z.number().int().min(1).max(1_000),
  max_total_trades: z.number().int().min(1).max(100_000),
  /**
   * Optional for byte-compatible parsing of already-approved v1 mandates.
   * New finite recurring mandates bind this executed-action count explicitly.
   */
  max_mandate_occurrences: z.number().int().min(1).max(100_000).optional(),
  cumulative_scope: z.literal("owner_network_asset_lifetime"),
})
  .strict()
  .superRefine((limits, context) => {
    if (
      compareCanonicalDecimals(
        limits.max_daily_value,
        limits.max_cumulative_value,
      ) > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["max_daily_value"],
        message: "daily value cannot exceed cumulative value",
      });
    }
    if (BigInt(limits.max_fee_drops) > BigInt(limits.max_daily_fee_drops)) {
      context.addIssue({
        code: "custom",
        path: ["max_fee_drops"],
        message: "per-order fee cannot exceed daily fee budget",
      });
    }
    if (
      BigInt(limits.max_daily_fee_drops) >
      BigInt(limits.max_cumulative_fee_drops)
    ) {
      context.addIssue({
        code: "custom",
        path: ["max_daily_fee_drops"],
        message: "daily fee budget cannot exceed cumulative fee budget",
      });
    }
    if (limits.max_daily_trades > limits.max_total_trades) {
      context.addIssue({
        code: "custom",
        path: ["max_daily_trades"],
        message: "daily trade count cannot exceed total trade count",
      });
    }
    if (
      limits.max_mandate_occurrences !== undefined &&
      limits.max_daily_trades > limits.max_mandate_occurrences
    ) {
      context.addIssue({
        code: "custom",
        path: ["max_daily_trades"],
        message: "daily trade count cannot exceed mandate occurrences",
      });
    }
    if (
      limits.max_mandate_occurrences !== undefined &&
      limits.max_mandate_occurrences > limits.max_total_trades
    ) {
      context.addIssue({
        code: "custom",
        path: ["max_mandate_occurrences"],
        message: "mandate occurrences cannot exceed total trade count",
      });
    }
  });
export type DeclarativeStrategyLimits = z.infer<
  typeof DeclarativeStrategyLimitsSchema
>;

export const StrategyScheduleSchema = z
  .object({
    interval_seconds: z.number().int().min(300).max(86_400),
    next_evaluation_at: IsoDateTimeSchema,
  })
  .strict();
export type StrategySchedule = z.infer<typeof StrategyScheduleSchema>;

export const DeclarativeStrategyTriggerSchema = z
  .object({
    kind: z.literal("interval"),
    interval_seconds: z.number().int().min(300).max(86_400),
  })
  .strict();
export type DeclarativeStrategyTrigger = z.infer<
  typeof DeclarativeStrategyTriggerSchema
>;

export const DeclarativeStrategyConditionSchema = z.union([
  z.object({ kind: z.literal("always") }).strict(),
  z
    .object({
      kind: z.literal("price_threshold"),
      side: z.enum(["bid", "ask"]),
      comparator: z.enum(["lte", "gte"]),
      /** test-RLUSD per XRP, from the named executable book side. */
      price: CanonicalUnsignedDecimalSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("xrp_allocation_outside"),
      lower_xrp_bps: z.number().int().min(0).max(9_998),
      upper_xrp_bps: z.number().int().min(2).max(10_000),
    })
    .strict()
    .superRefine((condition, context) => {
      if (condition.lower_xrp_bps >= condition.upper_xrp_bps) {
        context.addIssue({
          code: "custom",
          path: ["lower_xrp_bps"],
          message: "lower allocation bound must be below upper bound",
        });
      }
    }),
]);
export type DeclarativeStrategyCondition = z.infer<
  typeof DeclarativeStrategyConditionSchema
>;

export const DeclarativeStrategyActionSchema = z.union([
  z
    .object({
      kind: z.literal("fixed_swap"),
      direction: z.enum(["buy_xrp", "sell_xrp"]),
      /** Maximum order value in test-RLUSD units. */
      order_value: CanonicalUnsignedDecimalSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("target_allocation"),
      target_xrp_bps: z.number().int().min(1).max(9_999),
      lower_xrp_bps: z.number().int().min(0).max(9_998),
      upper_xrp_bps: z.number().int().min(2).max(10_000),
    })
    .strict()
    .superRefine((action, context) => {
      if (
        action.lower_xrp_bps >= action.target_xrp_bps ||
        action.target_xrp_bps >= action.upper_xrp_bps
      ) {
        context.addIssue({
          code: "custom",
          path: ["target_xrp_bps"],
          message: "target must be strictly inside the allocation band",
        });
      }
    }),
]);
export type DeclarativeStrategyAction = z.infer<
  typeof DeclarativeStrategyActionSchema
>;

export const DeclarativeStrategyRuleSchema = z
  .object({
    rule_id: StrategyIdSchema,
    all: z.array(DeclarativeStrategyConditionSchema).min(1).max(8),
    action: DeclarativeStrategyActionSchema,
  })
  .strict()
  .superRefine((rule, context) => {
    const always = rule.all.filter((condition) => condition.kind === "always");
    if (always.length > 0 && rule.all.length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["all"],
        message: "always must be the only condition in a rule",
      });
    }
  });
export type DeclarativeStrategyRule = z.infer<
  typeof DeclarativeStrategyRuleSchema
>;

export const DeclarativeStrategyPlanSchema = z
  .object({
    plan_version: z.literal("1"),
    trigger: DeclarativeStrategyTriggerSchema,
    rules: z.array(DeclarativeStrategyRuleSchema).min(1).max(8),
    fallback: z.object({ kind: z.literal("hold") }).strict(),
  })
  .strict()
  .superRefine((plan, context) => {
    const seen = new Set<string>();
    for (let index = 0; index < plan.rules.length; index += 1) {
      const id = plan.rules[index]!.rule_id;
      if (seen.has(id)) {
        context.addIssue({
          code: "custom",
          path: ["rules", index, "rule_id"],
          message: "rule_id must be unique within the plan",
        });
      }
      seen.add(id);
    }
  });
export type DeclarativeStrategyPlan = z.infer<
  typeof DeclarativeStrategyPlanSchema
>;

export const StrategyOwnerAuthorizationSchema = z
  .object({
    authorization_id: StrategyIdSchema,
    method: z.literal("wallet_action_proof_v1"),
    owner: ClassicAddressSchema,
    mandate_digest: StrategyDigestSchema,
    mandate_version: z.number().int().positive(),
    approved_at: IsoDateTimeSchema,
    expires_at: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((authorization, context) => {
    if (
      Date.parse(authorization.expires_at) <= Date.parse(authorization.approved_at)
    ) {
      context.addIssue({
        code: "custom",
        path: ["expires_at"],
        message: "authorization must expire after approval",
      });
    }
  });
export type StrategyOwnerAuthorization = z.infer<
  typeof StrategyOwnerAuthorizationSchema
>;

export const LegacyStrategyMandateSchema = z
  .object({
    mandate_id: StrategyIdSchema,
    strategy_id: StrategyIdSchema,
    version: z.number().int().positive(),
    digest: StrategyDigestSchema,
    status: StrategyMandateStatusSchema,
    kind: z.literal("xrp_issued_rebalancer_v1"),
    network: z.literal("testnet"),
    account: ClassicAddressSchema,
    issued_asset: StrategyIssuedAssetSchema,
    allocation: StrategyAllocationSchema,
    limits: StrategyLimitsSchema,
    schedule: StrategyScheduleSchema,
    execution_mode: z.literal("offer_create_fok"),
    not_before: IsoDateTimeSchema,
    expires_at: IsoDateTimeSchema,
    authorization: StrategyOwnerAuthorizationSchema.optional(),
  })
  .strict()
  .superRefine((mandate, context) => {
    if (Date.parse(mandate.expires_at) <= Date.parse(mandate.not_before)) {
      context.addIssue({
        code: "custom",
        path: ["expires_at"],
        message: "mandate must expire after not_before",
      });
    }
    const authorization = mandate.authorization;
    if (mandate.status === "approved" && authorization === undefined) {
      context.addIssue({
        code: "custom",
        path: ["authorization"],
        message: "approved mandates require owner authorization",
      });
    }
    if (
      authorization !== undefined &&
      (authorization.owner !== mandate.account ||
        authorization.mandate_digest !== mandate.digest ||
        authorization.mandate_version !== mandate.version ||
        Date.parse(authorization.expires_at) > Date.parse(mandate.expires_at))
    ) {
      context.addIssue({
        code: "custom",
        path: ["authorization"],
        message: "authorization must bind this mandate and its expiry",
      });
    }
  });
export type LegacyStrategyMandate = z.infer<
  typeof LegacyStrategyMandateSchema
>;

export const DeclarativeStrategyProposalSchema = z
  .object({
    semantics_version: z.literal(DECLARATIVE_STRATEGY_SEMANTICS_VERSION),
    kind: z.literal("declarative_strategy_v1"),
    network: z.literal("testnet"),
    account: ClassicAddressSchema,
    issued_asset: DeclarativeStrategyIssuedAssetSchema,
    plan: DeclarativeStrategyPlanSchema,
    limits: DeclarativeStrategyLimitsSchema,
    execution_mode: z.literal("offer_create_fok"),
    not_before: IsoDateTimeSchema,
    expires_at: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((proposal, context) => {
    if (Date.parse(proposal.expires_at) <= Date.parse(proposal.not_before)) {
      context.addIssue({
        code: "custom",
        path: ["expires_at"],
        message: "authority window must end after it begins",
      });
    }
  });
export type DeclarativeStrategyProposal = z.infer<
  typeof DeclarativeStrategyProposalSchema
>;

export const DeclarativeStrategyMandateSchema = z
  .object({
    mandate_id: StrategyIdSchema,
    strategy_id: StrategyIdSchema,
    version: z.number().int().positive(),
    digest: StrategyDigestSchema,
    status: StrategyMandateStatusSchema,
    semantics_version: z.literal(DECLARATIVE_STRATEGY_SEMANTICS_VERSION),
    kind: z.literal("declarative_strategy_v1"),
    network: z.literal("testnet"),
    account: ClassicAddressSchema,
    issued_asset: DeclarativeStrategyIssuedAssetSchema,
    plan: DeclarativeStrategyPlanSchema,
    limits: DeclarativeStrategyLimitsSchema,
    schedule: StrategyScheduleSchema,
    execution_mode: z.literal("offer_create_fok"),
    not_before: IsoDateTimeSchema,
    expires_at: IsoDateTimeSchema,
    authorization: StrategyOwnerAuthorizationSchema.optional(),
  })
  .strict()
  .superRefine((mandate, context) => {
    if (Date.parse(mandate.expires_at) <= Date.parse(mandate.not_before)) {
      context.addIssue({
        code: "custom",
        path: ["expires_at"],
        message: "authority window must end after it begins",
      });
    }
    if (
      mandate.schedule.interval_seconds !==
      mandate.plan.trigger.interval_seconds
    ) {
      context.addIssue({
        code: "custom",
        path: ["schedule", "interval_seconds"],
        message: "persisted schedule must match the approved plan trigger",
      });
    }
    const authorization = mandate.authorization;
    if (mandate.status === "approved" && authorization === undefined) {
      context.addIssue({
        code: "custom",
        path: ["authorization"],
        message: "approved mandates require owner authorization",
      });
    }
    if (
      authorization !== undefined &&
      (authorization.owner !== mandate.account ||
        authorization.mandate_digest !== mandate.digest ||
        authorization.mandate_version !== mandate.version ||
        Date.parse(authorization.expires_at) > Date.parse(mandate.expires_at))
    ) {
      context.addIssue({
        code: "custom",
        path: ["authorization"],
        message: "authorization must bind this mandate and its expiry",
      });
    }
  });
export type DeclarativeStrategyMandate = z.infer<
  typeof DeclarativeStrategyMandateSchema
>;

export const StrategyMandateSchema = z.union([
  LegacyStrategyMandateSchema,
  DeclarativeStrategyMandateSchema,
]);
export type AnyStrategyMandate = z.infer<typeof StrategyMandateSchema>;
/** Compatibility alias for the original rebalancer's dedicated interpreter. */
export type StrategyMandate = LegacyStrategyMandate;

export const StrategySchema = z
  .object({
    strategy_id: StrategyIdSchema,
    lifecycle: StrategyLifecycleSchema,
    mandate: StrategyMandateSchema,
    generation: z.number().int().nonnegative(),
    next_evaluation_at: IsoDateTimeSchema.optional(),
    last_evaluation_at: IsoDateTimeSchema.optional(),
    last_trade_at: IsoDateTimeSchema.optional(),
    hold_reason: z.string().min(1).max(240).optional(),
    error_code: z.string().min(1).max(80).optional(),
    created_at: IsoDateTimeSchema,
    updated_at: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((strategy, context) => {
    if (strategy.strategy_id !== strategy.mandate.strategy_id) {
      context.addIssue({
        code: "custom",
        path: ["mandate", "strategy_id"],
        message: "mandate must belong to strategy",
      });
    }
    if (strategy.lifecycle === "active" && strategy.mandate.status !== "approved") {
      context.addIssue({
        code: "custom",
        path: ["lifecycle"],
        message: "active strategies require an approved mandate",
      });
    }
    if (strategy.lifecycle === "active" && strategy.next_evaluation_at === undefined) {
      context.addIssue({
        code: "custom",
        path: ["next_evaluation_at"],
        message: "active strategies require a persisted next evaluation",
      });
    }
  });
export type Strategy = z.infer<typeof StrategySchema>;

export const StrategyHoldCodeSchema = z.enum([
  "inside_band",
  "cooldown",
  "below_minimum_trade",
  "global_kill",
  "strategy_not_active",
  "mandate_not_current",
  "mandate_expired",
  "grant_not_active",
  "policy_paused",
  "stale_price",
  "missing_price",
  "contradictory_price",
  "insufficient_liquidity",
  "fee_limit",
  "reserve_limit",
  "exposure_limit",
  "order_limit",
  "daily_limit",
  "cumulative_limit",
  "fee_budget_limit",
  "trade_count_limit",
  "no_rule_matched",
  "condition_not_met",
  "simulation_failed",
  "service_unavailable",
  "pending_reconciliation",
  "lease_lost",
]);
export type StrategyHoldCode = z.infer<typeof StrategyHoldCodeSchema>;

export const StrategyDecisionSchema = z
  .object({
    decision_id: StrategyIdSchema,
    trigger_id: StrategyIdSchema,
    strategy_id: StrategyIdSchema,
    mandate_digest: StrategyDigestSchema,
    mandate_version: z.number().int().positive(),
    action: z.enum(["hold", "buy_xrp", "sell_xrp"]),
    hold_codes: z.array(StrategyHoldCodeSchema).max(24),
    xrp_allocation_bps: z.number().int().min(0).max(10_000).optional(),
    proposed_value: CanonicalUnsignedDecimalSchema.optional(),
    semantics_version: z
      .literal(DECLARATIVE_STRATEGY_SEMANTICS_VERSION)
      .optional(),
    plan_digest: StrategyDigestSchema.optional(),
    matched_rule_id: StrategyIdSchema.optional(),
    quote_ledger_index: z.number().int().positive().optional(),
    quote_observed_at: IsoDateTimeSchema.optional(),
    explanation: z.string().min(1).max(1_000),
    created_at: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.action === "hold" && decision.hold_codes.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["hold_codes"],
        message: "holds require at least one reason",
      });
    }
    if (decision.action !== "hold" && decision.hold_codes.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["hold_codes"],
        message: "trade decisions cannot also be holds",
      });
    }
    if (decision.action !== "hold" && decision.proposed_value === undefined) {
      context.addIssue({
        code: "custom",
        path: ["proposed_value"],
        message: "trade decisions require a proposed value",
      });
    }
    if (
      (decision.semantics_version === undefined) !==
      (decision.plan_digest === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["plan_digest"],
        message:
          "declarative decisions require both semantics_version and plan_digest",
      });
    }
    if (
      decision.matched_rule_id !== undefined &&
      decision.semantics_version === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["matched_rule_id"],
        message: "matched_rule_id is only valid for declarative decisions",
      });
    }
  });
export type StrategyDecision = z.infer<typeof StrategyDecisionSchema>;

export const StrategyTickStatusSchema = z.enum([
  "held",
  "planned",
  "needs_approval",
  "executed",
  "pending_reconciliation",
  "failed",
]);
export type StrategyTickStatus = z.infer<typeof StrategyTickStatusSchema>;

export const StrategyTickResultSchema = z
  .object({
    trigger_id: StrategyIdSchema,
    strategy_id: StrategyIdSchema,
    status: StrategyTickStatusSchema,
    decision: StrategyDecisionSchema,
    build_id: StrategyIdSchema.optional(),
    execution_id: StrategyIdSchema.optional(),
    transaction_hash: z.string().regex(/^[A-Fa-f0-9]{64}$/).optional(),
    next_evaluation_at: IsoDateTimeSchema.optional(),
  })
  .strict();
export type StrategyTickResult = z.infer<typeof StrategyTickResultSchema>;

export const StrategyAuditEventSchema = z
  .object({
    event_id: StrategyIdSchema,
    strategy_id: StrategyIdSchema.optional(),
    trigger_id: StrategyIdSchema.optional(),
    decision_id: StrategyIdSchema.optional(),
    execution_id: StrategyIdSchema.optional(),
    actor: z.enum(["owner", "scheduler", "runner", "reconciler", "system"]),
    kind: z.enum([
      "created",
      "mandate_approved",
      "activated",
      "paused",
      "resumed",
      "stopped",
      "kill_enabled",
      "kill_disabled",
      "tick_started",
      "held",
      "planned",
      "budget_reserved",
      "submitted",
      "submission_unknown",
      "reconciled",
      "executed",
      "needs_approval",
      "failed",
    ]),
    detail: z.record(z.string(), z.unknown()),
    at: IsoDateTimeSchema,
  })
  .strict();
export type StrategyAuditEvent = z.infer<typeof StrategyAuditEventSchema>;

export const LegacyStrategyCreateArgsSchema = z
  .object({
    kind: z.literal("xrp_issued_rebalancer_v1"),
    network: z.literal("testnet"),
    account: ClassicAddressSchema,
    issued_asset: StrategyIssuedAssetSchema,
    allocation: StrategyAllocationSchema,
    limits: StrategyLimitsSchema,
    interval_seconds: z.number().int().min(300).max(86_400),
    execution_mode: z.literal("offer_create_fok"),
    not_before: IsoDateTimeSchema,
    expires_at: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (Date.parse(request.expires_at) <= Date.parse(request.not_before)) {
      context.addIssue({
        code: "custom",
        path: ["expires_at"],
        message: "mandate must expire after not_before",
      });
    }
  });
export type LegacyStrategyCreateArgs = z.infer<
  typeof LegacyStrategyCreateArgsSchema
>;

export const DeclarativeStrategyCreateArgsSchema =
  DeclarativeStrategyProposalSchema;
export type DeclarativeStrategyCreateArgs = z.infer<
  typeof DeclarativeStrategyCreateArgsSchema
>;

export const StrategyCreateArgsSchema = z.union([
  LegacyStrategyCreateArgsSchema,
  DeclarativeStrategyCreateArgsSchema,
]);
export type StrategyCreateArgs = z.infer<typeof StrategyCreateArgsSchema>;

export const StrategyPlanDiagnosticSchema = z
  .object({
    code: z.enum([
      "invalid_shape",
      "unsupported_asset",
      "unsupported_condition",
      "unsupported_action",
      "ambiguous_conditions",
      "contradictory_conditions",
      "unreachable_rule",
      "order_exceeds_limit",
      "numeric_overflow",
    ]),
    path: z.string().min(1).max(240),
    message: z.string().min(1).max(500),
  })
  .strict();
export type StrategyPlanDiagnostic = z.infer<
  typeof StrategyPlanDiagnosticSchema
>;

export const StrategyPlanCapabilitiesSchema = z
  .object({
    network: z.literal("testnet"),
    assets: z.tuple([
      z.object({ currency: z.literal("XRP") }).strict(),
      DeclarativeStrategyIssuedAssetSchema,
    ]),
    trigger_kinds: z.tuple([z.literal("interval")]),
    condition_kinds: z.tuple([
      z.literal("always"),
      z.literal("price_threshold"),
      z.literal("xrp_allocation_outside"),
    ]),
    action_kinds: z.tuple([
      z.literal("fixed_swap"),
      z.literal("target_allocation"),
    ]),
    execution_mode: z.literal("offer_create_fok"),
    max_rules: z.literal(8),
    max_conditions_per_rule: z.literal(8),
    max_actions_per_evaluation: z.literal(1),
  })
  .strict();
export type StrategyPlanCapabilities = z.infer<
  typeof StrategyPlanCapabilitiesSchema
>;

export const StrategyPlanValidationResultSchema = z
  .object({
    valid: z.boolean(),
    semantics_version: z.literal(DECLARATIVE_STRATEGY_SEMANTICS_VERSION),
    capabilities: StrategyPlanCapabilitiesSchema,
    errors: z.array(StrategyPlanDiagnosticSchema).max(64),
    plan_digest: StrategyDigestSchema.optional(),
    normalized_proposal: DeclarativeStrategyProposalSchema.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.valid !==
      (result.errors.length === 0 &&
        result.plan_digest !== undefined &&
        result.normalized_proposal !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["valid"],
        message: "valid must agree with diagnostics, digest, and normalization",
      });
    }
  });
export type StrategyPlanValidationResult = z.infer<
  typeof StrategyPlanValidationResultSchema
>;

export const StrategyValidateArgsSchema = DeclarativeStrategyProposalSchema;
export type StrategyValidateArgs = z.infer<typeof StrategyValidateArgsSchema>;

export const StrategyPlanObservationSchema = z
  .object({
    account: ClassicAddressSchema,
    network: z.literal("testnet"),
    issued_asset: DeclarativeStrategyIssuedAssetSchema,
    xrp_balance_drops: CanonicalNonnegativeDropsSchema,
    issued_balance: CanonicalNonnegativeDecimalSchema,
    /** Executable test-RLUSD per XRP book sides at quote_ledger_index. */
    bid: CanonicalUnsignedDecimalSchema,
    ask: CanonicalUnsignedDecimalSchema,
    executable_liquidity_value: CanonicalNonnegativeDecimalSchema,
    fee_drops: CanonicalDropsSchema,
    reserve_base_drops: CanonicalNonnegativeDropsSchema,
    reserve_increment_drops: CanonicalNonnegativeDropsSchema,
    owner_count: z.number().int().min(0).max(1_000_000),
    daily_value_used: CanonicalNonnegativeDecimalSchema,
    cumulative_value_used: CanonicalNonnegativeDecimalSchema,
    daily_fee_drops_used: CanonicalNonnegativeDropsSchema,
    cumulative_fee_drops_used: CanonicalNonnegativeDropsSchema,
    daily_trades_used: z.number().int().nonnegative().max(1_000_000),
    total_trades_used: z.number().int().nonnegative().max(100_000_000),
    ledger_index: z.number().int().positive(),
    quote_ledger_index: z.number().int().positive(),
    observed_at: IsoDateTimeSchema,
    last_trade_at: IsoDateTimeSchema.optional(),
    global_kill: z.boolean(),
    unresolved_execution: z.boolean(),
    grant_active: z.boolean(),
    policy_active: z.boolean(),
  })
  .strict();
export type StrategyPlanObservation = z.infer<
  typeof StrategyPlanObservationSchema
>;

export const StrategySimulateArgsSchema = z
  .object({
    proposal: DeclarativeStrategyProposalSchema,
    observation: StrategyPlanObservationSchema,
    at: IsoDateTimeSchema,
  })
  .strict();
export type StrategySimulateArgs = z.infer<typeof StrategySimulateArgsSchema>;

export const StrategyPlanPreviewSchema = z
  .object({
    boundary: z.literal("paper_only"),
    ledger_acceptance: z.literal("not_tested"),
    semantics_version: z.literal(DECLARATIVE_STRATEGY_SEMANTICS_VERSION),
    plan_digest: StrategyDigestSchema,
    outcome: z.enum(["hold", "order"]),
    action: z.enum(["hold", "buy_xrp", "sell_xrp"]),
    matched_rule_id: StrategyIdSchema.optional(),
    proposed_value: CanonicalUnsignedDecimalSchema.optional(),
    price_basis: z.enum(["bid", "ask"]).optional(),
    price_value: CanonicalUnsignedDecimalSchema.optional(),
    hold_codes: z.array(StrategyHoldCodeSchema).max(24),
    explanation: z.string().min(1).max(1_000),
    evaluated_at: IsoDateTimeSchema,
    observed_at: IsoDateTimeSchema,
    quote_ledger_index: z.number().int().positive(),
  })
  .strict()
  .superRefine((preview, context) => {
    if (
      preview.outcome === "order" &&
      (preview.action === "hold" ||
        preview.proposed_value === undefined ||
        preview.matched_rule_id === undefined ||
        preview.price_basis === undefined ||
        preview.price_value === undefined ||
        preview.hold_codes.length !== 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "order previews require one bounded matched action and price",
      });
    }
    if (
      preview.outcome === "hold" &&
      (preview.action !== "hold" || preview.hold_codes.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["hold_codes"],
        message: "hold previews require a hold action and reason",
      });
    }
  });
export type StrategyPlanPreview = z.infer<typeof StrategyPlanPreviewSchema>;

export const StrategyAuthorizeArgsSchema = z
  .object({
    strategy_id: StrategyIdSchema,
    mandate_version: z.number().int().positive(),
    mandate_digest: StrategyDigestSchema,
    authorization: StrategyOwnerAuthorizationSchema,
  })
  .strict();
export type StrategyAuthorizeArgs = z.infer<typeof StrategyAuthorizeArgsSchema>;

export const StrategyIdArgsSchema = z
  .object({ strategy_id: StrategyIdSchema })
  .strict();
export type StrategyIdArgs = z.infer<typeof StrategyIdArgsSchema>;

export const StrategyListArgsSchema = z
  .object({
    owner: ClassicAddressSchema.optional(),
    network: z.literal("testnet").optional(),
  })
  .strict();
export type StrategyListArgs = z.infer<typeof StrategyListArgsSchema>;

export const StrategyTickArgsSchema = z
  .object({
    strategy_id: StrategyIdSchema,
    trigger_id: StrategyIdSchema,
    scheduled_for: IsoDateTimeSchema,
  })
  .strict();
export type StrategyTickArgs = z.infer<typeof StrategyTickArgsSchema>;

export const StrategyKillSwitchArgsSchema = z
  .object({
    enabled: z.boolean(),
    reason: z.string().min(1).max(240),
  })
  .strict();
export type StrategyKillSwitchArgs = z.infer<
  typeof StrategyKillSwitchArgsSchema
>;

export const StrategyKillSwitchSchema = z
  .object({
    enabled: z.boolean(),
    reason: z.string().min(1).max(240).optional(),
    updated_at: IsoDateTimeSchema,
  })
  .strict();
export type StrategyKillSwitch = z.infer<typeof StrategyKillSwitchSchema>;
