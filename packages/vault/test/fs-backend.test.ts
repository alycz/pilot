import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FsVaultBackend } from "../src/backends/fs";

const temporaryRoots: string[] = [];

async function temporaryVault(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pilot-vault-fs-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FsVaultBackend", () => {
  it("persists nested notes, lists them, and supports VAULT_PATH", async () => {
    const root = await temporaryVault();
    vi.stubEnv("VAULT_PATH", root);
    const backend = FsVaultBackend.fromEnv();

    await backend.write("Trades/ABC123.md", "# Trade\n\nPersisted locally.\n", "Record trade ABC123");

    expect(await backend.read("Trades/ABC123.md")).toBe("# Trade\n\nPersisted locally.\n");
    expect(await backend.list()).toEqual(["Trades/ABC123.md"]);
    expect(await backend.list("Trades")).toEqual(["Trades/ABC123.md"]);
    expect(await new FsVaultBackend(root).read("Trades/ABC123.md")).toBe("# Trade\n\nPersisted locally.\n");
    await expect(access(path.join(root, ".git"))).resolves.toBeUndefined();

    const log = await simpleGit(root).log();
    expect(log.total).toBe(1);
    expect(log.latest?.message).toBe("Record trade ABC123");
  });

  it("rejects traversal, absolute paths, and git metadata paths", async () => {
    const root = await temporaryVault();
    const backend = new FsVaultBackend(root);
    const outside = path.join(root, "..", "escaped.md");

    await expect(backend.write("../escaped.md", "secret")).rejects.toThrow(/traversal/i);
    await expect(backend.write("nested/../../escaped.md", "secret")).rejects.toThrow(/traversal/i);
    await expect(backend.read(outside)).rejects.toThrow(/relative/i);
    await expect(backend.list("..\\outside")).rejects.toThrow(/traversal/i);
    await expect(backend.write(".git/config", "malicious")).rejects.toThrow(/metadata/i);
    await expect(readFile(outside, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates exactly one commit for every successful write", async () => {
    const root = await temporaryVault();
    const backend = new FsVaultBackend(root);

    await Promise.all([
      backend.write("Journal/one.md", "one", "First write"),
      backend.write("Journal/two.md", "two", "Second write"),
      backend.write("Journal/one.md", "one", "Identical-content write"),
    ]);

    const log = await simpleGit(root).log();
    expect(log.total).toBe(3);
    expect(log.all.map((commit) => commit.message)).toEqual([
      "Identical-content write",
      "Second write",
      "First write",
    ]);
    expect(await backend.list("Journal")).toEqual(["Journal/one.md", "Journal/two.md"]);
  });

  it("rejects credential material in paths and commit messages before persistence", async () => {
    const root = await temporaryVault();
    const backend = new FsVaultBackend(root);
    await expect(
      backend.write("Pilot/sEd123456789ABCDEFGHJKLMNPQ.md", "safe"),
    ).rejects.toThrow(/cannot contain seeds/i);
    await expect(
      backend.write("Pilot/safe.md", "safe", "seed: sEd123456789ABCDEFGHJKLMNPQ"),
    ).rejects.toThrow(/cannot contain seeds/i);
    expect(await backend.list()).toEqual([]);
  });

  it("restores the previous file when a git commit fails", async () => {
    const root = await temporaryVault();
    const backend = new FsVaultBackend(root);
    await backend.write("Pilot/Profile.md", "before", "Initial");
    const indexLock = path.join(root, ".git", "index.lock");
    await writeFile(indexLock, "locked", "utf8");
    await expect(backend.write("Pilot/Profile.md", "after", "Rejected")).rejects.toThrow();
    await rm(indexLock, { force: true });
    expect(await readFile(path.join(root, "Pilot", "Profile.md"), "utf8")).toBe("before");
    expect((await simpleGit(root).log()).total).toBe(1);
  });

  it("limits pinned metadata discovery inside the requested subtree", async () => {
    const root = await temporaryVault();
    const backend = new FsVaultBackend(root);
    const prefix = "Pilot/Scopes/testnet/r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
    await backend.write(`${prefix}/Profile.md`, "profile", "Initialize scoped tree");
    const journal = path.join(root, ...prefix.split("/"), "Journal");
    const junk = path.join(root, ...prefix.split("/"), "000-junk");
    const unrelated = path.join(root, "Pilot", "Scopes", "testnet", "rOtherOwner", "Journal");
    await mkdir(journal, { recursive: true });
    await mkdir(junk, { recursive: true });
    await mkdir(unrelated, { recursive: true });
    await Promise.all([
      ...Array.from({ length: 300 }, (_, index) =>
        writeFile(path.join(journal, `${String(index).padStart(3, "0")}.md`), "x", "utf8")),
      ...Array.from({ length: 10 }, (_, index) =>
        writeFile(path.join(junk, `${index}.json`), "{}", "utf8")),
      writeFile(path.join(unrelated, "private.md"), "unrelated", "utf8"),
    ]);
    const git = simpleGit(root);
    await git.add(["Pilot"]);
    await git.commit("Add large scoped trees");

    const snapshot = await backend.openReadSnapshot({ prefix, maxEntries: 3 });
    const entries = await snapshot.list(prefix);

    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.path.startsWith(`${prefix}/`))).toBe(true);
    expect(entries.some((entry) => entry.path.includes("rOtherOwner"))).toBe(false);
    await expect(backend.openReadSnapshot({
      prefix,
      maxEntries: 3,
      maxScannedEntries: 4,
      suffix: ".md",
    })).rejects.toThrow(/scan limit/i);
  });
});
