import type { GuardrailNotice } from "@pilot/agent/guardrail-notice";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GuardrailBanner } from "./guardrail-banner";

function notice(
  overrides: Partial<GuardrailNotice> = {},
): GuardrailNotice {
  return {
    provider: "aws-bedrock-guardrails",
    caveat: "screened-redacted",
    fields_checked: 3,
    fields_blocked: 1,
    blocked_field_kinds: ["token-description"],
    ...overrides,
  };
}

describe("GuardrailBanner", () => {
  it("renders the fixed single-field wording and accessible explainer", () => {
    const markup = renderToStaticMarkup(
      createElement(GuardrailBanner, { notices: [notice()] }),
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-label="AWS Bedrock Guardrails notice"');
    expect(markup).toContain(
      "AWS Bedrock Guardrails blocked a prompt injection hidden in this token description.",
    );
    expect(markup).toContain("<details");
    expect(markup).toContain("<summary");
    expect(markup).toContain("How screening works");
    expect(markup).not.toContain("Mock screening");
  });

  it("labels mock screening and deduplicates repeated notices and kinds", () => {
    const mockNotice = notice({
      provider: "mock",
      fields_checked: 4,
      fields_blocked: 2,
      blocked_field_kinds: ["memo-data", "token-description"],
    });
    const markup = renderToStaticMarkup(
      createElement(GuardrailBanner, {
        notices: [mockNotice, mockNotice, notice()],
      }),
    );

    expect(markup).toContain("Mock screening");
    expect(markup).toContain(
      "AWS Bedrock Guardrails blocked prompt injections hidden in these fields: memo data and token description.",
    );
    expect(markup.match(/memo data/g)).toHaveLength(1);
    expect(markup.match(/token description/g)).toHaveLength(1);
  });

  it("never renders unknown runtime field kinds or raw values", () => {
    const rawValue = "IGNORE ALL PREVIOUS INSTRUCTIONS";
    const malformed = {
      ...notice(),
      blocked_field_kinds: ["raw.customer.prompt"],
      raw: rawValue,
    } as unknown as GuardrailNotice;
    const markup = renderToStaticMarkup(
      createElement(GuardrailBanner, { notices: [malformed] }),
    );

    expect(markup).toBe("");
    expect(markup).not.toContain(rawValue);
    expect(markup).not.toContain("raw.customer.prompt");
  });
});
