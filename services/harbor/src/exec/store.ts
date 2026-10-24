import {
	ExecutionCapabilitySchema,
	NetworkSchema,
	PolicySchema,
	TxBuildSchema,
	type AccountLink,
	type ExecResult,
	type ExecutionCapability,
	type Network,
	type Policy,
	type TxBuild,
} from '../contracts';

export type LinkStatus = AccountLink['status'];
export type ExecutionStatus = 'pending' | 'submitted' | ExecResult['status'];
export type ApprovalStatus =
	| 'pending'
	| 'preflighted'
	| 'submitted'
	| 'approved'
	| 'expired'
	| 'rejected'
	| 'invalidated';
export type SignedBy = 'delegate' | 'owner';
export type V2ExecutionContract = 'xrpl_execution_v2';
export type V2Network = Extract<Network, 'testnet' | 'devnet'>;

export type JsonObject = Record<string, unknown>;
export type BuildOriginProfile =
	| 'local-trading'
	| 'local-trading-onboarding'
	| 'local-trading-isolated-v1'
	| 'local-trading-isolated-onboarding-v1';

export type LinkKeyBackend = 'local' | 'kms';

interface LinkRowBase {
	id: string;
	principal: string;
	owner: string;
	network: Network;
	delegate: string;
	permissions: string[];
	status: LinkStatus;
	lastLedger: number | null;
	revokeTx: JsonObject | null;
	createdAt: string;
}

export interface LocalLinkRow extends LinkRowBase {
	keyBackend: 'local';
	delegateSeedEnc: ArrayBuffer;
	iv: ArrayBuffer;
	kmsKeyId: null;
	kmsAlias: null;
}

export interface KmsLinkRow extends LinkRowBase {
	keyBackend: 'kms';
	delegateSeedEnc: null;
	iv: null;
	kmsKeyId: string;
	kmsAlias: string;
}

export type LinkRow = LocalLinkRow | KmsLinkRow;

type LocalLinkInsert = Omit<LocalLinkRow, 'principal' | 'keyBackend' | 'kmsKeyId' | 'kmsAlias'> & {
	/** Omitted for backwards-compatible callers; persisted rows always expose `local`. */
	keyBackend?: 'local';
	kmsKeyId?: null;
	kmsAlias?: null;
};

export type LinkInsert = LocalLinkInsert | Omit<KmsLinkRow, 'principal'>;
export type LinkUpdate = Partial<
	Pick<LinkRow, 'delegate' | 'delegateSeedEnc' | 'iv' | 'permissions' | 'status' | 'lastLedger' | 'revokeTx'>
>;

export interface PolicyRow {
	principal: string;
	owner: string;
	network: Network;
	json: Policy;
	updatedAt: string;
}

export type PolicyInsert = Omit<PolicyRow, 'principal'>;
export type PolicyUpdate = Partial<Pick<PolicyRow, 'json' | 'updatedAt'>>;

export interface BuildRow {
	id: string;
	principal: string;
	owner: string;
	network: Network;
	txJson: JsonObject;
	summary: TxBuild['summary'];
	lastLedgerSeq: number;
	createdAt: string;
	originProfile: BuildOriginProfile | null;
	executionContract?: V2ExecutionContract | null;
	buildRevision?: number | null;
}

export interface AcquisitionBalanceInvariant {
	kind: 'issued_balance_unchanged';
	currency: string;
	issuer: string;
	balance: string;
	ledgerIndex: number;
}

export interface BuildRevisionFields {
	executionContract: V2ExecutionContract;
	buildRevision: number;
	unsignedTxDigest: string;
	unsignedTxDigestAlg: 'sha256-jcs-v1';
	economicFingerprint: string;
	economicFingerprintAlg: 'sha256-jcs-economic-v1';
	buildLedger: number;
	firstInclusionLedger: number;
	lastLedgerSequence: number;
	minimumRemainingLedgers: 8;
	approvalExpiresInSeconds: 90;
	quoteLedger: number | null;
	quoteValidThroughLedger: number | null;
	acquisitionBalanceInvariant: AcquisitionBalanceInvariant | null;
}

export interface BuildRevisionRow extends BuildRevisionFields {
	principal: string;
	buildId: string;
	owner: string;
	network: V2Network;
	txJson: JsonObject;
	summary: TxBuild['summary'];
	createdAt: string;
}

export type BuildRevisionInsert = Omit<BuildRevisionRow, 'principal'>;

export type BuildInsert = Omit<BuildRow, 'principal' | 'originProfile'> &
	Partial<BuildRevisionFields> & {
	originProfile?: BuildOriginProfile | null;
	executionCapability?: ExecutionCapability;
};
export type BuildUpdate = Partial<Pick<BuildRow, 'txJson' | 'summary' | 'lastLedgerSeq'>>;

export interface ExecutionRow {
	id: string;
	principal: string;
	buildId: string;
	idempotencyKey: string;
	status: ExecutionStatus;
	hash: string | null;
	usdValue: number | null;
	signedBy: SignedBy | null;
	createdAt: string;
}

export type ExecutionInsert = Omit<ExecutionRow, 'principal'>;
export type ExecutionUpdate = Partial<Pick<ExecutionRow, 'status' | 'hash' | 'usdValue' | 'signedBy'>>;

export interface ApprovalRow {
	id: string;
	principal: string;
	buildId: string;
	txJson: JsonObject;
	expiresAt: string;
	status: ApprovalStatus;
	executionId: string | null;
	executionContract: V2ExecutionContract | null;
	buildRevision: number | null;
}

export type ApprovalInsert = Omit<ApprovalRow, 'principal' | 'executionId' | 'executionContract' | 'buildRevision'> & {
	executionId?: string | null;
	executionContract?: V2ExecutionContract | null;
	buildRevision?: number | null;
};
export type ApprovalUpdate = Partial<Pick<ApprovalRow, 'txJson' | 'expiresAt' | 'status'>>;

export interface ExecutionSnapshotRow {
	executionId: string;
	principal: string;
	buildId: string;
	executionContract: V2ExecutionContract;
	buildRevision: number;
	policySnapshot: Policy;
	policyRevision: string;
	unsignedTxDigest: string;
	unsignedTxDigestAlg: 'sha256-jcs-v1';
	economicFingerprint: string;
	economicFingerprintAlg: 'sha256-jcs-economic-v1';
	snapshotOwner: string;
	snapshotNetwork: V2Network;
	snapshotSequence: number;
	firstInclusionLedger: number;
	lastLedgerSequence: number;
	approvalId: string | null;
	approvalExpiresAt: string | null;
	acquisitionBalanceInvariant: AcquisitionBalanceInvariant | null;
	createdAt: string;
}

export type ExecutionSnapshotInsert = Omit<ExecutionSnapshotRow, 'principal'>;

export interface RelayClaimRow {
	principal: string;
	executionId: string;
	hash: string;
	attemptedAt: string;
}

export type RelayClaimInsert = Omit<RelayClaimRow, 'principal'>;

export interface EventRow {
	id: string;
	principal: string;
	owner: string;
	kind: string;
	detail: JsonObject;
	createdAt: string;
}

export type EventInsert = Omit<EventRow, 'principal'>;
export type EventUpdate = Partial<Pick<EventRow, 'kind' | 'detail'>>;

type RawLink = {
	id: string;
	principal: string;
	owner: string;
	network: string;
	delegate: string;
	delegate_seed_enc: unknown;
	iv: unknown;
	delegate_seed_enc_hex?: string;
	iv_hex?: string;
	key_backend?: unknown;
	kms_key_id?: unknown;
	kms_alias?: unknown;
	permissions: string;
	status: string;
	last_ledger: number | null;
	revoke_tx: string | null;
	created_at: string;
};

type RawPolicy = {
	principal: string;
	owner: string;
	network: string;
	json: string;
	updated_at: string;
};

