import { isValidClassicAddress } from "xrpl";

import type { X402IssuedAsset } from "./x402-issued-offline";

const CURRENCY = /^[0-9A-F]{40}$/;
const DECIMAL = /^(?:0\.[0-9]*[1-9]|[1-9][0-9]*(?:\.[0-9]*[1-9])?)$/;
const DROPS = /^(?:0|[1-9][0-9]*)$/;
const HASH = /^[A-F0-9]{64}$/;
const UINT32_MAX = 0xffff_ffff;
const MAX_SIGNIFICANT_DIGITS = 15;
const MAX_DECIMAL_PLACES = 81;
const MAX_SEARCH_LEDGERS = 1_000;
const FIXTURE_NOTICE =
  "OFFLINE FIXTURE ONLY. This is not live XRPL validated-ledger evidence.";

export type X402IssuedLedgerProvenance =
  | Readonly<{
      kind: "fixture";
      evidenceSource: "deterministic-offline-ledger-fixture";
      sourceId: string;
      notice: typeof FIXTURE_NOTICE;
    }>
  | Readonly<{
      kind: "live";
      evidenceSource: "validated-ledger";
      sourceId: string;
    }>;

export type X402IssuedTransactionQuery = Readonly<{
  network: "xrpl:1";
  transactionHash: string;
  minLedger?: number;
  maxLedger?: number;
}>;

export type X402IssuedTransactionObservation = Readonly<{
  network: "xrpl:1";
  provenance: X402IssuedLedgerProvenance;
  query: X402IssuedTransactionQuery;
  result: unknown;
}>;

export type X402IssuedValidatedHeadObservation = Readonly<{
  network: "xrpl:1";
  provenance: X402IssuedLedgerProvenance;
  validated: true;
  ledgerIndex: number;
}>;

export interface X402IssuedLedgerReader {
  lookupTransaction(
    query: X402IssuedTransactionQuery,
  ): Promise<X402IssuedTransactionObservation>;
  validatedLedgerHead(
    network: "xrpl:1",
  ): Promise<X402IssuedValidatedHeadObservation>;
}

export type X402IssuedReconciliationExpectation = Readonly<{
  network: "xrpl:1";
  transactionHash: string;
  payer: string;
  payTo: string;
  asset: X402IssuedAsset;
  amount: string;
  feeDrops: string;
  sequence: number;
  sourceTag: number;
  merchantInvoiceId: string;
  approvalDigest: string;
  firstLedgerSequence: number;
  lastLedgerSequence: number;
}>;

type ReconciliationEvidence = Readonly<{
  provenance: X402IssuedLedgerProvenance;
  transactionHash: string;
  network: "xrpl:1";
  merchantInvoiceId: string;
}>;

export type X402IssuedReconciliationResult =
  | Readonly<{
      status: "pending";
      budgetDisposition: "hold";
      reason:
        | "transaction-not-yet-validated"
        | "expiry-ledger-not-yet-closed"
        | "bounded-search-incomplete";
      evidence: ReconciliationEvidence;
    }>
  | Readonly<{
      status: "validated";
      budgetDisposition: "commit";
      evidence: ReconciliationEvidence & Readonly<{
        ledgerIndex: number;
        transactionResult: "tesSUCCESS";
        deliveredAmount: Readonly<{
          currency: string;
          issuer: string;
          value: string;
        }>;
      }>;
    }>
  | Readonly<{
      status: "not_included";
      budgetDisposition: "release";
      evidence: ReconciliationEvidence & Readonly<{
        validatedLedgerIndex: number;
        searchedAll: true;
        searchWindow: Readonly<{
          minLedger: number;
          maxLedger: number;
        }>;
      }>;
    }>;

export class X402IssuedReconciliationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "X402IssuedReconciliationError";
  }
}

function reject(code: string): never {
  throw new X402IssuedReconciliationError(code);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function positiveUint32(value: unknown, code: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > UINT32_MAX
  ) reject(code);
  return value;
}

function uint32(value: unknown, code: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > UINT32_MAX
  ) reject(code);
  return value;
}

function canonicalDrops(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    value.length > 18 ||
    !DROPS.test(value) ||
    BigInt(value) === 0n ||
    BigInt(value) > 9_223_372_036_854_775_807n
  ) reject(code);
  return value;
}

