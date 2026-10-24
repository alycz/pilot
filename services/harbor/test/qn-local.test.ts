import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { postSignedDelivery } from '../tools/qn-local/src/delivery.ts';
import { createQnLocalServer } from '../tools/qn-local/src/server.ts';
import { quickNodeSignature } from '../tools/qn-local/src/sign.ts';
import { JsonQnLocalStore } from '../tools/qn-local/src/store.ts';
import { publicTestnetWebsocket, startXrplRelay, type XrplRelayClient } from '../tools/qn-local/src/relay.ts';
import { verifyQuickNode, type QuickNodeNonceStore } from '../src/quicknode/hmac';
import { QuickNodeAdminClient } from '../scripts/quicknode/lib/admin-client.ts';
import { runProvision, type ProvisionConfig } from '../scripts/quicknode/provision.ts';

describe('QuickNode local stand-in', () => {
	let server: ReturnType<typeof createQnLocalServer>;
	let base: string;

	beforeEach(async () => {
		const root = await mkdtemp(join(tmpdir(), 'qn-local-'));
		const store = new JsonQnLocalStore(join(root, 'kv.json'));
		server = createQnLocalServer({ store });
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	});

	async function request(path: string, init: RequestInit = {}): Promise<Response> {
		return await fetch(`${base}${path}`, { ...init, headers: { 'x-api-key': 'local-test', 'content-type': 'application/json', ...init.headers } });
	}

	it('requires an API key and supports a persistent list round trip', async () => {
		expect((await fetch(`${base}/kv/rest/v1/lists`)).status).toBe(401);
		const created = await request('/kv/rest/v1/lists', { method: 'POST', body: JSON.stringify({ key: 'wallets', items: ['rA', 'rA'] }) });
		expect(created.status).toBe(200);
		expect(await created.json()).toEqual({ key: 'wallets', items: ['rA'] });
		await request('/kv/rest/v1/lists/wallets', { method: 'PATCH', body: JSON.stringify({ addItems: ['rB'], removeItems: ['rA'] }) });
		expect(await (await request('/kv/rest/v1/lists/wallets')).json()).toEqual({ key: 'wallets', items: ['rB'] });
		expect(await (await request('/kv/rest/v1/lists/wallets/contains/rB')).json()).toEqual({ contains: true });
	});

	it('stores and retrieves JSON values', async () => {
		await request('/kv/rest/v1/values', { method: 'POST', body: JSON.stringify({ key: 'mode', value: { enabled: true } }) });
		expect(await (await request('/kv/rest/v1/values/mode')).json()).toEqual({ key: 'mode', value: { enabled: true } });
	});

	it('runs a filter with an injected qnLib store', async () => {
		await request('/kv/rest/v1/lists', { method: 'POST', body: JSON.stringify({ key: 'watched', items: ['rA'] }) });
		const source = 'async function main(stream) { const found = await qnLib.qnContainsListItems("watched", stream.data); return found.some(Boolean) ? {found} : null; }';
		const response = await request('/streams/rest/v1/streams/test_filter', { method: 'POST', body: JSON.stringify({ filter_function: source, data: ['rA', 'rZ'] }) });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ result: { found: [true, false] } });
	});
});

describe('QuickNode-compatible delivery signatures', () => {
	it('signs nonce + timestamp + payload and delivers those headers', async () => {
		const payload = JSON.stringify({ data: [{ hash: 'A' }] });
		expect(quickNodeSignature('secret', payload, 'n-1', '123')).toMatch(/^[a-f\d]{64}$/);
		let observed: RequestInit | undefined;
		const response = await postSignedDelivery({
			url: 'http://127.0.0.1/hook', secret: 'secret', body: { data: [{ hash: 'A' }] }, nonce: 'n-1', timestamp: '123',
			fetchImpl: (async (_url, init) => { observed = init; return new Response(null, { status: 200 }); }) as typeof fetch,
		});
		expect(response.status).toBe(200);
		expect(new Headers(observed?.headers).get('x-qn-signature')).toBe(quickNodeSignature('secret', payload, 'n-1', '123'));
	});
});

