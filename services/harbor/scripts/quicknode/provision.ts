#!/usr/bin/env -S node --experimental-transform-types

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
	QuickNodeAdminClient,
	QuickNodeAdminError,
	type NamedResource,
	type StreamConfiguration,
	type WebhookConfiguration,
} from './lib/admin-client.ts';
import { defaultQuickNodeStatePath, writeQuickNodeState } from './lib/state.ts';

const LISTS = ['accounts', 'delegates', 'frozen', 'tx_types', 'issuers'] as const;

type Command = 'up' | 'status' | 'down';
type Network = 'testnet' | 'devnet';

export type ProvisionConfig = Readonly<{
	run: string;
	network: Network;
	networkSlug: string;
	dataset: string;
	region: string;
	harborPublicUrl: string;
	webhookSecurityToken: string;
	streamSecurityToken: string;
	webhookDeletePath: string;
	statePath: string;
	filterSource: string;
	testLedgers: Readonly<{ harbor: number; rogue: number; none: number }>;
}>;

export type ProvisionClient = Pick<QuickNodeAdminClient,
	'listWebhooks' | 'createWalletWebhook' | 'getWebhookConfiguration' | 'deleteWebhook' |
	'listStreams' | 'createStream' | 'getStreamConfiguration' | 'pauseStream' | 'deleteStream' |
	'getKvList' | 'deleteKvList' | 'testFilter'>;

export type ProvisionDependencies = Readonly<{
	client: ProvisionClient;
	reconcile(network: Network): Promise<void>;
	writeState?: typeof writeQuickNodeState;
	now?: () => Date;
}>;

function bounded(value: string | undefined, code: string, max = 1_024): string {
	const result = value?.trim();
	if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) throw new Error(code);
	return result;
}

function runTag(value: string | undefined): string {
	const result = bounded(value, 'QN_RUN_TAG_INVALID', 32);
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(result)) throw new Error('QN_RUN_TAG_INVALID');
	return result;
}

function network(value: string | undefined): Network {
	if (value !== 'testnet' && value !== 'devnet') throw new Error('QN_NETWORK_INVALID');
	return value;
}

function ledger(value: string | undefined): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('QN_TEST_LEDGER_INVALID');
	return parsed;
}

export function materializeWatchdogFilter(source: string, targetNetwork: Network, run: string): string {
	const networkMatches = source.match(/__NET__/g)?.length ?? 0;
	const runMatches = source.match(/__RUN__/g)?.length ?? 0;
	if (networkMatches !== 1 || runMatches !== 1) throw new Error('QN_WATCHDOG_FILTER_PLACEHOLDERS_INVALID');
	const materialized = source.replace('__NET__', targetNetwork).replace('__RUN__', runTag(run));
	if (materialized.includes('__NET__') || materialized.includes('__RUN__')) {
		throw new Error('QN_WATCHDOG_FILTER_PLACEHOLDERS_INVALID');
	}
	return materialized;
}

function webhookDeletePath(template: string, id: string): string {
	if (!template.includes('{id}')) throw new Error('QN_WEBHOOK_DELETE_PATH_INVALID');
	const path = template.replace('{id}', encodeURIComponent(id));
	if (!path.startsWith('/webhooks/rest/v1/') || path.includes('{')) throw new Error('QN_WEBHOOK_DELETE_PATH_INVALID');
	return path;
}

function harborUrl(value: string): string {
	let url: URL;
	try { url = new URL(value); } catch { throw new Error('HARBOR_PUBLIC_URL_INVALID'); }
	if (
		url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
		(url.protocol !== 'https:' && url.protocol !== 'http:')
	) {
		throw new Error('HARBOR_PUBLIC_URL_INVALID');
	}
	if (url.protocol === 'http:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '::1' && url.hostname !== '[::1]') {
		throw new Error('HARBOR_PUBLIC_URL_INVALID');
	}
	return url.toString().replace(/\/$/, '');
}

export function parseProvisionArguments(args: readonly string[]): { command: Command; run: string } {
	if (args.length !== 3 || (args[0] !== 'up' && args[0] !== 'status' && args[0] !== 'down') || args[1] !== '--run') {
		throw new Error('Usage: provision.ts up|status|down --run <tag>');
	}
	return { command: args[0], run: runTag(args[2]) };
}

