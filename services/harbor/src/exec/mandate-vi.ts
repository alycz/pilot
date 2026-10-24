import type { Mandate } from '../contracts';

type JsonObject = Record<string, unknown>;

export interface VerifyViChainInput {
	l1: string;
	l2: string;
	trustedIssuerJwk: JsonWebKey;
	expectedAgentPublicJwk: JsonObject;
	expectedConstraints: Mandate['constraints'];
	expectedIssuer?: string;
	expectedOwner?: string;
	now?: Date;
	crypto?: Crypto;
}

export interface VerifiedViChain {
	l1Claims: JsonObject;
	l2Claims: JsonObject;
	devicePublicJwk: JsonObject;
	agentPublicJwk: JsonObject;
	l1Digest: string;
	l2Digest: string;
}

export interface VerifyReferenceViInput {
	l1: string;
	l2: string;
	trustedIssuerJwk: JsonWebKey;
	expectedAgentPublicJwk: JsonObject;
	now?: Date;
	crypto?: Crypto;
}

export interface VerifyAp4mReferenceViInput extends VerifyReferenceViInput {
	expectedConstraints: Mandate['constraints'];
	expectedOwner: string;
	expectedIssuer: string;
	expectedIssuerKid: string;
	expectedMandateId: string;
	expectedAudience: string;
	notBefore: string;
	expiresAt: string;
}

export class ViVerificationError extends Error {
	constructor(
		message: string,
		readonly code:
			| 'MALFORMED_TOKEN'
			| 'UNSUPPORTED_ALGORITHM'
			| 'INVALID_SIGNATURE'
			| 'INVALID_DISCLOSURE'
			| 'INVALID_TIME'
			| 'ISSUER_MISMATCH'
			| 'OWNER_MISMATCH'
			| 'INVALID_CLAIMS'
			| 'DEVICE_KEY_MISSING'
			| 'AGENT_KEY_MISMATCH'
			| 'CONSTRAINT_MISMATCH',
	) {
		super(message);
		this.name = 'ViVerificationError';
	}
}

interface ParsedSdJwt {
	jwt: string;
	disclosures: string[];
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(value: Uint8Array, label: string): JsonObject {
	try {
		const parsed: unknown = JSON.parse(new TextDecoder().decode(value));
		if (!isObject(parsed)) throw new TypeError(`${label} must be an object`);
		return parsed;
	} catch {
		throw new ViVerificationError(`${label} is not valid JSON`, 'MALFORMED_TOKEN');
	}
}

function decodeBase64Url(value: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]*$/.test(value)) {
		throw new ViVerificationError('Token contains invalid base64url', 'MALFORMED_TOKEN');
	}
	const padded = `${value.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat((4 - (value.length % 4)) % 4)}`;
	try {
		return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
	} catch {
		throw new ViVerificationError('Token contains invalid base64url', 'MALFORMED_TOKEN');
	}
}

