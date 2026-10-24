import { expect, requireLane, test } from "./support";

const integrations = [
  ["/integrations/mastercard", "Authorize once. Let Pilot act only inside the mandate."],
  ["/integrations/aws", "Three protections, with each responsibility kept separate."],
  ["/integrations/quicknode", "A visible route to the ledger, with an independent watch on registered delegate and payer activity."],
  ["/integrations/ledger", "Bounded automation, with owner approval at the edge"],
] as const;

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

test("landing navigation opens with keyboard and closes with Escape and outside click", async ({ page }, testInfo) => {
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Integrations" }).first();

  await trigger.focus();
  await trigger.press("ArrowDown");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("menu", { name: "Integrations" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Mastercard AP4M/ })).toBeFocused();
  await testInfo.attach("landing-integrations-dropdown-desktop", {
    body: await page.screenshot({ animations: "disabled", fullPage: false }),
    contentType: "image/png",
  });

  await page.keyboard.press("Escape");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.locator("main").click({ position: { x: 8, y: 8 } });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
});

test("mobile landing menu exposes all four integration routes without hover", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation menu" }).click();
  const nav = page.getByRole("navigation", { name: "Sections and integrations (mobile)" });
  await expect(nav).toBeVisible();
  const navBox = await nav.boundingBox();
  expect(navBox).not.toBeNull();
  for (const [href] of integrations) {
    const link = nav.locator(`a[href="${href}"]`);
    await expect(link).toBeVisible();
    const linkBox = await link.boundingBox();
    expect(linkBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(linkBox?.y ?? -1).toBeGreaterThanOrEqual(navBox?.y ?? 0);
    expect((linkBox?.y ?? 0) + (linkBox?.height ?? 0)).toBeLessThanOrEqual(
      (navBox?.y ?? 0) + (navBox?.height ?? 0),
    );
  }
  const trigger = page.getByRole("button", { name: "Close navigation menu" });
  await trigger.focus();
  await page.keyboard.press("Tab");
  await expect(nav.locator('a[href="/integrations/mastercard"]')).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(nav.locator('a[href="/integrations/ledger"]')).toBeFocused();
  await testInfo.attach("landing-integrations-menu-mobile", {
    body: await page.screenshot({ animations: "disabled", fullPage: false }),
    contentType: "image/png",
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open navigation menu" })).toBeFocused();
});

for (const [path, heading] of integrations) {
  test(`${path} is public, responsive, and interactive`, async ({ page }, testInfo) => {
    const failures: string[] = [];
    const mutatingApiRequests: string[] = [];
    page.on("request", (request) => {
      const target = new URL(request.url());
      if (target.pathname.startsWith("/api/") && request.method() !== "GET") {
        mutatingApiRequests.push(`${request.method()} ${target.pathname}`);
      }
    });
    page.on("pageerror", (error) => failures.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) && /hydration|uncaught|did not match|error/i.test(message.text())) {
        failures.push(message.text());
      }
    });

    const response = await page.goto(path);
    expect(response?.ok()).toBe(true);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.getByText("Public read-only explainer", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Journey playback controls")).toBeVisible();

    const headerMenu = page.getByRole("button", { name: "Integrations" }).first();
    await headerMenu.click();
    await expect(page.locator(`a[role="menuitem"][href="${path}"]`)).toHaveAttribute("aria-current", "page");
    await page.keyboard.press("Escape");

    const pause = page.getByRole("button", { name: "Pause journey" });
    await expect(pause).toBeVisible();
    await pause.click();
    await page.getByRole("button", { name: "Replay from first step" }).click();
    await page.getByRole("button", { name: "Pause journey" }).click();
    const stepTrack = page.getByRole("region", { name: "Journey steps" });
    const currentStep = stepTrack.locator('[aria-current="step"]');
    const initialStep = await currentStep.textContent();
    await page.getByRole("button", { name: "Next step" }).click();
    await expect(stepTrack.locator('[aria-current="step"]')).not.toHaveText(initialStep ?? "");
    await page.getByRole("button", { name: "Replay from first step" }).click();
    await page.getByRole("button", { name: "Pause journey" }).click();
    await expect(stepTrack.locator('[aria-current="step"]')).toHaveText(initialStep ?? "");

    const outcomes = page.getByRole("radio");
    await expect(outcomes).toHaveCount(3);
    await outcomes.nth(1).click();
    await expect(outcomes.nth(1)).toHaveAttribute("aria-checked", "true");

    const availableNodes = page.getByRole("group", { name: "Selectable system nodes" }).locator("button:not([disabled])");
    const selectedNode = (await availableNodes.first().getAttribute("aria-pressed")) === "true" && await availableNodes.count() > 1
      ? availableNodes.nth(1)
      : availableNodes.first();
    await selectedNode.click();
    await expect(selectedNode).toHaveAttribute("aria-pressed", "true");

    const unavailableNode = page.getByRole("group", { name: "Selectable system nodes" }).locator("button:disabled").first();
    if (await unavailableNode.count()) {
      const unavailableStyle = await unavailableNode.evaluate((element) => {
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
        const effectiveBackground = (start: Element): Rgba => {
          let result: Rgba = [0, 0, 0, 0];
          let current: Element | null = start;
          while (current && result[3] < 1) {
            result = over(result, parse(getComputedStyle(current).backgroundColor));
            current = current.parentElement;
          }
          return result[3] < 1 ? over(result, [255, 255, 255, 1]) : result;
        };
        const luminance = (rgb: number[]) => {
          const channels = rgb.slice(0, 3).map((value) => {
            const normalized = value / 255;
            return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
        };
        const text = element.querySelector("span:nth-of-type(3)") ?? element;
        const renderedBackground = effectiveBackground(element);
        const renderedForeground = over(parse(getComputedStyle(text).color), renderedBackground);
        const foreground = luminance(renderedForeground);
        const background = luminance(renderedBackground);
        const contrast = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
        return { contrast, opacity: getComputedStyle(element).opacity };
      });
      expect(unavailableStyle.opacity).toBe("1");
      expect(unavailableStyle.contrast).toBeGreaterThanOrEqual(4.5);
    }

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(mutatingApiRequests).toEqual([]);
    expect(failures).toEqual([]);
    const name = path.split("/").at(-1) ?? "integration";
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      window.scrollTo({ top: 0, behavior: "instant" });
    });
    await testInfo.attach(`${name}-desktop`, {
      body: await page.screenshot({ animations: "disabled", fullPage: true }),
      contentType: "image/png",
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByText("Keep exploring", { exact: true }).scrollIntoViewIfNeeded();
    const footerMenu = page.getByRole("button", { name: "Integrations" }).last();
    await footerMenu.click();
    const visibleMenu = page.getByRole("menu", { name: "Integrations" }).filter({ visible: true });
    const menuBox = await visibleMenu.boundingBox();
    expect(menuBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((menuBox?.x ?? 0) + (menuBox?.width ?? 376)).toBeLessThanOrEqual(375);
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      window.scrollTo({ top: 0, behavior: "instant" });
    });
    const activeMobileItems = [
      stepTrack.locator('[aria-current="step"]'),
      page.getByRole("region", { name: "Animated system route" }).locator('[aria-current="step"]'),
    ];
    for (const item of activeMobileItems) {
      await expect.poll(() => item.evaluate((element) => {
        const viewport = element.closest("[data-horizontal-track]")?.getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        return Boolean(viewport && rect.left >= viewport.left && rect.right <= viewport.right);
      })).toBe(true);
    }
    await testInfo.attach(`${name}-mobile`, {
      body: await page.screenshot({ animations: "disabled", fullPage: true }),
      contentType: "image/png",
    });
    expect(failures).toEqual([]);
  });
}

test("playback and keyboard controls advance and pause the QuickNode route", async ({ page }) => {
  await page.goto("/integrations/quicknode");
  const stepTrack = page.getByRole("region", { name: "Journey steps" });
  await page.getByRole("button", { name: "Pause journey" }).click();
  const pausedStep = await stepTrack.locator('[aria-current="step"]').textContent();
  await page.waitForTimeout(5_000);
  await expect(stepTrack.locator('[aria-current="step"]')).toHaveText(pausedStep ?? "");

  await page.getByRole("button", { name: "Play journey" }).click();
  await page.waitForTimeout(5_000);
  await expect(stepTrack.locator('[aria-current="step"]')).not.toHaveText(pausedStep ?? "");
  await page.getByRole("button", { name: "Pause journey" }).click();

  const selectedStep = stepTrack.locator('[aria-current="step"]');
  await selectedStep.press("Home");
  await expect(stepTrack.locator('[aria-current="step"]')).toContainText("01");
  await stepTrack.locator('[aria-current="step"]').press("ArrowRight");
  await expect(stepTrack.locator('[aria-current="step"]')).toContainText("02");

  const outcomes = page.getByRole("radiogroup", { name: "QuickNode outcome" });
  await outcomes.getByRole("radio", { checked: true }).press("End");
  await expect(outcomes.getByRole("radio").last()).toHaveAttribute("aria-checked", "true");
});

test("mobile step and route strips keep the selected Mastercard step in view", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/integrations/mastercard");
  await expect(page.getByText("Swipe to explore every step →", { exact: true })).toBeVisible();
  await expect(page.getByText("Swipe route →", { exact: true })).toBeVisible();

  const stepTrack = page.getByRole("region", { name: "Journey steps" });
  const initialScrollY = await page.evaluate(() => window.scrollY);
  const initialStep = await stepTrack.locator('[aria-current="step"]').textContent();
  await page.waitForTimeout(5_000);
  await expect(stepTrack.locator('[aria-current="step"]')).not.toHaveText(initialStep ?? "");
  expect(await page.evaluate(() => window.scrollY)).toBe(initialScrollY);
  await page.getByRole("button", { name: "Pause journey" }).click();
  await page.setViewportSize({ width: 1280, height: 720 });
  await stepTrack.locator('[aria-current="step"]').press("End");
  await page.setViewportSize({ width: 375, height: 812 });
  const activeItems = [
    stepTrack.locator('[aria-current="step"]'),
    page.getByRole("region", { name: "Animated system route" }).locator('[aria-current="step"]'),
  ];
  for (const item of activeItems) {
    await expect.poll(() => item.evaluate((element) => {
      const viewport = element.closest("[data-horizontal-track]")?.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      return Boolean(viewport && rect.left >= viewport.left && rect.right <= viewport.right);
    })).toBe(true);
  }
});

test("reduced motion keeps the Ledger explainer manual on mobile", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/integrations/ledger");

  await expect(page.getByText("Reduced motion · manual stepping", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Autoplay disabled for reduced motion" })).toBeDisabled();
  const stepTrack = page.getByRole("region", { name: "Journey steps" });
  const current = stepTrack.locator('[aria-current="step"]');
  const before = await current.textContent();
  await page.waitForTimeout(5_000);
  await expect(current).toHaveText(before ?? "");
  await page.getByRole("button", { name: "Next step" }).click();
  await expect(stepTrack.locator('[aria-current="step"]')).not.toHaveText(before ?? "");

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await testInfo.attach("ledger-mobile-reduced-motion", {
    body: await page.screenshot({ animations: "disabled", fullPage: true }),
    contentType: "image/png",
  });
});
