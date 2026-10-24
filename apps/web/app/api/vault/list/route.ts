import { assertVaultRequestAuthorized, errorResponse, json } from "../_lib/http";
import { getVaultService } from "../_lib/service";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  try {
    assertVaultRequestAuthorized(request);
    const prefix = new URL(request.url).searchParams.get("prefix") ?? "Pilot";
    return json({ ok: true, data: await getVaultService().list(prefix) });
  } catch (error) {
    return errorResponse(error);
  }
}
