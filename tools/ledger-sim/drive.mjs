// Speculos button driver for the Ledger XRP app 2.8.2 on Nano X. Screen texts below were observed on
// the real app firmware in Speculos (2026-10-21). Used by conformance tests, E2E and the demo panel.
export function speculos(base = process.env.LEDGER_SPECULOS_URL ?? "http://127.0.0.1:5000") {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const screen = async () =>
    (await (await fetch(`${base}/events?currentscreenonly=true`)).json()).events.map((e) => e.text).join(" | ");
  const press = (button) =>
    fetch(`${base}/button/${button}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "press-and-release" }),
    });

  /** Walk a review like a person. target: "approve" | "reject". Returns the distinct screens seen. */
  async function review(target = "approve", { maxSteps = 80, stepMs = 350 } = {}) {
    const seen = [];
    for (let i = 0; i < maxSteps; i++) {
      await sleep(stepMs);
      const s = await screen();
      if (s && seen.at(-1) !== s) seen.push(s);
      if (/Transaction (signed|rejected)/i.test(s)) return seen;
      if (/Blind signing must/i.test(s)) { await press("both"); return seen; } // device refuses -> 0x6985
      if (/Blind signing ahead/i.test(s)) { await press(target === "approve" ? "both" : "right"); continue; }
      if (target === "approve" && /^(Sign transaction|Confirm)/i.test(s)) { await press("both"); if (/^Confirm/i.test(s)) return seen; continue; }
      if (target === "reject" && /^Reject/i.test(s)) { await press("both"); continue; }
      await press("right");
    }
    throw new Error(`review did not finish; last screens: ${seen.slice(-3).join(" / ")}`);
  }

  /** Toggle the XRP app's "Blind signing" setting from the home screen. State resets when Speculos restarts. */
  async function setBlindSigning(enabled) {
    const isHome = async () => /app is ready/i.test(await screen());
    // After a review the device shows "Transaction signed/rejected" briefly before returning home.
    for (let i = 0; i < 25 && !(await isHome()); i++) await sleep(200);
    if (!(await isHome())) throw new Error("device is not on the XRP home screen");
    await press("right"); await sleep(300);             // -> App settings
    await press("both"); await sleep(300);              // -> Blind signing | Enabled/Disabled
    const now = /Enabled/i.test(await screen());
    if (now !== enabled) { await press("both"); await sleep(300); }
    // back to home: right until "Back", then both, then left to the home screen
    for (let i = 0; i < 6 && !/^Back/i.test(await screen()); i++) { await press("right"); await sleep(250); }
    await press("both"); await sleep(300);
    for (let i = 0; i < 4 && !(await isHome()); i++) { await press("left"); await sleep(250); }
    if (!(await isHome())) throw new Error("could not return to the XRP home screen");
  }

  return { screen, press, review, setBlindSigning, base };
}
