"use client";

import { motion } from "framer-motion";
import {
  Ban,
  BookOpen,
  Check,
  CheckCircle2,
  Cpu,
  FileText,
  Link2,
  Lock,
  PenLine,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserRound,
  Wallet,
  X,
} from "lucide-react";
import type { ReactNode } from "react";

import type { ArtifactKind, LoopBranch } from "./learning-loop-data";

/** Stagger helper: children fade and rise in one after another. */
function Stagger({ children, reduced, step = 0.35, className = "" }: { children: ReactNode[]; reduced: boolean; step?: number; className?: string }) {
  return (
    <div className={className}>
      {children.map((child, index) => (
        <motion.div
          key={index}
          initial={reduced ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: reduced ? 0 : 0.25 + index * step, duration: 0.35, ease: "easeOut" }}
        >
          {child}
        </motion.div>
      ))}
    </div>
  );
}

const tick = "h-3.5 w-3.5 shrink-0 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]";
const mono = "font-mono text-[10px] uppercase tracking-wide";
const row = "flex items-center gap-2 border border-border bg-background px-3 py-2 text-[13px]";

function Pill({ tone, children }: { tone: "ok" | "warn" | "bad" | "info" | "accent"; children: ReactNode }) {
  const tones = {
    ok: "border-executed/30 bg-executed/10 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]",
    warn: "border-approval/30 bg-approval/10 text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))]",
    bad: "border-destructive/30 bg-destructive/10 text-destructive",
    info: "border-info/30 bg-info/10 text-info",
    accent: "border-primary/40 bg-primary/10 text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]",
  } as const;
  return <span className={`inline-flex items-center gap-1.5 border px-1.5 py-0.5 ${mono} ${tones[tone]}`}>{children}</span>;
}

