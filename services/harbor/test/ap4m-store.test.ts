import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import {
	Ap4mPurchaseStore,
	Ap4mPurchaseStoreError,
	unwrapAp4mPreparedContext,
	wrapAp4mPreparedContext,
	type Ap4mStoredResult,
} from '../src/exec/ap4m-store';

function sqliteValue(value: unknown): unknown {
	return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}

class Statement {
	private values: unknown[] = [];
	constructor(
		readonly database: DatabaseSync,
		readonly sql: string,
	) {}
	bind(...values: unknown[]) {
		this.values = values.map(sqliteValue);
		return this;
	}
	async run() {
		const result = this.database.prepare(this.sql).run(...(this.values as never[]));
		return { success: true, meta: { changes: Number(result.changes) } };
	}
	async first<T>() {
		return (this.database.prepare(this.sql).get(...(this.values as never[])) ?? null) as T | null;
	}
}

class SqliteD1 {
	readonly database = new DatabaseSync(':memory:');
	private batchTail: Promise<void> = Promise.resolve();
	constructor(mode: 'normal' | 'combined-local' = 'normal') {
		this.database.exec('PRAGMA foreign_keys = ON');
		const migrations = mode === 'normal'
			? [
				'../migrations/0001_init.sql',
				'../migrations/0002_build_capability_isolation.sql',
				'../migrations/0003_execution_lifetime_v2.sql',
				'../migrations/0007_ap4m_mandates.sql',
				'../migrations/0008_ap4m_purchase_attempts.sql',
			]
			: [
				'../migrations-local-x402/0001_init.sql',
				'../migrations-local-x402/0002_x402_payments.sql',
				'../migrations-local-x402/0003_x402_payers.sql',
				'../migrations-local-x402/0004_x402_sequence_safety.sql',
				'../migrations-local-x402/0005_x402_durable_lease.sql',
				'../migrations-local-x402/0006_x402_budget_accounting.sql',
				'../migrations-local-x402/0007_x402_payer_provisioning.sql',
				'../migrations-local-x402/0008_ap4m_shared_runtime.sql',
			];
		for (const migration of migrations) {
			this.database.exec(readFileSync(new URL(migration, import.meta.url), 'utf8'));
		}
	}
	prepare(sql: string) {
		return new Statement(this.database, sql);
	}
	async batch(statements: Statement[]) {
		let release!: () => void;
		const previous = this.batchTail;
		this.batchTail = new Promise<void>((resolve) => { release = resolve; });
		await previous;
		this.database.exec('BEGIN IMMEDIATE');
		try {
			const results = [];
			for (const statement of statements) results.push(await statement.run());
			this.database.exec('COMMIT');
			return results;
		} catch (error) {
			this.database.exec('ROLLBACK');
			throw error;
		} finally {
			release();
		}
	}
}

const PRINCIPAL = 'pilot';
const OWNER = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY';
const OTHER_OWNER = 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59';
const MANDATE = 'mandate-1';
const FP = 'A'.repeat(64);
const HASH = 'B'.repeat(64);
const L3A_DIGEST = 'a'.repeat(64);
const L3B_DIGEST = 'b'.repeat(64);
const RLUSD_WIRE = Buffer.from('RLUSD').toString('hex').toUpperCase().padEnd(40, '0');
const CREATED = '2026-10-21T18:00:00.000Z';
const LEGACY_KEK = Buffer.alloc(32, 7).toString('base64');
const SIGNING_TOKEN_A = '11111111-1111-4111-8111-111111111111';
const SIGNING_TOKEN_B = '22222222-2222-4222-8222-222222222222';

function signingLease(token = SIGNING_TOKEN_A, at = '2026-10-21T18:02:00.000Z') {
	return {
		token,
		firstEligibleLedgerIndex: 45,
		staleBefore: '2026-10-21T18:01:00.000Z',
		at,
	};
}

