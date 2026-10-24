import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isolatedOnboardingChildEnvironment,
  isolatedOnboardingCommands,
  main as onboardingMain,
  prepareIsolatedOnboardingLaunch,
} from "../scripts/dev-local-trading-isolated-v1-onboarding.mjs";
import {
  LOCAL_TRADING_ISOLATED_V1_STATE_ROOT,
  findIsolatedTradingD1Payload,
  isolatedTradingChildEnvironment,
  isolatedTradingCommands,
  main as tradingMain,
  prepareIsolatedTradingLaunch,
  validateExistingIsolatedTradingState,
  validatePinnedIsolatedTradingStateRoot,
} from "../scripts/dev-local-trading-isolated-v1.mjs";
import {
  TRADING_ISOLATED_V1_MIGRATIONS,
} from "../scripts/isolated-migration-profiles.mjs";
import {
  isolatedX402Commands,
} from "../scripts/dev-local-x402-isolated-v1.mjs";

const roots: string[] = [];
const PAYLOAD_NAME = `${"a".repeat(64)}.sqlite`;
const EXTRA_PAYLOAD_NAME = `${"b".repeat(64)}.sqlite`;
const OBSERVABILITY_PAYLOAD_NAME = `${"c".repeat(64)}.sqlite`;

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(process.cwd(), `.harbor-${label}-`));
  roots.push(root);
  return root;
}

function privateStateFixture(
  label: string,
  {
    d1Metadata = true,
    extraD1Sqlite = false,
    nestedD1Sqlite = false,
    payloadKind = "harbor",
    payloadName = PAYLOAD_NAME,
  }: {
    d1Metadata?: boolean;
    extraD1Sqlite?: boolean;
    nestedD1Sqlite?: boolean;
    payloadKind?: "corrupt" | "harbor" | "missing" | "wrong-schema";
    payloadName?: string;
  } = {},
): string {
  const root = temporaryRoot(label);
  const state = join(root, "state");
  const cacheDirectory = join(state, "v3", "cache", "miniflare-CacheObject");
  const databaseDirectory = join(
    state,
    "v3",
    "d1",
    "miniflare-D1DatabaseObject",
  );
  mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(databaseDirectory, { recursive: true, mode: 0o700 });
  for (const directory of [
    state,
    join(state, "v3"),
    join(state, "v3", "cache"),
    cacheDirectory,
    join(state, "v3", "d1"),
    databaseDirectory,
  ]) chmodSync(directory, 0o700);

  const createSqlite = (path: string, schema?: string) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    const database = new DatabaseSync(path);
    if (schema) database.exec(schema);
    database.close();
    chmodSync(path, 0o600);
  };
  for (const ancillaryPath of [
    join(cacheDirectory, "metadata.sqlite"),
    join(state, "v3", "kv", "miniflare-KVNamespaceObject", "metadata.sqlite"),
    join(
      state,
      "v3",
      "observability",
      "miniflare-wobs-trace-store",
      "metadata.sqlite",
    ),
    join(
      state,
      "v3",
      "observability",
      "miniflare-wobs-trace-store",
      OBSERVABILITY_PAYLOAD_NAME,
    ),
    join(state, "v3", "r2", "miniflare-R2BucketObject", "metadata.sqlite"),
  ]) createSqlite(ancillaryPath);
  if (d1Metadata) createSqlite(join(databaseDirectory, "metadata.sqlite"));

  const databasePath = join(databaseDirectory, payloadName);
  if (payloadKind === "harbor") {
    const database = new DatabaseSync(databasePath);
    database.exec(`CREATE TABLE d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`);
    for (const [index, name] of TRADING_ISOLATED_V1_MIGRATIONS.entries()) {
      database.exec(readFileSync(join(process.cwd(), "migrations", name), "utf8"));
      database.prepare("INSERT INTO d1_migrations(id, name) VALUES (?, ?)")
        .run(index + 1, name);
    }
    database.close();
    chmodSync(databasePath, 0o600);
  } else if (payloadKind === "wrong-schema") {
    createSqlite(databasePath);
  } else if (payloadKind === "corrupt") {
    writeFileSync(databasePath, "not sqlite", { mode: 0o600 });
  }
  if (extraD1Sqlite) {
    const database = new DatabaseSync(join(databaseDirectory, EXTRA_PAYLOAD_NAME));
    database.exec(readFileSync(join(process.cwd(), "migrations", "0001_init.sql"), "utf8"));
    database.close();
    chmodSync(join(databaseDirectory, EXTRA_PAYLOAD_NAME), 0o600);
  }
  if (nestedD1Sqlite) {
    createSqlite(join(databaseDirectory, "unexpected", "nested.sqlite"));
  }
  return state;
}

