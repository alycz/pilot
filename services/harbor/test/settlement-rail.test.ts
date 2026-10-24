import { describe, expect, it } from 'vitest';

import type { Mandate, Merchant } from '../src/contracts';
import {
	ap4mSandboxRail,
	selectAp4mSettlementRailId,
	SettlementRailError,
	SettlementRailRegistry,
	type SettlementRail,
} from '../src/exec/settlement-rail';

function merchant(schemes: Merchant['schemes']): Pick<Merchant, 'id' | 'schemes'> {
	return { id: 'venue-yield-desk', schemes };
}

function channels(...merchantIds: string[]): Mandate['channels'] {
	return merchantIds.map((merchant_id, index) => ({
		merchant_id,
		channel_id: String(index + 1).repeat(64),
		amount_drops: '1000000',
	}));
}

function code(error: unknown): string | undefined {
	return error instanceof SettlementRailError ? error.code : undefined;
}

describe('MH5 settlement-rail selection', () => {
	it('prefers paychan only when the catalog and active mandate independently agree', () => {
		expect(selectAp4mSettlementRailId({
			merchant: merchant(['exact', 'xrpl-paychan']),
			channels: channels('venue-yield-desk'),
		})).toBe('xrpl-paychan');
		expect(selectAp4mSettlementRailId({
			merchant: merchant(['exact', 'xrpl-paychan']),
			channels: channels('venue-risk-oracle'),
		})).toBe('xrpl-exact');
		expect(selectAp4mSettlementRailId({
			merchant: merchant(['exact']),
			channels: channels('venue-yield-desk'),
		})).toBe('xrpl-exact');
	});

	it('fails closed for duplicate channel bindings or a merchant with no usable rail', () => {
		expect(() => selectAp4mSettlementRailId({
			merchant: merchant(['exact', 'xrpl-paychan']),
			channels: channels('venue-yield-desk', 'venue-yield-desk'),
		})).toThrowError(expect.objectContaining({ code: 'RAIL_SELECTION_INVALID' }));
		expect(() => selectAp4mSettlementRailId({
			merchant: merchant([]),
			channels: [],
		})).toThrowError(expect.objectContaining({ code: 'RAIL_NOT_CONFIGURED' }));
	});
});

describe('MH5 settlement-rail registry', () => {
	it('keeps quote, pay and status behind the selected injected rail', async () => {
		const calls: string[] = [];
		const exact: SettlementRail<string, string, number, number, boolean, boolean> = {
			id: 'xrpl-exact',
			async quote(value) { calls.push(`quote:${value}`); return `q:${value}`; },
			async pay(value) { calls.push(`pay:${value}`); return value + 1; },
			async status(value) { calls.push(`status:${value}`); return !value; },
		};
		const registry = new SettlementRailRegistry([exact, ap4mSandboxRail]);
		expect(registry.list()).toEqual(['ap4m-sandbox', 'xrpl-exact']);
		const selected = registry.require<typeof exact>('xrpl-exact');
		expect(await selected.quote('one')).toBe('q:one');
		expect(await selected.pay(1)).toBe(2);
		expect(await selected.status(false)).toBe(true);
		expect(calls).toEqual(['quote:one', 'pay:1', 'status:false']);
	});

	it('rejects duplicate or missing registrations', () => {
		expect(() => new SettlementRailRegistry([ap4mSandboxRail, ap4mSandboxRail]))
			.toThrowError(expect.objectContaining({ code: 'RAIL_SELECTION_INVALID' }));
		const registry = new SettlementRailRegistry([]);
		expect(() => registry.require('xrpl-paychan'))
			.toThrowError(expect.objectContaining({ code: 'RAIL_NOT_CONFIGURED' }));
	});

	it.each(['quote', 'pay', 'status'] as const)(
		'keeps the AP4M sandbox %s path visibly disconnected with no mock success',
		async (method) => {
			await expect(ap4mSandboxRail[method]({})).rejects.toMatchObject({
				code: 'RAIL_NOT_CONNECTED',
				message: 'Requires Mastercard AP4M early-access credentials',
			});
		},
	);
});
