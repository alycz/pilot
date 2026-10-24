import { describe, expect, it } from 'vitest';

import { D1QuickNodeNonceStore } from '../src/quicknode/d1-nonce-store';

describe('D1QuickNodeNonceStore', () => {
  it('uses an atomic insert-or-ignore claim', async () => {
    const calls: unknown[][] = [];
    let changes = 1;
    const db = {
      prepare: (sql: string) => {
        expect(sql).toContain('INSERT OR IGNORE INTO qn_nonces');
        return {
          bind: (...values: unknown[]) => ({
            run: async () => { calls.push(values); return { meta: { changes } }; },
          }),
        };
      },
    } as unknown as D1Database;
    const store = new D1QuickNodeNonceStore(db);
    expect(await store.claim('nonce-1', '2026-10-21T00:00:00.000Z')).toBe(true);
    changes = 0;
    expect(await store.claim('nonce-1', '2026-10-21T00:00:01.000Z')).toBe(false);
    expect(calls).toEqual([
      ['nonce-1', '2026-10-21T00:00:00.000Z'],
      ['nonce-1', '2026-10-21T00:00:01.000Z'],
    ]);
  });
});
