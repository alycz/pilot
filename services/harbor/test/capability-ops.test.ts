import { Wallet } from 'xrpl';
import { describe, expect, it, vi } from 'vitest';

import { OpRegistry, type OpContext } from '../src/catalog/registry';
import {
	CapabilityAdapterRegistry,
	type CapabilityServiceAdapter,
} from '../src/exec/capability-broker';
import { MockCapabilitySecretStore } from '../src/exec/capability-mock-secret-store';
import { MemoryCapabilitySnapshotStore } from '../src/exec/capability-snapshot-store';
import {
	handleCapabilityActivate,
	handleCapabilityInvoke,
	handleCapabilityPrepare,
	handleCapabilityPrepareRevoke,
	handleCapabilityRevoke,
	handleCapabilityStatus,
	ops,
	type CapabilityOperationServices,
} from '../src/ops/capability';
import { handleRestOperation } from '../src/rest';

const NOW = new Date('2026-10-24T12:00:00.000Z');
const REF = `cap_v1_${'a'.repeat(43)}`;
const SERVICE = 'mock.catalog' as const;
const OPERATION = 'read' as const;
const DESTINATION = 'local-fixture-catalog' as const;
const AMOUNT = { unit: 'request' as const, value: '1' as const };

type OwnerReview = Readonly<{
	action: 'activate' | 'revoke';
	capability_ref: string;
	network: 'testnet';
	generation: number;
	approval_digest: string;
	nonce: string;
	approved_at: string;
	expires_at: string;
	tx_json: Readonly<Record<string, unknown>>;
	verification_boundary: Readonly<{
		signature_proves: 'owner-key-control-only';
		runtime_provenance: 'not-authenticated-by-signed-blob';
		physical_device_inferred: false;
	}>;
}>;

function adapter(dispatch = vi.fn(async ({ input }: { input: { resource: 'ledger-docs' | 'market-fixture' } }) => ({
	outcome: 'completed' as const,
	data: { resource: input.resource, entries: ['payments'], simulated: true as const },
}))): CapabilityServiceAdapter<{ resource: 'ledger-docs' | 'market-fixture' }> {
	return {
		service: SERVICE,
		operation: OPERATION,
		parseInput(value) {
			if (!value || typeof value !== 'object' || Array.isArray(value) ||
				Object.keys(value).join(',') !== 'resource' ||
				!['ledger-docs', 'market-fixture'].includes((value as { resource: string }).resource)) {
				throw new Error('invalid input');
			}
			return value as { resource: 'ledger-docs' | 'market-fixture' };
		},
		parseOutput(value) {
			if (!value || typeof value !== 'object' || Array.isArray(value) ||
				(value as { simulated?: unknown }).simulated !== true) throw new Error('invalid output');
			return value;
		},
		dispatch,
	};
}

function harness(customAdapter = adapter()) {
	let now = new Date(NOW);
	let nextReference = REF;
	const store = new MemoryCapabilitySnapshotStore();
	const services: CapabilityOperationServices = {
		enabled: true,
		store,
		resolver: new MockCapabilitySecretStore({
			'public-default-fixture': 'public-default-simulated-noncredential',
		}),
		registry: new CapabilityAdapterRegistry([customAdapter]),
		now: () => new Date(now),
		randomReference: () => nextReference,
	};
	const ctx: OpContext = { principal: 'pilot-route-test', capabilityServices: services };
	return {
		ctx,
		services,
		store,
		adapter: customAdapter,
		setNow(value: string) { now = new Date(value); },
		setReference(value: string) { nextReference = value; },
	};
}

function prepareArgs(account: string) {
	return {
		account,
		network: 'testnet' as const,
		service: SERVICE,
		operation: OPERATION,
		amount: AMOUNT,
		destination: DESTINATION,
		not_before: NOW.toISOString(),
		expires_at: '2026-10-24T13:00:00.000Z',
		max_uses: 3,
		rate_limit: { window_seconds: 60, max_calls: 2 },
	};
}

function ownerProof(wallet: Wallet, review: OwnerReview) {
	return {
		nonce: review.nonce,
		approved_at: review.approved_at,
		expires_at: review.expires_at,
		tx_blob: wallet.sign(review.tx_json as never).tx_blob,
	};
}

function activateArgs(account: string, review: OwnerReview, wallet: Wallet) {
	return {
		account,
		network: 'testnet' as const,
		capability_ref: review.capability_ref,
		generation: 1 as const,
		approval_digest: review.approval_digest,
		owner_proof: ownerProof(wallet, review),
	};
}

