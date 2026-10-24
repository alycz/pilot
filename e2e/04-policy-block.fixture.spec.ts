import type { CardEvent, Intent, PolicyResult } from "@pilot/contracts";

import { demoIntent, fixtureEvent } from "../apps/web/app/chat/fixtures";
import {
  expect,
  fulfillPilotStream,
  installFixtureChatPrerequisites,
  pilotRoutes,
  requireLane,
  test,
} from "./support";

const prompt = "Swap 5,000 RLUSD into FREEMONEY";
const blockedIntent: Intent = {
  ...demoIntent,
  id: "intent-golden-04-blocked-fixture",
  buy: { currency: "FREEMONEY", issuer: "rUnknownFixtureIssuer" },
  amount: "5000",
};
const policy: PolicyResult = {
  verdict: "block",
  reasons: [
    {
      rule: "issuer_allowlist",
      pass: false,
      detail: "FREEMONEY issuer is not allowlisted",
    },
    {
      rule: "max_per_tx_usd",
      pass: false,
      detail: "$5,000 exceeds the $2,000 transaction limit",
    },
    {
      rule: "preflight_trustline",
      pass: false,
      detail: "Pre-flight found no trust line for FREEMONEY; policy evaluation still completed",
    },
  ],
};

function blockedSequence(): CardEvent[] {
  const sequence = ["drafting", "planned", "simulated"].map((state) =>
    fixtureEvent(state as CardEvent["state"], blockedIntent),
  );
  const simulated = sequence.at(-1)!;
  const build = {
    ...simulated.build!,
    preflight: [
      ...simulated.build!.preflight,
      {
        check: "trustline",
        pass: false,
        detail: "No trust line exists for the FREEMONEY issuer",
      },
    ],
  };
  return [
    ...sequence,
    {
      ...fixtureEvent("policy_checked", blockedIntent),
      build,
      policy,
    },
    {
      ...fixtureEvent("blocked", blockedIntent),
      build,
      policy,
      exec: { status: "blocked", policy },
    },
  ];
}

test("golden 04 lists every policy and pre-flight failure and submits nothing", async ({
  page,
  lane,
  evidence,
}) => {
  requireLane(lane, "fixture");
  await installFixtureChatPrerequisites(page);
  const cards = blockedSequence();

  await page.route("**/api/chat", async (route) => {
    await fulfillPilotStream(route, {
      text: "Harbor evaluated policy after pre-flight and blocked the request. Nothing was signed or submitted.",
      cards,
    });
  });

  await page.goto(pilotRoutes.chat);
  await expect(page.getByText("Harbor is ready", { exact: true })).toBeVisible();
  await page.getByLabel("Message Pilot").fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();

  const turn = page.getByText(prompt, { exact: true }).locator("xpath=ancestor::article[1]");
  const blocked = turn.locator('[data-card-state="blocked"]');
  await expect(blocked).toHaveCount(1);
  await expect(blocked).toContainText("FREEMONEY issuer is not allowlisted");
  await expect(blocked).toContainText("$5,000 exceeds the $2,000 transaction limit");
  await expect(blocked).toContainText("Pre-flight found no trust line for FREEMONEY");
  await expect(blocked).toContainText("Nothing was signed or submitted.");
  await expect(turn.locator('[data-card-state="submitted"]')).toHaveCount(0);
  await expect(turn.locator('[data-card-state="validated"]')).toHaveCount(0);

  evidence.record("policy-block-fixture-result", {
    verdict: "block",
    failedRules: ["issuer_allowlist", "max_per_tx_usd", "preflight_trustline"],
    preflightReachedPolicy: true,
    submitted: false,
  });
});
