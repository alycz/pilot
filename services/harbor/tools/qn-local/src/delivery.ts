import { randomUUID } from 'node:crypto';

import { signedHeaders } from './sign.ts';

export async function postSignedDelivery(options: {
	url: string;
	secret: string;
	body: unknown;
	nonce?: string;
	timestamp?: string;
	fetchImpl?: typeof fetch;
}): Promise<Response> {
	const payload = JSON.stringify(options.body);
	const nonce = options.nonce ?? randomUUID();
	const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1_000));
	return await (options.fetchImpl ?? fetch)(options.url, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...signedHeaders(options.secret, payload, nonce, timestamp),
		},
		body: payload,
	});
}
