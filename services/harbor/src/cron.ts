import { runWatcher } from "./exec/watcher";
import {
  createQuickNodeRoutedRpc,
  type QuickNodeRpcEnv,
} from "./quicknode/rpc";
import { createProductionStrategyAdapter } from "./strategy/execution-adapter";
import { runStrategyScheduler, type StrategyExecutionAdapter } from "./strategy/runner";

export interface CronEnv extends QuickNodeRpcEnv {
  DB: D1Database;
  EXEC_NETWORK?: string;
  MAINNET_EXECUTION?: string;
  AUTONOMOUS_STRATEGY_RUNNER?: string;
}

export type CronDependencies = {
  runStrategies?: typeof runStrategyScheduler;
  adapterForPrincipal?: (principal: string) => StrategyExecutionAdapter;
};

/** Cloudflare invokes this from the `* * * * *` trigger in wrangler.jsonc. */
export async function scheduled(
  controller: ScheduledController,
  env: CronEnv,
  _ctx: ExecutionContext,
  dependencies: CronDependencies = {},
): Promise<void> {
  const routed = createQuickNodeRoutedRpc({
    env,
    operationName: "watcher.scan",
  });
  await runWatcher({ db: env.DB, env, xrplRpc: routed.rpc });
  if (env.AUTONOMOUS_STRATEGY_RUNNER !== "true" || env.EXEC_NETWORK !== "testnet" || env.MAINNET_EXECUTION === "true") return;
  const adapters = new Map<string, StrategyExecutionAdapter>();
  const adapterForPrincipal = dependencies.adapterForPrincipal ?? ((principal: string) => {
    let adapter = adapters.get(principal);
    if (!adapter) {
      adapter = createProductionStrategyAdapter({ principal, db: env.DB,
        env: env as unknown as Record<string, unknown>, xrplRpc: routed.rpc });
      adapters.set(principal, adapter);
    }
    return adapter;
  });
  await (dependencies.runStrategies ?? runStrategyScheduler)({
    db: env.DB,
    now: new Date(controller.scheduledTime),
    holderId: `cron:${controller.scheduledTime}:${crypto.randomUUID()}`,
    adapterForPrincipal,
  });
}

export default { scheduled } satisfies ExportedHandler<CronEnv>;
