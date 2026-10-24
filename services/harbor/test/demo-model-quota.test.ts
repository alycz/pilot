import { readFileSync } from "node:fs";

import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	D1DemoQuotaStore,
	DemoQuotaError,
	readDemoQuotaConfig,
	type DemoQuotaConfig,
	type DemoQuotaReserveInput,
} from "../src/demo-model-quota";

const D1_ID = "33333333-3333-4333-8333-333333333333";
const PRINCIPAL = "pilot-demo";
const MODEL = "openrouter/example:free";
const WALLET_A = "a".repeat(64);
const WALLET_B = "b".repeat(64);
const SESSION_A = "c".repeat(64);
const SESSION_B = "d".repeat(64);
const REQUEST_A = "1".repeat(64);
const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const RESERVATION_A = "11111111-1111-4111-8111-111111111111";
const MIGRATION = readFileSync(
	new URL("../migrations/0013_demo_model_quota.sql", import.meta.url),
	"utf8",
).replaceAll(/--[^\n]*(?:\n|$)/gu, " ").replaceAll(/\s*\n\s*/gu, " ");

function environment(
	overrides: Readonly<Record<string, string | undefined>> = {},
): Readonly<Record<string, string | undefined>> {
	return {
		HARBOR_DEMO_QUOTA_ENABLED: "1",
		HARBOR_DEMO_QUOTA_PRINCIPAL: PRINCIPAL,
		HARBOR_DEMO_COST_POLICY: "free-only",
		HARBOR_DEMO_POLICY_VERSION: "free-v1",
		HARBOR_DEMO_ALLOWED_MODELS: MODEL,
		HARBOR_DEMO_GLOBAL_DAILY_OUTPUT_TOKENS: "400",
		HARBOR_DEMO_GLOBAL_DAILY_REQUESTS: "4",
		HARBOR_DEMO_WALLET_DAILY_OUTPUT_TOKENS: "200",
		HARBOR_DEMO_WALLET_DAILY_REQUESTS: "2",
		HARBOR_DEMO_RATE_WINDOW_SECONDS: "60",
		HARBOR_DEMO_RATE_REQUESTS: "2",
		HARBOR_DEMO_MAX_GLOBAL_CONCURRENCY: "1",
		HARBOR_DEMO_MAX_WALLET_CONCURRENCY: "1",
		HARBOR_DEMO_RESERVATION_TTL_SECONDS: "120",
		HARBOR_DEMO_ABORT_GRACE_SECONDS: "10",
		HARBOR_DEMO_MAX_INPUT_BYTES: "4096",
		HARBOR_DEMO_MAX_OUTPUT_TOKENS: "100",
		HARBOR_DEMO_MAX_STEPS: "4",
		...overrides,
	};
}

function config(
	overrides: Readonly<Record<string, string | undefined>> = {},
): DemoQuotaConfig {
	const result = readDemoQuotaConfig(environment(overrides));
	if (!result) throw new Error("expected enabled config");
	return result;
}

function reserveInput(
	overrides: Partial<DemoQuotaReserveInput> = {},
): DemoQuotaReserveInput {
	return {
		version: 1,
		requestId: REQUEST_A,
		walletScopeId: WALLET_A,
		sessionScopeId: SESSION_A,
		network: "testnet",
		model: MODEL,
		inputBytes: 128,
		...overrides,
	};
}

function miniflareOptions() {
	return convertV4MiniflareOptions({
		compatibilityDate: "2026-10-06",
		d1Databases: { DB: D1_ID },
		inspectorPort: 0,
		logRequests: false,
		modules: true,
		name: `demo-quota-${crypto.randomUUID()}`,
		port: 0,
		script: "export default { fetch() { return new Response('ok'); } }",
		telemetry: { enabled: false },
	});
}

