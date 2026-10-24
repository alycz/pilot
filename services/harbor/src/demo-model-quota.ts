const FREE_MODEL_PATTERN =
	/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}:free$/;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
const PRINCIPAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const POLICY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Environment = Readonly<Record<string, string | undefined>>;

export type DemoQuotaErrorCode =
	| "DEMO_DISABLED"
	| "DEMO_MISCONFIGURED"
	| "DEMO_STATE_UNAVAILABLE"
	| "DEMO_UNAUTHORIZED"
	| "DEMO_REQUEST_CONFLICT"
	| "DEMO_MODEL_NOT_ALLOWED"
	| "DEMO_INPUT_TOO_LARGE"
	| "DEMO_GLOBAL_DAILY_OUTPUT_TOKENS_EXHAUSTED"
	| "DEMO_GLOBAL_DAILY_REQUESTS_EXHAUSTED"
	| "DEMO_WALLET_DAILY_OUTPUT_TOKENS_EXHAUSTED"
	| "DEMO_WALLET_DAILY_REQUESTS_EXHAUSTED"
	| "DEMO_RATE_LIMITED"
	| "DEMO_GLOBAL_BUSY"
	| "DEMO_WALLET_BUSY"
	| "DEMO_ZERO_COST_INTEGRITY_BLOCKED"
	| "DEMO_RESERVATION_NOT_FOUND";

export class DemoQuotaError extends Error {
	constructor(
		readonly code: DemoQuotaErrorCode,
		readonly status: number,
		message: string,
		readonly retryAfterSeconds?: number,
	) {
		super(message);
		this.name = "DemoQuotaError";
	}
}

export type DemoQuotaConfig = Readonly<{
	allowedPrincipal: string;
	costPolicy: "free-only";
	policyVersion: string;
	allowedModels: readonly string[];
	globalDailyOutputTokens: number;
	globalDailyRequests: number;
	walletDailyOutputTokens: number;
	walletDailyRequests: number;
	rateWindowSeconds: number;
	rateRequests: number;
	maxGlobalConcurrency: number;
	maxWalletConcurrency: number;
	reservationTtlSeconds: number;
	abortGraceSeconds: number;
	maxInputBytes: number;
	maxOutputTokens: number;
	maxSteps: number;
}>;

export type DemoQuotaReserveInput = Readonly<{
	version: 1;
	requestId: string;
	walletScopeId: string;
	sessionScopeId: string;
	network: "testnet" | "devnet";
	model: string;
	inputBytes: number;
}>;

export type DemoQuotaReservation = Readonly<{
	id: string;
	timeoutMs: number;
	maxOutputTokens: number;
	maxSteps: number;
	remainingGlobalDailyOutputTokens: number;
	remainingWalletDailyOutputTokens: number;
	remainingWalletDailyRequests: number;
	policyVersion: string;
}>;

export type DemoQuotaIntegrityFailure =
	| "unexpected-model"
	| "missing-cost"
	| "nonzero-cost";

export type DemoQuotaSettleInput = Readonly<{
	version: 1;
	reservationId: string;
	outcome: "completed" | "uncertain";
	actualInputTokens?: number;
	actualOutputTokens?: number;
	integrityFailure?: DemoQuotaIntegrityFailure;
}>;

export type DemoQuotaSettlement = Readonly<{
	id: string;
	outcome: "completed" | "uncertain";
	alreadySettled: boolean;
}>;

export type DemoQuotaStatus = Readonly<{
	available: true;
	policyVersion: string;
	costPolicy: "free-only";
	allowedModels: readonly string[];
	globalDailyOutputTokens: number;
	globalDailyRequests: number;
	walletDailyOutputTokens: number;
	walletDailyRequests: number;
	rateWindowSeconds: number;
	rateRequests: number;
	maxGlobalConcurrency: number;
	maxWalletConcurrency: number;
	reservationTtlSeconds: number;
	abortGraceSeconds: number;
	maxInputBytes: number;
	maxOutputTokens: number;
	maxSteps: number;
}>;

type Dependencies = Readonly<{
	now?: () => number;
	reservationId?: () => string;
}>;

type ReservationRow = Readonly<{
	id: string;
	request_digest: string;
	policy_version: string;
	timeout_ms: number;
	max_output_tokens_per_step: number;
	max_steps: number;
	remaining_global_daily_output_tokens: number;
	remaining_wallet_daily_output_tokens: number;
	remaining_wallet_daily_requests: number;
	status: string;
	expires_at_ms: number;
}>;

