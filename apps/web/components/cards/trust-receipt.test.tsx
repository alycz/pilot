import type { CardEvent } from "@pilot/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TrustReceipt } from "./trust-receipt";

type CardTrust = NonNullable<CardEvent["trust"]>;

function render(trust?: CardEvent["trust"] | null): string {
  return renderToStaticMarkup(createElement(TrustReceipt, { trust }));
}

describe("TrustReceipt", () => {
  it("renders an accessible complete AWS trust receipt without screened values", () => {
    const markup = render({
      screen: {
        provider: "aws-bedrock-guardrails",
        fields_checked: 3,
        fields_blocked: 1,
        max_score: 0.92,
      },
      model: { provider: "bedrock", id: "anthropic.claude-sonnet-4-5-v1:0" },
      signer: { kind: "aws-kms", key_ref: "alias/harbor/user-demo" },
    });

    expect(markup).toContain('aria-label="AWS trust receipt"');
    expect(markup).toContain("Screened by Bedrock Guardrails");
    expect(markup).toContain("3 fields checked · 1 field blocked");
    expect(markup).toContain("Maximum score: 0.92");
    expect(markup).toContain("Screened content was redacted before model use.");
    expect(markup).toContain("Model · Amazon Bedrock");
    expect(markup).toContain("anthropic.claude-sonnet-4-5-v1:0");
    expect(markup).toContain("Signed by AWS KMS");
    expect(markup).toContain("alias/harbor/user-demo");
  });

  it("labels explicit mock providers without inferring a mock KMS signer", () => {
    const markup = render({
      screen: { provider: "mock", fields_checked: 2, fields_blocked: 0 },
      model: { provider: "bedrock-mock", id: "openai/gpt-oss-120b:free" },
      signer: { kind: "aws-kms-kek", key_ref: "alias/harbor/kek" },
    });

    expect(markup).toContain("Screened by Bedrock Guardrails (mock)");
    expect(markup).toContain("Model · Amazon Bedrock (mock)");
    expect(markup).toContain("Key protected by AWS KMS");
    expect(markup).toContain("alias/harbor/kek");
    expect(markup).not.toMatch(/KMS \(mock\)|mock KMS/i);
  });

  it("supports the explicit light receipt context", () => {
    const markup = renderToStaticMarkup(createElement(TrustReceipt, {
      appearance: "light",
      trust: {
        screen: { provider: "mock", fields_checked: 1, fields_blocked: 0 },
      },
    }));

    expect(markup).toContain("border-slate-300");
    expect(markup).toContain("text-slate-800");
    expect(markup).not.toContain("bg-secondary/60");
  });

  it("renders the live QuickNode RPC, webhook, and Streams chips beside AWS trust", () => {
    const markup = render({
      screen: { provider: "mock", fields_checked: 2, fields_blocked: 0 },
      rpc: "quicknode",
      confirmation: {
        provider: "quicknode-webhook",
        at: "2026-10-21T12:00:04.200Z",
        latency_ms: 4_200,
      },
      watch: { provider: "quicknode-streams", status: "watching" },
    });

    expect(markup).toContain('aria-label="AWS and QuickNode trust receipt"');
    expect(markup).toContain("RPC · QuickNode");
    expect(markup).toContain("Confirmed · QuickNode webhook · 4.2 s");
    expect(markup).toContain("Watched · QuickNode Streams");
  });

  it("labels local QuickNode stand-ins and never presents them as live evidence", () => {
    const markup = render({
      rpc: "quicknode-mock",
      confirmation: {
        provider: "quicknode-mock",
        at: "2026-10-21T12:00:04.200Z",
        latency_ms: 4_200,
      },
      watch: { provider: "quicknode-mock", status: "frozen" },
    });

    expect(markup).toContain('aria-label="QuickNode trust receipt"');
    expect(markup).toContain("RPC · QuickNode (mock)");
    expect(markup).toContain("Confirmed · QuickNode webhook (mock) · 4.2 s");
    expect(markup).toContain("Watched · QuickNode Streams (mock)");
    expect(markup).toContain("local stand-in evidence, not a live QuickNode");
  });

  it("collapses signed-out demo provenance into one label with neutral capability names", () => {
    const markup = renderToStaticMarkup(createElement(TrustReceipt, {
      presentation: "demo",
      trust: {
        screen: { provider: "mock", fields_checked: 3, fields_blocked: 1 },
        model: { provider: "bedrock-mock", id: "anthropic.claude-sonnet-4-5-v1:0" },
        signer: { kind: "aws-kms-kek", key_ref: "alias/harbor/kek" },
        rpc: "quicknode-mock",
        confirmation: {
          provider: "quicknode-mock",
          at: "2026-10-21T12:00:04.200Z",
          latency_ms: 4_200,
        },
        watch: { provider: "quicknode-mock", status: "watching" },
      },
    }));

    expect(markup).toContain('aria-label="Demo capability preview"');
    for (const label of [
      "Bedrock Guardrails",
      "Amazon Bedrock",
      "AWS KMS",
      "QuickNode RPC",
      "QuickNode webhook",
      "QuickNode Streams",
    ]) expect(markup).toContain(label);
    expect(markup.match(/>Demo</g)).toHaveLength(1);
    expect(markup).not.toMatch(/\(mock\)|Screened by|Model ·|Key protected by|RPC ·|Confirmed ·|Watched ·/);
  });

  it("renders fallback and polling states and hides monitoring when off", () => {
    const markup = render({
      rpc: "fallback",
      confirmation: {
        provider: "poll",
        at: "2026-10-21T12:00:04.200Z",
        latency_ms: 4_200,
      },
      watch: { provider: "off", status: "watching" },
    });

    expect(markup).toContain("Fallback node");
    expect(markup).toContain("Confirmed · polling");
    expect(markup).not.toContain("Watched · QuickNode Streams");
  });

  it("distinguishes unavailable screening from off screening", () => {
    const unavailable = render({
      screen: { provider: "unavailable", fields_checked: 0, fields_blocked: 0 },
    });
    expect(unavailable).toContain("Guardrail screening unavailable");
    expect(unavailable).toContain("0 fields checked · 0 fields blocked");
    expect(unavailable).toContain("no screening claim is made");

    const unavailableWithBlockedCount = render({
      screen: { provider: "unavailable", fields_checked: 2, fields_blocked: 1 },
    });
    expect(unavailableWithBlockedCount).not.toContain("Screened content was redacted");

    expect(render({ screen: { provider: "off", fields_checked: 0, fields_blocked: 0 } })).toBe("");
  });

  it("renders OpenRouter and local signer states without showing a local key reference", () => {
    const trust = {
      model: { provider: "openrouter", id: "openai/gpt-4o-mini" },
      signer: { kind: "local", key_ref: "alias/must-not-render" },
    } as CardTrust;
    const markup = render(trust);

    expect(markup).toContain("Model · OpenRouter");
    expect(markup).toContain("openai/gpt-4o-mini");
    expect(markup).toContain("Signed locally");
    expect(markup).not.toContain("alias/must-not-render");
  });

  it("fails soft for absent, empty, and unknown trust states", () => {
    expect(render()).toBe("");
    expect(render(null)).toBe("");
    expect(render({})).toBe("");
    expect(
      render({
        screen: { provider: "future-provider", fields_checked: 1, fields_blocked: 0 },
        model: { provider: "future-provider", id: "future-model" },
        signer: { kind: "future-signer" },
      } as unknown as CardTrust),
    ).toBe("");
  });

  it("never renders injected field paths or raw tool output and escapes the model id", () => {
    const markup = render({
      screen: {
        provider: "mock",
        fields_checked: 1,
        fields_blocked: 1,
        field: "MemoData",
        raw_output: "RAW_TOOL_OUTPUT_SENTINEL",
      },
      model: { provider: "openrouter", id: "provider/<script>alert(1)</script>" },
    } as unknown as CardTrust);

    expect(markup).toContain("Screened content was redacted before model use.");
    expect(markup).not.toContain("MemoData");
    expect(markup).not.toContain("RAW_TOOL_OUTPUT_SENTINEL");
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;");
  });
});
