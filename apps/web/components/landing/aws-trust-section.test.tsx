import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AwsTrustSection } from "./aws-trust-section";

describe("AwsTrustSection", () => {
  it("renders exactly three named AWS protections in a light section", () => {
    const markup = renderToStaticMarkup(createElement(AwsTrustSection));

    expect(markup).toContain("Built on AWS");
    expect(markup).toContain("Bedrock Guardrails");
    expect(markup).toContain("Amazon Bedrock models");
    expect(markup).toContain("AWS KMS");
    expect(markup.match(/data-protection="aws"/g)).toHaveLength(3);
    expect(markup).toContain("bg-slate-50");
  });

  it("describes the architecture as an accessible ordered trust path", () => {
    const markup = renderToStaticMarkup(createElement(AwsTrustSection));

    expect(markup).toContain('aria-labelledby="aws-architecture-title"');
    expect(markup).toContain('aria-label="AWS trust path"');
    for (const stage of ["Untrusted data", "Guardrails", "Bedrock", "Harbor policy", "XRPL Testnet"]) {
      expect(markup).toContain(stage);
    }
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("https://");
  });
});
