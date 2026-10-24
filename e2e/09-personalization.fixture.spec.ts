import type { Page } from "@playwright/test";

import {
  expect,
  installFixtureChatPrerequisites,
  pilotRoutes,
  requireLane,
  test,
} from "./support";
import {
  CORRECTED_PREFERENCE,
  INITIAL_PREFERENCE,
  establishPersonalizationFixtureSession,
  resetPersonalizationFixtureStorage,
  seedPersonalizationFixtureProposals,
} from "./support/personalization-fixture";

async function submitPersonalizationPrompt(page: Page, prompt: string): Promise<void> {
  await page.getByLabel("Message Pilot").fill(prompt);
  const send = page.getByRole("button", { name: "Send message" });
  await expect(send).toBeEnabled();
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => {
      const url = new URL(candidate.url());
      return candidate.request().method() === "POST" && url.pathname === "/api/chat";
    }),
    send.click(),
  ]);
  if (!response.ok()) {
    throw new Error(`Personalization chat failed (${response.status()}): ${await response.text()}`);
  }
}

test.describe("personalization fixture lifecycle", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page, lane }) => {
    requireLane(lane, "fixture");
    await installFixtureChatPrerequisites(page, { personalization: true });
    // Establish the fixed fixture-only identity in each fresh browser context.
    // No wallet or transaction authority is established.
    await page.goto(pilotRoutes.memory, { waitUntil: "domcontentloaded" });
    await establishPersonalizationFixtureSession(page);
  });

  test("reviews and accepts preferences through the real UI", async ({ page }) => {
    await resetPersonalizationFixtureStorage(page);
    // Exercise retry cleanup with active records, rather than relying on a
    // pristine /tmp directory. The authenticated CAS reset is the serial
    // barrier for both a normal run and a retried lifecycle group.
    await seedPersonalizationFixtureProposals();
    await resetPersonalizationFixtureStorage(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    const preferencesPanel = page.locator('section[aria-labelledby="structured-preferences-title"]');
    const lessonsPanel = page.locator('section[aria-labelledby="workflow-lessons-title"]');
    await expect(preferencesPanel).toContainText("No structured preferences are active");
    await expect(lessonsPanel).toContainText("No workflow lessons are active");

    await seedPersonalizationFixtureProposals();
    await page.reload({ waitUntil: "domcontentloaded" });
    const proposedPreference = preferencesPanel.locator("article").filter({ hasText: INITIAL_PREFERENCE });
    await expect(proposedPreference).toContainText("proposed");
    await proposedPreference.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(proposedPreference).toContainText("accepted");
    const proposedLesson = lessonsPanel.locator("article").filter({ hasText: "Capital preservation first" });
    await expect(proposedLesson).toContainText("needs review");
    await proposedLesson.getByRole("button", { name: "Accept lesson" }).click();
    await expect(proposedLesson).toContainText("accepted");
  });

  test("retrieves accepted preferences through the real chat route", async ({ page }) => {
    // The later chat turn uses the dedicated read-only fixture branch of the
    // real route. It does not use a model or tools.
    await page.goto(pilotRoutes.chat, { waitUntil: "domcontentloaded" });
    await submitPersonalizationPrompt(page, "How should you tailor the next trade comparison?");
    await expect(page.getByText(INITIAL_PREFERENCE, { exact: false })).toBeVisible();
    await expect(page.getByText(/capital_preservation_first/)).toBeVisible();
    await expect(page.getByText(/transaction tools are disabled/)).toBeVisible();
  });

  test("corrects accepted preferences and retrieves the replacements", async ({ page }) => {
    const preferencesPanel = page.locator('section[aria-labelledby="structured-preferences-title"]');
    const lessonsPanel = page.locator('section[aria-labelledby="workflow-lessons-title"]');
    const acceptedPreference = preferencesPanel.locator("article").filter({ hasText: INITIAL_PREFERENCE });
    await acceptedPreference.getByLabel("Correct this preference").fill(CORRECTED_PREFERENCE);
    await acceptedPreference.getByRole("button", { name: "Save correction" }).click();
    await expect(preferencesPanel.locator("article").filter({ hasText: CORRECTED_PREFERENCE }))
      .toContainText("accepted");
    await expect(preferencesPanel).not.toContainText(INITIAL_PREFERENCE);
    const acceptedLesson = lessonsPanel.locator("article").filter({ hasText: "Capital preservation first" });
    await acceptedLesson.getByLabel("Correct this lesson").selectOption("balanced");
    await acceptedLesson.getByRole("button", { name: "Save correction" }).click();
    await expect(lessonsPanel.locator("article").filter({ hasText: "Balanced" }))
      .toContainText("accepted");
    await expect(lessonsPanel.locator("article p").filter({
      hasText: /^Capital preservation first$/,
    })).toHaveCount(0);

    await page.goto(pilotRoutes.chat, { waitUntil: "domcontentloaded" });
    await submitPersonalizationPrompt(page, "How should you tailor a market comparison?");
    await expect(page.getByText(CORRECTED_PREFERENCE, { exact: false })).toBeVisible();
    await expect(page.getByText(/research ordering: balanced/)).toBeVisible();
    await expect(page.getByText(INITIAL_PREFERENCE, { exact: false })).toHaveCount(0);
  });

  test("forgets accepted preferences and retrieves the empty state", async ({ page, evidence }) => {
    const preferencesPanel = page.locator('section[aria-labelledby="structured-preferences-title"]');
    const lessonsPanel = page.locator('section[aria-labelledby="workflow-lessons-title"]');
    const correctedPreference = preferencesPanel.locator("article").filter({ hasText: CORRECTED_PREFERENCE });
    await correctedPreference.getByRole("button", { name: "Forget" }).click();
    await expect(preferencesPanel).toContainText("No structured preferences are active");
    const correctedLesson = lessonsPanel.locator("article").filter({ hasText: "Balanced" });
    await correctedLesson.getByRole("button", { name: "Forget" }).click();
    await expect(lessonsPanel).toContainText("No workflow lessons are active");

    await page.goto(pilotRoutes.chat, { waitUntil: "domcontentloaded" });
    await submitPersonalizationPrompt(page, "How should you tailor the next comparison?");
    await expect(page.getByText("No accepted structured preferences are active.", { exact: false }))
      .toBeVisible();
    await expect(page.getByText("No accepted workflow lessons are active.", { exact: false }))
      .toBeVisible();
    await expect(page.getByText(CORRECTED_PREFERENCE, { exact: false })).toHaveCount(0);

    evidence.record("personalization-fixture-browser-loop", {
      source: "fixed synthetic scope with private local CAS storage",
      accepted: true,
      retrievedInLaterChat: true,
      corrected: true,
      forgotten: true,
      walletSessionCreated: false,
      transactionToolsEnabled: false,
      liveLedgerEvidenceClaimed: false,
    });
  });
});
