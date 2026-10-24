import type { CapabilityBrokerSnapshot } from './capability-broker';

const PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_STATE_BYTES = 2 * 1_024 * 1_024;
const LEASE_MS = 30_000;
const CLAIM_ATTEMPTS = 50;
const CLAIM_RETRY_MS = 10;

export interface CapabilitySnapshotStore {
	transaction<T>(principal: string, operation: (
		snapshot: CapabilityBrokerSnapshot | undefined,
		checkpoint: (snapshot: CapabilityBrokerSnapshot) => Promise<void>,
	) => Promise<Readonly<{ snapshot: CapabilityBrokerSnapshot; result: T }>>): Promise<T>;
}

type StateRow = {
	generation: number;
	state_json: string | null;
};

function changes(result: D1Result<unknown>): number {
	return typeof result.meta?.changes === 'number' ? result.meta.changes : 0;
}

/**
 * Local-only D1 snapshot store. One principal lease serializes grant and
 * receipt transitions across Worker isolates; the final snapshot replacement
 * is fenced by both lease token and generation.
 */
export class D1CapabilitySnapshotStore implements CapabilitySnapshotStore {
	#initialized?: Promise<void>;

	constructor(
		private readonly db: D1Database,
		private readonly now: () => Date = () => new Date(),
	) {}

