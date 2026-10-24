export const runtime = "nodejs";

export function GET(): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mock Data Connect</title></head><body style="font-family:system-ui;margin:0;background:#f5f3ec;color:#171814"><main style="max-width:42rem;margin:5rem auto;padding:2rem;border:1px solid #bbb;background:white"><p style="font-weight:700;color:#235a52">MOCK — Mastercard Data Connect appears here with sandbox keys</p><h1>Checking account linked</h1><p>This local fixture performs no network call and stores no financial credentials.</p><button onclick="window.close()" style="padding:.75rem 1rem">Return to workspace</button></main></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
      },
    },
  );
}
