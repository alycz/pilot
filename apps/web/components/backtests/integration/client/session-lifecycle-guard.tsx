"use client";

import { useEffect } from "react";

import { WALLET_SESSION_CHANGED_EVENT } from "../../../../lib/harbor-browser";

import { clearStoredBacktestRuns, type BrowserStorage } from "./storage";

export const BACKTEST_SESSION_CHANNEL = "pilot.backtests.session.v1" as const;
export const BACKTEST_SESSION_INVALIDATED_EVENT = "pilot:backtest-session-invalidated" as const;

type SessionInvalidationChannel = Pick<BroadcastChannel, "addEventListener" | "removeEventListener" | "postMessage">;

export function registerBacktestSessionInvalidation(
  target: Pick<EventTarget, "addEventListener" | "removeEventListener" | "dispatchEvent">,
  storage: BrowserStorage,
  channel?: SessionInvalidationChannel,
): () => void {
  const clearAndNotify = () => {
    clearStoredBacktestRuns(storage);
    target.dispatchEvent(new Event(BACKTEST_SESSION_INVALIDATED_EVENT));
  };
  const invalidateAndBroadcast = () => {
    clearAndNotify();
    channel?.postMessage(WALLET_SESSION_CHANGED_EVENT);
  };
  target.addEventListener(WALLET_SESSION_CHANGED_EVENT, invalidateAndBroadcast);
  channel?.addEventListener("message", clearAndNotify);
  return () => {
    target.removeEventListener(WALLET_SESSION_CHANGED_EVENT, invalidateAndBroadcast);
    channel?.removeEventListener("message", clearAndNotify);
  };
}

/** Keeps research evidence isolated even when the wallet changes on another page. */
export function BacktestSessionLifecycleGuard() {
  useEffect(() => {
    const channel = typeof BroadcastChannel === "function"
      ? new BroadcastChannel(BACKTEST_SESSION_CHANNEL)
      : undefined;
    const stop = registerBacktestSessionInvalidation(globalThis, window.sessionStorage, channel);
    return () => {
      stop();
      channel?.close();
    };
  }, []);
  return null;
}