describe('QuickNode local management API', () => {
	let server: ReturnType<typeof createQnLocalServer>;
	let base: string;

	beforeEach(async () => {
		const root = await mkdtemp(join(tmpdir(), 'qn-local-management-'));
		const store = new JsonQnLocalStore(join(root, 'kv.json'));
		server = createQnLocalServer({
			store,
			ledgerFetcher: async (index) => ({ kind: index === 12 ? 'none' : 'watched' }),
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	});

	function config(): ProvisionConfig {
		return {
			run: 'run1',
			network: 'testnet',
			networkSlug: 'xrp-testnet',
			dataset: 'Ledger',
			region: 'usa',
			harborPublicUrl: 'http://127.0.0.1:8799',
			webhookSecurityToken: 'webhook-local-token',
			streamSecurityToken: 'stream-local-token',
			webhookDeletePath: '/webhooks/rest/v1/webhooks/{id}',
			statePath: join(tmpdir(), 'qn-local-state.json'),
			filterSource: 'async function main(stream) { return stream.data.kind === "none" ? null : {events:[{tx_hash:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}]}; }',
			testLedgers: { harbor: 10, rogue: 11, none: 12 },
		};
	}

	function client(): QuickNodeAdminClient {
		return new QuickNodeAdminClient({ base, apiKey: 'local-management-test' });
	}

	async function reconcile(): Promise<void> {
		for (const suffix of ['accounts', 'delegates', 'frozen', 'tx_types', 'issuers']) {
			const response = await fetch(`${base}/kv/rest/v1/lists`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-api-key': 'local-management-test' },
				body: JSON.stringify({ key: `harbor_testnet_run1_${suffix}`, items: [] }),
			});
			expect(response.status).toBe(200);
		}
	}

	it('runs literal idempotent provision up, status, and down against the stand-in', async () => {
		const admin = client();
		const writes: unknown[] = [];
		const dependencies = {
			client: admin,
			reconcile,
			writeState: async (_path: string, value: unknown) => { writes.push(value); },
			now: () => new Date('2026-10-22T00:00:00.000Z'),
		};
		const first = await runProvision('up', config(), dependencies);
		expect(first).toMatchObject({
			configuration: { webhook: 'match', stream: 'match' },
			kv_lists: expect.arrayContaining(['harbor_testnet_run1_accounts']),
		});
		expect(first.webhooks).toHaveLength(1);
		expect(first.streams).toHaveLength(1);
		const second = await runProvision('up', config(), dependencies);
		expect(second.webhooks).toEqual(first.webhooks);
		expect(second.streams).toEqual(first.streams);
		const observed = await runProvision('status', config(), { client: admin, reconcile });
		expect(observed.configuration).toEqual({ webhook: 'match', stream: 'match' });
		expect(JSON.stringify({ observed, writes })).not.toContain('local-token');
		const removed = await runProvision('down', config(), { client: admin, reconcile });
		expect(removed).toMatchObject({ webhooks: [], streams: [], kv_lists: [] });
	});

	it('reports drift without exposing the webhook security token', async () => {
		await reconcile();
		const response = await fetch(`${base}/webhooks/rest/v1/webhooks/template/xrplWalletFilter`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-api-key': 'local-management-test' },
			body: JSON.stringify({
				name: 'harbor-wallets-testnet-run1',
				network: 'xrp-testnet',
				destination_attributes: {
					url: 'http://127.0.0.1:8799/hooks/quicknode/stale',
					security_token: 'must-not-leak',
					compression: 'none',
				},
				templateArgs: { walletsListName: 'harbor_testnet_run1_accounts' },
			}),
		});
		expect(response.status).toBe(200);
		const observed = await runProvision('status', config(), { client: client(), reconcile });
		expect(observed.configuration.webhook).toBe('drift');
		expect(JSON.stringify(observed)).not.toContain('must-not-leak');
		await expect(runProvision('up', config(), {
			client: client(), reconcile, writeState: async () => {},
		})).rejects.toThrow('QN_WEBHOOK_CONFIG_DRIFT');
	});

	it('rejects credentialed or query-bearing callback destinations', async () => {
		for (const url of [
			'http://user:pass@127.0.0.1:8799/hooks/quicknode/wallet',
			'http://127.0.0.1:8799/hooks/quicknode/wallet?token=leak',
		]) {
			const response = await fetch(`${base}/webhooks/rest/v1/webhooks/template/xrplWalletFilter`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-api-key': 'local-management-test' },
				body: JSON.stringify({
					name: 'harbor-wallets-testnet-run1',
					network: 'xrp-testnet',
					destination_attributes: {
						url,
						security_token: 'must-not-leak',
						compression: 'none',
					},
					templateArgs: { walletsListName: 'harbor_testnet_run1_accounts' },
				}),
			});
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ error: 'destination url is invalid' });
		}
	});
});