	async #initialize(): Promise<void> {
		this.#initialized ??= this.db.exec(`
CREATE TABLE IF NOT EXISTS local_capability_broker_state (
  principal TEXT PRIMARY KEY,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  state_json TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  updated_at TEXT NOT NULL
);
`).then(() => undefined);
		return this.#initialized;
	}

	async transaction<T>(principal: string, operation: (
		snapshot: CapabilityBrokerSnapshot | undefined,
		checkpoint: (snapshot: CapabilityBrokerSnapshot) => Promise<void>,
	) => Promise<Readonly<{ snapshot: CapabilityBrokerSnapshot; result: T }>>): Promise<T> {
		if (!PRINCIPAL.test(principal)) throw new TypeError('Capability store principal is invalid');
		await this.#initialize();
		let now = this.nowValue();
		const token = crypto.randomUUID();
		await this.db.prepare(`INSERT OR IGNORE INTO local_capability_broker_state(
principal, generation, state_json, lease_token, lease_expires_at, updated_at
) VALUES (?, 0, NULL, NULL, NULL, ?)`).bind(principal, now.toISOString()).run();
		let claimed = false;
		for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
			now = this.nowValue();
			const result = await this.db.prepare(`UPDATE local_capability_broker_state
SET lease_token = ?, lease_expires_at = ?, updated_at = ?
WHERE principal = ? AND (lease_token IS NULL OR lease_expires_at <= ?)`)
				.bind(token, new Date(now.getTime() + LEASE_MS).toISOString(), now.toISOString(), principal, now.toISOString()).run();
			if (changes(result) === 1) {
				claimed = true;
				break;
			}
			if (attempt + 1 < CLAIM_ATTEMPTS) {
				await new Promise<void>((resolve) => setTimeout(resolve, CLAIM_RETRY_MS));
			}
		}
		if (!claimed) throw new Error('Capability state is busy');

		let generation = -1;
		try {
			const row = await this.db.prepare(`SELECT generation, state_json
FROM local_capability_broker_state WHERE principal = ? AND lease_token = ?`)
				.bind(principal, token).first<StateRow>();
			if (!row || !Number.isSafeInteger(row.generation) || row.generation < 0) {
				throw new Error('Capability state lease was lost');
			}
			generation = row.generation;
			let snapshot: CapabilityBrokerSnapshot | undefined;
			if (row.state_json !== null) {
				if (new TextEncoder().encode(row.state_json).byteLength > MAX_STATE_BYTES) {
					throw new Error('Capability state is too large');
				}
				snapshot = JSON.parse(row.state_json) as CapabilityBrokerSnapshot;
			}
			const persist = async (next: CapabilityBrokerSnapshot): Promise<void> => {
				const serialized = this.serialize(next);
				const checkpointedAt = this.nowValue();
				const checkpointed = await this.db.prepare(`UPDATE local_capability_broker_state
SET generation = generation + 1, state_json = ?, lease_expires_at = ?, updated_at = ?
WHERE principal = ? AND generation = ? AND lease_token = ?`)
					.bind(
						serialized,
						new Date(checkpointedAt.getTime() + LEASE_MS).toISOString(),
						checkpointedAt.toISOString(),
						principal,
						generation,
						token,
					).run();
				if (changes(checkpointed) !== 1) throw new Error('Capability state checkpoint is uncertain');
				generation += 1;
			};
			const completed = await operation(snapshot, persist);
			const serialized = JSON.stringify(completed.snapshot);
			if (new TextEncoder().encode(serialized).byteLength > MAX_STATE_BYTES) {
				throw new Error('Capability state is too large');
			}
			const committed = await this.db.prepare(`UPDATE local_capability_broker_state
SET generation = generation + 1, state_json = ?, lease_token = NULL,
    lease_expires_at = NULL, updated_at = ?
WHERE principal = ? AND generation = ? AND lease_token = ?`)
				.bind(serialized, this.nowValue().toISOString(), principal, generation, token).run();
			if (changes(committed) !== 1) throw new Error('Capability state commit is uncertain');
			return completed.result;
		} catch (error) {
			await this.db.prepare(`UPDATE local_capability_broker_state
SET lease_token = NULL, lease_expires_at = NULL, updated_at = ?
WHERE principal = ? AND generation = ? AND lease_token = ?`)
				.bind(this.nowValue().toISOString(), principal, generation, token).run().catch(() => undefined);
			throw error;
		}
	}

	private nowValue(): Date {
		const value = this.now();
		if (!Number.isFinite(value.getTime())) throw new TypeError('Capability store time is invalid');
		return value;
	}

	private serialize(snapshot: CapabilityBrokerSnapshot): string {
		const serialized = JSON.stringify(snapshot);
		if (new TextEncoder().encode(serialized).byteLength > MAX_STATE_BYTES) {
			throw new Error('Capability state is too large');
		}
		return serialized;
	}
}

/** Deterministic local test backing with serialized, durable-shaped snapshots. */
export class MemoryCapabilitySnapshotStore implements CapabilitySnapshotStore {
	readonly #snapshots = new Map<string, CapabilityBrokerSnapshot>();
	readonly #tails = new Map<string, Promise<void>>();

	async transaction<T>(principal: string, operation: (
		snapshot: CapabilityBrokerSnapshot | undefined,
		checkpoint: (snapshot: CapabilityBrokerSnapshot) => Promise<void>,
	) => Promise<Readonly<{ snapshot: CapabilityBrokerSnapshot; result: T }>>): Promise<T> {
		if (!PRINCIPAL.test(principal)) throw new TypeError('Capability store principal is invalid');
		const prior = this.#tails.get(principal) ?? Promise.resolve();
		let release!: () => void;
		const tail = new Promise<void>((resolve) => { release = resolve; });
		const queued = prior.then(() => tail);
		this.#tails.set(principal, queued);
		await prior;
		try {
			const current = this.#snapshots.get(principal);
			const persist = async (snapshot: CapabilityBrokerSnapshot): Promise<void> => {
				this.#snapshots.set(principal, JSON.parse(JSON.stringify(snapshot)) as CapabilityBrokerSnapshot);
			};
			const completed = await operation(current === undefined
				? undefined
				: JSON.parse(JSON.stringify(current)) as CapabilityBrokerSnapshot, persist);
			this.#snapshots.set(principal, JSON.parse(JSON.stringify(completed.snapshot)) as CapabilityBrokerSnapshot);
			return completed.result;
		} finally {
			release();
			if (this.#tails.get(principal) === queued) this.#tails.delete(principal);
		}
	}
}
