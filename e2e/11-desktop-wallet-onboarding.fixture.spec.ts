import {
  devices,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";

import { expect, pilotRoutes, requireLane, test } from "./support";
import {
  createWalletOnboardingBoundary,
  installSyntheticCrossmark,
  installSyntheticGemWallet,
  installWalletOnboardingRoutes,
  readSyntheticCrossmarkCalls,
  readSyntheticGemWalletCalls,
  WALLET_FIXTURE_ACCOUNT,
} from "./support/wallet-onboarding-fixture";

const WALLET_FIXTURE_DELEGATE = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const WALLET_FIXTURE_PERMISSIONS = [
  "OfferCreate",
  "OfferCancel",
  "TrustSet",
  "AMMDeposit",
  "AMMWithdraw",
  "EscrowFinish",
  "CheckCash",
];

function activeRecoveryRecord(): string {
  return JSON.stringify({
    version: 1,
    provider: "gemwallet",
    account: WALLET_FIXTURE_ACCOUNT,
    main_account: WALLET_FIXTURE_ACCOUNT,
    budget_account: WALLET_FIXTURE_ACCOUNT,
    network: "testnet",
    delegate: WALLET_FIXTURE_DELEGATE,
    permissions: WALLET_FIXTURE_PERMISSIONS,
    model: "openai/gpt-oss-20b:free",
    aiMode: "demo",
    status: "active",
    txHash: "A".repeat(64),
  });
}

function pendingRecoveryRecord(): string {
  const lastLedgerSequence = 12_345;
  return JSON.stringify({
    version: 1,
    kind: "trust",
    hash: "B".repeat(64),
    account: WALLET_FIXTURE_ACCOUNT,
    network: "testnet",
    submissionRoute: "direct",
    lastLedgerSequence,
    expectedTx: {
      TransactionType: "TrustSet",
      Account: WALLET_FIXTURE_ACCOUNT,
      LastLedgerSequence: lastLedgerSequence,
    },
  });
}

async function tabUntilFocused(
  page: Page,
  target: Locator,
  maxTabs = 30,
): Promise<void> {
  for (let index = 0; index < maxTabs; index += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => document.activeElement === element)) return;
  }
  throw new Error(`Could not reach ${await target.getAttribute("aria-label") ?? await target.textContent() ?? "target"} by keyboard.`);
}

async function attachPageScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
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

test("desktop wallet guidance is ordered, official, keyboard reachable, and seed-free", async ({
  page,
  lane,
}, testInfo) => {
  requireLane(lane, "fixture");
  const boundary = createWalletOnboardingBoundary();
  await installWalletOnboardingRoutes(page, boundary, { baseURL: lane.baseURL });

  await page.setViewportSize({ width: 1_440, height: 900 });
  await page.goto(pilotRoutes.onboarding);

  await expect(page.getByRole("heading", { name: /^Connect your wallet$/i })).toBeVisible();
  const walletGuide = page.getByRole("region", { name: "Don’t have a wallet yet?" });
  await expect(walletGuide).toBeVisible();
  await expect(walletGuide.getByRole("heading", { name: "Don’t have a wallet yet?" })).toHaveCount(1);
  await expect(walletGuide.getByRole("note")).toContainText(/never asks for a seed phrase/i);

  const gemWallet = page.getByRole("button", { name: /GemWallet/i });
  const crossmark = page.getByRole("button", { name: /Crossmark/i });
  await expect(gemWallet).toBeVisible();
  await expect(crossmark).toBeVisible();
  const providerOrder = await page.getByRole("button").evaluateAll((buttons) =>
    buttons
      .map((button) => button.textContent?.replace(/\s+/g, " ").trim() ?? "")
      .filter((label) => /GemWallet|Crossmark/i.test(label)),
  );
  expect(providerOrder[0]).toMatch(/GemWallet/i);
  expect(providerOrder[1]).toMatch(/Crossmark/i);
  const gemSetup = page.getByRole("link", { name: /GemWallet setup/i });
  const crossmarkSetup = page.getByRole("link", { name: /Crossmark setup/i });
  await expect(gemSetup).toContainText(/Recommended/i);
  await expect(crossmarkSetup).toContainText(/Alternative/i);
  await expect(gemSetup).toHaveAttribute(
    "href",
    "https://gemwallet.app/docs/user-guide/getting-started",
  );
  await expect(crossmarkSetup).toHaveAttribute(
    "href",
    "https://support.crossmark.io/getting-started/get-started-with-crossmark",
  );
  await tabUntilFocused(page, gemSetup);
  await expect(gemSetup).toBeFocused();
  await tabUntilFocused(page, crossmarkSetup);
  await expect(crossmarkSetup).toBeFocused();
  expect(await page.locator([
    'input[name*="seed" i]',
    'input[name*="private" i]',
    'textarea[name*="seed" i]',
    'textarea[name*="private" i]',
  ].join(", ")).count()).toBe(0);

  await expect(page.getByRole("button", { name: /Xaman/i })).toHaveCount(0);
  await expect(page.getByText(/Xaman remains unavailable for this non-broadcast wallet-auth proof/i)).toBeVisible();
  await expect(page.getByRole("link", { name: /read-only Pilot/i })).toBeVisible();
  expect(boundary.modelRequests).toEqual([]);
  expect(boundary.tradingRequests).toEqual([]);
  expect(boundary.externalRequests).toEqual([]);
  await expect(crossmarkSetup).toBeFocused();
  await expect(crossmarkSetup).not.toHaveCSS("box-shadow", "none");
  await attachPageScreenshot(page, testInfo, "mock-provider-conformance-desktop-wallet-keyboard-focus");
  await attachPageScreenshot(page, testInfo, "mock-provider-conformance-desktop-wallet-guidance");
});

test("mobile context states the extension limitation and preserves read-only access", async ({
  browser,
  lane,
  evidence,
}, testInfo) => {
  requireLane(lane, "fixture");
  const { defaultBrowserType: _defaultBrowserType, ...iphone } = devices["iPhone 13"];
  const context = await browser.newContext(iphone);
  const mobilePage = await context.newPage();
  const boundary = createWalletOnboardingBoundary();
  await installWalletOnboardingRoutes(mobilePage, boundary, { baseURL: lane.baseURL });

  try {
    await mobilePage.goto(pilotRoutes.onboarding);
    await expect(mobilePage.getByText(/Connect your wallet from a computer/i)).toBeVisible();
    await expect(mobilePage.getByText(/Mobile wallet actions are not available yet/i)).toBeVisible();
    await expect(mobilePage.getByRole("button", { name: /Desktop wallet required/i })).toBeDisabled();
    await expect(mobilePage.getByRole("button", { name: /GemWallet/i })).toBeDisabled();
    await expect(mobilePage.getByRole("button", { name: /Crossmark/i })).toBeDisabled();
    await expect(mobilePage.getByRole("button", { name: /Xaman/i })).toHaveCount(0);
    await expect(mobilePage.getByRole("link", { name: /Look around Pilot/i })).toBeVisible();
    await expect(mobilePage.getByRole("link", { name: /Continue to read-only Pilot/i })).toBeVisible();
    const overflow = await mobilePage.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
    expect(boundary.modelRequests).toEqual([]);
    expect(boundary.tradingRequests).toEqual([]);
    expect(boundary.walletChallengeRequests).toEqual([]);
    expect(boundary.externalRequests).toEqual([]);
    await attachPageScreenshot(mobilePage, testInfo, "mock-provider-conformance-mobile-wallet-limitation");

    evidence.record("mobile-wallet-limitation-fixture", {
      evidenceKind: "mock-provider-conformance",
      realExtensionConnected: false,
      realWalletProof: false,
      walletCreated: false,
      providerCalled: false,
      ledgerTransaction: false,
      assertion: "The mobile browser offered read-only Pilot without claiming a supported wallet path.",
    });
  } finally {
    await context.close();
  }
});

