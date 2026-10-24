"use client";

import {
  AlertTriangle,
  Check,
  ExternalLink,
  LoaderCircle,
  LockKeyhole,
  Radio,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import React from "react";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

export const AP4M_DEMO_ACTIONS = {
  settle: { label: "Settle now", method: "POST", path: "/demo/ap4m/settle" },
  revoke: { label: "Revoke agent", method: "POST", path: "/demo/ap4m/revoke" },
  rogue: { label: "Run rogue agent", method: "POST", path: "/demo/ap4m/rogue" },
} as const;

const stageSchema = z.enum(["pass", "fail", "pending"]);
export const MerchantValidationEventSchema = z.object({
  id: z.string().trim().min(1).max(96),
  merchant: z.string().trim().min(1).max(80),
  intentId: z.string().trim().min(1).max(128),
  scheme: z.enum(["exact", "xrpl-paychan"]),
  amount: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/).max(32),
  asset: z.string().trim().min(2).max(20).regex(/^[A-Z0-9]+$/),
  stages: z.object({
    identity: stageSchema,
    intent: stageSchema,
    credential: stageSchema,
    payment: stageSchema,
  }).strict(),
  at: z.string().datetime(),
}).strict();
export type MerchantValidationEvent = z.infer<typeof MerchantValidationEventSchema>;

export const LedgerDemoEventSchema = z.object({
  id: z.string().trim().min(1).max(96),
  kind: z.enum(["payment", "claim", "ledger-transaction"]),
  label: z.string().trim().min(1).max(96),
  objectId: z.string().regex(/^[A-Fa-f0-9]{64}$/).optional(),
  at: z.string().datetime(),
}).strict();
export type LedgerDemoEvent = z.infer<typeof LedgerDemoEventSchema>;

export const DemoActionResponseSchema = z.object({
  ok: z.literal(true),
  evidence: z.object({
    schema: z.enum(["ap4m_settle_preview_v1", "ap4m_revoke_preview_v1", "ap4m_rogue_v1"]),
    source: z.literal("offline-injected"),
    network: z.literal("testnet"),
    outcome: z.enum(["previewed", "rejected"]),
    engine_result: z.literal("tecNO_PERMISSION").optional(),
    tx_hash: z.null(),
    rogue_address: z.null().optional(),
    submitted: z.literal(false),
    verified_live: z.literal(false),
    at: z.string().datetime(),
    label: z.string().trim().min(1).max(160),
  }).strict(),
  event: LedgerDemoEventSchema.optional(),
}).strict();
export type DemoActionResponse = z.infer<typeof DemoActionResponseSchema>;

export function summarizeLedgerEvents(events: readonly LedgerDemoEvent[]) {
  return {
    payments: events.filter(({ kind }) => kind === "payment" || kind === "claim").length,
    ledgerTransactions: events.filter(
      ({ kind, objectId }) => kind === "ledger-transaction" || (kind === "payment" && objectId !== undefined),
    ).length,
  };
}

export const DEMO_MERCHANT_EVENTS: readonly MerchantValidationEvent[] = [
  {
    id: "fixture-request-9",
    merchant: "Venue Yield Desk",
    intentId: "demo-intent-…7d21",
    scheme: "xrpl-paychan",
    amount: "0.05",
    asset: "RLUSD",
    stages: { identity: "pass", intent: "pass", credential: "pass", payment: "pass" },
    at: "2026-10-21T20:30:09.000Z",
  },
  {
    id: "fixture-request-8",
    merchant: "Risk Oracle",
    intentId: "demo-intent-…9c04",
    scheme: "exact",
    amount: "0.05",
    asset: "RLUSD",
    stages: { identity: "pass", intent: "pass", credential: "pass", payment: "pass" },
    at: "2026-10-21T20:30:08.000Z",
  },
] as const;

