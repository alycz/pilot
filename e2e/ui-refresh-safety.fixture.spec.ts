import {
  expect,
  fulfillPilotStream,
  installFixtureChatPrerequisites,
  pilotRoutes,
  requireLane,
  test,
} from "./support";

test.beforeEach(({ lane }) => requireLane(lane, "fixture"));

test("Newsreader replaces only the existing display family without responsive overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const hero = page.locator("#hero-title");
  await expect(hero).toBeVisible();
  const style = await hero.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      family: computed.fontFamily,
      opticalSizing: computed.fontOpticalSizing,
      weight: computed.fontWeight,
      letterSpacing: computed.letterSpacing,
      lineHeight: computed.lineHeight,
      fontSize: computed.fontSize,
      loaded: document.fonts.status,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(style.family).toMatch(/newsreader/i);
  expect(style.family).not.toMatch(/shippori/i);
  expect(style.opticalSizing).toBe("auto");
  expect(style.weight).toBe("600");
  // Existing hero metrics remain unchanged; only the family/loading changed.
  expect(style.fontSize).toBe("34px");
  expect(style.letterSpacing).toBe("-1.02px");
  expect(style.loaded).toBe("loaded");
  expect(style.overflow).toBeLessThanOrEqual(0);

  await page.setViewportSize({ width: 1_440, height: 900 });
  await expect(hero).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("chat URL state only opens reviewable UI and consumes a prepared draft", async ({ page }) => {
  const authorityRequests: string[] = [];
  await page.route("**/api/config/public", (route) => route.fulfill({ status: 503, json: { error: "Not configured in this fixture." } }));
  await page.route("**/api/auth/wallet/session", (route) => route.fulfill({ json: { authenticated: false } }));
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET" && (
      path === "/api/chat" ||
      path.startsWith("/api/strategy/") ||
      path.startsWith("/api/harbor/") ||
      path.startsWith("/api/ledger-sim/")
    )) authorityRequests.push(`${request.method()} ${path}`);
  });

  const draft = "Review a 5 RLUSD daily buy, but do not submit it.";
  await page.goto(`/chat?draft=${encodeURIComponent(draft)}&mode=autonomous&strategy=manage`);

  await expect(page.getByRole("textbox", { name: "Message Pilot" })).toHaveValue(draft);
  await expect(page.getByRole("button", { name: "Request mode" })).toHaveAttribute("data-value", "autonomous");
  await expect(page.getByRole("heading", { name: "How a strategy runs" })).toBeVisible();
  await expect(page).not.toHaveURL(/(?:\?|&)draft=/);
  await page.waitForTimeout(250);
  expect(authorityRequests).toEqual([]);
});

test("a market detail publishes only bounded untrusted reference context", async ({ page }) => {
  await installFixtureChatPrerequisites(page);
  let submittedPageContext: unknown;
  await page.route("**/api/chat", async (route) => {
    submittedPageContext = (await route.request().postDataJSON() as Record<string, unknown>).page_context;
    await fulfillPilotStream(route, { text: "I used the bounded market context as reference data only." });
  });

  await page.goto("/markets/xrp-usdc?network=mainnet");
  await expect(page.getByRole("heading", { level: 1, name: /XRP \/ USDC/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Best execution" })).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("harness-chat-toggle").click();
  const panel = page.getByTestId("harness-chat-panel");
  await panel.getByLabel("Message Pilot").fill("Summarize this market without executing anything.");
  await panel.getByRole("button", { name: "Send message" }).click();
  await expect(panel.getByText(/bounded market context/i)).toBeVisible();

  const context = submittedPageContext as {
    kind: string;
    trust: string;
    page: { id: string; summary: Record<string, unknown> };
  };
  expect(context.kind).toBe("pilot_page_context_v1");
  expect(context.trust).toBe("untrusted_reference_data_only");
  expect(context.page.id).toBe("markets");
  expect(Object.keys(context.page.summary).sort()).toEqual([
    "base_asset",
    "freshness",
    "network",
    "pair",
    "panel",
    "quote_asset",
  ]);
});

test("demo offer edits stay local and retain simulated provenance", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET" && path.startsWith("/api/")) writes.push(`${request.method()} ${path}`);
  });

  await page.goto(pilotRoutes.portfolio);
  const offers = page.getByRole("region", { name: "Open offers table" });
  await expect(offers).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("note", { name: "Demo mode" })).toContainText(/sample data/i);

  await offers.getByRole("button", { name: /Offer #42: Buy 60 RLUSD/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Edit" }).click();
  await dialog.getByLabel(/Quantity/).fill("80");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Offer #42 updated." })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel offer" }).click();
  await dialog.getByRole("button", { name: "Yes, cancel offer" }).click();
  await expect(offers.getByRole("button", { name: /Offer #42:/ })).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("signed-out approval is visibly simulated and never crosses an authority boundary", async ({ page }) => {
  const forbidden: string[] = [];
  await page.route("**/api/config/public", (route) => route.fulfill({ json: {
    network: "testnet",
    stableAsset: { currency: "RLUSD", issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" },
    devSignerEnabled: false,
    walletActionProofRequired: true,
    walletActionProofConfigured: true,
    mockMode: false,
  } }));
  await page.route("**/api/auth/wallet/session", (route) => route.fulfill({ json: { authenticated: false } }));
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET" && (
      path === "/api/chat" ||
      path.startsWith("/api/harbor/") ||
      path.startsWith("/api/ledger-sim/")
    )) forbidden.push(`${request.method()} ${path}`);
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(pilotRoutes.chat);
  await expect(page.getByText(/This is a simulated demo/i)).toBeVisible();

  await page.getByLabel("Message Pilot").fill("Swap 500 RLUSD for XRP, max 1% slippage");
  await page.getByRole("button", { name: "Send message" }).click();
  const approval = page.locator('[data-card-state="awaiting_approval"]');
  await expect(approval).toBeVisible({ timeout: 30_000 });
  await approval.getByRole("button", { name: "Review & sign" }).click();
  const dialog = page.getByRole("dialog", { name: "Review what your wallet would show" });
  await expect(dialog).toContainText(/simulated|demo|no wallet|not submitted/i);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog", { name: "Review what your wallet would show" })).toHaveCount(0);
  await expect(approval).toBeVisible();
  expect(forbidden).toEqual([]);
});
