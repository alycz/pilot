import { describe, expect, it } from "vitest";

import { describeDemoSessionFailure, OnboardingStepError } from "./demo-session-error";

describe("describeDemoSessionFailure", () => {
  it("maps the 503 SESSION_UNAVAILABLE shape to session-secret guidance", () => {
    const failure = describeDemoSessionFailure(
      503,
      JSON.stringify({ error: "SESSION_SECRET is not configured", code: "SESSION_UNAVAILABLE" }),
    );
    expect(failure.message).toContain("SESSION_SECRET");
    expect(failure.message).toContain("apps/web/.env.local");
    expect(failure.code).toContain("HTTP 503");
    expect(failure.code).toContain("SESSION_UNAVAILABLE");
  });

  it("explains an empty 500 as a session-secret problem and keeps the status line", () => {
    const failure = describeDemoSessionFailure(500, "");
    expect(failure.message).toMatch(/SESSION_SECRET/);
    expect(failure.message).toMatch(/DEMO_OPENROUTER_API_KEY/);
    expect(failure.code).toBe("POST /api/auth/openrouter/session · HTTP 500");
  });

  it("surfaces the server's own error text when present", () => {
    const failure = describeDemoSessionFailure(400, JSON.stringify({ error: "Invalid session body" }));
    expect(failure.message).toBe("Free models can't start: Invalid session body");
    expect(failure.code).toContain("HTTP 400 · Invalid session body");
  });

  it("maps the free-model rule to plain guidance", () => {
    const failure = describeDemoSessionFailure(400, JSON.stringify({ error: "Demo mode only supports :free models" }));
    expect(failure.message).toMatch(/Only free models are available/);
  });

  it("maps a reported SESSION_SECRET error", () => {
    const failure = describeDemoSessionFailure(400, JSON.stringify({ error: "SESSION_SECRET is not configured" }));
    expect(failure.message).toMatch(/apps\/web\/\.env\.local/);
  });

  it("ignores non-JSON bodies", () => {
    const failure = describeDemoSessionFailure(502, "<html>bad gateway</html>");
    expect(failure.code).toBe("POST /api/auth/openrouter/session · HTTP 502");
  });

  it("carries the code on the thrown error", () => {
    const error = new OnboardingStepError({ message: "m", code: "c" });
    expect(error.message).toBe("m");
    expect(error.code).toBe("c");
  });
});