type RawBuild = {
	id: string;
	principal: string;
	owner: string;
	network: string;
	tx_json: string;
	summary: string;
	last_ledger_seq: number;
	created_at: string;
	origin_profile: string | null;
	execution_contract?: unknown;
	build_revision?: unknown;
};

type RawBuildRevision = {
	principal: string;
	build_id: string;
	build_revision: unknown;
	execution_contract: unknown;
	owner: string;
	network: string;
	tx_json: string;
	summary: string;
	unsigned_tx_digest: unknown;
	unsigned_tx_digest_alg: unknown;
	economic_fingerprint: unknown;
	economic_fingerprint_alg: unknown;
	build_ledger: unknown;
	first_inclusion_ledger: unknown;
	last_ledger_sequence: unknown;
	minimum_remaining_ledgers: unknown;
	approval_expires_in_seconds: unknown;
	quote_ledger: unknown;
	quote_valid_through_ledger: unknown;
	acquisition_balance_invariant: string | null;
	created_at: string;
};

type RawExecution = {
	id: string;
	principal: string;
	build_id: string;
	idempotency_key: string;
	status: string;
	hash: string | null;
	usd_value: number | null;
	signed_by: string | null;
	created_at: string;
};

type RawApproval = {
	id: string;
	principal: string;
	build_id: string;
	tx_json: string;
	expires_at: string;
	status: string;
	execution_id?: unknown;
	execution_contract?: unknown;
	build_revision?: unknown;
};

type RawExecutionSnapshot = {
	execution_id: string;
	principal: string;
	build_id: string;
	execution_contract: unknown;
	build_revision: unknown;
	policy_snapshot: string;
	policy_revision: unknown;
	unsigned_tx_digest: unknown;
	unsigned_tx_digest_alg: unknown;
	economic_fingerprint: unknown;
	economic_fingerprint_alg: unknown;
	snapshot_owner: string;
	snapshot_network: string;
	snapshot_sequence: unknown;
	first_inclusion_ledger: unknown;
	last_ledger_sequence: unknown;
	approval_id: unknown;
	approval_expires_at: unknown;
	acquisition_balance_invariant: string | null;
	created_at: string;
};

type RawRelayClaim = {
	principal: string;
	execution_id: string;
	hash: unknown;
	attempted_at: string;
};

type RawEvent = {
	id: string;
	principal: string;
	owner: string;
	kind: string;
	detail: string;
	created_at: string;
};

type MutableValue = string | number | null | ArrayBuffer;

const LINK_STATUS = new Set<LinkStatus>(['pending', 'active', 'suspended', 'revoked']);
const EXECUTION_STATUS = new Set<ExecutionStatus>(['pending', 'submitted', 'executed', 'needs_approval', 'blocked', 'failed']);
const APPROVAL_STATUS = new Set<ApprovalStatus>([
	'pending',
	'preflighted',
	'submitted',
	'approved',
	'expired',
	'rejected',
	'invalidated',
]);
const SIGNED_BY = new Set<SignedBy>(['delegate', 'owner']);
const BUILD_ORIGIN_PROFILE = new Set<BuildOriginProfile>([
	'local-trading',
	'local-trading-onboarding',
	'local-trading-isolated-v1',
	'local-trading-isolated-onboarding-v1',
]);
const SENSITIVE_KEY_FRAGMENT = /seed|secret|private|mnemonic/i;
const SENSITIVE_VALUE_FRAGMENT = /(?:^|[^a-z0-9])(?:seed|secret|private|mnemonic)(?:$|[^a-z0-9])/i;
const UPPER_HEX_64 = /^[0-9A-F]{64}$/;
const V2_BUILD_FIELD_KEYS = [
	'executionContract',
	'buildRevision',
	'unsignedTxDigest',
	'unsignedTxDigestAlg',
	'economicFingerprint',
	'economicFingerprintAlg',
	'buildLedger',
	'firstInclusionLedger',
	'lastLedgerSequence',
	'minimumRemainingLedgers',
	'approvalExpiresInSeconds',
	'quoteLedger',
	'quoteValidThroughLedger',
	'acquisitionBalanceInvariant',
] as const satisfies readonly (keyof BuildRevisionFields)[];

export class StoreDataError extends Error {
	constructor(
		message: string,
		readonly cause?: unknown,
	) {
		super(message);
		this.name = 'StoreDataError';
	}
}

function parseJson<T>(value: string, field: string, validate: (parsed: unknown) => T): T {
	try {
		const parsed = validate(JSON.parse(value));
		assertJsonValue(parsed, new WeakSet<object>());
		return parsed;
	} catch (cause) {
		throw new StoreDataError(`Invalid JSON stored in ${field}`, cause);
	}
}

function serializeJson(value: unknown, field: string, validate: (candidate: unknown) => unknown = (candidate) => candidate): string {
	try {
		const validated = validate(value);
		assertJsonValue(validated, new WeakSet<object>());
		const json = JSON.stringify(validated);
		if (json === undefined) {
			throw new TypeError('value is not JSON serializable');
		}
		return json;
	} catch (cause) {
		throw new StoreDataError(`Could not serialize ${field}`, cause);
	}
}

function asObject(value: unknown): JsonObject {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new TypeError('expected a JSON object');
	}
	assertJsonValue(value, new WeakSet<object>());
	return value as JsonObject;
}

function assertJsonValue(value: unknown, ancestors: WeakSet<object>): void {
	if (value === null || typeof value === 'boolean') {
		return;
	}
	if (typeof value === 'string') {
		if (SENSITIVE_VALUE_FRAGMENT.test(value)) {
			throw new TypeError('sensitive material is not accepted');
		}
		return;
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new TypeError('expected a finite number');
		return;
	}
	if (typeof value !== 'object') {
		throw new TypeError('expected a JSON value');
	}
	if (ancestors.has(value)) throw new TypeError('cyclic JSON value');
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			for (const item of value) assertJsonValue(item, ancestors);
			return;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError('expected a plain JSON object');
		}
		if (Object.getOwnPropertySymbols(value).length > 0) {
			throw new TypeError('symbol keys are not JSON serializable');
		}
		for (const [key, item] of Object.entries(value)) {
			if (SENSITIVE_KEY_FRAGMENT.test(key)) {
				throw new TypeError('sensitive material is not accepted');
			}
			assertJsonValue(item, ancestors);
		}
	} finally {
		ancestors.delete(value);
	}
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 10 || !value.every((item) => typeof item === 'string')) {
		throw new TypeError('expected an array of strings');
	}
	return value;
}

function asStatus<T extends string>(value: string, allowed: Set<T>, field: string): T {
	if (!allowed.has(value as T)) {
		throw new StoreDataError(`Invalid value stored in ${field}`);
	}
	return value as T;
}

function network(value: string, field: string): Network {
	try {
		return NetworkSchema.parse(value);
	} catch (cause) {
		throw new StoreDataError(`Invalid network stored in ${field}`, cause);
	}
}

function v2Network(value: unknown, field: string): V2Network {
	if (value !== 'testnet' && value !== 'devnet') {
		throw new StoreDataError(`Invalid network stored in ${field}`);
	}
	return value;
}

function nonEmptyString(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new StoreDataError(`Invalid value stored in ${field}`);
	}
	return value;
}

function integerInRange(value: unknown, field: string, minimum = 1, maximum = 0xffff_ffff): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new StoreDataError(`Invalid integer stored in ${field}`);
	}
	return value;
}

function exactValue<T extends string | number>(value: unknown, expected: T, field: string): T {
	if (value !== expected) {
		throw new StoreDataError(`Invalid value stored in ${field}`);
	}
	return expected;
}

