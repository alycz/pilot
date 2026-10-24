import { assertVaultRequestAuthorized, errorResponse, json } from "../_lib/http";
import { getVaultService } from "../_lib/service";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  try {
    assertVaultRequestAuthorized(request);
    const parameters = new URL(request.url).searchParams;
    const query = parameters.get("q");
    if (!query) throw new Error("q is required");
    const requestedLimit = Number(parameters.get("limit") ?? 10);
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(50, Math.max(1, requestedLimit))
      : 10;
    return json({ ok: true, data: await getVaultService().search(query, limit) });
  } catch (error) {
    return errorResponse(error);
  }
}
