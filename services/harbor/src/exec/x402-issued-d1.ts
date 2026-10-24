import { isValidClassicAddress } from "xrpl";

import {
  X402IssuedOfflineError,
  type X402IssuedAsset,
  type X402IssuedBudgetAuthority,
  type X402IssuedBudgetReservation,
  type X402IssuedFixtureResult,
  type X402IssuedPolicy,
  type X402IssuedStateAuthority,
} from "./x402-issued-offline";

const DECIMAL = /^(?:0\.[0-9]*[1-9]|[1-9][0-9]*(?:\.[0-9]*[1-9])?)$/;
const DROPS = /^(?:0|[1-9][0-9]*)$/;
const HASH = /^[A-F0-9]{64}$/;
const HEX = /^[A-F0-9]+$/;
const CURRENCY = /^[0-9A-F]{40}$/;
const MAX_DECIMAL_PLACES = 81;
const MAX_SIGNIFICANT_DIGITS = 15;
const UINT32_MAX = 0xffff_ffff;

type StateStatus = "reserved" | "signing" | "signed" | "uncertain" | "delivered";
type RawRow = Record<string, unknown>;

export type D1IssuedX402StateRecord = Readonly<{
  scope: string;
  binding: string;
  payer: string;
  invoiceId: string;
  sequence: number;
  approvalId: string;
  approvalDigest: string;
  status: StateStatus;
  hash?: string;
  signedBlob?: string;
  result?: X402IssuedFixtureResult;
}>;

export type D1IssuedX402AuthorityOptions = Readonly<{
  enabled?: boolean;
  now?: () => Date;
  lockToken?: () => string;
  faultAfterWrite?: (point: D1IssuedX402WritePoint) => void | Promise<void>;
}>;

export type D1IssuedX402WritePoint =
  | "state_reserved"
  | "state_released_pre_sign"
  | "state_signing_started"
  | "state_signed"
  | "state_uncertain"
  | "budget_reserved"
  | "budget_released_pre_sign"
  | "budget_uncertain"
  | "budget_committed"
  | "delivered_journaled";

export type D1IssuedX402Recovery = Readonly<{
  outcome: "absent" | "released_pre_sign" | "reconciliation_required" | "delivered";
  record: D1IssuedX402StateRecord | null;
}>;

function reject(code: string): never {
  throw new X402IssuedOfflineError(code);
}

function boundedText(value: unknown, code: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    reject(code);
  }
  return value;
}

function isoTime(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    reject("ISSUED_AUTHORITY_CLOCK_INVALID");
  }
  return value.toISOString();
}

function drops(value: unknown, code: string, positive = false): bigint {
  if (typeof value !== "string" || value.length > 19 || !DROPS.test(value)) {
    reject(code);
  }
  const parsed = BigInt(value);
  if (parsed > 9_223_372_036_854_775_807n || (positive && parsed === 0n)) {
    reject(code);
  }
  return parsed;
}

function decimalAtoms(value: unknown, code = "INVALID_ISSUED_AMOUNT"): bigint {
  if (typeof value !== "string" || value.length > 128 || !DECIMAL.test(value)) {
    reject(code);
  }
  const [whole, fraction = ""] = value.split(".");
  const significant = `${whole}${fraction}`.replace(/^0+/, "").length;
  if (
    significant === 0 || significant > MAX_SIGNIFICANT_DIGITS ||
    fraction.length > MAX_DECIMAL_PLACES || whole.length > MAX_DECIMAL_PLACES
  ) reject(code);
  return BigInt(`${whole}${fraction}`) *
    10n ** BigInt(MAX_DECIMAL_PLACES - fraction.length);
}

function issuedAssetKey(asset: X402IssuedAsset): string {
  if (
    asset.kind !== "xrpl-issued" || asset.network !== "xrpl:1" ||
    !CURRENCY.test(asset.currency) || !isValidClassicAddress(asset.issuer)
  ) reject("INVALID_ISSUED_ASSET");
  return `${asset.network}:${asset.currency}:${asset.issuer}`;
}

