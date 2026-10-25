import { Wallet, hashes, type Payment } from "xrpl";
import { describe, expect, it, vi } from "vitest";

import {
  InMemoryIssuedX402Budget,
  InMemoryIssuedX402State,
  X402IssuedOfflineError,
  canonicalIssuedApprovalEnvelope,
  createOfflineIssuedX402Route,
  createOfflineIssuedX402RequestHandler,
  digestIssuedApprovalEnvelope,
  type X402IssuedApprovalEnvelopeV1,
  type X402IssuedLedgerPreparation,
  type X402IssuedPolicy,
  type X402IssuedSigningRequest,
} from "../src/exec/x402-issued-offline";
import { createIssuedX402FixtureService } from "../src/exec/x402-issued-service";

const CURRENCY = "524C555344000000000000000000000000000000";
const REQUEST_URL = "http://127.0.0.1:8000/api/x402/compare";
const MERCHANT_ID = "merchant-compare-v1";
const SESSION_SCOPE = "principal-owner-review-0001";

function base64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64Json(value: string): Record<string, unknown> {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

function challenge(policy: X402IssuedPolicy, changes: Record<string, unknown> = {}): string {
  const accepted = {
    scheme: "exact",
    network: "xrpl:1",
    asset: policy.asset.currency,
    payTo: policy.payTo,
    amount: "0.01",
    maxTimeoutSeconds: 60,
    extra: {
      areFeesSponsored: false,
      assetTransferMethod: "sequence",
      issuer: policy.asset.issuer,
      sourceTag: policy.sourceTag,
      invoiceId: "issued-invoice-1",
    },
    ...changes,
  };
  return base64Json({
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: {
      url: REQUEST_URL,
      description: "Local Pilot venue comparison paid with native XRPL issued currency",
      mimeType: "application/json",
      serviceName: "Pilot",
      tags: ["compare", "native-xrpl-issued-currency", "offline-fixture"],
    },
    accepts: [accepted],
    extensions: {},
  });
}

function setup(
  challengeChanges: Record<string, unknown> = {},
  options: {
    mutatePreparation?: (
      value: X402IssuedLedgerPreparation,
    ) => X402IssuedLedgerPreparation;
    payThrows?: boolean;
    receiptPatch?: Record<string, unknown>;
    signerWallet?: Wallet;
    signerNever?: boolean;
    signedTransactionPatch?: Partial<Payment>;
    operationTimeoutMs?: number;
  } = {},
) {
  // These keypairs exist only in process memory for format/signature validation.
  // No seed, private key, signed blob, or account credential is persisted/logged.
  const payer = Wallet.generate();
  const payee = Wallet.generate();
  const issuer = Wallet.generate();
  const policy: X402IssuedPolicy = {
    asset: {
      kind: "xrpl-issued",
      network: "xrpl:1",
      currency: CURRENCY,
      issuer: issuer.classicAddress,
    },
    payTo: payee.classicAddress,
    sourceTag: 2_610_240,
    maxPerCall: "1",
    dailyCap: "2",
    lifetimeCap: "3",
    maxFeeDrops: "20",
    dailyFeeCapDrops: "40",
    lifetimeFeeCapDrops: "60",
    minimumXrpReserveDrops: "1200000",
  };
  let signerCalls = 0;
  let merchantCalls = 0;
  let presented: X402IssuedSigningRequest | undefined;
  const state = new InMemoryIssuedX402State();
  const budget = new InMemoryIssuedX402Budget(
    policy,
    () => new Date("2026-10-24T12:00:00.000Z"),
  );
  const dependencies = {
    enabled: true,
    requestUrl: REQUEST_URL,
    merchantId: MERCHANT_ID,
    sessionScope: SESSION_SCOPE,
    policy,
    budget,
    state,
    prepare: async (approvalInput) => {
      const unsigned = {
      owner: payer.classicAddress,
      approvalId: "approval-issued-1",
      quoteExpiresAt: "2026-10-24T12:04:00.000Z",
      feeDrops: "12",
      validatedLedgerIndex: 1000,
      reserveBaseDrops: "1000000",
      reserveIncrementDrops: "200000",
      issuer: {
        account: issuer.classicAddress,
        flags: 0x0080_0000,
        transferRate: 1_000_000_000,
      },
      payer: {
        account: payer.classicAddress,
        balanceDrops: "5000000",
        ownerCount: 1,
        sequence: 1,
        flags: 0,
      },
      payee: { account: payee.classicAddress, flags: 0 },
      payerLine: {
        holder: payer.classicAddress,
        issuer: issuer.classicAddress,
        currency: CURRENCY,
        balance: "100",
        limit: "1000",
        frozen: false,
        deepFrozen: false,
        authorized: false,
        issuerNoRipple: false,
        qualitiesDefault: true,
      },
      payeeLine: {
        holder: payee.classicAddress,
        issuer: issuer.classicAddress,
        currency: CURRENCY,
        balance: "0",
        limit: "1000",
        frozen: false,
        deepFrozen: false,
        authorized: false,
        issuerNoRipple: false,
        qualitiesDefault: true,
      },
      };
      const approvalDigest = await digestIssuedApprovalEnvelope({
        version: 1,
        domain: "pilot.x402.owner-approval",
        approval_id: unsigned.approvalId,
        network: "xrpl:1",
        execution_network: "testnet",
        session_scope: SESSION_SCOPE,
        idempotency_key: approvalInput.idempotencyKey,
        merchant: {
          id: MERCHANT_ID,
          resource_method: "POST",
          resource_url: REQUEST_URL,
          pay_to: payee.classicAddress,
        },
        asset: {
          kind: "issued",
          network: "xrpl:1",
          namespace: "token",
          currency: CURRENCY,
          issuer: issuer.classicAddress,
        },
        amount: approvalInput.challenge.amount,
        owner: payer.classicAddress,
        quote_expires_at: unsigned.quoteExpiresAt,
        merchant_invoice_id: approvalInput.challenge.invoiceId,
        transaction: {
          fee_drops: unsigned.feeDrops,
          sequence: unsigned.payer.sequence,
          last_ledger_sequence: 1014,
          source_tag: policy.sourceTag,
          validated_ledger_index: unsigned.validatedLedgerIndex,
        },
      });
      const value: X402IssuedLedgerPreparation = { ...unsigned, approvalDigest };
      return options.mutatePreparation?.(value) ?? value;
    },
    signer: {
      sign: async (request) => {
        signerCalls += 1;
        presented = request;
        if (options.signerNever) return await new Promise<never>(() => undefined);
        const signed = (options.signerWallet ?? payer).sign({
          ...request.tx_json,
          ...options.signedTransactionPatch,
        });
        return { signedBlob: signed.tx_blob, hash: signed.hash };
      },
    },
    reconciler: {
      reconcile: async (expectation) => ({
        status: "validated" as const,
        budgetDisposition: "commit" as const,
        evidence: {
          provenance: {
            kind: "fixture" as const,
            evidenceSource: "deterministic-offline-ledger-fixture" as const,
            sourceId: "issued-route-test",
            notice: "OFFLINE FIXTURE ONLY. This is not live XRPL validated-ledger evidence." as const,
          },
          transactionHash: expectation.transactionHash,
          network: "xrpl:1" as const,
          merchantInvoiceId: expectation.merchantInvoiceId,
          ledgerIndex: 1_001,
          transactionResult: "tesSUCCESS" as const,
          deliveredAmount: {
            currency: expectation.asset.currency,
            issuer: expectation.asset.issuer,
            value: expectation.amount,
          },
        },
      }),
    },
    now: () => new Date("2026-10-24T12:00:00.000Z"),
    merchant: {
      challenge: async () => new Response(JSON.stringify({ error: "payment_required" }), {
        status: 402,
        headers: {
          "content-type": "application/json",
          "payment-required": challenge(policy, challengeChanges),
        },
      }),
      pay: async (paymentSignature) => {
        merchantCalls += 1;
        if (options.payThrows) throw new Error("fixture transport interrupted");
        const payload = decodeBase64Json(paymentSignature);
        const body = payload.payload as Record<string, unknown>;
        const signedBlob = body.signedTxBlob as string;
        return new Response(JSON.stringify({
          comparison: ["dex", "amm"],
          paymentEvidence: "deterministic-offline-fixture-not-live-validation",
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "payment-response": base64Json({
              success: true,
              transaction: hashes.hashSignedTx(signedBlob),
              network: "xrpl:1",
              payer: payer.classicAddress,
              evidenceSource: "deterministic-offline-fixture",
              ...options.receiptPatch,
            }),
          },
        });
      },
    },
    ...(options.operationTimeoutMs === undefined
      ? {}
      : { operationTimeoutMs: options.operationTimeoutMs }),
  } as const;
  const route = createOfflineIssuedX402Route(dependencies);
  return {
    payer,
    payee,
    issuer,
    policy,
    route,
    newRoute: () => createOfflineIssuedX402Route(dependencies),
    routeForRequestUrl: (requestUrl: string) => createOfflineIssuedX402Route({
      ...dependencies,
      requestUrl,
    }),
    state,
    calls: () => ({ signerCalls, merchantCalls }),
    presented: () => presented,
  };
}

describe("native-XRPL issued x402 offline route", () => {
  it("matches the joint Ledger approval-envelope golden vector", async () => {
    const envelope: X402IssuedApprovalEnvelopeV1 = {
      version: 1,
      domain: "pilot.x402.owner-approval",
      approval_id: "rlusd-approval-0001",
      network: "xrpl:1",
      execution_network: "testnet",
      session_scope: "principal-owner-review-0001",
      idempotency_key: "owner-review-operation-0001",
      merchant: {
        id: "merchant-weather-api-v1",
        resource_method: "POST",
        resource_url: "https://merchant.example/v1/weather",
        pay_to: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
      },
      asset: {
        currency: CURRENCY,
        issuer: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
        kind: "issued",
        namespace: "token",
        network: "xrpl:1",
      },
      amount: "1.25",
      owner: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      quote_expires_at: "2026-10-24T12:01:00.000Z",
      merchant_invoice_id: "invoice-merchant-0001",
      transaction: {
        fee_drops: "12",
        last_ledger_sequence: 512,
        sequence: 7,
        source_tag: 2_610_240,
        validated_ledger_index: 500,
      },
    };
    expect(canonicalIssuedApprovalEnvelope(envelope)).toBe(
      '{"amount":"1.25","approval_id":"rlusd-approval-0001","asset":{"currency":"524C555344000000000000000000000000000000","issuer":"rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh","kind":"issued","namespace":"token","network":"xrpl:1"},"domain":"pilot.x402.owner-approval","execution_network":"testnet","idempotency_key":"owner-review-operation-0001","merchant":{"id":"merchant-weather-api-v1","pay_to":"rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe","resource_method":"POST","resource_url":"https://merchant.example/v1/weather"},"merchant_invoice_id":"invoice-merchant-0001","network":"xrpl:1","owner":"r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59","quote_expires_at":"2026-10-24T12:01:00.000Z","session_scope":"principal-owner-review-0001","transaction":{"fee_drops":"12","last_ledger_sequence":512,"sequence":7,"source_tag":2610240,"validated_ledger_index":500},"version":1}',
    );
    await expect(digestIssuedApprovalEnvelope(envelope)).resolves.toBe(
      "7E9C53C776814D340A3D37840F2983D2EECC4376355E7F4526C7D787A4C4181F",
    );
  });

  it("constructs, presents, signs, pays, verifies, and caches one fixture payment", async () => {
    const harness = setup();
    const handler = createOfflineIssuedX402RequestHandler(harness.route);
    const [first, concurrent] = await Promise.all([
      harness.route.execute({ idempotencyKey: "issued-op-1" }),
      harness.route.execute({ idempotencyKey: "issued-op-1" }),
    ]);
    const routeResponse = await handler(new Request("http://local.invalid/x402/issued", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "issued-op-1" }),
    }));
    expect(routeResponse.status).toBe(200);
    const routed = await routeResponse.json();
    const replay = await harness.route.execute({ idempotencyKey: "issued-op-1" });

    expect(first).toEqual(routed);
    expect(first).toEqual(concurrent);
    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      status: "fixture_delivered",
      evidence: "deterministic-offline-fixture",
      amount: "0.01",
      payer: harness.payer.classicAddress,
      payTo: harness.payee.classicAddress,
      invoiceId: "issued-invoice-1",
      feeDrops: "12",
      asset: harness.policy.asset,
    });
    expect(harness.calls()).toEqual({ signerCalls: 1, merchantCalls: 1 });
    expect(harness.presented()).toMatchObject({
      version: 1,
      approval_id: "approval-issued-1",
      owner: harness.payer.classicAddress,
      execution_network: "testnet",
      asset: {
        kind: "issued",
        network: "xrpl:1",
        namespace: "token",
        currency: CURRENCY,
        issuer: harness.issuer.classicAddress,
      },
      amount: "0.01",
      pay_to: harness.payee.classicAddress,
      tx_json: {
        TransactionType: "Payment",
        Account: harness.payer.classicAddress,
        Destination: harness.payee.classicAddress,
      },
    });
    expect(Object.keys(harness.presented()!).sort()).toEqual([
      "amount", "approval_digest", "approval_id", "asset", "execution_network",
      "fee_drops", "invoice_id", "last_ledger_sequence", "owner", "pay_to",
      "quote_expires_at", "sequence", "source_tag", "tx_json",
      "validated_ledger_index", "version",
    ].sort());
    const transaction = harness.presented()!.tx_json;
    expect(Object.keys(transaction).sort()).toEqual([
      "Account", "Amount", "Destination", "Fee", "InvoiceID",
      "LastLedgerSequence", "SendMax", "Sequence", "SourceTag",
      "TransactionType",
    ].sort());
    expect(transaction.Amount).toEqual({
      currency: CURRENCY,
      issuer: harness.issuer.classicAddress,
      value: "0.01",
    });
    expect(transaction.SendMax).toEqual(transaction.Amount);
    expect(harness.presented()!.approval_digest).toBe(transaction.InvoiceID);
    expect(transaction).not.toHaveProperty("Paths");
    expect(transaction).not.toHaveProperty("DeliverMin");
  });

  it("runs the public fixture service through challenge, approval, signing, reconciliation, and resource delivery", async () => {
    const harness = setup();
    const service = createIssuedX402FixtureService({
      route: harness.route,
      owner: harness.payer.classicAddress,
      sessionScope: SESSION_SCOPE,
      merchantId: MERCHANT_ID,
      resourceUrl: REQUEST_URL,
      policy: harness.policy,
    });
    const result = await service.pay("principal-owner-review-0001", {
      owner: harness.payer.classicAddress,
      network: "testnet",
      resource: "compare",
      session_scope: SESSION_SCOPE,
      merchant: {
        id: MERCHANT_ID,
        resource_method: "POST",
        resource_url: REQUEST_URL,
      },
      asset: harness.policy.asset,
      max_amount: "0.01",
      pay_to: harness.payee.classicAddress,
      idempotency_key: "issued-op-1",
    });
    expect(result).toMatchObject({
      status: "fixture_delivered",
      evidence: "deterministic-offline-fixture",
      session_scope: SESSION_SCOPE,
      merchant_invoice_id: "issued-invoice-1",
      approval_digest: harness.presented()!.approval_digest,
      validated_ledger_index: 1_001,
    });
    expect(harness.calls()).toEqual({ signerCalls: 1, merchantCalls: 1 });
  });

  it("is disabled unless explicitly enabled", async () => {
    const harness = setup();
    const disabled = createOfflineIssuedX402Route({
      enabled: false,
      requestUrl: REQUEST_URL,
      merchantId: MERCHANT_ID,
      sessionScope: SESSION_SCOPE,
      policy: harness.policy,
      budget: new InMemoryIssuedX402Budget(harness.policy),
      state: new InMemoryIssuedX402State(),
      prepare: async () => ({
        owner: harness.payer.classicAddress,
        approvalId: "approval-disabled",
        approvalDigest: "A".repeat(64),
        quoteExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        feeDrops: "12",
        validatedLedgerIndex: 1000,
        reserveBaseDrops: "1000000",
        reserveIncrementDrops: "200000",
        issuer: {
          account: harness.issuer.classicAddress,
          flags: 0x0080_0000,
          transferRate: 1_000_000_000,
        },
        payer: {
          account: harness.payer.classicAddress,
          balanceDrops: "5000000",
          ownerCount: 1,
          sequence: 1,
          flags: 0,
        },
        payee: { account: harness.payee.classicAddress, flags: 0 },
        payerLine: {
          holder: harness.payer.classicAddress,
          issuer: harness.issuer.classicAddress,
          currency: CURRENCY,
          balance: "100",
          limit: "1000",
          frozen: false,
          deepFrozen: false,
          authorized: false,
          issuerNoRipple: false,
          qualitiesDefault: true,
        },
        payeeLine: {
          holder: harness.payee.classicAddress,
          issuer: harness.issuer.classicAddress,
          currency: CURRENCY,
          balance: "0",
          limit: "1000",
          frozen: false,
          deepFrozen: false,
          authorized: false,
          issuerNoRipple: false,
          qualitiesDefault: true,
        },
      }),
      signer: { sign: vi.fn() },
      reconciler: { reconcile: vi.fn() },
      merchant: { challenge: vi.fn(), pay: vi.fn() },
    });
    await expect(disabled.execute({ idempotencyKey: "disabled" })).rejects.toMatchObject({
      code: "ISSUED_X402_OFFLINE_DISABLED",
    });
  });

  it.each([
    ["wrong issuer", { extra: {
      areFeesSponsored: false,
      assetTransferMethod: "sequence",
      issuer: Wallet.generate().classicAddress,
      sourceTag: 2_610_240,
      invoiceId: "issued-invoice-1",
    } }],
    ["wrong network", { network: "xrpl:0" }],
    ["fee sponsorship", { extra: {
      areFeesSponsored: true,
      assetTransferMethod: "sequence",
      issuer: "invalid",
      sourceTag: 2_610_240,
      invoiceId: "issued-invoice-1",
    } }],
    ["partial-payment extension", { extra: {
      areFeesSponsored: false,
      assetTransferMethod: "sequence",
      issuer: "invalid",
      sourceTag: 2_610_240,
      invoiceId: "issued-invoice-1",
      transferFee: "1",
    } }],
  ])("rejects %s before signing", async (_label, changes) => {
    const harness = setup(changes);
    await expect(harness.route.execute({ idempotencyKey: "negative" })).rejects
      .toBeInstanceOf(X402IssuedOfflineError);
    expect(harness.calls()).toEqual({ signerCalls: 0, merchantCalls: 0 });
  });

  it("atomically enforces daily asset caps and aggregate XRP reserve", async () => {
    const harness = setup();
    const policy = {
      ...harness.policy,
      maxPerCall: "0.01",
      dailyCap: "0.01",
      lifetimeCap: "0.02",
    };
    const budget = new InMemoryIssuedX402Budget(policy);
    const reservation = (idempotencyKey: string) => budget.reserve({
      idempotencyKey,
      payer: harness.payer.classicAddress,
      asset: policy.asset,
      amount: "0.01",
      feeDrops: "12",
      xrpBalanceDrops: "1200020",
      minimumReserveDrops: "1200000",
    });
    const outcomes = await Promise.allSettled([
      reservation("budget-1"),
      reservation("budget-2"),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
  });

  it("uses the ledger-derived reserve for aggregate in-flight fees", async () => {
    const harness = setup();
    const budget = new InMemoryIssuedX402Budget(harness.policy);
    const reserve = (idempotencyKey: string) => budget.reserve({
      idempotencyKey,
      payer: harness.payer.classicAddress,
      asset: harness.policy.asset,
      amount: "0.01",
      feeDrops: "12",
      xrpBalanceDrops: "1200025",
      minimumReserveDrops: "1200010",
    });
    await expect(reserve("derived-reserve-1")).resolves.toMatchObject({
      replay: false,
    });
    await expect(reserve("derived-reserve-2")).rejects.toMatchObject({
      code: "ISSUED_XRP_RESERVE_REJECTED",
    });
  });

  it.each([
    ["global freeze", (value: X402IssuedLedgerPreparation) => ({
      ...value,
      issuer: { ...value.issuer, flags: value.issuer.flags | 0x0040_0000 },
    })],
    ["require auth", (value: X402IssuedLedgerPreparation) => ({
      ...value,
      issuer: { ...value.issuer, flags: value.issuer.flags | 0x0004_0000 },
    })],
    ["transfer fee", (value: X402IssuedLedgerPreparation) => ({
      ...value,
      issuer: { ...value.issuer, transferRate: 1_010_000_000 },
    })],
    ["frozen payer line", (value: X402IssuedLedgerPreparation) => ({
      ...value,
      payerLine: { ...value.payerLine, frozen: true },
    })],
    ["authorized line ambiguity", (value: X402IssuedLedgerPreparation) => ({
      ...value,
      payerLine: { ...value.payerLine, authorized: true },
    })],
    ["deposit auth", (value: X402IssuedLedgerPreparation) => ({
      ...value,
      payee: { ...value.payee, flags: value.payee.flags | 0x0100_0000 },
    })],
    ["insufficient issued balance", (value: X402IssuedLedgerPreparation) => ({
      ...value,
      payerLine: { ...value.payerLine, balance: "0" },
    })],
    ["actual reserve", (value: X402IssuedLedgerPreparation) => ({
      ...value,
      payer: { ...value.payer, balanceDrops: "1200011" },
    })],
    ["expired approval", (value: X402IssuedLedgerPreparation) => ({
      ...value,
      quoteExpiresAt: "2026-10-24T11:59:59.000Z",
    })],
    ["missing issuer flags", (value: X402IssuedLedgerPreparation) => ({
      ...value,
      issuer: { ...value.issuer, flags: undefined as never },
    })],
    ["non-boolean trust-line proof", (value: X402IssuedLedgerPreparation) => ({
      ...value,
      payerLine: { ...value.payerLine, frozen: "false" as never },
    })],
    ["non-string approval id", (value: X402IssuedLedgerPreparation) => ({
      ...value,
      approvalId: 12_345_678 as never,
    })],
    ["approval digest mutation", (value: X402IssuedLedgerPreparation) => ({
      ...value,
      approvalDigest: "A".repeat(64),
    })],
  ])("fails closed on %s before signing", async (_label, mutatePreparation) => {
    const harness = setup({}, { mutatePreparation });
    await expect(harness.route.execute({ idempotencyKey: `preflight-${_label}` }))
      .rejects.toBeInstanceOf(X402IssuedOfflineError);
    expect(harness.calls()).toEqual({ signerCalls: 0, merchantCalls: 0 });
  });

  it("fences invoice and payer sequence across different idempotency keys", async () => {
    const harness = setup();
    await harness.route.execute({ idempotencyKey: "sequence-1" });
    await expect(harness.route.execute({ idempotencyKey: "sequence-2" }))
      .rejects.toMatchObject({ code: "ISSUED_INVOICE_OR_SEQUENCE_CONFLICT" });
    expect(harness.calls()).toEqual({ signerCalls: 1, merchantCalls: 1 });
  });

  it("fences approval identifiers and digests independently of invoice and sequence", async () => {
    const harness = setup();
    await harness.state.reserve({
      idempotencyKey: "approval-fence-1",
      scope: "scope-a",
      binding: "binding-1",
      payer: harness.payer.classicAddress,
      invoiceId: "invoice-a",
      sequence: 1,
      approvalId: "approval-replay",
      approvalDigest: "C".repeat(64),
    });
    await expect(harness.state.reserve({
      idempotencyKey: "approval-fence-2",
      scope: "scope-a",
      binding: "binding-2",
      payer: harness.payer.classicAddress,
      invoiceId: "invoice-b",
      sequence: 2,
      approvalId: "approval-replay",
      approvalDigest: "D".repeat(64),
    })).rejects.toMatchObject({ code: "ISSUED_INVOICE_OR_SEQUENCE_CONFLICT" });
    await expect(harness.state.reserve({
      idempotencyKey: "approval-fence-3",
      scope: "scope-a",
      binding: "binding-3",
      payer: harness.payer.classicAddress,
      invoiceId: "invoice-c",
      sequence: 3,
      approvalId: "approval-distinct",
      approvalDigest: "C".repeat(64),
    })).rejects.toMatchObject({ code: "ISSUED_INVOICE_OR_SEQUENCE_CONFLICT" });
  });

  it("retains uncertainty across route reconstruction without a second sign", async () => {
    const harness = setup({}, { payThrows: true });
    await expect(harness.route.execute({ idempotencyKey: "unknown-1" }))
      .rejects.toMatchObject({ code: "MERCHANT_SETTLEMENT_UNCERTAIN" });
    await expect(harness.newRoute().execute({ idempotencyKey: "unknown-1" }))
      .rejects.toMatchObject({ code: "ISSUED_SETTLEMENT_RECONCILIATION_REQUIRED" });
    expect(harness.calls()).toEqual({ signerCalls: 1, merchantCalls: 1 });
  });

  it("rejects a delivered idempotency replay under a different resource scope", async () => {
    const harness = setup();
    await harness.route.execute({ idempotencyKey: "cross-resource-1" });
    const otherResource = harness.routeForRequestUrl(
      "http://127.0.0.1:8000/api/x402/different-service",
    );
    await expect(otherResource.execute({ idempotencyKey: "cross-resource-1" }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_BINDING_MISMATCH" });
    expect(harness.calls()).toEqual({ signerCalls: 1, merchantCalls: 1 });
  });

  it("treats a mismatched fixture receipt as uncertain and never re-signs", async () => {
    const harness = setup({}, { receiptPatch: { transaction: "B".repeat(64) } });
    await expect(harness.route.execute({ idempotencyKey: "receipt-1" }))
      .rejects.toMatchObject({ code: "MERCHANT_FIXTURE_RECEIPT_MISMATCH" });
    await expect(harness.newRoute().execute({ idempotencyKey: "receipt-1" }))
      .rejects.toMatchObject({ code: "ISSUED_SETTLEMENT_RECONCILIATION_REQUIRED" });
    expect(harness.calls()).toEqual({ signerCalls: 1, merchantCalls: 1 });
  });

  it.each([0, 0x8000_0000])(
    "rejects signer-added Flags=%i required to be absent by the Ledger binder",
    async (flags) => {
    const harness = setup({}, {
      signedTransactionPatch: { Flags: flags },
    });
    await expect(harness.route.execute({ idempotencyKey: `flags-${flags}` }))
      .rejects.toMatchObject({ code: "SIGNED_PAYMENT_BINDING_MISMATCH" });
    expect(harness.calls()).toEqual({ signerCalls: 1, merchantCalls: 0 });
    },
  );

  it("bounds request bodies before executing the payment route", async () => {
    const harness = setup();
    const handler = createOfflineIssuedX402RequestHandler(harness.route);
    const response = await handler(new Request("http://local.invalid/x402/issued", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "oversized", padding: "x".repeat(4_096) }),
    }));
    expect(response.status).toBe(400);
    expect(harness.calls()).toEqual({ signerCalls: 0, merchantCalls: 0 });
  });

  it("cancels a request body that never closes", async () => {
    const harness = setup();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => { cancelled = true; },
      start: () => undefined,
    });
    const handler = createOfflineIssuedX402RequestHandler(harness.route, 20);
    const response = await handler(new Request("http://local.invalid/x402/issued", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" }));
    expect(response.status).toBe(400);
    expect(cancelled).toBe(true);
    expect(harness.calls()).toEqual({ signerCalls: 0, merchantCalls: 0 });
  });

  it("times out owner signing and makes the attempt reconciliation-only", async () => {
    const harness = setup({}, { signerNever: true, operationTimeoutMs: 20 });
    await expect(harness.route.execute({ idempotencyKey: "signer-timeout" }))
      .rejects.toMatchObject({ code: "ISSUED_SIGNER_TIMEOUT" });
    await expect(harness.newRoute().execute({ idempotencyKey: "signer-timeout" }))
      .rejects.toMatchObject({ code: "ISSUED_SETTLEMENT_RECONCILIATION_REQUIRED" });
    expect(harness.calls()).toEqual({ signerCalls: 1, merchantCalls: 0 });
  });

  it("rejects a cryptographically valid signature from a different account", async () => {
    const harness = setup({}, { signerWallet: Wallet.generate() });
    await expect(harness.route.execute({ idempotencyKey: "signer-1" }))
      .rejects.toMatchObject({ code: "SIGNER_NOT_AUTHORIZED" });
    expect(harness.calls()).toEqual({ signerCalls: 1, merchantCalls: 0 });
  });
});
