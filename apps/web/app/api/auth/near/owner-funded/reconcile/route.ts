import { createNearOwnerFundedReconcileHandler } from "../../../../../../lib/near-owner-funded-reconcile-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createNearOwnerFundedReconcileHandler();
