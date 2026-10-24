import { isValidClassicAddress } from 'xrpl';

const ED25519_SIGNATURE_BYTES = 64;
const ED25519_PUBLIC_KEY_BYTES = 32;
const NONCE_BYTES = 64;
const SIGNATURE_LABEL = 'sig1';
const SIGNATURE_AGENT_KEY = 'sig1';
const SIGNATURE_LIFETIME_SECONDS = 60;

/**
 * Wire format sources:
 * - RFC 9421 derived components and signature-base construction:
 *   https://www.rfc-editor.org/rfc/rfc9421.html
 * - Current Web Bot Auth protocol (dictionary Signature-Agent, nonce, and tag):
 *   https://datatracker.ietf.org/doc/draft-ietf-webbotauth-httpsig-protocol/
 * - RFC 7638 JWK thumbprints:
 *   https://www.rfc-editor.org/rfc/rfc7638.html
 */

export interface WbaSigner {
	/** Public-only Ed25519 JWK. Private JWK members are rejected. */
	readonly publicJwk: JsonWebKey;
	/** Narrow signing capability suitable for either WebCrypto or a remote KMS. */
	sign(message: Uint8Array): Promise<ArrayBuffer>;
}

export interface WbaSigningOptions {
	/** HTTPS origin whose well-known path serves the key directory. */
	directoryOrigin: string;
	crypto?: Crypto;
	now?: () => number;
	nonce?: Uint8Array;
}

export interface WbaXrplCredential {
	issuer: string;
	credential_type: 'AP4M-Agent';
	subject: string;
}

export interface WbaDirectory {
	keys: Array<{
		kty: 'OKP';
		crv: 'Ed25519';
		x: string;
		kid: string;
		use: 'sig';
	}>;
	xrpl_credential: WbaXrplCredential;
}

export class WebBotAuthError extends Error {
	constructor(
		message: string,
		readonly code:
			| 'INVALID_DIRECTORY_URL'
			| 'INVALID_REQUEST_URL'
			| 'INVALID_PUBLIC_KEY'
			| 'INVALID_PRIVATE_KEY'
			| 'INVALID_CREDENTIAL'
			| 'INVALID_TIME'
			| 'INVALID_NONCE'
			| 'SIGNING_FAILED',
	) {
		super(message);
		this.name = 'WebBotAuthError';
	}
}

function base64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function base64Url(bytes: Uint8Array): string {
	return base64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) {
		throw new WebBotAuthError('Web Bot Auth public key is not canonical base64url', 'INVALID_PUBLIC_KEY');
	}
	const padded = `${value.replaceAll('-', '+').replaceAll('_', '/')}${'='.repeat((4 - (value.length % 4)) % 4)}`;
	try {
		const binary = atob(padded);
		return Uint8Array.from(binary, (character) => character.charCodeAt(0));
	} catch {
		throw new WebBotAuthError('Web Bot Auth public key is not valid base64url', 'INVALID_PUBLIC_KEY');
	}
}

function publicEd25519Jwk(jwk: JsonWebKey): { kty: 'OKP'; crv: 'Ed25519'; x: string } {
	const candidate = jwk as JsonWebKey & Record<string, unknown>;
	for (const privateName of ['d', 'k', 'p', 'q', 'dp', 'dq', 'qi', 'oth']) {
		if (candidate[privateName] !== undefined) {
			throw new WebBotAuthError('Web Bot Auth directory key contains private material', 'INVALID_PRIVATE_KEY');
		}
	}
	if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
		throw new WebBotAuthError('Web Bot Auth requires an Ed25519 public JWK', 'INVALID_PUBLIC_KEY');
	}
	const publicKeyBytes = decodeBase64Url(jwk.x);
	if (publicKeyBytes.byteLength !== ED25519_PUBLIC_KEY_BYTES) {
		throw new WebBotAuthError('Web Bot Auth Ed25519 public key has the wrong length', 'INVALID_PUBLIC_KEY');
	}
	if (base64Url(publicKeyBytes) !== jwk.x) {
		throw new WebBotAuthError('Web Bot Auth public key is not canonical base64url', 'INVALID_PUBLIC_KEY');
	}
	return { kty: 'OKP', crv: 'Ed25519', x: jwk.x };
}

