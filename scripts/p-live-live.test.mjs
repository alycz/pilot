import { describe, expect, it } from "vitest";
import roundingFixture from "./fixtures/exact-output-rounding-compat-v1.json" with { type: "json" };
import boundedTestnetEvidence from "./fixtures/p-live-bounded-testnet.synthetic.json" with { type: "json" };

import {
  actions,
  acquisitionApprovalToken,
  acquisitionExecuteArgs,
  acquisitionQuoteExpiredState,
  acquisitionSwapArgs,
  approvalSubmitArgs,
  assertAcquisitionStateBinding,
  assertAcquisitionStateIntegrity,
  assertFixedSellXrpFloor,
  assertExactRlusdBalanceDelta,
  assertExactOutputApprovalWindow,
  assertExactTxnNotFound,
  assertApprovalExpiredRefusal,
  assertApprovalMatchesBuild,
  assertRlusdAcquisitionTransaction,
  assertSafeBuild,
  assertSafeOwnerTransaction,
  assertUsableOfficialRlusdTrustLine,
  normalizeOfficialRlusdAmm,
  normalizeExactOutputRlusdQuote,
  maximumInputDrops,
  prepareRlusdAcquisitionLocked,
  quoteOfficialRlusdAmm,
  reconcileAcquisitionSubmission,
  revokeTestnetOfferCreateLink,
  resumeAcquisitionBeforeFreshQuote,
  safeBuildFailureDiagnostics,
  sealAcquisitionState,
  waitForLedgerAtOrAfter,
} from "./p-live-live.mjs";

