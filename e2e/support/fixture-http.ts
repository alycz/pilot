import type { CardEvent } from "@pilot/contracts";
import type { Page, Route } from "@playwright/test";

const TESTNET_RLUSD_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const FIXTURE_MODEL = "openai/gpt-oss-20b:free";

export async function installFixtureChatPrerequisites(
  page: Page,
  options: { personalization?: boolean; ledger?: boolean } = {},
): Promise<void> {
  await page.route("**/api/config/public", async (route) => {
    await route.fulfill({
      json: {
        network: "testnet",
        stableAsset: { currency: "RLUSD", issuer: TESTNET_RLUSD_ISSUER },
        devSignerEnabled: false,
        walletActionProofRequired: false,
        walletActionProofConfigured: false,
        mockMode: true,
        ...(options.ledger
          ? {
              ledger: {
                enabled: true,
                transports: ["virtual"],
                defaultAccountIndex: 0,
              },
            }
          : {}),
        ...(options.personalization ? { structuredPreferencesEnabled: true } : {}),
      },
    });
  });
  await page.route("**/api/auth/wallet/session", async (route) => {
    await route.fulfill({ json: { authenticated: false } });
  });
  await page.route("**/api/auth/openrouter/session", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      json: { mode: "demo", model: FIXTURE_MODEL, connected: false },
    });
  });
}

export type PilotFixtureStream = Readonly<{
  text?: string | readonly string[];
  cards?: readonly CardEvent[];
}>;

function streamPart(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

export async function fulfillPilotStream(
  route: Route,
  stream: PilotFixtureStream,
): Promise<void> {
  const text = typeof stream.text === "string"
    ? [stream.text]
    : [...(stream.text ?? [])];
  const textId = "fixture-text";
  const body = [
    ...(text.length > 0
      ? [
          streamPart({ type: "text-start", id: textId }),
          ...text.map((delta) =>
            streamPart({ type: "text-delta", id: textId, delta })
          ),
          streamPart({ type: "text-end", id: textId }),
        ]
      : []),
    ...(stream.cards ?? []).map((card) =>
      streamPart({ type: "data-card", data: card })
    ),
    "data: [DONE]\n\n",
  ].join("");

  await route.fulfill({
    status: 200,
    body,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/event-stream; charset=utf-8",
      "x-vercel-ai-ui-message-stream": "v1",
    },
  });
}
