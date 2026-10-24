import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { runQuickNodeFilter } from './filter.ts';
import { JsonQnLocalStore, type QnLocalStore } from './store.ts';

const MAX_BODY_BYTES = 1_048_576;

type LocalWebhook = {
	id: string;
	name: string;
	status: 'active';
	network: string;
	destination_attributes: {
		url: string;
		security_token: string;
		compression: 'none';
	};
	templateArgs: { walletsListName: string };
};

type LocalStream = {
	id: string;
	name: string;
	status: 'active' | 'paused';
	network: string;
	dataset: string;
	filter_function: string;
	region: string;
	dataset_batch_size: number;
	elastic_batch_enabled: boolean;
	end_range: -1;
	destination: 'webhook';
	destination_attributes: {
		url: string;
		security_token: string;
		compression: 'none';
		max_retry: number;
		retry_interval_sec: number;
		post_timeout_sec: number;
	};
};

export class LocalManagementStore {
	readonly webhooks = new Map<string, LocalWebhook>();
	readonly streams = new Map<string, LocalStream>();
	#webhookId = 0;
	#streamId = 0;

	createWebhook(configuration: Omit<LocalWebhook, 'id' | 'status'>): LocalWebhook {
		const webhook = {
			...configuration,
			id: `webhook-${++this.#webhookId}`,
			status: 'active' as const,
		};
		this.webhooks.set(webhook.id, webhook);
		return webhook;
	}

	createStream(configuration: Omit<LocalStream, 'id'>): LocalStream {
		const stream = { ...configuration, id: `stream-${++this.#streamId}` };
		this.streams.set(stream.id, stream);
		return stream;
	}
}

class HttpError extends Error {
	constructor(readonly status: number, message: string) { super(message); }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
	const body = Buffer.from(JSON.stringify(value), 'utf8');
	response.writeHead(status, {
		'content-type': 'application/json',
		'content-length': String(body.byteLength),
		'cache-control': 'no-store',
	});
	response.end(body);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.byteLength;
		if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body is too large');
		chunks.push(buffer);
	}
	if (chunks.length === 0) return {};
	try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
	catch { throw new HttpError(400, 'request body must be valid JSON'); }
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'request body must be an object');
	return value as Record<string, unknown>;
}

function strings(value: unknown, field: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new HttpError(400, `${field} must be an array of strings`);
	return value;
}

function key(value: unknown): string {
	if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value)) throw new HttpError(400, 'invalid key');
	return value;
}

function decodeSegment(value: string): string {
	try { return key(decodeURIComponent(value)); }
	catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'invalid path encoding'); }
}

function text(value: unknown, field: string, max = 2_048): string {
	if (
		typeof value !== 'string' || value.length === 0 || value.length > max ||
		/[\u0000-\u001f\u007f]/.test(value)
	) throw new HttpError(400, `${field} is invalid`);
	return value;
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new HttpError(400, `${field} is invalid`);
	}
	return value as number;
}

function boolean(value: unknown, field: string): boolean {
	if (typeof value !== 'boolean') throw new HttpError(400, `${field} is invalid`);
	return value;
}

function destinationUrl(value: unknown): string {
	const raw = text(value, 'destination url');
	let parsed: URL;
	try { parsed = new URL(raw); } catch { throw new HttpError(400, 'destination url is invalid'); }
	if (
		parsed.username || parsed.password || parsed.search || parsed.hash ||
		(parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
		(parsed.protocol === 'http:' && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname))
	) throw new HttpError(400, 'destination url is invalid');
	return parsed.toString();
}

function webhookBody(value: unknown): Omit<LocalWebhook, 'id' | 'status'> {
	const body = record(value);
	const destination = record(body.destination_attributes);
	const args = record(body.templateArgs);
	if (!destination || !args || destination.compression !== 'none') {
		throw new HttpError(400, 'webhook configuration is invalid');
	}
	return {
		name: text(body.name, 'webhook name', 200),
		network: text(body.network, 'webhook network', 100),
		destination_attributes: {
			url: destinationUrl(destination.url),
			security_token: text(destination.security_token, 'webhook security token', 4_096),
			compression: 'none',
		},
		templateArgs: { walletsListName: key(args.walletsListName) },
	};
}