type DiagnosticRow = Readonly<{
	global_used: number;
	global_requests: number;
	wallet_used: number;
	session_used: number;
	wallet_requests: number;
	session_requests: number;
	rate_requests: number;
	rate_oldest_ms: number | null;
	global_active: number;
	wallet_active: number;
}>;

function configurationError(message: string): never {
	throw new DemoQuotaError(
		"DEMO_MISCONFIGURED",
		503,
		`Demo quota service is misconfigured: ${message}`,
	);
}

function positiveInteger(environment: Environment, name: string): number {
	const value = environment[name];
	if (!value || !/^[1-9][0-9]*$/.test(value)) {
		return configurationError(`${name} must be a positive integer`);
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) {
		return configurationError(`${name} exceeds the supported integer range`);
	}
	return parsed;
}

function exactString(
	environment: Environment,
	name: string,
	pattern: RegExp,
): string {
	const value = environment[name];
	if (!value || value.trim() !== value || !pattern.test(value)) {
		return configurationError(`${name} is invalid`);
	}
	return value;
}

function allowedModels(value: string | undefined): readonly string[] {
	if (!value) return configurationError("HARBOR_DEMO_ALLOWED_MODELS is required");
	const entries = value.split(",").map((entry) => entry.trim());
	if (
		entries.length === 0 ||
		entries.some((entry) => !FREE_MODEL_PATTERN.test(entry)) ||
		new Set(entries).size !== entries.length
	) {
		return configurationError(
			"HARBOR_DEMO_ALLOWED_MODELS must contain unique exact :free model ids",
		);
	}
	return Object.freeze(entries);
}

/** Parse the authoritative Worker quota policy. Disabled is represented by null. */
export function readDemoQuotaConfig(
	environment: Environment,
): DemoQuotaConfig | null {
	const enabled = environment.HARBOR_DEMO_QUOTA_ENABLED;
	if (enabled === undefined || enabled === "0") return null;
	if (enabled !== "1") {
		return configurationError("HARBOR_DEMO_QUOTA_ENABLED must be exactly 0 or 1");
	}
	if (environment.HARBOR_DEMO_COST_POLICY !== "free-only") {
		return configurationError("HARBOR_DEMO_COST_POLICY must be exactly free-only");
	}

	const config: DemoQuotaConfig = Object.freeze({
		allowedPrincipal: exactString(
			environment,
			"HARBOR_DEMO_QUOTA_PRINCIPAL",
			PRINCIPAL_PATTERN,
		),
		costPolicy: "free-only",
		policyVersion: exactString(
			environment,
			"HARBOR_DEMO_POLICY_VERSION",
			POLICY_VERSION_PATTERN,
		),
		allowedModels: allowedModels(environment.HARBOR_DEMO_ALLOWED_MODELS),
		globalDailyOutputTokens: positiveInteger(
			environment,
			"HARBOR_DEMO_GLOBAL_DAILY_OUTPUT_TOKENS",
		),
		globalDailyRequests: positiveInteger(
			environment,
			"HARBOR_DEMO_GLOBAL_DAILY_REQUESTS",
		),
		walletDailyOutputTokens: positiveInteger(
			environment,
			"HARBOR_DEMO_WALLET_DAILY_OUTPUT_TOKENS",
		),
		walletDailyRequests: positiveInteger(
			environment,
			"HARBOR_DEMO_WALLET_DAILY_REQUESTS",
		),
		rateWindowSeconds: positiveInteger(
			environment,
			"HARBOR_DEMO_RATE_WINDOW_SECONDS",
		),
		rateRequests: positiveInteger(environment, "HARBOR_DEMO_RATE_REQUESTS"),
		maxGlobalConcurrency: positiveInteger(
			environment,
			"HARBOR_DEMO_MAX_GLOBAL_CONCURRENCY",
		),
		maxWalletConcurrency: positiveInteger(
			environment,
			"HARBOR_DEMO_MAX_WALLET_CONCURRENCY",
		),
		reservationTtlSeconds: positiveInteger(
			environment,
			"HARBOR_DEMO_RESERVATION_TTL_SECONDS",
		),
		abortGraceSeconds: positiveInteger(
			environment,
			"HARBOR_DEMO_ABORT_GRACE_SECONDS",
		),
		maxInputBytes: positiveInteger(environment, "HARBOR_DEMO_MAX_INPUT_BYTES"),
		maxOutputTokens: positiveInteger(
			environment,
			"HARBOR_DEMO_MAX_OUTPUT_TOKENS",
		),
		maxSteps: positiveInteger(environment, "HARBOR_DEMO_MAX_STEPS"),
	});

	if (config.walletDailyOutputTokens > config.globalDailyOutputTokens) {
		return configurationError("wallet output quota cannot exceed global output quota");
	}
	if (config.walletDailyRequests > config.globalDailyRequests) {
		return configurationError("wallet request quota cannot exceed global request quota");
	}
	if (config.rateRequests > config.walletDailyRequests) {
		return configurationError("rate limit cannot exceed wallet daily requests");
	}
	if (config.maxWalletConcurrency > config.maxGlobalConcurrency) {
		return configurationError("wallet concurrency cannot exceed global concurrency");
	}
	if (config.maxGlobalConcurrency !== 1 || config.maxWalletConcurrency !== 1) {
		return configurationError(
			"strict zero-cost mode requires global and wallet concurrency to be exactly 1",
		);
	}
	if (config.maxOutputTokens > config.walletDailyOutputTokens) {
		return configurationError("one reservation cannot exceed the wallet output quota");
	}
	if (config.maxOutputTokens < config.maxSteps) {
		return configurationError("max output tokens must be at least max steps");
	}
	if (config.abortGraceSeconds >= config.reservationTtlSeconds) {
		return configurationError("abort grace must be smaller than reservation TTL");
	}
	const maxSafeSeconds = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);
	if (
		config.rateWindowSeconds > maxSafeSeconds ||
		config.reservationTtlSeconds > maxSafeSeconds ||
		config.abortGraceSeconds > maxSafeSeconds
	) {
		return configurationError("quota time windows exceed the supported range");
	}
	return config;
}

