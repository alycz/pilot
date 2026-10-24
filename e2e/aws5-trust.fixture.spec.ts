import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";

import { fixtureSequence } from "../apps/web/app/chat/fixtures";
import { resolveFixtureAppOrigin } from "./support/fixture-app-origin";

const screenshotDirectory = path.join(process.cwd(), "status", "P-aws-screens");

const prompt = "Screen the hidden injection in the token description, then swap 80 RLUSD for XRP.";
const modelId = "anthropic.claude-sonnet-4-5-v1:0";

const guardrailNotice = {
  provider: "mock",
  caveat: "screened-redacted",
  fields_checked: 3,
  fields_blocked: 1,
  blocked_field_kinds: ["token-description"],
} as const;

const validatedCard = {
  intent_id: "intent-aws5-visual",
  state: "validated",
  at: "2026-10-18T00:00:00.000Z",
  intent: {
    id: "intent-aws5-visual",
    network: "testnet",
    kind: "swap",
    sell: {
      currency: "RLUSD",
      issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
    },
    buy: { currency: "XRP" },
    amount: "80",
    side: "sell",
    max_slippage_bps: 100,
  },
  build: {
    build_id: "build-aws5-visual",
    network: "testnet",
    tx_json: {
      TransactionType: "OfferCreate",
      Account: "rPT7vGmYxnV6wNP9RC2Mm3Fp9NBH3bK",
    },
    delegable: true,
    simulate: {
      engine_result: "tesSUCCESS",
      engine_result_message: "The deterministic mock transaction would succeed.",
      applied: false,
    },
    preflight: [
      {
        check: "fixture-only",
        pass: true,
        detail: "No network request or ledger submission was made.",
      },
    ],
    summary: {
      action: "Swap RLUSD for XRP",
      account: "rPT7vGmYxnV6wNP9RC2Mm3Fp9NBH3bK",
      amounts: ["80 RLUSD", "XRP at simulated quote"],
      fee_drops: "12",
      reserve_delta_drops: "0",
      est_slippage_bps: 18,
      usd_value: "80",
    },
  },
  hash: "A19F480BF22457EC706F0CFDFF3D8069B5A2A3C45BA14FA1B80C2",
  exec: {
    status: "executed",
    hash: "A19F480BF22457EC706F0CFDFF3D8069B5A2A3C45BA14FA1B80C2",
    ledger_index: 9_843_206,
    result: "filled",
    signed_by: "delegate",
  },
  trust: {
    screen: {
      provider: "mock",
      fields_checked: 3,
      fields_blocked: 1,
      max_score: 0.95,
      blocked_field_kinds: ["token-description"],
    },
    model: {
      provider: "bedrock-mock",
      id: modelId,
    },
    signer: {
      kind: "aws-kms-kek",
      key_ref: "alias/harbor/kek",
    },
  },
} as const;

const liveStream = [
  `data: ${JSON.stringify({ type: "data-guardrailNotice", data: guardrailNotice })}`,
  ...fixtureSequence(prompt).map((event) => `data: ${JSON.stringify({
    type: "data-card",
    data: event.state === "validated"
      ? { ...event, trust: validatedCard.trust }
      : event,
  })}`),
  `data: ${JSON.stringify({ type: "text-delta", delta: "The mock-only trust path completed without contacting AWS or XRPL." })}`,
  "data: [DONE]",
  "",
].join("\n");

test.beforeAll(async () => {
  await mkdir(screenshotDirectory, { recursive: true });
});

test.beforeEach(async ({ page }, testInfo) => {
  const appOrigin = resolveFixtureAppOrigin(testInfo.project.use.baseURL);
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

test("renders deterministic mock-live AWS trust evidence", async ({ page }) => {
  await installAuthFixture(page, true);
  await page.route("**/api/chat", async (route) => {
    const body = route.request().postDataJSON() as {
      messages?: Array<{ content?: unknown; role?: unknown }>;
      model?: unknown;
    };
    expect(body.messages).toEqual([{ role: "user", content: prompt }]);
    expect(body.model).toBe(modelId);
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      headers: {
        "cache-control": "no-cache, no-store",
        connection: "keep-alive",
      },
      body: liveStream,
    });
  });

  await submitPrompt(page);
  const turn = submittedTurn(page);
  await assertAndCaptureTrustEvidence(page, turn, "aws5-mock-live");
});