function canonicalIssuedDecimal(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length > 128 || !DECIMAL.test(value)) {
    reject(code);
  }
  const [whole, fraction = ""] = value.split(".");
  const significantDigits = `${whole}${fraction}`.replace(/^0+/, "").length;
  if (
    significantDigits === 0 ||
    significantDigits > MAX_SIGNIFICANT_DIGITS ||
    whole.length > MAX_DECIMAL_PLACES ||
    fraction.length > MAX_DECIMAL_PLACES
  ) reject(code);
  return value;
}

function validateProvenance(value: unknown): X402IssuedLedgerProvenance {
  if (!record(value)) reject("LEDGER_PROVENANCE_INVALID");
  if (
    value.kind === "fixture" &&
    exactKeys(value, ["kind", "evidenceSource", "sourceId", "notice"]) &&
    value.evidenceSource === "deterministic-offline-ledger-fixture" &&
    typeof value.sourceId === "string" &&
    /^[A-Za-z0-9._:-]{1,200}$/.test(value.sourceId) &&
    value.notice === FIXTURE_NOTICE
  ) return value as X402IssuedLedgerProvenance;
  if (
    value.kind === "live" &&
    exactKeys(value, ["kind", "evidenceSource", "sourceId"]) &&
    value.evidenceSource === "validated-ledger" &&
    typeof value.sourceId === "string" &&
    /^[A-Za-z0-9._:/-]{1,500}$/.test(value.sourceId)
  ) return value as X402IssuedLedgerProvenance;
  reject("LEDGER_PROVENANCE_INVALID");
}

function sameProvenance(
  left: X402IssuedLedgerProvenance,
  right: X402IssuedLedgerProvenance,
): boolean {
  return left.kind === right.kind &&
    left.evidenceSource === right.evidenceSource &&
    left.sourceId === right.sourceId &&
    (left.kind !== "fixture" ||
      (right.kind === "fixture" && left.notice === right.notice));
}

function validateExpectation(
  value: X402IssuedReconciliationExpectation,
): X402IssuedReconciliationExpectation {
  if (
    !record(value) ||
    !exactKeys(value, [
      "network", "transactionHash", "payer", "payTo", "asset", "amount",
      "feeDrops", "sequence", "sourceTag", "merchantInvoiceId", "approvalDigest",
      "firstLedgerSequence", "lastLedgerSequence",
    ]) ||
    value.network !== "xrpl:1" ||
    !HASH.test(value.transactionHash) ||
    !HASH.test(value.approvalDigest) ||
    typeof value.merchantInvoiceId !== "string" ||
    value.merchantInvoiceId.trim().length === 0 ||
    new TextEncoder().encode(value.merchantInvoiceId).length > 200 ||
    !isValidClassicAddress(value.payer) ||
    !isValidClassicAddress(value.payTo) ||
    value.payer === value.payTo ||
    !record(value.asset) ||
    !exactKeys(value.asset, ["kind", "network", "currency", "issuer"]) ||
    value.asset.kind !== "xrpl-issued" ||
    value.asset.network !== "xrpl:1" ||
    !CURRENCY.test(value.asset.currency) ||
    !isValidClassicAddress(value.asset.issuer) ||
    value.asset.issuer === value.payer ||
    value.asset.issuer === value.payTo
  ) reject("RECONCILIATION_EXPECTATION_INVALID");
  canonicalIssuedDecimal(value.amount, "RECONCILIATION_EXPECTATION_INVALID");
  canonicalDrops(value.feeDrops, "RECONCILIATION_EXPECTATION_INVALID");
  positiveUint32(value.sequence, "RECONCILIATION_EXPECTATION_INVALID");
  uint32(value.sourceTag, "RECONCILIATION_EXPECTATION_INVALID");
  const first = positiveUint32(
    value.firstLedgerSequence,
    "RECONCILIATION_EXPECTATION_INVALID",
  );
  const last = positiveUint32(
    value.lastLedgerSequence,
    "RECONCILIATION_EXPECTATION_INVALID",
  );
  if (last < first || last - first + 1 > MAX_SEARCH_LEDGERS) {
    reject("RECONCILIATION_SEARCH_WINDOW_INVALID");
  }
  return value;
}

function queryEqual(
  actual: X402IssuedTransactionQuery,
  expected: X402IssuedTransactionQuery,
): boolean {
  return actual.network === expected.network &&
    actual.transactionHash === expected.transactionHash &&
    actual.minLedger === expected.minLedger &&
    actual.maxLedger === expected.maxLedger &&
    exactKeys(actual as unknown as Record<string, unknown>, [
      "network", "transactionHash",
      ...(expected.minLedger === undefined ? [] : ["minLedger", "maxLedger"]),
    ]);
}

