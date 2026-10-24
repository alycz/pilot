import { describe, expect, it } from "vitest";

import {
  ChatRequestGate,
  chatRequestModePolicy,
  inferRequestMode,
  parseChatRequestMode,
  resolveRequestMode,
} from "./request-mode";

describe("ChatRequestGate", () => {
  it("admits one synchronous dispatch and reopens only after release", () => {
    const gate = new ChatRequestGate();
    expect(gate.enter()).toBe(true);
    expect(gate.enter()).toBe(false);
    gate.leave();
    expect(gate.enter()).toBe(true);
  });
});

describe("chat request mode", () => {
  it("keeps ordinary questions read-only even when they contain cadence words", () => {
    expect(inferRequestMode("What is my daily budget?")) .toBe("read_only");
    expect(inferRequestMode("Show my portfolio")) .toBe("read_only");
    expect(inferRequestMode("Explain autonomous strategies")) .toBe("read_only");
  });

  it("recommends bounded modes only from explicit request evidence", () => {
    expect(inferRequestMode("Swap 80 RLUSD for XRP")) .toBe("one_time");
    expect(inferRequestMode("Buy 10 RLUSD of XRP every day")) .toBe("recurring");
    expect(inferRequestMode("Create an autonomous XRP allocation strategy")) .toBe("autonomous");
    expect(inferRequestMode("Trade XRP")) .toBe("clarify");
  });

  it("uses Let agent choose as a recommendation, while explicit selection wins", () => {
    expect(resolveRequestMode("auto", "Trade XRP")).toMatchObject({
      effective: "clarify",
      explicit: false,
      label: "Needs scope",
    });
    expect(resolveRequestMode("one_time", "Buy 10 RLUSD of XRP every day")).toMatchObject({
      recommendation: "recurring",
      effective: "one_time",
      explicit: true,
    });
  });

  it("rejects unknown client modes and constrains ambiguous auto server-side", () => {
    expect(parseChatRequestMode(undefined)).toBe("auto");
    expect(() => parseChatRequestMode("forever")).toThrow("invalid");
    const policy = chatRequestModePolicy("auto", "Trade XRP");
    expect(policy).toContain("Let agent choose");
    expect(policy).toContain("Do not call any risk-bearing transaction or strategy tool");
    expect(policy).toContain("never consent");
    expect(policy).toContain("execution authority");
  });

  it("makes the approval boundary exact for every mode", () => {
    expect(resolveRequestMode("one_time", "swap 10 RLUSD for XRP").review).toContain("run once only");
    expect(resolveRequestMode("recurring", "buy 10 RLUSD every day").review).toContain("exact schedule");
    expect(resolveRequestMode("autonomous", "rebalance autonomously").review).toContain("semantics version");
    expect(resolveRequestMode("auto", "What is XRP?").review).toContain("no transaction");
  });

  it("requires a finite immutable-mandate action cap for recurring proposals", () => {
    const recurring = chatRequestModePolicy("recurring", "buy 10 RLUSD every day");
    expect(recurring).toContain("max_mandate_occurrences");
    expect(recurring).toContain("reserved, committed, or outcome-unknown");
    expect(recurring).toContain("retrying the same decision does not count twice");
    expect(recurring).toContain("separate from the owner/account/asset lifetime max_total_trades counter");
    expect(recurring).toContain("Do not invent reset behavior");
  });
});
