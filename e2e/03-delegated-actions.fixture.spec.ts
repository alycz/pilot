import type { CardEvent, Intent, PolicyResult, TxBuild } from "@pilot/contracts";

import { demoIntent, fixtureEvent } from "../apps/web/app/chat/fixtures";
import {
  expect,
  fulfillPilotStream,
  installFixtureChatPrerequisites,
  pilotRoutes,
  requireLane,
  test,
} from "./support";

const prompt =
  "Put 200 RLUSD into the XRP/RLUSD pool and buy 100 RLUSD of XRP, max 1% slippage";
const fixtureAccount = "rPT7vGmYxnV6wNP9RC2Mm3Fp9NBH3bK";
const rlusd = demoIntent.sell;

const lpIntent: Intent = {
  id: "intent-golden-03-lp-fixture",
  network: "testnet",
  kind: "lp_deposit",
  asset: demoIntent.sell,
  asset2: demoIntent.buy,
  amount: "200",
};
const swapIntent: Intent = {
  ...demoIntent,
  id: "intent-golden-03-swap-fixture",
  amount: "100",
  max_slippage_bps: 100,
};

const lpDepositTransaction = {
  TransactionType: "AMMDeposit",
  Account: fixtureAccount,
  Asset: rlusd,
  Asset2: { currency: "XRP" },
  Amount: { ...rlusd, value: "200" },
  Flags: 524_288,
};

const lpDepositBuild: TxBuild = {
  build_id: "build_fixture_intent-golden-03-lp-fixture",
  network: "testnet",
  tx_json: lpDepositTransaction,
  delegable: true,
  simulate: {
    engine_result: "tesSUCCESS",
    engine_result_message: "The simulated AMM deposit would succeed.",
    applied: false,
  },
  preflight: [
    { check: "reserve", pass: true, detail: "Reserve remains above minimum" },
    { check: "trustline", pass: true, detail: "RLUSD trust line is active" },
    { check: "amm", pass: true, detail: "The XRP/RLUSD AMM accepts a single-asset deposit" },
  ],
  summary: {
    action: "Deposit 200 RLUSD into the XRP/RLUSD AMM",
    account: fixtureAccount,
    amounts: ["200 RLUSD"],
    fee_drops: "12",
    reserve_delta_drops: "0",
    usd_value: "200.00",
  },
};

const lpDepositPolicy: PolicyResult = {
  verdict: "execute",
  reasons: [
    { rule: "max_per_tx_usd", pass: true, detail: "$200.00 is within the $2,000 limit" },
    { rule: "daily_cap_usd", pass: true, detail: "$1,120 remains today" },
    { rule: "issuer_allowlist", pass: true, detail: "RLUSD issuer is allowlisted" },
  ],
};

function localPreExecutionSequence(
  intent: Intent,
  build?: TxBuild,
  policy?: PolicyResult,
): CardEvent[] {
  return ["drafting", "planned", "simulated", "policy_checked", "executing"].map(
    (state) => {
      const event = fixtureEvent(state as CardEvent["state"], intent);
      return {
        ...event,
        ...(event.build && build ? { build } : {}),
        ...(event.policy && policy ? { policy } : {}),
      };
    },
  );
}

test("golden 03 renders two policy-cleared local actions without claiming ledger validation", async ({
  page,
  lane,
  evidence,
}) => {
  requireLane(lane, "fixture");
  await installFixtureChatPrerequisites(page);
  const cards = [
    ...localPreExecutionSequence(lpIntent, lpDepositBuild, lpDepositPolicy),
    ...localPreExecutionSequence(swapIntent),
  ];

  expect(lpDepositBuild.tx_json).toEqual({
    TransactionType: "AMMDeposit",
    Account: fixtureAccount,
    Asset: rlusd,
    Asset2: { currency: "XRP" },
    Amount: { ...rlusd, value: "200" },
    Flags: 524_288,
  });
  expect(lpDepositBuild.summary).toEqual({
    action: "Deposit 200 RLUSD into the XRP/RLUSD AMM",
    account: fixtureAccount,
    amounts: ["200 RLUSD"],
    fee_drops: "12",
    reserve_delta_drops: "0",
    usd_value: "200.00",
  });

  await page.route("**/api/chat", async (route) => {
    await fulfillPilotStream(route, {
      text: "The local fixture prepared two independent actions. No ledger outcome is asserted.",
      cards,
    });
  });

  await page.goto(pilotRoutes.chat);
  await expect(page.getByLabel("Message Pilot")).toBeEnabled();
  await page.getByLabel("Message Pilot").fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();

  const turn = page.getByText(prompt, { exact: true }).locator("xpath=ancestor::article[1]");
  await expect(turn.locator('[data-card-state="executing"]')).toHaveCount(2);
  await expect(turn).toContainText("Add 200 RLUSD to RLUSD/XRP");
  await expect(turn).toContainText("Sell 100 RLUSD · RLUSD/XRP");
  await expect(turn.locator('[data-card-state="submitted"]')).toHaveCount(0);
  await expect(turn.locator('[data-card-state="validated"]')).toHaveCount(0);

  evidence.record("delegated-actions-fixture-boundary", {
    plannedActions: ["lp_deposit", "swap"],
    lpDepositTransactionType: lpDepositBuild.tx_json.TransactionType as string,
    lpDepositAmount: "200 RLUSD",
    terminalLocalState: "executing",
    submitted: false,
    ledgerValidated: false,
    note: "Delegate field and validated hashes require the opt-in authenticated-live evidence lane.",
  });
});
