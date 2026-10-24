import {
  CardEventSchema,
  WatchdogEventSchema,
  type CardEvent,
  type CardState,
} from "@pilot/contracts";
import {
  X402PaymentEventSchema,
  type X402PaymentEvent,
} from "@pilot/agent/x402";
import {
  GuardrailNoticeSchema,
  type GuardrailNotice,
} from "@pilot/agent/guardrail-notice";

export type PreferenceProposalEvent = {
  id: string;
  state: "proposed";
  preference: string;
  reason?: string;
  at: string;
  structured?: {
    recordId: string;
    revision: number;
    version: number;
    category: "communication" | "presentation" | "workflow" | "research";
    key: string;
    origin: "explicit" | "inferred";
    confidence: number;
  };
  workflowLesson?: {
    recordId: string;
    revision: number;
    version: number;
    target:
      | { category: "response_detail"; value: "concise" | "balanced" | "detailed" }
      | { category: "evidence_layout"; value: "summary_first" | "sources_first" | "comparison_table" }
      | { category: "approval_explanation"; value: "plain_language" | "technical_detail" | "step_by_step" }
      | { category: "comparison_emphasis"; value: "best_price_first" | "risk_caveats_first" | "balanced" }
      | { category: "research_risk_posture"; value: "capital_preservation_first" | "balanced" | "opportunity_first" };
  };
  hermesAdvisory?: {
    schemaVersion: "pilot.hermes-workflow-advisory.v1";
    summary: string;
    caveats: string[];
    disclosure: {
      provider: string;
      model: string;
      dataPolicy: "bounded-redacted-proposals";
      retentionDays: number;
      termsVersion: string;
    };
    usage: {
      callsRemainingToday: number;
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    };
  };
};

/**
 * The browser receives only the bounded fields needed to render the freeze
 * notice. Account names, flags, memos, and provider payloads never cross this
 * projection.
 */
export type QuickNodeFreezeNotice = {
  tx_hash: string;
  ledger_index: number;
  network: "testnet";
};

const XRPL_TRANSACTION_HASH = /^[A-F0-9]{64}$/;
const XRPL_ACCOUNT = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

export function quickNodeTestnetAccount(
  account: string | undefined,
  sessionNetwork: "testnet" | "devnet" | undefined,
  configuredNetwork: "testnet" | "devnet" | undefined,
): string | undefined {
  return account &&
    XRPL_ACCOUNT.test(account) &&
    sessionNetwork === "testnet" &&
    configuredNetwork === "testnet"
    ? account
    : undefined;
}

export function parseQuickNodeFreezeNotice(
  value: unknown,
  expectedAccount?: string,
): QuickNodeFreezeNotice | undefined {
  const parsed = WatchdogEventSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.action !== "frozen" ||
    parsed.data.class !== "out_of_band_delegate" ||
    !expectedAccount ||
    !XRPL_ACCOUNT.test(expectedAccount) ||
    parsed.data.account !== expectedAccount ||
    !XRPL_TRANSACTION_HASH.test(parsed.data.tx_hash)
  ) {
    return undefined;
  }
  return {
    tx_hash: parsed.data.tx_hash,
    ledger_index: parsed.data.ledger_index,
    network: "testnet",
  };
}

const STRUCTURED_CATEGORIES = new Set(["communication", "presentation", "workflow", "research"]);
const PREFERENCE_KEY = /^[a-z][a-z0-9_.-]{0,63}$/;
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function parseStructuredPreference(value: unknown): PreferenceProposalEvent["structured"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  if (
    Object.keys(entry).some((key) => ![
      "recordId", "revision", "version", "category", "key", "origin", "confidence",
    ].includes(key)) ||
    typeof entry.recordId !== "string" || !RECORD_ID.test(entry.recordId) ||
    !Number.isInteger(entry.revision) || Number(entry.revision) <= 0 ||
    !Number.isInteger(entry.version) || Number(entry.version) <= 0 ||
    typeof entry.category !== "string" || !STRUCTURED_CATEGORIES.has(entry.category) ||
    typeof entry.key !== "string" || !PREFERENCE_KEY.test(entry.key) ||
    (entry.origin !== "explicit" && entry.origin !== "inferred") ||
    typeof entry.confidence !== "number" || !Number.isFinite(entry.confidence) ||
    entry.confidence < 0 || entry.confidence > 1
  ) return undefined;
  return entry as PreferenceProposalEvent["structured"];
}

const WORKFLOW_LESSON_VALUES = {
  response_detail: new Set(["concise", "balanced", "detailed"]),
  evidence_layout: new Set(["summary_first", "sources_first", "comparison_table"]),
  approval_explanation: new Set(["plain_language", "technical_detail", "step_by_step"]),
  comparison_emphasis: new Set(["best_price_first", "risk_caveats_first", "balanced"]),
  research_risk_posture: new Set(["capital_preservation_first", "balanced", "opportunity_first"]),
} as const;

