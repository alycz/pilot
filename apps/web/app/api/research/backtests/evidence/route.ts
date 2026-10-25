import { z } from "zod";

import {
  BacktestChatReferenceSchema,
  resolveBacktestChatEvidence,
  type SavedBacktestChatEvidence,
} from "../../../../../components/backtests/chat/evidence-reference";
import {
  SavedRunRecordSchema,
  verifyReproducibilityReport,
} from "../../../../../components/backtests/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 128_000;
const EvidenceRequestSchema = z.object({
  reference: BacktestChatReferenceSchema,
  savedRun: SavedRunRecordSchema,
}).strict();

export async function POST(request: Request): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: "Evidence request is too large." }, { status: 413 });
  }
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) {
      return Response.json({ error: "Evidence request is too large." }, { status: 413 });
    }
    const parsed = EvidenceRequestSchema.parse(JSON.parse(text));
    const report = verifyReproducibilityReport(parsed.savedRun.report);
    const candidate: SavedBacktestChatEvidence = {
      runId: report.runId,
      resultFingerprint: report.result.resultFingerprintSha256,
      datasetNormalizedHash: report.dataset.normalizedHashSha256,
      strategyVersion: report.strategy.strategyVersion,
      datasetLabel: report.dataset.sourceLabel,
      sourceKind: "saved_historical_report",
      sourceDisclosure: "Client-supplied fingerprint-consistent saved historical report; source not refetched. Research evidence only, not executable liquidity.",
      period: {
        startDate: report.dataset.coverage.startDate,
        endDate: report.dataset.coverage.endDate,
      },
      quoteSymbol: report.result.quoteCurrency,
      metrics: {
        strategyReturnBps: report.result.outOfSample.totalReturnBps,
        benchmarkReturnBps: report.result.outOfSample.benchmarkReturnBps,
        maxDrawdownBps: report.result.outOfSample.maxDrawdownBps,
        endingEquityQuote: report.result.outOfSample.endingEquityQuote,
        totalCostsQuote: report.result.outOfSample.totalCostsQuote,
        tradeCount: report.result.outOfSample.tradeCount,
      },
    };
    const context = resolveBacktestChatEvidence(parsed.reference, (runId) => runId === report.runId ? candidate : undefined);
    return Response.json(context, { status: 200, headers: { "Cache-Control": "no-store, private" } });
  } catch {
    return Response.json({ error: "Saved backtest evidence is invalid or does not match its reference." }, { status: 400 });
  }
}
