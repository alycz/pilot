import type { Page } from "@playwright/test";

import {
  expect,
  installFixtureChatPrerequisites,
  pilotRoutes,
  requireLane,
  test,
} from "./support";

const FIXTURE_ACCOUNT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const FIXTURE_MODEL = "openai/gpt-oss-20b:free";

type RequestBoundary = {
  modelRequests: string[];
  forbiddenBeforeWalletProof: string[];
  demoSessionResponses: string[];
};

async function installWalletFirstRoutes(
  page: Page,
  boundary: RequestBoundary,
  options: { demoModelsUnavailable?: boolean; oauthConnected?: boolean } = {},
): Promise<void> {
  let walletAuthenticated = false;

  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    const isModelRequest = pathname === "/api/auth/openrouter/models" ||
      pathname === "/api/auth/openrouter/start" ||
      (pathname === "/api/auth/openrouter/session" && request.method() === "POST");
    if (isModelRequest) boundary.modelRequests.push(`${request.method()} ${pathname}`);

    const isForbiddenSetupRequest = isModelRequest ||
      pathname === "/api/chat" ||
      pathname.startsWith("/api/harbor/") ||
      pathname.startsWith("/api/dev/") ||
      pathname.startsWith("/api/onboarding/trustset/") ||
      pathname.startsWith("/api/ledger-sim/");
    if (!walletAuthenticated && isForbiddenSetupRequest) {
      boundary.forbiddenBeforeWalletProof.push(`${request.method()} ${pathname}`);
    }
  });

  await page.route("**/api/config/public", async (route) => {
    await route.fulfill({
      json: {
        network: "testnet",
        stableAsset: {
          currency: "RLUSD",
          issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
        },
        devSignerEnabled: false,
        walletActionProofRequired: false,
        walletActionProofConfigured: false,
        mockMode: true,
      },
    });
  });
  await page.route("**/api/auth/wallet/challenge", async (route) => {
    await route.fulfill({
      json: {
        account: FIXTURE_ACCOUNT,
        network: "testnet",
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        tx_json: {
          TransactionType: "AccountSet",
          Account: FIXTURE_ACCOUNT,
          Sequence: 0,
          Fee: "0",
          LastLedgerSequence: 0,
          Memos: [{ Memo: { MemoType: "70696C6F742D77616C6C65742D617574682D7631" } }],
        },
      },
    });
  });
  await page.route("**/api/auth/wallet/session", async (route) => {
    if (route.request().headers().cookie?.includes("fixture-wallet-authenticated=1")) {
      walletAuthenticated = true;
    }
    if (route.request().method() === "POST") {
      walletAuthenticated = true;
      await route.fulfill({
        json: {
          authenticated: true,
          account: FIXTURE_ACCOUNT,
          network: "testnet",
          expiresAt: Date.now() + 60 * 60_000,
        },
      });
      return;
    }
    await route.fulfill({
      json: walletAuthenticated
        ? {
            authenticated: true,
            account: FIXTURE_ACCOUNT,
            network: "testnet",
            expiresAt: Date.now() + 60 * 60_000,
          }
        : { authenticated: false },
    });
  });
  await page.route("**/api/auth/openrouter/models**", async (route) => {
    if (options.demoModelsUnavailable) {
      await route.fulfill({
        status: 503,
        json: {
          error: "The free demo is not configured.",
          code: "DEMO_MISCONFIGURED",
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        defaultModel: FIXTURE_MODEL,
        models: [{ id: FIXTURE_MODEL, name: "Fixture free model" }],
      },
    });
  });
  await page.route("**/api/auth/openrouter/session", async (route) => {
    const connected = route.request().method() === "GET" &&
      walletAuthenticated &&
      options.oauthConnected === true;
    const response = JSON.stringify({
      connected,
      mode: connected ? "oauth" : "demo",
      model: FIXTURE_MODEL,
      demo: {
        available: true,
        costPolicy: "free-only",
        maxInputBytes: 4096,
        maxOutputTokens: 256,
        maxSteps: 3,
      },
    });
    if (route.request().method() === "POST") {
      boundary.demoSessionResponses.push(response);
    }
    await route.fulfill({
      status: walletAuthenticated ? 200 : 401,
      contentType: "application/json",
      body: response,
    });
  });
}

