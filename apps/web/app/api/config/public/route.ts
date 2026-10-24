import { resolvePublicPilotConfig } from "./config";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    return Response.json(await resolvePublicPilotConfig(process.env, request), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      {
        error: {
          code: "PUBLIC_CONFIG_UNAVAILABLE",
          message: "The public test-network configuration is unavailable.",
        },
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
