import {
  BacktestRunRequestSchema,
  BacktestPipelineError,
  isBacktestRequestValidationError,
  type BacktestRunResponse,
} from "../../../../../components/backtests/integration/server";

import {
  BacktestQuotaError,
  type BacktestAccessResolver,
  type BacktestAccessScope,
  type BacktestExternalReadQuota,
} from "./access-control";

const MAX_REQUEST_BYTES = 16_384;

export type BacktestRunner = (
  input: unknown,
  scope: BacktestAccessScope,
) => Promise<BacktestRunResponse>;

export function createBacktestRunPostHandler(
  run: BacktestRunner,
  dependencies: Readonly<{
    authenticate: BacktestAccessResolver;
    quota: BacktestExternalReadQuota;
    now?: () => number;
  }>,
) {
  return async function POST(request: Request): Promise<Response> {
    let scope: BacktestAccessScope | null;
    try {
      scope = dependencies.authenticate(request);
    } catch {
      return Response.json({ error: "Wallet session verification is unavailable. External historical data was not requested." }, {
        status: 503,
        headers: { "Cache-Control": "no-store, private" },
      });
    }
    if (!scope) {
      return Response.json({ error: "A wallet-bound session is required for external historical data. Signed-out research remains bundled demo only." }, {
        status: 401,
        headers: { "Cache-Control": "no-store, private" },
      });
    }
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
      return Response.json({ error: "Backtest request is too large." }, { status: 413 });
    }
    let input: unknown;
    try {
      const text = await request.text();
      if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) {
        return Response.json({ error: "Backtest request is too large." }, { status: 413 });
      }
      input = BacktestRunRequestSchema.parse(JSON.parse(text));
    } catch {
      return Response.json({ error: "Backtest request must be valid JSON matching the bounded research schema." }, { status: 400 });
    }
    try {
      await dependencies.quota.reserve(scope, dependencies.now?.() ?? Date.now());
    } catch (error) {
      if (error instanceof BacktestQuotaError) {
        return Response.json({
          error: error.code === "QUOTA_EXHAUSTED"
            ? "The authenticated research read quota is exhausted for this hour. No external historical data was requested."
            : "Research quota state is unavailable. No external historical data was requested.",
        }, {
          status: error.code === "QUOTA_EXHAUSTED" ? 429 : 503,
          headers: {
            "Cache-Control": "no-store, private",
            ...(error.code === "QUOTA_EXHAUSTED" ? { "Retry-After": "3600" } : {}),
          },
        });
      }
      return Response.json({ error: "Research quota state is unavailable. No external historical data was requested." }, {
        status: 503,
        headers: { "Cache-Control": "no-store, private" },
      });
    }
    try {
      return Response.json(await run(input, scope), {
        status: 200,
        headers: { "Cache-Control": "no-store, private" },
      });
    } catch (error) {
      if (isBacktestRequestValidationError(error) || (error instanceof BacktestPipelineError && error.code === "INVALID_REQUEST")) {
        return Response.json({ error: error instanceof Error ? error.message : "Backtest input is invalid." }, { status: 400 });
      }
      if (error instanceof BacktestPipelineError && error.code === "SIMULATION_REJECTED") {
        return Response.json({ error: error.message }, { status: 422 });
      }
      return Response.json({ error: "Validated historical data is currently unavailable. No fixture result was substituted." }, { status: 503 });
    }
  };
}
