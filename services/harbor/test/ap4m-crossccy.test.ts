import { describe, expect, it } from 'vitest';
import type { IssuedCurrencyAmount } from 'xrpl';

import {
	buildAp4mCrossCurrencyPayment,
	selectAp4mCrossCurrencySubmissionRoute,
	validateAp4mCrossCurrencyDeliveredAmount,
} from '../src/exec/ap4m-crossccy';

const PAYER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const MERCHANT = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV';
const ISSUER = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
const RLUSD = '524C555344000000000000000000000000000000';
const CREDENTIAL_A = 'A'.repeat(64);
const CREDENTIAL_B = 'B'.repeat(64);

const AMOUNT: IssuedCurrencyAmount = {
	currency: RLUSD,
	issuer: ISSUER,
	value: '12.5',
};

const PATHS = [[{ currency: RLUSD, issuer: ISSUER }]];

function pathFind(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		validated: true,
		full_reply: true,
		ledger_index: 1_000,
		ledger_hash: 'C'.repeat(64),
		source_account: PAYER,
		destination_account: MERCHANT,
		destination_amount: AMOUNT,
		alternatives: [{ source_amount: '1000001', paths_computed: PATHS }],
		...overrides,
	};
}

function build(overrides: Record<string, unknown> = {}) {
	return buildAp4mCrossCurrencyPayment({
		network: 'testnet',
		payer: PAYER,
		destination: MERCHANT,
		amount: AMOUNT,
		credentialIds: [CREDENTIAL_A, CREDENTIAL_B],
		sourceTag: 2610240,
		destinationTag: 7,
		sequence: 41,
		feeDrops: '12',
		lastLedgerSequence: 1_020,
		validatedLedgerIndex: 1_001,
		maxSlippageBps: 1,
		pathFindResponse: pathFind(),
		...overrides,
	} as Parameters<typeof buildAp4mCrossCurrencyPayment>[0]);
}

function expectCode(fn: () => unknown, code: string): void {
	expect(fn).toThrowError(expect.objectContaining({ code }));
}

