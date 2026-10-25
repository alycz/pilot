import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolvePublicPilotConfig,
  resolveWalletActionProofConfigured,
} from "./config";
import { GET } from "./route";

const LOCAL_URL = "http://127.0.0.1:3003/api/config/public";
const ISOLATED_URL = "http://127.0.0.2:3003/api/config/public";
const HOSTED_URL = "https://pilot.example/api/config/public";
const PROOF_SECRET = "public-config-proof-test-secret-at-least-thirty-two-characters";
const PROOF_STATE_DIRECTORY = "/private/pilot-wallet-action-proof-state";
const HOSTED_PROFILE = {
  HARBOR_URL: "https://harbor.example",
  NEXT_PUBLIC_DEV_SIGNER: "0",
  PILOT_DEPLOYMENT_PROFILE: "hosted",
  PILOT_PUBLIC_ORIGIN: "https://pilot.example",
} as const;

function request(url: string, headers: HeadersInit = {}): Request {
  return new Request(url, {
    headers: {
      ...(url === LOCAL_URL ? { host: "127.0.0.1:3003" } : {}),
      ...(url === ISOLATED_URL ? { host: "127.0.0.2:3003" } : {}),
      ...headers,
    },
  });
}

describe("public Pilot config", () => {
  it("returns only safe testnet metadata", async () => {
    const config = await resolvePublicPilotConfig({
      EXEC_NETWORK: "testnet",
      STABLE_CODE_TESTNET: "tUSD",
      STABLE_ISSUER_TESTNET: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
      NEXT_PUBLIC_DEV_SIGNER: "1",
      PILOT_DEPLOYMENT_PROFILE: "local-wallet",
      HARBOR_URL: "http://127.0.0.1:8791",
      HARBOR_MOCK: "1",
      HARBOR_API_KEY: "must-not-escape",
      MM_WALLET_SEED: "must-not-escape",
      SESSION_SECRET: PROOF_SECRET,
      P_LIVE_RLUSD_ACQUISITION_STATE_DIR: PROOF_STATE_DIRECTORY,
    }, request(LOCAL_URL), async (directory) => {
      expect(directory).toBe(PROOF_STATE_DIRECTORY);
      return directory!;
    });

    expect(config).toEqual({
      network: "testnet",
      stableAsset: {
        currency: "RLUSD",
        issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
      },
      devSignerEnabled: true,
      walletActionProofRequired: true,
      walletActionProofConfigured: true,
      mockMode: true,
      ledger: {
        enabled: true,
        transports: ["webhid"],
        defaultAccountIndex: 0,
      },
    });
    expect(JSON.stringify(config)).not.toContain("must-not-escape");
    expect(JSON.stringify(config)).not.toContain(PROOF_SECRET);
    expect(JSON.stringify(config)).not.toContain(PROOF_STATE_DIRECTORY);
  });

  it("publishes only a boolean when structured preferences are fully configured", async () => {
    const config = await resolvePublicPilotConfig({
      EXEC_NETWORK: "testnet",
      HARBOR_MOCK: "1",
      NEXT_PUBLIC_DEV_SIGNER: "0",
      PILOT_DEPLOYMENT_PROFILE: "local-wallet",
      HARBOR_URL: "http://127.0.0.1:8791",
      PILOT_STRUCTURED_PREFERENCES: "1",
      PILOT_PERSONALIZATION_TENANT_ID: "private-tenant",
      PILOT_PERSONALIZATION_STATE_DIR: "/private/personalization-state",
    }, request(LOCAL_URL));
    expect(config.structuredPreferencesEnabled).toBe(true);
    expect(JSON.stringify(config)).not.toContain("private-tenant");
    expect(JSON.stringify(config)).not.toContain("personalization-state");
    await expect(resolvePublicPilotConfig({
      EXEC_NETWORK: "testnet",
      HARBOR_MOCK: "1",
      NEXT_PUBLIC_DEV_SIGNER: "0",
      PILOT_DEPLOYMENT_PROFILE: "local-wallet",
      HARBOR_URL: "http://127.0.0.1:8791",
      PILOT_STRUCTURED_PREFERENCES: "1",
      PILOT_PERSONALIZATION_TENANT_ID: "private-tenant",
    }, request(LOCAL_URL))).rejects.toThrow("STRUCTURED_PREFERENCE_STORAGE_NOT_CONFIGURED");
  });

  it("publishes hosted structured preferences only for complete remote private storage", async () => {
    const environment = {
      ...HOSTED_PROFILE,
      EXEC_NETWORK: "testnet",
      HARBOR_MOCK: "1",
      PILOT_STRUCTURED_PREFERENCES: "1",
      PILOT_PERSONALIZATION_BACKEND: "harbor-d1",
      PILOT_PERSONALIZATION_TENANT_ID: "private-tenant",
      SESSION_SECRET: PROOF_SECRET,
      PILOT_HOSTED_STATE_API_KEY: `pilot-hosted-state:${"H".repeat(32)}`,
    } as const;
    const config = await resolvePublicPilotConfig(environment, request(HOSTED_URL));
    expect(config.structuredPreferencesEnabled).toBe(true);
    expect(JSON.stringify(config)).not.toContain("private-tenant");

    for (const invalid of [
      { ...environment, PILOT_HOSTED_STATE_API_KEY: undefined },
      { ...environment, SESSION_SECRET: "short" },
      { ...environment, PILOT_PERSONALIZATION_STATE_DIR: "/ambiguous/local-state" },
      { ...environment, PILOT_PERSONALIZATION_BACKEND: "unknown" },
    ]) {
      await expect(resolvePublicPilotConfig(invalid, request(HOSTED_URL)))
        .rejects.toThrow("STRUCTURED_PREFERENCE_STORAGE_NOT_CONFIGURED");
    }
  });

  it("publishes the fixed isolated build marker only for its exact slot", async () => {
    const environment = {
      EXEC_NETWORK: "testnet",
      HARBOR_MOCK: "0",
      HARBOR_URL: "http://127.0.0.2:8791",
      NEXT_PUBLIC_DEV_SIGNER: "1",
      NEXT_PUBLIC_PILOT_BUILD_MARKER: "pilot-local-wallet-isolated-v1",
      PILOT_DEPLOYMENT_PROFILE: "local-wallet-isolated-v1",
    } as const;
    const config = await resolvePublicPilotConfig(environment, request(ISOLATED_URL));

    expect(config).toMatchObject({
      buildMarker: "pilot-local-wallet-isolated-v1",
      devSignerEnabled: true,
      walletActionProofRequired: true,
    });
    await expect(resolvePublicPilotConfig(environment, request(LOCAL_URL))).rejects.toThrow();
    await expect(resolvePublicPilotConfig({
      ...environment,
      NEXT_PUBLIC_PILOT_BUILD_MARKER: undefined,
    }, request(ISOLATED_URL))).rejects.toThrow("PILOT_BUILD_MARKER_MISMATCH");
  });

  it.each([
    ["missing secret", { P_LIVE_RLUSD_ACQUISITION_STATE_DIR: PROOF_STATE_DIRECTORY }],
    ["short secret", {
      SESSION_SECRET: "too-short",
      P_LIVE_RLUSD_ACQUISITION_STATE_DIR: PROOF_STATE_DIRECTORY,
    }],
    ["whitespace-only secret", {
      SESSION_SECRET: " ".repeat(40),
      P_LIVE_RLUSD_ACQUISITION_STATE_DIR: PROOF_STATE_DIRECTORY,
    }],
    ["missing state directory", { SESSION_SECRET: PROOF_SECRET }],
    ["blank state directory", {
      SESSION_SECRET: PROOF_SECRET,
      P_LIVE_RLUSD_ACQUISITION_STATE_DIR: "",
    }],
    ["relative state directory", {
      SESSION_SECRET: PROOF_SECRET,
      P_LIVE_RLUSD_ACQUISITION_STATE_DIR: "relative/state",
    }],
  ])("reports wallet action proof prerequisites unavailable for a %s", async (_case, environment) => {
    expect(await resolveWalletActionProofConfigured(environment)).toBe(false);
  });

  it("reports true only for an existing private proof directory", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-public-config-proof-"));
    try {
      await chmod(directory, 0o700);
      expect(await resolveWalletActionProofConfigured({
        SESSION_SECRET: PROOF_SECRET,
        P_LIVE_RLUSD_ACQUISITION_STATE_DIR: directory,
      })).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports hosted proof readiness only for the dedicated HTTPS state credential", async () => {
    const dedicated = `pilot-hosted-state:${"H".repeat(32)}`;
    expect(await resolveWalletActionProofConfigured({
      ...HOSTED_PROFILE,
      SESSION_SECRET: PROOF_SECRET,
      PILOT_HOSTED_STATE_API_KEY: dedicated,
    })).toBe(true);
    for (const environment of [
      { ...HOSTED_PROFILE, SESSION_SECRET: PROOF_SECRET },
      { ...HOSTED_PROFILE, SESSION_SECRET: PROOF_SECRET, HARBOR_API_KEY: dedicated },
      { ...HOSTED_PROFILE, SESSION_SECRET: PROOF_SECRET,
        PILOT_HOSTED_STATE_API_KEY: dedicated, HARBOR_URL: "http://harbor.example" },
      { ...HOSTED_PROFILE, SESSION_SECRET: PROOF_SECRET,
        PILOT_HOSTED_STATE_API_KEY: dedicated, HARBOR_URL: "https://127.0.0.1:8791" },
      { ...HOSTED_PROFILE, SESSION_SECRET: PROOF_SECRET,
        PILOT_HOSTED_STATE_API_KEY: dedicated,
        HARBOR_API_KEY: `other-principal:${"H".repeat(32)}` },
      { ...HOSTED_PROFILE, SESSION_SECRET: PROOF_SECRET,
        PILOT_HOSTED_STATE_API_KEY: dedicated,
        HARBOR_API_KEY: `pilot-hosted-state:${"B".repeat(32)}` },
      { ...HOSTED_PROFILE, SESSION_SECRET: PROOF_SECRET,
        PILOT_HOSTED_STATE_API_KEY: dedicated,
        HARBOR_API_KEY: "malformed" },
    ]) {
      expect(await resolveWalletActionProofConfigured(environment)).toBe(false);
    }
    expect(await resolveWalletActionProofConfigured({
      ...HOSTED_PROFILE,
      SESSION_SECRET: PROOF_SECRET,
      PILOT_HOSTED_STATE_API_KEY: dedicated,
      HARBOR_API_KEY: `pilot-general:${"G".repeat(32)}`,
    })).toBe(true);
  });

  it("reports false for nonexistent, symlinked, regular-file, and group/world-accessible paths", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-public-config-invalid-proof-"));
    const file = path.join(directory, "regular-file");
    const link = `${directory}-link`;
    const environment = (stateDirectory: string) => ({
      SESSION_SECRET: PROOF_SECRET,
      P_LIVE_RLUSD_ACQUISITION_STATE_DIR: stateDirectory,
    });
    try {
      await chmod(directory, 0o700);
      await writeFile(file, "not a directory\n", { mode: 0o600 });
      await symlink(directory, link, "dir");
      expect(await resolveWalletActionProofConfigured(
        environment(path.join(directory, "missing")),
      )).toBe(false);
      expect(await resolveWalletActionProofConfigured(environment(link))).toBe(false);
      expect(await resolveWalletActionProofConfigured(environment(file))).toBe(false);
      for (const mode of [0o750, 0o705, 0o600, 0o500, 0o300]) {
        await chmod(directory, mode);
        expect(await resolveWalletActionProofConfigured(environment(directory))).toBe(false);
      }
    } finally {
      await chmod(directory, 0o700).catch(() => undefined);
      await rm(link, { force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("converts every proof-directory validation failure to a private false indicator", async () => {
    const validateDirectory = async () => {
      throw new Error(`sensitive path: ${PROOF_STATE_DIRECTORY}`);
    };
    expect(await resolveWalletActionProofConfigured({
      SESSION_SECRET: PROOF_SECRET,
      P_LIVE_RLUSD_ACQUISITION_STATE_DIR: PROOF_STATE_DIRECTORY,
    }, validateDirectory)).toBe(false);
    const config = await resolvePublicPilotConfig({
      EXEC_NETWORK: "testnet",
      HARBOR_MOCK: "1",
      HARBOR_URL: "http://127.0.0.1:8791",
      NEXT_PUBLIC_DEV_SIGNER: "0",
      PILOT_DEPLOYMENT_PROFILE: "local-wallet",
      SESSION_SECRET: PROOF_SECRET,
      P_LIVE_RLUSD_ACQUISITION_STATE_DIR: PROOF_STATE_DIRECTORY,
    }, request(LOCAL_URL), validateDirectory);
    expect(config.walletActionProofConfigured).toBe(false);
    expect(JSON.stringify(config)).not.toContain(PROOF_SECRET);
    expect(JSON.stringify(config)).not.toContain(PROOF_STATE_DIRECTORY);
  });

  it("marks the checked local mock-style defaults unready when proof prerequisites are blank", async () => {
    expect(await resolvePublicPilotConfig({
      EXEC_NETWORK: "testnet",
      HARBOR_MOCK: "1",
      HARBOR_URL: "http://127.0.0.1:8791",
      NEXT_PUBLIC_DEV_SIGNER: "0",
      PILOT_DEPLOYMENT_PROFILE: "local-wallet",
      SESSION_SECRET: "",
      P_LIVE_RLUSD_ACQUISITION_STATE_DIR: "",
    }, request(LOCAL_URL))).toMatchObject({
      mockMode: true,
      walletActionProofConfigured: false,
      walletActionProofRequired: true,
    });
  });

  it("uses the public Testnet RLUSD issuer only for the RLUSD default", async () => {
    expect((await resolvePublicPilotConfig({
      ...HOSTED_PROFILE,
      EXEC_NETWORK: "testnet",
      HARBOR_MOCK: "0",
    }, request(HOSTED_URL))).stableAsset).toEqual({
      currency: "RLUSD",
      issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
    });
    await expect(
      resolvePublicPilotConfig({
        ...HOSTED_PROFILE,
        EXEC_NETWORK: "devnet",
        STABLE_CODE_DEVNET: "tUSD",
        HARBOR_MOCK: "0",
      }, request(HOSTED_URL)),
    ).rejects.toThrow();
  });

  it("refuses mainnet and uses the server mode as the single authority", async () => {
    await expect(resolvePublicPilotConfig({
      ...HOSTED_PROFILE,
      EXEC_NETWORK: "mainnet",
    }, request(HOSTED_URL))).rejects.toThrow();
    expect(
      (await resolvePublicPilotConfig({
        ...HOSTED_PROFILE,
        EXEC_NETWORK: "testnet",
        HARBOR_MOCK: "1",
      }, request(HOSTED_URL))).mockMode,
    ).toBe(true);
    expect(
      (await resolvePublicPilotConfig({
        ...HOSTED_PROFILE,
        EXEC_NETWORK: "testnet",
        HARBOR_MOCK: "0",
      }, request(HOSTED_URL))).mockMode,
    ).toBe(false);
  });

  it.each([undefined, "", "true", "false", " 1 "]) (
    "refuses an implicit or invalid Harbor mode: %s",
    async (harborMode) => {
      await expect(resolvePublicPilotConfig({
        ...HOSTED_PROFILE,
        EXEC_NETWORK: "testnet",
        HARBOR_MOCK: harborMode,
      }, request(HOSTED_URL))).rejects.toThrow("UNSUPPORTED_PUBLIC_HARBOR_MODE");
    },
  );

  it("returns unavailable when the process Harbor mode is invalid", async () => {
    const previousNetwork = process.env.EXEC_NETWORK;
    const previousMode = process.env.HARBOR_MOCK;
    const previousProfile = process.env.PILOT_DEPLOYMENT_PROFILE;
    const previousPublicOrigin = process.env.PILOT_PUBLIC_ORIGIN;
    const previousHarborUrl = process.env.HARBOR_URL;
    const previousDevSigner = process.env.NEXT_PUBLIC_DEV_SIGNER;
    process.env.EXEC_NETWORK = "testnet";
    process.env.HARBOR_MOCK = "true";
    process.env.PILOT_DEPLOYMENT_PROFILE = "hosted";
    process.env.PILOT_PUBLIC_ORIGIN = "https://pilot.example";
    process.env.HARBOR_URL = "https://harbor.example";
    process.env.NEXT_PUBLIC_DEV_SIGNER = "0";
    try {
      const response = await GET(new Request(HOSTED_URL));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: {
          code: "PUBLIC_CONFIG_UNAVAILABLE",
          message: "The public test-network configuration is unavailable.",
        },
      });
    } finally {
      if (previousNetwork === undefined) delete process.env.EXEC_NETWORK;
      else process.env.EXEC_NETWORK = previousNetwork;
      if (previousMode === undefined) delete process.env.HARBOR_MOCK;
      else process.env.HARBOR_MOCK = previousMode;
      if (previousProfile === undefined) delete process.env.PILOT_DEPLOYMENT_PROFILE;
      else process.env.PILOT_DEPLOYMENT_PROFILE = previousProfile;
      if (previousPublicOrigin === undefined) delete process.env.PILOT_PUBLIC_ORIGIN;
      else process.env.PILOT_PUBLIC_ORIGIN = previousPublicOrigin;
      if (previousHarborUrl === undefined) delete process.env.HARBOR_URL;
      else process.env.HARBOR_URL = previousHarborUrl;
      if (previousDevSigner === undefined) delete process.env.NEXT_PUBLIC_DEV_SIGNER;
      else process.env.NEXT_PUBLIC_DEV_SIGNER = previousDevSigner;
    }
  });

  it("returns a sanitized unavailable response", async () => {
    const previousNetwork = process.env.EXEC_NETWORK;
    const previousMode = process.env.HARBOR_MOCK;
    const previousProfile = process.env.PILOT_DEPLOYMENT_PROFILE;
    const previousPublicOrigin = process.env.PILOT_PUBLIC_ORIGIN;
    const previousHarborUrl = process.env.HARBOR_URL;
    const previousDevSigner = process.env.NEXT_PUBLIC_DEV_SIGNER;
    process.env.EXEC_NETWORK = "mainnet";
    process.env.HARBOR_MOCK = "0";
    process.env.PILOT_DEPLOYMENT_PROFILE = "hosted";
    process.env.PILOT_PUBLIC_ORIGIN = "https://pilot.example";
    process.env.HARBOR_URL = "https://harbor.example";
    process.env.NEXT_PUBLIC_DEV_SIGNER = "0";
    try {
      const response = await GET(new Request(HOSTED_URL));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: {
          code: "PUBLIC_CONFIG_UNAVAILABLE",
          message: "The public test-network configuration is unavailable.",
        },
      });
    } finally {
      if (previousNetwork === undefined) delete process.env.EXEC_NETWORK;
      else process.env.EXEC_NETWORK = previousNetwork;
      if (previousMode === undefined) delete process.env.HARBOR_MOCK;
      else process.env.HARBOR_MOCK = previousMode;
      if (previousProfile === undefined) delete process.env.PILOT_DEPLOYMENT_PROFILE;
      else process.env.PILOT_DEPLOYMENT_PROFILE = previousProfile;
      if (previousPublicOrigin === undefined) delete process.env.PILOT_PUBLIC_ORIGIN;
      else process.env.PILOT_PUBLIC_ORIGIN = previousPublicOrigin;
      if (previousHarborUrl === undefined) delete process.env.HARBOR_URL;
      else process.env.HARBOR_URL = previousHarborUrl;
      if (previousDevSigner === undefined) delete process.env.NEXT_PUBLIC_DEV_SIGNER;
      else process.env.NEXT_PUBLIC_DEV_SIGNER = previousDevSigner;
    }
  });

  it("enables the development signer only for the exact local-wallet boundary", async () => {
    const environment = {
      EXEC_NETWORK: "testnet",
      HARBOR_MOCK: "0",
      HARBOR_URL: "http://127.0.0.1:8791",
      NEXT_PUBLIC_DEV_SIGNER: "1",
      PILOT_DEPLOYMENT_PROFILE: "local-wallet",
    };
    expect((await resolvePublicPilotConfig(
      environment,
      request(LOCAL_URL),
    )).devSignerEnabled).toBe(true);
    expect((await resolvePublicPilotConfig(
      environment,
      request(LOCAL_URL),
    )).walletActionProofRequired).toBe(true);
    await expect(resolvePublicPilotConfig(environment, request(HOSTED_URL))).rejects.toThrow();
    await expect(resolvePublicPilotConfig(
      { ...environment, HARBOR_URL: "http://localhost:8791" },
      request(LOCAL_URL),
    )).rejects.toThrow();
  });

  it.each<Record<string, string>>([
    { forwarded: "for=127.0.0.1,for=203.0.113.7" },
    { "x-forwarded-host": "127.0.0.1:3003,pilot.example" },
    { "x-forwarded-proto": "http,https" },
    { "x-forwarded-port": "3003,443" },
  ])("does not publish local signer config through ambiguous forwarding metadata: %o", async (headers) => {
    await expect(resolvePublicPilotConfig({
      EXEC_NETWORK: "testnet",
      HARBOR_MOCK: "0",
      HARBOR_URL: "http://127.0.0.1:8791",
      NEXT_PUBLIC_DEV_SIGNER: "1",
      PILOT_DEPLOYMENT_PROFILE: "local-wallet",
    }, request(LOCAL_URL, headers))).rejects.toThrow();
  });

  it("keeps the explicit hosted profile remote with the development signer disabled", async () => {
    const config = await resolvePublicPilotConfig({
      ...HOSTED_PROFILE,
      EXEC_NETWORK: "testnet",
      HARBOR_MOCK: "0",
    }, request(HOSTED_URL));
    expect(config.devSignerEnabled).toBe(false);
    expect(config.walletActionProofRequired).toBe(false);
    expect(config.walletActionProofConfigured).toBe(false);
    await expect(resolvePublicPilotConfig({
      ...HOSTED_PROFILE,
      EXEC_NETWORK: "testnet",
      HARBOR_MOCK: "0",
      NEXT_PUBLIC_DEV_SIGNER: "1",
    }, request(HOSTED_URL))).rejects.toThrow();
  });

  it("requires wallet action proofs for local external wallets without enabling the dev signer", async () => {
    const config = await resolvePublicPilotConfig({
      EXEC_NETWORK: "testnet",
      HARBOR_MOCK: "0",
      HARBOR_URL: "http://127.0.0.1:8791",
      NEXT_PUBLIC_DEV_SIGNER: "0",
      PILOT_DEPLOYMENT_PROFILE: "local-wallet",
    }, request(LOCAL_URL));
    expect(config.devSignerEnabled).toBe(false);
    expect(config.walletActionProofRequired).toBe(true);
    expect(config.walletActionProofConfigured).toBe(false);
  });

  it("uses the configured hosted origin instead of an internal request URL or forwarding metadata", async () => {
    const config = await resolvePublicPilotConfig({
      ...HOSTED_PROFILE,
      EXEC_NETWORK: "testnet",
      HARBOR_MOCK: "0",
    }, request("http://next-internal:3000/api/config/public", {
      forwarded: "for=203.0.113.7;proto=http;host=attacker.example",
      "x-forwarded-host": "attacker.example",
      "x-forwarded-proto": "http",
    }));

    expect(config.devSignerEnabled).toBe(false);
  });

  it.each([
    undefined,
    "",
    "http://pilot.example",
    "https://127.0.0.1",
    "https://pilot.example/path",
    "https://pilot.example/",
    " https://pilot.example",
  ])("fails closed for a missing or unsafe hosted public origin: %s", async (publicOrigin) => {
    await expect(resolvePublicPilotConfig({
      ...HOSTED_PROFILE,
      PILOT_PUBLIC_ORIGIN: publicOrigin,
      EXEC_NETWORK: "testnet",
      HARBOR_MOCK: "0",
    }, request("http://next-internal:3000/api/config/public"))).rejects.toThrow();
  });

  it.each([undefined, "", "local", "HOSTED"])(
    "fails closed for a missing or unknown deployment profile: %s",
    async (profile) => {
      await expect(resolvePublicPilotConfig({
        EXEC_NETWORK: "testnet",
        HARBOR_MOCK: "0",
        HARBOR_URL: "https://harbor.example",
        NEXT_PUBLIC_DEV_SIGNER: "0",
        PILOT_DEPLOYMENT_PROFILE: profile,
      }, request(HOSTED_URL))).rejects.toThrow();
    },
  );
});
