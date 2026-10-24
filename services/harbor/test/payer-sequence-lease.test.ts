import { readFileSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import {
	AccountSequenceLeaseAuthority,
	accountSequenceIdentity,
} from '../src/exec/account-sequence-lease';
import {
	PayerSequenceLeaseAuthority,
	PayerSequenceLeaseDataError,
	type PayerSequenceLeaseIdentity,
} from '../src/exec/payer-sequence-lease';

const PAYER = 'rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn';
const OTHER_PAYER = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY';
const NOW = '2026-10-21T18:00:00.000Z';
const LATER = '2026-10-21T18:01:00.000Z';
const TOKEN_A = 'A'.repeat(64);
const TOKEN_B = 'B'.repeat(64);
const HASH_A = 'C'.repeat(64);

const MIGRATIONS = Array.from({ length: 8 }, (_, index) =>
	readFileSync(new URL(`../migrations-local-x402/${String(index + 1).padStart(4, '0')}_${[
		'init',
		'x402_payments',
		'x402_payers',
		'x402_sequence_safety',
		'x402_durable_lease',
		'x402_budget_accounting',
		'x402_payer_provisioning',
		'ap4m_shared_runtime',
	][index]}.sql`, import.meta.url), 'utf8'),
).join('\n');

const MAIN_BEFORE_CHANNEL = [
	'0001_init.sql',
	'0002_quicknode.sql',
	'0007_ap4m_mandates.sql',
	'0008_ap4m_purchase_attempts.sql',
	'0009_aws_kms_delegate_keys.sql',
] as const;

const CHANNEL_SCHEMA_OBJECTS = [
	'ap4m_channel_claims',
	'ap4m_channel_claim_attempts',
	'ap4m_paychan_purchase_attempts',
	'idx_ap4m_channel_claims_mandate',
	'idx_ap4m_paychan_purchase_channel',
	'idx_ap4m_paychan_purchase_recovery',
	'trg_ap4m_channel_attempt_binding_insert',
	'trg_ap4m_channel_attempt_binding_update',
	'trg_ap4m_channel_claim_binding_immutable',
	'trg_ap4m_channel_claim_mandate_insert',
	'trg_ap4m_channel_claim_mandate_update',
	'trg_ap4m_exact_excludes_paychan_insert',
	'trg_ap4m_exact_excludes_paychan_update',
	'trg_ap4m_paychan_excludes_exact_insert',
	'trg_ap4m_paychan_excludes_exact_update',
	'trg_ap4m_paychan_delivered_update',
	'trg_ap4m_paychan_receipt_binding_insert',
	'trg_ap4m_paychan_purchase_binding_insert',
	'trg_ap4m_paychan_purchase_binding_update',
] as const;

function mainMigration(name: string): string {
	return readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
}

function applyMainBeforeChannel(database: DatabaseSync): void {
	database.exec('PRAGMA foreign_keys = ON');
	for (const name of MAIN_BEFORE_CHANNEL) database.exec(mainMigration(name));
}

function normalizedChannelSchema(database: DatabaseSync) {
	return database.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema
		WHERE name IN (${CHANNEL_SCHEMA_OBJECTS.map(() => '?').join(', ')})
		ORDER BY type, name`).all(...CHANNEL_SCHEMA_OBJECTS).map((row) => ({
		type: row.type,
		name: row.name,
		tbl_name: row.tbl_name,
		sql: String(row.sql).replace(/\s+/g, ' ').trim().toUpperCase(),
	}));
}

function seedPaychanPrerequisites(database: DatabaseSync, suffix: 'a' | 'b' | 'c') {
	const hex = { a: 'A', b: 'B', c: 'C' }[suffix];
	const mandateId = `mandate-${suffix}`;
	const merchantId = `merchant-${suffix}`;
	const idempotencyKey = `purchase-${suffix}`;
	const spendId = `spend-${suffix}`;
	const channelId = hex.repeat(64);
	const publicKey = `ED${hex.repeat(64)}`;
	const claimToken = { a: 'D', b: 'E', c: 'F' }[suffix].repeat(64);
	database.prepare(`INSERT INTO ap4m_mandates (
		id, principal, owner, network, status, execution_type, not_before, expires_at,
		constraints_json, agent_public_jwk, agent_key_enc, agent_key_iv, claim_keys_enc,
		claim_keys_iv, claim_public_keys_json, prepared_json, l1_digest, l2_digest,
		channels_json, created_at, updated_at
	) VALUES (?, 'principal', ?, 'testnet', 'ACTIVE', 'DEFERRED', ?, ?, '{}', '{}',
		?, ?, ?, ?, '[]', '{"unsigned_batch":{}}', '', '', '[]', ?, ?)`)
		.run(
			mandateId, OTHER_PAYER, NOW, '2026-10-22T18:00:00.000Z',
			Buffer.alloc(32, 1), Buffer.alloc(12, 2), Buffer.alloc(32, 3), Buffer.alloc(12, 4),
			NOW, NOW,
		);
	database.prepare(`INSERT INTO ap4m_spend (
		id, principal, mandate_id, spend_day, idempotency_key, amount_usd,
		amount_microusd, status, created_at, updated_at
	) VALUES (?, 'principal', ?, '2026-10-21', ?, '0.05', 50000, 'reserved', ?, ?)`)
		.run(spendId, mandateId, idempotencyKey, NOW, NOW);
	database.prepare(`INSERT INTO ap4m_channel_claims (
		principal, mandate_id, merchant_id, channel_id, payer, channel_amount_drops,
		public_key, cumulative_drops, pending_idempotency_key, pending_price_drops,
		pending_cumulative_drops, pending_token, created_at, updated_at
	) VALUES ('principal', ?, ?, ?, ?, '100', ?, '0', ?, '5', '5', ?, ?, ?)`)
		.run(mandateId, merchantId, channelId, PAYER, publicKey, idempotencyKey, claimToken, NOW, NOW);
	database.prepare(`INSERT INTO ap4m_channel_claim_attempts (
		principal, channel_id, idempotency_key, merchant_id, price_drops,
		cumulative_drops, claim_token, public_key, status, created_at, updated_at
	) VALUES ('principal', ?, ?, ?, '5', '5', ?, ?, 'pending', ?, ?)`)
		.run(channelId, idempotencyKey, merchantId, claimToken, publicKey, NOW, NOW);
	return { mandateId, merchantId, idempotencyKey, spendId, channelId, publicKey, claimToken };
}

function insertPaychanPurchase(
	database: DatabaseSync,
	input: ReturnType<typeof seedPaychanPrerequisites>,
) {
	return database.prepare(`INSERT INTO ap4m_paychan_purchase_attempts (
		principal, mandate_id, idempotency_key, id, request_fingerprint, network, rail,
		merchant_id, sku, merchant_snapshot_json, payer, channel_id, channel_amount_drops,
		price_drops, previous_drops, cumulative_drops, claim_token, public_key, spend_id,
		spend_day, amount_usd, intent_id, l3a_digest, l3b_digest, retry_material_enc,
		retry_material_iv, retry_material_digest, receipt_id, status, created_at, updated_at
	) VALUES ('principal', ?, ?, ?, ?, 'testnet', 'xrpl-paychan', ?, 'sku', '{}', ?, ?,
		'100', '5', '0', '5', ?, ?, ?, '2026-10-21', '0.05', ?, ?, ?, ?, ?, ?,
		?, 'reserved', ?, ?)`)
		.run(
			input.mandateId, input.idempotencyKey, `attempt-${input.idempotencyKey}`,
			'E'.repeat(64), input.merchantId, PAYER, input.channelId, input.claimToken,
			input.publicKey, input.spendId, `intent-${input.idempotencyKey}`,
			'a'.repeat(64), 'b'.repeat(64), Buffer.alloc(32, 5), Buffer.alloc(12, 6),
			'F'.repeat(64), `receipt-${input.idempotencyKey}`, NOW, NOW,
		);
}

function insertExactAttempt(
	database: DatabaseSync,
	input: ReturnType<typeof seedPaychanPrerequisites>,
) {
	return database.prepare(`INSERT INTO ap4m_purchase_attempts (
		id, principal, mandate_id, idempotency_key, request_fingerprint, merchant_id,
		sku, status, lease_acquired_at, created_at, updated_at
	) VALUES (?, 'principal', ?, ?, ?, ?, 'sku', 'claimed', ?, ?, ?)`)
		.run(
			`exact-${input.idempotencyKey}`, input.mandateId, input.idempotencyKey,
			'1'.repeat(64), input.merchantId, NOW, NOW, NOW,
		);
}

type SqlValue = string | number | bigint | null | Uint8Array;

class SqliteD1Statement {
	private values: SqlValue[] = [];
	constructor(private readonly statement: StatementSync) {}
	bind(...values: unknown[]): this {
		this.values = values.map((value) => value instanceof ArrayBuffer ? new Uint8Array(value) : value as SqlValue);
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
}

class SqliteD1 {
	readonly sqlite = new DatabaseSync(':memory:');
	constructor() {
		this.sqlite.exec('PRAGMA foreign_keys = ON');
		this.sqlite.exec(MIGRATIONS);
	}
	prepare(sql: string): SqliteD1Statement { return new SqliteD1Statement(this.sqlite.prepare(sql)); }
	close(): void { this.sqlite.close(); }
}

function asD1(db: SqliteD1): D1Database {
	return db as unknown as D1Database;
}

function identity(
	lease: Awaited<ReturnType<PayerSequenceLeaseAuthority['get']>>,
): PayerSequenceLeaseIdentity {
	if (lease === null || lease.rail === 'legacy') throw new Error('Expected owned lease');
	return {
		network: lease.network,
		payer: lease.payer,
		generation: lease.generation,
		token: lease.token,
		rail: lease.rail,
		attemptId: lease.attemptId,
	};
}

async function signedLease(authority: PayerSequenceLeaseAuthority) {
	const acquired = await authority.acquire({
		network: 'testnet', payer: PAYER, rail: 'ap4m', attemptId: 'attempt-a', token: TOKEN_A, at: NOW,
	});
	const owned = identity(acquired.lease);
	expect((await authority.markSigningStarted({
		...owned, sequence: 9, firstEligibleLedgerIndex: 100, lastLedgerSequence: 102, at: NOW,
	})).outcome).toBe('transitioned');
	expect((await authority.markSigned({ ...owned, hash: HASH_A, at: NOW })).outcome).toBe('transitioned');
	return owned;
}

describe('PayerSequenceLeaseAuthority', () => {
	it('shares the ledger-account fence with manual and strategy execution across principals', async () => {
		const db = new SqliteD1();
		try {
			const payer = new PayerSequenceLeaseAuthority(asD1(db));
			const global = new AccountSequenceLeaseAuthority(asD1(db));
			const manual = await global.acquire({
				principal: 'tenant:manual', network: 'testnet', account: PAYER,
				source: 'manual', attemptId: 'manual-attempt', token: TOKEN_A, at: NOW,
			});
			expect(manual.outcome).toBe('acquired');
			expect((await payer.acquire({
				network: 'testnet', payer: PAYER, rail: 'x402', attemptId: 'x402-attempt',
				token: TOKEN_B, at: NOW,
			})).outcome).toBe('blocked');
			expect((await global.releasePreSign({
				...accountSequenceIdentity(manual.lease), at: LATER, proof: 'signing_never_began',
			})).outcome).toBe('released');

			const ap4m = await payer.acquire({
				network: 'testnet', payer: PAYER, rail: 'ap4m', attemptId: 'ap4m-attempt',
				token: TOKEN_B, at: LATER,
			});
			expect(ap4m.outcome).toBe('acquired');
			expect((await global.acquire({
				principal: 'tenant:strategy', network: 'testnet', account: PAYER,
				source: 'strategy', attemptId: 'strategy-attempt', token: 'D'.repeat(64), at: LATER,
			})).outcome).toBe('blocked');
		} finally {
			db.close();
		}
	});

	it('does not orphan the local payer lease if another producer acquires after global release', async () => {
		const db = new SqliteD1();
		try {
			const payer = new PayerSequenceLeaseAuthority(asD1(db));
			const global = new AccountSequenceLeaseAuthority(asD1(db));
			const owned = await signedLease(payer);
			const globalLease = await global.get({ network: 'testnet', account: PAYER });
			if (!globalLease) throw new Error('expected global lease');
			expect((await global.releaseValidated({
				...accountSequenceIdentity(globalLease), hash: HASH_A, ledgerIndex: 101,
				engineResult: 'tesSUCCESS', at: LATER,
			})).outcome).toBe('released');
			const manual = await global.acquire({
				principal: 'tenant:manual', network: 'testnet', account: PAYER, source: 'manual',
				attemptId: 'manual-after-release', token: TOKEN_B, at: LATER,
			});
			expect(manual.outcome).toBe('acquired');
			expect((await payer.releaseValidatedTerminal({
				...owned, hash: HASH_A, at: LATER,
				evidence: { validated: true, transactionFound: true, ledgerIndex: 101 },
			})).outcome).toBe('released');
			expect(await global.get({ network: 'testnet', account: PAYER })).toMatchObject({
				source: 'manual', attemptId: 'manual-after-release', state: 'preparing',
			});
		} finally {
			db.close();
		}
	});

	it('serializes AP4M and x402 in both ordering directions and replays only the owning attempt', async () => {
		for (const [firstRail, secondRail] of [['ap4m', 'x402'], ['x402', 'ap4m']] as const) {
			const db = new SqliteD1();
			try {
				const authority = new PayerSequenceLeaseAuthority(asD1(db));
				const first = await authority.acquire({
					network: 'testnet', payer: PAYER, rail: firstRail, attemptId: 'first', token: TOKEN_A, at: NOW,
				});
				expect(first.outcome).toBe('acquired');
				const replay = await authority.acquire({
					network: 'testnet', payer: PAYER, rail: firstRail, attemptId: 'first', token: TOKEN_B, at: LATER,
				});
				expect(replay.outcome).toBe('replay');
				expect(replay.lease.token).toBe(TOKEN_A);
				expect((await authority.acquire({
					network: 'testnet', payer: PAYER, rail: secondRail, attemptId: 'second', token: TOKEN_B, at: NOW,
				})).outcome).toBe('blocked');
			} finally {
				db.close();
			}
		}
	});

	it('allows exactly one winner at a same-payer acquisition barrier', async () => {
		const db = new SqliteD1();
		try {
			const authority = new PayerSequenceLeaseAuthority(asD1(db));
			const results = await Promise.all([
				authority.acquire({
					network: 'testnet', payer: PAYER, rail: 'ap4m', attemptId: 'ap4m-race', token: TOKEN_A, at: NOW,
				}),
				authority.acquire({
					network: 'testnet', payer: PAYER, rail: 'x402', attemptId: 'x402-race', token: TOKEN_B, at: NOW,
				}),
			]);
			expect(results.map(({ outcome }) => outcome).sort()).toEqual(['acquired', 'blocked']);
		} finally {
			db.close();
		}
	});

	it('releases only a never-started preparation and increments the next generation', async () => {
		const db = new SqliteD1();
		try {
			const authority = new PayerSequenceLeaseAuthority(asD1(db));
			const acquired = await authority.acquire({
				network: 'testnet', payer: PAYER, rail: 'ap4m', attemptId: 'attempt-a', token: TOKEN_A, at: NOW,
			});
			const owned = identity(acquired.lease);
			expect((await authority.releasePreSign({
				...owned,
				at: LATER,
				proof: {
					code: 'signing_never_began', signingStarted: false,
					signedBlobPersisted: false, hashPersisted: false,
				},
			})).outcome).toBe('released');
			const next = await authority.acquire({
				network: 'testnet', payer: PAYER, rail: 'x402', attemptId: 'attempt-b', token: TOKEN_B, at: LATER,
			});
			expect(next.outcome).toBe('acquired');
			expect(next.lease.generation).toBe(owned.generation + 1);
		} finally {
			db.close();
		}
	});

	it('permanently fences a sign-started crash without a durable hash', async () => {
		const db = new SqliteD1();
		try {
			const authority = new PayerSequenceLeaseAuthority(asD1(db));
			const acquired = await authority.acquire({
				network: 'testnet', payer: PAYER, rail: 'ap4m', attemptId: 'ambiguous', token: TOKEN_A, at: NOW,
			});
			const owned = identity(acquired.lease);
			expect((await authority.markSigningStarted({
				...owned, sequence: 10, firstEligibleLedgerIndex: 200, lastLedgerSequence: 202, at: NOW,
			})).outcome).toBe('transitioned');
			expect((await authority.releasePreSign({
				...owned,
				at: LATER,
				proof: {
					code: 'signing_never_began', signingStarted: false,
					signedBlobPersisted: false, hashPersisted: false,
				},
			})).outcome).toBe('blocked');
			expect((await authority.acquire({
				network: 'testnet', payer: PAYER, rail: 'x402', attemptId: 'later', token: TOKEN_B, at: LATER,
			})).outcome).toBe('blocked');
			expect((await authority.get({ network: 'testnet', payer: PAYER }))?.state).toBe('signing');
		} finally {
			db.close();
		}
	});

	it('releases signed work only from exact validated terminal evidence', async () => {
		const db = new SqliteD1();
		try {
			const authority = new PayerSequenceLeaseAuthority(asD1(db));
			const owned = await signedLease(authority);
			expect((await authority.releaseValidatedTerminal({
				...owned,
				hash: HASH_A,
				at: LATER,
				evidence: { validated: true, transactionFound: true, ledgerIndex: 101 },
			})).outcome).toBe('released');
			expect((await authority.releaseValidatedTerminal({
				...owned,
				hash: HASH_A,
				at: LATER,
				evidence: { validated: true, transactionFound: true, ledgerIndex: 101 },
			})).outcome).toBe('replay');
		} finally {
			db.close();
		}
	});

	it('requires the exact contiguous validity window before expired-absent release', async () => {
		const db = new SqliteD1();
		try {
			const authority = new PayerSequenceLeaseAuthority(asD1(db));
			const owned = await signedLease(authority);
			await expect(authority.releaseExpiredAbsent({
				...owned,
				hash: HASH_A,
				lastLedgerSequence: 102,
				at: LATER,
				evidence: {
					validated: true, transactionFound: false, validatedLedgerIndex: 103,
					inclusionLedgersChecked: [100, 102],
				},
			})).rejects.toThrow(PayerSequenceLeaseDataError);
			expect((await authority.releaseExpiredAbsent({
				...owned,
				hash: HASH_A,
				lastLedgerSequence: 102,
				at: LATER,
				evidence: {
					validated: true, transactionFound: false, validatedLedgerIndex: 103,
					inclusionLedgersChecked: [100, 101, 102],
				},
			})).outcome).toBe('released');
		} finally {
			db.close();
		}
	});
});

describe('0008 AP4M shared runtime migration', () => {
	it.each([
		{
			label: 'orphan execution identity',
			seed: (database: DatabaseSync) => {
				database.prepare(`INSERT INTO builds (
					id, principal, owner, network, tx_json, summary, last_ledger_seq, created_at
				) VALUES ('build', 'principal', ?, 'testnet', '{}', '{}', 99, ?)`)
					.run(PAYER, NOW);
				database.prepare(`INSERT INTO executions (
					id, principal, build_id, idempotency_key, status, created_at
				) VALUES ('', 'principal', 'build', 'orphan-identity', 'prepared', ?)`)
					.run(NOW);
			},
		},
		{
			label: 'missing build',
			seed: (database: DatabaseSync) => database.prepare(`INSERT INTO executions (
				id, principal, build_id, idempotency_key, status, created_at
			) VALUES ('execution', 'principal', 'missing', 'missing-build', 'prepared', ?)`)
				.run(NOW),
		},
		{
			label: 'execution/build principal mismatch',
			seed: (database: DatabaseSync) => {
				database.prepare(`INSERT INTO builds (
					id, principal, owner, network, tx_json, summary, last_ledger_seq, created_at
				) VALUES ('build', 'other-principal', ?, 'testnet', '{}', '{}', 99, ?)`)
					.run(PAYER, NOW);
				database.prepare(`INSERT INTO executions (
					id, principal, build_id, idempotency_key, status, created_at
				) VALUES ('execution', 'principal', 'build', 'principal-mismatch', 'prepared', ?)`)
					.run(NOW);
			},
		},
	])('aborts the compatibility upgrade for $label', ({ seed }) => {
		const database = new DatabaseSync(':memory:');
		try {
			database.exec('PRAGMA foreign_keys = ON');
			for (const name of [
				'0001_init.sql', '0002_x402_payments.sql', '0003_x402_payers.sql',
				'0004_x402_sequence_safety.sql', '0005_x402_durable_lease.sql',
				'0006_x402_budget_accounting.sql', '0007_x402_payer_provisioning.sql',
			]) database.exec(readFileSync(new URL(`../migrations-local-x402/${name}`, import.meta.url), 'utf8'));
			seed(database);
			expect(() => database.exec(readFileSync(new URL(
				'../migrations-local-x402/0008_ap4m_shared_runtime.sql', import.meta.url,
			), 'utf8'))).toThrow();
		} finally {
			database.close();
		}
	});

	it('backfills immutable local execution attribution and snapshots every future execution', () => {
		const database = new DatabaseSync(':memory:');
		try {
			database.exec('PRAGMA foreign_keys = ON');
			for (const name of [
				'0001_init.sql', '0002_x402_payments.sql', '0003_x402_payers.sql',
				'0004_x402_sequence_safety.sql', '0005_x402_durable_lease.sql',
				'0006_x402_budget_accounting.sql', '0007_x402_payer_provisioning.sql',
			]) database.exec(readFileSync(new URL(`../migrations-local-x402/${name}`, import.meta.url), 'utf8'));
			database.prepare(`INSERT INTO builds (
				id, principal, owner, network, tx_json, summary, last_ledger_seq, created_at
			) VALUES ('legacy-build', 'principal', ?, 'testnet', '{}', '{}', 99, ?)`)
				.run(OTHER_PAYER, NOW);
			database.prepare(`INSERT INTO executions (
				id, principal, build_id, idempotency_key, status, created_at
			) VALUES ('legacy-execution', 'principal', 'legacy-build', 'legacy-execution-key',
				'prepared', ?)`)
				.run(NOW);
			database.exec(readFileSync(new URL(
				'../migrations-local-x402/0008_ap4m_shared_runtime.sql', import.meta.url,
			), 'utf8'));
			expect(database.prepare(`SELECT execution_id, principal, build_id,
				snapshot_owner, snapshot_network, created_at FROM execution_snapshots
				WHERE execution_id = 'legacy-execution'`).get()).toEqual({
					execution_id: 'legacy-execution', principal: 'principal', build_id: 'legacy-build',
					snapshot_owner: OTHER_PAYER, snapshot_network: 'testnet', created_at: NOW,
				});
			database.prepare(`UPDATE builds SET owner = ? WHERE id = 'legacy-build'`).run(PAYER);
			expect(database.prepare(`SELECT snapshot_owner FROM execution_snapshots
				WHERE execution_id = 'legacy-execution'`).get()).toEqual({ snapshot_owner: OTHER_PAYER });
			expect(() => database.prepare(`UPDATE execution_snapshots SET snapshot_owner = ?
				WHERE execution_id = 'legacy-execution'`).run(PAYER)).toThrow(/immutable/);
			expect(() => database.prepare(`DELETE FROM execution_snapshots
				WHERE execution_id = 'legacy-execution'`).run()).toThrow(/immutable/);

			database.prepare(`INSERT INTO builds (
				id, principal, owner, network, tx_json, summary, last_ledger_seq, created_at
			) VALUES ('future-build', 'principal', ?, 'testnet', '{}', '{}', 100, ?)`)
				.run(PAYER, LATER);
			database.prepare(`INSERT INTO executions (
				id, principal, build_id, idempotency_key, status, created_at
			) VALUES ('future-execution', 'principal', 'future-build', 'future-execution-key',
				'prepared', ?)`)
				.run(LATER);
			expect(database.prepare(`SELECT snapshot_owner, snapshot_network
				FROM execution_snapshots WHERE execution_id = 'future-execution'`).get())
				.toEqual({ snapshot_owner: PAYER, snapshot_network: 'testnet' });
			expect(() => database.prepare(`INSERT INTO executions (
				id, principal, build_id, idempotency_key, status, created_at
			) VALUES ('orphan', 'principal', 'missing', 'orphan-key', 'prepared', ?)`)
				.run(LATER)).toThrow(/build binding is invalid/);
			expect(database.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
		} finally {
			database.close();
		}
	});

	it('keeps normal 0009 rows intact through 0010 and matches the combined channel schema exactly', () => {
		const normal = new DatabaseSync(':memory:');
		const combined = new DatabaseSync(':memory:');
		try {
			applyMainBeforeChannel(normal);
			normal.prepare(`INSERT INTO ap4m_mandates (
				id, principal, owner, network, status, execution_type, not_before, expires_at,
				constraints_json, agent_public_jwk, agent_key_enc, agent_key_iv, claim_keys_enc,
				claim_keys_iv, claim_public_keys_json, prepared_json, created_at, updated_at
			) VALUES ('existing', 'principal', ?, 'testnet', 'ACTIVE', 'DEFERRED', ?, ?, '{}',
				'{}', ?, ?, ?, ?, '[]', '{"unsigned_batch":{}}', ?, ?)`)
				.run(
					OTHER_PAYER, NOW, '2026-10-22T18:00:00.000Z',
					Buffer.alloc(32, 1), Buffer.alloc(12, 2), Buffer.alloc(32, 3), Buffer.alloc(12, 4),
					NOW, NOW,
				);
			normal.prepare(`INSERT INTO ap4m_purchase_attempts (
				id, principal, mandate_id, idempotency_key, request_fingerprint, merchant_id,
				sku, status, lease_acquired_at, created_at, updated_at
			) VALUES ('existing-attempt', 'principal', 'existing', 'existing-key', ?,
				'merchant', 'sku', 'claimed', ?, ?, ?)`)
				.run('1'.repeat(64), NOW, NOW, NOW);
			const before = normal.prepare('SELECT * FROM ap4m_purchase_attempts').get();
			normal.exec(mainMigration('0010_ap4m_channel_purchase.sql'));
			expect(normal.prepare('SELECT * FROM ap4m_purchase_attempts').get()).toEqual(before);
			expect(normal.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });

			combined.exec('PRAGMA foreign_keys = ON');
			combined.exec(MIGRATIONS);
			expect(normalizedChannelSchema(normal)).toEqual(normalizedChannelSchema(combined));
			expect(normalizedChannelSchema(normal)).toHaveLength(CHANNEL_SCHEMA_OBJECTS.length);
			const columns = normal.prepare('PRAGMA table_info(ap4m_paychan_purchase_attempts)')
				.all().map((row) => String(row.name));
			expect(columns).toContain('retry_material_enc');
			expect(columns).toContain('retry_material_iv');
			expect(columns).toContain('retry_material_digest');
			expect(columns).not.toContain('intent_json');
			expect(columns).not.toContain('vi_l1');
			expect(columns).not.toContain('vi_l2');
			expect(columns).not.toContain('vi_l3b');
		} finally {
			normal.close();
			combined.close();
		}
	});

	it('enforces both rail-exclusion directions, strict claim shapes, replay keys and lookup indexes', () => {
		const database = new DatabaseSync(':memory:');
		try {
			applyMainBeforeChannel(database);
			database.exec(mainMigration('0010_ap4m_channel_purchase.sql'));
			const paychanFirst = seedPaychanPrerequisites(database, 'a');
			insertPaychanPurchase(database, paychanFirst);
			expect(database.prepare(`SELECT status, receipt_id
				FROM ap4m_paychan_purchase_attempts
				WHERE principal = 'principal' AND mandate_id = ? AND idempotency_key = ?`)
				.get(paychanFirst.mandateId, paychanFirst.idempotencyKey)).toEqual({
					status: 'reserved',
					receipt_id: `receipt-${paychanFirst.idempotencyKey}`,
				});
			expect(() => insertExactAttempt(database, paychanFirst)).toThrow(/paychan rail/);
			expect(() => insertPaychanPurchase(database, paychanFirst)).toThrow(/UNIQUE/);
			expect(database.prepare(`SELECT COUNT(*) AS count FROM ap4m_paychan_purchase_attempts
				WHERE principal = 'principal' AND mandate_id = ? AND idempotency_key = ?`)
				.get(paychanFirst.mandateId, paychanFirst.idempotencyKey)).toEqual({ count: 1 });
			const receiptId = `receipt-${paychanFirst.idempotencyKey}`;
			const receipt = {
				receipt_id: receiptId,
				mandate_id: paychanFirst.mandateId,
				merchant_id: paychanFirst.merchantId,
				sku: 'sku',
				intent_id: `intent-${paychanFirst.idempotencyKey}`,
				l3a_digest: 'a'.repeat(64),
				l3b_digest: 'b'.repeat(64),
				scheme: 'xrpl-paychan',
				amount: { asset: { kind: 'iou', currency: 'RLUSD', issuer: OTHER_PAYER }, value: '0.05' },
				proof: { channel_id: paychanFirst.channelId, cumulative_drops: '5' },
				merchant_validation: { checks: ['pass'] },
				settlement: 'claim_accepted',
				at: NOW,
			};
			const insertReceipt = (json: string) => database.prepare(`INSERT INTO ap4m_receipts (
				id, principal, mandate_id, merchant_id, idempotency_key, json, created_at
			) VALUES (?, 'principal', ?, ?, ?, ?, ?)`)
				.run(receiptId, paychanFirst.mandateId, paychanFirst.merchantId,
					paychanFirst.idempotencyKey, json, NOW);
			expect(() => insertReceipt(JSON.stringify(receipt))).toThrow(/receipt binding mismatch/);
			database.prepare(`UPDATE ap4m_channel_claim_attempts SET
				signature = 'AA', status = 'completed', updated_at = ?
				WHERE principal = 'principal' AND channel_id = ? AND idempotency_key = ?`)
				.run(NOW, paychanFirst.channelId, paychanFirst.idempotencyKey);
			database.prepare(`UPDATE ap4m_channel_claims SET
				cumulative_drops = '5', last_price_drops = '5', last_idempotency_key = ?,
				signature = 'AA', pending_idempotency_key = NULL, pending_price_drops = NULL,
				pending_cumulative_drops = NULL, pending_token = NULL, updated_at = ?
				WHERE principal = 'principal' AND channel_id = ?`)
				.run(paychanFirst.idempotencyKey, NOW, paychanFirst.channelId);
			database.prepare(`UPDATE ap4m_paychan_purchase_attempts SET
				signature = 'AA', status = 'claim_signed', updated_at = ?
				WHERE principal = 'principal' AND mandate_id = ? AND idempotency_key = ?`)
				.run(NOW, paychanFirst.mandateId, paychanFirst.idempotencyKey);
			database.prepare(`UPDATE ap4m_paychan_purchase_attempts SET
				merchant_response_json = '{}', status = 'merchant_accepted', accepted_at = ?, updated_at = ?
				WHERE principal = 'principal' AND mandate_id = ? AND idempotency_key = ?`)
				.run(NOW, NOW, paychanFirst.mandateId, paychanFirst.idempotencyKey);
			expect(() => insertReceipt(JSON.stringify({ ...receipt, intent_id: 'wrong' })))
				.toThrow(/receipt binding mismatch/);
			insertReceipt(JSON.stringify(receipt));
			const result = JSON.stringify({ receipt, data: { schema_id: 'yield_report_v1' } });
			expect(() => database.prepare(`UPDATE ap4m_paychan_purchase_attempts SET
				result_json = ?, status = 'delivered', delivered_at = ?, updated_at = ?
				WHERE principal = 'principal' AND mandate_id = ? AND idempotency_key = ?`)
				.run(result, NOW, NOW, paychanFirst.mandateId, paychanFirst.idempotencyKey))
				.toThrow(/delivered binding mismatch/);
			database.prepare(`UPDATE ap4m_spend SET status = 'committed', receipt_id = ?, updated_at = ?
				WHERE id = ?`).run(receiptId, NOW, paychanFirst.spendId);
			expect(() => database.prepare(`UPDATE ap4m_paychan_purchase_attempts SET
				result_json = ?, status = 'delivered', delivered_at = ?, updated_at = ?
				WHERE principal = 'principal' AND mandate_id = ? AND idempotency_key = ?`)
				.run(JSON.stringify({ receipt: { ...receipt, sku: 'wrong' }, data: {} }),
					NOW, NOW, paychanFirst.mandateId, paychanFirst.idempotencyKey))
				.toThrow(/delivered binding mismatch/);
			database.prepare(`UPDATE ap4m_paychan_purchase_attempts SET
				result_json = ?, status = 'delivered', delivered_at = ?, updated_at = ?
				WHERE principal = 'principal' AND mandate_id = ? AND idempotency_key = ?`)
				.run(result, NOW, NOW, paychanFirst.mandateId, paychanFirst.idempotencyKey);
			expect(database.prepare(`SELECT status FROM ap4m_paychan_purchase_attempts
				WHERE principal = 'principal' AND mandate_id = ? AND idempotency_key = ?`)
				.get(paychanFirst.mandateId, paychanFirst.idempotencyKey)).toEqual({ status: 'delivered' });

			const exactFirst = seedPaychanPrerequisites(database, 'b');
			insertExactAttempt(database, exactFirst);
			expect(() => insertPaychanPurchase(database, exactFirst)).toThrow(/exact rail/);
			const spendMismatch = seedPaychanPrerequisites(database, 'c');
			database.prepare(`UPDATE ap4m_spend SET idempotency_key = 'other-purchase'
				WHERE id = ?`).run(spendMismatch.spendId);
			expect(() => insertPaychanPurchase(database, spendMismatch))
				.toThrow(/purchase claim binding mismatch/);
			expect(() => database.prepare(`UPDATE ap4m_paychan_purchase_attempts
				SET amount_usd = '.' WHERE principal = 'principal' AND mandate_id = ?
					AND idempotency_key = ?`)
				.run(paychanFirst.mandateId, paychanFirst.idempotencyKey)).toThrow();
			expect(() => database.prepare(`UPDATE ap4m_paychan_purchase_attempts
				SET amount_usd = '1..2' WHERE principal = 'principal' AND mandate_id = ?
					AND idempotency_key = ?`)
				.run(paychanFirst.mandateId, paychanFirst.idempotencyKey)).toThrow();
			expect(() => database.prepare(`UPDATE ap4m_channel_claims
				SET channel_amount_drops = ? WHERE principal = 'principal' AND channel_id = ?`)
				.run('9'.repeat(19), paychanFirst.channelId)).toThrow();
			expect(() => database.prepare(`UPDATE ap4m_channel_claims
				SET merchant_id = 'other-merchant' WHERE principal = 'principal' AND channel_id = ?`)
				.run(paychanFirst.channelId)).toThrow(/binding mismatch/);

			const indexes = database.prepare(`SELECT name FROM sqlite_schema
				WHERE type = 'index' AND name IN (
					'idx_ap4m_channel_claims_mandate',
					'idx_ap4m_paychan_purchase_channel',
					'idx_ap4m_paychan_purchase_recovery'
				) ORDER BY name`).all().map((row) => String(row.name));
			expect(indexes).toEqual([
				'idx_ap4m_channel_claims_mandate',
				'idx_ap4m_paychan_purchase_channel',
				'idx_ap4m_paychan_purchase_recovery',
			]);
			const plan = database.prepare(`EXPLAIN QUERY PLAN
				SELECT * FROM ap4m_paychan_purchase_attempts
				WHERE principal = ? AND channel_id = ? ORDER BY created_at`)
				.all('principal', paychanFirst.channelId)
				.map((row) => String(row.detail)).join(' ');
			expect(plan).toContain('idx_ap4m_paychan_purchase_channel');
			expect(database.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
		} finally {
			database.close();
		}
	});

	it('matches the authoritative main QuickNode table, column and index shapes', () => {
		const combined = new DatabaseSync(':memory:');
		const authoritative = new DatabaseSync(':memory:');
		try {
			combined.exec('PRAGMA foreign_keys = ON');
			authoritative.exec('PRAGMA foreign_keys = ON');
			combined.exec(MIGRATIONS);
			authoritative.exec(readFileSync(new URL(
				'../migrations-local-x402/0001_init.sql', import.meta.url,
			), 'utf8'));
			authoritative.exec(readFileSync(new URL('../migrations/0002_quicknode.sql', import.meta.url), 'utf8'));
			authoritative.exec(readFileSync(new URL(
				'../migrations/0008_quicknode_rpc_counters.sql', import.meta.url,
			), 'utf8'));
			const names = [
				'qn_nonces', 'qn_wallet_events', 'qn_watchdog_events', 'qn_rpc_counters',
				'idx_qn_wallet_account', 'idx_qn_watchdog_account',
			];
			const normalize = (db: DatabaseSync) => db.prepare(`SELECT type, name, sql FROM sqlite_master
				WHERE name IN (${names.map(() => '?').join(', ')}) ORDER BY type, name`)
				.all(...names)
				.map((row) => ({
					type: row.type,
					name: row.name,
					sql: String(row.sql).replace(/\s+/g, ' ').trim().toUpperCase(),
				}));
			expect(normalize(combined)).toEqual(normalize(authoritative));
			for (const table of ['links', 'executions']) {
				const columns = (db: DatabaseSync) => db.prepare(`PRAGMA table_info(${table})`).all()
					.map((row) => ({ name: row.name, type: row.type, notnull: row.notnull, dflt_value: row.dflt_value }));
				expect(columns(combined)).toEqual(columns(authoritative));
			}
		} finally {
			combined.close();
			authoritative.close();
		}
	});

	it('adds the AP4M schema and conservatively fences every legacy nonterminal payer', () => {
		const sqlite = new DatabaseSync(':memory:');
		try {
			sqlite.exec('PRAGMA foreign_keys = ON');
			for (let index = 0; index < 7; index += 1) {
				const names = [
					'0001_init.sql', '0002_x402_payments.sql', '0003_x402_payers.sql',
					'0004_x402_sequence_safety.sql', '0005_x402_durable_lease.sql',
					'0006_x402_budget_accounting.sql', '0007_x402_payer_provisioning.sql',
				];
				sqlite.exec(readFileSync(new URL(`../migrations-local-x402/${names[index]}`, import.meta.url), 'utf8'));
			}
			sqlite.prepare(`INSERT INTO x402_payments (
				id, principal, idempotency_key, request_fingerprint, owner, network, delegate, url,
				status, amount_drops, lease_acquired_at, created_at, updated_at
			) VALUES (?, 'p', ?, ?, ?, 'testnet', ?, 'https://merchant.example', 'prepared', 1, ?, ?, ?)`)
				.run('legacy-active', 'idem-active', '1'.repeat(64), OTHER_PAYER, PAYER, NOW, NOW, NOW);
			sqlite.prepare(`INSERT INTO x402_payments (
				id, principal, idempotency_key, request_fingerprint, owner, network, delegate, url,
				status, amount_drops, lease_acquired_at, created_at, updated_at
			) VALUES (?, 'p', ?, ?, ?, 'testnet', ?, 'https://merchant.example', 'delivered', 1, ?, ?, ?)`)
				.run('legacy-terminal', 'idem-terminal', '2'.repeat(64), OTHER_PAYER, OTHER_PAYER, NOW, NOW, NOW);
			sqlite.exec(readFileSync(new URL(
				'../migrations-local-x402/0008_ap4m_shared_runtime.sql', import.meta.url,
			), 'utf8'));
			const tables = sqlite.prepare(`SELECT name FROM sqlite_master
				WHERE type = 'table' AND name IN (
					'ap4m_mandates', 'ap4m_spend', 'ap4m_receipts',
					'ap4m_purchase_attempts', 'ap4m_channel_claims',
					'ap4m_channel_claim_attempts', 'ap4m_paychan_purchase_attempts',
					'payer_sequence_leases'
				) ORDER BY name`).all().map((row) => String(row.name));
			expect(tables).toEqual([
				'ap4m_channel_claim_attempts', 'ap4m_channel_claims', 'ap4m_mandates',
				'ap4m_paychan_purchase_attempts', 'ap4m_purchase_attempts',
				'ap4m_receipts', 'ap4m_spend', 'payer_sequence_leases',
			]);
			const requiredObjects = [
				'idx_ap4m_channel_claims_mandate',
				'idx_ap4m_paychan_purchase_channel',
				'idx_ap4m_paychan_purchase_recovery',
				'trg_ap4m_channel_attempt_binding_insert',
				'trg_ap4m_channel_attempt_binding_update',
				'trg_ap4m_channel_claim_binding_immutable',
				'trg_ap4m_channel_claim_mandate_insert',
				'trg_ap4m_channel_claim_mandate_update',
				'trg_ap4m_exact_excludes_paychan_insert',
				'trg_ap4m_exact_excludes_paychan_update',
				'trg_ap4m_paychan_excludes_exact_insert',
				'trg_ap4m_paychan_excludes_exact_update',
				'trg_ap4m_paychan_delivered_update',
				'trg_ap4m_paychan_receipt_binding_insert',
				'trg_ap4m_paychan_purchase_binding_insert',
				'trg_ap4m_paychan_purchase_binding_update',
			];
			expect(sqlite.prepare(`SELECT name FROM sqlite_master
				WHERE name IN (${requiredObjects.map(() => '?').join(', ')}) ORDER BY name`)
				.all(...requiredObjects).map((row) => String(row.name)))
				.toEqual([...requiredObjects].sort());
			expect(sqlite.prepare(`SELECT rail, state, attempt_id FROM payer_sequence_leases
				WHERE network = 'testnet' AND payer = ?`).get(PAYER)).toMatchObject({
				rail: 'legacy', state: 'legacy_ambiguous', attempt_id: 'legacy-x402:legacy-active',
			});
			expect(sqlite.prepare(`SELECT 1 FROM payer_sequence_leases WHERE payer = ?`).get(OTHER_PAYER)).toBeUndefined();
			expect(sqlite.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
		} finally {
			sqlite.close();
		}
	});
});