test("server-rendered wallet controls fail closed before viewport resolution", async ({
  browser,
  lane,
}) => {
  requireLane(lane, "fixture");
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { height: 900, width: 1_440 },
  });
  const page = await context.newPage();

  try {
    await page.goto(pilotRoutes.onboarding);
    await expect(page.getByRole("button", { name: /Checking wallet availability/i })).toBeDisabled();
    await expect(page.getByRole("button", { name: /GemWallet/i })).toBeDisabled();
    await expect(page.getByRole("button", { name: /Crossmark/i })).toBeDisabled();
    await expect(page.getByRole("link", { name: /Exit setup/i })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("missing GemWallet fails before Pilot issues a wallet challenge", async ({ page, lane }) => {
  requireLane(lane, "fixture");
  const boundary = createWalletOnboardingBoundary();
  await installSyntheticGemWallet(page, { installed: false });
  await installWalletOnboardingRoutes(page, boundary, { baseURL: lane.baseURL });

  await page.goto(pilotRoutes.onboarding);
  await page.getByRole("button", { name: /GemWallet/i }).click();
  await page.getByRole("button", { name: /Find my wallet/i }).click();

  await expect(page.getByRole("alert").filter({
    hasText: /install|not installed|unavailable/i,
  }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /GemWallet setup/i })).toBeVisible();
  expect(boundary.walletChallengeRequests).toEqual([]);
  expect(boundary.modelRequests).toEqual([]);
  expect(boundary.tradingRequests).toEqual([]);
});

test("a Mainnet GemWallet fails closed before Pilot issues a Testnet challenge", async ({
  page,
  lane,
}) => {
  requireLane(lane, "fixture");
  const boundary = createWalletOnboardingBoundary();
  await installSyntheticGemWallet(page, { network: "Mainnet" });
  await installWalletOnboardingRoutes(page, boundary, { baseURL: lane.baseURL });

  await page.goto(pilotRoutes.onboarding);
  await page.getByRole("button", { name: /GemWallet/i }).click();
  await page.getByRole("button", { name: /Find my wallet/i }).click();
  await page.getByRole("button", { name: /Connect account/i }).click();

  await expect(page.getByRole("alert").filter({
    hasText: /different or unsupported XRPL network|network mismatch|switch.*Testnet/i,
  }).first()).toBeVisible();
  expect(boundary.walletChallengeRequests).toEqual([]);
  expect(boundary.modelRequests).toEqual([]);
  expect(boundary.tradingRequests).toEqual([]);
});

test("a rejected GemWallet connection stays before every Pilot authority boundary", async ({
  page,
  lane,
}) => {
  requireLane(lane, "fixture");
  const boundary = createWalletOnboardingBoundary();
  await installSyntheticGemWallet(page, { connectOutcomes: ["rejected"] });
  await installWalletOnboardingRoutes(page, boundary, { baseURL: lane.baseURL });

  await page.goto(pilotRoutes.onboarding);
  await page.getByRole("button", { name: /GemWallet/i }).click();
  await page.getByRole("button", { name: /Find my wallet/i }).click();
  await page.getByRole("button", { name: /Connect account/i }).click();

  await expect(page.getByRole("alert").filter({
    hasText: /connection.*rejected|cancelled|canceled/i,
  }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Connect account/i })).toBeVisible();
  expect(boundary.walletChallengeRequests).toEqual([]);
  expect(boundary.walletSessionMethods.filter((method) => method === "POST")).toEqual([]);
  expect(boundary.modelRequests).toEqual([]);
  expect(boundary.tradingRequests).toEqual([]);
});

test("a rejected GemWallet authentication proof stays unauthenticated and retries explicitly", async ({
  page,
  lane,
}) => {
  requireLane(lane, "fixture");
  const boundary = createWalletOnboardingBoundary();
  await installSyntheticGemWallet(page, { proofOutcomes: ["rejected", "success"] });
  await installWalletOnboardingRoutes(page, boundary, { baseURL: lane.baseURL });

  await page.goto(pilotRoutes.onboarding);
  await page.getByRole("button", { name: /GemWallet/i }).click();
  await page.getByRole("button", { name: /Find my wallet/i }).click();
  await page.getByRole("button", { name: /Connect account/i }).click();
  await page.getByRole("button", { name: /Sign in with wallet/i }).click();

  await expect(page.getByRole("alert").filter({
    hasText: /signing.*rejected|cancelled|canceled/i,
  }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Sign in with wallet/i })).toBeVisible();
  expect(boundary.walletChallengeRequests).toEqual(["POST /api/auth/wallet/challenge"]);
  expect(boundary.walletSessionMethods.filter((method) => method === "POST")).toEqual([]);
  expect(boundary.modelRequests).toEqual([]);
  expect(boundary.tradingRequests).toEqual([]);

  await page.getByRole("button", { name: /Sign in with wallet/i }).click();
  await expect(page.getByRole("heading", { name: /Choose an AI model/i })).toBeVisible();
  expect(boundary.walletChallengeRequests).toEqual([
    "POST /api/auth/wallet/challenge",
    "POST /api/auth/wallet/challenge",
  ]);
  expect(boundary.walletSessionMethods.filter((method) => method === "POST")).toEqual(["POST"]);
});

test("missing Crossmark fails during the prompt-free availability check", async ({
  page,
  lane,
}) => {
  requireLane(lane, "fixture");
  const boundary = createWalletOnboardingBoundary();
  await installSyntheticCrossmark(page, { installed: false });
  await installWalletOnboardingRoutes(page, boundary, { baseURL: lane.baseURL });

  await page.goto(pilotRoutes.onboarding);
  await page.getByRole("button", { name: /Crossmark/i }).click();
  await page.getByRole("button", { name: /Find my wallet/i }).click();

  await expect(page.getByRole("alert").filter({
    hasText: /install|not installed|unavailable/i,
  }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /Crossmark setup/i })).toBeVisible();
  expect(await readSyntheticCrossmarkCalls(page)).toEqual([]);
  expect(boundary.walletChallengeRequests).toEqual([]);
  expect(boundary.modelRequests).toEqual([]);
  expect(boundary.tradingRequests).toEqual([]);
});