function validatedRequestUrl(request: Request): URL {
	const parsed = new URL(request.url);
	if (parsed.protocol !== 'https:' || parsed.search !== '' || parsed.hash !== '') {
		throw new WebBotAuthError(
			'Web Bot Auth AP4M requests require HTTPS URLs without query or fragment components',
			'INVALID_REQUEST_URL',
		);
	}
	return parsed;
}

function validatedDirectoryOrigin(value: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new WebBotAuthError('Web Bot Auth directory URL is invalid', 'INVALID_DIRECTORY_URL');
	}
	if (
		parsed.protocol !== 'https:' ||
		parsed.username !== '' ||
		parsed.password !== '' ||
		parsed.hash !== '' ||
		parsed.search !== '' ||
		parsed.pathname !== '/'
	) {
		throw new WebBotAuthError(
			'Web Bot Auth directory discovery must be an HTTPS origin',
			'INVALID_DIRECTORY_URL',
		);
	}
	return parsed.origin;
}

function structuredString(value: string): string {
	if (!/^[\x20-\x7e]+$/.test(value)) {
		throw new WebBotAuthError('Web Bot Auth structured string contains invalid characters', 'INVALID_DIRECTORY_URL');
	}
	return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export async function wbaJwkThumbprint(jwk: JsonWebKey, cryptoImpl: Crypto = crypto): Promise<string> {
	const publicJwk = publicEd25519Jwk(jwk);
	// RFC 7638 requires lexicographic member order and no optional JWK members.
	const canonical = JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x });
	const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
	return base64Url(new Uint8Array(digest));
}

export function cryptoKeyWbaSigner(
	privateKey: CryptoKey,
	publicJwk: JsonWebKey,
	cryptoImpl: Crypto = crypto,
): WbaSigner {
	if (
		privateKey.type !== 'private' ||
		privateKey.extractable ||
		privateKey.algorithm.name !== 'Ed25519' ||
		!privateKey.usages.includes('sign')
	) {
		throw new WebBotAuthError('Web Bot Auth signing key is not an Ed25519 private key', 'INVALID_PRIVATE_KEY');
	}
	publicEd25519Jwk(publicJwk);
	return {
		publicJwk,
		async sign(message) {
			return cryptoImpl.subtle.sign('Ed25519', privateKey, message);
		},
	};
}

export async function buildWbaDirectory(
	publicJwk: JsonWebKey,
	xrplCredential: WbaXrplCredential,
	cryptoImpl: Crypto = crypto,
): Promise<WbaDirectory> {
	const key = publicEd25519Jwk(publicJwk);
	if (
		xrplCredential.credential_type !== 'AP4M-Agent' ||
		!isValidClassicAddress(xrplCredential.issuer) ||
		!isValidClassicAddress(xrplCredential.subject)
	) {
		throw new WebBotAuthError('Web Bot Auth XRPL credential linkage is invalid', 'INVALID_CREDENTIAL');
	}
	const kid = await wbaJwkThumbprint(key, cryptoImpl);
	return {
		keys: [{ ...key, kid, use: 'sig' }],
		xrpl_credential: { ...xrplCredential },
	};
}

interface SignatureMaterial {
	signatureAgent: string;
	signatureInput: string;
	signatureBase: string;
}

