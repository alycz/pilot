#!/usr/bin/env -S node --experimental-transform-types

import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type FactsSource = 'stand-in' | 'quicknode-event';

export type FactsIo = Readonly<{
	writeFile?: typeof writeFile;
	appendFile?: typeof appendFile;
	stdout?: Pick<NodeJS.WriteStream, 'write'>;
	now?: () => Date;
}>;

function arg(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

function value(raw: string | undefined, name: string): string {
	const result = raw?.trim();
	if (!result || result.length > 500 || /[\u0000-\u001f\u007f]/.test(result)) throw new Error(`${name}_INVALID`);
	return result;
}

export async function writeQuickNodeFacts(
	args: readonly string[],
	write = writeFile,
): Promise<string> {
	const source = value(arg(args, '--source'), 'SOURCE') as FactsSource;
	if (source !== 'stand-in' && source !== 'quicknode-event') throw new Error('SOURCE_INVALID');
	const networkSlug = value(arg(args, '--network-slug'), 'NETWORK_SLUG');
	const dataset = value(arg(args, '--dataset'), 'DATASET');
	const deletePath = value(arg(args, '--webhook-delete-path'), 'WEBHOOK_DELETE_PATH');
	if (!deletePath.startsWith('/webhooks/rest/v1/') || !deletePath.includes('{id}')) {
		throw new Error('WEBHOOK_DELETE_PATH_INVALID');
	}
	const output = resolve(arg(args, '--output') ?? 'quicknode/facts.json');
	const document = {
		version: 1,
		verification: source === 'quicknode-event' ? 'event-verified' : 'stand-in-only',
		network_slug: networkSlug,
		streams_dataset: dataset,
		webhook_delete_by_id_path: deletePath,
		wallet_payload_shape: source === 'quicknode-event' ? 'captured-by-q3' : 'stand-in-fixture-only',
	};
	await mkdir(dirname(output), { recursive: true });
	await write(output, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
	return output;
}

function mode(args: readonly string[]): 'mock' | 'live' {
	return arg(args, '--source') === 'quicknode-event' ? 'live' : 'mock';
}

async function record(
	passed: boolean,
	args: readonly string[],
	statusPath: string,
	io: FactsIo,
): Promise<void> {
	const at = (io.now ?? (() => new Date()))().toISOString();
	const result = passed ? 'pass' : 'fail';
	const note = passed
		? `${mode(args)} facts recorded; event values remain explicitly provenance-tagged`
		: 'facts probe failed; inspect local stderr';
	await (io.appendFile ?? appendFile)(statusPath,
		`| 3 | H-qn | QN-6 q5-facts | ${at} | ${at} | 1 | ${result} | ${note} |\n`,
		{ encoding: 'utf8' },
	);
	(io.stdout ?? process.stdout).write(`${passed ? 'PASS' : 'FAIL'} q5-facts mode=${mode(args)} ${note}\n`);
}

export async function runQ5Facts(args = process.argv.slice(2), io: FactsIo = {}): Promise<void> {
	const statusPath = resolve(arg(args, '--status') ?? 'status/H-qn.md');
	try {
		await writeQuickNodeFacts(args, io.writeFile ?? writeFile);
		await record(true, args, statusPath, io);
	} catch (error) {
		await record(false, args, statusPath, io);
		throw error;
	}
}

export async function main(args = process.argv.slice(2)): Promise<void> {
	await runQ5Facts(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error: unknown) => {
		void error;
		process.stderr.write('QN_FACTS_FAILED\n');
		process.exitCode = 1;
	});
}
