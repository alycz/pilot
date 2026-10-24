import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";
import { decode, Wallet } from "xrpl";

import { DEFAULT_POLICY } from "../src/contracts";
import {
  createX402PaymentEngine,
  X402_COMPARE_URL,
  X402PaymentError,
  type X402PaymentRow,
} from "../src/exec/x402-pay";
import {
  PayerSequenceLeaseAuthority,
} from "../src/exec/payer-sequence-lease";
import {
  createAp4mRuntimeServices,
} from "../src/exec/ap4m-runtime";
import {
  xrplCurrencyCodeForAp4m,
  type ValidatedAp4mX402Challenge,
} from "../src/exec/ap4m-x402";
import {
  handleAp4mPurchase,
  type Ap4mPurchaseServices,
} from "../src/ops/ap4m";
import { getCatalogMerchant } from "../src/ops/merchants";
import { LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO } from "../src/local-x402-isolated-v1";
import fixture from "./fixtures/ap4m-mh4-mm2-v1.json";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const OWNER = "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY";
const MANDATE_ID = "mandate-combined-mock";
const AP4M_IDEMPOTENCY_KEY = "combined-ap4m-0001";
const X402_IDEMPOTENCY_KEY = "combined-x402-0001";
const STATE = "A".repeat(43);
const KEK = btoa(String.fromCharCode(...new Uint8Array(32)));

const MIGRATIONS = Array.from({ length: 8 }, (_, index) =>
  readFileSync(new URL(`../migrations-local-x402/${String(index + 1).padStart(4, "0")}_${[
    "init",
    "x402_payments",
    "x402_payers",
    "x402_sequence_safety",
    "x402_durable_lease",
    "x402_budget_accounting",
    "x402_payer_provisioning",
    "ap4m_shared_runtime",
  ][index]}.sql`, import.meta.url), "utf8"),
).join("\n");

type SqlValue = string | number | bigint | null | Uint8Array;

class SqliteD1Statement {
  private values: SqlValue[] = [];
  constructor(private readonly statement: StatementSync) {}
  bind(...values: unknown[]): this {
    this.values = values.map((value) => value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : value as SqlValue);
    return this;
  }
  async run(): Promise<D1Result> {
    const result = this.statement.run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } as D1Result["meta"] };
  }
  async first<T>(column?: string): Promise<T | null> {
    const row = this.statement.get(...this.values) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return (column === undefined ? row : row[column]) as T;
  }
}

class SqliteD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  constructor() { this.sqlite.exec(MIGRATIONS); }
  prepare(sql: string): SqliteD1Statement { return new SqliteD1Statement(this.sqlite.prepare(sql)); }
  close(): void { this.sqlite.close(); }
}

function asD1(db: SqliteD1): D1Database {
  return db as unknown as D1Database;
}

