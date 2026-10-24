import { createCredentialRevokeHandler } from "@/lib/demo-network/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createCredentialRevokeHandler();
