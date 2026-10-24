import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { MemoryKeyStore } from '../tools/aws-local/src/key-store';
import {
	createAwsLocalRequestHandler,
	dispatchAwsLocalRequest,
} from '../tools/aws-local/src/server';

const authorization = 'AWS4-HMAC-SHA256 Credential=LOCAL/19700101/us-east-1/kms/aws4_request';

async function callHandler(input: {
	path: string;
	contentType: string;
	target?: string;
	body: unknown;
}): Promise<ReturnType<typeof vi.fn>> {
	const encoded = Buffer.from(JSON.stringify(input.body), 'utf8');
	const request = {
		method: 'POST',
		url: input.path,
		headers: {
			authorization,
			'content-type': input.contentType,
			...(input.target ? { 'x-amz-target': input.target } : {}),
		},
		async *[Symbol.asyncIterator]() {
			yield encoded;
		},
	} as unknown as IncomingMessage;
	const writeHead = vi.fn();
	const response = {
		writeHead,
		end: vi.fn(),
	} as unknown as ServerResponse;

	await createAwsLocalRequestHandler({ store: new MemoryKeyStore() })(request, response);
	return writeHead;
}

describe('aws-local HTTP server', () => {
	it('rejects a missing SigV4 Authorization header', async () => {
		const response = await dispatchAwsLocalRequest(
			{
				method: 'POST',
				target: 'TrentService.CreateKey',
				body: { KeySpec: 'SYMMETRIC_DEFAULT', KeyUsage: 'ENCRYPT_DECRYPT' },
			},
			{ store: new MemoryKeyStore() },
		);

		expect(response.statusCode).toBe(403);
		expect(response.body).toEqual({
			__type: 'InvalidRequestException',
			message: 'A SigV4 Authorization header is required',
		});
	});

	it('accepts a signed-looking local KMS JSON request', async () => {
		const response = await dispatchAwsLocalRequest(
			{
				method: 'POST',
				authorization,
				path: '/',
				target: 'TrentService.CreateKey',
				body: { KeySpec: 'SYMMETRIC_DEFAULT', KeyUsage: 'ENCRYPT_DECRYPT' },
			},
			{ store: new MemoryKeyStore() },
		);

		expect(response.statusCode).toBe(200);
		const body = response.body as Record<string, unknown>;
		expect(body.KeyMetadata).toMatchObject({
			KeySpec: 'SYMMETRIC_DEFAULT',
			KeyUsage: 'ENCRYPT_DECRYPT',
			KeyState: 'Enabled',
		});
		expect(JSON.stringify(body)).not.toContain('material');
	});

	it('does not echo a rejected request body in the error', async () => {
		const marker = 'do-not-echo-this-request-body';
		const response = await dispatchAwsLocalRequest(
			{ method: 'POST', authorization, target: 'TrentService.Sign', body: { marker } },
			{ store: new MemoryKeyStore() },
		);
		const text = JSON.stringify(response.body);

		expect(response.statusCode).toBe(400);
		expect(text).not.toContain(marker);
	});

	it('accepts Guardrails on the documented JSON path without X-Amz-Target', async () => {
		const response = await dispatchAwsLocalRequest(
			{
				method: 'POST',
				authorization,
				path: '/guardrail-checks/invoke',
				contentType: 'application/json',
				body: {
					messages: [{ role: 'user', content: [{ text: 'ordinary token name' }] }],
					checks: {
						promptAttack: {
							categories: [{ category: 'PROMPT_INJECTION' }, { category: 'JAILBREAK' }],
						},
					},
				},
			},
			{ store: new MemoryKeyStore() },
		);

		expect(response.statusCode).toBe(200);
		expect(response.body).toMatchObject({
			results: {
				promptAttack: {
					results: [
						{ category: 'PROMPT_INJECTION', severityScore: 0.02 },
						{ category: 'JAILBREAK', severityScore: 0.02 },
					],
				},
			},
		});
	});

	it('rejects Guardrails on the wrong path or without application/json', async () => {
		const body = {
			messages: [{ role: 'user', content: [{ text: 'ordinary token name' }] }],
			checks: { promptAttack: { categories: [{ category: 'PROMPT_INJECTION' }] } },
		};
		const wrongPath = await dispatchAwsLocalRequest(
			{
				method: 'POST',
				authorization,
				path: '/guardrail-checks',
				contentType: 'application/json',
				body,
			},
			{ store: new MemoryKeyStore() },
		);
		const wrongType = await dispatchAwsLocalRequest(
			{
				method: 'POST',
				authorization,
				path: '/guardrail-checks/invoke',
				contentType: 'application/x-amz-json-1.1',
				body,
			},
			{ store: new MemoryKeyStore() },
		);

		expect(wrongPath.statusCode).toBe(404);
		expect(wrongType.statusCode).toBe(415);
	});

	it('keeps KMS on the root TrentService target protocol', async () => {
		const body = { KeySpec: 'SYMMETRIC_DEFAULT', KeyUsage: 'ENCRYPT_DECRYPT' };
		const wrongPath = await dispatchAwsLocalRequest(
			{
				method: 'POST',
				authorization,
				path: '/kms',
				target: 'TrentService.CreateKey',
				body,
			},
			{ store: new MemoryKeyStore() },
		);
		const wrongTarget = await dispatchAwsLocalRequest(
			{
				method: 'POST',
				authorization,
				path: '/',
				target: 'BedrockRuntime.InvokeGuardrailChecks',
				body,
			},
			{ store: new MemoryKeyStore() },
		);

		expect(wrongPath.statusCode).toBe(404);
		expect(wrongTarget.statusCode).toBe(404);
	});

	it('returns application/json from the Guardrails HTTP handler', async () => {
		const writeHead = await callHandler({
			path: '/guardrail-checks/invoke',
			contentType: 'application/json',
			body: {
				messages: [{ role: 'user', content: [{ text: 'ordinary token name' }] }],
				checks: { promptAttack: { categories: [{ category: 'PROMPT_INJECTION' }] } },
			},
		});

		expect(writeHead).toHaveBeenCalledWith(
			200,
			expect.objectContaining({ 'content-type': 'application/json' }),
		);
	});

	it('retains application/x-amz-json-1.1 for the KMS HTTP handler', async () => {
		const writeHead = await callHandler({
			path: '/',
			contentType: 'application/x-amz-json-1.1',
			target: 'TrentService.CreateKey',
			body: { KeySpec: 'SYMMETRIC_DEFAULT', KeyUsage: 'ENCRYPT_DECRYPT' },
		});

		expect(writeHead).toHaveBeenCalledWith(
			200,
			expect.objectContaining({ 'content-type': 'application/x-amz-json-1.1' }),
		);
	});
});
