import {
  runTrustedDailyBarBacktest,
  TempPrivateDailyBarCache,
} from "../../../../../components/backtests/integration/server";

import {
  resolveAuthenticatedBacktestScope,
} from "./access-control";
import { createConfiguredBacktestQuota } from "./durable-quota";
import { createHarborBacktestExternalReadQuota } from "./harbor-quota";
import { createBacktestRunPostHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const cache = new TempPrivateDailyBarCache();
const quota = createConfiguredBacktestQuota(process.env, {
  createHarborD1Quota: createHarborBacktestExternalReadQuota,
});

export const POST = createBacktestRunPostHandler((input) => runTrustedDailyBarBacktest(input, {
  now: new Date(),
  fetcher: globalThis.fetch,
  cache,
}), {
  authenticate: resolveAuthenticatedBacktestScope,
  quota,
});
