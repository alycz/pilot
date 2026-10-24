import { describe, expect, it } from "vitest";

import { createHermesProposalProvider } from "@pilot/agent/hermes-transport";
import { runOfflineProposalEvaluation } from "@pilot/agent/offline-improvement";
import { ProposalResultSchema } from "@pilot/agent/proposal-provider";
import { createWorkflowLessonProposal } from "@pilot/agent/workflow-lessons";

describe("restricted proposal package exports", () => {
  it("publishes stable, separate server and offline entry points", () => {
    expect(createHermesProposalProvider).toBeTypeOf("function");
    expect(runOfflineProposalEvaluation).toBeTypeOf("function");
    expect(ProposalResultSchema).toBeDefined();
    expect(createWorkflowLessonProposal).toBeTypeOf("function");
  });
});
