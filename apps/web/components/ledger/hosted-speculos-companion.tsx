"use client";

import { ExternalLink, ShieldCheck } from "lucide-react";
import * as React from "react";
import { encode } from "xrpl";

import type { ExactLedgerActionExpectation } from "@pilot/wallet";
import {
  HOSTED_LEDGER_COMPANION_REVIEW_URL,
  HostedLedgerCompanionClient,
} from "../../lib/ledger-companion/client";

const PUBLIC_DEFAULT_ACCOUNT = "ra7Zr8ddy9tB88RaXL8B87YkqhEJG2vkAJ";
const FIXTURE_DESTINATION = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";

export const HOSTED_SPECULOS_PROVENANCE =
  "Software emulator · public default test seed · Testnet only · signing only";

type State = "idle" | "pairing" | "paired" | "signing" | "signed" | "unknown" | "failed";

function fixture(now: number): Readonly<{
  expectation: ExactLedgerActionExpectation;
  unsignedTxBlob: string;
}> {
  const expectation: ExactLedgerActionExpectation = {
    kind: "payment",
    network: "testnet",
    account: PUBLIC_DEFAULT_ACCOUNT,
    sequence: 42,
    validatedLedgerIndex: 1_000,
    maxLedgerWindow: 50,
    maxFeeDrops: "20",
    approvalExpiresAtMs: now + 120_000,
    quoteExpiresAtMs: now + 90_000,
    destination: FIXTURE_DESTINATION,
    amountDrops: "5000",
  };
  return Object.freeze({
    expectation,
    unsignedTxBlob: encode({
      TransactionType: "Payment",
      Account: PUBLIC_DEFAULT_ACCOUNT,
      Destination: FIXTURE_DESTINATION,
      Amount: "5000",
      Fee: "12",
      Sequence: 42,
      LastLedgerSequence: 1_050,
    }),
  });
}

