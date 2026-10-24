"use client";

import {
  createBrowserHarborClient,
  loadPublicPilotConfig,
  loadWalletSessionStatus,
  type PublicPilotConfig,
  type WalletSessionStatus,
} from "@/lib/harbor-browser";
import { DEFAULT_POLICY, PolicySchema, type Policy } from "@pilot/contracts";
import Link from "next/link";
import {
  AlertCircle,
  ArrowRight,
  BookOpenText,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { MEMORY_GRAPH_EDGES, MEMORY_GRAPH_NODES, MEMORY_NOTES } from "./fixtures";
import {
  fetchLiveMemorySnapshot,
  livePolicyEditorKey,
  loadPersonalizationFixtureSession,
  memoryContextKey,
  memoryPresentation,
  memorySessionExpiryDelay,
  memorySnapshotMatchesContext,
  personalizationPanelScope,
  registerMemoryIdentityRefresh,
  resolveMemoryReadiness,
} from "./live-memory";
import { MemoryGraph } from "./memory-graph";
import { NoteLibrary, NoteReader } from "./note-library";
import { PolicyEditor } from "./policy-editor";
import { StructuredPreferencesPanel } from "./structured-preferences";
import type { MemorySnapshot } from "./types";
import { WorkflowLessonsPanel } from "./workflow-lessons";

type LiveState =
  | { kind: "idle" }
  | { kind: "loading"; key: string }
  | { kind: "refreshing"; key: string; snapshot: MemorySnapshot }
  | { kind: "ready"; key: string; snapshot: MemorySnapshot }
  | { kind: "error"; key: string; message: string };

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Live memory data is unavailable.";
}

