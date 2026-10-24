import type { SavedBacktestChatEvidence } from "../../chat/evidence-reference";
import type { SavedRunRecord } from "../../runs";
import type { BacktestsViewModel } from "../../ui/view-model";

export type BacktestRunRequest = Readonly<{
  startDay: string;
  endDay: string;
  outOfSampleStartDay: string;
  initialBase: string;
  initialQuote: string;
  targetBaseBps: number;
  bandBps: number;
  maxTradeQuote: string;
  spreadBps: number;
  venueFeeBps: number;
  slippageBps: number;
  networkCostQuote: string;
  embargoBars: number;
  hypothesis: string;
}>;

/** JSON-safe output. Raw provider payloads and normalized bars never cross this boundary. */
export type BacktestRunResponse = Readonly<{
  version: 1;
  viewModel: BacktestsViewModel;
  savedRun: SavedRunRecord;
  chatEvidence: SavedBacktestChatEvidence;
}>;
