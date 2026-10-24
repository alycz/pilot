import { describe, expect, it } from "vitest";

import { WALLET_SESSION_CHANGED_EVENT } from "../../../../lib/harbor-browser";
import { createEvidenceGenerationGuard } from "../../chat/evidence-generation";

import { BACKTEST_SESSION_STORAGE_KEY } from "./contracts";
import { BACKTEST_SESSION_INVALIDATED_EVENT, registerBacktestSessionInvalidation } from "./session-lifecycle-guard";

describe("backtest session lifecycle guard", () => {
  it("clears saved research when the wallet changes away from the research page", () => {
    const target = new EventTarget();
    let value: string | null = "saved research";
    const storage = {
      getItem: (key: string) => key === BACKTEST_SESSION_STORAGE_KEY ? value : null,
      setItem: (key: string, next: string) => { if (key === BACKTEST_SESSION_STORAGE_KEY) value = next; },
    };
    const stop = registerBacktestSessionInvalidation(target, storage);
    let invalidations = 0;
    target.addEventListener(BACKTEST_SESSION_INVALIDATED_EVENT, () => { invalidations += 1; });
    target.dispatchEvent(new Event(WALLET_SESSION_CHANGED_EVENT));
    expect(value).toBe("[]");
    expect(invalidations).toBe(1);
    stop();
    value = "new session research";
    target.dispatchEvent(new Event(WALLET_SESSION_CHANGED_EVENT));
    expect(value).toBe("new session research");
  });

  it("broadcasts invalidation without rebroadcasting a remote wallet change", () => {
    const target = new EventTarget();
    const channel = new EventTarget() as EventTarget & { sent: unknown[]; postMessage(value: unknown): void };
    channel.sent = [];
    channel.postMessage = (value) => channel.sent.push(value);
    let value = "saved research";
    const storage = { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } };
    const stop = registerBacktestSessionInvalidation(target, storage, channel);
    let invalidations = 0;
    target.addEventListener(BACKTEST_SESSION_INVALIDATED_EVENT, () => { invalidations += 1; });
    target.dispatchEvent(new Event(WALLET_SESSION_CHANGED_EVENT));
    expect(channel.sent).toEqual([WALLET_SESSION_CHANGED_EVENT]);
    expect(invalidations).toBe(1);
    value = "other tab research";
    channel.dispatchEvent(new Event("message"));
    expect(value).toBe("[]");
    expect(channel.sent).toHaveLength(1);
    expect(invalidations).toBe(2);
    stop();
  });

  it("makes a deferred chat evidence result stale after a remote invalidation", () => {
    const target = new EventTarget();
    const channel = new EventTarget() as EventTarget & { postMessage(value: unknown): void };
    channel.postMessage = () => undefined;
    const storage = { getItem: () => "saved", setItem: () => undefined };
    const generation = createEvidenceGenerationGuard();
    const deferredResultGeneration = generation.capture();
    target.addEventListener(BACKTEST_SESSION_INVALIDATED_EVENT, generation.invalidate);
    const stop = registerBacktestSessionInvalidation(target, storage, channel);
    channel.dispatchEvent(new Event("message"));
    expect(generation.accepts(deferredResultGeneration)).toBe(false);
    stop();
  });
});
