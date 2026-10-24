import type { Page, TestInfo } from "@playwright/test";
import type { Strategy, StrategyAuditEvent, StrategyKillSwitch } from "@pilot/contracts";

import { expect, requireLane, test } from "./support";

const ACCOUNT_A = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const ACCOUNT_B = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const CURRENCY = "524C555344000000000000000000000000000000";
const ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const DIGEST_A = "A".repeat(64);
const DIGEST_B = "B".repeat(64);
const CREATED_AT = "2026-10-22T00:00:00.000Z";
const EXPIRES_AT = "2035-10-22T12:00:00.000Z";
const STRATEGY_MEMO_TYPE = "70696C6F742D73747261746567792D6D616E646174652D7631".toUpperCase();

type Lifecycle = Strategy["lifecycle"];
type Harness = {
  sessionAccount?: string;
  strategies: Map<string, Strategy>;
  globalKills: Map<string, StrategyKillSwitch>;
  audit: Map<string, StrategyAuditEvent[]>;
  actions: string[];
  mutationBodies: Record<string, unknown>[];
  externalRequests: string[];
  challengeRequests: number;
  challengeBodies: Record<string, unknown>[];
  challengeTransactions: Record<string, unknown>[];
  authorizationFailures: string[];
  walletAuthorizationEnabled: boolean;
  unknownPause: boolean;
  unknownGlobalClear: boolean;
  unknownRequestId?: string;
};

function strategyFor(account: string, lifecycle: Lifecycle, generation = 1): Strategy {
  const approved = lifecycle !== "draft";
  const digest = account === ACCOUNT_A ? DIGEST_A : DIGEST_B;
  const strategyId = account === ACCOUNT_A ? "strategy:fixture-a" : "strategy:fixture-b";
  return {
    strategy_id: strategyId,
    lifecycle,
    generation,
    ...(lifecycle === "active" ? { next_evaluation_at: "2026-10-22T00:05:00.000Z" } : {}),
    created_at: CREATED_AT,
    updated_at: "2026-10-22T00:01:00.000Z",
    mandate: {
      mandate_id: account === ACCOUNT_A ? "mandate:fixture-a" : "mandate:fixture-b",
      strategy_id: strategyId,
      version: 1,
      digest,
      status: approved ? "approved" : "draft",
      kind: "xrp_issued_rebalancer_v1",
      network: "testnet",
      account,
      issued_asset: { currency: CURRENCY, issuer: ISSUER },
      allocation: { target_xrp_bps: 5000, lower_xrp_bps: 4500, upper_xrp_bps: 5500 },
      limits: {
        max_order_value: "25",
        max_daily_value: "100",
        min_order_value: "1",
        max_fee_drops: "20",
        max_slippage_bps: 100,
        max_price_impact_bps: 100,
        min_xrp_reserve_drops: "12000000",
        fee_buffer_drops: "1000000",
        max_xrp_exposure_drops: "1000000000",
        max_issued_exposure: "1000",
        min_liquidity_value: "50",
        cooldown_seconds: 300,
        max_quote_age_seconds: 20,
        max_ledger_gap: 1,
      },
      schedule: { interval_seconds: 300, next_evaluation_at: "2026-10-22T00:05:00.000Z" },
      execution_mode: "offer_create_fok",
      not_before: CREATED_AT,
      expires_at: EXPIRES_AT,
      ...(approved ? {
        authorization: {
          authorization_id: account === ACCOUNT_A ? "authorization:fixture-a" : "authorization:fixture-b",
          method: "wallet_action_proof_v1",
          owner: account,
          mandate_digest: digest,
          mandate_version: 1,
          approved_at: "2026-10-22T00:00:30.000Z",
          expires_at: EXPIRES_AT,
        },
      } : {}),
    },
  };
}

function eventFor(strategy: Strategy, kind: StrategyAuditEvent["kind"], suffix: string): StrategyAuditEvent {
  return {
    event_id: `event:${suffix}`,
    strategy_id: strategy.strategy_id,
    actor: "owner",
    kind,
    detail: kind === "paused" ? { reason: "Paused by owner" } : kind === "kill_enabled" ? { reason: "Killed by owner" } : {},
    at: `2026-10-22T00:0${Math.min(strategy.generation, 9)}:00.000Z`,
  };
}

function envelope(data: unknown) {
  return {
    ok: true,
    data,
    asOf: "2026-10-22T00:10:00.000Z",
    asOfBasis: "offline strategy fixture",
  };
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await testInfo.attach(name, {
    body: await page.screenshot({ animations: "disabled", fullPage: true }),
    contentType: "image/png",
  });
}

function proofTransaction(account: string, action: "activate" | "resume" | "clear_global_kill", requestId: string): Record<string, unknown> {
  return {
    TransactionType: "AccountSet",
    Account: account,
    Sequence: 0,
    Fee: "0",
    LastLedgerSequence: 0,
    Memos: [{ Memo: {
      MemoType: STRATEGY_MEMO_TYPE,
      MemoData: Buffer.from(`fixture:${action}:${requestId}`, "utf8").toString("hex").toUpperCase(),
    } }],
  };
}