function payloadPath(state: string): string {
  return join(
    state,
    "v3",
    "d1",
    "miniflare-D1DatabaseObject",
    PAYLOAD_NAME,
  );
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("local trading isolated v1 preserved state root", () => {
  it("keeps onboarding and trading persistence fixed across checkout changes", () => {
    const checkoutA = "/private/fake-checkout-a";
    const checkoutB = "/private/fake-checkout-b";

    for (const commands of [
      isolatedTradingCommands(checkoutA),
      isolatedTradingCommands(checkoutB),
      isolatedOnboardingCommands(checkoutA),
      isolatedOnboardingCommands(checkoutB),
    ]) {
      expect(valueAfter(commands[1]!.args, "--persist-to")).toBe(
        LOCAL_TRADING_ISOLATED_V1_STATE_ROOT,
      );
      expect(valueAfter(commands[2]!.args, "--persist-to")).toBe(
        LOCAL_TRADING_ISOLATED_V1_STATE_ROOT,
      );
    }

    expect(valueAfter(isolatedTradingCommands(checkoutA)[2]!.args, "--config"))
      .not.toBe(valueAfter(isolatedTradingCommands(checkoutB)[2]!.args, "--config"));
    expect(valueAfter(isolatedOnboardingCommands(checkoutA)[2]!.args, "--config"))
      .not.toBe(valueAfter(isolatedOnboardingCommands(checkoutB)[2]!.args, "--config"));
    expect(isolatedTradingChildEnvironment({}).WRANGLER_LOG_PATH).toBe(
      join(LOCAL_TRADING_ISOLATED_V1_STATE_ROOT, "wrangler.log"),
    );
    expect(isolatedOnboardingChildEnvironment({}).WRANGLER_LOG_PATH).toBe(
      join(LOCAL_TRADING_ISOLATED_V1_STATE_ROOT, "onboarding.wrangler.log"),
    );
  });

  it("keeps the isolated x402 D1 separate from preserved trading state", () => {
    const checkout = "/private/fake-checkout";
    const x402StateRoot = "/private/operator-state/harbor-local-x402-isolated-v1";
    const x402Persistence = valueAfter(
      isolatedX402Commands(checkout, x402StateRoot)[1]!.args,
      "--persist-to",
    );
    expect(x402Persistence).toBe(x402StateRoot);
    expect(x402Persistence).not.toContain(checkout);
    expect(x402Persistence).not.toBe(LOCAL_TRADING_ISOLATED_V1_STATE_ROOT);
  });

  it("selects only D1 from a real Miniflare multi-store layout", async () => {
    const state = privateStateFixture("safe-state");
    await expect(findIsolatedTradingD1Payload(state)).resolves.toBe(
      payloadPath(state),
    );
    await expect(validateExistingIsolatedTradingState(state)).resolves.toBeUndefined();
  });

  it.each([
    ["missing D1 metadata", { d1Metadata: false }],
    ["missing payload", { payloadKind: "missing" }],
    ["malformed payload name", { payloadName: "fixture.sqlite" }],
    ["second D1 payload", { extraD1Sqlite: true }],
    ["nested D1 sqlite", { nestedD1Sqlite: true }],
  ] as const)("rejects %s", async (_name, options) => {
    const state = privateStateFixture(`bad-layout-${_name.replaceAll(" ", "-")}`, options);
    await expect(validateExistingIsolatedTradingState(state)).rejects.toThrow(
      "preserved state is missing or unsafe",
    );
  });

  it("rejects corrupt and wrong-schema payloads", async () => {
    const corrupt = privateStateFixture("corrupt-payload", {
      payloadKind: "corrupt",
    });
    await expect(validateExistingIsolatedTradingState(corrupt)).rejects.toThrow(
      "preserved state is missing or unsafe",
    );
    const wrongSchema = privateStateFixture("wrong-schema", {
      payloadKind: "wrong-schema",
    });
    await expect(validateExistingIsolatedTradingState(wrongSchema)).rejects.toThrow(
      "preserved state is missing or unsafe",
    );
  });

  it.each([
    ["missing migration", "DELETE FROM d1_migrations WHERE id = 7"],
    ["renamed migration", "UPDATE d1_migrations SET name = '0007_unreviewed.sql' WHERE id = 7"],
    ["later migration", `INSERT INTO d1_migrations(id, name) VALUES (${
      TRADING_ISOLATED_V1_MIGRATIONS.length + 1
    }, '9999_unreviewed.sql')`],
  ] as const)("rejects %s history", async (_name, mutation) => {
    const state = privateStateFixture(`migration-${_name.replaceAll(" ", "-")}`);
    const database = new DatabaseSync(payloadPath(state));
    database.exec(mutation);
    database.close();
    await expect(validateExistingIsolatedTradingState(state)).rejects.toThrow(
      "preserved state is missing or unsafe",
    );
  });

  it("rejects missing and empty state roots", async () => {
    const missing = join(temporaryRoot("missing-state"), "missing");
    await expect(validateExistingIsolatedTradingState(missing)).rejects.toThrow(
      "preserved state is missing or unsafe",
    );

    const empty = join(temporaryRoot("empty-state"), "state");
    mkdirSync(empty, { mode: 0o700 });
    await expect(validateExistingIsolatedTradingState(empty)).rejects.toThrow(
      "preserved state is missing or unsafe",
    );
  });

  it("rejects alternate, symlinked, noncanonical, and permission-unsafe roots", async () => {
    const state = privateStateFixture("unsafe-state");
    const alternateValidator = vi.fn(async () => undefined);
    await expect(
      validatePinnedIsolatedTradingStateRoot(state, {
        validateState: alternateValidator,
        findDatabase: async () => payloadPath(state),
      }),
    ).rejects.toThrow("preserved state is missing or unsafe");
    expect(alternateValidator).not.toHaveBeenCalled();

    const alias = join(temporaryRoot("alias-state"), "alias");
    symlinkSync(state, alias, "dir");
    await expect(validateExistingIsolatedTradingState(alias)).rejects.toThrow(
      "preserved state is missing or unsafe",
    );
    await expect(
      validateExistingIsolatedTradingState(`${state}/v3/..`),
    ).rejects.toThrow("preserved state is missing or unsafe");

    const database = payloadPath(state);
    chmodSync(database, 0o644);
    await expect(validateExistingIsolatedTradingState(state)).rejects.toThrow(
      "preserved state is missing or unsafe",
    );

    const linkedState = privateStateFixture("linked-payload");
    const linkedPayload = payloadPath(linkedState);
    const linkTarget = join(temporaryRoot("payload-target"), "target.sqlite");
    writeFileSync(linkTarget, "not sqlite", { mode: 0o600 });
    rmSync(linkedPayload);
    symlinkSync(linkTarget, linkedPayload);
    await expect(validateExistingIsolatedTradingState(linkedState)).rejects.toThrow(
      "preserved state is missing or unsafe",
    );
  });

  it.each([
    ["trading", prepareIsolatedTradingLaunch, tradingMain],
    ["onboarding", prepareIsolatedOnboardingLaunch, onboardingMain],
  ] as const)("fails %s closed before secret access or process execution", async (
    _profile,
    prepare,
    launch,
  ) => {
    const validateConfiguration = vi.fn(async () => undefined);
    const validateMigrationProfile = vi.fn(async () => undefined);
    const validateState = vi.fn(async () => {
      throw new Error("preserved state is missing or unsafe");
    });
    const validateSecret = vi.fn(async () => ({
      HARBOR_API_KEYS: `fixture:${"A".repeat(32)}`,
      HARBOR_KEK: Buffer.alloc(32, 7).toString("base64"),
    }));

    await expect(prepare("/private/fake-checkout", {
      validateConfiguration,
      validateMigrationProfile,
      validateState,
      validateSecret,
    })).rejects.toThrow("preserved state is missing or unsafe");
    expect(validateState).toHaveBeenCalledExactlyOnceWith(
      LOCAL_TRADING_ISOLATED_V1_STATE_ROOT,
    );
    expect(validateMigrationProfile).toHaveBeenCalledExactlyOnceWith(
      "/private/fake-checkout",
    );
    expect(validateSecret).not.toHaveBeenCalled();

    const run = vi.fn();
    await expect(launch([], {
      prepareLaunch: async () => {
        throw new Error("preserved state is missing or unsafe");
      },
      run,
      setUmask: vi.fn(),
    })).rejects.toThrow("preserved state is missing or unsafe");
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["trading", prepareIsolatedTradingLaunch],
    ["onboarding", prepareIsolatedOnboardingLaunch],
  ] as const)("fails %s closed on migration profile drift before state or secret access", async (
    _profile,
    prepare,
  ) => {
    const validateState = vi.fn(async () => undefined);
    const validateSecret = vi.fn(async () => ({
      HARBOR_API_KEYS: `fixture:${"A".repeat(32)}`,
      HARBOR_KEK: Buffer.alloc(32, 7).toString("base64"),
    }));
    await expect(prepare("/private/fake-checkout", {
      validateConfiguration: async () => undefined,
      validateMigrationProfile: async () => {
        throw new Error("stale migration profile");
      },
      validateState,
      validateSecret,
    })).rejects.toThrow("stale migration profile");
    expect(validateState).not.toHaveBeenCalled();
    expect(validateSecret).not.toHaveBeenCalled();
  });

  it.each([
    ["trading", isolatedTradingCommands, tradingMain],
    ["onboarding", isolatedOnboardingCommands, onboardingMain],
  ] as const)("revalidates %s state after catalog and before migration", async (
    _profile,
    commands,
    launch,
  ) => {
    const plan = commands("/private/fake-checkout");
    const run = vi.fn(async () => undefined);
    const revalidateState = vi.fn(async () => {
      throw new Error("preserved state changed after catalog");
    });

    await expect(launch([], {
      environment: () => ({}),
      prepareLaunch: async () => plan,
      revalidateState,
      run,
      setUmask: vi.fn(),
    })).rejects.toThrow("preserved state changed after catalog");
    expect(run).toHaveBeenCalledExactlyOnceWith(plan[0], {});
    expect(revalidateState).toHaveBeenCalledOnce();
  });

  it.each([
    ["trading", isolatedTradingCommands, tradingMain],
    ["onboarding", isolatedOnboardingCommands, onboardingMain],
  ] as const)("revalidates %s migration profile after catalog and before migration", async (
    _profile,
    commands,
    launch,
  ) => {
    const plan = commands("/private/fake-checkout");
    const run = vi.fn(async () => undefined);
    const revalidateMigrationProfile = vi.fn(async () => {
      throw new Error("migration profile changed after catalog");
    });

    await expect(launch([], {
      environment: () => ({}),
      prepareLaunch: async () => plan,
      revalidateMigrationProfile,
      revalidateState: vi.fn(async () => undefined),
      run,
      setUmask: vi.fn(),
    })).rejects.toThrow("migration profile changed after catalog");
    expect(run).toHaveBeenCalledExactlyOnceWith(plan[0], {});
    expect(revalidateMigrationProfile).toHaveBeenCalledOnce();
  });
});
