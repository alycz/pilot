"use client";

import { useState } from "react";

export type VerificationSummary = {
  mode: "mock" | "sandbox";
  label: "Mastercard Open Finance · mock" | "Mastercard Open Finance · sandbox";
  owner_name_masked: string;
  owner_name_hash: string;
  customer_ref_hash: string;
  balance: number;
  currency: string;
  last4: string;
  proposed_budget_usd: number;
  budget_rule: string;
};

interface OpenFinanceStepProps {
  dailyCapUsd: number;
  onVerified?: (value: VerificationSummary & { mandate_budget_usd: number }) => void;
}

async function responseJson<T>(response: Response): Promise<T> {
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Mastercard Open Finance request failed");
  return data;
}

export function OpenFinanceStep({ dailyCapUsd, onVerified }: OpenFinanceStepProps) {
  const [stage, setStage] = useState<"idle" | "linking" | "linked" | "verified">("idle");
  const [label, setLabel] = useState("Mastercard Open Finance · mock");
  const [summary, setSummary] = useState<VerificationSummary>();
  const [budget, setBudget] = useState(5);
  const [error, setError] = useState<string>();

  async function start() {
    setError(undefined);
    setStage("linking");
    try {
      const started = await responseJson<{ link: string; label: string }>(
        await fetch("/api/mastercard/open-finance/start", { method: "POST" }),
      );
      setLabel(started.label);
      window.open(started.link, "pilot-mastercard-data-connect", "popup,width=480,height=720");
      setStage("linked");
    } catch (cause) {
      setStage("idle");
      setError(cause instanceof Error ? cause.message : "Unable to start verification");
    }
  }

  async function verify() {
    setError(undefined);
    try {
      await responseJson(await fetch("/api/mastercard/open-finance/refresh", { method: "POST" }));
      const next = await responseJson<VerificationSummary>(
        await fetch(
          `/api/mastercard/open-finance/summary?daily_cap_usd=${encodeURIComponent(String(dailyCapUsd))}`,
        ),
      );
      setSummary(next);
      setLabel(next.label);
      setBudget(next.proposed_budget_usd);
      setStage("verified");
      onVerified?.({ ...next, mandate_budget_usd: next.proposed_budget_usd });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to verify account");
    }
  }

  function lowerBudget(value: number) {
    if (!summary) return;
    const next = Math.max(0, Math.min(value, summary.proposed_budget_usd));
    setBudget(next);
    onVerified?.({ ...summary, mandate_budget_usd: next });
  }

  return (
    <section className="rounded-3xl border border-border bg-card p-5" aria-labelledby="open-finance-title">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">{label}</p>
      <h3 id="open-finance-title" className="mt-2 text-xl font-semibold">Verify with Mastercard</h3>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        Link a mock or sandbox account to verify the owner and propose a bounded mandate budget.
        Raw owner details and Open Finance credentials stay server-side.
      </p>

      {stage === "verified" && summary ? (
        <div className="mt-5 space-y-4">
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4">
            <p className="font-semibold">Verified owner · {summary.label}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {summary.owner_name_masked} · Checking •••• {summary.last4} · {summary.currency}{" "}
              {summary.balance.toLocaleString()}
            </p>
          </div>
          <label className="block text-sm font-medium">
            Proposed mandate budget (USD)
            <input
              className="mt-2 w-full rounded-2xl border border-border bg-background px-3 py-2"
              type="number"
              min={0}
              max={summary.proposed_budget_usd}
              step="1"
              value={budget}
              onChange={(event) => lowerBudget(Number(event.target.value))}
            />
          </label>
          <p className="text-xs leading-5 text-muted-foreground">
            Proposed as min(policy daily cap, max($5, floor(2% of checking balance))). You can lower
            it, never raise it above the proposal.
          </p>
        </div>
      ) : (
        <button
          type="button"
          className="mt-5 rounded-2xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground disabled:opacity-60"
          disabled={stage === "linking"}
          onClick={stage === "linked" ? verify : start}
        >
          {stage === "linking"
            ? "Opening Data Connect…"
            : stage === "linked"
              ? "I linked my account"
              : "Open Data Connect"}
        </button>
      )}

      {error ? <p role="alert" className="mt-3 text-sm text-red-600">{error}</p> : null}
    </section>
  );
}
