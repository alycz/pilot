import { GuardrailNoticeSchema } from "@pilot/agent/guardrail-notice";
import { CardEventSchema } from "@pilot/contracts";
import { describe, expect, it } from "vitest";

import {
  allCardStateEvents,
  cardStates,
  demoGuardrailNotice,
  demoQuickNodeFreezeNotice,
  fixtureGuardrailNotice,
  fixtureQuickNodeFreezeNotice,
  fixtureSequence,
} from "./fixtures";

describe("chat card fixtures", () => {
  it("covers every CardState contract value with valid events", () => {
    expect(allCardStateEvents.map((event) => event.state)).toEqual(cardStates);
    expect(allCardStateEvents).toHaveLength(10);
    for (const event of allCardStateEvents) {
      expect(CardEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it("takes the approval path for non-delegable and over-limit prompts", () => {
    const vault = fixtureSequence("Deposit 100 XRP into the vault").at(-1);
    const swap = fixtureSequence("Swap 500 RLUSD for XRP with owner approval").at(-1);
    expect(vault?.state).toBe("awaiting_approval");
    expect(vault?.intent.kind).toBe("vault_deposit");
    expect(vault?.build?.tx_json.TransactionType).toBe("VaultDeposit");
    expect(swap?.state).toBe("awaiting_approval");
    expect(swap?.intent.kind).toBe("swap");
    expect(swap?.intent.kind === "swap" ? swap.intent.amount : undefined).toBe("500");
  });

  it("never continues after a policy block", () => {
    const sequence = fixtureSequence("Swap 5,000 RLUSD into FREEMONEY");
    expect(sequence.at(-1)?.state).toBe("blocked");
    expect(sequence.some((event) => event.state === "executing")).toBe(false);
    expect(sequence.some((event) => event.state === "submitted")).toBe(false);
  });

  it("ends the logged-out demo with complete AWS and QuickNode mock trust", () => {
    const sequence = fixtureSequence("Swap 80 RLUSD for XRP");
    const validated = sequence.at(-1);

    expect(validated?.state).toBe("validated");
    expect(CardEventSchema.safeParse(validated).success).toBe(true);
    expect(validated?.trust).toEqual({
      screen: {
        provider: "mock",
        fields_checked: 3,
        fields_blocked: 1,
        max_score: 0.95,
      },
      model: {
        provider: "bedrock-mock",
        id: "anthropic.claude-sonnet-4-5-v1:0",
      },
      signer: {
        kind: "aws-kms-kek",
        key_ref: "alias/harbor/kek",
      },
      rpc: "quicknode-mock",
      confirmation: {
        provider: "quicknode-mock",
        at: "2026-10-18T00:00:04.200Z",
        latency_ms: 4_200,
      },
      watch: {
        provider: "quicknode-mock",
        status: "watching",
      },
    });
  });

  it("provides a bounded logged-out QuickNode freeze fixture", () => {
    expect(fixtureQuickNodeFreezeNotice("Show the QuickNode Streams freeze")).toEqual(
      demoQuickNodeFreezeNotice,
    );
    expect(fixtureQuickNodeFreezeNotice("Swap 80 RLUSD for XRP")).toBeUndefined();
    expect(demoQuickNodeFreezeNotice).toEqual({
      tx_hash: "B".repeat(64),
      ledger_index: 9_843_207,
      network: "testnet",
    });
    expect(JSON.stringify(demoQuickNodeFreezeNotice)).not.toContain("memo");
  });

  it("returns a bounded canonical notice only for the injection demo", () => {
    expect(GuardrailNoticeSchema.safeParse(demoGuardrailNotice).success).toBe(true);
    expect(demoGuardrailNotice).toEqual({
      provider: "mock",
      caveat: "screened-redacted",
      fields_checked: 3,
      fields_blocked: 1,
      blocked_field_kinds: ["token-description"],
    });
    expect(fixtureGuardrailNotice("Run the logged-out injection demo")).toEqual(
      demoGuardrailNotice,
    );
    expect(fixtureGuardrailNotice("Swap 80 RLUSD for XRP")).toBeUndefined();
    expect(fixtureGuardrailNotice("Swap 5,000 RLUSD into FREEMONEY")).toBeUndefined();

    const serialized = JSON.stringify(demoGuardrailNotice);
    expect(serialized).not.toContain("field_path");
    expect(serialized).not.toContain("raw_output");
    expect(serialized).not.toContain("field_value");
  });
});
