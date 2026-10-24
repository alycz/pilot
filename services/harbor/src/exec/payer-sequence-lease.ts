import { isValidClassicAddress } from 'xrpl';

import {
	AccountSequenceLeaseAuthority,
	accountSequenceIdentity,
	type AccountSequenceSource,
} from './account-sequence-lease';

export type PayerSequenceRail = 'ap4m' | 'x402' | 'legacy';
export type PayerSequenceState =
	| 'preparing'
	| 'signing'
	| 'signed'
	| 'settlement_unknown'
	| 'legacy_ambiguous'
	| 'released';

export interface PayerSequenceLeaseRow {
	network: 'testnet' | 'devnet';
	payer: string;
	generation: number;
	token: string;
	rail: PayerSequenceRail;
	attemptId: string;
	state: PayerSequenceState;
	sequence: number | null;
	firstEligibleLedgerIndex: number | null;
	lastLedgerSequence: number | null;
	hash: string | null;
	acquiredAt: string;
	signingStartedAt: string | null;
	signedAt: string | null;
	updatedAt: string;
	releasedAt: string | null;
	releaseReason: 'pre_sign' | 'validated_terminal' | 'expired_absent' | null;
	resolutionLedgerIndex: number | null;
}

export interface PayerSequenceLeaseIdentity {
	network: 'testnet' | 'devnet';
	payer: string;
	generation: number;
	token: string;
	rail: 'ap4m' | 'x402';
	attemptId: string;
}

export interface AcquirePayerSequenceLeaseInput {
	network: 'testnet' | 'devnet';
	payer: string;
	rail: 'ap4m' | 'x402';
	attemptId: string;
	token: string;
	at: string;
}

export interface MarkPayerSigningStartedInput extends PayerSequenceLeaseIdentity {
	sequence: number;
	firstEligibleLedgerIndex: number;
	lastLedgerSequence: number;
	at: string;
}

export interface MarkPayerSignedInput extends PayerSequenceLeaseIdentity {
	hash: string;
	at: string;
}

export interface ReleasePayerPreSignInput extends PayerSequenceLeaseIdentity {
	at: string;
	proof: {
		code: 'signing_never_began';
		signingStarted: false;
		signedBlobPersisted: false;
		hashPersisted: false;
	};
}

export interface ReleasePayerValidatedTerminalInput extends PayerSequenceLeaseIdentity {
	hash: string;
	at: string;
	evidence: {
		validated: true;
		transactionFound: true;
		ledgerIndex: number;
	};
}

export interface ReleasePayerExpiredAbsentInput extends PayerSequenceLeaseIdentity {
	hash: string;
	lastLedgerSequence: number;
	at: string;
	evidence: {
		validated: true;
		transactionFound: false;
		validatedLedgerIndex: number;
		/** Every ledger checked for this exact hash, in ascending contiguous order. */
		inclusionLedgersChecked: readonly number[];
	};
}

export type AcquirePayerSequenceLeaseResult = {
	outcome: 'acquired' | 'replay' | 'blocked';
	lease: PayerSequenceLeaseRow;
};

export type PayerSequenceTransitionResult = {
	outcome: 'transitioned' | 'replay' | 'blocked';
	lease: PayerSequenceLeaseRow;
};

export type PayerSequenceReleaseResult = {
	outcome: 'released' | 'replay' | 'blocked';
	lease: PayerSequenceLeaseRow;
};

type RawLease = Record<string, unknown>;

const TOKEN = /^[0-9A-F]{64}$/;
const HASH = /^[0-9A-F]{64}$/;
const MAX_UINT32 = 0xffff_ffff;

export class PayerSequenceLeaseDataError extends Error {
	constructor(message: string, readonly cause?: unknown) {
		super(message);
		this.name = 'PayerSequenceLeaseDataError';
	}
}

function text(value: string, field: string, max = 256): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) {
		throw new PayerSequenceLeaseDataError(`Invalid ${field}`);
	}
	return value;
}

function timestamp(value: string, field: string): string {
	text(value, field, 40);
	if (new Date(value).toISOString() !== value) {
		throw new PayerSequenceLeaseDataError(`Invalid ${field}`);
	}
	return value;
}

function token(value: string): string {
	const normalized = text(value, 'lease token', 64).toUpperCase();
	if (!TOKEN.test(normalized)) throw new PayerSequenceLeaseDataError('Invalid lease token');
	return normalized;
}

