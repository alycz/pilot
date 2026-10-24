import type { Page } from "@playwright/test";

export const WALLET_FIXTURE_ACCOUNT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
export const WALLET_FIXTURE_MODEL = "openai/gpt-oss-20b:free";

export type WalletSessionFixtureState = "anonymous" | "authenticated" | "expired";

export type WalletOnboardingBoundary = {
  modelRequests: string[];
  tradingRequests: string[];
  walletChallengeRequests: string[];
  walletSessionMethods: string[];
  demoSessionWrites: string[];
  externalRequests: string[];
  postLogoutSensitiveRequests: string[];
};

export type WalletOnboardingRouteOptions = {
  baseURL: string;
  demoModelsUnavailable?: boolean;
  oauthConnected?: boolean;
  walletSession?: WalletSessionFixtureState;
  logoutFails?: boolean;
};

export function createWalletOnboardingBoundary(): WalletOnboardingBoundary {
  return {
    modelRequests: [],
    tradingRequests: [],
    walletChallengeRequests: [],
    walletSessionMethods: [],
    demoSessionWrites: [],
    externalRequests: [],
    postLogoutSensitiveRequests: [],
  };
}

export async function installWalletOnboardingRoutes(
  page: Page,
  boundary: WalletOnboardingBoundary,
  options: WalletOnboardingRouteOptions,
): Promise<void> {
  let walletState = options.walletSession ?? "anonymous";
  let oauthConnected = options.oauthConnected === true;
  let modelSelected = oauthConnected;
  let logoutObserved = false;
  const expectedOrigin = new URL(options.baseURL).origin;

  page.on("request", (request) => {
    const target = new URL(request.url());
    const requestLabel = `${request.method()} ${target.pathname}`;
    if (target.origin !== expectedOrigin) boundary.externalRequests.push(request.url());

    if (
      target.pathname === "/api/auth/openrouter/models" ||
      target.pathname === "/api/auth/openrouter/start" ||
      target.pathname === "/api/auth/openrouter/session"
    ) {
      boundary.modelRequests.push(requestLabel);
    }
    if (
      target.pathname.startsWith("/api/dev/") ||
      target.pathname.startsWith("/api/harbor/") ||
      target.pathname.startsWith("/api/onboarding/trustset/") ||
      target.pathname.startsWith("/api/ledger-sim/") ||
      target.pathname.startsWith("/api/strategy/")
    ) {
      boundary.tradingRequests.push(requestLabel);
    }
    if (target.pathname === "/api/auth/wallet/challenge") {
      boundary.walletChallengeRequests.push(requestLabel);
    }
    if (target.pathname === "/api/auth/wallet/session") {
      boundary.walletSessionMethods.push(request.method());
      if (request.method() === "DELETE") logoutObserved = true;
    }
    if (
      logoutObserved && (
        target.pathname === "/api/auth/openrouter/models" ||
        target.pathname === "/api/auth/openrouter/start" ||
        target.pathname === "/api/auth/openrouter/session" ||
        target.pathname === "/api/auth/wallet/challenge" ||
        (target.pathname === "/api/auth/wallet/session" && request.method() === "POST") ||
        target.pathname.startsWith("/api/dev/") ||
        target.pathname.startsWith("/api/harbor/") ||
        target.pathname.startsWith("/api/onboarding/trustset/") ||
        target.pathname.startsWith("/api/ledger-sim/") ||
        target.pathname.startsWith("/api/strategy/")
      )
    ) {
      boundary.postLogoutSensitiveRequests.push(requestLabel);
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
        account: WALLET_FIXTURE_ACCOUNT,
        network: "testnet",
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        tx_json: {
          TransactionType: "AccountSet",
          Account: WALLET_FIXTURE_ACCOUNT,
          Sequence: 0,
          Fee: "0",
          LastLedgerSequence: 0,
          Memos: [{ Memo: { MemoType: "70696C6F742D77616C6C65742D617574682D7631" } }],
        },
      },
    });
  });

  await page.route("**/api/auth/wallet/session", async (route) => {
    const method = route.request().method();
    if (method === "DELETE") {
      if (options.logoutFails) {
        await route.fulfill({ status: 503, json: { error: "Fixture wallet sign-out failed." } });
        return;
      }
      walletState = "anonymous";
      oauthConnected = false;
      modelSelected = false;
      await route.fulfill({ json: { authenticated: false } });
      return;
    }
    if (method === "POST") walletState = "authenticated";

    await route.fulfill({
      json: walletState === "anonymous"
        ? { authenticated: false }
        : {
            authenticated: true,
            account: WALLET_FIXTURE_ACCOUNT,
            network: "testnet",
            expiresAt: walletState === "expired"
              ? Date.now() - 1_000
              : Date.now() + 60 * 60_000,
          },
    });
  });

  await page.route("**/api/auth/openrouter/models**", async (route) => {
    if (options.demoModelsUnavailable) {
      await route.fulfill({
        status: 503,
        json: { error: "The free demo is not configured.", code: "DEMO_MISCONFIGURED" },
      });
      return;
    }
    await route.fulfill({
      json: {
        defaultModel: WALLET_FIXTURE_MODEL,
        models: [{ id: WALLET_FIXTURE_MODEL, name: "Fixture free model" }],
      },
    });
  });

  await page.route("**/api/auth/openrouter/session", async (route) => {
    const method = route.request().method();
    const authenticated = walletState !== "anonymous";
    if (method === "DELETE") {
      oauthConnected = false;
      modelSelected = false;
      await route.fulfill({
        status: authenticated ? 200 : 401,
        json: { connected: false, selected: false },
      });
      return;
    }
    if (method === "POST") modelSelected = true;
    const connected = method === "GET" && authenticated && oauthConnected;
    const response = {
      connected,
      selected: modelSelected,
      mode: connected ? "oauth" : "demo",
      model: WALLET_FIXTURE_MODEL,
      demo: {
        available: !options.demoModelsUnavailable,
        costPolicy: "free-only",
        maxInputBytes: 4_096,
        maxOutputTokens: 256,
        maxSteps: 3,
      },
    };
    if (method === "POST") boundary.demoSessionWrites.push(JSON.stringify(response));
    await route.fulfill({
      status: authenticated ? 200 : 401,
      json: response,
    });
  });
}

