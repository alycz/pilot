import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.join(process.cwd(), "components/onboarding/onboarding-flow.tsx"),
  "utf8",
);

describe("MP3 onboarding integration", () => {
  it("keeps the AWS model picker gated by the existing OAuth state", () => {
    expect(source).toContain("<ModelPicker");
    expect(source).toContain('bedrockMode: oauthConnected ? bedrockMode : "off"');
    expect(source).toContain("oauthConnected\n      ? continueOpenRouter\n      : startDemo");
    expect(source).toContain('loadCatalog("near-ai")');
    expect(source).toContain("mode: \"near-ai\", provider: \"near-ai\", model");
  });

  it("connects hash-only Open Finance verification to explicit mandate approval", () => {
    expect(source).toContain("<OpenFinanceStep");
    expect(source).toContain("customer_ref_hash: openFinance.customer_ref_hash");
    expect(source).not.toMatch(/customer_ref:\s*openFinance/);
    expect(source).toContain("<MandateApprovalCard");
    expect(source).toContain("onApprove={approveMandate}");
    expect(source).toContain("approveAndRegisterMandate(");
  });

  it("uses sign-only submission and the server-only MP5 vault writer without persisting VIs", () => {
    expect(source).toContain('harbor.op("tx.submit"');
    expect(source).toContain('harbor.op("mandate.register"');
    expect(source).toContain('fetch("/api/vault/ap4m/mandate"');
    expect(source).not.toContain('from "@pilot/vault"');
    expect(source).toContain("setPreparedMandate(undefined)");
    expect(source).not.toContain("signAndSubmit");
    expect(source).not.toMatch(/sessionStorage\.setItem\([\s\S]{0,200}\bl[12]:/);
  });
});
