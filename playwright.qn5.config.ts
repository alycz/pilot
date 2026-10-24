import { defineConfig, devices } from "@playwright/test";

const port = 3016;
const baseURL = `http://127.0.0.1:${port}`;
const mockServerCommand = [
  "env -i",
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "NODE_ENV=test",
  "NEXT_TELEMETRY_DISABLED=1",
  "OPENROUTER_API_KEY=",
  "HARBOR_MOCK=1",
  "NEXT_PUBLIC_HARBOR_MOCK=1",
  "QN_MODE=mock",
  "EXEC_NETWORK=testnet",
  "MAINNET_EXECUTION=false",
  `pnpm --dir apps/web exec next dev --hostname 127.0.0.1 --port ${port}`,
].join(" ");

export default defineConfig({
  testDir: "./e2e",
  testMatch: "qn5-visibility.fixture.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  outputDir: "test-results/qn5",
  use: {
    baseURL,
    ...devices["Desktop Chrome"],
    browserName: "chromium",
    viewport: { width: 1440, height: 1100 },
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    serviceWorkers: "block",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: {
    command: mockServerCommand,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