async function installSyntheticGemWallet(page: Page, account: string): Promise<void> {
  await page.addInitScript(({ account, memoType }) => {
    type WalletCalls = { errors: string[]; messages: string[]; signedTransactions: Record<string, unknown>[]; submitted: number };
    const fixtureWindow = window as typeof window & { gemWallet?: boolean; __strategyFixtureWallet?: WalletCalls };
    fixtureWindow.gemWallet = true;
    fixtureWindow.__strategyFixtureWallet = { errors: [], messages: [], signedTransactions: [], submitted: 0 };
    sessionStorage.setItem("pilot:wallet", JSON.stringify({ provider: "gemwallet", network: "testnet", account }));
    window.addEventListener("message", (event) => {
      const request = event.data as { source?: unknown; messageId?: unknown; type?: unknown; payload?: { transaction?: unknown } } | undefined;
      if (event.source !== window || request?.source !== "GEM_WALLET_MSG_REQUEST" || typeof request.messageId !== "number" || typeof request.type !== "string") return;
      const calls = fixtureWindow.__strategyFixtureWallet!;
      calls.messages.push(request.type);
      let result: Record<string, unknown> | undefined;
      if (request.type === "REQUEST_IS_INSTALLED/V3") {
        result = { isInstalled: true };
      } else if (request.type === "REQUEST_GET_PUBLIC_KEY/V3") {
        result = { address: account, publicKey: `ED${"A".repeat(64)}` };
      } else if (request.type === "REQUEST_GET_NETWORK/V3") {
        result = { chain: "XRPL", network: "Testnet", websocket: "wss://fixture.invalid" };
      } else if (request.type === "REQUEST_SIGN_TRANSACTION/V3") {
        const transaction = request.payload?.transaction;
        const candidate = transaction && typeof transaction === "object" && !Array.isArray(transaction)
          ? transaction as Record<string, unknown> : undefined;
        const topKeys = candidate ? Object.keys(candidate).sort() : [];
        const memos = candidate?.Memos;
        const memo = Array.isArray(memos) && memos.length === 1 && memos[0] && typeof memos[0] === "object"
          ? (memos[0] as { Memo?: unknown }).Memo : undefined;
        const memoRecord = memo && typeof memo === "object" && !Array.isArray(memo) ? memo as Record<string, unknown> : undefined;
        const valid = JSON.stringify(topKeys) === JSON.stringify(["Account", "Fee", "LastLedgerSequence", "Memos", "Sequence", "TransactionType"].sort()) &&
          candidate?.TransactionType === "AccountSet" && candidate.Account === account && candidate.Sequence === 0 &&
          candidate.Fee === "0" && candidate.LastLedgerSequence === 0 &&
          JSON.stringify(Object.keys(memoRecord ?? {}).sort()) === JSON.stringify(["MemoData", "MemoType"].sort()) &&
          memoRecord?.MemoType === memoType && typeof memoRecord.MemoData === "string";
        if (!valid || !candidate) {
          calls.errors.push("Synthetic wallet refused a non-canonical strategy proof transaction.");
        } else {
          calls.signedTransactions.push(structuredClone(candidate));
          const signatures = ["A1", "B2", "C3"];
          result = { signature: (signatures[calls.signedTransactions.length - 1] ?? "D4").repeat(16) };
        }
      } else {
        if (request.type.includes("SUBMIT")) calls.submitted += 1;
        calls.errors.push(`Unexpected synthetic wallet request: ${request.type}`);
      }
      window.postMessage({
        source: "GEM_WALLET_MSG_RESPONSE",
        messagedId: request.messageId,
        ...(result ? { result } : { error: { name: "Error", message: calls.errors.at(-1) ?? "Synthetic wallet rejected the request." } }),
      }, window.location.origin);
    });
  }, { account, memoType: STRATEGY_MEMO_TYPE });
}