test("keeps the logged-out demo local without fabricating AWS trust evidence", async ({ page }) => {
  await installAuthFixture(page, false);
  let chatRequests = 0;
  await page.route("**/api/chat", async (route) => {
    chatRequests += 1;
    await route.abort("blockedbyclient");
  });

  await submitPrompt(page);
  const turn = submittedTurn(page);
  await expect(turn.getByText(
    "Simulated · no wallet or ledger transaction",
    { exact: true },
  )).toBeVisible({ timeout: 15_000 });
  await expect(turn.getByLabel("AWS trust receipt")).toHaveCount(0);
  await expect(turn.getByRole("status", {
    name: "AWS Bedrock Guardrails notice",
  })).toHaveCount(0);
  expect(chatRequests).toBe(0);
});

async function installAuthFixture(page: Page, authenticated: boolean) {
  await page.route("**/api/config/public", async (route) => {
    await route.fulfill({
      json: {
        network: "testnet",
        stableAsset: {
          currency: "RLUSD",
          issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
        },
        devSignerEnabled: false,
        walletActionProofRequired: !authenticated,
        walletActionProofConfigured: true,
        mockMode: authenticated,
      },
    });
  });
  await page.route("**/api/auth/wallet/session", async (route) => {
    await route.fulfill({ json: authenticated ? {
      authenticated: true,
      account: "rPT7vGmYxnV6wNP9RC2Mm3Fp9NBH3bK",
      network: "testnet",
      expiresAt: Date.now() + 60_000,
    } : { authenticated: false } });
  });
  await page.route("**/api/auth/openrouter/session", async (route) => {
    if (authenticated) {
      await route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({ connected: true, mode: "openrouter", model: modelId }),
      });
      return;
    }
    await route.fulfill({
      status: 401,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({ authenticated: false }),
    });
  });
}

async function submitPrompt(page: Page) {
  await page.goto("/chat");
  await page.addStyleTag({
    content: "html { scroll-behavior: auto !important; } *, *::before, *::after { animation: none !important; caret-color: transparent !important; transition: none !important; }",
  });
  await page.getByLabel("Message Pilot").fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
}

function submittedTurn(page: Page) {
  return page.locator("article").filter({
    has: page.getByText(prompt, { exact: true }),
  });
}

async function assertAndCaptureTrustEvidence(
  page: Page,
  turn: Locator,
  filePrefix: "aws5-mock-live" | "aws5-logged-out-demo",
) {
  const receipt = turn.getByLabel("AWS trust receipt");
  await expect(receipt).toBeVisible({ timeout: 15_000 });
  await expect(receipt.getByText("Screened by Bedrock Guardrails (mock)", { exact: true })).toBeVisible();
  await expect(receipt.getByText("Model · Amazon Bedrock (mock)", { exact: true })).toBeVisible();
  await expect(receipt.getByText("Key protected by AWS KMS", { exact: true })).toBeVisible();

  const banner = turn.getByRole("status", {
    name: "AWS Bedrock Guardrails notice",
  });
  await expect(banner).toBeVisible();

  // Hide only the named composer surface while capturing scoped evidence.
  // In the persistent harness it is panel-contained rather than viewport-fixed,
  // so walking ancestors by computed positioning can hide the entire harness.
  await page.locator(".pilot-chat-composer").evaluate((element) => {
    (element as HTMLElement).style.display = "none";
  });

  const noHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(noHorizontalOverflow).toBe(true);

  const cardAndReceipt = receipt.locator("..");
  await cardAndReceipt.scrollIntoViewIfNeeded();
  await cardAndReceipt.screenshot({
    animations: "disabled",
    path: path.join(screenshotDirectory, `${filePrefix}-trust-card.png`),
  });
  await banner.scrollIntoViewIfNeeded();
  await banner.screenshot({
    animations: "disabled",
    path: path.join(screenshotDirectory, `${filePrefix}-guardrails-banner.png`),
  });
}