function encodeBase64Url(value: ArrayBuffer): string {
	let binary = '';
	for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function splitSdJwt(value: string): ParsedSdJwt {
	const segments = value.split('~');
	const jwt = segments.shift();
	if (!jwt || jwt.split('.').length !== 3) {
		throw new ViVerificationError('Verifiable Intent token is malformed', 'MALFORMED_TOKEN');
	}
	// A final dotted segment is the optional SD-JWT key-binding JWT. The L2
	// issuer signature is the holder proof used here, so the key-binding JWT is
	// not treated as a disclosure.
	const disclosures = segments.filter((segment) => segment.length > 0 && segment.split('.').length !== 3);
	return { jwt, disclosures };
}

function publicJwk(value: unknown, label: string): JsonObject {
	if (!isObject(value)) {
		throw new ViVerificationError(`${label} is missing`, 'DEVICE_KEY_MISSING');
	}
	if ('d' in value || 'p' in value || 'q' in value || 'dp' in value || 'dq' in value || 'qi' in value) {
		throw new ViVerificationError(`${label} must contain public key material only`, 'MALFORMED_TOKEN');
	}
	if (value.kty !== 'EC' || value.crv !== 'P-256' || typeof value.x !== 'string' || typeof value.y !== 'string') {
		throw new ViVerificationError(`${label} must be an ES256 public JWK`, 'MALFORMED_TOKEN');
	}
	return value;
}

function comparableP256Jwk(value: JsonObject): JsonObject {
	return { kty: value.kty, crv: value.crv, x: value.x, y: value.y };
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (isObject(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(',')}}`;
	}
	return JSON.stringify(value);
}

async function sha256Bytes(cryptoImpl: Crypto, value: string): Promise<ArrayBuffer> {
	return cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(value));
}

export async function viDigest(value: string, cryptoImpl: Crypto = crypto): Promise<string> {
	return Array.from(new Uint8Array(await sha256Bytes(cryptoImpl, value)), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('');
}

async function resolveDisclosures(
	cryptoImpl: Crypto,
	claims: JsonObject,
	disclosures: string[],
): Promise<JsonObject> {
	const digestList = claims._sd;
	if (digestList === undefined) return claims;
	if (!Array.isArray(digestList) || !digestList.every((entry) => typeof entry === 'string')) {
		throw new ViVerificationError('SD-JWT digest list is malformed', 'INVALID_DISCLOSURE');
	}
	if (claims._sd_alg !== undefined && claims._sd_alg !== 'sha-256') {
		throw new ViVerificationError('Only sha-256 SD-JWT disclosures are supported', 'INVALID_DISCLOSURE');
	}

	const disclosed: JsonObject = { ...claims };
	delete disclosed._sd;
	delete disclosed._sd_alg;
	const allowed = new Set(digestList);
	const values = new Map<string, unknown>();
	for (const encoded of disclosures) {
		const digest = encodeBase64Url(await sha256Bytes(cryptoImpl, encoded));
		if (!allowed.has(digest)) {
			throw new ViVerificationError('SD-JWT disclosure digest does not match', 'INVALID_DISCLOSURE');
		}
		let disclosure: unknown;
		try {
			disclosure = JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded)));
		} catch {
			throw new ViVerificationError('SD-JWT disclosure is malformed', 'INVALID_DISCLOSURE');
		}
		if (!Array.isArray(disclosure) || ![2, 3].includes(disclosure.length) || typeof disclosure[0] !== 'string') {
			throw new ViVerificationError('SD-JWT disclosure is malformed', 'INVALID_DISCLOSURE');
		}
		if (disclosure.length === 3) {
			if (typeof disclosure[1] !== 'string' || disclosure[1].length === 0) throw new ViVerificationError('SD-JWT disclosure is malformed', 'INVALID_DISCLOSURE');
			const key = disclosure[1];
			if (key in disclosed) throw new ViVerificationError('SD-JWT disclosure repeats a claim', 'INVALID_DISCLOSURE');
			disclosed[key] = disclosure[2];
			values.set(digest, disclosure[2]);
		} else {
			values.set(digest, disclosure[1]);
		}
	}
	function replace(value: unknown, seen = new Set<string>()): unknown {
		if (Array.isArray(value)) return value.map((entry) => replace(entry, new Set(seen)));
		if (!isObject(value)) return value;
		const keys = Object.keys(value);
		if (keys.length === 1 && typeof value['...'] === 'string' && values.has(value['...'])) {
			const digest = value['...'];
			if (seen.has(digest)) throw new ViVerificationError('SD-JWT disclosure cycle is invalid', 'INVALID_DISCLOSURE');
			seen.add(digest);
			return replace(values.get(digest), seen);
		}
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replace(entry, new Set(seen))]));
	}
	return replace(disclosed) as JsonObject;
}

function validateTime(claims: JsonObject, now: Date): void {
	const epoch = Math.floor(now.getTime() / 1_000);
	if (claims.exp !== undefined && (typeof claims.exp !== 'number' || !Number.isInteger(claims.exp) || epoch >= claims.exp)) {
		throw new ViVerificationError('Verifiable Intent token is expired', 'INVALID_TIME');
	}
	if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || !Number.isInteger(claims.nbf) || epoch < claims.nbf)) {
		throw new ViVerificationError('Verifiable Intent token is not active', 'INVALID_TIME');
	}
}

async function verifyCompactJwt(
	cryptoImpl: Crypto,
	token: string,
	verificationJwk: JsonWebKey,
): Promise<JsonObject> {
	const { jwt, disclosures } = splitSdJwt(token);
	const [protectedSegment, payloadSegment, signatureSegment] = jwt.split('.');
	if (!protectedSegment || !payloadSegment || !signatureSegment) {
		throw new ViVerificationError('Verifiable Intent token is malformed', 'MALFORMED_TOKEN');
	}
	const header = parseJsonObject(decodeBase64Url(protectedSegment), 'Protected header');
	if (header.alg !== 'ES256') {
		throw new ViVerificationError('Verifiable Intent token must use ES256', 'UNSUPPORTED_ALGORITHM');
	}
	const claims = parseJsonObject(decodeBase64Url(payloadSegment), 'Token payload');
	let key: CryptoKey;
	try {
		key = await cryptoImpl.subtle.importKey(
			'jwk',
			verificationJwk,
			{ name: 'ECDSA', namedCurve: 'P-256' },
			false,
			['verify'],
		);
	} catch {
		throw new ViVerificationError('Verifiable Intent verification key is invalid', 'MALFORMED_TOKEN');
	}
	const valid = await cryptoImpl.subtle.verify(
		{ name: 'ECDSA', hash: 'SHA-256' },
		key,
		decodeBase64Url(signatureSegment),
		new TextEncoder().encode(`${protectedSegment}.${payloadSegment}`),
	);
	if (!valid) {
		throw new ViVerificationError('Verifiable Intent signature is invalid', 'INVALID_SIGNATURE');
	}
	return resolveDisclosures(cryptoImpl, claims, disclosures);
}

/**
 * Verify the pre-v0.1 direct demo envelope. This is retained only for explicit
 * legacy interoperability tests; mandate.register never calls it.
 *
 * Verify the AP4M Verifiable Intent L1 → L2 chain without exporting either
 * private key. This deliberately uses only WebCrypto so it runs unchanged in a
 * Cloudflare Worker. L1 binds the browser device public key; that key verifies
 * L2, whose cnf key and constraints must match Harbor's prepared mandate.
 */
export async function verifyLegacyDirectViChain(input: VerifyViChainInput): Promise<VerifiedViChain> {
	const cryptoImpl = input.crypto ?? crypto;
	const now = input.now ?? new Date();
	const l1Claims = await verifyCompactJwt(cryptoImpl, input.l1, input.trustedIssuerJwk);
	validateTime(l1Claims, now);
	if (l1Claims.of_verified !== true || typeof l1Claims.exp !== 'number') {
		throw new ViVerificationError('L1 must contain current positive Open Finance verification', 'INVALID_CLAIMS');
	}
	if (input.expectedIssuer !== undefined && l1Claims.iss !== input.expectedIssuer) {
		throw new ViVerificationError('Verifiable Intent issuer does not match Demo Network', 'ISSUER_MISMATCH');
	}
	const l1Confirmation = l1Claims.cnf;
	if (!isObject(l1Confirmation)) {
		throw new ViVerificationError('L1 device confirmation key is missing', 'DEVICE_KEY_MISSING');
	}
	const devicePublicJwk = publicJwk(l1Confirmation.jwk, 'L1 device confirmation key');
	const budgetAccount = l1Claims.budget_account;
	if (typeof budgetAccount !== 'string' || (input.expectedOwner !== undefined && budgetAccount !== input.expectedOwner)) {
		throw new ViVerificationError('L1 budget account does not match mandate owner', 'OWNER_MISMATCH');
	}
	const l2Claims = await verifyCompactJwt(
		cryptoImpl,
		input.l2,
		devicePublicJwk as unknown as JsonWebKey,
	);
	validateTime(l2Claims, now);
	if (typeof l2Claims.exp !== 'number' || l2Claims.execution_type !== 'DEFERRED' || l2Claims.iss !== budgetAccount) {
		throw new ViVerificationError('L2 is not a current deferred intent for the L1 budget account', 'INVALID_CLAIMS');
	}
	const l2Confirmation = l2Claims.cnf;
	if (!isObject(l2Confirmation)) {
		throw new ViVerificationError('L2 agent confirmation key is missing', 'AGENT_KEY_MISMATCH');
	}
	const agentPublicJwk = publicJwk(l2Confirmation.jwk, 'L2 agent confirmation key');
	const expectedAgent = publicJwk(input.expectedAgentPublicJwk, 'Prepared mandate agent key');
	if (canonicalJson(comparableP256Jwk(agentPublicJwk)) !== canonicalJson(comparableP256Jwk(expectedAgent))) {
		throw new ViVerificationError('L2 agent key does not match prepared mandate', 'AGENT_KEY_MISMATCH');
	}
	if (canonicalJson(l2Claims.constraints) !== canonicalJson(input.expectedConstraints)) {
		throw new ViVerificationError('L2 constraints do not match prepared mandate', 'CONSTRAINT_MISMATCH');
	}
	return {
		l1Claims,
		l2Claims,
		devicePublicJwk,
		agentPublicJwk,
		l1Digest: await viDigest(input.l1, cryptoImpl),
		l2Digest: await viDigest(input.l2, cryptoImpl),
	};
}

/**
 * Verify the pinned public VI v0.1 autonomous L1/L2 profile independently of
 * Harbor's AP4M demo claims. This adapter intentionally does not translate the
 * reference vocabulary into an executable Harbor mandate.
 */
export async function verifyReferenceViChain(input: VerifyReferenceViInput): Promise<{ l1Claims: JsonObject; l2Claims: JsonObject }> {
	const cryptoImpl = input.crypto ?? crypto;
	const now = input.now ?? new Date();
	const trustedIssuer = publicJwk(input.trustedIssuerJwk as unknown, 'Reference VI trusted issuer key');
	if (trustedIssuer.alg !== undefined && trustedIssuer.alg !== 'ES256') {
		throw new ViVerificationError('Reference VI trusted issuer key must use ES256', 'UNSUPPORTED_ALGORITHM');
	}
	const l1Header = parseJsonObject(decodeBase64Url(splitSdJwt(input.l1).jwt.split('.')[0] ?? ''), 'L1 protected header');
	const l2Header = parseJsonObject(decodeBase64Url(splitSdJwt(input.l2).jwt.split('.')[0] ?? ''), 'L2 protected header');
	if (l1Header.typ !== 'sd+jwt' || l2Header.typ !== 'kb-sd-jwt+kb') {
		throw new ViVerificationError('Reference VI token types do not match v0.1 autonomous profile', 'INVALID_CLAIMS');
	}
	const l1Claims = await verifyCompactJwt(cryptoImpl, input.l1, input.trustedIssuerJwk);
	validateTime(l1Claims, now);
	if (typeof l1Claims.iat !== 'number' || !Number.isInteger(l1Claims.iat) || l1Claims.iat > Math.floor(now.getTime() / 1_000)) {
		throw new ViVerificationError('Reference VI L1 issued-at time is invalid', 'INVALID_TIME');
	}
	if (l1Claims.vct !== 'https://credentials.mastercard.com/card') {
		throw new ViVerificationError('Reference VI L1 credential type is invalid', 'INVALID_CLAIMS');
	}
	const l1Confirmation = l1Claims.cnf;
	if (!isObject(l1Confirmation)) throw new ViVerificationError('Reference VI L1 device key is missing', 'DEVICE_KEY_MISSING');
	const devicePublicJwk = publicJwk(l1Confirmation.jwk, 'Reference VI L1 device key');
	const l2Claims = await verifyCompactJwt(cryptoImpl, input.l2, devicePublicJwk as unknown as JsonWebKey);
	validateTime(l2Claims, now);
	if (typeof l2Claims.iat !== 'number' || !Number.isInteger(l2Claims.iat) || l2Claims.iat > Math.floor(now.getTime() / 1_000)) {
		throw new ViVerificationError('Reference VI L2 issued-at time is invalid', 'INVALID_TIME');
	}
	const expectedHash = encodeBase64Url(await sha256Bytes(cryptoImpl, input.l1));
	if (l2Claims.sd_hash !== expectedHash) throw new ViVerificationError('Reference VI L2 is not bound to L1', 'INVALID_CLAIMS');
	const delegates = l2Claims.delegate_payload;
	if (!Array.isArray(delegates)) throw new ViVerificationError('Reference VI delegate payload is missing', 'INVALID_CLAIMS');
	const required = ['mandate.checkout.open', 'mandate.payment.open'];
	for (const type of required) {
		const matches = delegates.filter((entry) => isObject(entry) && entry.vct === type);
		if (matches.length !== 1) throw new ViVerificationError(`Reference VI requires exactly one ${type} delegation`, 'INVALID_CLAIMS');
		const mandate = matches[0];
		if (!isObject(mandate) || !isObject(mandate.cnf)) throw new ViVerificationError(`Reference VI ${type} delegation is missing`, 'INVALID_CLAIMS');
		const agent = publicJwk(mandate.cnf.jwk, `Reference VI ${type} agent key`);
		const expected = publicJwk(input.expectedAgentPublicJwk, 'Expected reference VI agent key');
		if (canonicalJson(comparableP256Jwk(agent)) !== canonicalJson(comparableP256Jwk(expected))) {
			throw new ViVerificationError(`Reference VI ${type} agent key does not match`, 'AGENT_KEY_MISMATCH');
		}
	}
	return { l1Claims, l2Claims };
}

function strictConstraintMap(value: unknown, allowed: readonly string[], label: string): Map<string, JsonObject> {
	if (!Array.isArray(value)) throw new ViVerificationError(`${label} constraints are missing`, 'CONSTRAINT_MISMATCH');
	const result = new Map<string, JsonObject>();
	for (const item of value) {
		if (!isObject(item) || typeof item.type !== 'string' || !allowed.includes(item.type)) {
			throw new ViVerificationError(`${label} contains an unknown constraint`, 'CONSTRAINT_MISMATCH');
		}
		if (result.has(item.type)) throw new ViVerificationError(`${label} contains a duplicate ${item.type} constraint`, 'CONSTRAINT_MISMATCH');
		result.set(item.type, item);
	}
	return result;
}

function requiredConstraint(map: Map<string, JsonObject>, type: string): JsonObject {
	const value = map.get(type);
	if (!value) throw new ViVerificationError(`Required ${type} constraint is missing`, 'CONSTRAINT_MISMATCH');
	return value;
}

function usdCents(value: string, label: string): number {
	if (!/^(0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) {
		throw new ViVerificationError(`${label} cannot be represented as integer USD cents`, 'CONSTRAINT_MISMATCH');
	}
	const [whole, fraction = ''] = value.split('.');
	const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
	if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new ViVerificationError(`${label} exceeds the VI integer range`, 'CONSTRAINT_MISMATCH');
	return Number(cents);
}

function exactIds(value: unknown, field: string): string[] {
	if (!Array.isArray(value)) throw new ViVerificationError(`${field} is missing`, 'CONSTRAINT_MISMATCH');
	const ids = value.map((item) => isObject(item) && typeof item.id === 'string' ? item.id : undefined);
	if (ids.some((id) => id === undefined) || new Set(ids).size !== ids.length) {
		throw new ViVerificationError(`${field} must resolve to unique public ids`, 'CONSTRAINT_MISMATCH');
	}
	return ids as string[];
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

async function checkoutDisclosureHash(cryptoImpl: Crypto, l2: string): Promise<string> {
	for (const encoded of splitSdJwt(l2).disclosures) {
		let decoded: unknown;
		try { decoded = JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded))); } catch { continue; }
		if (Array.isArray(decoded) && decoded.length === 2 && isObject(decoded[1]) && decoded[1].vct === 'mandate.checkout.open') {
			return encodeBase64Url(await sha256Bytes(cryptoImpl, encoded));
		}
	}
	throw new ViVerificationError('Checkout mandate disclosure is missing', 'CONSTRAINT_MISMATCH');
}

/** Project the disclosed VI v0.1 vocabulary back to Harbor's prepared constraint contract. */
export async function assertAp4mReferenceProjection(
	l2: string,
	l2Claims: JsonObject,
	prepared: Pick<VerifyAp4mReferenceViInput, 'expectedConstraints' | 'expectedOwner' | 'notBefore' | 'expiresAt'>,
	cryptoImpl: Crypto = crypto,
): Promise<void> {
	const delegates = l2Claims.delegate_payload;
	if (!Array.isArray(delegates)) throw new ViVerificationError('Reference VI delegate payload is missing', 'CONSTRAINT_MISMATCH');
	const checkout = delegates.find((entry) => isObject(entry) && entry.vct === 'mandate.checkout.open') as JsonObject | undefined;
	const payment = delegates.find((entry) => isObject(entry) && entry.vct === 'mandate.payment.open') as JsonObject | undefined;
	if (!checkout || !payment) throw new ViVerificationError('Open checkout and payment mandates are required', 'CONSTRAINT_MISMATCH');
	const checkoutConstraints = strictConstraintMap(checkout.constraints, ['mandate.checkout.allowed_merchant', 'mandate.checkout.line_items'], 'checkout');
	const paymentConstraints = strictConstraintMap(payment.constraints, ['payment.amount', 'payment.budget', 'payment.allowed_payee', 'payment.agent_recurrence', 'payment.reference'], 'payment');

	const amount = requiredConstraint(paymentConstraints, 'payment.amount');
	if (amount.currency !== 'USD' || amount.max !== usdCents(prepared.expectedConstraints.per_payment_max, 'per_payment_max') || (amount.min !== undefined && amount.min !== 0)) {
		throw new ViVerificationError('payment.amount does not match prepared per-payment maximum', 'CONSTRAINT_MISMATCH');
	}
	const budget = requiredConstraint(paymentConstraints, 'payment.budget');
	if (budget.currency !== 'USD' || budget.max !== usdCents(prepared.expectedConstraints.total_max, 'total_max') || budget.pilot_daily_max !== usdCents(prepared.expectedConstraints.daily_max, 'daily_max')) {
		throw new ViVerificationError('payment.budget does not match prepared total and daily maxima', 'CONSTRAINT_MISMATCH');
	}
	const payees = exactIds(requiredConstraint(paymentConstraints, 'payment.allowed_payee').allowed_payees, 'allowed payees');
	const merchants = exactIds(requiredConstraint(checkoutConstraints, 'mandate.checkout.allowed_merchant').allowed_merchants, 'allowed merchants');
	if (!sameSet(payees, prepared.expectedConstraints.payees) || !sameSet(merchants, prepared.expectedConstraints.payees)) {
		throw new ViVerificationError('VI payees do not match prepared mandate', 'CONSTRAINT_MISMATCH');
	}
	const lineItems = checkoutConstraints.get('mandate.checkout.line_items');
	const projectedSkus: string[] = [];
	if (lineItems) {
		if (!Array.isArray(lineItems.items)) throw new ViVerificationError('checkout line items are malformed', 'CONSTRAINT_MISMATCH');
		for (const item of lineItems.items) {
			if (!isObject(item) || !Array.isArray(item.acceptable_items)) throw new ViVerificationError('checkout line items are malformed', 'CONSTRAINT_MISMATCH');
			for (const acceptable of item.acceptable_items) {
				if (!isObject(acceptable)) throw new ViVerificationError('acceptable item is malformed', 'CONSTRAINT_MISMATCH');
				const sku = typeof acceptable.sku === 'string' ? acceptable.sku : typeof acceptable.id === 'string' ? acceptable.id : undefined;
				if (!sku) throw new ViVerificationError('acceptable item has no SKU', 'CONSTRAINT_MISMATCH');
				projectedSkus.push(sku);
			}
		}
	}
	const expectedSkus = prepared.expectedConstraints.skus ?? [];
	if (new Set(projectedSkus).size !== projectedSkus.length || !sameSet(projectedSkus, expectedSkus)) {
		throw new ViVerificationError('VI SKUs do not match prepared mandate', 'CONSTRAINT_MISMATCH');
	}
	const recurrence = requiredConstraint(paymentConstraints, 'payment.agent_recurrence');
	if (recurrence.frequency !== 'ON_DEMAND' || recurrence.start_date !== prepared.notBefore.slice(0, 10) || recurrence.end_date !== prepared.expiresAt.slice(0, 10)) {
		throw new ViVerificationError('VI recurrence window does not match mandate dates', 'CONSTRAINT_MISMATCH');
	}
	const reference = requiredConstraint(paymentConstraints, 'payment.reference');
	if (reference.conditional_transaction_id !== await checkoutDisclosureHash(cryptoImpl, l2)) {
		throw new ViVerificationError('VI payment reference does not bind the checkout mandate', 'CONSTRAINT_MISMATCH');
	}
	if (!isObject(payment.payment_instrument) || payment.payment_instrument.type !== 'xrpl.ap4m' || payment.payment_instrument.id !== prepared.expectedOwner) {
		throw new ViVerificationError('VI payment instrument is not the prepared XRPL owner descriptor', 'CONSTRAINT_MISMATCH');
	}
}

/** Strict production verifier for AP4M's pinned VI v0.1 autonomous envelope. */
export async function verifyAp4mReferenceViChain(input: VerifyAp4mReferenceViInput): Promise<VerifiedViChain> {
	const cryptoImpl = input.crypto ?? crypto;
	const l1Header = parseJsonObject(decodeBase64Url(splitSdJwt(input.l1).jwt.split('.')[0] ?? ''), 'L1 protected header');
	const configuredKey = input.trustedIssuerJwk as unknown as JsonObject;
	if (l1Header.kid !== input.expectedIssuerKid || (configuredKey.kid !== undefined && configuredKey.kid !== input.expectedIssuerKid)) {
		throw new ViVerificationError('L1 issuer key id does not match the configured trust anchor', 'ISSUER_MISMATCH');
	}
	const verified = await verifyReferenceViChain(input);
	const l1 = verified.l1Claims;
	if (
		l1.iss !== input.expectedIssuer
		|| l1.pilot_issuer_name !== input.expectedIssuer
		|| l1.sub !== input.expectedOwner
		|| l1.of_verified !== true
		|| l1.budget_account !== input.expectedOwner
	) {
		throw new ViVerificationError('L1 Demo Network AP4M claims do not match the prepared owner', 'OWNER_MISMATCH');
	}
	if (
		typeof l1.nbf !== 'number'
		|| !Number.isInteger(l1.nbf)
		|| typeof l1.of_owner_name_hash !== 'string'
		|| !/^[a-fA-F0-9]{64}$/.test(l1.of_owner_name_hash)
		|| typeof l1.of_customer_ref !== 'string'
		|| !/^[a-fA-F0-9]{64}$/.test(l1.of_customer_ref)
	) {
		throw new ViVerificationError('L1 Demo Network AP4M proof claims are incomplete', 'INVALID_CLAIMS');
	}
	if (verified.l2Claims.iss !== input.expectedOwner) throw new ViVerificationError('L2 issuer does not match the prepared owner', 'OWNER_MISMATCH');
	if (verified.l2Claims.nonce !== input.expectedMandateId || verified.l2Claims.aud !== input.expectedAudience) {
		throw new ViVerificationError('L2 nonce or audience does not match this Harbor mandate', 'INVALID_CLAIMS');
	}
	const l2Expiry = verified.l2Claims.exp;
	if (typeof l2Expiry !== 'number' || l2Expiry > Math.floor(Date.parse(input.expiresAt) / 1_000)) {
		throw new ViVerificationError('L2 expiry exceeds the prepared mandate', 'INVALID_TIME');
	}
	await assertAp4mReferenceProjection(input.l2, verified.l2Claims, input, cryptoImpl);
	const delegates = verified.l2Claims.delegate_payload as JsonObject[];
	const agentPublicJwk = ((delegates.find((entry) => entry.vct === 'mandate.payment.open')?.cnf as JsonObject).jwk) as JsonObject;
	return {
		...verified,
		devicePublicJwk: ((verified.l1Claims.cnf as JsonObject).jwk) as JsonObject,
		agentPublicJwk,
		l1Digest: await viDigest(input.l1, cryptoImpl),
		l2Digest: await viDigest(input.l2, cryptoImpl),
	};
}
