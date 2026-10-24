import { assertVaultRequestAuthorized, errorResponse, json } from "../_lib/http";
import { getVaultService } from "../_lib/service";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  try {
    assertVaultRequestAuthorized(request);
    const path = new URL(request.url).searchParams.get("path");
    if (!path) throw new Error("path is required");
    const content = await getVaultService().read(path);
    return content === null
      ? json({ ok: false, error: { message: "Vault note not found" } }, 404)
      : json({ ok: true, data: { path, content } });
  } catch (error) {
    return errorResponse(error);
  }
}
