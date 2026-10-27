import { createNearPrincipalBootstrapHandler } from "../../../../../lib/near-principal-bootstrap-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createNearPrincipalBootstrapHandler();