export const DEMO_LEDGER_EVENTS: readonly LedgerDemoEvent[] = [
  { id: "claim-9", kind: "claim", label: "Claim 9 accepted off-ledger", at: "2026-10-21T20:30:09.000Z" },
  { id: "payment-8", kind: "payment", label: "Exact payment validated", objectId: "A".repeat(64), at: "2026-10-21T20:30:08.000Z" },
  { id: "setup-1", kind: "ledger-transaction", label: "Mandate setup batch", objectId: "B".repeat(64), at: "2026-10-21T20:29:00.000Z" },
] as const;

type ActionName = keyof typeof AP4M_DEMO_ACTIONS;
type ActionState = { name: ActionName; status: "idle" | "working" | "done" | "error"; message?: string };

export type Ap4mDemoWorkspaceProps = {
  merchantEventsUrl?: string;
  initialMerchantEvents?: readonly MerchantValidationEvent[];
  initialLedgerEvents?: readonly LedgerDemoEvent[];
};

function safeExplorerUrl(event: LedgerDemoEvent): string | undefined {
  if (!event.objectId) return undefined;
  return event.kind === "claim"
    ? `https://test.bithomp.com/explorer/${event.objectId}`
    : `https://testnet.xrpl.org/transactions/${event.objectId}`;
}

function Stage({ label, state }: { label: string; state: "pass" | "fail" | "pending" }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.08em]">
      <span
        aria-label={`${label}: ${state}`}
        className={state === "pass" ? "grid size-4 place-items-center bg-emerald-700 text-white" :
          state === "fail" ? "grid size-4 place-items-center bg-rose-700 text-white" :
            "grid size-4 place-items-center border border-slate-400 text-slate-500"}
      >
        {state === "pass" ? <Check aria-hidden className="size-3" /> : state === "fail" ? "!" : "·"}
      </span>
      <span>{label}</span>
    </span>
  );
}