function streamBody(value: unknown): Omit<LocalStream, 'id'> {
	const body = record(value);
	const destination = record(body.destination_attributes);
	if (
		!destination || body.end_range !== -1 || body.destination !== 'webhook' ||
		destination.compression !== 'none' || body.status !== 'active'
	) throw new HttpError(400, 'stream configuration is invalid');
	const filterFunction = text(body.filter_function, 'filter function', 500_000);
	try {
		if (Buffer.from(filterFunction, 'base64').toString('base64') !== filterFunction) {
			throw new Error('not canonical');
		}
	} catch {
		throw new HttpError(400, 'filter function is invalid');
	}
	return {
		name: text(body.name, 'stream name', 200),
		network: text(body.network, 'stream network', 100),
		dataset: text(body.dataset, 'stream dataset', 100),
		filter_function: filterFunction,
		region: text(body.region, 'stream region', 100),
		dataset_batch_size: integer(body.dataset_batch_size, 'dataset batch size', 1, 1_000),
		elastic_batch_enabled: boolean(body.elastic_batch_enabled, 'elastic batch enabled'),
		end_range: -1,
		destination: 'webhook',
		destination_attributes: {
			url: destinationUrl(destination.url),
			security_token: text(destination.security_token, 'stream security token', 4_096),
			compression: 'none',
			max_retry: integer(destination.max_retry, 'max retry', 0, 100),
			retry_interval_sec: integer(destination.retry_interval_sec, 'retry interval', 0, 3_600),
			post_timeout_sec: integer(destination.post_timeout_sec, 'post timeout', 1, 300),
		},
		status: 'active',
	};
}

function publicWebhook(webhook: LocalWebhook): Record<string, unknown> {
	return {
		id: webhook.id,
		name: webhook.name,
		status: webhook.status,
		network: webhook.network,
		destination_attributes: {
			url: webhook.destination_attributes.url,
			compression: webhook.destination_attributes.compression,
		},
		templateArgs: webhook.templateArgs,
	};
}

function publicStream(stream: LocalStream): Record<string, unknown> {
	return {
		id: stream.id,
		name: stream.name,
		status: stream.status,
		network: stream.network,
		dataset: stream.dataset,
		filter_function: stream.filter_function,
		region: stream.region,
		dataset_batch_size: stream.dataset_batch_size,
		elastic_batch_enabled: stream.elastic_batch_enabled,
		end_range: stream.end_range,
		destination: stream.destination,
		destination_attributes: {
			url: stream.destination_attributes.url,
			compression: stream.destination_attributes.compression,
			max_retry: stream.destination_attributes.max_retry,
			retry_interval_sec: stream.destination_attributes.retry_interval_sec,
			post_timeout_sec: stream.destination_attributes.post_timeout_sec,
		},
	};
}

export type QnLocalServerOptions = {
	store?: QnLocalStore;
	filterSource?: string;
	ledgerFetcher?: (index: number) => Promise<unknown>;
	management?: LocalManagementStore;
};

