"use client";

import { motion } from "framer-motion";
import {
  Check,
  Cpu,
  Landmark,
  MessagesSquare,
  Navigation2,
  NotebookText,
  ShieldCheck,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { LoopArtifact } from "./loop-artifacts";
import {
  branchOptions,
  loopBoundaries,
  loopLinks,
  loopNodes,
  loopScenes,
  type LoopBranch,
  type LoopNode,
  type LoopNodeId,
} from "./learning-loop-data";

const nodeIcons: Record<LoopNodeId, LucideIcon> = {
  you: UserRound,
  pilot: Navigation2,
  model: Cpu,
  harbor: ShieldCheck,
  ledger: Landmark,
  vault: NotebookText,
  hermes: MessagesSquare,
};

const nodeById = new Map(loopNodes.map((node) => [node.id, node]));
const linkKey = (a: LoopNodeId, b: LoopNodeId) => [a, b].sort().join("|");

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
 * Animated walkthrough of one message running Pilot's whole loop: a diagram
 * with a travelling "message", a narration panel that explains each step in
 * plain words, and controls to play, scrub and switch outcomes.
 */
export function LearningLoop() {
  const reduced = usePrefersReducedMotion();
  const [branch, setBranch] = useState<LoopBranch>("approval");
  const scenes = useMemo(() => loopScenes(branch), [branch]);
  const [index, setIndex] = useState(0);
  const [hoverPaused, setHoverPaused] = useState(false);
  const [focusPaused, setFocusPaused] = useState(false);
  const [visible, setVisible] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const currentStepRef = useRef<HTMLButtonElement>(null);
  const diagramRef = useRef<HTMLDivElement>(null);
  const [diagramSize, setDiagramSize] = useState(480);
  const [wide, setWide] = useState(true);

  // Track the diagram's size so the message can stop exactly at each box edge.
  useEffect(() => {
    const element = diagramRef.current;
    if (!element) return;
    const query = window.matchMedia("(min-width: 640px)");
    const update = () => {
      setDiagramSize(element.clientWidth);
      setWide(query.matches);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    query.addEventListener("change", update);
    return () => {
      observer.disconnect();
      query.removeEventListener("change", update);
    };
  }, []);
  const scrubberRef = useRef<HTMLDivElement>(null);
  const scene = scenes[Math.min(index, scenes.length - 1)]!;

  // It plays on its own whenever it's on screen and loops back to the start.
  // A mouse resting on it, or keyboard focus inside it, pauses it so people
  // can read; reduced-motion users step through it with the step bar instead.
  const running = visible && !hoverPaused && !focusPaused && !reduced;

  // Track whether the diagram is on screen.
  useEffect(() => {
    const element = rootRef.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const inView = Boolean(entry?.isIntersecting);
        setVisible(inView);
      },
      { threshold: 0.35 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => {
      setIndex((current) => (current >= scenes.length - 1 ? 0 : current + 1));
    }, scene.ms);
    return () => window.clearTimeout(timer);
  }, [index, running, scene.ms, scenes.length]);

  // Keep the current step visible in the scrubber on narrow screens (horizontal scroll only).
  useEffect(() => {
    const strip = scrubberRef.current;
    const step = currentStepRef.current;
    if (!strip || !step || strip.scrollWidth <= strip.clientWidth) return;
    const target = step.offsetLeft - (strip.clientWidth - step.offsetWidth) / 2;
    strip.scrollTo({ left: Math.max(0, target), behavior: reduced ? "auto" : "smooth" });
  }, [index, reduced]);

  const goTo = useCallback(
    (next: number) => {
      // Jumping to a step restarts its timer; playback carries on from there.
      setIndex(Math.max(0, Math.min(scenes.length - 1, next)));
    },
    [scenes.length],
  );

  const chooseBranch = (next: LoopBranch) => {
    if (next === branch) return;
    setBranch(next);
    // Jump to the limits check so the new outcome plays straight away.
    setIndex(5);
  };

  // Path of the travelling message for this step.
  const route = useMemo(() => scene.route.map((id) => nodeById.get(id)!), [scene]);
  const activeIds = new Set<LoopNodeId>(scene.route);
  const activeLinks = new Set(scene.route.slice(1).map((id, step) => linkKey(scene.route[step]!, id)));
  const destination = route[route.length - 1]!;
  const packetPath = useMemo(() => {
    // Half the node box in diagram percent: the message rests on the box's
    // border, exactly where the line attaches, instead of on top of the icon.
    const half = (id: LoopNodeId) => (id === "pilot" ? (wide ? 32 : 28) : wide ? 24 : 22) / Math.max(diagramSize, 1) * 100;
    const edge = (from: LoopNode, toward: LoopNode) => {
      const dx = toward.x - from.x;
      const dy = toward.y - from.y;
      const t = half(from.id) / Math.max(Math.abs(dx), Math.abs(dy), 0.0001);
      return { x: from.x + dx * t, y: from.y + dy * t };
    };
    if (route.length === 1) {
      const node = route[0]!;
      return [edge(node, nodeById.get(node.id === "pilot" ? "you" : "pilot")!)];
    }
    const points: { x: number; y: number }[] = [];
    route.slice(1).forEach((node, step) => {
      const from = route[step]!;
      points.push(edge(from, node), edge(node, from));
    });
    return points;
  }, [route, diagramSize, wide]);
  // Constant speed: each leg gets time in proportion to its length, so short
  // hops across a box don't take as long as a full line. Only the very start
  // and end ease, which keeps multi-hop routes from stuttering at every node.
  const motionPlan = useMemo(() => {
    const lengths = packetPath.slice(1).map((point, step) => Math.hypot(point.x - packetPath[step]!.x, point.y - packetPath[step]!.y));
    const total = lengths.reduce((sum, length) => sum + length, 0);
    if (packetPath.length < 2 || total === 0) return { duration: 0, times: undefined, ease: undefined };
    let run = 0;
    const times = [0, ...lengths.map((length) => (run += length) / total)];
    const ease = lengths.map((_, step) =>
      lengths.length === 1 ? "easeInOut" : step === 0 ? "easeIn" : step === lengths.length - 1 ? "easeOut" : "linear",
    ) as ("easeIn" | "easeOut" | "easeInOut" | "linear")[];
    return { duration: reduced ? 0 : Math.min(2.2, Math.max(0.6, total / 75)), times, ease };
  }, [packetPath, reduced]);

  return (
    <div ref={rootRef} className="space-y-6">
      <div
        className="border border-border bg-card rounded-xl"
        onFocus={(event) => setFocusPaused(event.target instanceof HTMLElement && event.target.matches(":focus-visible"))}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusPaused(false);
        }}
      >
        {/* Outcome switch */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
          <p className="label-mono">Watch one message run the whole loop</p>
          <div role="radiogroup" aria-label="Outcome" className="grid w-full grid-cols-3 border border-border sm:flex sm:w-auto rounded-xl">
            {branchOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={branch === option.id}
                title={option.hint}
                onClick={() => chooseBranch(option.id)}
                className={`h-8 border-r border-border px-2 text-xs transition last:border-r-0 sm:px-3 pointer-coarse:h-11 ${
                  branch === option.id ? "bg-white/[0.08] text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <span className="sm:hidden">{option.short}</span>
                <span className="hidden sm:inline">{option.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="grid min-w-0 lg:grid-cols-2">
          {/* Diagram */}
          <div className="relative min-w-0 overflow-hidden border-b border-border px-6 py-8 sm:p-10 lg:border-b-0 lg:border-r">
            <div ref={diagramRef} className="relative mx-auto aspect-square w-full max-w-[30rem]" role="img" aria-label={`Diagram, step ${index + 1}: ${scene.title}`}>
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden="true">
                {loopLinks.map(([from, to]) => {
                  const a = nodeById.get(from)!;
                  const b = nodeById.get(to)!;
                  const active = activeLinks.has(linkKey(from, to));
                  const optional = Boolean(a.optional || b.optional);
                  return (
                    <line
                      key={`${from}-${to}`}
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      vectorEffect="non-scaling-stroke"
                      strokeWidth={active ? 2 : 1}
                      strokeDasharray={optional ? "4 4" : undefined}
                      style={{ stroke: active ? "var(--primary)" : "var(--border-strong)", transition: "stroke 300ms, stroke-width 300ms" }}
                    />
                  );
                })}
              </svg>

              {loopNodes.map((node) => {
                const Icon = nodeIcons[node.id];
                const active = activeIds.has(node.id);
                const here = node.id === destination.id;
                return (
                  <div
                    key={node.id}
                    className="absolute -translate-x-1/2 -translate-y-1/2"
                    style={{ left: `${node.x}%`, top: `${node.y}%` }}
                  >
                    <span
                      className={`grid place-items-center border transition-colors duration-300 ${node.id === "pilot" ? "h-14 w-14 sm:h-16 sm:w-16" : "h-11 w-11 sm:h-12 sm:w-12"} ${
                        here
                          ? "bracket bracket-accent border-primary-soft-border bg-primary-soft text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]"
                          : active
                            ? "border-border-strong bg-card text-foreground"
                            : `${node.optional ? "border-dashed rounded-xl" : ""} border-border bg-card text-muted-foreground`
                      }`}
                    >
                      <Icon className={node.id === "pilot" ? "h-6 w-6" : "h-5 w-5"} strokeWidth={1.6} aria-hidden="true" />
                    </span>
                    {/* Labels hang below the box so the box itself sits exactly on the line ends. */}
                    <span className="absolute left-1/2 top-full mt-2.5 flex -translate-x-1/2 flex-col items-center text-center">
                      <span className={`whitespace-nowrap bg-card/80 px-1 text-[11px] font-medium sm:text-xs ${active ? "text-foreground" : "text-muted-foreground"}`}>{node.label}</span>
                      <span className="hidden whitespace-nowrap bg-card/80 px-1 text-xs text-muted-foreground sm:block">
                        {node.optional ? "Optional · your consent" : node.role}
                      </span>
                    </span>
                  </div>
                );
              })}

              {/* The travelling message */}
              <motion.span
                key={`${branch}-${scene.id}`}
                aria-hidden="true"
                className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-1/2"
                initial={{ left: `${packetPath[0]!.x}%`, top: `${packetPath[0]!.y}%` }}
                animate={{ left: packetPath.map((point) => `${point.x}%`), top: packetPath.map((point) => `${point.y}%`) }}
                transition={{ duration: motionPlan.duration, times: motionPlan.times, ease: motionPlan.ease ?? "easeInOut", delay: reduced ? 0 : 0.1 }}
              >
                <span className="relative block h-3 w-3 bg-primary shadow-[0_0_0_3px_color-mix(in_srgb,var(--primary)_22%,transparent)]">
                  {reduced ? null : <span className="absolute inset-0 animate-ping bg-primary/50" />}
                </span>
              </motion.span>
            </div>
          </div>

          {/* Narration: resting the mouse here pauses so the text can be read. */}
          <div
            className="flex min-w-0 flex-col p-4 sm:p-6"
            onPointerEnter={(event) => {
              if (event.pointerType === "mouse") setHoverPaused(true);
            }}
            onPointerLeave={() => setHoverPaused(false)}
          >
            <div className="flex items-center justify-between gap-3">
              <p className="label-mono">
                Step {String(index + 1).padStart(2, "0")} of {scenes.length}
              </p>
              <p className={`flex items-center gap-1.5 text-xs ${running ? "text-muted-foreground" : "text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]"}`}>
                <span aria-hidden="true" className={`h-1.5 w-1.5 ${running ? "animate-pulse bg-executed motion-reduce:animate-none" : "bg-primary"}`} />
                {reduced ? "Use the steps below" : running ? "Playing" : hoverPaused || focusPaused ? "Paused while you read" : "Paused"}
              </p>
            </div>

            <motion.div
              key={`${branch}-${scene.id}-text`}
              initial={reduced ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className="mt-4"
              aria-live="polite"
            >
              <h3 className="text-xl font-normal leading-snug tracking-[-0.01em] text-foreground">{scene.title}</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{scene.caption}</p>
            </motion.div>

            <div key={`${branch}-${scene.id}-art`} className="mt-5 min-h-[14rem] flex-1">
              <LoopArtifact kind={scene.artifact} branch={branch} reduced={reduced} />
            </div>
          </div>
        </div>

        {/* Scrubber */}
        <div ref={scrubberRef} className="overflow-x-auto border-t border-border" role="region" aria-label="Steps" tabIndex={0}>
          {/* Equal columns, so the middle divider lines up with the split between the diagram and the explanation. */}
          <ol className="grid min-w-[60rem] lg:min-w-0" style={{ gridTemplateColumns: `repeat(${scenes.length}, minmax(0, 1fr))` }}>
            {scenes.map((item, position) => {
              const current = position === index;
              return (
                <li key={item.id} className="min-w-0 border-r border-border last:border-r-0">
                  <button
                    ref={current ? currentStepRef : undefined}
                    type="button"
                    onClick={() => goTo(position)}
                    aria-current={current ? "step" : undefined}
                    className={`flex h-full w-full items-baseline justify-center gap-1.5 whitespace-nowrap px-1.5 py-3.5 transition pointer-coarse:min-h-11 ${
                      current ? "bg-primary-soft" : "hover:bg-white/[0.03]"
                    }`}
                  >
                    <span className={`font-mono text-[11px] ${current ? "text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" : "text-muted-foreground"}`}>{String(position + 1).padStart(2, "0")}</span>
                    <span className={`text-[13px] lg:text-xs xl:text-[13px] ${current ? "font-medium text-foreground" : "text-muted-foreground"}`}>{item.label}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      </div>

      {/* Boundaries */}
      <section aria-labelledby="loop-boundaries-title" className="grid gap-4 border border-border bg-card p-5 sm:p-6 lg:grid-cols-[14rem_minmax(0,1fr)] rounded-xl overflow-hidden">
        <div>
          <p className="label-mono">Privacy and control</p>
          <h3 id="loop-boundaries-title" className="mt-2 text-[15px] font-medium text-foreground">What the loop never does.</h3>
        </div>
        <ul className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
          {loopBoundaries.map((boundary) => (
            <li key={boundary} className="flex items-start gap-2.5 text-[13px] leading-5 text-muted-foreground">
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]" aria-hidden="true" />
              {boundary}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
