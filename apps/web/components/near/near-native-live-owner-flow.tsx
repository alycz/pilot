"use client";

import {
  BadgeCheck,
  Ban,
  FileKey2,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
  WalletCards,
} from "lucide-react";
import type { NearNativeExecutableQuoteReviewResult } from "@pilot/harbor-client";
import React, { useEffect, useRef, useState } from "react";

import { createBrowserHarborClient } from "../../lib/harbor-browser";
import {
  createPilotNearConnectAdapter,
  resolveNearConnectAdapterStatus,
  type PilotNearConnectAdapter,
} from "../../lib/near-connect-adapter";
import { createNearNativeLiveClient } from "../../lib/near-native-live-client";
import {
  createNearLiveRunCoordinator,
  type NearLiveRun,
} from "../../lib/near-live-run-coordinator";
import {
  loadLiveNearOwnerFundedReview,
  loadLiveNearOwnerFundedStatus,
  type LiveNearOwnerFundedStatus,
} from "../../lib/near-owner-funded-preview";
import type { NearOwnerApproveResponse } from "../../lib/near-native-live-client";
import { DetailGrid } from "../cards/card-frame";

const FIXED_ROUTE = "near-native-to-arbitrum-usdc-v1" as const;
const ARBITRUM_USDC_CONTRACT =
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831";

type Busy = "authorize" | "prove" | "approve" | "status";
export type NearNativeLiveGates = Readonly<{
  browserWallet: boolean;
  executableReview: boolean;
  principalBootstrap: boolean;
  ownerApproval: boolean;
}>;
type NativeLiveReview = Extract<
  NearNativeExecutableQuoteReviewResult,
  { source: "live" }
>;