function hash(value: string): string {
	const normalized = text(value, 'transaction hash', 64).toUpperCase();
	if (!HASH.test(normalized)) throw new PayerSequenceLeaseDataError('Invalid transaction hash');
	return normalized;
}

function ledgerIndex(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_UINT32) {
		throw new PayerSequenceLeaseDataError(`Invalid ${field}`);
	}
	return value;
}

function sequence(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0 || value > MAX_UINT32) {
		throw new PayerSequenceLeaseDataError('Invalid sequence');
	}
	return value;
}

function address(value: string): string {
	text(value, 'payer', 64);
	if (!isValidClassicAddress(value)) throw new PayerSequenceLeaseDataError('Invalid payer');
	return value;
}

function network(value: string): 'testnet' | 'devnet' {
	if (value !== 'testnet' && value !== 'devnet') {
		throw new PayerSequenceLeaseDataError('Invalid network');
	}
	return value;
}

function rail(value: string): 'ap4m' | 'x402' {
	if (value !== 'ap4m' && value !== 'x402') {
		throw new PayerSequenceLeaseDataError('Invalid rail');
	}
	return value;
}

function integerOrNull(value: unknown, field: string): number | null {
	if (value === null) return null;
	if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
		throw new PayerSequenceLeaseDataError(`Invalid stored ${field}`);
	}
	return value;
}

function stringOrNull(value: unknown, field: string): string | null {
	if (value === null) return null;
	if (typeof value !== 'string') throw new PayerSequenceLeaseDataError(`Invalid stored ${field}`);
	return value;
}

function parseRow(raw: RawLease | null): PayerSequenceLeaseRow {
	if (raw === null) throw new PayerSequenceLeaseDataError('Missing payer sequence lease');
	const storedRail = raw.rail;
	const storedState = raw.state;
	const releaseReason = raw.release_reason;
	if (storedRail !== 'ap4m' && storedRail !== 'x402' && storedRail !== 'legacy') {
		throw new PayerSequenceLeaseDataError('Invalid stored rail');
	}
	if (storedState !== 'preparing' && storedState !== 'signing' && storedState !== 'signed' &&
		storedState !== 'settlement_unknown' && storedState !== 'legacy_ambiguous' && storedState !== 'released') {
		throw new PayerSequenceLeaseDataError('Invalid stored state');
	}
	if (releaseReason !== null && releaseReason !== 'pre_sign' &&
		releaseReason !== 'validated_terminal' && releaseReason !== 'expired_absent') {
		throw new PayerSequenceLeaseDataError('Invalid stored release reason');
	}
	if (typeof raw.generation !== 'number' || !Number.isSafeInteger(raw.generation) || raw.generation <= 0) {
		throw new PayerSequenceLeaseDataError('Invalid stored generation');
	}
	return {
		network: network(String(raw.network)),
		payer: address(String(raw.payer)),
		generation: raw.generation,
		token: token(String(raw.lease_token)),
		rail: storedRail,
		attemptId: text(String(raw.attempt_id), 'stored attempt id'),
		state: storedState,
		sequence: integerOrNull(raw.sequence, 'sequence'),
		firstEligibleLedgerIndex: integerOrNull(raw.first_eligible_ledger_index, 'first eligible ledger index'),
		lastLedgerSequence: integerOrNull(raw.last_ledger_sequence, 'last ledger sequence'),
		hash: raw.tx_hash === null ? null : hash(String(raw.tx_hash)),
		acquiredAt: timestamp(String(raw.acquired_at), 'stored acquired timestamp'),
		signingStartedAt: stringOrNull(raw.signing_started_at, 'signing started timestamp'),
		signedAt: stringOrNull(raw.signed_at, 'signed timestamp'),
		updatedAt: timestamp(String(raw.updated_at), 'stored updated timestamp'),
		releasedAt: stringOrNull(raw.released_at, 'released timestamp'),
		releaseReason,
		resolutionLedgerIndex: integerOrNull(raw.resolution_ledger_index, 'resolution ledger index'),
	};
}

function changes(result: D1Result): number {
	return result.meta.changes ?? 0;
}

const SELECT_LEASE = `SELECT network, payer, generation, lease_token, rail, attempt_id, state,
  sequence, first_eligible_ledger_index, last_ledger_sequence, tx_hash,
  acquired_at, signing_started_at, signed_at, updated_at, released_at,
  release_reason, resolution_ledger_index
FROM payer_sequence_leases WHERE network = ? AND payer = ?`;

