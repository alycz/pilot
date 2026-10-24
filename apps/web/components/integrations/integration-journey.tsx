"use client";

import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  RotateCcw,
} from "lucide-react";
import { motion } from "framer-motion";
import React, { useEffect, useMemo, useRef, useState } from "react";

import type {
  IntegrationExplainer,
  IntegrationTone,
} from "./types";

const toneStyles: Record<IntegrationTone, string> = {
  success: "border-executed/40 bg-executed/10 text-executed",
  approval: "border-approval/40 bg-approval/10 text-approval",
  blocked: "border-blocked/40 bg-blocked/10 text-blocked",
  degraded: "border-info/40 bg-info/10 text-info",
};

const accentStyles: Record<IntegrationExplainer["accent"], string> = {
  coral: "bg-primary",
  orange: "bg-approval",
  blue: "bg-info",
  graphite: "bg-foreground",
};

const accentSelectionStyles: Record<IntegrationExplainer["accent"], string> = {
  coral: "border-primary/50 bg-primary/[0.06]",
  orange: "border-approval/50 bg-approval/[0.06]",
  blue: "border-info/50 bg-info/[0.06]",
  graphite: "border-foreground/40 bg-foreground/[0.04]",
};

export function nextJourneyIndex(
  current: number,
  length: number,
  direction: "next" | "previous",
): number {
  if (length <= 0) return 0;
  return direction === "next"
    ? (current + 1) % length
    : (current - 1 + length) % length;
}

