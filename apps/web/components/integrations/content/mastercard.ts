import type { IntegrationExplainer } from "../types";

export const mastercardIntegration = {
  slug: "mastercard",
  name: "Mastercard AP4M",
  eyebrow: "Bounded machine payments on XRPL Testnet",
  headline: "Authorize once. Let Pilot act only inside the mandate.",
  summary:
    "Pilot combines a human-approved Verifiable Intent mandate with Harbor policy, typed merchant validation, and XRPL Testnet payment proofs. The result is a mock-first demonstration of how an agent can buy allowlisted data without receiving open-ended payment authority.",
  status:
    "Mock-first implementation with offline, cross-language, and UI evidence. Mastercard Open Finance sandbox and live XRPL Testnet transaction checks remain event-day gates.",
  truthLabel:
    "Protocol demonstration · XRPL Testnet rails · no Mastercard-network money movement, certification, or partnership claim",
  what:
    "We use Mastercard Open Finance in mock or sandbox mode to establish a masked owner-and-balance signal, Mastercard and Google’s Verifiable Intent format to express the owner’s limits, and Mastercard’s Level 3 identity → intent → payment order to structure merchant checkout. Pilot adds an AP4M-Agent credential check before payment acceptance. Harbor supplies the XRPL rail and enforcement; Pilot supplies the agent and interface.",
  why:
    "Payments are easy to trigger; bounded authority is the hard part. A signed mandate gives Pilot a narrow envelope—known merchants and products, per-payment, daily and lifetime caps, and an expiry—while receipts make every decision and settlement proof inspectable.",
  accent: "coral",
  zones: [
    {
      id: "owner",
      label: "Owner browser",
      detail: "Human approval, wallet custody, and a non-extractable VI device key.",
    },
    {
      id: "pilot",
      label: "Workspace",
      detail: "Binds the active mandate and exposes only merchant and SKU to the model.",
    },
    {
      id: "harbor",
      label: "Harbor",
      detail: "Intersects Policy with the mandate, signs with Harbor-owned bounded keys, and stores receipts.",
    },
    {
      id: "merchant",
      label: "Demo merchant",
      detail: "Follows Mastercard’s identity → intent → payment order and adds Pilot’s credential check before accepting payment proof.",
    },
    {
      id: "ledger",
      label: "XRPL Testnet",
      detail: "Enforces credentials and records exact settlement or payment-channel redemption.",
    },
  ],
  nodes: [
    {
      id: "owner-approval",
      label: "Owner approval",
      shortLabel: "Approve",
      zone: "owner",
      detail:
        "The owner reviews payees, SKUs, caps, expiry, and locked channel amounts, then signs the exact setup once.",
    },
    {
      id: "pilot-request",
      label: "Bound request",
      shortLabel: "Pilot",
      zone: "pilot",
      detail:
        "Pilot binds owner, Testnet, mandate, and idempotency. The model can choose only an allowlisted merchant and SKU.",
    },
    {
      id: "two-gates",
      label: "Policy ∩ mandate",
      shortLabel: "2 gates",
      zone: "harbor",
      detail:
        "Base Policy must say execute and every mandate rule must pass. AP4M can narrow authority; it cannot broaden it.",
    },
    {
      id: "intent-identity",
      label: "Intent + identity",
      shortLabel: "L3 + WBA",
      zone: "harbor",
      detail:
        "Harbor creates a five-minute DEFERRED intent, L3a/L3b proofs, and a Web Bot Auth signature.",
    },
    {
      id: "merchant-validator",
      label: "Ordered validation",
      shortLabel: "Merchant",
      zone: "merchant",
      detail:
        "The merchant follows Mastercard’s identity → intent → payment order and adds Pilot’s AP4M-Agent credential check before accepting the XRPL payment proof.",
    },
    {
      id: "settlement-rail",
      label: "Selectable XRPL rail",
      shortLabel: "Pay",
      zone: "ledger",
      detail:
        "Exact uses one credential-bearing payment; pay channel uses a cumulative off-ledger claim redeemed later.",
    },
    {
      id: "ledger-evidence",
      label: "Settlement evidence",
      shortLabel: "Proof",
      zone: "ledger",
      detail:
        "Success requires validated, transaction-bound evidence; unknown settlement remains pending, never guessed.",
    },
    {
      id: "receipt-controls",
      label: "Receipt + controls",
      shortLabel: "Receipt",
      zone: "pilot",
      detail:
        "Pilot shows Mandate → Intent → L3 → Payment → Ledger and keeps revoke and watchdog state visible.",
    },
  ],
  scenarios: [
    {
      id: "purchase",
      label: "Bound purchase",
      tone: "success",
      summary:
        "One owner-approved mandate supports repeated exact payments or payment-channel claims, but only while both authorization gates pass.",
      steps: [
        {
          nodeId: "owner-approval",
          title: "Approve the envelope once",
          body:
            "The owner signs a VI L2 mandate and the exact XRPL setup: CredentialAccept plus one PaymentChannelCreate per selected merchant. Wallets without verified Batch support use the explicit sequential-signature plan before submission—not an automatic retry after an uncertain result.",
          input: "Payees, SKUs, limits, expiry, channel locks",
          output: "Signed setup bound to the L2 digest",
          status: "Owner controlled",
          crossesBoundary: "Owner browser → XRPL Testnet",
        },
        {
          nodeId: "pilot-request",
          title: "Bind the model’s narrow request",
          body:
            "The model supplies only merchant_id and sku. Pilot adds the active mandate, connected owner, Testnet network, and an idempotency key; it never exposes a URL, price, payment header, key, token, or raw merchant response to the model.",
          input: "Allowlisted merchant + SKU",
          output: "Server-bound purchase request",
          status: "No signing tool",
          crossesBoundary: "Pilot model boundary → Harbor REST",
        },
        {
          nodeId: "two-gates",
          title: "Intersect Policy and mandate",
          body:
            "Harbor requires its existing Policy to permit autonomous execution, then checks mandate status, time window, payee, SKU, per-payment cap, daily cap, lifetime cap, and ap4m_enabled.",
          input: "Policy, mandate, price, accumulated spend",
          output: "execute or named block reasons",
          status: "Fail closed",
        },
        {
          nodeId: "intent-identity",
          title: "Create short-lived authority proofs",
          body:
            "After both gates pass, Harbor creates a five-minute Mastercard-shaped DEFERRED intent plus L3a/L3b Verifiable Intent artifacts and signs the merchant request with Web Bot Auth.",
          input: "Bound checkout terms",
          output: "demo-intent-… + L3 + request signature",
          status: "Five-minute scope",
          crossesBoundary: "Harbor → demo merchant",
        },
        {
          nodeId: "merchant-validator",
          title: "Validate before serving",
          body:
            "The merchant follows Mastercard’s HTTP agent identity → Verifiable Intent → payment order. Pilot adds an AP4M-Agent credential check before accepting the XRPL payment proof. The merchant returns only schema-validated typed data plus intent_validation.",
          input: "Identity, intent, credential, payment proof",
          output: "Typed yield report or risk score",
          status: "Ordered validation",
        },
        {
          nodeId: "settlement-rail",
          title: "Choose exact or channel settlement",
          body:
            "An exact purchase uses Harbor’s own bounded Testnet payer and a credential-bearing XRPL Payment. When a mandate channel exists, Harbor can instead sign a monotonic cumulative claim; many machine payments can be covered by one later merchant redemption.",
          input: "Validated x402 challenge",
          output: "XRPL payment or cumulative claim",
          status: "Testnet only",
          crossesBoundary: "Demo merchant → XRPL Testnet",
        },
        {
          nodeId: "ledger-evidence",
          title: "Prove, do not infer, settlement",
          body:
            "Exact settlement becomes successful only when the validated ledger transaction matches the locally signed payment and delivered amount. A channel response remains claim_accepted until redemption is independently evidenced.",
          input: "Transaction or channel evidence",
          output: "validated, claim_accepted, redeemed, or pending",
          status: "Evidence bound",
        },
        {
          nodeId: "receipt-controls",
          title: "Render dispute-ready provenance",
          body:
            "Pilot renders the full evidence chain and can export public signatures, digests, validation outcomes, and hashes—never private keys, compact credentials, raw Open Finance data, or raw merchant text.",
          input: "Mandate, intent, L3, payment, ledger proof",
          output: "Bounded receipt and evidence export",
          status: "Inspectable",
          crossesBoundary: "Harbor evidence → Pilot UI",
        },
      ],
    },
    {
      id: "blocked",
      label: "Policy or mandate blocks",
      tone: "blocked",
      summary:
        "A blocked AP4M purchase does not fall through to a surprise wallet prompt. The owner must deliberately authorize a new or changed mandate.",
      steps: [
        {
          nodeId: "pilot-request",
          title: "Request arrives already bound",
          body:
            "Pilot rejects missing mandates, non-Testnet use, and an owner that does not match the connected budget account before asking Harbor to buy anything.",
          input: "Merchant + SKU",
          output: "Bound request or immediate block",
          status: "Context checked",
        },
        {
          nodeId: "two-gates",
          title: "One failed rule stops the purchase",
          body:
            "Examples include a revoked or expired mandate, unapproved merchant or SKU, cap overflow, disabled AP4M policy, or a base Policy verdict other than execute. No L3 artifact, claim, or payment is created after a failed gate.",
          input: "Policy and mandate evaluation",
          output: "POLICY_BLOCKED or MANDATE_NOT_ACTIVE",
          status: "Blocked",
        },
        {
          nodeId: "owner-approval",
          title: "No per-purchase approval escape",
          body:
            "AP4M intentionally treats a base Policy needs_approval verdict as blocked. To widen payees, limits, SKUs, or time, the owner creates and signs a new bounded setup; Harbor never converts the purchase into an implicit approval flow.",
          input: "Explicit owner decision",
          output: "Unchanged block or newly signed mandate",
          status: "Fresh approval required",
          crossesBoundary: "Owner-controlled authorization boundary",
        },
        {
          nodeId: "receipt-controls",
          title: "Explain the named reason",
          body:
            "Pilot surfaces the failed rule and does not retry the same blocked merchant/SKU request in the same model run.",
          input: "Named gate result",
          output: "Plain-language block explanation",
          status: "No automatic retry",
        },
      ],
    },
    {
      id: "safety",
      label: "Revoke, freeze, or wait",
      tone: "degraded",
      summary:
        "The user kill switch, QuickNode watchdog seam, and uncertain-settlement handling stop new authority without pretending that a local state change is the same as an on-ledger revoke.",
      steps: [
        {
          nodeId: "receipt-controls",
          title: "User invokes the kill switch",
          body:
            "Revoke agent is a user-controlled server action, never a model tool. It marks the Harbor mandate REVOKED and requests deletion of the Demo Network credential; remaining channel closure is a separate owner-visible ledger action.",
          input: "Explicit user revoke",
          output: "Revoked mandate + credential revoke result",
          status: "User controlled",
          crossesBoundary: "Pilot UI → Harbor + Demo Network",
        },
        {
          nodeId: "two-gates",
          title: "Next purchase fails before signing",
          body:
            "Mandate revocation stops Harbor from minting new L3 artifacts or claims. Credential deletion separately removes the ledger-level authorization used by exact payments.",
          input: "REVOKED mandate",
          output: "MANDATE_NOT_ACTIVE",
          status: "Fail closed",
        },
        {
          nodeId: "settlement-rail",
          title: "Watchdog freezes an out-of-band payer",
          body:
            "When the QuickNode Streams integration is in verified freeze mode, an AP4M/x402 payer transaction that Harbor does not own is classified out_of_band_payer and disables that payer. Later AP4M purchases fail PAYER_FROZEN. Mock mode demonstrates this classification but is not live Streams evidence.",
          input: "Verified ledger event",
          output: "Payer disabled or alert only",
          status: "Mode dependent",
          crossesBoundary: "QuickNode Streams → Harbor watchdog",
        },
        {
          nodeId: "ledger-evidence",
          title: "Uncertain is not failed or paid",
          body:
            "A missing first lookup is never absence proof. Pilot and Harbor preserve settlement_unknown or pending until exact ledger evidence establishes success, terminal failure, or expiry across the eligible ledger window.",
          input: "Incomplete settlement evidence",
          output: "Pending state; no blind repayment",
          status: "Degraded safely",
        },
      ],
    },
  ],
  boundaries: [
    {
      title: "Owner custody",
      body:
        "The owner XRPL key stays in the wallet or Testnet-only dev signer. The VI device key is non-extractable in the browser. Pilot never receives either key.",
    },
    {
      title: "Harbor-owned signers",
      body:
        "Mandate-agent, payment-channel claim, Web Bot Auth, payer, and delegate keys are Harbor-owned, encrypted at rest, scoped to their purpose, and never enter model context.",
    },
    {
      title: "No owner-payment delegation",
      body:
        "Payment, PaymentChannelCreate, and PaymentChannelFund are never added to the owner’s delegated permission set. Setup stays owner-signed; Harbor signs only with its own bounded payer or claim keys.",
    },
    {
      title: "Typed data boundary",
      body:
        "Open Finance credentials remain server-side, owner identity is masked or hashed, and only schema-validated merchant fields reach the model. Raw merchant prose and signed VI tokens do not.",
    },
    {
      title: "Testnet and stand-ins",
      body:
        "All payment, credential, mandate, channel, and merchant transaction paths are Testnet-only. The Demo Network issuer is a labelled production-role stand-in, not Mastercard infrastructure.",
    },
  ],
  enhancements: [
    "Turns a broad ‘agent can pay’ idea into explicit merchants, products, limits, expiry, and an owner-visible setup.",
    "Lets repeated low-value machine purchases use cumulative channel claims while keeping a bounded collateral ceiling.",
    "Gives exact purchases credential checks at both the merchant and ledger boundaries.",
    "Keeps the model away from prices, payment headers, URLs, signing material, and raw third-party text.",
    "Produces a readable evidence chain for support, audit, and dispute review.",
  ],
  demonstrates: [
    "A mock-first Open Finance owner-and-balance step with masked browser output.",
    "A signed Verifiable Intent mandate whose constraints are checked again by Harbor.",
    "Mastercard Level 3-inspired ordered merchant validation with an XRPL payment object.",
    "Exact-payment and cumulative payment-channel state machines against XRPL Testnet shapes.",
    "Offline cross-language verification, deterministic fixtures, UI evidence, and fail-closed safety branches.",
  ],
  doesNotDemonstrate: [
    "A Mastercard AP4M or Agent Pay API call, Mastercard-network payment, card transaction, certification, endorsement, or partnership.",
    "Live Open Finance sandbox access until its event-day account and egress checks pass.",
    "A validated Testnet credential, Batch, payment, claim redemption, rogue-agent rejection, or revoke unless a live evidence file records it.",
    "That mock transaction hashes or headless rehearsals are ledger evidence; committed final rehearsals are explicitly mock-only.",
    "That payment-channel collateral replaces Mastercard’s settlement guarantee; it only bounds the XRPL claim and complements that model.",
  ],
  sources: [
    {
      label: "Mastercard AP4M build blueprint",
      path: "docs/ap4m.md",
    },
    {
      label: "Claim-safe AP4M runbook and evidence gates",
      path: "docs/ap4m.md",
    },
    {
      label: "Open Finance masking and budget proposal",
      path: "apps/web/lib/mastercard/open-finance/service.ts",
    },
    {
      label: "Owner mandate preparation and sign-only registration",
      path: "apps/web/app/onboarding/mandate-flow.ts",
    },
    {
      label: "Bound model tool and user-controlled revoke boundary",
      path: "packages/agent/src/ap4m.ts",
    },
    {
      label: "Harbor policy and mandate intersection",
      path: "services/harbor/src/exec/mandate-gate.ts",
    },
    {
      label: "Harbor durable AP4M purchase state machine",
      path: "services/harbor/src/ops/ap4m.ts",
    },
    {
      label: "Harbor QuickNode payer watchdog",
      path: "services/harbor/src/quicknode/watchdog.ts",
    },
  ],
} as const satisfies IntegrationExplainer;
