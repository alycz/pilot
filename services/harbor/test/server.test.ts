import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { OpRegistry, type OpDef } from "../src/catalog/registry";
import { execute } from "../src/executor/run";
import { LOCAL_X402_OPERATION_DISABLED } from "../src/executor/providers";
import { LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO } from "../src/local-x402-isolated-v1";
import { X402_SIGNING_PROFILE } from "../src/ops/x402";
import {
	createWorker,
	selectRuntimeRegistry,
	type Env,
} from "../src/server";
import {
	REST_MAX_REQUEST_BYTES,
	REST_MAX_RESPONSE_BYTES,
} from "../src/rest";
import type { X402PayRequest, X402Service } from "../src/x402-contract";

const X402_OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const X402_PAYER = "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn";
const X402_PAY_TO = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const X402_HASH = "A".repeat(64);
const X402_REQUEST: X402PayRequest = {
	owner: X402_OWNER,
	network: "testnet",
	resource: "compare",
	max_price_drops: "1000",
	idempotency_key: "server-dispatch-test",
};

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

function x402Env(): Env {
	return {
		...env("named-principal:correct-secret"),
		HARBOR_LOCAL_DEV: "true",
		HARBOR_LOCAL_X402: "true",
		HARBOR_LOCAL_X402_MERCHANT_PAY_TO: X402_PAY_TO,
		HARBOR_LOCAL_X402_RUNTIME_ENABLED: "true",
		HARBOR_LOCAL_X402_SIGNING_PROFILE: X402_SIGNING_PROFILE,
		HARBOR_LOCAL_READ_ONLY: "true",
		EXEC_NETWORK: "testnet",
		MAINNET_EXECUTION: "false",
	};
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("Worker routes and identity", () => {
	it("serves health without authentication", async () => {
		const response = await createWorker(new OpRegistry()).fetch!(
			new Request("https://harbor.example/health"),
			env(),
			{} as ExecutionContext,
		);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			service: "harbor",
			health: "process",
			handoff_readiness: "not_evaluated",
		});
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

	it("preserves legacy loopback auth on localhost, IPv4, IPv6, and arbitrary ports", async () => {
		const request = new Request("http://127.0.0.1:8791/mcp", {
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

		for (const origin of [
			"http://localhost:8787",
			"http://127.0.0.1:9123",
			"http://[::1]:8787",
		]) {
			const response = await worker.fetch!(
				new Request(`${origin}/mcp`, { method: "POST", body: "{}" }),
				{ ...env(), HARBOR_LOCAL_DEV: "true" },
				{} as ExecutionContext,
			);
			expect(response.status).not.toBe(401);
		}
	});

	it("rejects local auth bypass for cross-origin browser requests", async () => {
		const worker = createWorker(new OpRegistry());
		const localEnv = {
			...env(),
			HARBOR_LOCAL_DEV: "true",
			HARBOR_LOCAL_X402: "true",
		};
		for (const headers of [
			{ origin: "https://attacker.example" },
			{ "sec-fetch-site": "cross-site" },
		]) {
			const response = await worker.fetch!(
				new Request("http://127.0.0.1:8791/mcp", {
					method: "POST",
					headers,
					body: "{}",
				}),
				localEnv,
				{} as ExecutionContext,
			);
			expect(response.status).toBe(401);
		}
	});

	it("preserves headerless REST JSON and unknown-operation precedence", async () => {
		const response = await createWorker(new OpRegistry([feeOp()])).fetch!(
			new Request("https://harbor.example/api/ops/ledger.fee", {
				method: "POST",
				headers: { authorization: "Bearer austin:alpha" },
				body: "{}",
			}),
			env(),
			{} as ExecutionContext,
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			ok: true,
			data: { drops: "12" },
		});

		const unknown = await createWorker(new OpRegistry()).fetch!(
			new Request("https://harbor.example/api/ops/unknown.operation", {
				method: "POST",
				headers: { authorization: "Bearer austin:alpha" },
				body: "not-json",
			}),
			env(),
			{} as ExecutionContext,
		);
		expect(unknown.status).toBe(404);
	});

	it("keeps QuickNode test operations out of deployed registries and exposes them only in exact local development", async () => {
		const localOnlyNames = [
			"quicknode.test.registerLink",
			"quicknode.test.deleteLink",
		] as const;
		const productionRegistry = selectRuntimeRegistry(
			{ HARBOR_LOCAL_DEV: "false" },
			false,
		);
		const spoofedRemoteRegistry = selectRuntimeRegistry(
			{ HARBOR_LOCAL_DEV: "true" },
			false,
		);
		const localRegistry = selectRuntimeRegistry(
			{ HARBOR_LOCAL_DEV: "true" },
			true,
		);

		for (const name of localOnlyNames) {
			expect(productionRegistry.get(name)).toBeUndefined();
			expect(spoofedRemoteRegistry.get(name)).toBeUndefined();
			expect(productionRegistry.list().map((operation) => operation.name))
				.not.toContain(name);
			expect(productionRegistry.search(name, 100).map((result) => result.name))
				.not.toContain(name);
			expect(localRegistry.get(name)?.name).toBe(name);
		}

		const args = {
			owner: X402_OWNER,
			delegate: "rJdYtgaiEgzL7xD2QdPKg5xoHkWc7CZjvm",
			network: "testnet",
			permissions: ["TrustSet"],
		};
		for (const [operation, body] of [
			["quicknode.test.registerLink", args],
			[
				"quicknode.test.deleteLink",
				{ owner: X402_OWNER, network: "testnet" },
			],
		] as const) {
			const deployed = await createWorker().fetch!(
				new Request(`https://harbor.example/api/ops/${operation}`, {
					method: "POST",
					headers: {
						authorization: "Bearer austin:alpha",
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
				}),
				env(),
				{} as ExecutionContext,
			);
			expect(deployed.status).toBe(404);
		}

		const statements: string[] = [];
		const localEnv = {
			...env(),
			HARBOR_LOCAL_DEV: "true",
			QN_MODE: "off",
			DB: {
				prepare(sql: string) {
					statements.push(sql);
					return {
						bind() { return this; },
						async run() {
							return { success: true, meta: { changes: 1 } };
						},
					};
				},
			} as unknown as D1Database,
		};
		const local = await createWorker().fetch!(
			new Request(
				"http://127.0.0.1:8791/api/ops/quicknode.test.registerLink",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(args),
				},
			),
			localEnv,
			{} as ExecutionContext,
		);
		expect(local.status).toBe(200);
		await expect(local.json()).resolves.toMatchObject({
			ok: true,
			data: { owner: X402_OWNER, network: "testnet", status: "active" },
		});
		expect(statements.some((sql) => sql.includes("INSERT INTO links"))).toBe(true);
	});

	it("rejects declared and chunked oversized REST bodies before JSON parsing", async () => {
		const worker = createWorker(new OpRegistry([feeOp()]));
		const headers = {
			authorization: "Bearer austin:alpha",
			"content-type": "application/json",
		};
		const declared = await worker.fetch!(
			new Request("https://harbor.example/api/ops/ledger.fee", {
				method: "POST",
				headers: { ...headers, "content-length": String(REST_MAX_REQUEST_BYTES + 1) },
				body: "{}",
			}),
			env(),
			{} as ExecutionContext,
		);
		expect(declared.status).toBe(413);
		await expect(declared.json()).resolves.toMatchObject({
			ok: false,
			error: { code: "REQUEST_TOO_LARGE" },
		});
		const leadingZeroLength = await worker.fetch!(
			new Request("https://harbor.example/api/ops/ledger.fee", {
				method: "POST",
				headers: { ...headers, "content-length": "0002" },
				body: "{}",
			}),
			env(),
			{} as ExecutionContext,
		);
		expect(leadingZeroLength.status).toBe(200);

		const chunk = new Uint8Array(REST_MAX_REQUEST_BYTES / 2 + 1).fill(0x20);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(chunk);
				controller.enqueue(chunk);
				controller.close();
			},
		});
		const chunked = await worker.fetch!(
			new Request("https://harbor.example/api/ops/ledger.fee", {
				method: "POST",
				headers,
				body: stream,
				duplex: "half",
			} as RequestInit & { duplex: "half" }),
			env(),
			{} as ExecutionContext,
		);
		expect(chunked.status).toBe(413);
		await expect(chunked.json()).resolves.toMatchObject({
			ok: false,
			error: { code: "REQUEST_TOO_LARGE" },
		});
	});

	it("replaces an oversized REST operation result with a bounded error", async () => {
		const oversizedOp: OpDef = {
			name: "test.large",
			family: "test",
			summary: "Return an oversized fixture.",
			args: z.object({}).strict(),
			returns: "an oversized fixture",
			caveats: [],
			example: "await harbor.test.large()",
			handler: () => "x".repeat(REST_MAX_RESPONSE_BYTES),
		};
		const response = await createWorker(new OpRegistry([oversizedOp])).fetch!(
			new Request("https://harbor.example/api/ops/test.large", {
				method: "POST",
				headers: { authorization: "Bearer austin:alpha" },
				body: "{}",
			}),
			env(),
			{} as ExecutionContext,
		);

		expect(response.status).toBe(500);
		const responseBody = await response.text();
		expect(new TextEncoder().encode(responseBody).byteLength).toBeLessThanOrEqual(
			REST_MAX_RESPONSE_BYTES,
		);
		expect(JSON.parse(responseBody)).toMatchObject({
			ok: false,
			error: {
				service: "test.large",
				code: "RESPONSE_TOO_LARGE",
			},
		});
	});

	it("exposes the fixed x402 probe only behind both local flags", async () => {
		const upstreamFetch = vi.fn(async () =>
			new Response(null, {
				status: 402,
				headers: { "content-type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", upstreamFetch);
		const worker = createWorker(new OpRegistry());
		const request = new Request("http://127.0.0.1:8791/local/x402/probe");

		const disabled = await worker.fetch!(
			request,
			{ ...env(), HARBOR_LOCAL_DEV: "true" },
			{} as ExecutionContext,
		);
		expect(disabled.status).toBe(404);
		expect(upstreamFetch).not.toHaveBeenCalled();

		const enabled = await worker.fetch!(
			request,
			{
				...env(),
				HARBOR_LOCAL_DEV: "true",
				HARBOR_LOCAL_X402: "true",
			},
			{} as ExecutionContext,
		);
		expect(enabled.status).toBe(200);
		await expect(enabled.json()).resolves.toEqual({
			reachable: true,
			status: 402,
			contentType: "application/json",
		});
		expect(upstreamFetch).toHaveBeenCalledOnce();
	});

	it("propagates the derived local capability into the Dynamic Worker RPC props", async () => {
		const rpc = { invoke: vi.fn() };
		const HarborRpc = vi.fn(() => rpc);
		const response = await createWorker(new OpRegistry([feeOp()])).fetch!(
			new Request("http://127.0.0.1:8791/mcp", {
				method: "POST",
				headers: {
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
			{
				...env(),
				HARBOR_LOCAL_DEV: "true",
				EXECUTOR: "dynamic",
				LOADER: {} as WorkerLoader,
			},
			{ exports: { HarborRpc } } as unknown as ExecutionContext,
		);

		expect(response.status).toBe(200);
		expect(HarborRpc).toHaveBeenCalledWith({
			props: { principal: "local-dev", localDevRequest: true },
		});
	});

	it("does not run scheduled work in local read-only mode", async () => {
		await expect(
			createWorker(new OpRegistry()).scheduled!(
				{} as ScheduledController,
				{ ...env(), HARBOR_LOCAL_READ_ONLY: "true" },
				{} as ExecutionContext,
			),
		).resolves.toBeUndefined();
	});

	it("allows only x402.pay and disables scheduled work in the enabled x402 profile", async () => {
		const worker = createWorker();
		for (const operation of [
			"account.link",
			"account.revoke",
			"policy.set",
			"tx.execute",
			"tx.submit",
		]) {
			const response = await worker.fetch!(
				new Request(`http://127.0.0.1:8791/api/ops/${operation}`, {
					method: "POST",
					headers: {
						authorization: "Bearer named-principal:correct-secret",
						"content-type": "application/json",
					},
					body: "{}",
				}),
				x402Env(),
				{} as ExecutionContext,
			);
			expect(response.status).toBe(200);
			await expect(response.json()).resolves.toMatchObject({
				ok: false,
				error: { service: operation, code: LOCAL_X402_OPERATION_DISABLED },
			});
		}

		await expect(
			worker.scheduled!(
				{} as ScheduledController,
				x402Env(),
				{} as ExecutionContext,
			),
		).resolves.toBeUndefined();
	});

	it("dispatches the generated x402.pay operation through the enabled narrow profile", async () => {
		const pay = vi.fn(async () => ({
			status: "settlement_unknown" as const,
			payment_id: "payment-server-1",
			idempotency_key: X402_REQUEST.idempotency_key,
			network: "testnet" as const,
			owner: X402_OWNER,
			resource: "compare" as const,
			request_fingerprint: "B".repeat(64),
			tx_hash: X402_HASH,
			last_ledger_sequence: 456,
			retry_after_seconds: 5,
		}));
		const service: X402Service = { pay };
		const worker = createWorker(undefined, () => service);
		const response = await worker.fetch!(
			new Request("http://127.0.0.1:8791/api/ops/x402.pay", {
				method: "POST",
				headers: {
					authorization: "Bearer named-principal:correct-secret",
					"content-type": "application/json",
				},
				body: JSON.stringify(X402_REQUEST),
			}),
			x402Env(),
			{} as ExecutionContext,
		);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			ok: true,
			data: { status: "settlement_unknown", payment_id: "payment-server-1" },
		});
		expect(pay).toHaveBeenCalledExactlyOnceWith("named-principal", X402_REQUEST);
	});

	it.each([
		[LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO, "OPERATION_FAILED"],
		["r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59", "INVALID_ARGUMENTS"],
	] as const)(
		"rejects pay_to=%s in the generic profile before service dispatch",
		async (payTo, errorCode) => {
			const pay = vi.fn();
			const worker = createWorker(undefined, () => ({ pay } as X402Service));
			const response = await worker.fetch!(
				new Request("http://127.0.0.1:8791/api/ops/x402.pay", {
					method: "POST",
					headers: {
						authorization: "Bearer named-principal:correct-secret",
						"content-type": "application/json",
					},
					body: JSON.stringify({
						...X402_REQUEST,
						pay_to: payTo,
					}),
				}),
				x402Env(),
				{} as ExecutionContext,
			);
			await expect(response.json()).resolves.toMatchObject({
				ok: false,
				error: { code: errorCode },
			});
			expect(pay).not.toHaveBeenCalled();
		},
	);

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
