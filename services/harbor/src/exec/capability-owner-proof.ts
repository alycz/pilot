import { decode, deriveAddress, encodeForSigning, verifyKeypairSignature } from 'xrpl';

import type { CapabilityNetwork, VerifiedCapabilityApproval } from './capability-broker';

const DIGEST = /^[a-f0-9]{64}$/;
const REFERENCE = /^cap_v1_[A-Za-z0-9_-]{32,128}$/;
const NONCE = /^[A-Za-z0-9_-]{32,128}$/;
const MEMO_TYPE = new TextEncoder().encode('pilot-capability-v1');
const MAX_PROOF_BYTES = 16_384;

export type CapabilityOwnerAction = 'activate' | 'revoke';

export type CapabilityOwnerReview = Readonly<{
	action: CapabilityOwnerAction;
	account: string;
	network: CapabilityNetwork;
	capabilityRef: string;
	generation: number;
	approvalDigest: string;
	nonce: string;
	approvedAt: string;
	expiresAt: string;
	txJson: Readonly<Record<string, unknown>>;
}>;

function hex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function utf8Hex(value: string): string {
	return hex(new TextEncoder().encode(value));
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (value && typeof value === 'object') {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

function randomNonce(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function memo(review: Omit<CapabilityOwnerReview, 'txJson'>): string {
	return utf8Hex(canonical({
		action: review.action,
		approvalDigest: review.approvalDigest,
		approvedAt: review.approvedAt,
		capabilityRef: review.capabilityRef,
		expiresAt: review.expiresAt,
		generation: review.generation,
		network: review.network,
		nonce: review.nonce,
	}));
}

function transaction(review: Omit<CapabilityOwnerReview, 'txJson'>): Readonly<Record<string, unknown>> {
	return Object.freeze({
		TransactionType: 'AccountSet',
		Account: review.account,
		Sequence: 0,
		Fee: '0',
		LastLedgerSequence: 0,
		Memos: [{ Memo: { MemoType: hex(MEMO_TYPE), MemoData: memo(review) } }],
	});
}

/** Build an exact sign-only AccountSet review payload. It is never submitted. */
export function buildCapabilityOwnerReview(input: Readonly<{
	action: CapabilityOwnerAction;
	account: string;
	network: CapabilityNetwork;
	capabilityRef: string;
	generation: number;
	approvalDigest: string;
}>, options: Readonly<{ now?: Date; nonce?: string; ttlMs?: number }> = {}): CapabilityOwnerReview {
	const now = options.now ?? new Date();
	const nonce = options.nonce ?? randomNonce();
	const ttlMs = options.ttlMs ?? 60_000;
	if (!Number.isFinite(now.getTime()) || input.network !== 'testnet' ||
		!REFERENCE.test(input.capabilityRef) || !DIGEST.test(input.approvalDigest) ||
		!Number.isSafeInteger(input.generation) || input.generation < 1 || !NONCE.test(nonce) ||
		!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 60_000) {
		throw new TypeError('Capability owner review is invalid');
	}
	const review = Object.freeze({
		...input,
		nonce,
		approvedAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
	});
	return Object.freeze({ ...review, txJson: transaction(review) });
}

/**
 * Verify exact fields and owner signature. This proves control of the owner
 * key; it does not prove that a physical Ledger rather than Speculos signed.
 */
export async function verifyCapabilityOwnerProof(
	review: Omit<CapabilityOwnerReview, 'txJson'>,
	txBlob: string,
	now = new Date(),
): Promise<VerifiedCapabilityApproval> {
	if (!Number.isFinite(now.getTime()) || review.network !== 'testnet' || Date.parse(review.expiresAt) <= now.getTime() ||
		Date.parse(review.approvedAt) > now.getTime() || !NONCE.test(review.nonce) ||
		!REFERENCE.test(review.capabilityRef) || !DIGEST.test(review.approvalDigest) ||
		typeof txBlob !== 'string' || txBlob.length === 0 || txBlob.length > MAX_PROOF_BYTES || !/^[A-Fa-f0-9]+$/.test(txBlob)) {
		throw new TypeError('Capability owner proof is invalid or expired');
	}
	let decoded: Record<string, unknown>;
	try {
		decoded = decode(txBlob) as Record<string, unknown>;
	} catch {
		throw new TypeError('Capability owner proof is invalid');
	}
	const signature = decoded.TxnSignature;
	const publicKey = decoded.SigningPubKey;
	const unsigned = { ...decoded };
	delete unsigned.TxnSignature;
	delete unsigned.SigningPubKey;
	if (typeof signature !== 'string' || typeof publicKey !== 'string' || publicKey.length === 0 ||
		canonical(unsigned) !== canonical(transaction(review)) || deriveAddress(publicKey) !== review.account ||
		!verifyKeypairSignature(encodeForSigning(decoded as never), signature, publicKey)) {
		throw new TypeError('Capability owner proof signature is invalid');
	}
	const approval = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(review.nonce));
	return Object.freeze({
		approvalId: `approval:${[...new Uint8Array(approval)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`,
		account: review.account,
		digest: review.approvalDigest,
		approvedAt: review.approvedAt,
		expiresAt: review.expiresAt,
		// A signed blob carries no authenticated transport provenance. Keep the
		// broker claim conservative even when the UI used Ledger or Speculos.
		evidence: Object.freeze({
			method: 'verified-account-signature' as const,
			runtime: 'other-wallet' as const,
			physicalDeviceInferred: false as const,
		}),
	});
}
