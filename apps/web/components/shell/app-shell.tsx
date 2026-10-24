"use client";

import {
  ArrowRight,
  Bot,
  BookOpenText,
  CandlestickChart,
  Check,
  ChevronDown,
  CircleDollarSign,
  ExternalLink,
  LoaderCircle,
  Map,
  Menu,
  MessageCircle,
  Navigation2,
  Settings2,
  Sparkles,
  WalletCards,
  X,
} from "lucide-react";
import Link from "next/link";
import React, { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { signOutPilotWallet } from "../../lib/wallet-sign-out";

import {
  DELEGATION_STATUS_LOADING,
  loadDelegationStatus,
  registerShellIdentityRefresh,
  shellIdentityLabels,
  shellSessionExpiryDelay,
  shellWalletAction,
  type DelegationStatusState,
  type ShellIdentityLabels,
} from "./delegation-status";

export const SHELL_SIDEBAR_SLOT_ID = "pilot-sidebar-slot";
/** Bottom-of-sidebar slot for page context (e.g. chat's Live context). */
export const SHELL_SIDEBAR_FOOTER_SLOT_ID = "pilot-sidebar-footer-slot";

export async function persistModelSelection(
  fetcher: typeof fetch,
  nextModel: string,
  nextMode: "demo" | "oauth",
): Promise<void> {
  const response = await fetcher("/api/auth/openrouter/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      nextMode === "demo"
        ? { mode: "demo", model: nextModel }
        : { model: nextModel },
    ),
  });
  const result = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(result.error ?? "Could not save the model.");
}

export function demoSwitchRevocationNotice(
  previousMode: "demo" | "oauth",
): string | undefined {
  return previousMode === "oauth"
    ? "Pilot switched this browser session to the server-managed free demo. Your OpenRouter-generated key remains active until you revoke it in OpenRouter settings; it is not used by the free demo."
    : undefined;
}

/** Logged-out visitors (no wallet session) see the simulated demo. */
function isSignedOut(identity: ShellIdentityLabels): boolean {
  return identity.walletStatus === "disconnected" || identity.walletStatus === "unavailable";
}

type NavKey = "chat" | "markets" | "map" | "portfolio" | "strategy" | "memory" | "how-it-works";

const navigation = [
  { key: "chat", label: "Chat", href: "/chat", icon: MessageCircle },
  { key: "markets", label: "Markets", href: "/markets", icon: CandlestickChart },
  { key: "map", label: "Map", href: "/map", icon: Map },
  { key: "portfolio", label: "Portfolio", href: "/portfolio", icon: CircleDollarSign },
  { key: "strategy", label: "Strategy", href: "/strategy", icon: Bot },
  { key: "memory", label: "Memory", href: "/memory", icon: Sparkles },
  { key: "how-it-works", label: "How it works", href: "/how-it-works", icon: BookOpenText },
] as const;

