import { z } from "zod";

export const HOSTED_STATE_ROUTE_PREFIX = "/internal/pilot-state/v1";
// A 1 MiB UTF-8 plaintext expands under AES-GCM/base64url. This is the
// client envelope allowance plus a separately bounded JSON frame.
export const HOSTED_STATE_MAX_CIPHERTEXT_CHARS = 1_398_358;
export const HOSTED_STATE_MAX_REQUEST_BYTES = 1_410_000;
export const HOSTED_STATE_MAX_ROWS = 4_096;
export const HOSTED_STATE_MAX_PERSONALIZATION_ROWS = 4_096;
export const HOSTED_STATE_MAX_SESSION_BINDINGS = 4_096;
export const HOSTED_STATE_PROOF_MAX_FUTURE_MS = 60_000;
export const HOSTED_STATE_RESEARCH_WINDOW_MS = 3_600_000;
export const HOSTED_STATE_RESEARCH_RETENTION_MS = 7_200_000;
export const HOSTED_STATE_SESSION_MAX_FUTURE_MS = 3_900_000;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/u);
const policyVersion = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);

export const walletProofConsumeSchema = z.object({
	version: z.literal(1), namespace: z.enum(["chat", "wallet-auth"]),
	scopeId: hex64, nonceDigest: hex64,
	expiresAtMs: z.number().int().positive().safe(),
}).strict();
export const personalizationReadSchema = z.object({
	version: z.literal(1), scopeId: hex64,
	resource: z.enum(["preferences", "workflow-lessons"]),
}).strict();
export const personalizationCompareAndSwapSchema = personalizationReadSchema.extend({
	expectedDigest: hex64.nullable(), contentDigest: hex64,
	ciphertext: z.string().min(1).max(HOSTED_STATE_MAX_CIPHERTEXT_CHARS),
}).strict();
export const personalizationDeleteSchema = personalizationReadSchema.extend({
	expectedDigest: hex64,
}).strict();
export const researchQuotaReservationSchema = z.object({
	version: z.literal(1), requestId: z.string().uuid(),
	accountScopeId: hex64, sessionScopeId: hex64,
	network: z.enum(["testnet", "devnet"]),
	sessionExpiresAtMs: z.number().int().positive().safe(),
	policyVersion,
	accountMaximum: z.number().int().min(1).max(24),
	sessionMaximum: z.number().int().min(1).max(12),
}).strict().refine((value) => value.sessionMaximum <= value.accountMaximum, {
	message: "sessionMaximum cannot exceed accountMaximum", path: ["sessionMaximum"],
});

export type WalletProofConsumeInput = z.infer<typeof walletProofConsumeSchema>;
export type PersonalizationReadInput = z.infer<typeof personalizationReadSchema>;
export type PersonalizationCompareAndSwapInput = z.infer<typeof personalizationCompareAndSwapSchema>;
export type PersonalizationDeleteInput = z.infer<typeof personalizationDeleteSchema>;
export type ResearchQuotaReservationInput = z.infer<typeof researchQuotaReservationSchema>;
export type HostedStateConfig = Readonly<{
	allowedPrincipal: string; researchPolicyVersion: string;
	researchAccountMaximum: number; researchSessionMaximum: number;
}>;

export type HostedStateErrorCode = "HOSTED_STATE_DISABLED" | "HOSTED_STATE_MISCONFIGURED"
	| "HOSTED_STATE_UNAVAILABLE" | "HOSTED_STATE_UNAUTHORIZED"
	| "HOSTED_STATE_INVALID_REQUEST" | "HOSTED_STATE_REQUEST_CONFLICT"
	| "HOSTED_STATE_QUOTA_EXHAUSTED";
export class HostedStateError extends Error {
	constructor(readonly code: HostedStateErrorCode, readonly status: number,
		message: string, readonly retryAfterSeconds?: number) {
		super(message); this.name = "HostedStateError";
	}
}

type Environment = Readonly<Record<string, string | undefined>>;
function misconfigured(message: string): never {
	throw new HostedStateError("HOSTED_STATE_MISCONFIGURED", 503,
		`Hosted state is misconfigured: ${message}`);
}
function exact(environment: Environment, name: string, pattern: RegExp): string {
	const value = environment[name];
	if (!value || value.trim() !== value || !pattern.test(value))
		return misconfigured(`${name} is invalid`);
	return value;
}
function boundedInteger(environment: Environment, name: string, maximum: number): number {
	const value = environment[name];
	if (!value || !/^[1-9][0-9]*$/u.test(value))
		return misconfigured(`${name} must be a positive integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed > maximum)
		return misconfigured(`${name} exceeds ${maximum}`);
	return parsed;
}

/** Parses the exact, nonsecret internal policy. Null means disabled. */
export function readHostedStateConfig(environment: object): HostedStateConfig | null {
	const values = environment as Environment;
	const enabled = values.HARBOR_HOSTED_STATE_ENABLED;
	if (enabled === undefined || enabled === "0") return null;
	if (enabled !== "1") return misconfigured("HARBOR_HOSTED_STATE_ENABLED must be exactly 0 or 1");
	const accountMaximum = boundedInteger(values, "HARBOR_RESEARCH_QUOTA_ACCOUNT_HOURLY_RUNS", 24);
	const sessionMaximum = boundedInteger(values, "HARBOR_RESEARCH_QUOTA_SESSION_HOURLY_RUNS", 12);
	if (sessionMaximum > accountMaximum) return misconfigured("session quota cannot exceed account quota");
	return Object.freeze({
		allowedPrincipal: exact(values, "HARBOR_HOSTED_STATE_PRINCIPAL", /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
		researchPolicyVersion: exact(values, "HARBOR_RESEARCH_QUOTA_POLICY_VERSION", /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
		researchAccountMaximum: accountMaximum, researchSessionMaximum: sessionMaximum,
	});
}
