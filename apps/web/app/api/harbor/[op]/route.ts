import { createHarborProxyHandler } from "./handler";
import {
  authorizeBrowserHarborOperation,
  walletHarborResponseHeaders,
} from "../../../../lib/wallet-authorization";
import { readNearPrincipalAuthorization } from "../../../../lib/near-wallet-proof";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createHarborProxyHandler({
  authorizeOperation: authorizeBrowserHarborOperation,
  operationResponseHeaders: walletHarborResponseHeaders,
  readNearPrincipalAuthorization,
});