function digest(value: unknown, field: string): string {
	if (typeof value !== 'string' || !UPPER_HEX_64.test(value)) {
		throw new StoreDataError(`Invalid digest stored in ${field}`);
	}
	return value;
}

function nullableInteger(value: unknown, field: string): number | null {
	return value === null ? null : integerInRange(value, field);
}

function nullableString(value: unknown, field: string): string | null {
	return value === null ? null : nonEmptyString(value, field);
}

function utcTimestamp(value: unknown, field: string): string {
	const timestamp = nonEmptyString(value, field);
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
		throw new StoreDataError(`Invalid UTC timestamp stored in ${field}`);
	}
	return timestamp;
}

function acquisitionBalanceInvariant(value: unknown): AcquisitionBalanceInvariant {
	const object = asObject(value);
	const keys = Object.keys(object).sort();
	const expectedKeys = ['balance', 'currency', 'issuer', 'kind', 'ledger_index'];
	if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
		throw new TypeError('expected the exact acquisition balance invariant fields');
	}
	if (object.kind !== 'issued_balance_unchanged') throw new TypeError('invalid balance invariant kind');
	if (typeof object.currency !== 'string' || !/^[0-9A-F]{40}$/.test(object.currency)) {
		throw new TypeError('invalid balance invariant currency');
	}
	if (typeof object.issuer !== 'string' || object.issuer.length === 0) throw new TypeError('invalid balance invariant issuer');
	if (
		typeof object.balance !== 'string' ||
		!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(object.balance)
	) {
		throw new TypeError('invalid balance invariant balance');
	}
	return {
		kind: 'issued_balance_unchanged',
		currency: object.currency,
		issuer: object.issuer,
		balance: object.balance,
		ledgerIndex: integerInRange(object.ledger_index, 'acquisition_balance_invariant.ledger_index'),
	};
}

function acquisitionBalanceInvariantInput(value: unknown): AcquisitionBalanceInvariant {
	const object = asObject(value);
	const keys = Object.keys(object).sort();
	const expectedKeys = ['balance', 'currency', 'issuer', 'kind', 'ledgerIndex'];
	if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
		throw new TypeError('expected the exact acquisition balance invariant fields');
	}
	return acquisitionBalanceInvariant({
		kind: object.kind,
		currency: object.currency,
		issuer: object.issuer,
		balance: object.balance,
		ledger_index: object.ledgerIndex,
	});
}

function invariantToStored(value: AcquisitionBalanceInvariant | null, field: string): string | null {
	if (value === null) return null;
	try {
		const stored = {
			kind: value.kind,
			currency: value.currency,
			issuer: value.issuer,
			balance: value.balance,
			ledger_index: value.ledgerIndex,
		};
		acquisitionBalanceInvariant(stored);
		return serializeJson(stored, field);
	} catch (cause) {
		if (cause instanceof StoreDataError) throw cause;
		throw new StoreDataError(`Could not serialize ${field}`, cause);
	}
}

function invariantFromStored(value: string | null, field: string): AcquisitionBalanceInvariant | null {
	if (value === null) return null;
	return parseJson(value, field, acquisitionBalanceInvariant);
}

function validateBuildRevisionFields(value: Partial<BuildRevisionFields>, fieldPrefix: string): BuildRevisionFields {
	const executionContract = exactValue(value.executionContract, 'xrpl_execution_v2', `${fieldPrefix}.execution_contract`);
	const buildRevision = integerInRange(value.buildRevision, `${fieldPrefix}.build_revision`);
	const buildLedger = integerInRange(value.buildLedger, `${fieldPrefix}.build_ledger`);
	const firstInclusionLedger = integerInRange(value.firstInclusionLedger, `${fieldPrefix}.first_inclusion_ledger`);
	const lastLedgerSequence = integerInRange(value.lastLedgerSequence, `${fieldPrefix}.last_ledger_sequence`);
	if (firstInclusionLedger !== buildLedger + 1 || lastLedgerSequence !== buildLedger + 64) {
		throw new StoreDataError(`Invalid ledger range stored in ${fieldPrefix}`);
	}
	const quoteLedger = nullableInteger(value.quoteLedger, `${fieldPrefix}.quote_ledger`);
	const quoteValidThroughLedger = nullableInteger(value.quoteValidThroughLedger, `${fieldPrefix}.quote_valid_through_ledger`);
	if (
		(quoteLedger === null) !== (quoteValidThroughLedger === null) ||
		(quoteLedger !== null &&
			(quoteValidThroughLedger !== quoteLedger + 1 || buildLedger < quoteLedger || buildLedger > quoteValidThroughLedger))
	) {
		throw new StoreDataError(`Invalid quote ledger range stored in ${fieldPrefix}`);
	}
	const balanceInvariant =
		value.acquisitionBalanceInvariant === null
			? null
			: (() => {
					try {
						return acquisitionBalanceInvariantInput(value.acquisitionBalanceInvariant);
					} catch (cause) {
						throw new StoreDataError(`Invalid value stored in ${fieldPrefix}.acquisition_balance_invariant`, cause);
					}
				})();
	if (
		balanceInvariant !== null &&
		(balanceInvariant.ledgerIndex > buildLedger || buildLedger - balanceInvariant.ledgerIndex > 1)
	) {
		throw new StoreDataError(`Invalid balance invariant ledger stored in ${fieldPrefix}`);
	}
	return {
		executionContract,
		buildRevision,
		unsignedTxDigest: digest(value.unsignedTxDigest, `${fieldPrefix}.unsigned_tx_digest`),
		unsignedTxDigestAlg: exactValue(value.unsignedTxDigestAlg, 'sha256-jcs-v1', `${fieldPrefix}.unsigned_tx_digest_alg`),
		economicFingerprint: digest(value.economicFingerprint, `${fieldPrefix}.economic_fingerprint`),
		economicFingerprintAlg: exactValue(
			value.economicFingerprintAlg,
			'sha256-jcs-economic-v1',
			`${fieldPrefix}.economic_fingerprint_alg`,
		),
		buildLedger,
		firstInclusionLedger,
		lastLedgerSequence,
		minimumRemainingLedgers: exactValue(value.minimumRemainingLedgers, 8, `${fieldPrefix}.minimum_remaining_ledgers`),
		approvalExpiresInSeconds: exactValue(value.approvalExpiresInSeconds, 90, `${fieldPrefix}.approval_expires_in_seconds`),
		quoteLedger,
		quoteValidThroughLedger,
		acquisitionBalanceInvariant: balanceInvariant,
	};
}

function v2FieldsFromBuildInput(input: BuildInsert): BuildRevisionFields | null {
	const present = V2_BUILD_FIELD_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(input, key));
	if (input.executionCapability === undefined && present.length === 0) return null;
	if (input.executionCapability !== undefined) {
		let capability: ExecutionCapability;
		try {
			capability = ExecutionCapabilitySchema.parse(input.executionCapability);
		} catch (cause) {
			throw new StoreDataError('Invalid v2 execution capability is not accepted', cause);
		}
		const mapped: BuildRevisionFields = {
			executionContract: capability.execution_contract,
			buildRevision: capability.build_revision,
			unsignedTxDigest: capability.unsigned_tx_digest,
			unsignedTxDigestAlg: capability.unsigned_tx_digest_alg,
			economicFingerprint: capability.economic_fingerprint,
			economicFingerprintAlg: capability.economic_fingerprint_alg,
			buildLedger: capability.build_ledger,
			firstInclusionLedger: capability.first_inclusion_ledger,
			lastLedgerSequence: capability.last_ledger_sequence,
			minimumRemainingLedgers: capability.minimum_remaining_ledgers,
			approvalExpiresInSeconds: capability.approval_expires_in_seconds,
			quoteLedger: capability.quote_ledger ?? null,
			quoteValidThroughLedger: capability.quote_valid_through_ledger ?? null,
			acquisitionBalanceInvariant:
				capability.acquisition_balance_invariant === undefined
					? null
					: {
							kind: capability.acquisition_balance_invariant.kind,
							currency: capability.acquisition_balance_invariant.currency,
							issuer: capability.acquisition_balance_invariant.issuer,
							balance: capability.acquisition_balance_invariant.balance,
							ledgerIndex: capability.acquisition_balance_invariant.ledger_index,
						},
		};
		for (const key of present) {
			if (JSON.stringify(input[key]) !== JSON.stringify(mapped[key])) {
				throw new StoreDataError(`V2 build metadata does not match execution capability field ${key}`);
			}
		}
		const fields = validateBuildRevisionFields(mapped, 'build_revisions');
		if (input.lastLedgerSeq !== fields.lastLedgerSequence) {
			throw new StoreDataError('V2 build last ledger does not match its immutable revision');
		}
		return fields;
	}
	if (present.length !== V2_BUILD_FIELD_KEYS.length) {
		throw new StoreDataError('Partial v2 build metadata is not accepted');
	}
	const fields = validateBuildRevisionFields(input, 'build_revisions');
	if (input.lastLedgerSeq !== fields.lastLedgerSequence) {
		throw new StoreDataError('V2 build last ledger does not match its immutable revision');
	}
	return fields;
}