export async function provisionConfig(
	run: string,
	env: NodeJS.ProcessEnv,
	readText = (path: string) => readFile(path, 'utf8'),
	command: Command = 'up',
): Promise<ProvisionConfig> {
	const filterPath = resolve(env.QN_WATCHDOG_FILTER_PATH ?? 'quicknode/filters/watchdog.js');
	const up = command === 'up';
	const desired = command === 'up' || command === 'status';
	const down = command === 'down';
	return {
		run: runTag(run),
		network: network(env.EXEC_NETWORK),
		networkSlug: desired ? bounded(env.QN_NETWORK_SLUG, 'QN_NETWORK_SLUG_MISSING', 100) : '',
		dataset: desired ? bounded(env.QN_STREAM_DATASET, 'QN_STREAM_DATASET_MISSING', 100) : '',
		region: desired ? bounded(env.QN_STREAM_REGION, 'QN_STREAM_REGION_MISSING', 100) : '',
		harborPublicUrl: desired ? harborUrl(bounded(env.HARBOR_PUBLIC_URL, 'HARBOR_PUBLIC_URL_MISSING', 2_048)) : '',
		webhookSecurityToken: up ? bounded(env.QN_WEBHOOK_SECURITY_TOKEN, 'QN_WEBHOOK_SECURITY_TOKEN_MISSING', 4_096) : '',
		streamSecurityToken: up ? bounded(env.QN_STREAM_SECURITY_TOKEN, 'QN_STREAM_SECURITY_TOKEN_MISSING', 4_096) : '',
		webhookDeletePath: down ? bounded(env.QN_WEBHOOK_DELETE_PATH, 'QN_WEBHOOK_DELETE_PATH_MISSING', 500) : '',
		statePath: resolve(env.QN_STATE_PATH ?? defaultQuickNodeStatePath(run)),
		filterSource: desired ? materializeWatchdogFilter(await readText(filterPath), network(env.EXEC_NETWORK), run) : '',
		testLedgers: {
			harbor: up ? ledger(env.QN_TEST_LEDGER_HARBOR) : 1,
			rogue: up ? ledger(env.QN_TEST_LEDGER_ROGUE) : 1,
			none: up ? ledger(env.QN_TEST_LEDGER_NONE) : 1,
		},
	};
}

function names(config: ProvisionConfig) {
	const net = config.network;
	return {
		webhook: `harbor-wallets-${net}-${config.run}`,
		stream: `harbor-watchdog-${net}-${config.run}`,
		lists: LISTS.map((list) => `harbor_${net}_${config.run}_${list}`),
	};
}

function uniqueNamed(resources: readonly NamedResource[], name: string): NamedResource | undefined {
	const matches = resources.filter((resource) => resource.name === name);
	if (matches.length > 1) throw new Error('QN_DUPLICATE_NAMED_RESOURCE');
	return matches[0];
}

function desiredWebhook(config: ProvisionConfig): WebhookConfiguration {
	return {
		name: names(config).webhook,
		network: config.networkSlug,
		destination_url: `${config.harborPublicUrl}/hooks/quicknode/wallet`,
		compression: 'none',
		wallets_list_name: `harbor_${config.network}_${config.run}_accounts`,
	};
}

function desiredStream(config: ProvisionConfig): StreamConfiguration {
	return {
		name: names(config).stream,
		network: config.networkSlug,
		dataset: config.dataset,
		filter_function: Buffer.from(config.filterSource, 'utf8').toString('base64'),
		region: config.region,
		dataset_batch_size: 1,
		elastic_batch_enabled: false,
		end_range: -1,
		destination: 'webhook',
		destination_url: `${config.harborPublicUrl}/hooks/quicknode/watchdog`,
		compression: 'none',
		max_retry: 3,
		retry_interval_sec: 5,
		post_timeout_sec: 10,
		status: 'active',
	};
}

function sameWebhook(left: WebhookConfiguration, right: WebhookConfiguration): boolean {
	return left.name === right.name && left.network === right.network &&
		left.destination_url === right.destination_url && left.compression === right.compression &&
		left.wallets_list_name === right.wallets_list_name;
}

function sameStream(left: StreamConfiguration, right: StreamConfiguration): boolean {
	return left.name === right.name && left.network === right.network && left.dataset === right.dataset &&
		left.filter_function === right.filter_function && left.region === right.region &&
		left.dataset_batch_size === right.dataset_batch_size && left.elastic_batch_enabled === right.elastic_batch_enabled &&
		left.end_range === right.end_range && left.destination === right.destination &&
		left.destination_url === right.destination_url && left.compression === right.compression &&
		left.max_retry === right.max_retry && left.retry_interval_sec === right.retry_interval_sec &&
		left.post_timeout_sec === right.post_timeout_sec && left.status === right.status;
}

