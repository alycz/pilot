import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Wallet, type Transaction } from 'xrpl';

import { OpRegistry } from '../src/catalog/registry';
import { D1WorkAgreementStore } from '../src/exec/work-agreement-d1';
import { D1LocalMockWorkAgreementEffects } from '../src/exec/work-agreement-mock-effects';
import { WorkAgreementRuntime } from '../src/exec/work-agreement-runtime';
import { createWorker, type Env } from '../src/server';
import { handleWorkAgreementRoute, type WorkAgreementRouteContext } from '../src/work-agreement-route';

type SqlValue = string | number | bigint | null | Uint8Array;
class SqliteD1Statement {
	#values: SqlValue[] = [];
	constructor(private readonly statement: StatementSync) {}
	bind(...values: unknown[]): this {
		this.#values = values.map((value) => value instanceof ArrayBuffer ? new Uint8Array(value) : value as SqlValue);
		return this;
	}
	async run(): Promise<D1Result> {
		const result = this.statement.run(...this.#values);
		return { success: true, meta: { changes: Number(result.changes) } as D1Result['meta'] };
	}
	async first<T>(column?: string): Promise<T | null> {
		const row = this.statement.get(...this.#values) as Record<string, unknown> | undefined;
		return row === undefined ? null : (column === undefined ? row : row[column]) as T;
	}
}
class SqliteD1 {
	readonly sqlite = new DatabaseSync(':memory:');
	prepare(sql: string): SqliteD1Statement { return new SqliteD1Statement(this.sqlite.prepare(sql)); }
	async exec(sql: string): Promise<D1ExecResult> { this.sqlite.exec(sql); return { count: 0, duration: 0 }; }
	close(): void { this.sqlite.close(); }
}

const open = new Set<SqliteD1>();
afterEach(() => { for (const db of open) db.close(); open.clear(); });
function database(): SqliteD1 { const db = new SqliteD1(); open.add(db); return db; }
function context(db = database()): WorkAgreementRouteContext {
	return {
		principal: 'agreement-route-principal', localDevRequest: true, db: db as unknown as D1Database,
		env: { HARBOR_LOCAL_DEV: 'true', HARBOR_MOCK: '1', HARBOR_LOCAL_WORK_AGREEMENT_ENABLED: 'true',
			EXEC_NETWORK: 'testnet', MAINNET_EXECUTION: 'false', HARBOR_SOURCE_TAG: '2610240' },
	};
}
async function call(ctx: WorkAgreementRouteContext, name: string, body: unknown) {
	const response = await handleWorkAgreementRoute(new Request(`http://127.0.0.1:8791/api/ops/${name}`, {
		method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
	}), ctx);
	if (!response) throw new Error('work-agreement route was not handled');
	return { response, envelope: await response.json() as any };
}
function prepareBody(owner: Wallet, counterparty: Wallet, action: 'create' | 'release' | 'cancel' = 'create') {
	return {
		owner: owner.classicAddress, network: 'testnet', agreement_id: 'agreement-route-0001', action,
		idempotency_key: `agreement-${action}-idempotency-0001`,
		approval_expires_at: new Date(Date.now() + 4 * 60_000).toISOString(),
		terms: { counterparty: counterparty.classicAddress, amount_drops: '2500000',
			finish_after: 900_000_000, cancel_after: 900_000_600 },
	};
}
function decision(prepared: any) {
	return { owner: prepared.owner, network: prepared.network, agreement_id: prepared.agreement_id,
		approval_id: prepared.approval.approval_id, idempotency_key: prepared.approval.idempotency_key };
}
async function restartedContext(ctx: WorkAgreementRouteContext): Promise<WorkAgreementRouteContext> {
	const store = new D1WorkAgreementStore(ctx.db); const effects = new D1LocalMockWorkAgreementEffects(ctx.db);
	await Promise.all([store.initialize(), effects.initialize()]);
	return { ...ctx, workAgreementRuntime: new WorkAgreementRuntime({ store, effects, enabled: true }) };
}

describe('reachable durable local work-agreement operations', () => {
	it('requires named Bearer authentication for all routes before storage', async () => {
		const db = database(); const owner = Wallet.generate(); const counterparty = Wallet.generate();
		const env = { DB: db as unknown as D1Database, EXECUTOR: 'quickjs',
			HARBOR_API_KEYS: 'agreement-principal:agreement-secret', HARBOR_LOCAL_DEV: 'true', HARBOR_MOCK: '1',
			HARBOR_LOCAL_WORK_AGREEMENT_ENABLED: 'true', EXEC_NETWORK: 'testnet', MAINNET_EXECUTION: 'false',
			HARBOR_SOURCE_TAG: '2610240' } satisfies Env;
		const worker = createWorker(new OpRegistry());
		for (const name of ['workAgreement.prepare', 'workAgreement.submit', 'workAgreement.recover',
			'workAgreement.reject', 'workAgreement.status']) {
			const response = await worker.fetch!(new Request(`http://127.0.0.1:8791/api/ops/${name}`, {
				method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify(prepareBody(owner, counterparty)),
			}), env, {} as ExecutionContext);
			expect(response.status, name).toBe(401);
		}
		expect(db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='local_work_agreement_events'").get()).toBeUndefined();
		const authorized = await worker.fetch!(new Request('http://127.0.0.1:8791/api/ops/workAgreement.prepare', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: 'Bearer agreement-principal:agreement-secret' },
			body: JSON.stringify(prepareBody(owner, counterparty)),
		}), env, {} as ExecutionContext);
		expect(authorized.status).toBe(200);
		await expect(authorized.json()).resolves.toMatchObject({ ok: true, data: { status: 'awaiting_approval' } });
	});

	it('fails closed for reserved principal and disabled or mainnet-shaped configuration', async () => {
		const owner = Wallet.generate(); const counterparty = Wallet.generate(); const db = database(); const base = context(db);
		const reserved = await call({ ...base, principal: 'local-dev' }, 'workAgreement.prepare', prepareBody(owner, counterparty));
		expect(reserved.response.status).toBe(401); expect(reserved.envelope.error.code).toBe('UNAUTHORIZED');
		const disabled = await call({ ...base, env: { ...base.env, HARBOR_LOCAL_WORK_AGREEMENT_ENABLED: 'false' } },
			'workAgreement.prepare', prepareBody(owner, counterparty));
		expect(disabled.response.status).toBe(404); expect(disabled.envelope.error.code).toBe('WORK_AGREEMENT_DISABLED');
		const mainnet = await call({ ...base, env: { ...base.env, EXEC_NETWORK: 'mainnet', MAINNET_EXECUTION: 'true' } },
			'workAgreement.prepare', prepareBody(owner, counterparty));
		expect(mainnet.response.status).toBe(404);
		expect(db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='local_work_agreement_events'").get()).toBeUndefined();
	});

	it('survives restarts through create then release without redispatching', async () => {
		const owner = Wallet.generate(); const counterparty = Wallet.generate(); let ctx = context();
		const preparedCreate = await call(ctx, 'workAgreement.prepare', prepareBody(owner, counterparty));
		expect(preparedCreate.envelope).toMatchObject({ ok: true, data: { status: 'awaiting_approval', simulation: true,
			settlement_provenance: 'local-mock-simulated-settlement', live_validation_claimed: false,
			physical_device_inferred: false, speculos_conformance_claimed: false, owner_key_custody: false,
			network_requests_made: 0 } });
		const create = preparedCreate.envelope.data;
		const createBlob = owner.sign(create.approval.tx_json as Transaction).tx_blob;
		const submittedCreate = await call(ctx, 'workAgreement.submit', { ...decision(create),
			attempt_id: 'agreement-create-attempt-0001', signed_blob: createBlob });
		expect(submittedCreate.envelope).toMatchObject({ ok: true, data: { status: 'unknown', outcome: 'submitted' } });
		ctx = await restartedContext(ctx);
		const recoveredCreate = await call(ctx, 'workAgreement.recover', decision(create));
		expect(recoveredCreate.envelope).toMatchObject({ ok: true, data: { status: 'active', outcome: 'validated',
			offer_sequence: 42, create_evidence: { validated: true, engine_result: 'tesSUCCESS' } } });

		const preparedRelease = await call(ctx, 'workAgreement.prepare', prepareBody(owner, counterparty, 'release'));
		const release = preparedRelease.envelope.data;
		const releaseBlob = owner.sign(release.approval.tx_json as Transaction).tx_blob;
		await call(ctx, 'workAgreement.submit', { ...decision(release),
			attempt_id: 'agreement-release-attempt-0001', signed_blob: releaseBlob });
		ctx = await restartedContext(ctx);
		const recoveredRelease = await call(ctx, 'workAgreement.recover', decision(release));
		expect(recoveredRelease.envelope).toMatchObject({ ok: true, data: { status: 'released', outcome: 'validated',
			terminal_evidence: { validated: true, engine_result: 'tesSUCCESS' } } });
		const rows = (ctx.db as unknown as SqliteD1).sqlite.prepare('SELECT COUNT(*) AS count FROM work_agreement_mock_relay').get() as { count: number };
		expect(rows.count).toBe(2);
	});

	it('rejects transaction mutation and cross-account reads before mock dispatch', async () => {
		const owner = Wallet.generate(); const counterparty = Wallet.generate(); const ctx = context();
		const prepared = (await call(ctx, 'workAgreement.prepare', prepareBody(owner, counterparty))).envelope.data;
		const changedBlob = owner.sign({ ...prepared.approval.tx_json, Amount: '2500001' } as Transaction).tx_blob;
		const mutated = await call(ctx, 'workAgreement.submit', { ...decision(prepared),
			attempt_id: 'agreement-mutated-attempt-0001', signed_blob: changedBlob });
		expect(mutated.envelope).toMatchObject({ ok: false, error: { code: 'SIGNED_TRANSACTION_BINDING_MISMATCH' } });
		const crossAccount = await call(ctx, 'workAgreement.status', { owner: counterparty.classicAddress,
			network: 'testnet', agreement_id: prepared.agreement_id });
		expect(crossAccount.envelope).toMatchObject({ ok: false, error: { code: 'AGREEMENT_NOT_FOUND' } });
		const rows = (ctx.db as unknown as SqliteD1).sqlite.prepare('SELECT COUNT(*) AS count FROM work_agreement_mock_relay').get() as { count: number };
		expect(rows.count).toBe(0);
	});
});
