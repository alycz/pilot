"use client";

import type { LedgerDeviceState, PilotWallet } from "@pilot/wallet";
import { useCallback, useEffect, useRef, useState } from "react";

export type LedgerButton = "left" | "right" | "both";

export const LEDGER_SCREENSHOT_PATH = "/api/ledger-sim/screenshot";
export const LEDGER_EVENTS_PATH = "/api/ledger-sim/events?stream=true";
export const LEDGER_POLL_INTERVAL_MS = 300;

type LedgerScreenResponse = Pick<Response, "ok" | "blob">;

export interface LedgerScreenRefreshController {
  refresh(): Promise<void>;
  dispose(): void;
}

interface LedgerScreenRefreshControllerOptions {
  fetchScreen(): Promise<LedgerScreenResponse>;
  createObjectUrl(blob: Blob): string;
  revokeObjectUrl(url: string): void;
  commit(url: string): void;
}

const IDLE_STATE: LedgerDeviceState = Object.freeze({
  interaction: "none",
  busy: false,
});

export function ledgerButtonForKey(key: string): LedgerButton | undefined {
  if (key === "ArrowLeft") return "left";
  if (key === "ArrowRight") return "right";
  if (key === "Enter" || key === "ArrowDown") return "both";
  return undefined;
}

export function virtualLedgerButtonRequest(button: LedgerButton): readonly [
  string,
  RequestInit,
] {
  return [
    `/api/ledger-sim/button/${button}`,
    {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "press-and-release" }),
    },
  ];
}

export function createLedgerScreenRefreshController({
  fetchScreen,
  createObjectUrl,
  revokeObjectUrl,
  commit,
}: LedgerScreenRefreshControllerOptions): LedgerScreenRefreshController {
  let generation = 0;
  let disposed = false;
  let currentUrl: string | undefined;

  return {
    async refresh() {
      const refreshGeneration = ++generation;
      try {
        const response = await fetchScreen();
        if (!response.ok) return;
        const nextUrl = createObjectUrl(await response.blob());
        if (disposed || refreshGeneration !== generation) {
          revokeObjectUrl(nextUrl);
          return;
        }
        const previousUrl = currentUrl;
        currentUrl = nextUrl;
        commit(nextUrl);
        if (previousUrl !== undefined) revokeObjectUrl(previousUrl);
      } catch {
        // The caller's bounded fallback owns retries.
      }
    },
    dispose() {
      disposed = true;
      generation += 1;
      if (currentUrl !== undefined) revokeObjectUrl(currentUrl);
      currentUrl = undefined;
    },
  };
}

export function useLedgerDevice(
  wallet: Pick<PilotWallet, "onDeviceState"> | undefined,
) {
  const [state, setState] = useState<LedgerDeviceState>(IDLE_STATE);
  const [signed, setSigned] = useState(false);

  useEffect(() => {
    setState(IDLE_STATE);
    setSigned(false);
    return wallet?.onDeviceState?.((next) => {
      setState(next);
      if (next.busy) setSigned(false);
    });
  }, [wallet]);

  return {
    state,
    signed,
    markSigned: useCallback(() => setSigned(true), []),
    clearSigned: useCallback(() => setSigned(false), []),
  } as const;
}

export function useVirtualLedgerScreen(enabled = true) {
  const [screenSrc, setScreenSrc] = useState(LEDGER_SCREENSHOT_PATH);
  const [connected, setConnected] = useState(false);
  const refreshController = useRef<LedgerScreenRefreshController | undefined>(
    undefined,
  );

  const refresh = useCallback(
    () => refreshController.current?.refresh() ?? Promise.resolve(),
    [],
  );

  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      return;
    }
    const controller = createLedgerScreenRefreshController({
      fetchScreen: () =>
        fetch(LEDGER_SCREENSHOT_PATH, {
          cache: "no-store",
          credentials: "same-origin",
        }),
      createObjectUrl: (blob) => URL.createObjectURL(blob),
      revokeObjectUrl: (url) => URL.revokeObjectURL(url),
      commit: setScreenSrc,
    });
    refreshController.current = controller;
    void controller.refresh();
    let poll: number | undefined;
    let source: EventSource | undefined;
    const startPolling = () => {
      if (poll !== undefined) return;
      setConnected(false);
      poll = window.setInterval(
        () => void controller.refresh(),
        LEDGER_POLL_INTERVAL_MS,
      );
    };
    try {
      source = new EventSource(LEDGER_EVENTS_PATH, { withCredentials: true });
      source.onopen = () => setConnected(true);
      source.onmessage = () => void controller.refresh();
      source.onerror = () => {
        source?.close();
        source = undefined;
        startPolling();
      };
    } catch {
      startPolling();
    }
    return () => {
      source?.close();
      if (poll !== undefined) window.clearInterval(poll);
      controller.dispose();
      if (refreshController.current === controller) {
        refreshController.current = undefined;
      }
    };
  }, [enabled]);

  const press = useCallback(
    async (button: LedgerButton) => {
      if (!enabled) return;
      const [url, init] = virtualLedgerButtonRequest(button);
      try {
        await fetch(url, init);
      } catch {
        // The next SSE event or bounded poll refreshes the local-only panel.
      }
    },
    [enabled],
  );

  return { screenSrc, connected, refresh, press } as const;
}
