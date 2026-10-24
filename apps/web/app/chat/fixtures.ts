import type {
  CardEvent,
  CardState,
  CardTrust,
  Intent,
  PolicyResult,
  TxBuild,
} from "@pilot/contracts";
import {
  GuardrailNoticeSchema,
  type GuardrailNotice,
} from "@pilot/agent/guardrail-notice";

export const demoIntent = {
  id: "intent-demo-swap",
  network: "testnet",
  kind: "swap",
  sell: { currency: "RLUSD", issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" },
  buy: { currency: "XRP" },
  amount: "80",
  side: "sell",
  max_slippage_bps: 100,
} satisfies Intent;

const fixtureAccount = "rPT7vGmYxnV6wNP9RC2Mm3Fp9NBH3bK";

export const demoAwsTrust = {
  screen: {
    provider: "mock",
    fields_checked: 3,
    fields_blocked: 1,
    max_score: 0.95,
  },
  model: {
    provider: "bedrock-mock",
    id: "anthropic.claude-sonnet-4-5-v1:0",
  },
  signer: {
    kind: "aws-kms-kek",
    key_ref: "alias/harbor/kek",
  },
  rpc: "quicknode-mock",
  confirmation: {
    provider: "quicknode-mock",
    at: "2026-10-18T00:00:04.200Z",
    latency_ms: 4_200,
  },
  watch: {
    provider: "quicknode-mock",
    status: "watching",
  },
} satisfies CardTrust;

/** Bounded UI projection for the logged-out watchdog demo. */
export const demoQuickNodeFreezeNotice = {
  tx_hash: "B".repeat(64),
  ledger_index: 9_843_207,
  network: "testnet",
} as const;

export function fixtureQuickNodeFreezeNotice(prompt: string) {
  return /quicknode streams|agent(?:'s)? key|outside harbor|freeze/i.test(prompt)
    ? demoQuickNodeFreezeNotice
    : undefined;
}

/** Canonical, bounded notice for the dedicated logged-out injection demo. */
export const demoGuardrailNotice = GuardrailNoticeSchema.parse({
  provider: "mock",
  caveat: "screened-redacted",
  fields_checked: 3,
  fields_blocked: 1,
  blocked_field_kinds: ["token-description"],
});

export function fixtureGuardrailNotice(
  prompt: string,
): GuardrailNotice | undefined {
  return prompt.toLowerCase().includes("injection")
    ? demoGuardrailNotice
    : undefined;
}

function fixtureBuild(intent: Intent): TxBuild {
  const isVault = intent.kind === "vault_deposit";
  const amount = "amount" in intent ? intent.amount : "80";
  return {
    build_id: `build_fixture_${intent.id}`,
    network: intent.network,
    tx_json: isVault
      ? { TransactionType: "VaultDeposit", Account: fixtureAccount, VaultID: intent.vault_id, Amount: amount }
      : { TransactionType: "OfferCreate", Account: fixtureAccount },
    delegable: !isVault,
    simulate: {
      engine_result: "tesSUCCESS",
      engine_result_message: "The simulated transaction would succeed.",
      applied: false,
    },
    preflight: [
      { check: "reserve", pass: true, detail: "Reserve remains above minimum" },
      { check: isVault ? "vault" : "trustline", pass: true, detail: isVault ? "Vault accepts XRP deposits" : "RLUSD trust line is active" },
    ],
    summary: {
      action: isVault ? "Deposit XRP into the vault" : "Swap RLUSD for XRP",
      account: fixtureAccount,
      amounts: isVault ? [`${amount} XRP`] : [`${amount} RLUSD`, `≈ ${(Number(amount) * 1.9277).toFixed(2)} XRP`],
      fee_drops: "12",
      reserve_delta_drops: "0",
      ...(isVault ? {} : { est_slippage_bps: 18 }),
      usd_value: isVault ? "100.00" : amount,
    },
  };
}
const clearPolicy: PolicyResult = {
  verdict: "execute",
  reasons: [
    { rule: "max_per_tx_usd", pass: true, detail: "$80.00 is within the $2,000 limit" },
    { rule: "daily_cap_usd", pass: true, detail: "$4,179.52 remains today" },
    { rule: "issuer_allowlist", pass: true, detail: "RLUSD issuer is allowlisted" },
  ],
};

export const cardStates: CardState[] = [
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
];

export function fixtureEvent(state: CardState, intent: Intent = demoIntent): CardEvent {
  const build = fixtureBuild(intent);
  const base: CardEvent = {
    intent_id: intent.id,
    state,
    at: "2026-10-18T00:00:00.000Z",
    intent,
  };

  if (["simulated", "policy_checked", "executing", "awaiting_approval", "submitted", "validated", "failed"].includes(state)) {
    base.build = build;
  }
  if (state === "policy_checked" || state === "executing") base.policy = clearPolicy;
  if (state === "awaiting_approval") {
    base.policy = { ...clearPolicy, verdict: "needs_approval", reasons: [{ rule: "execute_under_usd", pass: false, detail: "Owner approval required above $250" }] };
    base.exec = {
      status: "needs_approval",
      approval_id: "approval_demo_42",
      tx_json: build.tx_json,
      expires_at: "2099-01-01T00:00:00.000Z",
      policy: base.policy,
    };
  }
  if (state === "blocked") {
    base.policy = {
      verdict: "block",
      reasons: [
        { rule: "issuer_allowlist", pass: false, detail: "FREEMONEY issuer is not approved" },
        { rule: "max_per_tx_usd", pass: false, detail: "$5,000 exceeds the $2,000 transaction limit" },
      ],
    };
    base.exec = { status: "blocked", policy: base.policy };
  }
  if (state === "submitted") base.hash = "A19F480BF22457EC706F0CFDFF3D8069B5A2A3C45BA14FA1B80C2";
  if (state === "validated") {
    base.hash = "A19F480BF22457EC706F0CFDFF3D8069B5A2A3C45BA14FA1B80C2";
    base.exec = {
      status: "executed",
      hash: base.hash,
      ledger_index: 9_843_206,
      result: "filled",
      signed_by: "delegate",
    };
  }
  if (state === "failed") {
    base.error = "The offer crossed after its last valid ledger. Review current liquidity before trying again.";
    base.exec = { status: "failed", engine_result: "tefMAX_LEDGER", detail: base.error };
  }
  return base;
}

export const allCardStateEvents = cardStates.map((state, index) => ({
  ...fixtureEvent(state),
  intent_id: `${demoIntent.id}-${index}`,
  intent: { ...demoIntent, id: `${demoIntent.id}-${index}` },
}));

export function fixtureSequence(prompt: string): CardEvent[] {
  const normalized = prompt.toLowerCase();
  if (normalized.includes("freemoney") || normalized.includes("block")) {
    const blockedIntent: Intent = { ...demoIntent, id: "intent-fixture-blocked", sell: { currency: "FREEMONEY", issuer: "rUnknownFixtureIssuer" } };
    return ["drafting", "planned", "simulated", "policy_checked", "blocked"].map((state) => fixtureEvent(state as CardState, blockedIntent));
  }
  if (normalized.includes("vault")) {
    const vaultIntent: Intent = { id: "intent-fixture-vault", network: "testnet", kind: "vault_deposit", vault_id: "A4E7D8C9B2F10635A4E7D8C9B2F10635A4E7D8C9B2F10635A4E7D8C9B2F10635", asset: { currency: "XRP" }, amount: "100" };
    return ["drafting", "planned", "simulated", "policy_checked", "awaiting_approval"].map((state) => fixtureEvent(state as CardState, vaultIntent));
  }
  if (normalized.includes("5,000") || normalized.includes("5000")) {
    const overMaximumIntent: Intent = { ...demoIntent, id: "intent-fixture-over-maximum", amount: "5000" };
    return ["drafting", "planned", "simulated", "policy_checked", "blocked"].map((state) => fixtureEvent(state as CardState, overMaximumIntent));
  }
  if (normalized.includes("500") || normalized.includes("approval")) {
    const approvalIntent: Intent = { ...demoIntent, id: "intent-fixture-over-threshold", amount: "500" };
    return ["drafting", "planned", "simulated", "policy_checked", "awaiting_approval"].map((state) => fixtureEvent(state as CardState, approvalIntent));
  }
  if (normalized.includes("fail")) {
    return ["drafting", "planned", "simulated", "policy_checked", "executing", "failed"].map((state) => fixtureEvent(state as CardState));
  }
  return ["drafting", "planned", "simulated", "policy_checked", "executing", "submitted", "validated"].map((state) => {
    const event = fixtureEvent(state as CardState);
    if (event.state === "validated") event.trust = demoAwsTrust;
    return event;
  });
}
