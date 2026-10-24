import { describe, expect, it, vi } from "vitest";

import {
  buildIsolatedX402LaunchPlan,
  combineIsolatedX402Credentials,
  createIsolatedX402ChildEnvironment,
  GENERIC_DOTENV_PATHS,
  ISOLATED_X402_PILOT_CAPABILITY_FILE,
  ISOLATED_X402_PILOT_CREDENTIAL_FILE,
  ISOLATED_X402_PILOT_STATE_DIRECTORY,
  parseIsolatedX402CapabilityFile,
  REPOSITORY_ROOT,
} from "./dev-pilot-isolated-x402-v1.mjs";

const PRIMARY = `isolated-trading:${"T".repeat(32)}`;
const X402 = `isolated-x402:${"X".repeat(32)}`;
const SESSION = "isolated-x402-session-secret-at-least-32-chars";
const BASE_SOURCE = `HARBOR_API_KEY=${PRIMARY}\nSESSION_SECRET=${SESSION}\n`;
const CAPABILITY_SOURCE = `HARBOR_X402_API_KEY=${X402}\n`;

function directoryInfo() {
  return {
    isSymbolicLink: () => false,
    isFile: () => false,
    isDirectory: () => true,
    mode: 0o040700,
    size: 0,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
  };
}

describe("fixed isolated x402 Pilot launcher", () => {
  it("pins separate .2 trading and x402 ports with separate principal files", async () => {
    const checked = [];
    const plan = await buildIsolatedX402LaunchPlan({
      environment: {
        PATH: "/safe/bin",
        HARBOR_API_KEY: "ambient",
        HARBOR_X402_API_KEY: "ambient",
        HARBOR_X402_URL: "https://attacker.example",
        NODE_OPTIONS: "--require=/tmp/inject.cjs",
      },
      assertMissing: async (path) => checked.push(path),
      lstatFile: vi.fn(async (path) => {
        expect(path).toBe(ISOLATED_X402_PILOT_STATE_DIRECTORY);
        return directoryInfo();
      }),
      readCredentialFile: vi.fn(async (path) => {
        if (path === ISOLATED_X402_PILOT_CREDENTIAL_FILE) return BASE_SOURCE;
        expect(path).toBe(ISOLATED_X402_PILOT_CAPABILITY_FILE);
        return CAPABILITY_SOURCE;
      }),
    });
    expect(checked).toEqual(GENERIC_DOTENV_PATHS);
    expect(plan).toMatchObject({
      command: "pnpm",
      cwd: REPOSITORY_ROOT,
      args: [
        "--filter", "web", "exec", "next", "dev",
        "--hostname", "127.0.0.2", "--port", "3003",
      ],
      env: {
        PATH: "/safe/bin",
        PILOT_DEPLOYMENT_PROFILE: "local-wallet-isolated-v1",
        NEXT_PUBLIC_PILOT_BUILD_MARKER: "pilot-local-wallet-isolated-v1",
        HARBOR_URL: "http://127.0.0.2:8791",
        HARBOR_X402_URL: "http://127.0.0.2:8792",
        HARBOR_API_KEY: PRIMARY,
        HARBOR_X402_API_KEY: X402,
        EXEC_NETWORK: "testnet",
      },
    });
    expect(plan.env).not.toHaveProperty("NODE_OPTIONS");
  });

  it("rejects reused principals, malformed credentials, overrides, and generic dotenv", async () => {
    expect(() => combineIsolatedX402Credentials(
      BASE_SOURCE,
      CAPABILITY_SOURCE.replace(X402, `isolated-trading:${"X".repeat(32)}`),
    )).toThrow("principals must be different");
    expect(() => combineIsolatedX402Credentials(
      BASE_SOURCE,
      CAPABILITY_SOURCE.replace(X402, `isolated-x402:${"T".repeat(32)}`),
    )).toThrow("bearer tokens must be different");
    expect(() => parseIsolatedX402CapabilityFile(
      CAPABILITY_SOURCE.replace(X402, "not-named"),
    )).toThrow("HARBOR_X402_API_KEY");
    expect(() => parseIsolatedX402CapabilityFile(
      `${CAPABILITY_SOURCE}HARBOR_X402_URL=http://127.0.0.2:8792\n`,
    ))
      .toThrow("Unsupported isolated x402 credential entry");
    await expect(buildIsolatedX402LaunchPlan({ argv: ["--port=3004"] }))
      .rejects.toThrow("accepts no arguments");
    await expect(buildIsolatedX402LaunchPlan({
      assertMissing: async (path) => {
        if (path.endsWith(".env.local")) throw new Error(`forbidden ${path}`);
      },
    })).rejects.toThrow("forbidden");
  });

  it("constructs a sparse environment with no ambient credential inheritance", () => {
    const credentials = combineIsolatedX402Credentials(BASE_SOURCE, CAPABILITY_SOURCE);
    const child = createIsolatedX402ChildEnvironment({
      HOME: "/Users/example",
      PATH: "/bin",
      HARBOR_API_KEY: "ambient",
      HARBOR_X402_API_KEY: "ambient",
      SESSION_SECRET: "ambient",
      AWS_SECRET_ACCESS_KEY: "ambient",
    }, credentials);
    expect(child.HARBOR_API_KEY).toBe(PRIMARY);
    expect(child.HARBOR_X402_API_KEY).toBe(X402);
    expect(child.SESSION_SECRET).toBe(SESSION);
    expect(child).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
  });
});
