"use client";

import Link from "next/link";
import React, { useRef, useState } from "react";

import {
  WorkAgreementFixtureError,
  WorkAgreementFixtureService,
  type WorkAgreementFixtureView,
} from "./work-agreement-fixture";

const DEMO_NOW = Date.parse("2026-10-24T12:00:00.000Z");

export type WorkAgreementDemoSnapshot = Readonly<{
  deliveryReviewed: boolean;
  view: WorkAgreementFixtureView;
}>;

/** Local-only demo controller. It never fetches, opens a wallet, or signs. */
export class WorkAgreementDemoController {
  private service = new WorkAgreementFixtureService();
  private view = this.service.handle({ action: "start" }, DEMO_NOW);
  private deliveryReviewed = false;

  snapshot(): WorkAgreementDemoSnapshot {
    return { deliveryReviewed: this.deliveryReviewed, view: this.view };
  }

  reset(): WorkAgreementDemoSnapshot {
    this.service = new WorkAgreementFixtureService();
    this.view = this.service.handle({ action: "start" }, DEMO_NOW);
    this.deliveryReviewed = false;
    return this.snapshot();
  }

  approvePending(): WorkAgreementDemoSnapshot {
    const approval = this.view.approval;
    if (!approval) throw new WorkAgreementFixtureError("No simulated owner review is pending.");
    this.view = this.service.handle({
      action: "submit_recorded_blob",
      phase: approval.action,
      signed_blob: approval.recordedFixtureBlob,
    }, DEMO_NOW);
    return this.snapshot();
  }

  reviewDelivery(): WorkAgreementDemoSnapshot {
    if (this.view.status !== "active") {
      throw new WorkAgreementFixtureError("Create the sample escrow before reviewing delivery.");
    }
    this.deliveryReviewed = true;
    return this.snapshot();
  }

  prepareResolution(action: "release" | "cancel"): WorkAgreementDemoSnapshot {
    if (this.view.status !== "active") {
      throw new WorkAgreementFixtureError("Create the sample escrow before choosing a resolution.");
    }
    if (action === "release" && !this.deliveryReviewed) {
      throw new WorkAgreementFixtureError("Review the sample delivery before releasing it.");
    }
    this.view = this.service.handle({ action: "prepare", phase: action }, DEMO_NOW);
    return this.snapshot();
  }
}

