import { describe, expect, it, vi } from "vitest";

import {
	HOSTED_STATE_MAX_CIPHERTEXT_CHARS,
	HOSTED_STATE_MAX_REQUEST_BYTES,
	HostedStateError,
} from "../src/hosted-state/contracts";
import { handleHostedStateRoute } from "../src/hosted-state/route";

const PREFIX = "/internal/pilot-state/v1";
const PRINCIPAL = "pilot-web";
const SCOPE = "a".repeat(64);
const SESSION = "b".repeat(64);
const NONCE = "c".repeat(64);
const CONTENT = "d".repeat(64);
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const NOW = Date.UTC(2026, 9, 25, 8, 15, 0);

const environment = Object.freeze({
	HARBOR_HOSTED_STATE_ENABLED: "1",
	HARBOR_HOSTED_STATE_PRINCIPAL: PRINCIPAL,
	HARBOR_RESEARCH_QUOTA_POLICY_VERSION: "pilot.backtest.external-read.v1",
	HARBOR_RESEARCH_QUOTA_ACCOUNT_HOURLY_RUNS: "2",
	HARBOR_RESEARCH_QUOTA_SESSION_HOURLY_RUNS: "1",
});

function store(overrides: Record<string, unknown> = {}) {
	return {
		consumeWalletProof: vi.fn(async () => ({ consumed: true })),
		readPersonalization: vi.fn(async () => ({
			ciphertext: "encrypted",
			contentDigest: CONTENT,
		})),
		compareAndSwapPersonalization: vi.fn(async () => ({ swapped: true })),
		deletePersonalization: vi.fn(async () => ({ deleted: true })),
		reserveResearchQuota: vi.fn(async () => ({
			reserved: true as const,
			idempotent: false,
			policyVersion: "pilot.backtest.external-read.v1",
			windowExpiresAtMs: NOW + 45 * 60_000,
			remainingAccountRuns: 1,
			remainingSessionRuns: 0,
		})),
		...overrides,
	};
}

function options(
	fakeStore = store(),
	overrides: Partial<{
		principal: string;
		localDevRequest: boolean;
		environment: Record<string, string | undefined>;
	}> = {},
) {
	return {
		principal: overrides.principal ?? PRINCIPAL,
		localDevRequest: overrides.localDevRequest ?? false,
		database: {} as D1Database,
		environment: overrides.environment ?? environment,
		storeFactory: () => fakeStore,
	};
}

function request(path: string, body: unknown, init: RequestInit = {}): Request {
	return new Request(`https://harbor.example${path}`, {
		method: "POST",
		headers: { "content-type": "application/json; charset=utf-8" },
		body: JSON.stringify(body),
		...init,
	});
}

async function body(response: Response | undefined): Promise<any> {
	expect(response).toBeInstanceOf(Response);
	return response!.json();
}

function expectPrivateHeaders(response: Response | undefined): void {
	expect(response?.headers.get("cache-control")).toBe("no-store");
	expect(response?.headers.get("content-security-policy")).toBe("default-src 'none'");
	expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
	expect(response?.headers.get("access-control-allow-origin")).toBeNull();
	expect(response?.headers.get("location")).toBeNull();
}

function proof(overrides: Record<string, unknown> = {}) {
	return {
		version: 1,
		namespace: "chat",
		scopeId: SCOPE,
		nonceDigest: NONCE,
		expiresAtMs: NOW + 30_000,
		...overrides,
	};
}

