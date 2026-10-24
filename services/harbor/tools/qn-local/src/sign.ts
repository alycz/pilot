import { createHmac, timingSafeEqual } from 'node:crypto';

export type SignedDelivery = {
	'X-QN-Nonce': string;
	'X-QN-Timestamp': string;
	'X-QN-Signature': string;
};

export function quickNodeSignature(secret: string, payload: string, nonce: string, timestamp: string): string {
	return createHmac('sha256', secret).update(nonce).update(timestamp).update(payload).digest('hex');
}

export function signedHeaders(secret: string, payload: string, nonce: string, timestamp: string): SignedDelivery {
	return {
		'X-QN-Nonce': nonce,
		'X-QN-Timestamp': timestamp,
		'X-QN-Signature': quickNodeSignature(secret, payload, nonce, timestamp),
	};
}

export function sameSignature(left: string, right: string): boolean {
	if (!/^[a-f\d]{64}$/i.test(left) || !/^[a-f\d]{64}$/i.test(right)) return false;
	return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
