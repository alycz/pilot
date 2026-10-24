import {
  expect,
  fulfillPilotStream,
  installFixtureChatPrerequisites,
  requireLane,
  test,
} from "./support";

test.beforeEach(async ({ page, lane }) => {
  requireLane(lane, "fixture");
  await page.route("**/*", async (route) => {
    const target = new URL(route.request().url());
    if (target.origin === lane.baseURL) {
      await route.fallback();
      return;
    }
    await route.abort("blockedbyclient");
  });
});

test("markets terminal retains search and panel state across mobile navigation and resize", async ({ page }, testInfo) => {
  await page.goto("/markets");
  await expect(page.getByRole("heading", { level: 1, name: "XRPL market workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Illustrative demo" }).click();

  const workspace = page.getByRole("main", { name: "XRPL market analytics workspace" });
  await expect(workspace.getByText("Illustrative demo fixture.")).toBeVisible();
  await expect(workspace.getByLabel("Market pairs")).toBeVisible();
  await expect(workspace.getByRole("heading", { name: "XRP / RLUSD" })).toBeVisible();
  await expect(workspace.getByLabel("Market book and trade preview")).toBeVisible();

  const search = workspace.getByRole("searchbox", { name: "Search markets" });
  await search.fill("RLUSD");
  await expect(search).toHaveValue("RLUSD");
  await expect(workspace.getByRole("option", { name: /XRP \/ RLUSD/ })).toBeVisible();

  await testInfo.attach("markets-terminal-desktop", {
    body: await page.screenshot({ animations: "disabled", fullPage: false }),
    contentType: "image/png",
  });

  await page.setViewportSize({ width: 390, height: 844 });
  const tabs = workspace.getByRole("tablist", { name: "Markets terminal panels" });
  await expect(tabs).toBeVisible();

  const overview = tabs.getByRole("tab", { name: "Overview" });
  const book = tabs.getByRole("tab", { name: "Book" });
  const compare = tabs.getByRole("tab", { name: "Compare" });
  await overview.focus();
  await overview.press("ArrowRight");
  await expect(book).toBeFocused();
  await expect(book).toHaveAttribute("aria-selected", "true");
  await expect(workspace.getByRole("tabpanel", { name: "Book" })).toBeVisible();

  await book.press("End");
  await expect(compare).toBeFocused();
  await expect(compare).toHaveAttribute("aria-selected", "true");
  await expect(workspace.getByRole("tabpanel", { name: "Compare" })).toBeVisible();
  await expect(search).toHaveValue("RLUSD");

  await testInfo.attach("markets-terminal-mobile", {
    body: await page.screenshot({ animations: "disabled", fullPage: false }),
    contentType: "image/png",
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(search).toHaveValue("RLUSD");
  await expect(page.locator("#markets-terminal-tab-compare")).toHaveAttribute("aria-selected", "true");
  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(hasHorizontalOverflow).toBe(false);
});

test("read-only modes cannot expose an approval entry", async ({ page }) => {
  await page.goto("/markets");
  const workspace = page.getByRole("main", { name: "XRPL market analytics workspace" });

  await page.getByRole("button", { name: "Illustrative demo" }).click();
  await expect(workspace.getByText("Illustrative fixture · no approval path")).toBeVisible();
  await expect(workspace.locator('a[href="/chat"]')).toHaveCount(0);

  await page.getByRole("button", { name: "Mainnet read-only" }).click();
  await expect(workspace.getByRole("alert")).toContainText("Market reads unavailable");
  await expect(workspace.locator('a[href="/chat"]')).toHaveCount(0);
});

test("markets publishes only the six sanitized terminal fields to the persistent harness", async ({ page }) => {
  await installFixtureChatPrerequisites(page);
  let submittedPageContext: unknown;
  await page.route("**/api/chat", async (route) => {
    submittedPageContext = (await route.request().postDataJSON() as Record<string, unknown>).page_context;
    await fulfillPilotStream(route, { text: "I used the bounded market context as reference data only." });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/markets");
  await page.getByRole("button", { name: "Illustrative demo" }).click();
  const workspace = page.getByRole("main", { name: "XRPL market analytics workspace" });
  await expect(workspace.getByText("Illustrative demo fixture.")).toBeVisible();
  await workspace.getByRole("tab", { name: "Compare" }).click();
  await expect(workspace.getByRole("tab", { name: "Compare" })).toHaveAttribute("aria-selected", "true");

  await page.getByTestId("harness-chat-toggle").click();
  const panel = page.getByTestId("harness-chat-panel");
  await panel.getByLabel("Message Pilot").fill("Summarize this market view without executing anything.");
  await panel.getByRole("button", { name: "Send message" }).click();
  await expect(panel.getByText(/bounded market context/i)).toBeVisible();

  expect(submittedPageContext).toEqual({
    kind: "pilot_page_context_v1",
    trust: "untrusted_reference_data_only",
    page: {
      id: "markets",
      title: "XRPL Market Analytics",
      summary: {
        base_asset: "XRP",
        freshness: "demo",
        network: "testnet",
        pair: "XRP / RLUSD",
        panel: "compare",
        quote_asset: "RLUSD",
      },
    },
  });
});

test("live market loading state honors reduced motion before a bounded read failure", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  let releaseRead!: () => void;
  const readMayFinish = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  await page.route("**/api/harbor/analytics.marketSnapshot", async (route) => {
    await readMayFinish;
    await route.fulfill({
      status: 503,
      json: { error: { kind: "upstream", code: "FIXTURE_UNAVAILABLE", message: "Fixture read unavailable." } },
    });
  });

  await page.goto("/markets");
  const loading = page.getByLabel("Loading market analytics");
  try {
    await expect(loading).toBeVisible();
    await expect(loading).toHaveAttribute("aria-busy", "true");
    const skeletons = loading.locator(".animate-pulse");
    await expect(skeletons).toHaveCount(10);
    const reducedMotionStyles = await skeletons.evaluateAll((elements) => elements.map((element) => ({
      animationName: getComputedStyle(element).animationName,
      animationDurationSeconds: Number.parseFloat(getComputedStyle(element).animationDuration),
    })));
    expect(reducedMotionStyles.every(({ animationName }) => animationName === "none")).toBe(true);
    // Chromium's reduced-motion emulation may clamp disabled animations to a
    // 0.00001 s sentinel instead of serializing an exact zero.
    expect(reducedMotionStyles.every(({ animationDurationSeconds }) => animationDurationSeconds <= 0.00001)).toBe(true);
  } finally {
    releaseRead();
  }

  await expect(
    page
      .getByRole("main", { name: "XRPL market analytics workspace" })
      .getByRole("alert"),
  ).toContainText("Market reads unavailable");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