export function NearNativeLiveOwnerFlow({ gates }: Readonly<{
  gates: NearNativeLiveGates;
}>) {
  const enabled = Object.values(gates).every(Boolean);
  const adapterStatus = resolveNearConnectAdapterStatus(enabled);
  const [accountId, setAccountId] = useState("");
  const [amountAtomic, setAmountAtomic] = useState("1000000000000000000000000");
  const [recipient, setRecipient] = useState("");
  const [busy, setBusy] = useState<Busy>();
  const [review, setReview] = useState<NativeLiveReview>();
  const [walletControlVerified, setWalletControlVerified] = useState(false);
  const [reservation, setReservation] = useState<NearOwnerApproveResponse>();
  const [status, setStatus] = useState<LiveNearOwnerFundedStatus>();
  const [error, setError] = useState<string>();
  const [cancelled, setCancelled] = useState(false);
  const adapterRef = useRef<PilotNearConnectAdapter | null>(null);
  const coordinatorRef = useRef(createNearLiveRunCoordinator());

  useEffect(() => () => {
    coordinatorRef.current.cancel();
  }, []);

  const validInput = /^[a-z0-9._-]{2,64}$/.test(accountId.trim())
    && /^[1-9]\d*$/.test(amountAtomic)
    && /^0x[0-9a-fA-F]{40}$/.test(recipient.trim());

  const beginRun = (): NearLiveRun => {
    setCancelled(false);
    return coordinatorRef.current.begin();
  };

  const assertCurrent = (run: NearLiveRun) => {
    if (!coordinatorRef.current.isCurrent(run)) {
      throw new DOMException("The NEAR owner flow was cancelled.", "AbortError");
    }
  };

  const fail = (cause: unknown, fallback: string, run: NearLiveRun) => {
    if (!coordinatorRef.current.isCurrent(run)) return;
    setError(cause instanceof Error ? cause.message : fallback);
  };

  const walletAdapter = async (signal: AbortSignal) => {
    if (!adapterRef.current) {
      adapterRef.current = await createPilotNearConnectAdapter({
        enabled: true,
        signal,
      });
    }
    return adapterRef.current;
  };

  const harborClient = (signal: AbortSignal) => createBrowserHarborClient(
    ((request, init) => globalThis.fetch(request, { ...init, signal })) as typeof fetch,
  );

  const authorizeAndRequestReview = async () => {
    if (!enabled || !validInput) return;
    const run = beginRun();
    const { signal } = run;
    setBusy("authorize");
    setError(undefined);
    setReview(undefined);
    setWalletControlVerified(false);
    setReservation(undefined);
    setStatus(undefined);
    try {
      const account = accountId.trim();
      const authorization = createNearNativeLiveClient();
      const bootstrap = await authorization.bootstrap(account, signal);
      assertCurrent(run);
      if (bootstrap.account_id !== account) throw new Error("The bootstrap account changed.");
      const challenge = await authorization.genericChallenge(signal);
      assertCurrent(run);
      if (challenge.account_id !== account) throw new Error("The wallet challenge account changed.");
      const adapter = await walletAdapter(signal);
      assertCurrent(run);
      const proof = await adapter.signChallenge({
        accountId: challenge.account_id,
        message: challenge.sign_message.message,
        nonce: challenge.sign_message.nonce,
        recipient: challenge.sign_message.recipient,
        expiresAt: challenge.expires_at,
      }, signal);
      assertCurrent(run);
      const session = await authorization.upgradeSession(proof, signal);
      assertCurrent(run);
      if (session.account_id !== account || !session.authorization_upgraded) {
        throw new Error("The server did not upgrade the exact NEAR account authorization.");
      }
      const result = await loadLiveNearOwnerFundedReview(
        harborClient(signal),
        {
          route: FIXED_ROUTE,
          amount_atomic: amountAtomic,
          slippage_bps: 100,
          recipient: recipient.trim(),
          refund_to: account,
          refund_deadline: new Date(Date.now() + 60 * 60_000).toISOString(),
          quote_waiting_time_ms: 0,
        },
      );
      assertCurrent(run);
      if (result.route.version !== "pilot-near-native-to-arbitrum-usdc-route-v1") {
        throw new Error("Harbor returned a different executable-review route.");
      }
      setReview(result as NativeLiveReview);
    } catch (cause) {
      fail(cause, "The live native-NEAR executable review is unavailable.", run);
    } finally {
      if (coordinatorRef.current.finish(run)) {
        setBusy(undefined);
      }
    }
  };

  const proveExactQuote = async () => {
    if (!enabled || !review) return;
    const run = beginRun();
    const { signal } = run;
    setBusy("prove");
    setError(undefined);
    setWalletControlVerified(false);
    setReservation(undefined);
    setStatus(undefined);
    try {
      const authorization = createNearNativeLiveClient();
      const challenge = await authorization.quoteChallenge(review.quote_binding, signal);
      assertCurrent(run);
      if (challenge.account_id !== review.quote_binding.refund_to) {
        throw new Error("The quote-bound wallet challenge account changed.");
      }
      const adapter = await walletAdapter(signal);
      assertCurrent(run);
      const proof = await adapter.signChallenge({
        accountId: challenge.account_id,
        message: challenge.sign_message.message,
        nonce: challenge.sign_message.nonce,
        recipient: challenge.sign_message.recipient,
        expiresAt: challenge.expires_at,
      }, signal);
      assertCurrent(run);
      const verified = await authorization.verifyQuoteProof(
        review.quote_binding,
        proof,
        signal,
      );
      assertCurrent(run);
      if (
        verified.account_id !== challenge.account_id
        || verified.quote_digest !== challenge.quote_digest
      ) throw new Error("The verified proof did not match the exact quote challenge.");
      setWalletControlVerified(true);
    } catch (cause) {
      fail(cause, "The quote-bound wallet-control proof failed.", run);
    } finally {
      if (coordinatorRef.current.finish(run)) {
        setBusy(undefined);
      }
    }
  };

  const approveAndReserve = async () => {
    if (!enabled || !review || !walletControlVerified) return;
    const run = beginRun();
    const { signal } = run;
    setBusy("approve");
    setError(undefined);
    setReservation(undefined);
    setStatus(undefined);
    try {
      const result = await createNearNativeLiveClient().approveAndReserve(
        review.quote_binding,
        signal,
      );
      assertCurrent(run);
      const funding = result.funding_instructions;
      if (
        funding.source_account_id !== review.quote_binding.refund_to
        || funding.deposit_account_id !== review.quote_binding.deposit_address
        || funding.amount_yocto_near !== review.quote_binding.amount_in
        || funding.quote_hash !== review.quote_binding.quote_hash
        || funding.correlation_id !== review.quote_binding.correlation_id
        || funding.destination_recipient.toLowerCase() !==
          review.quote_binding.recipient.toLowerCase()
      ) throw new Error("The reservation returned mismatched funding instructions.");
      setReservation(result);
    } catch (cause) {
      fail(cause, "The separate economic approval and reservation failed.", run);
    } finally {
      if (coordinatorRef.current.finish(run)) {
        setBusy(undefined);
      }
    }
  };

  const refreshStatus = async () => {
    if (!enabled || !review || !reservation) return;
    const run = beginRun();
    const { signal } = run;
    setBusy("status");
    setError(undefined);
    setStatus(undefined);
    try {
      const result = await loadLiveNearOwnerFundedStatus(
        harborClient(signal),
        review,
      );
      assertCurrent(run);
      setStatus(result);
    } catch (cause) {
      fail(cause, "The bound provider status is unavailable.", run);
    } finally {
      if (coordinatorRef.current.finish(run)) {
        setBusy(undefined);
      }
    }
  };

  const cancel = () => {
    coordinatorRef.current.cancel();
    setBusy(undefined);
    setReview(undefined);
    setWalletControlVerified(false);
    setReservation(undefined);
    setStatus(undefined);
    setError(undefined);
    setCancelled(true);
  };

  return (
    <section aria-labelledby="near-native-live-title" data-near-native-live-flow={enabled ? "enabled" : "disabled"} className="min-w-0 overflow-hidden border border-border bg-card rounded-xl">
      <header className="border-b border-border px-4 py-4 sm:px-5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-8 shrink-0 place-items-center border border-approval/35 bg-approval/[0.06] text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))] rounded-md">
            <WalletCards className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="label-mono">Live owner-controlled route · default off</p>
            <h2 id="near-native-live-title" className="mt-1 text-sm font-medium tracking-tight">Native NEAR → canonical Arbitrum USDC</h2>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">Bootstrap the server principal, request a provider-verified quote, prove control of the exact source account, and separately approve a durable reservation. Pilot never signs or broadcasts a transfer.</p>
          </div>
        </div>
      </header>

      <div className="space-y-4 p-4 sm:p-5">
        <p role="status" className={`border px-3 py-2 text-xs leading-5 rounded-xl ${enabled ? "border-approval/30 bg-approval/[0.06] text-muted-foreground" : "border-border bg-white/[0.015] text-muted-foreground"}`}>
          <strong className="text-foreground">Browser wallet adapter: {adapterStatus.state}.</strong> {adapterStatus.notice}
        </p>

        <DetailGrid items={[
          { label: "Browser wallet gate", value: gates.browserWallet ? "Enabled" : "Disabled" },
          { label: "Executable-review gate", value: gates.executableReview ? "Enabled" : "Disabled" },
          { label: "Principal-bootstrap gate", value: gates.principalBootstrap ? "Enabled" : "Disabled" },
          { label: "Owner-approval gate", value: gates.ownerApproval ? "Enabled" : "Disabled" },
        ]} />

        {!enabled ? (
          <div className="border border-border bg-white/[0.015] px-3 py-3 rounded-xl">
            <p className="text-xs font-medium text-foreground">Live native-route flow disabled</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">All four public gates and an active Pilot wallet session are required. No principal bootstrap, executable quote, wallet prompt, proof, approval, reservation, funding instruction, or status request can start from this panel.</p>
            <button type="button" disabled aria-disabled="true" className="mt-3 inline-flex h-9 items-center border border-border-strong px-3.5 text-[13px] font-semibold text-muted-foreground disabled:cursor-not-allowed disabled:opacity-45 pointer-coarse:h-11 rounded-md">Authorize live quote review</button>
          </div>
        ) : (
          <>
            <p role="note" className="border border-info/30 bg-info/[0.06] px-3 py-2 text-xs leading-5 text-muted-foreground rounded-xl">Near Connect loads one app-pinned MyNearWallet sandbox executor. Injected and parent-frame wallets are not accepted. The wallet signs NEP-413 messages only; no access key or transaction permission is requested.</p>
            <DetailGrid items={[
              { label: "Source network", value: "NEAR mainnet" },
              { label: "Source asset", value: "Native NEAR · yoctoNEAR atomic units" },
              { label: "Destination network", value: "Arbitrum One · chain 42161" },
              { label: "Destination token", value: ARBITRUM_USDC_CONTRACT, mono: true },
            ]} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="NEAR owner / refund account">
                <input value={accountId} onChange={(event) => setAccountId(event.target.value)} placeholder="owner.near" autoComplete="off" className="mt-1.5 h-11 w-full border border-input bg-background px-3 font-mono text-xs rounded-md" />
              </Field>
              <Field label="Input amount · yoctoNEAR">
                <input value={amountAtomic} onChange={(event) => setAmountAtomic(event.target.value)} inputMode="numeric" className="mt-1.5 h-11 w-full border border-input bg-background px-3 font-mono text-xs rounded-md" />
              </Field>
              <Field label="Arbitrum USDC recipient">
                <input value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="0x…" autoComplete="off" className="mt-1.5 h-11 w-full border border-input bg-background px-3 font-mono text-xs rounded-md" />
              </Field>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={Boolean(busy) || !validInput} onClick={() => void authorizeAndRequestReview()} className="inline-flex h-9 items-center gap-1.5 bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45 pointer-coarse:h-11 rounded-md">
                {busy === "authorize" ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : <FileKey2 className="size-3.5" aria-hidden="true" />}
                Authorize live quote review
              </button>
              <button type="button" disabled={!busy} onClick={cancel} className="inline-flex h-9 items-center gap-1.5 border border-border-strong px-3.5 text-[13px] font-semibold text-foreground disabled:cursor-not-allowed disabled:opacity-45 pointer-coarse:h-11 rounded-md"><Ban className="size-3.5" aria-hidden="true" />Cancel current run</button>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">This explicit action requires an active Pilot wallet session, opens the NEAR wallet for a bootstrap NEP-413 control proof, upgrades only the server principal authorization, then requests the live executable review. It does not approve economics or move NEAR.</p>
          </>
        )}

        {cancelled ? <p role="status" className="border border-border bg-white/[0.015] px-3 py-2 text-xs leading-5 text-muted-foreground rounded-xl">The local run was cancelled. In-flight requests were aborted and all quote, proof, approval, reservation, instruction, and status state was cleared.</p> : null}

        {error ? <p role="alert" className="border border-blocked/35 bg-blocked/[0.06] px-3 py-2 text-xs leading-5 text-blocked rounded-xl">Unavailable: {error} No fixture data was substituted.</p> : null}

        {review ? (
          <article aria-labelledby="near-native-live-quote" className="min-w-0 overflow-hidden border border-approval/35 bg-card rounded-xl">
            <div className="flex min-w-0 items-start gap-3 p-4">
              <span className="grid size-8 shrink-0 place-items-center border border-executed/30 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))] rounded-md"><BadgeCheck className="size-4" aria-hidden="true" /></span>
              <div className="min-w-0">
                <p className="label-mono">Live provider response · signature verified</p>
                <h3 id="near-native-live-quote" className="mt-1 text-sm font-medium tracking-tight">Exact executable-review binding</h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">Provider verification is not wallet control, economic approval, funding, settlement, or destination evidence.</p>
              </div>
            </div>
            <div className="border-t border-border px-4 py-3.5">
              <DetailGrid items={quoteRows(review)} />
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" disabled={Boolean(busy) || walletControlVerified} onClick={() => void proveExactQuote()} className="inline-flex h-9 items-center gap-1.5 bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-45 pointer-coarse:h-11 rounded-md">
                  {busy === "prove" ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : <ShieldAlert className="size-3.5" aria-hidden="true" />}
                  {walletControlVerified ? "Exact wallet control verified" : "Prove control for this quote"}
                </button>
                <button type="button" onClick={cancel} className="inline-flex h-9 items-center gap-1.5 border border-border-strong px-3.5 text-[13px] font-semibold text-foreground pointer-coarse:h-11 rounded-md"><Ban className="size-3.5" aria-hidden="true" />Cancel local review</button>
              </div>
            </div>
          </article>
        ) : null}

        {review && walletControlVerified ? (
          <article aria-labelledby="near-native-live-approval" className="min-w-0 overflow-hidden border border-approval/35 bg-card rounded-xl">
            <div className="p-4">
              <p className="label-mono">Separate owner action · economic approval</p>
              <h3 id="near-native-live-approval" className="mt-1 text-sm font-medium tracking-tight">Confirm the exact quote and reserve its budget</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">The NEP-413 proof established source-account control only. This separate click binds the quote economics and requests durable reservation; it still does not transfer funds.</p>
            </div>
            <div className="border-t border-border px-4 py-3.5">
              <button type="button" disabled={Boolean(busy) || Boolean(reservation)} onClick={() => void approveAndReserve()} className="inline-flex h-9 items-center gap-1.5 bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-45 pointer-coarse:h-11 rounded-md">
                {busy === "approve" ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : null}
                {reservation ? "Economic approval reserved" : "Confirm exact approval & reserve"}
              </button>
            </div>
          </article>
        ) : null}

        {review && reservation ? (
          <article aria-labelledby="near-native-live-funding" className="min-w-0 overflow-hidden border border-border bg-card rounded-xl">
            <div className="p-4">
              <p className="label-mono">Manual owner funding · no app transaction</p>
              <h3 id="near-native-live-funding" className="mt-1 text-sm font-medium tracking-tight">Native NEAR transfer instructions</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">The owner—not Pilot—may manually send native NEAR after independently accepting these instructions. The app provides no transfer, signing, deep-link, QR, or broadcast action.</p>
            </div>
            <div className="border-t border-border px-4 py-3.5">
              <DetailGrid items={fundingRows(reservation)} />
              <p role="note" className="mt-3 border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-xs leading-5 text-muted-foreground rounded-xl">NEP-413 does not transfer NEAR. Pilot budgets cannot stop an owner from sending outside the app. Provider status and independent Arbitrum receipt evidence remain distinct.</p>
              <button type="button" disabled={Boolean(busy)} onClick={() => void refreshStatus()} className="mt-3 inline-flex h-9 items-center gap-1.5 border border-border-strong px-3.5 text-[13px] transition hover:bg-white/[0.05] disabled:opacity-45 pointer-coarse:h-11 rounded-md">
                {busy === "status" ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="size-3.5" aria-hidden="true" />}Refresh bound provider status
              </button>
            </div>
          </article>
        ) : null}

        {review && status ? (
          <article className="min-w-0 overflow-hidden border border-border bg-card rounded-xl">
            <div className="p-4"><p className="label-mono">Bound provider status · signature verified</p><h3 className="mt-1 text-sm font-medium tracking-tight">Settlement status, not independent receipt evidence</h3></div>
            <div className="border-t border-border px-4 py-3.5"><DetailGrid items={statusRows(review, status)} /></div>
          </article>
        ) : null}
      </div>
    </section>
  );
}