function invalidRequest(message: string): never {
	throw new DemoQuotaError("DEMO_MISCONFIGURED", 400, message);
}

function assertExactKeys(
	value: object,
	required: readonly string[],
	optional: readonly string[] = [],
): void {
	const keys = Object.keys(value);
	const allowed = new Set([...required, ...optional]);
	if (
		required.some((key) => !Object.hasOwn(value, key)) ||
		keys.some((key) => !allowed.has(key))
	) {
		invalidRequest("The demo quota request shape is invalid");
	}
}

function nonnegativeInteger(value: unknown, name: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		return invalidRequest(`${name} must be a nonnegative integer`);
	}
	return value as number;
}

function assertPrincipal(principal: string, config: DemoQuotaConfig): void {
	if (principal !== config.allowedPrincipal) {
		throw new DemoQuotaError(
			"DEMO_UNAUTHORIZED",
			403,
			"This principal cannot access the shared demo quota",
		);
	}
}

function validateReserveInput(
	input: DemoQuotaReserveInput,
	config: DemoQuotaConfig,
): void {
	if (!input || typeof input !== "object") invalidRequest("The demo quota request is invalid");
	assertExactKeys(input, [
		"version",
		"requestId",
		"walletScopeId",
		"sessionScopeId",
		"network",
		"model",
		"inputBytes",
	]);
	if (input.version !== 1) invalidRequest("The demo quota protocol version is invalid");
	if (!HEX_64_PATTERN.test(input.requestId)) invalidRequest("The request id is invalid");
	if (!HEX_64_PATTERN.test(input.walletScopeId)) invalidRequest("The wallet scope is invalid");
	if (!HEX_64_PATTERN.test(input.sessionScopeId)) invalidRequest("The session scope is invalid");
	if (input.network !== "testnet" && input.network !== "devnet") {
		invalidRequest("A test network is required");
	}
	if (!FREE_MODEL_PATTERN.test(input.model) || !config.allowedModels.includes(input.model)) {
		throw new DemoQuotaError(
			"DEMO_MODEL_NOT_ALLOWED",
			400,
			"The selected demo model is not available",
		);
	}
	const inputBytes = nonnegativeInteger(input.inputBytes, "inputBytes");
	if (inputBytes > config.maxInputBytes) {
		throw new DemoQuotaError(
			"DEMO_INPUT_TOO_LARGE",
			413,
			"The demo request is too large",
		);
	}
}