function mandate() {
  return {
    mandate: {
      id: MANDATE_ID,
      owner: OWNER,
      network: "testnet" as const,
      status: "ACTIVE" as const,
      execution_type: "DEFERRED" as const,
      not_before: "2026-10-21T00:00:00.000Z",
      expires_at: "2026-10-22T00:00:00.000Z",
      constraints: {
        currency: "USD" as const,
        per_payment_max: "5",
        daily_max: "10",
        total_max: "25",
        payees: ["venue-yield-desk"],
        skus: ["yield-report"],
      },
      agent_public_jwk: fixture.keys.agent_public_jwk,
      l1_digest: "a".repeat(64),
      l2_digest: "b".repeat(64),
      channels: [],
      spent_usd: "0",
    },
    agentKeyCiphertext: new ArrayBuffer(17),
    agentKeyIv: new ArrayBuffer(12),
    claimKeysCiphertext: new ArrayBuffer(17),
    claimKeysIv: new ArrayBuffer(12),
    claimPublicKeys: [],
    prepared: { unsigned_batch: {} },
    closeRequested: false,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function ap4mChallenge(url: string): ValidatedAp4mX402Challenge {
  const merchant = getCatalogMerchant("venue-yield-desk")!;
  const asset = merchant.settle_asset;
  if (asset.kind !== "iou") throw new Error("fixture merchant asset changed");
  const currency = xrplCurrencyCodeForAp4m(asset.currency);
  return {
    x402Version: 2,
    resource: { url },
    scheme: "exact",
    network: "xrpl:1",
    currency,
    issuer: asset.issuer,
    payTo: merchant.xrpl_address,
    amount: "0.75",
    maxTimeoutSeconds: 60,
    invoiceId: "invoice-combined-ap4m",
    sourceTag: 2_610_240,
    accepted: {
      scheme: "exact",
      network: "xrpl:1",
      asset: currency,
      payTo: merchant.xrpl_address,
      amount: "0.75",
      maxTimeoutSeconds: 60,
      extra: {
        areFeesSponsored: false,
        assetTransferMethod: "sequence",
        invoiceId: "invoice-combined-ap4m",
        issuer: asset.issuer,
        sourceTag: 2_610_240,
      },
    },
  };
}

function merchantResponse(intentId: string) {
  return {
    data: {
      schema_id: "yield_report_v1",
      venue: "venue-yield-desk",
      apr_percent: "4.2",
      tvl_usd: "1000000",
      risk: "low",
    },
    intent_validation: {
      intentId,
      validated: true,
      checks: {
        agent_identity: "pass",
        intent: "pass",
        payment: "pass",
        credential: "pass",
      },
      validation_errors: [],
    },
  };
}

function emptyAttempt() {
  return {
    id: "attempt-combined-ap4m",
    principal: "combined-principal",
    mandateId: MANDATE_ID,
    idempotencyKey: AP4M_IDEMPOTENCY_KEY,
    requestFingerprint: "",
    merchantId: "venue-yield-desk",
    sku: "yield-report",
    status: "claimed",
    spendId: null,
    spendDay: null,
    amountUsd: null,
    preparedContextWrapped: null,
    preparedContextBinding: null,
    leaseAcquiredAt: NOW.toISOString(),
    signingStartedAt: null,
    firstEligibleLedgerIndex: null,
    signedBlob: null,
    txHash: null,
    lastLedgerSequence: null,
    settlementUnknownAt: null,
    settledAt: null,
    deliveredAt: null,
    failedAt: null,
    ledgerIndex: null,
    deliveredAmount: null,
    receiptId: null,
    merchantResponse: null,
    merchantResponseAt: null,
    result: null,
    failure: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  } as any;
}

class MockOnlyAp4mStore {
  row = emptyAttempt();
  context: any;
  exists = false;
  signingToken: string | null = null;

  async get() { return this.exists ? this.row : null; }
  async claim(input: any) {
    this.exists = true;
    Object.assign(this.row, {
      id: input.id,
      requestFingerprint: input.requestFingerprint,
      leaseAcquiredAt: input.createdAt,
    });
    return { outcome: "claimed" as const, row: this.row };
  }
  async acquireClaimRecovery() { return { outcome: "invalid-state" as const, row: this.row }; }
  async reserve(input: any) {
    this.context = structuredClone(input.preparedContext);
    Object.assign(this.row, {
      status: "prepared",
      spendId: input.spendId,
      spendDay: input.spendDay,
      amountUsd: input.amountUsd,
      receiptId: input.preparedContext.receiptId,
      preparedContextWrapped: {
        ciphertext: new ArrayBuffer(17),
        iv: new ArrayBuffer(12),
        digest: "C".repeat(64),
      },
    });
    return { outcome: "reserved" as const, row: this.row };
  }
  async readPreparedContext() { return structuredClone(this.context); }
  async acquireSigningLease(_mandateId: string, _idempotencyKey: string, value: any) {
    this.signingToken = value.token;
    Object.assign(this.row, {
      signingStartedAt: value.at,
      firstEligibleLedgerIndex: value.firstEligibleLedgerIndex,
    });
    return { outcome: "acquired" as const, row: this.row };
  }
  async markSigned(_mandateId: string, _idempotencyKey: string, token: string, value: any) {
    if (token !== this.signingToken) return { outcome: "not-owner" as const, row: this.row };
    Object.assign(this.row, {
      status: "signed",
      txHash: value.hash,
      signedBlob: value.signedBlob,
      lastLedgerSequence: value.lastLedgerSequence,
    });
    return { outcome: "transitioned" as const, row: this.row };
  }
  async cacheMerchantResponse(_mandateId: string, _idempotencyKey: string, value: any) {
    this.row.merchantResponse = structuredClone(value.response);
    return { outcome: "transitioned" as const, row: this.row };
  }
  async markSettlementUnknown() {
    this.row.status = "settlement_unknown";
    return { outcome: "transitioned" as const, row: this.row };
  }
  async markSettled(_mandateId: string, _idempotencyKey: string, value: any) {
    Object.assign(this.row, {
      status: "settled",
      ledgerIndex: value.ledgerIndex,
      deliveredAmount: value.deliveredAmount,
      settledAt: value.at,
    });
    return { outcome: "transitioned" as const, row: this.row };
  }
  async markDelivered(_mandateId: string, _idempotencyKey: string, value: any) {
    Object.assign(this.row, { status: "delivered", result: value.result, deliveredAt: value.at });
    return { outcome: "transitioned" as const, row: this.row };
  }
}

function x402ClaimRow(input: any, payer: string): X402PaymentRow {
  return {
    id: input.id,
    principal: "combined-principal",
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: input.requestFingerprint,
    owner: OWNER,
    network: "testnet",
    delegate: payer,
    url: X402_COMPARE_URL,
    status: "claimed",
    amountDrops: null,
    feeCapDrops: null,
    reservedTotalDrops: null,
    budgetConsumedDrops: null,
    budgetConsumedAt: null,
    callerMaxDrops: null,
    policyPerCallCapDrops: null,
    dailyCapDrops: null,
    payTo: null,
    invoiceId: null,
    requirements: null,
    transaction: null,
    signedBlob: null,
    hash: null,
    lastLedgerSeq: null,
    expiresAt: null,
    reservedAt: null,
    leaseAcquiredAt: input.createdAt,
    signingStartedAt: null,
    signedAt: null,
    settlementUnknownAt: null,
    settledAt: null,
    deliveredAt: null,
    failedAt: null,
    settlement: null,
    delivery: null,
    failure: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

function x402Challenge(): string {
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    resource: { url: X402_COMPARE_URL },
    accepts: [{
      scheme: "exact",
      network: "xrpl:1",
      asset: "XRP",
      payTo: LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO,
      amount: "5000",
      maxTimeoutSeconds: 60,
      extra: {
        invoiceId: "invoice-combined-x402",
        sourceTag: 2_610_240,
        destinationTag: 7,
      },
    }],
  })).toString("base64");
}

describe("combined AP4M + x402 mock-only evidence", () => {
  it("runs the real composed paths with bounded fakes and one shared sequence authority", async () => {
    const db = new SqliteD1();
    try {
      const authority = new PayerSequenceLeaseAuthority(asD1(db));
      const payer = Wallet.generate();
      const ap4mStore = new MockOnlyAp4mStore();
      let releaseSigner!: () => void;
      let signalSigner!: () => void;
      const signerEntered = new Promise<void>((resolve) => { signalSigner = resolve; });
      const signerGate = new Promise<void>((resolve) => { releaseSigner = resolve; });
      const fakeSigner = vi.fn(async ({ payment }: any) => {
        signalSigner();
        await signerGate;
        return payer.sign(payment);
      });
      const fakeMerchant = vi.fn(async (input: any) => {
        const accepted = ap4mChallenge(input.trustedRegistryUrl);
        const paid = await input.preparePaidRequest(accepted, STATE);
        return {
          challenge: accepted,
          challengeState: STATE,
          txHash: paid.signedPayment.hash,
          merchantResponse: merchantResponse(paid.mastercardIntent.intentId),
        };
      });
      const fakeAp4mLedger = vi.fn(async ({ attempt, payment }: any) => ({
        status: "validated" as const,
        evidence: {
          validated: true,
          hash: attempt.txHash,
          ledger_index: 119,
          tx_json: decode(attempt.signedBlob),
          meta: { TransactionResult: "tesSUCCESS", DeliveredAmount: payment.Amount },
        },
      }));
      const ap4mServices: Ap4mPurchaseServices = {
        store: ap4mStore as any,
        sequenceAuthority: () => authority,
        getMerchant: (id) => getCatalogMerchant(id),
        getMandate: async () => mandate(),
        getPolicy: async () => ({ ...DEFAULT_POLICY, ap4m_enabled: true, issuer_allowlist: ["RLUSD"] }),
        getDailySpentUsd: async () => "0",
        getBaseDailySpentUsd: async () => 0,
        getPayer: async () => payer.classicAddress,
        getRecoveryKek: async () => KEK,
        prepareExecution: async () => ({
          l1: fixture.vi.l1,
          l2: fixture.vi.l2,
          payer: payer.classicAddress,
          credentialIds: ["B".repeat(64)],
          preparation: { sequence: 1, validatedLedgerIndex: 100, feeDrops: "12" },
          agentKid: fixture.keys.agent_kid,
          agentIssuer: "https://harbor.example/ap4m/agent",
          networkAudience: "https://harbor.example/ap4m/network",
          merchantAudience: "https://merchant.example",
          recoveryKek: KEK,
          withAgentSigner: async () => { throw new Error("fixture VI is injected"); },
        }),
        mintVi: async ({ intent }) => ({
          intent,
          checkoutPayload: fixture.vi.checkout_payload,
          checkoutHash: fixture.vi.checkout_hash,
          l3a: fixture.vi.l3a,
          l3b: fixture.vi.l3b,
          l3aDigest: fixture.vi.l3a_digest,
          l3bDigest: fixture.vi.l3b_digest,
        }),
        signPayment: fakeSigner,
        exchangeMerchant: fakeMerchant,
        recoverMerchant: async ({ preparedContext }: any) => merchantResponse(preparedContext.intent.intentId),
        reconcile: fakeAp4mLedger,
        expectedSourceTag: 2_610_240,
        now: () => NOW,
        uuid: (() => {
          let id = 0;
          return () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
        })(),
      };

      const ap4m = handleAp4mPurchase(
        { principal: "combined-principal", ap4mServices },
        {
          mandate_id: MANDATE_ID,
          merchant_id: "venue-yield-desk",
          sku: "yield-report",
          idempotency_key: AP4M_IDEMPOTENCY_KEY,
        },
      );
      await signerEntered;

      let x402Row: X402PaymentRow | null = null;
      const fakeX402Ledger = vi.fn(async () => { throw new Error("shared lease must block before XRPL"); });
      const fakeX402Signer = vi.fn(async () => { throw new Error("shared lease must block before signer"); });
      const x402 = createX402PaymentEngine({
        enabled: true,
        fetch: vi.fn(async () => new Response(null, {
          status: 402,
          headers: { "payment-required": x402Challenge() },
        })),
        xrpl: { request: fakeX402Ledger } as any,
        lock: { withLock: async (_key: string, callback: () => Promise<any>) => callback() },
        sequenceLeases: authority,
        resolvePayer: async ({ principal, owner, network }) => ({
          dedicated: true as const,
          merchantPayTo: LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO,
          identity: { principal, owner, network, payer: payer.classicAddress, sourceTag: 2_610_240 },
          store: {
            getByIdempotencyKey: async () => x402Row,
            claim: async (input: any) => {
              x402Row = x402ClaimRow(input, payer.classicAddress);
              return { outcome: "claimed" as const, row: x402Row };
            },
            markClaimFailed: async (_key: string, failure: any, at: string) => {
              x402Row = { ...x402Row!, status: "failed", failure, failedAt: at, updatedAt: at };
              return { outcome: "transitioned" as const, row: x402Row };
            },
          } as any,
          policyPerCallCapDrops: "100000",
          dailyCapDrops: "1000000",
        }),
        withDelegateSigner: fakeX402Signer,
        encodePaymentSignature: () => "unused",
        now: () => NOW,
        newId: () => "payment-combined-x402",
        newLeaseToken: () => "D".repeat(64),
      });

      await expect(x402.execute({
        principal: "combined-principal",
        owner: OWNER,
        network: "testnet",
        idempotencyKey: X402_IDEMPOTENCY_KEY,
        maxPriceDrops: "5000",
        exactPriceDrops: "5000",
        payTo: LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO,
      })).rejects.toMatchObject<X402PaymentError>({ code: "SIGNING_OUTCOME_UNKNOWN" });
      expect(fakeX402Ledger).not.toHaveBeenCalled();
      expect(fakeX402Signer).not.toHaveBeenCalled();

      releaseSigner();
      await expect(ap4m).resolves.toMatchObject({
        receipt: { settlement: "validated", merchant_id: "venue-yield-desk" },
      });
      expect(fakeSigner).toHaveBeenCalledOnce();
      expect(fakeMerchant).toHaveBeenCalledOnce();
      expect(fakeAp4mLedger).toHaveBeenCalledOnce();
      expect(await authority.get({ network: "testnet", payer: payer.classicAddress }))
        .toMatchObject({ state: "released", rail: "ap4m", releaseReason: "validated_terminal" });
    } finally {
      db.close();
    }
  });

  it("keeps the checked-in combined launcher fail-closed with no implicit AP4M effects", () => {
    const vars = JSON.parse(readFileSync(
      new URL("../wrangler.local-ap4m-x402-combined-v1.jsonc", import.meta.url),
      "utf8",
    )).vars as Record<string, string>;
    const fakeAdapter = vi.fn(() => ({ signPayment: vi.fn(), exchangeMerchant: vi.fn(), reconcile: vi.fn() }));

    expect(vars).toMatchObject({
      AP4M_PURCHASE_MODE: "mock",
      HARBOR_MOCK: "1",
      MAINNET_EXECUTION: "false",
    });
    const services = createAp4mRuntimeServices(vars, { live: fakeAdapter });
    expect(fakeAdapter).not.toHaveBeenCalled();
    expect(services).toEqual({
      expectedSourceTag: 2_610_240,
      getMerchant: expect.any(Function),
    });
    expect(services).not.toHaveProperty("signPayment");
    expect(services).not.toHaveProperty("exchangeMerchant");
    expect(services).not.toHaveProperty("reconcile");
  });
});