function storedHexBlob(value: unknown, field: string): ArrayBuffer {
	if (typeof value !== 'string' || value.length === 0 || value.length > 8192 || value.length % 2 !== 0 || !/^[0-9A-F]+$/.test(value)) {
		throw new StoreDataError(`Invalid BLOB stored in ${field}`);
	}
	const bytes = new Uint8Array(value.length / 2);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes.buffer;
}

function linkFromRaw(row: RawLink): LinkRow {
	const base: LinkRowBase = {
		id: row.id,
		principal: row.principal,
		owner: row.owner,
		network: network(row.network, 'links.network'),
		delegate: row.delegate,
		permissions: parseJson(row.permissions, 'links.permissions', asStringArray),
		status: asStatus(row.status, LINK_STATUS, 'links.status'),
		lastLedger: row.last_ledger,
		revokeTx: row.revoke_tx === null ? null : parseJson(row.revoke_tx, 'links.revoke_tx', asObject),
		createdAt: row.created_at,
	};
	const backend = row.key_backend ?? 'local';
	if (backend === 'local') {
		if ((row.kms_key_id ?? null) !== null || (row.kms_alias ?? null) !== null) {
			throw new StoreDataError('Local link contains KMS key metadata');
		}
		return {
			...base,
			keyBackend: 'local',
			delegateSeedEnc: storedHexBlob(row.delegate_seed_enc_hex, 'links.delegate_seed_enc'),
			iv: storedHexBlob(row.iv_hex, 'links.iv'),
			kmsKeyId: null,
			kmsAlias: null,
		};
	}
	if (backend !== 'kms') {
		throw new StoreDataError('Invalid value stored in links.key_backend');
	}
	if (row.delegate_seed_enc !== null || row.iv !== null) {
		throw new StoreDataError('KMS link contains wrapped local key material');
	}
	const kmsKeyId = nonEmptyString(row.kms_key_id, 'links.kms_key_id');
	const kmsAlias = nonEmptyString(row.kms_alias, 'links.kms_alias');
	if (kmsAlias !== `alias/harbor/${base.network}/${base.id}`) {
		throw new StoreDataError('Invalid value stored in links.kms_alias');
	}
	return {
		...base,
		keyBackend: 'kms',
		delegateSeedEnc: null,
		iv: null,
		kmsKeyId,
		kmsAlias,
	};
}

function policyFromRaw(row: RawPolicy): PolicyRow {
	return {
		principal: row.principal,
		owner: row.owner,
		network: network(row.network, 'policies.network'),
		json: parseJson(row.json, 'policies.json', (value) => PolicySchema.parse(value)),
		updatedAt: row.updated_at,
	};
}

function buildFromRaw(row: RawBuild): BuildRow {
	const executionContract =
		row.execution_contract === undefined || row.execution_contract === null
			? null
			: exactValue(row.execution_contract, 'xrpl_execution_v2', 'builds.execution_contract');
	const buildRevision =
		row.build_revision === undefined || row.build_revision === null
			? null
			: integerInRange(row.build_revision, 'builds.build_revision');
	if ((executionContract === null) !== (buildRevision === null)) {
		throw new StoreDataError('Partial v2 pointer stored in builds');
	}
	return {
		id: row.id,
		principal: row.principal,
		owner: row.owner,
		network: network(row.network, 'builds.network'),
		txJson: parseJson(row.tx_json, 'builds.tx_json', asObject),
		summary: parseJson(row.summary, 'builds.summary', (value) => TxBuildSchema.shape.summary.parse(value)),
		lastLedgerSeq: row.last_ledger_seq,
		createdAt: row.created_at,
		originProfile:
			row.origin_profile === null || row.origin_profile === undefined
				? null
				: asStatus(row.origin_profile, BUILD_ORIGIN_PROFILE, 'builds.origin_profile'),
		executionContract,
		buildRevision,
	};
}

function buildRevisionFromRaw(row: RawBuildRevision): BuildRevisionRow {
	const fields = validateBuildRevisionFields(
		{
			executionContract: row.execution_contract as BuildRevisionFields['executionContract'],
			buildRevision: row.build_revision as number,
			unsignedTxDigest: row.unsigned_tx_digest as string,
			unsignedTxDigestAlg: row.unsigned_tx_digest_alg as BuildRevisionFields['unsignedTxDigestAlg'],
			economicFingerprint: row.economic_fingerprint as string,
			economicFingerprintAlg: row.economic_fingerprint_alg as BuildRevisionFields['economicFingerprintAlg'],
			buildLedger: row.build_ledger as number,
			firstInclusionLedger: row.first_inclusion_ledger as number,
			lastLedgerSequence: row.last_ledger_sequence as number,
			minimumRemainingLedgers: row.minimum_remaining_ledgers as 8,
			approvalExpiresInSeconds: row.approval_expires_in_seconds as 90,
			quoteLedger: row.quote_ledger as number | null,
			quoteValidThroughLedger: row.quote_valid_through_ledger as number | null,
			acquisitionBalanceInvariant: invariantFromStored(
				row.acquisition_balance_invariant,
				'build_revisions.acquisition_balance_invariant',
			),
		},
		'build_revisions',
	);
	const txJson = parseJson(row.tx_json, 'build_revisions.tx_json', asObject);
	const summary = parseJson(
		row.summary,
		'build_revisions.summary',
		(value) => TxBuildSchema.shape.summary.parse(value),
	);
	const owner = nonEmptyString(row.owner, 'build_revisions.owner');
	if (txJson.Account !== owner || txJson.LastLedgerSequence !== fields.lastLedgerSequence) {
		throw new StoreDataError('Immutable build revision does not match its transaction identity');
	}
	integerInRange(txJson.Sequence, 'build_revisions.tx_json.Sequence');
	return {
		principal: nonEmptyString(row.principal, 'build_revisions.principal'),
		buildId: nonEmptyString(row.build_id, 'build_revisions.build_id'),
		owner,
		network: v2Network(row.network, 'build_revisions.network'),
		txJson,
		summary,
		createdAt: utcTimestamp(row.created_at, 'build_revisions.created_at'),
		...fields,
	};
}

function executionFromRaw(row: RawExecution): ExecutionRow {
	return {
		id: row.id,
		principal: row.principal,
		buildId: row.build_id,
		idempotencyKey: row.idempotency_key,
		status: asStatus(row.status, EXECUTION_STATUS, 'executions.status'),
		hash: row.hash,
		usdValue: row.usd_value,
		signedBy: row.signed_by === null ? null : asStatus(row.signed_by, SIGNED_BY, 'executions.signed_by'),
		createdAt: row.created_at,
	};
}

