import {
	channelClaimProof,
	type ChannelClaimProof,
	type ChannelClaimStore,
} from './channel-claim-store';
import {
	withMandateClaimSigner,
	type WrappedMandateClaimKeys,
} from './channel-keys';
import type { MandateKeyIdentity } from './mandate-keys';

const UINT = /^(?:0|[1-9]\d*)$/;
const POSITIVE_UINT = /^[1-9]\d*$/;
const PUBLIC_KEY = /^(?:ED|02|03)[A-F0-9]{64}$/;
const MAX_DROPS = 100_000_000_000_000_000n;

export interface IssueChannelClaimInput {
	identity: MandateKeyIdentity;
	merchantId: string;
	channelId: string;
	payer: string;
	channelAmountDrops: string;
	priceDrops: string;
	idempotencyKey: string;
	token: string;
	at: string;
	wrappedKeys: WrappedMandateClaimKeys;
	/** Legacy base64 KEK or AWS-3's cached non-extractable AES-GCM KEK. */
	kek: CryptoKey | string;
}

export interface IssuedChannelClaim extends ChannelClaimProof {
	/** Internal replay marker; never include it in the merchant payment header. */
	replayed: boolean;
}

export interface IssueChannelClaimDependencies {
	store: ChannelClaimStore;
	withSigner?: typeof withMandateClaimSigner;
}

export class ChannelClaimError extends Error {
	constructor(
		message: string,
		readonly code:
			| 'INVALID_CLAIM_AMOUNT'
			| 'CHANNEL_AMOUNT_EXCEEDED'
			| 'CLAIM_IN_PROGRESS'
			| 'CLAIM_STORE_CONFLICT'
			| 'CLAIM_KEY_MISMATCH',
		readonly cause?: unknown,
	) {
		super(message);
		this.name = 'ChannelClaimError';
	}
}

function amount(value: string, field: string, allowZero: boolean): bigint {
	const pattern = allowZero ? UINT : POSITIVE_UINT;
	if (typeof value !== 'string' || value.length > 18 || !pattern.test(value)) {
		throw new ChannelClaimError(`${field} is invalid`, 'INVALID_CLAIM_AMOUNT');
	}
	const parsed = BigInt(value);
	if (parsed > MAX_DROPS) {
		throw new ChannelClaimError(`${field} is invalid`, 'INVALID_CLAIM_AMOUNT');
	}
	return parsed;
}

/** Pure cumulative-claim math shared by the durable store tests and rail. */
export function nextChannelClaim(
	previousDrops: string,
	priceDrops: string,
	channelAmountDrops: string,
): string {
	const previous = amount(previousDrops, 'previous claim amount', true);
	const price = amount(priceDrops, 'claim price', false);
	const channelAmount = amount(channelAmountDrops, 'channel amount', false);
	if (previous > channelAmount) {
		throw new ChannelClaimError('Previous claim exceeds the channel amount', 'INVALID_CLAIM_AMOUNT');
	}
	const next = previous + price;
	if (next > channelAmount) {
		throw new ChannelClaimError('Payment-channel amount would be exceeded', 'CHANNEL_AMOUNT_EXCEEDED');
	}
	return next.toString();
}

/** Project the exact five-field merchant payment header without internal state. */
export function channelPaymentHeader(claim: IssuedChannelClaim): ChannelClaimProof {
	return {
		scheme: 'xrpl-paychan',
		channel_id: claim.channel_id,
		cumulative_drops: claim.cumulative_drops,
		signature: claim.signature,
		public_key: claim.public_key,
	};
}

/**
 * Atomically reserve, sign and persist one cumulative payment-channel claim.
 * Retries with the same idempotency key return the byte-identical durable proof.
 */
export async function issueChannelClaim(
	input: IssueChannelClaimInput,
	dependencies: IssueChannelClaimDependencies,
): Promise<IssuedChannelClaim> {
	const merchantKeys = Array.isArray(input.wrappedKeys.publicKeys)
		? input.wrappedKeys.publicKeys.filter((entry) =>
			entry && typeof entry === 'object' && entry.merchant_id === input.merchantId)
		: [];
	const expectedPublicKey = merchantKeys.length === 1 ? merchantKeys[0]!.public_key : undefined;
	if (typeof expectedPublicKey !== 'string' || !PUBLIC_KEY.test(expectedPublicKey)) {
		throw new ChannelClaimError('Mandate has no claim key for this merchant', 'CLAIM_KEY_MISMATCH');
	}
	let reserved;
	try {
		reserved = await dependencies.store.reserve({
			principal: input.identity.principal,
			mandateId: input.identity.mandateId,
			merchantId: input.merchantId,
			channelId: input.channelId,
			payer: input.payer,
			channelAmountDrops: input.channelAmountDrops,
			publicKey: expectedPublicKey,
			priceDrops: input.priceDrops,
			idempotencyKey: input.idempotencyKey,
			token: input.token,
			at: input.at,
		});
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'CLAIM_CAP_EXCEEDED') {
			throw new ChannelClaimError('Payment-channel amount would be exceeded', 'CHANNEL_AMOUNT_EXCEEDED', error);
		}
		throw error;
	}
	if (reserved.outcome === 'replay') return { ...reserved.proof, replayed: true };
	if (reserved.outcome === 'blocked') {
		throw new ChannelClaimError('Another claim is in progress for this channel', 'CLAIM_IN_PROGRESS');
	}
	const reservation = reserved.reservation;
	if (
		reservation.cumulativeDrops !== nextChannelClaim(
			reserved.row.cumulativeDrops,
			input.priceDrops,
			input.channelAmountDrops,
		) || reservation.publicKey !== expectedPublicKey
	) {
		throw new ChannelClaimError('Durable claim reservation is inconsistent', 'CLAIM_STORE_CONFLICT');
	}

	const run = dependencies.withSigner ?? withMandateClaimSigner;
	const signature = await run(
		input.identity,
		input.wrappedKeys,
		input.merchantId,
		input.kek,
		async (signer) => {
			if (signer.publicKey !== reservation.publicKey) {
				throw new ChannelClaimError('Claim signer does not match the mandate', 'CLAIM_KEY_MISMATCH');
			}
			return signer.sign(reservation.channelId, reservation.cumulativeDrops);
		},
	);
	const completed = await dependencies.store.complete({
		...reservation,
		signature,
		at: input.at,
	});
	if (completed.outcome === 'blocked') {
		throw new ChannelClaimError('Durable claim completion conflicted', 'CLAIM_STORE_CONFLICT');
	}
	return { ...channelClaimProof(completed.row), replayed: completed.outcome === 'replay' };
}