type ConfigurationState = 'absent' | 'match' | 'drift' | 'duplicate';

async function configurationState<T>(
	resources: readonly NamedResource[],
	read: (id: string) => Promise<T>,
	desired: T,
	equal: (left: T, right: T) => boolean,
): Promise<ConfigurationState> {
	if (resources.length === 0) return 'absent';
	if (resources.length > 1) return 'duplicate';
	try { return equal(await read(resources[0].id), desired) ? 'match' : 'drift'; }
	catch { return 'drift'; }
}

function filterResult(value: unknown): unknown {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('QN_TEST_FILTER_INVALID');
	return (value as Record<string, unknown>).result;
}

function nonEmptyEvents(value: unknown): boolean {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const events = (value as Record<string, unknown>).events;
	return Array.isArray(events) && events.length > 0;
}

async function verifyRecordedFilters(config: ProvisionConfig, client: ProvisionClient): Promise<void> {
	for (const [kind, ledgerIndex] of Object.entries(config.testLedgers) as Array<[keyof typeof config.testLedgers, number]>) {
		const response = await client.testFilter({
			filter_function: config.filterSource,
			ledger_index: ledgerIndex,
		});
		const result = filterResult(response);
		if (kind === 'none' ? result !== null : !nonEmptyEvents(result)) {
			throw new Error(`QN_TEST_FILTER_${kind.toUpperCase()}_FAILED`);
		}
	}
}

async function status(config: ProvisionConfig, client: ProvisionClient) {
	const expected = names(config);
	const [webhooks, streams] = await Promise.all([client.listWebhooks(), client.listStreams()]);
	const matchingWebhooks = webhooks.filter(({ name }) => name === expected.webhook);
	const matchingStreams = streams.filter(({ name }) => name === expected.stream);
	const [webhookConfiguration, streamConfiguration] = await Promise.all([
		configurationState(matchingWebhooks, (id) => client.getWebhookConfiguration(id), desiredWebhook(config), sameWebhook),
		configurationState(matchingStreams, (id) => client.getStreamConfiguration(id), desiredStream(config), sameStream),
	]);
	const kv = await Promise.all(expected.lists.map(async (key) => {
		try { await client.getKvList(key); return key; } catch (error) {
			if (error instanceof QuickNodeAdminError && error.code === 'QN_ADMIN_HTTP_404') return undefined;
			throw error;
		}
	}));
	return {
		run: config.run,
		network: config.network,
		webhooks: matchingWebhooks.map(({ id, name, status }) => ({ id, name, ...(status ? { status } : {}) })),
		streams: matchingStreams.map(({ id, name, status }) => ({ id, name, ...(status ? { status } : {}) })),
		configuration: { webhook: webhookConfiguration, stream: streamConfiguration },
		kv_lists: kv.filter((key): key is string => key !== undefined),
	};
}

