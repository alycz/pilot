import { describe, expect, it } from 'vitest';

import { runQ5Facts, writeQuickNodeFacts } from './q5-facts.ts';

describe('q5 facts', () => {
	it('records stand-in facts without presenting them as event verification', async () => {
		let written = '';
		await writeQuickNodeFacts([
			'--source', 'stand-in',
			'--network-slug', 'xrp-testnet',
			'--dataset', 'Ledger',
			'--webhook-delete-path', '/webhooks/rest/v1/webhooks/{id}',
			'--output', '/tmp/facts.json',
		], async (_path, data) => { written = String(data); });
		expect(JSON.parse(written)).toMatchObject({
			verification: 'stand-in-only',
			network_slug: 'xrp-testnet',
			streams_dataset: 'Ledger',
			webhook_delete_by_id_path: '/webhooks/rest/v1/webhooks/{id}',
		});
	});

	it('prints PASS and appends a bounded status row', async () => {
		const output: string[] = [];
		const status: string[] = [];
		await runQ5Facts([
			'--source', 'stand-in',
			'--network-slug', 'xrp-testnet',
			'--dataset', 'Ledger',
			'--webhook-delete-path', '/webhooks/rest/v1/webhooks/{id}',
			'--output', '/tmp/facts.json',
			'--status', '/tmp/status.md',
		], {
			writeFile: (async () => undefined) as never,
			appendFile: (async (_path, data) => { status.push(String(data)); }) as never,
			stdout: { write: (data) => { output.push(String(data)); return true; } },
			now: () => new Date('2026-10-21T20:00:00.000Z'),
		});
		expect(output.join('')).toMatch(/^PASS q5-facts mode=mock/);
		expect(status.join('')).toContain('| pass |');
		expect(status.join('')).not.toContain('/tmp/facts.json');
	});

	it('refuses a guessed delete path without an id placeholder', async () => {
		await expect(writeQuickNodeFacts([
			'--source', 'quicknode-event',
			'--network-slug', 'xrp-testnet',
			'--dataset', 'Ledger',
			'--webhook-delete-path', '/webhooks/rest/v1/webhooks',
		])).rejects.toThrow('WEBHOOK_DELETE_PATH_INVALID');
	});

	it('records a fixed FAIL row without echoing hostile values', async () => {
		const output: string[] = [];
		const status: string[] = [];
		await expect(runQ5Facts([
			'--source', 'stand-in',
			'--network-slug', 'hostile\nvalue',
			'--dataset', 'Ledger',
			'--webhook-delete-path', '/webhooks/rest/v1/webhooks/{id}',
			'--status', '/tmp/status.md',
		], {
			writeFile: (async () => undefined) as never,
			appendFile: (async (_path, data) => { status.push(String(data)); }) as never,
			stdout: { write: (data) => { output.push(String(data)); return true; } },
			now: () => new Date('2026-10-21T20:00:00.000Z'),
		})).rejects.toThrow();
		expect(output.join('')).toMatch(/^FAIL q5-facts mode=mock/);
		expect(status.join('')).toContain('| fail |');
		expect(status.join('')).not.toContain('hostile');
	});
});
