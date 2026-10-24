import { createDemoActionHandler } from "../action-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createDemoActionHandler("settle");
