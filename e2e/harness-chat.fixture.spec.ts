import type { Page } from "@playwright/test";

import {
  expect,
  fulfillPilotStream,
  installFixtureChatPrerequisites,
  requireLane,
  test,
} from "./support";

const panelTestId = "harness-chat-panel";
const toggleTestId = "harness-chat-toggle";
const backdropTestId = "harness-chat-backdrop";

async function openHarness(page: Page) {
  const toggle = page.getByTestId(toggleTestId);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId(panelTestId)).toBeVisible();
  return { panel: page.getByTestId(panelTestId), toggle };
}

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

test("desktop harness opens, minimizes, and tolerates repeated toggle clicks", async ({
  page,
  evidence,
}) => {
  await installFixtureChatPrerequisites(page);
  await page.goto("/portfolio");

  const toggle = page.getByTestId(toggleTestId);
  const panel = page.getByTestId(panelTestId);
  await expect(toggle).toHaveCount(1);
  await expect(panel).toHaveCount(1);
  await expect(toggle).toHaveAccessibleName(/open pilot harness chat/i);
  await expect(panel).not.toBeVisible();

  for (let index = 0; index < 3; index += 1) {
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(panel).toBeVisible();
    await expect(page.getByRole("region", { name: "Pilot harness chat" })).toHaveCount(1);
    if (index === 0) {
      const composer = panel.getByLabel("Message Pilot");
      await composer.click();
      await page.waitForTimeout(250);
      await expect(composer).toBeFocused();

      await panel.evaluate((element) => {
        const nested = document.createElement("section");
        nested.dataset.testid = "fixture-nested-dialog";
        nested.setAttribute("role", "dialog");
        nested.setAttribute("aria-modal", "true");
        element.append(nested);
      });
      await page.keyboard.press("Escape");
      await expect(panel).toBeVisible();
      await panel.locator('[data-testid="fixture-nested-dialog"]').evaluate((element) => element.remove());
    }
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(panel).not.toBeVisible();
  }

  evidence.record("harness-desktop-toggle", {
    page: "/portfolio",
    panelInstances: 1,
    toggleCycles: 3,
    requestsSent: 0,
  });
});