export async function installSyntheticGemWallet(
  page: Page,
  options: {
    installed?: boolean;
    network?: "Mainnet" | "Testnet";
    account?: string;
    connectOutcomes?: Array<"success" | "rejected">;
    proofOutcomes?: Array<"success" | "rejected">;
    proofDelayMs?: number;
  } = {},
): Promise<void> {
  await page.addInitScript((fixture) => {
    const fixtureWindow = window as unknown as {
      gemWallet?: boolean;
      __pilotWalletOnboardingFixtureCalls?: string[];
    };
    fixtureWindow.__pilotWalletOnboardingFixtureCalls = [];
    const installed = fixture.installed !== false;
    const connectOutcomes = [...fixture.connectOutcomes];
    const proofOutcomes = [...fixture.proofOutcomes];
    if (installed) {
      fixtureWindow.gemWallet = true;
    }
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.data?.source !== "GEM_WALLET_MSG_REQUEST") return;
      const request = event.data as { messageId?: number; type?: string };
      if (request.type) fixtureWindow.__pilotWalletOnboardingFixtureCalls?.push(request.type);
      let response: Record<string, unknown> | undefined;
      if (request.type === "REQUEST_IS_INSTALLED/V3") {
        response = { isInstalled: installed };
      } else if (installed && request.type === "REQUEST_GET_PUBLIC_KEY/V3") {
        const outcome = connectOutcomes.shift() ?? "success";
        response = outcome === "rejected"
          ? { type: "reject" }
          : fixture.account
            ? { result: { address: fixture.account, publicKey: "fixture-public-key" } }
            : { result: {} };
      } else if (installed && request.type === "REQUEST_GET_NETWORK/V3") {
        response = {
          result: {
            chain: "XRPL",
            network: fixture.network ?? "Testnet",
            websocket: "wss://fixture.invalid",
          },
        };
      } else if (installed && request.type === "REQUEST_SIGN_TRANSACTION/V3") {
        const outcome = proofOutcomes.shift() ?? "success";
        response = outcome === "rejected"
          ? { type: "reject" }
          : { result: { signature: "DEADBEEF" } };
      }
      if (!response) return;
      const postResponse = () => window.postMessage({
          source: "GEM_WALLET_MSG_RESPONSE",
          messagedId: request.messageId,
          ...response,
        }, window.location.origin);
      if (request.type === "REQUEST_SIGN_TRANSACTION/V3" && fixture.proofDelayMs > 0) {
        window.setTimeout(postResponse, fixture.proofDelayMs);
      } else {
        postResponse();
      }
    });
  }, {
    installed: options.installed ?? true,
    network: options.network ?? "Testnet",
    account: options.account ?? WALLET_FIXTURE_ACCOUNT,
    connectOutcomes: options.connectOutcomes ?? [],
    proofOutcomes: options.proofOutcomes ?? [],
    proofDelayMs: options.proofDelayMs ?? 0,
  });
}