test("a Mainnet Crossmark account fails closed before Pilot issues a Testnet challenge", async ({
  page,
  lane,
}) => {
  requireLane(lane, "fixture");
  const boundary = createWalletOnboardingBoundary();
  await installSyntheticCrossmark(page, { network: "Mainnet" });
  await installWalletOnboardingRoutes(page, boundary, { baseURL: lane.baseURL });

  await page.goto(pilotRoutes.onboarding);
  await page.getByRole("button", { name: /Crossmark/i }).click();
  await page.getByRole("button", { name: /Find my wallet/i }).click();
  await page.getByRole("button", { name: /Connect account/i }).click();

  await expect(page.getByRole("alert").filter({
    hasText: /different or unsupported XRPL network|network mismatch|switch.*Testnet/i,
  }).first()).toBeVisible();
  const providerCalls = await readSyntheticCrossmarkCalls(page);
  expect(providerCalls).toContain("sign:SignIn");
  expect(providerCalls).toContain("network");
  expect(providerCalls).not.toContain("sign:AccountSet");
  expect(boundary.walletChallengeRequests).toEqual([]);
  expect(boundary.modelRequests).toEqual([]);
  expect(boundary.tradingRequests).toEqual([]);
});

test("a rejected Crossmark account connection stays before every Pilot authority boundary", async ({
    page,
    lane,
  }) => {
    requireLane(lane, "fixture");
    const boundary = createWalletOnboardingBoundary();
    await installSyntheticCrossmark(page, { connectOutcomes: ["rejected"] });
    await installWalletOnboardingRoutes(page, boundary, { baseURL: lane.baseURL });

    await page.goto(pilotRoutes.onboarding);
    await page.getByRole("button", { name: /Crossmark/i }).click();
    await page.getByRole("button", { name: /Find my wallet/i }).click();
    await page.getByRole("button", { name: /Connect account/i }).click();

    await expect(page.getByRole("alert").filter({
      hasText: /connection.*rejected|cancelled|canceled/i,
    }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Connect account/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Choose an AI model/i })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /You’re all set/i })).toHaveCount(0);
    expect(await readSyntheticCrossmarkCalls(page)).toContain("sign:SignIn");
    expect(await readSyntheticCrossmarkCalls(page)).not.toContain("sign:AccountSet");
    expect(boundary.walletChallengeRequests).toEqual([]);
    expect(boundary.walletSessionMethods.filter((method) => method === "POST")).toEqual([]);
    expect(boundary.modelRequests).toEqual([]);
    expect(boundary.demoSessionWrites).toEqual([]);
    expect(boundary.tradingRequests).toEqual([]);
    expect(await page.evaluate(() => sessionStorage.getItem("pilot:wallet"))).toBeNull();
  });

test("a rejected Crossmark authentication proof stays unauthenticated and retries explicitly", async ({
    page,
    lane,
  }) => {
    requireLane(lane, "fixture");
    const boundary = createWalletOnboardingBoundary();
    await installSyntheticCrossmark(page, { proofOutcomes: ["rejected", "success"] });
    await installWalletOnboardingRoutes(page, boundary, { baseURL: lane.baseURL });

    await page.goto(pilotRoutes.onboarding);
    await page.getByRole("button", { name: /Crossmark/i }).click();
    await page.getByRole("button", { name: /Find my wallet/i }).click();
    await page.getByRole("button", { name: /Connect account/i }).click();
    await page.getByRole("button", { name: /Sign in with wallet/i }).click();

    await expect(page.getByRole("alert").filter({
      hasText: /signing.*rejected|cancelled|canceled/i,
    }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Sign in with wallet/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Choose an AI model/i })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /You’re all set/i })).toHaveCount(0);
    expect(boundary.walletChallengeRequests).toEqual(["POST /api/auth/wallet/challenge"]);
    expect(boundary.walletSessionMethods.filter((method) => method === "POST")).toEqual([]);
    expect(boundary.modelRequests).toEqual([]);
    expect(boundary.demoSessionWrites).toEqual([]);
    expect(boundary.tradingRequests).toEqual([]);
    expect(await page.evaluate(() => sessionStorage.getItem("pilot:wallet"))).toBeNull();
    expect((await readSyntheticCrossmarkCalls(page)).filter(
      (call) => call === "sign:AccountSet",
    )).toHaveLength(1);

    await page.getByRole("button", { name: /Sign in with wallet/i }).click();
    await expect(page.getByRole("heading", { name: /Choose an AI model/i })).toBeVisible();
    expect(boundary.walletChallengeRequests).toEqual([
      "POST /api/auth/wallet/challenge",
      "POST /api/auth/wallet/challenge",
    ]);
    expect(boundary.walletSessionMethods.filter((method) => method === "POST")).toEqual(["POST"]);
    expect((await readSyntheticCrossmarkCalls(page)).filter(
      (call) => call === "sign:AccountSet",
    )).toHaveLength(2);
    expect(boundary.tradingRequests).toEqual([]);
  });

test("reloading during an in-flight Crossmark proof creates no wallet or model authority", async ({
  page,
  lane,
}) => {
  requireLane(lane, "fixture");
  const boundary = createWalletOnboardingBoundary();
  await installSyntheticCrossmark(page, { proofDelayMs: 5_000 });
  await installWalletOnboardingRoutes(page, boundary, { baseURL: lane.baseURL });

  await page.goto(pilotRoutes.onboarding);
  await page.getByRole("button", { name: /Crossmark/i }).click();
  await page.getByRole("button", { name: /Find my wallet/i }).click();
  await page.getByRole("button", { name: /Connect account/i }).click();
  await page.getByRole("button", { name: /Sign in with wallet/i }).click();
  await expect.poll(() => boundary.walletChallengeRequests.length).toBe(1);
  await expect.poll(async () => (
    await readSyntheticCrossmarkCalls(page)
  ).filter((call) => call === "sign:AccountSet").length).toBe(1);

  await page.reload();

  await expect(page.getByRole("heading", { name: /Choose an AI model/i })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /You’re all set/i })).toHaveCount(0);
  expect(boundary.walletSessionMethods.filter((method) => method === "POST")).toEqual([]);
  expect(boundary.modelRequests).toEqual([]);
  expect(boundary.demoSessionWrites).toEqual([]);
  expect(boundary.tradingRequests).toEqual([]);
  expect(await page.evaluate(() => sessionStorage.getItem("pilot:wallet"))).toBeNull();
});

