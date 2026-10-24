import type { IntegrationExplainer } from "../types";

export const ledgerExplainer = {
  slug: "ledger",
  name: "Ledger",
  eyebrow: "Owner signing boundary",
  headline: "Bounded automation, with owner approval at the edge",
  summary:
    "Pilot uses Ledger as the owner-signing boundary. Harbor can execute only inside the permissions granted on-ledger and the limits enforced by policy; grants, revocations, and actions beyond that boundary return to the owner for review.",
  status:
    "Pitch-ready Speculos simulation. Physical hardware is not required for this pitch, and no physical-device or live-Testnet validation is claimed.",
  truthLabel:
    "Speculos simulation · XRP app 2.8.2 · public test seed · no physical device required",
  what:
    "Speculos runs Ledger's real XRP app 2.8.2 in an emulator. Pilot reaches it through the same Device Management Kit signing path used by the Ledger wallet facade, then verifies the resulting XRPL signature and every non-signature transaction field before relay.",
  why:
    "The integration separates proposing an action from authorizing it. Routine, in-policy actions can use Harbor's bounded delegate, while an owner-controlled signer handles the exact transactions that grant authority, revoke it, or exceed the delegate's limits.",
  accent: "graphite",
  zones: [
    {
      id: "pilot",
      label: "Pilot browser",
      detail:
        "Turns a request into a typed intent, shows the review, and never receives an owner seed or private key.",
    },
    {
      id: "harbor",
      label: "Harbor policy boundary",
      detail:
        "Evaluates the active link, granted transaction types, network, issuer, simulation result, slippage, and spend limits.",
    },
    {
      id: "signer",
      label: "Owner signer boundary",
      detail:
        "For this pitch, Speculos emulates a Ledger and runs XRP app 2.8.2 with its public default test seed.",
    },
    {
      id: "relay",
      label: "Sign-only relay",
      detail:
        "Pilot verifies the signature and unchanged fields; Harbor accepts only the exact approved transaction tuple.",
    },
    {
      id: "network",
      label: "XRPL test networks",
      detail:
        "The wallet facade permits testnet and devnet only. Mainnet signing is refused.",
    },
  ],
  nodes: [
    {
      id: "request",
      label: "Owner request",
      shortLabel: "Request",
      zone: "pilot",
      detail:
        "A person asks Pilot for an action. The model can propose; it cannot sign or expand permissions.",
    },
    {
      id: "intent",
      label: "Typed transaction intent",
      shortLabel: "Intent",
      zone: "pilot",
      detail:
        "Pilot deterministically maps the request to an exact XRPL builder and reviewable transaction fields.",
    },
    {
      id: "policy",
      label: "Harbor policy verdict",
      shortLabel: "Policy",
      zone: "harbor",
      detail:
        "Harbor returns execute, needs approval, or block. Memory and model behavior do not change this authority.",
    },
    {
      id: "delegate",
      label: "Bounded Harbor delegate",
      shortLabel: "Delegate",
      zone: "harbor",
      detail:
        "A separate delegate key may execute only transaction types granted on-ledger and only when Harbor policy passes.",
    },
    {
      id: "speculos",
      label: "Speculos + XRP app 2.8.2",
      shortLabel: "Speculos",
      zone: "signer",
      detail:
        "The emulator exercises the DMK address and signature path. Its public test seed is intentionally known and is not secure custody.",
    },
    {
      id: "verify",
      label: "Local signature guard",
      shortLabel: "Verify",
      zone: "pilot",
      detail:
        "Pilot requires the connected account, rejects pre-signed or changed transactions, and verifies the XRPL signature locally.",
    },
    {
      id: "relay",
      label: "Exact-blob relay",
      shortLabel: "Relay",
      zone: "relay",
      detail:
        "The Ledger facade signs only. Submission remains a separate Pilot-to-Harbor relay that binds the blob to the approved transaction.",
    },
    {
      id: "xrpl",
      label: "XRPL testnet or devnet",
      shortLabel: "XRPL",
      zone: "network",
      detail:
        "The protocol validates a relayed transaction. The public pitch replay does not submit anything to this node.",
    },
  ],
  scenarios: [
    {
      id: "delegate-path",
      label: "In-policy delegate path",
      tone: "success",
      summary:
        "An already-granted action passes Harbor policy and executes with the delegate key, without asking the owner signer again.",
      steps: [
        {
          nodeId: "request",
          title: "The owner asks",
          body: "Pilot receives an explicit action request; the model has proposal authority only.",
          input: "Natural-language request",
          output: "Candidate action",
          status: "proposed",
        },
        {
          nodeId: "intent",
          title: "Pilot makes it exact",
          body: "A deterministic mapping produces typed builder arguments and exact XRPL transaction fields.",
          input: "Candidate action",
          output: "Typed intent",
          status: "constructed",
        },
        {
          nodeId: "policy",
          title: "Harbor checks the boundary",
          body: "The link must be active and the transaction type, network, issuer, simulation, slippage, per-transaction limit, and daily cap must pass.",
          input: "Built and simulated transaction",
          output: "execute",
          status: "allowed",
          crossesBoundary: "Pilot → Harbor",
        },
        {
          nodeId: "delegate",
          title: "The bounded delegate signs",
          body: "Harbor's separate delegate key signs only inside the permission set previously granted by the owner.",
          input: "execute verdict",
          output: "Delegated signed blob",
          status: "delegated",
        },
        {
          nodeId: "xrpl",
          title: "The network validates",
          body: "XRPL enforces the on-ledger delegation. No owner-device signature is used for this in-policy transaction.",
          input: "Delegated signed blob",
          output: "Validated result",
          status: "validated",
          crossesBoundary: "Harbor → XRPL test network",
        },
      ],
    },
    {
      id: "speculos-approval",
      label: "Owner approval on Speculos",
      tone: "approval",
      summary:
        "A transaction beyond delegated authority is reviewed through the sign-only Ledger path. For the pitch, Speculos supplies the device behavior; the checked-in public replay creates no signature.",
      steps: [
        {
          nodeId: "policy",
          title: "Policy requests the owner",
          body: "A non-delegable or over-threshold action returns needs approval instead of being executed automatically.",
          input: "Built and simulated transaction",
          output: "Exact owner-signable transaction",
          status: "needs approval",
        },
        {
          nodeId: "speculos",
          title: "The owner reviews in the emulator",
          body: "Speculos runs XRP app 2.8.2 through Ledger DMK. Clear-signable transactions show their known fields; DelegateSet is honestly labeled as blind-signed with Pilot's exact permission legend.",
          input: "Unsigned exact transaction",
          output: "DER signature",
          status: "Speculos simulation",
          crossesBoundary: "Pilot same-origin proxy → loopback Speculos",
        },
        {
          nodeId: "verify",
          title: "Pilot verifies before relay",
          body: "Pilot confirms the signing key derives the connected account, the signature is valid, and no field except SigningPubKey and TxnSignature changed.",
          input: "Signature + reviewed fields",
          output: "Verified signed blob",
          status: "verified locally",
        },
        {
          nodeId: "relay",
          title: "Sign only, then relay",
          body: "The wallet has no submit method. Pilot separately sends the verified blob and approval identity to Harbor, which rejects any mismatch.",
          input: "Verified signed blob",
          output: "Bound approval relay",
          status: "sign-only",
          crossesBoundary: "Pilot → Harbor relay",
        },
        {
          nodeId: "xrpl",
          title: "Validation is a separate claim",
          body: "A live flow could submit to a test network, but this public explainer and recorded demo perform no signing or submission and claim no validated transaction.",
          input: "Bound approval relay",
          output: "Not exercised by public replay",
          status: "simulation boundary",
        },
      ],
    },
    {
      id: "reject-expire-revoke",
      label: "Reject, expire, or revoke",
      tone: "blocked",
      summary:
        "Every failure stays explicit: rejection stops, expiry requires a fresh build, and revocation removes the delegate's on-ledger permissions.",
      steps: [
        {
          nodeId: "policy",
          title: "A block is final",
          body: "If policy returns block, Pilot explains the failed rules and does not retry or route around them.",
          input: "Disallowed transaction",
          output: "Reasons",
          status: "blocked",
        },
        {
          nodeId: "speculos",
          title: "Device rejection stops signing",
          body: "Blind signing off refuses DelegateSet, and an owner can reject any review. The XRP app returns the same 6985 status in both cases; Pilot disambiguates using the expected signing mode.",
          input: "Review prompt",
          output: "No signature",
          status: "rejected",
        },
        {
          nodeId: "intent",
          title: "Expiry rebuilds from intent",
          body: "With less than 30 seconds left or after expiry, Pilot requires an explicit click and creates a fresh build plus a new idempotency key. It never reuses the expired tuple.",
          input: "Expired approval",
          output: "Fresh review",
          status: "rebuilt",
        },
        {
          nodeId: "speculos",
          title: "Revocation returns to the owner",
          body: "Harbor prepares an empty-Permissions DelegateSet. It is blind-signed only after the owner matches the exact account, delegate, fee, and empty permission set.",
          input: "Revoke request",
          output: "Signed empty-permission DelegateSet",
          status: "owner approved",
        },
        {
          nodeId: "relay",
          title: "Harbor relays the exact revoke",
          body: "The sign-only result follows the existing account-revoke relay; a changed field or wrong tuple is rejected.",
          input: "Signed revoke blob",
          output: "Exact revoke relay",
          status: "guarded",
        },
        {
          nodeId: "xrpl",
          title: "Delegated authority becomes empty",
          body: "After network validation, account status must report revoked with zero permissions. Harbor’s core account watcher can suspend a link after an unrecognized delegated transaction and prepare this owner-signed revoke path; the separate QuickNode watchdog applies a Harbor-local freeze.",
          input: "Empty-permission DelegateSet",
          output: "Revoked link",
          status: "revoked",
          crossesBoundary: "Harbor → XRPL test network",
        },
      ],
    },
  ],
  boundaries: [
    {
      title: "Physical hardware is not required for this pitch",
      body: "The presentation uses Speculos and a recorded replay. Physical Ledger/WebHID validation remains a future product-validation lane, not a pitch prerequisite.",
    },
    {
      title: "The public seed is not custody",
      body: "Speculos uses its public default test seed. That is useful for deterministic signatures and conformance, but it does not reproduce a physical secure element or prove protected owner-key custody.",
    },
    {
      title: "The public replay signs nothing",
      body: "The visible component must retain the labels “Simulated Ledger”, “Recorded demo · no signing”, and “Demo confirmed · no signature was created”. It makes no DMK, wallet, Harbor, XRPL, or sponsor-service request.",
    },
    {
      title: "Owner and delegate are separate",
      body: "The owner signer grants and revokes authority or approves exceptions. Harbor's delegate has its own key and cannot enlarge the seven on-ledger permissions or bypass policy.",
    },
    {
      title: "Local and test-network only",
      body: "Virtual Ledger is exposed only by a local profile through a same-origin proxy to loopback Speculos. The wallet facade refuses mainnet signing, and hosted Virtual Ledger is disabled.",
    },
  ],
  enhancements: [
    "Makes the line between agent proposal, delegated execution, and owner authorization visible at every step.",
    "Lets routine transactions proceed without repeated owner signatures while preserving an explicit approval path for exceptions.",
    "Shows blind-signed DelegateSet permissions in plain language instead of presenting unknown numeric fields as clear-signed.",
    "Fails closed on changed fields, invalid signatures, account mismatch, expiry, rejection, mainnet, or unavailable transport.",
    "Supports a pitch-ready simulator without pretending a recorded replay is a live wallet or physical-device proof.",
  ],
  demonstrates: [
    "Speculos running Ledger's XRP app 2.8.2 through the Ledger Device Management Kit path.",
    "Address derivation, on-device-style address review, XRPL transaction signing, and local signature verification in emulator conformance.",
    "Clear-sign behavior for wallet challenge, TrustSet, and OfferCreate, plus blind-sign behavior for DelegateSet.",
    "Deterministic Harbor compatibility fixtures for TrustSet, DelegateSet grant, DelegateSet revoke, and OfferCreate, including tamper rejection.",
    "A bounded, network-free recorded replay labeled as simulated and no-signing evidence.",
  ],
  doesNotDemonstrate: [
    "Physical Ledger hardware, Chrome WebHID behavior, a secure element, or protected real-world key custody.",
    "A live Testnet submission or validated transaction from the public replay or this explainer.",
    "Hosted or production readiness for real or virtual Ledger signing.",
    "A Ledger partnership, certification, sponsorship, endorsement, or Agent Intent support for XRPL.",
    "Server-verifiable proof that a client-known “Approved on Ledger” badge came from physical hardware.",
  ],
  sources: [
    {
      label: "Ledger integration blueprint and simulation boundaries",
      path: "RUNBOOK-LEDGER.md",
    },
    {
      label: "Sign-only wallet facade and local signature guard",
      path: "packages/wallet/src/ledger/facade.ts",
    },
    {
      label: "XRP app 2.8.2 clear/blind classification",
      path: "packages/wallet/src/ledger/clear-sign.ts",
    },
    {
      label: "Exact seven-permission legend",
      path: "packages/wallet/src/ledger/permissions.ts",
    },
    {
      label: "Recorded demo labels and no-signing replay",
      path: "apps/web/components/ledger/simulated-device.tsx",
    },
    {
      label: "Fresh-build approval expiry guard",
      path: "apps/web/components/chat/ledger-approval.ts",
    },
    {
      label: "Speculos and offline implementation evidence",
      path: "scripts/ledger/preflight.test.mjs",
    },
    {
      label: "Harbor signature, tamper, grant, and revoke fixtures",
      path: "services/harbor/test/ledger-compat.test.ts",
    },
  ],
} as const satisfies IntegrationExplainer;
