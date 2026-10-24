import type { Page } from "@playwright/test";

import { expect, installFixtureChatPrerequisites, pilotRoutes, requireLane, test } from "./support";

const PREFERENCE_PROMPT = "Prefer low-slippage routes in the future";
const PREFERENCE = "Prefer low-slippage routes";

async function routePendingPreference(page: Page) {
  await page.route("**/api/chat", async (route) => {
    const body = [
      `data: ${JSON.stringify({
        type: "text-delta",
        delta: "I prepared a preference proposal. It remains pending until you explicitly accept it.",
      })}`,
      `data: ${JSON.stringify({
        type: "data-preference",
        data: {
          id: "preference-fixture-pending-1",
          state: "proposed",
          preference: PREFERENCE,
          reason: "Use lower-slippage routes when otherwise comparable.",
          at: "2026-10-19T12:00:00.000Z",
        },
      })}`,
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

test("golden 08 exposes linked journal, trade, reflection, and one unresolved preference", async ({
  page,
  lane,
  evidence,
}) => {
  requireLane(lane, "fixture");
  expect(evidence.kind).toBe("fixture");
  await installFixtureChatPrerequisites(page);

  await page.goto(pilotRoutes.memory);
  const noteLibraryHeading = page.getByRole("heading", { name: "Vault notes" });
  await expect(noteLibraryHeading).toBeVisible();
  await expect(noteLibraryHeading.locator("..")).toContainText("8 linked Markdown files");
  await expect(page.getByText("October 17 journal", { exact: true })).toBeVisible();
  await expect(page.getByText("Swap 50 RLUSD → XRP", { exact: true })).toBeVisible();
  await expect(page.getByText("Fill reflection", { exact: true })).toBeVisible();

  await page.getByPlaceholder("Search notes and tags").fill("reflection");
  await expect(page.getByText("Fill reflection", { exact: true })).toBeVisible();
  await expect(page.getByText("October 17 journal", { exact: true })).toHaveCount(0);

  let preferenceWrites = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/vault/preferences/accept") preferenceWrites += 1;
  });
  await routePendingPreference(page);
  await page.goto(pilotRoutes.chat);
  await page.getByLabel("Message Pilot").fill(PREFERENCE_PROMPT);
  await page.getByLabel("Message Pilot").press("Enter");

  const proposal = page.getByLabel(`Preference proposal: ${PREFERENCE}`);
  await expect(proposal).toBeVisible();
  await expect(proposal).toContainText("only a proposal");
  await expect(proposal.getByRole("button", { name: "Accept preference" })).toBeVisible();
  await expect(proposal.getByRole("button", { name: "Reject" })).toBeVisible();
  expect(preferenceWrites).toBe(0);

  evidence.record("golden-08-vault-memory", {
    source: "deterministic fixture",
    noteKindsObserved: ["journal", "trade", "reflection"],
    pendingPreferenceCount: 1,
    preferenceAccepted: false,
    persistedLedgerArtifactsClaimed: false,
  });
});
