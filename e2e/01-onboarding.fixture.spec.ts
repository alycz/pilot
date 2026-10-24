import {
  expect,
  installFixtureChatPrerequisites,
  pilotRoutes,
  requireLane,
  test,
} from "./support";

test("golden 01 exposes the honest wallet and delegation preconditions without a signer", async ({
  page,
  lane,
  evidence,
}) => {
  requireLane(lane, "fixture");
  const ledgerApiRequests: string[] = [];
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const target = new URL(request.url());
    if (target.origin !== lane.baseURL) externalRequests.push(request.url());
    if (target.pathname.startsWith("/api/ledger-sim/")) {
      ledgerApiRequests.push(request.url());
    }
  });
  await installFixtureChatPrerequisites(page, { ledger: true });

  await page.goto(pilotRoutes.onboarding);
  await expect(
    page.getByRole("heading", { name: "Authenticate your budget wallet" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Check extension" })).toBeVisible();
  await expect(page.getByText(
    /separately sign .*AccountSet proof that cannot be submitted to the ledger/i,
  )).toBeVisible();
  await expect(page.getByRole("heading", { name: /Choose model access/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Testnet dev signer/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Gemwallet/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Crossmark/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Xaman/i })).toBeDisabled();
  await page.getByRole("button", { name: /^Ledger/i }).click();
  const simulatedLedger = page.getByRole("region", { name: "Simulated Ledger" });
  await expect(simulatedLedger.getByText("Recorded demo · no signing")).toBeVisible();
  await expect(simulatedLedger.getByText("Verify address")).toBeVisible();
  await expect(simulatedLedger.getByRole("status")).toContainText("Screen 1 of 3");
  expect(ledgerApiRequests).toEqual([]);
  expect(externalRequests).toEqual([]);

  evidence.record("onboarding-fixture-boundary", {
    signerEnabled: false,
    stoppedAt: "wallet-provider-selection",
    ledgerValidated: false,
    simulatedLedgerReplay: true,
    assertion:
      "The fixture lane verifies the local setup and signer preconditions only; it does not claim funding or an active delegation.",
  });
});