export class PayerSequenceLeaseAuthority {
	private readonly global: AccountSequenceLeaseAuthority;
	constructor(private readonly db: D1Database) {
		this.global = new AccountSequenceLeaseAuthority(db);
	}

	async get(input: { network: 'testnet' | 'devnet'; payer: string }): Promise<PayerSequenceLeaseRow | null> {
		const selectedNetwork = network(input.network);
		const selectedPayer = address(input.payer);
		const raw = await this.db.prepare(SELECT_LEASE).bind(selectedNetwork, selectedPayer).first<RawLease>();
		return raw === null ? null : parseRow(raw);
	}

	async acquire(input: AcquirePayerSequenceLeaseInput): Promise<AcquirePayerSequenceLeaseResult> {
		const selectedNetwork = network(input.network);
		const selectedPayer = address(input.payer);
		const selectedRail = rail(input.rail);
		const attemptId = text(input.attemptId, 'attempt id');
		const requestedToken = token(input.token);
		const at = timestamp(input.at, 'acquired timestamp');

		const recycled = await this.db.prepare(`UPDATE payer_sequence_leases SET
      generation = generation + 1, lease_token = ?, rail = ?, attempt_id = ?, state = 'preparing',
      sequence = NULL, first_eligible_ledger_index = NULL, last_ledger_sequence = NULL,
      tx_hash = NULL, acquired_at = ?, signing_started_at = NULL, signed_at = NULL,
      updated_at = ?, released_at = NULL, release_reason = NULL, resolution_ledger_index = NULL
      WHERE network = ? AND payer = ? AND state = 'released'`)
			.bind(requestedToken, selectedRail, attemptId, at, at, selectedNetwork, selectedPayer).run();
		let localOutcome: AcquirePayerSequenceLeaseResult['outcome'];
		let lease: PayerSequenceLeaseRow;
		if (changes(recycled) === 1) {
			localOutcome = 'acquired';
			lease = parseRow(await this.db.prepare(SELECT_LEASE)
				.bind(selectedNetwork, selectedPayer).first<RawLease>());
		} else {
			const inserted = await this.db.prepare(`INSERT OR IGNORE INTO payer_sequence_leases (
      network, payer, generation, lease_token, rail, attempt_id, state, acquired_at, updated_at
    ) VALUES (?, ?, 1, ?, ?, ?, 'preparing', ?, ?)`)
				.bind(selectedNetwork, selectedPayer, requestedToken, selectedRail, attemptId, at, at).run();
			lease = parseRow(await this.db.prepare(SELECT_LEASE)
				.bind(selectedNetwork, selectedPayer).first<RawLease>());
			localOutcome = changes(inserted) === 1
				? 'acquired'
				: lease.rail === selectedRail && lease.attemptId === attemptId && lease.state !== 'released'
					? 'replay'
					: 'blocked';
		}
		if (localOutcome === 'blocked') return { outcome: 'blocked', lease };
		const global = await this.global.acquire({
			principal: `payer-runtime:${selectedRail}`,
			network: selectedNetwork,
			account: selectedPayer,
			source: selectedRail,
			attemptId,
			token: lease.token,
			at,
		});
		if (global.outcome !== 'blocked') return { outcome: localOutcome, lease };
		await this.db.prepare(`UPDATE payer_sequence_leases SET state = 'released', released_at = ?,
			release_reason = 'pre_sign', updated_at = ? WHERE network = ? AND payer = ?
			AND rail = ? AND attempt_id = ? AND state = 'preparing' AND signing_started_at IS NULL`)
			.bind(at, at, selectedNetwork, selectedPayer, selectedRail, attemptId).run();
		return { outcome: 'blocked', lease: await this.required(selectedNetwork, selectedPayer) };
	}