async function installHarness(page: Page, baseURL: string, harness: Harness): Promise<void> {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== baseURL) {
      harness.externalRequests.push(route.request().url());
      await route.abort("blockedbyclient");
      return;
    }
    await route.fallback();
  });
  await page.route("**/api/config/public", async (route) => {
    await route.fulfill({ json: {
      network: "testnet",
      stableAsset: { currency: "RLUSD", issuer: ISSUER },
      devSignerEnabled: false,
      walletActionProofRequired: false,
      walletActionProofConfigured: false,
      mockMode: true,
    } });
  });
  await page.route("**/api/auth/wallet/session", async (route) => {
    await route.fulfill({ json: harness.sessionAccount ? {
      authenticated: true,
      account: harness.sessionAccount,
      network: "testnet",
      expiresAt: Date.now() + 60_000,
    } : { authenticated: false } });
  });
  await page.route("**/api/auth/wallet/strategy-challenge", async (route) => {
    harness.challengeRequests += 1;
    const body = route.request().postDataJSON() as Record<string, unknown>;
    harness.challengeBodies.push(body);
    if (!harness.walletAuthorizationEnabled || !harness.sessionAccount) {
      await route.fulfill({ status: 500, json: { error: "A fixture must never reach wallet authorization without the synthetic wallet boundary." } });
      return;
    }
    const current = harness.strategies.get(harness.sessionAccount);
    const expectedKeys = ["action", "mandate_digest", "mandate_expires_at", "mandate_version", "request_id", "strategy_id"].sort();
    const action = body.action;
    const valid = current && (action === "activate" || action === "resume" || action === "clear_global_kill") &&
      JSON.stringify(Object.keys(body).sort()) === JSON.stringify(expectedKeys) &&
      body.strategy_id === current.strategy_id && body.mandate_version === current.mandate.version &&
      body.mandate_digest === current.mandate.digest && body.mandate_expires_at === current.mandate.expires_at &&
      typeof body.request_id === "string" && body.request_id.length > 0;
    if (!valid || !current) {
      harness.authorizationFailures.push("Challenge request did not exactly match the current owner-scoped mandate.");
      await route.fulfill({ status: 400, json: { error: harness.authorizationFailures.at(-1) } });
      return;
    }
    const txJson = proofTransaction(harness.sessionAccount, action, body.request_id as string);
    harness.challengeTransactions.push(txJson);
    await route.fulfill({ json: {
      account: harness.sessionAccount,
      network: "testnet",
      mandate_version: current.mandate.version,
      mandate_digest: current.mandate.digest,
      mandate_expires_at: current.mandate.expires_at,
      request_id: body.request_id,
      challenge_token: `fixture-token:${action}:${body.request_id}`,
      tx_json: txJson,
    } });
  });
  await page.route("**/api/strategy/*", async (route) => {
    const action = new URL(route.request().url()).pathname.split("/").at(-1) ?? "";
    harness.actions.push(action);
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (["create", "activate", "pause", "resume", "stop", "kill", "global-kill-enable", "global-kill-clear"].includes(action)) {
      harness.mutationBodies.push({ action, ...body });
    }
    const account = harness.sessionAccount;
    const current = account ? harness.strategies.get(account) : undefined;
    const currentKill = account ? harness.globalKills.get(account) ?? { enabled: true, reason: "Fixture starts fail closed", updated_at: CREATED_AT } : undefined;
    if (action === "global-kill-get" && account && currentKill) {
      harness.globalKills.set(account, currentKill);
      await route.fulfill({ json: envelope({ owner: account, network: "testnet", kill_switch: currentKill }) });
      return;
    }
    if (action === "global-kill-enable" && account) {
      const next = { enabled: true, reason: String(body.reason), updated_at: "2026-10-22T00:11:00.000Z" } satisfies StrategyKillSwitch;
      harness.globalKills.set(account, next);
      await route.fulfill({ json: envelope({ owner: account, network: "testnet", kill_switch: next }) });
      return;
    }
    if (action === "global-kill-clear" && account && current) {
      const matchingChallenge = harness.challengeBodies.find((candidate) => candidate.action === "clear_global_kill" && candidate.request_id === body.request_id);
      const proofKeys = ["challenge_token", "mandate_digest", "mandate_expires_at", "mandate_version", "request_id", "strategy_id", "tx_blob"].sort();
      const valid = matchingChallenge && JSON.stringify(Object.keys(body).sort()) === JSON.stringify(proofKeys) &&
        body.strategy_id === current.strategy_id && body.mandate_version === current.mandate.version &&
        body.mandate_digest === current.mandate.digest && body.mandate_expires_at === current.mandate.expires_at &&
        body.challenge_token === `fixture-token:clear_global_kill:${body.request_id}` && body.tx_blob === "A1".repeat(16);
      if (!valid) {
        harness.authorizationFailures.push("global kill proof did not exactly reuse its owner-scoped challenge bindings.");
        await route.fulfill({ status: 400, json: { error: { message: harness.authorizationFailures.at(-1) } } });
        return;
      }
      if (harness.unknownGlobalClear) {
        harness.unknownRequestId = typeof body.request_id === "string" ? body.request_id : undefined;
        await route.fulfill({ status: 502, json: { error: { message: "Fixture withheld the global kill outcome.", code: "STRATEGY_UPSTREAM_OUTCOME_UNKNOWN", request_id: harness.unknownRequestId } } });
        return;
      }
      const next = { enabled: false, reason: "Cleared by synthetic owner proof", updated_at: "2026-10-22T00:12:00.000Z" } satisfies StrategyKillSwitch;
      harness.globalKills.set(account, next);
      await route.fulfill({ json: envelope({ owner: account, network: "testnet", kill_switch: next }) });
      return;
    }
    if (action === "list") {
      await route.fulfill({ json: envelope(current ? [current] : []) });
      return;
    }
    if (action === "audit") {
      await route.fulfill({ json: envelope(current ? (harness.audit.get(current.strategy_id) ?? []) : []) });
      return;
    }
    if (action === "create" && account) {
      const next = strategyFor(account, "draft");
      const requestedExpiry = typeof body.expires_at === "string" ? body.expires_at : EXPIRES_AT;
      const created = { ...next, mandate: { ...next.mandate, expires_at: requestedExpiry } };
      harness.strategies.set(account, created);
      harness.audit.set(created.strategy_id, [eventFor(created, "created", `created-${account.slice(-4)}`)]);
      await route.fulfill({ json: envelope(created) });
      return;
    }
    if ((action === "activate" || action === "resume") && current && account) {
      const matchingChallenge = harness.challengeBodies.find((candidate) => candidate.action === action && candidate.request_id === body.request_id);
      const proofKeys = ["challenge_token", "mandate_digest", "mandate_expires_at", "mandate_version", "request_id", "strategy_id", "tx_blob"].sort();
      const matchingChallengeIndex = harness.challengeBodies.indexOf(matchingChallenge!);
      const expectedBlob = (["A1", "B2", "C3"][matchingChallengeIndex] ?? "D4").repeat(16);
      const valid = matchingChallenge && JSON.stringify(Object.keys(body).sort()) === JSON.stringify(proofKeys) &&
        body.strategy_id === current.strategy_id && body.mandate_version === current.mandate.version &&
        body.mandate_digest === current.mandate.digest && body.mandate_expires_at === current.mandate.expires_at &&
        body.challenge_token === `fixture-token:${action}:${body.request_id}` && body.tx_blob === expectedBlob;
      if (!valid) {
        harness.authorizationFailures.push(`${action} proof did not exactly reuse its owner-scoped challenge bindings.`);
        await route.fulfill({ status: 400, json: { error: { message: harness.authorizationFailures.at(-1) } } });
        return;
      }
      const next = strategyFor(account, "active", current.generation + 1);
      harness.strategies.set(account, next);
      const kind = action === "activate" ? "activated" : "resumed";
      harness.audit.set(next.strategy_id, [...(harness.audit.get(next.strategy_id) ?? []), eventFor(next, kind, `${action}-${next.generation}`)]);
      await route.fulfill({ json: envelope(next) });
      return;
    }
    if (action === "pause" && current) {
      if (harness.unknownPause) {
        harness.unknownRequestId = typeof body.request_id === "string" ? body.request_id : undefined;
        await route.fulfill({
          status: 502,
          json: { error: {
            message: "The offline fixture intentionally withheld the durable outcome.",
            code: "STRATEGY_UPSTREAM_OUTCOME_UNKNOWN",
            request_id: harness.unknownRequestId,
          } },
        });
        return;
      }
      const next = strategyFor(account!, "paused", current.generation + 1);
      harness.strategies.set(account!, next);
      harness.audit.set(next.strategy_id, [...(harness.audit.get(next.strategy_id) ?? []), eventFor(next, "paused", `paused-${next.generation}`)]);
      await route.fulfill({ json: envelope(next) });
      return;
    }
    if (action === "kill" && current) {
      const next = strategyFor(account!, "stopped", current.generation + 1);
      harness.strategies.set(account!, next);
      harness.audit.set(next.strategy_id, [...(harness.audit.get(next.strategy_id) ?? []), eventFor(next, "kill_enabled", `killed-${next.generation}`)]);
      await route.fulfill({ json: envelope(next) });
      return;
    }
    await route.fulfill({ status: 500, json: { error: { message: `Unexpected fixture action: ${action}` } } });
  });
}