describe('MH8 AP4M cross-currency Payment construction', () => {
	it('builds exact issued Amount, ceil-slipped XRP SendMax, validated paths, and fixed bindings', () => {
		const result = build();

		expect(result).toEqual({
			payment: {
				TransactionType: 'Payment',
				Account: PAYER,
				Destination: MERCHANT,
				Amount: AMOUNT,
				SendMax: '1000102',
				Paths: PATHS,
				CredentialIDs: [CREDENTIAL_A, CREDENTIAL_B],
				SourceTag: 2610240,
				DestinationTag: 7,
				Sequence: 41,
				Fee: '12',
				LastLedgerSequence: 1_020,
			},
			quote: {
				ledgerIndex: 1_000,
				ledgerHash: 'C'.repeat(64),
				sourceAmountDrops: '1000001',
				sendMaxDrops: '1000102',
			},
		});
		expect(result.payment).not.toHaveProperty('Flags');
		expect(result.payment).not.toHaveProperty('DeliverMin');
	});

	it('selects the unique least-XRP alternative deterministically and applies integer ceiling', () => {
		const alternatives = [
			{ source_amount: '1000002', paths_computed: [[{ account: MERCHANT }]] },
			{ source_amount: '1000001', paths_computed: PATHS },
			{ source_amount: '1000010', paths_computed: [[{ currency: RLUSD, issuer: MERCHANT }]] },
		];
		const forward = build({ pathFindResponse: pathFind({ alternatives }) });
		const reverse = build({ pathFindResponse: pathFind({ alternatives: [...alternatives].reverse() }) });

		expect(forward.quote).toEqual(reverse.quote);
		expect(forward.payment.Paths).toEqual(PATHS);
		expect(forward.quote.sourceAmountDrops).toBe('1000001');
		expect(forward.quote.sendMaxDrops).toBe('1000102');
	});

	it.each([
		['no slippage', '1000001', 0, '1000001'],
		['fractional result', '9999', 1, '10000'],
		['whole-number result', '10000', 1, '10001'],
		['policy upper edge', '1', 10_000, '2'],
	])('uses exact bigint ceiling at the %s boundary', (_name, sourceAmount, bps, sendMax) => {
		const result = build({
			maxSlippageBps: bps,
			pathFindResponse: pathFind({
				alternatives: [{ source_amount: sourceAmount, paths_computed: PATHS }],
			}),
		});
		expect(result.quote.sendMaxDrops).toBe(sendMax);
		expect(result.payment.SendMax).toBe(sendMax);
	});

	it('preserves CredentialIDs and does not manufacture optional tags', () => {
		const result = build({
			credentialIds: [CREDENTIAL_B],
			sourceTag: undefined,
			destinationTag: undefined,
		});
		expect(result.payment.CredentialIDs).toEqual([CREDENTIAL_B]);
		expect(result.payment).not.toHaveProperty('SourceTag');
		expect(result.payment).not.toHaveProperty('DestinationTag');
	});

	it.each([
		['unvalidated', { validated: false }, 'INVALID_PATH_QUOTE'],
		['partial reply', { full_reply: false }, 'INVALID_PATH_QUOTE'],
		['missing ledger hash', { ledger_hash: undefined }, 'INVALID_PATH_QUOTE'],
		['future quote ledger', { ledger_index: 1_002 }, 'PATH_QUOTE_STALE'],
		['stale quote ledger', { ledger_index: 999 }, 'PATH_QUOTE_STALE'],
		['wrong source account', { source_account: MERCHANT }, 'INVALID_PATH_QUOTE'],
		['wrong destination account', { destination_account: PAYER }, 'INVALID_PATH_QUOTE'],
		['wrong destination amount', { destination_amount: { ...AMOUNT, value: '12.5001' } }, 'INVALID_PATH_QUOTE'],
		['empty alternatives', { alternatives: [] }, 'INVALID_PATH_QUOTE'],
		['malformed alternatives', { alternatives: {} }, 'INVALID_PATH_QUOTE'],
		['missing computed paths', { alternatives: [{ source_amount: '1000001' }] }, 'INVALID_PATH_QUOTE'],
		['empty computed paths', { alternatives: [{ source_amount: '1000001', paths_computed: [] }] }, 'INVALID_PATH_QUOTE'],
		['fractional drops', { alternatives: [{ source_amount: '1.1', paths_computed: PATHS }] }, 'INVALID_PATH_QUOTE'],
		['exponent drops', { alternatives: [{ source_amount: '1e6', paths_computed: PATHS }] }, 'INVALID_PATH_QUOTE'],
		['zero drops', { alternatives: [{ source_amount: '0', paths_computed: PATHS }] }, 'INVALID_PATH_QUOTE'],
	])('rejects %s path_find evidence', (_name, quoteOverrides, code) => {
		expectCode(() => build({ pathFindResponse: pathFind(quoteOverrides) }), code);
	});

	it('rejects equal-minimum alternatives because path choice would be ambiguous', () => {
		expectCode(() => build({
			pathFindResponse: pathFind({
				alternatives: [
					{ source_amount: '1000001', paths_computed: PATHS },
					{ source_amount: '1000001', paths_computed: [[{ account: MERCHANT }]] },
				],
			}),
		}), 'INVALID_PATH_QUOTE');
	});

	it.each([
		['unknown path field', [[{ currency: RLUSD, issuer: ISSUER, injected: 'text' }]]],
		['invalid path account', [[{ account: 'not-an-xrpl-account' }]]],
		['empty path step', [[{}]]],
	])('rejects %s instead of copying unvalidated path material', (_name, computedPaths) => {
		expectCode(() => build({
			pathFindResponse: pathFind({
				alternatives: [{ source_amount: '1000001', paths_computed: computedPaths }],
			}),
		}), 'INVALID_PATH_QUOTE');
	});

	it.each([
		['mainnet', { network: 'mainnet' }],
		['reserved XRP issued currency', { amount: { ...AMOUNT, currency: 'XRP' } }],
		['reserved all-zero issued currency', { amount: { ...AMOUNT, currency: '0'.repeat(40) } }],
		['reserved XRP hex issued currency', {
			amount: { ...AMOUNT, currency: '0000000000000000000000005852500000000000' },
		}],
		['17-significant-digit integer', { amount: { ...AMOUNT, value: '12345678901234567' } }],
		['17-significant-digit fraction', { amount: { ...AMOUNT, value: '0.12345678901234567' } }],
		['oversized mantissa', { amount: { ...AMOUNT, value: '1'.repeat(4_096) } }],
		['missing credentials', { credentialIds: [] }],
		['malformed credential', { credentialIds: ['A'.repeat(63)] }],
		['duplicate credentials', { credentialIds: [CREDENTIAL_A, CREDENTIAL_A] }],
		['fractional slippage', { maxSlippageBps: 0.5 }],
		['negative slippage', { maxSlippageBps: -1 }],
		['slippage above policy range', { maxSlippageBps: 10_001 }],
		['floating fee', { feeDrops: '12.1' }],
		['unsafe sequence', { sequence: Number.MAX_SAFE_INTEGER + 1 }],
		['XRP destination amount', { amount: '12500000' }],
	])('fails closed for invalid %s context', (_name, overrides) => {
		expectCode(() => build(overrides), 'INVALID_PAYMENT_CONTEXT');
	});
});

