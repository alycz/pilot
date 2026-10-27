import { expect, requireLane, test } from "./support";

test.beforeEach(async ({ page, lane }) => {
  requireLane(lane, "fixture");
  await page.route("**/*", async (route) => {
    const target = new URL(route.request().url());
    if (target.origin === lane.baseURL) return route.fallback();
    await route.abort("blockedbyclient");
  });
});

test("NEAR owner-funded route stays default-off without wallet or provider authority", async ({
  page,
  lane,
  evidence,
}, testInfo) => {
  const externalRequests: string[] = [];
  const mutatingRequests: string[] = [];
  const browserErrors: string[] = [];

  page.on("request", (request) => {
    const target = new URL(request.url());
    if (target.origin !== lane.baseURL) externalRequests.push(request.url());
    if (target.pathname.startsWith("/api/") && request.method() !== "GET") {
      mutatingRequests.push(`${request.method()} ${target.pathname}`);
    }
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  const response = await page.goto("/demo/near-intents");
  expect(response?.ok()).toBe(true);
  await expect(page.getByRole("heading", {
    level: 1,
    name: "Trace the boundary before any value moves.",
  })).toBeVisible();

  const liveFlow = page.locator('[data-near-native-live-flow="disabled"]');
  await expect(liveFlow).toBeVisible();
  await expect(liveFlow.getByRole("heading", {
    name: "Native NEAR → canonical Arbitrum USDC",
  })).toBeVisible();
  await expect(liveFlow.getByText("Live native-route flow disabled")).toBeVisible();
  await expect(liveFlow.getByText("Browser wallet gate")).toBeVisible();
  await expect(liveFlow.getByText("Executable-review gate")).toBeVisible();
  await expect(liveFlow.getByText("Principal-bootstrap gate")).toBeVisible();
  await expect(liveFlow.getByText("Owner-approval gate")).toBeVisible();
  await expect(liveFlow.getByRole("button", {
    name: "Authorize live quote review",
  })).toBeDisabled();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await liveFlow.scrollIntoViewIfNeeded();
  const overflow = await liveFlow.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  await testInfo.attach("near-owner-flow-default-off-mobile", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });

  expect(externalRequests).toEqual([]);
  expect(mutatingRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
  evidence.record("near-owner-funded-default-off", {
    route: "near-native-to-arbitrum-usdc-v1",
    walletPrompts: 0,
    providerCalls: 0,
    mutatingRequests: 0,
    externalRequests: 0,
    viewport: "390x844",
  });
});