test("Crossmark availability, connection, proof, and logout remain explicit separate actions", async ({
  page,
  lane,
  evidence,
}) => {
  requireLane(lane, "fixture");
  const boundary = createWalletOnboardingBoundary();
  await installSyntheticCrossmark(page);
  await installWalletOnboardingRoutes(page, boundary, { baseURL: lane.baseURL });

  await page.goto(pilotRoutes.onboarding);
  await page.getByRole("button", { name: /Crossmark/i }).click();
  await page.getByRole("button", { name: /Find my wallet/i }).click();

  await expect(page.getByRole("status")).toContainText(/Crossmark is available/i);
  await expect(page.getByRole("button", { name: /Connect account/i })).toBeVisible();
  expect(await readSyntheticCrossmarkCalls(page)).not.toContain("sign:SignIn");
  expect(boundary.walletChallengeRequests).toEqual([]);

  await page.getByRole("button", { name: /Connect account/i }).click();
  await expect(page.getByRole("status").filter({
    hasText: /Crossmark account/i,
  })).toContainText(
    new RegExp(`Crossmark account ${WALLET_FIXTURE_ACCOUNT} is connected on testnet`, "i"),
  );
  await expect(page.getByRole("button", { name: /Sign in with wallet/i })).toBeVisible();
  expect(await readSyntheticCrossmarkCalls(page)).toContain("sign:SignIn");
  expect(await readSyntheticCrossmarkCalls(page)).not.toContain("sign:AccountSet");
  expect(boundary.walletChallengeRequests).toEqual([]);

  await page.getByRole("button", { name: /Sign in with wallet/i }).click();
  await expect(page.getByRole("heading", { name: /Choose an AI model/i })).toBeVisible();
  expect(boundary.walletChallengeRequests).toEqual(["POST /api/auth/wallet/challenge"]);
  expect(await readSyntheticCrossmarkCalls(page)).toContain("sign:AccountSet");

  await page.getByRole("button", { name: /Try free demo/i }).click();
  await expect(page.getByRole("heading", { name: /You’re all set/i })).toBeVisible();
  const providerCallsBeforeLogout = await readSyntheticCrossmarkCalls(page);
  await page.getByRole("button", { name: /Sign out wallet/i }).click();
  await page.waitForURL(/\/onboarding\?wallet=signed-out$/);
  expect(boundary.walletSessionMethods.filter((method) => method === "DELETE")).toHaveLength(1);
  expect(boundary.postLogoutSensitiveRequests).toEqual([]);
  expect(await readSyntheticCrossmarkCalls(page)).toEqual(providerCallsBeforeLogout);

  evidence.record("crossmark-wallet-auth-fixture", {
    evidenceKind: "mock-provider-conformance",
    availabilityCheckSignatureCalls: 0,
    accountConnectedBeforeChallenge: true,
    walletChallengeCount: 1,
    proofTransactionType: "AccountSet",
    postLogoutProviderCalls: 0,
    realExtensionConnected: false,
    ledgerTransaction: false,
    assertion: "Synthetic Crossmark kept availability, account connection, non-broadcast authentication proof, and logout as separate fail-closed actions.",
  });
});

test("a saved extension delegation waits for explicit preflight, reconnect, and proof", async ({
  page,
  lane,
}) => {
  requireLane(lane, "fixture");
  const boundary = createWalletOnboardingBoundary();
  await installSyntheticGemWallet(page);
  await installWalletOnboardingRoutes(page, boundary, {
    baseURL: lane.baseURL,
    walletSession: "anonymous",
  });
  await page.route("**/api/harbor/account.status", async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        data: {
          owner: WALLET_FIXTURE_ACCOUNT,
          network: "testnet",
          delegate: WALLET_FIXTURE_DELEGATE,
          permissions: WALLET_FIXTURE_PERMISSIONS,
          status: "active",
        },
        asOf: "2026-10-23T00:00:00.000Z",
        asOfBasis: "isolated wallet restoration fixture",
      },
    });
  });
  await page.addInitScript((activeRecord) => {
    sessionStorage.setItem("pilot:onboarding", activeRecord);
  }, activeRecoveryRecord());

  await page.goto(pilotRoutes.onboarding);
  await expect(page.getByRole("status").filter({
    hasText: /saved active delegation/i,
  })).toContainText(
    /saved active delegation.*recovery metadata only/i,
  );
  await expect(page.getByRole("button", { name: /Find my wallet/i })).toBeVisible();
  expect(await readSyntheticGemWalletCalls(page)).toEqual([]);
  expect(boundary.walletChallengeRequests).toEqual([]);
  expect(boundary.tradingRequests).toEqual([]);

  await page.getByRole("button", { name: /Find my wallet/i }).click();
  await page.getByRole("button", { name: /Connect account/i }).click();
  await expect(page.getByRole("button", { name: /Sign in with wallet/i })).toBeVisible();
  expect(boundary.walletChallengeRequests).toEqual([]);

  await page.getByRole("button", { name: /Sign in with wallet/i }).click();
  await expect(page.getByRole("heading", { name: /trading setup is active/i })).toBeVisible();
  expect(boundary.walletChallengeRequests).toEqual(["POST /api/auth/wallet/challenge"]);
  expect((await readSyntheticGemWalletCalls(page)).filter(
    (call) => call === "REQUEST_SIGN_TRANSACTION/V3",
  )).toHaveLength(1);
});

test("an authenticated extension owner can review exact Testnet delegation revocation without submitting", async ({
  page,
  lane,
  evidence,
}, testInfo) => {
  requireLane(lane, "fixture");
  const boundary = createWalletOnboardingBoundary();
  await installSyntheticGemWallet(page);
  await installWalletOnboardingRoutes(page, boundary, {
    baseURL: lane.baseURL,
    walletSession: "anonymous",
  });
  const activeLink = {
    owner: WALLET_FIXTURE_ACCOUNT,
    network: "testnet",
    delegate: WALLET_FIXTURE_DELEGATE,
    permissions: WALLET_FIXTURE_PERMISSIONS,
    status: "active",
  };
  await page.route("**/api/harbor/account.status", async (route) => {
    await route.fulfill({ json: {
      ok: true, data: activeLink,
      asOf: "2026-10-23T00:00:00.000Z", asOfBasis: "offline extension revocation fixture",
    } });
  });
  await page.route("**/api/harbor/account.revoke", async (route) => {
    await route.fulfill({ json: {
      ok: true,
      data: {
        ...activeLink,
        status: "suspended",
        revoke_tx: {
          TransactionType: "DelegateSet",
          Account: WALLET_FIXTURE_ACCOUNT,
          Authorize: WALLET_FIXTURE_DELEGATE,
          Permissions: [],
          Fee: "12",
          Sequence: 42,
          LastLedgerSequence: 1_020,
        },
      },
      asOf: "2026-10-23T00:00:01.000Z", asOfBasis: "offline extension revocation fixture",
    } });
  });
  await page.route("**/api/harbor/ledger.account.info", async (route) => {
    await route.fulfill({ json: {
      ok: true,
      data: { account_data: { Account: WALLET_FIXTURE_ACCOUNT, Sequence: 42 }, ledger_index: 1_000, validated: true },
      asOf: "2026-10-23T00:00:01.000Z", asOfBasis: "offline extension revocation fixture",
    } });
  });
  await page.addInitScript((activeRecord) => {
    sessionStorage.setItem("pilot:onboarding", activeRecord);
  }, activeRecoveryRecord());

  await page.goto(pilotRoutes.onboarding);
  await page.getByRole("button", { name: /Find my wallet/i }).click();
  await page.getByRole("button", { name: /Connect account/i }).click();
  await page.getByRole("button", { name: /Sign in with wallet/i }).click();
  await expect(page.getByRole("heading", { name: /trading setup is active/i })).toBeVisible();
  await expect(page.getByText(/does not delete your external wallet key/i)).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: /Active Harbor delegation/i })).toHaveCount(0);

  const signingCallsBeforeReview = (await readSyntheticGemWalletCalls(page)).filter(
    (call) => call === "REQUEST_SIGN_TRANSACTION/V3",
  ).length;
  await page.getByRole("button", { name: /Review delegation revocation/i }).click();
  const dialog = page.getByRole("dialog", { name: /Review what your wallet will show/i });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Revoke Harbor's delegation for this exact Testnet account");
  await expect(dialog).toContainText("No payment or value transfer");
  await expect(dialog).toContainText("does not cancel an in-flight transaction");
  await expect(dialog).toContainText(WALLET_FIXTURE_DELEGATE);
  expect((await readSyntheticGemWalletCalls(page)).filter(
    (call) => call === "REQUEST_SIGN_TRANSACTION/V3",
  )).toHaveLength(signingCallsBeforeReview);
  expect(boundary.tradingRequests.filter((request) => request.includes("tx.submit"))).toEqual([]);
  await attachPageScreenshot(page, testInfo, "mock-provider-conformance-extension-revocation-review");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(await page.evaluate(() => sessionStorage.getItem("pilot:onboarding-pending"))).toBeNull();
  evidence.record("extension-revocation-review-fixture", {
    evidenceKind: "mock-provider-conformance",
    exactOwner: WALLET_FIXTURE_ACCOUNT,
    network: "testnet",
    permissionsAfterPreparedRevoke: 0,
    walletSignCallsDuringReview: 0,
    submitCalls: 0,
    externalWalletKeyDestroyed: false,
    assertion: "The exact authenticated extension owner reviewed an empty-permission DelegateSet without signing or submitting it.",
  });
});