function validateTransactionObservation(
  value: X402IssuedTransactionObservation,
  expectedQuery: X402IssuedTransactionQuery,
  expectedProvenance?: X402IssuedLedgerProvenance,
): X402IssuedLedgerProvenance {
  if (
    !record(value) ||
    !exactKeys(value, ["network", "provenance", "query", "result"]) ||
    value.network !== "xrpl:1" ||
    !record(value.query) ||
    !queryEqual(value.query as X402IssuedTransactionQuery, expectedQuery)
  ) reject("LEDGER_LOOKUP_BINDING_MISMATCH");
  const provenance = validateProvenance(value.provenance);
  if (expectedProvenance !== undefined && !sameProvenance(provenance, expectedProvenance)) {
    reject("LEDGER_PROVENANCE_CHANGED");
  }
  return provenance;
}

function notFound(result: Record<string, unknown>): boolean {
  return result.error === "txnNotFound" || result.error === "transactionNotFound";
}

function validateNotFoundResult(result: Record<string, unknown>): void {
  if (
    ["validated", "hash", "ledger_index", "meta", "tx_json"].some(
      (field) => Object.prototype.hasOwnProperty.call(result, field),
    ) ||
    (Object.prototype.hasOwnProperty.call(result, "searched_all") &&
      typeof result.searched_all !== "boolean")
  ) reject("LEDGER_NOT_FOUND_RESULT_CONTRADICTORY");
}

function exactIssuedAmount(
  value: unknown,
  expectation: X402IssuedReconciliationExpectation,
  code: string,
): Readonly<{ currency: string; issuer: string; value: string }> {
  if (
    !record(value) ||
    !exactKeys(value, ["currency", "issuer", "value"]) ||
    value.currency !== expectation.asset.currency ||
    value.issuer !== expectation.asset.issuer ||
    value.value !== expectation.amount
  ) reject(code);
  canonicalIssuedDecimal(value.value, code);
  return value as { currency: string; issuer: string; value: string };
}

function validateLedgerPayment(
  rawResult: unknown,
  expectation: X402IssuedReconciliationExpectation,
  provenance: X402IssuedLedgerProvenance,
): Extract<X402IssuedReconciliationResult, { status: "validated" }> {
  if (!record(rawResult) || rawResult.validated !== true) {
    reject("VALIDATED_LEDGER_RESULT_INVALID");
  }
  if (rawResult.hash !== expectation.transactionHash) {
    reject("LEDGER_TRANSACTION_HASH_MISMATCH");
  }
  const ledgerIndex = positiveUint32(rawResult.ledger_index, "LEDGER_INDEX_MISMATCH");
  if (
    ledgerIndex < expectation.firstLedgerSequence ||
    ledgerIndex > expectation.lastLedgerSequence
  ) reject("LEDGER_INDEX_MISMATCH");
  if (!record(rawResult.meta) || !record(rawResult.tx_json)) {
    reject("VALIDATED_LEDGER_RESULT_INVALID");
  }
  if (rawResult.meta.TransactionResult !== "tesSUCCESS") {
    reject("LEDGER_TRANSACTION_NOT_SUCCESSFUL");
  }
  if (!Object.prototype.hasOwnProperty.call(rawResult.meta, "delivered_amount")) {
    reject("LEDGER_DELIVERED_AMOUNT_MISSING");
  }
  const deliveredAmount = exactIssuedAmount(
    rawResult.meta.delivered_amount,
    expectation,
    "LEDGER_DELIVERED_AMOUNT_MISMATCH",
  );
  const transaction = rawResult.tx_json;
  if (transaction.hash !== undefined && transaction.hash !== expectation.transactionHash) {
    reject("LEDGER_TRANSACTION_HASH_MISMATCH");
  }
  if (
    transaction.TransactionType !== "Payment" ||
    transaction.Account !== expectation.payer ||
    transaction.Destination !== expectation.payTo
  ) reject("LEDGER_PAYMENT_PARTY_MISMATCH");
  const hasAmount = Object.prototype.hasOwnProperty.call(transaction, "Amount");
  const hasDeliverMax = Object.prototype.hasOwnProperty.call(transaction, "DeliverMax");
  if (hasAmount === hasDeliverMax) reject("LEDGER_PAYMENT_AMOUNT_AMBIGUOUS");
  exactIssuedAmount(
    hasAmount ? transaction.Amount : transaction.DeliverMax,
    expectation,
    "LEDGER_PAYMENT_AMOUNT_MISMATCH",
  );
  exactIssuedAmount(
    transaction.SendMax,
    expectation,
    "LEDGER_SEND_MAX_MISMATCH",
  );
  if (
    transaction.InvoiceID !== expectation.approvalDigest ||
    transaction.SourceTag !== expectation.sourceTag ||
    transaction.Sequence !== expectation.sequence ||
    transaction.LastLedgerSequence !== expectation.lastLedgerSequence ||
    transaction.Fee !== expectation.feeDrops
  ) reject("LEDGER_PAYMENT_BINDING_MISMATCH");
  const forbidden = [
    "Flags", "Paths", "DeliverMin", "DestinationTag", "Delegate", "Memos",
    "NetworkID", "TicketSequence", "Signers",
  ];
  if (forbidden.some((field) => Object.prototype.hasOwnProperty.call(transaction, field))) {
    reject("LEDGER_PAYMENT_UNSUPPORTED_FIELD");
  }
  return {
    status: "validated",
    budgetDisposition: "commit",
    evidence: {
      provenance,
      transactionHash: expectation.transactionHash,
      network: "xrpl:1",
      merchantInvoiceId: expectation.merchantInvoiceId,
      ledgerIndex,
      transactionResult: "tesSUCCESS",
      deliveredAmount,
    },
  };
}

