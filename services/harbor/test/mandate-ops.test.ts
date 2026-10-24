import { describe, expect, it, vi } from 'vitest';

import type { Merchant, Mandate } from '../src/contracts';
import ap4mFixture from './fixtures/vi-ap4m-reference-v0.1.json';
import { handleMandatePrepare, handleMandateRegister, handleMandateRevoke, handleMandateStatus, MandatePrepareArgsSchema } from '../src/ops/mandate';
import type { ActivateMandate, InsertPreparedMandate, StoredMandate } from '../src/exec/mandate-store';

const now = new Date('2026-10-21T12:00:00.000Z');
const merchant: Merchant = {
	id: 'merchant-a', name: 'A', network: 'testnet', base_url: 'https://merchant.test',
	xrpl_address: 'r3kmLJN5D28dHuH8vZNUZpMC43pEHpaocV', src_dpa_id: 'src-a', schemes: ['xrpl-paychan'],
	settle_asset: { kind: 'xrp' }, required_credential: { issuer: 'rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn', credential_type_hex: '4150344D' },
	products: [{ sku: 'sku-a', name: 'A', description: 'A', price: { asset: { kind: 'xrp' }, value: '1' }, response_schema_id: 'schema' }],
	wba_required: false,
};

function storedFrom(input: InsertPreparedMandate): StoredMandate {
	return {
		mandate: {
			id: input.id, owner: input.owner, network: 'testnet', status: 'PENDING', execution_type: 'DEFERRED',
			not_before: input.notBefore, expires_at: input.expiresAt, constraints: input.constraints,
			agent_public_jwk: input.agentPublicJwk, l1_digest: '', l2_digest: '', channels: [], spent_usd: '0',
		},
		agentKeyCiphertext: input.agentKeyCiphertext, agentKeyIv: input.agentKeyIv,
		claimKeysCiphertext: input.claimKeysCiphertext, claimKeysIv: input.claimKeysIv,
		claimPublicKeys: input.claimPublicKeys, prepared: input.prepared, closeRequested: false,
		createdAt: input.createdAt, updatedAt: input.createdAt,
	};
}

function harness() {
	let value: StoredMandate | null = null;
	const store = {
		insertPrepared: vi.fn(async (input: InsertPreparedMandate) => { value = storedFrom(input); return value; }),
		get: vi.fn(async () => value),
		activate: vi.fn(async (_id: string, activation: ActivateMandate) => {
			if (!value) throw new Error('missing');
			value = { ...value, mandate: { ...value.mandate, status: 'ACTIVE', l1_digest: activation.l1Digest, l2_digest: activation.l2Digest, setup_batch_hash: activation.setupBatchHash, channels: activation.channels } };
			return value;
		}),
		revoke: vi.fn(async () => {
			if (!value) throw new Error('missing');
			value = { ...value, mandate: { ...value.mandate, status: 'REVOKED' }, closeRequested: true };
			return value;
		}),
	};
	const context = {
		principal: 'principal', env: { HARBOR_KEK: btoa(String.fromCharCode(...new Uint8Array(32).fill(1))), HARBOR_MOCK: '1' },
		mandateServices: {
			store, now: () => now, randomUUID: () => 'mandate-1', getMerchant: () => merchant,
			generateKeys: async () => ({
				agentPublicJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }, agentKeyCiphertext: new ArrayBuffer(1), agentKeyIv: new ArrayBuffer(12),
				claimPublicKeys: [{ merchant_id: merchant.id, public_key: `ED${'11'.repeat(32)}` }], claimKeysCiphertext: new ArrayBuffer(1), claimKeysIv: new ArrayBuffer(12),
			}),
			ledgerSnapshot: async () => ({ sequence: 1, feeDrops: '12', lastLedgerSequence: 100 }),
			prepareTransactions: () => ({ unsigned_batch: { TransactionType: 'Batch' } as never }),
			trustedIssuerJwk: {},
			expectedIssuerKid: 'mastercard-issuer-key-1',
			verifyVi: async (input: { l2: string }) => {
				if (input.l2 === 'altered') throw new Error('altered L2');
				return { l1Claims: {}, l2Claims: {}, devicePublicJwk: {}, agentPublicJwk: {}, l1Digest: 'l1-digest', l2Digest: 'l2-digest' };
			},
			expectedAudience: 'https://agent.test',
			verifySetup: async () => ({ setupBatchHash: 'ABC', channels: [{ merchant_id: merchant.id, channel_id: 'channel', amount_drops: '10000000' }] }),
		},
	};
	return { context, store };
}

