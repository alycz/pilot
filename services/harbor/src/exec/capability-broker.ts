import { isValidClassicAddress } from 'xrpl';

import type { CapabilitySecretResolver } from './capability-mock-secret-store';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;
const DIGEST = /^[a-f0-9]{64}$/;
const REFERENCE = /^cap_v1_[A-Za-z0-9_-]{32,128}$/;
const FORBIDDEN_PROXY_KEY = /^(?:url|uri|host|hostname|method|headers?|authorization|cookie|token|credential|secret)$/i;
const MAX_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_JSON_NODES = 2_000;
const MAX_OUTPUT_BYTES = 64 * 1_024;
// Count caps are deliberately below the 2 MiB D1 snapshot ceiling even when
// every retained receipt contains the maximum 64 KiB projected output.
const MAX_GRANTS = 32;
const MAX_RECEIPTS = 16;
const DEFAULT_RESOLVER_TIMEOUT_MS = 5_000;
const DEFAULT_ADAPTER_TIMEOUT_MS = 10_000;
// Resolver plus adapter deadlines remain below the local D1 30-second lease.
const MAX_TIMEOUT_MS = 10_000;

export type CapabilityAmount = Readonly<{ unit: string; value: string }>;
export type CapabilityRateLimit = Readonly<{ windowSeconds: number; maxCalls: number }>;
export type CapabilityNetwork = 'testnet';

export type CapabilityGrantRequest = Readonly<{
	principal: string;
	account: string;
	network: CapabilityNetwork;
	service: string;
	operation: string;
	amount: CapabilityAmount;
	destination: string;
	notBefore: string;
	expiresAt: string;
	maxUses: number;
	rateLimit: CapabilityRateLimit;
}>;

export type VerifiedCapabilityApproval = Readonly<{
	approvalId: string;
	account: string;
	digest: string;
	approvedAt: string;
	expiresAt: string;
	/**
	 * Evidence supplied by the account-signature verifier. This is runtime
	 * provenance, not hardware attestation: a valid signature proves control of
	 * the account key and Speculos can produce the same signature shape.
	 */
	evidence: Readonly<{
		method: 'verified-account-signature';
		runtime: 'ledger-webhid' | 'speculos' | 'other-wallet';
		physicalDeviceInferred: false;
	}>;
}>;

export type CapabilityGrantView = Readonly<{
	capabilityRef: string;
	principal: string;
	account: string;
	network: CapabilityNetwork;
	service: string;
	operation: string;
	amount: CapabilityAmount;
	destination: string;
	notBefore: string;
	expiresAt: string;
	maxUses: number;
	uses: number;
	rateLimit: CapabilityRateLimit;
	generation: number;
	state: 'prepared' | 'active' | 'revoked' | 'expired';
	approvalDigest: string;
}>;

export type CapabilityAdapterResult =
	| Readonly<{ outcome: 'completed'; data: unknown }>
	| Readonly<{ outcome: 'unknown' }>;

export interface CapabilityServiceAdapter<TInput = unknown> {
	readonly service: string;
	readonly operation: string;
	parseInput(input: unknown): TInput;
	/** Project untrusted upstream output into this adapter's fixed public schema. */
	parseOutput(output: unknown): unknown;
	dispatch(input: Readonly<{
		secret: string;
		requestId: string;
		principal: string;
		account: string;
		amount: CapabilityAmount;
		destination: string;
		input: TInput;
		signal: AbortSignal;
	}>): Promise<CapabilityAdapterResult>;
}

export class CapabilityAdapterRegistry {
	readonly #adapters = new Map<string, CapabilityServiceAdapter>();

