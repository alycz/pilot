import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { OpRegistry, type OpDef } from "../src/catalog/registry";
import { execute } from "../src/executor/run";
import { createWorker, type Env } from "../src/server";

function feeOp(): OpDef {
	return {
		name: "ledger.fee",
		family: "ledger",
		summary: "Read the current XRPL transaction fee.",
		tags: ["fee"],
		args: z.object({}).strict(),
		returns: "fee drops and principal",
		caveats: [],
		example: "await harbor.ledger.fee()",
		handler: (ctx) => ({ drops: "12", principal: ctx.principal }),
	};
}

function env(apiKeys = "austin:alpha,second:beta"): Env {
	return {
		DB: {} as D1Database,
		HARBOR_API_KEYS: apiKeys,
		EXECUTOR: "quickjs",
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("Worker routes and identity", () => {
	it("serves health without authentication", async () => {
		const response = await createWorker(new OpRegistry()).fetch!(
			new Request("https://harbor.example/health"),
			env(),
			{} as ExecutionContext,
		);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ ok: true, service: "harbor" });
	});

	it("rejects an unknown API key", async () => {
		const response = await createWorker(new OpRegistry()).fetch!(
			new Request("https://harbor.example/mcp", {
				method: "POST",
				headers: { authorization: "Bearer austin:wrong" },
				body: "{}",
			}),
			env(),
			{} as ExecutionContext,
		);
		expect(response.status).toBe(401);
	});

	it("enables loopback bypass only with the explicit local-dev flag", async () => {
		const request = new Request("http://127.0.0.1/mcp", {
			method: "POST",
			body: "{}",
		});
		const worker = createWorker(new OpRegistry());
		const rejected = await worker.fetch!(request, env(), {} as ExecutionContext);
		expect(rejected.status).toBe(401);

		const accepted = await worker.fetch!(
			request,
			{ ...env(), HARBOR_LOCAL_DEV: "true" },
			{} as ExecutionContext,
		);
		expect(accepted.status).not.toBe(401);
	});

	it("passes the API key name as principal and mirrors execute envelopes", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-18T00:00:00.000Z"));
		const registry = new OpRegistry([feeOp()]);
		const response = await createWorker(registry).fetch!(
			new Request("https://harbor.example/api/ops/ledger.fee", {
				method: "POST",
				headers: {
					authorization: "Bearer second:beta",
					"content-type": "application/json",
				},
				body: "{}",
			}),
			env(),
			{} as ExecutionContext,
		);
		const restEnvelope = await response.json();
		const executeEnvelope = JSON.parse(
			await execute("return await harbor.ledger.fee();", {
				ctx: { principal: "second" },
				registry,
				runtime: "quickjs",
			}),
		);

		expect(response.status).toBe(200);
		expect(restEnvelope).toEqual(executeEnvelope);
		expect(restEnvelope.data.principal).toBe("second");
	});

	it("applies execute guards and redacts handler failures on REST", async () => {
		const request = (body: string) =>
			new Request("https://harbor.example/api/ops/ledger.fee", {
				method: "POST",
				headers: {
					authorization: "Bearer austin:alpha",
					"content-type": "application/json",
				},
				body,
			});
		const guarded = await createWorker(new OpRegistry([feeOp()])).fetch!(
			request('{"privateKey":"never"}'),
			env(),
			{} as ExecutionContext,
		);
		await expect(guarded.json()).resolves.toMatchObject({
			ok: false,
			error: { code: "SENSITIVE_INPUT" },
		});

		const failingOp = {
			...feeOp(),
			handler: () => {
				throw new Error("delegate credential material");
			},
		};
		const failed = await createWorker(new OpRegistry([failingOp])).fetch!(
			request("{}"),
			env(),
			{} as ExecutionContext,
		);
		const body = await failed.text();
		expect(body).toContain("Operation failed");
		expect(body).not.toContain("credential material");
	});

	it("exposes the stateless MCP initialize endpoint", async () => {
		const response = await createWorker(new OpRegistry([feeOp()])).fetch!(
			new Request("https://harbor.example/mcp", {
				method: "POST",
				headers: {
					authorization: "Bearer austin:alpha",
					accept: "application/json, text/event-stream",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: "2025-11-25",
						capabilities: {},
						clientInfo: { name: "unit-test", version: "1.0.0" },
					},
				}),
			}),
			env(),
			{} as ExecutionContext,
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('"name":"harbor"');
	});
});
