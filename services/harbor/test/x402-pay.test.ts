import { describe, expect, it, vi } from "vitest";

import type { XrplRpc } from "../src/adapters/xrpl-rpc";
import { LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO } from "../src/local-x402-isolated-v1";
import {
  X402_COMPARE_URL,
  X402_CLAIM_RECOVERY_MS,
  X402_DAILY_CAP_DROPS,
  X402_MAX_FEE_DROPS,
  X402_PER_CALL_CAP_DROPS,
  X402PaymentError,
  createX402PaymentEngine,
  type ExecuteX402PaymentInput,
  type X402PayerLock,
  type X402PaymentDependencies,
  type X402PaymentStore,
} from "../src/exec/x402-pay";
import type {
  ClaimX402Input,
  JsonObject,
  ReserveX402Input,
  X402PaymentRow,
} from "../src/exec/x402-store";
import type {
  PayerSequenceLeaseAuthority,
  PayerSequenceLeaseRow,
} from "../src/exec/payer-sequence-lease";

const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const PAYER = "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn";
const PAY_TO = LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO;
const UNAPPROVED_PAY_TO = "rDNPy1xcB9PJoNZyG1u36Whd1rboH6Go9D";
const HASH = "A".repeat(64);
const SOURCE_TAG = 2_610_240;
const NOW = "2026-10-19T10:00:00.000Z";

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

function challenge(amount = "5000", payTo = PAY_TO): string {
  return encode({
    x402Version: 2,
    resource: { url: X402_COMPARE_URL },
    accepts: [
      {
        scheme: "exact",
        network: "xrpl:1",
        asset: "XRP",
        payTo,
        amount,
        maxTimeoutSeconds: 60,
        extra: {
          invoiceId: "invoice-1",
          sourceTag: SOURCE_TAG,
          destinationTag: 7,
        },
      },
    ],
  });
}