	constructor(adapters: readonly CapabilityServiceAdapter[]) {
		for (const adapter of adapters) {
			assertIdentifier(adapter.service, 'service');
			assertIdentifier(adapter.operation, 'operation');
			const key = adapterKey(adapter.service, adapter.operation);
			if (this.#adapters.has(key)) throw new TypeError('Duplicate capability adapter');
			this.#adapters.set(key, Object.freeze(adapter));
		}
	}

	require(service: string, operation: string): CapabilityServiceAdapter {
		const adapter = this.#adapters.get(adapterKey(service, operation));
		if (!adapter) throw new CapabilityBrokerError('CAPABILITY_SCOPE_DENIED');
		return adapter;
	}
}

export class CapabilityBrokerError extends Error {
	constructor(readonly code:
		| 'CAPABILITY_DISABLED'
		| 'CAPABILITY_INVALID'
		| 'CAPABILITY_NOT_FOUND'
		| 'CAPABILITY_APPROVAL_MISMATCH'
		| 'CAPABILITY_SCOPE_DENIED'
		| 'CAPABILITY_NOT_ACTIVE'
		| 'CAPABILITY_EXPIRED'
		| 'CAPABILITY_USE_LIMIT'
		| 'CAPABILITY_RATE_LIMIT'
		| 'CAPABILITY_REPLAY_CONFLICT'
		| 'CAPABILITY_SECRET_UNAVAILABLE'
		| 'CAPABILITY_TIMEOUT'
		| 'CAPABILITY_CAPACITY') {
		super(code);
		this.name = 'CapabilityBrokerError';
	}
}

export type CapabilityInvocation = Readonly<{
	capabilityRef: string;
	requestId: string;
	principal: string;
	account: string;
	network: CapabilityNetwork;
	service: string;
	operation: string;
	amount: CapabilityAmount;
	destination: string;
	generation: number;
	input: unknown;
}>;

export type CapabilityInvocationResult = Readonly<{
	capabilityRef: string;
	requestId: string;
	generation: number;
	status: 'completed' | 'unknown';
	replayed: boolean;
	data?: unknown;
}>;

export type CapabilityAuditEvent = Readonly<{
	kind: 'prepared' | 'activated' | 'reserved' | 'completed' | 'unknown' | 'revoked';
	capabilityRef: string;
	requestId?: string;
	generation: number;
	at: string;
}>;

type StoredGrant = {
	view: CapabilityGrantView;
	secretHandle: string;
	createdAt: string;
	activation?: VerifiedCapabilityApproval;
	revocation?: VerifiedCapabilityApproval;
	pendingRevocation?: { generation: number; digest: string };
	rateEvents: Array<{ requestId: string; at: number }>;
};

type StoredReceipt = {
	digest: string;
	result?: CapabilityInvocationResult;
	pending?: Promise<CapabilityInvocationResult>;
};

export type CapabilityBrokerSnapshot = Readonly<{
	version: 1;
	grants: readonly Readonly<{
		view: CapabilityGrantView;
		secretHandle: string;
		createdAt: string;
		activation?: VerifiedCapabilityApproval;
		revocation?: VerifiedCapabilityApproval;
		pendingRevocation?: Readonly<{ generation: number; digest: string }>;
		rateEvents: readonly Readonly<{ requestId: string; at: number }>[];
	}>[];
	receipts: readonly Readonly<{
		capabilityRef: string;
		requestId: string;
		digest: string;
		result?: CapabilityInvocationResult;
	}>[];
}>;

export type CapabilityBrokerOptions = Readonly<{
	mode?: 'disabled' | 'mock';
	resolver?: CapabilitySecretResolver;
	registry?: CapabilityAdapterRegistry;
	now?: () => Date;
	randomReference?: () => string;
	audit?: (event: CapabilityAuditEvent) => void;
	snapshot?: CapabilityBrokerSnapshot;
	checkpoint?: () => Promise<void>;
	resolverTimeoutMs?: number;
	adapterTimeoutMs?: number;
	maxGrants?: number;
	maxReceipts?: number;
}>;

function adapterKey(service: string, operation: string): string {
	return `${service}\0${operation}`;
}

function assertIdentifier(value: string, _label: string): void {
	if (typeof value !== 'string' || !IDENTIFIER.test(value) || value.includes('://')) {
		throw new CapabilityBrokerError('CAPABILITY_INVALID');
	}
}

function timestamp(value: string, _label: string): number {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
		throw new CapabilityBrokerError('CAPABILITY_INVALID');
	}
	return parsed;
}

function exactAmount(value: CapabilityAmount): CapabilityAmount {
	if (!value || typeof value !== 'object' || Array.isArray(value) ||
		Object.keys(value).sort().join(',') !== 'unit,value') {
		throw new CapabilityBrokerError('CAPABILITY_INVALID');
	}
	assertIdentifier(value.unit, 'amount unit');
	if (!DECIMAL.test(value.value)) throw new CapabilityBrokerError('CAPABILITY_INVALID');
	return Object.freeze({ unit: value.unit, value: value.value });
}

function canonicalJson(value: unknown): string {
	let nodes = 0;
	const visit = (entry: unknown): string => {
		nodes += 1;
		if (nodes > MAX_JSON_NODES) throw new CapabilityBrokerError('CAPABILITY_INVALID');
		if (entry === null || typeof entry === 'boolean' || typeof entry === 'string') return JSON.stringify(entry);
		if (typeof entry === 'number' && Number.isFinite(entry)) return JSON.stringify(entry);
		if (Array.isArray(entry)) return `[${entry.map(visit).join(',')}]`;
		if (typeof entry !== 'object') throw new CapabilityBrokerError('CAPABILITY_INVALID');
		const record = entry as Record<string, unknown>;
		const prototype = Object.getPrototypeOf(record);
		if (prototype !== Object.prototype && prototype !== null) throw new CapabilityBrokerError('CAPABILITY_INVALID');
		const keys = Object.keys(record).sort();
		if (keys.some((key) => key === '__proto__' || key === 'constructor' || key === 'prototype')) {
			throw new CapabilityBrokerError('CAPABILITY_INVALID');
		}
		return `{${keys.map((key) => `${JSON.stringify(key)}:${visit(record[key])}`).join(',')}}`;
	};
	return visit(value);
}