function approvalFromRaw(row: RawApproval): ApprovalRow {
	const executionId = row.execution_id === undefined || row.execution_id === null ? null : nonEmptyString(row.execution_id, 'approvals.execution_id');
	const executionContract =
		row.execution_contract === undefined || row.execution_contract === null
			? null
			: exactValue(row.execution_contract, 'xrpl_execution_v2', 'approvals.execution_contract');
	const buildRevision =
		row.build_revision === undefined || row.build_revision === null
			? null
			: integerInRange(row.build_revision, 'approvals.build_revision');
	if ((executionId === null || executionContract === null || buildRevision === null) && (executionId !== null || executionContract !== null || buildRevision !== null)) {
		throw new StoreDataError('Partial v2 linkage stored in approvals');
	}
	return {
		id: row.id,
		principal: row.principal,
		buildId: row.build_id,
		txJson: parseJson(row.tx_json, 'approvals.tx_json', asObject),
		expiresAt: row.expires_at,
		status: asStatus(row.status, APPROVAL_STATUS, 'approvals.status'),
		executionId,
		executionContract,
		buildRevision,
	};
}

function executionSnapshotFromRaw(row: RawExecutionSnapshot): ExecutionSnapshotRow {
	const firstInclusionLedger = integerInRange(row.first_inclusion_ledger, 'execution_snapshots.first_inclusion_ledger');
	const lastLedgerSequence = integerInRange(row.last_ledger_sequence, 'execution_snapshots.last_ledger_sequence');
	if (lastLedgerSequence !== firstInclusionLedger + 63) {
		throw new StoreDataError('Invalid ledger range stored in execution_snapshots');
	}
	const approvalId = nullableString(row.approval_id, 'execution_snapshots.approval_id');
	const approvalExpiresAt =
		row.approval_expires_at === null ? null : utcTimestamp(row.approval_expires_at, 'execution_snapshots.approval_expires_at');
	if ((approvalId === null) !== (approvalExpiresAt === null)) {
		throw new StoreDataError('Partial approval pair stored in execution_snapshots');
	}
	return {
		executionId: nonEmptyString(row.execution_id, 'execution_snapshots.execution_id'),
		principal: nonEmptyString(row.principal, 'execution_snapshots.principal'),
		buildId: nonEmptyString(row.build_id, 'execution_snapshots.build_id'),
		executionContract: exactValue(row.execution_contract, 'xrpl_execution_v2', 'execution_snapshots.execution_contract'),
		buildRevision: integerInRange(row.build_revision, 'execution_snapshots.build_revision'),
		policySnapshot: parseJson(row.policy_snapshot, 'execution_snapshots.policy_snapshot', (value) => PolicySchema.parse(value)),
		policyRevision: nonEmptyString(row.policy_revision, 'execution_snapshots.policy_revision'),
		unsignedTxDigest: digest(row.unsigned_tx_digest, 'execution_snapshots.unsigned_tx_digest'),
		unsignedTxDigestAlg: exactValue(
			row.unsigned_tx_digest_alg,
			'sha256-jcs-v1',
			'execution_snapshots.unsigned_tx_digest_alg',
		),
		economicFingerprint: digest(row.economic_fingerprint, 'execution_snapshots.economic_fingerprint'),
		economicFingerprintAlg: exactValue(
			row.economic_fingerprint_alg,
			'sha256-jcs-economic-v1',
			'execution_snapshots.economic_fingerprint_alg',
		),
		snapshotOwner: nonEmptyString(row.snapshot_owner, 'execution_snapshots.snapshot_owner'),
		snapshotNetwork: v2Network(row.snapshot_network, 'execution_snapshots.snapshot_network'),
		snapshotSequence: integerInRange(row.snapshot_sequence, 'execution_snapshots.snapshot_sequence'),
		firstInclusionLedger,
		lastLedgerSequence,
		approvalId,
		approvalExpiresAt,
		acquisitionBalanceInvariant: invariantFromStored(
			row.acquisition_balance_invariant,
			'execution_snapshots.acquisition_balance_invariant',
		),
		createdAt: utcTimestamp(row.created_at, 'execution_snapshots.created_at'),
	};
}

function relayClaimFromRaw(row: RawRelayClaim): RelayClaimRow {
	return {
		principal: nonEmptyString(row.principal, 'relay_claims.principal'),
		executionId: nonEmptyString(row.execution_id, 'relay_claims.execution_id'),
		hash: digest(row.hash, 'relay_claims.hash'),
		attemptedAt: utcTimestamp(row.attempted_at, 'relay_claims.attempted_at'),
	};
}

function eventFromRaw(row: RawEvent): EventRow {
	return {
		id: row.id,
		principal: row.principal,
		owner: row.owner,
		kind: row.kind,
		detail: parseJson(row.detail, 'events.detail', asObject),
		createdAt: row.created_at,
	};
}

