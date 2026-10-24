import { describe, expect, it } from 'vitest';

import { QuickNodeAdminError, type NamedResource } from './lib/admin-client.ts';
import { materializeWatchdogFilter, parseProvisionArguments, runProvision, type ProvisionClient, type ProvisionConfig } from './provision.ts';

const config: ProvisionConfig = {
	run: 'run1',
	network: 'testnet',
	networkSlug: 'xrp-testnet',
	dataset: 'Ledger',
	region: 'usa',
	harborPublicUrl: 'http://127.0.0.1:8799',
	webhookSecurityToken: 'webhook-test-token',
	streamSecurityToken: 'stream-test-token',
	webhookDeletePath: '/webhooks/rest/v1/webhooks/{id}',
	statePath: '/tmp/qn-state.run1.json',
	filterSource: 'async function main(stream) { return stream; }',
	testLedgers: { harbor: 10, rogue: 11, none: 12 },
};

class StandInClient implements ProvisionClient {
	webhooks: NamedResource[] = [];
	streams: NamedResource[] = [];
	lists = new Set<string>();
	log: string[] = [];
	webhookConfigurations = new Map<string, Record<string, unknown>>();
	streamConfigurations = new Map<string, Record<string, unknown>>();

	async listWebhooks() { return this.webhooks; }
	async createWalletWebhook(body: Readonly<Record<string, unknown>>) {
		this.log.push(`create-webhook:${String(body.name)}`);
		this.webhooks.push({ id: 'wh-1', name: String(body.name), status: 'active' });
		this.webhookConfigurations.set('wh-1', { ...body });
		return 'wh-1';
	}
	async getWebhookConfiguration(id: string) {
		const body = this.webhookConfigurations.get(id);
		if (!body) throw new Error('missing webhook');
		const destination = body.destination_attributes as Record<string, unknown>;
		const args = body.templateArgs as Record<string, unknown>;
		return {
			name: String(body.name), network: String(body.network), destination_url: String(destination.url),
			compression: String(destination.compression), wallets_list_name: String(args.walletsListName),
		};
	}
	async deleteWebhook(path: string) {
		this.log.push(`delete-webhook:${path}`);
		this.webhooks = [];
		this.webhookConfigurations.clear();
	}
	async listStreams() { return this.streams; }
	async createStream(body: Readonly<Record<string, unknown>>) {
		this.log.push(`create-stream:${String(body.name)}`);
		this.streams.push({ id: 'st-1', name: String(body.name), status: 'active' });
		this.streamConfigurations.set('st-1', { ...body });
		return 'st-1';
	}
	async getStreamConfiguration(id: string) {
		const body = this.streamConfigurations.get(id);
		if (!body) throw new Error('missing stream');
		const destination = body.destination_attributes as Record<string, unknown>;
		return {
			name: String(body.name), network: String(body.network), dataset: String(body.dataset),
			filter_function: String(body.filter_function), region: String(body.region),
			dataset_batch_size: Number(body.dataset_batch_size), elastic_batch_enabled: Boolean(body.elastic_batch_enabled),
			end_range: Number(body.end_range), destination: String(body.destination), destination_url: String(destination.url),
			compression: String(destination.compression), max_retry: Number(destination.max_retry),
			retry_interval_sec: Number(destination.retry_interval_sec), post_timeout_sec: Number(destination.post_timeout_sec),
			status: String(body.status),
		};
	}
	async pauseStream(id: string) { this.log.push(`pause-stream:${id}`); }
	async deleteStream(id: string) {
		this.log.push(`delete-stream:${id}`);
		this.streams = [];
		this.streamConfigurations.clear();
	}
	async getKvList(key: string) {
		if (!this.lists.has(key)) throw new QuickNodeAdminError('QN_ADMIN_HTTP_404');
		return { key, items: [] };
	}
	async deleteKvList(key: string) {
		if (!this.lists.delete(key)) throw new QuickNodeAdminError('QN_ADMIN_HTTP_404');
		this.log.push(`delete-kv:${key}`);
	}
	async testFilter(body: Readonly<Record<string, unknown>>) {
		this.log.push(`test-filter:${String(body.ledger_index)}`);
		return body.ledger_index === 12 ? { result: null } : { result: { events: [{ tx_hash: 'A'.repeat(64) }] } };
	}
}

