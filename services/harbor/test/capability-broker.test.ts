import { describe, expect, it, vi } from 'vitest';

import {
	CapabilityAdapterRegistry,
	CapabilityBroker,
	CapabilityBrokerError,
	type CapabilityBrokerOptions,
	type CapabilityGrantRequest,
	type CapabilityInvocation,
	type CapabilityServiceAdapter,
} from '../src/exec/capability-broker';
import { MockCapabilitySecretStore } from '../src/exec/capability-mock-secret-store';

const ACCOUNT = 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59';
const REF = `cap_v1_${'a'.repeat(43)}`;
const NOW = new Date('2026-10-24T12:00:00.000Z');
const SECRET = 'test-only-api-key-material';
const EVIDENCE = {
	method: 'verified-account-signature' as const,
	runtime: 'speculos' as const,
	physicalDeviceInferred: false as const,
};

function adapter(dispatch = vi.fn(async () => ({ outcome: 'completed' as const, data: { ok: true } }))): CapabilityServiceAdapter<{ query: string }> {
	return {
		service: 'weather',
		operation: 'forecast.read',
		parseInput(input) {
			if (!input || typeof input !== 'object' || Array.isArray(input) ||
				Object.keys(input).join(',') !== 'query' || typeof (input as { query?: unknown }).query !== 'string') {
				throw new Error('invalid adapter input');
			}
			return { query: (input as { query: string }).query };
		},
		parseOutput(output) {
			if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('invalid adapter output');
			const keys = Object.keys(output);
			if (keys.length !== 1 || (keys[0] !== 'ok' && keys[0] !== 'value')) throw new Error('invalid adapter output');
			if (keys[0] === 'ok' && (output as { ok?: unknown }).ok === true) return { ok: true };
			if (keys[0] === 'value' && typeof (output as { value?: unknown }).value === 'string') {
				return { value: (output as { value: string }).value };
			}
			throw new Error('invalid adapter output');
		},
		dispatch,
	};
}

function request(overrides: Partial<CapabilityGrantRequest> = {}): CapabilityGrantRequest {
	return {
		principal: 'pilot', account: ACCOUNT, network: 'testnet', service: 'weather', operation: 'forecast.read',
		amount: { unit: 'request', value: '1' }, destination: 'weather-provider',
		notBefore: NOW.toISOString(), expiresAt: '2026-10-24T13:00:00.000Z', maxUses: 3,
		rateLimit: { windowSeconds: 60, maxCalls: 2 }, ...overrides,
	};
}

function harness(customAdapter = adapter(), options: Partial<CapabilityBrokerOptions> = {}) {
	let now = new Date(NOW);
	const audit = vi.fn();
	const broker = new CapabilityBroker({
		mode: 'mock', resolver: new MockCapabilitySecretStore({ 'mock-weather-key': SECRET }),
		registry: new CapabilityAdapterRegistry([customAdapter]), now: () => new Date(now),
		randomReference: () => REF, audit, ...options,
	});
	return { broker, adapter: customAdapter, audit, setNow: (value: string) => { now = new Date(value); } };
}

async function active(
	customAdapter = adapter(),
	overrides: Partial<CapabilityGrantRequest> = {},
	options: Partial<CapabilityBrokerOptions> = {},
) {
	const result = harness(customAdapter, options);
	const prepared = await result.broker.prepareGrant(request(overrides), 'mock-weather-key');
	const approval = {
		approvalId: 'approval:grant:1', account: ACCOUNT, digest: prepared.approvalDigest,
		approvedAt: NOW.toISOString(), expiresAt: '2026-10-24T12:30:00.000Z',
		evidence: EVIDENCE,
	};
	result.broker.activateGrant(REF, approval);
	return { ...result, prepared, approval };
}

function invocation(overrides: Partial<CapabilityInvocation> = {}): CapabilityInvocation {
	return {
		capabilityRef: REF, requestId: 'request:0001', principal: 'pilot', account: ACCOUNT,
		network: 'testnet',
		service: 'weather', operation: 'forecast.read', amount: { unit: 'request', value: '1' },
		destination: 'weather-provider', generation: 1, input: { query: 'London' }, ...overrides,
	};
}

