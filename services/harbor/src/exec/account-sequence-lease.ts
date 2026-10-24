import { isValidClassicAddress } from "xrpl";

export type AccountSequenceSource = "manual" | "strategy" | "ap4m" | "x402";
export type AccountSequenceState =
  | "preparing"
  | "signing"
  | "signed"
  | "submitted"
  | "ambiguous"
  | "released";

export interface AccountSequenceLeaseRow {
  principal: string;
  network: "testnet" | "devnet";
  account: string;
  generation: number;
  token: string;
  source: AccountSequenceSource;
  attemptId: string;
  state: AccountSequenceState;
  sequence: number | null;
  firstLedgerSequence: number | null;
  lastLedgerSequence: number | null;
  hash: string | null;
  acquiredAt: string;
  updatedAt: string;
  releasedAt: string | null;
  releaseEvidence: Record<string, unknown> | null;
}
export interface AccountSequenceLeaseIdentity {
  network: "testnet" | "devnet";
  account: string;
  generation: number;
  token: string;
  source: AccountSequenceSource;
  attemptId: string;
}

export type AccountSequenceResult = {
  outcome: "acquired" | "transitioned" | "released" | "replay" | "blocked";
  lease: AccountSequenceLeaseRow;
};

type Raw = Record<string, unknown>;
const HEX64 = /^[A-F0-9]{64}$/;
const UINT32_MAX = 0xffff_ffff;

export class AccountSequenceLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountSequenceLeaseError";
  }
}

function nonempty(value: string, field: string, max = 256): string {
  if (!value || value.length > max || value.includes("\0")) {
    throw new AccountSequenceLeaseError(`Invalid ${field}`);
  }
  return value;
}

function timestamp(value: string): string {
  if (new Date(value).toISOString() !== value) {
    throw new AccountSequenceLeaseError("Invalid timestamp");
  }
  return value;
}

function hex64(value: string, field: string): string {
  const normalized = value.toUpperCase();
  if (!HEX64.test(normalized)) throw new AccountSequenceLeaseError(`Invalid ${field}`);
  return normalized;
}

function network(value: string): "testnet" | "devnet" {
  if (value !== "testnet" && value !== "devnet") {
    throw new AccountSequenceLeaseError("Invalid network");
  }
  return value;
}

function account(value: string): string {
  if (!isValidClassicAddress(value)) throw new AccountSequenceLeaseError("Invalid account");
  return value;
}

function source(value: string): AccountSequenceSource {
  if (value !== "manual" && value !== "strategy" && value !== "ap4m" && value !== "x402") {
    throw new AccountSequenceLeaseError("Invalid source");
  }
  return value;
}

function uint32(value: number, field: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > UINT32_MAX) {
    throw new AccountSequenceLeaseError(`Invalid ${field}`);
  }
  return value;
}

function nullableNumber(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new AccountSequenceLeaseError("Invalid stored number");
  }
  return value;
}

function parse(raw: Raw | null): AccountSequenceLeaseRow {
  if (!raw) throw new AccountSequenceLeaseError("Missing account sequence lease");
  const state = raw.state;
  if (state !== "preparing" && state !== "signing" && state !== "signed" &&
      state !== "submitted" && state !== "ambiguous" && state !== "released") {
    throw new AccountSequenceLeaseError("Invalid stored state");
  }
  let releaseEvidence: Record<string, unknown> | null = null;
  if (typeof raw.release_evidence === "string") {
    const decoded = JSON.parse(raw.release_evidence) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new AccountSequenceLeaseError("Invalid release evidence");
    }
    releaseEvidence = decoded as Record<string, unknown>;
  } else if (raw.release_evidence !== null) {
    throw new AccountSequenceLeaseError("Invalid release evidence");
  }
  return {
    principal: nonempty(String(raw.principal), "principal"),
    network: network(String(raw.network)),
    account: account(String(raw.account)),
    generation: uint32(Number(raw.generation), "generation"),
    token: hex64(String(raw.lease_token), "lease token"),
    source: source(String(raw.source)),
    attemptId: nonempty(String(raw.attempt_id), "attempt id"),
    state,
    sequence: nullableNumber(raw.sequence),
    firstLedgerSequence: nullableNumber(raw.first_ledger_sequence),
    lastLedgerSequence: nullableNumber(raw.last_ledger_sequence),
    hash: raw.tx_hash === null ? null : hex64(String(raw.tx_hash), "transaction hash"),
    acquiredAt: timestamp(String(raw.acquired_at)),
    updatedAt: timestamp(String(raw.updated_at)),
    releasedAt: raw.released_at === null ? null : timestamp(String(raw.released_at)),
    releaseEvidence,
  };
}