function validatePolicy(policy: X402IssuedPolicy): void {
  const perCall = decimalAtoms(policy.maxPerCall);
  const daily = decimalAtoms(policy.dailyCap);
  const lifetime = decimalAtoms(policy.lifetimeCap);
  const feeCall = drops(policy.maxFeeDrops, "INVALID_ISSUED_POLICY", true);
  const feeDaily = drops(policy.dailyFeeCapDrops, "INVALID_ISSUED_POLICY", true);
  const feeLifetime = drops(policy.lifetimeFeeCapDrops, "INVALID_ISSUED_POLICY", true);
  issuedAssetKey(policy.asset);
  drops(policy.minimumXrpReserveDrops, "INVALID_ISSUED_POLICY");
  if (
    !isValidClassicAddress(policy.payTo) || !Number.isInteger(policy.sourceTag) ||
    policy.sourceTag < 0 || policy.sourceTag > UINT32_MAX ||
    perCall > daily || daily > lifetime ||
    feeCall > feeDaily || feeDaily > feeLifetime
  ) reject("INVALID_ISSUED_POLICY");
}

function changed(result: D1Result): boolean {
  return Number(result.meta?.changes ?? 0) === 1;
}

async function batch(db: D1Database, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  return await db.batch(statements);
}

function merchantInvoiceFromBinding(
  binding: string,
  idempotencyKey: string,
  approvalId: string,
  approvalDigest: string,
): string {
  let value: unknown;
  try {
    value = JSON.parse(binding) as unknown;
  } catch {
    reject("INVALID_ISSUED_STATE_BINDING");
  }
  if (
    !Array.isArray(value) || value.length !== 8 ||
    value[0] !== idempotencyKey || value[6] !== approvalId ||
    value[7] !== approvalDigest || typeof value[5] !== "string"
  ) reject("INVALID_ISSUED_STATE_BINDING");
  return boundedText(value[5], "INVALID_ISSUED_INVOICE", 200);
}

function parseFixtureResult(value: unknown): X402IssuedFixtureResult | undefined {
  if (value === null || value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(String(value));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      reject("ISSUED_STATE_CORRUPT");
    }
    return parsed as X402IssuedFixtureResult;
  } catch (error) {
    if (error instanceof X402IssuedOfflineError) throw error;
    reject("ISSUED_STATE_CORRUPT");
  }
}

function decodeState(row: RawRow): D1IssuedX402StateRecord {
  const status = String(row.status) as StateStatus;
  const sequence = Number(row.sequence);
  if (
    !["reserved", "signing", "signed", "uncertain", "delivered"].includes(status) ||
    !Number.isInteger(sequence) || sequence < 1 || sequence > UINT32_MAX
  ) reject("ISSUED_STATE_CORRUPT");
  const hash = row.tx_hash === null ? undefined : String(row.tx_hash);
  const signedBlob = row.signed_blob === null ? undefined : String(row.signed_blob);
  if (
    (hash !== undefined && !HASH.test(hash)) ||
    (signedBlob !== undefined &&
      (!HEX.test(signedBlob) || signedBlob.length % 2 !== 0))
  ) reject("ISSUED_STATE_CORRUPT");
  return {
    scope: String(row.scope), binding: String(row.binding), payer: String(row.payer),
    invoiceId: String(row.invoice_id), sequence,
    approvalId: String(row.approval_id), approvalDigest: String(row.approval_digest),
    status,
    ...(hash === undefined ? {} : { hash }),
    ...(signedBlob === undefined ? {} : { signedBlob }),
    ...(row.result_json === null ? {} : { result: parseFixtureResult(row.result_json)! }),
  };
}

export class D1IssuedX402State implements X402IssuedStateAuthority {
  readonly #enabled: boolean;
  readonly #now: () => Date;
  readonly #faultAfterWrite?: D1IssuedX402AuthorityOptions["faultAfterWrite"];
  readonly #tails = new Map<string, Promise<void>>();

