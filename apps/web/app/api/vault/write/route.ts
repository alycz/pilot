import {
  assertVaultRequestAuthorized,
  errorResponse,
  json,
  objectBody,
  requiredString,
} from "../_lib/http";
import { getVaultService } from "../_lib/service";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    assertVaultRequestAuthorized(request);
    const body = await objectBody(request);
    const path = requiredString(body, "path");
    if (typeof body.content !== "string") throw new Error("content is required");
    const content = body.content;
    const message = typeof body.message === "string" ? body.message : undefined;
    await getVaultService().write(path, content, message);
    return json({ ok: true, data: { path } });
  } catch (error) {
    return errorResponse(error);
  }
}
