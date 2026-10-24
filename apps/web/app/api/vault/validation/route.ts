import { ValidatedTransactionSchema } from "@pilot/vault";

import { assertVaultRequestAuthorized, errorResponse, json, objectBody } from "../_lib/http";
import { getVaultService } from "../_lib/service";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    assertVaultRequestAuthorized(request);
    const body = await objectBody(request);
    const paths = await getVaultService().recordValidatedTransaction(
      ValidatedTransactionSchema.parse(body),
    );
    return json({ ok: true, data: { paths } });
  } catch (error) {
    return errorResponse(error);
  }
}
