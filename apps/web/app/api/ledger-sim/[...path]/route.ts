import { createLedgerSimProxyHandlers } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = createLedgerSimProxyHandlers();
export const GET = handlers.GET;
export const POST = handlers.POST;