function changes(result: D1Result): number {
  return result.meta.changes ?? 0;
}

const SELECT = `SELECT principal, network, account, generation, lease_token, source,
  attempt_id, state, sequence, first_ledger_sequence, last_ledger_sequence,
  tx_hash, acquired_at, updated_at, released_at, release_evidence
  FROM account_sequence_leases WHERE network = ? AND account = ?`;

export class AccountSequenceLeaseAuthority {
  constructor(private readonly db: D1Database) {}

  async get(input: { network: "testnet" | "devnet"; account: string }): Promise<AccountSequenceLeaseRow | null> {
    const selectedNetwork = network(input.network);
    const selectedAccount = account(input.account);
    const row = await this.db.prepare(SELECT).bind(selectedNetwork, selectedAccount).first<Raw>();
    return row ? parse(row) : null;
  }

  async acquire(input: {
    principal: string;
    network: "testnet" | "devnet";
    account: string;
    source: AccountSequenceSource;
    attemptId: string;
    token: string;
    at: string;
  }): Promise<AccountSequenceResult> {
    const principal = nonempty(input.principal, "principal");
    const selectedNetwork = network(input.network);
    const selectedAccount = account(input.account);
    const selectedSource = source(input.source);
    const attemptId = nonempty(input.attemptId, "attempt id");
    const token = hex64(input.token, "lease token");
    const at = timestamp(input.at);
    const recycled = await this.db.prepare(`UPDATE account_sequence_leases SET
      principal = ?, generation = generation + 1, lease_token = ?, source = ?, attempt_id = ?,
      state = 'preparing', sequence = NULL, first_ledger_sequence = NULL,
      last_ledger_sequence = NULL, tx_hash = NULL, acquired_at = ?, updated_at = ?,
      released_at = NULL, release_evidence = NULL
      WHERE network = ? AND account = ? AND state = 'released'`)
      .bind(principal, token, selectedSource, attemptId, at, at, selectedNetwork, selectedAccount).run();
    if (changes(recycled) === 1) {
      return { outcome: "acquired", lease: parse(await this.db.prepare(SELECT).bind(selectedNetwork, selectedAccount).first<Raw>()) };
    }
    const inserted = await this.db.prepare(`INSERT OR IGNORE INTO account_sequence_leases
      (principal, network, account, generation, lease_token, source, attempt_id, state, acquired_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, 'preparing', ?, ?)`)
      .bind(principal, selectedNetwork, selectedAccount, token, selectedSource, attemptId, at, at).run();
    const lease = parse(await this.db.prepare(SELECT).bind(selectedNetwork, selectedAccount).first<Raw>());
    if (changes(inserted) === 1) return { outcome: "acquired", lease };
    if (lease.principal === principal && lease.source === selectedSource &&
        lease.attemptId === attemptId && lease.token === token && lease.state !== "released") {
      return { outcome: "replay", lease };
    }
    return { outcome: "blocked", lease };
  }

  async markSigning(input: AccountSequenceLeaseIdentity & {
    sequence: number;
    firstLedgerSequence: number;
    lastLedgerSequence: number;
    at: string;
  }): Promise<AccountSequenceResult> {
    const identity = this.identity(input);
    const sequence = uint32(input.sequence, "sequence", true);
    const first = uint32(input.firstLedgerSequence, "first ledger sequence");
    const last = uint32(input.lastLedgerSequence, "last ledger sequence");
    if (first > last) throw new AccountSequenceLeaseError("Invalid ledger window");
    const at = timestamp(input.at);
    const result = await this.db.prepare(`UPDATE account_sequence_leases SET
      state = 'signing', sequence = ?, first_ledger_sequence = ?, last_ledger_sequence = ?, updated_at = ?
      WHERE network = ? AND account = ? AND generation = ? AND lease_token = ?
        AND source = ? AND attempt_id = ? AND state = 'preparing'`)
      .bind(sequence, first, last, at, ...identity.bindings).run();
    const lease = await this.required(identity.network, identity.account);
    if (changes(result) === 1) return { outcome: "transitioned", lease };
    if (this.same(lease, identity) && lease.state === "signing" && lease.sequence === sequence &&
        lease.firstLedgerSequence === first && lease.lastLedgerSequence === last) {
      return { outcome: "replay", lease };
    }
    return { outcome: "blocked", lease };
  }