function parseWorkflowLesson(value: unknown): PreferenceProposalEvent["workflowLesson"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  if (
    Object.keys(entry).some((key) => !["recordId", "revision", "version", "target"].includes(key)) ||
    typeof entry.recordId !== "string" || !RECORD_ID.test(entry.recordId) ||
    !Number.isSafeInteger(entry.revision) || Number(entry.revision) <= 0 ||
    !Number.isSafeInteger(entry.version) || Number(entry.version) <= 0 ||
    !entry.target || typeof entry.target !== "object" || Array.isArray(entry.target)
  ) return undefined;
  const target = entry.target as Record<string, unknown>;
  if (Object.keys(target).some((key) => !["category", "value"].includes(key)) ||
      typeof target.category !== "string" || typeof target.value !== "string" ||
      !(target.category in WORKFLOW_LESSON_VALUES) ||
      !(WORKFLOW_LESSON_VALUES[target.category as keyof typeof WORKFLOW_LESSON_VALUES] as ReadonlySet<string>).has(target.value)) {
    return undefined;
  }
  return entry as PreferenceProposalEvent["workflowLesson"];
}

const HERMES_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const HERMES_SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function parseHermesAdvisory(value: unknown): PreferenceProposalEvent["hermesAdvisory"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).some((key) => ![
    "schemaVersion", "summary", "caveats", "disclosure", "usage",
  ].includes(key)) || entry.schemaVersion !== "pilot.hermes-workflow-advisory.v1" ||
    typeof entry.summary !== "string" || !entry.summary.trim() || entry.summary.length > 1_000 ||
    !Array.isArray(entry.caveats) || entry.caveats.length > 8 ||
    entry.caveats.some((item) => typeof item !== "string" || !item.trim() || item.length > 300) ||
    !entry.disclosure || typeof entry.disclosure !== "object" || Array.isArray(entry.disclosure) ||
    !entry.usage || typeof entry.usage !== "object" || Array.isArray(entry.usage)) return undefined;
  const disclosure = entry.disclosure as Record<string, unknown>;
  const usage = entry.usage as Record<string, unknown>;
  if (Object.keys(disclosure).some((key) => ![
    "provider", "model", "dataPolicy", "retentionDays", "termsVersion",
  ].includes(key)) || typeof disclosure.provider !== "string" ||
    disclosure.provider.length > 64 || !HERMES_SAFE_ID.test(disclosure.provider) ||
    typeof disclosure.model !== "string" || disclosure.model.length > 128 ||
    !HERMES_SAFE_MODEL.test(disclosure.model) ||
    disclosure.dataPolicy !== "bounded-redacted-proposals" ||
    !Number.isSafeInteger(disclosure.retentionDays) || Number(disclosure.retentionDays) < 1 ||
    Number(disclosure.retentionDays) > 30 || typeof disclosure.termsVersion !== "string" ||
    disclosure.termsVersion.length > 64 || !HERMES_SAFE_ID.test(disclosure.termsVersion)) return undefined;
  const usageKeys = ["callsRemainingToday", "promptTokens", "completionTokens", "totalTokens"];
  if (Object.keys(usage).some((key) => !usageKeys.includes(key)) ||
    !Number.isSafeInteger(usage.callsRemainingToday) || Number(usage.callsRemainingToday) < 0 ||
    Number(usage.callsRemainingToday) > 20 || ["promptTokens", "completionTokens", "totalTokens"]
      .some((key) => usage[key] !== undefined &&
        (!Number.isSafeInteger(usage[key]) || Number(usage[key]) < 0 || Number(usage[key]) > 1_000_000))) {
    return undefined;
  }
  if (
    usage.promptTokens !== undefined && usage.completionTokens !== undefined && usage.totalTokens !== undefined &&
    Number(usage.totalTokens) !== Number(usage.promptTokens) + Number(usage.completionTokens)
  ) return undefined;
  return entry as PreferenceProposalEvent["hermesAdvisory"];
}

type PilotStreamCallbacks = {
  signal: AbortSignal;
  quickNodeAccount?: string;
  onText: (delta: string) => void;
  onCard: (event: CardEvent) => void;
  onGuardrailNotice?: (notice: GuardrailNotice) => void;
  onQuickNodeFreeze?: (notice: QuickNodeFreezeNotice) => void;
  onPreference: (event: PreferenceProposalEvent) => void;
  onX402?: (event: X402PaymentEvent) => void;
};

const CARD_TRANSITIONS: Readonly<Record<CardState, readonly CardState[]>> = {
  drafting: ["planned", "failed"],
  planned: ["simulated", "failed"],
  simulated: ["policy_checked", "failed"],
  policy_checked: ["executing", "awaiting_approval", "blocked", "failed"],
  executing: ["submitted", "validated", "failed"],
  awaiting_approval: ["submitted", "failed"],
  blocked: [],
  submitted: ["validated", "failed"],
  validated: [],
  failed: [],
};

/**
 * Consumer-side counterpart to the agent's CardStateMachine. Each intent keeps
 * an independent history so interleaved card parts cannot advance one another.
 */
export class CardStreamTracker {
  private readonly historiesByIntent = new Map<string, CardEvent[]>();

