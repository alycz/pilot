import type { CardEvent } from "@pilot/contracts";
import type { Page } from "@playwright/test";

import { fixtureSequence } from "../apps/web/app/chat/fixtures";
import { expect, installFixtureChatPrerequisites, pilotRoutes, requireLane, test } from "./support";

const PROMPT = "Deposit 100 XRP in the vault";

function devnetVaultApproval(): CardEvent[] {
  return fixtureSequence(PROMPT).map((event) => ({
    ...event,
    intent: { ...event.intent, network: "devnet" },
    ...(event.build ? { build: { ...event.build, network: "devnet" } } : {}),
  })) as CardEvent[];
}

async function routeChatStream(page: Page, text: string, events: CardEvent[]) {
  await page.route("**/api/chat", async (route) => {
    const body = [
      `data: ${JSON.stringify({ type: "text-delta", delta: text })}`,
      ...events.map((event) => `data: ${JSON.stringify({ type: "data-card", data: event })}`),
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

test("golden 05 shows the exact owner-approval boundary without signing", async ({
  page,
  lane,
  evidence,
}) => {
  requireLane(lane, "fixture");
  expect(evidence.kind).toBe("fixture");
  await installFixtureChatPrerequisites(page);

  let submitRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/api/harbor/tx.submit")) submitRequests += 1;
  });
  await routeChatStream(
    page,
    "The vault deposit is simulated, but vault actions require an owner signature.",
    devnetVaultApproval(),
  );

  await page.goto(pilotRoutes.chat);
  await page.getByLabel("Message Pilot").fill(PROMPT);
  await page.getByLabel("Message Pilot").press("Enter");

  const turn = page.getByText(PROMPT, { exact: true }).locator("xpath=ancestor::article[1]");
  const approval = turn.locator('[data-card-state="awaiting_approval"]');
  await expect(approval).toBeVisible();
  await expect(approval).toContainText("Owner approval required");
  await expect(approval).toContainText("Deposit 100 XRP");
  await expect(approval).toContainText("Your wallet only signs; it never broadcasts.");
  await expect(approval.getByRole("button", { name: "Review & sign" })).toBeVisible();
  expect(submitRequests).toBe(0);

  evidence.record("golden-05-owner-approval", {
    authority: "none",
    finalCardState: "awaiting_approval",
    networkPresented: "devnet",
    signed: false,
    submitted: false,
    validatedLedgerClaimed: false,
  });
});