function emptyRow(input: ClaimX402Input): X402PaymentRow {
  return {
    id: input.id,
    principal: "principal-a",
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: input.requestFingerprint,
    owner: input.owner,
    network: input.network,
    delegate: input.delegate,
    url: input.url,
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

class MemoryStore implements X402PaymentStore {
  row: X402PaymentRow | null = null;
  reserveInput: ReserveX402Input | null = null;
  readonly transitions: string[] = [];
  failUnknownOnce = false;
  failSignedOnce = false;
  failClaimOnce = false;
  failSigningStartOnce = false;
  rejectDeliveryCacheOnce = false;
  signingStartMutation: ((row: X402PaymentRow) => X402PaymentRow) | null = null;

  async getByIdempotencyKey(): Promise<X402PaymentRow | null> {
    return this.row;
  }

  async claim(input: ClaimX402Input) {
    if (this.row === null) {
      this.row = emptyRow(input);
      if (this.failClaimOnce) {
        this.failClaimOnce = false;
        throw new Error("simulated crash after claim persistence");
      }
      return { outcome: "claimed" as const, row: this.row };
    }
    const matches =
      this.row.idempotencyKey === input.idempotencyKey &&
      this.row.requestFingerprint === input.requestFingerprint &&
      this.row.owner === input.owner &&
      this.row.delegate === input.delegate &&
      this.row.url === input.url;
    return {
      outcome: matches ? ("replay" as const) : ("mismatch" as const),
      row: this.row,
    };
  }

  async acquireClaimRecovery(
    _key: string,
    expectedLeaseAcquiredAt: string,
    staleBefore: string,
    acquiredAt: string,
  ) {
    if (
      this.row?.status !== "claimed" ||
      this.row.leaseAcquiredAt !== expectedLeaseAcquiredAt ||
      expectedLeaseAcquiredAt > staleBefore
    ) {
      return { outcome: "invalid-state" as const, row: this.row! };
    }
    this.transitions.push("claim_recovered");
    this.row = {
      ...this.row,
      leaseAcquiredAt: acquiredAt,
      updatedAt: acquiredAt,
    };
    return { outcome: "transitioned" as const, row: this.row };
  }

  async reserve(input: ReserveX402Input) {
    if (
      this.row === null ||
      this.row.status !== "claimed" ||
      this.row.leaseAcquiredAt !== input.leaseAcquiredAt
    ) {
      return { outcome: "invalid-state" as const, row: this.row! };
    }
    this.reserveInput = input;
    if (BigInt(input.amountDrops) > BigInt(input.callerMaxDrops)) {
      return { outcome: "caller-max" as const, row: this.row };
    }
    if (BigInt(input.amountDrops) > BigInt(input.policyPerCallCapDrops)) {
      return { outcome: "policy-per-call-cap" as const, row: this.row };
    }
    if (
      BigInt(input.amountDrops) + BigInt(input.feeCapDrops) >
      BigInt(input.dailyCapDrops)
    ) {
      return { outcome: "daily-cap" as const, row: this.row };
    }
    this.transitions.push("reserved");
    this.row = {
      ...this.row,
      status: "prepared",
      amountDrops: input.amountDrops,
      feeCapDrops: input.feeCapDrops,
      reservedTotalDrops: (
        BigInt(input.amountDrops) + BigInt(input.feeCapDrops)
      ).toString(),
      callerMaxDrops: input.callerMaxDrops,
      policyPerCallCapDrops: input.policyPerCallCapDrops,
      dailyCapDrops: input.dailyCapDrops,
      payTo: input.payTo,
      invoiceId: input.invoiceId,
      requirements: input.requirements,
      transaction: input.transaction,
      lastLedgerSeq: input.lastLedgerSeq,
      expiresAt: input.expiresAt,
      reservedAt: input.reservedAt,
      updatedAt: input.reservedAt,
    };
    return { outcome: "reserved" as const, row: this.row };
  }

  async markSigned(
    _key: string,
    value: { hash: string; signedBlob: string; signedAt: string },
  ) {
		if (this.failSignedOnce) {
			this.failSignedOnce = false;
			throw new Error("simulated crash after signing");
		}
    this.transitions.push("signed");
    this.row = {
      ...this.row!,
      status: "signed",
      hash: value.hash,
      signedBlob: value.signedBlob,
      signedAt: value.signedAt,
      updatedAt: value.signedAt,
    };
    return { outcome: "transitioned" as const, row: this.row };
  }

	async markSigningStarted(_key: string, at: string) {
		if (this.failSigningStartOnce) {
			this.failSigningStartOnce = false;
			throw new Error("simulated crash before signing start");
		}
		if (this.row?.status !== "prepared" || this.row.signingStartedAt !== null) {
			return { outcome: "invalid-state" as const, row: this.row! };
		}
		this.transitions.push("signing_started");
		const started = { ...this.row, signingStartedAt: at, updatedAt: at };
		this.row = this.signingStartMutation?.(started) ?? started;
		return { outcome: "transitioned" as const, row: this.row };
	}

  async markSigningAbandoned(_key: string, proof: JsonObject, at: string) {
    if (
      this.row?.status !== "prepared" ||
      this.row.signingStartedAt === null ||
      this.row.signedBlob !== null ||
      this.row.hash !== null
    ) {
      return { outcome: "invalid-state" as const, row: this.row! };
    }
    this.transitions.push("signing_abandoned");
    this.row = {
      ...this.row,
      status: "failed",
      failure: proof,
      budgetConsumedDrops: "0",
      budgetConsumedAt: at,
      failedAt: at,
      updatedAt: at,
    };
    return { outcome: "transitioned" as const, row: this.row };
  }

  async markSettlementUnknown(
    _key: string,
    at: string,
    pendingDelivery?: JsonObject & {
      http_status: 200;
      content_type: "application/json";
    },
  ) {
    if (pendingDelivery !== undefined && this.rejectDeliveryCacheOnce) {
      this.rejectDeliveryCacheOnce = false;
      return { outcome: "invalid-evidence" as const, row: this.row! };
    }
    if (this.failUnknownOnce) {
      this.failUnknownOnce = false;
      throw new Error("simulated crash before uncertainty persistence");
    }
    this.transitions.push("settlement_unknown");
    this.row = {
      ...this.row!,
      status: "settlement_unknown",
      delivery: pendingDelivery ?? this.row!.delivery,
      settlementUnknownAt: at,
      updatedAt: at,
    };
    return { outcome: "transitioned" as const, row: this.row };
  }

  async markSettled(_key: string, proof: JsonObject, at: string) {
    this.transitions.push("settled");
    this.row = {
      ...this.row!,
      status: "settled",
      settlement: proof,
      budgetConsumedDrops: (
        BigInt(this.row!.amountDrops!) +
        BigInt(String(this.row!.transaction!.Fee))
      ).toString(),
      budgetConsumedAt: at,
      settledAt: at,
      updatedAt: at,
    };
    return { outcome: "transitioned" as const, row: this.row };
  }

  async markValidatedFailure(_key: string, proof: JsonObject, at: string) {
    this.transitions.push("validated_failed");
    this.row = {
      ...this.row!,
      status: "failed",
      failure: proof,
      budgetConsumedDrops: String(this.row!.transaction!.Fee),
      budgetConsumedAt: at,
      failedAt: at,
      updatedAt: at,
    };
    return { outcome: "transitioned" as const, row: this.row };
  }

  async markDelivered(
    _key: string,
    delivery: JsonObject & { http_status: number },
    at: string,
  ) {
    this.transitions.push("delivered");
    this.row = {
      ...this.row!,
      status: "delivered",
      delivery,
      deliveredAt: at,
      updatedAt: at,
    };
    return { outcome: "transitioned" as const, row: this.row };
  }

  async markExpiredAbsentFailed(
    _key: string,
    proof: JsonObject,
    at: string,
  ) {
    this.transitions.push("expired");
    this.row = {
      ...this.row!,
      status: "failed",
      failure: proof,
      budgetConsumedDrops: "0",
      budgetConsumedAt: at,
      failedAt: at,
      updatedAt: at,
    };
    return { outcome: "transitioned" as const, row: this.row };
  }

  async markFailed(_key: string, failure: JsonObject, at: string) {
    this.transitions.push("failed");
    this.row = {
      ...this.row!,
      status: "failed",
      failure,
      failedAt: at,
      updatedAt: at,
    };
    return { outcome: "transitioned" as const, row: this.row };
  }

  async markClaimFailed(
    key: string,
    failure: JsonObject,
    at: string,
    leaseAcquiredAt: string,
  ) {
    if (
      this.row?.status !== "claimed" ||
      this.row.leaseAcquiredAt !== leaseAcquiredAt
    ) {
      return { outcome: "invalid-state" as const, row: this.row! };
    }
    return this.markFailed(key, failure, at);
  }
}

class Mutex implements X402PayerLock {
  private readonly tails = new Map<string, Promise<void>>();

  async withLock<T>(key: string, callback: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, previous.then(() => current));
    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }
}

class MemorySequenceAuthority {
  lease: PayerSequenceLeaseRow | null = null;
  readonly transitions: string[] = [];
  blockAcquire = false;
  failSigningStartOnce = false;
  failMarkSignedOnce = false;
  failReleaseOnce = false;
  beforeRelease?: (
    reason: "pre_sign" | "validated_terminal" | "expired_absent",
  ) => void;

  async get(): Promise<PayerSequenceLeaseRow | null> {
    return this.lease;
  }

  async acquire(
    input: Parameters<PayerSequenceLeaseAuthority["acquire"]>[0],
  ) {
    if (this.blockAcquire) {
      const lease = this.lease ?? this.newLease({
        ...input,
        rail: "ap4m",
        attemptId: "ap4m-winner",
      });
      this.lease = lease;
      return { outcome: "blocked" as const, lease };
    }
    if (this.lease === null || this.lease.state === "released") {
      this.lease = this.newLease(input);
      this.transitions.push("acquired");
      return { outcome: "acquired" as const, lease: this.lease };
    }
    if (this.lease.rail === input.rail && this.lease.attemptId === input.attemptId) {
      this.transitions.push("replayed");
      return { outcome: "replay" as const, lease: this.lease };
    }
    return { outcome: "blocked" as const, lease: this.lease };
  }

  async markSigningStarted(
    input: Parameters<PayerSequenceLeaseAuthority["markSigningStarted"]>[0],
  ) {
    if (this.failSigningStartOnce) {
      this.failSigningStartOnce = false;
      throw new Error("simulated crash before shared signing fence");
    }
    const lease = this.own(input);
    if (
      lease.state === "signing" &&
      lease.sequence === input.sequence &&
      lease.firstEligibleLedgerIndex === input.firstEligibleLedgerIndex &&
      lease.lastLedgerSequence === input.lastLedgerSequence
    ) {
      return { outcome: "replay" as const, lease };
    }
    if (lease.state !== "preparing") return { outcome: "blocked" as const, lease };
    this.lease = {
      ...lease,
      state: "signing",
      sequence: input.sequence,
      firstEligibleLedgerIndex: input.firstEligibleLedgerIndex,
      lastLedgerSequence: input.lastLedgerSequence,
      signingStartedAt: input.at,
      updatedAt: input.at,
    };
    this.transitions.push("signing");
    return { outcome: "transitioned" as const, lease: this.lease };
  }

  async markSigned(
    input: Parameters<PayerSequenceLeaseAuthority["markSigned"]>[0],
  ) {
    if (this.failMarkSignedOnce) {
      this.failMarkSignedOnce = false;
      throw new Error("simulated crash before lease hash persistence");
    }
    const lease = this.own(input);
    if ((lease.state === "signed" || lease.state === "settlement_unknown") && lease.hash === input.hash) {
      return { outcome: "replay" as const, lease };
    }
    if (lease.state !== "signing") return { outcome: "blocked" as const, lease };
    this.lease = {
      ...lease,
      state: "signed",
      hash: input.hash,
      signedAt: input.at,
      updatedAt: input.at,
    };
    this.transitions.push("signed");
    return { outcome: "transitioned" as const, lease: this.lease };
  }

  async markSettlementUnknown(
    input: Parameters<PayerSequenceLeaseAuthority["markSettlementUnknown"]>[0],
  ) {
    const lease = this.own(input);
    if (lease.state === "settlement_unknown" && lease.hash === input.hash) {
      return { outcome: "replay" as const, lease };
    }
    if (lease.state !== "signed" || lease.hash !== input.hash) {
      return { outcome: "blocked" as const, lease };
    }
    this.lease = { ...lease, state: "settlement_unknown", updatedAt: input.at };
    this.transitions.push("settlement_unknown");
    return { outcome: "transitioned" as const, lease: this.lease };
  }

  async releasePreSign(
    input: Parameters<PayerSequenceLeaseAuthority["releasePreSign"]>[0],
  ) {
    const lease = this.own(input);
    if (lease.state !== "preparing") return { outcome: "blocked" as const, lease };
    return this.release(lease, "pre_sign", input.at, null);
  }

  async releaseValidatedTerminal(
    input: Parameters<PayerSequenceLeaseAuthority["releaseValidatedTerminal"]>[0],
  ) {
    const lease = this.own(input);
    if ((lease.state !== "signed" && lease.state !== "settlement_unknown") || lease.hash !== input.hash) {
      return { outcome: "blocked" as const, lease };
    }
    return this.release(lease, "validated_terminal", input.at, input.evidence.ledgerIndex);
  }

  async releaseExpiredAbsent(
    input: Parameters<PayerSequenceLeaseAuthority["releaseExpiredAbsent"]>[0],
  ) {
    const lease = this.own(input);
    if ((lease.state !== "signed" && lease.state !== "settlement_unknown") || lease.hash !== input.hash) {
      return { outcome: "blocked" as const, lease };
    }
    return this.release(lease, "expired_absent", input.at, input.evidence.validatedLedgerIndex);
  }

  private newLease(
    input: Parameters<PayerSequenceLeaseAuthority["acquire"]>[0],
  ): PayerSequenceLeaseRow {
    return {
      network: input.network,
      payer: input.payer,
      generation: (this.lease?.generation ?? 0) + 1,
      token: input.token,
      rail: input.rail,
      attemptId: input.attemptId,
      state: "preparing",
      sequence: null,
      firstEligibleLedgerIndex: null,
      lastLedgerSequence: null,
      hash: null,
      acquiredAt: input.at,
      signingStartedAt: null,
      signedAt: null,
      updatedAt: input.at,
      releasedAt: null,
      releaseReason: null,
      resolutionLedgerIndex: null,
    };
  }

  private own(input: {
    network: string;
    payer: string;
    generation: number;
    token: string;
    rail: string;
    attemptId: string;
  }): PayerSequenceLeaseRow {
    const lease = this.lease;
    if (
      lease === null ||
      lease.network !== input.network ||
      lease.payer !== input.payer ||
      lease.generation !== input.generation ||
      lease.token !== input.token ||
      lease.rail !== input.rail ||
      lease.attemptId !== input.attemptId
    ) {
      throw new Error("sequence lease identity mismatch");
    }
    return lease;
  }

  private release(
    lease: PayerSequenceLeaseRow,
    reason: "pre_sign" | "validated_terminal" | "expired_absent",
    at: string,
    resolutionLedgerIndex: number | null,
  ) {
    this.beforeRelease?.(reason);
    if (this.failReleaseOnce) {
      this.failReleaseOnce = false;
      throw new Error("simulated crash after terminal payment persistence");
    }
    this.lease = {
      ...lease,
      state: "released",
      releasedAt: at,
      releaseReason: reason,
      resolutionLedgerIndex,
      updatedAt: at,
    };
    this.transitions.push(`released:${reason}`);
    return { outcome: "released" as const, lease: this.lease };
  }
}

const INPUT: ExecuteX402PaymentInput = {
  principal: "principal-a",
  owner: OWNER,
  network: "testnet",
  idempotencyKey: "request-1",
  maxPriceDrops: "100000",
};

const EXACT_INPUT: ExecuteX402PaymentInput = {
  ...INPUT,
  maxPriceDrops: "5000",
  exactPriceDrops: "5000",
  payTo: LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO,
};

function harness(options: {
  tx?: "valid" | "valid-v1" | "pending" | "tec" | "mismatch" | "missing" | "transport-error";
  balance?: string;
  reserveBaseXrp?: number;
  reserveIncrementXrp?: number;
  feeDrops?: string;
  policyPerCallCapDrops?: string;
  dailyCapDrops?: string;
  initialStatus?: number;
  paidStatus?: number;
  paidContentType?: string;
  paidContentLength?: string;
  paidBody?: string;
  paidError?: boolean;
  validatedLedgerIndex?: number;
  absenceHashLedger?: number;
  ledgerErrorAt?: number;
  initialGate?: Promise<void>;
  challengeAmount?: string;
  challengePayTo?: string;
  merchantPayTo?: string;
  now?: () => Date;
  sharedSequence?: boolean;
  sequence?: MemorySequenceAuthority;
} = {}) {
  const store = new MemoryStore();
  const sequence = options.sequence ?? new MemorySequenceAuthority();
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), init });
    if (!new Headers(init?.headers).has("payment-signature")) {
      await options.initialGate;
      return new Response(null, {
        status: options.initialStatus ?? 402,
        headers: {
          "payment-required": challenge(
            options.challengeAmount ?? "5000",
            options.challengePayTo ?? PAY_TO,
          ),
          // This must never substitute for independent ledger evidence.
          "payment-response": "forged",
        },
      });
    }
    if (options.paidError) throw new Error("merchant timeout");
    return new Response(
      options.paidBody ?? JSON.stringify({ comparison: ["dex", "amm"] }),
      {
        status: options.paidStatus ?? 200,
        headers: {
          "content-type": options.paidContentType ?? "application/json",
          ...(options.paidContentLength === undefined
            ? {}
            : { "content-length": options.paidContentLength }),
        },
      },
    );
  });
  let txMode = options.tx ?? "valid";
  const request = vi.fn(async (_network, command: string, params?: Record<string, unknown>) => {
    if (command === "server_info") {
      return {
        info: {
          validated_ledger: {
            seq: 1000,
            reserve_base_xrp: options.reserveBaseXrp ?? 10,
            reserve_inc_xrp: options.reserveIncrementXrp ?? 2,
          },
        },
      };
    }
    if (command === "account_info") {
      return {
        ledger_index: 1000,
        account_data: {
          Balance: options.balance ?? "20000000",
          OwnerCount: 1,
          Sequence: 22,
        },
      };
    }
    if (command === "fee") {
      return { drops: { open_ledger_fee: options.feeDrops ?? "12" } };
    }
    if (command === "tx") {
      if (txMode === "missing") throw { code: "txnNotFound", kind: "soft-empty" };
      if (txMode === "transport-error") throw new Error("timeout");
      const transaction = {
        ...store.row!.transaction!,
        Amount:
          txMode === "mismatch"
            ? String(BigInt(store.row!.amountDrops!) + 1n)
            : store.row!.amountDrops,
        SigningPubKey: "02AB",
        TxnSignature: "ABCD",
      };
      const v2Transaction = {
        ...transaction,
        DeliverMax: transaction.Amount,
        Amount: undefined,
      };
      delete v2Transaction.Amount;
      if (txMode === "pending") {
        return { validated: false, hash: HASH, tx_json: v2Transaction };
      }
      if (txMode === "valid-v1") {
        return {
          ...transaction,
          validated: true,
          hash: HASH,
          ledger_index: 1004,
          meta: { TransactionResult: "tesSUCCESS" },
          date: 1,
        };
      }
      return {
        validated: true,
        hash: HASH,
        ledger_index: 1004,
        meta: {
          TransactionResult:
            txMode === "tec" ? "tecUNFUNDED_PAYMENT" : "tesSUCCESS",
        },
        tx_json: v2Transaction,
      };
    }
    if (command === "ledger") {
      const requested = params?.ledger_index;
      if (requested === "validated") {
        const index = options.validatedLedgerIndex ?? 1000;
        return {
          validated: true,
          ledger_index: index,
          ledger: { ledger_index: String(index) },
        };
      }
      if (typeof requested === "number") {
        if (options.ledgerErrorAt === requested) throw new Error("ledger timeout");
        return {
          validated: true,
          ledger_index: requested,
          ledger: {
            ledger_index: String(requested),
            transactions:
              options.absenceHashLedger === requested ? [HASH] : [],
          },
        };
      }
    }
    throw new Error(`Unexpected command ${command}`);
  });
  const signerCalls = vi.fn();
  const signerAccessCalls = vi.fn();
  const deps: X402PaymentDependencies = {
    enabled: true,
    fetch: fetcher,
    xrpl: { request } as unknown as XrplRpc,
    lock: new Mutex(),
    sequenceLeases: options.sharedSequence
      ? (sequence as unknown as PayerSequenceLeaseAuthority)
      : undefined,
    resolvePayer: async ({ principal, owner, network }) => ({
      dedicated: true,
      merchantPayTo: options.merchantPayTo ?? PAY_TO,
      identity: {
        principal,
        owner,
        network,
        payer: PAYER,
        sourceTag: SOURCE_TAG,
      },
      store,
      policyPerCallCapDrops:
        options.policyPerCallCapDrops ?? X402_PER_CALL_CAP_DROPS,
      dailyCapDrops: options.dailyCapDrops ?? X402_DAILY_CAP_DROPS,
    }),
    withDelegateSigner: async (_identity, callback) => {
      signerAccessCalls();
      return callback({
        address: PAYER,
        publicKey: "02AB",
        sign: () => {
          signerCalls();
          return { hash: HASH, tx_blob: "ABCD" };
        },
      });
    },
    encodePaymentSignature: ({ hash, signedBlob }) =>
      encode({ hash, signedBlob }),
    now: options.now ?? (() => new Date(NOW)),
    newId: () => "payment-1",
    newLeaseToken: () => "C".repeat(64),
  };
  return {
    deps,
    store,
    fetchCalls,
    request,
    signerAccessCalls,
    signerCalls,
    sequence,
    setTxMode: (value: typeof txMode) => {
      txMode = value;
    },
  };
}

