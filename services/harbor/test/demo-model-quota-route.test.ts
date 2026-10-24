import { describe, expect, it, vi } from "vitest";

import { DemoQuotaError } from "../src/demo-model-quota";
import {
	DEMO_QUOTA_MAX_REQUEST_BYTES,
	handleDemoModelQuotaRoute,
} from "../src/demo-model-quota-route";

const PRINCIPAL = "pilot-demo";
const REQUEST_ID = "a".repeat(64);
const WALLET_SCOPE = "b".repeat(64);
const SESSION_SCOPE = "c".repeat(64);
const RESERVATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const MODEL = "openai/gpt-oss-20b:free";

const environment = Object.freeze({
	HARBOR_DEMO_QUOTA_ENABLED: "1",
	HARBOR_DEMO_QUOTA_PRINCIPAL: PRINCIPAL,
	HARBOR_DEMO_COST_POLICY: "free-only",
	HARBOR_DEMO_POLICY_VERSION: "demo-v1",
	HARBOR_DEMO_ALLOWED_MODELS: MODEL,
	HARBOR_DEMO_GLOBAL_DAILY_OUTPUT_TOKENS: "10000",
	HARBOR_DEMO_GLOBAL_DAILY_REQUESTS: "100",
	HARBOR_DEMO_WALLET_DAILY_OUTPUT_TOKENS: "2000",
	HARBOR_DEMO_WALLET_DAILY_REQUESTS: "10",
	HARBOR_DEMO_RATE_WINDOW_SECONDS: "60",
	HARBOR_DEMO_RATE_REQUESTS: "3",
	HARBOR_DEMO_MAX_GLOBAL_CONCURRENCY: "1",
	HARBOR_DEMO_MAX_WALLET_CONCURRENCY: "1",
	HARBOR_DEMO_RESERVATION_TTL_SECONDS: "120",
	HARBOR_DEMO_ABORT_GRACE_SECONDS: "10",
	HARBOR_DEMO_MAX_INPUT_BYTES: "4096",
	HARBOR_DEMO_MAX_OUTPUT_TOKENS: "500",
	HARBOR_DEMO_MAX_STEPS: "2",
});

const reservation = Object.freeze({
	id: RESERVATION_ID,
	timeoutMs: 110_000,
	maxOutputTokens: 250,
	maxSteps: 2,
	remainingGlobalDailyOutputTokens: 9_500,
	remainingWalletDailyOutputTokens: 1_500,
	remainingWalletDailyRequests: 9,
	policyVersion: "demo-v1",
});

const settlement = Object.freeze({
	id: RESERVATION_ID,
	outcome: "completed" as const,
	alreadySettled: false,
});

const status = Object.freeze({
	available: true as const,
	policyVersion: "demo-v1",
	costPolicy: "free-only" as const,
	allowedModels: [MODEL],
	globalDailyOutputTokens: 10_000,
	globalDailyRequests: 100,
	walletDailyOutputTokens: 2_000,
	walletDailyRequests: 10,
	rateWindowSeconds: 60,
	rateRequests: 3,
	maxGlobalConcurrency: 1,
	maxWalletConcurrency: 1,
	reservationTtlSeconds: 120,
	abortGraceSeconds: 10,
	maxInputBytes: 4_096,
	maxOutputTokens: 500,
	maxSteps: 2,
});

