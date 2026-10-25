import {
  expect,
  fulfillPilotStream,
  installFixtureChatPrerequisites,
  pilotRoutes,
  requireLane,
  test,
} from "./support";

const prompt = "Where can I earn on 500 RLUSD?";
const answer = [
  "As of 2026-10-19T12:00:00.000Z (fixture freshness), the XRP/RLUSD AMM can earn trading fees, but returns depend on volume and impermanent loss.",
  "The Single Asset Vault is devnet-only and its displayed APY is an estimate, not a guarantee.",
  "Doppler and Soil are off-ledger venues; availability, custody, and quoted yields require independent verification.",
  "No transaction was proposed for this research-only request.",
].join(" ");

test("golden 02 answers yield research with freshness and caveats but no action card", async ({
  page,
  lane,
  evidence,
}) => {
  requireLane(lane, "fixture");
  await installFixtureChatPrerequisites(page);

  await page.route("**/api/chat", async (route) => {
    await fulfillPilotStream(route, { text: answer });
  });

  await page.goto(pilotRoutes.chat);
  await expect(page.getByLabel("Message Pilot")).toBeEnabled();
  await page.getByLabel("Message Pilot").fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();

  const turn = page.getByText(prompt, { exact: true }).locator("xpath=ancestor::article[1]");
  await expect(turn).toContainText("AMM");
  await expect(turn).toContainText("Vault");
  await expect(turn).toContainText("Doppler");
  await expect(turn).toContainText("Soil");
  await expect(turn).toContainText("2026-10-19T12:00:00.000Z");
  await expect(turn).toContainText("devnet-only");
  await expect(turn).toContainText("off-ledger");
  await expect(turn).toContainText("not a guarantee");
  await expect(turn.locator("[data-card-state]")).toHaveCount(0);

  evidence.record("research-fixture-result", {
    sourcesRepresented: ["XRPL AMM", "Single Asset Vault", "Doppler", "Soil"],
    freshness: "2026-10-19T12:00:00.000Z",
    caveats: ["impermanent loss", "devnet-only", "off-ledger", "not guaranteed"],
    actionCardCount: 0,
  });
});
