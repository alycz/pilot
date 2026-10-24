import { chromium } from "playwright";
const S = "http://127.0.0.1:5000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const screen = async () => (await (await fetch(`${S}/events?currentscreenonly=true`)).json()).events.map((e) => e.text).join(" | ");
const press = (b) => fetch(`${S}/button/${b}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "press-and-release" }) });
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" in {} ? undefined : undefined });
const page = await browser.newPage();
const apduCalls = []; page.on("request", (r) => { if (r.url().includes("/api/ledger-sim/")) apduCalls.push(new URL(r.url()).pathname); });
await page.goto("http://127.0.0.1:3010/");
await page.click("#go");
const seen = [];
for (let i = 0; i < 80; i++) {
  await sleep(400);
  const s = await screen();
  if (seen.at(-1) !== s) seen.push(s);
  if (/Review transaction|Transaction Type|Account|Flags|Limit|Currency|Issuer|Fee/.test(s)) await press("right");
  else if (/^Sign transaction/.test(s)) await press("both");
  const txt = await page.textContent("#log");
  if (/RESULT|ERROR/.test(txt)) break;
}
console.log("device screens:", seen.filter(Boolean).join("  ->  "));
console.log("page log:\n" + await page.textContent("#log"));
console.log("proxied calls:", [...new Set(apduCalls)].join(", "), "count", apduCalls.length);
await page.screenshot({ path: "poc.png" });
await browser.close();
