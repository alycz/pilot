import type { Locator, Page, TestInfo } from "@playwright/test";

import { expect, requireLane, test } from "./support";

type RequestBoundary = {
  external: string[];
  mutations: string[];
};

async function installSignedOutNoConfigBoundary(
  page: Page,
  baseURL: string,
): Promise<RequestBoundary> {
  const boundary: RequestBoundary = { external: [], mutations: [] };

  page.on("request", (request) => {
    const target = new URL(request.url());
    if (target.origin !== baseURL) boundary.external.push(request.url());
    if (target.pathname.startsWith("/api/") && request.method() !== "GET") {
      boundary.mutations.push(`${request.method()} ${target.pathname}`);
    }
  });

  await page.route("**/*", async (route) => {
    const target = new URL(route.request().url());
    if (target.origin !== baseURL) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.fallback();
  });
  await page.route("**/api/config/public", (route) => route.fulfill({
    status: 503,
    json: { error: "Fixture intentionally omits public Testnet configuration." },
  }));
  await page.route("**/api/auth/wallet/session", (route) => route.fulfill({
    json: { authenticated: false },
  }));

  return boundary;
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await testInfo.attach(name, {
    body: await page.screenshot({ animations: "disabled", fullPage: true }),
    contentType: "image/png",
  });
}

