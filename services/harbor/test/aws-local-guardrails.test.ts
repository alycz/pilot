import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	GuardrailValidationError,
	handleGuardrails,
} from "../tools/aws-local/src/guardrails";

const fixturePath = fileURLToPath(
	new URL("../tools/aws-local/fixtures/injections.txt", import.meta.url),
);

function request(text: string) {
	return {
		checks: {
			promptAttack: {
				categories: [
					{ category: "PROMPT_INJECTION" },
					{ category: "JAILBREAK" },
				],
			},
		},
		messages: [{ role: "user", content: [{ text }] }],
	};
}

describe("AWS local InvokeGuardrailChecks", () => {
	it("scores every injection fixture high", () => {
		const fixtures = readFileSync(fixturePath, "utf8")
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);

		for (const fixture of fixtures) {
			const response = handleGuardrails(
				"BedrockRuntime.InvokeGuardrailChecks",
				request(fixture),
			);
			expect(response.results.promptAttack?.results).toEqual([
				{ category: "PROMPT_INJECTION", severityScore: 0.95 },
				{ category: "JAILBREAK", severityScore: 0.95 },
			]);
		}
	});

	it("scores ordinary text low using the documented response shape", () => {
		const response = handleGuardrails(
			"InvokeGuardrailChecks",
			request("USD Coin is a stablecoin used for settlement."),
		);

		expect(response).toEqual({
			results: {
				promptAttack: {
					results: [
						{ category: "PROMPT_INJECTION", severityScore: 0.02 },
						{ category: "JAILBREAK", severityScore: 0.02 },
					],
				},
			},
			usage: { promptAttack: { textUnits: 1 } },
		});
	});

	it("supports the complete documented check result keys", () => {
		const response = handleGuardrails("InvokeGuardrailChecks", {
			checks: {
				contentFilter: { categories: [{ category: "MISCONDUCT" }] },
				sensitiveInformation: { entities: [{ type: "EMAIL" }] },
			},
			messages: [{ role: "assistant", content: [{ text: "Normal output" }] }],
		});

		expect(response).toEqual({
			results: {
				contentFilter: {
					results: [{ category: "MISCONDUCT", severityScore: 0.02 }],
				},
				sensitiveInformation: { results: [], truncated: false },
			},
			usage: {
				contentFilter: { textUnits: 1 },
				sensitiveInformation: { textUnits: 1 },
			},
		});
	});

	it("rejects unsupported targets and malformed bodies safely", () => {
		expect(() => handleGuardrails("ApplyGuardrail", request("hello"))).toThrow(
			GuardrailValidationError,
		);
		expect(() =>
			handleGuardrails("InvokeGuardrailChecks", { checks: {}, messages: [] }),
		).toThrow("messages must contain at least one item");
	});
});
