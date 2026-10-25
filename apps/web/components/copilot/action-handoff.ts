import {
  decodeCopilotActionContext,
  serializeCopilotActionPrompt,
  type CopilotActionContext,
} from "./action-context";

export type InitialCopilotHandoff = {
  context?: CopilotActionContext;
  draft?: string;
  error?: string;
};

/** Parse a URL handoff into reviewable context. Handoffs never auto-submit. */
export function initialCopilotHandoff(search: string, now = Date.now()): InitialCopilotHandoff {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (params.has("pilot_context")) {
    try {
      const context = decodeCopilotActionContext(params, { now });
      return { context, draft: serializeCopilotActionPrompt(context) };
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : "Market context is invalid. Refresh it in Markets." };
    }
  }
  const action = params.get("action");
  if (action === "swap") {
    return { draft: "Research current routes, then help me prepare a swap for explicit wallet review." };
  }
  if (action === "limit") {
    return { draft: "Research the order book, then help me prepare a native XRPL limit order for explicit wallet review." };
  }
  return {};
}
