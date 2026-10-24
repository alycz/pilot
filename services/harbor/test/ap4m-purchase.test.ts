import { describe, expect, it } from 'vitest';
import { decode, encode, hashes, Wallet } from 'xrpl';

import {
	buildAp4mExactPayment,
	selectAp4mL2Disclosures,
	validateAp4mSignedPayment,
	withMandateAgentSigner,
} from '../src/exec/ap4m-purchase';
import { createWrappedMandateKeys } from '../src/exec/mandate-keys';
import viFixture from './fixtures/vi-ap4m-reference-v0.1.json';
import {
	xrplCurrencyCodeForAp4m,
	type ValidatedAp4mX402Challenge,
} from '../src/exec/ap4m-x402';

const PAYER = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY';
const MERCHANT = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const ISSUER = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV';
const HASH = 'A'.repeat(64);
const CREDENTIAL = 'B'.repeat(64);

function challenge(): ValidatedAp4mX402Challenge {
	const currency = xrplCurrencyCodeForAp4m('RLUSD');
	return {
		x402Version: 2,
		resource: { url: 'https://merchant.example/resource/yield-report' },
		scheme: 'exact',
		network: 'xrpl:1',
		currency,
		issuer: ISSUER,
		payTo: MERCHANT,
		amount: '1',
		maxTimeoutSeconds: 60,
		invoiceId: 'invoice-1',
		sourceTag: 2610240,
		accepted: {
			scheme: 'exact',
			network: 'xrpl:1',
			asset: currency,
			payTo: MERCHANT,
			amount: '1',
			maxTimeoutSeconds: 60,
			extra: {
				areFeesSponsored: false,
				assetTransferMethod: 'sequence',
				invoiceId: 'invoice-1',
				issuer: ISSUER,
				sourceTag: 2610240,
			},
		},
	};
}

