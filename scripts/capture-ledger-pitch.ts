import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { fixtureEvent } from "../apps/web/app/chat/fixtures";
import { DemoApprovalDialog } from "../apps/web/components/chat/demo-approval-dialog";
import { LedgerApprovalSection } from "../apps/web/components/landing/ledger-approval-section";
import { SimulatedDevice } from "../apps/web/components/ledger/simulated-device";
import trustSetTranscript from "../apps/web/components/ledger/transcripts/trust-set.json";

const appRequire = createRequire(path.join(process.cwd(), "apps/web/package.json"));
const React = appRequire("react") as {
  createElement: (...arguments_: unknown[]) => unknown;
};
const { renderToStaticMarkup } = appRequire("react-dom/server") as {
  renderToStaticMarkup: (node: unknown) => string;
};

const evidenceDirectory = path.join(process.cwd(), "test-results/playwright/ledger-pitch");
const compiledCssPath = path.join(
  process.cwd(),
  "apps/web/.next/static/css/app/layout.css",
);
const expectedCssSha256 =
  "a7b11ef6196734a321eb00761b08def807294ce44066764f39761db9a23bfb85";

async function readCompiledCss() {
  const css = await readFile(compiledCssPath, "utf8");
  const actualSha256 = createHash("sha256").update(css).digest("hex");
  if (actualSha256 !== expectedCssSha256) {
    throw new Error(
      `Ledger pitch capture CSS hash mismatch: expected ${expectedCssSha256}, got ${actualSha256}`,
    );
  }
  return css;
}

function documentFor(markup: string, css: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>${css}</style>
    <style>
      html, body { margin: 0; min-height: 100%; }
      body { background: #f4f3ef; color: #161615; }
    </style>
  </head>
  <body>${markup}</body>
</html>`;
}

const recordedOffer = {
  TransactionType: "OfferCreate",
  Account: "ra7Zr8ddy9tB88RaXL8B87YkqhEJG2vkAJ",
  Flags: 0x0004_0000,
  TakerPays: {
    currency: "RLUSD",
    issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
    value: "100",
  },
  TakerGets: "75000000",
  Fee: "12",
};

const fixture = fixtureEvent("awaiting_approval");
const approvalEvent = {
  ...fixture,
  build: fixture.build
    ? { ...fixture.build, tx_json: recordedOffer }
    : undefined,
  exec:
    fixture.exec?.status === "needs_approval"
      ? { ...fixture.exec, tx_json: recordedOffer }
      : fixture.exec,
};

async function main() {
  await mkdir(evidenceDirectory, { recursive: true });
  const css = await readCompiledCss();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  const forbiddenRequests: string[] = [];
  await page.route(/^https?:/u, async (route) => {
    forbiddenRequests.push(route.request().url());
    await route.abort("blockedbyclient");
  });

  try {
    const landingMarkup = renderToStaticMarkup(
      React.createElement(LedgerApprovalSection, {
        trustSetDevicePreview: React.createElement(SimulatedDevice, {
          transcript: trustSetTranscript,
        }),
      }),
    );
    await page.setContent(documentFor(landingMarkup, css), { waitUntil: "load" });
    const landing = page.locator("section[aria-labelledby='ledger-approval-heading']");
    await landing.waitFor({ state: "visible" });
    const landingText = await landing.textContent();
    for (const expected of [
      "Set the RLUSD trust line",
      "TrustSet",
      "Simulated evidence only.",
      "Physical-Ledger and live-Testnet checks are still pending",
    ]) {
      if (!landingText?.includes(expected)) {
        throw new Error(`Landing evidence is missing required copy: ${expected}`);
      }
    }
    await landing.screenshot({
      path: path.join(evidenceDirectory, "lg7-landing-trustset.png"),
    });

    const approvalMarkup = renderToStaticMarkup(
      React.createElement(DemoApprovalDialog, {
        event: approvalEvent,
        reducedMotion: true,
        onClose: () => undefined,
        onSubmitted: () => undefined,
        onValidated: () => undefined,
      }),
    );
    await page.setContent(documentFor(approvalMarkup, css), { waitUntil: "load" });
    const approval = page.locator("[role='dialog']");
    await approval.waitFor({ state: "visible" });
    const approvalText = await approval.textContent();
    for (const expected of [
      "Review what your wallet would show",
      "Recorded demo · no signing",
      "This is a demo. No wallet opens and nothing reaches the ledger.",
    ]) {
      if (!approvalText?.includes(expected)) {
        throw new Error(`Approval evidence is missing required copy: ${expected}`);
      }
    }
    await approval.screenshot({
      path: path.join(evidenceDirectory, "lg4-logged-out-approval-dialog.png"),
    });

    if (forbiddenRequests.length !== 0) {
      throw new Error(
        `Static Ledger pitch capture attempted network requests: ${forbiddenRequests.join(", ")}`,
      );
    }
  } finally {
    await browser.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