function signatureMaterial(request: Request, url: URL, directoryOrigin: string, created: number, nonce: string, kid: string): SignatureMaterial {
	const signatureAgentValue = structuredString(directoryOrigin);
	const signatureAgent = `${SIGNATURE_AGENT_KEY}=${signatureAgentValue}`;
	const coveredComponents =
		`("@authority" "@method" "@path" "signature-agent";key="${SIGNATURE_AGENT_KEY}")`;
	const parameters =
		`${coveredComponents};created=${created};expires=${created + SIGNATURE_LIFETIME_SECONDS}` +
		`;nonce=${structuredString(nonce)};keyid=${structuredString(kid)};alg="ed25519";tag="web-bot-auth"`;
	const signatureBase = [
		`"@authority": ${url.host}`,
		`"@method": ${request.method}`,
		`"@path": ${url.pathname || '/'}`,
		`"signature-agent";key="${SIGNATURE_AGENT_KEY}": ${signatureAgentValue}`,
		`"@signature-params": ${parameters}`,
	].join('\n');
	return { signatureAgent, signatureInput: `${SIGNATURE_LABEL}=${parameters}`, signatureBase };
}

/**
 * Return a copy of an outbound request carrying a fresh RFC 9421 signature.
 * Existing signature fields are replaced, so an untrusted caller cannot add
 * a second label or select different discovery material.
 */
export async function signWbaRequest(
	request: Request,
	signer: WbaSigner,
	options: WbaSigningOptions,
): Promise<Request> {
	const cryptoImpl = options.crypto ?? crypto;
	const requestUrl = validatedRequestUrl(request);
	// Current Web Bot Auth §5.5 defines the default `directory` discovery
	// member as an ASCII origin. Verifiers append the well-known path; a full
	// directory URL is ignored and therefore rejected here.
	const directoryOrigin = validatedDirectoryOrigin(options.directoryOrigin);
	const publicJwk = publicEd25519Jwk(signer.publicJwk);
	const kid = await wbaJwkThumbprint(publicJwk, cryptoImpl);
	const suppliedKid = (signer.publicJwk as JsonWebKey & { kid?: unknown }).kid;
	if (suppliedKid !== undefined && suppliedKid !== kid) {
		throw new WebBotAuthError('Web Bot Auth public JWK kid does not match its thumbprint', 'INVALID_PUBLIC_KEY');
	}
	const now = options.now?.() ?? Date.now();
	if (!Number.isFinite(now) || now < 0) {
		throw new WebBotAuthError('Web Bot Auth signing time is invalid', 'INVALID_TIME');
	}
	const created = Math.floor(now / 1_000);
	if (!Number.isSafeInteger(created)) {
		throw new WebBotAuthError('Web Bot Auth signing time is invalid', 'INVALID_TIME');
	}
	const nonceBytes = options.nonce === undefined
		? cryptoImpl.getRandomValues(new Uint8Array(NONCE_BYTES))
		: new Uint8Array(options.nonce);
	if (nonceBytes.byteLength !== NONCE_BYTES) {
		throw new WebBotAuthError('Web Bot Auth nonce must be exactly 64 bytes', 'INVALID_NONCE');
	}
	const material = signatureMaterial(request, requestUrl, directoryOrigin, created, base64Url(nonceBytes), kid);
	let rawSignature: ArrayBuffer;
	try {
		rawSignature = await signer.sign(new TextEncoder().encode(material.signatureBase));
	} catch {
		throw new WebBotAuthError('Web Bot Auth request signing failed', 'SIGNING_FAILED');
	}
	const signature = new Uint8Array(rawSignature);
	if (signature.byteLength !== ED25519_SIGNATURE_BYTES) {
		throw new WebBotAuthError('Web Bot Auth signer returned an invalid Ed25519 signature', 'SIGNING_FAILED');
	}
	const headers = new Headers(request.headers);
	headers.set('Signature-Agent', material.signatureAgent);
	headers.set('Signature-Input', material.signatureInput);
	headers.set('Signature', `${SIGNATURE_LABEL}=:${base64(signature)}:`);
	return new Request(request.clone(), { headers });
}