describe("D1 shared demo quota", () => {
	let miniflare: Miniflare;
	let database: D1Database;

	beforeEach(async () => {
		miniflare = new Miniflare(miniflareOptions());
		database = await miniflare.getD1Database("DB");
		await database.exec(MIGRATION);
	});

	afterEach(async () => {
		await miniflare.dispose();
	});

	it("is disabled by default and rejects ambiguous or paid policy configuration", () => {
		expect(readDemoQuotaConfig({})).toBeNull();
		expect(readDemoQuotaConfig({ HARBOR_DEMO_QUOTA_ENABLED: "0" })).toBeNull();
		expect(() => readDemoQuotaConfig(environment({
			HARBOR_DEMO_COST_POLICY: "paid",
		}))).toThrowError(DemoQuotaError);
		expect(() => readDemoQuotaConfig(environment({
			HARBOR_DEMO_ALLOWED_MODELS: "openrouter/not-free",
		}))).toThrowError(DemoQuotaError);
		expect(() => readDemoQuotaConfig(environment({
			HARBOR_DEMO_WALLET_DAILY_REQUESTS: "5",
		}))).toThrowError(/cannot exceed global/);
		expect(() => readDemoQuotaConfig(environment({
			HARBOR_DEMO_MAX_GLOBAL_CONCURRENCY: "2",
		}))).toThrowError(/concurrency to be exactly 1/);
	});

	it("admits one opaque reservation and returns an exact active idempotent retry", async () => {
		const store = new D1DemoQuotaStore(database, config(), {
			now: () => NOW,
			reservationId: () => RESERVATION_A,
		});
		const first = await store.reserve(PRINCIPAL, reserveInput());
		const retry = await store.reserve(PRINCIPAL, reserveInput());

		expect(retry).toEqual(first);
		expect(first).toEqual({
			id: RESERVATION_A,
			timeoutMs: 110_000,
			maxOutputTokens: 25,
			maxSteps: 4,
			remainingGlobalDailyOutputTokens: 300,
			remainingWalletDailyOutputTokens: 100,
			remainingWalletDailyRequests: 1,
			policyVersion: "free-v1",
		});
		const rows = await database.prepare(`
			SELECT principal, request_id, wallet_scope_id, session_scope_id, model
			FROM demo_model_quota_reservations
		`).all();
		expect(rows.results).toEqual([{
			principal: PRINCIPAL,
			request_id: REQUEST_A,
			wallet_scope_id: WALLET_A,
			session_scope_id: SESSION_A,
			model: MODEL,
		}]);
	});

	it("keeps the migration model bound aligned with the exact free-model schema", async () => {
		const longestModel = `${"a".repeat(100)}/${"b".repeat(100)}:free`;
		const store = new D1DemoQuotaStore(database, config({
			HARBOR_DEMO_ALLOWED_MODELS: longestModel,
		}), {
			now: () => NOW,
			reservationId: () => RESERVATION_A,
		});

		await expect(store.reserve(PRINCIPAL, reserveInput({
			model: longestModel,
		}))).resolves.toMatchObject({ id: RESERVATION_A });
	});

	it("uses a real D1 transaction so parallel admissions cannot overspend", async () => {
		const constrained = config({
			HARBOR_DEMO_GLOBAL_DAILY_OUTPUT_TOKENS: "100",
			HARBOR_DEMO_GLOBAL_DAILY_REQUESTS: "1",
			HARBOR_DEMO_WALLET_DAILY_OUTPUT_TOKENS: "100",
			HARBOR_DEMO_WALLET_DAILY_REQUESTS: "1",
			HARBOR_DEMO_RATE_REQUESTS: "1",
		});
		const ids = [
			"11111111-1111-4111-8111-111111111111",
			"22222222-2222-4222-8222-222222222222",
		];
		let index = 0;
		const left = new D1DemoQuotaStore(database, constrained, {
			now: () => NOW,
			reservationId: () => ids[index++]!,
		});
		const right = new D1DemoQuotaStore(database, constrained, {
			now: () => NOW,
			reservationId: () => ids[index++]!,
		});
		const results = await Promise.allSettled([
			left.reserve(PRINCIPAL, reserveInput()),
			right.reserve(PRINCIPAL, reserveInput({
				requestId: "2".repeat(64),
				walletScopeId: WALLET_B,
				sessionScopeId: SESSION_B,
			})),
		]);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejection = results.find((result) => result.status === "rejected");
		expect(rejection).toMatchObject({
			status: "rejected",
			reason: { code: "DEMO_GLOBAL_DAILY_OUTPUT_TOKENS_EXHAUSTED" },
		});
		const count = await database.prepare(
			"SELECT COUNT(*) AS value FROM demo_model_quota_reservations",
		).first<{ value: number }>();
		expect(count?.value).toBe(1);
	});

	it("enforces session rate, wallet-day, and the strict global concurrency boundary", async () => {
		const idSequence = () => {
			let value = 1;
			return () => {
				const hex = value.toString(16).padStart(12, "0");
				value += 1;
				return `aaaaaaaa-aaaa-4aaa-8aaa-${hex}`;
			};
		};

		const rateStore = new D1DemoQuotaStore(database, config({
			HARBOR_DEMO_RATE_REQUESTS: "1",
		}), { now: () => NOW, reservationId: idSequence() });
		const first = await rateStore.reserve(PRINCIPAL, reserveInput());
		await rateStore.settle(PRINCIPAL, {
			version: 1,
			reservationId: first.id,
			outcome: "completed",
		});
		await expect(rateStore.reserve(PRINCIPAL, reserveInput({
			requestId: "2".repeat(64),
		}))).rejects.toMatchObject({ code: "DEMO_RATE_LIMITED", retryAfterSeconds: 60 });

		await database.exec(
			"DELETE FROM demo_model_quota_reservations; DELETE FROM demo_model_zero_cost_integrity;",
		);
		const walletDayStore = new D1DemoQuotaStore(database, config({
			HARBOR_DEMO_WALLET_DAILY_OUTPUT_TOKENS: "100",
			HARBOR_DEMO_WALLET_DAILY_REQUESTS: "1",
			HARBOR_DEMO_RATE_REQUESTS: "1",
		}), { now: () => NOW, reservationId: idSequence() });
		await walletDayStore.reserve(PRINCIPAL, reserveInput());
		await expect(walletDayStore.reserve(PRINCIPAL, reserveInput({
			requestId: "2".repeat(64),
			sessionScopeId: SESSION_B,
		}))).rejects.toMatchObject({ code: "DEMO_WALLET_DAILY_OUTPUT_TOKENS_EXHAUSTED" });

		await database.exec("DELETE FROM demo_model_quota_reservations;");
		const globalBusyStore = new D1DemoQuotaStore(database, config({
			HARBOR_DEMO_MAX_GLOBAL_CONCURRENCY: "1",
			HARBOR_DEMO_MAX_WALLET_CONCURRENCY: "1",
		}), { now: () => NOW, reservationId: idSequence() });
		await globalBusyStore.reserve(PRINCIPAL, reserveInput());
		await expect(globalBusyStore.reserve(PRINCIPAL, reserveInput({
			requestId: "2".repeat(64),
			walletScopeId: WALLET_B,
			sessionScopeId: SESSION_B,
		}))).rejects.toMatchObject({ code: "DEMO_GLOBAL_BUSY" });
	});

	it("isolates principals even when request and scope ids are identical", async () => {
		const pilot = new D1DemoQuotaStore(database, config(), {
			now: () => NOW,
			reservationId: () => RESERVATION_A,
		});
		const otherConfig = Object.freeze({ ...config(), allowedPrincipal: "other-pilot" });
		const other = new D1DemoQuotaStore(database, otherConfig, {
			now: () => NOW,
			reservationId: () => "22222222-2222-4222-8222-222222222222",
		});

		await pilot.reserve(PRINCIPAL, reserveInput());
		await other.reserve("other-pilot", reserveInput());
		await expect(pilot.status("other-pilot")).rejects.toMatchObject({
			code: "DEMO_UNAUTHORIZED",
		});
		const count = await database.prepare(
			"SELECT COUNT(*) AS value FROM demo_model_quota_reservations",
		).first<{ value: number }>();
		expect(count?.value).toBe(2);
	});

	it("rejects request-id reuse with changed input and session rebinding", async () => {
		let next = 0;
		const ids = [
			RESERVATION_A,
			"22222222-2222-4222-8222-222222222222",
			"33333333-3333-4333-8333-333333333333",
		];
		const store = new D1DemoQuotaStore(database, config(), {
			now: () => NOW,
			reservationId: () => ids[next++]!,
		});
		await store.reserve(PRINCIPAL, reserveInput());
		await expect(store.reserve(PRINCIPAL, reserveInput({
			inputBytes: 129,
		}))).rejects.toMatchObject({ code: "DEMO_REQUEST_CONFLICT" });
		const driftedPolicy = new D1DemoQuotaStore(database, config({
			HARBOR_DEMO_GLOBAL_DAILY_OUTPUT_TOKENS: "500",
		}), {
			now: () => NOW,
			reservationId: () => "44444444-4444-4444-8444-444444444444",
		});
		await expect(driftedPolicy.reserve(PRINCIPAL, reserveInput())).rejects.toMatchObject({
			code: "DEMO_REQUEST_CONFLICT",
		});
		await expect(store.reserve(PRINCIPAL, reserveInput({
			requestId: "2".repeat(64),
			walletScopeId: WALLET_B,
		}))).rejects.toMatchObject({ code: "DEMO_MISCONFIGURED" });
	});

	it("persists an integrity trip atomically and blocks retries and later reservations", async () => {
		let next = 0;
		const ids = [
			RESERVATION_A,
			"22222222-2222-4222-8222-222222222222",
			"33333333-3333-4333-8333-333333333333",
		];
		const store = new D1DemoQuotaStore(database, config(), {
			now: () => NOW,
			reservationId: () => ids[next++]!,
		});
		const reservation = await store.reserve(PRINCIPAL, reserveInput());
		await store.settle(PRINCIPAL, {
			version: 1,
			reservationId: reservation.id,
			outcome: "uncertain",
			integrityFailure: "nonzero-cost",
		});

		await expect(store.reserve(PRINCIPAL, reserveInput())).rejects.toMatchObject({
			code: "DEMO_ZERO_COST_INTEGRITY_BLOCKED",
		});
		await expect(store.reserve(PRINCIPAL, reserveInput({
			requestId: "2".repeat(64),
			walletScopeId: WALLET_B,
			sessionScopeId: SESSION_B,
		}))).rejects.toMatchObject({ code: "DEMO_ZERO_COST_INTEGRITY_BLOCKED" });
		await expect(store.status(PRINCIPAL)).rejects.toMatchObject({
			code: "DEMO_ZERO_COST_INTEGRITY_BLOCKED",
		});
	});

	it("treats any unverified settlement as a durable zero-cost block", async () => {
		const store = new D1DemoQuotaStore(database, config(), {
			now: () => NOW,
			reservationId: () => RESERVATION_A,
		});
		const reservation = await store.reserve(PRINCIPAL, reserveInput());
		await store.settle(PRINCIPAL, {
			version: 1,
			reservationId: reservation.id,
			outcome: "uncertain",
		});

		await expect(store.status(PRINCIPAL)).rejects.toMatchObject({
			code: "DEMO_ZERO_COST_INTEGRITY_BLOCKED",
		});
		const trip = await database.prepare(`
			SELECT failure FROM demo_model_zero_cost_integrity WHERE principal = ?
		`).bind(PRINCIPAL).first<{ failure: string }>();
		expect(trip?.failure).toBe("unverified-cost");
	});

	it("turns reported output above the reserved cap into an integrity block", async () => {
		const store = new D1DemoQuotaStore(database, config(), {
			now: () => NOW,
			reservationId: () => RESERVATION_A,
		});
		const reservation = await store.reserve(PRINCIPAL, reserveInput());

		await expect(store.settle(PRINCIPAL, {
			version: 1,
			reservationId: reservation.id,
			outcome: "completed",
			actualOutputTokens: 101,
		})).resolves.toEqual({
			id: reservation.id,
			outcome: "uncertain",
			alreadySettled: false,
		});
		await expect(store.status(PRINCIPAL)).rejects.toMatchObject({
			code: "DEMO_ZERO_COST_INTEGRITY_BLOCKED",
		});
	});

	it("serializes an integrity trip racing a separate real D1 admission", async () => {
		let next = 0;
		const ids = [
			RESERVATION_A,
			"22222222-2222-4222-8222-222222222222",
			"33333333-3333-4333-8333-333333333333",
		];
		const store = new D1DemoQuotaStore(database, config(), {
			now: () => NOW,
			reservationId: () => ids[next++]!,
		});
		const first = await store.reserve(PRINCIPAL, reserveInput());
		const raced = await Promise.allSettled([
			store.settle(PRINCIPAL, {
				version: 1,
				reservationId: first.id,
				outcome: "uncertain",
				integrityFailure: "missing-cost",
			}),
			store.reserve(PRINCIPAL, reserveInput({
				requestId: "2".repeat(64),
				walletScopeId: WALLET_B,
				sessionScopeId: SESSION_B,
			})),
		]);
		expect(raced[0]).toMatchObject({ status: "fulfilled" });
		if (raced[1]?.status === "rejected") {
			expect(raced[1].reason).toMatchObject({
				code: "DEMO_ZERO_COST_INTEGRITY_BLOCKED",
			});
		}
		await expect(store.reserve(PRINCIPAL, reserveInput({
			requestId: "3".repeat(64),
			walletScopeId: WALLET_B,
			sessionScopeId: SESSION_B,
		}))).rejects.toMatchObject({ code: "DEMO_ZERO_COST_INTEGRITY_BLOCKED" });
	});

	it("turns an unverified expiry into a durable zero-cost block", async () => {
		let clock = NOW;
		const store = new D1DemoQuotaStore(database, config(), {
			now: () => clock,
			reservationId: () => RESERVATION_A,
		});
		await store.reserve(PRINCIPAL, reserveInput());
		clock += 120_000;

		await expect(store.status(PRINCIPAL)).rejects.toMatchObject({
			code: "DEMO_ZERO_COST_INTEGRITY_BLOCKED",
		});
		await expect(store.reserve(PRINCIPAL, reserveInput())).rejects.toMatchObject({
			code: "DEMO_ZERO_COST_INTEGRITY_BLOCKED",
		});
		const row = await database.prepare(`
			SELECT status FROM demo_model_quota_reservations WHERE principal = ? AND id = ?
		`).bind(PRINCIPAL, RESERVATION_A).first<{ status: string }>();
		expect(row?.status).toBe("uncertain");
	});

	it("settles idempotently and never revives an expired reservation", async () => {
		let clock = NOW;
		const store = new D1DemoQuotaStore(database, config(), {
			now: () => clock,
			reservationId: () => RESERVATION_A,
		});
		const reservation = await store.reserve(PRINCIPAL, reserveInput());
		const completed = await store.settle(PRINCIPAL, {
			version: 1,
			reservationId: reservation.id,
			outcome: "completed",
			actualInputTokens: 10,
			actualOutputTokens: 20,
		});
		expect(completed).toEqual({
			id: reservation.id,
			outcome: "completed",
			alreadySettled: false,
		});
		expect(await store.settle(PRINCIPAL, {
			version: 1,
			reservationId: reservation.id,
			outcome: "uncertain",
		})).toEqual({ id: reservation.id, outcome: "completed", alreadySettled: true });

		const later = new D1DemoQuotaStore(database, config(), {
			now: () => clock,
			reservationId: () => "22222222-2222-4222-8222-222222222222",
		});
		const active = await later.reserve(PRINCIPAL, reserveInput({
			requestId: "2".repeat(64),
			walletScopeId: WALLET_B,
			sessionScopeId: SESSION_B,
		}));
		clock += 120_000;
		expect(await later.settle(PRINCIPAL, {
			version: 1,
			reservationId: active.id,
			outcome: "completed",
		})).toMatchObject({ outcome: "uncertain", alreadySettled: false });
	});
});