export function AppShell({
  active = "chat",
  title,
  eyebrow,
  ownHeading = false,
  children,
}: {
  active?: NavKey;
  title: string;
  eyebrow?: string;
  /** The page renders its own h1, so the top-bar title is plain text. */
  ownHeading?: boolean;
  children: ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  const drawerOpenerRef = useRef<HTMLButtonElement>(null);
  const drawerWasOpen = useRef(false);
  // Move focus into the drawer when it opens, and back to the menu button when it closes.
  useEffect(() => {
    if (mobileOpen) {
      drawerWasOpen.current = true;
      drawerCloseRef.current?.focus();
    } else if (drawerWasOpen.current) {
      drawerWasOpen.current = false;
      drawerOpenerRef.current?.focus();
    }
  }, [mobileOpen]);
  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);
  const delegationStatus = useDelegationStatus();
  const identity = shellIdentityLabels(delegationStatus.identity);
  const signedOut = isSignedOut(identity);
  // While the wallet status loads, show neither the demo CTA nor signed-in chrome.
  const signedIn = !signedOut && identity.walletStatus !== "loading";

  return (
    <div className="min-h-dvh min-w-0 bg-background text-foreground">
      <a
        href="#main-content"
        className="fixed left-3 top-3 z-50 -translate-y-24 bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition focus:translate-y-0"
      >
        Skip to content
      </a>

      <aside aria-label="Sidebar" className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-border bg-sidebar lg:flex lg:flex-col">
        <div className="flex h-16 items-center border-b border-border px-5">
          <Brand />
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-5">
          <nav aria-label="Primary">
            <NavGroup active={active} />
          </nav>
          {/* Page-specific context (e.g. chat session) is portalled in here. */}
          <div id={SHELL_SIDEBAR_SLOT_ID} className="mt-5 empty:hidden" />
          {/* Bottom padding keeps sidebar content clear of the Ask Pilot button, which sits in this corner. */}
          <div className="mt-auto space-y-3 pt-5 lg:pb-14">
            {/* Page-specific footer context (e.g. chat's Live context) is portalled in here. */}
            <div id={SHELL_SIDEBAR_FOOTER_SLOT_ID} className="empty:hidden" />
            {signedOut ? <SidebarDemoCard /> : null}
            {!signedIn ? null : (
              <>
                <div className="xl:hidden"><NetworkBadge identity={identity} /></div>
                <DelegationStatus status={delegationStatus} />
              </>
            )}
          </div>
        </div>
      </aside>

      {mobileOpen ? (
        <button
          type="button"
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}
      <aside
        aria-label="Mobile navigation"
        inert={!mobileOpen}
        className={`fixed inset-y-0 left-0 z-40 flex w-[min(82vw,18rem)] flex-col border-r border-border bg-sidebar transition-transform lg:hidden ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex h-14 items-center justify-between border-b border-border px-4">
          <Brand />
          <button
            ref={drawerCloseRef}
            type="button"
            onClick={() => setMobileOpen(false)}
            className="grid h-8 w-8 place-items-center text-muted-foreground hover:bg-white/5 hover:text-foreground pointer-coarse:h-11 pointer-coarse:w-11"
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-5">
          <nav aria-label="Primary (mobile)">
            <NavGroup active={active} />
          </nav>
          {!signedIn ? null : (
            <div className="mt-6 space-y-3">
              <NetworkBadge identity={identity} />
              <DelegationStatus status={delegationStatus} />
            </div>
          )}
          {signedOut ? <div className="mt-auto pt-6"><SidebarDemoCard /></div> : null}
        </div>
      </aside>

      <div className="min-w-0 lg:pl-64">
        <header className="sticky top-0 z-20 flex h-14 min-w-0 items-center gap-3 border-b border-border bg-background/92 px-4 backdrop-blur-md sm:px-6 lg:h-16 lg:px-8">
          <button
            ref={drawerOpenerRef}
            type="button"
            onClick={() => setMobileOpen(true)}
            className="-ml-1 grid h-8 w-8 place-items-center text-muted-foreground hover:bg-white/5 hover:text-foreground pointer-coarse:-ml-2.5 pointer-coarse:h-11 pointer-coarse:w-11 lg:hidden"
            aria-label="Open navigation"
          >
            <Menu className="h-4 w-4" />
          </button>
          <div className="flex min-w-0 items-baseline gap-3">
            {ownHeading ? <p className="truncate text-lg font-medium tracking-[-0.01em]">{title}</p> : <h1 className="truncate text-lg font-medium tracking-[-0.01em]">{title}</h1>}
            {eyebrow ? <p className="label-mono hidden truncate md:block">{eyebrow}</p> : null}
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-5">
            {signedOut ? <DemoAccountCta /> : null}
            {signedIn ? (
              <>
                <StatusStrip identity={identity} />
                <SettingsMenu identity={identity} />
              </>
            ) : null}
          </div>
        </header>
        <main id="main-content" className="min-w-0">{children}</main>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5 focus-visible:outline-offset-4 pointer-coarse:min-h-11" aria-label="Pilot home">
      <Navigation2 className="h-5 w-5 rotate-45 text-foreground" strokeWidth={1.75} aria-hidden="true" />
      <span className="text-lg font-medium tracking-tight">Pilot</span>
    </Link>
  );
}

function NavGroup({ active }: { active: NavKey }) {
  return (
    <ul className="space-y-0.5">
      {navigation.map((item) => (
        <li key={item.key}>
          <NavItem item={item} active={active === item.key} />
        </li>
      ))}
    </ul>
  );
}

function NavItem({ item, active }: { item: (typeof navigation)[number]; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={`group flex h-9 items-center gap-3 rounded-md px-2.5 text-sm font-medium transition focus-visible:outline-offset-[-2px] ${
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      }`}
    >
      <Icon className={`h-4 w-4 ${active ? "text-primary" : ""}`} strokeWidth={1.75} aria-hidden="true" />
      {item.label}
    </Link>
  );
}

/** Logged-out visitors explore a simulated demo; this is the way in for real. */
function DemoAccountCta() {
  return (
    <Link
      href="/onboarding"
      className="inline-flex h-9 items-center gap-2 bg-primary px-3 pointer-coarse:h-11 text-[13px] font-medium text-primary-foreground transition hover:bg-primary/90 rounded-md"
    >
      <span className="sm:hidden">Sign up</span>
      <span className="hidden sm:inline">Create account</span>
    </Link>
  );
}

/** Signed-out state stays explicit on every app page. */
function SidebarDemoCard() {
  return (
    <div role="note" aria-label="Demo mode" className="bracket bracket-accent rounded-xl border border-primary/30 bg-[color-mix(in_srgb,var(--primary)_5%,var(--sidebar))] p-3">
      <p className="label-mono flex items-center gap-2 text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]">
        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
        Demo mode
      </p>
      <p className="mt-2 text-[12px] leading-[1.125rem] text-muted-foreground">
        Chat, Portfolio and Memory run on sample data until you connect a wallet.
      </p>
      <Link href="/onboarding" className="link-dashed mt-3 inline-flex min-h-11 items-center gap-1.5 text-[13px] font-medium text-foreground">
        Get started <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      </Link>
    </div>
  );
}

function NetworkBadge({ identity }: { identity: ShellIdentityLabels }) {
  return (
    <div className="flex items-center justify-between border border-border px-3 py-2.5 rounded-xl">
      <span className="label-mono">Network</span>
      <span className="text-xs font-medium text-foreground">XRPL {identity.networkLabel}</span>
    </div>
  );
}

const walletTone: Record<ShellIdentityLabels["walletStatus"], string> = {
  loading: "bg-muted-foreground animate-pulse",
  unavailable: "bg-destructive",
  disconnected: "bg-muted-foreground",
  "network-mismatch": "bg-approval",
  connected: "bg-executed",
};

function StatusStrip({ identity }: { identity: ShellIdentityLabels }) {
  return (
    <dl className="hidden min-w-0 items-center gap-5 xl:flex">
      <div className="flex items-center gap-2.5">
        <dt className="label-mono">Network</dt>
        <dd className="text-xs text-foreground">{identity.networkLabel}</dd>
      </div>
      <span aria-hidden="true" className="h-4 w-px bg-border" />
      <div className="flex min-w-0 items-center gap-2.5">
        <dt className="label-mono">Wallet</dt>
        <dd className="flex min-w-0 items-center gap-1.5 text-xs text-foreground">
          <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 ${walletTone[identity.walletStatus]}`} />
          <span className="truncate">{identity.walletLabel}</span>
        </dd>
      </div>
    </dl>
  );
}

const delegationTone: Record<DelegationStatusState["kind"], string> = {
  loading: "bg-muted-foreground animate-pulse",
  "missing-session": "bg-muted-foreground",
  unknown: "bg-muted-foreground",
  error: "bg-destructive",
  pending: "bg-approval",
  active: "bg-executed",
  suspended: "bg-approval",
  revoked: "bg-destructive",
};

function useDelegationStatus(): DelegationStatusState {
  const [status, setStatus] = useState<DelegationStatusState>(DELEGATION_STATUS_LOADING);
  const activeRef = useRef(false);
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | undefined>(undefined);

  const refresh = useCallback(() => {
    if (!activeRef.current) return;
    generationRef.current += 1;
    const currentGeneration = generationRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setStatus(DELEGATION_STATUS_LOADING);
    void loadDelegationStatus(undefined, controller.signal).then((next) => {
      if (activeRef.current && currentGeneration === generationRef.current) setStatus(next);
    }).catch((cause) => {
      if (
        activeRef.current &&
        currentGeneration === generationRef.current &&
        !(cause instanceof DOMException && cause.name === "AbortError")
      ) {
        setStatus({
          kind: "error",
          label: "Delegation unavailable",
          detail: "Pilot could not verify the delegation status.",
          identity: { kind: "unavailable" },
        });
      }
    });
  }, []);

  useEffect(() => {
    activeRef.current = true;
    refresh();
    const unregister = registerShellIdentityRefresh({
      onInvalidate: refresh,
      windowTarget: window,
      documentTarget: document,
      setIntervalImpl: (callback, milliseconds) => window.setInterval(callback, milliseconds),
      clearIntervalImpl: (handle) => window.clearInterval(handle),
    });
    return () => {
      activeRef.current = false;
      generationRef.current += 1;
      controllerRef.current?.abort();
      unregister();
    };
  }, [refresh]);

  useEffect(() => {
    const delay = shellSessionExpiryDelay(status.identity);
    if (delay === undefined) return;
    const timeout = window.setTimeout(refresh, delay);
    return () => window.clearTimeout(timeout);
  }, [refresh, status.identity]);

  return status;
}


function DelegationStatus({ status }: { status: DelegationStatusState }) {
  return (
    <div
      className="border border-border p-3 rounded-xl"
      aria-live="polite"
      aria-label={`Delegation: ${status.label}`}
    >
      <p className="label-mono">Delegation</p>
      <div className="mt-2 flex items-start gap-2 text-sm font-medium">
        <span aria-hidden="true" className={`mt-[7px] h-1.5 w-1.5 shrink-0 ${delegationTone[status.kind]}`} />
        <span>{status.label}</span>
      </div>
      <p className="mt-1.5 line-clamp-3 text-[11px] leading-4 text-muted-foreground" title={status.detail}>
        {status.detail}
      </p>
    </div>
  );
}

function SettingsMenu({ identity }: { identity: ShellIdentityLabels }) {
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState("nvidia/nemotron-3.5-super-vl:free");
  const [mode, setMode] = useState<"demo" | "oauth">("demo");
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string>();
  const rootRef = useRef<HTMLDivElement>(null);
  const walletAction = shellWalletAction(identity.walletStatus);
  // Logged-out visitors are in the simulated demo: no model or session calls.
  const demo = identity.walletStatus === "disconnected" || identity.walletStatus === "unavailable";
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open || demo) return;
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    setNotice(undefined);
    void (async () => {
      try {
        const sessionResponse = await fetch("/api/auth/openrouter/session", { signal: controller.signal });
        if (!sessionResponse.ok) {
          const failure = (await sessionResponse.json().catch(() => undefined)) as { code?: string } | undefined;
          // Missing server configuration is not the visitor's error; say so calmly.
          setNotice(
            failure?.code === "SESSION_UNAVAILABLE"
              ? "Model settings need server configuration (SESSION_SECRET)."
              : "Model settings are unavailable right now.",
          );
          return;
        }
        const session = (await sessionResponse.json()) as { mode: "demo" | "oauth"; model: string };
        setMode(session.mode);
        setModel(session.model);
        const modelsResponse = await fetch(`/api/auth/openrouter/models?mode=${session.mode}`, { signal: controller.signal });
        if (!modelsResponse.ok) {
          setNotice("The model list is unavailable right now; your current model is kept.");
          return;
        }
        const result = (await modelsResponse.json()) as { models?: { id: string; name: string }[] };
        setModels(result.models ?? []);
      } catch (cause) {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) {
          setNotice("Model settings are unavailable right now.");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [open, demo]);

  const saveModel = async (nextModel: string, nextMode = mode): Promise<boolean> => {
    setSaving(true);
    setError(undefined);
    try {
      await persistModelSelection(fetch, nextModel, nextMode);
      setModel(nextModel);
      setMode(nextMode);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the model.");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const switchToDemo = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const response = await fetch("/api/auth/openrouter/models?mode=demo");
      const result = (await response.json()) as {
        error?: string;
        models?: { id: string; name: string }[];
      };
      if (!response.ok) throw new Error(result.error ?? "The free demo is unavailable.");
      const demoModels = result.models ?? [];
      const freeModel = demoModels[0]?.id;
      if (!freeModel) throw new Error("No demo model is currently available.");
      await persistModelSelection(fetch, freeModel, "demo");
      setModels(demoModels);
      setModel(freeModel);
      setMode("demo");
      setNotice(demoSwitchRevocationNotice(mode));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The free demo is unavailable.");
    } finally {
      setSaving(false);
    }
  };

  const disconnectOpenRouter = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const response = await fetch("/api/auth/openrouter/session", { method: "DELETE" });
      const result = (await response.json()) as { error?: string; model?: string };
      if (!response.ok) throw new Error(result.error ?? "Could not disconnect OpenRouter.");
      setMode("demo");
      if (result.model) setModel(result.model);
      setModels([]);
      setNotice("OpenRouter was disconnected from this browser session only. Revoke the generated key in OpenRouter settings if needed.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not disconnect OpenRouter.");
    } finally {
      setSaving(false);
    }
  };

  const signOutWallet = async () => {
    setSigningOut(true);
    setError(undefined);
    try {
      await signOutPilotWallet();
      // DELETE /api/auth/wallet/session also clears model-access cookies. Keep
      // local settings in the same signed-out state before leaving this page.
      setMode("demo");
      setModels([]);
      setNotice(undefined);
      window.location.assign("/onboarding?wallet=signed-out");
    } catch (cause) {
      setError(cause instanceof Error
        ? cause.message
        : "Pilot could not clear the wallet authorization session.");
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label="Settings"
        aria-expanded={open}
        aria-controls="pilot-settings"
        onClick={() => setOpen((value) => !value)}
        className="bracket bracket-light flex h-9 items-center gap-2 border border-border bg-white/[0.03] px-2.5 text-[13px] text-foreground transition hover:bg-white/[0.06] sm:px-3 rounded-md"
      >
        <Settings2 className="h-4 w-4" />
        <span className="hidden sm:inline">Settings</span>
        <ChevronDown className={`hidden h-3.5 w-3.5 transition-transform sm:block ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div
          id="pilot-settings"
          role="dialog"
          aria-label="Model and wallet settings"
          className="absolute right-0 top-11 z-50 w-[min(21rem,calc(100vw-2rem))] border border-border-strong bg-popover shadow-xl shadow-black/[0.08] rounded-xl"
        >
          <div className="border-b border-border px-4 py-3">
            <p className="text-sm font-medium">Pilot settings</p>
            <p className="label-mono mt-1">Model access · owner signing</p>
          </div>
          {demo ? (
            <div className="border-b border-border p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="label-mono">AI access</span>
                <span className="border border-primary/35 bg-primary-soft px-1.5 py-0.5 text-xs font-medium text-[color-mix(in_srgb,var(--primary)_72%,var(--foreground))] rounded">Demo</span>
              </div>
              <p className="label-mono mt-4 flex items-center gap-2"><Bot className="h-3.5 w-3.5" aria-hidden="true" />Model</p>
              <p className="mt-2 border border-border bg-background px-2.5 py-2 font-mono text-xs text-muted-foreground rounded-xl">Simulated responses · no model calls</p>
              <p className="mt-2 text-[11px] leading-4 text-muted-foreground">Create an account to choose a model and bring your own OpenRouter key.</p>
            </div>
          ) : (
            <>
            <div className="border-b border-border p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="label-mono">AI access</span>
                <span className={`border px-1.5 py-0.5 text-xs font-medium rounded ${mode === "oauth" ? "border-executed/30 bg-executed/10 text-executed" : "border-border text-muted-foreground"}`}>{mode === "oauth" ? "OpenRouter" : "Demo"}</span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <a href="/api/auth/openrouter/start?returnTo=/chat" className="inline-flex items-center justify-center gap-1.5 bg-primary px-2 py-2 text-[13px] font-medium text-primary-foreground hover:bg-primary/90">
                  Sign in <ExternalLink className="h-3 w-3" />
                </a>
                <button type="button" onClick={() => void switchToDemo()} className="border border-border-strong px-2 py-2 text-[13px] font-medium hover:bg-white/5 rounded-xl">Try demo</button>
              </div>
              {mode === "oauth" ? <button type="button" onClick={() => void disconnectOpenRouter()} disabled={saving} className="mt-2 w-full border border-border px-2 py-2 text-xs font-medium text-muted-foreground hover:bg-white/5 disabled:opacity-50 rounded-xl">Disconnect OpenRouter locally</button> : null}
            </div>
            <label className="block border-b border-border p-4">
              <span className="label-mono flex items-center gap-2"><Bot className="h-3.5 w-3.5" aria-hidden="true" />Model</span>
              <select
                value={model}
                onChange={(event) => void saveModel(event.target.value)}
                disabled={loading || saving}
                className="mt-2 w-full min-w-0 border border-input bg-background px-2.5 py-2 text-xs text-foreground pointer-coarse:text-base rounded-xl"
              >
                {models.length === 0 ? <option value={model}>{model}</option> : null}
                {models.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
              </select>
              <span className="mt-2 flex min-h-4 items-center gap-1.5 text-[11px] text-muted-foreground">
                {loading || saving ? <><LoaderCircle className="h-3 w-3 animate-spin" />{loading ? "Loading tool-capable models" : "Saving selection"}</> : mode === "demo" ? "Demo shows free, tool-capable models only." : "Using your OpenRouter account."}
              </span>
            </label>
            </>
          )}
          {error ? <p role="alert" className="mx-4 mt-3 border border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] leading-4 text-destructive rounded-xl">{error}</p> : null}
          {notice && !demo ? <p role="status" className="mx-4 mt-3 border border-border bg-muted px-3 py-2 text-[11px] leading-4 text-muted-foreground rounded-xl">{notice}</p> : null}
          <div className="p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="label-mono flex items-center gap-2"><WalletCards className="h-3.5 w-3.5" aria-hidden="true" />Wallet</span>
              <span className={`flex items-center gap-1.5 text-[11px] font-semibold ${identity.walletStatus === "connected" ? "text-executed" : identity.walletStatus === "network-mismatch" ? "text-approval" : identity.walletStatus === "unavailable" ? "text-destructive" : "text-muted-foreground"}`}>
                {identity.walletStatus === "loading"
                  ? <LoaderCircle className="h-3 w-3 animate-spin" />
                  : identity.walletStatus === "connected"
                    ? <Check className="h-3 w-3" />
                    : <X className="h-3 w-3" />}
                {identity.walletLabel}
              </span>
            </div>
            {identity.walletAccount ? <p className="mt-2 truncate font-mono text-xs">{identity.walletAccount}</p> : null}
            <p className="mt-2 text-[11px] leading-4 text-muted-foreground">{identity.walletDetail}</p>
            {walletAction.href ? (
              <Link
                href={walletAction.href}
                className="mt-3 block w-full border border-border-strong px-3 py-2 text-center text-[13px] font-medium hover:bg-white/5 rounded-xl"
              >
                {walletAction.label}
              </Link>
            ) : (
              <span
                aria-disabled="true"
                className="mt-3 block w-full cursor-not-allowed border border-border px-3 py-2 text-center text-[13px] font-medium text-muted-foreground rounded-xl"
              >
                {walletAction.label}
              </span>
            )}
            {identity.walletStatus === "connected" || identity.walletStatus === "network-mismatch" ? (
              <>
                <p className="mt-3 text-[11px] leading-4 text-muted-foreground">
                  Signing out clears Pilot&apos;s wallet and model session in this browser. It does not revoke an active trading delegation, pause an autonomous strategy, or sign out of your wallet extension. An active strategy continues until you separately pause, stop, or kill it.
                </p>
                <button
                  type="button"
                  onClick={() => void signOutWallet()}
                  disabled={signingOut}
                  className="mt-3 w-full border border-border px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50 rounded-xl"
                >
                  {signingOut ? "Signing out…" : "Sign out of Pilot"}
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
