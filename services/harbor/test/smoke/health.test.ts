import { describe, expect, it } from "vitest";

const baseUrl = process.env.HARBOR_SMOKE_URL ?? "http://127.0.0.1:8787";

describe("running Harbor Worker", () => {
	it("serves health", async () => {
		const response = await fetch(`${baseUrl}/health`, {
			signal: AbortSignal.timeout(8_000),
		});
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			service: "harbor",
			health: "process",
			handoff_readiness: "not_evaluated",
		});
	});
});
