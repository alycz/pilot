import { describe, expect, it } from "vitest";

import { OpRegistry } from "../src/catalog/registry";
import { createWorker, type Env } from "../src/server";

function executionContext(): ExecutionContext {
	return {
		props: {},
		waitUntil() {},
		passThroughOnException() {},
	} as unknown as ExecutionContext;
}

function request(apiKey?: string): Request {
	return new Request("https://harbor.example/internal/demo-model/v1/status", {
		headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
	});
}

function environment(overrides: Partial<Env> = {}): Env {
	return {
		DB: {} as D1Database,
		HARBOR_API_KEYS: "pilot-demo:test-token,other:test-token-2",
		EXECUTOR: "quickjs",
		...overrides,
	};
}

const enabledPolicy = Object.freeze({
	HARBOR_DEMO_QUOTA_ENABLED: "1",
	HARBOR_DEMO_QUOTA_PRINCIPAL: "pilot-demo",
	HARBOR_DEMO_COST_POLICY: "free-only",
	HARBOR_DEMO_POLICY_VERSION: "demo-v1",
	HARBOR_DEMO_ALLOWED_MODELS: "openai/gpt-oss-20b:free",
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

describe("Worker private demo quota dispatch", () => {
	it("requires ordinary Harbor bearer authentication before quota routing", async () => {
		const response = await createWorker(new OpRegistry()).fetch!(
			request(),
			environment(),
			executionContext(),
		);

		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toBe("Bearer");
	});

	it("keeps the shared backend disabled by default after authentication", async () => {
		const response = await createWorker(new OpRegistry()).fetch!(
			request("pilot-demo:test-token"),
			environment(),
			executionContext(),
		);

		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			error: {
				code: "DEMO_DISABLED",
				message: "Shared demo quota access is disabled",
			},
		});
	});

	it("rejects a valid but non-allowlisted Harbor principal before D1 access", async () => {
		const response = await createWorker(new OpRegistry()).fetch!(
			request("other:test-token-2"),
			environment(enabledPolicy),
			executionContext(),
		);

		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toMatchObject({
			ok: false,
			error: { code: "DEMO_UNAUTHORIZED" },
		});
	});
});
