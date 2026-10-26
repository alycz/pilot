import {
	HOSTED_STATE_MAX_ROWS,
	HOSTED_STATE_MAX_PERSONALIZATION_ROWS,
	HOSTED_STATE_MAX_SESSION_BINDINGS,
	HOSTED_STATE_PROOF_MAX_FUTURE_MS,
	HOSTED_STATE_RESEARCH_RETENTION_MS,
	HOSTED_STATE_RESEARCH_WINDOW_MS,
	HOSTED_STATE_SESSION_MAX_FUTURE_MS,
	HostedStateError,
	type HostedStateConfig,
	type PersonalizationCompareAndSwapInput,
	type PersonalizationDeleteInput,
	type PersonalizationReadInput,
	type ResearchQuotaReservationInput,
	type WalletProofConsumeInput,
} from "./contracts";

type Dependencies = Readonly<{ now?: () => number }>;
type QuotaRow = Readonly<{
	request_digest: string;
	window_expires_at_ms: number;
	remaining_account_runs: number;
	remaining_session_runs: number;
}>;

function unavailable(message = "Hosted state is temporarily unavailable"): HostedStateError {
	return new HostedStateError("HOSTED_STATE_UNAVAILABLE", 503, message);
}
function conflict(message: string): HostedStateError {
	return new HostedStateError("HOSTED_STATE_REQUEST_CONFLICT", 409, message);
}
function changes(result: D1Result<unknown> | undefined): number {
	return Number(result?.meta.changes ?? 0);
}
function lowercaseHex(bytes: ArrayBuffer): string {
	return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

export class D1HostedStateStore {
	readonly #now: () => number;
	constructor(
		readonly database: D1Database,
		readonly config: HostedStateConfig,
		dependencies: Dependencies = {},
	) {
		this.#now = dependencies.now ?? Date.now;
	}

	async consumeWalletProof(principal: string, input: WalletProofConsumeInput): Promise<{ consumed: boolean }> {
		const now = this.#authoritativeNow();
		if (input.expiresAtMs <= now || input.expiresAtMs > now + HOSTED_STATE_PROOF_MAX_FUTURE_MS) {
			throw conflict("Wallet proof expiry is stale or outside the accepted clock window");
		}
		try {
			if (input.namespace === "near-wallet-auth") {
				const results = await this.database.batch([
					this.#clockStatement(principal, now),
					this.database.prepare("DELETE FROM pilot_near_wallet_proof_consumptions WHERE principal = ? AND expires_at_ms <= ?").bind(principal, now),
					this.database.prepare(`
						INSERT INTO pilot_near_wallet_proof_consumptions
							(principal, scope_id, nonce_digest, expires_at_ms, created_at_ms)
						SELECT ?, ?, ?, ?, ?
						WHERE EXISTS (SELECT 1 FROM pilot_hosted_state_clock WHERE principal = ? AND observed_at_ms = ?)
						AND (SELECT COUNT(*) FROM pilot_near_wallet_proof_consumptions WHERE principal = ?) < ?
						ON CONFLICT DO NOTHING
					`).bind(principal, input.scopeId, input.nonceDigest, input.expiresAtMs,
						now, principal, now, principal, HOSTED_STATE_MAX_ROWS),
				]);
				if (changes(results[0]) === 0) throw unavailable("Hosted state clock moved backwards");
				if (changes(results[2]) === 1) return { consumed: true };
				const duplicate = await this.database.prepare(`
					SELECT 1 AS found FROM pilot_near_wallet_proof_consumptions
					WHERE principal = ? AND scope_id = ? AND nonce_digest = ?
				`).bind(principal, input.scopeId, input.nonceDigest).first<{ found: number }>();
				if (duplicate?.found === 1) return { consumed: false };
				throw unavailable("Hosted NEAR wallet-proof capacity is unavailable");
			}
			const results = await this.database.batch([
				this.#clockStatement(principal, now),
				this.database.prepare("DELETE FROM pilot_wallet_proof_consumptions WHERE principal = ? AND expires_at_ms <= ?").bind(principal, now),
				this.database.prepare(`
					INSERT INTO pilot_wallet_proof_consumptions
						(principal, namespace, scope_id, nonce_digest, expires_at_ms, created_at_ms)
					SELECT ?, ?, ?, ?, ?, ?
					WHERE EXISTS (SELECT 1 FROM pilot_hosted_state_clock WHERE principal = ? AND observed_at_ms = ?)
					AND (SELECT COUNT(*) FROM pilot_wallet_proof_consumptions WHERE principal = ?) < ?
					ON CONFLICT DO NOTHING
				`).bind(principal, input.namespace, input.scopeId, input.nonceDigest,
					input.expiresAtMs, now, principal, now, principal, HOSTED_STATE_MAX_ROWS),
			]);
			if (changes(results[0]) === 0) throw unavailable("Hosted state clock moved backwards");
			if (changes(results[2]) === 1) return { consumed: true };
			const duplicate = await this.database.prepare(`
				SELECT 1 AS found FROM pilot_wallet_proof_consumptions
				WHERE principal = ? AND namespace = ? AND scope_id = ? AND nonce_digest = ?
			`).bind(principal, input.namespace, input.scopeId, input.nonceDigest).first<{ found: number }>();
			if (duplicate?.found === 1) return { consumed: false };
			throw unavailable("Hosted wallet-proof capacity is unavailable");
		} catch (error) {
			if (error instanceof HostedStateError) throw error;
			throw unavailable();
		}
	}

	async readPersonalization(principal: string, input: PersonalizationReadInput): Promise<{
		ciphertext: string | null; contentDigest: string | null;
	}> {
		try {
			const row = await this.database.prepare(`
				SELECT ciphertext, content_digest FROM pilot_personalization_state
				WHERE principal = ? AND scope_id = ? AND resource = ?
			`).bind(principal, input.scopeId, input.resource)
				.first<{ ciphertext: string; content_digest: string }>();
			return row ? { ciphertext: row.ciphertext, contentDigest: row.content_digest }
				: { ciphertext: null, contentDigest: null };
		} catch {
			throw unavailable();
		}
	}

	async compareAndSwapPersonalization(
		principal: string,
		input: PersonalizationCompareAndSwapInput,
	): Promise<{ swapped: boolean }> {
		const now = this.#authoritativeNow();
		try {
			const statement = input.expectedDigest === null
				? this.database.prepare(`
					INSERT INTO pilot_personalization_state
						(principal, scope_id, resource, content_digest, ciphertext, updated_at_ms)
					SELECT ?, ?, ?, ?, ?, ?
					WHERE (SELECT COUNT(*) FROM pilot_personalization_state WHERE principal = ?) < ?
					ON CONFLICT DO NOTHING
				`).bind(principal, input.scopeId, input.resource, input.contentDigest,
					input.ciphertext, now, principal, HOSTED_STATE_MAX_PERSONALIZATION_ROWS)
				: this.database.prepare(`
					UPDATE pilot_personalization_state
					SET content_digest = ?, ciphertext = ?, updated_at_ms = ?
					WHERE principal = ? AND scope_id = ? AND resource = ? AND content_digest = ?
				`).bind(input.contentDigest, input.ciphertext, now, principal, input.scopeId,
					input.resource, input.expectedDigest);
			if (changes(await statement.run()) === 1) return { swapped: true };
			if (input.expectedDigest !== null) return { swapped: false };
			const existing = await this.database.prepare(`
				SELECT 1 AS found FROM pilot_personalization_state
				WHERE principal = ? AND scope_id = ? AND resource = ?
			`).bind(principal, input.scopeId, input.resource).first<{ found: number }>();
			if (existing?.found === 1) return { swapped: false };
			const count = await this.database.prepare(`
				SELECT COUNT(*) AS value FROM pilot_personalization_state WHERE principal = ?
			`).bind(principal).first<{ value: number }>();
			if (!count || count.value >= HOSTED_STATE_MAX_PERSONALIZATION_ROWS) {
				throw unavailable("Hosted personalization capacity is unavailable");
			}
			return { swapped: false };
		} catch (error) {
			if (error instanceof HostedStateError) throw error;
			throw unavailable();
		}
	}

	async deletePersonalization(
		principal: string,
		input: PersonalizationDeleteInput,
	): Promise<{ deleted: boolean }> {
		try {
			const result = await this.database.prepare(`
				DELETE FROM pilot_personalization_state
				WHERE principal = ? AND scope_id = ? AND resource = ? AND content_digest = ?
			`).bind(principal, input.scopeId, input.resource, input.expectedDigest).run();
			return { deleted: changes(result) === 1 };
		} catch {
			throw unavailable();
		}
	}

	async reserveResearchQuota(principal: string, input: ResearchQuotaReservationInput): Promise<{
		reserved: true; idempotent: boolean; policyVersion: string; windowExpiresAtMs: number;
		remainingAccountRuns: number; remainingSessionRuns: number;
	}> {
		this.#assertPolicy(input);
		const now = this.#authoritativeNow();
		if (input.sessionExpiresAtMs <= now || input.sessionExpiresAtMs > now + HOSTED_STATE_SESSION_MAX_FUTURE_MS) {
			throw conflict("Research session expiry is stale or outside the accepted clock window");
		}
		const digest = await this.#quotaDigest(input);
		const windowStart = Math.floor(now / HOSTED_STATE_RESEARCH_WINDOW_MS) * HOSTED_STATE_RESEARCH_WINDOW_MS;
		const windowExpires = windowStart + HOSTED_STATE_RESEARCH_WINDOW_MS;
		const retainUntil = windowExpires + HOSTED_STATE_RESEARCH_RETENTION_MS;
		try {
			const results = await this.database.batch([
				this.#clockStatement(principal, now),
				this.database.prepare(`DELETE FROM pilot_research_quota_reservations WHERE principal = ? AND retain_until_ms <= ?`).bind(principal, now),
				this.database.prepare(`
					DELETE FROM pilot_research_quota_session_bindings
					WHERE principal = ? AND session_expires_at_ms <= ?
					AND NOT EXISTS (
						SELECT 1 FROM pilot_research_quota_reservations
						WHERE pilot_research_quota_reservations.principal = pilot_research_quota_session_bindings.principal
						AND pilot_research_quota_reservations.session_scope_id = pilot_research_quota_session_bindings.session_scope_id
					)
				`).bind(principal, now),
				this.database.prepare(`
					INSERT OR IGNORE INTO pilot_research_quota_policy
						(principal, policy_version, account_maximum, session_maximum, window_ms, retention_ms, max_active_reservations)
					VALUES (?, ?, ?, ?, ?, ?, ?)
				`).bind(principal, this.config.researchPolicyVersion, this.config.researchAccountMaximum,
					this.config.researchSessionMaximum, HOSTED_STATE_RESEARCH_WINDOW_MS,
					HOSTED_STATE_RESEARCH_RETENTION_MS, HOSTED_STATE_MAX_ROWS),
				this.database.prepare(`
					INSERT OR IGNORE INTO pilot_research_quota_session_bindings
						(principal, session_scope_id, account_scope_id, network, session_expires_at_ms)
					SELECT ?, ?, ?, ?, ?
					WHERE NOT EXISTS (
						SELECT 1 FROM pilot_research_quota_reservations
						WHERE principal = ? AND request_id = ?
					)
					AND EXISTS (SELECT 1 FROM pilot_hosted_state_clock
						WHERE principal = ? AND observed_at_ms = ?)
					AND EXISTS (SELECT 1 FROM pilot_research_quota_policy
						WHERE principal = ? AND policy_version = ? AND account_maximum = ?
						AND session_maximum = ? AND window_ms = ? AND retention_ms = ?
						AND max_active_reservations = ?)
					AND (EXISTS (SELECT 1 FROM pilot_research_quota_session_bindings
						WHERE principal = ? AND session_scope_id = ? AND account_scope_id = ?
						AND network = ? AND session_expires_at_ms = ?)
						OR (NOT EXISTS (SELECT 1 FROM pilot_research_quota_session_bindings
							WHERE principal = ? AND session_scope_id = ?)
							AND (SELECT COUNT(*) FROM pilot_research_quota_session_bindings
								WHERE principal = ?) < ?))
					AND (SELECT COUNT(*) FROM pilot_research_quota_reservations WHERE principal = ?) < ?
					AND (SELECT COUNT(*) FROM pilot_research_quota_reservations
						WHERE principal = ? AND account_scope_id = ? AND window_start_ms = ?) < ?
					AND (SELECT COUNT(*) FROM pilot_research_quota_reservations
						WHERE principal = ? AND session_scope_id = ? AND window_start_ms = ?) < ?
				`).bind(principal, input.sessionScopeId, input.accountScopeId, input.network,
					input.sessionExpiresAtMs,
					principal, input.requestId,
					principal, now,
					principal, this.config.researchPolicyVersion, this.config.researchAccountMaximum,
					this.config.researchSessionMaximum, HOSTED_STATE_RESEARCH_WINDOW_MS,
					HOSTED_STATE_RESEARCH_RETENTION_MS, HOSTED_STATE_MAX_ROWS,
					principal, input.sessionScopeId, input.accountScopeId, input.network, input.sessionExpiresAtMs,
					principal, input.sessionScopeId, principal, HOSTED_STATE_MAX_SESSION_BINDINGS,
					principal, HOSTED_STATE_MAX_ROWS,
					principal, input.accountScopeId, windowStart, this.config.researchAccountMaximum,
					principal, input.sessionScopeId, windowStart, this.config.researchSessionMaximum),
				this.#quotaInsert(principal, input, digest, now, windowStart, windowExpires, retainUntil),
			]);
			if (changes(results[0]) === 0) throw unavailable("Hosted state clock moved backwards");
			const row = await this.database.prepare(`
				SELECT request_digest, window_expires_at_ms, remaining_account_runs, remaining_session_runs
				FROM pilot_research_quota_reservations WHERE principal = ? AND request_id = ?
			`).bind(principal, input.requestId).first<QuotaRow>();
			if (row) {
				if (row.request_digest !== digest) throw conflict("Research reservation identifier was reused with different input");
				return {
					reserved: true, idempotent: changes(results[5]) === 0,
					policyVersion: this.config.researchPolicyVersion,
					windowExpiresAtMs: row.window_expires_at_ms,
					remainingAccountRuns: row.remaining_account_runs,
					remainingSessionRuns: row.remaining_session_runs,
				};
			}
			await this.#diagnoseQuotaFailure(principal, input, now, windowStart);
			throw unavailable();
		} catch (error) {
			if (error instanceof HostedStateError) throw error;
			throw unavailable();
		}
	}

	#authoritativeNow(): number {
		const value = this.#now();
		if (!Number.isSafeInteger(value) || value < 0) throw unavailable("Hosted state clock is invalid");
		return value;
	}

	#assertPolicy(input: ResearchQuotaReservationInput): void {
		if (
			input.policyVersion !== this.config.researchPolicyVersion ||
			input.accountMaximum !== this.config.researchAccountMaximum ||
			input.sessionMaximum !== this.config.researchSessionMaximum
		) {
			throw unavailable("Research quota policy does not match the authoritative policy");
		}
	}

	#clockStatement(principal: string, now: number): D1PreparedStatement {
		return this.database.prepare(`
			INSERT INTO pilot_hosted_state_clock (principal, observed_at_ms) VALUES (?, ?)
			ON CONFLICT(principal) DO UPDATE SET observed_at_ms = excluded.observed_at_ms
			WHERE pilot_hosted_state_clock.observed_at_ms <= excluded.observed_at_ms
		`).bind(principal, now);
	}

	async #quotaDigest(input: ResearchQuotaReservationInput): Promise<string> {
		const canonical = JSON.stringify({
			version: input.version, requestId: input.requestId,
			accountScopeId: input.accountScopeId, sessionScopeId: input.sessionScopeId,
			network: input.network, sessionExpiresAtMs: input.sessionExpiresAtMs,
			policyVersion: input.policyVersion, accountMaximum: input.accountMaximum,
			sessionMaximum: input.sessionMaximum,
		});
		return lowercaseHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
	}

	#quotaInsert(
		principal: string,
		input: ResearchQuotaReservationInput,
		digest: string,
		now: number,
		windowStart: number,
		windowExpires: number,
		retainUntil: number,
	): D1PreparedStatement {
		return this.database.prepare(`
			INSERT INTO pilot_research_quota_reservations
				(principal, request_id, request_digest, account_scope_id, session_scope_id, network,
				 window_start_ms, window_expires_at_ms, retain_until_ms, created_at_ms,
				 remaining_account_runs, remaining_session_runs)
			SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
				? - 1 - (SELECT COUNT(*) FROM pilot_research_quota_reservations
					WHERE principal = ? AND account_scope_id = ? AND window_start_ms = ?),
				? - 1 - (SELECT COUNT(*) FROM pilot_research_quota_reservations
					WHERE principal = ? AND session_scope_id = ? AND window_start_ms = ?)
			WHERE EXISTS (SELECT 1 FROM pilot_hosted_state_clock WHERE principal = ? AND observed_at_ms = ?)
			AND EXISTS (SELECT 1 FROM pilot_research_quota_policy
				WHERE principal = ? AND policy_version = ? AND account_maximum = ? AND session_maximum = ?
				AND window_ms = ? AND retention_ms = ? AND max_active_reservations = ?)
			AND EXISTS (SELECT 1 FROM pilot_research_quota_session_bindings
				WHERE principal = ? AND session_scope_id = ? AND account_scope_id = ?
				AND network = ? AND session_expires_at_ms = ? AND session_expires_at_ms > ?)
			AND (SELECT COUNT(*) FROM pilot_research_quota_reservations WHERE principal = ?) < ?
			AND (SELECT COUNT(*) FROM pilot_research_quota_reservations
				WHERE principal = ? AND account_scope_id = ? AND window_start_ms = ?) < ?
			AND (SELECT COUNT(*) FROM pilot_research_quota_reservations
				WHERE principal = ? AND session_scope_id = ? AND window_start_ms = ?) < ?
			ON CONFLICT DO NOTHING
		`).bind(
			principal, input.requestId, digest, input.accountScopeId, input.sessionScopeId, input.network,
			windowStart, windowExpires, retainUntil, now,
			this.config.researchAccountMaximum, principal, input.accountScopeId, windowStart,
			this.config.researchSessionMaximum, principal, input.sessionScopeId, windowStart,
			principal, now,
			principal, this.config.researchPolicyVersion, this.config.researchAccountMaximum,
			this.config.researchSessionMaximum, HOSTED_STATE_RESEARCH_WINDOW_MS,
			HOSTED_STATE_RESEARCH_RETENTION_MS, HOSTED_STATE_MAX_ROWS,
			principal, input.sessionScopeId, input.accountScopeId, input.network, input.sessionExpiresAtMs, now,
			principal, HOSTED_STATE_MAX_ROWS,
			principal, input.accountScopeId, windowStart, this.config.researchAccountMaximum,
			principal, input.sessionScopeId, windowStart, this.config.researchSessionMaximum,
		);
	}

	async #diagnoseQuotaFailure(
		principal: string,
		input: ResearchQuotaReservationInput,
		now: number,
		windowStart: number,
	): Promise<never> {
		const policy = await this.database.prepare(`
			SELECT policy_version, account_maximum, session_maximum FROM pilot_research_quota_policy
			WHERE principal = ?
		`).bind(principal).first<{ policy_version: string; account_maximum: number; session_maximum: number }>();
		if (!policy || policy.policy_version !== this.config.researchPolicyVersion ||
			policy.account_maximum !== this.config.researchAccountMaximum ||
			policy.session_maximum !== this.config.researchSessionMaximum) {
			throw unavailable("Stored research quota policy does not match configuration");
		}
		const binding = await this.database.prepare(`
			SELECT account_scope_id, network, session_expires_at_ms
			FROM pilot_research_quota_session_bindings WHERE principal = ? AND session_scope_id = ?
		`).bind(principal, input.sessionScopeId)
			.first<{ account_scope_id: string; network: string; session_expires_at_ms: number }>();
		if (binding && (binding.account_scope_id !== input.accountScopeId || binding.network !== input.network ||
			binding.session_expires_at_ms !== input.sessionExpiresAtMs || binding.session_expires_at_ms <= now)) {
			throw conflict("Research session binding is stale or conflicts with existing state");
		}
		const counts = await this.database.prepare(`
			SELECT
				(SELECT COUNT(*) FROM pilot_research_quota_reservations
				 WHERE principal = ? AND account_scope_id = ? AND window_start_ms = ?) AS account_count,
				(SELECT COUNT(*) FROM pilot_research_quota_reservations
				 WHERE principal = ? AND session_scope_id = ? AND window_start_ms = ?) AS session_count,
				(SELECT COUNT(*) FROM pilot_research_quota_reservations WHERE principal = ?) AS total_count
		`).bind(principal, input.accountScopeId, windowStart,
			principal, input.sessionScopeId, windowStart, principal)
			.first<{ account_count: number; session_count: number; total_count: number }>();
		if (!counts || counts.total_count >= HOSTED_STATE_MAX_ROWS) throw unavailable("Research quota capacity is unavailable");
		if (counts.account_count >= this.config.researchAccountMaximum ||
			counts.session_count >= this.config.researchSessionMaximum) {
			const windowExpires = windowStart + HOSTED_STATE_RESEARCH_WINDOW_MS;
			throw new HostedStateError("HOSTED_STATE_QUOTA_EXHAUSTED", 429,
				"Research quota is exhausted", Math.max(1, Math.ceil((windowExpires - now) / 1_000)));
		}
		if (!binding) {
			const bindingCount = await this.database.prepare(`
				SELECT COUNT(*) AS value FROM pilot_research_quota_session_bindings WHERE principal = ?
			`).bind(principal).first<{ value: number }>();
			if (!bindingCount || bindingCount.value >= HOSTED_STATE_MAX_SESSION_BINDINGS) {
				throw unavailable("Research session-binding capacity is unavailable");
			}
			throw conflict("Research session binding is stale or conflicts with existing state");
		}
		throw unavailable();
	}
}