export function WorkAgreementFixtureViewComponent() {
  const controllerRef = useRef<WorkAgreementDemoController | null>(null);
  if (!controllerRef.current) controllerRef.current = new WorkAgreementDemoController();
  const controller = controllerRef.current;
  const [snapshot, setSnapshot] = useState<WorkAgreementDemoSnapshot>(() => controller.snapshot());
  const [error, setError] = useState<string>();
  const { deliveryReviewed, view } = snapshot;
  const approval = view.approval;

  const run = (operation: () => WorkAgreementDemoSnapshot) => {
    setError(undefined);
    try {
      setSnapshot(operation());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The simulated agreement could not advance.");
    }
  };

  const reset = () => run(() => controller.reset());
  const terminal = view.status === "released" || view.status === "cancelled";

  return (
    <div className="mx-auto min-h-[calc(100dvh-4rem)] max-w-5xl space-y-6 px-4 py-10 sm:px-6">
      <header className="grid gap-5 border-b border-border pb-8 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
        <div className="space-y-3">
          <p className="label-mono">Demo · deterministic local fixture</p>
          <h1 className="font-display text-4xl font-medium tracking-tight sm:text-5xl">
            Sample escrow-backed work agreement
          </h1>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
            Review sample terms, simulate owner approval, inspect a delivery, then release or cancel.
            Everything stays in this browser component and resets on reload.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="min-h-11 rounded-md border border-border bg-card px-4 text-sm font-medium hover:bg-secondary" onClick={reset} type="button">
            Reset demo
          </button>
          <Link className="inline-flex min-h-11 items-center rounded-md border border-border bg-card px-4 text-sm font-medium hover:bg-secondary" href="/onboarding">
            Connect a wallet (optional)
          </Link>
        </div>
      </header>

      <section className="rounded-xl border border-approval/30 bg-approval/[0.05] p-4 text-sm leading-6" role="note">
        <strong>Simulated agreement only.</strong> No wallet opens, no valid signature exists, no escrow is
        created, and no provider or XRPL request is made. Sample ledger indexes and hashes below are
        deterministic fixture labels—not chain-validated receipts.
      </section>

      <DemoTimeline view={view} deliveryReviewed={deliveryReviewed} />

      <section className="space-y-5 rounded-xl border border-border bg-card p-5 sm:p-6" aria-label="Simulated work agreement state">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-5">
          <div>
            <p className="label-mono">Sample agreement</p>
            <h2 className="mt-2 text-lg font-medium">Website accessibility review</h2>
          </div>
          <span className="rounded-md border border-primary/30 bg-primary-soft px-2 py-1 text-xs font-medium text-primary">
            Simulated · {friendlyStatus(view.status)}
          </span>
        </div>

        <dl className="grid gap-px overflow-hidden rounded-xl border border-border bg-border text-xs sm:grid-cols-2">
          <FixtureTerm label="Client (sample)" value={view.terms.owner} />
          <FixtureTerm label="Contributor (sample)" value={view.terms.counterparty} />
          <FixtureTerm label="Escrow amount" value={`${Number(view.terms.amountDrops) / 1_000_000} XRP fixture`} />
          <FixtureTerm label="Deliverable" value="Accessibility findings memo + CSV appendix" />
          <FixtureTerm label="Resolution window" value="10-minute fixture window" />
          <FixtureTerm label="Network/provider calls" value={String(view.networkRequestsMade)} />
        </dl>

        {approval ? (
          <section className="space-y-4 rounded-xl border border-approval/35 bg-approval/[0.05] p-4" aria-label={`Simulated ${approval.action} review`}>
            <div>
              <p className="label-mono">Review · {approval.action}</p>
              <h3 className="mt-2 text-base font-medium">Review the exact sample transaction</h3>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                The button below advances only the deterministic fixture state. It does not sign or submit this JSON.
              </p>
            </div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-background p-3 font-code text-[11px] leading-5">
              {JSON.stringify(approval.txJson, null, 2)}
            </pre>
            <button
              className="min-h-11 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              onClick={() => run(() => controller.approvePending())}
              type="button"
            >
              Simulate owner approval · {approval.action}
            </button>
          </section>
        ) : null}

        {view.status === "active" ? (
          <section className="space-y-4 rounded-xl border border-border bg-surface p-4" aria-label="Sample delivery review">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="label-mono">Delivery · sample artifact</p>
                <h3 className="mt-2 text-base font-medium">Accessibility findings are ready</h3>
                <p className="mt-2 max-w-2xl text-xs leading-5 text-muted-foreground">
                  12 sample findings · 3 high priority · WCAG mapping and remediation notes included.
                  No file was uploaded and no external work was verified.
                </p>
              </div>
              <span className={`rounded-md border px-2 py-1 text-xs font-medium ${deliveryReviewed ? "border-executed/35 bg-executed/10 text-executed" : "border-border text-muted-foreground"}`}>
                {deliveryReviewed ? "Reviewed in demo" : "Awaiting demo review"}
              </span>
            </div>
            {!deliveryReviewed ? (
              <button className="min-h-11 rounded-md border border-primary-soft-border bg-primary-soft px-4 text-sm font-medium" onClick={() => run(() => controller.reviewDelivery())} type="button">
                Mark sample delivery reviewed
              </button>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button className="min-h-11 rounded-md border border-executed/40 px-4 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-45" disabled={!deliveryReviewed} onClick={() => run(() => controller.prepareResolution("release"))} type="button">
                Review simulated release
              </button>
              <button className="min-h-11 rounded-md border border-blocked/40 px-4 text-sm font-medium text-blocked" onClick={() => run(() => controller.prepareResolution("cancel"))} type="button">
                Review simulated cancel
              </button>
            </div>
          </section>
        ) : null}

        {terminal ? (
          <section className={`rounded-xl border p-4 text-sm leading-6 ${view.status === "released" ? "border-executed/35 bg-executed/10" : "border-blocked/35 bg-blocked/10"}`} role="status">
            <strong>Demo complete · {view.status}.</strong> The fixture recorded a simulated resolution only.
            It is not an XRPL receipt, signature, settlement, or proof of delivery.
            <button className="ml-2 underline decoration-border underline-offset-4" onClick={reset} type="button">Run again</button>
          </section>
        ) : null}

        {view.validation ? (
          <p className="text-xs leading-5 text-muted-foreground">
            Fixture checkpoint: {view.validation.action} · sample ledger index {view.validation.ledgerIndex} · deterministic hash {view.validation.hash.slice(0, 8)}…
            This checkpoint never came from a ledger.
          </p>
        ) : null}
      </section>

      {error ? <p className="rounded-xl border border-blocked/35 bg-blocked/10 p-3 text-sm text-blocked" role="alert">{error}</p> : null}
    </div>
  );
}

function DemoTimeline({ view, deliveryReviewed }: { view: WorkAgreementFixtureView; deliveryReviewed: boolean }) {
  const created = view.status !== "awaiting_create";
  const terminal = view.status === "released" || view.status === "cancelled";
  const resolutionReview = view.status === "awaiting_release" || view.status === "awaiting_cancel";
  const steps = [
    { label: "Create sample terms", state: "complete" },
    { label: "Review simulated owner approval", state: created ? "complete" : "current" },
    { label: terminal && !deliveryReviewed ? "Delivery skipped by cancellation" : "Review sample delivery", state: terminal || deliveryReviewed ? "complete" : created ? "current" : "pending" },
    { label: terminal ? `Simulated ${view.status}` : "Choose release or cancel", state: terminal ? "complete" : resolutionReview || deliveryReviewed ? "current" : "pending" },
  ] as const;
  return (
    <ol className="grid overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4" aria-label="Simulated agreement lifecycle">
      {steps.map((step, index) => (
        <li className="bg-card p-4" key={step.label} aria-current={step.state === "current" ? "step" : undefined}>
          <p className="label-mono">0{index + 1} · {step.state}</p>
          <p className="mt-2 text-sm font-medium">{step.label}</p>
        </li>
      ))}
    </ol>
  );
}

function friendlyStatus(status: WorkAgreementFixtureView["status"]): string {
  return status.replaceAll("_", " ");
}

function FixtureTerm({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-card p-3">
      <dt className="label-mono">{label}</dt>
      <dd className="mt-1 break-all font-mono text-[11px]">{value}</dd>
    </div>
  );
}
