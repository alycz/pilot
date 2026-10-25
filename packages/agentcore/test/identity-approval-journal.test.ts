import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFileAgentCoreIdentityApprovalJournal } from "../src/identity-approval-journal";

const RUN_ID = "00000000-0000-4000-8000-000000000004";
const APPROVED_AT = "2026-10-25T12:00:00.000Z";
const cleanup = new Set<string>();

async function fixtureRoot(): Promise<string> {
  const base = await mkdtemp(join(homedir(), ".pilot-agentcore-approval-test-"));
  cleanup.add(base);
  return join(base, "journal");
}

afterEach(async () => {
  await Promise.all([...cleanup].map((path) => rm(path, { recursive: true, force: true })));
  cleanup.clear();
});

describe("AgentCore identity acceptance approval journal", () => {
  it("consumes a fresh claim exactly once across journal instances and restart", async () => {
    const root = await fixtureRoot();
    await createFileAgentCoreIdentityApprovalJournal({ root }).consume({ runId: RUN_ID, approvedAt: APPROVED_AT });
    await expect(createFileAgentCoreIdentityApprovalJournal({ root }).consume({
      runId: RUN_ID.toUpperCase(),
      approvedAt: APPROVED_AT,
    })).rejects.toThrow("already consumed");
  });

  it("allows exactly one concurrent consumer for the same run ID", async () => {
    const root = await fixtureRoot();
    const first = createFileAgentCoreIdentityApprovalJournal({ root });
    const second = createFileAgentCoreIdentityApprovalJournal({ root });
    const results = await Promise.allSettled([
      first.consume({ runId: RUN_ID, approvedAt: APPROVED_AT }),
      second.consume({ runId: RUN_ID, approvedAt: APPROVED_AT }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("rejects unsafe directory modes and symlink roots", async () => {
    const unsafe = await fixtureRoot();
    await mkdir(unsafe, { mode: 0o700 });
    await chmod(unsafe, 0o777);
    await expect(createFileAgentCoreIdentityApprovalJournal({ root: unsafe }).consume({
      runId: RUN_ID,
      approvedAt: APPROVED_AT,
    })).rejects.toThrow("permissions are unsafe");

    const target = await fixtureRoot();
    await mkdir(target, { mode: 0o700 });
    const linked = await fixtureRoot();
    await symlink(target, linked);
    await expect(createFileAgentCoreIdentityApprovalJournal({ root: linked }).consume({
      runId: RUN_ID,
      approvedAt: APPROVED_AT,
    })).rejects.toThrow(/unsafe|canonical/);

    const unsafeAncestor = await mkdtemp(join(homedir(), ".pilot-agentcore-approval-unsafe-"));
    cleanup.add(unsafeAncestor);
    await chmod(unsafeAncestor, 0o777);
    await expect(createFileAgentCoreIdentityApprovalJournal({
      root: join(unsafeAncestor, "journal"),
    }).consume({
      runId: RUN_ID,
      approvedAt: APPROVED_AT,
    })).rejects.toThrow("permissions are unsafe");
  });

  it("fails closed for empty or corrupt preexisting claim files", async () => {
    for (const contents of ["", "not-json\n"]) {
      const root = await fixtureRoot();
      await mkdir(root, { mode: 0o700 });
      await writeFile(join(root, `${RUN_ID}.claim.json`), contents, { mode: 0o600 });
      await expect(createFileAgentCoreIdentityApprovalJournal({ root }).consume({
        runId: RUN_ID,
        approvedAt: APPROVED_AT,
      })).rejects.toThrow("already consumed");
    }
  });
});