function validateSettleInput(input: DemoQuotaSettleInput): void {
	if (!input || typeof input !== "object") invalidRequest("The demo settlement is invalid");
	assertExactKeys(
		input,
		["version", "reservationId", "outcome"],
		["actualInputTokens", "actualOutputTokens", "integrityFailure"],
	);
	if (input.version !== 1) invalidRequest("The demo quota protocol version is invalid");
	if (!UUID_PATTERN.test(input.reservationId)) invalidRequest("The reservation id is invalid");
	if (input.outcome !== "completed" && input.outcome !== "uncertain") {
		invalidRequest("The settlement outcome is invalid");
	}
	if (input.actualInputTokens !== undefined) {
		nonnegativeInteger(input.actualInputTokens, "actualInputTokens");
	}
	if (input.actualOutputTokens !== undefined) {
		nonnegativeInteger(input.actualOutputTokens, "actualOutputTokens");
	}
	if (
		input.integrityFailure !== undefined &&
		input.integrityFailure !== "unexpected-model" &&
		input.integrityFailure !== "missing-cost" &&
		input.integrityFailure !== "nonzero-cost"
	) {
		invalidRequest("The integrity failure is invalid");
	}
	if (input.integrityFailure !== undefined && input.outcome !== "uncertain") {
		invalidRequest("An integrity failure must settle as uncertain");
	}
}

function checkedNow(clock: () => number): number {
	const now = clock();
	if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) {
		throw new DemoQuotaError("DEMO_STATE_UNAVAILABLE", 503, "The quota clock is unavailable");
	}
	return now;
}

function utcDay(now: number): string {
	return new Date(now).toISOString().slice(0, 10);
}