async function installGemWalletReconnectFixture(page: Page): Promise<void> {
  await page.addInitScript(({ account }) => {
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.data?.source !== "GEM_WALLET_MSG_REQUEST") return;
      const request = event.data as { messageId?: number; type?: string };
      let response: Record<string, unknown> | undefined;
      if (request.type === "REQUEST_IS_INSTALLED/V3") {
        response = { isInstalled: true };
      } else if (request.type === "REQUEST_GET_PUBLIC_KEY/V3") {
        response = { result: { address: account, publicKey: "fixture-public-key" } };
      } else if (request.type === "REQUEST_GET_NETWORK/V3") {
        response = {
          result: {
            chain: "XRPL",
            network: "Testnet",
            websocket: "wss://fixture.invalid",
          },
        };
      }
      if (!response) return;
      window.postMessage({
        source: "GEM_WALLET_MSG_RESPONSE",
        messagedId: request.messageId,
        ...response,
      }, window.location.origin);
    });
  }, { account: FIXTURE_ACCOUNT });
}

test("model access stays hidden until a wallet-bound session is restored", async ({
  page,
  lane,
  evidence,
}) => {
  requireLane(lane, "fixture");
  const boundary: RequestBoundary = {
    modelRequests: [],
    forbiddenBeforeWalletProof: [],
    demoSessionResponses: [],
  };
  await installWalletFirstRoutes(page, boundary, { oauthConnected: true });

  await page.goto(pilotRoutes.onboarding);
  await expect(page.getByRole("heading", { name: /Authenticate your budget wallet/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Choose model access/i })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Connect OpenRouter/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Try free demo/i })).toHaveCount(0);
  await page.waitForTimeout(250);
  expect(boundary.forbiddenBeforeWalletProof).toEqual([]);
  expect(boundary.modelRequests).toEqual([]);

  await page.evaluate(({ account }) => {
    sessionStorage.setItem("pilot:wallet", JSON.stringify({
      provider: "gemwallet",
      network: "testnet",
      account,
    }));
  }, { account: FIXTURE_ACCOUNT });
  await page.context().addCookies([{
    name: "fixture-wallet-authenticated",
    value: "1",
    url: lane.baseURL,
  }]);
  await page.goto(`${pilotRoutes.onboarding}?openrouter=connected`);
  await expect(page.getByRole("heading", { name: /Choose model access/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /Connect OpenRouter/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Continue with OpenRouter/i })).toBeVisible();
  expect(boundary.forbiddenBeforeWalletProof).toEqual([]);
  expect(boundary.modelRequests).toContain("GET /api/auth/openrouter/models");

  expect(boundary.demoSessionResponses).toEqual([]);

  evidence.record("wallet-first-model-access-fixture", {
    evidenceKind: "mock-provider-conformance",
    walletProof: "stubbed same-origin wallet session matched to strict public wallet metadata",
    realProviderGrant: false,
    realModelResponse: false,
    ledgerTransaction: false,
    assertion:
      "No model, funding, trustline, delegation, Harbor, chat, or ledger request occurred before the synthetic wallet-session conformance boundary completed.",
  });
});

