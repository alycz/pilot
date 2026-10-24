import {
	NetworkSchema,
	PolicySchema,
	TxBuildSchema,
	type AccountLink,
	type ExecResult,
	type Network,
	type Policy,
	type TxBuild,
} from '../contracts';

export type LinkStatus = AccountLink['status'];
export type ExecutionStatus = 'pending' | 'submitted' | ExecResult['status'];
export type ApprovalStatus = 'pending' | 'submitted' | 'approved' | 'expired' | 'rejected';
export type SignedBy = 'delegate' | 'owner';

export type JsonObject = Record<string, unknown>;

export interface LinkRow {
	id: string;
	principal: string;
	owner: string;
	network: Network;
	delegate: string;
	delegateSeedEnc: ArrayBuffer;
	iv: ArrayBuffer;
	permissions: string[];
	status: LinkStatus;
	lastLedger: number | null;
	revokeTx: JsonObject | null;
	createdAt: string;
}

export type LinkInsert = Omit<LinkRow, 'principal'>;
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
}

export type BuildInsert = Omit<BuildRow, 'principal'>;
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
}

export type ApprovalInsert = Omit<ApprovalRow, 'principal'>;
export type ApprovalUpdate = Partial<Pick<ApprovalRow, 'txJson' | 'expiresAt' | 'status'>>;

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
	delegate_seed_enc: ArrayBuffer;
	iv: ArrayBuffer;
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
const APPROVAL_STATUS = new Set<ApprovalStatus>(['pending', 'submitted', 'approved', 'expired', 'rejected']);
const SIGNED_BY = new Set<SignedBy>(['delegate', 'owner']);
const SENSITIVE_FRAGMENT = /seed|secret|private|mnemonic/i;

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
		if (SENSITIVE_FRAGMENT.test(value)) {
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
			if (SENSITIVE_FRAGMENT.test(key)) {
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

function linkFromRaw(row: RawLink): LinkRow {
	return {
		id: row.id,
		principal: row.principal,
		owner: row.owner,
		network: network(row.network, 'links.network'),
		delegate: row.delegate,
		delegateSeedEnc: row.delegate_seed_enc,
		iv: row.iv,
		permissions: parseJson(row.permissions, 'links.permissions', asStringArray),
		status: asStatus(row.status, LINK_STATUS, 'links.status'),
		lastLedger: row.last_ledger,
		revokeTx: row.revoke_tx === null ? null : parseJson(row.revoke_tx, 'links.revoke_tx', asObject),
		createdAt: row.created_at,
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
	return {
		id: row.id,
		principal: row.principal,
		owner: row.owner,
		network: network(row.network, 'builds.network'),
		txJson: parseJson(row.tx_json, 'builds.tx_json', asObject),
		summary: parseJson(row.summary, 'builds.summary', (value) => TxBuildSchema.shape.summary.parse(value)),
		lastLedgerSeq: row.last_ledger_seq,
		createdAt: row.created_at,
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
	return {
		id: row.id,
		principal: row.principal,
		buildId: row.build_id,
		txJson: parseJson(row.tx_json, 'approvals.tx_json', asObject),
		expiresAt: row.expires_at,
		status: asStatus(row.status, APPROVAL_STATUS, 'approvals.status'),
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
			.prepare('SELECT * FROM links WHERE principal = ? AND owner = ? AND network = ?')
			.bind(this.principal, owner, networkValue)
			.first<RawLink>();
		return row === null ? null : linkFromRaw(row);
	}

	async insertLink(input: LinkInsert): Promise<LinkRow> {
		await this.db
			.prepare(
				`INSERT INTO links
          (id, principal, owner, network, delegate, delegate_seed_enc, iv, permissions,
           status, last_ledger, revoke_tx, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				input.id,
				this.principal,
				input.owner,
				input.network,
				input.delegate,
				input.delegateSeedEnc,
				input.iv,
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
			.prepare('SELECT * FROM links WHERE principal = ? AND status = ? ORDER BY created_at, id')
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

	async insertBuild(input: BuildInsert): Promise<BuildRow> {
		await this.db
			.prepare(
				`INSERT INTO builds
          (id, principal, owner, network, tx_json, summary, last_ledger_seq, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
			)
			.run();
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
		await this.db
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
			)
			.run();
		return expectRow(await this.getExecution(input.id), 'executions');
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

	async getApproval(id: string): Promise<ApprovalRow | null> {
		const row = await this.db
			.prepare('SELECT * FROM approvals WHERE principal = ? AND id = ?')
			.bind(this.principal, id)
			.first<RawApproval>();
		return row === null ? null : approvalFromRaw(row);
	}

	async insertApproval(input: ApprovalInsert): Promise<ApprovalRow> {
		await this.requireOwnedBuild(input.buildId);
		await this.db
			.prepare(
				`INSERT INTO approvals (id, principal, build_id, tx_json, expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				input.id,
				this.principal,
				input.buildId,
				serializeJson(input.txJson, 'approvals.tx_json', asObject),
				input.expiresAt,
				input.status,
			)
			.run();
		return expectRow(await this.getApproval(input.id), 'approvals');
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
		const row = await this.db.prepare('SELECT * FROM links WHERE principal = ? AND id = ?').bind(this.principal, id).first<RawLink>();
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
