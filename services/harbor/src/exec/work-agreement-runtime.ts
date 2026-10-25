import {
	decode, deriveAddress, encode, encodeForSigning, hashes, isValidClassicAddress,
	verifyKeypairSignature, type Transaction,
} from 'xrpl';

export const WORK_AGREEMENT_LOCAL_PROFILE = Object.freeze({
	id: 'local-testnet-mock-v1', network: 'testnet' as const, simulatedSubmission: true,
	liveValidationClaimed: false, ownerKeyCustody: false,
});

export type WorkAgreementAction = 'create' | 'release' | 'cancel';
export type WorkAgreementStatus = 'awaiting_approval' | 'submitting' | 'unknown' |
	'active' | 'released' | 'cancelled' | 'rejected' | 'expired';
export type JsonObject = Record<string, unknown>;

export interface WorkAgreementTerms {
	agreementId: string;
	owner: string;
	counterparty: string;
	network: 'testnet';
	amountDrops: string;
	finishAfter?: number;
	cancelAfter?: number;
	condition?: string;
}

export interface WorkAgreementApproval {
	action: WorkAgreementAction;
	approvalId: string;
	expiresAt: string;
	execution: { build_id: string; idempotency_key: string; require_owner_approval: true };
	validatedLedgerIndex: number;
	validatedAccountSequence: number;
	maxFeeDrops: string;
	txJson: JsonObject;
}

export interface WorkAgreementSettlementEvidence {
	approvalId: string;
	hash: string;
	ledgerIndex: number;
	validated: true;
	engineResult: 'tesSUCCESS';
	/** Reviewed unsigned transaction only; signing material is never persisted. */
	txJson: JsonObject;
}

export interface WorkAgreementNonInclusionProof {
	approvalId: string;
	hash: string;
	outcome: 'not_included';
	searchedAll: true;
	validatedLedgerIndex: number;
	checkedThroughLedger: number;
}

export type WorkAgreementLookupResult =
	| { status: 'pending'; hash: string }
	| ({ status: 'validated'; txJson: JsonObject } & Omit<WorkAgreementSettlementEvidence, 'approvalId' | 'txJson'>)
	| ({ status: 'not_included' } & Omit<WorkAgreementNonInclusionProof, 'approvalId' | 'outcome'>);

export interface WorkAgreementRecord {
	profile: typeof WORK_AGREEMENT_LOCAL_PROFILE.id;
	principal: string;
	revision: number;
	status: WorkAgreementStatus;
	terms: WorkAgreementTerms;
	history: { approvalIds: string[]; idempotencyKeys: string[]; attemptIds: string[] };
	action?: WorkAgreementAction;
	approval?: WorkAgreementApproval;
	attemptId?: string;
	expectedHash?: string;
	offerSequence?: number;
	createEvidence?: WorkAgreementSettlementEvidence;
	terminalEvidence?: WorkAgreementSettlementEvidence;
	lastResolution?: { approvalId: string; idempotencyKey: string; action: WorkAgreementAction; outcome: 'validated' | 'rejected' | 'not_included' };
	dispatchError?: string;
	createdAt: string;
	updatedAt: string;
}

export interface WorkAgreementStore {
	get(principal: string, agreementId: string): Promise<WorkAgreementRecord | null>;
	insert(record: WorkAgreementRecord): Promise<boolean>;
	compareAndSwap(principal: string, agreementId: string, expectedRevision: number, next: WorkAgreementRecord): Promise<boolean>;
	hasReplay?(principal: string, input: { approvalId?: string; idempotencyKey?: string; attemptId?: string }): Promise<boolean>;
}

export interface WorkAgreementEffects {
	dispatch(input: Readonly<{ profile: typeof WORK_AGREEMENT_LOCAL_PROFILE.id; principal: string;
		agreementId: string; action: WorkAgreementAction; approvalId: string; idempotencyKey: string;
		attemptId: string; hash: string; signedBlob: string }>): Promise<void>;
	lookup(input: Readonly<{ profile: typeof WORK_AGREEMENT_LOCAL_PROFILE.id; principal: string;
		agreementId: string; action: WorkAgreementAction; approvalId: string; idempotencyKey: string;
		hash: string }>): Promise<WorkAgreementLookupResult>;
}

export class WorkAgreementRuntimeError extends Error {
	constructor(readonly code: string, message: string) { super(message); this.name = 'WorkAgreementRuntimeError'; }
}

const PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const HASH = /^[A-F0-9]{64}$/;
const HEX = /^(?:[A-Fa-f0-9]{2})+$/;
const UINT32_MAX = 0xffff_ffff;
const MAX_FEE_DROPS = 1_000n;
const MAX_LEDGER_WINDOW = 50;
const COMMON = ['TransactionType', 'Account', 'Fee', 'Sequence', 'LastLedgerSequence', 'SourceTag', 'Memos'];
const ACTION_FIELDS: Record<WorkAgreementAction, readonly string[]> = {
	create: [...COMMON, 'Destination', 'Amount', 'FinishAfter', 'CancelAfter', 'Condition'],
	release: [...COMMON, 'Owner', 'OfferSequence', 'Condition', 'Fulfillment'],
	cancel: [...COMMON, 'Owner', 'OfferSequence'],
};
const SIGNED_FIELDS = ['SigningPubKey', 'TxnSignature'];