export async function runProvision(
	command: Command,
	config: ProvisionConfig,
	dependencies: ProvisionDependencies,
): Promise<ReturnType<typeof status> extends Promise<infer T> ? T : never> {
	const expected = names(config);
	if (command === 'status') return status(config, dependencies.client);

	if (command === 'up') {
		await dependencies.reconcile(config.network);
		for (const key of expected.lists) await dependencies.client.getKvList(key);

		const existingWebhook = uniqueNamed(await dependencies.client.listWebhooks(), expected.webhook);
		if (existingWebhook && !sameWebhook(
			await dependencies.client.getWebhookConfiguration(existingWebhook.id),
			desiredWebhook(config),
		)) throw new Error('QN_WEBHOOK_CONFIG_DRIFT');
		const webhookId = existingWebhook?.id ?? await dependencies.client.createWalletWebhook({
			name: expected.webhook,
			network: config.networkSlug,
			destination_attributes: {
				url: `${config.harborPublicUrl}/hooks/quicknode/wallet`,
				security_token: config.webhookSecurityToken,
				compression: 'none',
			},
			templateArgs: { walletsListName: `harbor_${config.network}_${config.run}_accounts` },
		});
		if (!sameWebhook(await dependencies.client.getWebhookConfiguration(webhookId), desiredWebhook(config))) {
			throw new Error('QN_WEBHOOK_CONFIG_DRIFT');
		}

		await verifyRecordedFilters(config, dependencies.client);
		const existingStream = uniqueNamed(await dependencies.client.listStreams(), expected.stream);
		if (existingStream && !sameStream(
			await dependencies.client.getStreamConfiguration(existingStream.id),
			desiredStream(config),
		)) throw new Error('QN_STREAM_CONFIG_DRIFT');
		const streamId = existingStream?.id ?? await dependencies.client.createStream({
			name: expected.stream,
			network: config.networkSlug,
			dataset: config.dataset,
			filter_function: Buffer.from(config.filterSource, 'utf8').toString('base64'),
			region: config.region,
			dataset_batch_size: 1,
			elastic_batch_enabled: false,
			end_range: -1,
			destination: 'webhook',
			destination_attributes: {
				url: `${config.harborPublicUrl}/hooks/quicknode/watchdog`,
				security_token: config.streamSecurityToken,
				compression: 'none',
				max_retry: 3,
				retry_interval_sec: 5,
				post_timeout_sec: 10,
			},
			status: 'active',
		});
		if (!sameStream(await dependencies.client.getStreamConfiguration(streamId), desiredStream(config))) {
			throw new Error('QN_STREAM_CONFIG_DRIFT');
		}

		await (dependencies.writeState ?? writeQuickNodeState)(config.statePath, {
			version: 1,
			run: config.run,
			network: config.network,
			webhook: { id: webhookId, name: expected.webhook },
			stream: { id: streamId, name: expected.stream },
			kv_lists: expected.lists,
			updated_at: (dependencies.now ?? (() => new Date()))().toISOString(),
		});
		return status(config, dependencies.client);
	}

	const streams = (await dependencies.client.listStreams()).filter(({ name }) => name === expected.stream);
	for (const stream of streams) {
		await dependencies.client.pauseStream(stream.id);
		await dependencies.client.deleteStream(stream.id);
	}
	const webhooks = (await dependencies.client.listWebhooks()).filter(({ name }) => name === expected.webhook);
	for (const webhook of webhooks) {
		await dependencies.client.deleteWebhook(webhookDeletePath(config.webhookDeletePath, webhook.id));
	}
	for (const key of expected.lists) {
		try { await dependencies.client.deleteKvList(key); } catch (error) {
			if (!(error instanceof QuickNodeAdminError) || error.code !== 'QN_ADMIN_HTTP_404') throw error;
		}
	}
	const result = await status(config, dependencies.client);
	if (result.webhooks.length !== 0 || result.streams.length !== 0 || result.kv_lists.length !== 0) {
		throw new Error('QN_TEARDOWN_INCOMPLETE');
	}
	return result;
}

async function harborReconcile(env: NodeJS.ProcessEnv, network: Network): Promise<void> {
	const base = harborUrl(bounded(env.HARBOR_PUBLIC_URL, 'HARBOR_PUBLIC_URL_MISSING', 2_048));
	const authorization = bounded(env.HARBOR_API_KEY, 'HARBOR_API_KEY_MISSING', 8_192);
	const response = await fetch(`${base}/api/ops/quicknode.kv.reconcile`, {
		method: 'POST',
		headers: { authorization: `Bearer ${authorization}`, 'content-type': 'application/json' },
		body: JSON.stringify({ network }),
	});
	if (!response.ok) throw new Error(`HARBOR_RECONCILE_HTTP_${response.status}`);
	const payload = await response.json() as Record<string, unknown>;
	if (payload.ok !== true) throw new Error('HARBOR_RECONCILE_FAILED');
}

export async function main(args = process.argv.slice(2), env = process.env): Promise<void> {
	const parsed = parseProvisionArguments(args);
	const config = await provisionConfig(parsed.run, env, (path) => readFile(path, 'utf8'), parsed.command);
	const client = new QuickNodeAdminClient({
		base: bounded(env.QN_API_BASE, 'QN_API_BASE_MISSING', 2_048),
		apiKey: bounded(env.QN_API_KEY, 'QN_API_KEY_MISSING', 4_096),
	});
	const result = await runProvision(parsed.command, config, {
		client,
		reconcile: (targetNetwork) => harborReconcile(env, targetNetwork),
	});
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : 'QN_PROVISION_FAILED'}\n`);
		process.exitCode = 1;
	});
}
