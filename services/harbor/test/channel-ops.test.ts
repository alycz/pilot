import { describe, expect, it, vi } from 'vitest';

import type { Merchant } from '../src/contracts';
import type { ChannelClaimRow } from '../src/exec/channel-claim-store';
import type { StoredMandate } from '../src/exec/mandate-store';
import {
	handleChannelList,
	handleChannelStatus,
	type ChannelLedgerStatus,
	type ChannelServices,
} from '../src/ops/channel';

const PRINCIPAL = 'mh5-test-principal';
const OWNER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const MERCHANT_ADDRESS = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY';
const ISSUER = 'r3ADD8kXSUKHd6zTCKfnKT3zV9EZHjzp1S';
const MANDATE_ID = 'mandate-mh5';
const MERCHANT_ID = 'venue-yield-desk';
const CHANNEL_ID = 'A'.repeat(64);
const PUBLIC_KEY = `ED${'B'.repeat(64)}`;
const NOW = '2026-10-21T20:30:00.000Z';

const MERCHANT: Merchant = {
	id: MERCHANT_ID,
	name: 'Yield Desk',
	network: 'testnet',
	base_url: 'https://merchant.test',
	xrpl_address: MERCHANT_ADDRESS,
	src_dpa_id: 'src-dpa-test',
	schemes: ['exact', 'xrpl-paychan'],
	settle_asset: { kind: 'iou', currency: 'RLUSD', issuer: ISSUER },
	required_credential: { issuer: ISSUER, credential_type_hex: '4150344D' },
	products: [{
		sku: 'yield-report',
		name: 'Yield report',
		description: 'Offline test product',
		price: { asset: { kind: 'iou', currency: 'RLUSD', issuer: ISSUER }, value: '0.05' },
		response_schema_id: 'yield_report_v1',
	}],
	wba_required: true,
};

function storedMandate(): StoredMandate {
	return {
		mandate: {
			id: MANDATE_ID,
			owner: OWNER,
			network: 'testnet',
			status: 'ACTIVE',
			execution_type: 'DEFERRED',
			not_before: '2026-10-21T00:00:00.000Z',
			expires_at: '2026-10-22T00:00:00.000Z',
			constraints: {
				currency: 'USD',
				per_payment_max: '1',
				total_max: '2',
				daily_max: '2',
				payees: [MERCHANT_ID],
				skus: ['yield-report'],
			},
			agent_public_jwk: { kty: 'EC' },
			l1_digest: '1'.repeat(64),
			l2_digest: '2'.repeat(64),
			setup_batch_hash: '3'.repeat(64),
			channels: [{
				merchant_id: MERCHANT_ID,
				channel_id: CHANNEL_ID,
				amount_drops: '100000',
			}],
			spent_usd: '0.05',
		},
		agentKeyCiphertext: new ArrayBuffer(1),
		agentKeyIv: new ArrayBuffer(12),
		claimKeysCiphertext: new ArrayBuffer(1),
		claimKeysIv: new ArrayBuffer(12),
		claimPublicKeys: [{ merchant_id: MERCHANT_ID, public_key: PUBLIC_KEY }],
		prepared: { unsigned_batch: {} },
		closeRequested: false,
		createdAt: NOW,
		updatedAt: NOW,
	};
}