	async markSigningStarted(input: MarkPayerSigningStartedInput): Promise<PayerSequenceTransitionResult> {
		const identity = this.identity(input);
		const selectedSequence = sequence(input.sequence);
		const first = ledgerIndex(input.firstEligibleLedgerIndex, 'first eligible ledger index');
		const last = ledgerIndex(input.lastLedgerSequence, 'last ledger sequence');
		if (first > last) throw new PayerSequenceLeaseDataError('Invalid ledger window');
		const at = timestamp(input.at, 'signing timestamp');
		const result = await this.db.prepare(`UPDATE payer_sequence_leases SET
      state = 'signing', sequence = ?, first_eligible_ledger_index = ?, last_ledger_sequence = ?,
      signing_started_at = ?, updated_at = ?
      WHERE network = ? AND payer = ? AND generation = ? AND lease_token = ?
        AND rail = ? AND attempt_id = ? AND state = 'preparing'`)
			.bind(selectedSequence, first, last, at, at, ...identity.bindings).run();
		const lease = await this.required(identity.network, identity.payer);
		const localOutcome = changes(result) === 1 ? 'transitioned' :
			this.sameIdentity(lease, identity) && lease.state === 'signing' &&
			lease.sequence === selectedSequence && lease.firstEligibleLedgerIndex === first &&
			lease.lastLedgerSequence === last ? 'replay' : 'blocked';
		if (localOutcome === 'blocked') return { outcome: 'blocked', lease };
		const globalIdentity = await this.globalIdentity(lease);
		const global = await this.global.markSigning({ ...globalIdentity,
			sequence: selectedSequence, firstLedgerSequence: first, lastLedgerSequence: last, at });
		return { outcome: global.outcome === 'blocked' ? 'blocked' : localOutcome, lease };
	}

	async markSigned(input: MarkPayerSignedInput): Promise<PayerSequenceTransitionResult> {
		const identity = this.identity(input);
		const selectedHash = hash(input.hash);
		const at = timestamp(input.at, 'signed timestamp');
		const result = await this.db.prepare(`UPDATE payer_sequence_leases SET
      state = 'signed', tx_hash = ?, signed_at = ?, updated_at = ?
      WHERE network = ? AND payer = ? AND generation = ? AND lease_token = ?
        AND rail = ? AND attempt_id = ? AND state = 'signing'`)
			.bind(selectedHash, at, at, ...identity.bindings).run();
		const lease = await this.required(identity.network, identity.payer);
		const localOutcome = changes(result) === 1 ? 'transitioned' :
			this.sameIdentity(lease, identity) && (lease.state === 'signed' || lease.state === 'settlement_unknown') &&
			lease.hash === selectedHash ? 'replay' : 'blocked';
		if (localOutcome === 'blocked') return { outcome: 'blocked', lease };
		const global = await this.global.markSigned({ ...(await this.globalIdentity(lease)), hash: selectedHash, at });
		return { outcome: global.outcome === 'blocked' ? 'blocked' : localOutcome, lease };
	}

	async markSettlementUnknown(input: MarkPayerSignedInput): Promise<PayerSequenceTransitionResult> {
		const identity = this.identity(input);
		const selectedHash = hash(input.hash);
		const at = timestamp(input.at, 'settlement unknown timestamp');
		const result = await this.db.prepare(`UPDATE payer_sequence_leases SET
      state = 'settlement_unknown', updated_at = ?
      WHERE network = ? AND payer = ? AND generation = ? AND lease_token = ?
        AND rail = ? AND attempt_id = ? AND state = 'signed' AND tx_hash = ?`)
			.bind(at, ...identity.bindings, selectedHash).run();
		const lease = await this.required(identity.network, identity.payer);
		const localOutcome = changes(result) === 1 ? 'transitioned' :
			this.sameIdentity(lease, identity) && lease.state === 'settlement_unknown' &&
			lease.hash === selectedHash ? 'replay' : 'blocked';
		if (localOutcome === 'blocked') return { outcome: 'blocked', lease };
		const global = await this.global.markAmbiguous({ ...(await this.globalIdentity(lease)), hash: selectedHash, at });
		return { outcome: global.outcome === 'blocked' ? 'blocked' : localOutcome, lease };
	}

