import { DatabaseSync, type StatementSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";
import { Wallet, type Payment } from "xrpl";

import {
	handleOwnerReviewX402Route,
	type OwnerReviewRouteContext,
} from "../src/x402-owner-review-route";
import { OpRegistry } from "../src/catalog/registry";
import { createWorker, type Env } from "../src/server";

type SqlValue = string | number | bigint | null | Uint8Array;

class SqliteD1Statement {
	private values: SqlValue[] = [];
	constructor(
		private readonly statement: StatementSync,
		private readonly beforeRun?: () => Promise<void>,
	) {}
	bind(...values: unknown[]): this {
		this.values = values.map((value) => value instanceof ArrayBuffer
			? new Uint8Array(value)
			: value as SqlValue);
		return this;
	}
	async run(): Promise<D1Result> {
		await this.beforeRun?.();
		const result = this.statement.run(...this.values);
		return { success: true, meta: { changes: Number(result.changes) } as D1Result["meta"] };
	}
	async first<T>(column?: string): Promise<T | null> {
		const row = this.statement.get(...this.values) as Record<string, unknown> | undefined;
		if (row === undefined) return null;
		return (column === undefined ? row : row[column]) as T;
	}
}

class SqliteD1 {
	readonly sqlite = new DatabaseSync(":memory:");
	beforeRun?: (sql: string) => Promise<void>;
	prepare(sql: string): SqliteD1Statement {
		return new SqliteD1Statement(
			this.sqlite.prepare(sql),
			async () => { await this.beforeRun?.(sql); },
		);
	}
	close(): void { this.sqlite.close(); }
}

const open = new Set<SqliteD1>();

afterEach(() => {
	for (const database of open) database.close();
	open.clear();
});

function context(db = new SqliteD1()): OwnerReviewRouteContext {
	open.add(db);
	return {
		principal: "principal-owner-review-route",
		localDevRequest: true,
		db: db as unknown as D1Database,
		env: {
			HARBOR_LOCAL_DEV: "true",
			HARBOR_MOCK: "1",
			HARBOR_LOCAL_X402_OWNER_REVIEW_ENABLED: "true",
			EXEC_NETWORK: "testnet",
			MAINNET_EXECUTION: "false",
			HARBOR_SOURCE_TAG: "2610240",
		},
	};
}

async function call(
	ctx: OwnerReviewRouteContext,
	name: string,
	body: unknown,
): Promise<{ response: Response; envelope: any }> {
	const response = await handleOwnerReviewX402Route(new Request(
		`http://127.0.0.1:8791/api/ops/${name}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	), ctx);
	if (!response) throw new Error("owner-review route was not handled");
	return { response, envelope: await response.json() };
}

function prepareBody(owner: string, key = "owner-review-route-0001") {
	return {
		owner,
		network: "testnet",
		max_price_drops: "5000",
		idempotency_key: key,
	};
}

function decisionBody(prepared: any) {
	return {
		owner: prepared.owner,
		network: prepared.network,
		idempotency_key: prepared.idempotency_key,
		approval_id: prepared.approval_id,
	};
}

describe("reachable local/mock owner-reviewed x402 operations", () => {
	it("requires configured Bearer authentication instead of the legacy loopback bypass", async () => {
		const db = new SqliteD1();
		open.add(db);
		const worker = createWorker(new OpRegistry());
		const env = {
			DB: db as unknown as D1Database,
			EXECUTOR: "quickjs",
			HARBOR_API_KEYS: "review-principal:review-secret",
			HARBOR_LOCAL_DEV: "true",
			HARBOR_MOCK: "1",
			HARBOR_LOCAL_X402_OWNER_REVIEW_ENABLED: "true",
			EXEC_NETWORK: "testnet",
			MAINNET_EXECUTION: "false",
			HARBOR_SOURCE_TAG: "2610240",
		} satisfies Env;
		const request = (authorization?: string) => new Request(
			"http://127.0.0.1:8791/api/ops/x402.ownerReviewPrepare",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(authorization === undefined ? {} : { authorization }),
				},
				body: JSON.stringify(prepareBody(Wallet.generate().classicAddress, "owner-review-auth-0001")),
			},
		);

		for (const authorization of [undefined, "Bearer review-principal:wrong-secret"]) {
			const response = await worker.fetch!(request(authorization), env, {} as ExecutionContext);
			expect(response.status).toBe(401);
			await expect(response.json()).resolves.toMatchObject({
				ok: false,
				error: { code: "UNAUTHORIZED" },
			});
		}
		expect(db.sqlite.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'x402_owner_reviews'",
		).get()).toBeUndefined();
	});

	it("rejects the reserved legacy principal at the route boundary", async () => {
		const db = new SqliteD1();
		const ctx = { ...context(db), principal: "local-dev" };
		const result = await call(
			ctx,
			"x402.ownerReviewPrepare",
			prepareBody(Wallet.generate().classicAddress, "owner-review-reserved-principal-1"),
		);
		expect(result.response.status).toBe(401);
		expect(result.envelope).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
		expect(db.sqlite.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'x402_owner_reviews'",
		).get()).toBeUndefined();
	});

	it("runs the complete owner-signature flow through the Harbor worker without catalog registration", async () => {
		const wallet = Wallet.generate();
		const db = new SqliteD1();
		open.add(db);
		const env = {
			DB: db as unknown as D1Database,
			EXECUTOR: "quickjs",
			HARBOR_API_KEYS: "review-principal:review-secret",
			HARBOR_LOCAL_DEV: "true",
			HARBOR_MOCK: "1",
			HARBOR_LOCAL_X402_OWNER_REVIEW_ENABLED: "true",
			EXEC_NETWORK: "testnet",
			MAINNET_EXECUTION: "false",
			HARBOR_SOURCE_TAG: "2610240",
		} satisfies Env;
		const worker = createWorker(new OpRegistry());
		const prepareResponse = await worker.fetch!(
			new Request("http://127.0.0.1:8791/api/ops/x402.ownerReviewPrepare", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: "Bearer review-principal:review-secret",
				},
				body: JSON.stringify(prepareBody(wallet.classicAddress, "owner-review-worker-0001")),
			}),
			env,
			{} as ExecutionContext,
		);
		const prepareEnvelope = await prepareResponse.json() as any;
		expect(prepareResponse.status).toBe(200);
		expect(prepareEnvelope).toMatchObject({
			ok: true,
			data: {
				status: "awaiting_approval",
				owner: wallet.classicAddress,
				validated_ledger_index: 1000,
				validated_account_sequence: 1,
				expected_source_tag: 2610240,
			},
		});

		const prepared = prepareEnvelope.data;
		const signed = wallet.sign(prepared.tx_json as Payment);
		const submitResponse = await worker.fetch!(
			new Request("http://127.0.0.1:8791/api/ops/x402.ownerReviewSubmit", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: "Bearer review-principal:review-secret",
				},
				body: JSON.stringify({
					...decisionBody(prepared),
					approval_digest: prepared.approval_digest,
					signed_blob: signed.tx_blob,
				}),
			}),
			env,
			{} as ExecutionContext,
		);
		const submitEnvelope = await submitResponse.json() as any;
		expect(submitResponse.status).toBe(200);
		expect(submitEnvelope).toMatchObject({
			ok: true,
			data: {
				status: "delivered",
				tx_hash: signed.hash,
				receipt: {
					status: "delivered",
					tx_hash: signed.hash,
					body: { comparison: ["dex", "amm"] },
				},
			},
		});
	});

	it("is default-off and does not initialize storage while disabled", async () => {
		const db = new SqliteD1();
		const ctx = context(db);
		(ctx.env as Record<string, string | undefined>).HARBOR_LOCAL_X402_OWNER_REVIEW_ENABLED = undefined;
		const result = await call(ctx, "x402.ownerReviewPrepare", prepareBody(Wallet.generate().classicAddress));
		expect(result.response.status).toBe(404);
		expect(result.envelope).toMatchObject({ ok: false, error: { code: "OWNER_REVIEW_DISABLED" } });
		const table = db.sqlite.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'x402_owner_reviews'",
		).get();
		expect(table).toBeUndefined();
	});

	it("runs request, review, owner signature, one simulated relay, reconciliation, and receipt", async () => {
		const wallet = Wallet.generate();
		const ctx = context();
		const preparedResult = await call(ctx, "x402.ownerReviewPrepare", prepareBody(wallet.classicAddress));
		expect(preparedResult.envelope.ok).toBe(true);
		const prepared = preparedResult.envelope.data;
		expect(prepared).toMatchObject({
			status: "awaiting_approval",
			owner: wallet.classicAddress,
			network: "testnet",
			asset: "XRP",
			amount_drops: "5000",
			validated_ledger_index: 1000,
			validated_account_sequence: 1,
			expected_source_tag: 2610240,
			tx_json: {
				TransactionType: "Payment",
				Account: wallet.classicAddress,
				Amount: "5000",
				Sequence: 1,
				SourceTag: 2610240,
			},
		});
		const signed = wallet.sign(prepared.tx_json as Payment);
		const submittedResult = await call(ctx, "x402.ownerReviewSubmit", {
			...decisionBody(prepared),
			approval_digest: prepared.approval_digest,
			signed_blob: signed.tx_blob,
		});
		expect(submittedResult.envelope.ok).toBe(true);
		expect(submittedResult.envelope.data).not.toHaveProperty("signed_blob");
		expect(submittedResult.envelope.data).not.toHaveProperty("tx_json");
		expect(submittedResult.envelope.data).toMatchObject({
			status: "delivered",
			tx_hash: signed.hash,
			receipt: {
				status: "delivered",
				simulation: true,
				owner: wallet.classicAddress,
				network: "testnet",
				asset: "XRP",
				amount_drops: "5000",
				tx_hash: signed.hash,
				body: { comparison: ["dex", "amm"] },
				provenance: "local-mock-simulated-settlement",
			},
		});

		const recovered = await call(ctx, "x402.ownerReviewRecover", decisionBody(prepared));
		expect(recovered.envelope.data).toEqual(submittedResult.envelope.data);
		const replay = await call(ctx, "x402.ownerReviewSubmit", {
			...decisionBody(prepared),
			approval_digest: prepared.approval_digest,
			signed_blob: signed.tx_blob,
		});
		expect(replay.envelope.data).toEqual(submittedResult.envelope.data);
	});

	it("recovers when reconciliation wins the mock relay-marker race without dispatching twice", async () => {
		const wallet = Wallet.generate();
		const db = new SqliteD1();
		const ctx = context(db);
		const prepared = (await call(
			ctx,
			"x402.ownerReviewPrepare",
			prepareBody(wallet.classicAddress, "owner-review-route-marker-race-1"),
		)).envelope.data;
		const signed = wallet.sign(prepared.tx_json as Payment);
		let markerWrites = 0;
		let markerReached!: () => void;
		let releaseMarker!: () => void;
		const reached = new Promise<void>((resolve) => { markerReached = resolve; });
		const released = new Promise<void>((resolve) => { releaseMarker = resolve; });
		db.beforeRun = async (sql) => {
			if (!sql.includes("SET mock_relay_dispatched = 1")) return;
			markerWrites += 1;
			markerReached();
			await released;
		};

		const submitted = call(ctx, "x402.ownerReviewSubmit", {
			...decisionBody(prepared),
			approval_digest: prepared.approval_digest,
			signed_blob: signed.tx_blob,
		});
		await reached;
		const earlyRecovery = await call(ctx, "x402.ownerReviewRecover", decisionBody(prepared));
		expect(earlyRecovery.envelope.data.status).toBe("settlement_unknown");
		releaseMarker();

		const delivered = await submitted;
		expect(delivered.envelope.data).toMatchObject({
			status: "delivered",
			tx_hash: signed.hash,
			receipt: { provenance: "local-mock-simulated-settlement" },
		});
		const replay = await call(ctx, "x402.ownerReviewSubmit", {
			...decisionBody(prepared),
			approval_digest: prepared.approval_digest,
			signed_blob: signed.tx_blob,
		});
		expect(replay.envelope.data).toEqual(delivered.envelope.data);
		expect(markerWrites).toBe(1);
	});

	it("recovers mock settlement from D1 after the route runtime is recreated", async () => {
		const wallet = Wallet.generate();
		const db = new SqliteD1();
		const first = context(db);
		const prepared = (await call(first, "x402.ownerReviewPrepare",
			prepareBody(wallet.classicAddress, "owner-review-route-restart-1"))).envelope.data;
		const signed = wallet.sign(prepared.tx_json as Payment);
		const delivered = await call(first, "x402.ownerReviewSubmit", {
			...decisionBody(prepared),
			approval_digest: prepared.approval_digest,
			signed_blob: signed.tx_blob,
		});
		expect(delivered.envelope.data.status).toBe("delivered");

		const stored = db.sqlite.prepare(
			"SELECT revision, record_json FROM x402_owner_reviews WHERE approval_id = ?",
		).get(prepared.approval_id) as { revision: number; record_json: string };
		const record = JSON.parse(stored.record_json) as Record<string, unknown>;
		record.status = "settlement_unknown";
		record.revision = stored.revision + 1;
		record.settlement = null;
		record.receipt = null;
		record.updatedAt = "2026-10-24T12:00:01.000Z";
		db.sqlite.prepare(`UPDATE x402_owner_reviews
			SET revision = ?, status = 'settlement_unknown', record_json = ?
			WHERE approval_id = ?`).run(record.revision as number, JSON.stringify(record), prepared.approval_id);

		// A distinct D1 facade gives the runtime cache a new identity while
		// retaining the same durable database, mirroring a Worker restart.
		const restarted: OwnerReviewRouteContext = {
			...first,
			db: { prepare: (sql: string) => db.prepare(sql) } as unknown as D1Database,
		};
		const recovered = await call(restarted, "x402.ownerReviewRecover", decisionBody(prepared));
		expect(recovered.envelope.data).toMatchObject({
			status: "delivered",
			tx_hash: signed.hash,
			receipt: { tx_hash: signed.hash, body: { comparison: ["dex", "amm"] } },
		});
	});

	it("atomically reuses one approval for concurrent prepare requests", async () => {
		const wallet = Wallet.generate();
		const ctx = context();
		const body = prepareBody(wallet.classicAddress, "owner-review-route-race-1");
		const [left, right] = await Promise.all([
			call(ctx, "x402.ownerReviewPrepare", body),
			call(ctx, "x402.ownerReviewPrepare", body),
		]);
		expect(left.envelope.ok).toBe(true);
		expect(right.envelope.ok).toBe(true);
		expect(right.envelope.data.approval_id).toBe(left.envelope.data.approval_id);
		const rowCount = (ctx.db as unknown as SqliteD1).sqlite
			.prepare("SELECT COUNT(*) AS count FROM x402_owner_reviews")
			.get() as { count: number };
		expect(Number(rowCount.count)).toBe(1);
	});

	it("persists an explicit owner rejection and refuses later submission", async () => {
		const wallet = Wallet.generate();
		const ctx = context();
		const prepared = (await call(
			ctx,
			"x402.ownerReviewPrepare",
			prepareBody(wallet.classicAddress, "owner-review-route-reject-1"),
		)).envelope.data;
		const rejected = await call(ctx, "x402.ownerReviewReject", decisionBody(prepared));
		expect(rejected.envelope.data).toMatchObject({ status: "rejected", reason: "owner_rejected" });
		const submitted = await call(ctx, "x402.ownerReviewSubmit", {
			...decisionBody(prepared),
			approval_digest: prepared.approval_digest,
			signed_blob: wallet.sign(prepared.tx_json as Payment).tx_blob,
		});
		expect(submitted.envelope).toMatchObject({ ok: false, error: { code: "APPROVAL_NOT_PENDING" } });
	});

	it("rejects a changed signing account before the simulated relay", async () => {
		const owner = Wallet.generate();
		const other = Wallet.generate();
		const ctx = context();
		const prepared = (await call(
			ctx,
			"x402.ownerReviewPrepare",
			prepareBody(owner.classicAddress, "owner-review-route-account-1"),
		)).envelope.data;
		const submitted = await call(ctx, "x402.ownerReviewSubmit", {
			...decisionBody(prepared),
			approval_digest: prepared.approval_digest,
			signed_blob: other.sign(prepared.tx_json as Payment).tx_blob,
		});
		expect(submitted.envelope).toMatchObject({ ok: false, error: { code: "SIGNED_TRANSACTION_INVALID" } });
		const recovered = await call(ctx, "x402.ownerReviewRecover", decisionBody(prepared));
		expect(recovered.envelope.data.status).toBe("awaiting_approval");
	});
});