test("wallet-first onboarding is responsive without horizontal overflow", async ({
  page,
  lane,
}) => {
  requireLane(lane, "fixture");
  const boundary: RequestBoundary = {
    modelRequests: [],
    forbiddenBeforeWalletProof: [],
    demoSessionResponses: [],
  };
  await installWalletFirstRoutes(page, boundary);

  for (const viewport of [
    { width: 375, height: 812 },
    { width: 1_440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(pilotRoutes.onboarding);
    await expect(page.getByRole("heading", { name: /Authenticate your budget wallet/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /gemwallet/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /crossmark/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /xaman/i })).toBeDisabled();
    await expect(page.getByText(/Xaman needs an app API key/i)).toBeVisible();
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }
  expect(boundary.forbiddenBeforeWalletProof).toEqual([]);
});

test("an unavailable free demo stays disabled without hiding OpenRouter or read-only exploration", async ({
  page,
  lane,
}) => {
  requireLane(lane, "fixture");
  const boundary: RequestBoundary = {
    modelRequests: [],
    forbiddenBeforeWalletProof: [],
    demoSessionResponses: [],
  };
  await installWalletFirstRoutes(page, boundary, { demoModelsUnavailable: true });
  await page.goto(pilotRoutes.onboarding);
  await page.evaluate(() => {
    sessionStorage.setItem("pilot:wallet", JSON.stringify({
      provider: "gemwallet",
      network: "testnet",
      account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
    }));
  });
  await page.context().addCookies([{
    name: "fixture-wallet-authenticated",
    value: "1",
    url: lane.baseURL,
  }]);

  await page.goto(`${pilotRoutes.onboarding}?openrouter=error`);
  await expect(page.getByRole("heading", { name: /Choose model access/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Free demo unavailable/i })).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("The free demo is not configured.");
  await expect(page.getByRole("link", { name: /Connect OpenRouter/i })).toBeVisible();
  expect(boundary.demoSessionResponses).toEqual([]);

  await page.getByRole("button", { name: /Back/i }).click();
  await expect(page.getByRole("link", { name: /Explore the read-only demo/i })).toBeVisible();
});

test("OpenRouter error recovery rejects stored Xaman with the exact unavailable reason", async ({
  page,
  lane,
}) => {
  requireLane(lane, "fixture");
  const boundary: RequestBoundary = {
    modelRequests: [],
    forbiddenBeforeWalletProof: [],
    demoSessionResponses: [],
  };
  await installWalletFirstRoutes(page, boundary);
  await page.goto(pilotRoutes.onboarding);
  await page.evaluate(() => {
    sessionStorage.setItem("pilot:wallet", JSON.stringify({
      provider: "xaman",
      network: "testnet",
      account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
    }));
  });
  await page.context().addCookies([{
    name: "fixture-wallet-authenticated",
    value: "1",
    url: lane.baseURL,
  }]);

  await page.goto(`${pilotRoutes.onboarding}?openrouter=error`);
  await expect(page.getByRole("heading", { name: /Authenticate your budget wallet/i })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Xaman needs an app API key" })).toContainText(
    "Xaman needs an app API key, and the current adapter cannot sign Pilot's non-broadcast wallet-auth proof safely.",
  );
  expect(boundary.modelRequests).toEqual([]);
  expect(boundary.demoSessionResponses).toEqual([]);
});

test("OpenRouter denial restores the exact wallet before demo activation", async ({
  page,
  lane,
  evidence,
}) => {
  requireLane(lane, "fixture");
  const boundary: RequestBoundary = {
    modelRequests: [],
    forbiddenBeforeWalletProof: [],
    demoSessionResponses: [],
  };
  await installGemWalletReconnectFixture(page);
  await installWalletFirstRoutes(page, boundary);
  await page.goto(pilotRoutes.onboarding);
  await page.evaluate(({ account }) => {
    sessionStorage.setItem("pilot:wallet", JSON.stringify({
      provider: "gemwallet",
      network: "testnet",
      account,
    }));
  }, { account: FIXTURE_ACCOUNT });
  await page.context().addCookies([{
    name: "fixture-wallet-authenticated",
    value: "1",
    url: lane.baseURL,
  }]);

  await page.goto(`${pilotRoutes.onboarding}?openrouter=error`);
  await expect(page.getByRole("heading", { name: /Choose model access/i })).toBeVisible();
  await expect(page.getByText(/No provider credential was saved/i)).toBeVisible();
  await page.getByRole("button", { name: /Try free demo/i }).click();

  await expect(page.getByRole("heading", { name: /Wallet and model ready/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Enable Testnet trading/i })).toBeVisible();
  expect(boundary.demoSessionResponses).toHaveLength(1);
  expect(boundary.forbiddenBeforeWalletProof).toEqual([]);

  evidence.record("wallet-bound-demo-recovery-fixture", {
    evidenceKind: "mock-provider-conformance",
    walletReconnect: "stubbed GemWallet reconnect matched the authenticated wallet session",
    providerGrantCompleted: false,
    realModelResponse: false,
    ledgerTransaction: false,
    assertion:
      "After a simulated provider denial, Pilot restored the exact wallet facade before accepting the demo session and did not submit a ledger transaction.",
  });
});

test("logged-out chat remains a local scripted exploration with no model or ledger authority", async ({
  page,
  lane,
  evidence,
}) => {
  requireLane(lane, "fixture");
  const unexpected: string[] = [];
  await installFixtureChatPrerequisites(page);
  await page.route("**/api/config/public", async (route) => {
    await route.fulfill({
      json: {
        network: "testnet",
        stableAsset: {
          currency: "RLUSD",
          issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
        },
        devSignerEnabled: false,
        walletActionProofRequired: true,
        walletActionProofConfigured: true,
        mockMode: false,
      },
    });
  });
  page.on("request", (request) => {
    const target = new URL(request.url());
    if (target.origin !== lane.baseURL ||
      target.pathname === "/api/chat" ||
      target.pathname.startsWith("/api/auth/openrouter/") ||
      target.pathname.startsWith("/api/harbor/") ||
      target.pathname.startsWith("/api/dev/") ||
      target.pathname.startsWith("/api/ledger-sim/")) {
      unexpected.push(`${request.method()} ${request.url()}`);
    }
  });

  await page.goto(pilotRoutes.chat);
  await expect(page.getByText("This is a simulated demo.", { exact: false })).toBeVisible();
  await page.getByRole("textbox", { name: /Message Pilot/i }).fill("Show me a safe swap demo");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(/simulated|demo/i).first()).toBeVisible();
  expect(unexpected).toEqual([]);

  evidence.record("logged-out-local-exploration", {
    evidenceKind: "scripted-browser-fixture",
    walletConnected: false,
    providerCalled: false,
    ledgerCalled: false,
    assertion: "The logged-out exploration stayed inside browser-local scripted behavior.",
  });
});
