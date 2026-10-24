import { describe, expect, it, vi } from "vitest";

import type { TxBuild } from "../src/contracts";
import {
  BuildValidationError,
  assertExecutionContractSupported,
  persistBuild,
  type BuildContext,
} from "../src/exec/build";
import {
  Store,
  StoreDataError,
  type BuildInsert,
} from "../src/exec/store";
import { LOCAL_TRADING_BUILD_ORIGIN } from "../src/local-trading";
import { LOCAL_TRADING_ONBOARDING_BUILD_ORIGIN } from "../src/local-trading-onboarding";
import { LOCAL_TRADING_ISOLATED_V1_BUILD_ORIGIN } from "../src/local-trading-isolated-v1";
import { LOCAL_TRADING_ISOLATED_ONBOARDING_V1_BUILD_ORIGIN } from "../src/local-trading-isolated-onboarding-v1";

const OWNER = "rIsolatedOnboardingOwnerFixture";
const CREATED_AT = new Date("2026-10-20T10:00:00.000Z");

const build: TxBuild = {
  build_id: "isolated-onboarding-build",
  network: "testnet",
  tx_json: {
    Account: OWNER,
    TransactionType: "TrustSet",
    LastLedgerSequence: 164,
  },
  delegable: true,
  simulate: {
    engine_result: "tesSUCCESS",
    engine_result_message: "The simulated transaction would succeed.",
    applied: false,
  },
  preflight: [],
  summary: {
    action: "isolated onboarding origin fixture",
    account: OWNER,
    amounts: [],
    fee_drops: "12",
    reserve_delta_drops: "0",
  },
};

const reviewedBaseEnv = {
  EXEC_NETWORK: "testnet",
  EXECUTOR: "quickjs",
  MAINNET_EXECUTION: "false",
  HARBOR_LOCAL_DEV: "true",
  HARBOR_LOCAL_READ_ONLY: "false",
  HARBOR_LOCAL_AUTH_REQUIRED: "true",
  HARBOR_LOCAL_CRON_DISABLED: "true",
  HARBOR_LOCAL_X402: "false",
  HARBOR_LOCAL_X402_RUNTIME_ENABLED: "false",
  HARBOR_SOURCE_TAG: "2610240",
} as const;

const exactIsolatedOnboardingEnv = {
  ...reviewedBaseEnv,
  HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_RUNTIME_ENABLED: "true",
  HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_SIGNING_PROFILE:
    "local-wallet-isolated-onboarding-v1",
} as const;

function buildContext(
  env: Record<string, unknown>,
): { ctx: BuildContext; insertBuild: ReturnType<typeof vi.fn> } {
  const insertBuild = vi.fn(async (_input: BuildInsert) => undefined);
  return {
    ctx: {
      principal: "isolated-onboarding-test-principal",
      localDevRequest: true,
      env,
      store: { insertBuild },
    },
    insertBuild,
  };
}

function rawBuild(originProfile: string | null): Record<string, unknown> {
  return {
    id: build.build_id,
    principal: "isolated-onboarding-test-principal",
    owner: OWNER,
    network: "testnet",
    tx_json: JSON.stringify(build.tx_json),
    summary: JSON.stringify(build.summary),
    last_ledger_seq: 164,
    created_at: CREATED_AT.toISOString(),
    origin_profile: originProfile,
    execution_contract: null,
    build_revision: null,
  };
}

function storeReading(row: Record<string, unknown>): Store {
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => row),
  };
  const db = { prepare: vi.fn(() => statement) };
  return new Store(
    db as unknown as D1Database,
    "isolated-onboarding-test-principal",
  );
}

