import { describe, expect, it, vi } from "vitest";

import {
  buildIsolatedLaunchPlan,
  createIsolatedChildEnvironment,
  GENERIC_DOTENV_PATHS,
  PILOT_PRIVATE_SECRETS_ROOT_ENV,
  PILOT_PRIVATE_STATE_ROOT_ENV,
  parseIsolatedCredentialFile,
  REPOSITORY_ROOT,
} from "./dev-pilot-isolated-v1.mjs";

const SECRETS_ROOT = "/private-secrets";
const STATE_ROOT = "/private-state";
const CREDENTIAL_FILE = "/private-secrets/pilot-isolated-v1.env.local";
const STATE_DIRECTORY = "/private-state/p-live-isolated-v1";

const CREDENTIALS = {
  HARBOR_API_KEY: "isolated-harbor-key",
  SESSION_SECRET: "isolated-session-secret-with-at-least-32-characters",
};

function fileInfo() {
  return {
    isSymbolicLink: () => false,
    isFile: () => true,
    isDirectory: () => false,
    mode: 0o100600,
    size: 200,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
  };
}

function directoryInfo() {
  return {
    ...fileInfo(),
    isFile: () => false,
    isDirectory: () => true,
    mode: 0o040700,
  };
}

describe("fixed isolated Pilot launcher", () => {
  it("pins the only credential/state identities and exact loopback launch arguments", async () => {
    const checked = [];
    const plan = await buildIsolatedLaunchPlan({
      environment: {
        PATH: "/safe/bin",
        [PILOT_PRIVATE_SECRETS_ROOT_ENV]: SECRETS_ROOT,
        [PILOT_PRIVATE_STATE_ROOT_ENV]: STATE_ROOT,
        SESSION_SECRET: "ambient-must-not-win",
        HARBOR_URL: "http://127.0.0.1:8791",
        P_LIVE_RLUSD_ACQUISITION_STATE_DIR: "/tmp/ambient-state",
        NEXT_PUBLIC_PILOT_BUILD_MARKER: "ambient-marker",
        DOTENV_CONFIG_PATH: "/tmp/ambient.env",
      },
      assertMissing: async (path) => checked.push(path),
      lstatFile: vi.fn(async (path) => path === STATE_DIRECTORY
          ? directoryInfo()
          : (() => { throw new Error(`unexpected path ${path}`); })()),
      readCredentialFile: vi.fn(async (path) => {
        expect(path).toBe(CREDENTIAL_FILE);
        return `HARBOR_API_KEY=${CREDENTIALS.HARBOR_API_KEY}\nSESSION_SECRET=${CREDENTIALS.SESSION_SECRET}\n`;
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
        P_LIVE_RLUSD_ACQUISITION_STATE_DIR: STATE_DIRECTORY,
        SESSION_SECRET: CREDENTIALS.SESSION_SECRET,
        HARBOR_API_KEY: CREDENTIALS.HARBOR_API_KEY,
      },
    });
    expect(plan.env).not.toHaveProperty("DOTENV_CONFIG_PATH");
    expect(plan.env).not.toHaveProperty("ambient-must-not-win");
    expect(plan.env.SESSION_SECRET).not.toBe("ambient-must-not-win");
  });

  it("rejects arguments, generic dotenv files, and alternate credential entries", async () => {
    await expect(buildIsolatedLaunchPlan({
      environment: {},
      assertMissing: async () => {},
    })).rejects.toThrow("PILOT_PRIVATE_SECRETS_ROOT must be an explicit absolute path");
    await expect(buildIsolatedLaunchPlan({ argv: ["--port", "3004"] })).rejects.toThrow(
      "accepts no arguments",
    );
    await expect(buildIsolatedLaunchPlan({
      assertMissing: async (path) => {
        if (path.endsWith(".env.local")) throw new Error(`forbidden ${path}`);
      },
    })).rejects.toThrow("forbidden");
    expect(() => parseIsolatedCredentialFile(
      `HARBOR_API_KEY=${CREDENTIALS.HARBOR_API_KEY}\n` +
      `SESSION_SECRET=${CREDENTIALS.SESSION_SECRET}\nHARBOR_URL=http://127.0.0.1:8791`,
    )).toThrow("Unsupported isolated credential entry");
    expect(() => parseIsolatedCredentialFile(
      `SESSION_SECRET=${CREDENTIALS.SESSION_SECRET}\nSESSION_SECRET=${CREDENTIALS.SESSION_SECRET}`,
    )).toThrow("Duplicate isolated credential");
  });

  it("passes through only non-application process fields", () => {
    const child = createIsolatedChildEnvironment({
      HOME: "/Users/example",
      PATH: "/bin",
      HARBOR_API_KEY: "ambient",
      SESSION_SECRET: "ambient",
      NODE_OPTIONS: "--require=/tmp/inject.cjs",
      PILOT_DEPLOYMENT_PROFILE: "hosted",
    }, CREDENTIALS, STATE_DIRECTORY);
    expect(child.HOME).toBe("/Users/example");
    expect(child.HARBOR_API_KEY).toBe(CREDENTIALS.HARBOR_API_KEY);
    expect(child.PILOT_DEPLOYMENT_PROFILE).toBe("local-wallet-isolated-v1");
    expect(child).not.toHaveProperty("NODE_OPTIONS");
  });
});