test("switching providers after account connection clears pre-proof wallet state", async ({
  page,
  lane,
}) => {
  requireLane(lane, "fixture");
  const boundary = createWalletOnboardingBoundary();
  await installSyntheticGemWallet(page);
  await installSyntheticCrossmark(page);
  await installWalletOnboardingRoutes(page, boundary, { baseURL: lane.baseURL });

  await page.goto(pilotRoutes.onboarding);
  await page.getByRole("button", { name: /GemWallet/i }).click();
  await page.getByRole("button", { name: /Find my wallet/i }).click();
  await page.getByRole("button", { name: /Connect account/i }).click();
  await expect(page.getByRole("button", { name: /Sign in with wallet/i })).toBeVisible();

  await page.getByRole("button", { name: /Crossmark/i }).click();
  await expect(page.getByRole("button", { name: /Find my wallet/i })).toBeVisible();
  await expect(page.getByText(/GemWallet account .* is connected/i)).toHaveCount(0);
  expect(boundary.walletChallengeRequests).toEqual([]);
  expect((await readSyntheticCrossmarkCalls(page)).filter(
    (call) => call.startsWith("sign:"),
  )).toEqual([]);
  expect(boundary.walletSessionMethods.filter((method) => method === "DELETE")).toEqual([]);
});

test("switching identity clears the authenticated wallet and model authority first", async ({
  page,
  lane,
}) => {
  requireLane(lane, "fixture");
  const boundary = createWalletOnboardingBoundary();
  await installSyntheticGemWallet(page);
  await installSyntheticCrossmark(page);
  await installWalletOnboardingRoutes(page, boundary, { baseURL: lane.baseURL });

  await page.goto(pilotRoutes.onboarding);
  await page.getByRole("button", { name: /Crossmark/i }).click();
  await page.getByRole("button", { name: /Find my wallet/i }).click();
  await page.getByRole("button", { name: /Connect account/i }).click();
  await page.getByRole("button", { name: /Sign in with wallet/i }).click();
  await expect(page.getByRole("heading", { name: /Choose an AI model/i })).toBeVisible();

  const deletesBeforeSwitch = boundary.walletSessionMethods.filter(
    (method) => method === "DELETE",
  ).length;
  await page.getByRole("button", { name: /Use a different wallet/i }).click();
  await expect(page.getByRole("heading", { name: /^Connect your wallet$/i })).toBeVisible();
  await page.getByRole("button", { name: /GemWallet/i }).click();

  await expect(page.getByRole("button", { name: /Find my wallet/i })).toBeVisible();
  expect(boundary.walletSessionMethods.filter(
    (method) => method === "DELETE",
  )).toHaveLength(deletesBeforeSwitch + 1);
  await expect(page.getByRole("heading", { name: /Choose an AI model/i })).toHaveCount(0);
});

test("a saved delegation rejects a different provider before wallet proof", async ({
  page,
  lane,
}) => {
  requireLane(lane, "fixture");
  const boundary = createWalletOnboardingBoundary();
  await installSyntheticGemWallet(page);
  await installSyntheticCrossmark(page);
  await installWalletOnboardingRoutes(page, boundary, { baseURL: lane.baseURL });
  await page.addInitScript((activeRecord) => {
    sessionStorage.setItem("pilot:onboarding", activeRecord);
  }, activeRecoveryRecord());

  await page.goto(pilotRoutes.onboarding);
  await page.getByRole("button", { name: /Crossmark/i }).click();
  await page.getByRole("button", { name: /Find my wallet/i }).click();
  await page.getByRole("button", { name: /Connect account/i }).click();

  await expect(page.getByRole("alert").filter({
    hasText: /saved active delegation requires its exact wallet provider and network/i,
  }).first()).toBeVisible();
  expect(boundary.walletChallengeRequests).toEqual([]);
  expect((await readSyntheticCrossmarkCalls(page)).filter(
    (call) => call.startsWith("sign:"),
  )).toEqual([]);
});

test("wallet and model readiness creates no trading authority until explicit opt-in", async ({
  page,
  lane,
  evidence,
}, testInfo) => {
  requireLane(lane, "fixture");
  const boundary = createWalletOnboardingBoundary();
  await installSyntheticGemWallet(page);
  await installWalletOnboardingRoutes(page, boundary, {
    baseURL: lane.baseURL,
    walletSession: "authenticated",
  });
  await page.addInitScript(({ account }) => {
    sessionStorage.setItem("pilot:wallet", JSON.stringify({
      provider: "gemwallet",
      network: "testnet",
      account,
    }));
  }, { account: WALLET_FIXTURE_ACCOUNT });

  await page.goto(`${pilotRoutes.onboarding}?openrouter=error`);
  await expect(page.getByRole("heading", { name: /Choose an AI model/i })).toBeVisible();
  await page.getByRole("button", { name: /Try free demo/i }).click();

  await expect(page.getByRole("heading", { name: /You’re all set/i })).toBeVisible();
  await expect(page.getByText(/can’t trade for you yet/i)).toBeVisible();
  await expect(page.getByRole("link", { name: /Open Pilot/i })).toBeVisible();
  expect(boundary.demoSessionWrites).toHaveLength(1);
  expect(boundary.tradingRequests).toEqual([]);
  await attachPageScreenshot(page, testInfo, "mock-provider-conformance-wallet-and-model-ready");

  await page.getByRole("button", { name: /Enable Testnet trading/i }).click();
  await expect(page.getByRole("heading", { name: /Prepare the budget account/i })).toBeVisible();
  expect(boundary.tradingRequests).toEqual([]);

  evidence.record("desktop-wallet-access-ready-fixture", {
    evidenceKind: "mock-provider-conformance",
    realExtensionConnected: false,
    realWalletProof: false,
    walletCreated: false,
    providerCalled: false,
    ledgerTransaction: false,
    tradingRequestCountBeforeExplicitReview: boundary.tradingRequests.length,
    assertion: "Wallet plus model readiness created no trustline, funding, delegation, mandate, strategy, or ledger authority.",
  });
});

