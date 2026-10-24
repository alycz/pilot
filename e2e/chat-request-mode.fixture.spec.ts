import { expect, fulfillPilotStream, requireLane, test } from "./support";

const ACCOUNT_A = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const ACCOUNT_B = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";

test.beforeEach(({ lane }) => requireLane(lane, "fixture"));

test("request mode is request-scoped across repeat, interruption, reload, navigation, and account switch", async ({ page }) => {
  let activeAccount = ACCOUNT_A;
  const requests: Array<Record<string, unknown>> = [];

  await page.route("**/api/config/public", async (route) => {
    await route.fulfill({ json: {
      network: "testnet",
      stableAsset: { currency: "RLUSD", issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" },
      devSignerEnabled: false,
      walletActionProofRequired: false,
      walletActionProofConfigured: true,
      mockMode: false,
    } });
  });
  await page.route("**/api/auth/wallet/session", async (route) => {
    await route.fulfill({ json: { authenticated: true, account: activeAccount, network: "testnet" } });
  });
  await page.route("**/api/auth/openrouter/session", async (route) => {
    await route.fulfill({ json: { connected: true, mode: "openrouter", model: "fixture/model" } });
  });
  await page.route("**/api/chat", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    requests.push(body);
    const messages = body.messages as Array<{ content?: string }>;
    if (messages[0]?.content?.includes("slow")) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    await fulfillPilotStream(route, { text: "Request scope received. No authority was created." }).catch(() => undefined);
  });

  await page.goto("/chat");
  const mode = page.getByRole("button", { name: "Request mode" });
  const chooseMode = async (label: "Let agent choose" | "One-time" | "Recurring" | "Autonomous") => {
    await mode.click();
    await page.getByRole("option", { name: label }).click();
  };
  const composer = page.getByRole("textbox", { name: "Message Pilot" });
  await expect(mode).toHaveAttribute("data-value", "auto");
  await expect(page.getByText(/Recommendation: Needs scope/)).toBeVisible();

  await composer.fill("Trade XRP");
  await expect(page.getByText(/Recommendation: Needs scope/)).toBeVisible();
  await chooseMode("One-time");
  await composer.fill("Swap 10 RLUSD for XRP");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Request scope received. No authority was created.")).toBeVisible();
  await expect(page.getByLabel("Request scope").last()).toContainText("One-time");
  expect(requests[0]?.request_mode).toBe("one_time");

  // Changing the current selector must not reinterpret Repeat; it reuses the
  // original request's exact mode.
  await chooseMode("Autonomous");
  await page.getByRole("button", { name: "Repeat" }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]?.request_mode).toBe("one_time");

  await chooseMode("Recurring");
  await composer.fill("slow recurring buy of 10 RLUSD every day");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("button", { name: "Stop streaming" })).toBeVisible();
  await page.getByRole("button", { name: "Stop streaming" }).click();
  await expect(page.getByText(/Stopped before any transaction tool completed/)).toBeVisible();
  await expect(page.getByLabel("Request scope").last()).toContainText("Recurring");
  expect(requests[2]?.request_mode).toBe("recurring");

  await chooseMode("Autonomous");
  await page.reload();
  await expect(mode).toHaveAttribute("data-value", "auto");

  await chooseMode("Recurring");
  activeAccount = ACCOUNT_B;
  await page.goto("/chat?account-switch=1");
  await expect(mode).toHaveAttribute("data-value", "auto");
  await expect(page.getByText(/rPT1Sj…bpAYe/)).toBeVisible();

  await chooseMode("Autonomous");
  await page.goto("/");
  await page.goto("/chat?after-navigation=1");
  await expect(mode).toHaveAttribute("data-value", "auto");

  for (const body of requests) {
    const serialized = JSON.stringify(body).toLowerCase();
    expect(serialized).not.toContain(ACCOUNT_A.toLowerCase());
    expect(serialized).not.toContain(ACCOUNT_B.toLowerCase());
    expect(serialized).not.toContain("seed");
    expect(serialized).not.toContain("cookie");
  }
  const storageKeys = await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)]);
  expect(storageKeys.filter((key) => /request.?mode/i.test(key))).toEqual([]);
});

test("signed-out mode choices stay single-flight, interruptible, simulated, and authority-free", async ({ page }) => {
  const forbidden: string[] = [];
  await page.route("**/api/config/public", async (route) => route.fulfill({ json: {
    network: "testnet",
    stableAsset: { currency: "RLUSD", issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" },
    devSignerEnabled: false,
    walletActionProofRequired: true,
    walletActionProofConfigured: true,
    mockMode: false,
  } }));
  await page.route("**/api/auth/wallet/session", async (route) => route.fulfill({ json: { authenticated: false } }));
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/chat" || path.startsWith("/api/harbor/") || path.startsWith("/api/dev/") || path.startsWith("/api/ledger-sim/")) forbidden.push(`${request.method()} ${path}`);
  });

  await page.goto("/chat");
  const mode = page.getByRole("button", { name: "Request mode" });
  const chooseMode = async (label: "Autonomous") => {
    await mode.click();
    await page.getByRole("option", { name: label }).click();
  };
  const composer = page.getByRole("textbox", { name: "Message Pilot" });
  await chooseMode("Autonomous");
  await composer.fill("Rebalance XRP autonomously");
  await composer.locator("xpath=ancestor::form[1]").evaluate((form) => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await expect(page.getByText("Rebalance XRP autonomously", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Stop streaming" })).toBeVisible();
  await page.getByRole("button", { name: "Stop streaming" }).click();
  await expect(page.getByText(/Stopped before any transaction tool completed/)).toBeVisible();

  // Interrupting a pending demo sleep must release its synchronous submit
  // gate. A later request can run once, still without crossing any authority
  // boundary.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await chooseMode("Autonomous");
  await composer.fill("Rebalance XRP autonomously after the interruption");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(/signed-out simulation cannot activate or execute/i)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/nothing here connects a wallet, creates a mandate, submits an order or touches the ledger/i)).toBeVisible();
  await expect(page.getByText(/No mandate, wallet proof, transaction, schedule, or ledger submission was created/i)).toBeVisible();
  await expect(page.getByText("Rebalance XRP autonomously after the interruption", { exact: true })).toHaveCount(1);
  await expect(page.getByText(/Simulated · no wallet or ledger transaction/)).toHaveCount(0);
  await expect(page.getByRole("link", { name: /XRPL Testnet Explorer/i })).toHaveCount(0);
  expect(forbidden).toEqual([]);
});
