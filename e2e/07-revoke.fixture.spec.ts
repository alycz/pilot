import type { AccountLink, CardEvent, Intent, PolicyResult } from "@pilot/contracts";
import type { Page } from "@playwright/test";

import { demoIntent, fixtureEvent } from "../apps/web/app/chat/fixtures";
import { expect, installFixtureChatPrerequisites, pilotRoutes, requireLane, test } from "./support";

const PROMPT = "My delegation is revoked. Swap 80 RLUSD for XRP, max 1% slippage";
const revokedDelegation = {
  owner: "rPT7vGmYxnV6wNP9RC2Mm3Fp9NBH3bK",
  network: "testnet",
  delegate: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
  permissions: [],
  status: "revoked",
} satisfies AccountLink;
const belowThresholdIntent: Intent = {
  ...demoIntent,
  id: "intent-golden-07-revoked-fixture",
  amount: "80",
};
const revokedPolicy: PolicyResult = {
  verdict: "needs_approval",
  reasons: [
    {
      rule: "delegation_status",
      pass: false,
      detail: `Delegation to ${revokedDelegation.delegate} is revoked; autonomous execution is unavailable`,
    },
    {
      rule: "execute_under_usd",
      pass: true,
      detail: "$80.00 is below the $250 autonomous threshold",
    },
  ],
};

function revokedFallbackSequence(): CardEvent[] {
  return ["drafting", "planned", "simulated", "policy_checked", "awaiting_approval"].map(
    (state) => {
      const event = fixtureEvent(state as CardEvent["state"], belowThresholdIntent);
      if (state === "policy_checked") return { ...event, policy: revokedPolicy };
      if (state === "awaiting_approval" && event.exec?.status === "needs_approval") {
        return {
          ...event,
          policy: revokedPolicy,
          exec: { ...event.exec, policy: revokedPolicy },
        };
      }
      return event;
    },
  );
}

async function routeRevokedFallback(page: Page, events: CardEvent[]) {
  await page.route("**/api/chat", async (route) => {
    const body = [
      `data: ${JSON.stringify({
        type: "text-delta",
        delta: "The delegation is revoked, so this otherwise valid swap cannot use autonomous execution and requires owner approval.",
      })}`,
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

test("golden 07 models the post-revocation action as owner approval, never delegated execution", async ({
  page,
  lane,
  evidence,
}) => {
  requireLane(lane, "fixture");
  expect(evidence.kind).toBe("fixture");
  await installFixtureChatPrerequisites(page);

  let mutationRequests = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/api/harbor/account.revoke") || path.endsWith("/api/harbor/tx.submit")) {
      mutationRequests += 1;
    }
  });
  const events = revokedFallbackSequence();
  const approval = events.at(-1);
  expect(revokedDelegation).toMatchObject({ status: "revoked", permissions: [] });
  expect(Number(belowThresholdIntent.amount)).toBeLessThan(250);
  expect(approval).toMatchObject({
    state: "awaiting_approval",
    policy: {
      verdict: "needs_approval",
      reasons: expect.arrayContaining([
        expect.objectContaining({ rule: "delegation_status", pass: false }),
        expect.objectContaining({ rule: "execute_under_usd", pass: true }),
      ]),
    },
  });
  await routeRevokedFallback(page, events);

  await page.goto(pilotRoutes.chat);
  await page.getByLabel("Message Pilot").fill(PROMPT);
  await page.getByLabel("Message Pilot").press("Enter");

  const turn = page.getByText(PROMPT, { exact: true }).locator("xpath=ancestor::article[1]");
  await expect(turn).toContainText("delegation is revoked");
  await expect(turn.locator('[data-card-state="awaiting_approval"]')).toBeVisible();
  await expect(turn.locator('[data-card-state="executing"]')).toHaveCount(0);
  await expect(turn.locator('[data-card-state="validated"]')).toHaveCount(0);
  expect(mutationRequests).toBe(0);

  evidence.record("golden-07-post-revocation-fallback", {
    precondition: revokedDelegation.status,
    permissionsAfterRevocation: revokedDelegation.permissions,
    amountUsd: 80,
    executeUnderUsd: 250,
    approvalCause: "delegation_status",
    finalCardState: "awaiting_approval",
    delegatedExecutionShown: false,
    revokeSubmitted: false,
    ownerTransactionSubmitted: false,
  });
});
