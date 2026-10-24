import type { IntegrationExplainer } from "../types";

export const awsIntegration = {
  slug: "aws",
  name: "AWS trust layer",
  eyebrow: "Inspectable safeguards for reading, reasoning, and signing",
  headline: "Three protections, with each responsibility kept separate.",
  summary:
    "Pilot uses an AWS-shaped trust layer around Harbor: Bedrock Guardrails screens mapped untrusted text, an optional Bedrock model can handle a signed-in session, and KMS can protect or sign with Harbor's delegate keys. Harbor policy and XRPL permissions still decide what an action may do.",
  status:
    "Implemented and tested against mocks and a local AWS stand-in. No live AWS account, live Bedrock request, or production KMS claim is made on this page.",
  truthLabel: "Architecture simulation · local stand-in evidence",
  what:
    "The integration adds structured screening, model, and signer provenance to Harbor results and Pilot action receipts. Pilot stays on Vercel and Harbor stays on Cloudflare; AWS is a trust layer, not a hosting migration.",
  why:
    "Ledger and provider text can be adversarial, model provenance should be visible, and a delegate signer should not expose its private key. These controls make those boundaries inspectable without giving the model, the browser, or AWS any new transaction authority.",
  accent: "orange",
  zones: [
    {
      id: "pilot",
      label: "Workspace",
      detail:
        "The browser presents requests and receipts. AWS and Harbor credentials stay server-side, and Pilot never holds an XRPL owner key.",
    },
    {
      id: "harbor",
      label: "Harbor control plane",
      detail:
        "Operations, deterministic transaction building, policy checks, and the foreign-transaction watcher run here. Model output cannot rewrite these controls.",
    },
    {
      id: "aws",
      label: "AWS trust services",
      detail:
        "Guardrails evaluates mapped free text, Bedrock is an optional model provider, and KMS protects or signs with delegate key material. Each feature has an explicit mode switch.",
    },
    {
      id: "owner",
      label: "Owner control",
      detail:
        "The user's wallet keeps the owner key and signs DelegateSet, revocation, and approval-required transactions. Harbor and AWS never receive that secret.",
    },
    {
      id: "xrpl",
      label: "XRPL Testnet",
      detail:
        "Ledger state supplies reads, on-ledger permissions, and final validation. Mainnet execution remains disabled regardless of AWS configuration.",
    },
  ],
  nodes: [
    {
      id: "pilot-request",
      label: "Pilot request & receipt",
      shortLabel: "Pilot",
      zone: "pilot",
      detail:
        "A user asks a question or requests an action. Pilot shows structured trust metadata, including explicit mock labels, but does not turn that metadata into permission.",
    },
    {
      id: "harbor-operation",
      label: "Harbor operation boundary",
      shortLabel: "Harbor op",
      zone: "harbor",
      detail:
        "Harbor runs the requested read or action operation. Successful results pass through the screening hook before REST or MCP returns them.",
    },
    {
      id: "guardrails",
      label: "Bedrock Guardrails screen",
      shortLabel: "Guardrails",
      zone: "aws",
      detail:
        "Only mapped attacker-controlled free text is scored. Suspicious fields are replaced; on timeout or provider failure, mapped free text is hidden fail-closed while addresses and currency codes remain available.",
    },
    {
      id: "bedrock-model",
      label: "Optional Bedrock model",
      shortLabel: "Model",
      zone: "aws",
      detail:
        "When enabled, eligible signed-in sessions may select an Amazon Bedrock model. Logged-out and demo sessions remain on free OpenRouter models; local mock mode records bedrock-mock, not a live Bedrock call.",
    },
    {
      id: "policy-watchdog",
      label: "Policy & watchdog",
      shortLabel: "Policy",
      zone: "harbor",
      detail:
        "Harbor checks network, link status, granted transaction type, issuer rules, simulation, slippage, per-action and daily limits. Its watcher suspends a link when it sees a foreign delegated transaction and prepares an owner-signed revoke.",
    },
    {
      id: "kms-signer",
      label: "KMS delegate signer",
      shortLabel: "KMS",
      zone: "aws",
      detail:
        "In sign mode, a per-link Ed25519 private key remains non-exportable in KMS. Harbor sends signing bytes, verifies the returned signature locally, and fails instead of silently falling back to a local key.",
    },
    {
      id: "owner-wallet",
      label: "Owner wallet",
      shortLabel: "Owner",
      zone: "owner",
      detail:
        "The owner decides and signs when a transaction cannot be delegated, crosses the auto-execute threshold, or revokes a delegate. The owner key never crosses this boundary.",
    },
    {
      id: "xrpl-testnet",
      label: "XRPL Testnet",
      shortLabel: "XRPL",
      zone: "xrpl",
      detail:
        "The ledger is the authority for the active Delegate entry and validated transaction result. A simulated, prepared, or submitted action is not described as validated until the ledger confirms it.",
    },
  ],
  scenarios: [
    {
      id: "screened-read",
      label: "Clean or screened read",
      tone: "success",
      summary:
        "Follow untrusted ledger text through Harbor's result screen before any model receives it, including the fail-closed branch when screening is unavailable.",
      steps: [
        {
          nodeId: "pilot-request",
          title: "Ask about ledger data",
          body:
            "Pilot sends a structured read request. AWS credentials and Harbor API credentials remain server-side and never enter model context.",
          input: "A question about a token, memo, account, or provider document",
          output: "A typed Harbor operation",
          status: "Requested",
          crossesBoundary: "Browser → Pilot server",
        },
        {
          nodeId: "harbor-operation",
          title: "Read structured data",
          body:
            "Harbor retrieves the requested data and identifies only the fields classified as third-party or ledger-controlled free text.",
          input: "Typed operation arguments",
          output: "Structured result plus mapped untrusted fields",
          status: "Mapped",
          crossesBoundary: "Pilot → Harbor",
        },
        {
          nodeId: "xrpl-testnet",
          title: "Return ledger evidence",
          body:
            "XRPL supplies account, transaction, or token facts. This is a read; it grants no signing permission and causes no transaction.",
          input: "Read-only XRPL request",
          output: "Ledger facts and possible free text",
          status: "Read only",
          crossesBoundary: "Harbor ↔ XRPL Testnet",
        },
        {
          nodeId: "guardrails",
          title: "Screen before model use",
          body:
            "Clean text passes with checked and blocked counts. Text above the configured threshold is replaced. If Guardrails times out or fails, mapped free text becomes '[unscreened text hidden]' instead of passing through.",
          input: "Mapped free-text fields",
          output: "Clean or redacted envelope with fixed-category trust metadata",
          status: "Fail closed",
          crossesBoundary: "Harbor → AWS trust service",
        },
        {
          nodeId: "bedrock-model",
          title: "Use the screened result",
          body:
            "An eligible selected model receives the screened envelope. In this explainer the provider is simulated; the receipt must say bedrock-mock when the local mode is used.",
          input: "Screened Harbor result",
          output: "Answer with visible model and screening provenance",
          status: "Mock labeled",
          crossesBoundary: "Trust result → model context",
        },
        {
          nodeId: "pilot-request",
          title: "Show an inspectable receipt",
          body:
            "Pilot displays fields checked, fields blocked, model provider, and safe fixed categories. It never repeats the blocked text or its raw path.",
          input: "Structured trust metadata",
          output: "Readable, claim-safe trust receipt",
          status: "Visible",
          crossesBoundary: "Server result → browser",
        },
      ],
    },
    {
      id: "kms-delegated-action",
      label: "Allowed delegated action",
      tone: "success",
      summary:
        "See an allowed Testnet action pass deterministic policy, receive a delegate signature, and stop safely if KMS cannot sign.",
      steps: [
        {
          nodeId: "pilot-request",
          title: "Request an action",
          body:
            "Pilot turns an explicit user request into a typed intent. The model may propose the intent, but deterministic application code selects the Harbor builder.",
          input: "Explicit user action request",
          output: "Typed intent",
          status: "Intent captured",
          crossesBoundary: "Browser → Pilot server",
        },
        {
          nodeId: "harbor-operation",
          title: "Build and simulate",
          body:
            "Harbor validates inputs, prepares an unsigned transaction, and evaluates simulation evidence. Neither Pilot nor the model signs here.",
          input: "Typed intent and policy context",
          output: "Unsigned build with simulation result",
          status: "Prepared",
          crossesBoundary: "Pilot → Harbor",
        },
        {
          nodeId: "policy-watchdog",
          title: "Authorize within narrow limits",
          body:
            "The action proceeds only when Testnet is allowed, the link is active, the transaction type is granted on-ledger and in policy, issuer and simulation rules pass, and value, slippage, and daily limits pass.",
          input: "Build, active link, ledger facts, and policy",
          output: "Execute verdict",
          status: "Policy passed",
        },
        {
          nodeId: "kms-signer",
          title: "Sign with the delegate",
          body:
            "KMS sign mode uses the stored per-link key reference. Harbor adds the Delegate field, sends canonical signing bytes, and verifies the Ed25519 signature locally. A KMS error stops here with no local-key fallback.",
          input: "Policy-approved delegated transaction",
          output: "Verified signed blob or a hard failure",
          status: "No silent fallback",
          crossesBoundary: "Harbor → KMS signer",
        },
        {
          nodeId: "xrpl-testnet",
          title: "Submit and validate",
          body:
            "The budget owner remains the transaction Account, the delegate authorizes the action and pays the fee, and XRPL Testnet determines the final result.",
          input: "Verified delegated transaction blob",
          output: "Validated result and transaction hash",
          status: "Ledger authority",
          crossesBoundary: "Harbor → XRPL Testnet",
        },
        {
          nodeId: "pilot-request",
          title: "Explain who did what",
          body:
            "The receipt distinguishes 'Signed by AWS KMS' from 'Key protected by AWS KMS' and includes only an alias, never a key ARN or credential.",
          input: "Execution, model, screen, and signer provenance",
          output: "Inspectable action receipt",
          status: "Provenance shown",
          crossesBoundary: "Harbor → Pilot",
        },
      ],
    },
    {
      id: "approval-revoke",
      label: "Approval, block, or revoke",
      tone: "approval",
      summary:
        "AWS never widens authority: protected transaction types and larger actions return to the owner, policy failures block, and foreign delegate activity suspends the link.",
      steps: [
        {
          nodeId: "policy-watchdog",
          title: "Choose the safe branch",
          body:
            "A non-delegable type or an otherwise-safe amount at or above the auto-execute threshold needs owner approval. Mainnet, missing or suspended links, failed simulation, disallowed issuers, unsafe slippage, or cap breaches block.",
          input: "Build plus current policy and ledger state",
          output: "Needs approval or blocked verdict with reasons",
          status: "Authority enforced",
        },
        {
          nodeId: "owner-wallet",
          title: "Keep owner consent with the owner",
          body:
            "For an approval verdict, Pilot presents the exact transaction for sign-only review in the user's wallet. KMS does not sign on the owner's behalf.",
          input: "Owner-signable transaction and approval id",
          output: "Owner-signed blob, or no action",
          status: "Human approval",
          crossesBoundary: "Pilot → owner wallet",
        },
        {
          nodeId: "xrpl-testnet",
          title: "Treat the ledger as final",
          body:
            "Only a validated XRPL result completes an approved action or changes the on-ledger delegation. A prepared approval is not a completed transaction.",
          input: "Owner-signed exact transaction",
          output: "Validated result or rejection",
          status: "Validated only",
          crossesBoundary: "Owner wallet → Harbor → XRPL Testnet",
        },
        {
          nodeId: "policy-watchdog",
          title: "Detect foreign delegate use",
          body:
            "If the watcher finds a validated delegated transaction with no matching Harbor execution record, it records a foreign event, suspends the link, refuses further delegated signing, and prepares an empty-permissions DelegateSet.",
          input: "Validated account transaction history",
          output: "Suspended link and prepared revoke",
          status: "Quarantined",
          crossesBoundary: "XRPL Testnet → Harbor watcher",
        },
        {
          nodeId: "owner-wallet",
          title: "Revoke on-ledger permission",
          body:
            "The owner reviews and signs the empty-permissions DelegateSet. Harbor cannot revoke the owner's authority or sign this protected transaction as the delegate.",
          input: "Prepared revoke transaction",
          output: "Owner-signed revocation",
          status: "Owner controlled",
        },
        {
          nodeId: "kms-signer",
          title: "Retire the exact delegate key",
          body:
            "After Harbor observes that the Delegate entry is gone, it schedules the stored KMS key for deletion with a seven-day window. This complements on-ledger revocation; it does not replace it.",
          input: "Validated missing Delegate entry",
          output: "Key deletion scheduled",
          status: "Revoked",
          crossesBoundary: "Harbor → KMS lifecycle",
        },
      ],
    },
  ],
  boundaries: [
    {
      title: "Screening is not authorization",
      body:
        "Guardrails can redact mapped free text; it cannot grant a transaction type, raise a spending limit, activate a delegate, or approve a blocked action.",
    },
    {
      title: "Owner custody stays outside",
      body:
        "Pilot holds no XRPL key. Harbor and AWS never receive the owner's seed or private key; the owner wallet signs DelegateSet, revocation, and approval-required transactions.",
    },
    {
      title: "Delegate custody is narrow",
      body:
        "KMS sign mode applies to the owner-delegation signer. Mastercard payer, claim, VI, and Web Bot Auth keys remain protected through the KMS KEK path; direct KMS signing for those keys is roadmap.",
    },
    {
      title: "Failure does not downgrade",
      body:
        "Guardrails hides mapped text when unavailable, and KMS signing returns an error when it fails. Neither path silently switches off its protection for a successful-looking result.",
    },
    {
      title: "AWS metadata changes no permission",
      body:
        "Trust chips describe screen, model, and signer provenance. XRPL delegation plus Harbor's deterministic policy remain the authority for what can execute.",
    },
  ],
  enhancements: [
    "Screens mapped ledger and provider free text before it enters model context.",
    "Makes model, screening, and signer provenance visible on action receipts.",
    "Supports non-exportable per-link delegate signing with local verification of each signature.",
    "Fails closed on screening outages and refuses silent signer fallback.",
    "Links key retirement to observed on-ledger revocation while Harbor's watcher handles foreign delegated activity.",
  ],
  demonstrates: [
    "The implemented trust contract and explicit off, mock, KEK, and sign modes.",
    "Deterministic prompt-injection screening and fail-closed redaction against the local AWS stand-in.",
    "Real Ed25519 signing behavior, signature verification, alias provenance, and key-lifecycle logic against the stand-in.",
    "Pilot receipts and banners that distinguish mock, unavailable, KMS-protected, and KMS-signed states.",
    "How AWS protections compose with Harbor policy, owner approval, XRPL delegation, watchdog suspension, and revocation.",
  ],
  doesNotDemonstrate: [
    "A live AWS account, production AWS KMS key, live Bedrock model call, or live Bedrock Guardrails decision.",
    "AWS sponsorship, partnership, certification, endorsement, or an AWS-hosted Pilot/Harbor deployment.",
    "A validated Testnet transaction signed by real AWS KMS; that event-day acceptance remains deferred.",
    "Any AWS ability to approve transactions, alter Harbor policy, expand XRPL permissions, or access an owner key.",
    "A guarantee that all arbitrary text is screened; coverage is deliberately limited to reviewed untrusted-field mappings.",
  ],
  sources: [
    {
      label: "AWS trust-layer blueprint and claim boundaries",
      path: "RUNBOOK-AWS.md",
    },
    {
      label: "Harbor Guardrails screening and fail-closed behavior",
      path: "services/harbor/src/guard/screen.ts",
    },
    {
      label: "Harbor operation result screening hook",
      path: "services/harbor/src/executor/providers.ts",
    },
    {
      label: "Harbor policy verdicts and limits",
      path: "services/harbor/src/exec/policy.ts",
    },
    {
      label: "KMS Ed25519 signer and no-fallback checks",
      path: "services/harbor/src/exec/kms-signer.ts",
    },
    {
      label: "Foreign delegated-transaction watcher",
      path: "services/harbor/src/exec/watcher.ts",
    },
    {
      label: "Pilot Bedrock access boundary",
      path: "apps/web/lib/model-access.ts",
    },
    {
      label: "Pilot structured trust receipt",
      path: "apps/web/components/cards/trust-receipt.tsx",
    },
  ],
} as const satisfies IntegrationExplainer;