function useReducedMotion(): boolean | null {
  const [reduced, setReduced] = useState<boolean | null>(null);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function centerInHorizontalTrack(
  element: HTMLElement | null | undefined,
  behavior: ScrollBehavior,
) {
  const track = element?.closest<HTMLElement>("[data-horizontal-track]");
  if (!element || !track) return;
  const itemRect = element.getBoundingClientRect();
  const trackRect = track.getBoundingClientRect();
  const left = track.scrollLeft + itemRect.left - trackRect.left
    - (track.clientWidth - itemRect.width) / 2;
  track.scrollTo({ left, behavior });
}

export function IntegrationJourney({ explainer }: { explainer: IntegrationExplainer }) {
  const reducedMotion = useReducedMotion();
  const [scenarioId, setScenarioId] = useState(explainer.scenarios[0]?.id ?? "");
  const scenario = useMemo(
    () => explainer.scenarios.find((item) => item.id === scenarioId) ?? explainer.scenarios[0],
    [explainer.scenarios, scenarioId],
  );
  const [stepIndex, setStepIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const scenarioRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const stepRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const routeRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const steps = scenario?.steps ?? [];
  const step = steps[stepIndex] ?? steps[0];
  const activeNode = explainer.nodes.find((node) => node.id === step?.nodeId);
  const activeZone = explainer.zones.find((zone) => zone.id === activeNode?.zone);

  useEffect(() => {
    if (reducedMotion === false) setPlaying(true);
    if (reducedMotion === true) setPlaying(false);
  }, [reducedMotion]);

  useEffect(() => {
    if (!playing || reducedMotion !== false || steps.length < 2) return;
    const timer = window.setInterval(() => {
      setStepIndex((current) => nextJourneyIndex(current, steps.length, "next"));
    }, 4800);
    return () => window.clearInterval(timer);
  }, [playing, reducedMotion, steps.length, scenarioId]);

  useEffect(() => {
    const centerActiveItems = (behavior: ScrollBehavior) => {
      centerInHorizontalTrack(stepRefs.current[stepIndex], behavior);
      centerInHorizontalTrack(routeRefs.current[stepIndex], behavior);
    };
    centerActiveItems(reducedMotion === false ? "smooth" : "auto");
    const centerAfterResize = () => centerActiveItems("auto");
    window.addEventListener("resize", centerAfterResize);
    return () => window.removeEventListener("resize", centerAfterResize);
  }, [reducedMotion, scenarioId, stepIndex]);

  if (!scenario || !step || !activeNode || !activeZone) return null;

  const selectScenario = (id: string) => {
    setScenarioId(id);
    setStepIndex(0);
    setPlaying(reducedMotion === false);
  };

  const moveScenario = (index: number) => {
    const bounded = (index + explainer.scenarios.length) % explainer.scenarios.length;
    selectScenario(explainer.scenarios[bounded]?.id ?? scenario.id);
    scenarioRefs.current[bounded]?.focus();
  };

  const selectStep = (index: number) => {
    setStepIndex(index);
    setPlaying(false);
  };

  const moveStep = (direction: "next" | "previous") => {
    setStepIndex((current) => nextJourneyIndex(current, steps.length, direction));
    setPlaying(false);
  };

  return (
    <div className="border border-border-strong bg-card" data-integration-journey={explainer.slug}>
      <div className="grid border-b border-border lg:grid-cols-[0.82fr_1.18fr]">
        <div className="border-b border-border p-5 sm:p-6 lg:border-b-0 lg:border-r">
          <p className="label-mono">Choose an outcome</p>
          <div className="mt-4 grid gap-2" role="radiogroup" aria-label={`${explainer.name} outcome`}>
            {explainer.scenarios.map((item, index) => (
              <button
                key={item.id}
                ref={(element) => { scenarioRefs.current[index] = element; }}
                type="button"
                role="radio"
                aria-checked={item.id === scenario.id}
                tabIndex={item.id === scenario.id ? 0 : -1}
                onClick={() => selectScenario(item.id)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" || event.key === "ArrowRight") {
                    event.preventDefault();
                    moveScenario(index + 1);
                  } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
                    event.preventDefault();
                    moveScenario(index - 1);
                  } else if (event.key === "Home") {
                    event.preventDefault();
                    moveScenario(0);
                  } else if (event.key === "End") {
                    event.preventDefault();
                    moveScenario(explainer.scenarios.length - 1);
                  }
                }}
                className={`bracket min-h-11 border px-3 py-3 text-left transition ${
                  item.id === scenario.id
                    ? `bracket-accent ${toneStyles[item.tone]}`
                    : "border-border bg-background text-muted-foreground hover:border-border-strong hover:text-foreground"
                }`}
              >
                <span className="block text-sm font-medium">{item.label}</span>
                <span className="mt-1 block text-xs leading-5">{item.summary}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="min-w-0 p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="label-mono">Interactive backend flow</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Select any node or step to inspect what crosses the boundary.
              </p>
            </div>
            <div className="flex items-center border border-border" role="group" aria-label="Journey playback controls">
              <button
                type="button"
                onClick={() => moveStep("previous")}
                className="grid h-11 w-11 place-items-center border-r border-border text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
                aria-label="Previous step"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                disabled={reducedMotion === true}
                onClick={() => setPlaying((value) => !value)}
                className="inline-flex h-11 min-w-24 items-center justify-center gap-2 border-r border-border px-3 font-mono text-[10px] uppercase tracking-wide text-foreground disabled:cursor-not-allowed disabled:text-muted-foreground"
                aria-label={reducedMotion === true ? "Autoplay disabled for reduced motion" : playing ? "Pause journey" : "Play journey"}
              >
                {playing ? <Pause className="h-3.5 w-3.5" aria-hidden="true" /> : <Play className="h-3.5 w-3.5" aria-hidden="true" />}
                {reducedMotion === true ? "Manual" : playing ? "Pause" : "Play"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setStepIndex(0);
                  setPlaying(reducedMotion === false);
                }}
                className="grid h-11 w-11 place-items-center border-r border-border text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
                aria-label="Replay from first step"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => moveStep("next")}
                className="grid h-11 w-11 place-items-center text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
                aria-label="Next step"
              >
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>
          {reducedMotion === true ? (
            <p className="mt-3 font-mono text-[10px] uppercase tracking-wide text-muted-foreground" role="status">
              Reduced motion · manual stepping
            </p>
          ) : null}
        </div>
      </div>

      <div className="border-b border-border" role="region" aria-label="Journey steps">
        <p className="border-b border-border px-5 py-2 font-mono text-[9px] uppercase tracking-wide text-muted-foreground sm:hidden">
          Swipe to explore every step →
        </p>
        <div className="overflow-x-auto" data-horizontal-track>
          <div className="grid min-w-[46rem] auto-cols-fr grid-flow-col">
            {steps.map((item, index) => {
              const node = explainer.nodes.find((candidate) => candidate.id === item.nodeId);
              const selected = index === stepIndex;
              return (
                <button
                  key={`${scenario.id}-${index}-${item.nodeId}`}
                  ref={(element) => { stepRefs.current[index] = element; }}
                  type="button"
                  aria-current={selected ? "step" : undefined}
                  onClick={() => selectStep(index)}
                  onKeyDown={(event) => {
                    let next = index;
                    if (event.key === "ArrowRight") next = Math.min(index + 1, steps.length - 1);
                    else if (event.key === "ArrowLeft") next = Math.max(index - 1, 0);
                    else if (event.key === "Home") next = 0;
                    else if (event.key === "End") next = steps.length - 1;
                    else return;
                    event.preventDefault();
                    selectStep(next);
                    stepRefs.current[next]?.focus();
                  }}
                  className={`relative min-h-24 border-r border-border px-3 py-4 text-left last:border-r-0 focus-visible:outline-offset-[-2px] ${
                    selected ? "bg-white/[0.05] text-foreground" : "text-muted-foreground hover:bg-white/[0.025] hover:text-foreground"
                  }`}
                >
                  <span className="font-mono text-[10px] tabular-nums">{String(index + 1).padStart(2, "0")}</span>
                  <span className="mt-2 block text-xs leading-4">{node?.shortLabel ?? item.title}</span>
                  <span className={`absolute inset-x-0 bottom-0 h-0.5 ${selected ? accentStyles[explainer.accent] : "bg-transparent"}`} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="border-b border-border p-5 sm:p-7" role="region" aria-label="Animated system route">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="label-mono">Connected route</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              The marker follows the active backend handoff. Boundaries are labelled at each node.
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground sm:hidden">
              Swipe route →
            </span>
            <span className={`h-2 w-2 ${accentStyles[explainer.accent]}`} aria-hidden="true" />
          </div>
        </div>
        <div className="mt-5 overflow-x-auto pb-2" data-horizontal-track>
          <ol className="flex min-w-max items-center" aria-label={`${scenario.label} connected route`}>
            {steps.map((routeStep, index) => {
              const routeNode = explainer.nodes.find((node) => node.id === routeStep.nodeId);
              const routeZone = explainer.zones.find((zone) => zone.id === routeNode?.zone);
              const selected = index === stepIndex;
              const connectorActive = index === Math.min(stepIndex, steps.length - 2);
              return (
                <li key={`${scenario.id}-route-${index}-${routeStep.nodeId}`} className="flex items-center">
                  <button
                    ref={(element) => { routeRefs.current[index] = element; }}
                    type="button"
                    aria-current={selected ? "step" : undefined}
                    onClick={() => selectStep(index)}
                    className={`bracket relative grid min-h-28 w-36 content-between border p-3 text-left transition sm:w-40 ${
                      selected
                        ? `bracket-accent ${accentSelectionStyles[explainer.accent]}`
                        : "border-border bg-background hover:border-border-strong"
                    }`}
                  >
                    <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
                      {routeZone?.label}
                    </span>
                    <span className="mt-3 block text-sm font-medium leading-5 text-foreground">
                      {routeNode?.shortLabel ?? routeStep.title}
                    </span>
                    <span className="mt-2 block font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
                      {String(index + 1).padStart(2, "0")} · {routeStep.status}
                    </span>
                  </button>
                  {index < steps.length - 1 ? (
                    <div className="relative h-16 w-14 shrink-0 sm:w-20" aria-hidden="true">
                      <span className="absolute left-0 right-0 top-1/2 border-t border-dashed border-border-strong" />
                      <ChevronRight className="absolute right-0 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      {routeZone?.id !== explainer.zones.find((zone) => zone.id === explainer.nodes.find((node) => node.id === steps[index + 1]?.nodeId)?.zone)?.id ? (
                        <span className="absolute left-1/2 top-0 -translate-x-1/2 whitespace-nowrap bg-card px-1 font-mono text-[8px] uppercase tracking-wide text-muted-foreground">
                          Boundary
                        </span>
                      ) : null}
                      {connectorActive ? (
                        <motion.span
                          key={`${scenario.id}-${stepIndex}-${playing}`}
                          initial={false}
                          animate={playing && reducedMotion === false ? { left: ["8%", "78%"] } : { left: "70%" }}
                          transition={playing && reducedMotion === false ? { duration: 1.4, ease: "easeInOut", repeat: Infinity } : { duration: 0 }}
                          className={`absolute top-1/2 h-2 w-2 -translate-y-1/2 ${accentStyles[explainer.accent]}`}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </div>
      </div>

      <div className="grid lg:grid-cols-[1.1fr_0.9fr]">
        <div className="border-b border-border p-5 sm:p-7 lg:border-b-0 lg:border-r">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" role="group" aria-label="Selectable system nodes">
            {explainer.nodes.map((node) => {
              const nodeActive = node.id === activeNode.id;
              const nodeStep = steps.findIndex((candidate) => candidate.nodeId === node.id);
              return (
                <button
                  key={node.id}
                  type="button"
                  aria-pressed={nodeActive}
                  disabled={nodeStep < 0}
                  onClick={() => nodeStep >= 0 && selectStep(nodeStep)}
                  className={`bracket min-h-24 border p-3 text-left transition ${
                    nodeActive
                      ? `bracket-accent ${accentSelectionStyles[explainer.accent]}`
                      : "border-border bg-background hover:border-border-strong"
                  } ${nodeStep < 0 ? "cursor-not-allowed border-dashed border-border bg-surface" : ""}`}
                >
                  <span className="label-mono">{explainer.zones.find((zone) => zone.id === node.zone)?.label}</span>
                  <span className="mt-2 block text-sm font-medium text-foreground">{node.label}</span>
                  <span className="mt-1 block text-xs leading-5 text-muted-foreground">{node.detail}</span>
                  {nodeStep < 0 ? (
                    <span className="mt-2 block font-mono text-[9px] uppercase tracking-wide text-muted-foreground">Not on this path</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        <div className="p-5 sm:p-7" aria-live="polite" aria-atomic="true">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`border px-2 py-1 font-mono text-[10px] uppercase tracking-wide ${toneStyles[scenario.tone]}`}>
              {scenario.label}
            </span>
            <span className="border border-border px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              {activeZone.label}
            </span>
          </div>
          <p className="mt-5 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
            Step {stepIndex + 1} of {steps.length}
          </p>
          <h3 className="mt-2 text-xl font-normal tracking-tight text-foreground">{step.title}</h3>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">{step.body}</p>
          <dl className="mt-6 divide-y divide-border border-y border-border text-sm">
            <div className="grid gap-1 py-3 sm:grid-cols-[6.5rem_1fr]">
              <dt className="label-mono">Input</dt>
              <dd className="text-foreground">{step.input}</dd>
            </div>
            <div className="grid gap-1 py-3 sm:grid-cols-[6.5rem_1fr]">
              <dt className="label-mono">Output</dt>
              <dd className="text-foreground">{step.output}</dd>
            </div>
            <div className="grid gap-1 py-3 sm:grid-cols-[6.5rem_1fr]">
              <dt className="label-mono">Status</dt>
              <dd className="text-foreground">{step.status}</dd>
            </div>
            {step.crossesBoundary ? (
              <div className="grid gap-1 py-3 sm:grid-cols-[6.5rem_1fr]">
                <dt className="label-mono">Boundary</dt>
                <dd className="text-foreground">{step.crossesBoundary}</dd>
              </div>
            ) : null}
          </dl>
        </div>
      </div>

      <div className="grid border-t border-border sm:grid-cols-2 lg:grid-cols-5" role="group" aria-label="Trust boundaries">
        {explainer.zones.map((zone) => (
          <div key={zone.id} className="border-b border-border p-4 last:border-b-0 sm:border-r sm:last:border-r-0 lg:border-b-0">
            <p className="label-mono">Trust boundary</p>
            <p className="mt-2 text-sm font-medium text-foreground">{zone.label}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{zone.detail}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
