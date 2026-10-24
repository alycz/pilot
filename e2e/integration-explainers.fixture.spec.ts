import { expect, requireLane, test } from "./support";

const integrations = [
  ["/integrations/mastercard", "Let Pilot buy data for you, inside limits you sign once.", "Mastercard AP4M"],
  ["/integrations/aws", "Extra safety checks around Pilot, powered by AWS.", "AWS trust layer"],
  ["/integrations/quicknode", "A faster line to the ledger, with a watchdog on Harbor's keys.", "QuickNode"],
  ["/integrations/ledger", "Routine trades run on their own. Anything bigger asks your Ledger.", "Ledger"],
] as const;

test.beforeEach(async ({ page, lane }) => {
  requireLane(lane, "fixture");
  await page.route("**/*", async (route) => {
    const target = new URL(route.request().url());
    if (target.origin === lane.baseURL) return route.fallback();
    await route.abort("blockedbyclient");
  });
});

test("landing integration navigation is keyboard and mobile accessible", async ({ page }) => {
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Integrations" }).first();
  await trigger.focus();
  await trigger.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: /Mastercard AP4M/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();

  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole("button", { name: "Open navigation menu" }).click();
  const nav = page.getByRole("navigation", { name: "Sections and integrations (mobile)" });
  await expect(nav).toBeVisible();
  for (const [href] of integrations) {
    const link = nav.locator(`a[href="${href}"]`);
    await expect(link).toBeVisible();
    expect((await link.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open navigation menu" })).toBeFocused();
});

for (const [path, heading, name] of integrations) {
  test(`${path} is public, responsive, interactive, and authority-free`, async ({ page }) => {
    const mutatingApiRequests: string[] = [];
    const failures: string[] = [];
    page.on("request", (request) => {
      const target = new URL(request.url());
      if (target.pathname.startsWith("/api/") && request.method() !== "GET") {
        mutatingApiRequests.push(`${request.method()} ${target.pathname}`);
      }
    });
    page.on("pageerror", (error) => failures.push(error.message));

    const response = await page.goto(path);
    expect(response?.ok()).toBe(true);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "At a glance" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Sections" }).locator('a[href="/#api"]')).toBeVisible();

    const flow = page.locator(`[data-integration-flow="${name}"]`);
    await flow.scrollIntoViewIfNeeded();
    const steps = flow.getByRole("region", { name: "Steps" });
    await steps.getByRole("button").nth(1).click();
    await expect(steps.locator('[aria-current="step"]')).toContainText("02");
    await steps.getByRole("button").first().click();
    await expect(steps.locator('[aria-current="step"]')).toContainText("01");

    const outcomes = flow.getByRole("radio");
    await expect(outcomes).toHaveCount(3);
    await outcomes.nth(1).click();
    await expect(outcomes.nth(1)).toHaveAttribute("aria-checked", "true");
    await flow.getByRole("button", { name: "Next step" }).click();
    await expect(steps.locator('[aria-current="step"]')).toContainText("02");
    await flow.getByRole("button", { name: "Previous step" }).click();
    await expect(steps.locator('[aria-current="step"]')).toContainText("01");

    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole("button", { name: "Open navigation menu" }).click();
    const mobileNav = page.getByRole("navigation", { name: "Sections and integrations (mobile)" });
    await expect(mobileNav.locator(`a[href="${path}"]`)).toHaveAttribute("aria-current", "page");
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(mutatingApiRequests).toEqual([]);
    expect(failures).toEqual([]);
  });
}

test("reduced motion keeps the Ledger explainer manual on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/integrations/ledger");

  const flow = page.locator('[data-integration-flow="Ledger"]');
  await flow.scrollIntoViewIfNeeded();
  const steps = flow.getByRole("region", { name: "Steps" });
  const current = steps.locator('[aria-current="step"]');
  const before = await current.textContent();
  await page.waitForTimeout(5_000);
  await expect(current).toHaveText(before ?? "");
  await flow.getByRole("button", { name: "Next step" }).click();
  await expect(steps.locator('[aria-current="step"]')).not.toHaveText(before ?? "");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