function row(overrides: Partial<ChannelClaimRow> = {}): ChannelClaimRow {
	return {
		principal: PRINCIPAL,
		mandateId: MANDATE_ID,
		merchantId: MERCHANT_ID,
		channelId: CHANNEL_ID,
		payer: OWNER,
		channelAmountDrops: '100000',
		publicKey: PUBLIC_KEY,
		cumulativeDrops: '50000',
		lastPriceDrops: '50000',
		lastIdempotencyKey: 'purchase-one',
		signature: '30',
		pendingIdempotencyKey: null,
		pendingPriceDrops: null,
		pendingCumulativeDrops: null,
		pendingToken: null,
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

function ledger(overrides: Partial<ChannelLedgerStatus> = {}): ChannelLedgerStatus {
	return {
		channel_id: CHANNEL_ID,
		account: OWNER,
		destination: MERCHANT_ADDRESS,
		amount_drops: '100000',
		balance_drops: '50000',
		public_key: PUBLIC_KEY,
		settle_delay_seconds: 3600,
		ledger_index: 12_345,
		...overrides,
	};
}

function services(overrides: Partial<ChannelServices> = {}): ChannelServices {
	const mandate = storedMandate();
	return {
		store: {
			get: vi.fn(async () => row()),
			list: vi.fn(async () => [row()]),
		},
		findMandateByChannel: vi.fn(async () => mandate),
		getMandate: vi.fn(async () => mandate),
		readLedgerChannel: vi.fn(async () => ledger()),
		getMerchant: vi.fn(() => MERCHANT),
		...overrides,
	};
}

function context(channelServices: ChannelServices) {
	return { principal: PRINCIPAL, channelServices };
}

describe('MH5 channel.status injected boundaries', () => {
	it('returns validated ledger evidence and the durable highest completed claim', async () => {
		const injected = services();
		await expect(handleChannelStatus(context(injected), { channel_id: CHANNEL_ID.toLowerCase() }))
			.resolves.toEqual({
				mandate_id: MANDATE_ID,
				merchant_id: MERCHANT_ID,
				channel_id: CHANNEL_ID,
				amount_drops: '100000',
				ledger: ledger(),
				local: {
					highest_claim_drops: '50000',
					has_pending_claim: false,
					updated_at: NOW,
				},
			});
		expect(injected.readLedgerChannel).toHaveBeenCalledWith(
			expect.objectContaining({ principal: PRINCIPAL }),
			CHANNEL_ID,
		);
	});

	it('reports zero local progress only when no durable claim row exists', async () => {
		const injected = services({
			store: { get: async () => null, list: async () => [] },
			readLedgerChannel: async () => ledger({ balance_drops: '0' }),
		});
		const result = await handleChannelStatus(context(injected), { channel_id: CHANNEL_ID });
		expect(result.local).toEqual({ highest_claim_drops: '0', has_pending_claim: false });
	});

	it('fails closed when a resolved merchant identity differs from the mandate binding', async () => {
		const mandate = storedMandate();
		mandate.mandate.channels[0]!.merchant_id = 'catalog-alias';
		const injected = services({
			store: { get: async () => null, list: async () => [] },
			findMandateByChannel: async () => mandate,
			readLedgerChannel: async () => ledger({ balance_drops: '0' }),
			getMerchant: (id) => id === 'catalog-alias' ? MERCHANT : undefined,
		});
		await expect(handleChannelStatus(context(injected), { channel_id: CHANNEL_ID }))
			.rejects.toThrow('payment channel merchant is not configured for Testnet');
	});

	it.each([
		['amount', { amount_drops: '9'.repeat(100_000) }],
		['balance', { balance_drops: '9'.repeat(100_000) }],
	] as const)('rejects an oversized injected ledger %s', async (_label, patch) => {
		await expect(handleChannelStatus(context(services({
			readLedgerChannel: async () => ledger(patch),
		})), { channel_id: CHANNEL_ID })).rejects.toThrow();
	});

	it.each([
		['owner', { account: MERCHANT_ADDRESS }, row()],
		['destination', { destination: OWNER }, row()],
		['amount', { amount_drops: '99999' }, row()],
		['public key', { public_key: `ED${'C'.repeat(64)}` }, row()],
		['settle delay', { settle_delay_seconds: 0 }, row()],
		['unpersisted ledger balance', { balance_drops: '50001' }, row()],
		['local payer', {}, row({ payer: MERCHANT_ADDRESS })],
	] as const)('fails closed for a %s mismatch', async (_label, ledgerPatch, localRow) => {
		const injected = services({
			store: { get: async () => localRow, list: async () => [localRow] },
			readLedgerChannel: async () => ledger(ledgerPatch),
		});
		await expect(handleChannelStatus(context(injected), { channel_id: CHANNEL_ID }))
			.rejects.toThrow('payment channel evidence conflicts with durable mandate state');
	});

	it('rejects a channel outside the principal and missing validated ledger evidence', async () => {
		await expect(handleChannelStatus(context(services({
			findMandateByChannel: async () => null,
		})), { channel_id: CHANNEL_ID })).rejects.toThrow(
			'payment channel is not bound to this principal',
		);
		await expect(handleChannelStatus(context(services({
			readLedgerChannel: async () => null,
		})), { channel_id: CHANNEL_ID })).rejects.toThrow(
			'payment channel is not present in the validated ledger',
		);
	});
});

describe('MH5 channel.list injected boundaries', () => {
	it('lists only mandate-bound channels and projects pending state', async () => {
		const pending = row({
			pendingIdempotencyKey: 'purchase-two',
			pendingPriceDrops: '50000',
			pendingCumulativeDrops: '100000',
			pendingToken: 'C'.repeat(64),
		});
		const result = await handleChannelList(context(services({
			store: { get: async () => pending, list: async () => [pending] },
		})), { mandate_id: MANDATE_ID });
		expect(result).toEqual([{
			mandate_id: MANDATE_ID,
			merchant_id: MERCHANT_ID,
			channel_id: CHANNEL_ID,
			amount_drops: '100000',
			local: {
				highest_claim_drops: '50000',
				has_pending_claim: true,
				updated_at: NOW,
			},
		}]);
	});

	it('rejects a resolved merchant identity that differs from the mandate binding', async () => {
		const mandate = storedMandate();
		mandate.mandate.channels[0] = {
			merchant_id: 'catalog-alias',
			channel_id: CHANNEL_ID.toLowerCase(),
			amount_drops: '100000',
		};
		await expect(handleChannelList(context(services({
			getMandate: async () => mandate,
			getMerchant: () => MERCHANT,
			store: { get: async () => null, list: async () => [] },
		})), { mandate_id: MANDATE_ID })).rejects.toThrow('mandate channel binding is invalid');
	});

	it.each([
		['zero amount', '0'],
		['noncanonical amount', '01'],
		['fractional amount', '1.1'],
		['oversized amount', '9'.repeat(100_000)],
	] as const)('rejects a %s in durable mandate state', async (_label, amount) => {
		const mandate = storedMandate();
		mandate.mandate.channels[0]!.amount_drops = amount;
		await expect(handleChannelList(context(services({
			getMandate: async () => mandate,
			store: { get: async () => null, list: async () => [] },
		})), { mandate_id: MANDATE_ID })).rejects.toThrow();
	});

	it('rejects unknown and non-Testnet merchants in durable mandate state', async () => {
		const unknown = storedMandate();
		unknown.mandate.channels[0]!.merchant_id = 'unknown-merchant';
		await expect(handleChannelList(context(services({
			getMandate: async () => unknown,
			getMerchant: (id) => id === MERCHANT_ID ? MERCHANT : undefined,
			store: { get: async () => null, list: async () => [] },
		})), { mandate_id: MANDATE_ID })).rejects.toThrow('mandate channel binding is invalid');

		await expect(handleChannelList(context(services({
			getMerchant: () => ({ ...MERCHANT, network: 'devnet' }),
			store: { get: async () => null, list: async () => [] },
		})), { mandate_id: MANDATE_ID })).rejects.toThrow('mandate channel binding is invalid');
	});

	it('rejects duplicate channel and merchant bindings', async () => {
		const duplicateChannel = storedMandate();
		duplicateChannel.mandate.channels.push({
			merchant_id: 'venue-second',
			channel_id: CHANNEL_ID,
			amount_drops: '100000',
		});
		await expect(handleChannelList(context(services({
			getMandate: async () => duplicateChannel,
			getMerchant: (id) => ({ ...MERCHANT, id }),
			store: { get: async () => null, list: async () => [] },
		})), { mandate_id: MANDATE_ID })).rejects.toThrow('mandate channel binding is invalid');

		const duplicateMerchant = storedMandate();
		duplicateMerchant.mandate.channels.push({
			merchant_id: MERCHANT_ID,
			channel_id: 'F'.repeat(64),
			amount_drops: '100000',
		});
		await expect(handleChannelList(context(services({
			getMandate: async () => duplicateMerchant,
			store: { get: async () => null, list: async () => [] },
		})), { mandate_id: MANDATE_ID })).rejects.toThrow('mandate channel binding is invalid');
	});

	it('fails closed for a missing mandate, mismatched local row, or extra local channel', async () => {
		await expect(handleChannelList(context(services({
			getMandate: async () => null,
		})), { mandate_id: MANDATE_ID })).rejects.toThrow('mandate not found');

		const wrongPayer = row({ payer: MERCHANT_ADDRESS });
		await expect(handleChannelList(context(services({
			store: { get: async () => wrongPayer, list: async () => [wrongPayer] },
		})), { mandate_id: MANDATE_ID })).rejects.toThrow(
			'local channel claim conflicts with durable mandate state',
		);

		const extra = row({ channelId: 'F'.repeat(64) });
		await expect(handleChannelList(context(services({
			store: { get: async () => row(), list: async () => [row(), extra] },
		})), { mandate_id: MANDATE_ID })).rejects.toThrow(
			'local claim references a channel outside the mandate',
		);
	});
});