test("wallet proof alone creates a Pilot account and model setup stays optional", async ({
  page,
  lane,
  evidence,
}, testInfo) => {
  requireLane(lane, "fixture");
  const boundary = createWalletOnboardingBoundary();
  await installSyntheticCrossmark(page);
  await installWalletOnboardingRoutes(page, boundary, { baseURL: lane.baseURL });

  await page.goto(pilotRoutes.onboarding);
  await page.getByRole("button", { name: /Crossmark/i }).click();
  await page.getByRole("button", { name: /Find my wallet/i }).click();
  await page.getByRole("button", { name: /Connect account/i }).click();
  await page.getByRole("button", { name: /Sign in with wallet/i }).click();

  await expect(page.getByRole("heading", { name: /Choose an AI model/i })).toBeVisible();
  await page.getByRole("button", { name: /Skip model setup/i }).click();

  await expect(page.getByRole("heading", { name: /Your wallet is connected/i })).toBeVisible();
  await expect(page.getByText(/Not set up yet/i)).toBeVisible();
  await expect(page.getByText(/add an AI model any time/i)).toBeVisible();
  expect(boundary.walletChallengeRequests).toEqual(["POST /api/auth/wallet/challenge"]);
  expect(boundary.walletSessionMethods.filter((method) => method === "POST")).toEqual(["POST"]);
  expect(boundary.demoSessionWrites).toEqual([]);
  expect(boundary.tradingRequests).toEqual([]);
  await attachPageScreenshot(page, testInfo, "mock-provider-conformance-wallet-account-ready");

  evidence.record("wallet-account-without-model-fixture", {
    evidenceKind: "mock-provider-conformance",
    realExtensionConnected: false,
    realWalletProof: false,
    walletSessionWrites: 1,
    modelSessionWrites: 0,
    tradingRequests: 0,
    assertion: "A verified wallet proof completes Pilot account onboarding without OpenRouter, demo-model, or trading authority.",
  });
});

test("a valid wallet session survives same-tab reload without restoring signing authority", async ({
  page,
  lane,
}) => {
  requireLane(lane, "fixture");
  const boundary = createWalletOnboardingBoundary();
  await installSyntheticCrossmark(page);
  await installWalletOnboardingRoutes(page, boundary, { baseURL: lane.baseURL });

  await page.goto(pilotRoutes.onboarding);
  await page.getByRole("button", { name: /Crossmark/i }).click();
  await page.getByRole("button", { name: /Find my wallet/i }).click();
  await page.getByRole("button", { name: /Connect account/i }).click();
  await page.getByRole("button", { name: /Sign in with wallet/i }).click();
  await expect(page.getByRole("heading", { name: /Choose an AI model/i })).toBeVisible();
  const proofCalls = (await readSyntheticCrossmarkCalls(page)).filter(
    (call) => call === "sign:AccountSet",
  );
  expect(proofCalls).toEqual(["sign:AccountSet"]);

  await page.reload();

  await expect(page.getByRole("heading", { name: /Choose an AI model/i })).toBeVisible();
  expect((await readSyntheticCrossmarkCalls(page)).filter(
    (call) => call === "sign:AccountSet",
  )).toEqual([]);
});

test("same-tab restore shows the existing OAuth session and skip clears it server-side", async ({
  page,
  lane,
}) => {
  requireLane(lane, "fixture");
  const boundary = createWalletOnboardingBoundary();
  await installSyntheticCrossmark(page);
  await installWalletOnboardingRoutes(page, boundary, {
    baseURL: lane.baseURL,
    oauthConnected: true,
    walletSession: "authenticated",
  });
  await page.addInitScript(({ account }) => {
    sessionStorage.setItem("pilot:wallet", JSON.stringify({
      provider: "crossmark",
      network: "testnet",
      account,
    }));
  }, { account: WALLET_FIXTURE_ACCOUNT });

  await page.goto(pilotRoutes.onboarding);

  await expect(page.getByRole("heading", { name: /Choose an AI model/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /Reconnect OpenRouter/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Continue with OpenRouter/i })).toBeVisible();
  expect((await readSyntheticCrossmarkCalls(page)).filter(
    (call) => call === "sign:AccountSet",
  )).toEqual([]);

  await page.getByRole("button", { name: /Skip model setup/i }).click();

  await expect(page.getByRole("heading", { name: /Your wallet is connected/i })).toBeVisible();
  await expect(page.getByText(/Not set up yet/i)).toBeVisible();
  expect(boundary.modelRequests.filter(
    (request) => request === "DELETE /api/auth/openrouter/session",
  )).toEqual(["DELETE /api/auth/openrouter/session"]);
});

for (const callbackPath of ["", "?openrouter=connected"] as const) {
  test(`a transient model-session failure preserves wallet identity${callbackPath ? " after OAuth return" : " on same-tab restore"}`, async ({
    page,
    lane,
  }) => {
    requireLane(lane, "fixture");
    const boundary = createWalletOnboardingBoundary();
    await installSyntheticCrossmark(page);
    await installWalletOnboardingRoutes(page, boundary, {
      baseURL: lane.baseURL,
      oauthConnected: true,
      walletSession: "authenticated",
    });
    await page.addInitScript(({ account }) => {
      sessionStorage.setItem("pilot:wallet", JSON.stringify({
        provider: "crossmark",
        network: "testnet",
        account,
      }));
    }, { account: WALLET_FIXTURE_ACCOUNT });
    await page.route("**/api/auth/openrouter/session", async (route) => {
      if (route.request().method() === "GET") {
        await route.abort("failed");
        return;
      }
      await route.fallback();
    });

    await page.goto(`${pilotRoutes.onboarding}${callbackPath}`);

    await expect(page.getByRole("heading", { name: /Choose an AI model/i })).toBeVisible();
    await expect(page.getByText(WALLET_FIXTURE_ACCOUNT)).toBeVisible();
    await expect(page.getByRole("status").filter({
      hasText: /could not check.*model session/i,
    })).toBeVisible();
    await expect(page.getByRole("button", { name: /Try free demo/i })).toBeDisabled();
    await expect(page.getByRole("link", { name: /Connect OpenRouter/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Skip model setup/i })).toBeEnabled();
    await expect(page.getByRole("heading", { name: /^Connect your wallet$/i })).toHaveCount(0);
    expect((await readSyntheticCrossmarkCalls(page)).filter(
      (call) => call === "sign:AccountSet",
    )).toEqual([]);
  });
}

