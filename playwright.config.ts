import { defineConfig, devices } from "@playwright/test";

import { laneTestMatch, resolveE2ELane } from "./e2e/support/lanes";
import {
  PERSONALIZATION_FIXTURE_STATE_PATH,
  PERSONALIZATION_FIXTURE_TENANT,
  PERSONALIZATION_FIXTURE_VAULT_PATH,
} from "./e2e/support/personalization-fixture";

const lane = resolveE2ELane();
const fixturePort = lane.id === "fixture" ? new URL(lane.baseURL).port : "3004";
const fixtureProcessAllowlist = new Set([
  "CI",
  "COLORTERM",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "PNPM_HOME",
  "SHELL",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
]);

const isolatedFixtureEnvironment = Object.fromEntries(
  Object.entries(process.env).map(([name, value]) => [
    name,
    fixtureProcessAllowlist.has(name) ? (value ?? "") : "",
  ]),
);

const fixtureServerEnvironment: Record<string, string> = {
  ...isolatedFixtureEnvironment,
  HARBOR_MOCK: "1",
  NEXT_PUBLIC_HARBOR_MOCK: "1",
  NEXT_PUBLIC_DEV_SIGNER: "0",
  NEXT_TELEMETRY_DISABLED: "1",
  TEST_SIGNER: "0",
  EXEC_NETWORK: "testnet",
  MAINNET_EXECUTION: "false",
  VAULT_BACKEND: "fs",
  VAULT_PATH: PERSONALIZATION_FIXTURE_VAULT_PATH,
  PILOT_STRUCTURED_PREFERENCES: "1",
  PILOT_PERSONALIZATION_FIXTURE: "1",
  PILOT_PERSONALIZATION_FIXTURE_ORIGIN: lane.baseURL,
  PILOT_PERSONALIZATION_TENANT_ID: PERSONALIZATION_FIXTURE_TENANT,
  PILOT_PERSONALIZATION_STATE_DIR: PERSONALIZATION_FIXTURE_STATE_PATH,
  SESSION_SECRET: "playwright-fixture-only-not-a-live-credential",
  HARBOR_URL: "",
  HARBOR_API_KEY: "",
  DEMO_OPENROUTER_API_KEY: "",
  DEMO_CHAT_RATE_LIMIT: "1000",
  MODEL_DEFAULT: "openai/gpt-oss-20b:free",
  MM_WALLET_SEED: "",
  VAULT_GITHUB_TOKEN: "",
  VAULT_REPO: "",
  XAMAN_API_KEY: "",
  XAMAN_API_SECRET: "",
  X402_FACILITATOR_URL: "",
  X402_PAY_TO: "",
  XRPL_MAINNET_URL: "",
  XRPL_TESTNET_URL: "",
  XRPL_DEVNET_URL: "",
  XRPL_LENDING_DEVNET_URL: "",
  // Node 24's built-in fetch otherwise lets Next's dev-only version check
  // reach npm during fixture startup. Route all non-loopback server traffic to
  // a closed local port so that check fails immediately and the fixture stays
  // deterministic and offline.
  NODE_USE_ENV_PROXY: "1",
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  ALL_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1,localhost",
  STABLE_CODE_TESTNET: "RLUSD",
  STABLE_ISSUER_TESTNET: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
};

export default defineConfig({
  testDir: "./e2e",
  testMatch: laneTestMatch(lane.id),
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  outputDir: "test-results/playwright",
  use: {
    baseURL: lane.baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  expect: { timeout: 10_000 },
  timeout: 45_000,
  webServer: lane.startsLocalServer
    ? {
        command: `pnpm --filter web dev --hostname 127.0.0.1 --port ${fixturePort}`,
        url: lane.baseURL,
        reuseExistingServer: false,
        timeout: 120_000,
        // Keep fixture startup failures diagnosable in hosted CI. The fixture
        // environment below is scrubbed before this process is spawned.
        stdout: "pipe",
        stderr: "pipe",
        env: fixtureServerEnvironment,
      }
    : undefined,
  projects: [
    {
      name: lane.id,
      metadata: {
        authority: lane.authority,
        evidenceKind: lane.evidenceKind,
        maySignOrFund: lane.maySignOrFund,
      },
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