  async markAmbiguous(input: AccountSequenceLeaseIdentity & { hash?: string; at: string }): Promise<AccountSequenceResult> {
    const identity = this.identity(input);
    const hash = input.hash === undefined ? null : hex64(input.hash, "transaction hash");
    const at = timestamp(input.at);
    const result = await this.db.prepare(`UPDATE account_sequence_leases SET
      state = 'ambiguous', tx_hash = COALESCE(tx_hash, ?), updated_at = ?
      WHERE network = ? AND account = ? AND generation = ? AND lease_token = ?
        AND source = ? AND attempt_id = ? AND state IN ('signing','signed','submitted')
        AND (tx_hash IS NULL OR tx_hash = ?)`)
      .bind(hash, at, ...identity.bindings, hash).run();
    const lease = await this.required(identity.network, identity.account);
    if (changes(result) === 1) return { outcome: "transitioned", lease };
    if (this.same(lease, identity) && lease.state === "ambiguous" && (hash === null || lease.hash === hash)) {
      return { outcome: "replay", lease };
    }
    return { outcome: "blocked", lease };
  }

  async markSigned(input: AccountSequenceLeaseIdentity & { hash: string; at: string }): Promise<AccountSequenceResult> {
    return this.markHashState(input, "signed", ["signing"]);
  }

  async markSubmitted(input: AccountSequenceLeaseIdentity & { hash: string; at: string }): Promise<AccountSequenceResult> {
    return this.markHashState(input, "submitted", ["signed"]);
  }

  async releasePreSign(input: AccountSequenceLeaseIdentity & { at: string; proof: "signing_never_began" }): Promise<AccountSequenceResult> {
    const identity = this.identity(input);
    const at = timestamp(input.at);
    const evidence = JSON.stringify({ kind: input.proof });
    const result = await this.db.prepare(`UPDATE account_sequence_leases SET
      state = 'released', released_at = ?, updated_at = ?, release_evidence = ?
      WHERE network = ? AND account = ? AND generation = ? AND lease_token = ?
        AND source = ? AND attempt_id = ? AND state = 'preparing'
        AND sequence IS NULL AND tx_hash IS NULL`)
      .bind(at, at, evidence, ...identity.bindings).run();
    return this.releaseResult(result, identity, "signing_never_began");
  }

  async releaseValidated(input: AccountSequenceLeaseIdentity & {
    hash: string;
    ledgerIndex: number;
    engineResult: string;
    at: string;
  }): Promise<AccountSequenceResult> {
    const identity = this.identity(input);
    const hash = hex64(input.hash, "transaction hash");
    const ledger = uint32(input.ledgerIndex, "ledger index");
    const leaseBefore = await this.required(identity.network, identity.account);
    if (!this.same(leaseBefore, identity) || leaseBefore.hash !== hash ||
        leaseBefore.firstLedgerSequence === null || leaseBefore.lastLedgerSequence === null ||
        ledger < leaseBefore.firstLedgerSequence || ledger > leaseBefore.lastLedgerSequence) {
      throw new AccountSequenceLeaseError("Validated transaction is outside the leased ledger window");
    }
    nonempty(input.engineResult, "engine result", 128);
    const at = timestamp(input.at);
    const evidence = JSON.stringify({ kind: "validated_terminal", hash, ledger_index: ledger, engine_result: input.engineResult });
    const result = await this.db.prepare(`UPDATE account_sequence_leases SET
      state = 'released', released_at = ?, updated_at = ?, release_evidence = ?
      WHERE network = ? AND account = ? AND generation = ? AND lease_token = ?
        AND source = ? AND attempt_id = ? AND state IN ('signed','submitted','ambiguous')
        AND tx_hash = ? AND first_ledger_sequence <= ? AND last_ledger_sequence >= ?`)
      .bind(at, at, evidence, ...identity.bindings, hash, ledger, ledger).run();
    return this.releaseResult(result, identity, "validated_terminal");
  }