test("an indeterminate session check keeps identity visible and locks authority changes", async ({
  page,
  lane,
}) => {
  requireLane(lane, "fixture");
  const boundary = createWalletOnboardingBoundary();
  await installSyntheticCrossmark(page);
  await installWalletOnboardingRoutes(page, boundary, { baseURL: lane.baseURL });

  await page.goto(pilotRoutes.onboarding);
  await page.getByRole("button", { name: /Crossmark/i }).click();
  await page.getByRole("button", { name: /Find my wallet/i }).click();
  await page.getByRole("button", { name: /Connect account/i }).click();
  await page.getByRole("button", { name: /Sign in with wallet/i }).click();
  await expect(page.getByRole("heading", { name: /Choose an AI model/i })).toBeVisible();

  await page.route("**/api/auth/wallet/session", async (route) => {
    if (route.request().method() === "GET") {
      await route.abort("failed");
      return;
    }
    await route.fallback();
  });
  await page.evaluate(() => window.dispatchEvent(new Event("pilot:wallet-session-changed")));

  await expect(page.getByRole("heading", { name: /Choose an AI model/i })).toBeVisible();
  await expect(page.getByRole("status").filter({
    hasText: /could not revalidate.*known account remains visible/i,
  })).toBeVisible();
  await expect(page.getByText(WALLET_FIXTURE_ACCOUNT)).toBeVisible();
  await expect(page.getByRole("button", { name: /Try free demo/i })).toBeDisabled();
  await expect(page.getByRole("link", { name: /Connect OpenRouter/i })).toHaveCount(0);
  await expect(page.locator('[aria-disabled="true"]').filter({
    hasText: /Connect OpenRouter/i,
  })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Connect your wallet$/i })).toHaveCount(0);
});

test("an indeterminate check during optional trading preserves state and exposes no authority control", async ({
  page,
  lane,
}) => {
  requireLane(lane, "fixture");
  const boundary = createWalletOnboardingBoundary();
  await installSyntheticCrossmark(page);
  await installWalletOnboardingRoutes(page, boundary, { baseURL: lane.baseURL });

  await page.goto(pilotRoutes.onboarding);
  await page.getByRole("button", { name: /Crossmark/i }).click();
  await page.getByRole("button", { name: /Find my wallet/i }).click();
  await page.getByRole("button", { name: /Connect account/i }).click();
  await page.getByRole("button", { name: /Sign in with wallet/i }).click();
  await page.getByRole("button", { name: /Skip model setup/i }).click();
  await page.getByRole("button", { name: /Enable Testnet trading/i }).click();
  await expect(page.getByRole("heading", { name: /Prepare the budget account/i })).toBeVisible();
  const providerCallsBeforeFailure = await readSyntheticCrossmarkCalls(page);
  const tradingRequestsBeforeFailure = [...boundary.tradingRequests];

  await page.route("**/api/auth/wallet/session", async (route) => {
    if (route.request().method() === "GET") {
      await route.abort("failed");
      return;
    }
    await route.fallback();
  });
  await page.evaluate(() => window.dispatchEvent(new Event("pilot:wallet-session-changed")));

  await expect(page.getByRole("heading", { name: /Trading changes are locked/i })).toBeVisible();
  await expect(page.getByText(/partially completed Testnet setup is preserved/i)).toBeVisible();
  await expect(page.getByText(/may still remain active/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /Create trust line/i })).toHaveCount(0);
  expect(await readSyntheticCrossmarkCalls(page)).toEqual(providerCallsBeforeFailure);
  expect(boundary.tradingRequests).toEqual(tradingRequestsBeforeFailure);
});

test("an invalidated live wallet session immediately removes model readiness", async ({
  page,
  lane,
}) => {
  requireLane(lane, "fixture");
  const boundary = createWalletOnboardingBoundary();
  await installSyntheticCrossmark(page);
  await installWalletOnboardingRoutes(page, boundary, { baseURL: lane.baseURL });

  await page.goto(pilotRoutes.onboarding);
  await page.getByRole("button", { name: /Crossmark/i }).click();
  await page.getByRole("button", { name: /Find my wallet/i }).click();
  await page.getByRole("button", { name: /Connect account/i }).click();
  await page.getByRole("button", { name: /Sign in with wallet/i }).click();
  await expect(page.getByRole("heading", { name: /Choose an AI model/i })).toBeVisible();

  await page.route("**/api/auth/wallet/session", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { authenticated: false } });
      return;
    }
    await route.fallback();
  });
  await page.evaluate(() => window.dispatchEvent(new Event("pilot:wallet-session-changed")));

  await expect(page.getByRole("heading", { name: /^Connect your wallet$/i })).toBeVisible();
  await expect(page.getByText(/wallet session is no longer valid/i)).toBeVisible();
  await expect(page.getByRole("heading", { name: /Choose an AI model/i })).toHaveCount(0);
});

test("an authenticated server session without tab metadata requires exact-wallet reconnect", async ({
  page,
  lane,
  evidence,
}) => {
  requireLane(lane, "fixture");
  const boundary = createWalletOnboardingBoundary();
  await installWalletOnboardingRoutes(page, boundary, {
    baseURL: lane.baseURL,
    walletSession: "authenticated",
  });

  await page.goto(`${pilotRoutes.onboarding}?openrouter=connected`);
  await expect(page.getByRole("heading", { name: /^Connect your wallet$/i })).toBeVisible();
  await expect(page.getByRole("alert").filter({
    hasText: /reconnect the exact wallet|reconnect.*this tab/i,
  }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: /Choose an AI model/i })).toHaveCount(0);
  expect(boundary.modelRequests).toEqual([]);
  expect(boundary.tradingRequests).toEqual([]);

  evidence.record("wallet-new-tab-reconnect-fixture", {
    evidenceKind: "mock-provider-conformance",
    serverSessionPresent: true,
    tabWalletMetadataPresent: false,
    realExtensionConnected: false,
    realWalletProof: false,
    ledgerTransaction: false,
    assertion: "A server cookie alone did not authorize model selection or trading from a tab without wallet metadata.",
  });
});

test("an expired wallet session stays before model selection and trading", async ({ page, lane }) => {
  requireLane(lane, "fixture");
  const boundary = createWalletOnboardingBoundary();
  await installSyntheticCrossmark(page);
  await installWalletOnboardingRoutes(page, boundary, {
    baseURL: lane.baseURL,
    walletSession: "expired",
  });
  await page.addInitScript(({ account }) => {
    sessionStorage.setItem("pilot:wallet", JSON.stringify({
      provider: "crossmark",
      network: "testnet",
      account,
    }));
  }, { account: WALLET_FIXTURE_ACCOUNT });

  await page.goto(`${pilotRoutes.onboarding}?openrouter=connected`);
  await expect(page.getByRole("heading", { name: /^Connect your wallet$/i })).toBeVisible();
  await expect(page.getByRole("alert").filter({
    hasText: /reconnect the exact wallet|session expired/i,
  }).first()).toBeVisible();
  expect(boundary.modelRequests).toEqual([]);
  expect(boundary.tradingRequests).toEqual([]);
  expect(await readSyntheticCrossmarkCalls(page)).not.toContain("sign:AccountSet");
});

