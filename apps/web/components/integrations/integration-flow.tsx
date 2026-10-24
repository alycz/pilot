"use client";

import { motion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  Ban,
  Check,
  Cpu,
  Hourglass,
  KeyRound,
  Landmark,
  Navigation2,
  RadioTower,
  ScanSearch,
  Server,
  ShieldCheck,
  Store,
  Usb,
  UserRound,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";

import type { IntegrationStory, IntegrationTone, StoryActor, StoryIcon, StoryStep } from "./types";

const icons: Record<StoryIcon, LucideIcon> = {
  user: UserRound,
  wallet: Wallet,
  pilot: Navigation2,
  harbor: ShieldCheck,
  ledger: Landmark,
  store: Store,
  scan: ScanSearch,
  cpu: Cpu,
  key: KeyRound,
  radio: RadioTower,
  server: Server,
  device: Usb,
};

const toneDot: Record<IntegrationTone, string> = {
  success: "bg-executed",
  approval: "bg-approval",
  blocked: "bg-blocked",
  degraded: "bg-info",
};

const outcomeChip: Record<NonNullable<StoryStep["outcome"]>, { label: string; icon: LucideIcon; className: string }> = {
  ok: { label: "Passes", icon: Check, className: "border-executed/35 bg-executed/10 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]" },
  wait: { label: "Waits for you", icon: Hourglass, className: "border-approval/40 bg-approval/10 text-[color-mix(in_oklab,var(--approval)_75%,var(--foreground))]" },
  stop: { label: "Stopped", icon: Ban, className: "border-blocked/35 bg-blocked/10 text-[color-mix(in_oklab,var(--blocked)_85%,var(--foreground))]" },
};

const linkKey = (a: string, b: string) => [a, b].sort().join("|");

/** Pixels the moving square travels per second: one steady speed everywhere. */
const SPEED = 300;

type Point = { x: number; y: number };

/** Reading time for a step: long enough to read the caption, short enough to keep moving. */
export function stepDuration(step: StoryStep): number {
  return Math.min(4200, 1600 + step.caption.length * 14);
}

/** Every pair of actors any flow travels between: the lines drawn on the diagram. */
export function storyLinks(story: IntegrationStory): [string, string][] {
  const seen = new Map<string, [string, string]>();
  for (const flow of story.flows) {
    for (const step of flow.steps) {
      step.route.slice(1).forEach((id, index) => {
        const from = step.route[index]!;
        if (from !== id) seen.set(linkKey(from, id), [from, id]);
      });
    }
  }
  return [...seen.values()];
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

/**
 * The integration page's centrepiece: the parts involved, a square that
 * carries the request along the lines (drawing its trail as it goes), and the
 * explanation of each step underneath. It plays continuously, like a video,
 * through every step of every outcome while it is on screen; clicking a step
 * or outcome jumps there and carries on. Reduced-motion users step through it
 * with Back and Next.
 */
export function IntegrationFlow({ story, name }: { story: IntegrationStory; name: string }) {
  const reduced = usePrefersReducedMotion();
  const [flowIndex, setFlowIndex] = useState(0);
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const diagramRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLButtonElement>(null);
  const [size, setSize] = useState({ width: 960, height: 480, half: 26 });

  const flow = story.flows[flowIndex]!;
  const step = flow.steps[Math.min(index, flow.steps.length - 1)]!;
  const actorById = useMemo(() => new Map(story.actors.map((actor) => [actor.id, actor])), [story.actors]);
  const links = useMemo(() => storyLinks(story), [story]);
  const running = visible && !reduced;

  useEffect(() => {
    const element = diagramRef.current;
    if (!element) return;
    const query = window.matchMedia("(min-width: 640px)");
    const update = () => setSize({ width: element.clientWidth, height: element.clientHeight, half: query.matches ? 26 : 20 });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    query.addEventListener("change", update);
    return () => {
      observer.disconnect();
      query.removeEventListener("change", update);
    };
  }, []);

  useEffect(() => {
    const element = rootRef.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting)), { threshold: 0 });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Geometry, in pixels of the measured diagram.
  const px = useMemo(() => {
    const toPx = (actor: StoryActor): Point => ({ x: (actor.x / 100) * size.width, y: (actor.y / 100) * size.height });
    /**
     * Where a line toward `toward` attaches to `from`'s box: the middle of the
     * side facing it (left or right; top or bottom only for a straight
     * vertical link), so lines and the square always meet a box dead centre.
     */
    const edge = (from: StoryActor, toward: StoryActor): Point => {
      const a = toPx(from);
      const b = toPx(toward);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (Math.abs(dx) > size.half) return { x: a.x + Math.sign(dx) * size.half, y: a.y };
      return { x: a.x, y: a.y + Math.sign(dy || 1) * size.half };
    };
    return { toPx, edge };
  }, [size]);

  /** The square's path for a step: edge to edge along each line. */
  const pathFor = useMemo(() => {
    const cache = new Map<string, Point[]>();
    const compute = (stepIndex: number): Point[] => {
      const key = `${flowIndex}-${stepIndex}`;
      const hit = cache.get(key);
      if (hit) return hit;
      const current = flow.steps[stepIndex]!;
      const route = current.route.map((id) => actorById.get(id)!);
      let points: Point[];
      if (route.length === 1) {
        // Work happens inside one box: stay where the previous step left off
        // if it ended here, otherwise wait on the side facing the next hop.
        const actor = route[0]!;
        const previous = stepIndex > 0 ? flow.steps[stepIndex - 1]! : null;
        if (previous && previous.route[previous.route.length - 1] === actor.id) {
          const before = compute(stepIndex - 1);
          points = [before[before.length - 1]!];
        } else {
          const next = flow.steps[stepIndex + 1]?.route.find((id) => id !== actor.id);
          const neighbourId = next ?? links.find(([a, b]) => a === actor.id || b === actor.id)?.find((id) => id !== actor.id);
          const neighbour = neighbourId ? actorById.get(neighbourId) : undefined;
          points = [neighbour ? px.edge(actor, neighbour) : px.toPx(actor)];
        }
      } else {
        points = [];
        route.slice(1).forEach((actor, position) => {
          const from = route[position]!;
          points.push(px.edge(from, actor), px.edge(actor, from));
        });
      }
      cache.set(key, points);
      return points;
    };
    return compute;
  }, [flow, flowIndex, actorById, links, px]);

  const basePoints = useMemo(() => pathFor(index), [pathFor, index]);

  // How this step picks up from the last one, decided once per step so that
  // re-renders (hover, resize) never restart it:
  // - continue: it starts exactly where the square is;
  // - glide: same box, other side: the square slides across to the new start;
  // - fade: a new starting point elsewhere: the square fades in there.
  const previousEnd = useRef<{ point: Point; actor: string } | null>(null);
  const stepStart = useRef<{ key: string; mode: "continue" | "glide" | "fade"; from?: Point }>({ key: "", mode: "fade" });
  const currentKey = `${flow.id}-${index}`;
  if (stepStart.current.key !== currentKey) {
    const start = basePoints[0]!;
    const before = previousEnd.current;
    if (!before) stepStart.current = { key: currentKey, mode: "fade" };
    else if (Math.hypot(before.point.x - start.x, before.point.y - start.y) <= 2) stepStart.current = { key: currentKey, mode: "continue" };
    else if (before.actor === step.route[0]) stepStart.current = { key: currentKey, mode: "glide", from: before.point };
    else stepStart.current = { key: currentKey, mode: "fade" };
  }
  const startMode = stepStart.current.mode;
  const glideFrom = stepStart.current.from;
  const points = useMemo(
    () => (startMode === "glide" && glideFrom ? [glideFrom, ...basePoints] : basePoints),
    [startMode, glideFrom, basePoints],
  );
  const legOffset = startMode === "glide" ? 1 : 0;

  // Steady speed: time on each leg is proportional to its length. The trail
  // of each line uses the same clock, so it draws exactly under the square.
  const plan = useMemo(() => {
    const lengths = points.slice(1).map((point, position) => Math.hypot(point.x - points[position]!.x, point.y - points[position]!.y));
    const total = lengths.reduce((sum, length) => sum + length, 0);
    if (total === 0 || reduced) return { duration: 0, times: [0], total: 0 };
    let run = 0;
    const times = [0, ...lengths.map((length) => (run += length) / total)];
    return { duration: Math.min(2.6, Math.max(0.35, total / SPEED)), times, total };
  }, [points, reduced]);

  useEffect(() => {
    previousEnd.current = { point: points[points.length - 1]!, actor: step.route[step.route.length - 1]! };
  }, [points, step]);

  // Advance through the steps, then on to the next outcome.
  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => {
      if (index < flow.steps.length - 1) {
        setIndex(index + 1);
      } else {
        setFlowIndex((current) => (current + 1) % story.flows.length);
        setIndex(0);
      }
    }, stepDuration(step) + plan.duration * 1000);
    return () => window.clearTimeout(timer);
  }, [running, index, flow.steps.length, step, story.flows.length, plan.duration]);

  // Keep the current step in view inside the step bar only (never scroll the page).
  useEffect(() => {
    const strip = stripRef.current;
    const current = currentRef.current;
    if (!strip || !current || strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollTo({ left: Math.max(0, current.offsetLeft - (strip.clientWidth - current.offsetWidth) / 2), behavior: reduced ? "auto" : "smooth" });
  }, [index, flowIndex, reduced]);

  const chooseFlow = (next: number) => {
    setFlowIndex((next + story.flows.length) % story.flows.length);
    setIndex(0);
  };
  const go = (delta: number) => {
    const next = index + delta;
    if (next < 0) {
      const previousFlow = (flowIndex - 1 + story.flows.length) % story.flows.length;
      setFlowIndex(previousFlow);
      setIndex(story.flows[previousFlow]!.steps.length - 1);
    } else if (next >= flow.steps.length) {
      chooseFlow(flowIndex + 1);
    } else {
      setIndex(next);
    }
  };

  const route = step.route;
  const activeIds = new Set(route);
  const destination = route[route.length - 1]!;
  const working = route.length === 1;
  const trail = route.slice(1).map((id, position) => {
    const from = actorById.get(route[position]!)!;
    const to = actorById.get(id)!;
    const startAt = plan.times[legOffset + position * 2] ?? 0;
    const endAt = plan.times[legOffset + position * 2 + 1] ?? 1;
    return { key: `${position}-${from.id}-${to.id}`, from: px.edge(from, to), to: px.edge(to, from), delay: startAt * plan.duration, duration: (endAt - startAt) * plan.duration };
  });
  const stepKey = `${flow.id}-${index}`;
  const chip = step.outcome ? outcomeChip[step.outcome] : null;
  const ChipIcon = chip?.icon;

  return (
    <div
      ref={rootRef}
      className="border border-border bg-card rounded-xl"
      data-integration-flow={name}
    >
      {/* Outcome switch */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
        <p className="label-mono">Pick an outcome</p>
        <div
          role="radiogroup"
          aria-label={`${name} outcome`}
          className="grid w-full border border-border sm:flex sm:w-auto rounded-xl"
          style={{ gridTemplateColumns: `repeat(${story.flows.length}, minmax(0, 1fr))` }}
        >
          {story.flows.map((option, position) => {
            const checked = position === flowIndex;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={checked ? 0 : -1}
                onClick={() => chooseFlow(position)}
                onKeyDown={(event) => {
                  const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
                  let next: number | null = null;
                  if (event.key in keys) next = position + keys[event.key]!;
                  if (event.key === "Home") next = 0;
                  if (event.key === "End") next = story.flows.length - 1;
                  if (next === null) return;
                  event.preventDefault();
                  const target = (next + story.flows.length) % story.flows.length;
                  chooseFlow(target);
                  const group = event.currentTarget.parentElement;
                  requestAnimationFrame(() => (group?.children[target] as HTMLElement | undefined)?.focus());
                }}
                className={`flex min-h-9 items-center justify-center gap-1.5 border-r border-border px-2 text-center text-xs leading-4 transition-colors last:border-r-0 sm:px-3 pointer-coarse:min-h-11 ${
                  checked ? "bg-white/[0.08] text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <span aria-hidden="true" className={`size-1.5 shrink-0 ${toneDot[option.tone]}`} />
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Diagram */}
      <div className="relative overflow-hidden border-b border-border px-5 pb-12 pt-7 sm:px-12 sm:pb-14 sm:pt-9">
        <div
          ref={diagramRef}
          className="relative mx-auto aspect-square w-full max-w-[60rem] sm:aspect-[5/2]"
          role="img"
          aria-label={`Diagram, ${flow.label}, step ${index + 1}: ${step.title}`}
        >
          <svg viewBox={`0 0 ${size.width} ${size.height}`} className="absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
            {links.map(([from, to]) => {
              const a = px.edge(actorById.get(from)!, actorById.get(to)!);
              const b = px.edge(actorById.get(to)!, actorById.get(from)!);
              return <line key={`${from}-${to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth={1} style={{ stroke: "var(--border-strong)" }} />;
            })}
            {/* The trail draws under the square, in the direction it travels. */}
            {trail.map((segment) => (
              <motion.line
                key={`${stepKey}-${segment.key}`}
                x1={segment.from.x}
                y1={segment.from.y}
                x2={segment.to.x}
                y2={segment.to.y}
                strokeWidth={2}
                style={{ stroke: "var(--primary)" }}
                initial={reduced ? false : { pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ delay: segment.delay, duration: segment.duration, ease: "linear" }}
              />
            ))}
          </svg>

          {story.actors.map((actor) => {
            const Icon = icons[actor.icon];
            const active = activeIds.has(actor.id);
            const here = actor.id === destination;
            return (
              <div key={actor.id} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${actor.x}%`, top: `${actor.y}%` }}>
                <span
                  className={`relative grid size-10 place-items-center border transition-colors duration-500 sm:size-[3.25rem] rounded-md ${
                    here
                      ? "bracket bracket-accent border-primary-soft-border bg-primary-soft text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]"
                      : active
                        ? "border-border-strong bg-card text-foreground"
                        : "border-border bg-card text-muted-foreground"
                  }`}
                >
                  <Icon className="size-[18px] sm:size-[22px]" strokeWidth={1.6} aria-hidden="true" />
                  {/* Work happening inside this box. */}
                  {here && working && !reduced ? (
                    <motion.span
                      key={stepKey}
                      aria-hidden="true"
                      className="pointer-events-none absolute -inset-1 border border-primary/60 rounded-xl"
                      initial={{ opacity: 0, scale: 1 }}
                      animate={{ opacity: [0, 0.9, 0], scale: [1, 1.18, 1.32] }}
                      transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
                    />
                  ) : null}
                </span>
                <span className="absolute left-1/2 top-full mt-2 flex -translate-x-1/2 flex-col items-center text-center">
                  <span className={`whitespace-nowrap bg-card/85 px-1 text-[11px] font-medium transition-colors duration-500 sm:text-[13px] ${active ? "text-foreground" : "text-muted-foreground"}`}>{actor.label}</span>
                  <span className="hidden whitespace-nowrap bg-card/85 px-1 text-xs text-muted-foreground sm:block">{actor.role}</span>
                </span>
              </div>
            );
          })}

          {/* The request: one square that keeps moving from step to step. */}
          <motion.span
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0 z-10"
            initial={false}
            animate={{ x: points.map((point) => point.x - 6), y: points.map((point) => point.y - 6) }}
            transition={{
              x: { duration: plan.duration, times: plan.times.length === points.length ? plan.times : undefined, ease: "linear" },
              y: { duration: plan.duration, times: plan.times.length === points.length ? plan.times : undefined, ease: "linear" },
            }}
          >
            {/* Remounted each step; fades in only when the square starts somewhere new. */}
            <motion.span
              key={currentKey}
              className="block size-3 bg-primary shadow-[0_0_0_4px_color-mix(in_srgb,var(--primary)_20%,transparent)]"
              initial={startMode === "fade" && !reduced ? { opacity: 0, scale: 0.6 } : false}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
            />
          </motion.span>
        </div>
      </div>

      {/* Step bar */}
      <div ref={stripRef} className="overflow-x-auto border-b border-border" role="region" aria-label="Steps" tabIndex={-1}>
        <ol className="grid min-w-[34rem] sm:min-w-0" style={{ gridTemplateColumns: `repeat(${flow.steps.length}, minmax(0, 1fr))` }}>
          {flow.steps.map((item, position) => {
            const current = position === index;
            const done = position < index;
            return (
              <li key={`${flow.id}-${item.label}-${position}`} className="min-w-0 border-r border-border last:border-r-0">
                <button
                  ref={current ? currentRef : undefined}
                  type="button"
                  onClick={() => setIndex(position)}
                  aria-current={current ? "step" : undefined}
                  className={`relative flex h-full w-full items-baseline justify-center gap-1.5 whitespace-nowrap px-2 py-3.5 transition-colors pointer-coarse:min-h-11 ${
                    current ? "bg-primary-soft" : "hover:bg-white/[0.03]"
                  }`}
                >
                  <span className={`font-mono text-[11px] ${current ? "text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" : done ? "text-foreground/70" : "text-muted-foreground"}`}>
                    {String(position + 1).padStart(2, "0")}
                  </span>
                  <span className={`text-[13px] ${current ? "font-medium text-foreground" : done ? "text-foreground/70" : "text-muted-foreground"}`}>{item.label}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>

      {/* Explanation */}
      <div className="grid gap-6 p-5 sm:px-8 sm:py-6 lg:grid-cols-[minmax(0,1fr)_17rem] lg:gap-10">
        <div className="min-w-0">
          <div className="flex items-center justify-between gap-3 lg:justify-start lg:gap-5">
            <p className="label-mono">
              Step {String(index + 1).padStart(2, "0")} of {flow.steps.length}
            </p>
            <p className={`flex items-center gap-1.5 text-xs ${running ? "text-muted-foreground" : "text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]"}`}>
              <span aria-hidden="true" className={`size-1.5 ${running ? "animate-pulse bg-executed motion-reduce:animate-none" : "bg-primary"}`} />
              {reduced ? "Use Back and Next" : running ? "Playing" : "Starts when in view"}
            </p>
          </div>
          <motion.div
            key={`${stepKey}-text`}
            initial={reduced ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: "easeOut" }}
            aria-live="polite"
          >
            <h3 className="mt-4 text-2xl font-normal leading-snug tracking-[-0.015em] text-foreground sm:text-[1.75rem]">{step.title}</h3>
            <p className="mt-3 max-w-2xl text-[15px] leading-7 text-muted-foreground sm:text-base">{step.caption}</p>
            {step.carries || chip ? (
              <div className="mt-5 flex flex-wrap items-center gap-2">
                {step.carries ? (
                  <span className="inline-flex items-center gap-2 border border-border bg-background/60 px-2.5 py-1.5 text-xs text-foreground rounded-xl">
                    <span className="label-mono">Passes on</span>
                    {step.carries}
                  </span>
                ) : null}
                {chip && ChipIcon ? (
                  <span className={`inline-flex items-center gap-1.5 border px-2 py-1.5 text-xs rounded-xl ${chip.className}`}>
                    <ChipIcon className="size-3" aria-hidden="true" />
                    {chip.label}
                  </span>
                ) : null}
              </div>
            ) : null}
          </motion.div>
        </div>

        <div className="flex flex-col justify-between gap-5 border-t border-border pt-5 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
          <div>
            <p className="label-mono flex items-center gap-2">
              <span aria-hidden="true" className={`size-1.5 ${toneDot[flow.tone]}`} />
              Why it matters
            </p>
            <motion.p
              key={`${flow.id}-takeaway`}
              initial={reduced ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.4 }}
              className="mt-2.5 text-[15px] leading-6 text-foreground"
            >
              {flow.takeaway}
            </motion.p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => go(-1)}
              aria-label="Previous step"
              className="bracket bracket-light inline-flex h-10 items-center justify-center gap-2 border border-border bg-white/[0.03] text-[13px] text-foreground transition-colors hover:bg-white/[0.07] pointer-coarse:h-11 rounded-md"
            >
              <ArrowLeft className="size-3.5" aria-hidden="true" /> Back
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              aria-label="Next step"
              className="inline-flex h-10 items-center justify-center gap-2 bg-primary text-[13px] text-primary-foreground transition-opacity hover:opacity-90 pointer-coarse:h-11"
            >
              Next <ArrowRight className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
