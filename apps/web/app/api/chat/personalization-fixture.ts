import {
  createVaultFromEnv,
  renderUntrustedPreferenceContext,
  retrieveAcceptedStructuredPreferences,
  type StructuredPreferenceScope,
  type StructuredPreferenceSnapshot,
  type WorkflowLessonSnapshot,
} from "@pilot/vault";

import {
  isPersonalizationFixtureBrowserRequest,
  readPersonalizationFixtureSession,
} from "../../../lib/personalization-fixture-session";
import { resolveStructuredPreferenceTenant } from "../../../lib/structured-preferences";
import {
  renderUntrustedWorkflowLessonContext,
} from "../../../lib/workflow-lessons";
import {
  currentRequestPreferenceKeys,
  rejectsRememberedPreferences,
} from "./handler";
import { parseChatRequestMode } from "../../../components/chat/request-mode";
import { parseHarnessPageContext } from "../../../components/harness-chat/page-context";

type FixtureEnvironment = Readonly<Record<string, string | undefined>>;
type FixtureVault = {
  readStructuredPreferences(scope: StructuredPreferenceScope): Promise<StructuredPreferenceSnapshot>;
  readWorkflowLessons(scope: StructuredPreferenceScope): Promise<WorkflowLessonSnapshot>;
};

type FixtureOptions = {
  environment?: FixtureEnvironment;
  vault?: FixtureVault;
};

function textFromMessages(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  for (const message of [...value].reverse()) {
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const entry = message as Record<string, unknown>;
    if (entry.role !== "user") continue;
    if (typeof entry.content === "string" && entry.content.trim()) return entry.content.trim();
    if (Array.isArray(entry.parts)) {
      const text = entry.parts
        .filter((part): part is { type: "text"; text: string } => Boolean(
          part && typeof part === "object" && !Array.isArray(part) &&
          (part as Record<string, unknown>).type === "text" &&
          typeof (part as Record<string, unknown>).text === "string",
        ))
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return undefined;
}

function streamResponse(message: string): Response {
  const id = "personalization-fixture";
  const part = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  return new Response([
    part({ type: "text-start", id }),
    part({ type: "text-delta", id, delta: message }),
    part({ type: "text-end", id }),
    "data: [DONE]\n\n",
  ].join(""), {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/event-stream; charset=utf-8",
      "x-vercel-ai-ui-message-stream": "v1",
    },
  });
}

function invalid(message: string): Response {
  return Response.json({ error: message }, {
    status: 400,
    headers: { "cache-control": "no-store" },
  });
}

/**
 * Development-only, retrieval-only chat harness for the Playwright
 * personalization lane. A valid fixture request is completed here and can
 * never reach model, Harbor, wallet-proof, tool, signing, or transaction code.
 * Invalid or disabled fixture cookies return undefined so the normal chat
 * authorization path remains authoritative.
 */
export async function maybeHandlePersonalizationFixtureChat(
  request: Request,
  options: FixtureOptions = {},
): Promise<Response | undefined> {
  const environment = options.environment ?? process.env;
  if (!isPersonalizationFixtureBrowserRequest(request, environment)) return undefined;
  const session = readPersonalizationFixtureSession(request, { environment });
  if (!session) return undefined;
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return invalid("Fixture chat requires application/json.");

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return invalid("Fixture chat requires a JSON object.");
  }
  if (Object.keys(body).some((key) =>
    key !== "messages" && key !== "model" && key !== "request_mode" && key !== "page_context"
  )) {
    return invalid("Fixture chat accepts only read-only message metadata.");
  }
  try {
    parseChatRequestMode(body.request_mode);
  } catch {
    return invalid("Fixture chat request mode is invalid.");
  }
  try {
    parseHarnessPageContext(body.page_context);
  } catch {
    return invalid("Fixture chat page context is invalid.");
  }
  const currentRequest = textFromMessages(body.messages);
  if (!currentRequest) return invalid("Fixture chat requires a user message.");

  const tenantId = resolveStructuredPreferenceTenant(environment);
  if (!tenantId) return undefined;
  const scope: StructuredPreferenceScope = {
    tenantId,
    owner: session.owner,
    network: session.network,
  };
  const vault = options.vault ?? createVaultFromEnv({
    VAULT_BACKEND: environment.VAULT_BACKEND,
    VAULT_PATH: environment.VAULT_PATH,
    VAULT_GITHUB_TOKEN: environment.VAULT_GITHUB_TOKEN,
    VAULT_REPO: environment.VAULT_REPO,
    PILOT_PERSONALIZATION_STATE_DIR: environment.PILOT_PERSONALIZATION_STATE_DIR,
    PILOT_STRUCTURED_PREFERENCES: environment.PILOT_STRUCTURED_PREFERENCES,
  });
  const [preferences, lessons] = await Promise.all([
    vault.readStructuredPreferences(scope),
    vault.readWorkflowLessons(scope),
  ]);
  const optedOut = rejectsRememberedPreferences(currentRequest);
  const acceptedPreferences = optedOut ? [] : retrieveAcceptedStructuredPreferences(preferences, {
    currentPreferenceKeys: currentRequestPreferenceKeys(currentRequest),
    maxRecords: 12,
    maxCharacters: 4_000,
  });
  const renderedPreferences = acceptedPreferences.length
    ? renderUntrustedPreferenceContext(acceptedPreferences, 4_000)
    : undefined;
  const renderedLessons = optedOut ? undefined : renderUntrustedWorkflowLessonContext(
    lessons.records
      .filter((record) => record.status === "accepted")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 8)
      .map((record) => ({ target: record.target, updatedAt: record.updatedAt })),
    currentRequest,
  );
  return streamResponse([
    "Personalization fixture response (read-only; transaction tools are disabled).",
    renderedPreferences ?? "No accepted structured preferences are active.",
    renderedLessons ?? "No accepted workflow lessons are active.",
  ].join("\n\n"));
}