test("Pilot sign-out preserves an active recovery record without silently restoring it", async ({
  page,
  lane,
  evidence,
}) => {
  requireLane(lane, "fixture");
  const boundary = createWalletOnboardingBoundary();
  await installSyntheticGemWallet(page);
  await installWalletOnboardingRoutes(page, boundary, {
    baseURL: lane.baseURL,
    walletSession: "authenticated",
  });
  const active = activeRecoveryRecord();
  await page.addInitScript(({ account }) => {
    sessionStorage.setItem("pilot:wallet", JSON.stringify({
      provider: "gemwallet",
      network: "testnet",
      account,
    }));
  }, { account: WALLET_FIXTURE_ACCOUNT });

  await page.goto(`${pilotRoutes.onboarding}?openrouter=error`);
  await page.getByRole("button", { name: /Try free demo/i }).click();
  await expect(page.getByRole("heading", { name: /You’re all set/i })).toBeVisible();
  await page.evaluate((activeRecord) => {
    sessionStorage.setItem("pilot:onboarding", activeRecord);
  }, active);
  const providerCallsBeforeLogout = await readSyntheticGemWalletCalls(page);
  await page.getByRole("button", { name: /Sign out wallet/i }).click();
  await page.waitForURL(/\/onboarding\?wallet=signed-out$/);
  await expect(page.getByText(/recovery record remains unchanged|reconnect the exact wallet/i)).toBeVisible();

  const stored = await page.evaluate(() => ({
    wallet: sessionStorage.getItem("pilot:wallet"),
    active: sessionStorage.getItem("pilot:onboarding"),
    pending: sessionStorage.getItem("pilot:onboarding-pending"),
  }));
  expect(stored).toEqual({
    wallet: null,
    active,
    pending: null,
  });
  expect(boundary.walletSessionMethods.filter((method) => method === "DELETE")).toHaveLength(1);
  expect(boundary.postLogoutSensitiveRequests).toEqual([]);
  expect(await readSyntheticGemWalletCalls(page)).toEqual(providerCallsBeforeLogout);

  evidence.record("wallet-sign-out-active-recovery-fixture", {
    evidenceKind: "mock-provider-conformance",
    pilotWalletMetadataCleared: true,
    activeRecoveryMetadataPreserved: true,
    automaticProviderReconnect: false,
    postLogoutSensitiveRequests: 0,
    delegationRevoked: false,
    realExtensionConnected: false,
    ledgerTransaction: false,
    assertion: "Pilot sign-out preserved valid active recovery metadata without restoring it or attempting wallet, model, or trading authority.",
  });
});

test("Pilot sign-out preserves pending recovery without silently reconnecting", async ({
  page,
  lane,
  evidence,
}) => {
  requireLane(lane, "fixture");
  const boundary = createWalletOnboardingBoundary();
  await installSyntheticGemWallet(page);
  await installWalletOnboardingRoutes(page, boundary, {
    baseURL: lane.baseURL,
    walletSession: "authenticated",
  });
  const pending = pendingRecoveryRecord();
  await page.addInitScript(({ account }) => {
    sessionStorage.setItem("pilot:wallet", JSON.stringify({
      provider: "gemwallet",
      network: "testnet",
      account,
    }));
  }, { account: WALLET_FIXTURE_ACCOUNT });

  await page.goto(`${pilotRoutes.onboarding}?openrouter=error`);
  await page.getByRole("button", { name: /Try free demo/i }).click();
  await expect(page.getByRole("heading", { name: /You’re all set/i })).toBeVisible();
  await page.evaluate((pendingRecord) => {
    sessionStorage.setItem("pilot:onboarding-pending", pendingRecord);
  }, pending);
  const providerCallsBeforeLogout = await readSyntheticGemWalletCalls(page);
  await page.getByRole("button", { name: /Sign out wallet/i }).click();
  await page.waitForURL(/\/onboarding\?wallet=signed-out$/);
  await expect(page.getByText(/recovery record remains unchanged|reconnect the exact wallet/i)).toBeVisible();

  const stored = await page.evaluate(() => ({
    wallet: sessionStorage.getItem("pilot:wallet"),
    active: sessionStorage.getItem("pilot:onboarding"),
    pending: sessionStorage.getItem("pilot:onboarding-pending"),
  }));
  expect(stored).toEqual({ wallet: null, active: null, pending });
  expect(boundary.walletSessionMethods.filter((method) => method === "DELETE")).toHaveLength(1);
  expect(boundary.postLogoutSensitiveRequests).toEqual([]);
  expect(await readSyntheticGemWalletCalls(page)).toEqual(providerCallsBeforeLogout);

  evidence.record("wallet-sign-out-pending-recovery-fixture", {
    evidenceKind: "mock-provider-conformance",
    pilotWalletMetadataCleared: true,
    pendingRecoveryMetadataPreserved: true,
    automaticProviderReconnect: false,
    postLogoutSensitiveRequests: 0,
    realExtensionConnected: false,
    ledgerTransaction: false,
    assertion: "Pilot sign-out preserved pending recovery metadata without automatically reconnecting the provider or creating new authority.",
  });
});

test("a failed explicit reconnect keeps signed-out restoration suppressed", async ({
  page,
  lane,
}) => {
  requireLane(lane, "fixture");
  const boundary = createWalletOnboardingBoundary();
  await installSyntheticGemWallet(page, { installed: false });
  await installWalletOnboardingRoutes(page, boundary, {
    baseURL: lane.baseURL,
    walletSession: "anonymous",
  });
  const active = activeRecoveryRecord();
  await page.addInitScript((activeRecord) => {
    sessionStorage.setItem("pilot:onboarding", activeRecord);
  }, active);

  await page.goto(`${pilotRoutes.onboarding}?wallet=signed-out`);
  await page.getByRole("button", { name: /Find my wallet/i }).click();

  await expect(page.getByRole("alert").filter({
    hasText: /install|not installed|unavailable/i,
  }).first()).toBeVisible();
  await expect(page).toHaveURL(/\/onboarding\?wallet=signed-out$/);
  expect(await page.evaluate(() => sessionStorage.getItem("pilot:onboarding"))).toBe(active);
  expect(boundary.walletChallengeRequests).toEqual([]);
  expect(boundary.modelRequests).toEqual([]);
  expect(boundary.tradingRequests).toEqual([]);
  expect(boundary.postLogoutSensitiveRequests).toEqual([]);
});

test("an unconfigured free demo cannot reach access readiness", async ({ page, lane }) => {
  requireLane(lane, "fixture");
  const boundary = createWalletOnboardingBoundary();
  await installWalletOnboardingRoutes(page, boundary, {
    baseURL: lane.baseURL,
    demoModelsUnavailable: true,
    walletSession: "authenticated",
  });
  await page.addInitScript(({ account }) => {
    sessionStorage.setItem("pilot:wallet", JSON.stringify({
      provider: "gemwallet",
      network: "testnet",
      account,
    }));
  }, { account: WALLET_FIXTURE_ACCOUNT });

  await page.goto(`${pilotRoutes.onboarding}?openrouter=error`);
  await expect(page.getByRole("button", { name: /Free demo unavailable/i })).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("The free demo is not configured.");
  await expect(page.getByRole("heading", { name: /You’re all set/i })).toHaveCount(0);
  expect(boundary.demoSessionWrites).toEqual([]);
  expect(boundary.tradingRequests).toEqual([]);
});