	async releasePreSign(input: ReleasePayerPreSignInput): Promise<PayerSequenceReleaseResult> {
		if (input.proof.code !== 'signing_never_began' || input.proof.signingStarted !== false ||
			input.proof.signedBlobPersisted !== false || input.proof.hashPersisted !== false) {
			throw new PayerSequenceLeaseDataError('Invalid pre-sign release proof');
		}
		const identity = this.identity(input);
		const at = timestamp(input.at, 'release timestamp');
		const leaseBefore = await this.required(identity.network, identity.payer);
		const globalIdentity = await this.ownedGlobalIdentity(leaseBefore);
		if (globalIdentity) {
			const global = await this.global.releasePreSign({ ...globalIdentity, at, proof: 'signing_never_began' });
			if (global.outcome === 'blocked') return { outcome: 'blocked', lease: leaseBefore };
		}
		const result = await this.db.prepare(`UPDATE payer_sequence_leases SET
      state = 'released', released_at = ?, release_reason = 'pre_sign', updated_at = ?
      WHERE network = ? AND payer = ? AND generation = ? AND lease_token = ?
        AND rail = ? AND attempt_id = ? AND state = 'preparing'
        AND signing_started_at IS NULL AND signed_at IS NULL AND tx_hash IS NULL`)
			.bind(at, at, ...identity.bindings).run();
		const local = await this.releaseResult(result, identity, 'pre_sign', null, null);
		return local;
	}

	async releaseValidatedTerminal(
		input: ReleasePayerValidatedTerminalInput,
	): Promise<PayerSequenceReleaseResult> {
		if (input.evidence.validated !== true || input.evidence.transactionFound !== true) {
			throw new PayerSequenceLeaseDataError('Invalid validated terminal evidence');
		}
		const identity = this.identity(input);
		const selectedHash = hash(input.hash);
		const resolvedAt = ledgerIndex(input.evidence.ledgerIndex, 'resolution ledger index');
		const at = timestamp(input.at, 'release timestamp');
		const leaseBefore = await this.required(identity.network, identity.payer);
		const globalIdentity = await this.ownedGlobalIdentity(leaseBefore);
		if (globalIdentity) {
			const global = await this.global.releaseValidated({ ...globalIdentity, hash: selectedHash,
				ledgerIndex: resolvedAt, engineResult: 'payer_terminal', at });
			if (global.outcome === 'blocked') return { outcome: 'blocked', lease: leaseBefore };
		}
		const result = await this.db.prepare(`UPDATE payer_sequence_leases SET
      state = 'released', released_at = ?, release_reason = 'validated_terminal',
      resolution_ledger_index = ?, updated_at = ?
      WHERE network = ? AND payer = ? AND generation = ? AND lease_token = ?
        AND rail = ? AND attempt_id = ? AND state IN ('signed', 'settlement_unknown')
		AND tx_hash = ? AND first_eligible_ledger_index <= ? AND last_ledger_sequence >= ?`)
			.bind(at, resolvedAt, at, ...identity.bindings, selectedHash, resolvedAt, resolvedAt).run();
		const local = await this.releaseResult(result, identity, 'validated_terminal', selectedHash, resolvedAt);
		return local;
	}

	async releaseExpiredAbsent(input: ReleasePayerExpiredAbsentInput): Promise<PayerSequenceReleaseResult> {
		if (input.evidence.validated !== true || input.evidence.transactionFound !== false) {
			throw new PayerSequenceLeaseDataError('Invalid expired-absent evidence');
		}
		const identity = this.identity(input);
		const selectedHash = hash(input.hash);
		const last = ledgerIndex(input.lastLedgerSequence, 'last ledger sequence');
		const validated = ledgerIndex(input.evidence.validatedLedgerIndex, 'validated ledger index');
		if (!Array.isArray(input.evidence.inclusionLedgersChecked) ||
			input.evidence.inclusionLedgersChecked.length === 0 ||
			input.evidence.inclusionLedgersChecked.length > 64) {
			throw new PayerSequenceLeaseDataError('Incomplete expired-absent evidence');
		}
		const checked = input.evidence.inclusionLedgersChecked.map((value) =>
			ledgerIndex(value, 'checked ledger index'));
		const leaseBefore = await this.required(identity.network, identity.payer);
		if (!this.sameIdentity(leaseBefore, identity) || leaseBefore.hash !== selectedHash ||
			leaseBefore.firstEligibleLedgerIndex === null || leaseBefore.lastLedgerSequence !== last ||
			validated <= last || checked.length !== last - leaseBefore.firstEligibleLedgerIndex + 1 ||
			checked.some((value, index) => value !== leaseBefore.firstEligibleLedgerIndex! + index)) {
			throw new PayerSequenceLeaseDataError('Incomplete expired-absent evidence');
		}
		const at = timestamp(input.at, 'release timestamp');
		const globalIdentity = await this.ownedGlobalIdentity(leaseBefore);
		if (globalIdentity) {
			const global = await this.global.releaseAbsent({ ...globalIdentity, hash: selectedHash,
				validatedHead: validated,
				checkedFrom: leaseBefore.firstEligibleLedgerIndex!, checkedThrough: last,
				searchedAll: true, at });
			if (global.outcome === 'blocked') return { outcome: 'blocked', lease: leaseBefore };
		}
		const result = await this.db.prepare(`UPDATE payer_sequence_leases SET
      state = 'released', released_at = ?, release_reason = 'expired_absent',
      resolution_ledger_index = ?, updated_at = ?
      WHERE network = ? AND payer = ? AND generation = ? AND lease_token = ?
        AND rail = ? AND attempt_id = ? AND state IN ('signed', 'settlement_unknown')
		AND tx_hash = ? AND last_ledger_sequence = ?`)
			.bind(at, validated, at, ...identity.bindings, selectedHash, last).run();
		const local = await this.releaseResult(result, identity, 'expired_absent', selectedHash, validated);
		return local;
	}

