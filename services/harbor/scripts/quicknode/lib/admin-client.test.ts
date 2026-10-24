import { describe, expect, it, vi } from 'vitest';

import { QuickNodeAdminClient, QuickNodeAdminError } from './admin-client.ts';

describe('QuickNode admin client', () => {
	it('sends the API key only in the header and parses named resources', async () => {
		const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
			expect(new Headers(init?.headers).get('x-api-key')).toBe('local-test-key');
			expect(String(_input)).not.toContain('local-test-key');
			return Response.json({ webhooks: [{ id: 'one', name: 'harbor-wallets-testnet-run1' }] });
		});
		const client = new QuickNodeAdminClient({
			base: 'http://127.0.0.1:8793',
			apiKey: 'local-test-key',
			fetcher,
		});
		expect(await client.listWebhooks()).toEqual([{ id: 'one', name: 'harbor-wallets-testnet-run1' }]);
	});

	it('returns only a fixed error code when the provider response contains hostile text', async () => {
		const client = new QuickNodeAdminClient({
			base: 'https://api.quicknode.com',
			apiKey: 'secret-key',
			fetcher: async () => new Response('secret-key hostile provider body', { status: 500 }),
		});
		const error = await client.listStreams().catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(QuickNodeAdminError);
		expect(String(error)).toContain('QN_ADMIN_HTTP_500');
		expect(String(error)).not.toContain('secret-key');
		expect(String(error)).not.toContain('hostile provider body');
	});

	it('allows plaintext only for a loopback stand-in', () => {
		expect(() => new QuickNodeAdminClient({ base: 'http://api.quicknode.example', apiKey: 'x' })).toThrow('QN_ADMIN_BASE_INVALID');
		expect(() => new QuickNodeAdminClient({ base: 'http://127.0.0.1:8793', apiKey: 'x' })).not.toThrow();
	});

	it('accepts only an origin root as the API base', () => {
		for (const base of [
			'https://api.quicknode.com/tenant',
			'https://api.quicknode.com/?token=secret',
			'https://api.quicknode.com/#fragment',
		]) {
			expect(() => new QuickNodeAdminClient({ base, apiKey: 'x' })).toThrow('QN_ADMIN_BASE_INVALID');
		}
	});

	it('rejects decoded dot, slash and backslash traversal before fetch', async () => {
		const fetcher = vi.fn<typeof fetch>();
		const client = new QuickNodeAdminClient({ base: 'http://127.0.0.1:8793', apiKey: 'x', fetcher });
		for (const path of [
			'/webhooks/rest/v1/webhooks/%2e%2e',
			'/webhooks/rest/v1/webhooks/a%2fb',
			'/webhooks/rest/v1/webhooks/a%5cb',
		]) {
			await expect(client.deleteWebhook(path)).rejects.toThrow('QN_ADMIN_PATH_INVALID');
		}
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('accepts documented bounded nested list wrappers only', async () => {
		const client = new QuickNodeAdminClient({
			base: 'http://127.0.0.1:8793',
			apiKey: 'x',
			fetcher: async () => Response.json({ data: { webhooks: [{ id: 'wh-1', name: 'named' }] } }),
		});
		expect(await client.listWebhooks()).toEqual([{ id: 'wh-1', name: 'named' }]);
	});

	it('projects webhook details to nonsecret configuration fields only', async () => {
		const client = new QuickNodeAdminClient({
			base: 'http://127.0.0.1:8793',
			apiKey: 'x',
			fetcher: async () => Response.json({ data: {
				id: 'wh-1', name: 'named', network: 'xrp-testnet',
				destination_attributes: {
					url: 'https://harbor.example/hooks/quicknode/wallet',
					compression: 'none', security_token: 'must-not-return',
				},
				templateArgs: { walletsListName: 'harbor_testnet_run1_accounts' },
			} }),
		});
		const projected = await client.getWebhookConfiguration('wh-1');
		expect(projected).toEqual({
			name: 'named', network: 'xrp-testnet',
			destination_url: 'https://harbor.example/hooks/quicknode/wallet',
			compression: 'none', wallets_list_name: 'harbor_testnet_run1_accounts',
		});
		expect(JSON.stringify(projected)).not.toContain('must-not-return');
	});
});
