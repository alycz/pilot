import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readQuickNodeState, writeQuickNodeState } from './state.ts';

describe('QuickNode external state', () => {
	it('round trips public resource IDs through an owner-only file', async () => {
		const root = await mkdtemp(join(tmpdir(), 'qn-state-'));
		const path = join(root, 'nested', 'qn-state.run1.json');
		const value = {
			version: 1 as const,
			run: 'run1',
			network: 'testnet' as const,
			webhook: { id: 'wh-1', name: 'harbor-wallets-testnet-run1' },
			stream: { id: 'st-1', name: 'harbor-watchdog-testnet-run1' },
			kv_lists: ['harbor_testnet_run1_accounts'],
			updated_at: '2026-10-21T00:00:00.000Z',
		};
		await writeQuickNodeState(path, value);
		expect(await readQuickNodeState(path)).toEqual(value);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});
});
