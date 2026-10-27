import { createNearExecutableReviewVerifyHandler } from "../../../../../../lib/near-executable-review-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createNearExecutableReviewVerifyHandler();
