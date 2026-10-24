import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { handleGuardrails } from './guardrails.ts';
import { JsonKeyStore, type LocalKmsStore } from './key-store.ts';
import { handleKms, LocalKmsError } from './kms.ts';

const DEFAULT_MAX_BODY_BYTES = 1_048_576;

export type AwsLocalServerOptions = {
	store?: LocalKmsStore;
	maxBodyBytes?: number;
};

export type AwsLocalDispatchRequest = {
	method: string;
	authorization?: string;
	path?: string;
	contentType?: string;
	target?: string;
	body: unknown;
};

export type AwsLocalDispatchResponse = {
	statusCode: number;
	body: unknown;
};

function responseContentType(path: string): string {
	return path === '/guardrail-checks/invoke' ? 'application/json' : 'application/x-amz-json-1.1';
}

function sendJson(
	response: ServerResponse,
	statusCode: number,
	body: unknown,
	contentType: string,
): void {
	const encoded = Buffer.from(JSON.stringify(body), 'utf8');
	response.writeHead(statusCode, {
		'content-type': contentType,
		'content-length': String(encoded.byteLength),
		'cache-control': 'no-store',
	});
	response.end(encoded);
}

function isSigV4Authorization(value: string | undefined): boolean {
	return typeof value === 'string' && /^AWS4-HMAC-SHA256\s/.test(value);
}

async function readJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.byteLength;
		if (size > maxBodyBytes) {
			throw new HttpRequestError(413, 'Request body is too large');
		}
		chunks.push(buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
	} catch {
		throw new HttpRequestError(400, 'Request body must be valid JSON');
	}
}

class HttpRequestError extends Error {
	constructor(
		readonly statusCode: number,
		message: string,
	) {
		super(message);
		this.name = 'HttpRequestError';
	}
}

function statusCodeOf(error: unknown): number {
	if (error instanceof LocalKmsError || error instanceof HttpRequestError) return error.statusCode;
	if (
		error &&
		typeof error === 'object' &&
		'statusCode' in error &&
		typeof error.statusCode === 'number'
	) {
		return error.statusCode;
	}
	return 500;
}

function codeOf(error: unknown): string {
	if (error instanceof LocalKmsError) return error.code;
	if (error instanceof HttpRequestError) return 'InvalidRequestException';
	if (error instanceof Error && error.name === 'GuardrailValidationError') return 'ValidationException';
	return 'InternalFailure';
}

function safeMessage(error: unknown): string {
	if (error instanceof LocalKmsError || error instanceof HttpRequestError) return error.message;
	if (error instanceof Error && error.name === 'GuardrailValidationError') return 'Guardrails request is invalid';
	return 'Local AWS stand-in request failed';
}

export async function dispatchAwsLocalRequest(
	request: AwsLocalDispatchRequest,
	options: AwsLocalServerOptions = {},
): Promise<AwsLocalDispatchResponse> {
	const store = options.store ?? new JsonKeyStore();
	try {
		if (request.method !== 'POST') throw new HttpRequestError(405, 'Only POST is supported');
		if (!isSigV4Authorization(request.authorization)) {
			throw new HttpRequestError(403, 'A SigV4 Authorization header is required');
		}
		const path = request.path ?? '/';
		let body: unknown;
		if (path === '/guardrail-checks/invoke') {
			if (!/^application\/json(?:\s*;|$)/i.test(request.contentType ?? '')) {
				throw new HttpRequestError(415, 'Guardrails requires Content-Type application/json');
			}
			body = await handleGuardrails('InvokeGuardrailChecks', request.body);
		} else if (path === '/') {
			if (!request.target) throw new HttpRequestError(400, 'X-Amz-Target is required');
			if (!request.target.startsWith('TrentService.')) {
				throw new HttpRequestError(404, 'Unsupported AWS JSON target');
			}
			body = await handleKms(request.target, request.body, store);
		} else {
			throw new HttpRequestError(404, 'Unsupported AWS stand-in path');
		}
		return { statusCode: 200, body };
	} catch (error) {
		return {
			statusCode: statusCodeOf(error),
			body: { __type: codeOf(error), message: safeMessage(error) },
		};
	}
}

export function createAwsLocalRequestHandler(
	options: AwsLocalServerOptions = {},
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
	const store = options.store ?? new JsonKeyStore();
	const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

	return async (request, response) => {
		const path = request.url ?? '/';
		try {
			const target = request.headers['x-amz-target'];
			if (request.method !== 'POST') throw new HttpRequestError(405, 'Only POST is supported');
			if (!isSigV4Authorization(request.headers.authorization)) {
				throw new HttpRequestError(403, 'A SigV4 Authorization header is required');
			}
			const body = await readJsonBody(request, maxBodyBytes);
			const result = await dispatchAwsLocalRequest(
				{
					method: request.method,
					authorization: request.headers.authorization,
					path,
					contentType: request.headers['content-type'],
					target: typeof target === 'string' ? target : undefined,
					body,
				},
				{ store },
			);
			sendJson(response, result.statusCode, result.body, responseContentType(path));
		} catch (error) {
			sendJson(
				response,
				statusCodeOf(error),
				{
					__type: codeOf(error),
					message: safeMessage(error),
				},
				responseContentType(path),
			);
		}
	};
}

export function createAwsLocalServer(options: AwsLocalServerOptions = {}): Server {
	const handler = createAwsLocalRequestHandler(options);
	return createServer((request, response) => {
		void handler(request, response);
	});
}