describe("P-live harness stages", () => {
  it("exposes the validated Devnet link, vault, and expiry acceptance stages", () => {
    expect(Object.keys(actions)).toEqual(expect.arrayContaining([
      "devnet-link",
      "vault-approval",
      "expired-approval",
    ]));
  });

  it("keeps the Testnet gate sequenced behind a non-mutating preflight", () => {
    expect(Object.keys(actions).indexOf("preflight")).toBeLessThan(Object.keys(actions).indexOf("gate"));
  });

  it("exposes a dedicated OfferCreate-only Testnet link stage", () => {
    expect(Object.keys(actions)).toContain("testnet-offercreate-link");
  });

  it("records only the bounded validated Testnet delegation and acquisition", () => {
    expect(boundedTestnetEvidence.delegation).toMatchObject({
      engine_result: "tesSUCCESS",
      permissions: ["OfferCreate"],
      hosted_status_at_activation: "active",
      current_hosted_status: "revoked",
      current_permissions: [],
    });
    expect(boundedTestnetEvidence.acquisition).toMatchObject({
      operation_id: "00000000-0000-4000-8000-000000000010",
      engine_result: "tesSUCCESS",
      flags: 0x0004_0000,
      delegate_present: false,
      balance_before: "0",
      balance_after: "75",
      execution_mode: "fill_or_kill",
      approved_absolute_cap_drops: "275000000",
    });
    expect(boundedTestnetEvidence.acquisition.taker_gets_maximum_drops)
      .toBe("271112288");
    expect(boundedTestnetEvidence.acquisition.actual_trade_spend_drops)
      .toBe("268428007");
    expect(boundedTestnetEvidence.revocation).toMatchObject({
      engine_result: "tesSUCCESS",
      permissions: [],
      hosted_status: "revoked",
      hosted_permission_count: 0,
      queue_count_after: 0,
      rlusd_balance_after: "75",
      successful_offercreate_count_after: 1,
      pending: false,
    });
    expect(Object.values(boundedTestnetEvidence.redactions)).toEqual([
      "omitted",
      "omitted",
      "omitted",
      "omitted",
    ]);
  });

  it("revokes an active OfferCreate-only Testnet link and verifies exact revoked status", async () => {
    const owner = "rOwner";
    const delegate = "rDelegate";
    const wallet = { classicAddress: owner };
    const current = {
      owner,
      network: "testnet",
      delegate,
      permissions: ["OfferCreate"],
      status: "active",
    };
    const revokeTx = {
      TransactionType: "DelegateSet",
      Account: owner,
      Authorize: delegate,
      Permissions: [],
      Fee: "10",
      Sequence: 7,
      LastLedgerSequence: 100,
    };
    const calls = [];
    const result = await revokeTestnetOfferCreateLink(
      { config: { baseUrl: "https://harbor.example" }, wallet },
      {
        readActiveLink: async (_config, actualWallet, network, permissions) => {
          expect(actualWallet).toBe(wallet);
          expect(network).toBe("testnet");
          expect(permissions).toEqual(["OfferCreate"]);
          return current;
        },
        callHarbor: async (_config, op, args) => {
          calls.push(op);
          expect(args).toEqual({ owner, network: "testnet" });
          if (op === "account.revoke") {
            return { ...current, permissions: [], status: "revoked", revoke_tx: revokeTx };
          }
          if (op === "account.status") {
            return { ...current, permissions: [], status: "revoked" };
          }
          throw new Error(`Unexpected operation ${op}`);
        },
        submit: async (_config, actualWallet, transaction, network) => {
          calls.push("submit");
          expect(actualWallet).toBe(wallet);
          expect(transaction).toEqual(revokeTx);
          expect(network).toBe("testnet");
          return { hash: "A".repeat(64), validated: true, engine_result: "tesSUCCESS" };
        },
        readValidatedTransaction: async (network, hash) => {
          calls.push("validatedTransaction");
          expect(network).toBe("testnet");
          expect(hash).toBe("A".repeat(64));
          return { tx: revokeTx, meta: { TransactionResult: "tesSUCCESS" }, ledgerIndex: 101 };
        },
      },
    );

    expect(calls).toEqual([
      "account.revoke",
      "submit",
      "validatedTransaction",
      "account.status",
    ]);
    expect(result.status).toMatchObject({
      owner,
      network: "testnet",
      delegate,
      permissions: [],
      status: "revoked",
    });
    expect(result.validated).toMatchObject({
      tx: revokeTx,
      meta: { TransactionResult: "tesSUCCESS" },
      ledgerIndex: 101,
    });
  });

  it("exposes separately approved preparation before acquisition and the disabled direct P2.4 gate", async () => {
    expect(Object.keys(actions).indexOf("prepare-rlusd-acquisition"))
      .toBeLessThan(Object.keys(actions).indexOf("acquire-rlusd"));
    await expect(actions["prepare-rlusd-acquisition"]()).rejects.toThrow(/canonical lowercase durable operation UUID/i);
    expect(Object.keys(actions).indexOf("acquire-rlusd")).toBeLessThan(Object.keys(actions).indexOf("gate"));
    await expect(actions["acquire-rlusd"]()).rejects.toThrow(/locked until.*Harbor FOK.*deployed/i);
    await expect(actions.gate()).rejects.toThrow(/duplicate 50 RLUSD trade/i);
  });

  it("keeps approval-backed owner submit explicitly network-bound", () => {
    expect(approvalSubmitArgs("SIGNED", "testnet", "approval-1")).toEqual({
      tx_blob: "SIGNED",
      network: "testnet",
      approval_id: "approval-1",
    });
  });

  it("quotes the validated official XRP/RLUSD AMM inside the one-percent gate", () => {
    const quote = quoteOfficialRlusdAmm({
      Asset: { currency: "XRP" },
      Asset2: {
        currency: "524C555344000000000000000000000000000000",
        issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
      },
      Amount: "782771569438",
      Amount2: {
        currency: "524C555344000000000000000000000000000000",
        issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
        value: "219952.3222748822",
      },
      TradingFee: 501,
    });
    expect(quote.acquire.rlusd).toBe(75);
    expect(quote.acquire.quotedXrp).toBeCloseTo(268.3472515843551, 9);
    expect(quote.acquire.cappedXrpAtOnePercent).toBeCloseTo(271.03072410019865, 9);
    expect(quote.acquire.quotedInputDrops).toBe("268347252");
    expect(quote.acquire.maximumInputDrops).toBe("271030725");
    expect(quote.acquire.withinOnePercent).toBe(true);
    expect(quote.sale.rlusd).toBe(50);
    expect(quote.sale.quotedXrp).toBeCloseTo(177.00967031621326, 9);
    expect(quote.acquire.priceImpactBps).toBeLessThan(100);
    expect(quote.sale.priceImpactBps).toBeLessThan(100);
  });

  it("rejects a mismatched or unsafe AMM", () => {
    expect(() => quoteOfficialRlusdAmm({
      Asset: { currency: "XRP" },
      Asset2: { currency: "USD", issuer: "rOther" },
      Amount: "1000000",
      Amount2: { currency: "USD", issuer: "rOther", value: "1" },
      TradingFee: 0,
    })).toThrow(/assets do not match/i);
  });

  it("rejects a frozen or uncertain official RLUSD AMM side in either orientation", () => {
    const rlusd = {
      currency: "524C555344000000000000000000000000000000",
      issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
      value: "1000",
    };
    expect(() => normalizeOfficialRlusdAmm({
      amount: "1000000",
      amount2: rlusd,
      asset2_frozen: true,
      trading_fee: 501,
    })).toThrow(/frozen or.*uncertain/i);
    expect(() => normalizeOfficialRlusdAmm({
      amount: rlusd,
      amount2: "1000000",
      asset_frozen: undefined,
      trading_fee: 501,
    })).toThrow(/frozen or.*uncertain/i);
    expect(normalizeOfficialRlusdAmm({
      amount: rlusd,
      amount2: "1000000",
      asset_frozen: false,
      trading_fee: 501,
    }).RlusdFrozen).toBe(false);
  });

  it("binds acquisition to official Testnet RLUSD, FOK, one percent, and 275 XRP", () => {
    const account = "rOwner";
    expect(acquisitionSwapArgs(account, "intent-1")).toEqual({
      account,
      network: "testnet",
      intent_id: "intent-1",
      sell: { currency: "XRP" },
      buy: {
        currency: "524C555344000000000000000000000000000000",
        issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
      },
      amount: {
        currency: "524C555344000000000000000000000000000000",
        issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
        value: "75",
      },
      side: "buy",
      max_slippage_bps: 100,
      execution_mode: "fill_or_kill",
    });
    const tx = {
      TransactionType: "OfferCreate",
      Account: account,
      TakerGets: "271030724",
      TakerPays: {
        currency: "524C555344000000000000000000000000000000",
        issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
        value: "75",
      },
      Flags: 0x0004_0000,
      LastLedgerSequence: 90000005,
    };
    const references = acquisitionQuoteReferences(account, {
      executionQuote: exactOutputQuote(account, "268428007", 90000000),
    });
    expect(assertRlusdAcquisitionTransaction({ ...tx, TakerGets: "271112288" }, account, references))
      .toBe(271112288n);
    expect(() => assertRlusdAcquisitionTransaction({ ...tx, TakerGets: "271112289" }, account, references))
      .toThrow(/exact FOK amount and XRP cap/i);
    expect(() => assertRlusdAcquisitionTransaction({ ...tx, Flags: 0x0002_0000 }, account, references))
      .toThrow(/exact FOK amount and XRP cap/i);
    expect(() => assertRlusdAcquisitionTransaction({ ...tx, TakerGets: "275000001" }, account, references))
      .toThrow(/exact FOK amount and XRP cap/i);
  });

  it("matches exact-output rounding v1 and hard-cap boundaries", () => {
    expect(roundingFixture.reference).toBe(
      "xrpl-exact-output-rounding-v1",
    );
    expect(roundingFixture.provenance).toMatchObject({
      validated: true,
      full_reply: true,
      destination_amount: roundingFixture.destination_amount,
    });
    expect(
      roundingFixture.freshness.build_ledger_index - roundingFixture.provenance.ledger_index,
    ).toBe(roundingFixture.freshness.maximum_directional_ledger_gap);
    expect(roundingFixture.freshness.expired_execution_result).toBe("QUOTE_EXPIRED");
    for (const vector of roundingFixture.vectors) {
      expect(maximumInputDrops(
        BigInt(vector.source_amount_drops),
        vector.max_slippage_bps ?? roundingFixture.max_slippage_bps,
      ).toString()).toBe(vector.maximum_input_drops);
    }

    const account = "rOwner";
    expect(normalizeExactOutputRlusdQuote(exactOutputQuoteResult(
      account,
      [{ source_amount: "268428007" }, { source_amount: "268428008" }],
    ), account).maximum_input_drops).toBe("271112288");
    expect(() => normalizeExactOutputRlusdQuote(
      exactOutputQuoteResult(account, [{ source_amount: "272277228" }]),
      account,
    )).toThrow(/275 XRP cap/i);
  });

  it("rejects fractional/stale exact-output quotes and quote provenance drift", () => {
    const account = "rOwner";
    expect(() => normalizeExactOutputRlusdQuote(
      exactOutputQuoteResult(account, [{ source_amount: "268428007.1" }]),
      account,
    )).toThrow(/no XRP source amount/i);
    expect(() => normalizeExactOutputRlusdQuote(exactOutputQuoteResult(
      account,
      [{ source_amount: "268428007" }],
      { validated: false },
    ), account)).toThrow(/stale or incomplete/i);
    for (const override of [
      { ledger_hash: undefined },
      { ledger_hash: "BAD" },
      { source_account: "rOther" },
      { destination_account: "rOther" },
      { destination_amount: { currency: "XRP" } },
    ]) {
      expect(() => normalizeExactOutputRlusdQuote(exactOutputQuoteResult(
        account,
        [{ source_amount: "268428007" }],
        override,
      ), account)).toThrow(/stale or incomplete/i);
    }

    const tx = acquisitionTransaction(account, "271112288", 90000005);
    const references = acquisitionQuoteReferences(account, {
      executionQuote: exactOutputQuote(account, "268428007", 90000000),
    });
    expect(() => assertRlusdAcquisitionTransaction(tx, account, {
      ...references,
      executionQuote: { ...references.executionQuote, rounding_reference: "unreviewed" },
    })).toThrow(/quote reference is invalid/i);
    expect(() => assertRlusdAcquisitionTransaction(tx, account, {
      ...references,
      executionQuote: { ...references.executionQuote, ledger_index: 89999990 },
    })).toThrow(/stale/i);
    expect(() => assertRlusdAcquisitionTransaction(tx, account, {
      ...references,
      executionQuote: { ...references.executionQuote, ledger_index: 89999999 },
    })).toThrow(/stale/i);
    expect(() => assertRlusdAcquisitionTransaction(tx, account, {
      ...references,
      executionQuote: { ...references.executionQuote, ledger_index: 90000002 },
    })).toThrow(/stale/i);
    expect(() => assertRlusdAcquisitionTransaction(tx, account, {
      ...references,
      executionQuote: { ...references.executionQuote, ledger_index: 90000001 },
    })).not.toThrow();
    const legacyExecutionQuote = {
      ...references.executionQuote,
      rounding_reference: "xrpl-exact-output-rounding-legacy-v0",
      ledger_hash: undefined,
      ledger_index: 90000005,
    };
    expect(() => assertRlusdAcquisitionTransaction(tx, account, {
      ...references,
      executionQuote: legacyExecutionQuote,
    })).not.toThrow();
    expect(() => assertRlusdAcquisitionTransaction(tx, account, {
      ...references,
      executionQuote: { ...legacyExecutionQuote, ledger_index: 90000006 },
    })).toThrow(/stale/i);
    expect(() => assertRlusdAcquisitionTransaction(tx, account, {
      ...references,
      executionQuote: {
        ...references.executionQuote,
        destination_amount: { ...references.executionQuote.destination_amount, issuer: "rOther" },
      },
    })).toThrow(/quote reference is invalid/i);
  });

  it("binds durable acquisition state to one approved operation and wallet", () => {
    const state = acquisitionState();
    expect(() => assertAcquisitionStateBinding(state, {
      operationId: state.operation_id,
      owner: state.owner,
    })).not.toThrow();
    expect(() => assertAcquisitionStateBinding(state, {
      operationId: "11111111-1111-4111-8111-111111111111",
      owner: state.owner,
    })).toThrow(/exact approved operation/i);
    expect(() => assertAcquisitionStateBinding(state, {
      operationId: state.operation_id,
      owner: "rOther",
    })).toThrow(/exact approved operation/i);
    expect(() => assertAcquisitionStateBinding({ ...state, version: 2 }, {
      operationId: state.operation_id,
      owner: state.owner,
    })).toThrow(/Legacy.*cannot carry/i);
    const legacyReady = {
      ...state,
      version: 2,
      status: "ready",
      quoted_cap_xrp: 271,
      amm_ledger_index: 100,
    };
    delete legacyReady.amm_eligibility_quote;
    delete legacyReady.execution_quote;
    delete legacyReady.build_id;
    delete legacyReady.tx_json;
    delete legacyReady.hash;
    delete legacyReady.last_ledger_sequence;
    expect(() => assertAcquisitionStateBinding(legacyReady, {
      operationId: state.operation_id,
      owner: state.owner,
    })).not.toThrow();
    const signedWithPriorReference = acquisitionState({
      execution_quote: {
        ...state.execution_quote,
        rounding_reference: "xrpl-exact-output-rounding-legacy-v0",
        ledger_hash: undefined,
      },
    });
    expect(() => assertAcquisitionStateBinding(signedWithPriorReference, {
      operationId: state.operation_id,
      owner: state.owner,
    })).not.toThrow();
    expect(() => assertAcquisitionStateBinding({
      ...signedWithPriorReference,
      status: "built",
    }, {
      operationId: state.operation_id,
      owner: state.owner,
    })).toThrow(/unsigned.*obsolete/i);
  });

  it("preserves immutable legacy signed and validated transaction recovery windows", () => {
    const tx = acquisitionTransaction("rOwner", "271112288", 105);
    const legacyExecutionQuote = {
      ...exactOutputQuote("rOwner", "268428007", 105),
      rounding_reference: "xrpl-exact-output-rounding-legacy-v0",
      ledger_hash: undefined,
    };
    for (const status of ["signed_pending", "validated"]) {
      const state = acquisitionState({
        status,
        tx_json: tx,
        last_ledger_sequence: tx.LastLedgerSequence,
        amm_eligibility_quote: ammEligibilityQuote("rOwner", 100),
        execution_quote: legacyExecutionQuote,
        ...(status === "validated" ? {
          ledger_index: 104,
          balance_after: "75",
          balance_after_ledger_index: 104,
          maximum_offer_spend_drops: "271112288",
        } : {}),
      });
      expect(() => assertAcquisitionStateBinding(state, {
        operationId: state.operation_id,
        owner: state.owner,
      })).not.toThrow();
      expect(assertRlusdAcquisitionTransaction(tx, state.owner, {
        ammEligibilityQuote: state.amm_eligibility_quote,
        executionQuote: state.execution_quote,
      })).toBe(271112288n);
    }
  });

  it("binds approval to the operation, owner, network, official asset, amount, and cap", () => {
    const operationId = "00000000-0000-4000-8000-000000000001";
    expect(acquisitionApprovalToken(operationId, "rApprovedOwner")).toBe(
      "P-LIVE-RLUSD:00000000-0000-4000-8000-000000000001:rApprovedOwner:testnet:" +
      "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV:524C555344000000000000000000000000000000:75:275000000",
    );
  });

  it("requires an exact usable and authorized official RLUSD trust line", () => {
    const state = {
      balance: "0",
      ledgerIndex: 100,
      line: {
        account: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
        currency: "524C555344000000000000000000000000000000",
        balance: "0",
        limit: "10000",
      },
    };
    expect(() => assertUsableOfficialRlusdTrustLine(state, 0)).not.toThrow();
    expect(() => assertUsableOfficialRlusdTrustLine({
      ...state,
      line: { ...state.line, limit: "75" },
    }, 0)).toThrow(/not usable/i);
    expect(() => assertUsableOfficialRlusdTrustLine({
      ...state,
      line: { ...state.line, freeze_peer: true },
    }, 0)).toThrow(/not usable/i);
    expect(() => assertUsableOfficialRlusdTrustLine(state, 0x0040_0000)).toThrow(/not usable/i);
    expect(() => assertUsableOfficialRlusdTrustLine(state, 0x0004_0000)).toThrow(/not usable/i);
    expect(() => assertUsableOfficialRlusdTrustLine({
      ...state,
      line: { ...state.line, peer_authorized: true },
    }, 0x0004_0000)).not.toThrow();
  });

  it("keeps preparation inside the exact activation, trust-line, headroom, and read-only report boundary", async () => {
    const calls = [];
    const line = {
      balance: "0",
      ledgerIndex: 100,
      ledgerHash: "A".repeat(64),
      line: {
        account: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
        currency: "524C555344000000000000000000000000000000",
        balance: "0",
        limit: "10000",
      },
    };
    const detail = await prepareRlusdAcquisitionLocked({
      operationId: "00000000-0000-4000-8000-000000000001",
      approvedOwner: "rOwner",
      wallet: { classicAddress: "rOwner" },
      config: { test: true },
    }, {
      activateAccount: async (network, owner) => calls.push(["activate", network, owner]),
      readTrustLine: async () => {
        calls.push(["read-trust-line"]);
        return line;
      },
      ensureExactTrustLine: async () => calls.push(["ensure-trust-line"]),
      readXrpBalance: async (network, owner) => {
        calls.push(["read-xrp", network, owner]);
        return 299_999_990n;
      },
      ensureHeadroom: async () => {
        calls.push(["ensure-headroom"]);
        return 299_999_990n;
      },
      readIssuerFlags: async () => {
        calls.push(["read-issuer-flags"]);
        return 0;
      },
      report: (action, value) => calls.push(["report", action, value.acquisitionAttempted]),
    });

    expect(calls).toEqual([
      ["activate", "testnet", "rOwner"],
      ["read-trust-line"],
      ["ensure-trust-line"],
      ["read-xrp", "testnet", "rOwner"],
      ["ensure-headroom"],
      ["read-trust-line"],
      ["read-issuer-flags"],
      ["report", "rlusd-acquisition-prepared", false],
    ]);
    expect(detail).toMatchObject({
      operationId: "00000000-0000-4000-8000-000000000001",
      owner: "rOwner",
      amount: "75",
      capDrops: "275000000",
      trustLineCreated: false,
      faucetToppedUp: false,
      acquisitionAttempted: false,
    });
  });

  it("forces owner approval in the acquisition execute request", () => {
    expect(acquisitionExecuteArgs("build-1", "intent-1")).toEqual({
      build_id: "build-1",
      idempotency_key: "intent-1",
      require_owner_approval: true,
    });
  });

  it("accepts only Harbor's exact terminal quote-expiry contract", () => {
    const state = acquisitionState({ status: "built" });
    const expired = acquisitionQuoteExpiredState(state, {
      status: "failed",
      engine_result: "QUOTE_EXPIRED",
      detail: "Exact-output FOK quote expired",
    }, new Date("2026-10-19T20:00:00.000Z"));
    expect(expired).toMatchObject({
      status: "expired_unsubmitted",
      reconciled_at: "2026-10-19T20:00:00.000Z",
      build_id: state.build_id,
    });
    expect(acquisitionQuoteExpiredState(state, {
      status: "failed",
      engine_result: "tecKILLED",
    })).toBeUndefined();
    expect(acquisitionQuoteExpiredState(state, {
      status: "needs_approval",
      engine_result: "QUOTE_EXPIRED",
    })).toBeUndefined();
  });

  it("forbids approval-time revival of an exact-output quote window", () => {
    expect(() => assertExactOutputApprovalWindow(
      { LastLedgerSequence: 90000005 },
      { LastLedgerSequence: 90000005 },
    )).not.toThrow();
    expect(() => assertExactOutputApprovalWindow(
      { LastLedgerSequence: 90000005 },
      { LastLedgerSequence: 90000009 },
    )).toThrow(/refresh.*quote window/i);
  });

  it("authenticates the full persisted acquisition state and rejects local replay edits", () => {
    const integrityKey = "test-only-integrity-key-material";
    const sealed = sealAcquisitionState(acquisitionState(), integrityKey);
    expect(() => assertAcquisitionStateIntegrity(sealed, integrityKey)).not.toThrow();
    expect(() => assertAcquisitionStateIntegrity({ ...sealed, owner: "rOther" }, integrityKey))
      .toThrow(/integrity check failed/i);
    expect(() => assertAcquisitionStateIntegrity({ ...sealed, status: "validated" }, integrityKey))
      .toThrow(/integrity check failed/i);
    expect(() => assertAcquisitionStateIntegrity({ ...sealed, balance_before: "75" }, integrityKey))
      .toThrow(/integrity check failed/i);
  });

  it("reconciles a lost response to one persisted validation without resubmission", async () => {
    const persisted = [];
    const state = acquisitionState({ status: "signed_pending" });
    const result = await reconcileAcquisitionSubmission(state, {
      lookup: async (hash, lastLedgerSequence) => ({
        hash,
        ledger_index: lastLedgerSequence - 1,
        validated: true,
        engine_result: "tesSUCCESS",
      }),
      verify: async (outcome) => ({
        ledger_index: outcome.ledger_index,
        balance_after: "75",
        balance_after_ledger_index: outcome.ledger_index,
        maximum_offer_spend_drops: "271000000",
      }),
      persist: async (value) => persisted.push(value),
    });
    expect(result.resumed).toBe(true);
    expect(result.state.status).toBe("validated");
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ status: "validated", hash: state.hash });
  });

  it("reconciles signed state before any unavailable or worsened fresh quote", async () => {
    const state = acquisitionState({ status: "signed_pending" });
    const calls = [];
    const result = await resumeAcquisitionBeforeFreshQuote(state, {
      verifyValidated: async () => { throw new Error("not a prevalidated state"); },
      reconcileSigned: async (persisted) => (await reconcileAcquisitionSubmission(persisted, {
        lookup: async (hash, lastLedgerSequence) => {
          calls.push(["lookup-public-hash", hash, lastLedgerSequence]);
          return {
            hash,
            ledger_index: 120,
            validated: true,
            engine_result: "tesSUCCESS",
          };
        },
        verify: async () => ({
          ledger_index: 120,
          balance_after: "75",
          balance_after_ledger_index: 120,
          maximum_offer_spend_drops: "271000000",
        }),
        persist: async (persistedResult) => calls.push(["persist-reconciled", persistedResult.hash]),
      })).state,
      loadFreshQuote: async () => {
        calls.push(["fresh-quote"]);
        throw new Error("AMM unavailable and current price exceeds the cap");
      },
    });
    expect(result.state).toMatchObject({ status: "validated", hash: state.hash, ledger_index: 120 });
    expect(calls).toEqual([
      ["lookup-public-hash", state.hash, state.last_ledger_sequence],
      ["persist-reconciled", state.hash],
    ]);
  });

  it("replays validated state before any fresh quote and never reconciles or resubmits", async () => {
    const state = acquisitionState({
      status: "validated",
      ledger_index: 120,
      balance_after: "75",
      balance_after_ledger_index: 120,
      maximum_offer_spend_drops: "271000000",
    });
    const calls = [];
    const result = await resumeAcquisitionBeforeFreshQuote(state, {
      verifyValidated: async (persisted) => calls.push(["verify-persisted", persisted.hash]),
      reconcileSigned: async () => {
        calls.push(["reconcile-or-submit"]);
        throw new Error("must not reconcile validated state");
      },
      loadFreshQuote: async () => {
        calls.push(["fresh-quote"]);
        throw new Error("later market state must not block receipt replay");
      },
    });
    expect(result).toEqual({ handled: true, state });
    expect(calls).toEqual([["verify-persisted", state.hash]]);
  });

  it("rejects terminal state before any quote, reconciliation, or submission", async () => {
    for (const status of ["expired_unsubmitted", "expired_unincluded"]) {
      const state = acquisitionState({ status });
      const calls = [];
      await expect(resumeAcquisitionBeforeFreshQuote(state, {
        verifyValidated: async () => calls.push(["verify"]),
        reconcileSigned: async () => calls.push(["reconcile"]),
        loadFreshQuote: async () => calls.push(["fresh-quote"]),
      })).rejects.toThrow(/terminal.*new explicit approval/i);
      expect(calls).toEqual([]);
    }
  });

  it("loads fresh eligibility only for an unexecuted acquisition state", async () => {
    const state = acquisitionState({ status: "ready" });
    const quote = { marker: "fresh-validated-amm" };
    const calls = [];
    const result = await resumeAcquisitionBeforeFreshQuote(state, {
      verifyValidated: async () => calls.push(["verify"]),
      reconcileSigned: async () => calls.push(["reconcile"]),
      loadFreshQuote: async () => {
        calls.push(["fresh-quote"]);
        return quote;
      },
    });
    expect(result).toEqual({ handled: false, state, freshQuote: quote });
    expect(calls).toEqual([["fresh-quote"]]);
  });

  it("resumes an unsigned build without repeating faucet-era quote setup", async () => {
    const state = acquisitionState({ status: "built" });
    const calls = [];
    const result = await resumeAcquisitionBeforeFreshQuote(state, {
      verifyValidated: async () => calls.push(["verify"]),
      reconcileSigned: async () => calls.push(["reconcile"]),
      loadFreshQuote: async () => calls.push(["fresh-quote"]),
    });
    expect(result).toEqual({ handled: false, state });
    expect(calls).toEqual([]);
  });

  it("returns a persisted validation on rerun without lookup or another buy", async () => {
    let lookupCalls = 0;
    let persistCalls = 0;
    const state = acquisitionState({
      status: "validated",
      ledger_index: 120,
      balance_after: "75",
      balance_after_ledger_index: 120,
      maximum_offer_spend_drops: "271000000",
    });
    const result = await reconcileAcquisitionSubmission(state, {
      lookup: async () => { lookupCalls += 1; },
      verify: async () => { throw new Error("must not verify twice"); },
      persist: async () => { persistCalls += 1; },
    });
    expect(result).toEqual({ state, resumed: true });
    expect(lookupCalls).toBe(0);
    expect(persistCalls).toBe(0);
  });

  it("keeps an unknown lost-response outcome pending and never marks it retryable", async () => {
    const persisted = [];
    const state = acquisitionState({ status: "signed_pending" });
    await expect(reconcileAcquisitionSubmission(state, {
      lookup: async () => { throw new Error("provider unavailable"); },
      verify: async () => ({}),
      persist: async (value) => persisted.push(value),
    })).rejects.toThrow(/outcome remains unknown.*refusing to resubmit/i);
    expect(persisted).toEqual([]);
    expect(state.status).toBe("signed_pending");
  });

  it("marks only ledger-expired non-inclusion terminal", async () => {
    const persisted = [];
    const state = acquisitionState({ status: "signed_pending" });
    await expect(reconcileAcquisitionSubmission(state, {
      lookup: async () => undefined,
      verify: async () => ({}),
      persist: async (value) => persisted.push(value),
    })).rejects.toThrow(/not included before LastLedgerSequence.*terminal/i);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].status).toBe("expired_unincluded");
  });

  it("waits for validated account lines to reach the transaction ledger", async () => {
    const reads = [
      { ledgerIndex: 119, balance: "0" },
      { ledgerIndex: 120, balance: "75" },
    ];
    let waits = 0;
    const result = await waitForLedgerAtOrAfter(
      async () => reads.shift(),
      120,
      { maxAttempts: 2, wait: async () => { waits += 1; } },
    );
    expect(result).toEqual({ ledgerIndex: 120, balance: "75" });
    expect(waits).toBe(1);
  });

  it("binds fixed-sell XRP proceeds to the independent one-percent floor", () => {
    expect(() => assertFixedSellXrpFloor({ TakerPays: "175247561" }, 175.2475602)).not.toThrow();
    expect(() => assertFixedSellXrpFloor({ TakerPays: "175247560" }, 175.2475602))
      .toThrow(/slippage floor/i);
    expect(() => assertFixedSellXrpFloor({ TakerPays: { currency: "USD", value: "175" } }, 175))
      .toThrow(/slippage floor/i);
  });

  it("accepts only the specific approval-expired refusal contract", () => {
    expect(() => assertApprovalExpiredRefusal({
      status: 422,
      code: "APPROVAL_EXPIRED",
      message: "Approval has expired",
    })).not.toThrow();
    expect(() => assertApprovalExpiredRefusal({
      status: 422,
      code: "TRANSACTION_EXPIRED",
      message: "Transaction expired after LastLedgerSequence",
    })).toThrow(/specific APPROVAL_EXPIRED/);
    expect(() => assertApprovalExpiredRefusal({
      status: 200,
      code: "OPERATION_FAILED",
      message: "Operation failed",
    })).toThrow(/specific APPROVAL_EXPIRED/);
    expect(() => assertApprovalExpiredRefusal({
      status: 422,
      code: "APPROVAL_EXPIRED",
      message: "The signed transaction expired",
    })).toThrow(/specific APPROVAL_EXPIRED/);
  });

  it("accepts only exact txnNotFound as non-inclusion evidence", () => {
    expect(() => assertExactTxnNotFound({ data: { error: "txnNotFound" } })).not.toThrow();
    expect(() => assertExactTxnNotFound({ result: { validated: false } })).toThrow(/exact txnNotFound/i);
    expect(() => assertExactTxnNotFound({ result: { validated: true } })).toThrow(/exact txnNotFound/i);
    expect(() => assertExactTxnNotFound(new Error("transport failed"))).toThrow(/exact txnNotFound/i);
  });

  it("compares validated RLUSD balance deltas exactly and fails closed on malformed values", () => {
    expect(() => assertExactRlusdBalanceDelta("0", "75.000000000000000", "75")).not.toThrow();
    expect(() => assertExactRlusdBalanceDelta("100", "80", "-20")).not.toThrow();
    expect(() => assertExactRlusdBalanceDelta("0", "74.999999999999999", "75"))
      .toThrow(/not exactly 75/i);
    expect(() => assertExactRlusdBalanceDelta("0", "NaN", "75")).toThrow(/canonical decimal/i);
    expect(() => assertExactRlusdBalanceDelta("0", "Infinity", "75")).toThrow(/canonical decimal/i);
    expect(() => assertExactRlusdBalanceDelta(undefined, "75", "75")).toThrow(/canonical decimal/i);
  });

  it("fails closed unless a Harbor build has an exact successful dry-run and preflight", () => {
    const base = {
      build_id: "build-1",
      network: "testnet",
      tx_json: { Account: "rOwner", TransactionType: "OfferCreate" },
      summary: { account: "rOwner" },
      simulate: { applied: false, engine_result: "tesSUCCESS" },
      preflight: [{ check: "schema", pass: true }],
    };
    expect(() => assertSafeBuild(base, {
      account: "rOwner",
      network: "testnet",
      transactionType: "OfferCreate",
    })).not.toThrow();
    expect(() => assertSafeBuild({ ...base, simulate: { applied: false, engine_result: "tecKILLED" } }, {
      account: "rOwner",
      network: "testnet",
      transactionType: "OfferCreate",
    })).toThrow(/simulate\.engine_result.*tecKILLED/i);
    expect(() => assertSafeBuild({ ...base, preflight: [{ check: "policy", pass: false }] }, {
      account: "rOwner",
      network: "testnet",
      transactionType: "OfferCreate",
    })).toThrow(/preflight\[\]\.pass.*policy/i);
  });

  it.each([
    ["build", null, ["build"]],
    ["build_id", { build_id: "" }, ["build_id"]],
    ["network", { network: "devnet" }, ["network"]],
    ["tx_json", { tx_json: null }, ["tx_json"]],
    ["tx_json.Account", { tx_json: { Account: "rOther", TransactionType: "OfferCreate" } }, ["tx_json.Account"]],
    ["tx_json.TransactionType", { tx_json: { Account: "rOwner", TransactionType: "Payment" } }, ["tx_json.TransactionType"]],
    ["summary", { summary: null }, ["summary"]],
    ["summary.account", { summary: { account: "rOther" } }, ["summary.account"]],
    ["simulate", { simulate: null }, ["simulate"]],
    ["simulate.applied", { simulate: { applied: true, engine_result: "tesSUCCESS" } }, ["simulate.applied"]],
    ["simulate.engine_result", { simulate: { applied: false, engine_result: "tecKILLED" } }, ["simulate.engine_result"]],
    ["preflight empty", { preflight: [] }, ["preflight"]],
    ["preflight malformed", { preflight: [null] }, ["preflight[]"]],
    ["preflight failed", { preflight: [{ check: "reserve", pass: false }] }, ["preflight[].pass"]],
  ])("reports only the sanitized failed build predicate for %s", (_name, patch, expectedFields) => {
    const base = {
      build_id: "build-1",
      network: "testnet",
      tx_json: { Account: "rOwner", TransactionType: "OfferCreate" },
      summary: { account: "rOwner" },
      simulate: { applied: false, engine_result: "tesSUCCESS" },
      preflight: [{ check: "schema", pass: true }],
    };
    const candidate = patch === null ? null : { ...base, ...patch };
    expect(safeBuildFailureDiagnostics(candidate, {
      account: "rOwner",
      network: "testnet",
      transactionType: "OfferCreate",
    }).failedFields).toEqual(expectedFields);
  });

  it("aggregates deterministic sanitized build diagnostics without reflecting unsafe values", () => {
    const sentinel = "tecSEED_SECRET_PRIVATE_MATERIAL";
    const diagnostics = safeBuildFailureDiagnostics({
      build_id: "",
      network: sentinel,
      tx_json: { Account: sentinel, TransactionType: sentinel },
      summary: { account: sentinel },
      simulate: { applied: true, engine_result: sentinel },
      preflight: [null, { check: sentinel, pass: false }, { check: "reserve", pass: false }],
    }, {
      account: "rOwner",
      network: "testnet",
      transactionType: "OfferCreate",
    });
    expect(diagnostics).toEqual({
      failedFields: [
        "build_id",
        "network",
        "tx_json.Account",
        "tx_json.TransactionType",
        "summary.account",
        "simulate.applied",
        "simulate.engine_result",
        "preflight[]",
        "preflight[].pass",
      ],
      simulationEngineResult: undefined,
      failedPreflightChecks: ["reserve"],
    });
    expect(JSON.stringify(diagnostics)).not.toContain(sentinel);
    expect(() => assertSafeBuild({
      build_id: "",
      network: sentinel,
      tx_json: { Account: sentinel, TransactionType: sentinel },
      summary: { account: sentinel },
      simulate: { applied: true, engine_result: sentinel },
      preflight: [{ check: sentinel, pass: false }],
    }, {
      account: "rOwner",
      network: "testnet",
      transactionType: "OfferCreate",
    })).toThrow(expect.not.stringContaining(sentinel));
  });

  it("attributes the sanitized stopped FOK fixture to tecKILLED without weakening the gate", () => {
    const stoppedBuild = {
      build_id: "bd6d85f5-c521-43cc-8ce5-3adcbfa55bda",
      network: "testnet",
      tx_json: {
        Account: "r5QTTcw4XtrY58EeBiaJDoDV7ZRzYa5GL",
        TransactionType: "OfferCreate",
        Flags: 0x00040000,
        TakerGets: "265701941",
        TakerPays: {
          currency: "524C555344000000000000000000000000000000",
          issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
          value: "75",
        },
      },
      summary: { account: "r5QTTcw4XtrY58EeBiaJDoDV7ZRzYa5GL" },
      simulate: {
        applied: false,
        engine_result: "tecKILLED",
        engine_result_message: "No funds transferred and no offer created.",
      },
      preflight: [
        { check: "network", pass: true },
        { check: "reserve", pass: true },
        { check: "trust-line", pass: true },
        { check: "require-auth", pass: true },
        { check: "expiry", pass: true },
        { check: "flag-conflicts", pass: true },
      ],
    };
    const expected = {
      account: "r5QTTcw4XtrY58EeBiaJDoDV7ZRzYa5GL",
      network: "testnet",
      transactionType: "OfferCreate",
    };
    expect(safeBuildFailureDiagnostics(stoppedBuild, expected)).toEqual({
      failedFields: ["simulate.engine_result"],
      simulationEngineResult: "tecKILLED",
      failedPreflightChecks: [],
    });
    expect(() => assertSafeBuild(stoppedBuild, expected))
      .toThrow(/simulate\.engine_result.*tecKILLED/i);
  });

  it("requires approval metadata and tx_json to preserve the exact safe build", () => {
    const build = {
      tx_json: { Account: "rOwner", TransactionType: "VaultDeposit", Amount: "1000000" },
    };
    const approval = {
      status: "needs_approval",
      approval_id: "approval-1",
      expires_at: "2099-01-01T00:00:00.000Z",
      tx_json: build.tx_json,
    };
    expect(() => assertApprovalMatchesBuild(build, approval)).not.toThrow();
    expect(() => assertApprovalMatchesBuild(build, {
      ...approval,
      tx_json: { ...build.tx_json, Fee: "12", Sequence: 4, LastLedgerSequence: 110 },
    })).not.toThrow();
    expect(() => assertApprovalMatchesBuild(build, {
      ...approval,
      tx_json: { ...build.tx_json, Amount: "2000000" },
    })).toThrow(/exact safe build/i);
    expect(() => assertApprovalMatchesBuild(build, { ...approval, expires_at: "invalid" }))
      .toThrow(/exact safe build/i);
  });

  it("allows only bounded unsigned owner transaction fields", () => {
    const tx = {
      TransactionType: "VaultDeposit",
      Account: "rOwner",
      VaultID: "A".repeat(64),
      Amount: "1000000",
      Fee: "12",
      Sequence: 4,
      LastLedgerSequence: 110,
    };
    expect(() => assertSafeOwnerTransaction(tx, "rOwner", 100, 4)).not.toThrow();
    expect(() => assertSafeOwnerTransaction({ ...tx, Sequence: 5 }, "rOwner", 100, 4)).toThrow(/unsafe or stale/i);
    expect(() => assertSafeOwnerTransaction({ ...tx, Fee: "101" }, "rOwner", 100, 4)).toThrow(/unsafe or stale/i);
    expect(() => assertSafeOwnerTransaction({ ...tx, LastLedgerSequence: 151 }, "rOwner", 100, 4)).toThrow(/unsafe or stale/i);
    expect(() => assertSafeOwnerTransaction({ ...tx, Destination: "rOther" }, "rOwner", 100, 4)).toThrow(/unsafe or stale/i);
    expect(() => assertSafeOwnerTransaction({ ...tx, TxnSignature: "BAD" }, "rOwner", 100, 4)).toThrow(/unsafe or stale/i);
  });
});