describe("private hosted Pilot state route", () => {
	it("ignores unrelated paths without constructing the store", async () => {
		const fakeStore = store();
		const result = await handleHostedStateRoute(
			new Request("https://harbor.example/api/ops/ledger.fee"),
			options(fakeStore),
		);
		expect(result).toBeUndefined();
		expect(fakeStore.consumeWalletProof).not.toHaveBeenCalled();
	});

	it("returns 404 in local development and stays disabled by default", async () => {
		const localStore = store();
		const local = await handleHostedStateRoute(
			request(`${PREFIX}/wallet-proofs/consume`, proof()),
			options(localStore, { localDevRequest: true }),
		);
		expect(local?.status).toBe(404);
		expectPrivateHeaders(local);
		expect(localStore.consumeWalletProof).not.toHaveBeenCalled();

		const disabledStore = store();
		const disabled = await handleHostedStateRoute(
			request(`${PREFIX}/wallet-proofs/consume`, proof()),
			options(disabledStore, { environment: {} }),
		);
		expect(disabled?.status).toBe(503);
		expect(await body(disabled)).toMatchObject({ error: { code: expect.any(String) } });
		expect(disabledStore.consumeWalletProof).not.toHaveBeenCalled();
	});

	it("requires the exact allowlisted authenticated principal", async () => {
		const fakeStore = store();
		const response = await handleHostedStateRoute(
			request(`${PREFIX}/wallet-proofs/consume`, proof()),
			options(fakeStore, { principal: "another-principal" }),
		);
		expect(response?.status).toBe(403);
		expect(fakeStore.consumeWalletProof).not.toHaveBeenCalled();
		expectPrivateHeaders(response);
	});

	it("dispatches all five exact POST operations with direct response shapes", async () => {
		const fakeStore = store();
		const routeOptions = options(fakeStore);
		const proofResponse = await handleHostedStateRoute(
			request(`${PREFIX}/wallet-proofs/consume`, proof()),
			routeOptions,
		);
		expect(await body(proofResponse)).toEqual({ consumed: true });
		expect(fakeStore.consumeWalletProof).toHaveBeenCalledWith(PRINCIPAL, proof());
		const nearProofRequest = proof({ namespace: "near-wallet-auth" });
		const nearProofResponse = await handleHostedStateRoute(
			request(`${PREFIX}/wallet-proofs/consume`, nearProofRequest),
			routeOptions,
		);
		expect(await body(nearProofResponse)).toEqual({ consumed: true });
		expect(fakeStore.consumeWalletProof).toHaveBeenLastCalledWith(
			PRINCIPAL,
			nearProofRequest,
		);

		const readRequest = {
			version: 1,
			scopeId: SCOPE,
			resource: "preferences",
		};
		const readResponse = await handleHostedStateRoute(
			request(`${PREFIX}/personalization/read`, readRequest),
			routeOptions,
		);
		expect(await body(readResponse)).toEqual({
			ciphertext: "encrypted",
			contentDigest: CONTENT,
		});
		expect(fakeStore.readPersonalization).toHaveBeenCalledWith(PRINCIPAL, readRequest);

		const casRequest = {
			...readRequest,
			expectedDigest: null,
			contentDigest: CONTENT,
			ciphertext: "encrypted",
		};
		const casResponse = await handleHostedStateRoute(
			request(`${PREFIX}/personalization/compare-and-swap`, casRequest),
			routeOptions,
		);
		expect(await body(casResponse)).toEqual({ swapped: true });
		expect(fakeStore.compareAndSwapPersonalization).toHaveBeenCalledWith(
			PRINCIPAL,
			casRequest,
		);

		const deleteRequest = {
			...readRequest,
			expectedDigest: CONTENT,
		};
		const deleteResponse = await handleHostedStateRoute(
			request(`${PREFIX}/personalization/delete`, deleteRequest),
			routeOptions,
		);
		expect(await body(deleteResponse)).toEqual({ deleted: true });
		expect(fakeStore.deletePersonalization).toHaveBeenCalledWith(PRINCIPAL, deleteRequest);

		const quotaRequest = {
			version: 1,
			requestId: REQUEST_ID,
			accountScopeId: SCOPE,
			sessionScopeId: SESSION,
			network: "testnet",
			sessionExpiresAtMs: NOW + 30 * 60_000,
			policyVersion: "pilot.backtest.external-read.v1",
			accountMaximum: 2,
			sessionMaximum: 1,
		};
		const quotaResponse = await handleHostedStateRoute(
			request(`${PREFIX}/research/quota/reservations`, quotaRequest),
			routeOptions,
		);
		expect(await body(quotaResponse)).toEqual({
			reserved: true,
			idempotent: false,
			policyVersion: "pilot.backtest.external-read.v1",
			windowExpiresAtMs: NOW + 45 * 60_000,
			remainingAccountRuns: 1,
			remainingSessionRuns: 0,
		});
		expect(fakeStore.reserveResearchQuota).toHaveBeenCalledWith(
			PRINCIPAL,
			quotaRequest,
		);
		for (const response of [proofResponse, nearProofResponse, readResponse, casResponse,
			deleteResponse, quotaResponse]) {
			expect(response?.status).toBe(200);
			expectPrivateHeaders(response);
		}
	});

	it("rejects queries, wrong methods/media types, malformed JSON, and extra fields", async () => {
		const fakeStore = store();
		const routeOptions = options(fakeStore);
		const query = await handleHostedStateRoute(
			request(`${PREFIX}/wallet-proofs/consume?debug=1`, proof()),
			routeOptions,
		);
		expect(query?.status).toBe(400);

		const get = await handleHostedStateRoute(
			new Request(`https://harbor.example${PREFIX}/wallet-proofs/consume`),
			routeOptions,
		);
		expect(get?.status).toBe(405);

		const text = await handleHostedStateRoute(
			request(`${PREFIX}/wallet-proofs/consume`, proof(), {
				headers: { "content-type": "text/plain" },
			}),
			routeOptions,
		);
		expect(text?.status).toBe(415);

		const malformed = await handleHostedStateRoute(
			new Request(`https://harbor.example${PREFIX}/wallet-proofs/consume`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{",
			}),
			routeOptions,
		);
		expect(malformed?.status).toBe(400);

		const extra = await handleHostedStateRoute(
			request(`${PREFIX}/wallet-proofs/consume`, proof({ secret: "must-not-forward" })),
			routeOptions,
		);
		expect(extra?.status).toBe(400);
		const invalidDelete = await handleHostedStateRoute(
			request(`${PREFIX}/personalization/delete`, {
				version: 1, scopeId: SCOPE, resource: "preferences",
				expectedDigest: CONTENT, extra: true,
			}),
			routeOptions,
		);
		expect(invalidDelete?.status).toBe(400);
		expect(fakeStore.consumeWalletProof).not.toHaveBeenCalled();
		expect(fakeStore.deletePersonalization).not.toHaveBeenCalled();
	});

	it("enforces both declared and streamed body bounds", async () => {
		const routeOptions = options();
		const declared = await handleHostedStateRoute(
			new Request(`https://harbor.example${PREFIX}/personalization/compare-and-swap`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"content-length": String(HOSTED_STATE_MAX_REQUEST_BYTES + 1),
				},
				body: "{}",
			}),
			routeOptions,
		);
		expect(declared?.status).toBe(413);

		const streamed = await handleHostedStateRoute(
			new Request(`https://harbor.example${PREFIX}/personalization/compare-and-swap`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(HOSTED_STATE_MAX_REQUEST_BYTES + 1));
						controller.close();
					},
				}),
				duplex: "half",
			} as RequestInit),
			routeOptions,
		);
		expect(streamed?.status).toBe(413);
	});

	it("accepts the maximum encrypted 1 MiB plaintext envelope and rejects one extra character", async () => {
		const fakeStore = store();
		const routeOptions = options(fakeStore);
		const base = {
			version: 1,
			scopeId: SCOPE,
			resource: "preferences",
			expectedDigest: null,
			contentDigest: CONTENT,
		};
		const maximum = await handleHostedStateRoute(
			request(`${PREFIX}/personalization/compare-and-swap`, {
				...base,
				ciphertext: "x".repeat(HOSTED_STATE_MAX_CIPHERTEXT_CHARS),
			}),
			routeOptions,
		);
		expect(maximum?.status).toBe(200);
		expect(fakeStore.compareAndSwapPersonalization).toHaveBeenCalledTimes(1);

		const oversized = await handleHostedStateRoute(
			request(`${PREFIX}/personalization/compare-and-swap`, {
				...base,
				ciphertext: "x".repeat(HOSTED_STATE_MAX_CIPHERTEXT_CHARS + 1),
			}),
			routeOptions,
		);
		expect(oversized?.status).toBe(400);
		expect(fakeStore.compareAndSwapPersonalization).toHaveBeenCalledTimes(1);
	});

	it("maps known store errors exactly and hides unexpected storage details", async () => {
		const knownStore = store({
			consumeWalletProof: vi.fn(async () => {
				throw new HostedStateError(
					"HOSTED_STATE_UNAVAILABLE",
					503,
					"Harbor clock is unavailable",
					2,
				);
			}),
		});
		const known = await handleHostedStateRoute(
			request(`${PREFIX}/wallet-proofs/consume`, proof()),
			options(knownStore),
		);
		expect(known?.status).toBe(503);
		expect(known?.headers.get("retry-after")).toBe("2");
		expect(await body(known)).toEqual({
			error: {
				code: "HOSTED_STATE_UNAVAILABLE",
				message: "Harbor clock is unavailable",
				retryAfterSeconds: 2,
			},
		});

		const unexpectedStore = store({
			consumeWalletProof: vi.fn(async () => {
				throw new Error("SECRET database internals");
			}),
		});
		const unexpected = await handleHostedStateRoute(
			request(`${PREFIX}/wallet-proofs/consume`, proof()),
			options(unexpectedStore),
		);
		expect(unexpected?.status).toBe(503);
		expect(JSON.stringify(await body(unexpected))).not.toContain("SECRET");
	});
});