export function MerchantConsole({
  events,
  connection,
}: {
  events: readonly MerchantValidationEvent[];
  connection: "fixture" | "connecting" | "live" | "degraded";
}) {
  return (
    <section aria-labelledby="merchant-console-title" className="min-h-0 overflow-hidden bg-[#f7f5ee] p-4">
      <header className="flex items-start justify-between gap-3 border-b border-slate-300 pb-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#59645c]">Merchant console</p>
          <h2 id="merchant-console-title" className="mt-1 text-lg font-semibold">Level 3 validation</h2>
        </div>
        <span className="inline-flex items-center gap-1.5 border border-slate-300 bg-white px-2 py-1 text-[10px] font-semibold uppercase">
          <Radio aria-hidden className="size-3" /> {connection === "live" ? "local SSE" : connection}
        </span>
      </header>
      <div className="mt-3 max-h-[13.5rem] space-y-2 overflow-y-auto" aria-live="polite">
        {events.map((event) => (
          <article className="border border-slate-300 bg-white p-3" key={event.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold">{event.merchant}</p>
                <p className="mt-0.5 truncate font-mono text-[10px] text-slate-500">intentId · {event.intentId}</p>
              </div>
              <p className="shrink-0 font-mono text-xs font-semibold">{event.amount} {event.asset}</p>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-slate-700 sm:grid-cols-4">
              <Stage label="Agent identity" state={event.stages.identity} />
              <Stage label="Intent" state={event.stages.intent} />
              <Stage label="Credential" state={event.stages.credential} />
              <Stage label="Payment" state={event.stages.payment} />
            </div>
            <p className="mt-2 text-[10px] text-slate-500">{event.scheme} · payment object: XRPL</p>
          </article>
        ))}
      </div>
    </section>
  );
}

export function LedgerFeed({ events }: { events: readonly LedgerDemoEvent[] }) {
  const summary = summarizeLedgerEvents(events);
  return (
    <section aria-labelledby="ledger-feed-title" className="min-h-0 overflow-hidden bg-[#efede5] p-4">
      <header className="flex items-end justify-between gap-3 border-b border-slate-300 pb-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#59645c]">XRPL Testnet</p>
          <h2 id="ledger-feed-title" className="mt-1 text-lg font-semibold">Ledger feed</h2>
        </div>
        <dl className="flex gap-4 text-right">
          <div><dt className="text-[9px] font-bold uppercase text-slate-500">Payments</dt><dd className="font-mono text-xl font-semibold">{summary.payments}</dd></div>
          <div><dt className="text-[9px] font-bold uppercase text-slate-500">Ledger transactions</dt><dd className="font-mono text-xl font-semibold">{summary.ledgerTransactions}</dd></div>
        </dl>
      </header>
      <p className="mt-2 text-[10px] leading-4 text-slate-600">Claims increment payments only. A ledger transaction is counted only when XRPL records one.</p>
      <ul className="mt-2 space-y-1.5">
        {events.slice(0, 4).map((event) => {
          const href = safeExplorerUrl(event);
          return (
            <li className="flex items-center justify-between gap-3 border border-slate-300 bg-white px-3 py-2 text-xs" key={event.id}>
              <span className="min-w-0 truncate">{event.label}</span>
              {href ? (
                <a
                  aria-label={`Open fixture ${event.label} in Testnet explorer`}
                  className="inline-flex shrink-0 items-center gap-1 text-[10px] text-sky-800 underline"
                  href={href}
                  rel="noreferrer"
                  target="_blank"
                >
                  fixture link <ExternalLink aria-hidden className="size-3.5" />
                </a>
              ) : <span className="shrink-0 text-[10px] text-slate-500">off-ledger fixture</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function PilotDemoPanel() {
  return (
    <section aria-labelledby="pilot-demo-title" className="min-h-0 overflow-y-auto bg-white p-5">
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#235a52]">Workspace</p>
      <h2 id="pilot-demo-title" className="mt-1 text-xl font-semibold">Authorize once. Buy within bounds.</h2>
      <div className="mt-4 space-y-3 text-sm">
        <p className="ml-auto max-w-[88%] bg-[#e9eee8] p-3">Buy nine $0.05 reports from the approved merchants.</p>
        <p className="max-w-[92%] border-l-2 border-[#235a52] bg-[#f5f3ec] p-3">I found two credential-gated Testnet merchants. Your mandate caps every payment, day, and lifetime total.</p>
      </div>
      <article className="mt-4 border-2 border-[#235a52] bg-[#f9faf7] p-4" aria-label="Mandate approval preview">
        <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">One mandate approval</h3><ShieldCheck aria-hidden className="size-5 text-[#235a52]" /></div>
        <dl className="mt-3 grid grid-cols-3 gap-px bg-slate-300 text-xs">
          <div className="bg-white p-2"><dt className="text-slate-500">Per payment</dt><dd className="mt-1 font-mono font-semibold">$0.05</dd></div>
          <div className="bg-white p-2"><dt className="text-slate-500">Daily</dt><dd className="mt-1 font-mono font-semibold">$5.00</dd></div>
          <div className="bg-white p-2"><dt className="text-slate-500">Merchants</dt><dd className="mt-1 font-mono font-semibold">2 only</dd></div>
        </dl>
        <p className="mt-3 inline-flex items-center gap-2 text-xs text-slate-600"><LockKeyhole aria-hidden className="size-4" /> Preview fixture · no wallet action</p>
      </article>
      <article className="mt-4 border border-slate-300 bg-white p-4" aria-label="Latest AP4M receipt preview">
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-emerald-800">claim_accepted · mock evidence</p>
        <h3 className="mt-1 font-semibold">Receipt · Mandate → Intent → L3 → Payment → Ledger</h3>
        <p className="mt-2 text-xs leading-5 text-slate-600">Payment 9 used an off-ledger cumulative claim. No new ledger transaction is claimed.</p>
      </article>
    </section>
  );
}

export function DemoControls({ onLedgerEvent }: { onLedgerEvent?: (event: LedgerDemoEvent) => void }) {
  const [action, setAction] = useState<ActionState>({ name: "settle", status: "idle" });
  async function run(name: ActionName) {
    const definition = AP4M_DEMO_ACTIONS[name];
    setAction({ name, status: "working" });
    try {
      const response = await fetch(definition.path, { method: definition.method, credentials: "same-origin" });
      if (!response.ok) throw new Error(`Demo action unavailable (${response.status})`);
      const result = DemoActionResponseSchema.parse(await response.json());
      if (result.event) onLedgerEvent?.(result.event);
      setAction({
        name,
        status: "done",
        message: `${result.evidence.label} · submitted=false · verified_live=false`,
      });
    } catch (error) {
      setAction({ name, status: "error", message: error instanceof Error ? error.message : "Demo action unavailable" });
    }
  }
  return (
    <div className="border-t border-slate-300 bg-[#faf9f4] p-3">
      <div className="flex flex-wrap gap-2" aria-label="Demo controls">
        {(Object.keys(AP4M_DEMO_ACTIONS) as ActionName[]).map((name) => {
          const definition = AP4M_DEMO_ACTIONS[name];
          const working = action.status === "working" && action.name === name;
          return <button className={name === "revoke" ? "border border-rose-700 bg-white px-3 py-2 text-xs font-semibold text-rose-800 disabled:opacity-50" : "border border-slate-800 bg-white px-3 py-2 text-xs font-semibold disabled:opacity-50"} disabled={action.status === "working"} key={name} onClick={() => void run(name)} type="button">{working ? <LoaderCircle aria-hidden className="mr-1 inline size-3 animate-spin" /> : name === "rogue" ? <AlertTriangle aria-hidden className="mr-1 inline size-3" /> : <RotateCcw aria-hidden className="mr-1 inline size-3" />}{definition.label}</button>;
        })}
      </div>
      <p aria-live="polite" className={action.status === "error" ? "mt-2 text-xs text-rose-800" : "mt-2 text-xs text-slate-600"}>{action.message ?? "Buttons call local, fail-closed demo routes only. No action runs automatically."}</p>
    </div>
  );
}

export function Ap4mDemoWorkspace({
  merchantEventsUrl,
  initialMerchantEvents = DEMO_MERCHANT_EVENTS,
  initialLedgerEvents = DEMO_LEDGER_EVENTS,
}: Ap4mDemoWorkspaceProps) {
  const [merchantEvents, setMerchantEvents] = useState(() => initialMerchantEvents.map((event) => MerchantValidationEventSchema.parse(event)));
  const [ledgerEvents, setLedgerEvents] = useState(() => initialLedgerEvents.map((event) => LedgerDemoEventSchema.parse(event)));
  const [connection, setConnection] = useState<"fixture" | "connecting" | "live" | "degraded">(merchantEventsUrl ? "connecting" : "fixture");

  useEffect(() => {
    if (!merchantEventsUrl) return;
    const source = new EventSource(merchantEventsUrl);
    source.onopen = () => setConnection("live");
    source.onerror = () => setConnection("degraded");
    source.onmessage = ({ data }) => {
      if (typeof data !== "string" || data.length > 16_384) return;
      try {
        const parsed = MerchantValidationEventSchema.safeParse(JSON.parse(data));
        if (parsed.success) setMerchantEvents((current) => [parsed.data, ...current.filter(({ id }) => id !== parsed.data.id)].slice(0, 24));
      } catch { /* malformed local SSE events are ignored */ }
    };
    return () => source.close();
  }, [merchantEventsUrl]);

  const stableLedgerEvents = useMemo(() => ledgerEvents.slice(0, 24), [ledgerEvents]);
  return (
    <div className="grid min-h-[38rem] gap-px border border-slate-400 bg-slate-400 lg:h-[calc(100dvh-11rem)] lg:min-h-[39rem] lg:grid-cols-[1.04fr_0.96fr]">
      <PilotDemoPanel />
      <div className="grid min-h-0 grid-rows-[1fr_1fr_auto] gap-px bg-slate-400">
        <MerchantConsole events={merchantEvents} connection={connection} />
        <LedgerFeed events={stableLedgerEvents} />
        <DemoControls onLedgerEvent={(event) => setLedgerEvents((current) => [event, ...current.filter(({ id }) => id !== event.id)])} />
      </div>
    </div>
  );
}
