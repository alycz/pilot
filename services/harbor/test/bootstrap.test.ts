import { describe, expect, it } from "vitest";

import { createWorker } from "../src/server";

describe("P1.0 Worker bootstrap", () => {
	it("serves health", async () => {
		const response = await createWorker().fetch!(
			new Request("https://harbor.example/health"),
			{} as never,
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
});
