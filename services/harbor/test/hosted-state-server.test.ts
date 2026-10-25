import { describe, expect, it } from "vitest";

import { OpRegistry } from "../src/catalog/registry";
import { createWorker, type Env } from "../src/server";

const STATE_PRINCIPAL = "pilot-state";
const STATE_TOKEN = "state-token-that-is-not-an-operations-token";

function executionContext(): ExecutionContext {
	return {
		props: {},
		waitUntil() {},
		passThroughOnException() {},
	} as unknown as ExecutionContext;
}

function environment(overrides: Partial<Env> = {}): Env {
	return {
		DB: {} as D1Database,
		HARBOR_API_KEYS: `${STATE_PRINCIPAL}:${STATE_TOKEN},pilot-ops:ops-token`,
		HARBOR_HOSTED_STATE_ENABLED: "0",
		HARBOR_HOSTED_STATE_PRINCIPAL: STATE_PRINCIPAL,
		EXECUTOR: "quickjs",
		...overrides,
	};
}

function authenticated(path: string, credential = `${STATE_PRINCIPAL}:${STATE_TOKEN}`): Request {
	return new Request(`https://harbor.example${path}`, {
		method: "POST",
		headers: { authorization: `Bearer ${credential}` },
	});
}

describe("hosted-state server dispatch", () => {
	it.each(["/api/ops/ledger.account.info", "/mcp", "/not-an-internal-state-route"])(
		"keeps the dedicated state principal out of %s",
		async (path) => {
			const response = await createWorker(new OpRegistry()).fetch!(
				authenticated(path),
				environment(),
				executionContext(),
			);

			expect(response.status).toBe(403);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(response.headers.get("content-security-policy")).toBe("default-src 'none'");
			expect(response.headers.get("x-content-type-options")).toBe("nosniff");
			await expect(response.json()).resolves.toMatchObject({
				ok: false,
				error: { code: "HOSTED_STATE_PRINCIPAL_SCOPE_DENIED" },
			});
		},
	);

	it("does not narrow an ordinary Harbor principal", async () => {
		const response = await createWorker(new OpRegistry()).fetch!(
			authenticated("/not-an-internal-state-route", "pilot-ops:ops-token"),
			environment(),
			executionContext(),
		);

		expect(response.status).toBe(404);
	});

	it("fails closed when an ordinary principal reuses the hosted-state token", async () => {
		const response = await createWorker(new OpRegistry()).fetch!(
			authenticated("/not-an-internal-state-route", `pilot-ops:${STATE_TOKEN}`),
			environment({
				HARBOR_API_KEYS: `${STATE_PRINCIPAL}:${STATE_TOKEN},pilot-ops:${STATE_TOKEN}`,
			}),
			executionContext(),
		);

		expect(response.status).toBe(401);
	});

	it("fails closed for the hosted-state principal when its token is shared", async () => {
		const response = await createWorker(new OpRegistry()).fetch!(
			authenticated("/internal/pilot-state/v1/personalization/read"),
			environment({
				HARBOR_API_KEYS: `${STATE_PRINCIPAL}:${STATE_TOKEN},pilot-ops:${STATE_TOKEN}`,
				HARBOR_HOSTED_STATE_ENABLED: "1",
			}),
			executionContext(),
		);

		expect(response.status).toBe(401);
	});
});