function headers(call: { init?: RequestInit }): Headers {
  return new Headers(call.init?.headers);
}

function alterTransaction(
  row: X402PaymentRow,
  patch: JsonObject,
): X402PaymentRow {
  return {
    ...row,
    transaction: { ...row.transaction!, ...patch },
  };
}

function alterRequirements(
  row: X402PaymentRow,
  patch: JsonObject,
): X402PaymentRow {
  return {
    ...row,
    requirements: { ...row.requirements!, ...patch },
  };
}

describe("x402 payment execution", () => {
  it("is disabled by default and accepts only the fixed Testnet resource", async () => {
    const { deps, fetchCalls } = harness();
    await expect(
      createX402PaymentEngine({ ...deps, enabled: undefined }).execute(INPUT),
    ).rejects.toMatchObject({ code: "X402_DISABLED" });
    await expect(
      createX402PaymentEngine(deps).execute({
        ...INPUT,
        url: "http://127.0.0.1:8000/evil" as typeof X402_COMPARE_URL,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      createX402PaymentEngine(deps).execute({
        ...INPUT,
        network: "mainnet",
      } as unknown as ExecuteX402PaymentInput),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_NETWORK" });
    await expect(
      createX402PaymentEngine(deps).execute({
        ...INPUT,
        maxPriceDrops: "9".repeat(10_000),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetchCalls).toHaveLength(0);
  });

  it.each([
    {
      name: "pay-to without exact price",
      input: {
        ...INPUT,
        maxPriceDrops: "5000",
        payTo: LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO,
      },
    },
    {
      name: "exact price without pay-to",
      input: {
        ...INPUT,
        maxPriceDrops: "5000",
        exactPriceDrops: "5000",
      },
    },
    {
      name: "substituted pay-to",
      input: {
        ...EXACT_INPUT,
        payTo: UNAPPROVED_PAY_TO,
      },
    },
  ])(
    "rejects an incomplete or altered isolated tuple ($name) before network, reserve, or signer access",
    async ({ input }) => {
      const { deps, store, fetchCalls, request, signerAccessCalls, signerCalls } =
        harness();

      await expect(
        createX402PaymentEngine(deps).execute(
          input as unknown as ExecuteX402PaymentInput,
        ),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(fetchCalls).toHaveLength(0);
      expect(request).not.toHaveBeenCalled();
      expect(store.reserveInput).toBeNull();
      expect(signerAccessCalls).not.toHaveBeenCalled();
      expect(signerCalls).not.toHaveBeenCalled();
    },
  );

  it("keeps legacy ceiling negotiation when the exact-price opt-in is omitted", async () => {
    const { deps, store, signerCalls } = harness({ challengeAmount: "4999" });

    await expect(
      createX402PaymentEngine(deps).execute({
        ...INPUT,
        maxPriceDrops: "5000",
      }),
    ).resolves.toMatchObject({ status: "delivered" });
    expect(store.row).toMatchObject({ amountDrops: "4999" });
    expect(signerCalls).toHaveBeenCalledOnce();
  });

  it("binds the isolated compare opt-in to an exact 5000-drop payment across replay", async () => {
    const { deps, store, fetchCalls, request, signerAccessCalls, signerCalls } =
      harness();
    const engine = createX402PaymentEngine(deps);

    await expect(engine.execute(EXACT_INPUT)).resolves.toMatchObject({
      status: "delivered",
      replayed: false,
    });
    await expect(engine.execute(EXACT_INPUT)).resolves.toMatchObject({
      status: "delivered",
      replayed: true,
    });
    expect(store.row).toMatchObject({
      amountDrops: "5000",
      reservedTotalDrops: "5100",
    });
    expect(fetchCalls).toHaveLength(2);
    expect(signerAccessCalls).toHaveBeenCalledOnce();
    expect(signerCalls).toHaveBeenCalledOnce();
    expect(request.mock.calls.filter((call) => call[1] === "submit")).toHaveLength(0);
  });

  it("binds an old prepared row to its legacy fingerprint so it cannot replay as isolated", async () => {
    const { deps, store, fetchCalls, request, signerAccessCalls, signerCalls } =
      harness();
    const engine = createX402PaymentEngine(deps);
    const legacyInput = { ...INPUT, maxPriceDrops: "5000" };
    store.failSigningStartOnce = true;

    await expect(engine.execute(legacyInput)).rejects.toThrow(
      "simulated crash before signing start",
    );
    expect(store.row).toMatchObject({ status: "prepared" });
    const legacyFingerprint = store.row?.requestFingerprint;
    const fetchesBeforeCrossProfileReplay = fetchCalls.length;
    const ledgerCallsBeforeCrossProfileReplay = request.mock.calls.length;

    await expect(engine.execute(EXACT_INPUT)).rejects.toMatchObject({
      code: "IDEMPOTENCY_MISMATCH",
    });
    expect(store.row).toMatchObject({
      status: "prepared",
      requestFingerprint: legacyFingerprint,
    });
    expect(fetchCalls).toHaveLength(fetchesBeforeCrossProfileReplay);
    expect(request).toHaveBeenCalledTimes(ledgerCallsBeforeCrossProfileReplay);
    expect(signerAccessCalls).not.toHaveBeenCalled();
    expect(signerCalls).not.toHaveBeenCalled();
  });

  it.each(["4999", "5001", "100000"])(
    "rejects isolated compare input max %s before network or signer access",
    async (maxPriceDrops) => {
      const { deps, fetchCalls, request, signerAccessCalls, signerCalls } = harness();

      await expect(
        createX402PaymentEngine(deps).execute({
          ...EXACT_INPUT,
          maxPriceDrops,
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(fetchCalls).toHaveLength(0);
      expect(request).not.toHaveBeenCalled();
      expect(signerAccessCalls).not.toHaveBeenCalled();
      expect(signerCalls).not.toHaveBeenCalled();
    },
  );

  it.each(["4999", "5001", "100000"])(
    "rejects isolated compare challenge amount %s before ledger, reserve, or signer access",
    async (challengeAmount) => {
      const { deps, store, fetchCalls, request, signerAccessCalls, signerCalls } =
        harness({ challengeAmount });

      await expect(
        createX402PaymentEngine(deps).execute(EXACT_INPUT),
      ).rejects.toBeInstanceOf(X402PaymentError);
      expect(fetchCalls).toHaveLength(1);
      expect(request).not.toHaveBeenCalled();
      expect(store.reserveInput).toBeNull();
      expect(store.row).toMatchObject({
        status: "failed",
        failure: { code: "pre_sign_failure" },
      });
      expect(signerAccessCalls).not.toHaveBeenCalled();
      expect(signerCalls).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "stored principal",
      mutate: (row: X402PaymentRow) => ({ ...row, principal: "principal-b" }),
    },
    {
      name: "stored owner",
      mutate: (row: X402PaymentRow) => ({ ...row, owner: PAY_TO }),
    },
    {
      name: "stored network",
      mutate: (row: X402PaymentRow) => ({
        ...row,
        network: "devnet" as const,
      }),
    },
    {
      name: "stored idempotency key",
      mutate: (row: X402PaymentRow) => ({
        ...row,
        idempotencyKey: "other-request",
      }),
    },
    {
      name: "stored amount",
      mutate: (row: X402PaymentRow) => ({ ...row, amountDrops: "4999" }),
    },
    {
      name: "challenge amount",
      mutate: (row: X402PaymentRow) =>
        alterRequirements(row, { amountDrops: "4999" }),
    },
    {
      name: "transaction amount",
      mutate: (row: X402PaymentRow) => alterTransaction(row, { Amount: "4999" }),
    },
    {
      name: "fee cap",
      mutate: (row: X402PaymentRow) => ({ ...row, feeCapDrops: "99" }),
    },
    {
      name: "transaction fee",
      mutate: (row: X402PaymentRow) => alterTransaction(row, { Fee: "101" }),
    },
    {
      name: "stored destination",
      mutate: (row: X402PaymentRow) => ({ ...row, payTo: UNAPPROVED_PAY_TO }),
    },
    {
      name: "challenge destination",
      mutate: (row: X402PaymentRow) =>
        alterRequirements(row, { payTo: UNAPPROVED_PAY_TO }),
    },
    {
      name: "transaction destination",
      mutate: (row: X402PaymentRow) =>
        alterTransaction(row, { Destination: UNAPPROVED_PAY_TO }),
    },
    {
      name: "stored payer",
      mutate: (row: X402PaymentRow) => ({ ...row, delegate: OWNER }),
    },
    {
      name: "transaction Account",
      mutate: (row: X402PaymentRow) => alterTransaction(row, { Account: OWNER }),
    },
    {
      name: "challenge SourceTag",
      mutate: (row: X402PaymentRow) =>
        alterRequirements(row, { sourceTag: SOURCE_TAG + 1 }),
    },
    {
      name: "transaction SourceTag",
      mutate: (row: X402PaymentRow) =>
        alterTransaction(row, { SourceTag: SOURCE_TAG + 1 }),
    },
    {
      name: "challenge DestinationTag",
      mutate: (row: X402PaymentRow) =>
        alterRequirements(row, { destinationTag: 8 }),
    },
    {
      name: "transaction DestinationTag",
      mutate: (row: X402PaymentRow) =>
        alterTransaction(row, { DestinationTag: 8 }),
    },
    {
      name: "stored invoice",
      mutate: (row: X402PaymentRow) => ({ ...row, invoiceId: "invoice-2" }),
    },
    {
      name: "challenge invoice",
      mutate: (row: X402PaymentRow) =>
        alterRequirements(row, { invoiceId: "invoice-2" }),
    },
    {
      name: "transaction InvoiceID",
      mutate: (row: X402PaymentRow) =>
        alterTransaction(row, { InvoiceID: "B".repeat(64) }),
    },
    {
      name: "stored resource URL",
      mutate: (row: X402PaymentRow) => ({
        ...row,
        url: "http://127.0.0.1:8000/other",
      }),
    },
    {
      name: "challenge resource URL",
      mutate: (row: X402PaymentRow) =>
        alterRequirements(row, {
          resource: {
            ...(row.requirements!.resource as JsonObject),
            url: "http://127.0.0.1:8000/other",
          },
        }),
    },
    {
      name: "unexpected challenge control",
      mutate: (row: X402PaymentRow) =>
        alterRequirements(row, { unexpected: true }),
    },
    {
      name: "unexpected transaction field",
      mutate: (row: X402PaymentRow) =>
        alterTransaction(row, { Memos: [] }),
    },
    {
      name: "invalid transaction Sequence",
      mutate: (row: X402PaymentRow) => alterTransaction(row, { Sequence: 0 }),
    },
    {
      name: "stored last-ledger sequence",
      mutate: (row: X402PaymentRow) => ({ ...row, lastLedgerSeq: 1016 }),
    },
    {
      name: "transaction LastLedgerSequence",
      mutate: (row: X402PaymentRow) =>
        alterTransaction(row, { LastLedgerSequence: 1016 }),
    },
    {
      name: "caller cap",
      mutate: (row: X402PaymentRow) => ({ ...row, callerMaxDrops: "4999" }),
    },
    {
      name: "per-call cap",
      mutate: (row: X402PaymentRow) => ({
        ...row,
        policyPerCallCapDrops: "4999",
      }),
    },
    {
      name: "daily cap",
      mutate: (row: X402PaymentRow) => ({ ...row, dailyCapDrops: "5099" }),
    },
    {
      name: "reserved total",
      mutate: (row: X402PaymentRow) => ({ ...row, reservedTotalDrops: "5099" }),
    },
    {
      name: "request fingerprint",
      mutate: (row: X402PaymentRow) => ({
        ...row,
        requestFingerprint: "B".repeat(64),
      }),
    },
    {
      name: "premature hash",
      mutate: (row: X402PaymentRow) => ({
        ...row,
        hash: "B".repeat(64),
      }),
    },
    {
      name: "premature signed blob",
      mutate: (row: X402PaymentRow) => ({ ...row, signedBlob: "ABCD" }),
    },
  ])(
    "rejects a prepared row with altered $name before signer access or submission",
    async ({ mutate }) => {
      const { deps, store, request, signerAccessCalls, signerCalls } = harness();
      store.signingStartMutation = mutate;

      await expect(
        createX402PaymentEngine(deps).execute(EXACT_INPUT),
      ).rejects.toMatchObject({ code: "STORE_TRANSITION_REJECTED" });
      expect(store.row?.status).toBe("prepared");
      expect(signerAccessCalls).not.toHaveBeenCalled();
      expect(signerCalls).not.toHaveBeenCalled();
      expect(request.mock.calls.filter((call) => call[1] === "submit")).toHaveLength(0);
    },
  );

  it("keeps owner, payer, and merchant receiver distinct through challenge, signing, and delivery", async () => {
    const { deps, store, fetchCalls, request, signerCalls } = harness();
    const result = await createX402PaymentEngine(deps).execute(INPUT);

    expect(new Set([INPUT.owner, PAYER, PAY_TO])).toHaveProperty("size", 3);
    expect(result).toMatchObject({
      status: "delivered",
      hash: HASH,
      httpStatus: 200,
      body: { comparison: ["dex", "amm"] },
      replayed: false,
    });
    expect(store.transitions).toEqual([
      "reserved",
			"signing_started",
      "signed",
      "settlement_unknown",
      "settled",
      "delivered",
    ]);
    expect(store.reserveInput).toMatchObject({
      amountDrops: "5000",
      feeCapDrops: X402_MAX_FEE_DROPS,
      callerMaxDrops: "100000",
      policyPerCallCapDrops: X402_PER_CALL_CAP_DROPS,
      dailyCapDrops: X402_DAILY_CAP_DROPS,
      lastLedgerSeq: 1015,
    });
    expect(store.row?.reservedTotalDrops).toBe("5100");
    expect(store.reserveInput?.transaction).toMatchObject({
      TransactionType: "Payment",
      Account: PAYER,
      Destination: PAY_TO,
      Amount: "5000",
      InvoiceID:
        "ED8D97C08BF3ADD20118C75A4E92EB49AF62ED9B602A6E60B3E5E87E440F5726",
      SourceTag: SOURCE_TAG,
      DestinationTag: 7,
      Fee: "12",
      Sequence: 22,
      LastLedgerSequence: 1015,
    });
    expect(signerCalls).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.filter((call) => call[1] === "submit")).toHaveLength(0);
    expect(request.mock.calls.filter((call) => call[1] === "tx")).toHaveLength(1);
    expect(request.mock.calls.find((call) => call[1] === "tx")?.[2]).toMatchObject({
      api_version: 1,
    });
    expect(fetchCalls).toHaveLength(2);
    for (const call of fetchCalls) {
      expect(call.url).toBe(X402_COMPARE_URL);
      expect(call.init?.method).toBe("GET");
      expect(call.init?.redirect).toBe("manual");
      expect(call.init).not.toHaveProperty("body");
    }
    expect([...headers(fetchCalls[0]).entries()]).toEqual([
      ["accept", "application/json"],
    ]);
    expect([...headers(fetchCalls[1]).keys()].sort()).toEqual([
      "accept",
      "payment-signature",
    ]);
  });

  it("rejects a substituted valid isolated merchant before ledger preparation or signing", async () => {
    const { deps, store, fetchCalls, request, signerAccessCalls, signerCalls } = harness({
      challengePayTo: UNAPPROVED_PAY_TO,
    });

    await expect(createX402PaymentEngine(deps).execute(EXACT_INPUT)).rejects.toMatchObject({
      code: "PAYER_BINDING_MISMATCH",
    });
    expect(fetchCalls).toHaveLength(1);
    expect(request).not.toHaveBeenCalled();
    expect(store.reserveInput).toBeNull();
    expect(store.row).toMatchObject({
      status: "failed",
      failure: { code: "pre_sign_failure" },
    });
    expect(signerAccessCalls).not.toHaveBeenCalled();
    expect(signerCalls).not.toHaveBeenCalled();
  });

  it("rejects a substituted valid configured merchant before service, ledger, reserve, or signing", async () => {
    expect(LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO).toBe(
      "rnSXTVWEhMKhECNUEENzUi9QuMFoFpKghr",
    );
    const { deps, store, fetchCalls, request, signerAccessCalls, signerCalls } =
      harness({ merchantPayTo: UNAPPROVED_PAY_TO });

    await expect(
      createX402PaymentEngine(deps).execute(EXACT_INPUT),
    ).rejects.toMatchObject({ code: "PAYER_BINDING_MISMATCH" });
    expect(fetchCalls).toHaveLength(0);
    expect(request).not.toHaveBeenCalled();
    expect(store.reserveInput).toBeNull();
    expect(signerAccessCalls).not.toHaveBeenCalled();
    expect(signerCalls).not.toHaveBeenCalled();
  });

  it("refuses a persisted prepared row whose receiver no longer matches the configured merchant", async () => {
    const { deps, store, signerCalls } = harness();
    const engine = createX402PaymentEngine(deps);
    store.failSigningStartOnce = true;

    await expect(engine.execute(INPUT)).rejects.toThrow(
      "simulated crash before signing start",
    );
    expect(store.row?.status).toBe("prepared");
    store.row = {
      ...store.row!,
      payTo: UNAPPROVED_PAY_TO,
      transaction: {
        ...store.row!.transaction!,
        Destination: UNAPPROVED_PAY_TO,
      },
    };

    await expect(engine.execute(INPUT)).rejects.toMatchObject({
      code: "PAYER_BINDING_MISMATCH",
    });
    expect(store.row).toMatchObject({
      status: "failed",
      failure: { code: "pay_to_binding_mismatch" },
    });
    expect(signerCalls).not.toHaveBeenCalled();
  });

  it("accepts finite fractional numeric reserve values from server_info", async () => {
    const { deps, signerCalls } = harness({
      reserveBaseXrp: 0.2,
      reserveIncrementXrp: 0.1,
    });
    await expect(createX402PaymentEngine(deps).execute(INPUT)).resolves.toMatchObject({
      status: "delivered",
    });
    expect(signerCalls).toHaveBeenCalledOnce();
  });

  it("accepts a valid leading-zero merchant Content-Length", async () => {
    const { deps } = harness({ paidContentLength: "00042" });
    await expect(createX402PaymentEngine(deps).execute(INPUT)).resolves.toMatchObject({
      status: "delivered",
    });
  });

  it.each(["valid", "valid-v1"] as const)(
    "accepts exact validated XRPL %s tx response evidence",
    async (tx) => {
      const { deps } = harness({ tx });
      await expect(createX402PaymentEngine(deps).execute(INPUT)).resolves.toMatchObject({
        status: "delivered",
        hash: HASH,
      });
    },
  );

  it("keeps a validated:false tx response uncertain", async () => {
    const { deps, store } = harness({ tx: "pending" });
    await expect(createX402PaymentEngine(deps).execute(INPUT)).resolves.toMatchObject({
      status: "settlement_unknown",
      hash: HASH,
    });
    expect(store.row?.status).toBe("settlement_unknown");
  });

  it("enforces lower stored policy caps", async () => {
    const perCall = harness({ policyPerCallCapDrops: "4999" });
    await expect(createX402PaymentEngine(perCall.deps).execute(INPUT)).rejects.toMatchObject({
      code: "INITIAL_RESPONSE_NOT_402",
    });
    expect(perCall.signerCalls).not.toHaveBeenCalled();

    const daily = harness({
      policyPerCallCapDrops: "5000",
      dailyCapDrops: "5000",
    });
    await expect(createX402PaymentEngine(daily.deps).execute(INPUT)).rejects.toMatchObject({
      code: "RESERVATION_REJECTED",
    });
    expect(daily.store.reserveInput).toMatchObject({
      policyPerCallCapDrops: "5000",
      dailyCapDrops: "5000",
    });
    expect(daily.signerCalls).not.toHaveBeenCalled();
  });

  it("serializes a payer and invokes the signer only once under concurrency", async () => {
    const { deps, signerCalls, request, fetchCalls } = harness();
    const engine = createX402PaymentEngine(deps);
    const [first, second] = await Promise.all([
      engine.execute(INPUT),
      engine.execute(INPUT),
    ]);
    expect([first.status, second.status]).toEqual(["delivered", "delivered"]);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(signerCalls).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.filter((call) => call[1] === "submit")).toHaveLength(0);
    expect(fetchCalls).toHaveLength(2);
  });

  it("holds the shared payer lease from preparation through validated settlement", async () => {
    const { deps, store, sequence, request } = harness({ sharedSequence: true });
    sequence.beforeRelease = (reason) => {
      expect(reason).toBe("validated_terminal");
      expect(store.row?.status).toBe("settled");
    };
    await expect(createX402PaymentEngine(deps).execute(INPUT)).resolves.toMatchObject({
      status: "delivered",
    });
    expect(sequence.transitions).toEqual([
      "acquired",
      "signing",
      "signed",
      "settlement_unknown",
      "released:validated_terminal",
    ]);
    expect(sequence.lease).toMatchObject({
      rail: "x402",
      attemptId: "payment-1",
      state: "released",
      sequence: 22,
      firstEligibleLedgerIndex: 1000,
      lastLedgerSequence: 1015,
      hash: HASH,
      releaseReason: "validated_terminal",
      resolutionLedgerIndex: 1004,
    });
    expect(
      request.mock.calls.findIndex((call) => call[1] === "account_info"),
    ).toBeGreaterThanOrEqual(0);
  });

  it("recovers when terminal payment persistence wins before lease release", async () => {
    const sequence = new MemorySequenceAuthority();
    sequence.failReleaseOnce = true;
    const { deps, store, signerCalls } = harness({
      sharedSequence: true,
      sequence,
    });
    const engine = createX402PaymentEngine(deps);

    await expect(engine.execute(INPUT)).rejects.toThrow(
      "simulated crash after terminal payment persistence",
    );
    expect(store.row).toMatchObject({ status: "settled", hash: HASH });
    expect(sequence.lease).toMatchObject({
      state: "settlement_unknown",
      hash: HASH,
      releasedAt: null,
    });

    await expect(engine.execute(INPUT)).resolves.toMatchObject({
      status: "delivered",
      hash: HASH,
    });
    expect(signerCalls).toHaveBeenCalledTimes(1);
    expect(sequence.lease).toMatchObject({
      state: "released",
      releaseReason: "validated_terminal",
    });
  });

  it("fails before account_info when AP4M owns the shared payer lease", async () => {
    const sequence = new MemorySequenceAuthority();
    sequence.blockAcquire = true;
    const { deps, store, request, signerCalls } = harness({
      sharedSequence: true,
      sequence,
    });
    await expect(createX402PaymentEngine(deps).execute(INPUT)).rejects.toMatchObject({
      code: "SIGNING_OUTCOME_UNKNOWN",
    });
    expect(request.mock.calls.some((call) => call[1] === "account_info")).toBe(false);
    expect(signerCalls).not.toHaveBeenCalled();
    expect(store.row).toMatchObject({
      status: "failed",
      failure: { code: "pre_sign_failure" },
    });
    expect(sequence.lease).toMatchObject({ rail: "ap4m", state: "preparing" });
  });

  it("releases a shared lease only for a proven pre-sign failure", async () => {
    const { deps, sequence, signerCalls } = harness({
      sharedSequence: true,
      balance: "13005011",
    });
    await expect(createX402PaymentEngine(deps).execute(INPUT)).rejects.toMatchObject({
      code: "INSUFFICIENT_SPENDABLE_BALANCE",
    });
    expect(sequence.lease).toMatchObject({
      state: "released",
      releaseReason: "pre_sign",
      signingStartedAt: null,
      hash: null,
    });
    expect(signerCalls).not.toHaveBeenCalled();
  });

  it("recovers a crash after payment hash persistence without re-signing", async () => {
    const sequence = new MemorySequenceAuthority();
    sequence.failMarkSignedOnce = true;
    const { deps, store, signerCalls } = harness({
      sharedSequence: true,
      sequence,
    });
    const engine = createX402PaymentEngine(deps);
    await expect(engine.execute(INPUT)).rejects.toThrow(
      "simulated crash before lease hash persistence",
    );
    expect(store.row).toMatchObject({ status: "signed", hash: HASH });
    expect(sequence.lease).toMatchObject({ state: "signing", hash: null });

    await expect(engine.execute(INPUT)).resolves.toMatchObject({ status: "delivered" });
    expect(signerCalls).toHaveBeenCalledTimes(1);
    expect(sequence.lease).toMatchObject({
      state: "released",
      hash: HASH,
      releaseReason: "validated_terminal",
    });
  });

  it("recovers a payment signing-marker CAS failure without fencing the shared lease", async () => {
    const { deps, store, signerCalls, sequence } = harness({
      sharedSequence: true,
    });
    store.failSigningStartOnce = true;
    const engine = createX402PaymentEngine(deps);

    await expect(engine.execute(INPUT)).rejects.toThrow(
      "simulated crash before signing start",
    );
    expect(store.row).toMatchObject({
      status: "prepared",
      signingStartedAt: null,
    });
    expect(sequence.lease).toMatchObject({
      state: "preparing",
      hash: null,
    });
    expect(signerCalls).not.toHaveBeenCalled();

    await expect(engine.execute(INPUT)).resolves.toMatchObject({
      status: "delivered",
    });
    expect(signerCalls).toHaveBeenCalledTimes(1);
    expect(sequence.lease).toMatchObject({
      state: "released",
      hash: HASH,
      releaseReason: "validated_terminal",
    });
  });

  it("releases pre-sign after a crash between the payment marker and shared fence", async () => {
    const sequence = new MemorySequenceAuthority();
    sequence.failSigningStartOnce = true;
    sequence.failReleaseOnce = true;
    const { deps, store, signerCalls } = harness({
      sharedSequence: true,
      sequence,
    });
    const engine = createX402PaymentEngine(deps);

    await expect(engine.execute(INPUT)).rejects.toThrow(
      "simulated crash before shared signing fence",
    );
    expect(store.row).toMatchObject({
      status: "prepared",
      signingStartedAt: NOW,
      signedBlob: null,
      hash: null,
    });
    expect(sequence.lease).toMatchObject({
      state: "preparing",
      hash: null,
    });
    expect(signerCalls).not.toHaveBeenCalled();

    await expect(engine.execute(INPUT)).rejects.toThrow(
      "simulated crash after terminal payment persistence",
    );
    expect(store.row).toMatchObject({
      status: "failed",
      failure: {
        code: "signing_abandoned",
        signed_blob_persisted: false,
        hash_persisted: false,
      },
    });
    expect(sequence.lease).toMatchObject({
      state: "preparing",
      releasedAt: null,
      hash: null,
    });
    expect(signerCalls).not.toHaveBeenCalled();

    await expect(engine.execute(INPUT)).rejects.toMatchObject({
      code: "TERMINAL_PAYMENT",
    });
    expect(sequence.lease).toMatchObject({
      state: "released",
      releaseReason: "pre_sign",
      hash: null,
    });
    expect(signerCalls).not.toHaveBeenCalled();
  });

  it.each([
    ["merchant unavailable", { initialStatus: 503 }],
    ["policy rejection", { policyPerCallCapDrops: "4999" }],
  ] as const)(
    "reclaims a stale pre-reserve claim after a crash and releases it on %s",
    async (_name, failureOptions) => {
      let clock = new Date(NOW).getTime();
      const { deps, store, fetchCalls, signerCalls } = harness({
        ...failureOptions,
        now: () => new Date(clock),
      });
      store.failClaimOnce = true;
      const engine = createX402PaymentEngine(deps);

      await expect(engine.execute(INPUT)).rejects.toThrow(
        "simulated crash after claim persistence",
      );
      expect(store.row?.status).toBe("claimed");
      expect(fetchCalls).toHaveLength(0);

      clock += X402_CLAIM_RECOVERY_MS + 1;
      await expect(engine.execute(INPUT)).rejects.toBeInstanceOf(X402PaymentError);
      expect(store.row).toMatchObject({
        status: "failed",
        failure: { code: "pre_sign_failure" },
      });
      expect(store.transitions).toContain("claim_recovered");
      expect(signerCalls).not.toHaveBeenCalled();

      const fetchCount = fetchCalls.length;
      await expect(engine.execute(INPUT)).rejects.toMatchObject({
        code: "TERMINAL_PAYMENT",
      });
      expect(fetchCalls).toHaveLength(fetchCount);
    },
  );

  it("does not let a fresh replaying isolate cancel the claim winner", async () => {
    let releaseInitial!: () => void;
    const initialGate = new Promise<void>((resolve) => {
      releaseInitial = resolve;
    });
    const { deps, store, fetchCalls, signerCalls } = harness({ initialGate });
    const winner = createX402PaymentEngine(deps).execute(INPUT);
    await vi.waitFor(() => expect(fetchCalls).toHaveLength(1));

    const loser = createX402PaymentEngine({ ...deps, lock: new Mutex() });
    await expect(loser.execute(INPUT)).rejects.toMatchObject({
      code: "SIGNING_OUTCOME_UNKNOWN",
    });
    expect(store.row).toMatchObject({ status: "claimed", failure: null });

    releaseInitial();
    await expect(winner).resolves.toMatchObject({ status: "delivered" });
    expect(store.row).toMatchObject({ status: "delivered", failure: null });
    expect(signerCalls).toHaveBeenCalledTimes(1);
  });

  it("keeps settlement_unknown on merchant/lookup timeout and never signs again", async () => {
    const { deps, store, signerCalls, request } = harness({
      paidError: true,
      tx: "transport-error",
    });
    const engine = createX402PaymentEngine(deps);
    await expect(engine.execute(INPUT)).resolves.toMatchObject({
      status: "settlement_unknown",
      hash: HASH,
    });
    await expect(engine.execute(INPUT)).resolves.toMatchObject({
      status: "settlement_unknown",
      hash: HASH,
    });
    expect(store.row?.status).toBe("settlement_unknown");
    expect(signerCalls).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.filter((call) => call[1] === "submit")).toHaveLength(0);
    expect(store.transitions).not.toContain("expired");
  });

  it("keeps merchant prose structurally and falls back to hash reconciliation if delivery caching is rejected", async () => {
    const merchantBody = { note: "private market", secretary: "available" };
    const { deps, store, signerCalls, setTxMode } = harness({
      paidBody: JSON.stringify(merchantBody),
      tx: "transport-error",
    });
    store.rejectDeliveryCacheOnce = true;
    const engine = createX402PaymentEngine(deps);

    await expect(engine.execute(INPUT)).resolves.toMatchObject({
      status: "settlement_unknown",
      hash: HASH,
    });
    expect(store.row).toMatchObject({
      status: "settlement_unknown",
      delivery: null,
    });

    setTxMode("valid");
    await expect(engine.execute(INPUT)).resolves.toMatchObject({
      status: "delivered",
      body: merchantBody,
    });
    expect(store.row?.delivery).toMatchObject({ body: merchantBody });
    expect(signerCalls).toHaveBeenCalledTimes(1);
  });

  it("does not release on one txnNotFound or before validated ledger advancement", async () => {
    const { deps, store, request } = harness({
      tx: "missing",
      validatedLedgerIndex: 1015,
    });
    await expect(createX402PaymentEngine(deps).execute(INPUT)).resolves.toMatchObject({
      status: "settlement_unknown",
    });
    expect(store.row?.status).toBe("settlement_unknown");
    expect(store.transitions).not.toContain("expired");
    expect(request.mock.calls.filter((call) => call[1] === "ledger")).toHaveLength(1);
  });

  it("releases only after validated advancement and a complete bounded absence scan", async () => {
    const { deps, store, request, signerCalls, fetchCalls, sequence } = harness({
      tx: "missing",
      validatedLedgerIndex: 1016,
      sharedSequence: true,
    });
    const engine = createX402PaymentEngine(deps);
    sequence.beforeRelease = (reason) => {
      expect(reason).toBe("expired_absent");
      expect(store.row?.status).toBe("failed");
    };
    await expect(engine.execute(INPUT)).rejects.toMatchObject({
      code: "TERMINAL_PAYMENT",
    });
    expect(store.row).toMatchObject({
      status: "failed",
      budgetConsumedDrops: "0",
      failure: {
        code: "expired_absent",
        transaction_found: false,
        validated_ledger_index: 1016,
        inclusion_ledgers_checked: Array.from(
          { length: 16 },
          (_, index) => 1000 + index,
        ),
        hash: HASH,
      },
    });
    expect(store.transitions).toContain("expired");
    expect(sequence.lease).toMatchObject({
      state: "released",
      releaseReason: "expired_absent",
      resolutionLedgerIndex: 1016,
    });
    // LLS 1015 and the derived 15-ledger window require exact ledgers
    // 1000..1015 after the validated-head read.
    expect(request.mock.calls.filter((call) => call[1] === "ledger")).toHaveLength(17);

    const requestsBeforeRestart = request.mock.calls.length;
    const fetchesBeforeRestart = fetchCalls.length;
    await expect(engine.execute(INPUT)).rejects.toMatchObject({
      code: "TERMINAL_PAYMENT",
    });
    expect(request.mock.calls).toHaveLength(requestsBeforeRestart);
    expect(fetchCalls).toHaveLength(fetchesBeforeRestart);
    expect(signerCalls).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "hash appears in a candidate ledger", absenceHashLedger: 1007 },
    { name: "a candidate ledger times out", ledgerErrorAt: 1007 },
  ])("keeps the reservation when $name", async (scan) => {
    const { deps, store } = harness({
      tx: "missing",
      validatedLedgerIndex: 1016,
      absenceHashLedger: scan.absenceHashLedger,
      ledgerErrorAt: scan.ledgerErrorAt,
    });
    await expect(createX402PaymentEngine(deps).execute(INPUT)).resolves.toMatchObject({
      status: "settlement_unknown",
    });
    expect(store.row?.status).toBe("settlement_unknown");
    expect(store.transitions).not.toContain("expired");
  });

  it("terminalizes exact validated tec evidence and never retries after restart", async () => {
    const { deps, store, request, signerCalls, fetchCalls } = harness({ tx: "tec" });
    const engine = createX402PaymentEngine(deps);
    await expect(engine.execute(INPUT)).rejects.toMatchObject({
      code: "TERMINAL_PAYMENT",
    });
    expect(store.row).toMatchObject({
      status: "failed",
      budgetConsumedDrops: "12",
      failure: {
        validated: true,
        hash: HASH,
        ledger_index: 1004,
        engine_result: "tecUNFUNDED_PAYMENT",
        transaction: { Fee: "12" },
      },
    });
    expect(store.transitions).toContain("validated_failed");

    const requestsBeforeRestart = request.mock.calls.length;
    const fetchesBeforeRestart = fetchCalls.length;
    await expect(engine.execute(INPUT)).rejects.toMatchObject({
      code: "TERMINAL_PAYMENT",
    });
    expect(request.mock.calls).toHaveLength(requestsBeforeRestart);
    expect(fetchCalls).toHaveLength(fetchesBeforeRestart);
    expect(signerCalls).toHaveBeenCalledTimes(1);
  });

  it("rejects mismatched ledger evidence without releasing or trusting PAYMENT-RESPONSE", async () => {
    const { deps, store, signerCalls, request, fetchCalls, setTxMode } = harness({
      tx: "mismatch",
    });
    const engine = createX402PaymentEngine(deps);
    await expect(engine.execute(INPUT)).rejects.toMatchObject({
      code: "SETTLEMENT_EVIDENCE_MISMATCH",
    });
    expect(store.row?.status).toBe("settlement_unknown");
    expect(store.transitions).not.toContain("settled");
    expect(fetchCalls).toHaveLength(2);

    setTxMode("valid");
    await expect(engine.execute(INPUT)).resolves.toMatchObject({
      status: "delivered",
    });
    expect(signerCalls).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.filter((call) => call[1] === "submit")).toHaveLength(0);
    expect(fetchCalls).toHaveLength(2);
  });

  it("fails before reservation/signing when validated spendable balance is too low", async () => {
    const { deps, store, signerCalls, request } = harness({ balance: "13005011" });
    await expect(createX402PaymentEngine(deps).execute(INPUT)).rejects.toMatchObject({
      code: "INSUFFICIENT_SPENDABLE_BALANCE",
    });
    expect(store.reserveInput).toBeNull();
    expect(store.row?.status).toBe("failed");
    expect(signerCalls).not.toHaveBeenCalled();
    expect(request.mock.calls.some((call) => call[1] === "submit")).toBe(false);
  });

  it.each(["101", "9".repeat(10_000)])(
    "rejects an over-cap or huge ledger fee %s before reserve/sign",
    async (feeDrops) => {
      const { deps, store, request, signerAccessCalls, signerCalls } = harness({
        feeDrops,
      });
      await expect(
        createX402PaymentEngine(deps).execute(EXACT_INPUT),
      ).rejects.toMatchObject({
        code: feeDrops === "101" ? "FEE_CAP_EXCEEDED" : "LEDGER_RESPONSE_INVALID",
      });
      expect(store.reserveInput).toBeNull();
      expect(store.row?.status).toBe("failed");
      expect(signerAccessCalls).not.toHaveBeenCalled();
      expect(signerCalls).not.toHaveBeenCalled();
      expect(request.mock.calls.filter((call) => call[1] === "submit")).toHaveLength(0);
    },
  );

  it("requires an initial 402 and does not follow redirects", async () => {
    const { deps, fetchCalls, signerCalls } = harness({ initialStatus: 302 });
    await expect(createX402PaymentEngine(deps).execute(INPUT)).rejects.toBeInstanceOf(
      X402PaymentError,
    );
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].init?.redirect).toBe("manual");
    expect(signerCalls).not.toHaveBeenCalled();
  });

  it("replays the same signed PAYMENT-SIGNATURE after a crash without re-signing", async () => {
    const { deps, store, signerCalls, fetchCalls } = harness({
      tx: "transport-error",
    });
    store.failUnknownOnce = true;
    const engine = createX402PaymentEngine(deps);
    await expect(engine.execute(INPUT)).rejects.toThrow(
      "simulated crash before uncertainty persistence",
    );
    expect(store.row?.status).toBe("signed");
    await expect(engine.execute(INPUT)).resolves.toMatchObject({
      status: "settlement_unknown",
      hash: HASH,
    });
    expect(signerCalls).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(3);
    expect(headers(fetchCalls[1]).get("payment-signature")).toBe(
      headers(fetchCalls[2]).get("payment-signature"),
    );
  });

	it("abandons zero-consumption but keeps the shared sequence fenced after signing became ambiguous", async () => {
		const { deps, store, signerCalls, fetchCalls, request, sequence } = harness({
			sharedSequence: true,
		});
		store.failSignedOnce = true;
		const engine = createX402PaymentEngine(deps);
		await expect(engine.execute(INPUT)).rejects.toThrow("simulated crash after signing");
		expect(store.row).toMatchObject({ status: "prepared", signingStartedAt: NOW });
		expect(signerCalls).toHaveBeenCalledTimes(1);
		const requestsBeforeRecovery = request.mock.calls.length;
		await expect(engine.execute(INPUT)).rejects.toMatchObject({
			code: "TERMINAL_PAYMENT",
		});
		expect(store.row).toMatchObject({
			status: "failed",
			budgetConsumedDrops: "0",
			failure: {
				code: "signing_abandoned",
				signed_blob_persisted: false,
				hash_persisted: false,
			},
		});
		expect(sequence.lease).toMatchObject({
			state: "signing",
			hash: null,
			releasedAt: null,
		});
		expect(signerCalls).toHaveBeenCalledTimes(1);
		expect(fetchCalls).toHaveLength(1);
		expect(request.mock.calls).toHaveLength(requestsBeforeRecovery);
	});

	it("serializes concurrent restart recovery into one signing-abandonment CAS", async () => {
		const { deps, store, signerCalls, fetchCalls, request } = harness();
		store.failSignedOnce = true;
		const engine = createX402PaymentEngine(deps);
		await expect(engine.execute(INPUT)).rejects.toThrow("simulated crash after signing");
		const requestsBeforeRecovery = request.mock.calls.length;
		const results = await Promise.allSettled([
			engine.execute(INPUT),
			engine.execute(INPUT),
		]);
		expect(results).toHaveLength(2);
		for (const result of results) {
			expect(result.status).toBe("rejected");
			if (result.status === "rejected") {
				expect(result.reason).toMatchObject({ code: "TERMINAL_PAYMENT" });
			}
		}
		expect(store.transitions.filter((value) => value === "signing_abandoned")).toHaveLength(1);
		expect(store.row).toMatchObject({ status: "failed", budgetConsumedDrops: "0" });
		expect(signerCalls).toHaveBeenCalledTimes(1);
		expect(fetchCalls).toHaveLength(1);
		expect(request.mock.calls).toHaveLength(requestsBeforeRecovery);
	});

  it.each([
    {
      name: "wrong content type",
      paidContentType: "text/html",
      paidBody: "{}",
    },
    {
      name: "oversized body",
      paidContentType: "application/json",
      paidBody: JSON.stringify({ value: "x".repeat(64 * 1024) }),
    },
  ])("does not cache a $name merchant response", async (response) => {
    const { deps, store, fetchCalls } = harness({
      tx: "transport-error",
      paidContentType: response.paidContentType,
      paidBody: response.paidBody,
    });
    await expect(createX402PaymentEngine(deps).execute(INPUT)).resolves.toMatchObject({
      status: "settlement_unknown",
    });
    expect(store.row?.delivery).toBeNull();
    expect(fetchCalls).toHaveLength(2);
  });

  it("keeps a proven paid transaction settled when merchant delivery is malformed", async () => {
    const { deps, store, signerCalls } = harness({
      tx: "valid",
      paidContentType: "text/html",
      paidBody: "not-json",
    });
    const engine = createX402PaymentEngine(deps);
    await expect(engine.execute(INPUT)).rejects.toMatchObject({
      code: "PAID_RESPONSE_REJECTED",
    });
    expect(store.row).toMatchObject({ status: "settled", delivery: null });
    await expect(engine.execute(INPUT)).rejects.toMatchObject({
      code: "PAID_RESPONSE_REJECTED",
    });
    expect(store.row?.status).toBe("settled");
    expect(signerCalls).toHaveBeenCalledTimes(1);
  });
});
