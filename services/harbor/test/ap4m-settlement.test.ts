import { decode, Wallet, type IssuedCurrencyAmount, type Payment } from 'xrpl';
import { describe, expect, it } from 'vitest';

import {
	classifyAbsentAp4mSettlement,
	validateAp4mSettlement,
} from '../src/exec/ap4m-settlement';

const MERCHANT = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const ISSUER = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV';
const CREDENTIAL = 'B'.repeat(64);

function payment(account: string): Payment {
	return {
		TransactionType: 'Payment',
		Account: account,
		Destination: MERCHANT,
		Amount: { currency: '524C555344000000000000000000000000000000', issuer: ISSUER, value: '1' },
		CredentialIDs: [CREDENTIAL],
		SourceTag: 2610240,
		DestinationTag: 7,
		InvoiceID: 'A'.repeat(64),
		Memos: [{ Memo: { MemoType: '6170346D', MemoData: '6170346D2F64656D6F' } }],
		Fee: '12',
		Sequence: 7,
		LastLedgerSequence: 1_020,
	};
}

function settled(overrides: Record<string, unknown> = {}) {
	const payer = Wallet.generate();
	const expected = payment(payer.classicAddress);
	const signed = payer.sign(expected);
	const tx = decode(signed.tx_blob) as Record<string, unknown>;
	const evidence = {
		result: {
			hash: signed.hash,
			validated: true,
			ledger_index: 1_015,
			tx_json: tx,
			meta: {
				TransactionResult: 'tesSUCCESS',
				DeliveredAmount: expected.Amount,
			},
			...overrides,
		},
	};
	return { payer, expected, signed, evidence, tx };
}

describe('MH4 settlement evidence', () => {
	it('accepts an exact validated successful IOU Payment', () => {
		const fixture = settled();
		expect(validateAp4mSettlement({
			signed: fixture.signed,
			expectedPayment: fixture.expected,
			evidence: fixture.evidence,
		})).toEqual({
			hash: fixture.signed.hash,
			ledgerIndex: 1_015,
			deliveredAmount: fixture.expected.Amount,
		});
	});

	it.each([
		['hash', () => settled({ hash: 'C'.repeat(64) }), 'SETTLEMENT_MISMATCH'],
		['validation', () => settled({ validated: false }), 'SETTLEMENT_PENDING'],
		['ledger window', () => settled({ ledger_index: 1_021 }), 'SETTLEMENT_MISMATCH'],
		['engine result', () => settled({ meta: { TransactionResult: 'tecPATH_DRY', DeliveredAmount: '0' } }), 'SETTLEMENT_FAILED'],
	])('rejects invalid %s evidence', (_name, build, code) => {
		const fixture = build();
		expect(() => validateAp4mSettlement({
			signed: fixture.signed,
			expectedPayment: fixture.expected,
			evidence: fixture.evidence,
		})).toThrowError(expect.objectContaining({ code }));
	});

	it('rejects altered transaction bindings and partial-payment semantics', () => {
		for (const patch of [
			{ Destination: Wallet.generate().classicAddress },
			{ CredentialIDs: ['C'.repeat(64)] },
			{ Memos: [] },
			{ SendMax: { currency: '524C555344000000000000000000000000000000', issuer: ISSUER, value: '2' } },
			{ Paths: [] },
			{ Flags: 0x0002_0000 },
		]) {
			const fixture = settled();
			(fixture.evidence.result.tx_json as Record<string, unknown>) = { ...fixture.tx, ...patch };
			expect(() => validateAp4mSettlement({
				signed: fixture.signed,
				expectedPayment: fixture.expected,
				evidence: fixture.evidence,
			})).toThrowError(expect.objectContaining({ code: 'SETTLEMENT_MISMATCH' }));
		}
	});

	it('requires exact IOU identity and at least the signed amount', () => {
		for (const amount of [
			{ currency: 'USD', issuer: ISSUER, value: '1' },
			{ currency: '524C555344000000000000000000000000000000', issuer: MERCHANT, value: '1' },
			{ currency: '524C555344000000000000000000000000000000', issuer: ISSUER, value: '0.999999' },
			'1000000',
		] as const) {
			const fixture = settled({ meta: { TransactionResult: 'tesSUCCESS', DeliveredAmount: amount } });
			expect(() => validateAp4mSettlement({
				signed: fixture.signed,
				expectedPayment: fixture.expected,
				evidence: fixture.evidence,
			})).toThrowError(expect.objectContaining({ code: expect.stringMatching(/INVALID_SETTLEMENT_EVIDENCE|SETTLEMENT_MISMATCH/) }));
		}
	});

	it('accepts greater delivered IOU value without trusting merchant output', () => {
		const fixture = settled({
			meta: {
				TransactionResult: 'tesSUCCESS',
				DeliveredAmount: { ...(payment(Wallet.generate().classicAddress).Amount as IssuedCurrencyAmount), value: '1.01' },
			},
		});
		const result = validateAp4mSettlement({
			signed: fixture.signed,
			expectedPayment: fixture.expected,
			evidence: fixture.evidence,
		});
		expect(result.deliveredAmount.value).toBe('1.01');
	});

	it('keeps txnNotFound pending until every possible inclusion ledger is proven absent', () => {
		const base = {
			lookupCode: 'txnNotFound',
			validatedLedgerIndex: 1_021,
			firstEligibleLedgerIndex: 1_001,
			lastLedgerSequence: 1_020,
		};
		expect(classifyAbsentAp4mSettlement({ ...base, inclusionLedgersChecked: [1_001, 1_002] })).toEqual({ status: 'pending' });
		expect(classifyAbsentAp4mSettlement({
			...base,
			validatedLedgerIndex: 1_020,
			inclusionLedgersChecked: Array.from({ length: 20 }, (_, index) => 1_001 + index),
		})).toEqual({ status: 'pending' });
		expect(classifyAbsentAp4mSettlement({
			...base,
			inclusionLedgersChecked: Array.from({ length: 20 }, (_, index) => 1_001 + index),
		})).toEqual({ status: 'expired-absent', checkedFrom: 1_001, checkedThrough: 1_020 });
	});
});