function utcDayStart(now: Date): string {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

function expectRow<T>(row: T | null, table: string): T {
	if (row === null) {
		throw new StoreDataError(`Inserted ${table} row could not be read`);
	}
	return row;
}

export class Store {
	constructor(
		private readonly db: D1Database,
		readonly principal: string,
	) {
		if (principal.length === 0) {
			throw new TypeError('principal must not be empty');
		}
	}

	async getLink(owner: string, networkValue: Network): Promise<LinkRow | null> {
		const row = await this.db
			.prepare('SELECT *, hex(delegate_seed_enc) AS delegate_seed_enc_hex, hex(iv) AS iv_hex FROM links WHERE principal = ? AND owner = ? AND network = ?')
			.bind(this.principal, owner, networkValue)
			.first<RawLink>();
		return row === null ? null : linkFromRaw(row);
	}

	async insertLink(input: LinkInsert): Promise<LinkRow> {
		const backend = input.keyBackend ?? 'local';
		const delegateSeedEnc = backend === 'local' ? input.delegateSeedEnc : null;
		const iv = backend === 'local' ? input.iv : null;
		const kmsKeyId = backend === 'kms' ? input.kmsKeyId : null;
		const kmsAlias = backend === 'kms' ? input.kmsAlias : null;
		await this.db
			.prepare(
				`INSERT INTO links
          (id, principal, owner, network, delegate, delegate_seed_enc, iv,
           key_backend, kms_key_id, kms_alias, permissions,
           status, last_ledger, revoke_tx, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				input.id,
				this.principal,
				input.owner,
				input.network,
				input.delegate,
				delegateSeedEnc,
				iv,
				backend,
				kmsKeyId,
				kmsAlias,
				serializeJson(input.permissions, 'links.permissions', asStringArray),
				input.status,
				input.lastLedger,
				input.revokeTx === null ? null : serializeJson(input.revokeTx, 'links.revoke_tx', asObject),
				input.createdAt,
			)
			.run();
		return expectRow(await this.getLink(input.owner, input.network), 'links');
	}

	async updateLink(id: string, patch: LinkUpdate): Promise<LinkRow | null> {
		const fields: [string, MutableValue][] = [];
		if (patch.delegate !== undefined) fields.push(['delegate', patch.delegate]);
		if (patch.delegateSeedEnc !== undefined) fields.push(['delegate_seed_enc', patch.delegateSeedEnc]);
		if (patch.iv !== undefined) fields.push(['iv', patch.iv]);
		if (patch.permissions !== undefined) fields.push(['permissions', serializeJson(patch.permissions, 'links.permissions', asStringArray)]);
		if (patch.status !== undefined) fields.push(['status', patch.status]);
		if (patch.lastLedger !== undefined) fields.push(['last_ledger', patch.lastLedger]);
		if (patch.revokeTx !== undefined)
			fields.push(['revoke_tx', patch.revokeTx === null ? null : serializeJson(patch.revokeTx, 'links.revoke_tx', asObject)]);
		await this.updateById('links', id, fields);
		return this.getLinkById(id);
	}

	async listActiveLinks(): Promise<LinkRow[]> {
		const result = await this.db
			.prepare('SELECT *, hex(delegate_seed_enc) AS delegate_seed_enc_hex, hex(iv) AS iv_hex FROM links WHERE principal = ? AND status = ? ORDER BY created_at, id')
			.bind(this.principal, 'active')
			.all<RawLink>();
		return result.results.map(linkFromRaw);
	}

	async getPolicy(owner: string, networkValue: Network): Promise<PolicyRow | null> {
		const row = await this.db
			.prepare('SELECT * FROM policies WHERE principal = ? AND owner = ? AND network = ?')
			.bind(this.principal, owner, networkValue)
			.first<RawPolicy>();
		return row === null ? null : policyFromRaw(row);
	}

	async insertPolicy(input: PolicyInsert): Promise<PolicyRow> {
		await this.db
			.prepare(
				`INSERT INTO policies (principal, owner, network, json, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
			)
			.bind(
				this.principal,
				input.owner,
				input.network,
				serializeJson(input.json, 'policies.json', (value) => PolicySchema.parse(value)),
				input.updatedAt,
			)
			.run();
		return expectRow(await this.getPolicy(input.owner, input.network), 'policies');
	}

	async updatePolicy(owner: string, networkValue: Network, patch: PolicyUpdate): Promise<PolicyRow | null> {
		const fields: [string, MutableValue][] = [];
		if (patch.json !== undefined) fields.push(['json', serializeJson(patch.json, 'policies.json', (value) => PolicySchema.parse(value))]);
		if (patch.updatedAt !== undefined) fields.push(['updated_at', patch.updatedAt]);
		if (fields.length > 0) {
			const set = fields.map(([column]) => `${column} = ?`).join(', ');
			await this.db
				.prepare(`UPDATE policies SET ${set} WHERE principal = ? AND owner = ? AND network = ?`)
				.bind(...fields.map(([, value]) => value), this.principal, owner, networkValue)
				.run();
		}
		return this.getPolicy(owner, networkValue);
	}

	async getBuild(id: string): Promise<BuildRow | null> {
		const row = await this.db.prepare('SELECT * FROM builds WHERE principal = ? AND id = ?').bind(this.principal, id).first<RawBuild>();
		return row === null ? null : buildFromRaw(row);
	}

	async getBuildRevision(buildId: string, buildRevision: number): Promise<BuildRevisionRow | null> {
		const row = await this.db
			.prepare('SELECT * FROM build_revisions WHERE principal = ? AND build_id = ? AND build_revision = ?')
			.bind(this.principal, buildId, buildRevision)
			.first<RawBuildRevision>();
		return row === null ? null : buildRevisionFromRaw(row);
	}

	prepareInsertBuildRevision(input: BuildRevisionInsert): D1PreparedStatement {
		const fields = validateBuildRevisionFields(input, 'build_revisions');
		const txJson = asObject(input.txJson);
		const summary = TxBuildSchema.shape.summary.parse(input.summary);
		const takerPays =
			txJson.TakerPays !== null && typeof txJson.TakerPays === 'object' && !Array.isArray(txJson.TakerPays)
				? asObject(txJson.TakerPays)
				: null;
		const acquiresOfficialTestnetRlusd =
			input.network === 'testnet' &&
			txJson.TransactionType === 'OfferCreate' &&
			takerPays !== null &&
			String(takerPays.currency).toUpperCase() === '524C555344000000000000000000000000000000' &&
			takerPays.issuer === 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV';
		if (
			acquiresOfficialTestnetRlusd &&
			(fields.acquisitionBalanceInvariant === null ||
				fields.acquisitionBalanceInvariant.currency !== '524C555344000000000000000000000000000000' ||
				fields.acquisitionBalanceInvariant.issuer !== 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV')
		) {
			throw new StoreDataError('Official testnet RLUSD acquisition requires its exact balance invariant');
		}
		if (txJson.Account !== input.owner || txJson.LastLedgerSequence !== fields.lastLedgerSequence) {
			throw new StoreDataError('Immutable build revision does not match its transaction identity');
		}
		integerInRange(txJson.Sequence, 'build_revisions.tx_json.Sequence');
		const row: BuildRevisionRow = {
			...input,
			principal: this.principal,
			network: v2Network(input.network, 'build_revisions.network'),
			txJson,
			summary,
			createdAt: utcTimestamp(input.createdAt, 'build_revisions.created_at'),
			...fields,
		};
		return this.db
			.prepare(
				`INSERT INTO build_revisions
				  (principal, build_id, build_revision, execution_contract, owner, network, tx_json, summary,
           unsigned_tx_digest, unsigned_tx_digest_alg, economic_fingerprint, economic_fingerprint_alg,
           build_ledger, first_inclusion_ledger, last_ledger_sequence, minimum_remaining_ledgers,
           approval_expires_in_seconds, quote_ledger, quote_valid_through_ledger,
				   acquisition_balance_invariant, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				this.principal,
				row.buildId,
				row.buildRevision,
				row.executionContract,
				row.owner,
				row.network,
				serializeJson(row.txJson, 'build_revisions.tx_json', asObject),
				serializeJson(row.summary, 'build_revisions.summary', (value) => TxBuildSchema.shape.summary.parse(value)),
				row.unsignedTxDigest,
				row.unsignedTxDigestAlg,
				row.economicFingerprint,
				row.economicFingerprintAlg,
				row.buildLedger,
				row.firstInclusionLedger,
				row.lastLedgerSequence,
				row.minimumRemainingLedgers,
				row.approvalExpiresInSeconds,
				row.quoteLedger,
				row.quoteValidThroughLedger,
				invariantToStored(row.acquisitionBalanceInvariant, 'build_revisions.acquisition_balance_invariant'),
				row.createdAt,
			);
	}

	async insertBuildRevision(input: BuildRevisionInsert): Promise<BuildRevisionRow> {
		const build = await this.requireOwnedBuild(input.buildId);
		if (
			build.owner !== input.owner ||
			build.network !== input.network ||
			build.executionContract !== 'xrpl_execution_v2' ||
			build.buildRevision === null ||
			build.buildRevision === undefined ||
			input.buildRevision !== build.buildRevision
		) {
			throw new StoreDataError('Build revision identity does not match its build');
		}
		await this.prepareInsertBuildRevision(input).run();
		return expectRow(await this.getBuildRevision(input.buildId, input.buildRevision), 'build_revisions');
	}

	async insertBuild(input: BuildInsert): Promise<BuildRow> {
		const v2Fields = v2FieldsFromBuildInput(input);
		const insertBuild = this.db
			.prepare(
				`INSERT INTO builds
          (id, principal, owner, network, tx_json, summary, last_ledger_seq, created_at, origin_profile,
           execution_contract, build_revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				input.id,
				this.principal,
				input.owner,
				input.network,
				serializeJson(input.txJson, 'builds.tx_json', asObject),
				serializeJson(input.summary, 'builds.summary', (value) => TxBuildSchema.shape.summary.parse(value)),
				input.lastLedgerSeq,
				input.createdAt,
				input.originProfile ?? null,
				v2Fields?.executionContract ?? null,
				v2Fields?.buildRevision ?? null,
			);
		if (v2Fields === null) {
			await insertBuild.run();
		} else {
			await this.db.batch([
				insertBuild,
				this.prepareInsertBuildRevision({
					buildId: input.id,
					owner: input.owner,
					network: v2Network(input.network, 'build_revisions.network'),
					txJson: input.txJson,
					summary: input.summary,
					createdAt: input.createdAt,
					...v2Fields,
				}),
			]);
		}
		return expectRow(await this.getBuild(input.id), 'builds');
	}

	async updateBuild(id: string, patch: BuildUpdate): Promise<BuildRow | null> {
		const fields: [string, MutableValue][] = [];
		if (patch.txJson !== undefined) fields.push(['tx_json', serializeJson(patch.txJson, 'builds.tx_json', asObject)]);
		if (patch.summary !== undefined)
			fields.push(['summary', serializeJson(patch.summary, 'builds.summary', (value) => TxBuildSchema.shape.summary.parse(value))]);
		if (patch.lastLedgerSeq !== undefined) fields.push(['last_ledger_seq', patch.lastLedgerSeq]);
		await this.updateById('builds', id, fields);
		return this.getBuild(id);
	}

	async getExecution(id: string): Promise<ExecutionRow | null> {
		const row = await this.db
			.prepare('SELECT * FROM executions WHERE principal = ? AND id = ?')
			.bind(this.principal, id)
			.first<RawExecution>();
		return row === null ? null : executionFromRaw(row);
	}

	async insertExecution(input: ExecutionInsert): Promise<ExecutionRow> {
		await this.requireOwnedBuild(input.buildId);
		await this.prepareInsertExecution(input).run();
		return expectRow(await this.getExecution(input.id), 'executions');
	}

	prepareInsertExecution(input: ExecutionInsert): D1PreparedStatement {
		return this.db
			.prepare(
				`INSERT INTO executions
          (id, principal, build_id, idempotency_key, status, hash, usd_value, signed_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				input.id,
				this.principal,
				input.buildId,
				input.idempotencyKey,
				input.status,
				input.hash,
				input.usdValue,
				input.signedBy,
				input.createdAt,
			);
	}

	async updateExecution(id: string, patch: ExecutionUpdate): Promise<ExecutionRow | null> {
		const fields: [string, MutableValue][] = [];
		if (patch.status !== undefined) fields.push(['status', patch.status]);
		if (patch.hash !== undefined) fields.push(['hash', patch.hash]);
		if (patch.usdValue !== undefined) fields.push(['usd_value', patch.usdValue]);
		if (patch.signedBy !== undefined) fields.push(['signed_by', patch.signedBy]);
		await this.updateById('executions', id, fields);
		return this.getExecution(id);
	}

	async findExecutionByHash(hash: string): Promise<ExecutionRow | null> {
		const row = await this.db
			.prepare('SELECT * FROM executions WHERE principal = ? AND hash = ?')
			.bind(this.principal, hash)
			.first<RawExecution>();
		return row === null ? null : executionFromRaw(row);
	}

	async findExecutionByIdempotencyKey(idempotencyKey: string): Promise<ExecutionRow | null> {
		const row = await this.db
			.prepare('SELECT * FROM executions WHERE principal = ? AND idempotency_key = ?')
			.bind(this.principal, idempotencyKey)
			.first<RawExecution>();
		return row === null ? null : executionFromRaw(row);
	}

	async getDailyExecutedUsdTotal(owner: string, networkValue: Network, since: Date | string = utcDayStart(new Date())): Promise<number> {
		const sinceIso = since instanceof Date ? since.toISOString() : since;
		const row = await this.db
			.prepare(
				`SELECT COALESCE(SUM(e.usd_value), 0) AS total
           FROM executions AS e
           JOIN builds AS b ON b.id = e.build_id AND b.principal = e.principal
          WHERE e.principal = ? AND b.principal = ?
            AND b.owner = ? AND b.network = ?
            AND e.status = ? AND e.created_at >= ?`,
			)
			.bind(this.principal, this.principal, owner, networkValue, 'executed', sinceIso)
			.first<{ total: number | null }>();
		return row?.total ?? 0;
	}

	async dailyUsdTotal(owner: string, networkValue: Network, since?: Date | string): Promise<number> {
		return since === undefined
			? this.getDailyExecutedUsdTotal(owner, networkValue)
			: this.getDailyExecutedUsdTotal(owner, networkValue, since);
	}

	async getExecutionSnapshot(executionId: string): Promise<ExecutionSnapshotRow | null> {
		const row = await this.db
			.prepare('SELECT * FROM execution_snapshots WHERE principal = ? AND execution_id = ?')
			.bind(this.principal, executionId)
			.first<RawExecutionSnapshot>();
		if (row === null) return null;
		const snapshot = executionSnapshotFromRaw(row);
		const [revision, execution] = await Promise.all([
			this.getBuildRevision(snapshot.buildId, snapshot.buildRevision),
			this.getExecution(snapshot.executionId),
		]);
		if (revision === null || execution === null || execution.buildId !== snapshot.buildId) {
			throw new StoreDataError('Execution snapshot has missing or mismatched identity evidence');
		}
		const invariantMatches =
			JSON.stringify(revision.acquisitionBalanceInvariant) === JSON.stringify(snapshot.acquisitionBalanceInvariant);
		if (
			revision.executionContract !== snapshot.executionContract ||
			revision.unsignedTxDigest !== snapshot.unsignedTxDigest ||
			revision.unsignedTxDigestAlg !== snapshot.unsignedTxDigestAlg ||
			revision.economicFingerprint !== snapshot.economicFingerprint ||
			revision.economicFingerprintAlg !== snapshot.economicFingerprintAlg ||
			revision.owner !== snapshot.snapshotOwner ||
			revision.network !== snapshot.snapshotNetwork ||
			revision.txJson.Sequence !== snapshot.snapshotSequence ||
			revision.firstInclusionLedger !== snapshot.firstInclusionLedger ||
			revision.lastLedgerSequence !== snapshot.lastLedgerSequence ||
			!invariantMatches
		) {
			throw new StoreDataError('Execution snapshot does not match its immutable build revision');
		}
		if (snapshot.approvalId !== null) {
			const approval = await this.getApproval(snapshot.approvalId);
			if (
				approval === null ||
				approval.executionId !== snapshot.executionId ||
				approval.buildId !== snapshot.buildId ||
				approval.executionContract !== snapshot.executionContract ||
				approval.buildRevision !== snapshot.buildRevision ||
				approval.expiresAt !== snapshot.approvalExpiresAt
			) {
				throw new StoreDataError('Execution snapshot does not match its approval binding');
			}
		}
		return snapshot;
	}

	prepareInsertExecutionSnapshot(input: ExecutionSnapshotInsert): D1PreparedStatement {
		const executionContract = exactValue(
			input.executionContract,
			'xrpl_execution_v2',
			'execution_snapshots.execution_contract',
		);
		const buildRevision = integerInRange(input.buildRevision, 'execution_snapshots.build_revision');
		const snapshotNetwork = v2Network(input.snapshotNetwork, 'execution_snapshots.snapshot_network');
		const snapshotSequence = integerInRange(input.snapshotSequence, 'execution_snapshots.snapshot_sequence');
		const firstInclusionLedger = integerInRange(
			input.firstInclusionLedger,
			'execution_snapshots.first_inclusion_ledger',
		);
		const lastLedgerSequence = integerInRange(input.lastLedgerSequence, 'execution_snapshots.last_ledger_sequence');
		if (lastLedgerSequence !== firstInclusionLedger + 63) {
			throw new StoreDataError('Invalid ledger range stored in execution_snapshots');
		}
		const approvalId = input.approvalId === null ? null : nonEmptyString(input.approvalId, 'execution_snapshots.approval_id');
		const approvalExpiresAt =
			input.approvalExpiresAt === null
				? null
				: utcTimestamp(input.approvalExpiresAt, 'execution_snapshots.approval_expires_at');
		if ((approvalId === null) !== (approvalExpiresAt === null)) {
			throw new StoreDataError('Partial approval pair stored in execution_snapshots');
		}
		return this.db
			.prepare(
				`INSERT INTO execution_snapshots
          (execution_id, principal, build_id, execution_contract, build_revision,
           policy_snapshot, policy_revision, unsigned_tx_digest, unsigned_tx_digest_alg,
           economic_fingerprint, economic_fingerprint_alg, snapshot_owner, snapshot_network,
           snapshot_sequence, first_inclusion_ledger, last_ledger_sequence, approval_id,
           approval_expires_at, acquisition_balance_invariant, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				nonEmptyString(input.executionId, 'execution_snapshots.execution_id'),
				this.principal,
				nonEmptyString(input.buildId, 'execution_snapshots.build_id'),
				executionContract,
				buildRevision,
				serializeJson(input.policySnapshot, 'execution_snapshots.policy_snapshot', (value) => PolicySchema.parse(value)),
				nonEmptyString(input.policyRevision, 'execution_snapshots.policy_revision'),
				digest(input.unsignedTxDigest, 'execution_snapshots.unsigned_tx_digest'),
				exactValue(input.unsignedTxDigestAlg, 'sha256-jcs-v1', 'execution_snapshots.unsigned_tx_digest_alg'),
				digest(input.economicFingerprint, 'execution_snapshots.economic_fingerprint'),
				exactValue(
					input.economicFingerprintAlg,
					'sha256-jcs-economic-v1',
					'execution_snapshots.economic_fingerprint_alg',
				),
				nonEmptyString(input.snapshotOwner, 'execution_snapshots.snapshot_owner'),
				snapshotNetwork,
				snapshotSequence,
				firstInclusionLedger,
				lastLedgerSequence,
				approvalId,
				approvalExpiresAt,
				invariantToStored(input.acquisitionBalanceInvariant, 'execution_snapshots.acquisition_balance_invariant'),
				utcTimestamp(input.createdAt, 'execution_snapshots.created_at'),
			);
	}

	async insertExecutionSnapshot(input: ExecutionSnapshotInsert): Promise<ExecutionSnapshotRow> {
		await this.prepareInsertExecutionSnapshot(input).run();
		return expectRow(await this.getExecutionSnapshot(input.executionId), 'execution_snapshots');
	}

	async getRelayClaim(executionId: string): Promise<RelayClaimRow | null> {
		const row = await this.db
			.prepare('SELECT * FROM relay_claims WHERE principal = ? AND execution_id = ?')
			.bind(this.principal, executionId)
			.first<RawRelayClaim>();
		if (row === null) return null;
		const claim = relayClaimFromRaw(row);
		const execution = await this.getExecution(claim.executionId);
		if (execution === null || execution.hash !== claim.hash) {
			throw new StoreDataError('Relay claim does not match the durable execution hash');
		}
		return claim;
	}

	prepareInsertRelayClaim(input: RelayClaimInsert): D1PreparedStatement {
		return this.db
			.prepare('INSERT INTO relay_claims (principal, execution_id, hash, attempted_at) VALUES (?, ?, ?, ?)')
			.bind(
				this.principal,
				nonEmptyString(input.executionId, 'relay_claims.execution_id'),
				digest(input.hash, 'relay_claims.hash'),
				utcTimestamp(input.attemptedAt, 'relay_claims.attempted_at'),
			);
	}

	async insertRelayClaim(input: RelayClaimInsert): Promise<RelayClaimRow> {
		await this.prepareInsertRelayClaim(input).run();
		return expectRow(await this.getRelayClaim(input.executionId), 'relay_claims');
	}

	async getApproval(id: string): Promise<ApprovalRow | null> {
		const row = await this.db
			.prepare('SELECT * FROM approvals WHERE principal = ? AND id = ?')
			.bind(this.principal, id)
			.first<RawApproval>();
		return row === null ? null : approvalFromRaw(row);
	}

	async insertApproval(input: ApprovalInsert): Promise<ApprovalRow> {
		await this.requireOwnedBuild(input.buildId);
		await this.prepareInsertApproval(input).run();
		return expectRow(await this.getApproval(input.id), 'approvals');
	}

	prepareInsertApproval(input: ApprovalInsert): D1PreparedStatement {
		const executionId = input.executionId ?? null;
		const executionContract = input.executionContract ?? null;
		const buildRevision = input.buildRevision ?? null;
		if (
			(executionId === null || executionContract === null || buildRevision === null) &&
			(executionId !== null || executionContract !== null || buildRevision !== null)
		) {
			throw new StoreDataError('Partial v2 linkage is not accepted for approvals');
		}
		if (executionContract !== null) {
			exactValue(executionContract, 'xrpl_execution_v2', 'approvals.execution_contract');
			integerInRange(buildRevision, 'approvals.build_revision');
			nonEmptyString(executionId, 'approvals.execution_id');
		}
		return this.db
			.prepare(
				`INSERT INTO approvals
          (id, principal, build_id, tx_json, expires_at, status, execution_id, execution_contract, build_revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				input.id,
				this.principal,
				input.buildId,
				serializeJson(input.txJson, 'approvals.tx_json', asObject),
				input.expiresAt,
				input.status,
				executionId,
				executionContract,
				buildRevision,
			);
	}

	async updateApproval(id: string, patch: ApprovalUpdate): Promise<ApprovalRow | null> {
		const fields: [string, MutableValue][] = [];
		if (patch.txJson !== undefined) fields.push(['tx_json', serializeJson(patch.txJson, 'approvals.tx_json', asObject)]);
		if (patch.expiresAt !== undefined) fields.push(['expires_at', patch.expiresAt]);
		if (patch.status !== undefined) fields.push(['status', patch.status]);
		await this.updateById('approvals', id, fields);
		return this.getApproval(id);
	}

	async getEvent(id: string): Promise<EventRow | null> {
		const row = await this.db.prepare('SELECT * FROM events WHERE principal = ? AND id = ?').bind(this.principal, id).first<RawEvent>();
		return row === null ? null : eventFromRaw(row);
	}

	async insertEvent(input: EventInsert): Promise<EventRow> {
		await this.db
			.prepare(
				`INSERT INTO events (id, principal, owner, kind, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.bind(input.id, this.principal, input.owner, input.kind, serializeJson(input.detail, 'events.detail', asObject), input.createdAt)
			.run();
		return expectRow(await this.getEvent(input.id), 'events');
	}

	async updateEvent(id: string, patch: EventUpdate): Promise<EventRow | null> {
		const fields: [string, MutableValue][] = [];
		if (patch.kind !== undefined) fields.push(['kind', patch.kind]);
		if (patch.detail !== undefined) fields.push(['detail', serializeJson(patch.detail, 'events.detail', asObject)]);
		await this.updateById('events', id, fields);
		return this.getEvent(id);
	}

	private async getLinkById(id: string): Promise<LinkRow | null> {
		const row = await this.db
			.prepare('SELECT *, hex(delegate_seed_enc) AS delegate_seed_enc_hex, hex(iv) AS iv_hex FROM links WHERE principal = ? AND id = ?')
			.bind(this.principal, id)
			.first<RawLink>();
		return row === null ? null : linkFromRaw(row);
	}

	private async updateById(
		table: 'links' | 'builds' | 'executions' | 'approvals' | 'events',
		id: string,
		fields: [string, MutableValue][],
	): Promise<void> {
		if (fields.length === 0) return;
		const set = fields.map(([column]) => `${column} = ?`).join(', ');
		await this.db
			.prepare(`UPDATE ${table} SET ${set} WHERE principal = ? AND id = ?`)
			.bind(...fields.map(([, value]) => value), this.principal, id)
			.run();
	}

	private async requireOwnedBuild(buildId: string): Promise<BuildRow> {
		const build = await this.getBuild(buildId);
		if (build === null) {
			throw new StoreDataError('Build does not exist for this principal');
		}
		return build;
	}
}

export function createStore(db: D1Database, principal: string): Store {
	return new Store(db, principal);
}
