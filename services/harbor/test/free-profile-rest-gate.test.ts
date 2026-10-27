import { describe, expect, it } from "vitest";
import { z } from "zod";

import { OpRegistry, type OpDef } from "../src/catalog/registry";
import {
	createWorker,
	FREE_QUICKJS_REST_OPERATION_NAMES,
	restOperationEnabledForDeployment,
	restOperationsEnabledForDeployment,
	type Env,
} from "../src/server";

function freeEnv(): Env {
	return {
		DB: {} as D1Database,
		EXECUTOR: "quickjs",
		HARBOR_API_KEYS: "near-gateway:secret",
		HARBOR_DEPLOYMENT_PROFILE: "free-quickjs",
	};
}

function operation(name: string): OpDef {
	return {
		name,
		family: name.split(".", 1)[0] ?? "near",
		summary: "Test the exact Free/QuickJS NEAR REST boundary.",
		args: z.object({}).strict(),
		returns: "the authenticated principal",
		caveats: ["off-ledger"],
		example: `await harbor.${name}({})`,
		handler: (ctx) => ({ principal: ctx.principal }),
	};
}

describe("Free/QuickJS REST operation gate", () => {
	it("preserves existing paid behavior when the profile is absent or explicit", () => {
		expect(restOperationsEnabledForDeployment({})).toBe(true);
		expect(restOperationsEnabledForDeployment({
			HARBOR_DEPLOYMENT_PROFILE: "paid-dynamic",
		})).toBe(true);
	});

	it("disables every REST operation for Free and malformed explicit profiles", () => {
		expect(restOperationsEnabledForDeployment({
			HARBOR_DEPLOYMENT_PROFILE: "free-quickjs",
		})).toBe(false);
		expect(restOperationsEnabledForDeployment({
			HARBOR_DEPLOYMENT_PROFILE: "Free-QuickJS",
		})).toBe(false);
	});

	it("allows only the exact reviewed NEAR backend operations in Free/QuickJS", () => {
		for (const name of FREE_QUICKJS_REST_OPERATION_NAMES) {
			expect(restOperationEnabledForDeployment({
				HARBOR_DEPLOYMENT_PROFILE: "free-quickjs",
			}, name), name).toBe(true);
		}
		for (const name of [
			"ledger.fee",
			"near.intents.execute",
			"near.intents.owner-funded.reserve.extra",
			"near.intents.owner-funded",
		]) {
			expect(restOperationEnabledForDeployment({
				HARBOR_DEPLOYMENT_PROFILE: "free-quickjs",
			}, name), name).toBe(false);
		}
		expect(restOperationEnabledForDeployment({
			HARBOR_DEPLOYMENT_PROFILE: "Free-QuickJS",
		}, "near.intents.tokens")).toBe(false);
	});

	it("routes the exact allowlist while retaining authenticated principal scope", async () => {
		const registry = new OpRegistry(
			FREE_QUICKJS_REST_OPERATION_NAMES.map(operation),
		);
		const worker = createWorker(registry);
		for (const name of FREE_QUICKJS_REST_OPERATION_NAMES) {
			const response = await worker.fetch!(
				new Request(`https://harbor.example/api/ops/${name}`, {
					method: "POST",
					headers: {
						authorization: "Bearer near-gateway:secret",
						"content-type": "application/json",
					},
					body: "{}",
				}),
				freeEnv(),
				{} as ExecutionContext,
			);
			expect(response.status, name).toBe(200);
			await expect(response.json()).resolves.toMatchObject({
				ok: true,
				data: { principal: "near-gateway" },
			});
		}
	});

	it("rejects ordinary and lookalike operations before dispatch", async () => {
		const registry = new OpRegistry([
			operation("ledger.fee"),
			operation("near.intents.owner-funded.reserve.extra"),
		]);
		const worker = createWorker(registry);
		for (const name of ["ledger.fee", "near.intents.owner-funded.reserve.extra"]) {
			const response = await worker.fetch!(
				new Request(`https://harbor.example/api/ops/${name}`, {
					method: "POST",
					headers: {
						authorization: "Bearer near-gateway:secret",
						"content-type": "application/json",
					},
					body: "{}",
				}),
				freeEnv(),
				{} as ExecutionContext,
			);
			expect(response.status, name).toBe(403);
			await expect(response.json()).resolves.toMatchObject({
				ok: false,
				error: { code: "DEPLOYMENT_PROFILE_DISABLED" },
			});
		}
	});
});