async function renderedTextContrast(locator: Locator): Promise<{ contrast: number; opacity: string }> {
  return locator.evaluate((element) => {
    type Rgba = [number, number, number, number];
    const parse = (value: string): Rgba => {
      const canvas = new OffscreenCanvas(1, 1);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return [0, 0, 0, 0];
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [red = 0, green = 0, blue = 0, alpha = 0] = context.getImageData(0, 0, 1, 1).data;
      return [red, green, blue, alpha / 255];
    };
    const over = (foreground: Rgba, background: Rgba): Rgba => {
      const alpha = foreground[3] + background[3] * (1 - foreground[3]);
      if (alpha === 0) return [0, 0, 0, 0];
      return [
        (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha,
        (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha,
        (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha,
        alpha,
      ];
    };
    let background: Rgba = [0, 0, 0, 0];
    let current: Element | null = element;
    while (current && background[3] < 1) {
      background = over(background, parse(getComputedStyle(current).backgroundColor));
      current = current.parentElement;
    }
    if (background[3] < 1) background = over(background, [255, 255, 255, 1]);
    const luminance = (rgba: Rgba) => {
      const channels = rgba.slice(0, 3).map((value) => {
        const normalized = value / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
    };
    const foreground = over(parse(getComputedStyle(element).color), background);
    const foregroundLuminance = luminance(foreground);
    const backgroundLuminance = luminance(background);
    return {
      contrast: (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05),
      opacity: getComputedStyle(element.closest("li") ?? element).opacity,
    };
  });
}

test("signed-out visitors can explore deterministic bounded decisions without config or authority", async ({
  page,
  lane,
  evidence,
}, testInfo) => {
  requireLane(lane, "fixture");
  const boundary = await installSignedOutNoConfigBoundary(page, lane.baseURL);

  const response = await page.goto("/strategy");
  expect(response?.ok()).toBe(true);
  await expect(page.getByRole("heading", { name: "Explore bounded autonomous strategies" })).toBeVisible();
  await expect(page.getByText(/illustrative simulation.*client only/i)).toBeVisible();
  await expect(page.getByText(/simulator itself uses no wallet.*network-dependent/i)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sample assumptions" })).toBeAttached();
  await expect(page.getByText(/prices are fixed examples/i)).toBeVisible();
  await expect(page.getByRole("link", { name: "Connect account for Testnet setup" })).toHaveAttribute("href", "/onboarding");
  await expect(page.getByText(/public test-network config unavailable/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /check wallet session/i })).toHaveCount(0);

  const firstUpcoming = page.locator('[data-upcoming="true"]').first();
  for (const metadata of [firstUpcoming.locator("[data-demo-timeline-time]"), firstUpcoming.locator("[data-demo-timeline-price]")]) {
    const rendered = await renderedTextContrast(metadata);
    expect(rendered.opacity).toBe("1");
    expect(rendered.contrast).toBeGreaterThanOrEqual(4.5);
  }

  const decision = page.getByRole("status", { name: /simulation decision/i });
  await expect(decision).toContainText(/hold/i);
  const initialDecision = await decision.textContent();

  const step = page.getByRole("button", { name: /step|next market event/i });
  await step.click();
  await expect(decision).not.toHaveText(initialDecision ?? "");
  await expect(decision).toContainText(/rebalance|blocked/i);

  const target = page.getByRole("slider", { name: /target.*xrp/i });
  const drift = page.getByRole("slider", { name: /drift|band/i });
  await expect(target).toBeVisible();
  await expect(drift).toBeVisible();
  await target.fill("40");
  await drift.fill("3");
  await expect(target).toHaveValue("40");
  await expect(drift).toHaveValue("3");
  await expect(decision).toContainText(/rebalance/i);

  await target.fill("50");
  await drift.fill("5");

  const reset = page.getByRole("button", { name: /reset simulation/i });
  await reset.click();
  await expect(decision).toContainText(/hold/i);

  await step.click();
  await expect(decision).toContainText(/rebalance/i);
  await page.reload();
  await expect(decision).toContainText(/hold/i);
  await expect(page.getByText(`1 / ${7}`, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => ({
    local: Object.keys(window.localStorage).filter((key) => /strategy.*demo|demo.*strategy/i.test(key)),
    session: Object.keys(window.sessionStorage).filter((key) => /strategy.*demo|demo.*strategy/i.test(key)),
  }))).toEqual({ local: [], session: [] });

  const play = page.getByRole("button", { name: /play simulation/i });
  await play.click();
  const pause = page.getByRole("button", { name: /pause simulation/i });
  await expect(pause).toBeVisible();
  await expect.poll(async () => decision.textContent()).not.toBe(initialDecision);
  await pause.click();
  const pausedDecision = await decision.textContent();
  await page.waitForTimeout(1_500);
  await expect(decision).toHaveText(pausedDecision ?? "");

  // Repeated stepping remains bounded by the finite sample timeline and never
  // falls through to a real strategy endpoint.
  for (let index = 0; index < 8; index += 1) {
    if (await step.isEnabled()) await step.click();
  }
  await expect(page.getByRole("region", { name: /event timeline/i })).toBeVisible();
  expect(boundary.mutations).toEqual([]);
  expect(boundary.external).toEqual([]);

  evidence.record("strategy-signed-out-client-simulation", {
    authority: "none",
    publicConfigPresent: false,
    walletConnected: false,
    mutatingRequests: 0,
    externalRequests: 0,
  });
  await attachScreenshot(page, testInfo, "strategy-signed-out-demo-desktop");
});

test("mobile reduced-motion demo remains manual, keyboard operable, and contained", async ({
  page,
  lane,
  evidence,
}, testInfo) => {
  requireLane(lane, "fixture");
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const boundary = await installSignedOutNoConfigBoundary(page, lane.baseURL);

  await page.goto("/strategy");
  await expect(page.getByRole("heading", { name: "Explore bounded autonomous strategies" })).toBeVisible();
  const decision = page.getByRole("status", { name: /simulation decision/i });
  const before = await decision.textContent();
  await page.waitForTimeout(1_500);
  await expect(decision).toHaveText(before ?? "");

  const step = page.getByRole("button", { name: /step|next market event/i });
  await step.focus();
  await expect(step).toBeFocused();
  await step.press("Enter");
  await expect(decision).not.toHaveText(before ?? "");

  const reset = page.getByRole("button", { name: /reset simulation/i });
  await reset.focus();
  await reset.press("Space");
  await expect(decision).toContainText(/hold/i);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(boundary.mutations).toEqual([]);
  expect(boundary.external).toEqual([]);

  evidence.record("strategy-signed-out-mobile-reduced-motion", {
    authority: "none",
    viewportWidth: 375,
    reducedMotion: true,
    keyboardStep: true,
    horizontalOverflow: false,
    mutatingRequests: 0,
  });
  await attachScreenshot(page, testInfo, "strategy-signed-out-demo-mobile-reduced-motion");
});
