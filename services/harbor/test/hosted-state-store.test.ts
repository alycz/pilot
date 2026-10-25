import { readFileSync } from "node:fs";

import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	HOSTED_STATE_MAX_CIPHERTEXT_CHARS,
	HOSTED_STATE_MAX_PERSONALIZATION_ROWS,
	HOSTED_STATE_MAX_SESSION_BINDINGS,
	HOSTED_STATE_PROOF_MAX_FUTURE_MS,
	HostedStateError,
	readHostedStateConfig,
} from "../src/hosted-state/contracts";
import { D1HostedStateStore } from "../src/hosted-state/store";

const D1_ID = "77777777-7777-4777-8777-777777777777";
const PRINCIPAL = "pilot-web";
const ACCOUNT = "a".repeat(64);
const ACCOUNT_B = "b".repeat(64);
const SESSION = "c".repeat(64);
const SESSION_B = "d".repeat(64);
const NONCE = "e".repeat(64);
const CONTENT_A = "1".repeat(64);
const CONTENT_B = "2".repeat(64);
const REQUEST_A = "123e4567-e89b-42d3-a456-426614174000";
const REQUEST_B = "223e4567-e89b-42d3-a456-426614174000";
const NOW = Date.UTC(2026, 9, 25, 8, 15, 0);
const MIGRATION = readFileSync(
	new URL("../migrations/0017_hosted_pilot_state.sql", import.meta.url),
	"utf8",
).replaceAll(/--[^\n]*(?:\n|$)/gu, " ").replaceAll(/\s*\n\s*/gu, " ");

function environment(
	overrides: Readonly<Record<string, string | undefined>> = {},
): Readonly<Record<string, string | undefined>> {
	return {
		HARBOR_HOSTED_STATE_ENABLED: "1",
		HARBOR_HOSTED_STATE_PRINCIPAL: PRINCIPAL,
		HARBOR_RESEARCH_QUOTA_POLICY_VERSION: "pilot.backtest.external-read.v1",
		HARBOR_RESEARCH_QUOTA_ACCOUNT_HOURLY_RUNS: "2",
		HARBOR_RESEARCH_QUOTA_SESSION_HOURLY_RUNS: "1",
		...overrides,
	};
}

function config(
	overrides: Readonly<Record<string, string | undefined>> = {},
) {
	const value = readHostedStateConfig(environment(overrides));
	if (!value) throw new Error("expected hosted state to be enabled");
	return value;
}

function miniflareOptions() {
	return convertV4MiniflareOptions({
		compatibilityDate: "2026-10-06",
		d1Databases: { DB: D1_ID },
		inspectorPort: 0,
		logRequests: false,
		modules: true,
		name: `hosted-state-${crypto.randomUUID()}`,
		port: 0,
		script: "export default { fetch() { return new Response('ok'); } }",
		telemetry: { enabled: false },
	});
}

function proofInput(overrides: Record<string, unknown> = {}) {
	return {
		version: 1 as const,
		namespace: "chat" as const,
		scopeId: ACCOUNT,
		nonceDigest: NONCE,
		expiresAtMs: NOW + 30_000,
		...overrides,
	};
}

function quotaInput(overrides: Record<string, unknown> = {}) {
	return {
		version: 1 as const,
		requestId: REQUEST_A,
		accountScopeId: ACCOUNT,
		sessionScopeId: SESSION,
		network: "testnet" as const,
		sessionExpiresAtMs: NOW + 30 * 60_000,
		policyVersion: "pilot.backtest.external-read.v1",
		accountMaximum: 2,
		sessionMaximum: 1,
		...overrides,
	};
}

