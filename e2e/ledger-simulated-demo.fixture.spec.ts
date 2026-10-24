import { expect, installFixtureChatPrerequisites, pilotRoutes, requireLane, test } from "./support";

test("logged-out Ledger demo replays recorded screens without device or network authority", async ({
  page,
  lane,
  evidence,
}) => {
  requireLane(lane, "fixture");
  expect(evidence.kind).toBe("fixture");

  const unexpectedRequests: string[] = [];
  page.on("request", (request) => {
    const target = new URL(request.url());
    if (target.origin !== lane.baseURL) unexpectedRequests.push(request.url());
    if (target.pathname.startsWith("/api/")) {
      unexpectedRequests.push(request.url());
    }
  });

  await page.goto("/demo/ledger");

  await expect(page.getByRole("heading", { name: "See every screen before you sign." })).toBeVisible();
  const device = page.getByRole("region", { name: "Simulated Ledger replay" });
  await expect(device.getByText("Simulated Ledger", { exact: true })).toBeVisible();
  await expect(device.getByText("Recorded demo · no signing")).toBeVisible();
  await expect(device.getByText("Review what your wallet would show")).toBeVisible();
  await expect(device.getByText("Your wallet only signs; it never broadcasts.", { exact: false })).toBeVisible();

  const initialProgress = await device.getByRole("status").textContent();
  await device.getByRole("button", { name: "Press the right Ledger button" }).click();
  await expect(device.getByRole("status")).not.toHaveText(initialProgress ?? "");

  await page.getByRole("button", { name: "Permissions" }).click();
  await expect(page.getByRole("button", { name: "Permissions" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Owner approval" })).toHaveAttribute("aria-pressed", "false");
  await expect(device.getByText("Approve seven narrow permissions")).toBeVisible();
  await expect(device.getByText("None can send value to another account.", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Owner approval" }).click();
  await expect(page.getByRole("button", { name: "Owner approval" })).toHaveAttribute("aria-pressed", "true");
  await expect(device.getByText("Review what your wallet would show")).toBeVisible();

  expect(unexpectedRequests).toEqual([]);
  await page.screenshot({ path: "test-results/playwright/ledger-pitch/lg5-logged-out-simulated-ledger.png", fullPage: true });
  evidence.record("lg5-logged-out-simulated-ledger", {
    authority: "none",
    source: "bundled-deterministic-speculos-transcript",
    deviceConnected: false,
    signed: false,
    submitted: false,
    validatedLedgerClaimed: false,
  });
});

test("logged-out chat approval uses the recorded device without signing", async ({
  page,
  lane,
  evidence,
}) => {
  requireLane(lane, "fixture");
  await installFixtureChatPrerequisites(page);
  await page.unroute("**/api/config/public");
  await page.route("**/api/config/public", (route) => route.fulfill({ json: {
    network: "testnet",
    stableAsset: { currency: "RLUSD", issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" },
    devSignerEnabled: false,
    walletActionProofRequired: true,
    walletActionProofConfigured: true,
    mockMode: false,
  } }));
  let submitRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/api/harbor/tx.submit")) submitRequests += 1;
  });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(pilotRoutes.chat);
  await page.getByRole("button", { name: "Review the recorded Ledger approval" }).click();
  await page.getByLabel("Message Pilot").press("Enter");
  const approval = page.locator('[data-card-state="awaiting_approval"]');
  await expect(approval).toBeVisible();
  await approval.getByRole("button", { name: "Review & sign" }).click();
  const dialog = page.getByRole("dialog", { name: "Review what your wallet would show" });
  await expect(dialog.getByRole("region", { name: "Simulated Ledger" })).toBeVisible();
  await expect(dialog.getByText("Recorded demo · no signing")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Sign (simulated)" })).toHaveCount(0);
  const progress = dialog.getByRole("status");
  for (let screen = 1; screen < 11; screen += 1) {
    await dialog.getByRole("button", { name: "Press the right Ledger button" }).click();
    await expect(progress).toContainText(`Screen ${screen + 1} of 11`);
  }
  await dialog.getByRole("button", { name: "Press both Ledger buttons" }).click();
  await expect(dialog.getByText("Simulated signature accepted. No real transaction was made.")).toBeVisible();
  expect(submitRequests).toBe(0);
  evidence.record("lg4-logged-out-approval-replay", {
    authority: "none",
    deviceConnected: false,
    signed: false,
    submitted: false,
    validatedLedgerClaimed: false,
  });
});

test("landing presents the recorded TrustSet with explicit simulated-only provenance", async ({
  page,
  lane,
  evidence,
}) => {
  requireLane(lane, "fixture");
  expect(evidence.kind).toBe("fixture");

  const unexpectedRequests: string[] = [];
  page.on("request", (request) => {
    const target = new URL(request.url());
    if (target.origin !== lane.baseURL || target.pathname.startsWith("/api/")) {
      unexpectedRequests.push(request.url());
    }
  });

  await page.goto("/");
  const section = page.getByRole("region", {
    name: "Bounded automation. Owner control beyond the boundary.",
  });
  await expect(section).toBeVisible();
  await expect(section.getByText("Set the RLUSD trust line", { exact: true })).toBeVisible();
  const trustSetFigure = section.locator(
    'figure[aria-labelledby="ledger-trustset-caption"]',
  );
  await expect(
    trustSetFigure.locator('[aria-label="Simulated Ledger clear-signing a TrustSet"]'),
  ).toBeVisible();
  await expect(
    trustSetFigure.locator("figcaption").getByText("TrustSet", { exact: true }),
  ).toBeVisible();
  await expect(section.getByText("Simulated evidence only.", { exact: false })).toBeVisible();
  await expect(section.getByText("Physical-Ledger and live-Testnet checks are", { exact: false })).toBeVisible();
  expect(unexpectedRequests).toEqual([]);
  evidence.record("lg7-landing-trustset", {
    authority: "none",
    source: "bundled-deterministic-speculos-transcript",
    deviceConnected: false,
    signed: false,
    submitted: false,
    validatedLedgerClaimed: false,
  });
});