describe('MH4 exact AP4M payment', () => {
	it('binds stablecoin, credential, source tag and the VI memo', async () => {
		const payment = await buildAp4mExactPayment({
			payer: PAYER,
			challenge: challenge(),
			credentialIds: [CREDENTIAL],
			intentId: 'demo-intent-00000000-0000-4000-8000-000000000004',
			l3aDigest: HASH,
			preparation: {
				sequence: 7,
				validatedLedgerIndex: 1_000,
				feeDrops: '12',
			},
		});

		expect(payment).toMatchObject({
			TransactionType: 'Payment',
			Account: PAYER,
			Destination: MERCHANT,
			Amount: {
				currency: xrplCurrencyCodeForAp4m('RLUSD'),
				issuer: ISSUER,
				value: '1',
			},
			CredentialIDs: [CREDENTIAL],
			SourceTag: 2610240,
			Fee: '12',
			Sequence: 7,
			LastLedgerSequence: 1_020,
		});
		expect(payment.InvoiceID).toMatch(/^[A-F0-9]{64}$/);
		expect(payment.Memos?.[0]?.Memo.MemoType).toBe('6170346D'.toUpperCase());
		expect(Buffer.from(payment.Memos?.[0]?.Memo.MemoData ?? '', 'hex').toString()).toBe(
			`ap4m/demo-intent-00000000-0000-4000-8000-000000000004/${HASH.toLowerCase()}`,
		);
	});

	it('requires an accepted credential and bounded ledger preparation', async () => {
		const base = {
			payer: PAYER,
			challenge: challenge(),
			credentialIds: [] as string[],
			intentId: 'demo-intent-00000000-0000-4000-8000-000000000004',
			l3aDigest: HASH,
			preparation: { sequence: 7, validatedLedgerIndex: 1_000, feeDrops: '12' },
		};
		await expect(buildAp4mExactPayment(base)).rejects.toMatchObject({
			code: 'CREDENTIAL_REQUIRED',
		});
		await expect(
			buildAp4mExactPayment({
				...base,
				credentialIds: [CREDENTIAL],
				preparation: { ...base.preparation, feeDrops: '101' },
			}),
		).rejects.toMatchObject({ code: 'INVALID_LEDGER_PREPARATION' });
	});

	it('accepts only the exact locally hashed payer-signed transaction', async () => {
		const payer = Wallet.generate();
		const expected = await buildAp4mExactPayment({
			payer: payer.classicAddress,
			challenge: challenge(),
			credentialIds: [CREDENTIAL],
			intentId: 'demo-intent-00000000-0000-4000-8000-000000000004',
			l3aDigest: HASH,
			preparation: { sequence: 7, validatedLedgerIndex: 1_000, feeDrops: '12' },
		});
		const signed = payer.sign(expected);
		expect(validateAp4mSignedPayment(signed, expected)).toEqual(signed);
		expect(() =>
			validateAp4mSignedPayment({ hash: 'bad', tx_blob: 'not-hex' }, expected),
		).toThrowError(expect.objectContaining({ code: 'INVALID_SIGNED_PAYMENT' }));
		expect(() =>
			validateAp4mSignedPayment(signed, {
				...expected,
				Destination: PAYER,
			}),
		).toThrowError(expect.objectContaining({ code: 'INVALID_SIGNED_PAYMENT' }));
		const decoded = decode(signed.tx_blob) as Record<string, unknown>;
		const signature = decoded.TxnSignature as string;
		const tamperedBlob = encode({
			...decoded,
			TxnSignature: `${signature.slice(0, -2)}${signature.endsWith('00') ? '01' : '00'}`,
		});
		expect(() => validateAp4mSignedPayment({
			hash: hashes.hashSignedTx(tamperedBlob),
			tx_blob: tamperedBlob,
		}, expected)).toThrowError(expect.objectContaining({ code: 'INVALID_SIGNED_PAYMENT' }));
	});

	it('keeps the wrapped mandate agent private key behind a narrow signer callback', async () => {
		const kek = btoa(String.fromCharCode(...new Uint8Array(32)));
		const identity = {
			principal: 'principal-a',
			owner: MERCHANT,
			network: 'testnet' as const,
			mandateId: 'mandate-a',
		};
		const wrapped = await createWrappedMandateKeys(identity, ['merchant-a'], kek);
		const compact = await withMandateAgentSigner(
			identity,
			{
				ciphertext: wrapped.agentKeyCiphertext,
				iv: wrapped.agentKeyIv,
				publicJwk: wrapped.agentPublicJwk,
			},
			kek,
			async (signer) => signer(
				{ alg: 'ES256', typ: 'kb-sd-jwt', kid: 'agent-a' },
				{ aud: 'merchant-a', nonce: 'nonce-a' },
			),
		);
		const [header, payload, signature] = compact.split('.');
		const publicKey = await crypto.subtle.importKey(
			'jwk',
			wrapped.agentPublicJwk,
			{ name: 'ECDSA', namedCurve: 'P-256' },
			false,
			['verify'],
		);
		const bytes = Uint8Array.from(
			atob(`${signature?.replaceAll('-', '+').replaceAll('_', '/')}${'='.repeat((4 - (signature?.length ?? 0) % 4) % 4)}`),
			(character) => character.charCodeAt(0),
		);
		expect(
			await crypto.subtle.verify(
				{ name: 'ECDSA', hash: 'SHA-256' },
				publicKey,
				bytes,
				new TextEncoder().encode(`${header}.${payload}`),
			),
		).toBe(true);
		expect(JSON.stringify({ identity, wrapped })).not.toMatch(/"d"|seed|private/i);
	});

	it('invalidates a retained mandate signer when the callback exits', async () => {
		const kek = btoa(String.fromCharCode(...new Uint8Array(32)));
		const identity = {
			principal: 'principal-a',
			owner: MERCHANT,
			network: 'testnet' as const,
			mandateId: 'mandate-a',
		};
		const wrapped = await createWrappedMandateKeys(identity, ['merchant-a'], kek);
		let retained: Parameters<typeof withMandateAgentSigner>[3] extends (
			signer: infer Signer,
		) => Promise<unknown> ? Signer : never;
		await withMandateAgentSigner(
			identity,
			{
				ciphertext: wrapped.agentKeyCiphertext,
				iv: wrapped.agentKeyIv,
				publicJwk: wrapped.agentPublicJwk,
			},
			kek,
			async (signer) => { retained = signer; },
		);
		await expect(retained!(
			{ alg: 'ES256', typ: 'kb-sd-jwt', kid: 'agent-a' },
			{ aud: 'merchant-a', nonce: 'nonce-a' },
		)).rejects.toMatchObject({ code: 'INVALID_PAYMENT_CONTEXT' });
	});

	it('selects the exact four public L2 disclosures needed for L3 minting', () => {
		const selected = selectAp4mL2Disclosures({
			l2: viFixture.l2,
			merchantId: 'merchant-a',
			sku: 'sku-a',
		});
		expect(selected.baseJwt.split('.')).toHaveLength(3);
		expect(Object.values(selected).every((value) => typeof value === 'string' && value.length > 0)).toBe(true);
		expect(() =>
			selectAp4mL2Disclosures({
				l2: viFixture.l2,
				merchantId: 'merchant-b',
				sku: 'sku-a',
			}),
		).toThrowError(expect.objectContaining({ code: 'INVALID_PAYMENT_CONTEXT' }));
	});
});
