import { describe, expect, it } from "vitest";

import absentFixture from "./fixtures/x402-issued/expired-not-included.json";
import validatedFixture from "./fixtures/x402-issued/validated-payment.json";
import {
  X402IssuedReconciliationError,
  createDeterministicIssuedLedgerFixtureReader,
  createIssuedX402LedgerReconciler,
  type X402IssuedLedgerReader,
  type X402IssuedReconciliationExpectation,
  type X402IssuedTransactionObservation,
  type X402IssuedValidatedHeadObservation,
} from "../src/exec/x402-issued-reconciliation";

const CURRENCY = "524C555344000000000000000000000000000000";
const HASH = "C".repeat(64);
const APPROVAL_DIGEST = "D".repeat(64);
const PAYER = "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn";
const PAYEE = "rnSXTVWEhMKhECNUEENzUi9QuMFoFpKghr";
const ISSUER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

const expectation: X402IssuedReconciliationExpectation = {
  network: "xrpl:1",
  transactionHash: HASH,
  payer: PAYER,
  payTo: PAYEE,
  asset: {
    kind: "xrpl-issued",
    network: "xrpl:1",
    currency: CURRENCY,
    issuer: ISSUER,
  },
  amount: "0.01",
  feeDrops: "12",
  sequence: 7,
  sourceTag: 2_610_240,
  merchantInvoiceId: "merchant-issued-invoice-1",
  approvalDigest: APPROVAL_DIGEST,
  firstLedgerSequence: 1001,
  lastLedgerSequence: 1020,
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function reconcile(fixture: unknown = validatedFixture) {
  return await createIssuedX402LedgerReconciler({
    reader: createDeterministicIssuedLedgerFixtureReader(fixture),
  }).reconcile(expectation);
}

function expectCode(code: string) {
  return expect.objectContaining<X402IssuedReconciliationError>({ code });
}

describe("issued x402 deterministic validated-ledger reconciliation", () => {
  it("commits only an exactly bound tesSUCCESS issued payment", async () => {
    const result = await reconcile();

    expect(result).toEqual({
      status: "validated",
      budgetDisposition: "commit",
      evidence: {
        provenance: {
          kind: "fixture",
          evidenceSource: "deterministic-offline-ledger-fixture",
          sourceId: "x402-issued-validated-v1",
          notice: "OFFLINE FIXTURE ONLY. This is not live XRPL validated-ledger evidence.",
        },
        transactionHash: HASH,
        network: "xrpl:1",
        merchantInvoiceId: "merchant-issued-invoice-1",
        ledgerIndex: 1012,
        transactionResult: "tesSUCCESS",
        deliveredAmount: {
          currency: CURRENCY,
          issuer: ISSUER,
          value: "0.01",
        },
      },
    });
  });

  it("authorizes release only after expiry and a complete bounded absence search", async () => {
    const calls: unknown[] = [];
    const base = createDeterministicIssuedLedgerFixtureReader(absentFixture);
    const reader: X402IssuedLedgerReader = {
      async lookupTransaction(query) {
        calls.push(query);
        return await base.lookupTransaction(query);
      },
      async validatedLedgerHead(network) {
        calls.push({ validatedLedgerHead: network });
        return await base.validatedLedgerHead(network);
      },
    };

    const result = await createIssuedX402LedgerReconciler({ reader })
      .reconcile(expectation);

    expect(result).toEqual({
      status: "not_included",
      budgetDisposition: "release",
      evidence: {
        provenance: {
          kind: "fixture",
          evidenceSource: "deterministic-offline-ledger-fixture",
          sourceId: "x402-issued-expired-absent-v1",
          notice: "OFFLINE FIXTURE ONLY. This is not live XRPL validated-ledger evidence.",
        },
        transactionHash: HASH,
        network: "xrpl:1",
        merchantInvoiceId: "merchant-issued-invoice-1",
        validatedLedgerIndex: 1021,
        searchedAll: true,
        searchWindow: { minLedger: 1001, maxLedger: 1020 },
      },
    });
    expect(calls).toEqual([
      { network: "xrpl:1", transactionHash: HASH },
      { validatedLedgerHead: "xrpl:1" },
      {
        network: "xrpl:1",
        transactionHash: HASH,
        minLedger: 1001,
        maxLedger: 1020,
      },
    ]);
  });

  it("holds the reservation until a validated ledger has passed expiry", async () => {
    const fixture = clone(absentFixture);
    fixture.validatedLedgerHead = 1020;

    await expect(reconcile(fixture)).resolves.toMatchObject({
      status: "pending",
      budgetDisposition: "hold",
      reason: "expiry-ledger-not-yet-closed",
    });
  });

  it("holds the reservation when the bounded search is incomplete", async () => {
    const fixture = clone(absentFixture);
    fixture.boundedSearches[0].result.searched_all = false;

    await expect(reconcile(fixture)).resolves.toMatchObject({
      status: "pending",
      budgetDisposition: "hold",
      reason: "bounded-search-incomplete",
    });
  });

  it("recovers a validated payment found by the bounded search", async () => {
    const fixture = clone(absentFixture);
    fixture.boundedSearches[0].result = clone(validatedFixture.unboundedResult) as never;

    await expect(reconcile(fixture)).resolves.toMatchObject({
      status: "validated",
      budgetDisposition: "commit",
      evidence: { ledgerIndex: 1012 },
    });
  });

  it("holds an observed transaction until it is validated", async () => {
    const fixture = clone(validatedFixture);
    fixture.unboundedResult.validated = false;

    await expect(reconcile(fixture)).resolves.toMatchObject({
      status: "pending",
      budgetDisposition: "hold",
      reason: "transaction-not-yet-validated",
    });
  });

  it("rejects a search window larger than the XRPL tx search bound before reading", async () => {
    let calls = 0;
    const base = createDeterministicIssuedLedgerFixtureReader(absentFixture);
    const reader: X402IssuedLedgerReader = {
      async lookupTransaction(query) {
        calls += 1;
        return await base.lookupTransaction(query);
      },
      async validatedLedgerHead(network) {
        calls += 1;
        return await base.validatedLedgerHead(network);
      },
    };
    const invalid = {
      ...expectation,
      firstLedgerSequence: 1,
      lastLedgerSequence: 1001,
    };

    await expect(createIssuedX402LedgerReconciler({ reader }).reconcile(invalid))
      .rejects.toEqual(expectCode("RECONCILIATION_SEARCH_WINDOW_INVALID"));
    expect(calls).toBe(0);
  });

  it("never upgrades an offline fixture to live-ledger provenance", async () => {
    const result = await reconcile();
    expect(result.evidence.provenance.kind).toBe("fixture");
    expect(result.evidence.provenance.evidenceSource)
      .toBe("deterministic-offline-ledger-fixture");

    const fixture = clone(validatedFixture);
    fixture.notice = "validated-ledger";
    expect(() => createDeterministicIssuedLedgerFixtureReader(fixture))
      .toThrowError(expectCode("LEDGER_FIXTURE_INVALID"));
  });

  it("rejects provenance changes between lookup, head, and bounded proof", async () => {
    const base = createDeterministicIssuedLedgerFixtureReader(absentFixture);
    const reader: X402IssuedLedgerReader = {
      lookupTransaction: (query) => base.lookupTransaction(query),
      async validatedLedgerHead(network) {
        const head = await base.validatedLedgerHead(network);
        return {
          ...head,
          provenance: { ...head.provenance, sourceId: "different-fixture" },
        } as X402IssuedValidatedHeadObservation;
      },
    };

    await expect(createIssuedX402LedgerReconciler({ reader }).reconcile(expectation))
      .rejects.toEqual(expectCode("VALIDATED_LEDGER_HEAD_INVALID"));
  });

  it("rejects contradictory not-found evidence instead of releasing", async () => {
    const initialContradiction = clone(absentFixture) as unknown as {
      unboundedResult: Record<string, unknown>;
    };
    initialContradiction.unboundedResult.validated = true;

    await expect(reconcile(initialContradiction))
      .rejects.toEqual(expectCode("LEDGER_NOT_FOUND_RESULT_CONTRADICTORY"));

    const boundedContradiction = clone(absentFixture) as unknown as {
      boundedSearches: [{ result: Record<string, unknown> }];
    };
    boundedContradiction.boundedSearches[0].result.hash = HASH;

    await expect(reconcile(boundedContradiction))
      .rejects.toEqual(expectCode("LEDGER_NOT_FOUND_RESULT_CONTRADICTORY"));
  });

  it("rejects a lookup response bound to a different network", async () => {
    const base = createDeterministicIssuedLedgerFixtureReader(validatedFixture);
    const reader: X402IssuedLedgerReader = {
      async lookupTransaction(query) {
        const observation = await base.lookupTransaction(query);
        return {
          ...observation,
          network: "xrpl:2",
        } as unknown as X402IssuedTransactionObservation;
      },
      validatedLedgerHead: (network) => base.validatedLedgerHead(network),
    };

    await expect(createIssuedX402LedgerReconciler({ reader }).reconcile(expectation))
      .rejects.toEqual(expectCode("LEDGER_LOOKUP_BINDING_MISMATCH"));
  });

  it.each([
    ["transaction hash", (fixture: typeof validatedFixture) => {
      fixture.unboundedResult.hash = "E".repeat(64);
    }, "LEDGER_TRANSACTION_HASH_MISMATCH"],
    ["payer", (fixture: typeof validatedFixture) => {
      fixture.unboundedResult.tx_json.Account = PAYEE;
    }, "LEDGER_PAYMENT_PARTY_MISMATCH"],
    ["payee", (fixture: typeof validatedFixture) => {
      fixture.unboundedResult.tx_json.Destination = PAYER;
    }, "LEDGER_PAYMENT_PARTY_MISMATCH"],
    ["asset currency", (fixture: typeof validatedFixture) => {
      fixture.unboundedResult.tx_json.Amount.currency = "A".repeat(40);
    }, "LEDGER_PAYMENT_AMOUNT_MISMATCH"],
    ["asset issuer", (fixture: typeof validatedFixture) => {
      fixture.unboundedResult.tx_json.Amount.issuer = PAYEE;
    }, "LEDGER_PAYMENT_AMOUNT_MISMATCH"],
    ["asset value", (fixture: typeof validatedFixture) => {
      fixture.unboundedResult.tx_json.Amount.value = "0.02";
    }, "LEDGER_PAYMENT_AMOUNT_MISMATCH"],
    ["SendMax value", (fixture: typeof validatedFixture) => {
      fixture.unboundedResult.tx_json.SendMax.value = "0.02";
    }, "LEDGER_SEND_MAX_MISMATCH"],
    ["approval digest", (fixture: typeof validatedFixture) => {
      fixture.unboundedResult.tx_json.InvoiceID = "E".repeat(64);
    }, "LEDGER_PAYMENT_BINDING_MISMATCH"],
    ["transaction result", (fixture: typeof validatedFixture) => {
      fixture.unboundedResult.meta.TransactionResult = "tecPATH_DRY";
    }, "LEDGER_TRANSACTION_NOT_SUCCESSFUL"],
    ["delivered currency", (fixture: typeof validatedFixture) => {
      fixture.unboundedResult.meta.delivered_amount.currency = "A".repeat(40);
    }, "LEDGER_DELIVERED_AMOUNT_MISMATCH"],
    ["delivered issuer", (fixture: typeof validatedFixture) => {
      fixture.unboundedResult.meta.delivered_amount.issuer = PAYEE;
    }, "LEDGER_DELIVERED_AMOUNT_MISMATCH"],
    ["delivered value", (fixture: typeof validatedFixture) => {
      fixture.unboundedResult.meta.delivered_amount.value = "0.009";
    }, "LEDGER_DELIVERED_AMOUNT_MISMATCH"],
  ])("fails closed on %s mismatch", async (_label, mutate, code) => {
    const fixture = clone(validatedFixture);
    mutate(fixture);
    await expect(reconcile(fixture)).rejects.toEqual(expectCode(code));
  });

  it("rejects missing delivered_amount rather than trusting the requested Amount", async () => {
    const fixture = clone(validatedFixture) as unknown as {
      unboundedResult: { meta: Record<string, unknown> };
    };
    delete fixture.unboundedResult.meta.delivered_amount;

    await expect(reconcile(fixture))
      .rejects.toEqual(expectCode("LEDGER_DELIVERED_AMOUNT_MISSING"));
  });

  it("rejects partial-payment and alternate-delivery fields", async () => {
    const withFlags = clone(validatedFixture) as unknown as {
      unboundedResult: { tx_json: Record<string, unknown> };
    };
    withFlags.unboundedResult.tx_json.Flags = 0x0002_0000;
    await expect(reconcile(withFlags))
      .rejects.toEqual(expectCode("LEDGER_PAYMENT_UNSUPPORTED_FIELD"));

    const withDeliverMin = clone(validatedFixture) as unknown as {
      unboundedResult: { tx_json: Record<string, unknown> };
    };
    withDeliverMin.unboundedResult.tx_json.DeliverMin = clone(
      validatedFixture.unboundedResult.tx_json.Amount,
    );
    await expect(reconcile(withDeliverMin))
      .rejects.toEqual(expectCode("LEDGER_PAYMENT_UNSUPPORTED_FIELD"));
  });
});