describe('scoped capability broker', () => {
	it('is disabled by default and accepts only configured mock adapters', async () => {
		await expect(new CapabilityBroker().prepareGrant(request(), 'weather'))
			.rejects.toMatchObject<Partial<CapabilityBrokerError>>({ code: 'CAPABILITY_DISABLED' });
		const { broker } = harness();
		await expect(broker.prepareGrant(request({ operation: 'forecast.write' }), 'mock-weather-key'))
			.rejects.toMatchObject<Partial<CapabilityBrokerError>>({ code: 'CAPABILITY_SCOPE_DENIED' });
	});

	it('prepares and activates an exact account-bound grant without exposing its secret handle or value', async () => {
		const { broker, prepared } = await active();
		expect(prepared).toMatchObject({ capabilityRef: REF, state: 'prepared', generation: 1, uses: 0 });
		expect(prepared.approvalDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.stringify(prepared)).not.toContain('mock-weather-key');
		expect(JSON.stringify(prepared)).not.toContain(SECRET);
		expect(broker.status(REF, 'pilot', ACCOUNT).state).toBe('active');
		expect(() => broker.status(REF, 'other', ACCOUNT)).toThrow(expect.objectContaining({ code: 'CAPABILITY_NOT_FOUND' }));
	});

	it('durably checkpoints a reservation before dispatch and never redispatches it after a crash', async () => {
		const dispatch = vi.fn(async () => ({ outcome: 'completed' as const, data: { ok: true } }));
		const seeded = await active(adapter(dispatch));
		let durable = seeded.broker.snapshot();
		let crashing!: CapabilityBroker;
		crashing = new CapabilityBroker({
			mode: 'mock',
			resolver: new MockCapabilitySecretStore({ 'mock-weather-key': SECRET }),
			registry: new CapabilityAdapterRegistry([adapter(dispatch)]),
			now: () => new Date(NOW),
			snapshot: durable,
			checkpoint: async () => {
				durable = crashing.snapshot();
				throw new Error('simulated process stop after durable reservation');
			},
		});
		await expect(crashing.invoke(invocation())).rejects.toThrow(/process stop/i);
		expect(dispatch).not.toHaveBeenCalled();

		const recovered = new CapabilityBroker({
			mode: 'mock',
			resolver: new MockCapabilitySecretStore({ 'mock-weather-key': SECRET }),
			registry: new CapabilityAdapterRegistry([adapter(dispatch)]),
			now: () => new Date(NOW),
			snapshot: durable,
		});
		await expect(recovered.invoke(invocation())).resolves.toMatchObject({
			status: 'unknown',
			replayed: true,
		});
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('rejects altered, stale, or expired approval bindings', async () => {
		const { broker } = harness();
		const prepared = await broker.prepareGrant(request(), 'mock-weather-key');
		expect(() => broker.activateGrant(REF, {
			approvalId: 'approval:grant:1', account: ACCOUNT, digest: '0'.repeat(64),
			approvedAt: NOW.toISOString(), expiresAt: '2026-10-24T12:30:00.000Z',
			evidence: EVIDENCE,
		})).toThrow(expect.objectContaining({ code: 'CAPABILITY_APPROVAL_MISMATCH' }));
		expect(() => broker.activateGrant(REF, {
			approvalId: 'approval:grant:1', account: ACCOUNT, digest: prepared.approvalDigest,
			approvedAt: NOW.toISOString(), expiresAt: NOW.toISOString(),
			evidence: EVIDENCE,
		})).toThrow(expect.objectContaining({ code: 'CAPABILITY_APPROVAL_MISMATCH' }));
		expect(() => broker.activateGrant(REF, {
			approvalId: 'approval:grant:1', account: ACCOUNT, digest: prepared.approvalDigest,
			approvedAt: NOW.toISOString(), expiresAt: '2026-10-24T12:30:00.000Z',
			evidence: { ...EVIDENCE, physicalDeviceInferred: true } as never,
		})).toThrow(expect.objectContaining({ code: 'CAPABILITY_APPROVAL_MISMATCH' }));
	});

	it('enforces every exact scope field and blocks arbitrary proxy controls', async () => {
		const { broker, adapter: configured } = await active();
		for (const changed of [
			{ principal: 'other' }, { account: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh' },
			{ service: 'other' }, { operation: 'other' }, { amount: { unit: 'request', value: '2' } },
			{ destination: 'other' }, { generation: 2 }, { network: 'devnet' },
		] as const) {
			await expect(broker.invoke(invocation(changed))).rejects.toBeInstanceOf(CapabilityBrokerError);
		}
		await expect(broker.invoke(invocation({ input: { query: 'London', url: 'https://attacker.invalid' } })))
			.rejects.toMatchObject<Partial<CapabilityBrokerError>>({ code: 'CAPABILITY_SCOPE_DENIED' });
		await expect(broker.invoke(invocation({ input: { query: 'https://attacker.invalid' } })))
			.rejects.toMatchObject<Partial<CapabilityBrokerError>>({ code: 'CAPABILITY_SCOPE_DENIED' });
		expect(configured.dispatch).not.toHaveBeenCalled();
	});

	it('refreshes the durable fence immediately before dispatch and aborts safely when it is lost', async () => {
		let checkpoints = 0;
		const dispatch = vi.fn(async () => ({ outcome: 'completed' as const, data: { ok: true } }));
		const configured = await active(adapter(dispatch), {}, {
			checkpoint: async () => {
				checkpoints += 1;
				if (checkpoints === 2) throw new Error('lease generation changed');
			},
		});
		await expect(configured.broker.invoke(invocation()))
			.rejects.toMatchObject({ code: 'CAPABILITY_SECRET_UNAVAILABLE' });
		expect(checkpoints).toBe(3);
		expect(dispatch).not.toHaveBeenCalled();
		expect(configured.broker.status(REF, 'pilot', ACCOUNT).uses).toBe(0);
	});

	it('checkpoints a reserved tombstone after asynchronous secret resolution before dispatch', async () => {
		const checkpoint = vi.fn(async () => undefined);
		const dispatch = vi.fn(async () => ({ outcome: 'completed' as const, data: { ok: true } }));
		const configured = await active(adapter(dispatch), {}, {
			resolver: {
				kind: 'mock',
				async useSecret<T>(_handle: string, use: (secret: string) => Promise<T>): Promise<T> {
					await Promise.resolve();
					return use(SECRET);
				},
			},
			checkpoint,
		});
		await expect(configured.broker.invoke(invocation()))
			.resolves.toMatchObject({ status: 'completed', replayed: false });
		expect(checkpoint).toHaveBeenCalledTimes(2);
		expect(dispatch).toHaveBeenCalledTimes(1);
	});

	it('times out a delayed resolver before dispatch and prevents its late callback from dispatching', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const dispatch = vi.fn(async () => ({ outcome: 'completed' as const, data: { ok: true } }));
		const configured = await active(adapter(dispatch), {}, {
			resolver: {
				kind: 'mock',
				async useSecret<T>(_handle: string, use: (secret: string) => Promise<T>): Promise<T> {
					await gate;
					return use(SECRET);
				},
			},
			resolverTimeoutMs: 1,
			adapterTimeoutMs: 1,
		});
		await expect(configured.broker.invoke(invocation()))
			.rejects.toMatchObject({ code: 'CAPABILITY_TIMEOUT' });
		release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(dispatch).not.toHaveBeenCalled();
		expect(configured.broker.status(REF, 'pilot', ACCOUNT).uses).toBe(0);
	});

	it('holds a timed-out adapter as unknown, aborts it, and never redispatches', async () => {
		let observedSignal: AbortSignal | undefined;
		const dispatch = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
			observedSignal = signal;
			return new Promise<never>(() => undefined);
		});
		const configured = await active(adapter(dispatch), {}, {
			resolverTimeoutMs: 5,
			adapterTimeoutMs: 1,
		});
		await expect(configured.broker.invoke(invocation()))
			.resolves.toMatchObject({ status: 'unknown', replayed: false });
		expect(observedSignal?.aborted).toBe(true);
		await expect(configured.broker.invoke(invocation()))
			.resolves.toMatchObject({ status: 'unknown', replayed: true });
		expect(dispatch).toHaveBeenCalledTimes(1);
	});

	it('dispatches once, returns a redacted result, and replays only the exact request', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const dispatch = vi.fn(async ({ secret }: { secret: string }) => {
			await gate;
			return { outcome: 'completed' as const, data: { value: `answer:${secret}` } };
		});
		const { broker } = await active(adapter(dispatch));
		const first = broker.invoke(invocation());
		const duplicate = broker.invoke(invocation());
		release();
		await expect(first).resolves.toMatchObject({ status: 'completed', replayed: false, data: { value: 'answer:[redacted]' } });
		await expect(duplicate).resolves.toMatchObject({ status: 'completed', replayed: true });
		expect(JSON.stringify(await broker.invoke(invocation()))).not.toContain(SECRET);
		expect(dispatch).toHaveBeenCalledTimes(1);
		await expect(broker.invoke(invocation({ input: { query: 'Paris' } })))
			.rejects.toMatchObject<Partial<CapabilityBrokerError>>({ code: 'CAPABILITY_REPLAY_CONFLICT' });
	});

	it('holds a dispatched call as unknown when its fixed output schema rejects upstream data', async () => {
		const dispatch = vi.fn(async () => ({
			outcome: 'completed' as const,
			data: { ok: true, instructions: `leak ${SECRET}` },
		}));
		const { broker } = await active(adapter(dispatch));
		await expect(broker.invoke(invocation())).resolves.toMatchObject({ status: 'unknown' });
		expect(JSON.stringify(await broker.invoke(invocation()))).not.toContain(SECRET);
		expect(dispatch).toHaveBeenCalledTimes(1);
	});

	it('holds ambiguous dispatches as unknown and never retries them', async () => {
		const dispatch = vi.fn(async () => { throw new Error(`upstream leaked ${SECRET}`); });
		const { broker, audit } = await active(adapter(dispatch));
		await expect(broker.invoke(invocation())).resolves.toEqual({
			capabilityRef: REF, requestId: 'request:0001', generation: 1, status: 'unknown', replayed: false,
		});
		await expect(broker.invoke(invocation())).resolves.toMatchObject({ status: 'unknown', replayed: true });
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(audit.mock.calls)).not.toContain(SECRET);
	});

	it('enforces not-before, expiry, rate, and maximum-use limits', async () => {
		const future = await active(adapter(), { notBefore: '2026-10-24T12:10:00.000Z' });
		await expect(future.broker.invoke(invocation())).rejects.toMatchObject({ code: 'CAPABILITY_EXPIRED' });

		const limited = await active(adapter(), { maxUses: 2, rateLimit: { windowSeconds: 60, maxCalls: 1 } });
		await limited.broker.invoke(invocation());
		await expect(limited.broker.invoke(invocation({ requestId: 'request:0002' })))
			.rejects.toMatchObject({ code: 'CAPABILITY_RATE_LIMIT' });
		limited.setNow('2026-10-24T12:01:01.000Z');
		await limited.broker.invoke(invocation({ requestId: 'request:0002' }));
		await expect(limited.broker.invoke(invocation({ requestId: 'request:0003' })))
			.rejects.toMatchObject({ code: 'CAPABILITY_USE_LIMIT' });
		limited.setNow('2026-10-24T13:00:00.000Z');
		expect(limited.broker.status(REF, 'pilot', ACCOUNT).state).toBe('expired');
	});

	it('fails safely at configured capacity while preserving replay and revocation tombstones', async () => {
		const configured = await active(adapter(), {}, { maxGrants: 1, maxReceipts: 1 });
		await configured.broker.invoke(invocation());
		await expect(configured.broker.invoke(invocation({ requestId: 'request:0002' })))
			.rejects.toMatchObject({ code: 'CAPABILITY_CAPACITY' });
		await expect(configured.broker.invoke(invocation()))
			.resolves.toMatchObject({ status: 'completed', replayed: true });
		await expect(configured.broker.prepareGrant(request(), 'mock-weather-key'))
			.rejects.toMatchObject({ code: 'CAPABILITY_CAPACITY' });

		const preview = await configured.broker.prepareRevocation(REF, 'pilot', ACCOUNT);
		const revoked = configured.broker.revoke({
			capabilityRef: REF,
			principal: 'pilot',
			account: ACCOUNT,
			generation: preview.generation,
			approvalDigest: preview.approvalDigest,
			approval: {
				approvalId: 'approval:capacity:revoke',
				account: ACCOUNT,
				digest: preview.approvalDigest,
				approvedAt: NOW.toISOString(),
				expiresAt: '2026-10-24T12:30:00.000Z',
				evidence: EVIDENCE,
			},
		});
		expect(revoked).toMatchObject({ state: 'revoked', generation: 2 });
		await expect(configured.broker.invoke(invocation()))
			.resolves.toMatchObject({ status: 'completed', replayed: true });
	});

	it('keeps the default retained-receipt envelope below the D1 byte ceiling', async () => {
		const value = 'x'.repeat(60 * 1_024);
		const configured = await active(adapter(vi.fn(async () => ({
			outcome: 'completed' as const,
			data: { value },
		}))), {
			maxUses: 100,
			rateLimit: { windowSeconds: 60, maxCalls: 100 },
		});
		for (let index = 0; index < 16; index += 1) {
			await configured.broker.invoke(invocation({ requestId: `request:${String(index).padStart(4, '0')}` }));
		}
		const serialized = JSON.stringify(configured.broker.snapshot());
		expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(2 * 1_024 * 1_024);
		await expect(configured.broker.invoke(invocation({ requestId: 'request:0016' })))
			.rejects.toMatchObject({ code: 'CAPABILITY_CAPACITY' });
	});

	it('requires an exact revocation approval and fences stale or post-revoke use', async () => {
		const { broker } = await active();
		await broker.invoke(invocation());
		const preview = await broker.prepareRevocation(REF, 'pilot', ACCOUNT);
		expect(() => broker.revoke({
			capabilityRef: REF, principal: 'pilot', account: ACCOUNT, generation: preview.generation,
			approvalDigest: preview.approvalDigest,
			approval: { approvalId: 'approval:revoke:1', account: ACCOUNT, digest: '0'.repeat(64), approvedAt: NOW.toISOString(), expiresAt: '2026-10-24T12:30:00.000Z', evidence: EVIDENCE },
		})).toThrow(expect.objectContaining({ code: 'CAPABILITY_APPROVAL_MISMATCH' }));
		const revoked = broker.revoke({
			capabilityRef: REF, principal: 'pilot', account: ACCOUNT, generation: preview.generation,
			approvalDigest: preview.approvalDigest,
			approval: { approvalId: 'approval:revoke:1', account: ACCOUNT, digest: preview.approvalDigest, approvedAt: NOW.toISOString(), expiresAt: '2026-10-24T12:30:00.000Z', evidence: EVIDENCE },
		});
		expect(revoked).toMatchObject({ state: 'revoked', generation: 2 });
		await expect(broker.invoke(invocation())).resolves.toMatchObject({ status: 'completed', replayed: true });
		await expect(broker.invoke(invocation({ generation: 2, requestId: 'request:0002' })))
			.rejects.toMatchObject({ code: 'CAPABILITY_NOT_ACTIVE' });
	});

	it('fences revocation before a reserved call reaches its adapter', async () => {
		let releaseResolver!: () => void;
		const resolverGate = new Promise<void>((resolve) => { releaseResolver = resolve; });
		const dispatch = vi.fn(async () => ({ outcome: 'completed' as const, data: { ok: true } }));
		const broker = new CapabilityBroker({
			mode: 'mock',
			resolver: {
				kind: 'mock',
				async useSecret<T>(_handle: string, use: (secret: string) => Promise<T>): Promise<T> {
					await resolverGate;
					return use(SECRET);
				},
			},
			registry: new CapabilityAdapterRegistry([adapter(dispatch)]), now: () => NOW, randomReference: () => REF,
		});
		const prepared = await broker.prepareGrant(request(), 'mock-weather-key');
		broker.activateGrant(REF, { approvalId: 'approval:grant:1', account: ACCOUNT, digest: prepared.approvalDigest, approvedAt: NOW.toISOString(), expiresAt: '2026-10-24T12:30:00.000Z', evidence: EVIDENCE });
		const pending = broker.invoke(invocation());
		const preview = await broker.prepareRevocation(REF, 'pilot', ACCOUNT);
		broker.revoke({
			capabilityRef: REF, principal: 'pilot', account: ACCOUNT, generation: preview.generation,
			approvalDigest: preview.approvalDigest,
			approval: { approvalId: 'approval:revoke:race', account: ACCOUNT, digest: preview.approvalDigest, approvedAt: NOW.toISOString(), expiresAt: '2026-10-24T12:30:00.000Z', evidence: EVIDENCE },
		});
		releaseResolver();
		await expect(pending).rejects.toMatchObject({ code: 'CAPABILITY_NOT_ACTIVE' });
		expect(dispatch).not.toHaveBeenCalled();
		expect(broker.status(REF, 'pilot', ACCOUNT)).toMatchObject({ state: 'revoked', uses: 0 });
	});

	it('releases a reservation when the mock secret cannot be resolved before dispatch', async () => {
		const configured = adapter();
		const broker = new CapabilityBroker({
			mode: 'mock', resolver: new MockCapabilitySecretStore({}),
			registry: new CapabilityAdapterRegistry([configured]), now: () => NOW, randomReference: () => REF,
		});
		const prepared = await broker.prepareGrant(request(), 'missing');
		broker.activateGrant(REF, { approvalId: 'approval:grant:1', account: ACCOUNT, digest: prepared.approvalDigest, approvedAt: NOW.toISOString(), expiresAt: '2026-10-24T12:30:00.000Z', evidence: EVIDENCE });
		await expect(broker.invoke(invocation())).rejects.toMatchObject({ code: 'CAPABILITY_SECRET_UNAVAILABLE' });
		expect(broker.status(REF, 'pilot', ACCOUNT).uses).toBe(0);
		expect(configured.dispatch).not.toHaveBeenCalled();
	});
});