export function MemoryWorkspace() {
  const liveHarbor = useMemo(() => createBrowserHarborClient(), []);
  const [config, setConfig] = useState<PublicPilotConfig | null>();
  const [session, setSession] = useState<WalletSessionStatus | null>();
  const [checkingContext, setCheckingContext] = useState(true);
  const [contextRevision, setContextRevision] = useState(0);
  const [personalizationFixtureEnabled, setPersonalizationFixtureEnabled] = useState(false);
  const [liveState, setLiveState] = useState<LiveState>({ kind: "idle" });
  const [demoPolicy, setDemoPolicy] = useState(DEFAULT_POLICY);
  const [selectedNoteId, setSelectedNoteId] = useState(MEMORY_NOTES[0]?.id ?? "");
  const loadGeneration = useRef(0);
  const policyAnchor = useRef<HTMLDivElement>(null);
  const policyHashHandled = useRef(false);
  const refreshContextRef = useRef<() => void>(() => undefined);
  const readiness = resolveMemoryReadiness(
    config,
    session,
    Date.now(),
    personalizationFixtureEnabled,
  );
  const presentation = memoryPresentation(readiness);

  useEffect(() => {
    let active = true;
    let contextGeneration = 0;
    let controller: AbortController | undefined;
    const refreshContext = async () => {
      const generation = ++contextGeneration;
      controller?.abort();
      controller = new AbortController();
      setCheckingContext(true);
      // Identity-bound notes must disappear before revalidating the cookie.
      setConfig(undefined);
      setSession(undefined);
      setLiveState({ kind: "idle" });
      const [nextConfig, nextSession] = await Promise.allSettled([
        loadPublicPilotConfig(globalThis.fetch, controller.signal),
        loadWalletSessionStatus(globalThis.fetch, controller.signal),
      ]);
      if (!active || generation !== contextGeneration) return;
      const resolvedConfig = nextConfig.status === "fulfilled" ? nextConfig.value : null;
      let resolvedSession = nextSession.status === "fulfilled" ? nextSession.value : null;
      let fixtureEnabled = false;
      if (resolvedConfig?.mockMode && resolvedConfig.structuredPreferencesEnabled === true) {
        try {
          const fixtureSession = await loadPersonalizationFixtureSession(
            globalThis.fetch,
            controller.signal,
          );
          if (fixtureSession) {
            resolvedSession = fixtureSession;
            fixtureEnabled = true;
          }
        } catch {
          resolvedSession = null;
        }
      }
      if (!active || generation !== contextGeneration) return;
      setConfig(resolvedConfig);
      setSession(resolvedSession);
      setPersonalizationFixtureEnabled(fixtureEnabled);
      setCheckingContext(false);
      setContextRevision((current) => current + 1);
    };
    refreshContextRef.current = () => void refreshContext();
    void refreshContext();
    const unregister = registerMemoryIdentityRefresh({
      onInvalidate: refreshContextRef.current,
      windowTarget: window,
      documentTarget: document,
      setIntervalImpl: (callback, milliseconds) => window.setInterval(callback, milliseconds),
      clearIntervalImpl: (handle) => window.clearInterval(handle),
    });
    return () => {
      active = false;
      controller?.abort();
      refreshContextRef.current = () => undefined;
      unregister();
    };
  }, []);

  useEffect(() => {
    const delay = memorySessionExpiryDelay(session);
    if (delay === undefined) return;
    const timeout = window.setTimeout(() => refreshContextRef.current(), delay);
    return () => window.clearTimeout(timeout);
  }, [session]);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    if (readiness.kind !== "live") {
      setLiveState({ kind: "idle" });
      return;
    }
    const key = memoryContextKey(readiness.owner, readiness.network);
    const controller = new AbortController();
    setLiveState((current) =>
      (current.kind === "ready" || current.kind === "refreshing") && current.key === key
        ? { kind: "refreshing", key, snapshot: current.snapshot }
        : { kind: "loading", key },
    );
    void fetchLiveMemorySnapshot(
      liveHarbor,
      { owner: readiness.owner, network: readiness.network },
      globalThis.fetch,
      controller.signal,
    ).then(
      (snapshot) => {
        if (generation === loadGeneration.current) {
          setLiveState({ kind: "ready", key, snapshot });
        }
      },
      (cause) => {
        if (generation === loadGeneration.current && !(cause instanceof DOMException && cause.name === "AbortError")) {
          setLiveState({ kind: "error", key, message: errorMessage(cause) });
        }
      },
    );
    return () => controller.abort();
  }, [
    liveHarbor,
    contextRevision,
    readiness.kind,
    readiness.kind === "live" ? readiness.network : undefined,
    readiness.kind === "live" ? readiness.owner : undefined,
  ]);

  const demo = presentation.kind === "demo";
  const candidateSnapshot = liveState.kind === "ready" || liveState.kind === "refreshing"
    ? liveState.snapshot
    : undefined;
  const snapshot = memorySnapshotMatchesContext(candidateSnapshot, readiness)
    ? candidateSnapshot
    : undefined;
  const notes = demo ? MEMORY_NOTES : snapshot?.notes ?? [];
  const nodes = demo ? MEMORY_GRAPH_NODES : snapshot?.nodes ?? [];
  const edges = demo ? MEMORY_GRAPH_EDGES : snapshot?.edges ?? [];
  const policy = demo ? demoPolicy : snapshot?.policy;
  const selectedNote = notes.find((note) => note.id === selectedNoteId) ?? notes[0];
  const personalizationScope = personalizationPanelScope(readiness, snapshot);

  useEffect(() => {
    if (notes.length > 0 && !notes.some((note) => note.id === selectedNoteId)) {
      setSelectedNoteId(notes[0].id);
    }
  }, [notes, selectedNoteId]);

  // The policy renders after the vault loads, so the browser's own #policy jump
  // misses it; scroll once when the anchor first appears.
  const policyReady = Boolean((demo || snapshot) && policy);
  useEffect(() => {
    if (!policyReady || policyHashHandled.current || window.location.hash !== "#policy") return;
    policyHashHandled.current = true;
    policyAnchor.current?.scrollIntoView({ block: "start" });
  }, [policyReady]);

  // Demo saves stay in this component's state; nothing is sent to Harbor.
  const saveDemoPolicy = async (nextPolicy: Policy) => {
    setDemoPolicy(PolicySchema.parse(nextPolicy));
  };

  const demoReason = presentation.kind === "demo" ? presentation.reason : undefined;
  const loading = readiness.kind === "checking" || (readiness.kind === "live" && liveState.kind === "loading");
  const liveError = readiness.kind === "live" && liveState.kind === "error" ? liveState.message : undefined;
  const refreshing = checkingContext || liveState.kind === "refreshing";

  return (
    <div className="w-full min-w-0">
      {demo ? <DemoBand reason={demoReason} /> : null}
      <section className="relative flex min-w-0 flex-col gap-6 overflow-hidden border-b border-border px-4 py-8 sm:px-6 sm:py-10 lg:flex-row lg:items-end lg:justify-between lg:px-8" aria-labelledby="memory-overview-title">
        <div className="relative min-w-0">
          <p className="label-mono flex items-center gap-2"><Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden="true" />Persistent context</p>
          <h1 id="memory-overview-title" className="mt-3 text-[1.75rem] font-semibold leading-tight tracking-[-0.02em] font-display">Your agent&apos;s working memory</h1>
          <p className="label-mono mt-3 max-w-2xl leading-6">{demo ? "Explore a simulated vault of Markdown notes and the execution policy Pilot follows." : "Inspect stored Markdown notes and the execution policy for the authenticated owner and network."}</p>
          {snapshot ? <p className="mt-3 break-all font-mono text-[11px] text-muted-foreground">{snapshot.network} · {snapshot.owner} · snapshot {new Date(snapshot.generatedAt).toLocaleString()}</p> : null}
        </div>
        <dl className="relative flex min-w-0 flex-wrap items-center gap-y-2" aria-label="Memory overview">
          <Metric icon={BookOpenText} value={loading ? "…" : String(notes.length)} label="Notes" />
          <Metric icon={GitBranch} value={loading ? "…" : String(edges.length)} label="Links" />
          <Metric icon={ShieldCheck} value={policy ? `$${policy.execute_under_usd}` : "—"} label="Auto cap" />
        </dl>
      </section>

      <div className="min-w-0 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      {refreshing && snapshot ? (
        <StatusBanner icon={RefreshCw} tone="info">Refreshing wallet scope and data. Displayed live data may be stale until refresh completes.</StatusBanner>
      ) : null}
      {loading ? <StatusBanner icon={LoaderCircle} tone="info" spin>Loading wallet-bound vault notes and Harbor policy…</StatusBanner> : null}
      {liveError ? <StatusBanner icon={AlertCircle} tone="error">{liveError} Demo data is never substituted for a signed-in vault.</StatusBanner> : null}

      {(demo || snapshot) && policy ? (
        <div className="flex min-w-0 flex-col gap-4">
          {selectedNote ? (
            <>
              {/* Row 1: the graph sets the height; the reader fills it and scrolls internally. */}
              <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.08fr)_minmax(0,1fr)] xl:items-stretch">
                <MemoryGraph nodes={nodes} edges={edges} selectedNoteId={selectedNote.id} onSelect={setSelectedNoteId} />
                <div className="relative min-w-0">
                  <NoteReader note={selectedNote} notes={notes} onSelect={setSelectedNoteId} />
                </div>
              </div>
              {/* Row 2: every vault note as a horizontal card strip. */}
              <NoteLibrary notes={notes} selectedId={selectedNote.id} onSelect={setSelectedNoteId} />
            </>
          ) : (
            <section className="border border-border bg-card p-10 text-center rounded-xl overflow-hidden">
              <BookOpenText className="mx-auto h-5 w-5 text-muted-foreground" aria-hidden="true" />
              <h2 className="mt-3 text-sm font-medium">No vault notes</h2>
              <p className="label-mono mt-2 normal-case tracking-normal">The authenticated owner&apos;s vault snapshot contains no supported Pilot Markdown notes.</p>
            </section>
          )}
          {/* Row 3: the execution policy, full width. /memory#policy deep-links here. */}
          <div id="policy" ref={policyAnchor} className="min-w-0 scroll-mt-20">
            <PolicyEditor
              key={demo ? "demo-policy" : livePolicyEditorKey(snapshot!)}
              // Demo saves update page stats only; the editor keeps its own saved
              // baseline, so a stable initial policy avoids a false "refreshed" conflict.
              initialPolicy={demo ? DEFAULT_POLICY : policy}
              mode={demo ? "demo" : "live-readonly"}
              onSave={demo ? saveDemoPolicy : undefined}
            />
          </div>
          {personalizationScope && config?.structuredPreferencesEnabled === true ? (
            <div className="grid min-w-0 gap-4 lg:grid-cols-2">
              <StructuredPreferencesPanel
                scopeKey={`${personalizationScope.network}:${personalizationScope.owner}`}
              />
              <WorkflowLessonsPanel
                scopeKey={`${personalizationScope.network}:${personalizationScope.owner}`}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      </div>
    </div>
  );
}