export function HostedSpeculosCompanion() {
  const enabled = process.env.NEXT_PUBLIC_LEDGER_COMPANION_ENABLED === "1";
  const client = React.useMemo(() => new HostedLedgerCompanionClient(), []);
  const [sessionId] = React.useState(() => `session.${globalThis.crypto?.randomUUID?.() ?? "unavailable"}`);
  const [prepared, setPrepared] = React.useState<ReturnType<typeof fixture>>();
  const [state, setState] = React.useState<State>("idle");
  const [message, setMessage] = React.useState(
    enabled
      ? "Pair the exact Testnet action, then approve it in the separate local companion window."
      : "Hosted companion signing is disabled in this build.",
  );
  const [transactionHash, setTransactionHash] = React.useState<string>();
  const context = React.useMemo(() => ({
    origin: typeof location === "undefined" ? "https://invalid.example" : location.origin,
    sessionId,
    network: "testnet" as const,
    account: PUBLIC_DEFAULT_ACCOUNT,
  }), [sessionId]);

  async function pair() {
    if (!enabled) return;
    const next = fixture(Date.now());
    setPrepared(next);
    setState("pairing");
    setMessage("Waiting for an explicit decision in the loopback-only review window.");
    const pairing = client.pair({ context, ...next });
    window.open(HOSTED_LEDGER_COMPANION_REVIEW_URL, "_blank", "noopener,noreferrer");
    try {
      await pairing;
      setState("paired");
      setMessage("Paired for this exact action. Review and approve the transaction in Speculos to sign.");
    } catch (error) {
      setState("failed");
      setMessage(error instanceof Error ? error.message : "The local pairing failed.");
    }
  }

  async function sign() {
    if (prepared === undefined || state !== "paired") return;
    setState("signing");
    setMessage("Waiting for the software emulator review. No transaction will be submitted.");
    try {
      const result = await client.sign({
        context,
        action: prepared.expectation.kind,
        unsignedTxBlob: prepared.unsignedTxBlob,
      });
      setTransactionHash(result.transactionHash);
      setState("signed");
      setMessage("The exact fixture was signed locally and verified. It was not submitted.");
    } catch (error) {
      setState("unknown");
      setMessage(error instanceof Error ? error.message : "Signing failed closed.");
    }
  }

  async function recover() {
    if (state !== "unknown") return;
    try {
      const result = await client.recover(context);
      if (result.status === "signed" && typeof result.transaction_hash === "string") {
        setTransactionHash(result.transaction_hash);
        setState("signed");
        setMessage("Recovered and verified the exact local signature. It was not submitted.");
      } else {
        setMessage("The local signing outcome is still unknown. Do not sign again; disconnect or check later.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Status recovery failed closed.");
    }
  }

  async function disconnect() {
    try {
      await client.disconnectRemote(context);
      setPrepared(undefined);
      setState("idle");
      setMessage("The local companion pairing was revoked. A new action requires fresh local review.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The local companion could not be disconnected.");
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <section className="rounded-xl border border-border bg-card p-5 sm:p-6" aria-labelledby="companion-title">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md border border-approval/35 text-approval">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 id="companion-title" className="font-display text-2xl">Hosted Ledger companion</h1>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Proves the hosted-to-local trust boundary with a fixed 5,000-drop Testnet payment fixture.
            </p>
          </div>
        </div>

        <div className="mt-5 rounded-xl border border-info/30 bg-info/10 p-4 text-sm leading-6">
          <p className="font-medium">{HOSTED_SPECULOS_PROVENANCE}</p>
          <p className="mt-1 text-muted-foreground">
            A valid signature proves control of the emulator signing key. It does not prove a physical Ledger or settlement.
          </p>
        </div>

        <dl className="mt-5 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2">
          {[{ label: "Account", value: PUBLIC_DEFAULT_ACCOUNT },
            { label: "Action", value: "Pay 5,000 drops" },
            { label: "Network", value: "XRPL Testnet" },
            { label: "Submission", value: "Disabled" }].map((item) => (
            <div key={item.label} className="min-w-0 bg-card px-3 py-3">
              <dt className="label-mono">{item.label}</dt>
              <dd className="mt-1 break-all text-xs font-medium">{item.value}</dd>
            </div>
          ))}
        </dl>

        <p className="mt-5 text-sm" role="status" aria-live="polite">{message}</p>
        {transactionHash ? (
          <p className="mt-2 break-all font-mono text-xs" aria-label="Verified transaction hash">
            Verified hash: {transactionHash}
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            disabled={!enabled || state === "pairing" || state === "signing" || state === "paired" || state === "unknown" || state === "signed"}
            onClick={() => void pair()}
            className="min-h-11 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-approval disabled:cursor-not-allowed disabled:opacity-50"
          >
            {state === "pairing" ? "Waiting for local review…" : "Pair exact fixture"}
          </button>
          <button
            type="button"
            disabled={state !== "paired"}
            onClick={() => void sign()}
            className="min-h-11 rounded-md border border-border-strong bg-card px-4 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-approval disabled:cursor-not-allowed disabled:opacity-50"
          >
            {state === "signing" ? "Waiting for Speculos…" : "Sign locally"}
          </button>
          {state === "unknown" ? (
            <button
              type="button"
              onClick={() => void recover()}
              className="min-h-11 rounded-md border border-approval/40 bg-approval/10 px-4 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-approval"
            >
              Check exact status
            </button>
          ) : null}
          {state === "paired" || state === "unknown" || state === "signed" ? (
            <button
              type="button"
              onClick={() => void disconnect()}
              className="min-h-11 rounded-md border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
            >
              Revoke local pairing
            </button>
          ) : null}
          <a
            href={HOSTED_LEDGER_COMPANION_REVIEW_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border-strong px-4 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-approval"
          >
            Open local review <ExternalLink className="h-4 w-4" aria-hidden="true" />
          </a>
        </div>
      </section>
    </main>
  );
}
