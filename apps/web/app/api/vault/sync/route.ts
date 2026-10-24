import { assertVaultRequestAuthorized, errorResponse, json } from "../_lib/http";
import { getVaultService } from "../_lib/service";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    assertVaultRequestAuthorized(request);
    await getVaultService().syncPolicy();
    return json({ ok: true, data: { synced: true } });
  } catch (error) {
    return errorResponse(error);
  }
}