function DemoBand({ reason }: { reason?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-3 border-b border-border bg-surface px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:hidden" role="note" aria-label="Demo vault">
      <p className="flex min-w-0 items-start gap-2.5 text-[13px] leading-5 text-muted-foreground">
        <span aria-hidden="true" className="mt-[7px] h-1.5 w-1.5 shrink-0 bg-primary" />
        <span>
          <span className="font-medium text-foreground">You&apos;re viewing a demo vault.</span> Connect a wallet to see your own notes and policy.
          {reason ? <span className="mt-0.5 block text-xs">{reason}</span> : null}
        </span>
      </p>
      <Link
        href="/onboarding"
        className="link-dashed inline-flex shrink-0 items-center gap-1.5 self-start text-[13px] font-medium text-foreground sm:self-auto pointer-coarse:py-3.5"
      >
        Get started <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      </Link>
    </div>
  );
}

function StatusBanner({ children, icon: Icon, spin = false, tone }: { children: React.ReactNode; icon: typeof AlertCircle; spin?: boolean; tone: "info" | "error" }) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`mb-5 flex items-start gap-2.5 border px-3.5 py-3 text-xs leading-5 rounded-xl ${tone === "error" ? "border-blocked/35 bg-blocked/[0.07] text-blocked" : "border-border bg-card text-muted-foreground"}`}>
      <Icon className={`mt-px h-3.5 w-3.5 shrink-0 ${spin ? "animate-spin" : ""}`} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

function Metric({ icon: Icon, value, label }: { icon: typeof BookOpenText; value: string; label: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2.5 border-l border-border px-5 first:border-l-0 first:pl-0 last:pr-0">
      <dt className="label-mono flex items-center gap-1.5"><Icon className="h-3 w-3 self-center" aria-hidden="true" />{label}</dt>
      <dd className="truncate font-mono text-sm text-foreground">{value}</dd>
    </div>
  );
}