function fail(code: string, message: string): never { throw new WorkAgreementRuntimeError(code, message); }
function plain(value: unknown): value is JsonObject {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
function own(value: JsonObject, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key); }
function exactKeys(value: JsonObject, allowed: readonly string[]): boolean {
	const permitted = new Set(allowed); return Object.keys(value).every((key) => permitted.has(key));
}
function safeInteger(value: unknown, field: string, allowZero = false): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) fail('INVALID_REQUEST', `${field} is invalid`);
	return value;
}
function uint32(value: unknown, field: string): number {
	const parsed = safeInteger(value, field, true); if (parsed > UINT32_MAX) fail('INVALID_REQUEST', `${field} is invalid`); return parsed;
}
function text(value: unknown, field: string, max = 200): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) fail('INVALID_REQUEST', `${field} is invalid`);
	return value;
}
function id(value: unknown, field: string): string {
	const parsed = text(value, field); if (!SAFE_ID.test(parsed)) fail('INVALID_REQUEST', `${field} is invalid`); return parsed;
}
function drops(value: unknown, field: string): bigint {
	if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value)) fail('INVALID_REQUEST', `${field} is invalid`);
	return BigInt(value);
}
function iso(value: unknown, field: string): string {
	const parsed = text(value, field, 40);
	try { if (new Date(parsed).toISOString() !== parsed) fail('INVALID_REQUEST', `${field} is invalid`); }
	catch { fail('INVALID_REQUEST', `${field} is invalid`); }
	return parsed;
}
function address(value: unknown, field: string): string {
	const parsed = text(value, field, 64); if (!isValidClassicAddress(parsed)) fail('INVALID_REQUEST', `${field} is invalid`); return parsed;
}
function txHash(value: unknown, field = 'hash'): string {
	const parsed = text(value, field, 64).toUpperCase(); if (!HASH.test(parsed)) fail('INVALID_EVIDENCE', `${field} is invalid`); return parsed;
}
function stable(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	return `{${Object.keys(value as JsonObject).sort().map((key) => `${JSON.stringify(key)}:${stable((value as JsonObject)[key])}`).join(',')}}`;
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function same(left: unknown, right: unknown): boolean { return stable(left) === stable(right); }

function validateTerms(input: WorkAgreementTerms): WorkAgreementTerms {
	if (!plain(input)) fail('INVALID_REQUEST', 'terms are invalid');
	const agreementId = id(input.agreementId, 'agreementId');
	const owner = address(input.owner, 'owner');
	const counterparty = address(input.counterparty, 'counterparty');
	if (owner === counterparty) fail('INVALID_REQUEST', 'counterparty must differ from owner');
	if (input.network !== 'testnet') fail('NETWORK_UNSUPPORTED', 'only the fixed local Testnet mock profile is supported');
	drops(input.amountDrops, 'amountDrops');
	const finishAfter = input.finishAfter === undefined ? undefined : uint32(input.finishAfter, 'finishAfter');
	const cancelAfter = input.cancelAfter === undefined ? undefined : uint32(input.cancelAfter, 'cancelAfter');
	if (finishAfter === undefined && cancelAfter === undefined) fail('INVALID_REQUEST', 'an escrow time bound is required');
	if (finishAfter !== undefined && cancelAfter !== undefined && finishAfter >= cancelAfter) fail('INVALID_REQUEST', 'finishAfter must precede cancelAfter');
	let condition: string | undefined;
	if (input.condition !== undefined) { condition = text(input.condition, 'condition', 512).toUpperCase(); if (!HEX.test(condition)) fail('INVALID_REQUEST', 'condition is invalid'); }
	if (condition !== undefined && cancelAfter === undefined) fail('INVALID_REQUEST', 'conditioned escrow requires cancelAfter');
	return { agreementId, owner, counterparty, network: 'testnet', amountDrops: input.amountDrops,
		...(finishAfter === undefined ? {} : { finishAfter }), ...(cancelAfter === undefined ? {} : { cancelAfter }),
		...(condition === undefined ? {} : { condition }) };
}

function exactOptional(tx: JsonObject, key: string, expected: unknown): void {
	if ((expected === undefined) !== !own(tx, key) || (expected !== undefined && tx[key] !== expected)) fail('TRANSACTION_BINDING_MISMATCH', `${key} changed`);
}

function validateUnsignedTransaction(terms: WorkAgreementTerms, action: WorkAgreementAction, tx: JsonObject,
	bounds: { validatedLedgerIndex: number; validatedAccountSequence: number; maxFee: bigint }): void {
	if (!exactKeys(tx, ACTION_FIELDS[action])) fail('UNSUPPORTED_TRANSACTION_FIELD', 'transaction contains an unsupported field');
	const expectedType = action === 'create' ? 'EscrowCreate' : action === 'release' ? 'EscrowFinish' : 'EscrowCancel';
	if (tx.TransactionType !== expectedType || tx.Account !== terms.owner) fail('TRANSACTION_BINDING_MISMATCH', 'transaction action or account changed');
	const fee = drops(tx.Fee, 'Fee');
	if (fee > bounds.maxFee || fee > MAX_FEE_DROPS) fail('TRANSACTION_BINDING_MISMATCH', 'transaction fee exceeds approval');
	if (uint32(tx.Sequence, 'Sequence') !== bounds.validatedAccountSequence) fail('TRANSACTION_BINDING_MISMATCH', 'transaction sequence changed');
	const lastLedger = safeInteger(tx.LastLedgerSequence, 'LastLedgerSequence');
	if (lastLedger <= bounds.validatedLedgerIndex || lastLedger > bounds.validatedLedgerIndex + MAX_LEDGER_WINDOW) fail('TRANSACTION_BINDING_MISMATCH', 'transaction ledger window is outside approval bounds');
	if (own(tx, 'SourceTag')) uint32(tx.SourceTag, 'SourceTag');
	if (own(tx, 'Memos') && !Array.isArray(tx.Memos)) fail('INVALID_REQUEST', 'Memos is invalid');
	if (action === 'create') {
		if (tx.Destination !== terms.counterparty || tx.Amount !== terms.amountDrops) fail('TRANSACTION_BINDING_MISMATCH', 'escrow destination or amount changed');
		exactOptional(tx, 'FinishAfter', terms.finishAfter); exactOptional(tx, 'CancelAfter', terms.cancelAfter); exactOptional(tx, 'Condition', terms.condition);
	} else {
		if (tx.Owner !== terms.owner) fail('TRANSACTION_BINDING_MISMATCH', 'escrow owner changed');
		uint32(tx.OfferSequence, 'OfferSequence');
		if (action === 'release') {
			exactOptional(tx, 'Condition', terms.condition);
			if (terms.condition !== undefined) {
				const fulfillment = text(tx.Fulfillment, 'Fulfillment', 1024);
				if (!HEX.test(fulfillment)) fail('INVALID_REQUEST', 'Fulfillment is invalid');
			} else if (own(tx, 'Fulfillment')) fail('UNSUPPORTED_TRANSACTION_FIELD', 'time-based release cannot include Fulfillment');
		}
	}
}

function validateApproval(terms: WorkAgreementTerms, input: WorkAgreementApproval, now: Date): WorkAgreementApproval {
	if (!plain(input) || !['create', 'release', 'cancel'].includes(input.action)) fail('INVALID_REQUEST', 'approval is invalid');
	const approvalId = id(input.approvalId, 'approvalId'); const expiresAt = iso(input.expiresAt, 'expiresAt');
	if (Date.parse(expiresAt) <= now.getTime()) fail('APPROVAL_EXPIRED', 'approval has expired');
	if (!plain(input.execution) || input.execution.require_owner_approval !== true) fail('INVALID_REQUEST', 'owner approval is required');
	const execution = { build_id: id(input.execution.build_id, 'build_id'), idempotency_key: id(input.execution.idempotency_key, 'idempotency_key'), require_owner_approval: true as const };
	const validatedLedgerIndex = safeInteger(input.validatedLedgerIndex, 'validatedLedgerIndex');
	const validatedAccountSequence = uint32(input.validatedAccountSequence, 'validatedAccountSequence');
	const maxFee = drops(input.maxFeeDrops, 'maxFeeDrops'); if (maxFee > MAX_FEE_DROPS) fail('INVALID_REQUEST', 'fee cap exceeds the local profile maximum');
	if (!plain(input.txJson)) fail('INVALID_REQUEST', 'txJson is invalid');
	validateUnsignedTransaction(terms, input.action, input.txJson, { validatedLedgerIndex, validatedAccountSequence, maxFee });
	return { action: input.action, approvalId, expiresAt, execution, validatedLedgerIndex, validatedAccountSequence, maxFeeDrops: input.maxFeeDrops, txJson: clone(input.txJson) };
}

function verifySignedBlob(approval: WorkAgreementApproval, owner: string, signedBlob: string): { hash: string; signed: JsonObject } {
	if (typeof signedBlob !== 'string' || signedBlob.length === 0 || signedBlob.length > 20_000 || !HEX.test(signedBlob)) fail('SIGNED_TRANSACTION_INVALID', 'signed transaction is invalid');
	let signed: JsonObject;
	try { signed = decode(signedBlob) as JsonObject; } catch { fail('SIGNED_TRANSACTION_INVALID', 'signed transaction could not be decoded'); }
	if (!exactKeys(signed!, [...ACTION_FIELDS[approval.action], ...SIGNED_FIELDS])) fail('SIGNED_TRANSACTION_BINDING_MISMATCH', 'signed transaction contains an unreviewed field');
	const publicKey = signed!.SigningPubKey; const signature = signed!.TxnSignature;
	if (typeof publicKey !== 'string' || typeof signature !== 'string' || own(signed!, 'Signers')) fail('SIGNED_TRANSACTION_INVALID', 'single-signing fields are missing');
	try {
		if (deriveAddress(publicKey) !== owner || !verifyKeypairSignature(encodeForSigning(signed! as Transaction), signature, publicKey)) fail('SIGNED_TRANSACTION_INVALID', 'signature does not match approved owner');
	} catch (error) { if (error instanceof WorkAgreementRuntimeError) throw error; fail('SIGNED_TRANSACTION_INVALID', 'signature could not be verified'); }
	const unsigned = { ...signed! }; delete unsigned.SigningPubKey; delete unsigned.TxnSignature;
	if (!same(unsigned, approval.txJson)) fail('SIGNED_TRANSACTION_BINDING_MISMATCH', 'signed transaction differs from owner review');
	return { hash: hashes.hashSignedTx(signedBlob).toUpperCase(), signed: signed! };
}

function validateValidatedEvidence(record: WorkAgreementRecord, result: Extract<WorkAgreementLookupResult, { status: 'validated' }>): WorkAgreementSettlementEvidence {
	const approval = record.approval!; const expectedHash = txHash(record.expectedHash);
	if (!plain(result) || !exactKeys(result, ['status', 'validated', 'hash', 'ledgerIndex', 'engineResult', 'txJson'])) fail('INVALID_EVIDENCE', 'validated result shape is invalid');
	if (result.validated !== true || result.engineResult !== 'tesSUCCESS' || txHash(result.hash) !== expectedHash) fail('INVALID_EVIDENCE', 'validated result does not match submitted transaction');
	const ledgerIndex = safeInteger(result.ledgerIndex, 'ledgerIndex');
	if (ledgerIndex > safeInteger(approval.txJson.LastLedgerSequence, 'LastLedgerSequence')) fail('INVALID_EVIDENCE', 'transaction validated outside its ledger window');
	if (!plain(result.txJson) || !exactKeys(result.txJson, [...ACTION_FIELDS[approval.action], ...SIGNED_FIELDS])) fail('INVALID_EVIDENCE', 'validated transaction contains an unreviewed field');
	let encoded: string;
	try { encoded = encode(result.txJson as Transaction); } catch { fail('INVALID_EVIDENCE', 'validated transaction could not be encoded'); }
	if (verifySignedBlob(approval, record.terms.owner, encoded!).hash !== expectedHash) fail('INVALID_EVIDENCE', 'validated transaction hash changed');
	return { approvalId: approval.approvalId, hash: expectedHash, ledgerIndex, validated: true, engineResult: 'tesSUCCESS', txJson: clone(approval.txJson) };
}

function validateNonInclusion(record: WorkAgreementRecord, result: Extract<WorkAgreementLookupResult, { status: 'not_included' }>, now: Date): void {
	const approval = record.approval!; const lastLedger = safeInteger(approval.txJson.LastLedgerSequence, 'LastLedgerSequence');
	if (!plain(result) || !exactKeys(result, ['status', 'hash', 'searchedAll', 'validatedLedgerIndex', 'checkedThroughLedger'])) fail('INVALID_EVIDENCE', 'non-inclusion result shape is invalid');
	const validatedLedgerIndex = safeInteger(result.validatedLedgerIndex, 'validatedLedgerIndex');
	const checkedThroughLedger = safeInteger(result.checkedThroughLedger, 'checkedThroughLedger');
	if (txHash(result.hash) !== txHash(record.expectedHash) || result.searchedAll !== true ||
		checkedThroughLedger !== lastLedger || validatedLedgerIndex <= lastLedger || now.getTime() < Date.parse(approval.expiresAt)) fail('INVALID_EVIDENCE', 'non-inclusion proof is incomplete or premature');
}

function assertPrincipal(value: string): void { if (!PRINCIPAL.test(value)) fail('INVALID_REQUEST', 'principal is invalid'); }
function assertOwnerNetwork(record: WorkAgreementRecord, owner: string, network: string): void {
	if (network !== 'testnet') fail('NETWORK_UNSUPPORTED', 'only the fixed local Testnet mock profile is supported');
	if (record.terms.owner !== owner || record.terms.network !== network) {
		fail('AUTH_BINDING_MISMATCH', 'owner or network binding changed');
	}
}
function assertScope(record: WorkAgreementRecord, owner: string, network: string, approvalId: string, idempotencyKey: string): void {
	assertOwnerNetwork(record, owner, network);
	if (record.approval?.approvalId !== approvalId ||
		record.approval?.execution.idempotency_key !== idempotencyKey) {
		fail('AUTH_BINDING_MISMATCH', 'approval or idempotency binding changed');
	}
}
function nextRecord(record: WorkAgreementRecord, now: Date, changes: Partial<WorkAgreementRecord>): WorkAgreementRecord {
	return { ...record, ...changes, revision: record.revision + 1, updatedAt: now.toISOString() };
}
function withoutTransient(record: WorkAgreementRecord, changes: Partial<WorkAgreementRecord>): WorkAgreementRecord {
	const next = { ...record }; delete next.action; delete next.approval; delete next.attemptId;
	delete next.expectedHash; delete next.dispatchError; return { ...next, ...changes };
}
const UNAVAILABLE_EFFECTS: WorkAgreementEffects = {
	async dispatch() { fail('EFFECT_UNAVAILABLE', 'no local mock dispatch effect was injected'); },
	async lookup() { fail('EFFECT_UNAVAILABLE', 'no local mock lookup effect was injected'); },
};

export class WorkAgreementRuntime {
	readonly #store: WorkAgreementStore;
	readonly #effects: WorkAgreementEffects;
	readonly #enabled: boolean;
	readonly #now: () => Date;

	constructor(input: { store: WorkAgreementStore; effects?: WorkAgreementEffects; enabled?: boolean; now?: () => Date }) {
		this.#store = input.store; this.#effects = input.effects ?? UNAVAILABLE_EFFECTS;
		this.#enabled = input.enabled ?? false; this.#now = input.now ?? (() => new Date());
	}

	async get(input: { principal: string; agreementId: string }): Promise<WorkAgreementRecord | null> {
		assertPrincipal(input.principal); id(input.agreementId, 'agreementId');
		const record = await this.#store.get(input.principal, input.agreementId); return record === null ? null : clone(record);
	}

	async prepare(input: { principal: string; terms: WorkAgreementTerms; approval: WorkAgreementApproval }): Promise<{ record: WorkAgreementRecord; outcome: 'prepared' | 'replay' }> {
		this.#assertEnabled(); assertPrincipal(input.principal);
		const now = this.#nowValue(); const terms = validateTerms(input.terms); const approval = validateApproval(terms, input.approval, now);
		const current = await this.#store.get(input.principal, terms.agreementId);
		if (current === null) {
			if (approval.action !== 'create') fail('INVALID_STATE', 'agreement must be created first');
			const record: WorkAgreementRecord = {
				profile: WORK_AGREEMENT_LOCAL_PROFILE.id, principal: input.principal, revision: 0, status: 'awaiting_approval',
				terms, action: approval.action, approval,
				history: { approvalIds: [approval.approvalId], idempotencyKeys: [approval.execution.idempotency_key], attemptIds: [] },
				createdAt: now.toISOString(), updatedAt: now.toISOString(),
			};
			if (await this.#store.insert(record)) return { record: clone(record), outcome: 'prepared' };
			const raced = await this.#store.get(input.principal, terms.agreementId);
			if (raced === null && await this.#isReplay(input.principal, approval.approvalId, approval.execution.idempotency_key)) fail('REPLAY_DETECTED', 'approval or idempotency key was already used');
			if (raced === null) fail('STATE_RACE', 'agreement claim failed without durable state');
			return this.#prepareReplay(raced, terms, approval);
		}
		if (current.status === 'awaiting_approval' && same(current.terms, terms) && same(current.approval, approval)) return { record: clone(current), outcome: 'replay' };
		if (!same(current.terms, terms)) fail('AGREEMENT_BINDING_MISMATCH', 'agreement terms cannot change');
		if (current.history.approvalIds.includes(approval.approvalId) || current.history.idempotencyKeys.includes(approval.execution.idempotency_key)) fail('REPLAY_DETECTED', 'approval or idempotency key was already used');
		const allowed = approval.action === 'create' ? current.status === 'rejected' || current.status === 'expired' : current.status === 'active';
		if (!allowed) fail('INVALID_STATE', 'agreement action is not available in this state');
		if (approval.action !== 'create' && (current.offerSequence === undefined || approval.txJson.OfferSequence !== current.offerSequence)) fail('TRANSACTION_BINDING_MISMATCH', 'escrow offer sequence changed');
		const next = nextRecord(current, now, { status: 'awaiting_approval', action: approval.action, approval,
			history: { approvalIds: [...current.history.approvalIds, approval.approvalId], idempotencyKeys: [...current.history.idempotencyKeys, approval.execution.idempotency_key], attemptIds: [...current.history.attemptIds] } });
		if (await this.#store.compareAndSwap(input.principal, terms.agreementId, current.revision, next)) return { record: clone(next), outcome: 'prepared' };
		const raced = await this.#required(input.principal, terms.agreementId);
		if (await this.#isReplay(input.principal, approval.approvalId, approval.execution.idempotency_key) &&
			!(raced.status === 'awaiting_approval' && same(raced.approval, approval))) fail('REPLAY_DETECTED', 'approval or idempotency key was already used');
		return this.#prepareReplay(raced, terms, approval);
	}

	async submit(input: { principal: string; agreementId: string; owner: string; network: 'testnet'; approvalId: string; idempotencyKey: string; attemptId: string; signedBlob: string }): Promise<{ record: WorkAgreementRecord; outcome: 'submitted' | 'replay' | 'unknown' }> {
		this.#assertEnabled(); assertPrincipal(input.principal); id(input.agreementId, 'agreementId'); id(input.approvalId, 'approvalId');
		id(input.idempotencyKey, 'idempotencyKey'); id(input.attemptId, 'attemptId'); address(input.owner, 'owner');
		const now = this.#nowValue(); const current = await this.#required(input.principal, input.agreementId);
		assertOwnerNetwork(current, input.owner, input.network);
		if (current.lastResolution?.approvalId === input.approvalId &&
			current.lastResolution.idempotencyKey === input.idempotencyKey &&
			current.lastResolution.outcome === 'validated' &&
			current.history.attemptIds.includes(input.attemptId)) {
			const evidence = current.lastResolution.action === 'create' ? current.createEvidence : current.terminalEvidence;
			let replayHash: string;
			try { replayHash = hashes.hashSignedTx(input.signedBlob).toUpperCase(); }
			catch { fail('SIGNED_TRANSACTION_INVALID', 'signed transaction is invalid'); }
			if (evidence?.hash !== replayHash) fail('REPLAY_DETECTED', 'resolved submission replay changed');
			return { record: clone(current), outcome: 'replay' };
		}
		assertScope(current, input.owner, input.network, input.approvalId, input.idempotencyKey);
		if (current.status !== 'awaiting_approval') return this.#submitReplay(current, input.attemptId);
		const approval = current.approval!;
		if (now.getTime() >= Date.parse(approval.expiresAt)) {
			const expired = nextRecord(withoutTransient(current, { status: approval.action === 'create' ? 'expired' : 'active',
				lastResolution: { approvalId: approval.approvalId, idempotencyKey: approval.execution.idempotency_key, action: approval.action, outcome: 'not_included' } }), now, {});
			await this.#store.compareAndSwap(input.principal, input.agreementId, current.revision, expired); fail('APPROVAL_EXPIRED', 'approval has expired');
		}
		if (current.history.attemptIds.includes(input.attemptId)) fail('REPLAY_DETECTED', 'attempt was already used');
		const verified = verifySignedBlob(approval, input.owner, input.signedBlob);
		const claimed = nextRecord(current, now, { status: 'submitting', attemptId: input.attemptId, expectedHash: verified.hash,
			history: { ...current.history, attemptIds: [...current.history.attemptIds, input.attemptId] } });
		if (!await this.#store.compareAndSwap(input.principal, input.agreementId, current.revision, claimed)) {
			const raced = await this.#required(input.principal, input.agreementId);
			if (await this.#store.hasReplay?.(input.principal, { attemptId: input.attemptId }) && raced.attemptId !== input.attemptId) fail('REPLAY_DETECTED', 'attempt was already used');
			return this.#submitReplay(raced, input.attemptId);
		}
		let dispatchError: string | undefined;
		try {
			await this.#effects.dispatch({ profile: WORK_AGREEMENT_LOCAL_PROFILE.id, principal: input.principal, agreementId: input.agreementId,
				action: approval.action, approvalId: approval.approvalId, idempotencyKey: approval.execution.idempotency_key,
				attemptId: input.attemptId, hash: verified.hash, signedBlob: input.signedBlob });
		} catch { dispatchError = 'mock dispatch outcome is unknown'; }
		const unknown = nextRecord(claimed, this.#nowValue(), { status: 'unknown', ...(dispatchError === undefined ? {} : { dispatchError }) });
		const moved = await this.#store.compareAndSwap(input.principal, input.agreementId, claimed.revision, unknown);
		const record = moved ? unknown : await this.#required(input.principal, input.agreementId);
		return { record: clone(record), outcome: dispatchError === undefined ? 'submitted' : 'unknown' };
	}

	async reject(input: { principal: string; agreementId: string; owner: string; network: 'testnet'; approvalId: string; idempotencyKey: string }): Promise<{ record: WorkAgreementRecord; outcome: 'rejected' | 'replay' }> {
		this.#assertEnabled(); assertPrincipal(input.principal); id(input.approvalId, 'approvalId'); id(input.idempotencyKey, 'idempotencyKey');
		const current = await this.#required(input.principal, id(input.agreementId, 'agreementId'));
		assertOwnerNetwork(current, address(input.owner, 'owner'), input.network);
		if (current.lastResolution?.approvalId === input.approvalId && current.lastResolution.idempotencyKey === input.idempotencyKey && current.lastResolution.outcome === 'rejected') return { record: clone(current), outcome: 'replay' };
		assertScope(current, input.owner, input.network, input.approvalId, input.idempotencyKey);
		if (current.status !== 'awaiting_approval') fail('INVALID_STATE', 'approval cannot be rejected in this state');
		const approval = current.approval!;
		const next = nextRecord(withoutTransient(current, { status: approval.action === 'create' ? 'rejected' : 'active',
			lastResolution: { approvalId: approval.approvalId, idempotencyKey: approval.execution.idempotency_key, action: approval.action, outcome: 'rejected' } }), this.#nowValue(), {});
		if (!await this.#store.compareAndSwap(input.principal, input.agreementId, current.revision, next)) {
			const raced = await this.#required(input.principal, input.agreementId);
			if (raced.lastResolution?.approvalId === input.approvalId && raced.lastResolution.idempotencyKey === input.idempotencyKey && raced.lastResolution.outcome === 'rejected') return { record: clone(raced), outcome: 'replay' };
			fail('STATE_RACE', 'agreement changed while rejecting approval');
		}
		return { record: clone(next), outcome: 'rejected' };
	}

	async recover(input: { principal: string; agreementId: string; owner: string; network: 'testnet'; approvalId: string; idempotencyKey: string }): Promise<{ record: WorkAgreementRecord; outcome: 'pending' | 'validated' | 'not_included' }> {
		this.#assertEnabled(); assertPrincipal(input.principal); id(input.approvalId, 'approvalId'); id(input.idempotencyKey, 'idempotencyKey');
		let current = await this.#required(input.principal, id(input.agreementId, 'agreementId'));
		assertOwnerNetwork(current, address(input.owner, 'owner'), input.network);
		if (current.lastResolution?.approvalId === input.approvalId &&
			current.lastResolution.idempotencyKey === input.idempotencyKey) {
			if (current.lastResolution.outcome === 'validated') return { record: clone(current), outcome: 'validated' };
			if (current.lastResolution.outcome === 'not_included') return { record: clone(current), outcome: 'not_included' };
		}
		assertScope(current, input.owner, input.network, input.approvalId, input.idempotencyKey);
		if (current.status === 'submitting') {
			const unknown = nextRecord(current, this.#nowValue(), { status: 'unknown', dispatchError: 'recovered after interrupted dispatch' });
			if (await this.#store.compareAndSwap(input.principal, input.agreementId, current.revision, unknown)) current = unknown;
			else current = await this.#required(input.principal, input.agreementId);
		}
		if (current.status !== 'unknown') fail('INVALID_STATE', 'agreement is not awaiting reconciliation');
		const approval = current.approval!;
		const result = await this.#effects.lookup({ profile: WORK_AGREEMENT_LOCAL_PROFILE.id, principal: input.principal,
			agreementId: input.agreementId, action: approval.action, approvalId: approval.approvalId,
			idempotencyKey: approval.execution.idempotency_key, hash: txHash(current.expectedHash) });
		if (txHash(result.hash) !== txHash(current.expectedHash)) fail('INVALID_EVIDENCE', 'lookup returned a different transaction');
		if (result.status === 'pending') {
			if (!plain(result) || !exactKeys(result, ['status', 'hash'])) fail('INVALID_EVIDENCE', 'pending result shape is invalid');
			return { record: clone(current), outcome: 'pending' };
		}
		const now = this.#nowValue();
		if (result.status === 'validated') {
			const evidence = validateValidatedEvidence(current, result);
			const status: WorkAgreementStatus = approval.action === 'create' ? 'active' : approval.action === 'release' ? 'released' : 'cancelled';
			const resolved = nextRecord(withoutTransient(current, { status,
				lastResolution: { approvalId: approval.approvalId, idempotencyKey: approval.execution.idempotency_key, action: approval.action, outcome: 'validated' },
				...(approval.action === 'create' ? { createEvidence: evidence, offerSequence: approval.txJson.Sequence as number } : { terminalEvidence: evidence }) }), now, {});
			if (!await this.#store.compareAndSwap(input.principal, input.agreementId, current.revision, resolved)) fail('STATE_RACE', 'agreement changed while applying settlement evidence');
			return { record: clone(resolved), outcome: 'validated' };
		}
		validateNonInclusion(current, result, now);
		const resolved = nextRecord(withoutTransient(current, { status: approval.action === 'create' ? 'expired' : 'active',
			lastResolution: { approvalId: approval.approvalId, idempotencyKey: approval.execution.idempotency_key, action: approval.action, outcome: 'not_included' } }), now, {});
		if (!await this.#store.compareAndSwap(input.principal, input.agreementId, current.revision, resolved)) fail('STATE_RACE', 'agreement changed while applying non-inclusion proof');
		return { record: clone(resolved), outcome: 'not_included' };
	}

	#assertEnabled(): void { if (!this.#enabled) fail('FEATURE_DISABLED', 'local work-agreement runtime is disabled'); }
	#nowValue(): Date {
		const value = this.#now(); if (!Number.isFinite(value.getTime())) fail('INVALID_TIME', 'clock returned an invalid time'); return value;
	}
	async #required(principal: string, agreementId: string): Promise<WorkAgreementRecord> {
		const record = await this.#store.get(principal, agreementId); if (record === null) fail('AGREEMENT_NOT_FOUND', 'agreement was not found'); return record;
	}
	async #isReplay(principal: string, approvalId: string, idempotencyKey: string): Promise<boolean> {
		return this.#store.hasReplay?.(principal, { approvalId, idempotencyKey }) ?? false;
	}
	#prepareReplay(record: WorkAgreementRecord, terms: WorkAgreementTerms, approval: WorkAgreementApproval): { record: WorkAgreementRecord; outcome: 'replay' } {
		if (record.status === 'awaiting_approval' && same(record.terms, terms) && same(record.approval, approval)) return { record: clone(record), outcome: 'replay' };
		fail('STATE_RACE', 'a different agreement request won the claim');
	}
	#submitReplay(record: WorkAgreementRecord, attemptId: string): { record: WorkAgreementRecord; outcome: 'replay' } {
		if (record.attemptId === attemptId && record.history.attemptIds.includes(attemptId) && ['submitting', 'unknown'].includes(record.status)) return { record: clone(record), outcome: 'replay' };
		fail('INVALID_STATE', 'agreement is not awaiting this submission');
	}
}

function validatePersistedEvidence(
	record: WorkAgreementRecord,
	evidence: WorkAgreementSettlementEvidence,
	action: WorkAgreementAction,
): void {
	if (!plain(evidence) || !exactKeys(evidence, ['approvalId', 'hash', 'ledgerIndex', 'validated', 'engineResult', 'txJson']) ||
		evidence.validated !== true || evidence.engineResult !== 'tesSUCCESS' || !plain(evidence.txJson) ||
		own(evidence.txJson, 'SigningPubKey') || own(evidence.txJson, 'TxnSignature') ||
		!record.history.approvalIds.includes(id(evidence.approvalId, 'approvalId'))) {
		fail('CORRUPT_STATE', 'persisted settlement evidence is invalid');
	}
	txHash(evidence.hash); const ledgerIndex = safeInteger(evidence.ledgerIndex, 'ledgerIndex');
	const sequence = uint32(evidence.txJson.Sequence, 'Sequence');
	const lastLedger = safeInteger(evidence.txJson.LastLedgerSequence, 'LastLedgerSequence');
	if (ledgerIndex > lastLedger) fail('CORRUPT_STATE', 'settlement evidence is outside the ledger window');
	validateUnsignedTransaction(record.terms, action, evidence.txJson, {
		validatedLedgerIndex: lastLedger - 1,
		validatedAccountSequence: sequence,
		maxFee: drops(evidence.txJson.Fee, 'Fee'),
	});
}

/** Strict decoder used by durable stores before returning persisted state. */
export function parseWorkAgreementRecord(value: unknown): WorkAgreementRecord {
	if (!plain(value) || value.profile !== WORK_AGREEMENT_LOCAL_PROFILE.id || typeof value.principal !== 'string' ||
		typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
		typeof value.status !== 'string' || !['awaiting_approval', 'submitting', 'unknown', 'active', 'released', 'cancelled', 'rejected', 'expired'].includes(value.status) ||
		!plain(value.terms) || !plain(value.history) || !Array.isArray(value.history.approvalIds) || !Array.isArray(value.history.idempotencyKeys) ||
		!Array.isArray(value.history.attemptIds) || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') fail('CORRUPT_STATE', 'persisted work agreement is invalid');
	if (!exactKeys(value, ['profile', 'principal', 'revision', 'status', 'terms', 'history', 'action', 'approval',
		'attemptId', 'expectedHash', 'offerSequence', 'createEvidence', 'terminalEvidence', 'lastResolution',
		'dispatchError', 'createdAt', 'updatedAt']) ||
		!exactKeys(value.history, ['approvalIds', 'idempotencyKeys', 'attemptIds'])) {
		fail('CORRUPT_STATE', 'persisted work agreement contains unsupported fields');
	}
	const serialized = JSON.stringify(value);
	if (/"signedBlob"|"signed_blob"|"tx_blob"/.test(serialized)) fail('CORRUPT_STATE', 'persisted state contains a signed blob');
	assertPrincipal(value.principal); const terms = validateTerms(value.terms as unknown as WorkAgreementTerms);
	if (!same(terms, value.terms)) fail('CORRUPT_STATE', 'persisted agreement terms are not canonical');
	const createdAt = iso(value.createdAt, 'createdAt'); const updatedAt = iso(value.updatedAt, 'updatedAt');
	if (Date.parse(updatedAt) < Date.parse(createdAt)) fail('CORRUPT_STATE', 'persisted timestamps are inconsistent');
	for (const item of value.history.approvalIds) id(item, 'approvalId');
	for (const item of value.history.idempotencyKeys) id(item, 'idempotency_key');
	for (const item of value.history.attemptIds) id(item, 'attemptId');
	for (const items of [value.history.approvalIds, value.history.idempotencyKeys, value.history.attemptIds]) {
		if (new Set(items).size !== items.length) fail('CORRUPT_STATE', 'persisted replay history contains duplicates');
	}
	const record = clone(value) as unknown as WorkAgreementRecord;
	const pending = ['awaiting_approval', 'submitting', 'unknown'].includes(record.status);
	if (pending) {
		if (!record.approval || !record.action || record.approval.action !== record.action) fail('CORRUPT_STATE', 'pending state is missing approval');
		const expiresAt = iso(record.approval.expiresAt, 'expiresAt');
		const checked = validateApproval(terms, record.approval, new Date(Date.parse(expiresAt) - 1));
		if (!same(checked, record.approval) || record.history.approvalIds.at(-1) !== record.approval.approvalId ||
			record.history.idempotencyKeys.at(-1) !== record.approval.execution.idempotency_key) fail('CORRUPT_STATE', 'pending approval is inconsistent with replay history');
	} else if (record.approval !== undefined || record.action !== undefined || record.attemptId !== undefined || record.expectedHash !== undefined) {
		fail('CORRUPT_STATE', 'resolved state retains transient submission data');
	}
	if (record.status === 'awaiting_approval') {
		if (record.attemptId !== undefined || record.expectedHash !== undefined) fail('CORRUPT_STATE', 'unsubmitted approval has submission data');
	} else if (record.status === 'submitting' || record.status === 'unknown') {
		if (record.attemptId === undefined || record.history.attemptIds.at(-1) !== record.attemptId) fail('CORRUPT_STATE', 'submission attempt is inconsistent');
		id(record.attemptId, 'attemptId'); txHash(record.expectedHash);
	}
	if (record.offerSequence !== undefined) uint32(record.offerSequence, 'offerSequence');
	if (['active', 'released', 'cancelled'].includes(record.status) && (record.offerSequence === undefined || record.createEvidence === undefined)) fail('CORRUPT_STATE', 'settled agreement is missing create evidence');
	if ((record.status === 'released' || record.status === 'cancelled') && record.terminalEvidence === undefined) fail('CORRUPT_STATE', 'terminal agreement is missing terminal evidence');
	if (record.createEvidence !== undefined) {
		validatePersistedEvidence(record, record.createEvidence, 'create');
		if (record.offerSequence !== record.createEvidence.txJson.Sequence) fail('CORRUPT_STATE', 'persisted offer sequence changed');
	}
	if (record.terminalEvidence !== undefined) {
		if (record.status !== 'released' && record.status !== 'cancelled') fail('CORRUPT_STATE', 'nonterminal agreement contains terminal evidence');
		validatePersistedEvidence(record, record.terminalEvidence, record.status === 'released' ? 'release' : 'cancel');
		if (record.terminalEvidence.txJson.OfferSequence !== record.offerSequence) fail('CORRUPT_STATE', 'terminal offer sequence changed');
	}
	if (record.lastResolution !== undefined) {
		if (!record.history.approvalIds.includes(id(record.lastResolution.approvalId, 'approvalId')) ||
			!record.history.idempotencyKeys.includes(id(record.lastResolution.idempotencyKey, 'idempotencyKey')) ||
			!['create', 'release', 'cancel'].includes(record.lastResolution.action) ||
			!['validated', 'rejected', 'not_included'].includes(record.lastResolution.outcome)) fail('CORRUPT_STATE', 'last resolution is invalid');
	}
	if (record.dispatchError !== undefined && (record.status !== 'unknown' || typeof record.dispatchError !== 'string')) fail('CORRUPT_STATE', 'dispatch error is invalid');
	return record;
}
