#!/usr/bin/env node

import { chromium } from "@playwright/test";

const baseUrl = process.env.PILOT_URL ?? "http://127.0.0.1:3003";
const executablePath =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const browser = await chromium.launch({ executablePath, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const browserAuthHeaders = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/harbor/") && request.headers().authorization) {
      browserAuthHeaders.push(request.headers().authorization);
    }
  });
  const waitForSignOnly = async () => {
    const signOnly = page.getByRole("button", { name: "Sign only" });
    try {
      await signOnly.waitFor({ timeout: 45_000 });
    } catch {
      const alerts = await page.locator('[role="alert"]:visible').allTextContents();
      throw new Error(`Onboarding stopped: ${alerts.join(" | ") || "approval modal did not open"}`);
    }
    return signOnly;
  };
  await page.goto(`${baseUrl}/onboarding`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Use free models" }).click();
  await page.getByRole("button", { name: "Connect wallet" }).waitFor();
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: "Create trust line" }).waitFor();
  await page.getByRole("button", { name: "Create trust line" }).click();
  await (await waitForSignOnly()).click();
  await page.getByRole("button", { name: "Done" }).waitFor({ timeout: 45_000 });
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Review DelegateSet" }).waitFor({ timeout: 45_000 });
  await page.getByRole("button", { name: "Review DelegateSet" }).click();
  await (await waitForSignOnly()).click();
  await page.getByRole("button", { name: "Done" }).waitFor({ timeout: 45_000 });
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByText("Setup complete", { exact: true }).waitFor({ timeout: 45_000 });

  const result = await page.evaluate(() => {
    const wallet = JSON.parse(sessionStorage.getItem("pilot:wallet") ?? "null");
    const onboarding = JSON.parse(sessionStorage.getItem("pilot:onboarding") ?? "null");
    return {
      account: wallet?.account,
      network: wallet?.network,
      provider: wallet?.provider,
      status: onboarding?.status,
      txHash: onboarding?.txHash,
    };
  });
  await page.goto(`${baseUrl}/portfolio`, { waitUntil: "networkidle" });
  await page.getByText(/Budget-only live|Subscribed to distinct/i).first().waitFor({ timeout: 45_000 });
  const portfolioStatus = await page.getByText(/Budget-only live|Subscribed to distinct/i).first().textContent();
  if (browserAuthHeaders.length) {
    throw new Error("Browser Harbor request contained an Authorization header");
  }
  process.stdout.write(`${JSON.stringify({
    action: "onboarding-browser-qa",
    ...result,
    portfolioStatus,
    permissionsConfirmed: result.status === "active",
    browserAuthorizationHeaderCount: browserAuthHeaders.length,
    readyForHumanGemWallet: result.status === "active" && typeof result.txHash === "string",
  })}\n`);
  await context.close();
} finally {
  await browser.close();
}
