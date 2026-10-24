import { createWorkAgreementFixtureHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createWorkAgreementFixtureHandler({
  enabled:
    process.env.NODE_ENV !== "production" &&
    process.env.PILOT_WORK_AGREEMENT_FIXTURE === "1",
});