  constructor(
    private readonly db: D1Database,
    options: D1IssuedX402AuthorityOptions = {},
  ) {
    this.#enabled = options.enabled === true;
    this.#now = options.now ?? (() => new Date());
    this.#faultAfterWrite = options.faultAfterWrite;
  }

  #requireEnabled(): void {
    if (!this.#enabled) reject("ISSUED_X402_D1_DISABLED");
  }

  async #fault(point: D1IssuedX402WritePoint): Promise<void> {
    await this.#faultAfterWrite?.(point);
  }

  async withPayerLock<T>(payer: string, callback: () => Promise<T>): Promise<T> {
    this.#requireEnabled();
    if (!isValidClassicAddress(payer)) reject("INVALID_PAYER_LOCK");
    const previous = this.#tails.get(payer) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.#tails.set(payer, tail);
    await previous.catch(() => undefined);
    try {
      return await callback();
    } finally {
      release();
      if (this.#tails.get(payer) === tail) this.#tails.delete(payer);
    }
  }

  async get(idempotencyKey: string): Promise<D1IssuedX402StateRecord | null> {
    this.#requireEnabled();
    boundedText(idempotencyKey, "INVALID_IDEMPOTENCY_KEY", 200);
    const row = await this.db.prepare(
      "SELECT * FROM issued_x402_state WHERE idempotency_key = ?",
    ).bind(idempotencyKey).first<RawRow>();
    return row === null ? null : decodeState(row);
  }

  async reserve(input: Readonly<{
    idempotencyKey: string;
    scope: string;
    binding: string;
    payer: string;
    invoiceId: string;
    sequence: number;
    approvalId: string;
    approvalDigest: string;
  }>): Promise<{ replay: boolean; record: D1IssuedX402StateRecord }> {
    this.#requireEnabled();
    boundedText(input.idempotencyKey, "INVALID_IDEMPOTENCY_KEY", 200);
    boundedText(input.scope, "INVALID_ISSUED_STATE_BINDING", 4096);
    boundedText(input.binding, "INVALID_ISSUED_STATE_BINDING", 16_384);
    boundedText(input.approvalId, "INVALID_ISSUED_APPROVAL", 256);
    const merchantInvoiceId = merchantInvoiceFromBinding(
      input.binding, input.idempotencyKey, input.approvalId, input.approvalDigest,
    );
    if (
      !isValidClassicAddress(input.payer) ||
      !Number.isInteger(input.sequence) || input.sequence < 1 ||
      input.sequence > UINT32_MAX || !HASH.test(input.approvalDigest) ||
      !HASH.test(input.invoiceId) || input.invoiceId !== input.approvalDigest
    ) reject("INVALID_ISSUED_STATE_BINDING");
    const at = isoTime(this.#now());
    let results: D1Result[];
    try {
      results = await batch(this.db, [
        this.db.prepare(`INSERT INTO issued_x402_state (
        idempotency_key, scope, binding, payer, merchant_invoice_id, invoice_id,
        sequence, approval_id, approval_digest, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING`).bind(
        input.idempotencyKey, input.scope, input.binding, input.payer,
        merchantInvoiceId, input.invoiceId, input.sequence, input.approvalId,
        input.approvalDigest, at, at,
        ),
        this.db.prepare(`INSERT INTO issued_x402_journal (
          idempotency_key, payer, merchant_invoice_id, invoice_id,
          state_status, budget_state, updated_at
        ) SELECT ?, ?, ?, ?, 'reserved', NULL, ?
          WHERE EXISTS (
            SELECT 1 FROM issued_x402_state WHERE idempotency_key = ?
          ) ON CONFLICT(idempotency_key) DO NOTHING`).bind(
          input.idempotencyKey, input.payer, merchantInvoiceId, input.invoiceId,
          at, input.idempotencyKey,
        ),
      ]);
    } catch (error) {
      if (error instanceof X402IssuedOfflineError) throw error;
      const record = await this.get(input.idempotencyKey);
      if (record !== null) {
        if (record.scope !== input.scope || record.binding !== input.binding) {
          reject("IDEMPOTENCY_BINDING_MISMATCH");
        }
        return { replay: true, record };
      }
      reject("ISSUED_INVOICE_OR_SEQUENCE_CONFLICT");
    }
    const record = await this.get(input.idempotencyKey);
    if (record === null) reject("ISSUED_INVOICE_OR_SEQUENCE_CONFLICT");
    if (record.scope !== input.scope || record.binding !== input.binding) {
      reject("IDEMPOTENCY_BINDING_MISMATCH");
    }
    const replay = !changed(results[0]!);
    // Keep injected process-exit failures outside database conflict handling:
    // the batch is durable even though the caller did not observe success.
    if (!replay) await this.#fault("state_reserved");
    return { replay, record };
  }

  async releasePreSign(idempotencyKey: string): Promise<void> {
    this.#requireEnabled();
    const results = await batch(this.db, [
      this.db.prepare(
        "DELETE FROM issued_x402_journal WHERE idempotency_key = ? AND state_status = 'reserved'",
      ).bind(idempotencyKey),
      this.db.prepare(
        "DELETE FROM issued_x402_state WHERE idempotency_key = ? AND status = 'reserved'",
      ).bind(idempotencyKey),
    ]);
    if (!changed(results[1]!)) reject("ISSUED_STATE_MISMATCH");
    await this.#fault("state_released_pre_sign");
  }

  async markSigningStarted(idempotencyKey: string): Promise<void> {
    await this.#transition(idempotencyKey, "reserved", "signing");
  }

  async markSigned(idempotencyKey: string, hash: string, signedBlob: string): Promise<void> {
    this.#requireEnabled();
    const normalizedHash = hash.toUpperCase();
    const normalizedBlob = signedBlob.toUpperCase();
    if (!HASH.test(normalizedHash) || !HEX.test(normalizedBlob) || normalizedBlob.length % 2 !== 0) {
      reject("ISSUED_STATE_MISMATCH");
    }
    const at = isoTime(this.#now());
    const results = await batch(this.db, [
      this.db.prepare(`UPDATE issued_x402_state
        SET status = 'signed', tx_hash = ?, signed_blob = ?, updated_at = ?
        WHERE idempotency_key = ? AND status = 'signing'
          AND EXISTS (SELECT 1 FROM issued_x402_journal
            WHERE idempotency_key = ? AND state_status = 'signing')`).bind(
          normalizedHash, normalizedBlob, at, idempotencyKey, idempotencyKey,
        ),
      this.db.prepare(`UPDATE issued_x402_journal
        SET state_status = 'signed', tx_hash = ?, updated_at = ?
        WHERE idempotency_key = ? AND state_status = 'signing'`).bind(
          normalizedHash, at, idempotencyKey,
        ),
    ]);
    if (!changed(results[0]!) || !changed(results[1]!)) reject("ISSUED_STATE_MISMATCH");
    await this.#fault("state_signed");
  }

  async markUncertain(idempotencyKey: string): Promise<void> {
    this.#requireEnabled();
    const at = isoTime(this.#now());
    const results = await batch(this.db, [
      this.db.prepare(`UPDATE issued_x402_state
        SET status = 'uncertain', updated_at = ?
        WHERE idempotency_key = ? AND status IN ('signing', 'signed', 'uncertain')`)
        .bind(at, idempotencyKey),
      this.db.prepare(`UPDATE issued_x402_journal
        SET state_status = 'uncertain', updated_at = ?
        WHERE idempotency_key = ?
          AND state_status IN ('signing', 'signed', 'uncertain')`)
        .bind(at, idempotencyKey),
    ]);
    if (!changed(results[0]!) || !changed(results[1]!)) reject("ISSUED_STATE_MISMATCH");
    await this.#fault("state_uncertain");
  }

  async markDelivered(idempotencyKey: string, value: X402IssuedFixtureResult): Promise<void> {
    this.#requireEnabled();
    const resultJson = JSON.stringify(value);
    if (
      resultJson.length > 65_536 || value.status !== "fixture_delivered" ||
      value.evidence !== "deterministic-offline-fixture" ||
      value.idempotencyKey !== idempotencyKey || !isValidClassicAddress(value.payer) ||
      !isValidClassicAddress(value.payTo) || !HASH.test(value.transactionHash)
    ) {
      reject("ISSUED_STATE_MISMATCH");
    }
    const at = isoTime(this.#now());
    const results = await batch(this.db, [
      this.db.prepare(`UPDATE issued_x402_state
        SET status = 'delivered', result_json = ?, updated_at = ?
        WHERE idempotency_key = ? AND status = 'signed' AND tx_hash = ?
          AND payer = ? AND merchant_invoice_id = ?
          AND EXISTS (SELECT 1 FROM issued_x402_journal
            WHERE idempotency_key = ? AND budget_state = 'committed')`).bind(
          resultJson, at, idempotencyKey, value.transactionHash,
          value.payer, value.invoiceId, idempotencyKey,
        ),
      this.db.prepare(`UPDATE issued_x402_journal
        SET state_status = 'delivered', result_json = ?, updated_at = ?
        WHERE idempotency_key = ? AND state_status = 'signed'
          AND budget_state = 'committed' AND tx_hash = ?`).bind(
          resultJson, at, idempotencyKey, value.transactionHash,
        ),
    ]);
    if (!changed(results[0]!) || !changed(results[1]!)) reject("ISSUED_STATE_MISMATCH");
    await this.#fault("delivered_journaled");
  }

  /**
   * Repair one journal after process restart without inferring non-submission
   * from elapsed time. Only a state that never crossed signing-started is
   * released. Every later phase remains fenced for ledger reconciliation.
   */
  async recover(idempotencyKey: string): Promise<D1IssuedX402Recovery> {
    this.#requireEnabled();
    const record = await this.get(idempotencyKey);
    if (record === null) return { outcome: "absent", record: null };
    const journal = await this.db.prepare(
      "SELECT * FROM issued_x402_journal WHERE idempotency_key = ?",
    ).bind(idempotencyKey).first<RawRow>();
    if (journal === null) reject("ISSUED_JOURNAL_CORRUPT");
    const budget = await this.db.prepare(
      "SELECT state FROM issued_x402_budget WHERE idempotency_key = ?",
    ).bind(idempotencyKey).first<RawRow>();
    const at = isoTime(this.#now());

    if (record.status === "reserved") {
      if (budget !== null && budget.state !== "reserved") {
        return { outcome: "reconciliation_required", record };
      }
      await batch(this.db, [
        this.db.prepare(`DELETE FROM issued_x402_budget_locks
          WHERE payer = ? AND idempotency_key = ?`).bind(
          record.payer, idempotencyKey,
        ),
        this.db.prepare(
          "DELETE FROM issued_x402_budget WHERE idempotency_key = ? AND state = 'reserved'",
        ).bind(idempotencyKey),
        this.db.prepare(
          "DELETE FROM issued_x402_journal WHERE idempotency_key = ? AND state_status = 'reserved'",
        ).bind(idempotencyKey),
        this.db.prepare(
          "DELETE FROM issued_x402_state WHERE idempotency_key = ? AND status = 'reserved'",
        ).bind(idempotencyKey),
      ]);
      return { outcome: "released_pre_sign", record: null };
    }

    if (record.status === "signing" || record.status === "uncertain") {
      await batch(this.db, [
        this.db.prepare(`UPDATE issued_x402_state SET status = 'uncertain', updated_at = ?
          WHERE idempotency_key = ? AND status IN ('signing', 'uncertain')`)
          .bind(at, idempotencyKey),
        this.db.prepare(`UPDATE issued_x402_journal
          SET state_status = 'uncertain', updated_at = ?
          WHERE idempotency_key = ? AND state_status IN ('signing', 'uncertain')`)
          .bind(at, idempotencyKey),
        this.db.prepare(`UPDATE issued_x402_budget SET state = 'uncertain', updated_at = ?
          WHERE idempotency_key = ? AND state = 'reserved'`)
          .bind(at, idempotencyKey),
        this.db.prepare(`UPDATE issued_x402_journal SET budget_state = 'uncertain', updated_at = ?
          WHERE idempotency_key = ? AND budget_state = 'reserved'`)
          .bind(at, idempotencyKey),
      ]);
      return {
        outcome: "reconciliation_required",
        record: await this.get(idempotencyKey),
      };
    }

    if (record.status === "signed") {
      await batch(this.db, [
        this.db.prepare(`UPDATE issued_x402_budget SET state = 'uncertain', updated_at = ?
          WHERE idempotency_key = ? AND state = 'reserved'`)
          .bind(at, idempotencyKey),
        this.db.prepare(`UPDATE issued_x402_journal SET budget_state = 'uncertain', updated_at = ?
          WHERE idempotency_key = ? AND budget_state = 'reserved'`)
          .bind(at, idempotencyKey),
      ]);
      return { outcome: "reconciliation_required", record };
    }

    if (record.status === "delivered") {
      if (journal.result_json === null || record.result === undefined) {
        reject("ISSUED_JOURNAL_CORRUPT");
      }
      await batch(this.db, [
        this.db.prepare(`UPDATE issued_x402_budget SET state = 'committed', updated_at = ?
          WHERE idempotency_key = ? AND state IN ('reserved', 'uncertain', 'committed')`)
          .bind(at, idempotencyKey),
        this.db.prepare(`UPDATE issued_x402_journal SET budget_state = 'committed', updated_at = ?
          WHERE idempotency_key = ? AND state_status = 'delivered'`)
          .bind(at, idempotencyKey),
      ]);
      return { outcome: "delivered", record: await this.get(idempotencyKey) };
    }
    reject("ISSUED_JOURNAL_CORRUPT");
  }

  /** Recover every unfinished issued journal before the runtime accepts work. */
  async recoverAll(): Promise<readonly D1IssuedX402Recovery[]> {
    this.#requireEnabled();
    const rows = await this.db.prepare(`SELECT idempotency_key
      FROM issued_x402_journal
      WHERE state_status <> 'delivered'
      ORDER BY updated_at, idempotency_key`).all<{ idempotency_key: string }>();
    const recoveries: D1IssuedX402Recovery[] = [];
    for (const row of rows.results ?? []) {
      recoveries.push(await this.recover(row.idempotency_key));
    }
    return recoveries;
  }

  async #transition(idempotencyKey: string, from: StateStatus, to: StateStatus): Promise<void> {
    this.#requireEnabled();
    const at = isoTime(this.#now());
    const results = await batch(this.db, [
      this.db.prepare(`UPDATE issued_x402_state
        SET status = ?, updated_at = ? WHERE idempotency_key = ? AND status = ?`)
        .bind(to, at, idempotencyKey, from),
      this.db.prepare(`UPDATE issued_x402_journal
        SET state_status = ?, updated_at = ?
        WHERE idempotency_key = ? AND state_status = ?`)
        .bind(to, at, idempotencyKey, from),
    ]);
    if (!changed(results[0]!) || !changed(results[1]!)) reject("ISSUED_STATE_MISMATCH");
    if (to === "signing") await this.#fault("state_signing_started");
  }
}

export class D1IssuedX402Budget implements X402IssuedBudgetAuthority {
  readonly #enabled: boolean;
  readonly #now: () => Date;
  readonly #lockToken: () => string;
  readonly #assetKey: string;
  readonly #faultAfterWrite?: D1IssuedX402AuthorityOptions["faultAfterWrite"];

  constructor(
    private readonly db: D1Database,
    private readonly policy: X402IssuedPolicy,
    options: D1IssuedX402AuthorityOptions = {},
  ) {
    validatePolicy(policy);
    this.#enabled = options.enabled === true;
    this.#now = options.now ?? (() => new Date());
    this.#lockToken = options.lockToken ?? (() => crypto.randomUUID());
    this.#assetKey = issuedAssetKey(policy.asset);
    this.#faultAfterWrite = options.faultAfterWrite;
  }

  #requireEnabled(): void {
    if (!this.#enabled) reject("ISSUED_X402_D1_DISABLED");
  }

  async #fault(point: D1IssuedX402WritePoint): Promise<void> {
    await this.#faultAfterWrite?.(point);
  }

  async reserve(input: Readonly<{
    idempotencyKey: string;
    payer: string;
    asset: X402IssuedAsset;
    amount: string;
    feeDrops: string;
    xrpBalanceDrops: string;
    minimumReserveDrops: string;
  }>): Promise<X402IssuedBudgetReservation> {
    this.#requireEnabled();
    boundedText(input.idempotencyKey, "INVALID_IDEMPOTENCY_KEY", 200);
    if (!isValidClassicAddress(input.payer) || issuedAssetKey(input.asset) !== this.#assetKey) {
      reject("ISSUED_BUDGET_REJECTED");
    }
    const amount = decimalAtoms(input.amount);
    const fee = drops(input.feeDrops, "INVALID_FEE", true);
    const balance = drops(input.xrpBalanceDrops, "INVALID_XRP_BALANCE");
    const requestedReserve = drops(input.minimumReserveDrops, "INVALID_XRP_RESERVE");
    const policyReserve = drops(this.policy.minimumXrpReserveDrops, "INVALID_ISSUED_POLICY");
    const minimumReserve = requestedReserve > policyReserve ? requestedReserve : policyReserve;
    const binding = JSON.stringify([
      input.payer, this.#assetKey, input.amount, input.feeDrops,
      input.minimumReserveDrops,
    ]);
    const at = isoTime(this.#now());
    const day = at.slice(0, 10);
    const token = boundedText(this.#lockToken(), "ISSUED_BUDGET_LOCK_INVALID", 200);
    const acquired = await this.db.prepare(`INSERT INTO issued_x402_budget_locks
      (payer, idempotency_key, token, acquired_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(payer) DO NOTHING`).bind(
        input.payer, input.idempotencyKey, token, at,
      ).run();
    if (!changed(acquired)) reject("ISSUED_BUDGET_BUSY");
    try {
      const existing = await this.db.prepare(
        "SELECT * FROM issued_x402_budget WHERE idempotency_key = ?",
      ).bind(input.idempotencyKey).first<RawRow>();
      if (existing !== null) {
        if (String(existing.binding) !== binding) reject("IDEMPOTENCY_BINDING_MISMATCH");
        const state = String(existing.state);
        if (!["reserved", "uncertain", "committed"].includes(state)) {
          reject("ISSUED_BUDGET_STATE_MISMATCH");
        }
        return { replay: true, state: state as X402IssuedBudgetReservation["state"] };
      }
      if (
        amount > decimalAtoms(this.policy.maxPerCall) ||
        fee > drops(this.policy.maxFeeDrops, "INVALID_ISSUED_POLICY", true)
      ) reject("ISSUED_BUDGET_REJECTED");
      const rows = await this.db.prepare(`SELECT asset_key, amount_atoms,
        fee_drops, budget_day, state FROM issued_x402_budget
        WHERE payer = ?`).bind(input.payer).all<RawRow>();
      let daily = 0n;
      let lifetime = 0n;
      let dailyFees = 0n;
      let lifetimeFees = 0n;
      let activeFees = 0n;
      for (const row of rows.results) {
        const rowAmount = BigInt(String(row.amount_atoms));
        const rowFee = BigInt(String(row.fee_drops));
        lifetimeFees += rowFee;
        const sameDay = String(row.budget_day) === day;
        if (sameDay) dailyFees += rowFee;
        if (String(row.asset_key) === this.#assetKey) {
          lifetime += rowAmount;
          if (sameDay) daily += rowAmount;
        }
        if (row.state !== "committed") activeFees += rowFee;
      }
      if (
        daily + amount > decimalAtoms(this.policy.dailyCap) ||
        lifetime + amount > decimalAtoms(this.policy.lifetimeCap) ||
        dailyFees + fee > drops(this.policy.dailyFeeCapDrops, "INVALID_ISSUED_POLICY", true) ||
        lifetimeFees + fee > drops(this.policy.lifetimeFeeCapDrops, "INVALID_ISSUED_POLICY", true)
      ) reject("ISSUED_BUDGET_REJECTED");
      if (balance - activeFees - fee < minimumReserve) {
        reject("ISSUED_XRP_RESERVE_REJECTED");
      }
      const results = await batch(this.db, [
        this.db.prepare(`INSERT INTO issued_x402_budget (
          idempotency_key, binding, payer, asset_key, amount, amount_atoms,
          fee_drops, budget_day, state, created_at, updated_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?
          WHERE EXISTS (SELECT 1 FROM issued_x402_journal
            WHERE idempotency_key = ? AND state_status = 'reserved')
        ON CONFLICT(idempotency_key) DO NOTHING`).bind(
          input.idempotencyKey, binding, input.payer, this.#assetKey, input.amount,
          amount.toString(), input.feeDrops, day, at, at, input.idempotencyKey,
        ),
        this.db.prepare(`UPDATE issued_x402_journal
          SET budget_state = 'reserved', updated_at = ?
          WHERE idempotency_key = ? AND state_status = 'reserved'
            AND budget_state IS NULL`).bind(at, input.idempotencyKey),
      ]);
      if (!changed(results[0]!) || !changed(results[1]!)) {
        reject("IDEMPOTENCY_BINDING_MISMATCH");
      }
      await this.#fault("budget_reserved");
      return { replay: false, state: "reserved" };
    } finally {
      await this.db.prepare(
        "DELETE FROM issued_x402_budget_locks WHERE payer = ? AND token = ?",
      ).bind(input.payer, token).run();
    }
  }

  async releasePreSign(idempotencyKey: string): Promise<void> {
    this.#requireEnabled();
    const at = isoTime(this.#now());
    const results = await batch(this.db, [
      this.db.prepare(
        "DELETE FROM issued_x402_budget WHERE idempotency_key = ? AND state = 'reserved'",
      ).bind(idempotencyKey),
      this.db.prepare(`UPDATE issued_x402_journal SET budget_state = NULL, updated_at = ?
        WHERE idempotency_key = ? AND budget_state = 'reserved'
          AND state_status = 'reserved'`).bind(at, idempotencyKey),
    ]);
    if (!changed(results[0]!) || !changed(results[1]!)) {
      reject("ISSUED_BUDGET_STATE_MISMATCH");
    }
    await this.#fault("budget_released_pre_sign");
  }

  async markUncertain(idempotencyKey: string): Promise<void> {
    await this.#transition(idempotencyKey, ["reserved", "uncertain"], "uncertain");
  }

  async commit(idempotencyKey: string): Promise<void> {
    await this.#transition(
      idempotencyKey, ["reserved", "uncertain", "committed"], "committed",
    );
  }

  async #transition(
    idempotencyKey: string,
    from: readonly X402IssuedBudgetReservation["state"][],
    to: X402IssuedBudgetReservation["state"],
  ): Promise<void> {
    this.#requireEnabled();
    const placeholders = from.map(() => "?").join(",");
    const at = isoTime(this.#now());
    const results = await batch(this.db, [
      this.db.prepare(`UPDATE issued_x402_budget
        SET state = ?, updated_at = ?
        WHERE idempotency_key = ? AND state IN (${placeholders})`).bind(
          to, at, idempotencyKey, ...from,
        ),
      this.db.prepare(`UPDATE issued_x402_journal
        SET budget_state = ?, updated_at = ?
        WHERE idempotency_key = ? AND budget_state IN (${placeholders})`).bind(
          to, at, idempotencyKey, ...from,
        ),
    ]);
    if (!changed(results[0]!) || !changed(results[1]!)) {
      reject("ISSUED_BUDGET_STATE_MISMATCH");
    }
    await this.#fault(to === "committed" ? "budget_committed" : "budget_uncertain");
  }
}