function acquisitionState(overrides = {}) {
  const operationId = "00000000-0000-4000-8000-000000000001";
  return {
    version: 3,
    operation_id: operationId,
    owner: "rOwner",
    network: "testnet",
    issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
    currency: "524C555344000000000000000000000000000000",
    amount: "75",
    cap_drops: "275000000",
    intent_id: `p-live-acquire-rlusd-${operationId}`,
    status: "signed_pending",
    balance_before: "0",
    balance_before_ledger_index: 100,
    amm_eligibility_quote: ammEligibilityQuote("rOwner", 100),
    execution_quote: exactOutputQuote("rOwner", "268428007", 100),
    funded_balance_drops: "300000000",
    build_id: "build-1",
    tx_json: { TransactionType: "OfferCreate" },
    hash: "A".repeat(64),
    last_ledger_sequence: 130,
    ...overrides,
  };
}

function exactOutputQuote(account, sourceAmountDrops, ledgerIndex) {
  return {
    source: "ripple_path_find.validated.exact_output",
    rounding_reference: "xrpl-exact-output-rounding-v1",
    network: "testnet",
    account,
    ledger_index: ledgerIndex,
    ledger_hash: "C".repeat(64),
    source_asset: { currency: "XRP" },
    destination_amount: {
      currency: "524C555344000000000000000000000000000000",
      issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
      value: "75",
    },
    source_amount_drops: sourceAmountDrops,
    max_slippage_bps: 100,
    maximum_input_drops: maximumInputDrops(BigInt(sourceAmountDrops), 100).toString(),
  };
}