function store(overrides: Partial<{
	reserve: ReturnType<typeof vi.fn>;
	settle: ReturnType<typeof vi.fn>;
	status: ReturnType<typeof vi.fn>;
}> = {}) {
	return {
		reserve: vi.fn(async () => reservation),
		settle: vi.fn(async () => settlement),
		status: vi.fn(async () => status),
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

function reserveBody(overrides: Record<string, unknown> = {}) {
	return {
		version: 1,
		requestId: REQUEST_ID,
		walletScopeId: WALLET_SCOPE,
		sessionScopeId: SESSION_SCOPE,
		network: "testnet",
		model: MODEL,
		inputBytes: 128,
		...overrides,
	};
}

function jsonRequest(path: string, body: unknown, init: RequestInit = {}): Request {
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
	expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
	expect(response?.headers.get("access-control-allow-origin")).toBeNull();
}

describe("private demo-model quota route", () => {
	it("ignores unrelated routes without constructing a quota store", async () => {
		const fakeStore = store();
		const result = await handleDemoModelQuotaRoute(
			new Request("https://harbor.example/api/ops/ledger.fee"),
			options(fakeStore),
		);

		expect(result).toBeUndefined();
		expect(fakeStore.status).not.toHaveBeenCalled();
	});

	it("keeps the private capability unavailable to every local-dev bypass", async () => {
		const fakeStore = store();
		const response = await handleDemoModelQuotaRoute(
			new Request("http://127.0.0.1:8791/internal/demo-model/v1/status"),
			options(fakeStore, { localDevRequest: true }),
		);

		expect(response?.status).toBe(404);
		expect(await body(response)).toEqual({
			ok: false,
			error: {
				code: "DEMO_ROUTE_UNAVAILABLE",
				message: "The demo quota route is unavailable",
			},
		});
		expect(fakeStore.status).not.toHaveBeenCalled();
		expectPrivateHeaders(response);
	});

	it("is disabled by default and rejects every non-allowlisted principal", async () => {
		const disabledStore = store();
		const disabled = await handleDemoModelQuotaRoute(
			new Request("https://harbor.example/internal/demo-model/v1/status"),
			options(disabledStore, { environment: {} }),
		);
		expect(disabled?.status).toBe(503);
		expect(await body(disabled)).toMatchObject({
			error: { code: "DEMO_DISABLED" },
		});
		expect(disabledStore.status).not.toHaveBeenCalled();

		const otherStore = store();
		const forbidden = await handleDemoModelQuotaRoute(
			new Request("https://harbor.example/internal/demo-model/v1/status"),
			options(otherStore, { principal: "another-principal" }),
		);
		expect(forbidden?.status).toBe(403);
		expect(await body(forbidden)).toMatchObject({
			error: { code: "DEMO_UNAUTHORIZED" },
		});
		expect(otherStore.status).not.toHaveBeenCalled();
	});

	it("returns only the bounded public policy status with private headers", async () => {
		const fakeStore = store();
		const response = await handleDemoModelQuotaRoute(
			new Request("https://harbor.example/internal/demo-model/v1/status"),
			options(fakeStore),
		);

		expect(response?.status).toBe(200);
		expect(await body(response)).toEqual({ ok: true, status });
		expect(fakeStore.status).toHaveBeenCalledWith(PRINCIPAL);
		expectPrivateHeaders(response);
	});

	it("reserves with an exact strict request and never forwards HTTP metadata", async () => {
		const fakeStore = store();
		const request = jsonRequest(
			"/internal/demo-model/v1/reservations",
			reserveBody(),
			{ headers: {
				"content-type": "application/json; charset=utf-8",
				"x-secret-sentinel": "must-not-forward",
			} },
		);
		const response = await handleDemoModelQuotaRoute(request, options(fakeStore));

		expect(response?.status).toBe(200);
		expect(await body(response)).toEqual({ ok: true, reservation });
		expect(fakeStore.reserve).toHaveBeenCalledWith(PRINCIPAL, reserveBody());
		expect(JSON.stringify(fakeStore.reserve.mock.calls)).not.toContain("must-not-forward");
		expectPrivateHeaders(response);
	});

	it("settles the path-bound reservation id and enforces integrity uncertainty", async () => {
		const fakeStore = store();
		const response = await handleDemoModelQuotaRoute(
			jsonRequest(
				`/internal/demo-model/v1/reservations/${RESERVATION_ID}/settle`,
				{
					version: 1,
					outcome: "uncertain",
					actualInputTokens: 12,
					actualOutputTokens: 34,
					integrityFailure: "nonzero-cost",
				},
			),
			options(fakeStore),
		);

		expect(response?.status).toBe(200);
		expect(fakeStore.settle).toHaveBeenCalledWith(PRINCIPAL, {
			version: 1,
			reservationId: RESERVATION_ID,
			outcome: "uncertain",
			actualInputTokens: 12,
			actualOutputTokens: 34,
			integrityFailure: "nonzero-cost",
		});

		const rejected = await handleDemoModelQuotaRoute(
			jsonRequest(
				`/internal/demo-model/v1/reservations/${RESERVATION_ID}/settle`,
				{ version: 1, outcome: "completed", integrityFailure: "missing-cost" },
			),
			options(fakeStore),
		);
		expect(rejected?.status).toBe(400);
		expect(await body(rejected)).toMatchObject({
			error: { code: "DEMO_INVALID_REQUEST" },
		});
	});

	it.each([
		["query string", "/internal/demo-model/v1/status?debug=1", "GET", undefined, 400],
		["wrong status method", "/internal/demo-model/v1/status", "POST", {}, 405],
		["wrong reserve method", "/internal/demo-model/v1/reservations", "GET", undefined, 405],
	] as const)("rejects %s before reaching storage", async (_name, path, method, requestBody, expected) => {
		const fakeStore = store();
		const response = await handleDemoModelQuotaRoute(
			new Request(`https://harbor.example${path}`, {
				method,
				...(requestBody === undefined
					? {}
					: {
						headers: { "content-type": "application/json" },
						body: JSON.stringify(requestBody),
					}),
			}),
			options(fakeStore),
		);
		expect(response?.status).toBe(expected);
		expect(fakeStore.reserve).not.toHaveBeenCalled();
		expect(fakeStore.settle).not.toHaveBeenCalled();
		expect(fakeStore.status).not.toHaveBeenCalled();
	});

	it.each([
		["missing content type", {}, reserveBody(), 415],
		["non-JSON content type", { "content-type": "text/plain" }, reserveBody(), 415],
		["malformed JSON", { "content-type": "application/json" }, "{", 400],
	] as const)("rejects %s without storage access", async (_name, headers, value, expected) => {
		const fakeStore = store();
		const request = new Request(
			"https://harbor.example/internal/demo-model/v1/reservations",
			{
				method: "POST",
				headers,
				body: typeof value === "string" ? value : JSON.stringify(value),
			},
		);
		const response = await handleDemoModelQuotaRoute(request, options(fakeStore));
		expect(response?.status).toBe(expected);
		expect(fakeStore.reserve).not.toHaveBeenCalled();
	});

	it.each([
		["unknown field", reserveBody({ extra: true })],
		["paid model", reserveBody({ model: "openai/gpt-4.1" })],
		["uppercase request id", reserveBody({ requestId: REQUEST_ID.toUpperCase() })],
		["raw wallet account", reserveBody({ walletScopeId: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh" })],
		["unsafe byte count", reserveBody({ inputBytes: Number.MAX_SAFE_INTEGER + 1 })],
	] as const)("rejects a strict reservation with %s", async (_name, requestBody) => {
		const fakeStore = store();
		const response = await handleDemoModelQuotaRoute(
			jsonRequest("/internal/demo-model/v1/reservations", requestBody),
			options(fakeStore),
		);
		expect(response?.status).toBe(400);
		expect(fakeStore.reserve).not.toHaveBeenCalled();
	});

	it("bounds declared and streamed request bodies", async () => {
		const fakeStore = store();
		const declared = await handleDemoModelQuotaRoute(
			new Request("https://harbor.example/internal/demo-model/v1/reservations", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"content-length": String(DEMO_QUOTA_MAX_REQUEST_BYTES + 1),
				},
				body: "{}",
			}),
			options(fakeStore),
		);
		expect(declared?.status).toBe(413);

		const streamed = await handleDemoModelQuotaRoute(
			new Request("https://harbor.example/internal/demo-model/v1/reservations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: `"${"x".repeat(DEMO_QUOTA_MAX_REQUEST_BYTES)}"`,
			}),
			options(fakeStore),
		);
		expect(streamed?.status).toBe(413);
		expect(fakeStore.reserve).not.toHaveBeenCalled();
	});

	it("maps stable store errors and never leaks unexpected values", async () => {
		const limitedStore = store({
			reserve: vi.fn(async () => {
				throw new DemoQuotaError(
					"DEMO_RATE_LIMITED",
					429,
					"The demo model rate limit was reached",
					17,
				);
			}),
		});
		const limited = await handleDemoModelQuotaRoute(
			jsonRequest("/internal/demo-model/v1/reservations", reserveBody()),
			options(limitedStore),
		);
		expect(limited?.status).toBe(429);
		expect(limited?.headers.get("retry-after")).toBe("17");
		expect(await body(limited)).toEqual({
			ok: false,
			error: {
				code: "DEMO_RATE_LIMITED",
				message: "The demo model rate limit was reached",
				retryAfterSeconds: 17,
			},
		});

		const sentinel = "database-password-sentinel";
		const brokenStore = store({
			status: vi.fn(async () => { throw new Error(sentinel); }),
		});
		const broken = await handleDemoModelQuotaRoute(
			new Request("https://harbor.example/internal/demo-model/v1/status"),
			options(brokenStore),
		);
		const serialized = JSON.stringify(await body(broken));
		expect(broken?.status).toBe(503);
		expect(serialized).toContain("DEMO_STATE_UNAVAILABLE");
		expect(serialized).not.toContain(sentinel);
	});

	it("fails closed instead of serializing unexpected store fields", async () => {
		const secret = "internal-d1-sentinel";
		const malformedStore = store({
			status: vi.fn(async () => ({ ...status, secret })),
		});
		const response = await handleDemoModelQuotaRoute(
			new Request("https://harbor.example/internal/demo-model/v1/status"),
			options(malformedStore),
		);
		const serialized = JSON.stringify(await body(response));
		expect(response?.status).toBe(503);
		expect(serialized).toContain("DEMO_STATE_UNAVAILABLE");
		expect(serialized).not.toContain(secret);
	});
});