export async function readSyntheticGemWalletCalls(page: Page): Promise<string[]> {
  return page.evaluate(() => [
    ...((window as unknown as { __pilotWalletOnboardingFixtureCalls?: string[] })
      .__pilotWalletOnboardingFixtureCalls ?? []),
  ]);
}

/**
 * Installs the minimum Crossmark window-message surface consumed by
 * xrpl-connect. This is provider-conformance evidence only: it never loads the
 * real extension and every response stays inside the fixture page.
 */
export async function installSyntheticCrossmark(
  page: Page,
  options: {
    installed?: boolean;
    network?: "Mainnet" | "Testnet";
    account?: string;
    connectOutcomes?: Array<"success" | "rejected">;
    proofOutcomes?: Array<"success" | "rejected">;
    proofDelayMs?: number;
  } = {},
): Promise<void> {
  await page.addInitScript((fixture) => {
    type CrossmarkRequest = {
      app?: string;
      type?: string;
      id?: string;
      command?: string;
      data?: { tx?: { TransactionType?: string } };
    };
    const fixtureWindow = window as unknown as {
      xrpl?: { isCrossmark?: boolean };
      __pilotCrossmarkFixtureCalls?: string[];
    };
    const installed = fixture.installed !== false;
    const connectOutcomes = [...fixture.connectOutcomes];
    const proofOutcomes = [...fixture.proofOutcomes];
    fixtureWindow.__pilotCrossmarkFixtureCalls = [];
    if (installed) {
      fixtureWindow.xrpl = {
        ...fixtureWindow.xrpl,
        isCrossmark: true,
      };
    }

    window.addEventListener("message", (event) => {
      if (
        event.source !== window ||
        event.origin !== window.location.origin ||
        event.data?.app !== "crossmark" ||
        event.data?.type !== "request"
      ) return;

      const request = event.data as CrossmarkRequest;
      if (!installed || !request.id || !request.command) return;
      const transactionType = request.data?.tx?.TransactionType;
      fixtureWindow.__pilotCrossmarkFixtureCalls?.push(
        transactionType ? `${request.command}:${transactionType}` : request.command,
      );

      const network = {
        protocol: "xrpl",
        type: (fixture.network ?? "Testnet").toLowerCase(),
        label: "XRPL",
        wss: "wss://fixture.invalid",
        rpc: "https://fixture.invalid",
      };
      let data: Record<string, unknown>;
      if (request.command === "network") {
        data = { network };
      } else if (request.command === "user") {
        data = {
          user: {
            id: "fixture-user",
            username: "fixture-user",
            type: "test",
            developer: true,
          },
        };
      } else if (request.command === "address") {
        data = { address: fixture.account };
      } else if (request.command === "sign" && transactionType === "SignIn") {
        const outcome = connectOutcomes.shift() ?? "success";
        data = outcome === "success"
          ? {
              address: fixture.account,
              publicKey: "fixture-crossmark-public-key",
              network,
              user: {
                id: "fixture-user",
                username: "fixture-user",
                type: "test",
                developer: true,
              },
              meta: { isRejected: false },
            }
          : { meta: { isRejected: true, reason: outcome } };
      } else if (request.command === "sign") {
        const outcome = proofOutcomes.shift() ?? "success";
        data = outcome === "success"
          ? {
              txBlob: "DEADBEEF",
              meta: { isRejected: false },
            }
          : { meta: { isRejected: true, reason: outcome } };
      } else {
        return;
      }

      const postResponse = () => {
        const now = Date.now();
        window.postMessage({
          app: "crossmark",
          type: "response",
          request,
          response: {
            app: "crossmark",
            type: "response",
            id: request.id,
            data,
          },
          createdAt: now,
          resolvedAt: now,
        }, window.location.origin);
      };
      if (
        request.command === "sign" &&
        transactionType === "AccountSet" &&
        fixture.proofDelayMs > 0
      ) {
        window.setTimeout(postResponse, fixture.proofDelayMs);
      } else {
        postResponse();
      }
    });
  }, {
    installed: options.installed ?? true,
    network: options.network ?? "Testnet",
    account: options.account ?? WALLET_FIXTURE_ACCOUNT,
    connectOutcomes: options.connectOutcomes ?? [],
    proofOutcomes: options.proofOutcomes ?? [],
    proofDelayMs: options.proofDelayMs ?? 0,
  });
}

export async function readSyntheticCrossmarkCalls(page: Page): Promise<string[]> {
  return page.evaluate(() => [
    ...((window as unknown as { __pilotCrossmarkFixtureCalls?: string[] })
      .__pilotCrossmarkFixtureCalls ?? []),
  ]);
}
