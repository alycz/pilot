"use client";

import type { Network, Policy } from "@pilot/contracts";
import { AlertCircle, Check, ChevronDown, ChevronUp, LoaderCircle, RotateCcw, Save, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  POLICY_NETWORKS,
  createPolicyDraft,
  policyDraftEquals,
  policyRefreshConflictIsObsolete,
  reconcilePolicyRefresh,
  settleGuardedPolicySave,
  validatePolicyDraft,
} from "./policy-utils";
import type { PolicyDraft } from "./types";

export const DELEGATED_TRANSACTION_TYPES = [
  "OfferCreate",
  "OfferCancel",
  "TrustSet",
  "AMMDeposit",
  "AMMWithdraw",
  "EscrowFinish",
  "CheckCash",
] as const;

type SaveState = "idle" | "saving" | "saved" | "error";

export function PolicyEditor({
  initialPolicy,
  mode,
  onSave,
}: {
  initialPolicy: Policy;
  mode: "demo" | "live-readonly";
  onSave?: (policy: Policy) => Promise<void>;
}) {
  const readOnly = mode === "live-readonly";
  const initialDraft = useMemo(() => createPolicyDraft(initialPolicy), [initialPolicy]);
  const [baseline, setBaseline] = useState<PolicyDraft>(initialDraft);
  const [draft, setDraft] = useState<PolicyDraft>(initialDraft);
  const [errors, setErrors] = useState<Partial<Record<keyof PolicyDraft, string>>>({});
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [pendingRefresh, setPendingRefresh] = useState<{
    draft: PolicyDraft;
    fields: Array<keyof PolicyDraft>;
  }>();
  const [statusMessage, setStatusMessage] = useState(
    readOnly
      ? "Loaded from Harbor for the authenticated owner and network. Live vault policy editing is not available from this read-only view."
      : "", // The demo band at the top of the page already says edits are local.
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const inFlight = useRef(false);
  const pendingRefreshRef = useRef(pendingRefresh);
  pendingRefreshRef.current = pendingRefresh;
  const observedSource = useRef(initialDraft);
  const sourceRevision = useRef(0);
  if (!policyDraftEquals(observedSource.current, initialDraft)) {
    observedSource.current = initialDraft;
    sourceRevision.current += 1;
  }
  const dirty = !policyDraftEquals(draft, baseline);

  useEffect(() => {
    if (readOnly) {
      if (!policyDraftEquals(baseline, initialDraft) || !policyDraftEquals(draft, initialDraft)) {
        setBaseline(initialDraft);
        setDraft(initialDraft);
        setErrors({});
        setSaveState("idle");
        setPendingRefresh(undefined);
        setStatusMessage("Refreshed from Harbor for the authenticated owner and network.");
      }
      return;
    }

    const reconciliation = reconcilePolicyRefresh(baseline, draft, initialDraft);
    if (reconciliation.kind === "unchanged") {
      if (policyRefreshConflictIsObsolete(baseline, initialDraft, pendingRefresh?.draft)) {
        setPendingRefresh(undefined);
        setSaveState("idle");
        setStatusMessage("The conflicting refresh is obsolete. Your unsaved edits are preserved.");
      }
      return;
    }
    if (reconciliation.kind === "conflict") {
      setPendingRefresh({ draft: reconciliation.incoming, fields: reconciliation.fields });
      setSaveState("error");
      setStatusMessage("Policy changed while you had unsaved edits. Review the refresh conflict before saving.");
      return;
    }
    setBaseline(reconciliation.baseline);
    setDraft(reconciliation.draft);
    setErrors({});
    setSaveState("idle");
    setPendingRefresh(undefined);
    setStatusMessage(
      reconciliation.kind === "merge"
        ? "Policy refreshed; your non-conflicting unsaved edits were preserved."
        : "Demo policy reloaded.",
    );
  }, [initialDraft, readOnly]);

  const setField = <K extends keyof PolicyDraft>(field: K, value: PolicyDraft[K]) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    if (saveState !== "saving") setSaveState("idle");
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current || readOnly || !onSave || pendingRefresh) return;
    if (!dirty) {
      setStatusMessage("No changes to save.");
      return;
    }
    const result = validatePolicyDraft(draft);
    if (!result.ok) {
      setErrors(result.errors);
      if (
        result.errors.allowed_tx_types ||
        result.errors.x402_max_per_call_drops ||
        result.errors.x402_daily_cap_drops
      ) {
        setAdvancedOpen(true);
      }
      setSaveState("error");
      setStatusMessage("Review the highlighted policy fields.");
      return;
    }

    inFlight.current = true;
    const sourceRevisionAtSaveStart = sourceRevision.current;
    setSaveState("saving");
    setStatusMessage(readOnly ? "Saving policy…" : "Saving in this demo session…");
    try {
      const completion = await settleGuardedPolicySave(
        onSave(result.policy),
        sourceRevisionAtSaveStart,
        () => ({
          sourceRevision: sourceRevision.current,
          refreshConflictPending: pendingRefreshRef.current !== undefined,
        }),
      );
      if (completion.kind === "stale") {
        setSaveState("error");
        setStatusMessage("Policy refreshed while the save was in progress. The older save response was not applied; resolve the refreshed policy before saving again.");
        return;
      }
      const savedDraft = createPolicyDraft(result.policy);
      setBaseline(savedDraft);
      setDraft(savedDraft);
      setErrors({});
      setSaveState("saved");
      setPendingRefresh(undefined);
      setStatusMessage("Policy saved.");
    } catch (cause) {
      setSaveState("error");
      setStatusMessage(cause instanceof Error ? cause.message : "Policy could not be saved.");
    } finally {
      inFlight.current = false;
    }
  };

  const cancel = () => {
    if (inFlight.current) return;
    const resetTo = pendingRefresh?.draft ?? baseline;
    setDraft({
      ...resetTo,
      allowed_tx_types: [...resetTo.allowed_tx_types],
      networks: [...resetTo.networks],
    });
    if (pendingRefresh) setBaseline(resetTo);
    setPendingRefresh(undefined);
    setErrors({});
    setSaveState("idle");
    setStatusMessage(pendingRefresh ? "Unsaved changes discarded; refreshed policy loaded." : "Unsaved changes discarded.");
  };

  return (
    <section className="min-w-0 overflow-hidden border border-border bg-card rounded-xl" aria-labelledby="policy-title">
      <header className="border-b border-border px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <h2 id="policy-title" className="text-[1.25rem] font-normal leading-tight tracking-[-0.02em]">Execution policy</h2>
            </div>
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{readOnly ? "Live Harbor policy for the wallet-bound owner and network." : <>The limits Pilot checks before every action, stored as <span className="font-mono">Pilot/Policy.md</span>.</>}</p>
          </div>
          {readOnly ? <span className={`shrink-0 border px-1.5 py-0.5 text-xs font-medium rounded ${readOnly ? "border-executed/35 bg-executed/10 text-executed" : "border-primary-soft-border bg-primary-soft text-[color-mix(in_srgb,var(--primary)_72%,var(--foreground))]"}`}>{readOnly ? "Live read" : "Demo"}</span> : null}
        </div>
      </header>

      <form onSubmit={submit} noValidate>
        <div className="space-y-6 p-5">
          <fieldset>
            <legend className="label-mono">Autonomy limits</legend>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <NumberField disabled={readOnly} label="Auto-execute under" prefix="$" value={draft.execute_under_usd} error={errors.execute_under_usd} onChange={(value) => setField("execute_under_usd", value)} />
              <NumberField disabled={readOnly} label="Per transaction" prefix="$" value={draft.max_per_tx_usd} error={errors.max_per_tx_usd} onChange={(value) => setField("max_per_tx_usd", value)} />
              <NumberField disabled={readOnly} label="Daily cap" prefix="$" value={draft.daily_cap_usd} error={errors.daily_cap_usd} onChange={(value) => setField("daily_cap_usd", value)} />
              <NumberField disabled={readOnly} label="Max slippage" suffix="bps" value={draft.max_slippage_bps} error={errors.max_slippage_bps} onChange={(value) => setField("max_slippage_bps", value)} />
            </div>
          </fieldset>

          <div className="grid gap-5 border-t border-border pt-5 md:grid-cols-2 xl:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <fieldset className="min-w-0 md:col-span-2 xl:col-span-1">
            {/* Floated so the legend lines up with the neighbouring column labels. */}
            <legend className="label-mono float-left w-full">Allowed networks</legend>
            <div className="grid clear-left grid-cols-2 gap-2 pt-3 sm:grid-cols-3">
              {POLICY_NETWORKS.map((network) => (
                <ToggleChip
                  key={network}
                  label={network.replace("-", " ")}
                  checked={draft.networks.includes(network)}
                  disabled={readOnly}
                  onChange={() => setField("networks", toggleValue(draft.networks, network))}
                />
              ))}
            </div>
            <FieldError message={errors.networks} />
          </fieldset>

          <label className="block min-w-0">
            <span className="label-mono block">Issuer allowlist</span>
            <input
              value={draft.issuer_allowlist}
              onChange={(event) => setField("issuer_allowlist", event.target.value)}
              aria-invalid={Boolean(errors.issuer_allowlist)}
              disabled={readOnly}
              className="mt-3 h-11 w-full min-w-0 border border-input bg-background/60 px-3 font-mono text-xs text-foreground focus-visible:border-primary/60 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 rounded-md"
              placeholder="RLUSD, tUSD"
            />
            <span className="mt-1.5 block text-[11px] text-muted-foreground">Separate currency codes or issuer addresses with commas.</span>
            <FieldError message={errors.issuer_allowlist} />
          </label>

          <div className="min-w-0">
          <span className="label-mono block" aria-hidden="true">Issuer safety</span>
          <label className="mt-3 flex h-11 cursor-pointer items-center gap-3 border border-border bg-background/40 px-3.5 rounded-md">
            <input
              type="checkbox"
              disabled={readOnly}
              checked={draft.block_requireauth_issuers}
              onChange={(event) => setField("block_requireauth_issuers", event.target.checked)}
              aria-describedby="requireauth-help"
              className="h-4 w-4 shrink-0 rounded-none accent-[var(--primary)]"
            />
            <span className="min-w-0 truncate text-[13px] font-medium">Block RequireAuth issuers</span>
          </label>
          <span id="requireauth-help" className="mt-1.5 block text-[11px] text-muted-foreground">Reject assets whose issuer must authorize each trust line.</span>
          </div>
          </div>

          <div className="overflow-hidden border border-border rounded-xl">
            <button
              type="button"
              onClick={() => setAdvancedOpen((current) => !current)}
              aria-expanded={advancedOpen}
              className="flex w-full items-center justify-between gap-3 bg-background/40 px-3.5 py-3 text-left text-[13px] font-medium transition hover:bg-white/[0.03] focus-visible:outline-offset-[-2px]"
            >
              Permissions & x402 limits
              {advancedOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
            </button>
            {advancedOpen ? (
              <div className="space-y-5 border-t border-border p-3.5">
                <fieldset>
                  <legend className="label-mono">Allowed delegated transaction types</legend>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    {DELEGATED_TRANSACTION_TYPES.map((txType) => (
                      <ToggleChip disabled={readOnly} key={txType} label={txType} checked={draft.allowed_tx_types.includes(txType)} onChange={() => setField("allowed_tx_types", toggleValue(draft.allowed_tx_types, txType))} />
                    ))}
                  </div>
                  <FieldError message={errors.allowed_tx_types} />
                </fieldset>
                <div className="grid gap-3 sm:grid-cols-2 lg:max-w-xl">
                  <NumberField disabled={readOnly} label="x402 per call" suffix="drops" value={draft.x402_max_per_call_drops} error={errors.x402_max_per_call_drops} onChange={(value) => setField("x402_max_per_call_drops", value)} />
                  <NumberField disabled={readOnly} label="x402 daily" suffix="drops" value={draft.x402_daily_cap_drops} error={errors.x402_daily_cap_drops} onChange={(value) => setField("x402_daily_cap_drops", value)} />
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <footer className="border-t border-border bg-background/30 px-5 py-4">
          {pendingRefresh ? (
            <div className="mb-4 border border-blocked/35 bg-blocked/[0.07] p-3 text-xs text-blocked rounded-xl" role="alert">
              <p className="font-medium">A refreshed policy also changed: {pendingRefresh.fields.join(", ")}.</p>
              <p className="mt-1 leading-5">Your edits are preserved for comparison. Saving is blocked until you load the refreshed policy.</p>
            </div>
          ) : null}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p
            className={`flex min-h-5 min-w-0 items-start gap-2 text-xs ${saveState === "error" ? "text-blocked" : saveState === "saved" ? "text-executed" : "text-muted-foreground"}`}
            role={saveState === "error" ? "alert" : "status"}
            aria-live="polite"
          >
            {saveState === "saving" ? <LoaderCircle className="mt-px h-3.5 w-3.5 shrink-0 animate-spin" /> : saveState === "saved" ? <Check className="mt-px h-3.5 w-3.5 shrink-0" /> : saveState === "error" ? <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" /> : null}
            {statusMessage}
          </p>
          <div className="flex shrink-0 flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={cancel}
              disabled={readOnly || (!dirty && !pendingRefresh) || saveState === "saving"}
              className="bracket bracket-light inline-flex h-10 items-center justify-center gap-2 border border-border bg-white/[0.03] px-4 text-[13px] font-medium text-foreground transition hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:text-muted-foreground disabled:opacity-50 disabled:hover:bg-white/[0.03] rounded-md"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />{pendingRefresh ? "Load refreshed policy" : "Cancel"}
            </button>
            <button
              type="submit"
              disabled={readOnly || !dirty || saveState === "saving" || Boolean(pendingRefresh)}
              className="inline-flex h-10 items-center justify-center gap-2 bg-primary px-4 text-[13px] font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-white/[0.08] disabled:text-muted-foreground rounded-md"
            >
              {saveState === "saving" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              {saveState === "saving" ? "Saving" : readOnly ? "Save policy" : "Save"}
            </button>
          </div>
          </div>
        </footer>
      </form>
    </section>
  );
}

function NumberField({ disabled, label, prefix, suffix, value, error, onChange }: { disabled?: boolean; label: string; prefix?: string; suffix?: string; value: string; error?: string; onChange: (value: string) => void }) {
  return (
    <label className="block min-w-0">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className="bracket bracket-hover bracket-focus relative mt-1.5 block">
        {prefix ? <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-muted-foreground">{prefix}</span> : null}
        <input
          type="number"
          min="0"
          step="1"
          inputMode="numeric"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={Boolean(error)}
          disabled={disabled}
          className={`h-10 w-full min-w-0 border bg-background/60 font-mono text-[13px] text-foreground focus-visible:border-primary/60 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 rounded-md ${prefix ? "pl-7" : "pl-3"} ${suffix ? "pr-14" : "pr-3"} ${error ? "border-blocked/70" : "border-input"}`}
        />
        {suffix ? <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] text-muted-foreground">{suffix}</span> : null}
      </span>
      <FieldError message={error} />
    </label>
  );
}

function ToggleChip({ disabled, label, checked, onChange }: { disabled?: boolean; label: string; checked: boolean; onChange: () => void }) {
  return (
    <label className={`flex h-11 min-w-0 items-center gap-2 border px-2.5 text-[13px] transition rounded-md ${checked ? "bracket bracket-accent border-border-strong bg-white/[0.06] text-foreground" : "border-border bg-background/40 text-muted-foreground hover:text-foreground"} ${disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer"}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} className="h-3.5 w-3.5 shrink-0 rounded-none accent-[var(--primary)]" />
      <span className="min-w-0 truncate leading-tight" title={label}>{label}</span>
    </label>
  );
}

function FieldError({ message }: { message?: string }) {
  return message ? <span className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-4 text-blocked"><AlertCircle className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />{message}</span> : null;
}

function toggleValue<T extends string>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((candidate) => candidate !== value) : [...values, value];
}
