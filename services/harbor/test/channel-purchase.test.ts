import { Buffer } from 'node:buffer';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { buildMcIntent } from '../src/exec/ap4m-intent';
import { D1ChannelClaimStore } from '../src/exec/channel-claim-store';
import {
	ChannelPurchaseStoreError,
	D1ChannelPurchaseStore,
	executeChannelPurchase,
	type ExecuteChannelPurchaseInput,
	type ReserveChannelPurchaseInput,
} from '../src/exec/channel-purchase';
import { getCatalogMerchant } from '../src/ops/merchants';

type SqlValue = string | number | bigint | null | Uint8Array;

class SqliteD1Statement {
	private values: SqlValue[] = [];
	constructor(private readonly statement: StatementSync) {}
	bind(...values: unknown[]): this {
		this.values = values.map((value) => value instanceof ArrayBuffer
			? new Uint8Array(value)
			: value as SqlValue);
		return this;
	}
	async run(): Promise<D1Result> {
		const result = this.statement.run(...this.values);
		return { success: true, meta: { changes: Number(result.changes) } as D1Result['meta'] };
	}
	async first<T>(column?: string): Promise<T | null> {
		const row = this.statement.get(...this.values) as Record<string, unknown> | undefined;
		if (row === undefined) return null;
		return (column === undefined ? row : row[column]) as T;
	}
	async all<T>(): Promise<D1Result<T>> {
		return { success: true, results: this.statement.all(...this.values) as T[] };
	}
}

class SqliteD1 {
	readonly sqlite = new DatabaseSync(':memory:');
	private batchTail: Promise<void> = Promise.resolve();
	constructor(mode: 'combined' | 'pre-0010' = 'combined') {
		this.sqlite.exec('PRAGMA foreign_keys = ON');
		if (mode === 'combined') {
			const directory = fileURLToPath(new URL('../migrations-local-x402/', import.meta.url));
			for (const filename of readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
				this.sqlite.exec(readFileSync(`${directory}/${filename}`, 'utf8'));
			}
			seedRuntime(this.sqlite);
		} else {
			const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
			for (const filename of ['0001_init.sql', '0007_ap4m_mandates.sql', '0008_ap4m_purchase_attempts.sql']) {
				this.sqlite.exec(readFileSync(`${directory}/${filename}`, 'utf8'));
			}
		}
	}
	prepare(sql: string): SqliteD1Statement { return new SqliteD1Statement(this.sqlite.prepare(sql)); }
	async batch(statements: SqliteD1Statement[]): Promise<D1Result[]> {
		const before = this.batchTail;
		let release!: () => void;
		this.batchTail = new Promise<void>((resolve) => { release = resolve; });
		await before;
		try {
			this.sqlite.exec('BEGIN IMMEDIATE');
			const results: D1Result[] = [];
			for (const statement of statements) results.push(await statement.run());
			this.sqlite.exec('COMMIT');
			return results;
		} catch (error) {
			this.sqlite.exec('ROLLBACK');
			throw error;
		} finally {
			release();
		}
	}
	close(): void { this.sqlite.close(); }
}

const PRINCIPAL = 'mh5-test-principal';
const MANDATE_ID = 'mandate-mh5';
const IDEM = 'purchase-one';
const OWNER = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY';
const CHANNEL_ID = 'A'.repeat(64);
const PUBLIC_KEY = `ED${'B'.repeat(64)}`;
const NOW = new Date('2026-10-21T20:30:00.000Z');
const KEK = Buffer.alloc(32, 7).toString('base64');
const merchant = getCatalogMerchant('venue-yield-desk')!;

