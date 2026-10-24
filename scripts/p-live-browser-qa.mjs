#!/usr/bin/env node

import { chromium } from "@playwright/test";

const baseUrl = process.env.PILOT_URL ?? "http://127.0.0.1:3003";
const owner = process.env.P_LIVE_OWNER_ADDRESS;
const executablePath = process.env.CHROME_PATH;

const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
try {
  const results = [];
  for (const width of [375, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    if (owner) {
      await context.addInitScript(({ address }) => {
        sessionStorage.setItem(
          "pilot:onboarding",
          JSON.stringify({
            account: address,
            budget_account: address,
            network: "testnet",
            status: "pending",
          }),
        );
        sessionStorage.setItem(
          "pilot:wallet",
          JSON.stringify({ provider: "dev", network: "testnet", account: address }),
        );
      }, { address: owner });
    }
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    const failedResponses = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 400) {
        failedResponses.push(`${response.status()} ${response.url()}`);
      }
    });
    const browserAuthorizationHeaders = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/harbor/")) {
        const authorization = request.headers().authorization;
        if (authorization) browserAuthorizationHeaders.push(authorization);
      }
    });

    for (const path of ["/onboarding", "/chat", "/portfolio", "/map", "/memory"]) {
      const response = await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle" });
      if (!response?.ok()) throw new Error(`${path} returned HTTP ${response?.status()}`);
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      if (overflow) throw new Error(`${path} has horizontal overflow at ${width}px`);
    }

    await page.goto(`${baseUrl}/chat`, { waitUntil: "networkidle" });
    await page.getByText("Live Harbor", { exact: true }).waitFor({ state: "attached" });
    await page.goto(`${baseUrl}/portfolio`, { waitUntil: "networkidle" });
    const portfolioState = owner
      ? await page.getByText(/Budget-only live|Subscribed to distinct/i).first().textContent()
      : "no owner supplied";
    if (browserAuthorizationHeaders.length) {
      throw new Error("Browser Harbor request contained an Authorization header");
    }
    const unexpectedConsoleErrors = consoleErrors.filter(
      (message) => !message.includes("favicon") && !message.startsWith("Failed to load resource:"),
    );
    const unexpectedResponses = failedResponses.filter((entry) => !entry.endsWith("/favicon.ico"));
    if (unexpectedConsoleErrors.length > 0 || pageErrors.length > 0 || unexpectedResponses.length > 0) {
      throw new Error(
        `Browser errors at ${width}px: ${[
          ...unexpectedConsoleErrors,
          ...pageErrors,
          ...unexpectedResponses,
        ].join(" | ")}`,
      );
    }
    results.push({
      width,
      consoleErrors: unexpectedConsoleErrors,
      failedResponses: unexpectedResponses,
      pageErrors,
      portfolioState,
      browserAuthorizationHeaderCount: browserAuthorizationHeaders.length,
    });
    await context.close();
  }
  process.stdout.write(`${JSON.stringify({ action: "browser-qa", results })}\n`);
} finally {
  await browser.close();
}