  async releaseAbsent(input: AccountSequenceLeaseIdentity & {
    hash: string;
    validatedHead: number;
    checkedFrom: number;
    checkedThrough: number;
    searchedAll: true;
    at: string;
  }): Promise<AccountSequenceResult> {
    const identity = this.identity(input);
    if (input.searchedAll !== true) {
      throw new AccountSequenceLeaseError("Incomplete absence evidence");
    }
    const hash = hex64(input.hash, "transaction hash");
    const head = uint32(input.validatedHead, "validated head");
    const checkedFrom = uint32(input.checkedFrom, "checked from");
    const checkedThrough = uint32(input.checkedThrough, "checked through");
    const leaseBefore = await this.required(identity.network, identity.account);
    if (!this.same(leaseBefore, identity) || leaseBefore.hash !== hash ||
        leaseBefore.firstLedgerSequence === null || leaseBefore.lastLedgerSequence === null ||
        checkedFrom !== leaseBefore.firstLedgerSequence ||
        checkedThrough !== leaseBefore.lastLedgerSequence || head <= checkedThrough) {
      throw new AccountSequenceLeaseError("Incomplete absence evidence");
    }
    const at = timestamp(input.at);
    const evidence = JSON.stringify({ kind: "expired_absent", hash,
      validated_head: head, checked_from: checkedFrom,
      checked_through: checkedThrough, searched_all: true });
    const result = await this.db.prepare(`UPDATE account_sequence_leases SET
      state = 'released', released_at = ?, updated_at = ?, release_evidence = ?
      WHERE network = ? AND account = ? AND generation = ? AND lease_token = ?
        AND source = ? AND attempt_id = ? AND state IN ('signed','submitted','ambiguous')
        AND tx_hash = ? AND first_ledger_sequence = ?
        AND last_ledger_sequence = ? AND last_ledger_sequence < ?`)
      .bind(at, at, evidence, ...identity.bindings, hash,
        checkedFrom, checkedThrough, head).run();
    return this.releaseResult(result, identity, "expired_absent");
  }

  private identity(input: AccountSequenceLeaseIdentity): AccountSequenceLeaseIdentity & { bindings: unknown[] } {
    const selectedNetwork = network(input.network);
    const selectedAccount = account(input.account);
    const generation = uint32(input.generation, "generation");
    const token = hex64(input.token, "lease token");
    const selectedSource = source(input.source);
    const attemptId = nonempty(input.attemptId, "attempt id");
    return { network: selectedNetwork, account: selectedAccount, generation, token,
      source: selectedSource, attemptId,
      bindings: [selectedNetwork, selectedAccount, generation, token, selectedSource, attemptId] };
  }

  private async required(selectedNetwork: "testnet" | "devnet", selectedAccount: string): Promise<AccountSequenceLeaseRow> {
    return parse(await this.db.prepare(SELECT).bind(selectedNetwork, selectedAccount).first<Raw>());
  }

  private async markHashState(
    input: AccountSequenceLeaseIdentity & { hash: string; at: string },
    target: "signed" | "submitted",
    allowed: readonly ("signing" | "signed" | "submitted")[],
  ): Promise<AccountSequenceResult> {
    const identity = this.identity(input);
    const hash = hex64(input.hash, "transaction hash");
    const at = timestamp(input.at);
    const placeholders = allowed.map(() => "?").join(",");
    const result = await this.db.prepare(`UPDATE account_sequence_leases SET
      state = ?, tx_hash = ?, updated_at = ?
      WHERE network = ? AND account = ? AND generation = ? AND lease_token = ?
        AND source = ? AND attempt_id = ? AND state IN (${placeholders})
        AND (tx_hash IS NULL OR tx_hash = ?)`)
      .bind(target, hash, at, ...identity.bindings, ...allowed, hash).run();
    const lease = await this.required(identity.network, identity.account);
    if (changes(result) === 1) return { outcome: "transitioned", lease };
    if (this.same(lease, identity) && lease.state === target && lease.hash === hash) {
      return { outcome: "replay", lease };
    }
    return { outcome: "blocked", lease };
  }

  private same(lease: AccountSequenceLeaseRow, identity: AccountSequenceLeaseIdentity): boolean {
    return lease.network === identity.network && lease.account === identity.account &&
      lease.generation === identity.generation && lease.token === identity.token &&
      lease.source === identity.source && lease.attemptId === identity.attemptId;
  }

  private async releaseResult(result: D1Result, identity: AccountSequenceLeaseIdentity, kind: string): Promise<AccountSequenceResult> {
    const lease = await this.required(identity.network, identity.account);
    if (changes(result) === 1) return { outcome: "released", lease };
    if (this.same(lease, identity) && lease.state === "released" && lease.releaseEvidence?.kind === kind) {
      return { outcome: "replay", lease };
    }
    return { outcome: "blocked", lease };
  }
}

export function accountSequenceIdentity(lease: AccountSequenceLeaseRow): AccountSequenceLeaseIdentity {
  return {
    network: lease.network,
    account: lease.account,
    generation: lease.generation,
    token: lease.token,
    source: lease.source,
    attemptId: lease.attemptId,
  };
}