export function createQnLocalHandler(options: QnLocalServerOptions = {}) {
	const store = options.store ?? new JsonQnLocalStore();
	const management = options.management ?? new LocalManagementStore();
	return async (request: IncomingMessage, response: ServerResponse) => {
		try {
			if (typeof request.headers['x-api-key'] !== 'string' || request.headers['x-api-key'].length === 0) {
				throw new HttpError(401, 'x-api-key is required');
			}
			const url = new URL(request.url ?? '/', 'http://127.0.0.1');
			const method = request.method ?? 'GET';
			const listMatch = /^\/kv\/rest\/v1\/lists\/([^/]+)$/.exec(url.pathname);
			const containsMatch = /^\/kv\/rest\/v1\/lists\/([^/]+)\/contains\/([^/]+)$/.exec(url.pathname);
			const valueMatch = /^\/kv\/rest\/v1\/values\/([^/]+)$/.exec(url.pathname);
			const webhookMatch = /^\/webhooks\/rest\/v1\/webhooks\/([^/]+)$/.exec(url.pathname);
			const streamMatch = /^\/streams\/rest\/v1\/streams\/([^/]+)$/.exec(url.pathname);
			const streamPauseMatch = /^\/streams\/rest\/v1\/streams\/([^/]+)\/pause$/.exec(url.pathname);

			if (method === 'GET' && url.pathname === '/webhooks/rest/v1/webhooks') {
				return sendJson(response, 200, { webhooks: [...management.webhooks.values()].map(publicWebhook) });
			}
			if (method === 'POST' && url.pathname === '/webhooks/rest/v1/webhooks/template/xrplWalletFilter') {
				const created = management.createWebhook(webhookBody(await readBody(request)));
				return sendJson(response, 200, { id: created.id });
			}
			if (webhookMatch && method === 'GET') {
				const webhook = management.webhooks.get(decodeSegment(webhookMatch[1]));
				if (!webhook) throw new HttpError(404, 'webhook not found');
				return sendJson(response, 200, publicWebhook(webhook));
			}
			if (webhookMatch && method === 'DELETE') {
				const deleted = management.webhooks.delete(decodeSegment(webhookMatch[1]));
				if (!deleted) throw new HttpError(404, 'webhook not found');
				return sendJson(response, 200, { deleted: true });
			}
			if (method === 'GET' && url.pathname === '/streams/rest/v1/streams') {
				return sendJson(response, 200, { streams: [...management.streams.values()].map(publicStream) });
			}
			if (method === 'POST' && url.pathname === '/streams/rest/v1/streams') {
				const created = management.createStream(streamBody(await readBody(request)));
				return sendJson(response, 200, { id: created.id });
			}
			if (streamPauseMatch && method === 'POST') {
				const id = decodeSegment(streamPauseMatch[1]);
				const stream = management.streams.get(id);
				if (!stream) throw new HttpError(404, 'stream not found');
				management.streams.set(id, { ...stream, status: 'paused' });
				return sendJson(response, 200, { id, status: 'paused' });
			}
			if (streamMatch && method === 'GET') {
				const stream = management.streams.get(decodeSegment(streamMatch[1]));
				if (!stream) throw new HttpError(404, 'stream not found');
				return sendJson(response, 200, publicStream(stream));
			}
			if (streamMatch && method === 'DELETE') {
				const deleted = management.streams.delete(decodeSegment(streamMatch[1]));
				if (!deleted) throw new HttpError(404, 'stream not found');
				return sendJson(response, 200, { deleted: true });
			}

			if (method === 'POST' && url.pathname === '/kv/rest/v1/lists') {
				const body = record(await readBody(request));
				const list = await store.putList(key(body.key), strings(body.items, 'items'));
				return sendJson(response, 200, { key: body.key, items: list });
			}
			if (listMatch && method === 'GET') {
				const listKey = decodeSegment(listMatch[1]);
				const list = await store.getList(listKey);
				if (!list) throw new HttpError(404, 'list not found');
				return sendJson(response, 200, { key: listKey, items: list });
			}
			if (listMatch && method === 'PATCH') {
				const body = record(await readBody(request));
				const listKey = decodeSegment(listMatch[1]);
				const list = await store.patchList(listKey, strings(body.addItems, 'addItems'), strings(body.removeItems, 'removeItems'));
				return sendJson(response, 200, { key: listKey, items: list });
			}
			if (listMatch && method === 'DELETE') {
				const listKey = decodeSegment(listMatch[1]);
				return sendJson(response, 200, { deleted: await store.deleteList(listKey) });
			}
			if (containsMatch && method === 'GET') {
				const list = await store.getList(decodeSegment(containsMatch[1]));
				if (!list) throw new HttpError(404, 'list not found');
				const item = decodeURIComponent(containsMatch[2]);
				return sendJson(response, 200, { contains: list.includes(item) });
			}
			if (method === 'POST' && url.pathname === '/kv/rest/v1/values') {
				const body = record(await readBody(request));
				await store.putValue(key(body.key), body.value);
				return sendJson(response, 200, { key: body.key, value: body.value });
			}
			if (valueMatch && method === 'GET') {
				const valueKey = decodeSegment(valueMatch[1]);
				const value = await store.getValue(valueKey);
				if (value === undefined) throw new HttpError(404, 'value not found');
				return sendJson(response, 200, { key: valueKey, value });
			}
			if (method === 'POST' && url.pathname === '/streams/rest/v1/streams/test_filter') {
				const body = record(await readBody(request));
				const source = typeof body.filter_function === 'string' ? body.filter_function : options.filterSource;
				if (!source) throw new HttpError(400, 'filter_function is required');
				let data = body.data;
				if (data === undefined && Number.isSafeInteger(body.ledger_index) && options.ledgerFetcher) {
					data = await options.ledgerFetcher(body.ledger_index as number);
				}
				if (data === undefined) throw new HttpError(400, 'data or configured ledger_index is required');
				const result = await runQuickNodeFilter(source, { data, metadata: body.metadata }, store);
				return sendJson(response, 200, { result });
			}
			throw new HttpError(404, 'unsupported QuickNode stand-in path');
		} catch (error) {
			const status = error instanceof HttpError ? error.status : 500;
			const message = error instanceof HttpError ? error.message : 'QuickNode stand-in request failed';
			return sendJson(response, status, { error: message });
		}
	};
}

export function createQnLocalServer(options: QnLocalServerOptions = {}): Server {
	const handler = createQnLocalHandler(options);
	return createServer((request, response) => { void handler(request, response); });
}
