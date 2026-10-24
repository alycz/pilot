/**
 * Turns a failed `POST /api/auth/openrouter/session` (demo mode) response into
 * a specific, plain-language explanation. Presentation only: it never retries,
 * bypasses or changes the request.
 */

export type StepFailure = { message: string; code: string };

const ENDPOINT = "POST /api/auth/openrouter/session";

/** An Error that also carries a short diagnostic line for the onboarding alert. */
export class OnboardingStepError extends Error {
  readonly code: string;

  constructor(failure: StepFailure) {
    super(failure.message);
    this.name = "OnboardingStepError";
    this.code = failure.code;
  }
}

function parseBody(bodyText: string): { error?: string; code?: string } {
  if (!bodyText.trim()) return {};
  try {
    const parsed = JSON.parse(bodyText) as { error?: unknown; code?: unknown };
    return {
      error: typeof parsed.error === "string" && parsed.error.trim() ? parsed.error.trim() : undefined,
      code: typeof parsed.code === "string" ? parsed.code : undefined,
    };
  } catch {
    return {};
  }
}

const SECRET_GUIDANCE =
  "Set SESSION_SECRET (at least 32 characters) in apps/web/.env.local and restart the dev server.";

export function describeDemoSessionFailure(status: number, bodyText: string): StepFailure {
  const { error: reported, code: serverCode } = parseBody(bodyText);
  const code = `${ENDPOINT} · HTTP ${status}${serverCode ? ` · ${serverCode}` : ""}${reported ? ` · ${reported}` : ""}`;

  if (serverCode === "SESSION_UNAVAILABLE") {
    return {
      message: `Free models can't start: the server has no usable session secret${reported ? ` (${reported})` : ""}. ${SECRET_GUIDANCE}`,
      code,
    };
  }

  if (reported) {
    if (/SESSION_SECRET/.test(reported)) {
      return {
        message: `Free models can't start: the server's session secret isn't usable (${reported}). ${SECRET_GUIDANCE}`,
        code,
      };
    }
    if (/only supports :free models/i.test(reported)) {
      return {
        message: "Only free models are available without an OpenRouter account. Pick a model marked “(free)” and try again.",
        code,
      };
    }
    return { message: `Free models can't start: ${reported}`, code };
  }

  if (status >= 500) {
    // The route seals the demo session with SESSION_SECRET; when that secret is
    // missing or too short the server throws before it can return a JSON body.
    return {
      message:
        "Free models can't start: Pilot's server failed while creating the demo session. " +
        "The session is sealed with SESSION_SECRET; an empty server error at this step usually means it is missing or shorter than 32 characters. " +
        `${SECRET_GUIDANCE} Chatting on the free demo also needs the server-only DEMO_OPENROUTER_API_KEY and a verified free-only quota configuration.`,
      code,
    };
  }

  return {
    message: "Free models can't start: the server rejected the request without a reason.",
    code,
  };
}