describe("local-trading-isolated-v1 onboarding durable build origin", () => {
  it("persists the exact onboarding origin and permits v2 in the reviewed context", async () => {
    const { ctx, insertBuild } = buildContext({
      ...exactIsolatedOnboardingEnv,
    });

    expect(assertExecutionContractSupported(ctx, "xrpl_execution_v2")).toBe(
      "xrpl_execution_v2",
    );
    await persistBuild(ctx, build, CREATED_AT);

    expect(insertBuild).toHaveBeenCalledTimes(1);
    expect(insertBuild.mock.calls[0]?.[0]).toMatchObject({
      id: build.build_id,
      originProfile: LOCAL_TRADING_ISOLATED_ONBOARDING_V1_BUILD_ORIGIN,
    });
  });

  it.each([
    [
      "runtime marker only",
      {
        HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_RUNTIME_ENABLED: "true",
      },
    ],
    [
      "signing marker only",
      {
        HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_SIGNING_PROFILE:
          "local-wallet-isolated-onboarding-v1",
      },
    ],
    [
      "partial marker mixed with an otherwise reviewed legacy profile",
      {
        ...reviewedBaseEnv,
        HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_RUNTIME_ENABLED: "true",
        HARBOR_LOCAL_TRADING_RUNTIME_ENABLED: "true",
        HARBOR_LOCAL_TRADING_SIGNING_PROFILE:
          "reviewed-testnet-local-trading-v1",
      },
    ],
    [
      "malformed runtime marker",
      {
        ...exactIsolatedOnboardingEnv,
        HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_RUNTIME_ENABLED: true,
      },
    ],
    [
      "malformed signing profile",
      {
        ...exactIsolatedOnboardingEnv,
        HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_SIGNING_PROFILE:
          "local-wallet-isolated-onboarding-v2",
      },
    ],
    [
      "mixed legacy trading profile",
      {
        ...exactIsolatedOnboardingEnv,
        HARBOR_LOCAL_TRADING_RUNTIME_ENABLED: "true",
        HARBOR_LOCAL_TRADING_SIGNING_PROFILE:
          "reviewed-testnet-local-trading-v1",
      },
    ],
    [
      "mixed legacy onboarding profile",
      {
        ...exactIsolatedOnboardingEnv,
        HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED: "true",
        HARBOR_LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE:
          "reviewed-testnet-local-trading-onboarding-v1",
      },
    ],
    [
      "mixed isolated trading profile",
      {
        ...exactIsolatedOnboardingEnv,
        HARBOR_LOCAL_TRADING_ISOLATED_V1_RUNTIME_ENABLED: "true",
        HARBOR_LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE:
          "local-wallet-isolated-v1",
      },
    ],
    [
      "mixed x402 profile",
      {
        ...exactIsolatedOnboardingEnv,
        HARBOR_LOCAL_X402_SIGNING_PROFILE: "unexpected-x402-profile",
      },
    ],
  ])("fails closed for %s", async (_name, env) => {
    const { ctx, insertBuild } = buildContext(env);

    expect(() =>
      assertExecutionContractSupported(ctx, "xrpl_execution_v2"),
    ).toThrow(BuildValidationError);
    await expect(persistBuild(ctx, build, CREATED_AT)).rejects.toMatchObject({
      code: "INVALID_BUILD",
    });
    expect(insertBuild).not.toHaveBeenCalled();
  });

  it.each([
    [
      "legacy trading",
      { HARBOR_LOCAL_TRADING_RUNTIME_ENABLED: "true" },
      LOCAL_TRADING_BUILD_ORIGIN,
    ],
    [
      "legacy onboarding",
      { HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED: "true" },
      LOCAL_TRADING_ONBOARDING_BUILD_ORIGIN,
    ],
    [
      "isolated trading",
      {
        EXEC_NETWORK: "testnet",
        EXECUTOR: "quickjs",
        MAINNET_EXECUTION: "false",
        HARBOR_LOCAL_DEV: "true",
        HARBOR_LOCAL_READ_ONLY: "false",
        HARBOR_LOCAL_AUTH_REQUIRED: "true",
        HARBOR_LOCAL_CRON_DISABLED: "true",
        HARBOR_LOCAL_X402: "false",
        HARBOR_LOCAL_X402_RUNTIME_ENABLED: "false",
        HARBOR_LOCAL_TRADING_ISOLATED_V1_RUNTIME_ENABLED: "true",
        HARBOR_LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE:
          "local-wallet-isolated-v1",
        HARBOR_SOURCE_TAG: "2610240",
      },
      LOCAL_TRADING_ISOLATED_V1_BUILD_ORIGIN,
    ],
    ["unprofiled", {}, null],
  ])("preserves %s origin behavior", async (_name, env, expectedOrigin) => {
    const { ctx, insertBuild } = buildContext(env);

    await persistBuild(ctx, build, CREATED_AT);

    expect(insertBuild).toHaveBeenCalledTimes(1);
    expect(insertBuild.mock.calls[0]?.[0]).toMatchObject({
      originProfile: expectedOrigin,
    });
  });

  it("parses the exact onboarding origin literal", async () => {
    const stored = await storeReading(
      rawBuild(LOCAL_TRADING_ISOLATED_ONBOARDING_V1_BUILD_ORIGIN),
    ).getBuild(build.build_id);

    expect(stored?.originProfile).toBe(
      LOCAL_TRADING_ISOLATED_ONBOARDING_V1_BUILD_ORIGIN,
    );
  });

  it.each([
    "local-trading-isolated-onboarding",
    "local-trading-isolated-onboarding-v1 ",
    "LOCAL-TRADING-ISOLATED-ONBOARDING-V1",
    "local-wallet-isolated-onboarding-v1",
    "local-trading-isolated-v1-onboarding",
  ])("rejects unsupported stored origin literal %s", async (originProfile) => {
    await expect(
      storeReading(rawBuild(originProfile)).getBuild(build.build_id),
    ).rejects.toBeInstanceOf(StoreDataError);
  });
});
