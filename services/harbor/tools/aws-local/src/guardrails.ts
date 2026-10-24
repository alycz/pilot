// Mirrors the InvokeGuardrailChecks wire shape documented by AWS:
// https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeGuardrailChecks.html

type JsonRecord = Record<string, unknown>;

export type GuardrailCheckResult = {
	category: string;
	severityScore: number;
};

export type GuardrailChecksResponse = {
	results: {
		contentFilter?: { results: GuardrailCheckResult[] };
		promptAttack?: { results: GuardrailCheckResult[] };
		sensitiveInformation?: {
			results: Array<{
				beginOffset: number;
				confidenceScore: number;
				contentIndex: number;
				endOffset: number;
				messageIndex: number;
				type: string;
			}>;
			truncated: boolean;
		};
	};
	usage: {
		contentFilter?: { textUnits: number };
		promptAttack?: { textUnits: number };
		sensitiveInformation?: { textUnits: number };
	};
};

export class GuardrailValidationError extends Error {
	readonly statusCode = 400;
	readonly code = "ValidationException";

	constructor(message: string) {
		super(message);
		this.name = "GuardrailValidationError";
	}
}

const INJECTION_PATTERNS = [
	/ignore\s+(?:all|previous)\s+instructions/i,
	/send\s+all\s+funds/i,
	/system\s+prompt/i,
] as const;

const LOW_SCORE = 0.02;
const HIGH_SCORE = 0.95;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMessages(body: JsonRecord): string[] {
	if (!Array.isArray(body.messages) || body.messages.length === 0) {
		throw new GuardrailValidationError("messages must contain at least one item");
	}

	const texts: string[] = [];
	for (const message of body.messages) {
		if (!isRecord(message)) {
			throw new GuardrailValidationError("each message must be an object");
		}
		if (!["user", "assistant", "system"].includes(String(message.role))) {
			throw new GuardrailValidationError("message role is invalid");
		}
		if (!Array.isArray(message.content) || message.content.length === 0) {
			throw new GuardrailValidationError("message content must not be empty");
		}

		for (const block of message.content) {
			if (!isRecord(block) || typeof block.text !== "string" || block.text.length === 0) {
				throw new GuardrailValidationError(
					"each content block must contain non-empty text",
				);
			}
			texts.push(block.text);
		}
	}

	return texts;
}

function readCategories(
	checks: JsonRecord,
	checkName: "promptAttack" | "contentFilter",
): string[] | undefined {
	const configured = checks[checkName];
	if (configured === undefined) return undefined;
	if (!isRecord(configured) || !Array.isArray(configured.categories)) {
		throw new GuardrailValidationError(`${checkName}.categories must be an array`);
	}

	return configured.categories.map((entry) => {
		if (!isRecord(entry) || typeof entry.category !== "string" || entry.category.length === 0) {
			throw new GuardrailValidationError(
				`${checkName}.categories entries require category`,
			);
		}
		return entry.category;
	});
}

function hasSensitiveInformation(checks: JsonRecord): boolean {
	const configured = checks.sensitiveInformation;
	if (configured === undefined) return false;
	if (!isRecord(configured) || !Array.isArray(configured.entities)) {
		throw new GuardrailValidationError(
			"sensitiveInformation.entities must be an array",
		);
	}
	return true;
}

function isInjection(text: string): boolean {
	return INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

function scoreTexts(texts: string[]): number {
	return texts.some(isInjection) ? HIGH_SCORE : LOW_SCORE;
}

function textUnits(texts: string[]): number {
	const characters = texts.reduce((total, text) => total + text.length, 0);
	return Math.max(1, Math.ceil(characters / 1_000));
}

/**
 * Deterministic local implementation of Bedrock Runtime InvokeGuardrailChecks.
 * It intentionally detects only the fixture/pattern set required by AWS-0.
 */
export function handleGuardrails(
	target: string,
	body: unknown,
): GuardrailChecksResponse {
	if (target !== "InvokeGuardrailChecks" && !target.endsWith(".InvokeGuardrailChecks")) {
		throw new GuardrailValidationError("unsupported Bedrock target");
	}
	if (!isRecord(body) || !isRecord(body.checks)) {
		throw new GuardrailValidationError("checks must be an object");
	}

	const texts = readMessages(body);
	const promptAttackCategories = readCategories(body.checks, "promptAttack");
	const contentFilterCategories = readCategories(body.checks, "contentFilter");
	const includeSensitiveInformation = hasSensitiveInformation(body.checks);

	if (
		promptAttackCategories === undefined &&
		contentFilterCategories === undefined &&
		!includeSensitiveInformation
	) {
		throw new GuardrailValidationError("at least one guardrail check is required");
	}

	const score = scoreTexts(texts);
	const units = textUnits(texts);
	const response: GuardrailChecksResponse = { results: {}, usage: {} };

	if (promptAttackCategories !== undefined) {
		response.results.promptAttack = {
			results: promptAttackCategories.map((category) => ({
				category,
				severityScore: score,
			})),
		};
		response.usage.promptAttack = { textUnits: units };
	}

	if (contentFilterCategories !== undefined) {
		response.results.contentFilter = {
			results: contentFilterCategories.map((category) => ({
				category,
				severityScore: LOW_SCORE,
			})),
		};
		response.usage.contentFilter = { textUnits: units };
	}

	if (includeSensitiveInformation) {
		response.results.sensitiveInformation = { results: [], truncated: false };
		response.usage.sensitiveInformation = { textUnits: units };
	}

	return response;
}
