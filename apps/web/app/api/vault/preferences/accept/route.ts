import type { PreferenceProposal } from "@pilot/vault";

import {
  assertPreferenceAcceptanceAuthorized,
  errorResponse,
  json,
  objectBody,
  requiredString,
} from "../../_lib/http";
import { getVaultService } from "../../_lib/service";

export const runtime = "nodejs";

function boundedString(body: Record<string, unknown>, key: string, maximum: number): string {
  const value = requiredString(body, key).trim();
  if (value.length > maximum) throw new Error(`${key} must not exceed ${maximum} characters`);
  return value;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const walletScope = assertPreferenceAcceptanceAuthorized(request);
    const body = await objectBody(request);
    if (body.accepted !== true) {
      throw new Error("accepted must be true to store a preference");
    }
    const proposal: PreferenceProposal = {
      id: boundedString(body, "id", 128),
      preference: boundedString(body, "preference", 500),
      ...(body.reason === undefined
        ? {}
        : { reason: boundedString(body, "reason", 500) }),
    };
    const service = getVaultService();
    const profile = walletScope
      ? await service.applyScopedPreference(walletScope, proposal, true)
      : await service.applyPreference(proposal, true);
    return json({ ok: true, data: { profile } });
  } catch (error) {
    return errorResponse(error);
  }
}