/** The small illustration shown for each step of the loop. */
export function LoopArtifact({ kind, branch, reduced }: { kind: ArtifactKind; branch: LoopBranch; reduced: boolean }) {
  const amount = branch === "auto" ? "120" : "500";
  const buy = branch === "blocked" ? "FREEMONEY" : "XRP";

  switch (kind) {
    case "ask":
      return (
        <Stagger reduced={reduced} className="space-y-2">
          {[
            <div key="q" className="ml-auto flex max-w-[92%] items-start justify-end gap-2">
              <p className="border border-border bg-white/[0.05] px-3.5 py-2.5 text-[13px] leading-5 text-foreground">
                Swap {amount} RLUSD for {buy}.{" "}
                <motion.mark
                  initial={reduced ? false : { backgroundColor: "rgba(0,0,0,0)" }}
                  animate={{ backgroundColor: "color-mix(in srgb, var(--primary) 16%, transparent)" }}
                  transition={{ delay: reduced ? 0 : 1.6, duration: 0.6 }}
                  className="bg-transparent px-0.5 text-foreground"
                >
                  I prefer risk caveats first.
                </motion.mark>
              </p>
              <span className="grid h-8 w-8 shrink-0 place-items-center border border-border bg-card text-muted-foreground"><UserRound className="h-4 w-4" aria-hidden="true" /></span>
            </div>,
            <p key="n" className={`${mono} text-muted-foreground`}>Highlighted: a preference Pilot can offer to remember</p>,
          ]}
        </Stagger>
      );

    case "checks":
      return (
        <Stagger reduced={reduced} className="space-y-1.5">
          {[
            ["Signed in", "Session verified"],
            ["Your wallet", "Proved it's yours"],
            ["AI model", "The one you picked"],
            ["Approved preferences", "Loaded, if you have any"],
          ].map(([label, detail]) => (
            <div key={label} className={row}>
              <Check className={tick} aria-hidden="true" />
              <span className="font-medium text-foreground">{label}</span>
              <span className="ml-auto text-xs text-muted-foreground">{detail}</span>
            </div>
          ))}
        </Stagger>
      );

    case "tools":
      return (
        <div className="space-y-2">
          <p className={`${mono} text-muted-foreground`}>What the model is allowed to do</p>
          <Stagger reduced={reduced} step={0.22} className="grid grid-cols-2 gap-1.5">
            {[
              ["Read market data", true],
              ["Search your notes", true],
              ["Propose a trade", true],
              ["Suggest a preference", true],
              ["Sign or send money", false],
            ].map(([label, allowed]) => (
              <div key={String(label)} className={`${row} ${allowed ? "" : "col-span-2 border-destructive/30 bg-destructive/[0.05]"}`}>
                {allowed ? <Check className={tick} aria-hidden="true" /> : <Lock className="h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden="true" />}
                <span className={allowed ? "text-foreground" : "text-destructive line-through decoration-1"}>{label}</span>
                {allowed ? null : <span className={`${mono} ml-auto text-destructive`}>Not a tool</span>}
              </div>
            ))}
          </Stagger>
        </div>
      );

    case "lookup":
      return (
        <Stagger reduced={reduced} className="space-y-2">
          {[
            <div key="s" className={row}>
              <BookOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="text-muted-foreground">Search:</span>
              <span className="text-foreground">RLUSD swaps</span>
              <span className={`${mono} ml-auto text-muted-foreground`}>Your vault only</span>
            </div>,
            <div key="r" className="border border-border bg-background px-3 py-2.5">
              <p className="flex items-center gap-2 text-[13px] font-medium text-foreground"><FileText className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />Trades/2026-10-14.md</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">Sold 80 RLUSD for XRP on the DEX · validated · linked to [[RLUSD]] and [[XRPL DEX]]</p>
            </div>,
          ]}
        </Stagger>
      );

    case "propose":
      return (
        <div className="space-y-2.5">
          <p className="border border-border bg-background px-3 py-2 font-mono text-xs uppercase tracking-wide text-foreground">Sell {amount} RLUSD · receive {buy}</p>
          <Stagger reduced={reduced} step={0.55} className="flex flex-wrap items-center gap-1.5">
            {["Drafted", "Planned", "Simulated ✓"].map((state, index) => (
              <span key={state} className="flex items-center gap-1.5">
                {index > 0 ? <span aria-hidden="true" className="text-muted-foreground">→</span> : null}
                <Pill tone={index === 2 ? "ok" : "info"}>{state}</Pill>
              </span>
            ))}
          </Stagger>
          <p className="text-xs leading-5 text-muted-foreground">A simulation runs the trade against the ledger without actually doing it.</p>
        </div>
      );

    case "policy": {
      const value = branch === "auto" ? 120 : 500;
      const pct = Math.min(100, (value / 2000) * 100);
      const verdict = branch === "approval" ? <Pill tone="warn">Ask the owner</Pill> : branch === "auto" ? <Pill tone="ok">Run it</Pill> : <Pill tone="bad">Block</Pill>;
      const rules: [string, boolean][] = [
        ["Network is Testnet", true],
        ["Token issuer on your allowlist", branch !== "blocked"],
        ["Under $2,000 per trade", true],
        ["Slippage under 1%", true],
      ];
      return (
        <div className="space-y-3">
          <div>
            <p className="mb-1.5 flex items-baseline justify-between gap-3 text-[13px] text-foreground">
              <span>This trade: <span className="font-mono">${value}</span></span>
              <span className={`${mono} text-muted-foreground`}>Your limits</span>
            </p>
            <div className="relative h-2 w-full border border-border bg-background">
              <motion.div
                className={`h-full ${branch === "approval" ? "bg-approval" : branch === "auto" ? "bg-executed" : "bg-muted-foreground/50"}`}
                initial={reduced ? false : { width: 0 }}
                animate={{ width: `${pct}%` }}
                transition={{ delay: reduced ? 0 : 0.3, duration: 1.2, ease: "easeOut" }}
              />
              <span aria-hidden="true" className="absolute inset-y-[-4px] w-px bg-foreground/70" style={{ left: "12.5%" }} />
            </div>
            <div className="relative mt-1.5 h-4 font-mono text-[10px] text-muted-foreground">
              <span className="absolute" style={{ left: "12.5%", transform: "translateX(-50%)" }}>$250 auto</span>
              <span className="absolute right-0">$2,000 max</span>
            </div>
          </div>
          <Stagger reduced={reduced} step={0.3} className="space-y-1">
            {rules.map(([label, pass]) => (
              <p key={label} className="flex items-center gap-2 text-[13px] text-foreground">
                {pass ? <Check className={tick} aria-hidden="true" /> : <X className="h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden="true" />}
                <span className={pass ? "" : "text-destructive"}>{label}</span>
              </p>
            ))}
          </Stagger>
          <motion.div initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: reduced ? 0 : 2.2 }} className="flex items-center gap-2">
            <span className={`${mono} text-muted-foreground`}>Harbor decides</span>
            {verdict}
          </motion.div>
        </div>
      );
    }

    case "sign":
      return (
        <Stagger reduced={reduced} step={0.6} className="space-y-1.5">
          {[
            <div key="w" className="flex items-center gap-2.5 border border-approval/30 bg-approval/[0.06] px-3 py-2.5">
              <Wallet className="h-4 w-4 shrink-0 text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))]" aria-hidden="true" />
              <span className="text-[13px] text-foreground">Your wallet shows: sell 500 RLUSD → ≈963.85 XRP</span>
            </div>,
            <div key="s" className={row}><PenLine className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />You sign<span className={`${mono} ml-auto text-muted-foreground`}>Sign only</span></div>,
            <div key="h" className={row}><ShieldCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />Harbor checks it matches this approval<Check className={`${tick} ml-auto`} aria-hidden="true" /></div>,
            <div key="l" className={row}><Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />Submitted to the XRP Ledger</div>,
          ]}
        </Stagger>
      );

    case "auto":
      return (
        <Stagger reduced={reduced} step={0.5} className="space-y-1.5">
          {[
            <div key="d" className={row}><ShieldCheck className={tick} aria-hidden="true" />Signed by Harbor&apos;s limited permission<span className={`${mono} ml-auto text-muted-foreground`}>7 actions only</span></div>,
            <div key="i" className={row}><RotateCcw className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />Sent once, even if the connection drops</div>,
            <div key="l" className={row}><Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />Submitted to the XRP Ledger</div>,
          ]}
        </Stagger>
      );

    case "blocked":
      return (
        <Stagger reduced={reduced} step={0.5} className="space-y-1.5">
          {[
            <div key="b" className="flex items-center gap-2.5 border border-destructive/30 bg-destructive/[0.05] px-3 py-2.5 text-[13px] text-destructive">
              <Ban className="h-4 w-4 shrink-0" aria-hidden="true" />Blocked: FREEMONEY&apos;s issuer isn&apos;t on your allowlist
            </div>,
            <div key="n" className={row}><X className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />Nothing signed, nothing sent</div>,
            <div key="r" className={row}><Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />Won&apos;t be retried</div>,
          ]}
        </Stagger>
      );

    case "ledger":
      return (
        <div className="space-y-2">
          <motion.div
            initial={reduced ? false : { opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: reduced ? 0 : 0.4, duration: 0.4 }}
            className="border border-executed/30 bg-executed/[0.06] px-3.5 py-3"
          >
            <p className="flex items-center gap-2 text-[13px] font-medium text-foreground">
              <CheckCircle2 className={tick} aria-hidden="true" /> Validated in ledger #9,843,206
            </p>
            <p className="mt-1 font-mono text-xs text-muted-foreground">tesSUCCESS · received {branch === "auto" ? "231.32" : "963.85"} XRP</p>
          </motion.div>
          <p className="text-xs leading-5 text-muted-foreground">Until this point the card never says &ldquo;done&rdquo;.</p>
        </div>
      );

    case "record":
      return (
        <div className="space-y-2">
          <p className={`${mono} text-muted-foreground`}>Saved to your vault, linked together</p>
          <Stagger reduced={reduced} step={0.28} className="grid grid-cols-2 gap-1.5">
            {["Trades/…md", "Journal/2026-10-21.md", "Venues/XRPL DEX.md", "Tokens/RLUSD.md", "Reflections/…md"].map((note) => (
              <div key={note} className={`${row} py-1.5`}>
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="truncate font-mono text-[11px] text-foreground">{note}</span>
              </div>
            ))}
          </Stagger>
        </div>
      );

    case "learn":
      return (
        <Stagger reduced={reduced} step={0.6} className="space-y-1.5">
          {[
            <div key="m" className="border border-border bg-background px-3 py-2.5">
              <p className="flex items-center gap-2 text-[13px] text-foreground">
                <Sparkles className="h-3.5 w-3.5 shrink-0 text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" aria-hidden="true" />
                Remember: <span className="font-medium">&ldquo;I prefer risk caveats first.&rdquo;</span>
              </p>
              <p className={`${mono} mt-1.5 flex items-center gap-1.5 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]`}>
                <Check className="h-3 w-3" aria-hidden="true" /> Matches your exact words
              </p>
            </div>,
            <div key="h" className="flex items-start gap-2 border border-dashed border-border-strong px-3 py-2 text-xs leading-5 text-muted-foreground">
              <Cpu className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span><span className="text-foreground">Hermes, with your consent:</span> &ldquo;Sensible. It only changes how answers are ordered.&rdquo;</span>
            </div>,
            <div key="o" className="flex items-center gap-2 border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
              <BookOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              Also noticed: 3 RLUSD trades. Add RLUSD context?
              <span className={`${mono} ml-auto`}>Needs your OK</span>
            </div>,
          ]}
        </Stagger>
      );

    case "review":
      return (
        <div className="space-y-2.5">
          <div className="flex flex-wrap gap-1.5">
            <motion.span
              initial={reduced ? false : { scale: 1 }}
              animate={reduced ? undefined : { scale: [1, 0.94, 1] }}
              transition={{ delay: 0.9, duration: 0.35 }}
              className="inline-flex items-center gap-1.5 bg-foreground px-3 py-1.5 font-mono text-[11px] uppercase tracking-wide text-background"
            >
              <Check className="h-3.5 w-3.5" aria-hidden="true" /> Accept
            </motion.span>
            {["Reject", "Correct", "Forget"].map((action) => (
              <span key={action} className="inline-flex items-center gap-1.5 border border-border px-3 py-1.5 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                {action === "Forget" ? <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                {action}
              </span>
            ))}
          </div>
          <motion.p
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: reduced ? 0 : 1.5 }}
            className="flex items-center gap-2 border border-executed/30 bg-executed/[0.06] px-3 py-2 text-[13px] text-foreground"
          >
            <CheckCircle2 className={tick} aria-hidden="true" /> Saved to your vault: &ldquo;risk caveats first&rdquo;
          </motion.p>
        </div>
      );

    case "next":
      return (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className={`${mono} text-muted-foreground`}>Model</span>
            <span className="relative inline-flex">
              <motion.span
                initial={reduced ? { opacity: 0 } : { opacity: 1 }}
                animate={{ opacity: 0 }}
                transition={{ delay: reduced ? 0 : 1.1, duration: 0.3 }}
                className="absolute"
              >
                <Pill tone="info">Model A</Pill>
              </motion.span>
              <motion.span initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: reduced ? 0 : 1.3, duration: 0.3 }}>
                <Pill tone="accent">Model B</Pill>
              </motion.span>
            </span>
            <span className="text-xs text-muted-foreground">switched, preference kept</span>
          </div>
          <Stagger reduced={reduced} step={0.4} className="space-y-1">
            {[
              <div key="r" className={`${row} py-1.5`}><Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />Safety rules: never change limits or signing</div>,
              <div key="p" className={`${row} border-primary/30 bg-primary/[0.05] py-1.5`}><Sparkles className="h-3.5 w-3.5 shrink-0 text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" aria-hidden="true" />Your preference: risk caveats first</div>,
              <div key="q" className={`${row} py-1.5`}><UserRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />&ldquo;Compare XRP and RLUSD routes&rdquo;</div>,
            ]}
          </Stagger>
          <motion.p initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: reduced ? 0 : 2.6 }} className="text-[13px] leading-5 text-foreground">
            &ldquo;Key risks first: the AMM pool is thin right now…&rdquo;
          </motion.p>
        </div>
      );
  }
}
