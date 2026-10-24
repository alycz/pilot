"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import * as React from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Bot,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CirclePause,
  CirclePlay,
  Database,
  FileCheck2,
  FileText,
  GitCompareArrows,
  Lightbulb,
  LockKeyhole,
  MessageCircle,
  Pause,
  Play,
  RefreshCcw,
  Repeat2,
  Search,
  ShieldCheck,
  Sparkles,
  Undo2,
  UserCheck,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import {
  architectureCallouts,
  explainerBadges,
  explainerStages,
  modelSwitchDemo,
  privacyBoundaries,
  type ExplainerIcon,
  type ExplainerStage,
  type ExplainerStatus,
  type ExplainerTone,
} from "./explainer-data";

const STEP_DURATION_MS = 2_250;

export function flowPlaybackAllowed(reduceMotion: boolean): boolean {
  return !reduceMotion;
}

const icons: Record<ExplainerIcon, LucideIcon> = {
  chat: MessageCircle,
  vault: Database,
  search: Search,
  model: BrainCircuit,
  sparkles: Sparkles,
  shield: ShieldCheck,
  ledger: FileCheck2,
  check: CheckCircle2,
  lightbulb: Lightbulb,
  review: UserCheck,
  bookmark: FileText,
  repeat: Repeat2,
};

const toneStyles: Record<
  ExplainerTone,
  { icon: string; active: string; glow: string; dot: string }
> = {
  conversation: {
    icon: "bg-sky-400/10 text-sky-300",
    active: "border-sky-300/55 bg-sky-400/[0.085]",
    glow: "shadow-[0_0_28px_rgba(125,211,252,0.1)]",
    dot: "bg-sky-300",
  },
  memory: {
    icon: "bg-violet-400/10 text-violet-300",
    active: "border-violet-300/55 bg-violet-400/[0.085]",
    glow: "shadow-[0_0_28px_rgba(196,181,253,0.1)]",
    dot: "bg-violet-300",
  },
  model: {
    icon: "bg-cyan-400/10 text-cyan-300",
    active: "border-cyan-300/55 bg-cyan-400/[0.085]",
    glow: "shadow-[0_0_28px_rgba(103,232,249,0.1)]",
    dot: "bg-cyan-300",
  },
  proposal: {
    icon: "bg-fuchsia-400/10 text-fuchsia-300",
    active: "border-fuchsia-300/55 bg-fuchsia-400/[0.085]",
    glow: "shadow-[0_0_28px_rgba(240,171,252,0.1)]",
    dot: "bg-fuchsia-300",
  },
  guardrail: {
    icon: "bg-approval/10 text-approval",
    active: "border-approval/55 bg-approval/[0.085]",
    glow: "shadow-[0_0_28px_rgba(252,211,77,0.1)]",
    dot: "bg-approval/10",
  },
  ledger: {
    icon: "bg-primary-soft text-primary",
    active: "border-primary/55 bg-primary-soft",
    glow: "shadow-[0_0_28px_oklch(0.76_0.14_177/0.1)]",
    dot: "bg-primary",
  },
  learning: {
    icon: "bg-rose-400/10 text-rose-300",
    active: "border-rose-300/55 bg-rose-400/[0.085]",
    glow: "shadow-[0_0_28px_rgba(253,164,175,0.1)]",
    dot: "bg-rose-300",
  },
};

const statusStyles: Record<ExplainerStatus, string> = {
  implemented: "border-primary/25 bg-primary-soft text-primary",
  inspired: "border-violet-300/25 bg-violet-400/10 text-violet-200",
  optional: "border-approval/25 bg-approval/10 text-approval",
};

const laneMeta = [
  {
    number: "01",
    label: "Understand",
    title: "Request → relevant context",
    detail: "Scope first. Retrieve only what this turn needs.",
  },
  {
    number: "02",
    label: "Act safely",
    title: "Proposal → verified result",
    detail: "The model proposes. Deterministic controls decide.",
  },
  {
    number: "03",
    label: "Learn with consent",
    title: "Feedback → next turn",
    detail: "Nothing inferred becomes durable without review.",
  },
] as const;