	private identity(input: PayerSequenceLeaseIdentity): PayerSequenceLeaseIdentity & { bindings: unknown[] } {
		const selectedNetwork = network(input.network);
		const selectedPayer = address(input.payer);
		const selectedRail = rail(input.rail);
		const attemptId = text(input.attemptId, 'attempt id');
		const selectedToken = token(input.token);
		if (!Number.isSafeInteger(input.generation) || input.generation <= 0) {
			throw new PayerSequenceLeaseDataError('Invalid generation');
		}
		return {
			network: selectedNetwork,
			payer: selectedPayer,
			generation: input.generation,
			token: selectedToken,
			rail: selectedRail,
			attemptId,
			bindings: [selectedNetwork, selectedPayer, input.generation, selectedToken, selectedRail, attemptId],
		};
	}

	private async globalIdentity(lease: PayerSequenceLeaseRow) {
		if (lease.rail !== 'ap4m' && lease.rail !== 'x402') {
			throw new PayerSequenceLeaseDataError('Legacy payer lease has no global authority');
		}
		const global = await this.global.get({ network: lease.network, account: lease.payer });
		if (!global || global.source !== (lease.rail as AccountSequenceSource) ||
			global.attemptId !== lease.attemptId) {
			throw new PayerSequenceLeaseDataError('Global account sequence lease is missing or inconsistent');
		}
		return accountSequenceIdentity(global);
	}

	private async ownedGlobalIdentity(lease: PayerSequenceLeaseRow) {
		if (lease.rail !== 'ap4m' && lease.rail !== 'x402') {
			throw new PayerSequenceLeaseDataError('Legacy payer lease has no global authority');
		}
		const global = await this.global.get({ network: lease.network, account: lease.payer });
		if (!global) throw new PayerSequenceLeaseDataError('Global account sequence lease is missing');
		if (global.source !== lease.rail || global.attemptId !== lease.attemptId ||
			global.token !== lease.token) return null;
		return accountSequenceIdentity(global);
	}

	private async required(selectedNetwork: 'testnet' | 'devnet', selectedPayer: string): Promise<PayerSequenceLeaseRow> {
		return parseRow(await this.db.prepare(SELECT_LEASE).bind(selectedNetwork, selectedPayer).first<RawLease>());
	}

	private sameIdentity(lease: PayerSequenceLeaseRow, identity: PayerSequenceLeaseIdentity): boolean {
		return lease.network === identity.network && lease.payer === identity.payer &&
			lease.generation === identity.generation && lease.token === identity.token &&
			lease.rail === identity.rail && lease.attemptId === identity.attemptId;
	}

	private async releaseResult(
		result: D1Result,
		identity: PayerSequenceLeaseIdentity,
		reason: 'pre_sign' | 'validated_terminal' | 'expired_absent',
		selectedHash: string | null,
		resolvedAt: number | null,
	): Promise<PayerSequenceReleaseResult> {
		const lease = await this.required(identity.network, identity.payer);
		if (changes(result) === 1) return { outcome: 'released', lease };
		if (this.sameIdentity(lease, identity) && lease.state === 'released' &&
			lease.releaseReason === reason && lease.hash === selectedHash &&
			lease.resolutionLedgerIndex === resolvedAt) return { outcome: 'replay', lease };
		return { outcome: 'blocked', lease };
	}
}