function createHarness(sessionAccount?: string): Harness {
  return {
    sessionAccount,
    strategies: new Map(),
    globalKills: new Map(),
    audit: new Map(),
    actions: [],
    mutationBodies: [],
    externalRequests: [],
    challengeRequests: 0,
    challengeBodies: [],
    challengeTransactions: [],
    authorizationFailures: [],
    walletAuthorizationEnabled: false,
    unknownPause: false,
    unknownGlobalClear: false,
  };
}

test.describe.configure({ mode: "serial" });

test("strategy offers a non-authorizing simulation without an authenticated Testnet owner", async ({ page, lane, evidence }, testInfo) => {
  requireLane(lane, "fixture");
  const harness = createHarness();
  await installHarness(page, lane.baseURL, harness);

  await page.goto("/strategy");
  await expect(page.getByRole("heading", { name: "Set the rules once. Pilot trades inside them." })).toBeVisible();
  await expect(page.getByText(/illustrative simulation.*client only/i)).toBeVisible();
  await expect(page.getByText(/client-only simulation never connects a wallet.*grants a mandate/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Review immutable mandate" })).toHaveCount(0);
  expect(harness.mutationBodies).toEqual([]);
  expect(harness.externalRequests).toEqual([]);
  evidence.record("strategy-signed-out-demo", { authenticated: false, mutationRequests: 0, externalRequests: 0 });
  await attachScreenshot(page, testInfo, "strategy-signed-out-demo-desktop");
});

test("same-page wallet changes isolate and reset signed-out simulation state", async ({ page, lane, evidence }) => {
  requireLane(lane, "fixture");
  const harness = createHarness();
  await installHarness(page, lane.baseURL, harness);

  await page.goto("/strategy");
  const decision = page.getByRole("status", { name: /^decision:/i });
  await page.getByRole("button", { name: "Next event" }).click();
  await expect(decision).toContainText(/trade/i);

  const activeA = strategyFor(ACCOUNT_A, "active", 2);
  harness.strategies.set(ACCOUNT_A, activeA);
  harness.audit.set(activeA.strategy_id, [eventFor(activeA, "activated", "same-page-a")]);
  harness.sessionAccount = ACCOUNT_A;
  await page.evaluate(() => window.dispatchEvent(new Event("pilot:wallet-session-changed")));
  await expect(page.getByRole("heading", { name: "Set the rules once. Pilot trades inside them." })).toHaveCount(0);
  await expect(page.locator('[role="status"][aria-live="polite"]')).toContainText("active");

  harness.sessionAccount = undefined;
  await page.evaluate(() => window.dispatchEvent(new Event("pilot:wallet-session-changed")));
  await expect(page.getByRole("heading", { name: "Set the rules once. Pilot trades inside them." })).toBeVisible();
  await expect(page.getByRole("status", { name: /^decision:/i })).toContainText(/hold/i);
  await expect(page.getByText("1 / 7", { exact: true })).toBeVisible();
  expect(harness.mutationBodies).toEqual([]);
  expect(harness.externalRequests).toEqual([]);
  evidence.record("strategy-same-page-demo-isolation", { demoResetAfterAccountChange: true, mutationRequests: 0 });
});

test("actual form rejects invalid limits and creates only a non-authorizing immutable draft", async ({ page, lane, evidence }, testInfo) => {
  requireLane(lane, "fixture");
  const harness = createHarness(ACCOUNT_A);
  await installHarness(page, lane.baseURL, harness);

  await page.goto("/strategy");
  await expect(page.getByRole("heading", { name: "Create a strategy draft" })).toBeVisible();
  await expect(page.getByText(ACCOUNT_A, { exact: true })).toBeVisible();
  await page.locator('input[name="maxOrderValue"]').fill("101");
  await page.locator('input[name="mandateExpiresAt"]').fill("2035-10-22T12:00");
  await page.getByRole("button", { name: "Review immutable mandate" }).click();
  await expect(page.getByText("Maximum order cannot exceed the daily cap.")).toBeVisible();
  expect(harness.mutationBodies).toEqual([]);

  await page.locator('input[name="maxOrderValue"]').fill("25");
  await page.getByRole("button", { name: "Review immutable mandate" }).click();
  await expect(page.getByRole("heading", { name: "Approve immutable strategy authority" })).toBeVisible();
  await expect(page.getByText(DIGEST_A, { exact: true })).toBeVisible();
  const create = harness.mutationBodies.find((entry) => entry.action === "create");
  expect(create).toMatchObject({
    action: "create",
    kind: "xrp_issued_rebalancer_v1",
    issued_asset: { currency: CURRENCY, issuer: ISSUER },
    allocation: { target_xrp_bps: 5000, lower_xrp_bps: 4500, upper_xrp_bps: 5500 },
    interval_seconds: 300,
    execution_mode: "offer_create_fok",
  });
  expect(harness.externalRequests).toEqual([]);
  evidence.record("strategy-draft-browser", { invalidCreateRequests: 0, finalCreateRequests: 1, lifecycle: "draft", account: ACCOUNT_A });
  await attachScreenshot(page, testInfo, "strategy-draft-review-desktop");
  await page.setViewportSize({ width: 375, height: 812 });
  await attachScreenshot(page, testInfo, "strategy-draft-review-mobile");
});

test("missing wallet authorization fails closed before activation and resume", async ({ page, lane, evidence }, testInfo) => {
  requireLane(lane, "fixture");
  const harness = createHarness(ACCOUNT_A);
  const draft = strategyFor(ACCOUNT_A, "draft");
  harness.strategies.set(ACCOUNT_A, draft);
  harness.globalKills.set(ACCOUNT_A, { enabled: false, updated_at: CREATED_AT });
  harness.audit.set(draft.strategy_id, [eventFor(draft, "created", "draft-auth")]);
  await installHarness(page, lane.baseURL, harness);

  await page.goto("/strategy");
  await page.getByRole("button", { name: "Approve and activate this mandate" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Reconnect the exact wallet used for this Pilot session before signing." })).toBeVisible();
  expect(harness.challengeRequests).toBe(0);
  expect(harness.mutationBodies.filter((entry) => entry.action === "activate")).toEqual([]);

  const paused = strategyFor(ACCOUNT_A, "paused", 2);
  harness.strategies.set(ACCOUNT_A, paused);
  harness.audit.set(paused.strategy_id, [eventFor(paused, "paused", "paused-auth")]);
  await page.reload();
  await page.getByRole("button", { name: "Revalidate and resume" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Reconnect the exact wallet used for this Pilot session before signing." })).toBeVisible();
  expect(harness.challengeRequests).toBe(0);
  expect(harness.mutationBodies.filter((entry) => entry.action === "resume")).toEqual([]);
  expect(harness.externalRequests).toEqual([]);
  evidence.record("strategy-wallet-proof-fail-closed", { challengeRequests: 0, activateRequests: 0, resumeRequests: 0 });
  await attachScreenshot(page, testInfo, "strategy-missing-authorization");
});

test("synthetic sign-only wiring activates and resumes only the exact immutable mandate", async ({ page, lane, evidence }, testInfo) => {
  requireLane(lane, "fixture");
  expect(lane.authority).toBe("none");
  expect(lane.maySignOrFund).toBe(false);
  const harness = createHarness(ACCOUNT_A);
  harness.walletAuthorizationEnabled = true;
  const draft = strategyFor(ACCOUNT_A, "draft");
  harness.strategies.set(ACCOUNT_A, draft);
  harness.audit.set(draft.strategy_id, [eventFor(draft, "created", "draft-synthetic-auth")]);
  await installSyntheticGemWallet(page, ACCOUNT_A);
  await installHarness(page, lane.baseURL, harness);

  await page.goto("/strategy");
  await expect(page.getByRole("button", { name: "Global kill must be cleared first" })).toBeDisabled();
  await page.getByRole("button", { name: "Authorize autonomous submissions…" }).click();
  await expect(page.getByRole("dialog", { name: "Authorize autonomous submissions?" })).toContainText("does not create a strategy, expand its limits, or authorize another account");
  await attachScreenshot(page, testInfo, "strategy-global-kill-clear-confirmation");
  await page.getByRole("button", { name: "Continue to wallet proof" }).click();
  await expect(page.getByText("cleared", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve and activate this mandate" })).toBeEnabled();
  await page.getByRole("button", { name: "Approve and activate this mandate" }).click();
  await expect(page.locator('[role="status"][aria-live="polite"]')).toContainText("active");
  await page.getByRole("button", { name: "Pause new evaluations" }).click();
  await expect(page.locator('[role="status"][aria-live="polite"]')).toContainText("paused");
  await page.getByRole("button", { name: "Revalidate and resume" }).click();
  await expect(page.locator('[role="status"][aria-live="polite"]')).toContainText("active");
  await page.getByRole("button", { name: "Enable global kill…" }).click();
  await expect(page.getByRole("dialog", { name: "Enable account-wide global kill?" })).toContainText("does not cancel or hide any submitted or unresolved transaction");
  await page.getByRole("button", { name: "Confirm · block new submissions" }).click();
  await expect(page.getByText("enabled", { exact: true })).toBeVisible();

  expect(harness.challengeRequests).toBe(3);
  expect(harness.challengeBodies.map((body) => body.action)).toEqual(["clear_global_kill", "activate", "resume"]);
  const [clearChallenge, activateChallenge, resumeChallenge] = harness.challengeBodies;
  const challengeKeys = ["action", "mandate_digest", "mandate_expires_at", "mandate_version", "request_id", "strategy_id"].sort();
  for (const challenge of harness.challengeBodies) {
    expect(Object.keys(challenge).sort()).toEqual(challengeKeys);
    expect(challenge).toMatchObject({
      strategy_id: draft.strategy_id,
      mandate_version: draft.mandate.version,
      mandate_digest: draft.mandate.digest,
      mandate_expires_at: draft.mandate.expires_at,
    });
  }
  expect(clearChallenge.request_id).not.toBe(activateChallenge.request_id);
  expect(activateChallenge.request_id).not.toBe(resumeChallenge.request_id);

  const proofs = harness.mutationBodies.filter((body) => body.action === "activate" || body.action === "resume");
  expect(proofs).toHaveLength(2);
  const proofKeys = ["action", "challenge_token", "mandate_digest", "mandate_expires_at", "mandate_version", "request_id", "strategy_id", "tx_blob"].sort();
  for (const proof of proofs) expect(Object.keys(proof).sort()).toEqual(proofKeys);
  expect(proofs[0]).toMatchObject({
    action: "activate",
    request_id: activateChallenge.request_id,
    challenge_token: `fixture-token:activate:${activateChallenge.request_id}`,
    tx_blob: "B2".repeat(16),
  });
  expect(proofs[1]).toMatchObject({
    action: "resume",
    request_id: resumeChallenge.request_id,
    challenge_token: `fixture-token:resume:${resumeChallenge.request_id}`,
    tx_blob: "C3".repeat(16),
  });
  expect(proofs[0].challenge_token).not.toBe(proofs[1].challenge_token);
  expect(proofs[0].tx_blob).not.toBe(proofs[1].tx_blob);

  const walletCalls = await page.evaluate(() => {
    const fixtureWindow = window as typeof window & { __strategyFixtureWallet?: { errors: string[]; messages: string[]; signedTransactions: Record<string, unknown>[]; submitted: number } };
    return structuredClone(fixtureWindow.__strategyFixtureWallet);
  });
  expect(walletCalls?.errors).toEqual([]);
  expect(walletCalls?.submitted).toBe(0);
  expect(walletCalls?.messages.filter((message) => message === "REQUEST_SIGN_TRANSACTION/V3")).toHaveLength(3);
  expect(walletCalls?.messages.some((message) => message.includes("SUBMIT"))).toBe(false);
  expect(walletCalls?.signedTransactions).toEqual(harness.challengeTransactions);
  expect(harness.authorizationFailures).toEqual([]);
  expect(harness.externalRequests).toEqual([]);
  expect(harness.mutationBodies.filter((body) => body.action === "global-kill-enable")).toHaveLength(1);
  evidence.record("strategy-synthetic-sign-only-wiring", {
    authority: "none",
    realSignature: false,
    freshChallenges: 3,
    syntheticSignOnlyCalls: 3,
    submitCalls: 0,
    finalLifecycle: "active",
    finalGlobalKill: "enabled",
  });
  await attachScreenshot(page, testInfo, "strategy-synthetic-authorized-active");
});

test("unknown global-kill clear stays fail closed until a durable owner-scoped read reconciles it", async ({ page, lane, evidence }, testInfo) => {
  requireLane(lane, "fixture");
  const harness = createHarness(ACCOUNT_A);
  harness.walletAuthorizationEnabled = true;
  harness.unknownGlobalClear = true;
  const active = strategyFor(ACCOUNT_A, "active", 2);
  harness.strategies.set(ACCOUNT_A, active);
  harness.audit.set(active.strategy_id, [eventFor(active, "activated", "active-unknown-global")]);
  await installSyntheticGemWallet(page, ACCOUNT_A);
  await installHarness(page, lane.baseURL, harness);

  await page.goto("/strategy");
  await page.getByRole("button", { name: "Authorize autonomous submissions…" }).click();
  await page.getByRole("button", { name: "Continue to wallet proof" }).click();
  const alert = page.getByRole("alert").filter({ hasText: "Global kill outcome unknown" });
  await expect(alert).toBeVisible();
  await expect(page.getByRole("button", { name: "Authorize autonomous submissions…" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Pause new evaluations" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Stop this mandate version" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Emergency kill this strategy" })).toBeEnabled();
  expect(await page.evaluate((account) => sessionStorage.getItem(`pilot:strategy:global-kill-pending:${account}`), ACCOUNT_A)).toContain(harness.unknownRequestId!);
  await attachScreenshot(page, testInfo, "strategy-global-kill-unknown-outcome");

  const draftB = strategyFor(ACCOUNT_B, "draft");
  harness.strategies.set(ACCOUNT_B, draftB);
  harness.audit.set(draftB.strategy_id, [eventFor(draftB, "created", "global-account-b")]);
  harness.sessionAccount = ACCOUNT_B;
  await page.reload();
  await expect(page.getByText(ACCOUNT_B, { exact: true })).toBeVisible();
  await expect(page.getByText(harness.unknownRequestId!, { exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Authorize autonomous submissions…" })).toBeEnabled();
  expect(await page.evaluate((account) => sessionStorage.getItem(`pilot:strategy:global-kill-pending:${account}`), ACCOUNT_A)).toContain(harness.unknownRequestId!);
  expect(await page.evaluate((account) => sessionStorage.getItem(`pilot:strategy:global-kill-pending:${account}`), ACCOUNT_B)).toBeNull();

  harness.unknownGlobalClear = false;
  harness.sessionAccount = ACCOUNT_A;
  await page.reload();
  await expect(page.getByText("enabled", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Authorize autonomous submissions…" })).toBeEnabled();
  expect(await page.evaluate((account) => sessionStorage.getItem(`pilot:strategy:global-kill-pending:${account}`), ACCOUNT_A)).toBeNull();
  expect(harness.mutationBodies.filter((body) => body.action === "global-kill-clear")).toHaveLength(1);
  expect(harness.externalRequests).toEqual([]);
  evidence.record("strategy-global-kill-unknown-reconciliation", { replacementMutationSent: false, retainedRequestId: true, accountBPendingApplied: false, reconciledByOwnerScopedRead: true, finalGlobalKill: "enabled" });
});

test("owner controls pause and kill while preserving honest in-flight semantics", async ({ page, lane, evidence }, testInfo) => {
  requireLane(lane, "fixture");
  const harness = createHarness(ACCOUNT_A);
  const active = strategyFor(ACCOUNT_A, "active", 2);
  harness.strategies.set(ACCOUNT_A, active);
  harness.audit.set(active.strategy_id, [eventFor(active, "activated", "active-controls")]);
  await installHarness(page, lane.baseURL, harness);

  await page.goto("/strategy");
  await expect(page.locator('[role="status"][aria-live="polite"]')).toContainText("active");
  await expect(page.getByText(/existing or uncertain ledger submission cannot be cancelled here/i)).toBeVisible();
  await attachScreenshot(page, testInfo, "strategy-active-controls");

  await page.getByRole("button", { name: "Pause new evaluations" }).click();
  await expect(page.locator('[role="status"][aria-live="polite"]')).toContainText("paused");
  await expect(page.getByRole("button", { name: "Revalidate and resume" })).toBeVisible();
  await page.getByRole("button", { name: "Emergency kill this strategy" }).click();
  await expect(page.getByRole("dialog", { name: "Emergency kill this strategy?" })).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("does not cancel, hide, or release any transaction whose outcome is unresolved");
  await attachScreenshot(page, testInfo, "strategy-kill-confirmation");
  await page.getByRole("button", { name: "Confirm · stop new submissions" }).click();
  await expect(page.locator('[role="status"][aria-live="polite"]')).toContainText("stopped");
  expect(harness.mutationBodies.map((entry) => entry.action)).toEqual(["pause", "kill"]);
  expect(harness.externalRequests).toEqual([]);
  evidence.record("strategy-owner-controls", { pauseRequests: 1, killRequests: 1, finalLifecycle: "stopped", cancellationPromised: false });
});

test("unknown pause identity survives reload and is not applied to a different account", async ({ page, lane, evidence }, testInfo) => {
  requireLane(lane, "fixture");
  const harness = createHarness(ACCOUNT_A);
  const activeA = strategyFor(ACCOUNT_A, "active", 4);
  harness.strategies.set(ACCOUNT_A, activeA);
  harness.audit.set(activeA.strategy_id, [eventFor(activeA, "activated", "unknown-a")]);
  harness.unknownPause = true;
  await installHarness(page, lane.baseURL, harness);

  await page.goto("/strategy");
  await page.getByRole("button", { name: "Pause new evaluations" }).click();
  const unknownAlert = page.getByRole("alert").filter({ hasText: "Mutation outcome unknown" });
  await expect(unknownAlert).toBeVisible();
  expect(harness.unknownRequestId).toBeTruthy();
  await expect(unknownAlert).toContainText(harness.unknownRequestId!);
  await expect(page.getByRole("button", { name: "Emergency kill this strategy" })).toBeDisabled();
  await attachScreenshot(page, testInfo, "strategy-unknown-outcome-before-reload");

  await page.reload();
  const retainedAlert = page.getByRole("alert").filter({ hasText: "Mutation outcome remains unknown" });
  await expect(retainedAlert).toBeVisible();
  await expect(retainedAlert).toContainText(harness.unknownRequestId!);
  const retainedForA = await page.evaluate((account) => sessionStorage.getItem(`pilot:strategy:pending:${account}`), ACCOUNT_A);
  expect(retainedForA).toContain(harness.unknownRequestId!);

  const draftB = strategyFor(ACCOUNT_B, "draft");
  harness.strategies.set(ACCOUNT_B, draftB);
  harness.audit.set(draftB.strategy_id, [eventFor(draftB, "created", "account-b")]);
  harness.sessionAccount = ACCOUNT_B;
  await page.reload();
  await expect(page.getByRole("heading", { name: "Approve immutable strategy authority" })).toBeVisible();
  await expect(page.getByText(ACCOUNT_B, { exact: true })).toBeVisible();
  await expect(page.getByText(harness.unknownRequestId!, { exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Global kill must be cleared first" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Authorize autonomous submissions…" })).toBeEnabled();
  const retainedForAAfterSwitch = await page.evaluate((account) => sessionStorage.getItem(`pilot:strategy:pending:${account}`), ACCOUNT_A);
  expect(retainedForAAfterSwitch).toContain(harness.unknownRequestId!);
  const retainedForB = await page.evaluate((account) => sessionStorage.getItem(`pilot:strategy:pending:${account}`), ACCOUNT_B);
  expect(retainedForB).toBeNull();
  expect(harness.externalRequests).toEqual([]);
  evidence.record("strategy-unknown-outcome-isolation", { retainedAcrossReload: true, accountAPendingPreserved: true, accountBPendingApplied: false });
  await attachScreenshot(page, testInfo, "strategy-account-switch-isolation");
});
