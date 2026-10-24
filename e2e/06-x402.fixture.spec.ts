import type { Page } from "@playwright/test";

import { expect, installFixtureChatPrerequisites, pilotRoutes, requireLane, test } from "./support";

const PROMPT = "Run the premium venue comparison";
const BLOCKED_FALLBACK =
  "Premium comparison is blocked in the localhost run: the hosted Harbor Worker cannot reach a merchant on localhost. No x402 payment was attempted, no settlement occurred, and no spend was logged.";

async function routeBlockedFallback(page: Page) {
  await page.route("**/api/chat", async (route) => {
    const body = [
      `data: ${JSON.stringify({ type: "text-delta", delta: BLOCKED_FALLBACK })}`,
      "data: [DONE]",
      "",
    ].join("\n");
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      body,
    });
  });
}

test("golden 06 reports the localhost x402 reachability blocker without fabricating settlement", async ({
  page,
  lane,
  evidence,
}) => {
  requireLane(lane, "fixture");
  expect(evidence.kind).toBe("fixture");
  await installFixtureChatPrerequisites(page);

  const attemptedPaymentRequests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.includes("x402.pay") || path.startsWith("/api/x402/")) {
      attemptedPaymentRequests.push(path);
    }
  });
  await routeBlockedFallback(page);

  await page.goto(pilotRoutes.chat);
  await page.getByLabel("Message Pilot").fill(PROMPT);
  await page.getByLabel("Message Pilot").press("Enter");

  const turn = page.getByText(PROMPT, { exact: true }).locator("xpath=ancestor::article[1]");
  await expect(turn).toContainText("hosted Harbor Worker cannot reach a merchant on localhost");
  await expect(turn).toContainText("No x402 payment was attempted");
  await expect(turn).toContainText("no settlement occurred");
  await expect(turn.locator("[data-card-state]")).toHaveCount(0);
  expect(attemptedPaymentRequests).toEqual([]);

  evidence.record("golden-06-x402-blocked-fallback", {
    outcome: "blocked",
    reason: "hosted Harbor Worker cannot reach localhost merchant",
    paymentAttempted: false,
    settlementClaimed: false,
    spendLoggedClaimed: false,
  });
});