describe('QuickNode event-day provisioner', () => {
	it('materializes the exact network and run placeholders with no remnants', () => {
		const result = materializeWatchdogFilter('const n="__NET__"; const r="__RUN__";', 'testnet', 'run1');
		expect(result).toBe('const n="testnet"; const r="run1";');
		expect(result).not.toMatch(/__(?:NET|RUN)__/);
		expect(() => materializeWatchdogFilter('const n="testnet"; const r="__RUN__";', 'testnet', 'run1'))
			.toThrow('QN_WATCHDOG_FILTER_PLACEHOLDERS_INVALID');
		expect(() => materializeWatchdogFilter('__NET__ __NET__ __RUN__', 'testnet', 'run1'))
			.toThrow('QN_WATCHDOG_FILTER_PLACEHOLDERS_INVALID');
	});

	it('parses only the bounded command and run grammar', () => {
		expect(parseProvisionArguments(['up', '--run', 'event'])).toEqual({ command: 'up', run: 'event' });
		expect(() => parseProvisionArguments(['up', '--run', '../event'])).toThrow('QN_RUN_TAG_INVALID');
	});

	it('orders reconcile, webhook, three filter checks and stream, then stays idempotent', async () => {
		const client = new StandInClient();
		const writes: unknown[] = [];
		const reconcile = async () => {
			client.log.push('reconcile');
			for (const suffix of ['accounts', 'delegates', 'frozen', 'tx_types', 'issuers']) {
				client.lists.add(`harbor_testnet_run1_${suffix}`);
			}
		};
		const first = await runProvision('up', config, {
			client,
			reconcile,
			writeState: async (_path, value) => { writes.push(value); },
			now: () => new Date('2026-10-21T00:00:00.000Z'),
		});
		expect(first.kv_lists).toHaveLength(5);
		expect(client.log).toEqual([
			'reconcile', 'create-webhook:harbor-wallets-testnet-run1',
			'test-filter:10', 'test-filter:11', 'test-filter:12',
			'create-stream:harbor-watchdog-testnet-run1',
		]);
		expect(JSON.stringify(writes)).not.toContain('test-token');

		client.log = [];
		await runProvision('up', config, { client, reconcile, writeState: async () => {} });
		expect(client.log).toEqual(['reconcile', 'test-filter:10', 'test-filter:11', 'test-filter:12']);
	});

	it('reports and rejects a same-name webhook with stale nonsecret configuration', async () => {
		const client = new StandInClient();
		const reconcile = async () => {
			for (const suffix of ['accounts', 'delegates', 'frozen', 'tx_types', 'issuers']) {
				client.lists.add(`harbor_testnet_run1_${suffix}`);
			}
		};
		await runProvision('up', config, { client, reconcile, writeState: async () => {} });
		const webhook = client.webhookConfigurations.get('wh-1')!;
		client.webhookConfigurations.set('wh-1', {
			...webhook,
			destination_attributes: {
				...(webhook.destination_attributes as Record<string, unknown>),
				url: 'https://stale.example/hooks/quicknode/wallet',
			},
		});
		const observed = await runProvision('status', config, { client, reconcile });
		expect(observed.configuration).toEqual({ webhook: 'drift', stream: 'match' });
		expect(JSON.stringify(observed)).not.toContain('test-token');
		await expect(runProvision('up', config, { client, reconcile, writeState: async () => {} }))
			.rejects.toThrow('QN_WEBHOOK_CONFIG_DRIFT');
	});

	it('reports and rejects a same-name stream with a stale filter', async () => {
		const client = new StandInClient();
		const reconcile = async () => {
			for (const suffix of ['accounts', 'delegates', 'frozen', 'tx_types', 'issuers']) {
				client.lists.add(`harbor_testnet_run1_${suffix}`);
			}
		};
		await runProvision('up', config, { client, reconcile, writeState: async () => {} });
		client.streamConfigurations.set('st-1', {
			...client.streamConfigurations.get('st-1')!,
			filter_function: Buffer.from('stale filter').toString('base64'),
		});
		const observed = await runProvision('status', config, { client, reconcile });
		expect(observed.configuration).toEqual({ webhook: 'match', stream: 'drift' });
		await expect(runProvision('up', config, { client, reconcile, writeState: async () => {} }))
			.rejects.toThrow('QN_STREAM_CONFIG_DRIFT');
	});

	it('pauses and deletes tagged resources and every run-scoped list', async () => {
		const client = new StandInClient();
		client.webhooks = [{ id: 'wh-1', name: 'harbor-wallets-testnet-run1' }];
		client.streams = [{ id: 'st-1', name: 'harbor-watchdog-testnet-run1' }];
		for (const suffix of ['accounts', 'delegates', 'frozen', 'tx_types', 'issuers']) {
			client.lists.add(`harbor_testnet_run1_${suffix}`);
		}
		const result = await runProvision('down', config, { client, reconcile: async () => {} });
		expect(result).toMatchObject({ webhooks: [], streams: [], kv_lists: [] });
		expect(client.log.slice(0, 3)).toEqual([
			'pause-stream:st-1',
			'delete-stream:st-1',
			'delete-webhook:/webhooks/rest/v1/webhooks/wh-1',
		]);
		expect(client.log.filter((entry) => entry.startsWith('delete-kv:'))).toHaveLength(5);
	});

	it('fails before creating the stream when any recorded filter fixture disagrees', async () => {
		const client = new StandInClient();
		client.testFilter = async () => ({ result: null });
		await expect(runProvision('up', config, {
			client,
			reconcile: async () => {
				for (const suffix of ['accounts', 'delegates', 'frozen', 'tx_types', 'issuers']) {
					client.lists.add(`harbor_testnet_run1_${suffix}`);
				}
			},
			writeState: async () => {},
		})).rejects.toThrow('QN_TEST_FILTER_HARBOR_FAILED');
		expect(client.streams).toEqual([]);
	});
});
