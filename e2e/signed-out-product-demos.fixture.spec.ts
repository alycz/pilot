import type { Page } from "@playwright/test";

import { expect, requireLane, test } from "./support";

type Boundary = { external: string[]; mutations: string[]; authenticated: boolean };

async function installDemoBoundary(page: Page, baseURL: string): Promise<Boundary> {
  const boundary: Boundary = { external: [], mutations: [], authenticated: false };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== baseURL) boundary.external.push(request.url());
    if (url.pathname.startsWith("/api/") && request.method() !== "GET") {
      boundary.mutations.push(`${request.method()} ${url.pathname}`);
    }
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== baseURL) return route.abort("blockedbyclient");
    return route.fallback();
  });
  await page.route("**/api/config/public", (route) => route.fulfill({ json: {
    network: "testnet",
    stableAsset: { currency: "RLUSD", issuer: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59" },
    devSignerEnabled: false,
    walletActionProofRequired: false,
    walletActionProofConfigured: false,
    mockMode: true,
  } }));
  await page.route("**/api/auth/wallet/session", (route) => route.fulfill({ json: boundary.authenticated
    ? { authenticated: true, account: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", network: "testnet", expiresAt: Date.now() + 60_000 }
    : { authenticated: false } }));
  return boundary;
}

test("signed-out Backtests and Research lab are useful deterministic local demos", async ({ page, lane, evidence }) => {
  requireLane(lane, "fixture");
  const boundary = await installDemoBoundary(page, lane.baseURL);

  await page.goto("/research/backtests");
  await expect(page.getByRole("button", { name: "Sample", exact: true })).toBeVisible();
  await expect(page.getByText("Demo · simulated sample results")).toHaveCount(0);
  await expect(page.getByText(/not historical, live, or executable/i)).toBeVisible();
  await expect(page.getByText("Sample strategy return", { exact: true })).toBeVisible();
  await page.getByLabel("Starting XRP").fill("-1");
  await page.getByRole("button", { name: "Run simulated sample" }).click();
  await expect(page.locator("p[role=alert]")).toContainText(/greater than or equal|nonnegative|invalid/i);
  await page.getByLabel("Starting XRP").fill("100");
  await page.getByLabel("Target base (bps)").fill("6000");
  await page.getByRole("button", { name: "Run simulated sample" }).click();
  await expect(page.getByText(/recalculated locally/i)).toBeVisible();
  await expect(page.getByLabel("Compare sample run")).toBeVisible();
  await page.getByRole("button", { name: "Reset sample" }).click();
  await expect(page.getByLabel("Target base (bps)")).toHaveValue("5000");
  await page.reload();
  await expect(page.getByLabel("Target base (bps)")).toHaveValue("5000");

  await page.goto("/strategy-research");
  await expect(page.getByRole("heading", { name: "Test assumptions before preparing an action" })).toBeVisible();
  await expect(page.getByText(/No AI model, wallet, provider, live price feed/i)).toBeVisible();
  await page.getByLabel("Sample hypothesis").selectOption("cost-stress");
  await expect(page.getByText(/Parameters changed/i)).toBeVisible();
  await page.getByRole("button", { name: "Run simulated research" }).click();
  await expect(page.getByText(/Simulated run 2/i)).toBeVisible();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.getByText(/Simulated run 1/i)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/Simulated run 1/i)).toBeVisible();

  expect(boundary.mutations).toEqual([]);
  expect(boundary.external).toEqual([]);
  evidence.record("signed-out-research-demos", { externalRequests: 0, mutatingRequests: 0, providerCalls: 0 });
});

test("signed-out Agreements completes release and cancel locally, then discards demo on login", async ({ page, lane, evidence }) => {
  requireLane(lane, "fixture");
  const boundary = await installDemoBoundary(page, lane.baseURL);

  await page.goto("/agreements");
  await expect(page.getByRole("heading", { name: "Sample escrow-backed work agreement" })).toBeVisible();
  await expect(page.getByText(/no provider or XRPL request is made/i)).toHaveCount(0);
  await page.getByRole("button", { name: /Simulate owner approval.*create/i }).click();
  await page.getByRole("button", { name: "Mark sample delivery reviewed" }).click();
  await page.getByRole("button", { name: "Review simulated release" }).click();
  await page.getByRole("button", { name: /Simulate owner approval.*release/i }).click();
  await expect(page.getByRole("status")).toContainText(/Demo complete.*released/i);
  await page.getByRole("button", { name: "Run again" }).click();
  await page.getByRole("button", { name: /Simulate owner approval.*create/i }).click();
  await page.getByRole("button", { name: "Review simulated cancel" }).click();
  await page.getByRole("button", { name: /Simulate owner approval.*cancel/i }).click();
  await expect(page.getByRole("status")).toContainText(/Demo complete.*cancelled/i);
  await page.reload();
  await expect(page.getByRole("button", { name: /Simulate owner approval.*create/i })).toBeVisible();

  expect(boundary.mutations).toEqual([]);
  expect(boundary.external).toEqual([]);

  boundary.authenticated = true;
  await page.reload();
  await expect(page.getByRole("heading", { name: "Owner-reviewed escrow workspace" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sample escrow-backed work agreement" })).toHaveCount(0);

  expect(boundary.mutations.filter((request) => /agreement|sign|submit|wallet/i.test(request))).toEqual([]);
  expect(boundary.external).toEqual([]);
  evidence.record("signed-out-agreements-demo", { externalRequests: 0, mutatingRequests: 0, signingCalls: 0, discardedOnLogin: true });
});

test("all signed-out demos remain usable on mobile without horizontal overflow", async ({ page, lane }) => {
  requireLane(lane, "fixture");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const boundary = await installDemoBoundary(page, lane.baseURL);
  for (const [route, heading] of [
    ["/research/backtests", "Synthetic sample path · deterministic browser calculation"],
    ["/strategy-research", "Test assumptions before preparing an action"],
    ["/strategy", "Set the rules once. Pilot trades inside them."],
    ["/agreements", "Sample escrow-backed work agreement"],
  ] as const) {
    await page.goto(route);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    const overflow = await page.locator("main").evaluate((main) => ({
      route: window.location.pathname,
      clientWidth: main.clientWidth,
      contentWidth: main.scrollWidth,
      elements: [...main.querySelectorAll("*")]
        .filter((element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.right > window.innerWidth + 1 || bounds.left < -1;
        })
        .slice(0, 8)
        .map((element) => ({ tag: element.tagName, className: element.className, text: element.textContent?.slice(0, 60) })),
    }));
    expect(overflow.contentWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.clientWidth);
  }
  expect(boundary.mutations).toEqual([]);
  expect(boundary.external).toEqual([]);
});
