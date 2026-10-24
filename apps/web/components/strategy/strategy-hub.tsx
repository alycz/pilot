"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { demoHoldForTick, demoTradeForTick, type DemoStrategyPlan, type DemoTrade } from "./demo-strategy";
import { useStrategyController, type StrategyClient, type StrategyController } from "./use-strategy-controller";

export type DemoStrategyStatus = "ready_to_sign" | "signing" | "running" | "paused" | "stopped";

export type DemoStrategy = {
  cardId: string;
  plan: DemoStrategyPlan;
  status: DemoStrategyStatus;
  trades: DemoTrade[];
  checks: number;
  lastResult?: string;
  usedToday: number;
};

export type StrategyCardLink = { cardId: string; strategyId: string; mandateDigest: string; mandateVersion: number };

type StrategyHub = {
  controller: StrategyController;
  /** The chat card and the exact strategy mandate it created. */
  link?: StrategyCardLink;
  /** Card whose set-up request is in flight. */
  settingUpCardId?: string;
  setUpFromCard: (cardId: string, input: Record<string, unknown> & { expires_at: string }) => Promise<void>;
  demo?: DemoStrategy;
  demoSetUp: (cardId: string, plan: DemoStrategyPlan) => void;
  demoSign: () => void;
  demoPause: () => void;
  demoResume: () => void;
  demoStop: () => void;
  demoDiscard: () => void;
  managerOpen: boolean;
  openManager: () => void;
  closeManager: () => void;
};

const StrategyHubContext = createContext<StrategyHub | null>(null);

const DEMO_TICK_MS = 4_000;
const DEMO_SIGN_MS = 1_400;

/**
 * One strategy controller per browser tab, shared by the chat cards, the
 * sidebar block and the strategy manager panel. Signed-out visitors get a
 * local demo strategy instead; it never calls an API.
 */
export function StrategyHubProvider({ children, client }: { children: ReactNode; client?: StrategyClient }) {
  const controller = useStrategyController(client);
  const [link, setLink] = useState<StrategyCardLink>();
  const [settingUpCardId, setSettingUpCardId] = useState<string>();
  const [demo, setDemo] = useState<DemoStrategy>();
  const [managerOpen, setManagerOpen] = useState(false);
  const seedRef = useRef(0);

  const createFromProposal = controller.createFromProposal;
  const setUpFromCard = useCallback(async (cardId: string, input: Record<string, unknown> & { expires_at: string }) => {
    setSettingUpCardId(cardId);
    try {
      const created = await createFromProposal(input);
      if (created) setLink({ cardId, strategyId: created.strategy_id, mandateDigest: created.mandate.digest, mandateVersion: created.mandate.version });
    } finally {
      setSettingUpCardId(undefined);
    }
  }, [createFromProposal]);

  const demoSetUp = useCallback((cardId: string, plan: DemoStrategyPlan) => {
    seedRef.current += 1;
    setDemo({ cardId, plan, status: "ready_to_sign", trades: [], checks: 0, usedToday: 0 });
  }, []);
  const demoSign = useCallback(() => {
    setDemo((current) => current && current.status === "ready_to_sign" ? { ...current, status: "signing" } : current);
  }, []);
  const demoPause = useCallback(() => setDemo((current) => current?.status === "running" ? { ...current, status: "paused", lastResult: "Paused by you. No new trades." } : current), []);
  const demoResume = useCallback(() => setDemo((current) => current?.status === "paused" ? { ...current, status: "running", lastResult: "Resumed. Next check soon." } : current), []);
  const demoStop = useCallback(() => setDemo((current) => current && current.status !== "stopped" ? { ...current, status: "stopped", lastResult: "Stopped by you. It won't trade again." } : current), []);
  const demoDiscard = useCallback(() => setDemo(undefined), []);

  const demoStatus = demo?.status;
  useEffect(() => {
    if (demoStatus !== "signing") return;
    const timer = window.setTimeout(() => {
      setDemo((current) => current?.status === "signing" ? { ...current, status: "running", lastResult: "Signed. First check starts now." } : current);
    }, DEMO_SIGN_MS);
    return () => window.clearTimeout(timer);
  }, [demoStatus]);

  useEffect(() => {
    if (demoStatus !== "running") return;
    const interval = window.setInterval(() => {
      setDemo((current) => {
        if (!current || current.status !== "running") return current;
        const tick = current.checks + 1;
        const trade = demoTradeForTick(current.plan.kind, tick, seedRef.current);
        const value = trade ? Number(/([\d.]+) RLUSD/.exec(trade.summary)?.[1] ?? 0) : 0;
        return {
          ...current,
          checks: tick,
          trades: trade ? [...current.trades, trade] : current.trades,
          usedToday: Math.min(current.plan.dailyCap, current.usedToday + value),
          lastResult: trade ? "Traded. See the receipt below." : demoHoldForTick(current.plan.kind, tick),
        };
      });
    }, DEMO_TICK_MS);
    return () => window.clearInterval(interval);
  }, [demoStatus]);

  // Real strategies replace the demo the moment a wallet session appears.
  const mode = controller.context?.mode;
  useEffect(() => {
    if (mode === "real") setDemo(undefined);
  }, [mode]);

  const openManager = useCallback(() => setManagerOpen(true), []);
  const closeManager = useCallback(() => setManagerOpen(false), []);

  const value = useMemo<StrategyHub>(() => ({
    controller, link, settingUpCardId, setUpFromCard,
    demo, demoSetUp, demoSign, demoPause, demoResume, demoStop, demoDiscard,
    managerOpen, openManager, closeManager,
  }), [closeManager, controller, demo, demoDiscard, demoPause, demoResume, demoSetUp, demoSign, demoStop, link, managerOpen, openManager, settingUpCardId, setUpFromCard]);

  return <StrategyHubContext.Provider value={value}>{children}</StrategyHubContext.Provider>;
}

export function useStrategyHub(): StrategyHub {
  const hub = useContext(StrategyHubContext);
  if (!hub) throw new Error("useStrategyHub must be used inside StrategyHubProvider.");
  return hub;
}

export function useOptionalStrategyHub(): StrategyHub | null {
  return useContext(StrategyHubContext);
}