function assertNoProxyControls(value: unknown): void {
	const pending: unknown[] = [value];
	let visited = 0;
	while (pending.length > 0) {
		const current = pending.pop();
		visited += 1;
		if (visited > MAX_JSON_NODES) throw new CapabilityBrokerError('CAPABILITY_INVALID');
		if (typeof current === 'string') {
			if (current.includes('://') || current.startsWith('//')) throw new CapabilityBrokerError('CAPABILITY_SCOPE_DENIED');
			continue;
		}
		if (current === null || typeof current !== 'object') continue;
		if (Array.isArray(current)) {
			pending.push(...current);
			continue;
		}
		for (const [key, child] of Object.entries(current)) {
			if (FORBIDDEN_PROXY_KEY.test(key)) throw new CapabilityBrokerError('CAPABILITY_SCOPE_DENIED');
			pending.push(child);
		}
	}
}

async function sha256(value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(canonicalJson(value));
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
	const selected = value ?? fallback;
	if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
		throw new CapabilityBrokerError('CAPABILITY_INVALID');
	}
	return selected;
}

class CapabilityTimeoutError extends Error {
	constructor() {
		super('Capability operation timed out');
		this.name = 'CapabilityTimeoutError';
	}
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			onTimeout?.();
			reject(new CapabilityTimeoutError());
		}, timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function defaultReference(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return `cap_v1_${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}`;
}

function publicView(grant: StoredGrant, now: number): CapabilityGrantView {
	const state = grant.view.state === 'active' && now >= Date.parse(grant.view.expiresAt)
		? 'expired'
		: grant.view.state;
	return Object.freeze({
		...grant.view,
		amount: Object.freeze({ ...grant.view.amount }),
		rateLimit: Object.freeze({ ...grant.view.rateLimit }),
		state,
	});
}

function replaceSecret(value: string, secret: string): string {
	return secret.length > 0 && value.includes(secret) ? value.split(secret).join('[redacted]') : value;
}

function sanitizeOutput(value: unknown, secret: string): unknown {
	let nodes = 0;
	const visit = (entry: unknown): unknown => {
		nodes += 1;
		if (nodes > MAX_JSON_NODES) throw new Error('Adapter output is too large');
		if (typeof entry === 'string') return replaceSecret(entry, secret);
		if (entry === null || typeof entry === 'boolean' || (typeof entry === 'number' && Number.isFinite(entry))) return entry;
		if (Array.isArray(entry)) return entry.map(visit);
		if (typeof entry !== 'object') throw new Error('Adapter output is invalid');
		const result: Record<string, unknown> = Object.create(null);
		for (const [key, child] of Object.entries(entry as Record<string, unknown>)) {
			result[replaceSecret(key, secret)] = visit(child);
		}
		return result;
	};
	const result = visit(value);
	if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_OUTPUT_BYTES) throw new Error('Adapter output is too large');
	return result;
}

function sameAmount(left: CapabilityAmount, right: CapabilityAmount): boolean {
	return left.unit === right.unit && left.value === right.value;
}

export class CapabilityBroker {
	readonly #mode: 'disabled' | 'mock';
	readonly #resolver?: CapabilitySecretResolver;
	readonly #registry: CapabilityAdapterRegistry;
	readonly #now: () => Date;
	readonly #randomReference: () => string;
	readonly #audit?: (event: CapabilityAuditEvent) => void;
	readonly #checkpoint?: () => Promise<void>;
	readonly #resolverTimeoutMs: number;
	readonly #adapterTimeoutMs: number;
	readonly #maxGrants: number;
	readonly #maxReceipts: number;
	readonly #grants = new Map<string, StoredGrant>();
	readonly #receipts = new Map<string, StoredReceipt>();