function invokeArgs(account: string, overrides: Record<string, unknown> = {}) {
	return {
		account,
		network: 'testnet' as const,
		capability_ref: REF,
		generation: 1,
		request_id: 'request:0001',
		service: SERVICE,
		operation: OPERATION,
		amount: AMOUNT,
		destination: DESTINATION,
		input: { resource: 'ledger-docs' as const },
		...overrides,
	};
}

async function post(ctx: OpContext, name: string, body: unknown) {
	const response = await handleRestOperation(new Request(`https://harbor.test/api/ops/${name}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	}), name, ctx, new OpRegistry(ops));
	return { response, body: await response.json() as Record<string, unknown> };
}

describe('capability operation routes', () => {
	it('persists prepare, exact owner activation, invoke replay, and exact owner revocation', async () => {
		const owner = Wallet.generate();
		const { ctx } = harness();
		const prepared = await post(ctx, 'capability.prepare', prepareArgs(owner.address));
		expect(prepared.response.status).toBe(200);
		expect(prepared.body).toMatchObject({
			ok: true,
			data: { grant: { capabilityRef: REF, state: 'prepared', uses: 0 } },
		});
		const preparedData = prepared.body.data as { owner_review: OwnerReview };
		expect(preparedData.owner_review.action).toBe('activate');
		expect(preparedData.owner_review.network).toBe('testnet');
		const memo = ((preparedData.owner_review.tx_json.Memos as Array<{
			Memo: { MemoData: string };
		}>)[0]?.Memo.MemoData);
		expect(Buffer.from(memo, 'hex').toString('utf8')).toContain('"network":"testnet"');
		expect(preparedData.owner_review.verification_boundary).toEqual({
			signature_proves: 'owner-key-control-only',
			runtime_provenance: 'not-authenticated-by-signed-blob',
			physical_device_inferred: false,
		});
		expect(JSON.stringify(prepared.body)).not.toContain('public-default-simulated-noncredential');
		expect(JSON.stringify(prepared.body)).not.toContain('public-default-fixture');

		const activated = await post(ctx, 'capability.activate',
			activateArgs(owner.address, preparedData.owner_review, owner));
		expect(activated.body).toMatchObject({ ok: true, data: { state: 'active', generation: 1 } });

		const invoked = await post(ctx, 'capability.invoke', invokeArgs(owner.address));
		expect(invoked.body).toMatchObject({
			ok: true,
			data: { status: 'completed', replayed: false, data: { resource: 'ledger-docs', simulated: true } },
		});
		const replayed = await post(ctx, 'capability.invoke', invokeArgs(owner.address));
		expect(replayed.body).toMatchObject({ ok: true, data: { status: 'completed', replayed: true } });

		const status = await handleCapabilityStatus(ctx, {
			account: owner.address, network: 'testnet', capability_ref: REF,
		});
		expect(status).toMatchObject({ state: 'active', uses: 1 });
		const preparedRevocation = await handleCapabilityPrepareRevoke(ctx, {
			account: owner.address, network: 'testnet', capability_ref: REF, request_id: 'revoke:0001',
		});
		const review = preparedRevocation.owner_review;
		const revoked = await handleCapabilityRevoke(ctx, {
			account: owner.address,
			network: 'testnet',
			capability_ref: REF,
			generation: review.generation,
			approval_digest: review.approval_digest,
			owner_proof: ownerProof(owner, review),
		});
		expect(revoked).toMatchObject({ state: 'revoked', generation: 2, uses: 1 });
		await expect(handleCapabilityInvoke(ctx, {
			...invokeArgs(owner.address), generation: 2, request_id: 'request:0002',
		})).rejects.toMatchObject({ code: 'CAPABILITY_NOT_ACTIVE' });
	});

	it('atomically collapses concurrent double clicks and rejects conflicting request replay', async () => {
		const dispatch = vi.fn(async ({ input }: { input: { resource: 'ledger-docs' | 'market-fixture' } }) => ({
			outcome: 'completed' as const,
			data: { resource: input.resource, entries: ['payments'], simulated: true as const },
		}));
		const owner = Wallet.generate();
		const { ctx } = harness(adapter(dispatch));
		const prepared = await handleCapabilityPrepare(ctx, prepareArgs(owner.address));
		await handleCapabilityActivate(ctx, activateArgs(owner.address, prepared.owner_review, owner));

		const [first, second] = await Promise.all([
			handleCapabilityInvoke(ctx, invokeArgs(owner.address)),
			handleCapabilityInvoke(ctx, invokeArgs(owner.address)),
		]);
		expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
		expect(dispatch).toHaveBeenCalledTimes(1);
		await expect(handleCapabilityInvoke(ctx, invokeArgs(owner.address, {
			input: { resource: 'market-fixture' },
		}))).rejects.toMatchObject({ code: 'CAPABILITY_REPLAY_CONFLICT' });
	});

	it('persists an ambiguous dispatch as unknown and never pays or dispatches it twice', async () => {
		const dispatch = vi.fn(async () => {
			throw new Error('ambiguous local fixture failure');
		});
		const owner = Wallet.generate();
		const { ctx } = harness(adapter(dispatch));
		const prepared = await handleCapabilityPrepare(ctx, prepareArgs(owner.address));
		await handleCapabilityActivate(ctx, activateArgs(owner.address, prepared.owner_review, owner));

		await expect(handleCapabilityInvoke(ctx, invokeArgs(owner.address)))
			.resolves.toMatchObject({ status: 'unknown', replayed: false });
		await expect(handleCapabilityInvoke(ctx, invokeArgs(owner.address)))
			.resolves.toMatchObject({ status: 'unknown', replayed: true });
		expect(dispatch).toHaveBeenCalledTimes(1);
		await expect(handleCapabilityStatus(ctx, {
			account: owner.address, network: 'testnet', capability_ref: REF,
		})).resolves.toMatchObject({ uses: 1, state: 'active' });
	});

	it('rejects wrong signer, altered binding, expiry, scope changes, and arbitrary proxy fields', async () => {
		const owner = Wallet.generate();
		const wrongOwner = Wallet.generate();
		const first = harness();
		const prepared = await handleCapabilityPrepare(first.ctx, prepareArgs(owner.address));
		await expect(handleCapabilityActivate(first.ctx,
			activateArgs(owner.address, prepared.owner_review, wrongOwner)))
			.rejects.toThrow('signature is invalid');
		await expect(handleCapabilityActivate(first.ctx, {
			...activateArgs(owner.address, prepared.owner_review, owner),
			approval_digest: '0'.repeat(64),
		})).rejects.toThrow('signature is invalid');

		const expired = harness();
		const expiring = await handleCapabilityPrepare(expired.ctx, prepareArgs(owner.address));
		expired.setNow('2026-10-24T12:01:01.000Z');
		await expect(handleCapabilityActivate(expired.ctx,
			activateArgs(owner.address, expiring.owner_review, owner)))
			.rejects.toThrow('invalid or expired');

		const active = harness();
		const ready = await handleCapabilityPrepare(active.ctx, prepareArgs(owner.address));
		await handleCapabilityActivate(active.ctx, activateArgs(owner.address, ready.owner_review, owner));
		await expect(handleCapabilityInvoke(active.ctx, {
			...invokeArgs(owner.address), destination: 'other-destination' as never,
		})).rejects.toThrow();
		await expect(handleCapabilityInvoke(active.ctx, {
			...invokeArgs(owner.address), input: { resource: 'ledger-docs', url: 'https://invalid.test' } as never,
		})).rejects.toThrow();
	});

	it('fails closed before touching storage when the local mock broker is not explicitly enabled', async () => {
		const transaction = vi.fn();
		const ctx: OpContext = {
			principal: 'pilot-route-test',
			capabilityServices: { enabled: false, store: { transaction } },
		};
		const result = await post(ctx, 'capability.prepare', prepareArgs(Wallet.generate().address));
		expect(result.body).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
		expect(transaction).not.toHaveBeenCalled();
	});

	it('rejects the reserved headerless local-dev principal even with injected enabled services', async () => {
		const transaction = vi.fn();
		const ctx: OpContext = {
			principal: 'local-dev',
			capabilityServices: { enabled: true, store: { transaction } },
		};
		const result = await post(ctx, 'capability.prepare', prepareArgs(Wallet.generate().address));
		expect(result.body).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
		expect(transaction).not.toHaveBeenCalled();
	});

	it('requires the direct-local principal to be present in the configured Bearer principal set', async () => {
		const prepare = vi.fn(() => { throw new Error('D1 must not be touched'); });
		const ctx: OpContext = {
			principal: 'named-local-user',
			localDevRequest: true,
			db: { prepare } as unknown as D1Database,
			env: {
				HARBOR_LOCAL_CAPABILITY_RUNTIME_ENABLED: 'true',
				HARBOR_LOCAL_DEV: 'true',
				HARBOR_MOCK: '1',
				EXEC_NETWORK: 'testnet',
				MAINNET_EXECUTION: 'false',
			},
		};
		const result = await post(ctx, 'capability.prepare', prepareArgs(Wallet.generate().address));
		expect(result.body).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
		expect(prepare).not.toHaveBeenCalled();
	});
});
