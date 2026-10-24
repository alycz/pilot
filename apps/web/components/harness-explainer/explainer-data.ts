export type ExplainerStatus = "implemented" | "inspired" | "optional";

export type ExplainerTone =
  | "conversation"
  | "memory"
  | "model"
  | "proposal"
  | "guardrail"
  | "ledger"
  | "learning";

export type ExplainerIcon =
  | "chat"
  | "vault"
  | "search"
  | "model"
  | "sparkles"
  | "shield"
  | "ledger"
  | "check"
  | "lightbulb"
  | "review"
  | "bookmark"
  | "repeat";

export type ExplainerStage = {
  id: string;
  order: number;
  shortLabel: string;
  title: string;
  summary: string;
  detail: string;
  input: string;
  output: string;
  status: ExplainerStatus;
  tone: ExplainerTone;
  icon: ExplainerIcon;
};

export type ExplainerBadge = {
  status: ExplainerStatus;
  label: string;
  description: string;
};

export type ArchitectureCallout = {
  id: "pilot-harbor" | "hermes" | "harness" | "vault";
  title: string;
  status: ExplainerStatus;
  summary: string;
  detail: string;
};

export type ModelSwitchStep = {
  model: string;
  modelDetail: string;
  prompt: string;
  retrievedContext: string;
  response: string;
};

export const explainerBadges: readonly ExplainerBadge[] = [
  {
    status: "implemented",
    label: "Implemented",
    description: "Present in Pilot or Harbor today.",
  },
  {
    status: "inspired",
    label: "Inspired",
    description: "A design influence, not an installed or live integration.",
  },
  {
    status: "optional",
    label: "Optional · not enabled",
    description: "Code exists, but it is disabled and not part of this active path.",
  },
] as const;

export const explainerStages: readonly ExplainerStage[] = [
  {
    id: "conversation",
    order: 1,
    shortLabel: "Ask",
    title: "Conversation + authorized feedback",
    summary: "You ask, correct, or explicitly share a preference.",
    detail:
      "Pilot starts with the current request. Feedback is eligible for learning only when it is explicit and authorized; the diagram never uses real conversations or wallet data.",
    input: "Current request",
    output: "Scoped intent + explicit feedback",
    status: "implemented",
    tone: "conversation",
    icon: "chat",
  },
  {
    id: "scoped-memory",
    order: 2,
    shortLabel: "Scope",
    title: "Scoped preferences + journal",
    summary: "Pilot keeps reviewed preferences and activity notes in one scoped vault.",
    detail:
      "The owner- and network-scoped Pilot vault uses Markdown for journal, trade, reflection, venue, token, profile, and policy notes, plus scoped JSON state for reviewed preferences and workflow lessons. It is not a universal archive of every historical AI chat.",
    input: "Accepted memory + recorded activity",
    output: "Bounded vault state",
    status: "implemented",
    tone: "memory",
    icon: "vault",
  },
  {
    id: "context-retrieval",
    order: 3,
    shortLabel: "Retrieve",
    title: "Relevant context retrieval",
    summary: "Only useful, authorized context is selected for this request.",
    detail:
      "Pilot searches within the authenticated scope and reads specific matching notes. Choosing a model does not grant that model access to the whole vault or to an imagined complete chat history.",
    input: "Current request + scoped index",
    output: "Small relevant context set",
    status: "implemented",
    tone: "memory",
    icon: "search",
  },
  {
    id: "chosen-model",
    order: 4,
    shortLabel: "Choose",
    title: "Chosen model",
    summary: "The selected model receives the request and bounded context.",
    detail:
      "Model access runs through Pilot. Personalization comes from retrieved memory and reviewed lessons, not from retraining or fine-tuning the chosen model.",
    input: "Request + relevant context",
    output: "Context-aware model turn",
    status: "implemented",
    tone: "model",
    icon: "model",
  },
  {
    id: "research-proposal",
    order: 5,
    shortLabel: "Propose",
    title: "Research + proposal",
    summary: "The model researches, explains, or proposes a typed intent.",
    detail:
      "A proposal is not execution. Market facts need sources and freshness, and transaction work stays declarative until Pilot passes the typed intent to Harbor.",
    input: "Context-aware model turn",
    output: "Answer or typed intent",
    status: "implemented",
    tone: "proposal",
    icon: "sparkles",
  },
  {
    id: "policy-approval",
    order: 6,
    shortLabel: "Guard",
    title: "Deterministic Harbor policy + approval",
    summary: "Harbor builds, simulates, and applies fixed policy rules.",
    detail:
      "Harbor—not the model—decides whether an action is allowed, blocked, or needs owner approval. Approval-required actions stay paused until the user signs; blocked actions are not retried automatically.",
    input: "Typed intent",
    output: "Execute, approve, or block",
    status: "implemented",
    tone: "guardrail",
    icon: "shield",
  },
  {
    id: "xrpl-execution",
    order: 7,
    shortLabel: "Execute",
    title: "XRPL execution",
    summary: "An allowed or owner-approved transaction reaches the ledger.",
    detail:
      "Harbor executes within its delegated permissions, or relays a client-signed approval. Pilot never gives the model a signing tool, and this explainer performs no network or wallet calls.",
    input: "Policy-cleared transaction",
    output: "Submitted XRPL transaction",
    status: "implemented",
    tone: "ledger",
    icon: "ledger",
  },
  {
    id: "verified-result",
    order: 8,
    shortLabel: "Verify",
    title: "Verified result + feedback",
    summary: "Validation becomes a durable result; the user can respond.",
    detail:
      "Pilot records the validated outcome and reflection in its journal. A ledger result is evidence of execution, not evidence that a trade was profitable or optimal.",
    input: "Ledger validation + user response",
    output: "Recorded outcome + evidence",
    status: "implemented",
    tone: "ledger",
    icon: "check",
  },
  {
    id: "proposed-learning",
    order: 9,
    shortLabel: "Suggest",
    title: "Proposed learning",
    summary: "Eligible feedback can become a preference or workflow proposal.",
    detail:
      "Pilot may propose a bounded preference or lesson from verified evidence. Inferred or unverified observations stay proposals and cannot silently become durable memory. This structured-personalization path is implemented behind a configuration gate and is default-off.",
    input: "Explicit feedback + verified evidence",
    output: "Pending proposal",
    status: "implemented",
    tone: "learning",
    icon: "lightbulb",
  },
  {
    id: "user-review",
    order: 10,
    shortLabel: "Review",
    title: "User review",
    summary: "You accept, reject, or correct the proposal.",
    detail:
      "Review is the boundary between an observation and retained personalization. When the default-off structured-personalization feature is enabled, you can correct or forget stored preferences and lessons without rewriting immutable XRPL history.",
    input: "Pending proposal",
    output: "Accepted, rejected, or corrected",
    status: "implemented",
    tone: "learning",
    icon: "review",
  },
  {
    id: "retained-learning",
    order: 11,
    shortLabel: "Retain",
    title: "Retained preferences + lessons",
    summary: "Only reviewed items become reusable context.",
    detail:
      "When structured personalization is enabled, accepted current records are stored as scoped, versioned vault state. They can guide later planning but do not change Harbor policy or promise better returns.",
    input: "Reviewed decision",
    output: "Versioned durable context",
    status: "implemented",
    tone: "memory",
    icon: "bookmark",
  },
  {
    id: "next-conversation",
    order: 12,
    shortLabel: "Continue",
    title: "Next conversation + model",
    summary: "A later model can use the same confirmed preference when relevant.",
    detail:
      "When the default-off feature is enabled, the preference travels through Pilot's scoped retrieval, not through model training. Switch models and the confirmed context can still be supplied without exposing unrelated history.",
    input: "New request + relevant retained context",
    output: "Personalized next turn",
    status: "implemented",
    tone: "conversation",
    icon: "repeat",
  },
] as const;