describe('MH8 exact merchant delivery validation', () => {
	it.each([
		['same canonical decimal', { ...AMOUNT, value: '12.5000' }],
		['equivalent exponent', { ...AMOUNT, value: '1.25e1' }],
	])('accepts %s only when the issued amount is numerically exact', (_name, delivered) => {
		expect(validateAp4mCrossCurrencyDeliveredAmount(delivered, AMOUNT)).toEqual(delivered);
	});

	it('accepts the bounded 16-significant-digit XRPL precision edge', () => {
		const required = { ...AMOUNT, value: '1234567890123456' };
		const delivered = { ...AMOUNT, value: '1.234567890123456e15' };
		expect(validateAp4mCrossCurrencyDeliveredAmount(delivered, required)).toEqual(delivered);
	});

	it.each([
		['under-delivery', { ...AMOUNT, value: '12.499999' }, 'DELIVERY_MISMATCH'],
		['over-delivery', { ...AMOUNT, value: '12.500001' }, 'DELIVERY_MISMATCH'],
		['currency substitution', { ...AMOUNT, currency: 'USD' }, 'DELIVERY_MISMATCH'],
		['issuer substitution', { ...AMOUNT, issuer: MERCHANT }, 'DELIVERY_MISMATCH'],
		['number instead of decimal string', { ...AMOUNT, value: 12.5 }, 'INVALID_DELIVERY_EVIDENCE'],
		['NaN text', { ...AMOUNT, value: 'NaN' }, 'INVALID_DELIVERY_EVIDENCE'],
		['unbounded exponent', { ...AMOUNT, value: '1e999' }, 'INVALID_DELIVERY_EVIDENCE'],
		['17-significant-digit integer', { ...AMOUNT, value: '12345678901234567' }, 'INVALID_DELIVERY_EVIDENCE'],
		['17-significant-digit fraction', { ...AMOUNT, value: '0.12345678901234567' }, 'INVALID_DELIVERY_EVIDENCE'],
		['oversized mantissa', { ...AMOUNT, value: '1'.repeat(4_096) }, 'INVALID_DELIVERY_EVIDENCE'],
		['XRP drops', '12500000', 'INVALID_DELIVERY_EVIDENCE'],
	])('rejects %s', (_name, delivered, code) => {
		expectCode(() => validateAp4mCrossCurrencyDeliveredAmount(delivered, AMOUNT), code);
	});
});

describe('MH8 facilitator/direct submission seam', () => {
	it('selects the facilitator only after explicit acceptance', () => {
		expect(selectAp4mCrossCurrencySubmissionRoute({
			facilitatorStatus: 'accepted',
			merchantDirectEnabled: false,
		})).toBe('facilitator');
	});

	it('selects merchant direct only for explicit facilitator non-support', () => {
		expect(selectAp4mCrossCurrencySubmissionRoute({
			facilitatorStatus: 'unsupported',
			merchantDirectEnabled: true,
		})).toBe('merchant-direct');
	});

	it.each([
		['unknown facilitator result', { facilitatorStatus: 'unknown', merchantDirectEnabled: true }],
		['disabled direct fallback', { facilitatorStatus: 'unsupported', merchantDirectEnabled: false }],
	])('fails closed for %s without performing network work', (_name, input) => {
		expectCode(
			() => selectAp4mCrossCurrencySubmissionRoute(input as Parameters<typeof selectAp4mCrossCurrencySubmissionRoute>[0]),
			'SUBMISSION_ROUTE_UNAVAILABLE',
		);
	});
});