function quoteRows(review: NativeLiveReview) {
  return [
    { label: "Source account", value: review.quote_binding.refund_to, mono: true },
    { label: "Network", value: "near:mainnet", mono: true },
    { label: "Quote hash", value: review.quote_hash, mono: true },
    { label: "Correlation ID", value: review.quote_binding.correlation_id, mono: true },
    { label: "Input asset ID", value: review.quote_binding.route.origin_asset_id, mono: true },
    { label: "Input amount · yoctoNEAR", value: review.quote_binding.amount_in, mono: true },
    { label: "Destination asset ID", value: review.quote_binding.route.destination_asset_id, mono: true },
    { label: "Minimum USDC output · atomic", value: review.quote_binding.min_amount_out, mono: true },
    { label: "Arbitrum recipient", value: review.quote_binding.recipient, mono: true },
    { label: "Provider deposit account", value: review.quote_binding.deposit_address, mono: true },
    { label: "Memo", value: "None · SIMPLE deposit" },
    { label: "Approval freshness ends", value: review.quote_binding.approval_expires_at, mono: true },
    { label: "Provider refund processing begins after", value: review.quote_binding.provider_deadline_at, mono: true },
    { label: "Execution", value: "Disabled · manual owner funding only" },
  ];
}

function fundingRows(result: NearOwnerApproveResponse) {
  const funding = result.funding_instructions;
  return [
    { label: "Reservation ID", value: result.reservation_id, mono: true },
    { label: "Approval digest", value: result.approval_digest, mono: true },
    { label: "Owner source account", value: funding.source_account_id, mono: true },
    { label: "Network", value: "NEAR mainnet" },
    { label: "Transfer asset", value: "Native NEAR · do not pre-wrap" },
    { label: "Exact amount · yoctoNEAR", value: funding.amount_yocto_near, mono: true },
    { label: "Exact deposit account", value: funding.deposit_account_id, mono: true },
    { label: "Memo", value: "None · do not add one" },
    { label: "Arbitrum recipient", value: funding.destination_recipient, mono: true },
    { label: "Canonical Arbitrum USDC contract", value: ARBITRUM_USDC_CONTRACT, mono: true },
    { label: "Provider deadline", value: funding.provider_deadline_at, mono: true },
  ];
}

function statusRows(review: NativeLiveReview, status: LiveNearOwnerFundedStatus) {
  return [
    { label: "Provider status", value: status.status.status, mono: true },
    { label: "Correlation ID", value: status.status.correlationId, mono: true },
    { label: "Bound quote hash", value: review.quote_hash, mono: true },
    { label: "Bound deposit account", value: review.quote_binding.deposit_address, mono: true },
    { label: "Independent destination evidence", value: "Not collected by this provider status read" },
  ];
}

function Field({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return <label className="min-w-0"><span className="label-mono block">{label}</span>{children}</label>;
}