function pending(
  expectation: X402IssuedReconciliationExpectation,
  provenance: X402IssuedLedgerProvenance,
  reason: Extract<X402IssuedReconciliationResult, { status: "pending" }>["reason"],
): Extract<X402IssuedReconciliationResult, { status: "pending" }> {
  return {
    status: "pending",
    budgetDisposition: "hold",
    reason,
    evidence: {
      provenance,
      transactionHash: expectation.transactionHash,
      network: "xrpl:1",
      merchantInvoiceId: expectation.merchantInvoiceId,
    },
  };
}

export function createIssuedX402LedgerReconciler(deps: Readonly<{
  reader: X402IssuedLedgerReader;
}>): Readonly<{
  reconcile(
    expectation: X402IssuedReconciliationExpectation,
  ): Promise<X402IssuedReconciliationResult>;
}> {
  return Object.freeze({
    async reconcile(rawExpectation) {
      const expectation = validateExpectation(rawExpectation);
      const initialQuery: X402IssuedTransactionQuery = {
        network: "xrpl:1",
        transactionHash: expectation.transactionHash,
      };
      const initial = await deps.reader.lookupTransaction(initialQuery);
      const provenance = validateTransactionObservation(initial, initialQuery);
      if (!record(initial.result)) reject("LEDGER_LOOKUP_RESULT_INVALID");
      if (!notFound(initial.result)) {
        if (initial.result.error !== undefined) reject("LEDGER_LOOKUP_REJECTED");
        if (initial.result.validated !== true) {
          return pending(expectation, provenance, "transaction-not-yet-validated");
        }
        return validateLedgerPayment(initial.result, expectation, provenance);
      }
      validateNotFoundResult(initial.result);

      const head = await deps.reader.validatedLedgerHead("xrpl:1");
      if (
        !record(head) ||
        !exactKeys(head, ["network", "provenance", "validated", "ledgerIndex"]) ||
        head.network !== "xrpl:1" ||
        head.validated !== true ||
        !sameProvenance(validateProvenance(head.provenance), provenance)
      ) reject("VALIDATED_LEDGER_HEAD_INVALID");
      const headIndex = positiveUint32(
        head.ledgerIndex,
        "VALIDATED_LEDGER_HEAD_INVALID",
      );
      if (headIndex <= expectation.lastLedgerSequence) {
        return pending(expectation, provenance, "expiry-ledger-not-yet-closed");
      }

      const boundedQuery: X402IssuedTransactionQuery = {
        network: "xrpl:1",
        transactionHash: expectation.transactionHash,
        minLedger: expectation.firstLedgerSequence,
        maxLedger: expectation.lastLedgerSequence,
      };
      const bounded = await deps.reader.lookupTransaction(boundedQuery);
      validateTransactionObservation(bounded, boundedQuery, provenance);
      if (!record(bounded.result)) reject("LEDGER_LOOKUP_RESULT_INVALID");
      if (notFound(bounded.result)) {
        validateNotFoundResult(bounded.result);
        if (bounded.result.searched_all !== true) {
          return pending(expectation, provenance, "bounded-search-incomplete");
        }
        return {
          status: "not_included",
          budgetDisposition: "release",
          evidence: {
            provenance,
            transactionHash: expectation.transactionHash,
            network: "xrpl:1",
            merchantInvoiceId: expectation.merchantInvoiceId,
            validatedLedgerIndex: headIndex,
            searchedAll: true,
            searchWindow: {
              minLedger: expectation.firstLedgerSequence,
              maxLedger: expectation.lastLedgerSequence,
            },
          },
        };
      }
      if (bounded.result.error !== undefined) reject("LEDGER_LOOKUP_REJECTED");
      if (bounded.result.validated !== true) {
        return pending(expectation, provenance, "transaction-not-yet-validated");
      }
      return validateLedgerPayment(bounded.result, expectation, provenance);
    },
  });
}