	constructor(options: CapabilityBrokerOptions = {}) {
		this.#mode = options.mode ?? 'disabled';
		this.#resolver = options.resolver;
		this.#registry = options.registry ?? new CapabilityAdapterRegistry([]);
		this.#now = options.now ?? (() => new Date());
		this.#randomReference = options.randomReference ?? defaultReference;
		this.#audit = options.audit;
		this.#checkpoint = options.checkpoint;
		this.#resolverTimeoutMs = boundedPositiveInteger(
			options.resolverTimeoutMs, DEFAULT_RESOLVER_TIMEOUT_MS, MAX_TIMEOUT_MS,
		);
		this.#adapterTimeoutMs = boundedPositiveInteger(
			options.adapterTimeoutMs, DEFAULT_ADAPTER_TIMEOUT_MS, MAX_TIMEOUT_MS,
		);
		this.#maxGrants = boundedPositiveInteger(options.maxGrants, MAX_GRANTS, MAX_GRANTS);
		this.#maxReceipts = boundedPositiveInteger(options.maxReceipts, MAX_RECEIPTS, MAX_RECEIPTS);
		if (this.#mode === 'mock' && this.#resolver?.kind !== 'mock') {
			throw new CapabilityBrokerError('CAPABILITY_SECRET_UNAVAILABLE');
		}
		if (options.snapshot !== undefined) this.#restore(options.snapshot);
	}

	snapshot(): CapabilityBrokerSnapshot {
		this.#enabled();
		const grants = [...this.#grants.values()].map((grant) => Object.freeze({
			view: publicView(grant, Number.NEGATIVE_INFINITY),
			secretHandle: grant.secretHandle,
			createdAt: grant.createdAt,
			...(grant.activation === undefined ? {} : { activation: Object.freeze({ ...grant.activation }) }),
			...(grant.revocation === undefined ? {} : { revocation: Object.freeze({ ...grant.revocation }) }),
			...(grant.pendingRevocation === undefined ? {} : { pendingRevocation: Object.freeze({ ...grant.pendingRevocation }) }),
			rateEvents: Object.freeze(grant.rateEvents.map((event) => Object.freeze({ ...event }))),
		}));
		const receipts = [...this.#receipts.entries()].map(([key, receipt]) => {
			const separator = key.indexOf('\0');
			return Object.freeze({
				capabilityRef: key.slice(0, separator),
				requestId: key.slice(separator + 1),
				digest: receipt.digest,
				...(receipt.result === undefined ? {} : { result: Object.freeze({ ...receipt.result }) }),
			});
		});
		return Object.freeze({ version: 1, grants: Object.freeze(grants), receipts: Object.freeze(receipts) });
	}

	#enabled(): void {
		if (this.#mode !== 'mock') throw new CapabilityBrokerError('CAPABILITY_DISABLED');
	}

	#date(): Date {
		const value = this.#now();
		if (!Number.isFinite(value.getTime())) throw new CapabilityBrokerError('CAPABILITY_INVALID');
		return value;
	}

	#event(kind: CapabilityAuditEvent['kind'], grant: StoredGrant, requestId?: string, generation = grant.view.generation): void {
		this.#audit?.(Object.freeze({
			kind,
			capabilityRef: grant.view.capabilityRef,
			...(requestId === undefined ? {} : { requestId }),
			generation,
			at: this.#date().toISOString(),
		}));
	}

	async prepareGrant(request: CapabilityGrantRequest, secretHandle: string): Promise<CapabilityGrantView> {
		this.#enabled();
		if (this.#grants.size >= this.#maxGrants) throw new CapabilityBrokerError('CAPABILITY_CAPACITY');
		if (!IDENTIFIER.test(request.principal) || !isValidClassicAddress(request.account)) {
			throw new CapabilityBrokerError('CAPABILITY_INVALID');
		}
		if (request.network !== 'testnet') throw new CapabilityBrokerError('CAPABILITY_INVALID');
		assertIdentifier(request.service, 'service');
		assertIdentifier(request.operation, 'operation');
		assertIdentifier(request.destination, 'destination');
		assertIdentifier(secretHandle, 'secret handle');
		this.#registry.require(request.service, request.operation);
		const amount = exactAmount(request.amount);
		const notBefore = timestamp(request.notBefore, 'notBefore');
		const expiresAt = timestamp(request.expiresAt, 'expiresAt');
		const now = this.#date().getTime();
		if (expiresAt <= notBefore || expiresAt <= now || expiresAt - notBefore > MAX_TTL_MS ||
			!Number.isSafeInteger(request.maxUses) || request.maxUses < 1 || request.maxUses > 100 ||
			!Number.isSafeInteger(request.rateLimit.windowSeconds) || request.rateLimit.windowSeconds < 1 || request.rateLimit.windowSeconds > 3_600 ||
			!Number.isSafeInteger(request.rateLimit.maxCalls) || request.rateLimit.maxCalls < 1 || request.rateLimit.maxCalls > request.maxUses) {
			throw new CapabilityBrokerError('CAPABILITY_INVALID');
		}
		const capabilityRef = this.#randomReference();
		if (!REFERENCE.test(capabilityRef) || this.#grants.has(capabilityRef)) throw new CapabilityBrokerError('CAPABILITY_INVALID');
		const base = {
			capabilityRef,
			principal: request.principal,
			account: request.account,
			network: request.network,
			service: request.service,
			operation: request.operation,
			amount,
			destination: request.destination,
			notBefore: request.notBefore,
			expiresAt: request.expiresAt,
			maxUses: request.maxUses,
			rateLimit: Object.freeze({ ...request.rateLimit }),
			generation: 1,
		};
		const approvalDigest = await sha256({ action: 'capability.grant.v1', ...base });
		const view: CapabilityGrantView = Object.freeze({ ...base, uses: 0, state: 'prepared', approvalDigest });
		const grant: StoredGrant = { view, secretHandle, createdAt: this.#date().toISOString(), rateEvents: [] };
		this.#grants.set(capabilityRef, grant);
		this.#event('prepared', grant);
		return publicView(grant, now);
	}

	activateGrant(capabilityRef: string, approval: VerifiedCapabilityApproval): CapabilityGrantView {
		this.#enabled();
		const grant = this.#require(capabilityRef);
		const now = this.#date().getTime();
		if (grant.view.state === 'active' && grant.activation && canonicalJson(grant.activation) === canonicalJson(approval)) {
			return publicView(grant, now);
		}
		this.#assertApproval(grant, approval, grant.view.approvalDigest, now);
		if (grant.view.state !== 'prepared') throw new CapabilityBrokerError('CAPABILITY_NOT_ACTIVE');
		grant.activation = Object.freeze({ ...approval });
		grant.view = Object.freeze({ ...grant.view, state: 'active' });
		this.#event('activated', grant);
		return publicView(grant, now);
	}

	async prepareRevocation(capabilityRef: string, principal: string, account: string): Promise<Readonly<{ generation: number; approvalDigest: string }>> {
		this.#enabled();
		const grant = this.#requireScoped(capabilityRef, principal, account);
		if (grant.view.state !== 'active') throw new CapabilityBrokerError('CAPABILITY_NOT_ACTIVE');
		const generation = grant.view.generation + 1;
		const preview = Object.freeze({
			generation,
			approvalDigest: await sha256({
				action: 'capability.revoke.v1', capabilityRef, principal, account,
				fromGeneration: grant.view.generation, generation, grantDigest: grant.view.approvalDigest,
			}),
		});
		grant.pendingRevocation = { generation: preview.generation, digest: preview.approvalDigest };
		return preview;
	}

	revoke(input: Readonly<{
		capabilityRef: string;
		principal: string;
		account: string;
		generation: number;
		approvalDigest: string;
		approval: VerifiedCapabilityApproval;
	}>): CapabilityGrantView {
		this.#enabled();
		const grant = this.#requireScoped(input.capabilityRef, input.principal, input.account);
		const now = this.#date().getTime();
		if (grant.view.state === 'revoked' && grant.revocation &&
			input.generation === grant.view.generation && input.approvalDigest === input.approval.digest &&
			canonicalJson(grant.revocation) === canonicalJson(input.approval)) {
			return publicView(grant, now);
		}
		if (input.generation !== grant.view.generation + 1 || !DIGEST.test(input.approvalDigest) ||
			grant.pendingRevocation?.generation !== input.generation || grant.pendingRevocation.digest !== input.approvalDigest) {
			throw new CapabilityBrokerError('CAPABILITY_APPROVAL_MISMATCH');
		}
		this.#assertApproval(grant, input.approval, input.approvalDigest, now);
		grant.revocation = Object.freeze({ ...input.approval });
		delete grant.pendingRevocation;
		grant.view = Object.freeze({ ...grant.view, generation: input.generation, state: 'revoked' });
		this.#event('revoked', grant);
		return publicView(grant, now);
	}

	status(capabilityRef: string, principal: string, account: string): CapabilityGrantView {
		this.#enabled();
		return publicView(this.#requireScoped(capabilityRef, principal, account), this.#date().getTime());
	}

	async invoke(input: CapabilityInvocation): Promise<CapabilityInvocationResult> {
		this.#enabled();
		if (!REQUEST_ID.test(input.requestId)) throw new CapabilityBrokerError('CAPABILITY_INVALID');
		assertNoProxyControls(input.input);
		const grant = this.#requireScoped(input.capabilityRef, input.principal, input.account);
		if (grant.view.network !== input.network || grant.view.service !== input.service || grant.view.operation !== input.operation ||
			!sameAmount(grant.view.amount, exactAmount(input.amount)) || grant.view.destination !== input.destination) {
			throw new CapabilityBrokerError('CAPABILITY_SCOPE_DENIED');
		}
		const adapter = this.#registry.require(input.service, input.operation);
		let parsedInput: unknown;
		try {
			parsedInput = adapter.parseInput(input.input);
		} catch {
			throw new CapabilityBrokerError('CAPABILITY_INVALID');
		}
		assertNoProxyControls(parsedInput);
		const normalizedInput: unknown = JSON.parse(canonicalJson(parsedInput));
		const requestDigest = await sha256({ ...input, input: normalizedInput });
		const receiptKey = `${input.capabilityRef}\0${input.requestId}`;
		const existing = this.#receipts.get(receiptKey);
		if (existing) {
			if (existing.digest !== requestDigest) throw new CapabilityBrokerError('CAPABILITY_REPLAY_CONFLICT');
			if (existing.result) return Object.freeze({ ...existing.result, replayed: true });
			if (existing.pending) return existing.pending.then((result) => Object.freeze({ ...result, replayed: true }));
			const uncertain: CapabilityInvocationResult = Object.freeze({
				capabilityRef: input.capabilityRef,
				requestId: input.requestId,
				generation: input.generation,
				status: 'unknown',
				replayed: false,
			});
			existing.result = uncertain;
			this.#event('unknown', grant, input.requestId, input.generation);
			await this.#checkpoint?.();
			return Object.freeze({ ...uncertain, replayed: true });
		}
		if (this.#receipts.size >= this.#maxReceipts) throw new CapabilityBrokerError('CAPABILITY_CAPACITY');
		if (grant.view.generation !== input.generation) throw new CapabilityBrokerError('CAPABILITY_SCOPE_DENIED');

		const now = this.#date().getTime();
		if (grant.view.state !== 'active') throw new CapabilityBrokerError('CAPABILITY_NOT_ACTIVE');
		if (now < Date.parse(grant.view.notBefore) || now >= Date.parse(grant.view.expiresAt)) {
			throw new CapabilityBrokerError('CAPABILITY_EXPIRED');
		}
		if (grant.view.uses >= grant.view.maxUses) throw new CapabilityBrokerError('CAPABILITY_USE_LIMIT');
		const windowStart = now - grant.view.rateLimit.windowSeconds * 1_000;
		grant.rateEvents = grant.rateEvents.filter((event) => event.at > windowStart);
		if (grant.rateEvents.length >= grant.view.rateLimit.maxCalls) throw new CapabilityBrokerError('CAPABILITY_RATE_LIMIT');

		grant.rateEvents.push({ requestId: input.requestId, at: now });
		grant.view = Object.freeze({ ...grant.view, uses: grant.view.uses + 1 });
		const receipt: StoredReceipt = { digest: requestDigest };
		this.#receipts.set(receiptKey, receipt);
		this.#event('reserved', grant, input.requestId, input.generation);
		// Persist the use and replay marker before the adapter can observe the
		// request. If the process stops after this checkpoint, a replay resolves
		// to unknown and never dispatches the same request a second time.
		await this.#checkpoint?.();

		let dispatchStarted = false;
		const run = async (): Promise<CapabilityInvocationResult> => {
			let dispatchPermitted = true;
			const abortController = new AbortController();
			try {
				if (!this.#resolver) throw new CapabilityBrokerError('CAPABILITY_SECRET_UNAVAILABLE');
				const resolverUse = this.#resolver.useSecret(grant.secretHandle, async (secret) => {
					if (!dispatchPermitted) throw new CapabilityTimeoutError();
					if (grant.view.state !== 'active' || grant.view.generation !== input.generation) {
						throw new CapabilityBrokerError('CAPABILITY_NOT_ACTIVE');
					}
					// Refresh the durable lease/generation fence after resolving the
					// secret, immediately before the adapter may observe the request.
					await withTimeout(
						this.#checkpoint?.() ?? Promise.resolve(),
						this.#resolverTimeoutMs,
						() => { dispatchPermitted = false; },
					);
					if (!dispatchPermitted) throw new CapabilityTimeoutError();
					dispatchStarted = true;
					const dispatched = await withTimeout(adapter.dispatch({
						secret, requestId: input.requestId, principal: input.principal, account: input.account,
						amount: grant.view.amount, destination: grant.view.destination, input: normalizedInput,
						signal: abortController.signal,
					}), this.#adapterTimeoutMs, () => abortController.abort());
					if (dispatched.outcome !== 'completed') return dispatched;
					let projected: unknown;
					try {
						projected = adapter.parseOutput(dispatched.data);
					} catch {
						throw new Error('Capability adapter output was rejected');
					}
					return { outcome: 'completed' as const, data: sanitizeOutput(projected, secret) };
				});
				const result = await withTimeout(
					resolverUse,
					this.#resolverTimeoutMs + this.#adapterTimeoutMs,
					() => {
						dispatchPermitted = false;
						abortController.abort();
					},
				);
				const completed = result.outcome === 'completed';
				const invocation: CapabilityInvocationResult = Object.freeze({
					capabilityRef: input.capabilityRef,
					requestId: input.requestId,
					generation: input.generation,
					status: completed ? 'completed' : 'unknown',
					replayed: false,
					...(completed ? { data: result.data } : {}),
				});
				receipt.result = invocation;
				delete receipt.pending;
				this.#event(completed ? 'completed' : 'unknown', grant, input.requestId, input.generation);
				return invocation;
			} catch (error) {
				dispatchPermitted = false;
				abortController.abort();
				if (!dispatchStarted) {
					grant.rateEvents = grant.rateEvents.filter((event) => event.requestId !== input.requestId);
					grant.view = Object.freeze({ ...grant.view, uses: Math.max(0, grant.view.uses - 1) });
					this.#receipts.delete(receiptKey);
					delete receipt.pending;
					await this.#checkpoint?.();
					throw error instanceof CapabilityBrokerError
						? error
						: error instanceof CapabilityTimeoutError
							? new CapabilityBrokerError('CAPABILITY_TIMEOUT')
							: new CapabilityBrokerError('CAPABILITY_SECRET_UNAVAILABLE');
				}
				const invocation: CapabilityInvocationResult = Object.freeze({
					capabilityRef: input.capabilityRef, requestId: input.requestId, generation: input.generation,
					status: 'unknown', replayed: false,
				});
				receipt.result = invocation;
				delete receipt.pending;
				this.#event('unknown', grant, input.requestId, input.generation);
				return invocation;
			}
		};
		receipt.pending = run();
		return receipt.pending;
	}

	#require(capabilityRef: string): StoredGrant {
		if (!REFERENCE.test(capabilityRef)) throw new CapabilityBrokerError('CAPABILITY_NOT_FOUND');
		const grant = this.#grants.get(capabilityRef);
		if (!grant) throw new CapabilityBrokerError('CAPABILITY_NOT_FOUND');
		return grant;
	}

	#requireScoped(capabilityRef: string, principal: string, account: string): StoredGrant {
		const grant = this.#require(capabilityRef);
		if (grant.view.principal !== principal || grant.view.account !== account) {
			throw new CapabilityBrokerError('CAPABILITY_NOT_FOUND');
		}
		return grant;
	}

	#assertApproval(grant: StoredGrant, approval: VerifiedCapabilityApproval, digest: string, now: number): void {
		if (!IDENTIFIER.test(approval.approvalId) || approval.account !== grant.view.account || approval.digest !== digest ||
			!DIGEST.test(approval.digest) || timestamp(approval.approvedAt, 'approvedAt') < Date.parse(grant.createdAt) ||
			timestamp(approval.approvedAt, 'approvedAt') > now || timestamp(approval.expiresAt, 'approval expiresAt') <= now ||
			Date.parse(approval.expiresAt) > Date.parse(grant.view.expiresAt) ||
			approval.evidence?.method !== 'verified-account-signature' ||
			!['ledger-webhid', 'speculos', 'other-wallet'].includes(approval.evidence.runtime) ||
			approval.evidence.physicalDeviceInferred !== false) {
			throw new CapabilityBrokerError('CAPABILITY_APPROVAL_MISMATCH');
		}
	}

	#restore(snapshot: CapabilityBrokerSnapshot): void {
		if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.grants) || !Array.isArray(snapshot.receipts) ||
			snapshot.grants.length > this.#maxGrants || snapshot.receipts.length > this.#maxReceipts) {
			throw new CapabilityBrokerError('CAPABILITY_INVALID');
		}
		for (const raw of snapshot.grants) {
			const view = raw?.view;
			if (!view || !REFERENCE.test(view.capabilityRef) || this.#grants.has(view.capabilityRef) ||
				!IDENTIFIER.test(view.principal) || !isValidClassicAddress(view.account) || view.network !== 'testnet' ||
				!IDENTIFIER.test(view.service) || !IDENTIFIER.test(view.operation) || !IDENTIFIER.test(view.destination) ||
				!IDENTIFIER.test(raw.secretHandle) || !DIGEST.test(view.approvalDigest) ||
				!['prepared', 'active', 'revoked'].includes(view.state) || !Number.isSafeInteger(view.generation) || view.generation < 1 ||
				!Number.isSafeInteger(view.uses) || view.uses < 0 || !Number.isSafeInteger(view.maxUses) || view.maxUses < view.uses ||
				timestamp(view.notBefore, 'notBefore') >= timestamp(view.expiresAt, 'expiresAt')) {
				throw new CapabilityBrokerError('CAPABILITY_INVALID');
			}
			this.#registry.require(view.service, view.operation);
			const amount = exactAmount(view.amount);
			if (!Number.isSafeInteger(view.rateLimit.windowSeconds) || view.rateLimit.windowSeconds < 1 || view.rateLimit.windowSeconds > 3_600 ||
				!Number.isSafeInteger(view.rateLimit.maxCalls) || view.rateLimit.maxCalls < 1 || view.rateLimit.maxCalls > view.maxUses ||
				!Array.isArray(raw.rateEvents) || raw.rateEvents.length > view.maxUses || raw.rateEvents.some((event: Readonly<{ requestId: string; at: number }>) =>
					!REQUEST_ID.test(event.requestId) || !Number.isSafeInteger(event.at) || event.at < 0)) {
				throw new CapabilityBrokerError('CAPABILITY_INVALID');
			}
			const grant: StoredGrant = {
				view: Object.freeze({ ...view, amount, rateLimit: Object.freeze({ ...view.rateLimit }) }),
				secretHandle: raw.secretHandle,
				createdAt: new Date(timestamp(raw.createdAt, 'createdAt')).toISOString(),
				...(raw.activation === undefined ? {} : { activation: this.#storedApproval(raw.activation, view.account) }),
				...(raw.revocation === undefined ? {} : { revocation: this.#storedApproval(raw.revocation, view.account) }),
				...(raw.pendingRevocation === undefined ? {} : { pendingRevocation: this.#storedPendingRevocation(raw.pendingRevocation) }),
				rateEvents: raw.rateEvents.map((event: Readonly<{ requestId: string; at: number }>) => ({ ...event })),
			};
			const invalidPrepared = view.state === 'prepared' &&
				(grant.activation !== undefined || grant.revocation !== undefined || grant.pendingRevocation !== undefined || view.generation !== 1);
			const invalidActive = view.state === 'active' &&
				(grant.activation === undefined || grant.revocation !== undefined || view.generation !== 1);
			const invalidRevoked = view.state === 'revoked' &&
				(grant.activation === undefined || grant.revocation === undefined || grant.pendingRevocation !== undefined || view.generation < 2);
			const invalidPending = grant.pendingRevocation !== undefined &&
				(view.state !== 'active' || grant.pendingRevocation.generation !== view.generation + 1);
			if (invalidPrepared || invalidActive || invalidRevoked || invalidPending) {
				throw new CapabilityBrokerError('CAPABILITY_INVALID');
			}
			this.#grants.set(view.capabilityRef, grant);
		}
		for (const raw of snapshot.receipts) {
			if (!this.#grants.has(raw.capabilityRef) || !REQUEST_ID.test(raw.requestId) || !DIGEST.test(raw.digest) ||
				(raw.result !== undefined && (raw.result.capabilityRef !== raw.capabilityRef ||
					raw.result.requestId !== raw.requestId || !Number.isSafeInteger(raw.result.generation) ||
					!['completed', 'unknown'].includes(raw.result.status) || raw.result.replayed !== false))) {
				throw new CapabilityBrokerError('CAPABILITY_INVALID');
			}
			if (raw.result !== undefined) canonicalJson(raw.result);
			const key = `${raw.capabilityRef}\0${raw.requestId}`;
			if (this.#receipts.has(key)) throw new CapabilityBrokerError('CAPABILITY_INVALID');
			this.#receipts.set(key, {
				digest: raw.digest,
				...(raw.result === undefined ? {} : { result: Object.freeze({ ...raw.result }) }),
			});
		}
	}

	#storedApproval(value: VerifiedCapabilityApproval, account: string): VerifiedCapabilityApproval {
		if (!value || !IDENTIFIER.test(value.approvalId) || value.account !== account || !DIGEST.test(value.digest) ||
			value.evidence?.method !== 'verified-account-signature' ||
			!['ledger-webhid', 'speculos', 'other-wallet'].includes(value.evidence.runtime) ||
			value.evidence.physicalDeviceInferred !== false) {
			throw new CapabilityBrokerError('CAPABILITY_INVALID');
		}
		timestamp(value.approvedAt, 'approvedAt');
		timestamp(value.expiresAt, 'expiresAt');
		return Object.freeze({ ...value });
	}

	#storedPendingRevocation(value: Readonly<{ generation: number; digest: string }>): { generation: number; digest: string } {
		if (!value || !Number.isSafeInteger(value.generation) || value.generation < 2 || !DIGEST.test(value.digest)) {
			throw new CapabilityBrokerError('CAPABILITY_INVALID');
		}
		return { ...value };
	}
}
