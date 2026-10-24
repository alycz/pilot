import { defineConfig, devices } from "@playwright/test";

const port = 3015;
const baseURL = `http://127.0.0.1:${port}`;

// `env -i` gives the visual fixture a closed, credential-free server process.
// NODE_ENV=test also prevents Next.js from loading apps/web/.env.local.
const mockServerCommand = [
  "env -i",
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "NODE_ENV=test",
  "NEXT_TELEMETRY_DISABLED=1",
  "AWS_EC2_METADATA_DISABLED=true",
  "AWS_ACCESS_KEY_ID=",
  "AWS_SECRET_ACCESS_KEY=",
  "AWS_SESSION_TOKEN=",
  "AWS_PROFILE=",
  "AWS_WEB_IDENTITY_TOKEN_FILE=",
  "AWS_ENDPOINT_URL=http://127.0.0.1:8799",
  "AWS_ENDPOINT_URL_KMS=http://127.0.0.1:8799",
  "AWS_ENDPOINT_URL_BEDROCK_RUNTIME=http://127.0.0.1:8799",
  "OPENROUTER_API_KEY=",
  "GUARDRAILS_MODE=mock",
  "KMS_MODE=kek",
  "BEDROCK_MODE=mock",
  "HARBOR_MOCK=1",
  "NEXT_PUBLIC_HARBOR_MOCK=1",
  "EXEC_NETWORK=testnet",
  "MAINNET_EXECUTION=false",
  `pnpm --dir apps/web exec next dev --hostname 127.0.0.1 --port ${port}`,
].join(" ");

export default defineConfig({
  testDir: "./e2e",
  testMatch: "aws5-trust.fixture.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  outputDir: "test-results/aws5",
  use: {
    baseURL,
    ...devices["Desktop Chrome"],
    browserName: "chromium",
    viewport: { width: 1440, height: 1100 },
    colorScheme: "dark",
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