describe("D1 hosted Pilot state", () => {
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

	it("is default-off and rejects ambiguous policy configuration", () => {
		expect(readHostedStateConfig({})).toBeNull();
		expect(readHostedStateConfig({ HARBOR_HOSTED_STATE_ENABLED: "0" })).toBeNull();
		expect(() => readHostedStateConfig(environment({
			HARBOR_HOSTED_STATE_ENABLED: "yes",
		}))).toThrowError(HostedStateError);
		expect(() => readHostedStateConfig(environment({
			HARBOR_RESEARCH_QUOTA_SESSION_HOURLY_RUNS: "3",
		}))).toThrowError(/cannot exceed/i);
	});

	it("consumes one wallet proof exactly once across concurrent store instances", async () => {
		const left = new D1HostedStateStore(database, config(), { now: () => NOW });
		const right = new D1HostedStateStore(database, config(), { now: () => NOW });
		const results = await Promise.all([
			left.consumeWalletProof(PRINCIPAL, proofInput()),
			right.consumeWalletProof(PRINCIPAL, proofInput()),
		]);

		expect(results.map((result) => result.consumed).sort()).toEqual([false, true]);
		await expect(new D1HostedStateStore(database, config(), { now: () => NOW })
			.consumeWalletProof(PRINCIPAL, proofInput()))
			.resolves.toEqual({ consumed: false });
		const rows = await database.prepare(`
			SELECT principal, namespace, scope_id, nonce_digest
			FROM pilot_wallet_proof_consumptions
		`).all();
		expect(rows.results).toEqual([{
			principal: PRINCIPAL,
			namespace: "chat",
			scope_id: ACCOUNT,
			nonce_digest: NONCE,
		}]);
	});

	it("rejects stale/far-future proofs and fences a backwards Harbor clock", async () => {
		let now = NOW;
		const store = new D1HostedStateStore(database, config(), { now: () => now });
		await expect(store.consumeWalletProof(PRINCIPAL, proofInput({
			expiresAtMs: NOW,
		}))).rejects.toMatchObject({ status: 409 });
		await expect(store.consumeWalletProof(PRINCIPAL, proofInput({
			nonceDigest: "f".repeat(64),
			expiresAtMs: NOW + HOSTED_STATE_PROOF_MAX_FUTURE_MS + 1,
		}))).rejects.toMatchObject({ status: 409 });

		await expect(store.consumeWalletProof(PRINCIPAL, proofInput({
			nonceDigest: "0".repeat(64),
			expiresAtMs: NOW + HOSTED_STATE_PROOF_MAX_FUTURE_MS,
		}))).resolves.toEqual({ consumed: true });
		now -= 1;
		await expect(store.consumeWalletProof(PRINCIPAL, proofInput({
			nonceDigest: "1".repeat(64),
		}))).rejects.toMatchObject({ status: 503 });
	});

	it("performs encrypted personalization compare-and-swap atomically", async () => {
		const left = new D1HostedStateStore(database, config(), { now: () => NOW });
		const right = new D1HostedStateStore(database, config(), { now: () => NOW });
		await expect(left.readPersonalization(PRINCIPAL, {
			version: 1,
			scopeId: ACCOUNT,
			resource: "preferences",
		})).resolves.toEqual({ ciphertext: null, contentDigest: null });

		const attempts = await Promise.all([
			left.compareAndSwapPersonalization(PRINCIPAL, {
				version: 1,
				scopeId: ACCOUNT,
				resource: "preferences",
				expectedDigest: null,
				contentDigest: CONTENT_A,
				ciphertext: "encrypted-a",
			}),
			right.compareAndSwapPersonalization(PRINCIPAL, {
				version: 1,
				scopeId: ACCOUNT,
				resource: "preferences",
				expectedDigest: null,
				contentDigest: CONTENT_B,
				ciphertext: "encrypted-b",
			}),
		]);
		expect(attempts.map((result) => result.swapped).sort()).toEqual([false, true]);

		const selected = await left.readPersonalization(PRINCIPAL, {
			version: 1,
			scopeId: ACCOUNT,
			resource: "preferences",
		});
		expect([
			{ ciphertext: "encrypted-a", contentDigest: CONTENT_A },
			{ ciphertext: "encrypted-b", contentDigest: CONTENT_B },
		]).toContainEqual(selected);
	});

	it("physically deletes personalization only with the exact current digest", async () => {
		const store = new D1HostedStateStore(database, config(), { now: () => NOW });
		await store.compareAndSwapPersonalization(PRINCIPAL, {
			version: 1, scopeId: ACCOUNT, resource: "preferences",
			expectedDigest: null, contentDigest: CONTENT_A, ciphertext: "encrypted",
		});
		await expect(store.deletePersonalization(PRINCIPAL, {
			version: 1, scopeId: ACCOUNT, resource: "preferences", expectedDigest: CONTENT_B,
		})).resolves.toEqual({ deleted: false });
		await expect(store.readPersonalization(PRINCIPAL, {
			version: 1, scopeId: ACCOUNT, resource: "preferences",
		})).resolves.toEqual({ ciphertext: "encrypted", contentDigest: CONTENT_A });
		await expect(store.deletePersonalization(PRINCIPAL, {
			version: 1, scopeId: ACCOUNT, resource: "preferences", expectedDigest: CONTENT_A,
		})).resolves.toEqual({ deleted: true });
		await expect(store.readPersonalization(PRINCIPAL, {
			version: 1, scopeId: ACCOUNT, resource: "preferences",
		})).resolves.toEqual({ ciphertext: null, contentDigest: null });
		const rows = await database.prepare(
			"SELECT COUNT(*) AS value FROM pilot_personalization_state WHERE principal = ?",
		).bind(PRINCIPAL).first<{ value: number }>();
		expect(rows?.value).toBe(0);
	});

	it("persists the exact encrypted-envelope maximum and rejects one extra character", async () => {
		const store = new D1HostedStateStore(database, config(), { now: () => NOW });
		await expect(store.compareAndSwapPersonalization(PRINCIPAL, {
			version: 1,
			scopeId: ACCOUNT,
			resource: "preferences",
			expectedDigest: null,
			contentDigest: CONTENT_A,
			ciphertext: "x".repeat(HOSTED_STATE_MAX_CIPHERTEXT_CHARS),
		})).resolves.toEqual({ swapped: true });
		await expect(store.compareAndSwapPersonalization(PRINCIPAL, {
			version: 1,
			scopeId: ACCOUNT,
			resource: "preferences",
			expectedDigest: CONTENT_A,
			contentDigest: CONTENT_B,
			ciphertext: "x".repeat(HOSTED_STATE_MAX_CIPHERTEXT_CHARS + 1),
		})).rejects.toMatchObject({ status: 503 });
	});

	it("admits only one concurrent personalization insert at capacity while preserving updates", async () => {
		await database.prepare(`
			WITH RECURSIVE sequence(value) AS (
				SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < ?
			)
			INSERT INTO pilot_personalization_state
				(principal, scope_id, resource, content_digest, ciphertext, updated_at_ms)
			SELECT ?, printf('%064x', value), 'preferences', printf('%064x', value + 10000), 'sealed', ?
			FROM sequence
		`).bind(HOSTED_STATE_MAX_PERSONALIZATION_ROWS - 1, PRINCIPAL, NOW).run();
		const left = new D1HostedStateStore(database, config(), { now: () => NOW });
		const right = new D1HostedStateStore(database, config(), { now: () => NOW });
		const results = await Promise.allSettled([
			left.compareAndSwapPersonalization(PRINCIPAL, {
				version: 1, scopeId: ACCOUNT, resource: "preferences",
				expectedDigest: null, contentDigest: CONTENT_A, ciphertext: "left",
			}),
			right.compareAndSwapPersonalization(PRINCIPAL, {
				version: 1, scopeId: ACCOUNT_B, resource: "preferences",
				expectedDigest: null, contentDigest: CONTENT_B, ciphertext: "right",
			}),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.find((result) => result.status === "rejected")).toMatchObject({
			status: "rejected", reason: { status: 503 },
		});
		const winner = await database.prepare(`
			SELECT scope_id, content_digest FROM pilot_personalization_state
			WHERE principal = ? AND scope_id IN (?, ?)
		`).bind(PRINCIPAL, ACCOUNT, ACCOUNT_B)
			.first<{ scope_id: string; content_digest: string }>();
		expect(winner).toBeTruthy();
		await expect(left.compareAndSwapPersonalization(PRINCIPAL, {
			version: 1, scopeId: winner!.scope_id, resource: "preferences",
			expectedDigest: null, contentDigest: CONTENT_A, ciphertext: "conflict",
		})).resolves.toEqual({ swapped: false });
		await expect(left.compareAndSwapPersonalization(PRINCIPAL, {
			version: 1, scopeId: winner!.scope_id, resource: "preferences",
			expectedDigest: winner!.content_digest, contentDigest: NONCE, ciphertext: "updated",
		})).resolves.toEqual({ swapped: true });
	});

	it("makes research reservations idempotent while enforcing account/session limits", async () => {
		const left = new D1HostedStateStore(database, config(), { now: () => NOW });
		const first = await left.reserveResearchQuota(PRINCIPAL, quotaInput());
		expect(first).toMatchObject({
			reserved: true,
			idempotent: false,
			policyVersion: "pilot.backtest.external-read.v1",
			remainingAccountRuns: 1,
			remainingSessionRuns: 0,
		});
		await expect(left.reserveResearchQuota(PRINCIPAL, quotaInput())).resolves.toEqual({
			...first,
			idempotent: true,
		});
		await expect(left.reserveResearchQuota(PRINCIPAL, quotaInput({
			network: "devnet",
		}))).rejects.toMatchObject({ status: 409 });
		const contenders = await Promise.allSettled([
			new D1HostedStateStore(database, config(), { now: () => NOW })
				.reserveResearchQuota(PRINCIPAL, quotaInput({
					requestId: REQUEST_B,
					accountScopeId: ACCOUNT_B,
					sessionScopeId: SESSION_B,
				})),
			new D1HostedStateStore(database, config(), { now: () => NOW })
				.reserveResearchQuota(PRINCIPAL, quotaInput({
					requestId: "323e4567-e89b-42d3-a456-426614174000",
					accountScopeId: ACCOUNT_B,
					sessionScopeId: SESSION_B,
				})),
		]);
		expect(contenders.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(contenders.find((result) => result.status === "rejected")).toMatchObject({
			status: "rejected",
			reason: { status: 429 },
		});
	});

	it("rejects session rebinding and policy drift without consuming quota", async () => {
		const store = new D1HostedStateStore(database, config(), { now: () => NOW });
		await store.reserveResearchQuota(PRINCIPAL, quotaInput());
		await expect(store.reserveResearchQuota(PRINCIPAL, quotaInput({
			sessionScopeId: SESSION_B,
			accountScopeId: ACCOUNT_B,
		}))).rejects.toMatchObject({ status: 409 });
		await expect(store.reserveResearchQuota(PRINCIPAL, quotaInput({
			requestId: REQUEST_B,
			accountScopeId: ACCOUNT_B,
		}))).rejects.toMatchObject({ status: 409 });
		await expect(new D1HostedStateStore(database, config({
			HARBOR_RESEARCH_QUOTA_ACCOUNT_HOURLY_RUNS: "3",
		}), { now: () => NOW }).reserveResearchQuota(PRINCIPAL, quotaInput({
			requestId: REQUEST_B,
			accountMaximum: 3,
		}))).rejects.toMatchObject({ status: 503 });

		const count = await database.prepare(
			"SELECT COUNT(*) AS value FROM pilot_research_quota_reservations",
		).first<{ value: number }>();
		expect(count?.value).toBe(1);
		const bindingCount = await database.prepare(
			"SELECT COUNT(*) AS value FROM pilot_research_quota_session_bindings",
		).first<{ value: number }>();
		expect(bindingCount?.value).toBe(1);
	});

	it("does not create a session binding when account quota is exhausted", async () => {
		const constrained = config({
			HARBOR_RESEARCH_QUOTA_ACCOUNT_HOURLY_RUNS: "1",
			HARBOR_RESEARCH_QUOTA_SESSION_HOURLY_RUNS: "1",
		});
		const store = new D1HostedStateStore(database, constrained, { now: () => NOW });
		await store.reserveResearchQuota(PRINCIPAL, quotaInput({ accountMaximum: 1 }));
		await expect(store.reserveResearchQuota(PRINCIPAL, quotaInput({
			requestId: REQUEST_B,
			sessionScopeId: SESSION_B,
			accountMaximum: 1,
		}))).rejects.toMatchObject({ status: 429 });
		const counts = await database.prepare(`
			SELECT
				(SELECT COUNT(*) FROM pilot_research_quota_session_bindings WHERE principal = ?) AS bindings,
				(SELECT COUNT(*) FROM pilot_research_quota_reservations WHERE principal = ?) AS reservations
		`).bind(PRINCIPAL, PRINCIPAL).first<{ bindings: number; reservations: number }>();
		expect(counts).toEqual({ bindings: 1, reservations: 1 });
	});

	it("caps concurrent session bindings without leaking a rejected reservation", async () => {
		await database.prepare(`
			WITH RECURSIVE sequence(value) AS (
				SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < ?
			)
			INSERT INTO pilot_research_quota_session_bindings
				(principal, session_scope_id, account_scope_id, network, session_expires_at_ms)
			SELECT ?, printf('%064x', value), printf('%064x', value + 10000), 'testnet', ?
			FROM sequence
		`).bind(HOSTED_STATE_MAX_SESSION_BINDINGS - 1, PRINCIPAL, NOW + 30 * 60_000).run();
		const results = await Promise.allSettled([
			new D1HostedStateStore(database, config(), { now: () => NOW })
				.reserveResearchQuota(PRINCIPAL, quotaInput()),
			new D1HostedStateStore(database, config(), { now: () => NOW })
				.reserveResearchQuota(PRINCIPAL, quotaInput({
					requestId: REQUEST_B, accountScopeId: ACCOUNT_B, sessionScopeId: SESSION_B,
				})),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.find((result) => result.status === "rejected")).toMatchObject({
			status: "rejected", reason: { status: 503 },
		});
		const counts = await database.prepare(`
			SELECT
				(SELECT COUNT(*) FROM pilot_research_quota_session_bindings WHERE principal = ?) AS bindings,
				(SELECT COUNT(*) FROM pilot_research_quota_reservations WHERE principal = ?) AS reservations
		`).bind(PRINCIPAL, PRINCIPAL).first<{ bindings: number; reservations: number }>();
		expect(counts).toEqual({ bindings: HOSTED_STATE_MAX_SESSION_BINDINGS, reservations: 1 });
	});

	it("releases an expired session binding only after retained reservations expire", async () => {
		let now = NOW;
		const store = new D1HostedStateStore(database, config(), { now: () => now });
		await store.reserveResearchQuota(PRINCIPAL, quotaInput());

		now = Math.floor(NOW / 3_600_000) * 3_600_000 + 3 * 3_600_000 + 1;
		await expect(store.reserveResearchQuota(PRINCIPAL, quotaInput({
			requestId: REQUEST_B,
			accountScopeId: ACCOUNT_B,
			sessionExpiresAtMs: now + 30 * 60_000,
		}))).resolves.toMatchObject({
			reserved: true,
			idempotent: false,
		});
	});
});
