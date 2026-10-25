import { DatabaseSync, type StatementSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { CapabilityBrokerSnapshot } from "../src/exec/capability-broker";
import { D1CapabilitySnapshotStore } from "../src/exec/capability-snapshot-store";

type SqlValue = string | number | bigint | null | Uint8Array;

class SqliteD1Statement {
	private values: SqlValue[] = [];

	constructor(private readonly statement: StatementSync) {}

	bind(...values: unknown[]): this {
		this.values = values.map((value) => value instanceof ArrayBuffer
			? new Uint8Array(value)
			: value as SqlValue);
		return this;
	}

	async run(): Promise<D1Result> {
		const result = this.statement.run(...this.values);
		return { success: true, meta: { changes: Number(result.changes) } as D1Result["meta"] };
	}

	async first<T>(column?: string): Promise<T | null> {
		const row = this.statement.get(...this.values) as Record<string, unknown> | undefined;
		if (row === undefined) return null;
		return (column === undefined ? row : row[column]) as T;
	}
}

class SqliteD1 {
	readonly sqlite = new DatabaseSync(":memory:");

	prepare(sql: string): SqliteD1Statement {
		return new SqliteD1Statement(this.sqlite.prepare(sql));
	}

	async exec(sql: string): Promise<D1ExecResult> {
		this.sqlite.exec(sql);
		return { count: 0, duration: 0 };
	}

	close(): void {
		this.sqlite.close();
	}
}

const EMPTY: CapabilityBrokerSnapshot = Object.freeze({
	version: 1,
	grants: Object.freeze([]),
	receipts: Object.freeze([]),
});

const open = new Set<SqliteD1>();

afterEach(() => {
	for (const database of open) database.close();
	open.clear();
});

function stores() {
	const database = new SqliteD1();
	open.add(database);
	return {
		first: new D1CapabilitySnapshotStore(database as unknown as D1Database),
		second: new D1CapabilitySnapshotStore(database as unknown as D1Database),
	};
}

describe("D1 capability snapshot store", () => {
	it("persists a generation-fenced snapshot across store instances", async () => {
		const { first, second } = stores();
		await expect(first.transaction("principal-one", async (snapshot) => {
			expect(snapshot).toBeUndefined();
			return { snapshot: EMPTY, result: "created" as const };
		})).resolves.toBe("created");

		await expect(second.transaction("principal-one", async (snapshot) => {
			expect(snapshot).toEqual(EMPTY);
			return { snapshot: snapshot!, result: "reloaded" as const };
		})).resolves.toBe("reloaded");
	});

	it("releases its lease after a failed operation without replacing state", async () => {
		const { first, second } = stores();
		await expect(first.transaction("principal-two", async () => {
			throw new Error("fixture failure");
		})).rejects.toThrow("fixture failure");

		await expect(second.transaction("principal-two", async (snapshot) => {
			expect(snapshot).toBeUndefined();
			return { snapshot: EMPTY, result: "recovered" as const };
		})).resolves.toBe("recovered");
	});

	it("retains an explicit checkpoint when the process fails before its final commit", async () => {
		const { first, second } = stores();
		await expect(first.transaction("principal-checkpoint", async (_snapshot, checkpoint) => {
			await checkpoint(EMPTY);
			throw new Error("simulated stop");
		})).rejects.toThrow("simulated stop");

		await expect(second.transaction("principal-checkpoint", async (snapshot) => {
			expect(snapshot).toEqual(EMPTY);
			return { snapshot: snapshot!, result: "checkpoint-recovered" as const };
		})).resolves.toBe("checkpoint-recovered");
	});

	it("serializes competing writers and exposes only the committed snapshot", async () => {
		const { first, second } = stores();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let entered!: () => void;
		const claimed = new Promise<void>((resolve) => { entered = resolve; });

		const left = first.transaction("principal-three", async () => {
			entered();
			await gate;
			return { snapshot: EMPTY, result: "first" as const };
		});
		await claimed;
		const right = second.transaction("principal-three", async (snapshot) => {
			expect(snapshot).toEqual(EMPTY);
			return { snapshot: snapshot!, result: "second" as const };
		});
		release();

		await expect(Promise.all([left, right])).resolves.toEqual(["first", "second"]);
	});
});
