import { describe, expect, it } from 'vitest';

import { buildMandateTransactions } from '../src/exec/mandate-batch';

const input = {
	owner: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', sequence: 10, feeDrops: '12', lastLedgerSequence: 100,
	credential: { issuer: 'rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn', credentialTypeHex: '4150344D' },
	merchants: [{ id: 'm1', address: 'r3kmLJN5D28dHuH8vZNUZpMC43pEHpaocV', claimPublicKey: `ED${'11'.repeat(32)}` }],
	channelAmountDrops: '1000000', expiresAt: '2026-10-22T00:00:00.000Z',
};

describe('mandate setup Batch', () => {
	it('builds an all-or-nothing Batch with exact inner placeholders', () => {
		const prepared = buildMandateTransactions(input);
		expect(prepared.unsigned_sequential?.map((tx) => tx.TransactionType)).toEqual(['CredentialAccept', 'PaymentChannelCreate']);
		expect(prepared.unsigned_batch.Flags).toBe(0x00010000);
		expect(prepared.unsigned_batch.RawTransactions).toHaveLength(2);
		for (const { RawTransaction } of prepared.unsigned_batch.RawTransactions) {
			expect(RawTransaction).toMatchObject({ Flags: 0x40000000, Fee: '0', SigningPubKey: '' });
		}
		expect(prepared.unsigned_batch.RawTransactions[0]?.RawTransaction.Sequence).toBe(11);
		expect(prepared.unsigned_batch.RawTransactions[1]?.RawTransaction.Sequence).toBe(12);
		expect(prepared.unsigned_batch.RawTransactions[1]?.RawTransaction).toMatchObject({ SettleDelay: 3_600 });
	});

	it('retains the same pre-signing fallback when local Batch validation fails', () => {
		const prepared = buildMandateTransactions({ ...input, validateTransaction: () => { throw new Error('Batch unavailable'); } });
		expect(prepared.unsigned_sequential?.map((tx) => tx.TransactionType)).toEqual(['CredentialAccept', 'PaymentChannelCreate']);
		expect(prepared.unsigned_sequential?.every((tx) => tx.Flags === undefined)).toBe(true);
	});
});