type DeterministicFixture = Readonly<{
  fixtureKind: "deterministic-offline-xrpl-issued-reconciliation";
  notice: typeof FIXTURE_NOTICE;
  fixtureId: string;
  network: "xrpl:1";
  transactionHash: string;
  unboundedResult: unknown;
  validatedLedgerHead: number;
  boundedSearches: readonly Readonly<{
    minLedger: number;
    maxLedger: number;
    result: unknown;
  }>[];
}>;

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createDeterministicIssuedLedgerFixtureReader(
  rawFixture: unknown,
): X402IssuedLedgerReader {
  if (
    !record(rawFixture) ||
    !exactKeys(rawFixture, [
      "fixtureKind", "notice", "fixtureId", "network", "transactionHash",
      "unboundedResult", "validatedLedgerHead", "boundedSearches",
    ]) ||
    rawFixture.fixtureKind !== "deterministic-offline-xrpl-issued-reconciliation" ||
    rawFixture.notice !== FIXTURE_NOTICE ||
    typeof rawFixture.fixtureId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,200}$/.test(rawFixture.fixtureId) ||
    rawFixture.network !== "xrpl:1" ||
    typeof rawFixture.transactionHash !== "string" ||
    !HASH.test(rawFixture.transactionHash) ||
    !Array.isArray(rawFixture.boundedSearches)
  ) reject("LEDGER_FIXTURE_INVALID");
  const fixture = rawFixture as DeterministicFixture;
  positiveUint32(fixture.validatedLedgerHead, "LEDGER_FIXTURE_INVALID");
  for (const search of fixture.boundedSearches) {
    if (
      !record(search) ||
      !exactKeys(search, ["minLedger", "maxLedger", "result"]) ||
      positiveUint32(search.minLedger, "LEDGER_FIXTURE_INVALID") >
        positiveUint32(search.maxLedger, "LEDGER_FIXTURE_INVALID") ||
      search.maxLedger - search.minLedger + 1 > MAX_SEARCH_LEDGERS
    ) reject("LEDGER_FIXTURE_INVALID");
  }
  const provenance: X402IssuedLedgerProvenance = Object.freeze({
    kind: "fixture",
    evidenceSource: "deterministic-offline-ledger-fixture",
    sourceId: fixture.fixtureId,
    notice: FIXTURE_NOTICE,
  });
  const reader: X402IssuedLedgerReader = {
    async lookupTransaction(query: X402IssuedTransactionQuery) {
      if (
        query.network !== fixture.network ||
        query.transactionHash !== fixture.transactionHash ||
        (query.minLedger === undefined) !== (query.maxLedger === undefined)
      ) reject("LEDGER_FIXTURE_QUERY_MISMATCH");
      let result: unknown;
      if (query.minLedger === undefined) {
        result = fixture.unboundedResult;
      } else {
        const match = fixture.boundedSearches.filter(
          (search) => search.minLedger === query.minLedger &&
            search.maxLedger === query.maxLedger,
        );
        if (match.length !== 1) reject("LEDGER_FIXTURE_QUERY_MISMATCH");
        result = match[0].result;
      }
      return {
        network: "xrpl:1",
        provenance,
        query: jsonClone(query),
        result: jsonClone(result),
      };
    },
    async validatedLedgerHead(network: "xrpl:1") {
      if (network !== fixture.network) reject("LEDGER_FIXTURE_QUERY_MISMATCH");
      return {
        network: "xrpl:1",
        provenance,
        validated: true,
        ledgerIndex: fixture.validatedLedgerHead,
      };
    },
  };
  return Object.freeze(reader);
}