const prepareArgs = {
	owner: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', network: 'testnet' as const,
	constraints: { currency: 'USD' as const, per_payment_max: '5', daily_max: '10', total_max: '10', payees: ['merchant-a'], skus: ['sku-a'] },
	payees: ['merchant-a'], expires_at: '2026-10-22T12:00:00.000Z',
};

describe('mandate operations', () => {
	it('prepares and stores only wrapped/private-safe material', async () => {
		const { context, store } = harness();
		const result = await handleMandatePrepare(context, prepareArgs);
		expect(result).toMatchObject({ mandate_id: 'mandate-1', agent_public_jwk: { kty: 'EC' } });
		expect(result).not.toHaveProperty('agentKeyCiphertext');
		expect(store.insertPrepared).toHaveBeenCalledOnce();
	});

	it('accepts the exact MP0 client shape and rejects split-brain payee lists', () => {
		expect(MandatePrepareArgsSchema.parse(prepareArgs).constraints.payees).toEqual(prepareArgs.payees);
		expect(() => MandatePrepareArgsSchema.parse({
			...prepareArgs,
			constraints: { ...prepareArgs.constraints, payees: ['merchant-b'] },
		})).toThrow('constraints.payees must exactly match payees');
	});

	it('registers only after both VI and ledger setup verification', async () => {
		const { context, store } = harness();
		await handleMandatePrepare(context, prepareArgs);
		const result = await handleMandateRegister(context, { mandate_id: 'mandate-1', l1: 'l1', l2: 'l2', setup_tx_hash: 'ABC' });
		expect(result.status).toBe('ACTIVE');
		expect(result.l2_digest).toBe('l2-digest');
		expect(result).not.toHaveProperty('l1');
		expect(result).not.toHaveProperty('l2');
		expect(store.activate).toHaveBeenCalledWith('mandate-1', expect.objectContaining({
			viChainCiphertext: expect.any(ArrayBuffer), viChainIv: expect.any(ArrayBuffer),
		}));
	});

	it('uses the pinned autonomous VI v0.1 envelope on the operational register path', async () => {
		const { context: base } = harness();
		const context = {
			...base,
			mandateServices: {
				...base.mandateServices,
				now: () => new Date(ap4mFixture.now), randomUUID: () => ap4mFixture.mandate_id,
				trustedIssuerJwk: ap4mFixture.issuer_public_jwk,
				expectedIssuerKid: ap4mFixture.issuer_kid,
				expectedAudience: ap4mFixture.audience,
				verifyVi: undefined,
				generateKeys: async () => ({
					agentPublicJwk: ap4mFixture.agent_public_jwk,
					agentKeyCiphertext: new ArrayBuffer(1), agentKeyIv: new ArrayBuffer(12),
					claimPublicKeys: [{ merchant_id: merchant.id, public_key: `ED${'11'.repeat(32)}` }],
					claimKeysCiphertext: new ArrayBuffer(1), claimKeysIv: new ArrayBuffer(12),
				}),
			},
		};
		await handleMandatePrepare(context, {
			owner: ap4mFixture.owner, network: 'testnet', constraints: {
				currency: 'USD', per_payment_max: '5.00', daily_max: '10.00', total_max: '25.00', payees: ['merchant-a'], skus: ['sku-a'],
			}, payees: ['merchant-a'], expires_at: ap4mFixture.expires_at,
		});
		const result = await handleMandateRegister(context, {
			mandate_id: ap4mFixture.mandate_id, l1: ap4mFixture.l1, l2: ap4mFixture.l2, setup_tx_hash: 'ABC',
		});
		expect(result).toMatchObject({ status: 'ACTIVE', owner: ap4mFixture.owner });
	});

	it('rejects an altered L2 before activation', async () => {
		const { context, store } = harness();
		await handleMandatePrepare(context, prepareArgs);
		await expect(handleMandateRegister(context, { mandate_id: 'mandate-1', l1: 'l1', l2: 'altered', setup_tx_hash: 'ABC' })).rejects.toThrow('altered L2');
		expect(store.activate).not.toHaveBeenCalled();
	});

	it('reports and revokes a mandate with a close request', async () => {
		const { context, store } = harness();
		await handleMandatePrepare(context, prepareArgs);
		expect((await handleMandateStatus(context, { mandate_id: 'mandate-1' })).status).toBe('PENDING');
		expect((await handleMandateRevoke(context, { mandate_id: 'mandate-1' })).status).toBe('REVOKED');
		expect(store.revoke).toHaveBeenCalledOnce();
	});

	it('refuses mainnet at schema validation before any setup work', async () => {
		const { context, store } = harness();
		await expect(handleMandatePrepare(context, { ...prepareArgs, network: 'mainnet' as never })).rejects.toThrow();
		expect(store.insertPrepared).not.toHaveBeenCalled();
	});
});
