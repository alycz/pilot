import { describe, expect, it } from 'vitest';

import {
	WebBotAuthError,
	buildWbaDirectory,
	cryptoKeyWbaSigner,
	signWbaRequest,
	wbaJwkThumbprint,
} from '../src/exec/wba';

const DIRECTORY_ORIGIN = 'https://agent.example';
const XRPL_CREDENTIAL = {
	issuer: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
	credential_type: 'AP4M-Agent' as const,
	subject: 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY',
};

async function testKeys(): Promise<{ pair: CryptoKeyPair; publicJwk: JsonWebKey }> {
	const pair = (await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])) as CryptoKeyPair;
	return { pair, publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey) };
}

function decodeSignature(header: string): Uint8Array {
	const encoded = /^sig1=:([A-Za-z0-9+/]+=*):$/.exec(header)?.[1];
	if (!encoded) throw new Error('invalid signature header');
	const binary = atob(encoded);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

describe('Web Bot Auth', () => {
	it('matches the RFC 7638 thumbprint used by the current IETF Ed25519 vector', async () => {
		await expect(
			wbaJwkThumbprint({
				kty: 'OKP',
				crv: 'Ed25519',
				x: 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs',
			}),
		).resolves.toBe('poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U');
	});

	it('signs the required request components with dictionary-form discovery', async () => {
		const { pair, publicJwk } = await testKeys();
		const nonce = Uint8Array.from({ length: 64 }, (_, index) => index);
		const original = new Request('https://merchant.example/resource/yield-report', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				Signature: 'attacker=:AAAA:',
			},
			body: '{"request":"report"}',
		});
		const signer = cryptoKeyWbaSigner(pair.privateKey, publicJwk);
		const signed = await signWbaRequest(original, signer, {
			directoryOrigin: DIRECTORY_ORIGIN,
			now: () => 1_795_000_000_999,
			nonce,
		});
		const kid = await wbaJwkThumbprint(publicJwk);
		const encodedNonce = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-Pw';
		const parameters =
			'("@authority" "@method" "@path" "signature-agent";key="sig1")' +
			`;created=1795000000;expires=1795000060;nonce="${encodedNonce}";keyid="${kid}";alg="ed25519";tag="web-bot-auth"`;
		const base = [
			'"@authority": merchant.example',
			'"@method": POST',
			'"@path": /resource/yield-report',
			`"signature-agent";key="sig1": "${DIRECTORY_ORIGIN}"`,
			`"@signature-params": ${parameters}`,
		].join('\n');

		expect(signed.headers.get('signature-agent')).toBe(`sig1="${DIRECTORY_ORIGIN}"`);
		expect(signed.headers.get('signature-agent')).not.toContain('.well-known');
		expect(signed.headers.get('signature-input')).toBe(`sig1=${parameters}`);
		expect(signed.headers.get('signature')).not.toContain('attacker');
		expect(signed.headers.get('content-type')).toBe('application/json');
		expect(await signed.text()).toBe('{"request":"report"}');
		expect(await original.text()).toBe('{"request":"report"}');
		expect(
			await crypto.subtle.verify(
				'Ed25519',
				pair.publicKey,
				decodeSignature(signed.headers.get('signature') ?? ''),
				new TextEncoder().encode(base),
			),
		).toBe(true);
	});

	it('binds authority, method, path, discovery member, and signature parameters', async () => {
		const { pair, publicJwk } = await testKeys();
		const signed = await signWbaRequest(
			new Request('https://merchant.example/resource/risk-score', { method: 'GET' }),
			cryptoKeyWbaSigner(pair.privateKey, publicJwk),
			{ directoryOrigin: DIRECTORY_ORIGIN, now: () => 1_795_000_000_000, nonce: new Uint8Array(64) },
		);
		const signature = decodeSignature(signed.headers.get('signature') ?? '');
		const parameters = signed.headers.get('signature-input')?.replace(/^sig1=/, '') ?? '';
		const tamperedBase = [
			'"@authority": merchant.example',
			'"@method": GET',
			'"@path": /resource/other',
			`"signature-agent";key="sig1": "${DIRECTORY_ORIGIN}"`,
			`"@signature-params": ${parameters}`,
		].join('\n');
		expect(
			await crypto.subtle.verify('Ed25519', pair.publicKey, signature, new TextEncoder().encode(tamperedBase)),
		).toBe(false);
	});

	it('publishes only the public Ed25519 key and exact XRPL credential link', async () => {
		const { publicJwk } = await testKeys();
		const directory = await buildWbaDirectory(publicJwk, XRPL_CREDENTIAL);
		expect(directory).toEqual({
			keys: [
				{
					kty: 'OKP',
					crv: 'Ed25519',
					x: publicJwk.x,
					kid: await wbaJwkThumbprint(publicJwk),
					use: 'sig',
				},
			],
			xrpl_credential: XRPL_CREDENTIAL,
		});
		expect(JSON.stringify(directory)).not.toMatch(/"d"|private|seed/i);
	});

	it('rejects private JWK material and mismatched key ids', async () => {
		const { pair, publicJwk } = await testKeys();
		await expect(buildWbaDirectory({ ...publicJwk, d: 'secret' }, XRPL_CREDENTIAL)).rejects.toMatchObject({
			code: 'INVALID_PRIVATE_KEY',
		});
		await expect(
			signWbaRequest(
				new Request('https://merchant.example/resource/risk-score'),
				cryptoKeyWbaSigner(pair.privateKey, { ...publicJwk, kid: 'wrong' }),
				{ directoryOrigin: DIRECTORY_ORIGIN, nonce: new Uint8Array(64) },
			),
		).rejects.toMatchObject({ code: 'INVALID_PUBLIC_KEY' });
		const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
		const x = publicJwk.x ?? '';
		const finalIndex = alphabet.indexOf(x.at(-1) ?? '');
		expect(finalIndex).toBeGreaterThanOrEqual(0);
		expect(finalIndex % 4).toBe(0);
		const nonCanonicalX = `${x.slice(0, -1)}${alphabet[finalIndex + 1]}`;
		await expect(wbaJwkThumbprint({ ...publicJwk, x: nonCanonicalX })).rejects.toMatchObject({
			code: 'INVALID_PUBLIC_KEY',
		});
	});

	it('rejects insecure or unsigned request URL components', async () => {
		const { pair, publicJwk } = await testKeys();
		const signer = cryptoKeyWbaSigner(pair.privateKey, publicJwk);
		for (const url of [
			'http://merchant.example/resource',
			'https://merchant.example/resource?sku=risk-score',
			'https://merchant.example/resource#alternate',
		]) {
			await expect(
				signWbaRequest(new Request(url), signer, {
					directoryOrigin: DIRECTORY_ORIGIN,
					nonce: new Uint8Array(64),
				}),
			).rejects.toMatchObject({ code: 'INVALID_REQUEST_URL' });
		}
	});

	it('rejects unsafe directories, malformed credential links, and short nonces', async () => {
		const { pair, publicJwk } = await testKeys();
		const signer = cryptoKeyWbaSigner(pair.privateKey, publicJwk);
		await expect(
			signWbaRequest(new Request('https://merchant.example/resource'), signer, {
				directoryOrigin: 'http://agent.example',
				nonce: new Uint8Array(64),
			}),
		).rejects.toMatchObject({ code: 'INVALID_DIRECTORY_URL' });
		await expect(
			signWbaRequest(new Request('https://merchant.example/resource'), signer, {
				directoryOrigin: 'https://agent.example/.well-known/http-message-signatures-directory',
				nonce: new Uint8Array(64),
			}),
		).rejects.toMatchObject({ code: 'INVALID_DIRECTORY_URL' });
		await expect(
			signWbaRequest(new Request('https://merchant.example/resource'), signer, {
				directoryOrigin: DIRECTORY_ORIGIN,
				nonce: new Uint8Array(63),
			}),
		).rejects.toMatchObject({ code: 'INVALID_NONCE' });
		await expect(
			buildWbaDirectory(publicJwk, { ...XRPL_CREDENTIAL, subject: 'not-an-xrpl-address' }),
		).rejects.toBeInstanceOf(WebBotAuthError);
	});
});
