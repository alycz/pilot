import { beforeEach, describe, expect, it, vi } from "vitest";

const { createQuickNodeRoutedRpc, routedRpc, runWatcher, runStrategyScheduler } = vi.hoisted(() => ({
	createQuickNodeRoutedRpc: vi.fn(),
	routedRpc: { request: vi.fn() },
	runWatcher: vi.fn(),
	runStrategyScheduler: vi.fn(),
}));

vi.mock("../src/exec/watcher", () => ({ runWatcher }));
vi.mock("../src/quicknode/rpc", () => ({ createQuickNodeRoutedRpc }));
vi.mock("../src/strategy/runner", () => ({ runStrategyScheduler }));

import { OpRegistry } from "../src/catalog/registry";
import defaultWorker, { createWorker, type Env } from "../src/server";

function controller(): ScheduledController {
	return {
		scheduledTime: Date.parse("2026-10-18T06:00:00.000Z"),
		cron: "* * * * *",
		noRetry: vi.fn(),
	};
}

function context(): ExecutionContext {
	return {} as ExecutionContext;
}

beforeEach(() => {
	runWatcher.mockReset();
	runWatcher.mockResolvedValue(undefined);
	runStrategyScheduler.mockReset();
	runStrategyScheduler.mockResolvedValue({ claimed: 0, held: 0, executed: 0, blocked: 0, failed: 0 });
	createQuickNodeRoutedRpc.mockReset();
	createQuickNodeRoutedRpc.mockReturnValue({
		rpc: routedRpc,
		trust: () => ({
			route: "fallback",
			methods_quicknode: 0,
			methods_fallback: 0,
		}),
	});
});

describe("Worker scheduled entrypoint", () => {
	it("routes factory and default scheduled deliveries through the watcher", async () => {
		const db = {} as D1Database;
		const env: Env = { DB: db, EXEC_NETWORK: "testnet" };
		const firstController = controller();
		const firstContext = context();
		const createdWorker = createWorker(new OpRegistry());

		await createdWorker.scheduled!(firstController, env, firstContext);

		const secondController = controller();
		const secondContext = context();
		await defaultWorker.scheduled!(secondController, env, secondContext);

		expect(createQuickNodeRoutedRpc).toHaveBeenNthCalledWith(1, {
			env,
			operationName: "watcher.scan",
		});
		expect(createQuickNodeRoutedRpc).toHaveBeenNthCalledWith(2, {
			env,
			operationName: "watcher.scan",
		});
		expect(runWatcher).toHaveBeenNthCalledWith(1, {
			db,
			env,
			xrplRpc: routedRpc,
		});
		expect(runWatcher).toHaveBeenNthCalledWith(2, {
			db,
			env,
			xrplRpc: routedRpc,
		});
	});

	it("keeps autonomy disabled unless all testnet safety flags are explicit", async () => {
		const worker = createWorker(new OpRegistry());
		await worker.scheduled!(controller(), { DB: {} as D1Database, EXEC_NETWORK: "testnet" }, context());
		expect(runStrategyScheduler).not.toHaveBeenCalled();

		await worker.scheduled!(controller(), {
			DB: {} as D1Database, EXEC_NETWORK: "testnet", AUTONOMOUS_STRATEGY_RUNNER: "true",
		} as Env, context());
		expect(runStrategyScheduler).toHaveBeenCalledOnce();
	});

	it("runs the watchdog first and suppresses strategy work if it fails", async () => {
		runWatcher.mockRejectedValueOnce(new Error("watchdog failed"));
		const worker = createWorker(new OpRegistry());
		await expect(worker.scheduled!(controller(), {
			DB: {} as D1Database, EXEC_NETWORK: "testnet", AUTONOMOUS_STRATEGY_RUNNER: "true",
		} as Env, context())).rejects.toThrow("watchdog failed");
		expect(runStrategyScheduler).not.toHaveBeenCalled();
	});
});
