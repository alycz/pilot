import { offlinePendingRogueEvidence } from "../../../../../../scripts/ap4m-demo/rogue";

import { createDemoActionHandler } from "../action-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const guardedPost = createDemoActionHandler("rogue");

export async function POST(request: Request): Promise<Response> {
  const response = await guardedPost(request);
  if (!response.ok) return response;

  const value = await response.json() as { evidence?: { at?: unknown } };
  if (typeof value.evidence?.at !== "string") {
    return Response.json(
      { ok: false, error: { code: "AP4M_DEMO_EVIDENCE_INVALID" } },
      { status: 503 },
    );
  }
  return Response.json({
    ok: true,
    evidence: offlinePendingRogueEvidence(new Date(value.evidence.at)),
  });
}