function seedRuntime(db: DatabaseSync): void {
	const channels = [{ merchant_id: merchant.id, channel_id: CHANNEL_ID, amount_drops: '100000' }];
	db.prepare(`INSERT INTO ap4m_mandates (
		id, principal, owner, network, status, execution_type, not_before, expires_at,
		constraints_json, agent_public_jwk, agent_key_enc, agent_key_iv,
		claim_keys_enc, claim_keys_iv, claim_public_keys_json, prepared_json,
		channels_json, created_at, updated_at
	) VALUES (?, ?, ?, 'testnet', 'ACTIVE', 'DEFERRED', ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		.run(
			MANDATE_ID, PRINCIPAL, OWNER, '2026-10-21T00:00:00.000Z', '2026-10-22T00:00:00.000Z',
			JSON.stringify({ currency: 'USD', per_payment_max: '5', total_max: '5', daily_max: '5',
				payees: [merchant.id], skus: ['yield-report'] }),
			new Uint8Array([1]), new Uint8Array(12), new Uint8Array([1]), new Uint8Array(12),
			JSON.stringify([{ merchant_id: merchant.id, public_key: PUBLIC_KEY }]),
			JSON.stringify({ unsigned_batch: {} }), JSON.stringify(channels),
			NOW.toISOString(), NOW.toISOString(),
		);
	db.prepare(`INSERT INTO policies (principal, owner, network, json, updated_at)
		VALUES (?, ?, 'testnet', ?, ?)`)
		.run(PRINCIPAL, OWNER, JSON.stringify({
			networks: ['testnet'], daily_cap_usd: 5, max_per_tx_usd: 5,
			issuer_allowlist: ['RLUSD'], ap4m_enabled: true,
		}), NOW.toISOString());
}

function intent(idempotencyKey = IDEM) {
	let counter = 1;
	return buildMcIntent({
		merchantId: merchant.id,
		merchantName: merchant.name,
		srcDpaId: merchant.src_dpa_id,
		sku: 'yield-report',
		itemName: merchant.products[0]!.name,
		priceUsd: merchant.products[0]!.price.value,
	}, {
		now: () => NOW,
		uuid: () => `00000000-0000-4000-8000-${String(counter++).padStart(12, String(idempotencyKey.length % 10))}`,
	});
}

function merchantResponse(intentId: string) {
	return {
		data: {
			schema_id: 'yield_report_v1' as const,
			venue: merchant.id,
			apr_percent: '4.2',
			tvl_usd: '1000000',
			risk: 'low',
		},
		intent_validation: {
			intentId,
			validated: true,
			checks: { agent_identity: 'pass' as const, intent: 'pass' as const,
				payment: 'pass' as const, credential: 'pass' as const },
			validation_errors: [],
		},
	};
}

function reserveInput(idempotencyKey = IDEM, overrides: Partial<ReserveChannelPurchaseInput> = {}): ReserveChannelPurchaseInput {
	const preparedIntent = intent(idempotencyKey);
	return {
		id: `attempt-${idempotencyKey}`,
		mandateId: MANDATE_ID,
		idempotencyKey,
		requestFingerprint: 'F'.repeat(64),
		merchant,
		sku: 'yield-report',
		payer: OWNER,
		channel: { merchant_id: merchant.id, channel_id: CHANNEL_ID, amount_drops: '100000' },
		priceDrops: '50000',
		previousDrops: '0',
		cumulativeDrops: '50000',
		claimToken: (idempotencyKey === IDEM ? 'C' : 'D').repeat(64),
		publicKey: PUBLIC_KEY,
		spendId: `spend-${idempotencyKey}`,
		spendDay: NOW.toISOString().slice(0, 10),
		amountUsd: '1',
		receiptId: `receipt-${idempotencyKey}`,
		retryMaterial: { intent: preparedIntent, viL1: 'l1', viL2: 'l2', viL3b: 'l3b', exchangeState: { nonce: idempotencyKey } },
		l3aDigest: 'a'.repeat(64),
		l3bDigest: 'b'.repeat(64),
		at: NOW.toISOString(),
		...overrides,
	};
}

function executeInput(idempotencyKey = IDEM, overrides: Partial<ExecuteChannelPurchaseInput> = {}): ExecuteChannelPurchaseInput {
	const preparedIntent = intent(idempotencyKey);
	return {
		principal: PRINCIPAL,
		mandateId: MANDATE_ID,
		idempotencyKey,
		requestFingerprint: 'F'.repeat(64),
		merchant,
		sku: 'yield-report',
		payer: OWNER,
		channel: { merchant_id: merchant.id, channel_id: CHANNEL_ID, amount_drops: '100000' },
		identity: { principal: PRINCIPAL, owner: OWNER, network: 'testnet', mandateId: MANDATE_ID },
		wrappedKeys: {
			ciphertext: new ArrayBuffer(17),
			iv: new ArrayBuffer(12),
			publicKeys: [{ merchant_id: merchant.id, public_key: PUBLIC_KEY }],
		},
		recoveryKek: KEK,
		amountUsd: '1',
		prepare: vi.fn(async () => ({
			priceDrops: '50000', intent: preparedIntent,
			viL1: 'l1', viL2: 'l2', viL3b: 'l3b',
			l3aDigest: 'a'.repeat(64), l3bDigest: 'b'.repeat(64),
			exchangeState: { nonce: idempotencyKey },
		})),
		exchange: vi.fn(async ({ mastercardIntent }) => merchantResponse(mastercardIntent.intentId)),
		...overrides,
	};
}

function stores(db: SqliteD1) {
	const claimStore = new D1ChannelClaimStore(db as unknown as D1Database, PRINCIPAL);
	const purchaseStore = new D1ChannelPurchaseStore(db as unknown as D1Database, PRINCIPAL);
	const withSigner = vi.fn(async (_identity, _wrapped, _merchantId, _kek, callback) =>
		callback({ publicKey: PUBLIC_KEY, sign: () => '30' }));
	return {
		claimStore,
		purchaseStore,
		withSigner,
		dependencies: { store: claimStore, claimStore, purchaseStore, withSigner, now: () => NOW },
	};
}

describe('MH5 durable channel purchase facade', () => {
	it.each([
		['duplicate merchant keys', [
			{ merchant_id: merchant.id, public_key: PUBLIC_KEY },
			{ merchant_id: merchant.id, public_key: `ED${'C'.repeat(64)}` },
		]],
		['malformed first merchant key', [
			{ merchant_id: merchant.id, public_key: PUBLIC_KEY.toLowerCase() },
			{ merchant_id: 'venue-risk-oracle', public_key: `ED${'C'.repeat(64)}` },
		]],
	] as const)('rejects %s before any durable purchase or spend write', async (_label, publicKeys) => {
		const db = new SqliteD1();
		try {
			const state = stores(db);
			const input = executeInput(IDEM, {
				wrappedKeys: { ciphertext: new ArrayBuffer(17), iv: new ArrayBuffer(12), publicKeys },
			});
			await expect(executeChannelPurchase(input, state.dependencies)).rejects.toMatchObject({
				code: 'INVALID_INPUT',
			});
			expect(input.prepare).not.toHaveBeenCalled();
			expect(db.sqlite.prepare(`SELECT count(*) AS count FROM ap4m_spend`).get()).toEqual({ count: 0 });
			expect(db.sqlite.prepare(`SELECT count(*) AS count FROM ap4m_channel_claim_attempts`).get())
				.toEqual({ count: 0 });
			expect(db.sqlite.prepare(`SELECT count(*) AS count FROM ap4m_paychan_purchase_attempts`).get())
				.toEqual({ count: 0 });
		} finally {
			db.close();
		}
	});

	it('rejects a Mastercard intent that does not match the registry before durable writes', async () => {
		const db = new SqliteD1();
		try {
			const state = stores(db);
			const malformed = structuredClone(intent());
			malformed.orders[0]!.items[0]!.itemName = 'attacker-controlled item';
			const input = executeInput(IDEM, {
				prepare: vi.fn(async () => ({
					priceDrops: '50000', intent: malformed,
					viL1: 'l1', viL2: 'l2', viL3b: 'l3b',
					l3aDigest: 'a'.repeat(64), l3bDigest: 'b'.repeat(64),
					exchangeState: { nonce: IDEM },
				})),
			});
			await expect(executeChannelPurchase(input, state.dependencies)).rejects.toMatchObject({
				code: 'INVALID_INPUT',
			});
			expect(input.exchange).not.toHaveBeenCalled();
			expect(db.sqlite.prepare(`SELECT count(*) AS count FROM ap4m_spend`).get()).toEqual({ count: 0 });
			expect(db.sqlite.prepare(`SELECT count(*) AS count FROM ap4m_channel_claim_attempts`).get())
				.toEqual({ count: 0 });
			expect(db.sqlite.prepare(`SELECT count(*) AS count FROM ap4m_paychan_purchase_attempts`).get())
				.toEqual({ count: 0 });
		} finally {
			db.close();
		}
	});

	it('reserves, signs, accepts and durably replays one exact five-field claim result', async () => {
		const db = new SqliteD1();
		try {
			const state = stores(db);
			const input = executeInput();
			const first = await executeChannelPurchase(input, state.dependencies);
			expect(Object.keys(first.proof).sort()).toEqual([
				'channel_id', 'cumulative_drops', 'public_key', 'scheme', 'signature',
			]);
			expect(first.proof).toEqual({
				scheme: 'xrpl-paychan', channel_id: CHANNEL_ID, cumulative_drops: '50000',
				signature: '30', public_key: PUBLIC_KEY,
			});
			expect(first.result.receipt).toMatchObject({
				mandate_id: MANDATE_ID, merchant_id: merchant.id, scheme: 'xrpl-paychan',
				settlement: 'claim_accepted',
				proof: { channel_id: CHANNEL_ID, cumulative_drops: '50000' },
			});
			expect((await state.purchaseStore.read(MANDATE_ID, IDEM)).outcome).toBe('delivered');
			const spend = db.sqlite.prepare(`SELECT status FROM ap4m_spend WHERE principal = ? AND idempotency_key = ?`).get(PRINCIPAL, IDEM) as { status: string };
			expect(spend.status).toBe('committed');

			const replay = await executeChannelPurchase(input, state.dependencies);
			expect(replay).toEqual({ ...first, replayed: true });
			expect(input.prepare).toHaveBeenCalledTimes(1);
			expect(input.exchange).toHaveBeenCalledTimes(1);
			expect(state.withSigner).toHaveBeenCalledTimes(1);

			await expect(executeChannelPurchase({ ...input, requestFingerprint: 'E'.repeat(64) }, state.dependencies))
				.rejects.toMatchObject({ code: 'STORE_CONFLICT' });
		} finally {
			db.close();
		}
	});

	it('resumes a signed crash with the same proof and durable merchant route without re-signing', async () => {
		const db = new SqliteD1();
		try {
			const state = stores(db);
			const firstExchange = vi.fn(async () => { throw new Error('simulated transport crash'); });
			const firstInput = executeInput(IDEM, { exchange: firstExchange });
			await expect(executeChannelPurchase(firstInput, state.dependencies)).rejects.toThrow('simulated transport crash');
			const pending = await state.purchaseStore.read(MANDATE_ID, IDEM);
			expect(pending.outcome).toBe('pending');
			if (pending.outcome !== 'pending') throw new Error('expected pending purchase');
			expect(pending.attempt.status).toBe('claim_signed');
			const originalBase = pending.attempt.merchantSnapshot.base_url.replace(/\/+$/, '');

			const retryExchange = vi.fn(async (request: Parameters<ExecuteChannelPurchaseInput['exchange']>[0]) => {
				expect(request.trustedRegistryUrl).toBe(`${originalBase}/resource/yield-report`);
				expect(Object.keys(request.paymentHeader).sort()).toEqual([
					'channel_id', 'cumulative_drops', 'public_key', 'scheme', 'signature',
				]);
				return merchantResponse(request.mastercardIntent.intentId);
			});
			const retryInput = executeInput(IDEM, {
				merchant: {
					...merchant,
					base_url: 'https://attacker.invalid/redirect',
					schemes: ['exact'],
					products: [{ ...merchant.products[0]!, description: 'mutated catalog prose' }],
				},
				prepare: vi.fn(async () => { throw new Error('prepare must not run on signed retry'); }),
				exchange: retryExchange,
			});
			const recovered = await executeChannelPurchase(retryInput, state.dependencies);
			expect(recovered.proof).toEqual({
				scheme: 'xrpl-paychan', channel_id: CHANNEL_ID, cumulative_drops: '50000',
				signature: '30', public_key: PUBLIC_KEY,
			});
			expect(state.withSigner).toHaveBeenCalledTimes(1);
			expect(retryInput.prepare).not.toHaveBeenCalled();
			expect(retryExchange).toHaveBeenCalledTimes(1);
		} finally {
			db.close();
		}
	});

	it('atomically permits one parallel reservation and leaves no loser spend or counter residue', async () => {
		for (const ids of [[IDEM, 'purchase-two'], ['purchase-two', IDEM]] as const) {
			const db = new SqliteD1();
			try {
				const state = stores(db);
				const attempts = await Promise.allSettled(ids.map((id) =>
					state.purchaseStore.reserve(reserveInput(id), KEK)));
				expect(attempts.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
				expect(attempts.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
				expect(db.sqlite.prepare(`SELECT count(*) AS count FROM ap4m_paychan_purchase_attempts`)
					.get()).toEqual({ count: 1 });
				expect(db.sqlite.prepare(`SELECT count(*) AS count FROM ap4m_spend`).get()).toEqual({ count: 1 });
				expect(db.sqlite.prepare(`SELECT spent_microusd FROM ap4m_mandates WHERE id = ?`).get(MANDATE_ID))
					.toEqual({ spent_microusd: 1_000_000 });
			} finally {
				db.close();
			}
		}
	});

	it('advances exact prices monotonically to the channel cap and leaves no over-cap spend', async () => {
		const db = new SqliteD1();
		try {
			const state = stores(db);
			const first = await executeChannelPurchase(executeInput(IDEM), state.dependencies);
			const second = await executeChannelPurchase(executeInput('purchase-two'), state.dependencies);
			expect(first.proof.cumulative_drops).toBe('50000');
			expect(second.proof.cumulative_drops).toBe('100000');
			await expect(executeChannelPurchase(executeInput('purchase-three'), state.dependencies))
				.rejects.toMatchObject({ code: 'CHANNEL_AMOUNT_EXCEEDED' });
			expect(db.sqlite.prepare(`SELECT count(*) AS count FROM ap4m_paychan_purchase_attempts`).get())
				.toEqual({ count: 2 });
			expect(db.sqlite.prepare(`SELECT count(*) AS count FROM ap4m_spend`).get())
				.toEqual({ count: 2 });
			expect(db.sqlite.prepare(`SELECT spent_microusd FROM ap4m_mandates WHERE id = ?`).get(MANDATE_ID))
				.toEqual({ spent_microusd: 2_000_000 });
		} finally {
			db.close();
		}
	});

	it('rejects oversized drop and USD inputs without durable writes', async () => {
		const db = new SqliteD1();
		try {
			const state = stores(db);
			const huge = '9'.repeat(100_000);
			await expect(state.purchaseStore.reserve(reserveInput(IDEM, {
				priceDrops: huge,
				cumulativeDrops: huge,
			}), KEK)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
			const hugeMerchant = {
				...merchant,
				products: [{ ...merchant.products[0]!, price: { ...merchant.products[0]!.price, value: huge } }],
			};
			await expect(state.purchaseStore.reserve(reserveInput(IDEM, {
				merchant: hugeMerchant,
				amountUsd: huge,
			}), KEK)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
			expect(db.sqlite.prepare(`SELECT count(*) AS count FROM ap4m_spend`).get()).toEqual({ count: 0 });
		} finally {
			db.close();
		}
	});

	it('keeps receipt, spend and result atomic across a delivery write fault', async () => {
		const db = new SqliteD1();
		try {
			db.sqlite.exec(`CREATE TRIGGER mh5_fail_delivery
				BEFORE UPDATE ON ap4m_paychan_purchase_attempts
				WHEN NEW.status = 'delivered'
				BEGIN SELECT RAISE(ABORT, 'injected delivery fault'); END`);
			const state = stores(db);
			const input = executeInput();
			await expect(executeChannelPurchase(input, state.dependencies)).rejects.toMatchObject({
				code: 'STORE_CONFLICT',
			});
			expect(db.sqlite.prepare(`SELECT count(*) AS count FROM ap4m_receipts`).get()).toEqual({ count: 0 });
			expect(db.sqlite.prepare(`SELECT status FROM ap4m_spend WHERE principal = ? AND idempotency_key = ?`)
				.get(PRINCIPAL, IDEM)).toEqual({ status: 'reserved' });
			expect(db.sqlite.prepare(`SELECT status, result_json, delivered_at
				FROM ap4m_paychan_purchase_attempts WHERE principal = ? AND idempotency_key = ?`)
				.get(PRINCIPAL, IDEM)).toEqual({
				status: 'merchant_accepted', result_json: null, delivered_at: null,
			});

			db.sqlite.exec(`DROP TRIGGER mh5_fail_delivery`);
			const recovered = await executeChannelPurchase(input, state.dependencies);
			expect(recovered.result.receipt.settlement).toBe('claim_accepted');
			expect(input.exchange).toHaveBeenCalledTimes(1);
			expect(state.withSigner).toHaveBeenCalledTimes(1);
		} finally {
			db.close();
		}
	});

	it('charges the shared cap to the immutable execution snapshot after build attribution mutates', async () => {
		const db = new SqliteD1();
		try {
			db.sqlite.prepare(`INSERT INTO builds (
				id, principal, owner, network, tx_json, summary, last_ledger_seq, created_at
			) VALUES (?, ?, ?, 'testnet', '{}', '{}', 100, ?)`)
				.run('build-cap', PRINCIPAL, OWNER, NOW.toISOString());
			db.sqlite.prepare(`INSERT INTO executions (
				id, principal, build_id, idempotency_key, status, usd_value, created_at
			) VALUES (?, ?, ?, ?, 'executed', 4.5, ?)`)
				.run('execution-cap', PRINCIPAL, 'build-cap', 'execution-cap-idem', NOW.toISOString());
			expect(db.sqlite.prepare(`SELECT snapshot_owner, snapshot_network
				FROM execution_snapshots WHERE execution_id = ?`).get('execution-cap')).toEqual({
				snapshot_owner: OWNER,
				snapshot_network: 'testnet',
			});
			db.sqlite.prepare(`UPDATE builds SET owner = ?, network = 'devnet' WHERE id = ?`)
				.run(merchant.xrpl_address, 'build-cap');

			const state = stores(db);
			const input = executeInput();
			await expect(executeChannelPurchase(input, state.dependencies))
				.rejects.toMatchObject({ code: 'SPEND_LIMIT' });
			expect(state.withSigner).not.toHaveBeenCalled();
			expect(db.sqlite.prepare(`SELECT count(*) AS count FROM ap4m_spend`).get()).toEqual({ count: 0 });
		} finally {
			db.close();
		}
	});

	it('fails closed before signing for missing schema, price undercount, policy gate and exact-rail collision', async () => {
		const preMigration = new SqliteD1('pre-0010');
		try {
			const store = new D1ChannelPurchaseStore(preMigration as unknown as D1Database, PRINCIPAL);
			await expect(store.read(MANDATE_ID, IDEM)).rejects.toMatchObject({ code: 'SCHEMA_UNAVAILABLE' });
			expect(preMigration.sqlite.prepare(
				`SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'ap4m_paychan_purchase_attempts'`,
			).get()).toEqual({ count: 0 });
		} finally {
			preMigration.close();
		}

		const undercountDb = new SqliteD1();
		try {
			const state = stores(undercountDb);
			await expect(state.purchaseStore.reserve(reserveInput(IDEM, { amountUsd: '0.5' }), KEK))
				.rejects.toMatchObject({ code: 'INVALID_INPUT' });
			expect(undercountDb.sqlite.prepare(`SELECT count(*) AS count FROM ap4m_spend`).get())
				.toEqual({ count: 0 });
		} finally {
			undercountDb.close();
		}

		const gatedDb = new SqliteD1();
		try {
			gatedDb.sqlite.prepare(`UPDATE policies SET json = ?`).run(JSON.stringify({
				networks: ['testnet'], daily_cap_usd: 5, max_per_tx_usd: 5,
				issuer_allowlist: ['RLUSD'], ap4m_enabled: false,
			}));
			const state = stores(gatedDb);
			const input = executeInput();
			await expect(executeChannelPurchase(input, state.dependencies))
				.rejects.toMatchObject({ code: 'SPEND_LIMIT' });
			expect(state.withSigner).not.toHaveBeenCalled();
			expect(input.exchange).not.toHaveBeenCalled();
		} finally {
			gatedDb.close();
		}

		const exactDb = new SqliteD1();
		try {
			exactDb.sqlite.prepare(`INSERT INTO ap4m_purchase_attempts (
				id, principal, mandate_id, idempotency_key, request_fingerprint, merchant_id,
				sku, status, lease_acquired_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?, ?)`)
				.run('exact-attempt', PRINCIPAL, MANDATE_ID, IDEM, 'E'.repeat(64), merchant.id,
					'yield-report', NOW.toISOString(), NOW.toISOString(), NOW.toISOString());
			const state = stores(exactDb);
			const input = executeInput();
			await expect(executeChannelPurchase(input, state.dependencies)).rejects.toBeInstanceOf(ChannelPurchaseStoreError);
			expect(state.withSigner).not.toHaveBeenCalled();
			expect(input.exchange).not.toHaveBeenCalled();
			expect(exactDb.sqlite.prepare(`SELECT count(*) AS count FROM ap4m_purchase_attempts`).get())
				.toEqual({ count: 1 });
			expect(exactDb.sqlite.prepare(`SELECT count(*) AS count FROM ap4m_paychan_purchase_attempts`).get())
				.toEqual({ count: 0 });
		} finally {
			exactDb.close();
		}
	});
});
