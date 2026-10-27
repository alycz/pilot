import { createHarborProxyHandler } from "./handler";
import {
  authorizeBrowserHarborOperation,
  walletHarborResponseHeaders,
} from "../../../../lib/wallet-authorization";
import { readNearPrincipalAuthorization } from "../../../../lib/near-wallet-proof";
import { nearExecutableReviewAttestationResponseHeaders } from "../../../../lib/near-executable-review-attestation";
import type { HarborProxyOpName } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function browserHarborResponseHeaders(
  request: Request,
  op: HarborProxyOpName,
  args: Record<string, unknown>,
  body: ArrayBuffer,
  status: number,
): Record<string, string> {
  const nearAttestation = nearExecutableReviewAttestationResponseHeaders(
    request,
    op,
    args,
    body,
    status,
  );
  if (nearAttestation["set-cookie"]) return nearAttestation;
  return walletHarborResponseHeaders(request, op, args, body, status);
}

export const POST = createHarborProxyHandler({
  authorizeOperation: authorizeBrowserHarborOperation,
  operationResponseHeaders: browserHarborResponseHeaders,
  readNearPrincipalAuthorization,
});