function exactOutputQuoteResult(account, alternatives, overrides = {}) {
  return {
    validated: true,
    full_reply: true,
    ledger_index: 90000000,
    ledger_hash: "D".repeat(64),
    source_account: account,
    destination_account: account,
    destination_amount: {
      currency: "524C555344000000000000000000000000000000",
      issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
      value: "75",
    },
    alternatives,
    ...overrides,
  };
}

function ammEligibilityQuote(account, ledgerIndex) {
  return {
    source: "amm_info.validated.constant_product",
    network: "testnet",
    account,
    ledger_index: ledgerIndex,
    ledger_hash: "B".repeat(64),
    source_asset: { currency: "XRP" },
    destination_amount: {
      currency: "524C555344000000000000000000000000000000",
      issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
      value: "75",
    },
    xrp_reserve_drops: "782771569438",
    rlusd_reserve: "219952.3222748822",
    trading_fee: 501,
    quoted_input_drops: "268347252",
    max_slippage_bps: 100,
    maximum_input_drops: "271030725",
  };
}

function acquisitionQuoteReferences(account, { executionQuote } = {}) {
  return {
    ammEligibilityQuote: ammEligibilityQuote(account, 90000000),
    executionQuote: executionQuote ?? exactOutputQuote(account, "268428007", 90000000),
  };
}

function acquisitionTransaction(account, takerGets, lastLedgerSequence) {
  return {
    TransactionType: "OfferCreate",
    Account: account,
    TakerGets: takerGets,
    TakerPays: {
      currency: "524C555344000000000000000000000000000000",
      issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
      value: "75",
    },
    Flags: 0x0004_0000,
    LastLedgerSequence: lastLedgerSequence,
  };
}