function base64urlJson(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function preparedContext(amount = '6') {
	const intent = {
		intentId: 'demo-intent-11111111-1111-4111-8111-111111111111',
		intentSummary: 'Purchase yield-report from Demo Merchant',
		intentStatus: 'ACTIVE' as const,
		orders: [{
			orderId: 'demo-order-22222222-2222-4222-8222-222222222222',
			orderExecutionType: 'DEFERRED' as const,
			orderExpiry: 1_798_000_000,
			orderTotalAmount: { amount, currency: 'USD' },
			items: [{
				itemId: 'yield-report', itemName: 'Yield report',
				itemUnitPrice: { amount, currency: 'USD' },
				itemQuantity: 1, itemDeliveryMethod: 'DIGITAL' as const,
			}],
			merchants: [{ srcDpaId: 'src-dpa-1', merchantName: 'Demo Merchant' }],
		}],
	};
	const acceptedRequirement = {
		scheme: 'exact', network: 'xrpl:1', asset: RLUSD_WIRE, payTo: 'rMerchant', amount,
		maxTimeoutSeconds: 60,
		extra: { areFeesSponsored: false, assetTransferMethod: 'sequence', invoiceId: 'invoice-1', issuer: 'rIssuer' },
	};
	return {
		intent,
		vi: {
			l1: 'l1.jwt~disclosure', l2: 'l2.jwt~disclosure', l3a: 'l3a.jwt~disclosure',
			l3b: 'l3b.jwt~disclosure', l3aDigest: L3A_DIGEST, l3bDigest: L3B_DIGEST,
		},
		challenge: {
			x402Version: 2,
			scheme: 'exact',
			network: 'xrpl:1',
			currency: RLUSD_WIRE,
			issuer: 'rIssuer',
			amount,
			payTo: 'rMerchant',
			resource: { url: 'https://merchant.example/resource/yield-report' },
			accepted: acceptedRequirement,
		},
		challengeState: 'sealed-challenge-state.jwt',
		payer: 'rExactPreparedPayer',
		merchantSnapshot: {
			id: 'merchant-a',
			name: 'Demo Merchant',
			network: 'testnet' as const,
			base_url: 'https://merchant.example',
			xrpl_address: 'rMerchant',
			src_dpa_id: 'src-dpa-1',
			schemes: ['exact' as const],
			settle_asset: { kind: 'iou' as const, currency: 'RLUSD', issuer: 'rIssuer' },
			required_credential: { issuer: 'encrypted-credential-issuer', credential_type_hex: 'A1B2' },
			products: [{
				sku: 'yield-report', name: 'Yield report',
				description: 'Encrypted recovery-only product description',
				price: { asset: { kind: 'iou' as const, currency: 'RLUSD', issuer: 'rIssuer' }, value: amount },
				response_schema_id: 'encrypted_yield_report_v1',
			}],
			wba_required: true,
		},
		receiptAmount: {
			asset: { kind: 'iou' as const, currency: 'RLUSD', issuer: 'rIssuer' },
			value: amount,
		},
		acceptedRequirement,
		resourceUrl: 'https://merchant.example/resource/yield-report',
		receiptId: 'receipt-1',
		retryHeaders: {
			'x-mastercard-intent': base64urlJson(intent),
			'x-vi-l1': 'l1.jwt~disclosure',
			'x-vi-l2': 'l2.jwt~disclosure',
			'x-vi-l3b': 'l3b.jwt~disclosure',
		},
	};
}

function merchantResponse() {
	return {
		data: {
			schema_id: 'yield_report_v1' as const,
			venue: 'demo', apr_percent: '4.10', tvl_usd: '1000000', risk: 'low',
		},
		intent_validation: {
			intentId: preparedContext().intent.intentId,
			validated: true,
			checks: { agent_identity: 'pass' as const, intent: 'pass' as const, payment: 'pass' as const, credential: 'pass' as const },
			validation_errors: [],
		},
	};
}

function setPolicy(db: SqliteD1, overrides: Record<string, unknown> = {}): void {
	const policy = {
		ap4m_enabled: true,
		networks: ['testnet'],
		issuer_allowlist: ['RLUSD'],
		max_per_tx_usd: 100,
		daily_cap_usd: 100,
		...overrides,
	};
	db.database.prepare(`INSERT INTO policies (principal, owner, network, json, updated_at)
		VALUES (?, ?, 'testnet', ?, ?)
		ON CONFLICT(principal, owner, network) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`)
		.run(PRINCIPAL, OWNER, JSON.stringify(policy), CREATED);
}

function insertMandate(db: SqliteD1, constraints: Record<string, unknown> = {
	currency: 'USD',
	per_payment_max: '6',
	daily_max: '10',
	total_max: '12',
	payees: ['merchant-a'],
}, mandateId = MANDATE): void {
	setPolicy(db);
	db.database.prepare(`INSERT INTO ap4m_mandates (
		id, principal, owner, network, status, execution_type, not_before, expires_at,
		constraints_json, agent_public_jwk, agent_key_enc, agent_key_iv,
		claim_keys_enc, claim_keys_iv, claim_public_keys_json, prepared_json,
		l1_digest, l2_digest, channels_json, created_at, updated_at
	) VALUES (?, ?, ?, 'testnet', 'ACTIVE', 'DEFERRED', ?, ?, ?, '{}', X'01', X'02',
		X'03', X'04', '[]', '{"unsigned_batch":{}}', 'l1', 'l2', '[]', ?, ?)`)
		.run(mandateId, PRINCIPAL, OWNER, '2026-10-21T00:00:00.000Z', '2026-10-24T00:00:00.000Z',
			JSON.stringify(constraints), CREATED, CREATED);
}

function claimInput(idempotencyKey = 'idem-1', mandateId = MANDATE) {
	return {
		id: `attempt-${idempotencyKey}`,
		mandateId,
		idempotencyKey,
		requestFingerprint: FP,
		merchantId: 'merchant-a',
		sku: 'yield-report',
		createdAt: CREATED,
	};
}

function reserveInput(
	idempotencyKey = 'idem-1',
	amountUsd = '6',
	spendDay = '2026-10-21',
	mandateId = MANDATE,
) {
	return {
		mandateId,
		idempotencyKey,
		requestFingerprint: FP,
		leaseAcquiredAt: CREATED,
		spendId: `spend-${idempotencyKey}`,
		spendDay,
		amountUsd,
		preparedContext: preparedContext(amountUsd),
		preparedAt: `${spendDay}T18:01:00.000Z`,
	};
}

function result(): Ap4mStoredResult {
	return {
		receipt: {
			receipt_id: 'receipt-1',
			mandate_id: MANDATE,
			merchant_id: 'merchant-a',
			sku: 'yield-report',
			intent_id: preparedContext().intent.intentId,
			l3a_digest: L3A_DIGEST,
			l3b_digest: L3B_DIGEST,
			scheme: 'exact',
			amount: { asset: { kind: 'iou', currency: 'RLUSD', issuer: 'rIssuer' }, value: '6' },
			proof: { tx_hash: HASH },
			merchant_validation: {
				intentId: preparedContext().intent.intentId,
				validated: true,
				checks: { agent_identity: 'pass', intent: 'pass', payment: 'pass', credential: 'pass' },
				validation_errors: [],
			},
			settlement: 'validated',
			at: '2026-10-21T18:04:00.000Z',
		},
		data: merchantResponse().data,
		evidence: {
			version: 'ap4m-public-evidence-v1',
			provenance: 'live-testnet',
			network: 'testnet',
			rail: 'exact',
			intent: preparedContext().intent,
			artifacts: [
				{ kind: 'l1', digest: 'A'.repeat(64), digest_basis: 'sha256-utf8/vi-l1-presentation' },
				{ kind: 'l2', digest: 'B'.repeat(64), digest_basis: 'sha256-utf8/vi-l2-merchant-presentation' },
				{ kind: 'l3a', digest: L3A_DIGEST.toUpperCase(), digest_basis: 'sha256-utf8/vi-l3a-presentation' },
				{ kind: 'l3b', digest: L3B_DIGEST.toUpperCase(), digest_basis: 'sha256-utf8/vi-l3b-presentation' },
				{ kind: 'payment', digest: HASH, digest_basis: 'xrpl/signed-transaction-hash' },
			],
		},
	};
}

function storeFor(db: SqliteD1, at = '2026-10-21T18:01:00.000Z') {
	return new Ap4mPurchaseStore(db as unknown as D1Database, PRINCIPAL, () => new Date(at));
}

async function prepared(db: SqliteD1, idempotencyKey = 'idem-1', amount = '6') {
	const store = storeFor(db);
	await store.claim(claimInput(idempotencyKey));
	expect((await store.reserve(reserveInput(idempotencyKey, amount), LEGACY_KEK)).outcome).toBe('reserved');
	return store;
}

describe('Ap4mPurchaseStore atomic reservation', () => {
	it('round-trips recovery context with legacy and nonextractable AWS-style KEKs', async () => {
		const identity = { principal: PRINCIPAL, mandateId: MANDATE, idempotencyKey: 'idem-1' };
		const legacyWrapped = await wrapAp4mPreparedContext(identity, preparedContext(), LEGACY_KEK);
		expect(await unwrapAp4mPreparedContext(identity, legacyWrapped, LEGACY_KEK)).toEqual(preparedContext());

		const key = await crypto.subtle.importKey(
			'raw', Buffer.alloc(32, 9), 'AES-GCM', false, ['encrypt', 'decrypt'],
		);
		expect(key.extractable).toBe(false);
		const awsWrapped = await wrapAp4mPreparedContext(identity, preparedContext(), key);
		expect(await unwrapAp4mPreparedContext(identity, awsWrapped, key)).toEqual(preparedContext());
		await expect(unwrapAp4mPreparedContext(
			{ ...identity, idempotencyKey: 'other' }, awsWrapped, key,
		)).rejects.toBeInstanceOf(Ap4mPurchaseStoreError);
	});

	it('permits HTTP only for exact loopback resource hosts', async () => {
		const db = new SqliteD1();
		insertMandate(db);
		const store = storeFor(db);
		for (const [index, resourceUrl] of [
			'http://127.0.0.1:8794/resource/yield-report',
			'http://[::1]:8794/resource/yield-report',
			'http://localhost:8794/resource/yield-report',
		].entries()) {
			const idempotencyKey = `loopback-${index}`;
			await store.claim(claimInput(idempotencyKey));
			const input = reserveInput(idempotencyKey, '1');
			input.preparedContext = {
				...input.preparedContext,
				resourceUrl,
				challenge: { ...input.preparedContext.challenge, resource: { url: resourceUrl } },
				merchantSnapshot: { ...input.preparedContext.merchantSnapshot, base_url: new URL(resourceUrl).origin },
			};
			expect((await store.reserve(input, LEGACY_KEK)).outcome).toBe('reserved');
		}
		for (const [index, resourceUrl] of [
			'http://localhost.evil.example/resource/yield-report',
			'http://127.0.0.1.evil.example/resource/yield-report',
			'http://127.0.0.2:8794/resource/yield-report',
			'http://merchant.example/resource/yield-report',
			'http://user@localhost:8794/resource/yield-report',
			'http://localhost:8794/resource/yield-report#fragment',
		].entries()) {
			const idempotencyKey = `non-loopback-${index}`;
			await store.claim(claimInput(idempotencyKey));
			const input = reserveInput(idempotencyKey, '1');
			input.preparedContext = {
				...input.preparedContext,
				resourceUrl,
				challenge: { ...input.preparedContext.challenge, resource: { url: resourceUrl } },
				merchantSnapshot: { ...input.preparedContext.merchantSnapshot, base_url: new URL(resourceUrl).origin },
			};
			await expect(store.reserve(input, LEGACY_KEK)).rejects.toBeInstanceOf(Ap4mPurchaseStoreError);
		}
	});

	it('claims once, replays an identical request, and rejects changed request identity', async () => {
		const db = new SqliteD1();
		insertMandate(db);
		const store = storeFor(db);
		const outcomes = await Promise.all([
			store.claim(claimInput()),
			store.claim({ ...claimInput(), id: 'ignored' }),
		]);
		expect(outcomes.map(({ outcome }) => outcome).sort()).toEqual(['claimed', 'replay']);
		expect((await store.claim({ ...claimInput(), sku: 'risk-score' })).outcome).toBe('mismatch');
		expect(db.database.prepare('SELECT COUNT(*) AS count FROM ap4m_purchase_attempts').get()).toEqual({ count: 1 });
	});

	it('atomically reserves the attempt and mandate ledger and cannot double-count a replay', async () => {
		const db = new SqliteD1();
		insertMandate(db);
		const store = storeFor(db);
		await store.claim(claimInput());
		const reserved = await store.reserve(reserveInput(), LEGACY_KEK);
		expect(reserved.outcome).toBe('reserved');
		expect(reserved.row).toMatchObject({
			status: 'prepared', amountUsd: '6', spendId: 'spend-idem-1',
			preparedContextBinding: {
				intentId: preparedContext().intent.intentId,
				l3aDigest: L3A_DIGEST,
				l3bDigest: L3B_DIGEST,
				receiptId: 'receipt-1',
				challenge: {
					asset: { currency: RLUSD_WIRE, issuer: 'rIssuer' },
					amount: '6', payTo: 'rMerchant',
				},
				receiptAmount: {
					asset: { kind: 'iou', currency: 'RLUSD', issuer: 'rIssuer' }, value: '6',
				},
			},
		});
		const storedBytes = db.database.prepare(
			`SELECT hex(prepared_context_enc) AS ciphertext, hex(prepared_context_iv) AS iv,
			 prepared_context_public_json, prepared_context_digest
			 FROM ap4m_purchase_attempts WHERE idempotency_key = ?`,
		).get('idem-1');
		expect((await store.reserve(reserveInput(), LEGACY_KEK)).outcome).toBe('replay');
		expect(db.database.prepare(
			`SELECT hex(prepared_context_enc) AS ciphertext, hex(prepared_context_iv) AS iv,
			 prepared_context_public_json, prepared_context_digest
			 FROM ap4m_purchase_attempts WHERE idempotency_key = ?`,
		).get('idem-1')).toEqual(storedBytes);
		const replacement = reserveInput();
		replacement.preparedContext = {
			...replacement.preparedContext,
			vi: { ...replacement.preparedContext.vi, l3b: 'replacement.jwt' },
			retryHeaders: { ...replacement.preparedContext.retryHeaders, 'x-vi-l3b': 'replacement.jwt' },
		};
		expect((await store.reserve(replacement, LEGACY_KEK)).outcome).toBe('mismatch');
		expect(db.database.prepare(
			`SELECT hex(prepared_context_enc) AS ciphertext, hex(prepared_context_iv) AS iv,
			 prepared_context_public_json, prepared_context_digest
			 FROM ap4m_purchase_attempts WHERE idempotency_key = ?`,
		).get('idem-1')).toEqual(storedBytes);
		expect(await store.readPreparedContext(MANDATE, 'idem-1', LEGACY_KEK)).toEqual(preparedContext());
		const rawDatabaseRecord = JSON.stringify(db.database.prepare(
			'SELECT * FROM ap4m_purchase_attempts WHERE idempotency_key = ?',
		).get('idem-1'));
		for (const forbidden of [
			'l1.jwt~disclosure', 'l2.jwt~disclosure', 'l3a.jwt~disclosure', 'l3b.jwt~disclosure',
			'sealed-challenge-state.jwt', 'rExactPreparedPayer',
			'Demo Merchant', 'src-dpa-1', 'Yield report',
			'Encrypted recovery-only product description', 'encrypted_yield_report_v1',
			preparedContext().intent.intentSummary,
			preparedContext().retryHeaders['x-mastercard-intent'],
		]) {
			expect(rawDatabaseRecord).not.toContain(forbidden);
		}
		expect((db.database.prepare(`PRAGMA table_info(ap4m_purchase_attempts)`).all() as Array<{ name: string }>)
			.map(({ name }) => name)).not.toContain('prepared_context_json');
		expect(db.database.prepare('SELECT spent_microusd FROM ap4m_mandates').get()).toEqual({ spent_microusd: 6_000_000 });
		expect(db.database.prepare('SELECT COUNT(*) AS count FROM ap4m_spend').get()).toEqual({ count: 1 });
	});

	it('binds the semantic receipt asset to the exact XRPL wire challenge asset', async () => {
		const db = new SqliteD1();
		insertMandate(db);
		const store = storeFor(db);
		await store.claim(claimInput());
		const input = reserveInput();
		expect(input.preparedContext.receiptAmount.asset.currency).toBe('RLUSD');
		expect(input.preparedContext.challenge.currency).toBe(RLUSD_WIRE);
		expect((await store.reserve(input, LEGACY_KEK)).outcome).toBe('reserved');

		await store.claim(claimInput('mismatch'));
		const mismatch = reserveInput('mismatch');
		mismatch.preparedContext.receiptAmount.asset.currency = 'USD';
		await expect(store.reserve(mismatch, LEGACY_KEK)).rejects.toBeInstanceOf(Ap4mPurchaseStoreError);
	});

	it('enforces per-payment, daily, and total limits without leaving partial rows', async () => {
		const db = new SqliteD1();
		insertMandate(db);
		const store = storeFor(db);
		await store.claim(claimInput('too-large'));
		expect((await store.reserve(reserveInput('too-large', '7'), LEGACY_KEK)).outcome).toBe('spend-limit');
		await store.claim(claimInput('secret'));
		const secretContext = reserveInput('secret', '1');
		(secretContext.preparedContext.challenge as Record<string, unknown>).private_key = 'forbidden';
		await expect(store.reserve(secretContext, LEGACY_KEK)).rejects.toBeInstanceOf(Ap4mPurchaseStoreError);
		await store.claim(claimInput('one'));
		expect((await store.reserve(reserveInput('one', '6'), LEGACY_KEK)).outcome).toBe('reserved');
		await store.claim(claimInput('daily'));
		expect((await store.reserve(reserveInput('daily', '5'), LEGACY_KEK)).outcome).toBe('spend-limit');
		await store.claim(claimInput('next-day'));
		expect((await storeFor(db, '2026-10-22T18:01:00.000Z')
			.reserve(reserveInput('next-day', '6', '2026-10-22'), LEGACY_KEK)).outcome).toBe('reserved');
		await store.claim(claimInput('total'));
		expect((await storeFor(db, '2026-10-23T18:01:00.000Z')
			.reserve(reserveInput('total', '0.000001', '2026-10-23'), LEGACY_KEK)).outcome).toBe('spend-limit');
		expect(db.database.prepare('SELECT COUNT(*) AS count FROM ap4m_spend').get()).toEqual({ count: 2 });
	});

	it('atomically enforces the current owner policy across sequential and concurrent mandates', async () => {
		const wideConstraints = {
			currency: 'USD', per_payment_max: '100', daily_max: '100', total_max: '100', payees: ['merchant-a'],
		};
		const sequentialDb = new SqliteD1();
		insertMandate(sequentialDb, wideConstraints);
		setPolicy(sequentialDb, { max_per_tx_usd: 10, daily_cap_usd: 10 });
		const sequential = storeFor(sequentialDb);
		await sequential.claim(claimInput('first'));
		expect((await sequential.reserve(reserveInput('first', '6'), LEGACY_KEK)).outcome).toBe('reserved');
		await sequential.claim(claimInput('second'));
		expect((await sequential.reserve(reserveInput('second', '5'), LEGACY_KEK)).outcome).toBe('spend-limit');
		expect(sequentialDb.database.prepare('SELECT SUM(amount_microusd) AS total FROM ap4m_spend').get())
			.toEqual({ total: 6_000_000 });

		const concurrentDb = new SqliteD1();
		insertMandate(concurrentDb, wideConstraints, 'mandate-a');
		insertMandate(concurrentDb, wideConstraints, 'mandate-b');
		setPolicy(concurrentDb, { max_per_tx_usd: 10, daily_cap_usd: 10 });
		const concurrent = storeFor(concurrentDb);
		await concurrent.claim(claimInput('concurrent-a', 'mandate-a'));
		await concurrent.claim(claimInput('concurrent-b', 'mandate-b'));
		const outcomes = await Promise.all([
			concurrent.reserve(reserveInput('concurrent-a', '6', '2026-10-21', 'mandate-a'), LEGACY_KEK),
			concurrent.reserve(reserveInput('concurrent-b', '6', '2026-10-21', 'mandate-b'), LEGACY_KEK),
		]);
		expect(outcomes.map(({ outcome }) => outcome).sort()).toEqual(['reserved', 'spend-limit']);
		expect(concurrentDb.database.prepare('SELECT SUM(amount_microusd) AS total FROM ap4m_spend').get())
			.toEqual({ total: 6_000_000 });
	});

	it('counts prior normal execution reservations before AP4M and rechecks mutable gates atomically', async () => {
		const wideConstraints = {
			currency: 'USD', per_payment_max: '100', daily_max: '100', total_max: '100', payees: ['merchant-a'],
		};
		const db = new SqliteD1();
		insertMandate(db, wideConstraints);
		setPolicy(db, { max_per_tx_usd: 10, daily_cap_usd: 10 });
		db.database.prepare(`INSERT INTO builds
			(id, principal, owner, network, tx_json, summary, last_ledger_seq, created_at)
			VALUES ('build-1', ?, ?, 'testnet', '{}', 'ordinary execution', 50, ?)`)
			.run(PRINCIPAL, OWNER, '2026-10-21T12:00:00.000Z');
		db.database.prepare(`INSERT INTO executions
			(id, principal, build_id, idempotency_key, status, usd_value, created_at)
			VALUES ('execution-1', ?, 'build-1', 'ordinary-1', 'pending', 5, ?)`)
			.run(PRINCIPAL, '2026-10-21T12:01:00.000Z');
		const store = storeFor(db);
		await store.claim(claimInput());
		expect((await store.reserve(reserveInput(), LEGACY_KEK)).outcome).toBe('spend-limit');
		expect(db.database.prepare('SELECT COUNT(*) AS count FROM ap4m_spend').get()).toEqual({ count: 0 });
		expect(db.database.prepare('SELECT spent_microusd FROM ap4m_mandates').get()).toEqual({ spent_microusd: 0 });

		for (const [name, mutate] of [
			['revoked', (gateDb: SqliteD1) => gateDb.database.prepare(
				"UPDATE ap4m_mandates SET status = 'REVOKED' WHERE id = ?",
			).run(MANDATE)],
			['expired', (gateDb: SqliteD1) => gateDb.database.prepare(
				'UPDATE ap4m_mandates SET expires_at = ? WHERE id = ?',
			).run('2026-10-21T18:01:00.000Z', MANDATE)],
			['policy-disabled', (gateDb: SqliteD1) => setPolicy(gateDb, { ap4m_enabled: false })],
		] as const) {
			const gateDb = new SqliteD1();
			insertMandate(gateDb, wideConstraints);
			const gateStore = storeFor(gateDb);
			await gateStore.claim(claimInput(name));
			mutate(gateDb);
			expect((await gateStore.reserve(reserveInput(name), LEGACY_KEK)).outcome).not.toBe('reserved');
			expect(gateDb.database.prepare('SELECT COUNT(*) AS count FROM ap4m_spend').get()).toEqual({ count: 0 });
			expect(gateDb.database.prepare('SELECT spent_microusd FROM ap4m_mandates').get()).toEqual({ spent_microusd: 0 });
		}
	});

	it('uses immutable local compatibility snapshots for the exact shared-cap query', async () => {
		const db = new SqliteD1('combined-local');
		const wideConstraints = {
			currency: 'USD', per_payment_max: '100', daily_max: '100', total_max: '100', payees: ['merchant-a'],
		};
		insertMandate(db, wideConstraints);
		setPolicy(db, { max_per_tx_usd: 10, daily_cap_usd: 10 });
		db.database.prepare(`INSERT INTO builds
			(id, principal, owner, network, tx_json, summary, last_ledger_seq, created_at)
			VALUES ('combined-build', ?, ?, 'testnet', '{}', 'ordinary execution', 50, ?)`)
			.run(PRINCIPAL, OWNER, '2026-10-21T12:00:00.000Z');
		db.database.prepare(`INSERT INTO executions
			(id, principal, build_id, idempotency_key, status, usd_value, created_at)
			VALUES ('combined-execution', ?, 'combined-build', 'combined-ordinary', 'pending', 5, ?)`)
			.run(PRINCIPAL, '2026-10-21T12:01:00.000Z');
		expect(db.database.prepare(`SELECT snapshot_owner, snapshot_network
			FROM execution_snapshots WHERE execution_id = 'combined-execution'`).get()).toEqual({
			snapshot_owner: OWNER, snapshot_network: 'testnet',
		});
		db.database.prepare(`UPDATE builds SET owner = ?, network = 'devnet'
			WHERE id = 'combined-build'`).run(OTHER_OWNER);
		const store = storeFor(db);
		await store.claim(claimInput('combined-cap'));
		expect((await store.reserve(reserveInput('combined-cap'), LEGACY_KEK)).outcome).toBe('spend-limit');
		expect(db.database.prepare('SELECT COUNT(*) AS count FROM ap4m_spend').get()).toEqual({ count: 0 });
	});

	it('rejects stale or cross-midnight reservation timestamps before policy accounting', async () => {
		const db = new SqliteD1();
		insertMandate(db);
		const store = storeFor(db, '2026-10-22T00:00:01.000Z');
		await store.claim(claimInput());
		const stale = reserveInput();
		stale.preparedAt = '2026-10-21T23:59:59.000Z';
		await expect(store.reserve(stale, LEGACY_KEK)).rejects.toBeInstanceOf(Ap4mPurchaseStoreError);
		expect(db.database.prepare('SELECT COUNT(*) AS count FROM ap4m_spend').get()).toEqual({ count: 0 });
	});

	it('allows only one stale claimant to acquire the compare-and-swap recovery lease', async () => {
		const db = new SqliteD1();
		insertMandate(db);
		const store = storeFor(db);
		await store.claim(claimInput());
		const acquired = '2026-10-21T18:05:00.000Z';
		expect((await store.acquireClaimRecovery(MANDATE, 'idem-1', CREATED,
			'2026-10-21T18:04:00.000Z', acquired)).outcome).toBe('transitioned');
		expect((await store.acquireClaimRecovery(MANDATE, 'idem-1', CREATED,
			'2026-10-21T18:04:00.000Z', '2026-10-21T18:06:00.000Z')).outcome).toBe('invalid-state');
	});

	it('grants one signing owner and never permits non-owner persistence or release', async () => {
		const db = new SqliteD1();
		insertMandate(db);
		const store = await prepared(db);
		const leases = await Promise.all([
			store.acquireSigningLease(MANDATE, 'idem-1', signingLease(SIGNING_TOKEN_A)),
			store.acquireSigningLease(MANDATE, 'idem-1', signingLease(SIGNING_TOKEN_B)),
		]);
		expect(leases.map(({ outcome }) => outcome).sort()).toEqual(['acquired', 'busy']);
		const owner = leases[0]?.outcome === 'acquired' ? SIGNING_TOKEN_A : SIGNING_TOKEN_B;
		const nonOwner = owner === SIGNING_TOKEN_A ? SIGNING_TOKEN_B : SIGNING_TOKEN_A;
		expect((await store.acquireSigningLease(MANDATE, 'idem-1', signingLease(owner))).outcome).toBe('owner');
		expect((await store.markSigned(MANDATE, 'idem-1', nonOwner, {
			hash: HASH, signedBlob: 'ABCD', lastLedgerSequence: 50, at: '2026-10-21T18:02:30.000Z',
		})).outcome).toBe('not-owner');
		expect((await store.markSigningFailed(MANDATE, 'idem-1', nonOwner,
			{ code: 'not_owner' }, '2026-10-21T18:02:30.000Z')).outcome).toBe('not-owner');
		expect(db.database.prepare('SELECT status FROM ap4m_spend').get()).toEqual({ status: 'reserved' });
		expect((await store.markSigned(MANDATE, 'idem-1', owner, {
			hash: HASH, signedBlob: 'ABCD', lastLedgerSequence: 50, at: '2026-10-21T18:02:30.000Z',
		})).outcome).toBe('transitioned');
		expect((await store.get(MANDATE, 'idem-1'))?.firstEligibleLedgerIndex).toBe(45);
	});

	it('permanently fences a crashed signer instead of allowing stale takeover', async () => {
		const db = new SqliteD1();
		insertMandate(db);
		const store = await prepared(db);
		expect((await store.acquireSigningLease(MANDATE, 'idem-1', signingLease(SIGNING_TOKEN_A))).outcome)
			.toBe('acquired');
		expect((await store.acquireSigningLease(MANDATE, 'idem-1', {
			...signingLease(SIGNING_TOKEN_B, '2026-10-21T18:02:10.000Z'),
			staleBefore: '2026-10-21T18:01:30.000Z',
		})).outcome).toBe('busy');
		expect((await store.acquireSigningLease(MANDATE, 'idem-1', {
			...signingLease(SIGNING_TOKEN_B, '2026-10-21T18:05:00.000Z'),
			firstEligibleLedgerIndex: 46,
			staleBefore: '2026-10-21T18:04:00.000Z',
		})).outcome).toBe('busy');
		expect((await store.markSigned(MANDATE, 'idem-1', SIGNING_TOKEN_B, {
			hash: HASH, signedBlob: 'ABCD', lastLedgerSequence: 50, at: '2026-10-21T18:05:01.000Z',
		})).outcome).toBe('not-owner');
		expect((await store.markSigningFailed(MANDATE, 'idem-1', SIGNING_TOKEN_B,
			{ code: 'replacement_failure' }, '2026-10-21T18:05:02.000Z')).outcome).toBe('not-owner');
		expect(db.database.prepare('SELECT status FROM ap4m_spend').get()).toEqual({ status: 'reserved' });
		expect((await store.markSigned(MANDATE, 'idem-1', SIGNING_TOKEN_A, {
			hash: HASH, signedBlob: 'ABCD', lastLedgerSequence: 50, at: '2026-10-21T18:05:03.000Z',
		})).outcome).toBe('transitioned');
		expect((await store.get(MANDATE, 'idem-1'))?.firstEligibleLedgerIndex).toBe(45);
	});
});

describe('Ap4mPurchaseStore settlement safety', () => {
	it('keeps settlement-unknown reserved and persists a bounded exact result for replay', async () => {
		const db = new SqliteD1();
		insertMandate(db);
		const store = await prepared(db);
		await store.acquireSigningLease(MANDATE, 'idem-1', signingLease());
		await store.markSigned(MANDATE, 'idem-1', SIGNING_TOKEN_A, {
			hash: HASH, signedBlob: 'ABCD', lastLedgerSequence: 50, at: '2026-10-21T18:02:30.000Z',
		});
		expect((await store.markSettlementUnknown(MANDATE, 'idem-1', '2026-10-21T18:03:00.000Z')).outcome)
			.toBe('transitioned');
		expect(db.database.prepare('SELECT status FROM ap4m_spend').get()).toEqual({ status: 'reserved' });
		expect((await store.cacheMerchantResponse(MANDATE, 'idem-1', {
			response: merchantResponse(), at: '2026-10-21T18:03:10.000Z',
		})).outcome).toBe('transitioned');
		const merchantBytes = db.database.prepare(
			'SELECT merchant_response_json FROM ap4m_purchase_attempts WHERE idempotency_key = ?',
		).get('idem-1');
		expect((await store.cacheMerchantResponse(MANDATE, 'idem-1', {
			response: merchantResponse(), at: '2026-10-21T18:03:20.000Z',
		})).outcome).toBe('replay');
		const changedResponse = merchantResponse();
		changedResponse.data.apr_percent = '9.99';
		expect((await store.cacheMerchantResponse(MANDATE, 'idem-1', {
			response: changedResponse, at: '2026-10-21T18:03:30.000Z',
		})).outcome).toBe('mismatch');
		expect(db.database.prepare(
			'SELECT merchant_response_json FROM ap4m_purchase_attempts WHERE idempotency_key = ?',
		).get('idem-1')).toEqual(merchantBytes);
		expect((await store.get(MANDATE, 'idem-1'))?.merchantResponse).toEqual(merchantResponse());
		expect((await store.markSettled(MANDATE, 'idem-1', {
			hash: HASH, ledgerIndex: 49, deliveredAmount: '5.99', at: '2026-10-21T18:03:35.000Z',
		})).outcome).toBe('invalid-evidence');
		expect((await store.get(MANDATE, 'idem-1'))?.status).toBe('settlement_unknown');
		expect(db.database.prepare('SELECT status FROM ap4m_spend').get()).toEqual({ status: 'reserved' });
		expect((await store.markSettled(MANDATE, 'idem-1', {
			hash: HASH, ledgerIndex: 49, deliveredAmount: '6', at: '2026-10-21T18:03:40.000Z',
		})).outcome).toBe('transitioned');
		expect(db.database.prepare('SELECT status FROM ap4m_spend').get()).toEqual({ status: 'committed' });
		const missingEvidence = result();
		delete missingEvidence.evidence;
		await expect(store.markDelivered(MANDATE, 'idem-1', {
			result: missingEvidence, at: '2026-10-21T18:03:45.000Z',
		})).rejects.toBeInstanceOf(Ap4mPurchaseStoreError);
		expect((await store.get(MANDATE, 'idem-1'))?.status).toBe('settled');
		const wrongSemanticAsset = result();
		wrongSemanticAsset.receipt.amount.asset.currency = 'USD';
		await expect(store.markDelivered(MANDATE, 'idem-1', {
			result: wrongSemanticAsset, at: '2026-10-21T18:03:50.000Z',
		})).rejects.toBeInstanceOf(Ap4mPurchaseStoreError);
		expect((await store.get(MANDATE, 'idem-1'))?.status).toBe('settled');
		const delivered = await store.markDelivered(MANDATE, 'idem-1', {
			result: result(), at: '2026-10-21T18:04:00.000Z',
		});
		expect(delivered.outcome).toBe('transitioned');
		expect(delivered.row.result).toEqual(result());
		expect((await store.claim(claimInput())).row.result).toEqual(result());
		expect((await store.markDelivered(MANDATE, 'idem-1', {
			result: result(), at: '2026-10-21T18:04:00.000Z',
		})).outcome).toBe('replay');
		const legacy = result();
		delete legacy.evidence;
		db.database.prepare(
			'UPDATE ap4m_purchase_attempts SET result_json = ? WHERE mandate_id = ? AND idempotency_key = ?',
		).run(JSON.stringify(legacy), MANDATE, 'idem-1');
		expect((await store.get(MANDATE, 'idem-1'))?.result).toEqual(legacy);
	});

	it('releases pre-signing failures exactly once but never releases settlement-unknown', async () => {
		const db = new SqliteD1();
		insertMandate(db);
		const store = await prepared(db);
		expect((await store.markFailed(MANDATE, 'idem-1', { code: 'merchant_unavailable' },
			'2026-10-21T18:02:00.000Z')).outcome).toBe('transitioned');
		expect(db.database.prepare('SELECT status FROM ap4m_spend').get()).toEqual({ status: 'released' });
		expect(db.database.prepare('SELECT spent_microusd FROM ap4m_mandates').get()).toEqual({ spent_microusd: 0 });
		expect((await store.markFailed(MANDATE, 'idem-1', { code: 'merchant_unavailable' },
			'2026-10-21T18:02:00.000Z')).outcome).toBe('replay');
		expect(db.database.prepare('SELECT spent_microusd FROM ap4m_mandates').get()).toEqual({ spent_microusd: 0 });
	});

	it('requires validated post-expiry absence before releasing a signed attempt', async () => {
		const db = new SqliteD1();
		insertMandate(db);
		const store = await prepared(db);
		await store.acquireSigningLease(MANDATE, 'idem-1', signingLease());
		await store.markSigned(MANDATE, 'idem-1', SIGNING_TOKEN_A, {
			hash: HASH, signedBlob: 'ABCD', lastLedgerSequence: 50, at: '2026-10-21T18:02:30.000Z',
		});
		const complete = [45, 46, 47, 48, 49, 50];
		expect((await store.markExpiredAbsentFailed(MANDATE, 'idem-1', {
			hash: HASH, lookupCode: 'txnNotFound', validatedLedgerIndex: 50,
			inclusionLedgersChecked: complete,
			at: '2026-10-21T18:03:00.000Z',
		})).outcome).toBe('invalid-evidence');
		expect(db.database.prepare('SELECT status FROM ap4m_spend').get()).toEqual({ status: 'reserved' });
		expect((await store.markExpiredAbsentFailed(MANDATE, 'idem-1', {
			hash: HASH, lookupCode: 'transactionNotFound', validatedLedgerIndex: 51,
			inclusionLedgersChecked: complete,
			at: '2026-10-21T18:03:10.000Z',
		})).outcome).toBe('invalid-evidence');
		expect((await store.markExpiredAbsentFailed(MANDATE, 'idem-1', {
			hash: HASH, lookupCode: 'txnNotFound', validatedLedgerIndex: 51,
			inclusionLedgersChecked: [45, 46],
			at: '2026-10-21T18:03:20.000Z',
		})).outcome).toBe('invalid-evidence');
		expect((await store.markExpiredAbsentFailed(MANDATE, 'idem-1', {
			hash: HASH, lookupCode: 'txnNotFound', validatedLedgerIndex: 51,
			inclusionLedgersChecked: [46, 47, 48, 49, 50],
			at: '2026-10-21T18:03:25.000Z',
		})).outcome).toBe('invalid-evidence');
		expect((await store.markExpiredAbsentFailed(MANDATE, 'idem-1', {
			hash: HASH, lookupCode: 'txnNotFound', validatedLedgerIndex: 51,
			inclusionLedgersChecked: [45, 46, 48, 49, 50],
			at: '2026-10-21T18:03:30.000Z',
		})).outcome).toBe('invalid-evidence');
		expect(db.database.prepare('SELECT status FROM ap4m_spend').get()).toEqual({ status: 'reserved' });
		expect((await store.markExpiredAbsentFailed(MANDATE, 'idem-1', {
			hash: HASH, lookupCode: 'txnNotFound', validatedLedgerIndex: 51,
			inclusionLedgersChecked: complete,
			at: '2026-10-21T18:04:00.000Z',
		})).outcome).toBe('transitioned');
		expect(db.database.prepare('SELECT status FROM ap4m_spend').get()).toEqual({ status: 'released' });
		const failure = JSON.parse((db.database.prepare(
			'SELECT failure_json FROM ap4m_purchase_attempts WHERE idempotency_key = ?',
		).get('idem-1') as { failure_json: string }).failure_json) as Record<string, unknown>;
		expect(failure).toMatchObject({
			code: 'expired_absent', lookup_code: 'txnNotFound', checked_from: 45,
			checked_through: 50, validated_ledger_index: 51,
		});
		expect(failure).not.toHaveProperty('inclusionLedgersChecked');
	});

	it('releases exactly once for an exact validated terminal transaction failure', async () => {
		const db = new SqliteD1();
		insertMandate(db);
		const store = await prepared(db);
		await store.acquireSigningLease(MANDATE, 'idem-1', signingLease());
		await store.markSigned(MANDATE, 'idem-1', SIGNING_TOKEN_A, {
			hash: HASH, signedBlob: 'ABCD', lastLedgerSequence: 50, at: '2026-10-21T18:02:30.000Z',
		});
		await store.markSettlementUnknown(MANDATE, 'idem-1', '2026-10-21T18:03:00.000Z');
		const evidence = {
			hash: HASH, validated: true as const, transactionFound: true as const,
			validatedLedgerIndex: 48, transactionResult: 'tecPATH_DRY', at: '2026-10-21T18:04:00.000Z',
		};
		for (const invalid of [
			{ ...evidence, hash: 'C'.repeat(64) },
			{ ...evidence, validated: false },
			{ ...evidence, transactionFound: false },
			{ ...evidence, transactionResult: 'pending' },
			{ ...evidence, transactionResult: 'txnNotFound' },
			{ ...evidence, transactionResult: 'tesSUCCESS' },
			{ ...evidence, validatedLedgerIndex: 44 },
			{ ...evidence, validatedLedgerIndex: 51 },
		]) {
			expect((await store.markValidatedFailed(MANDATE, 'idem-1', invalid as typeof evidence)).outcome)
				.toBe('invalid-evidence');
		}
		expect(db.database.prepare('SELECT status FROM ap4m_spend').get()).toEqual({ status: 'reserved' });
		expect((await store.markValidatedFailed(MANDATE, 'idem-1', evidence)).outcome).toBe('transitioned');
		expect((await store.markValidatedFailed(MANDATE, 'idem-1', evidence)).outcome).toBe('replay');
		expect(db.database.prepare('SELECT status FROM ap4m_spend').get()).toEqual({ status: 'released' });
		expect(db.database.prepare('SELECT spent_microusd FROM ap4m_mandates').get()).toEqual({ spent_microusd: 0 });
		expect((await store.get(MANDATE, 'idem-1'))?.failure).toEqual({
			code: 'validated_transaction_failure', validated: true, transaction_found: true,
			transaction_result: 'tecPATH_DRY', validated_ledger_index: 48, hash: HASH,
		});
	});

	it('rejects oversized or sensitive result data before touching the delivered state', async () => {
		const db = new SqliteD1();
		insertMandate(db);
		const store = await prepared(db);
		await store.acquireSigningLease(MANDATE, 'idem-1', signingLease());
		await store.markSigned(MANDATE, 'idem-1', SIGNING_TOKEN_A, {
			hash: HASH, signedBlob: 'ABCD', lastLedgerSequence: 50, at: '2026-10-21T18:02:30.000Z',
		});
		await store.markSettled(MANDATE, 'idem-1', {
			hash: HASH, ledgerIndex: 49, deliveredAmount: '6', at: '2026-10-21T18:03:30.000Z',
		});
		await expect(store.markDelivered(MANDATE, 'idem-1', {
			result: result(), at: '2026-10-21T18:03:45.000Z',
		})).rejects.toBeInstanceOf(Ap4mPurchaseStoreError);
		expect((await store.get(MANDATE, 'idem-1'))?.status).toBe('settled');
		expect((await store.cacheMerchantResponse(MANDATE, 'idem-1', {
			response: merchantResponse(), at: '2026-10-21T18:03:50.000Z',
		})).outcome).toBe('transitioned');
		await expect(store.markDelivered(MANDATE, 'idem-1', {
			result: { ...result(), data: { private_key: 'nope' } }, at: '2026-10-21T18:04:00.000Z',
		})).rejects.toBeInstanceOf(Ap4mPurchaseStoreError);
		expect((await store.get(MANDATE, 'idem-1'))?.status).toBe('settled');
	});
});