async function sha256(value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function reservationFromRow(row: ReservationRow): DemoQuotaReservation {
	return {
		id: row.id,
		timeoutMs: row.timeout_ms,
		maxOutputTokens: row.max_output_tokens_per_step,
		maxSteps: row.max_steps,
		remainingGlobalDailyOutputTokens: row.remaining_global_daily_output_tokens,
		remainingWalletDailyOutputTokens: row.remaining_wallet_daily_output_tokens,
		remainingWalletDailyRequests: row.remaining_wallet_daily_requests,
		policyVersion: row.policy_version,
	};
}

function firstRow<T>(result: D1Result<unknown> | undefined): T | undefined {
	return result?.results?.[0] as T | undefined;
}

function stateError(): DemoQuotaError {
	return new DemoQuotaError(
		"DEMO_STATE_UNAVAILABLE",
		503,
		"The shared demo quota is unavailable",
	);
}

export class D1DemoQuotaStore {
	private readonly now: () => number;
	private readonly reservationId: () => string;

	constructor(
		private readonly db: D1Database,
		readonly config: DemoQuotaConfig,
		dependencies: Dependencies = {},
	) {
		this.now = dependencies.now ?? Date.now;
		this.reservationId = dependencies.reservationId ?? (() => crypto.randomUUID());
	}

	async reserve(
		principal: string,
		input: DemoQuotaReserveInput,
	): Promise<DemoQuotaReservation> {
		assertPrincipal(principal, this.config);
		validateReserveInput(input, this.config);
		const now = checkedNow(this.now);
		const id = this.reservationId();
		if (!UUID_PATTERN.test(id)) throw stateError();
		const day = utcDay(now);
		const reservationTtlMs = this.config.reservationTtlSeconds * 1_000;
		const timeoutMs =
			(this.config.reservationTtlSeconds - this.config.abortGraceSeconds) * 1_000;
		if (
			!Number.isSafeInteger(reservationTtlMs) ||
			!Number.isSafeInteger(timeoutMs) ||
			now > Number.MAX_SAFE_INTEGER - reservationTtlMs
		) {
			throw stateError();
		}
		const expiresAt = now + reservationTtlMs;
		const perStepOutput = Math.floor(
			this.config.maxOutputTokens / this.config.maxSteps,
		);
		const rateStart = now - this.config.rateWindowSeconds * 1_000;
		const requestDigest = await sha256(JSON.stringify({
			version: input.version,
			requestId: input.requestId,
			walletScopeId: input.walletScopeId,
			sessionScopeId: input.sessionScopeId,
			network: input.network,
			model: input.model,
			inputBytes: input.inputBytes,
			policy: {
				version: this.config.policyVersion,
				costPolicy: this.config.costPolicy,
				allowedModels: this.config.allowedModels,
				globalDailyOutputTokens: this.config.globalDailyOutputTokens,
				globalDailyRequests: this.config.globalDailyRequests,
				walletDailyOutputTokens: this.config.walletDailyOutputTokens,
				walletDailyRequests: this.config.walletDailyRequests,
				rateWindowSeconds: this.config.rateWindowSeconds,
				rateRequests: this.config.rateRequests,
				maxGlobalConcurrency: this.config.maxGlobalConcurrency,
				maxWalletConcurrency: this.config.maxWalletConcurrency,
				reservationTtlSeconds: this.config.reservationTtlSeconds,
				abortGraceSeconds: this.config.abortGraceSeconds,
				maxInputBytes: this.config.maxInputBytes,
				maxOutputTokens: this.config.maxOutputTokens,
				maxSteps: this.config.maxSteps,
			},
		}));

		try {
			const results = await this.db.batch([
				this.db.prepare(`
					UPDATE demo_model_quota_reservations
					SET status = 'uncertain', settled_at_ms = ?2
					WHERE principal = ?1 AND status = 'active' AND expires_at_ms <= ?2
				`).bind(principal, now),
				this.db.prepare(`
					WITH usage AS (
						SELECT
							(SELECT COALESCE(SUM(reserved_output_tokens), 0)
							 FROM demo_model_quota_reservations
							 WHERE principal = ?1 AND utc_day = ?10) AS global_used,
							(SELECT COUNT(*) FROM demo_model_quota_reservations
							 WHERE principal = ?1 AND utc_day = ?10) AS global_requests,
							(SELECT COALESCE(SUM(reserved_output_tokens), 0)
							 FROM demo_model_quota_reservations
							 WHERE principal = ?1 AND wallet_scope_id = ?5 AND utc_day = ?10) AS wallet_used,
							(SELECT COALESCE(SUM(reserved_output_tokens), 0)
							 FROM demo_model_quota_reservations
							 WHERE principal = ?1 AND session_scope_id = ?6 AND utc_day = ?10) AS session_used,
							(SELECT COUNT(*) FROM demo_model_quota_reservations
							 WHERE principal = ?1 AND wallet_scope_id = ?5 AND utc_day = ?10) AS wallet_requests,
							(SELECT COUNT(*) FROM demo_model_quota_reservations
							 WHERE principal = ?1 AND session_scope_id = ?6 AND utc_day = ?10) AS session_requests,
							(SELECT COUNT(*) FROM demo_model_quota_reservations
							 WHERE principal = ?1 AND session_scope_id = ?6 AND created_at_ms > ?17) AS rate_requests,
							(SELECT COUNT(*) FROM demo_model_quota_reservations
							 WHERE principal = ?1 AND status = 'active' AND expires_at_ms > ?15) AS global_active,
							(SELECT COUNT(*) FROM demo_model_quota_reservations
							 WHERE principal = ?1 AND status = 'active' AND expires_at_ms > ?15
							 AND (wallet_scope_id = ?5 OR session_scope_id = ?6)) AS wallet_active
					)
					INSERT INTO demo_model_quota_reservations (
						principal, id, request_id, request_digest, wallet_scope_id,
						session_scope_id, network, model, policy_version, utc_day,
						reserved_output_tokens, max_output_tokens_per_step, max_steps,
						timeout_ms, remaining_global_daily_output_tokens,
						remaining_wallet_daily_output_tokens, remaining_wallet_daily_requests,
						status, created_at_ms, expires_at_ms
					)
					SELECT
						?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
						?11, ?12, ?13, ?14, ?18 - global_used - ?11,
						?20 - MAX(wallet_used, session_used) - ?11,
						?21 - MAX(wallet_requests, session_requests) - 1,
						'active', ?15, ?16
					FROM usage
					WHERE NOT EXISTS (
						SELECT 1 FROM demo_model_zero_cost_integrity WHERE principal = ?1
					)
					AND NOT EXISTS (
						SELECT 1 FROM demo_model_quota_reservations
						WHERE principal = ?1 AND status = 'uncertain'
					)
					AND NOT EXISTS (
						SELECT 1 FROM demo_model_quota_reservations
						WHERE principal = ?1 AND session_scope_id = ?6
						AND (wallet_scope_id <> ?5 OR network <> ?7)
					)
					AND global_used + ?11 <= ?18
					AND global_requests < ?19
					AND wallet_used + ?11 <= ?20
					AND session_used + ?11 <= ?20
					AND wallet_requests < ?21
					AND session_requests < ?21
					AND rate_requests < ?22
					AND global_active < ?23
					AND wallet_active < ?24
					ON CONFLICT(principal, request_id) DO NOTHING
				`).bind(
					principal,
					id,
					input.requestId,
					requestDigest,
					input.walletScopeId,
					input.sessionScopeId,
					input.network,
					input.model,
					this.config.policyVersion,
					day,
					this.config.maxOutputTokens,
					perStepOutput,
					this.config.maxSteps,
					timeoutMs,
					now,
					expiresAt,
					rateStart,
					this.config.globalDailyOutputTokens,
					this.config.globalDailyRequests,
					this.config.walletDailyOutputTokens,
					this.config.walletDailyRequests,
					this.config.rateRequests,
					this.config.maxGlobalConcurrency,
					this.config.maxWalletConcurrency,
				),
				this.db.prepare(`
					SELECT id, request_digest, policy_version, timeout_ms,
						max_output_tokens_per_step, max_steps,
						remaining_global_daily_output_tokens,
						remaining_wallet_daily_output_tokens,
						remaining_wallet_daily_requests, status, expires_at_ms
					FROM demo_model_quota_reservations
					WHERE principal = ? AND request_id = ?
						AND status = 'active' AND expires_at_ms > ?
						AND NOT EXISTS (
							SELECT 1 FROM demo_model_zero_cost_integrity
							WHERE principal = demo_model_quota_reservations.principal
						)
				`).bind(principal, input.requestId, now),
			]);
			const row = firstRow<ReservationRow>(results[2]);
			if (row) {
				if (row.request_digest !== requestDigest) {
					throw new DemoQuotaError(
						"DEMO_REQUEST_CONFLICT",
						409,
						"The demo request id was already used for different input",
					);
				}
				return reservationFromRow(row);
			}
			return await this.diagnoseReserve(
				principal,
				input,
				requestDigest,
				now,
				day,
				rateStart,
			);
		} catch (error) {
			if (error instanceof DemoQuotaError) throw error;
			throw stateError();
		}
	}

	private async diagnoseReserve(
		principal: string,
		input: DemoQuotaReserveInput,
		requestDigest: string,
		now: number,
		day: string,
		rateStart: number,
	): Promise<never> {
		const integrity = await this.db.prepare(`
			SELECT failure FROM demo_model_zero_cost_integrity WHERE principal = ?
		`).bind(principal).first<{ failure: string }>();
		if (integrity) {
			throw new DemoQuotaError(
				"DEMO_ZERO_COST_INTEGRITY_BLOCKED",
				503,
				"Free demo access is paused after a zero-cost integrity check failed",
			);
		}
		const unverified = await this.db.prepare(`
			SELECT 1 AS blocked FROM demo_model_quota_reservations
			WHERE principal = ? AND status = 'uncertain' LIMIT 1
		`).bind(principal).first<{ blocked: number }>();
		if (unverified) {
			throw new DemoQuotaError(
				"DEMO_ZERO_COST_INTEGRITY_BLOCKED",
				503,
				"Free demo access is paused because a prior request could not be verified as zero cost",
			);
		}
		const existing = await this.db.prepare(`
			SELECT request_digest, status, expires_at_ms
			FROM demo_model_quota_reservations
			WHERE principal = ? AND request_id = ?
		`).bind(principal, input.requestId).first<{
			request_digest: string;
			status: string;
			expires_at_ms: number;
		}>();
		if (existing) {
			if (existing.request_digest !== requestDigest) {
				throw new DemoQuotaError(
					"DEMO_REQUEST_CONFLICT",
					409,
					"The demo request id was already used for different input",
				);
			}
			if (existing.status !== "active" || existing.expires_at_ms <= now) {
				throw new DemoQuotaError(
					"DEMO_REQUEST_CONFLICT",
					409,
					"The existing demo reservation is no longer active",
				);
			}
			throw stateError();
		}
		const priorSession = await this.db.prepare(`
			SELECT wallet_scope_id, network FROM demo_model_quota_reservations
			WHERE principal = ? AND session_scope_id = ? LIMIT 1
		`).bind(principal, input.sessionScopeId).first<{
			wallet_scope_id: string;
			network: string;
		}>();
		if (
			priorSession &&
			(priorSession.wallet_scope_id !== input.walletScopeId ||
				priorSession.network !== input.network)
		) {
			throw new DemoQuotaError(
				"DEMO_MISCONFIGURED",
				400,
				"The session scope does not match its original wallet scope",
			);
		}

		const result = await this.db.prepare(`
			SELECT
				(SELECT COALESCE(SUM(reserved_output_tokens), 0)
				 FROM demo_model_quota_reservations WHERE principal = ?1 AND utc_day = ?5) AS global_used,
				(SELECT COUNT(*) FROM demo_model_quota_reservations
				 WHERE principal = ?1 AND utc_day = ?5) AS global_requests,
				(SELECT COALESCE(SUM(reserved_output_tokens), 0)
				 FROM demo_model_quota_reservations
				 WHERE principal = ?1 AND wallet_scope_id = ?2 AND utc_day = ?5) AS wallet_used,
				(SELECT COALESCE(SUM(reserved_output_tokens), 0)
				 FROM demo_model_quota_reservations
				 WHERE principal = ?1 AND session_scope_id = ?3 AND utc_day = ?5) AS session_used,
				(SELECT COUNT(*) FROM demo_model_quota_reservations
				 WHERE principal = ?1 AND wallet_scope_id = ?2 AND utc_day = ?5) AS wallet_requests,
				(SELECT COUNT(*) FROM demo_model_quota_reservations
				 WHERE principal = ?1 AND session_scope_id = ?3 AND utc_day = ?5) AS session_requests,
				(SELECT COUNT(*) FROM demo_model_quota_reservations
				 WHERE principal = ?1 AND session_scope_id = ?3 AND created_at_ms > ?6) AS rate_requests,
				(SELECT MIN(created_at_ms) FROM demo_model_quota_reservations
				 WHERE principal = ?1 AND session_scope_id = ?3 AND created_at_ms > ?6) AS rate_oldest_ms,
				(SELECT COUNT(*) FROM demo_model_quota_reservations
				 WHERE principal = ?1 AND status = 'active' AND expires_at_ms > ?4) AS global_active,
				(SELECT COUNT(*) FROM demo_model_quota_reservations
				 WHERE principal = ?1 AND status = 'active' AND expires_at_ms > ?4
				 AND (wallet_scope_id = ?2 OR session_scope_id = ?3)) AS wallet_active
		`).bind(
			principal,
			input.walletScopeId,
			input.sessionScopeId,
			now,
			day,
			rateStart,
		).first<DiagnosticRow>();
		if (!result) throw stateError();
		if (result.global_used + this.config.maxOutputTokens > this.config.globalDailyOutputTokens) {
			throw new DemoQuotaError(
				"DEMO_GLOBAL_DAILY_OUTPUT_TOKENS_EXHAUSTED",
				429,
				"The shared free-demo output quota is exhausted for today",
			);
		}
		if (result.global_requests >= this.config.globalDailyRequests) {
			throw new DemoQuotaError(
				"DEMO_GLOBAL_DAILY_REQUESTS_EXHAUSTED",
				429,
				"The shared free-demo request quota is exhausted for today",
			);
		}
		if (
			Math.max(result.wallet_used, result.session_used) + this.config.maxOutputTokens >
			this.config.walletDailyOutputTokens
		) {
			throw new DemoQuotaError(
				"DEMO_WALLET_DAILY_OUTPUT_TOKENS_EXHAUSTED",
				429,
				"The wallet free-demo output quota is exhausted for today",
			);
		}
		if (
			Math.max(result.wallet_requests, result.session_requests) >=
			this.config.walletDailyRequests
		) {
			throw new DemoQuotaError(
				"DEMO_WALLET_DAILY_REQUESTS_EXHAUSTED",
				429,
				"The wallet demo request quota is exhausted for today",
			);
		}
		if (result.rate_requests >= this.config.rateRequests) {
			const retryAfterSeconds = result.rate_oldest_ms === null
				? this.config.rateWindowSeconds
				: Math.max(
					1,
					Math.ceil(
						(result.rate_oldest_ms + this.config.rateWindowSeconds * 1_000 - now) /
							1_000,
					),
				);
			throw new DemoQuotaError(
				"DEMO_RATE_LIMITED",
				429,
				"The demo model rate limit was reached",
				retryAfterSeconds,
			);
		}
		if (result.global_active >= this.config.maxGlobalConcurrency) {
			throw new DemoQuotaError("DEMO_GLOBAL_BUSY", 429, "The shared demo is busy", 1);
		}
		if (result.wallet_active >= this.config.maxWalletConcurrency) {
			throw new DemoQuotaError(
				"DEMO_WALLET_BUSY",
				429,
				"This wallet already has the maximum number of demo requests running",
				1,
			);
		}
		throw stateError();
	}

	async settle(
		principal: string,
		input: DemoQuotaSettleInput,
	): Promise<DemoQuotaSettlement> {
		assertPrincipal(principal, this.config);
		validateSettleInput(input);
		const now = checkedNow(this.now);
		try {
			const results = await this.db.batch([
				this.db.prepare(`
					INSERT INTO demo_model_zero_cost_integrity (principal, tripped_at_ms, failure)
					SELECT ?1, ?2, CASE WHEN ?3 IS NOT NULL THEN ?3 ELSE 'unverified-cost' END
					FROM demo_model_quota_reservations
					WHERE principal = ?1 AND id = ?4
						AND (
							?3 IS NOT NULL OR (
								status = 'active' AND (
									?5 = 'uncertain' OR
									(?6 IS NOT NULL AND ?6 > reserved_output_tokens)
								)
							)
						)
					ON CONFLICT(principal) DO NOTHING
				`).bind(
					principal,
					now,
					input.integrityFailure ?? null,
					input.reservationId,
					input.outcome,
					input.actualOutputTokens ?? null,
				),
				this.db.prepare(`
					UPDATE demo_model_quota_reservations
					SET status = CASE
							WHEN expires_at_ms <= ?3 OR (?6 IS NOT NULL AND ?6 > reserved_output_tokens)
							THEN 'uncertain'
							ELSE ?4
						END,
						settled_at_ms = ?3,
						actual_input_tokens = ?5,
						actual_output_tokens = ?6
					WHERE principal = ?1 AND id = ?2 AND status = 'active'
				`).bind(
					principal,
					input.reservationId,
					now,
					input.outcome,
					input.actualInputTokens ?? null,
					input.actualOutputTokens ?? null,
				),
				this.db.prepare(`
					SELECT id, status FROM demo_model_quota_reservations
					WHERE principal = ? AND id = ?
				`).bind(principal, input.reservationId),
			]);
			const row = firstRow<{ id: string; status: string }>(results[2]);
			if (!row) {
				throw new DemoQuotaError(
					"DEMO_RESERVATION_NOT_FOUND",
					404,
					"The demo model reservation was not found",
				);
			}
			return {
				id: row.id,
				outcome: row.status === "completed" ? "completed" : "uncertain",
				alreadySettled: (results[1]?.meta.changes ?? 0) === 0,
			};
		} catch (error) {
			if (error instanceof DemoQuotaError) throw error;
			throw stateError();
		}
	}

	async status(principal: string): Promise<DemoQuotaStatus> {
		assertPrincipal(principal, this.config);
		try {
			const integrity = await this.db.prepare(`
				SELECT failure FROM demo_model_zero_cost_integrity WHERE principal = ?1
				UNION ALL
				SELECT 'unverified-cost' AS failure
				FROM demo_model_quota_reservations
				WHERE principal = ?1
					AND (status = 'uncertain' OR (status = 'active' AND expires_at_ms <= ?2))
				LIMIT 1
			`).bind(principal, checkedNow(this.now)).first<{ failure: string }>();
			if (integrity) {
				throw new DemoQuotaError(
					"DEMO_ZERO_COST_INTEGRITY_BLOCKED",
					503,
					"Free demo access is paused after a zero-cost integrity check failed",
				);
			}
			return {
				available: true,
				policyVersion: this.config.policyVersion,
				costPolicy: "free-only",
				allowedModels: this.config.allowedModels,
				globalDailyOutputTokens: this.config.globalDailyOutputTokens,
				globalDailyRequests: this.config.globalDailyRequests,
				walletDailyOutputTokens: this.config.walletDailyOutputTokens,
				walletDailyRequests: this.config.walletDailyRequests,
				rateWindowSeconds: this.config.rateWindowSeconds,
				rateRequests: this.config.rateRequests,
				maxGlobalConcurrency: this.config.maxGlobalConcurrency,
				maxWalletConcurrency: this.config.maxWalletConcurrency,
				reservationTtlSeconds: this.config.reservationTtlSeconds,
				abortGraceSeconds: this.config.abortGraceSeconds,
				maxInputBytes: this.config.maxInputBytes,
				maxOutputTokens: this.config.maxOutputTokens,
				maxSteps: this.config.maxSteps,
			};
		} catch (error) {
			if (error instanceof DemoQuotaError) throw error;
			throw stateError();
		}
	}
}
