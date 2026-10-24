import type { QuickNodeNonceStore } from './hmac';

/** Atomic replay protection backed by the QN-0 qn_nonces primary key. */
export class D1QuickNodeNonceStore implements QuickNodeNonceStore {
  constructor(private readonly db: D1Database) {}

  async claim(nonce: string, receivedAt: string): Promise<boolean> {
    const result = await this.db
      .prepare('INSERT OR IGNORE INTO qn_nonces (nonce, received_at) VALUES (?, ?)')
      .bind(nonce, receivedAt)
      .run();
    return result.meta.changes === 1;
  }
}