export const architectureCallouts: readonly ArchitectureCallout[] = [
  {
    id: "pilot-harbor",
    title: "Pilot + Harbor",
    status: "implemented",
    summary: "The active application and deterministic execution boundary.",
    detail:
      "Pilot owns the conversation, scoped context, and reviewed learning. Harbor owns builds, simulation, policy decisions, approval state, and XRPL execution paths.",
  },
  {
    id: "hermes",
    title: "Hermes proposal adapter",
    status: "optional",
    summary: "Implemented as a restricted adapter, default-off and not running here.",
    detail:
      "It has no browser wiring or runtime enablement and must not be presented as a live Hermes service. It can only be enabled after a separately provisioned, reviewed, tool-free profile passes acceptance.",
  },
  {
    id: "harness",
    title: "Google Research Harness²",
    status: "inspired",
    summary: "Inspires an offline propose / compare / refine pattern.",
    detail:
      "Pilot includes a bounded offline evaluator for synthetic, redacted fixtures. There is no installed Harness² package, live Google integration, automatic promotion, or upstream compatibility claim.",
  },
  {
    id: "vault",
    title: "Vault-based memory",
    status: "implemented",
    summary: "Obsidian-compatible Markdown notes plus scoped personalization state.",
    detail:
      "Pilot writes Markdown notes and wikilinks that can open in Obsidian; reviewed structured preferences and lessons use scoped JSON state. It does not claim Obsidian sync or universal import of past conversations.",
  },
] as const;

export const modelSwitchDemo = {
  label: "Synthetic model-switch demo",
  confirmedPreference: "Lead with risk caveats and source freshness before comparisons.",
  preferenceState: "Confirmed conservative preference · retained in scoped memory",
  explanation:
    "The same reviewed preference is retrieved for both turns. The models do not share hidden state and are not trained on this example.",
  steps: [
    {
      model: "Model A · Deliberate",
      modelDetail: "Synthetic reasoning-oriented option",
      prompt: "Compare XRPL routes for exchanging XRP and RLUSD.",
      retrievedContext: "Confirmed preference: lead with risk caveats and source freshness.",
      response: "I’ll lead with the key risks and source timestamps, then compare the available routes.",
    },
    {
      model: "Model B · Fast",
      modelDetail: "Synthetic speed-oriented option",
      prompt: "Use a different model to compare those routes.",
      retrievedContext: "Confirmed preference: lead with risk caveats and source freshness.",
      response: "The model changed, but Pilot still supplied your reviewed risk-first, source-aware format.",
    },
  ] satisfies readonly ModelSwitchStep[],
} as const;

export const privacyBoundaries = [
  "Synthetic examples only—no real conversations, wallet addresses, balances, or transactions.",
  "Relevant authorized context only; model selection does not unlock whole-history access.",
  "Inferred or unverified observations require user review before retention.",
  "Stored preferences and lessons can be corrected or forgotten; validated ledger history remains immutable.",
  "Personalization improves continuity, not guaranteed performance or profitability.",
] as const;

export function getExplainerStage(id: string): ExplainerStage | undefined {
  return explainerStages.find((stage) => stage.id === id);
}