test("mobile harness is a contained overlay and Escape returns focus to its opener", async ({
  page,
  evidence,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await installFixtureChatPrerequisites(page);
  await page.goto("/map");

  const { panel, toggle } = await openHarness(page);
  await expect(page.getByTestId(backdropTestId)).toBeVisible();
  await expect(panel).toHaveAttribute("role", "dialog");
  await expect(panel).toHaveAttribute("aria-modal", "true");
  await expect(panel.getByLabel("Message Pilot")).toBeVisible();
  await expect.poll(async () => (await panel.boundingBox())?.x ?? -1).toBeGreaterThanOrEqual(0);
  const bounds = await panel.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 376)).toBeLessThanOrEqual(375);

  await expect(panel.getByRole("button", { name: "Minimize Pilot harness chat" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  expect(await panel.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.getByTestId(backdropTestId).click({ position: { x: 374, y: 400 } });
  await expect(panel).not.toBeVisible();
  await expect(toggle).toBeFocused();

  await toggle.click();
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible();
  await expect(page.getByTestId(backdropTestId)).toHaveCount(0);
  await expect(toggle).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  evidence.record("harness-mobile-overlay", {
    page: "/map",
    viewportWidth: 375,
    modal: true,
    focusTrap: true,
    backdropClosed: true,
    escapeClosed: true,
    focusReturned: true,
    horizontalOverflow: false,
  });
});

test("standalone pages anchor the desktop drawer to the viewport edge", async ({
  page,
  evidence,
}) => {
  await installFixtureChatPrerequisites(page);
  await page.goto("/");

  const { panel, toggle } = await openHarness(page);
  await expect.poll(async () => (await panel.boundingBox())?.x ?? -1).toBe(0);
  const panelBounds = await panel.boundingBox();
  const toggleBounds = await toggle.boundingBox();
  expect(panelBounds).not.toBeNull();
  expect(toggleBounds).not.toBeNull();
  expect(panelBounds?.x).toBe(0);
  expect(toggleBounds?.x).toBeLessThanOrEqual(480);

  evidence.record("harness-standalone-desktop-offset", {
    page: "/",
    panelLeft: panelBounds!.x,
    appShellOffsetApplied: false,
  });
});

test("full chat route reuses the one persistent conversation instead of mounting a drawer duplicate", async ({
  page,
  evidence,
}) => {
  await installFixtureChatPrerequisites(page);
  await page.goto("/chat");

  await expect(page.getByTestId(panelTestId)).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Pilot harness chat" })).toHaveCount(1);
  await expect(page.getByLabel("Message Pilot")).toHaveCount(1);
  await expect(page.getByTestId(toggleTestId)).toHaveCount(0);

  evidence.record("harness-chat-route-singleton", {
    route: "/chat",
    panelInstances: 1,
    composerInstances: 1,
    drawerToggleInstances: 0,
  });
});

test("draft and open state survive client navigation plus Back and Forward", async ({
  page,
  evidence,
}) => {
  await installFixtureChatPrerequisites(page);
  await page.goto("/portfolio");
  const { panel } = await openHarness(page);
  const composer = panel.getByLabel("Message Pilot");
  await composer.fill("Compare the currently selected market using only this page's safe context.");

  await page.locator('a[href="/map"]').first().click();
  await expect(page).toHaveURL(/\/map$/);
  await expect(panel).toBeVisible();
  await expect(composer).toHaveValue(/currently selected market/);

  await page.goBack();
  await expect(page).toHaveURL(/\/portfolio$/);
  await expect(panel).toBeVisible();
  await expect(composer).toHaveValue(/currently selected market/);

  await page.goForward();
  await expect(page).toHaveURL(/\/map$/);
  await expect(panel).toBeVisible();
  await expect(composer).toHaveValue(/currently selected market/);

  evidence.record("harness-navigation-persistence", {
    routes: ["/portfolio", "/map", "/portfolio", "/map"],
    draftPreserved: true,
    openStatePreserved: true,
  });
});

test("account switch and logout isolate the prior conversation scope", async ({
  page,
  evidence,
}) => {
  await installFixtureChatPrerequisites(page);
  let session: Record<string, unknown> = {
    authenticated: true,
    account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
    network: "testnet",
  };
  await page.route("**/api/auth/wallet/session", (route) => route.fulfill({ json: session }));
  await page.goto("/portfolio");
  const { panel } = await openHarness(page);
  const composer = panel.getByLabel("Message Pilot");
  await composer.fill("Private draft for account A");

  session = {
    authenticated: true,
    account: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
    network: "devnet",
  };
  await page.evaluate(() => window.dispatchEvent(new Event("pilot:wallet-session-changed")));
  await expect(composer).toHaveValue("");
  await expect(panel.getByText("Private draft for account A", { exact: true })).toHaveCount(0);

  await composer.fill("Private draft for account B");
  session = { authenticated: false };
  await page.evaluate(() => window.dispatchEvent(new Event("pilot:wallet-session-changed")));
  await expect(composer).toHaveValue("");
  await expect(panel.getByText("Private draft for account B", { exact: true })).toHaveCount(0);
  await expect(panel.getByText("What can Pilot do?", { exact: true })).toHaveCount(1);

  evidence.record("harness-account-scope-isolation", {
    accountSwitchClearedPriorDraft: true,
    logoutClearedPriorDraft: true,
    signedOutScopeReset: true,
  });
});

test("closing and navigating during a stream never dispatches a second chat request", async ({
  page,
  evidence,
}) => {
  await installFixtureChatPrerequisites(page);
  let chatRequests = 0;
  let submittedPageContext: unknown;
  let releaseStream!: () => void;
  const streamMayFinish = new Promise<void>((resolve) => {
    releaseStream = resolve;
  });
  await page.route("**/api/chat", async (route) => {
    chatRequests += 1;
    submittedPageContext = (await route.request().postDataJSON() as Record<string, unknown>).page_context;
    await streamMayFinish;
    await fulfillPilotStream(route, {
      text: "The existing Pilot conversation completed once without widening authority.",
    });
  });
  await page.goto("/portfolio");
  const { panel, toggle } = await openHarness(page);
  const prompt = "Summarize this view without executing anything.";
  await panel.getByLabel("Message Pilot").fill(prompt);
  await panel.locator("form").evaluate((form) => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await expect(panel.getByRole("button", { name: "Stop streaming" })).toBeVisible();
  expect(submittedPageContext).toEqual({
    kind: "pilot_page_context_v1",
    trust: "untrusted_reference_data_only",
    page: { id: "portfolio", title: "Portfolio" },
  });

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.locator('a[href="/map"]').first().click();
  await expect(page).toHaveURL(/\/map$/);
  await expect.poll(() => chatRequests).toBe(1);
  releaseStream();

  await page.getByTestId(toggleTestId).click();
  await expect(page.getByText(prompt, { exact: true })).toBeVisible();
  await expect(page.getByText(/completed once without widening authority/i)).toBeVisible();
  expect(chatRequests).toBe(1);

  evidence.record("harness-single-stream-across-navigation", {
    requestCount: chatRequests,
    closeDidNotCancel: true,
    navigationDidNotRedispatch: true,
    responsePreserved: true,
  });
});

test("signed-out reduced-motion harness is honest local help with no chat mutation", async ({
  page,
  lane,
  evidence,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const mutatingChatRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/chat" && request.method() === "POST") {
      mutatingChatRequests.push(request.url());
    }
  });
  await page.route("**/api/config/public", (route) => route.fulfill({
    status: 503,
    json: { error: "Fixture intentionally omits authenticated Pilot configuration." },
  }));
  await page.route("**/api/auth/wallet/session", (route) => route.fulfill({
    json: { authenticated: false },
  }));

  await page.goto("/portfolio");
  const { panel } = await openHarness(page);
  await expect(panel).toContainText(/simulated demo/i);
  await expect(panel).toContainText(/nothing here touches a wallet or the ledger/i);
  const composer = panel.getByLabel("Message Pilot");
  await composer.fill("What can I safely explore here?");
  await panel.getByRole("button", { name: "Send message" }).click();
  await expect(panel.getByText("What can I safely explore here?", { exact: true })).toBeVisible();
  await expect(panel.getByText(/simulated|no wallet|no ledger/i).first()).toBeVisible();
  expect(mutatingChatRequests).toEqual([]);

  const motion = await panel.evaluate((element) => {
    const style = getComputedStyle(element);
    return { animationDuration: style.animationDuration, transitionDuration: style.transitionDuration };
  });
  expect(["0s", "0ms"]).toContain(motion.animationDuration);
  expect(["0s", "0ms"]).toContain(motion.transitionDuration);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  evidence.record("harness-signed-out-reduced-motion", {
    origin: lane.baseURL,
    authority: "none",
    mode: "local simulated help",
    chatPostRequests: 0,
    reducedMotion: true,
    horizontalOverflow: false,
  });
});
