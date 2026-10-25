import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";

import { resolveFixtureAppOrigin } from "./support/fixture-app-origin";

const screenshotDirectory = path.join(process.cwd(), "status", "P-qn-screens");
const prompt = "Swap 80 RLUSD for XRP, then show the QuickNode Streams freeze outside Harbor.";
const txHash = "C".repeat(64);

const validatedCard = {
  intent_id: "intent-qn5-visual",
  state: "validated",
  at: "2026-10-21T12:00:04.200Z",
  intent: {
    id: "intent-qn5-visual",
    network: "testnet",
    kind: "swap",
    sell: { currency: "RLUSD", issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" },
    buy: { currency: "XRP" },
    amount: "80",
    side: "sell",
    max_slippage_bps: 100,
  },
  hash: txHash,
  trust: {
    screen: { provider: "mock", fields_checked: 3, fields_blocked: 0, max_score: 0 },
    model: { provider: "bedrock-mock", id: "anthropic.claude-sonnet-4-5-v1:0" },
    signer: { kind: "aws-kms-kek", key_ref: "alias/harbor/kek" },
    rpc: "quicknode-mock",
    confirmation: {
      provider: "quicknode-mock",
      at: "2026-10-21T12:00:04.200Z",
      latency_ms: 4_200,
    },
    watch: { provider: "quicknode-mock", status: "frozen" },
  },
} as const;

const watchdog = {
  tx_hash: txHash,
  account: "rPT7vGmYxnV6wNP9RC2Mm3Fp9NBH3bK",
  delegate: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
  class: "out_of_band_delegate",
  flags: ["tx_type_not_delegated"],
  ledger_index: 9_843_207,
  close_time: "2026-10-21T12:00:04.200Z",
  action: "frozen",
  next_step: "owner_revoke_onledger",
} as const;

const mockLiveCards = [
  "drafting",
  "planned",
  "simulated",
  "policy_checked",
  "executing",
  "submitted",
  "validated",
].map((state) => ({
  ...validatedCard,
  state,
  ...(state === "validated" ? {} : { trust: undefined, hash: undefined }),
}));

const mockLiveStream = [
  ...mockLiveCards.map((data) => `data: ${JSON.stringify({ type: "data-card", data })}`),
  `data: ${JSON.stringify({ type: "data-watchdog", data: watchdog })}`,
  `data: ${JSON.stringify({ type: "text-delta", delta: "Mock-only QuickNode visibility completed without a provider or ledger call." })}`,
  "data: [DONE]",
  "",
].join("\n");

test.beforeAll(async () => {
  await mkdir(screenshotDirectory, { recursive: true });
});

test.beforeEach(async ({ page, baseURL }) => {
  const appOrigin = resolveFixtureAppOrigin(baseURL);
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      await route.fallback();
      return;
    }
    if (url.origin === appOrigin) {
      if (url.pathname.startsWith("/api/")) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.fallback();
      return;
    }
    await route.abort("blockedbyclient");
  });
});

test("renders intercepted mock-live QuickNode trust and freeze evidence", async ({ page }) => {
  await installAuthFixture(page, true);
  await page.route("**/api/chat", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: mockLiveStream,
    });
  });
  await submitPrompt(page);
  await assertAndCaptureChat(page, submittedTurn(page), "qn5-mock-live");
});

test("renders the logged-out QuickNode demo", async ({ page }) => {
  await installAuthFixture(page, false);
  await submitPrompt(page);
  const turn = submittedTurn(page);
  await assertAndCaptureChat(page, turn, "qn5-logged-out-demo", true);
});

test("renders the logged-out QuickNode account panel", async ({ page }) => {
  await installAuthFixture(page, false);
  await page.goto("/portfolio");
  const panel = page.getByRole("region", { name: "QuickNode" });
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByText("84%", { exact: true })).toBeVisible();
  await panel.screenshot({
    animations: "disabled",
    path: path.join(screenshotDirectory, "qn5-logged-out-demo-panel.png"),
  });
});

async function installAuthFixture(page: Page, authenticated: boolean) {
  await page.route("**/api/config/public", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        network: "testnet",
        stableAsset: {
          currency: "RLUSD",
          issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
        },
        devSignerEnabled: false,
        walletActionProofRequired: false,
        walletActionProofConfigured: false,
        mockMode: authenticated,
      }),
    });
  });
  await page.route("**/api/auth/wallet/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(authenticated
        ? {
            authenticated: true,
            account: watchdog.account,
            network: "testnet",
          }
        : { authenticated: false }),
    });
  });
  await page.route("**/api/auth/openrouter/session", async (route) => {
    await route.fulfill({
      status: authenticated ? 200 : 401,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(authenticated
        ? { authenticated: true, model: "anthropic.claude-sonnet-4-5-v1:0" }
        : { authenticated: false }),
    });
  });
}

async function submitPrompt(page: Page) {
  await page.goto("/chat");
  await page.addStyleTag({
    content: "html { scroll-behavior: auto !important; } *, *::before, *::after { animation: none !important; transition: none !important; }",
  });
  await page.getByLabel("Message Pilot").fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
}

function submittedTurn(page: Page) {
  return page.locator("article").filter({ has: page.getByText(prompt, { exact: true }) });
}

async function assertAndCaptureChat(
  page: Page,
  turn: Locator,
  prefix: string,
  demoPresentation = false,
) {
  const receipt = turn.getByLabel(demoPresentation
    ? "Capability preview"
    : "AWS and QuickNode trust receipt");
  await expect(receipt).toBeVisible({ timeout: 15_000 });
  if (demoPresentation) {
    await expect(receipt.getByText("Demo", { exact: true })).toHaveCount(0);
    await expect(receipt.getByText("QuickNode RPC", { exact: true })).toBeVisible();
    await expect(receipt.getByText("QuickNode webhook", { exact: true })).toBeVisible();
    await expect(receipt.getByText("QuickNode Streams", { exact: true })).toBeVisible();
    await expect(receipt.getByText(/\(mock\)/)).toHaveCount(0);
  } else {
    await expect(receipt.getByText("RPC · QuickNode (mock)", { exact: true })).toBeVisible();
    await expect(receipt.getByText("Confirmed · QuickNode webhook (mock) · 4.2 s", { exact: true })).toBeVisible();
    await expect(receipt.getByText("Watched · QuickNode Streams (mock)", { exact: true })).toBeVisible();
  }
  const banner = turn.getByRole("alert", { name: "QuickNode Streams freeze notice" });
  await expect(banner).toBeVisible();
  await expect(banner.getByRole("link", { name: "Revoke on-ledger" })).toHaveAttribute("href", "/onboarding?action=revoke");
  // Mock/demo hashes are illustrative identifiers, not validated-ledger
  // receipts. Explorer links are reserved for trusted live API evidence.
  await expect(banner.getByRole("link", { name: /View transaction/ })).toHaveCount(0);
  await receipt.locator("..").screenshot({
    animations: "disabled",
    path: path.join(screenshotDirectory, `${prefix}-trust-card.png`),
  });
  await banner.screenshot({
    animations: "disabled",
    path: path.join(screenshotDirectory, `${prefix}-freeze-banner.png`),
  });
}
