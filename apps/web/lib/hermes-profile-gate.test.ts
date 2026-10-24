import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertHermesProfileGateUnchangedWithAclInspectorForTest,
  hermesAclHelperEnvironmentForTest,
  validatePrivateMacAclResult,
  PINNED_HERMES_COMMIT,
  PINNED_HERMES_VERSION,
  verifyHermesProfileGate,
  verifyHermesProfileGateWithAclInspectorForTest,
  type HermesProfileGateInput,
  type HermesProfileManifest,
} from "./hermes-profile-gate";
import { HERMES_PROFILE_RUNTIME_INVARIANTS } from "./hermes-profile-contract";

const roots: string[] = [];
const portableEmptyAcl = () => undefined;

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(
  mutateManifest?: (manifest: Record<string, unknown>) => void,
): Promise<{
  root: string;
  manifestPath: string;
  configPath: string;
  input: HermesProfileGateInput;
}> {
  const canonicalTmp = await realpath(tmpdir());
  const root = await mkdtemp(path.join(canonicalTmp, "pilot-hermes-gate-"));
  roots.push(root);
  await chmod(root, 0o700);
  const profiles = path.join(root, "profiles");
  await mkdir(profiles, { mode: 0o700 });
  await chmod(profiles, 0o700);

  const configPath = path.join(profiles, "pilot-proposal-v1.yaml");
  const config = [
    "profile: pilot-proposal-v1",
    "provider: pilot-egress-v1",
    "tools: []",
    "memory: false",
  ].join("\n");
  await writeFile(configPath, config, { mode: 0o600 });
  await chmod(configPath, 0o600);

  const manifest: HermesProfileManifest = {
    schemaVersion: "pilot.hermes-profile-manifest.v1",
    hermesVersion: PINNED_HERMES_VERSION,
    hermesCommit: PINNED_HERMES_COMMIT,
    profile: "pilot-proposal-v1",
    hermesOrigin: "http://127.0.0.1:8642",
    egressOrigin: "http://127.0.0.1:8644",
    provider: "pilot-egress-v1",
    model: "proposal-lease-v1",
    retentionDays: 7,
    profileConfigPath: configPath,
    profileConfigSha256: sha256(config),
    capabilities: {
      toolsets: "disabled",
      memory: "disabled",
      skills: "disabled",
      mcp: "disabled",
      background: "disabled",
      lazyInstall: "disabled",
    },
    runtimeInvariants: HERMES_PROFILE_RUNTIME_INVARIANTS,
  };
  mutateManifest?.(manifest as unknown as Record<string, unknown>);
  const manifestBytes = JSON.stringify(manifest);
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, manifestBytes, { mode: 0o600 });
  await chmod(manifestPath, 0o600);

  return {
    root,
    manifestPath,
    configPath,
    input: {
      privateRoot: root,
      manifestPath,
      manifestSha256: sha256(manifestBytes),
      profileConfigPath: configPath,
      expected: {
        profile: "pilot-proposal-v1",
        hermesOrigin: "http://127.0.0.1:8642",
        egressOrigin: "http://127.0.0.1:8644",
        provider: "pilot-egress-v1",
        model: "proposal-lease-v1",
        retentionDays: 7,
      },
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Hermes immutable profile gate", () => {
  it("accepts only the native empty-ACL classification", () => {
    expect(() => validatePrivateMacAclResult("EMPTY\n")).not.toThrow();
    for (const unsafe of ["ACCESS_GRANTING\n", "DENY_ONLY\n", "", "EMPTY\nextra"]) {
      expect(() => validatePrivateMacAclResult(unsafe)).toThrow(
        "Hermes immutable profile verification failed",
      );
    }
  });

  it("gives the ACL helper only a fixed locale and no inherited loader or credential environment", () => {
    const originalRubyOpt = process.env.RUBYOPT;
    const originalCredential = process.env.HERMES_API_KEY;
    process.env.RUBYOPT = "-r/tmp/untrusted.rb";
    process.env.HERMES_API_KEY = "must-not-leak";
    try {
      const helperEnvironment = hermesAclHelperEnvironmentForTest();
      expect(Object.keys(helperEnvironment).sort()).toEqual(["LANG", "LC_ALL"]);
      expect(helperEnvironment).toEqual({ LANG: "C", LC_ALL: "C" });
      expect(helperEnvironment).not.toHaveProperty("RUBYOPT");
      expect(helperEnvironment).not.toHaveProperty("RUBYLIB");
      expect(helperEnvironment).not.toHaveProperty("HERMES_API_KEY");
    } finally {
      if (originalRubyOpt === undefined) delete process.env.RUBYOPT;
      else process.env.RUBYOPT = originalRubyOpt;
      if (originalCredential === undefined) delete process.env.HERMES_API_KEY;
      else process.env.HERMES_API_KEY = originalCredential;
    }
  });

  it("uses the injected ACL result in portable structural tests", async () => {
    const test = await fixture();
    const grantingAcl = (target: string) => {
      if (target === test.configPath) {
        throw new Error("Hermes immutable profile verification failed");
      }
    };
    await expect(
      verifyHermesProfileGateWithAclInspectorForTest(test.input, grantingAcl),
    ).rejects.toThrow("Hermes immutable profile verification failed");
  });

  it.runIf(process.platform === "darwin")(
    "rejects an access-granting macOS ACL and accepts the same private fixture after ACL removal",
    async () => {
      const test = await fixture();
      execFileSync("/bin/chmod", ["+a", "everyone allow read", test.configPath]);
      await expect(verifyHermesProfileGate(test.input)).rejects.toThrow(
        "Hermes immutable profile verification failed",
      );
      execFileSync("/bin/chmod", ["-N", test.configPath]);
      await expect(verifyHermesProfileGate(test.input)).resolves.toBeDefined();
    },
  );

  it.runIf(process.platform !== "darwin")(
    "fails closed when the native macOS ACL inspector is unavailable",
    async () => {
      const test = await fixture();
      await expect(verifyHermesProfileGate(test.input)).rejects.toThrow(
        "Hermes immutable profile verification failed",
      );
    },
  );

  it("verifies a pinned, private, zero-capability profile and revalidates it", async () => {
    const test = await fixture();
    const snapshot = await verifyHermesProfileGateWithAclInspectorForTest(
      test.input,
      portableEmptyAcl,
    );

    expect(snapshot.manifest).toMatchObject({
      hermesVersion: PINNED_HERMES_VERSION,
      hermesCommit: PINNED_HERMES_COMMIT,
      profile: "pilot-proposal-v1",
      provider: "pilot-egress-v1",
      capabilities: {
        toolsets: "disabled",
        memory: "disabled",
        skills: "disabled",
        mcp: "disabled",
        background: "disabled",
        lazyInstall: "disabled",
      },
      runtimeInvariants: HERMES_PROFILE_RUNTIME_INVARIANTS,
    });
    expect(snapshot.manifestFile).not.toHaveProperty("bytes");
    expect(snapshot.profileConfigFile).not.toHaveProperty("bytes");
    await expect(
      assertHermesProfileGateUnchangedWithAclInspectorForTest(snapshot, portableEmptyAcl),
    ).resolves.toBeUndefined();
  });

  it("rejects unknown manifest fields and any enabled capability", async () => {
    const unknown = await fixture((manifest) => {
      manifest.unreviewed = true;
    });
    await expect(verifyHermesProfileGateWithAclInspectorForTest(
      unknown.input,
      portableEmptyAcl,
    )).rejects.toThrow(
      "Hermes immutable profile verification failed",
    );

    const enabled = await fixture((manifest) => {
      manifest.capabilities = {
        ...(manifest.capabilities as Record<string, unknown>),
        memory: "enabled",
      };
    });
    await expect(verifyHermesProfileGateWithAclInspectorForTest(
      enabled.input,
      portableEmptyAcl,
    )).rejects.toThrow(
      "Hermes immutable profile verification failed",
    );

    const retrying = await fixture((manifest) => {
      manifest.runtimeInvariants = {
        ...HERMES_PROFILE_RUNTIME_INVARIANTS,
        apiMaxRetries: 2,
      };
    });
    await expect(verifyHermesProfileGateWithAclInspectorForTest(
      retrying.input,
      portableEmptyAcl,
    )).rejects.toThrow("Hermes immutable profile verification failed");
  });

  it("rejects mismatched pins, disclosure, paths, and non-dedicated ports", async () => {
    const test = await fixture();
    await expect(verifyHermesProfileGateWithAclInspectorForTest({
      ...test.input,
      manifestSha256: "0".repeat(64),
    }, portableEmptyAcl)).rejects.toThrow("Hermes immutable profile verification failed");
    await expect(verifyHermesProfileGateWithAclInspectorForTest({
      ...test.input,
      expected: { ...test.input.expected, provider: "other-provider" },
    }, portableEmptyAcl)).rejects.toThrow("Hermes immutable profile verification failed");
    await expect(verifyHermesProfileGateWithAclInspectorForTest({
      ...test.input,
      expected: {
        ...test.input.expected,
        egressOrigin: test.input.expected.hermesOrigin,
      },
    }, portableEmptyAcl)).rejects.toThrow("Hermes immutable profile verification failed");
    await expect(verifyHermesProfileGateWithAclInspectorForTest({
      ...test.input,
      profileConfigPath: path.join(test.root, "different.yaml"),
    }, portableEmptyAcl)).rejects.toThrow("Hermes immutable profile verification failed");
  });

  it("rejects unsafe permissions anywhere below the private root", async () => {
    const unsafeFile = await fixture();
    await chmod(unsafeFile.configPath, 0o644);
    await expect(verifyHermesProfileGateWithAclInspectorForTest(
      unsafeFile.input,
      portableEmptyAcl,
    )).rejects.toThrow(
      "Hermes immutable profile verification failed",
    );

    const unsafeParent = await fixture();
    await chmod(path.dirname(unsafeParent.configPath), 0o755);
    await expect(verifyHermesProfileGateWithAclInspectorForTest(
      unsafeParent.input,
      portableEmptyAcl,
    )).rejects.toThrow(
      "Hermes immutable profile verification failed",
    );
  });

  it("rejects symlink and hardlink profile files", async () => {
    const linked = await fixture();
    const symlinkPath = path.join(linked.root, "linked-config.yaml");
    await symlink(linked.configPath, symlinkPath);
    await expect(verifyHermesProfileGateWithAclInspectorForTest({
      ...linked.input,
      profileConfigPath: symlinkPath,
    }, portableEmptyAcl)).rejects.toThrow("Hermes immutable profile verification failed");

    const hardlinked = await fixture();
    const hardlinkPath = path.join(hardlinked.root, "hardlink-config.yaml");
    await link(hardlinked.configPath, hardlinkPath);
    await expect(verifyHermesProfileGateWithAclInspectorForTest(
      hardlinked.input,
      portableEmptyAcl,
    )).rejects.toThrow(
      "Hermes immutable profile verification failed",
    );
  });

  it("detects changes made after the initial verification", async () => {
    const test = await fixture();
    const snapshot = await verifyHermesProfileGateWithAclInspectorForTest(
      test.input,
      portableEmptyAcl,
    );
    const original = await readFile(test.configPath, "utf8");
    await writeFile(test.configPath, `${original}\n# changed`, { mode: 0o600 });

    await expect(
      assertHermesProfileGateUnchangedWithAclInspectorForTest(snapshot, portableEmptyAcl),
    ).rejects.toThrow(
      "Hermes immutable profile verification failed",
    );
  });
});