describe('XRPL testnet relay', () => {
	it('refuses mainnet, credentialed, and non-WSS relay endpoints', () => {
		expect(publicTestnetWebsocket('wss://s.altnet.rippletest.net:51233')).toContain('altnet.rippletest.net');
		expect(() => publicTestnetWebsocket('wss://s1.ripple.com')).toThrow(/Testnet/);
		expect(() => publicTestnetWebsocket('https://s.altnet.rippletest.net:51234')).toThrow(/Testnet/);
		expect(() => publicTestnetWebsocket('wss://token@s.altnet.rippletest.net:51233')).toThrow(/Testnet/);
	});

	it('subscribes watched accounts and emits one signed webhook payload', async () => {
		const root = await mkdtemp(join(tmpdir(), 'qn-relay-'));
		const store = new JsonQnLocalStore(join(root, 'kv.json'));
		await store.putList('wallets', ['rWatched']);
		const listeners = new Map<string, (event: unknown) => void>();
		const requests: Record<string, unknown>[] = [];
		const client: XrplRelayClient = {
			connect: async () => {}, disconnect: async () => {},
			request: async (request) => { requests.push(request); return {}; },
			on: (event, listener) => { listeners.set(event, listener); },
			off: (event) => { listeners.delete(event); },
		};
		let observedBody = '';
		let observedHeaders = new Headers();
		const stop = await startXrplRelay({
			client, store, walletsListKey: 'wallets', webhook: { url: 'http://127.0.0.1/hook', secret: 'test-token' },
			fetchImpl: (async (_url, init) => {
				observedBody = String(init?.body);
				observedHeaders = new Headers(init?.headers);
				return new Response(null, { status: 200 });
			}) as typeof fetch,
		});
		expect(requests).toContainEqual({ command: 'subscribe', accounts: ['rWatched'] });
		listeners.get('transaction')?.({ transaction: { hash: 'ABC', TransactionType: 'Payment' }, meta: { TransactionResult: 'tesSUCCESS' } });
		await stop();
		expect(JSON.parse(observedBody)).toEqual({
			data: [{ hash: 'ABC', TransactionType: 'Payment', metaData: { TransactionResult: 'tesSUCCESS' } }],
			metadata: { network: 'xrp-testnet', source: 'qn-local' },
		});
		const claimed = new Set<string>();
		const nonceStore: QuickNodeNonceStore = {
			claim: async (nonce) => claimed.has(nonce) ? false : (claimed.add(nonce), true),
		};
		await expect(verifyQuickNode(
			'test-token',
			new TextEncoder().encode(observedBody),
			observedHeaders.get('x-qn-nonce') ?? '',
			observedHeaders.get('x-qn-timestamp') ?? '',
			observedHeaders.get('x-qn-signature') ?? '',
			{ nonceStore },
		)).resolves.toMatchObject({ status: 'verified', text: observedBody });
	});

	it('runs the configured stream filter and skips null outputs', async () => {
		const root = await mkdtemp(join(tmpdir(), 'qn-stream-'));
		const store = new JsonQnLocalStore(join(root, 'kv.json'));
		const listeners = new Map<string, (event: unknown) => void>();
		let deliveries = 0;
		const client: XrplRelayClient = {
			connect: async () => {}, disconnect: async () => {},
			request: async (request) => request.command === 'ledger' ? { result: { ledger: { ledger_index: request.ledger_index, transactions: [] } } } : {},
			on: (event, listener) => { listeners.set(event, listener); },
			off: (event) => { listeners.delete(event); },
		};
		const stop = await startXrplRelay({
			client, store, walletsListKey: 'wallets',
			stream: { url: 'http://127.0.0.1/stream', secret: 'test-token', filterSource: 'async function main(stream) { return stream.data.transactions.length ? stream : null; }' },
			fetchImpl: (async () => { deliveries += 1; return new Response(null, { status: 200 }); }) as typeof fetch,
		});
		listeners.get('ledgerClosed')?.({ ledger_index: 123 });
		await stop();
		expect(deliveries).toBe(0);
	});

	it('settles failed deliveries without an unhandled rejection', async () => {
		const root = await mkdtemp(join(tmpdir(), 'qn-relay-failure-'));
		const store = new JsonQnLocalStore(join(root, 'kv.json'));
		await store.putList('wallets', ['rWatched']);
		const listeners = new Map<string, (event: unknown) => void>();
		const failures: unknown[] = [];
		let disconnected = false;
		const client: XrplRelayClient = {
			connect: async () => {},
			disconnect: async () => { disconnected = true; },
			request: async () => ({}),
			on: (event, listener) => { listeners.set(event, listener); },
			off: (event) => { listeners.delete(event); },
		};
		const stop = await startXrplRelay({
			client,
			store,
			walletsListKey: 'wallets',
			webhook: { url: 'http://127.0.0.1/hook', secret: 'test-token' },
			fetchImpl: (async () => { throw new Error('fixture delivery failed'); }) as typeof fetch,
			onRelayError: (error) => { failures.push(error); },
		});
		listeners.get('transaction')?.({ transaction: { hash: 'FAILED', TransactionType: 'Payment' } });
		await expect(stop()).resolves.toBeUndefined();
		expect(disconnected).toBe(true);
		expect(failures).toHaveLength(1);
		expect(failures[0]).toBeInstanceOf(Error);
	});
});
