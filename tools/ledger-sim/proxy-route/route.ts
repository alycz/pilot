// Same-origin proxy to Speculos (it sends no CORS headers). Test networks only.
const UPSTREAM = process.env.LEDGER_SPECULOS_UPSTREAM ?? "http://127.0.0.1:5000";
const ALLOWED = new Set(["apdu", "events"]);

async function forward(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if (path.length !== 1 || !ALLOWED.has(path[0])) return new Response("not found", { status: 404 });
  const url = new URL(request.url);
  const upstream = await fetch(`${UPSTREAM}/${path[0]}${url.search}`, {
    method: request.method,
    headers: { "content-type": request.headers.get("content-type") ?? "application/json", accept: request.headers.get("accept") ?? "*/*" },
    body: request.method === "POST" ? await request.text() : undefined,
    cache: "no-store",
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" },
  });
}
export const GET = forward;
export const POST = forward;
export const dynamic = "force-dynamic";
