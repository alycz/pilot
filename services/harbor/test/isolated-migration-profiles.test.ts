import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { open as openFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FREE_QUICKJS_MIGRATION_DIRECTORY,
  FREE_QUICKJS_MIGRATIONS,
  TRADING_ISOLATED_V1_MIGRATION_DIRECTORY,
  TRADING_ISOLATED_V1_MIGRATIONS,
  X402_ISOLATED_V1_MIGRATION_DIRECTORY,
  X402_ISOLATED_V1_MIGRATIONS,
  validateIsolatedMigrationProfile,
} from "../scripts/isolated-migration-profiles.mjs";

const roots: string[] = [];
const profiles = ["free-quickjs", "trading-isolated-v1", "x402-isolated-v1"] as const;
type Profile = (typeof profiles)[number];

function profileContract(profile: Profile) {
  if (profile === "free-quickjs") {
    return {
      directory: FREE_QUICKJS_MIGRATION_DIRECTORY,
      names: FREE_QUICKJS_MIGRATIONS,
      sourceDirectory: "migrations",
    };
  }
  if (profile === "trading-isolated-v1") {
    return {
      directory: TRADING_ISOLATED_V1_MIGRATION_DIRECTORY,
      names: TRADING_ISOLATED_V1_MIGRATIONS,
      sourceDirectory: "migrations",
    };
  }
  return {
    directory: X402_ISOLATED_V1_MIGRATION_DIRECTORY,
    names: X402_ISOLATED_V1_MIGRATIONS,
    sourceDirectory: "migrations-local-x402",
  };
}