export function ArchitectureExplainer() {
  const reduceMotion = useReducedMotion();
  const [activeIndex, setActiveIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [selectedModelIndex, setSelectedModelIndex] = useState(0);
  const selectedButton = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (reduceMotion) setPlaying(false);
  }, [reduceMotion]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setActiveIndex((current) => {
        if (current >= explainerStages.length - 1) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, STEP_DURATION_MS);
    return () => window.clearInterval(timer);
  }, [playing]);

  const selectStage = useCallback((index: number, pause = true) => {
    setActiveIndex(index);
    setHasStarted(true);
    if (pause) setPlaying(false);
  }, []);

  const start = useCallback(() => {
    if (activeIndex >= explainerStages.length - 1) setActiveIndex(0);
    setHasStarted(true);
    setPlaying(flowPlaybackAllowed(Boolean(reduceMotion)));
  }, [activeIndex, reduceMotion]);

  const replay = useCallback(() => {
    setActiveIndex(0);
    setHasStarted(true);
    setPlaying(flowPlaybackAllowed(Boolean(reduceMotion)));
  }, [reduceMotion]);

  const move = useCallback(
    (delta: number) => {
      const next = Math.min(
        explainerStages.length - 1,
        Math.max(0, activeIndex + delta),
      );
      selectStage(next);
      window.requestAnimationFrame(() => selectedButton.current?.focus());
    },
    [activeIndex, selectStage],
  );

  const onFlowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      selectStage(0);
    } else if (event.key === "End") {
      event.preventDefault();
      selectStage(explainerStages.length - 1);
    }
  };

  const activeStage = explainerStages[activeIndex]!;

  const switchModel = (index: number) => {
    if (index === selectedModelIndex) return;
    setSelectedModelIndex(index);
  };

  return (
    <div className="relative min-h-dvh overflow-hidden bg-background text-foreground">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute -left-24 top-24 h-72 w-72 rounded-full bg-cyan-400/[0.055] blur-3xl" />
        <div className="absolute right-[-8rem] top-[30rem] h-96 w-96 rounded-full bg-violet-400/[0.05] blur-3xl" />
        <div className="absolute inset-0 opacity-[0.035] [background-image:linear-gradient(rgba(255,255,255,.5)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.5)_1px,transparent_1px)] [background-size:64px_64px] [mask-image:linear-gradient(to_bottom,black,transparent_78%)]" />
      </div>

      <a
        href="#explainer-main"
        className="fixed left-3 top-3 z-50 -translate-y-24 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition focus:translate-y-0"
      >
        Skip to explainer
      </a>

      <header className="relative z-20 border-b border-white/8 bg-background/78 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[94rem] items-center gap-3 px-4 sm:px-6 lg:px-8">
          <Link
            href="/"
            className="flex items-center gap-3 rounded-xl focus-visible:outline-offset-4"
            aria-label="Back to workspace conversation"
          >
            <span className="grid h-9 w-9 place-items-center rounded-xl border border-primary/25 bg-primary-soft text-primary shadow-[0_0_24px_oklch(0.76_0.14_177/0.12)]">
              <Bot className="h-[1.15rem] w-[1.15rem]" />
            </span>
            <span>
              <span className="block text-[15px] font-bold leading-none tracking-tight">Pilot</span>
              <span className="mt-1 block text-xs font-medium text-muted-foreground">System tour</span>
            </span>
          </Link>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden rounded-full border border-white/10 bg-white/[0.035] px-3 py-1.5 text-[11px] font-semibold text-muted-foreground sm:inline-flex">
              Offline · synthetic data
            </span>
            <Link
              href="/"
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.035] px-3 py-2 text-xs font-semibold text-foreground transition hover:border-white/20 hover:bg-white/[0.06]"
            >
              Back to workspace <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      </header>

      <main id="explainer-main" className="relative z-10">
        <section className="mx-auto max-w-[94rem] px-4 pb-10 pt-12 sm:px-6 sm:pt-16 lg:px-8 lg:pt-20">
          <div className="grid items-end gap-9 lg:grid-cols-[minmax(0,1fr)_26rem]">
            <div className="max-w-4xl">
              <p className="inline-flex items-center gap-2 text-[13px] font-bold text-primary">
                <span className="h-px w-7 bg-primary/70" />
                Architecture, without the hand-waving
              </p>
              <h1 className="mt-5 text-balance text-4xl font-semibold leading-[1.04] tracking-[-0.04em] sm:text-5xl lg:text-[4.35rem] font-display">
                How Pilot turns context into
                <span className="block bg-gradient-to-r from-primary via-cyan-200 to-violet-300 bg-clip-text text-transparent">
                  safer, reviewable action.
                </span>
              </h1>
              <p className="mt-6 max-w-3xl text-pretty text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">
                Follow one synthetic request through scoped memory, a chosen model,
                deterministic Harbor controls, XRPL validation, and user-reviewed learning.
                Personalization lives outside the model—it is not model training.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-1">
              <Metric label="Flow stages" value="12" />
              <Metric label="Live data used" value="None" />
              <Metric label="User review gates" value="2" />
            </div>
          </div>
        </section>

        <section aria-labelledby="flow-title" className="mx-auto max-w-[94rem] px-4 pb-20 sm:px-6 lg:px-8">
          <div className="overflow-hidden rounded-[1.75rem] border border-white/10 bg-[linear-gradient(150deg,rgba(255,255,255,.045),rgba(255,255,255,.012))] shadow-[0_28px_100px_rgba(0,0,0,0.24)]">
            <div className="flex flex-col gap-5 border-b border-white/8 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-xs font-bold text-primary">Interactive system map</p>
                <h2 id="flow-title" className="mt-1 text-lg font-semibold tracking-tight sm:text-xl">Follow the data—not a black box</h2>
              </div>
              <PlaybackControls
                activeIndex={activeIndex}
                hasStarted={hasStarted}
                playing={playing}
                reduceMotion={Boolean(reduceMotion)}
                onStart={start}
                onPause={() => setPlaying(false)}
                onReplay={replay}
                onPrevious={() => move(-1)}
                onNext={() => move(1)}
              />
            </div>

            <div className="grid min-w-0 xl:grid-cols-[minmax(0,1fr)_23rem]">
              <div
                className="min-w-0 p-4 sm:p-6 lg:p-8"
                onKeyDown={onFlowKeyDown}
                aria-label="Architecture flow. Use arrow keys to move between stages."
              >
                <div className="space-y-7 lg:space-y-9">
                  {laneMeta.map((lane, laneIndex) => {
                    const stages = explainerStages.slice(laneIndex * 4, laneIndex * 4 + 4);
                    return (
                      <div key={lane.number}>
                        <div className="mb-3 flex items-baseline gap-3">
                          <span className="font-mono text-[10px] text-primary/80">{lane.number}</span>
                          <h3 className="text-xs font-bold text-foreground/85">{lane.label}</h3>
                          <span className="hidden text-xs text-muted-foreground sm:inline">{lane.title} · {lane.detail}</span>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                          {stages.map((stage, stageOffset) => {
                            const index = laneIndex * 4 + stageOffset;
                            return (
                              <FlowNode
                                key={stage.id}
                                stage={stage}
                                index={index}
                                active={index === activeIndex}
                                complete={index < activeIndex}
                                playing={playing}
                                reduceMotion={Boolean(reduceMotion)}
                                buttonRef={index === activeIndex ? selectedButton : undefined}
                                onClick={() => selectStage(index)}
                              />
                            );
                          })}
                        </div>
                        {laneIndex < laneMeta.length - 1 ? (
                          <div aria-hidden="true" className="relative mx-auto mt-3 h-4 w-px bg-white/10">
                            <ArrowDown className="absolute -bottom-1 -left-[7px] h-3.5 w-3.5 text-white/25" />
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>

              <StageDetail
                stage={activeStage}
                activeIndex={activeIndex}
                playing={playing}
                reduceMotion={Boolean(reduceMotion)}
              />
            </div>
          </div>
          <p className="mt-3 text-center text-[11px] text-muted-foreground">
            Tap any node, or use arrow keys to inspect it. Playback controls remain available above.
            {reduceMotion ? " Motion is reduced on this device; playback advances only when requested." : ""}
          </p>
        </section>

        <ModelSwitchDemo
          selectedIndex={selectedModelIndex}
          reduceMotion={Boolean(reduceMotion)}
          onSelect={switchModel}
        />

        <section aria-labelledby="components-title" className="mx-auto max-w-[94rem] px-4 pb-20 sm:px-6 lg:px-8">
          <div className="grid gap-8 lg:grid-cols-[0.72fr_1.28fr] lg:items-start">
            <div>
              <p className="text-[13px] font-bold text-primary">What is actually here</p>
              <h2 id="components-title" className="mt-3 text-3xl font-semibold tracking-[-0.035em] sm:text-4xl font-display">Clear labels for every layer.</h2>
              <p className="mt-4 max-w-xl text-sm leading-6 text-muted-foreground">
                “Implemented,” “inspired,” and “optional” mean different things. This page keeps those boundaries visible instead of blending them into one story.
              </p>
              <div className="mt-6 space-y-3">
                {explainerBadges.map((badge) => (
                  <div key={badge.status} className="flex items-start gap-3">
                    <StatusBadge status={badge.status}>{badge.label}</StatusBadge>
                    <p className="pt-0.5 text-xs leading-5 text-muted-foreground">{badge.description}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {architectureCallouts.map((callout) => {
                const CalloutIcon = callout.id === "pilot-harbor"
                  ? ShieldCheck
                  : callout.id === "hermes"
                    ? Bot
                    : callout.id === "harness"
                      ? GitCompareArrows
                      : Database;
                return (
                  <article key={callout.id} className="rounded-2xl border border-white/9 bg-card/72 p-5">
                    <div className="flex items-start justify-between gap-3">
                      <span className="grid h-9 w-9 place-items-center rounded-xl bg-white/[0.05] text-foreground/80">
                        <CalloutIcon className="h-[1.05rem] w-[1.05rem]" />
                      </span>
                      <StatusBadge status={callout.status}>
                        {explainerBadges.find((badge) => badge.status === callout.status)?.label}
                      </StatusBadge>
                    </div>
                    <h3 className="mt-5 text-sm font-semibold">{callout.title}</h3>
                    <p className="mt-2 text-xs font-medium leading-5 text-foreground/80">{callout.summary}</p>
                    <p className="mt-3 text-xs leading-5 text-muted-foreground">{callout.detail}</p>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section aria-labelledby="boundaries-title" className="border-y border-white/8 bg-white/[0.018]">
          <div className="mx-auto grid max-w-[94rem] gap-8 px-4 py-14 sm:px-6 lg:grid-cols-[0.7fr_1.3fr] lg:px-8 lg:py-16">
            <div>
              <div className="flex items-center gap-2 text-primary">
                <LockKeyhole className="h-4 w-4" />
                <p className="text-[13px] font-bold">Privacy + control</p>
              </div>
              <h2 id="boundaries-title" className="mt-3 text-3xl font-semibold tracking-[-0.035em] font-display">What the loop does not do.</h2>
            </div>
            <ul className="grid gap-3 sm:grid-cols-2">
              {privacyBoundaries.map((boundary, index) => (
                <li key={boundary} className="flex gap-3 rounded-xl border border-white/8 bg-background/40 p-4 text-xs leading-5 text-muted-foreground">
                  <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border border-white/10 font-mono text-[9px] text-primary">{index + 1}</span>
                  {boundary}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <footer className="mx-auto flex max-w-[94rem] flex-col gap-4 px-4 py-10 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <p>Built from the checked-in Pilot, Harbor, vault, Hermes-adapter, and offline-evaluator contracts.</p>
          <Link href="/" className="inline-flex items-center gap-2 font-semibold text-foreground transition hover:text-primary">
            <ArrowLeft className="h-3.5 w-3.5" /> Return to workspace
          </Link>
        </footer>
      </main>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-white/8 bg-white/[0.028] px-3 py-3 sm:block lg:flex lg:px-4">
      <p className="text-wrap text-xs font-bold leading-4 text-muted-foreground sm:text-xs">{label}</p>
      <p className="shrink-0 text-sm font-semibold text-foreground sm:mt-1 lg:mt-0">{value}</p>
    </div>
  );
}

function PlaybackControls({
  activeIndex,
  hasStarted,
  playing,
  reduceMotion,
  onStart,
  onPause,
  onReplay,
  onPrevious,
  onNext,
}: {
  activeIndex: number;
  hasStarted: boolean;
  playing: boolean;
  reduceMotion: boolean;
  onStart: () => void;
  onPause: () => void;
  onReplay: () => void;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Flow playback controls">
      <button
        type="button"
        onClick={onPrevious}
        disabled={activeIndex === 0}
        className="grid h-9 w-9 place-items-center rounded-lg border border-white/10 bg-white/[0.03] text-muted-foreground transition hover:bg-white/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
        aria-label="Previous stage"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      {playing ? (
        <button type="button" onClick={onPause} className="inline-flex h-9 items-center gap-2 rounded-lg border border-primary/25 bg-primary-soft px-3 text-xs font-semibold text-primary">
          <Pause className="h-3.5 w-3.5" /> Pause
        </button>
      ) : (
        <button type="button" onClick={onStart} className="inline-flex h-9 items-center gap-2 rounded-lg border border-primary/25 bg-primary-soft px-3 text-xs font-semibold text-primary">
          <Play className="h-3.5 w-3.5" /> {hasStarted ? "Resume" : "Play flow"}
        </button>
      )}
      <button
        type="button"
        onClick={onNext}
        disabled={activeIndex === explainerStages.length - 1}
        className="grid h-9 w-9 place-items-center rounded-lg border border-white/10 bg-white/[0.03] text-muted-foreground transition hover:bg-white/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
        aria-label="Next stage"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
      <button type="button" onClick={onReplay} className="inline-flex h-9 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 text-xs font-semibold text-muted-foreground transition hover:bg-white/[0.06] hover:text-foreground">
        <RefreshCcw className="h-3.5 w-3.5" /> Replay
      </button>
      {reduceMotion ? (
        <span className="rounded-full bg-white/[0.035] px-2.5 py-1 text-[10px] font-medium text-muted-foreground">Reduced motion</span>
      ) : null}
    </div>
  );
}

function FlowNode({
  stage,
  index,
  active,
  complete,
  playing,
  reduceMotion,
  buttonRef,
  onClick,
}: {
  stage: ExplainerStage;
  index: number;
  active: boolean;
  complete: boolean;
  playing: boolean;
  reduceMotion: boolean;
  buttonRef?: RefObject<HTMLButtonElement | null>;
  onClick: () => void;
}) {
  const Icon = icons[stage.icon];
  const tone = toneStyles[stage.tone];
  return (
    <div className="relative min-w-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={onClick}
        aria-current={active ? "step" : undefined}
        aria-label={`Stage ${stage.order}: ${stage.title}. ${stage.summary}`}
        className={`group relative flex h-full min-h-[7.25rem] w-full min-w-0 flex-col overflow-hidden rounded-2xl border p-3.5 text-left transition duration-300 sm:min-h-[8.5rem] ${
          active
            ? `${tone.active} ${tone.glow}`
            : complete
              ? "border-white/12 bg-white/[0.035]"
              : "border-white/8 bg-white/[0.018] hover:border-white/16 hover:bg-white/[0.038]"
        }`}
      >
        {active && playing && !reduceMotion ? (
          <motion.span
            aria-hidden="true"
            className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/90 to-transparent"
            initial={{ x: "-100%" }}
            animate={{ x: "100%" }}
            transition={{ duration: STEP_DURATION_MS / 1_000, ease: "linear", repeat: Infinity }}
          />
        ) : null}
        <span className="flex items-start justify-between gap-2">
          <span className={`grid h-8 w-8 place-items-center rounded-xl ${tone.icon}`}>
            <Icon className="h-4 w-4" />
          </span>
          <span className="flex items-center gap-1.5 font-mono text-[9px] font-medium text-muted-foreground">
            {complete ? <Check className="h-3 w-3 text-primary" /> : null}
            {String(index + 1).padStart(2, "0")}
          </span>
        </span>
        <span className="mt-auto block pt-4">
          <span className="block text-xs font-semibold leading-4 text-foreground">{stage.shortLabel}</span>
          <span className="mt-1 line-clamp-2 block text-[10px] leading-4 text-muted-foreground sm:text-[11px]">{stage.summary}</span>
        </span>
        <span className={`absolute bottom-0 left-0 h-0.5 transition-all duration-300 ${tone.dot} ${active ? "w-full" : complete ? "w-1/3 opacity-55" : "w-0"}`} />
      </button>
      {index % 4 !== 3 ? (
        <span aria-hidden="true" className="absolute right-[-0.75rem] top-1/2 z-10 hidden h-px w-3 bg-white/12 lg:block">
          <span className="absolute -right-px -top-[2px] h-1.5 w-1.5 rotate-45 border-r border-t border-white/18" />
        </span>
      ) : null}
    </div>
  );
}

function StageDetail({
  stage,
  activeIndex,
  playing,
  reduceMotion,
}: {
  stage: ExplainerStage;
  activeIndex: number;
  playing: boolean;
  reduceMotion: boolean;
}) {
  const Icon = icons[stage.icon];
  const tone = toneStyles[stage.tone];
  return (
    <aside className="min-w-0 border-t border-white/8 bg-black/[0.13] p-5 sm:p-6 xl:border-l xl:border-t-0 xl:p-7" aria-live="polite" aria-atomic="true">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={stage.id}
          initial={reduceMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 1 } : { opacity: 0, y: -6 }}
          transition={{ duration: 0.2 }}
        >
          <div className="flex items-center justify-between gap-3">
            <span className={`grid h-11 w-11 place-items-center rounded-2xl ${tone.icon}`}>
              <Icon className="h-5 w-5" />
            </span>
            <StatusBadge status={stage.status}>Implemented</StatusBadge>
          </div>
          <p className="mt-7 text-xs text-primary">Stage {String(stage.order).padStart(2, "0")} of {explainerStages.length}</p>
          <h3 className="mt-2 text-xl font-semibold tracking-tight">{stage.title}</h3>
          <p className="mt-3 text-sm font-medium leading-6 text-foreground/82">{stage.summary}</p>
          <p className="mt-4 text-xs leading-5 text-muted-foreground">{stage.detail}</p>

          <div className="mt-7 space-y-2.5">
            <FlowValue label="Receives" value={stage.input} />
            <FlowValue label="Passes on" value={stage.output} accent />
          </div>

          <div className="mt-7 flex items-center gap-3 border-t border-white/8 pt-5">
            {playing ? <CirclePlay className="h-4 w-4 text-primary" /> : <CirclePause className="h-4 w-4 text-muted-foreground" />}
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between text-[10px] font-medium text-muted-foreground">
                <span>{playing ? "Flow playing" : "Inspecting stage"}</span>
                <span>{Math.round(((activeIndex + 1) / explainerStages.length) * 100)}%</span>
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/8">
                <motion.div
                  className="h-full rounded-full bg-primary"
                  animate={{ width: `${((activeIndex + 1) / explainerStages.length) * 100}%` }}
                  transition={{ duration: reduceMotion ? 0 : 0.35, ease: "easeOut" }}
                />
              </div>
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
    </aside>
  );
}

function FlowValue({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.025] p-3">
      <p className="text-xs font-bold text-muted-foreground">{label}</p>
      <p className={`mt-1.5 text-xs font-medium leading-5 ${accent ? "text-primary" : "text-foreground/85"}`}>{value}</p>
    </div>
  );
}

function StatusBadge({ status, children }: { status: ExplainerStatus; children: ReactNode }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-xs font-bold ${statusStyles[status]}`}>
      {children}
    </span>
  );
}

function ModelSwitchDemo({
  selectedIndex,
  reduceMotion,
  onSelect,
}: {
  selectedIndex: number;
  reduceMotion: boolean;
  onSelect: (index: number) => void;
}) {
  const selected = modelSwitchDemo.steps[selectedIndex]!;
  return (
    <section aria-labelledby="model-switch-title" className="mx-auto max-w-[94rem] px-4 pb-20 sm:px-6 lg:px-8">
      <div className="overflow-hidden rounded-[1.75rem] border border-white/10 bg-card/68">
        <div className="grid lg:grid-cols-[0.76fr_1.24fr]">
          <div className="border-b border-white/8 p-6 sm:p-8 lg:border-b-0 lg:border-r lg:p-10">
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex rounded-full border border-white/10 bg-white/[0.035] px-2.5 py-1 text-xs font-bold text-muted-foreground">Synthetic demo</span>
              <StatusBadge status="implemented">Implemented · default-off</StatusBadge>
            </div>
            <h2 id="model-switch-title" className="mt-5 text-3xl font-semibold tracking-[-0.035em] font-display">Switch the model. Keep the confirmed context.</h2>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">{modelSwitchDemo.explanation}</p>

            <div className="mt-7 rounded-2xl border border-violet-300/18 bg-violet-400/[0.065] p-4">
              <div className="flex items-start gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-violet-400/10 text-violet-200"><Database className="h-4 w-4" /></span>
                <div>
                  <p className="text-xs font-bold text-violet-200/80">Reviewed memory · not training</p>
                  <p className="mt-2 text-sm font-semibold leading-5">{modelSwitchDemo.confirmedPreference}</p>
                  <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">{modelSwitchDemo.preferenceState}</p>
                </div>
              </div>
            </div>
          </div>

          <div className="p-5 sm:p-8 lg:p-10">
            <div className="grid grid-cols-2 gap-2" aria-label="Synthetic model choices">
              {modelSwitchDemo.steps.map((step, index) => (
                <button
                  key={step.model}
                  type="button"
                  aria-pressed={selectedIndex === index}
                  onClick={() => onSelect(index)}
                  className={`min-w-0 rounded-xl border px-3 py-3 text-left transition sm:px-4 ${selectedIndex === index ? "border-primary/35 bg-primary-soft" : "border-white/8 bg-white/[0.02] hover:bg-white/[0.045]"}`}
                >
                  <span className="flex items-center gap-2 text-xs font-semibold">
                    <span className={`h-1.5 w-1.5 rounded-full ${selectedIndex === index ? "bg-primary shadow-[0_0_9px_var(--primary)]" : "bg-muted-foreground/50"}`} />
                    <span className="truncate">{step.model}</span>
                  </span>
                  <span className="mt-1.5 hidden text-[10px] text-muted-foreground sm:block">{step.modelDetail}</span>
                </button>
              ))}
            </div>

            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                aria-live="polite"
                key={selected.model}
                initial={reduceMotion ? false : { opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={reduceMotion ? { opacity: 1 } : { opacity: 0, x: -12 }}
                transition={{ duration: reduceMotion ? 0 : 0.24 }}
                className="mt-4 min-w-0 rounded-2xl border border-white/9 bg-background/50 p-4 sm:p-5"
              >
                <DemoMessage actor="You" icon={MessageCircle} text={selected.prompt} />
                <div className="my-3 flex items-center gap-2 pl-3 text-[10px] font-medium text-violet-200/85">
                  <span className="h-5 w-px bg-gradient-to-b from-violet-300/10 to-violet-300/55" />
                  <Database className="h-3.5 w-3.5" /> {selected.retrievedContext}
                </div>
                <DemoMessage actor={selected.model} icon={BrainCircuit} text={selected.response} accent />
              </motion.div>
            </AnimatePresence>

            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[10px] text-muted-foreground">
              <span className="inline-flex items-center gap-1.5"><Check className="h-3 w-3 text-primary" /> Same accepted preference</span>
              <span className="inline-flex items-center gap-1.5"><LockKeyhole className="h-3 w-3 text-primary" /> No unrelated history</span>
              <span className="inline-flex items-center gap-1.5"><Undo2 className="h-3 w-3 text-primary" /> Correctable + forgettable</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function DemoMessage({ actor, icon: Icon, text, accent = false }: { actor: string; icon: LucideIcon; text: string; accent?: boolean }) {
  return (
    <div className="flex min-w-0 gap-3">
      <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-xl ${accent ? "bg-primary-soft text-primary" : "bg-white/[0.05] text-muted-foreground"}`}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <p className="text-xs font-bold text-muted-foreground">{actor}</p>
        <p className="mt-1 text-xs leading-5 text-foreground/85">{text}</p>
      </div>
    </div>
  );
}