  accept(event: CardEvent): boolean {
    if (event.intent_id !== event.intent.id) return false;

    const history = this.historiesByIntent.get(event.intent_id);
    const current = history?.at(-1)?.state;
    const allowed = current === undefined
      ? event.state === "drafting"
      : CARD_TRANSITIONS[current].includes(event.state);
    if (!allowed) return false;

    if (history) history.push(event);
    else this.historiesByIntent.set(event.intent_id, [event]);
    return true;
  }

  history(intentId: string): readonly CardEvent[] {
    return [...(this.historiesByIntent.get(intentId) ?? [])];
  }

  histories(): ReadonlyMap<string, readonly CardEvent[]> {
    return new Map(
      [...this.historiesByIntent].map(([intentId, history]) => [
        intentId,
        [...history],
      ]),
    );
  }
}

export async function consumePilotStream(response: Response, callbacks: PilotStreamCallbacks) {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  const cardTracker = new CardStreamTracker();
  const orderedCallbacks = {
    ...callbacks,
    onCard: (event: CardEvent) => {
      if (cardTracker.accept(event)) callbacks.onCard(event);
    },
  };
  let buffer = "";
  while (true) {
    callbacks.signal.throwIfAborted();
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) parsePilotStreamLine(rawLine, orderedCallbacks);
  }
  if (buffer) parsePilotStreamLine(buffer, orderedCallbacks);
}

export function parsePilotStreamLine(
  line: string,
  callbacks: Omit<PilotStreamCallbacks, "signal">,
) {
  const trimmed = line.trim();
  if (!trimmed || trimmed === "data: [DONE]") return;
  const payloadText = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  try {
    const payload = JSON.parse(payloadText) as {
      type?: string;
      data?: unknown;
      value?: unknown;
      delta?: unknown;
      textDelta?: unknown;
    };
    if (payload.type === "data-card") {
      const parsed = CardEventSchema.safeParse(payload.data ?? payload.value);
      if (parsed.success) callbacks.onCard(parsed.data);
    }
    if (payload.type === "data-preference") {
      const preference = parsePreferenceProposal(payload.data ?? payload.value);
      if (preference) callbacks.onPreference(preference);
    }
    if (payload.type === "data-x402") {
      const parsed = X402PaymentEventSchema.safeParse(payload.data ?? payload.value);
      if (parsed.success) callbacks.onX402?.(parsed.data);
    }
    if (payload.type === "data-guardrailNotice") {
      const parsed = GuardrailNoticeSchema.safeParse(
        payload.data ?? payload.value,
      );
      if (parsed.success) callbacks.onGuardrailNotice?.(parsed.data);
    }
    if (payload.type === "data-watchdog") {
      const notice = parseQuickNodeFreezeNotice(
        payload.data ?? payload.value,
        callbacks.quickNodeAccount,
      );
      if (notice) callbacks.onQuickNodeFreeze?.(notice);
    }
    if (payload.type === "text-delta") {
      const delta = payload.delta ?? payload.textDelta;
      if (typeof delta === "string") callbacks.onText(delta);
    }
  } catch {
    // Ignore transport heartbeats, malformed data, and unknown stream parts.
  }
}

export function parsePreferenceProposal(value: unknown): PreferenceProposalEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const proposal = value as Record<string, unknown>;
  const id = typeof proposal.id === "string" ? proposal.id.trim() : "";
  const preference = typeof proposal.preference === "string" ? proposal.preference.trim() : "";
  const reason = typeof proposal.reason === "string" ? proposal.reason.trim() : undefined;
  const at = typeof proposal.at === "string" ? proposal.at : "";
  const atMilliseconds = Date.parse(at);
  const structured = proposal.structured === undefined
    ? undefined
    : parseStructuredPreference(proposal.structured);
  const workflowLesson = proposal.workflowLesson === undefined
    ? undefined
    : parseWorkflowLesson(proposal.workflowLesson);
  const hermesAdvisory = proposal.hermesAdvisory === undefined
    ? undefined
    : parseHermesAdvisory(proposal.hermesAdvisory);
  if (
    !id || id.length > 128 ||
    proposal.state !== "proposed" ||
    !preference || preference.length > 500 ||
    !at || Number.isNaN(atMilliseconds) || new Date(atMilliseconds).toISOString() !== at ||
    (proposal.reason !== undefined && (reason === undefined || !reason || reason.length > 500)) ||
    (proposal.structured !== undefined && structured === undefined) ||
    (proposal.workflowLesson !== undefined && workflowLesson === undefined) ||
    (proposal.hermesAdvisory !== undefined &&
      (hermesAdvisory === undefined || workflowLesson === undefined))
  ) {
    return undefined;
  }
  return {
    id,
    state: "proposed",
    preference,
    ...(reason
      ? { reason }
      : {}),
    at,
    ...(structured ? { structured } : {}),
    ...(workflowLesson ? { workflowLesson } : {}),
    ...(hermesAdvisory ? { hermesAdvisory } : {}),
  };
}