function syntheticProfile(
  profile: Profile,
): {
  profileRoot: string;
  repoRoot: string;
  sourceRoot: string;
  names: readonly string[];
} {
  const repoRoot = mkdtempSync(join(process.cwd(), ".migration-profile-test-"));
  roots.push(repoRoot);
  const contract = profileContract(profile);
  const sourceRoot = join(repoRoot, contract.sourceDirectory);
  const profileRoot = join(repoRoot, contract.directory);
  const names = contract.names;
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(profileRoot, { recursive: true });
  for (const name of names) {
    const content = readFileSync(join(
      process.cwd(),
      contract.sourceDirectory,
      name,
    ));
    writeFileSync(join(sourceRoot, name), content);
    writeFileSync(join(profileRoot, name), content);
  }
  return { profileRoot, repoRoot, sourceRoot, names };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("isolated migration profiles", () => {
  it.each([
    ["free-quickjs", FREE_QUICKJS_MIGRATION_DIRECTORY],
    ["trading-isolated-v1", TRADING_ISOLATED_V1_MIGRATION_DIRECTORY],
    ["x402-isolated-v1", X402_ISOLATED_V1_MIGRATION_DIRECTORY],
  ] as const)("validates the checked-in %s frozen profile", async (profile, directory) => {
    await expect(validateIsolatedMigrationProfile(process.cwd(), profile)).resolves.toEqual({
      migrationNames: profileContract(profile).names,
      profileDirectory: directory,
    });
  });

  it("keeps unrelated combined migrations outside exact isolated forward profiles", () => {
    expect(TRADING_ISOLATED_V1_MIGRATIONS).toEqual([
      "0001_init.sql",
      "0002_build_capability_isolation.sql",
      "0002_quicknode.sql",
      "0003_execution_lifetime_v2.sql",
      "0004_v2_preflight_rejections.sql",
      "0005_v2_approval_recovery.sql",
      "0006_local_trading_isolated_onboarding_v1.sql",
      "0012_isolated_sequence_authority.sql",
      "0014_declarative_strategies.sql",
    ]);
    expect(X402_ISOLATED_V1_MIGRATIONS).toEqual([
      "0001_init.sql",
      "0002_x402_payments.sql",
      "0003_x402_payers.sql",
      "0004_x402_sequence_safety.sql",
      "0005_x402_durable_lease.sql",
      "0006_x402_budget_accounting.sql",
      "0007_x402_payer_provisioning.sql",
      "0009_isolated_sequence_authority.sql",
      "0010_issued_x402_authority.sql",
    ]);
    expect(TRADING_ISOLATED_V1_MIGRATIONS).not.toContain(
      "0008_ap4m_shared_runtime.sql",
    );
    expect(X402_ISOLATED_V1_MIGRATIONS).not.toContain(
      "0008_ap4m_shared_runtime.sql",
    );

    expect(TRADING_ISOLATED_V1_MIGRATIONS.at(-1)).toBe(
      "0014_declarative_strategies.sql",
    );
    expect(X402_ISOLATED_V1_MIGRATIONS.at(-1)).toBe(
      "0010_issued_x402_authority.sql",
    );
  });

  it.each([
    ["free-quickjs", "9999_unreviewed.sql"],
    ["trading-isolated-v1", "9999_unreviewed.sql"],
    ["x402-isolated-v1", "9999_unreviewed.sql"],
    ["free-quickjs", "0007_duplicate.sql"],
    ["trading-isolated-v1", "0006_duplicate.sql"],
    ["x402-isolated-v1", "0007_duplicate.sql"],
  ] as const)(
    "rejects unexpected later or duplicate migration %s/%s",
    async (profile, unexpected) => {
      const fixture = syntheticProfile(profile);
      writeFileSync(join(fixture.profileRoot, unexpected), "SELECT 1;\n");
      await expect(validateIsolatedMigrationProfile(fixture.repoRoot, profile))
        .rejects.toThrow(`Isolated ${profile} migration profile is missing or stale`);
    },
  );

  it.each(profiles)(
    "rejects matching source and profile content drift in %s",
    async (profile) => {
      const fixture = syntheticProfile(profile);
      const name = fixture.names[0]!;
      writeFileSync(join(fixture.sourceRoot, name), "-- matching but unreviewed\n");
      writeFileSync(join(fixture.profileRoot, name), "-- matching but unreviewed\n");
      await expect(validateIsolatedMigrationProfile(fixture.repoRoot, profile))
        .rejects.toThrow(`Isolated ${profile} migration profile is missing or stale`);
    },
  );

  it.each(profiles)(
    "rejects missing or byte-drifted migrations in %s",
    async (profile) => {
      const missing = syntheticProfile(profile);
      rmSync(join(missing.profileRoot, missing.names.at(-1)!));
      await expect(validateIsolatedMigrationProfile(missing.repoRoot, profile))
        .rejects.toThrow(`Isolated ${profile} migration profile is missing or stale`);

      const drifted = syntheticProfile(profile);
      writeFileSync(join(drifted.profileRoot, drifted.names[0]!), "-- drifted\n");
      await expect(validateIsolatedMigrationProfile(drifted.repoRoot, profile))
        .rejects.toThrow(`Isolated ${profile} migration profile is missing or stale`);
    },
  );

  it.each(profiles)(
    "rejects a linked migration in %s",
    async (profile) => {
      const fixture = syntheticProfile(profile);
      const name = fixture.names[0]!;
      rmSync(join(fixture.profileRoot, name));
      symlinkSync(join(fixture.sourceRoot, name), join(fixture.profileRoot, name));
      await expect(validateIsolatedMigrationProfile(fixture.repoRoot, profile))
        .rejects.toThrow(`Isolated ${profile} migration profile is missing or stale`);
    },
  );

  it.each(profiles)(
    "rejects symlinked source and profile directories in %s",
    async (profile) => {
      const linkedProfile = syntheticProfile(profile);
      const realProfileRoot = `${linkedProfile.profileRoot}-real`;
      renameSync(linkedProfile.profileRoot, realProfileRoot);
      symlinkSync(realProfileRoot, linkedProfile.profileRoot, "dir");
      await expect(validateIsolatedMigrationProfile(linkedProfile.repoRoot, profile))
        .rejects.toThrow(`Isolated ${profile} migration profile is missing or stale`);

      const linkedSource = syntheticProfile(profile);
      const realSourceRoot = `${linkedSource.sourceRoot}-real`;
      renameSync(linkedSource.sourceRoot, realSourceRoot);
      symlinkSync(realSourceRoot, linkedSource.sourceRoot, "dir");
      await expect(validateIsolatedMigrationProfile(linkedSource.repoRoot, profile))
        .rejects.toThrow(`Isolated ${profile} migration profile is missing or stale`);
    },
  );

  it.each(profiles)(
    "rejects hard-linked migrations in %s",
    async (profile) => {
      const fixture = syntheticProfile(profile);
      const name = fixture.names[0]!;
      rmSync(join(fixture.profileRoot, name));
      linkSync(join(fixture.sourceRoot, name), join(fixture.profileRoot, name));
      await expect(validateIsolatedMigrationProfile(fixture.repoRoot, profile))
        .rejects.toThrow(`Isolated ${profile} migration profile is missing or stale`);
    },
  );

  it.each(profiles)(
    "rejects a migration path swapped after descriptor open in %s",
    async (profile) => {
      const fixture = syntheticProfile(profile);
      const name = fixture.names[0]!;
      const target = join(fixture.profileRoot, name);
      const original = join(fixture.repoRoot, `${name}.original`);
      const replacement = join(fixture.repoRoot, `${name}.replacement`);
      writeFileSync(replacement, "-- swapped after open\n");
      let swapped = false;
      await expect(validateIsolatedMigrationProfile(fixture.repoRoot, profile, {
        openFile: async (path, flags) => {
          const handle = await openFile(path, flags);
          if (!swapped && path === target) {
            swapped = true;
            renameSync(target, original);
            renameSync(replacement, target);
          }
          return handle;
        },
      })).rejects.toThrow(`Isolated ${profile} migration profile is missing or stale`);
      expect(swapped).toBe(true);
    },
  );

  it.each(profiles)(
    "rejects a profile directory swapped after descriptor open in %s",
    async (profile) => {
      const fixture = syntheticProfile(profile);
      const target = join(fixture.profileRoot, fixture.names[0]!);
      const movedProfileRoot = `${fixture.profileRoot}-moved`;
      let swapped = false;
      await expect(validateIsolatedMigrationProfile(fixture.repoRoot, profile, {
        openFile: async (path, flags) => {
          const handle = await openFile(path, flags);
          if (!swapped && path === target) {
            swapped = true;
            renameSync(fixture.profileRoot, movedProfileRoot);
            symlinkSync(movedProfileRoot, fixture.profileRoot, "dir");
          }
          return handle;
        },
      })).rejects.toThrow(`Isolated ${profile} migration profile is missing or stale`);
      expect(swapped).toBe(true);
    },
  );
});
