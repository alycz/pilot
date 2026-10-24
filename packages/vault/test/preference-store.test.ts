import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FsStructuredPreferenceStore } from "../src/preference-store";

const roots: string[] = [];
const scope = {
  tenantId: "pilot-local",
  owner: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
  network: "testnet" as const,
};

async function temporaryRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "pilot-preferences-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FsStructuredPreferenceStore", () => {
  it("allows only one concurrent compare-and-swap winner across instances", async () => {
    const root = await temporaryRoot();
    const first = new FsStructuredPreferenceStore(root);
    const second = new FsStructuredPreferenceStore(root);
    const attempts = await Promise.allSettled([
      first.compareAndSwap(scope, null, "{\"writer\":1}\n"),
      second.compareAndSwap(scope, null, "{\"writer\":2}\n"),
    ]);
    const winners = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<boolean> =>
        attempt.status === "fulfilled" && attempt.value,
    );
    expect(winners).toHaveLength(1);
    expect(["{\"writer\":1}\n", "{\"writer\":2}\n"]).toContain(await first.read(scope));
    expect(await readdir(root)).not.toContain(".personalization.lock");
  });

  it("never recovers an existing lock automatically", async () => {
    const root = await temporaryRoot();
    await writeFile(path.join(root, ".personalization.lock"), JSON.stringify({
      pid: 2_000_000_000,
      token: "dead-owner",
    }), { encoding: "utf8", mode: 0o600 });
    const store = new FsStructuredPreferenceStore(root);
    await expect(store.compareAndSwap(scope, null, "{}\n")).rejects.toThrow(/storage is busy/i);
    expect(await store.read(scope)).toBeNull();
  });

  it("fails closed on an unverifiable lock instead of deleting it", async () => {
    const root = await temporaryRoot();
    const lockPath = path.join(root, ".personalization.lock");
    await writeFile(lockPath, "not-json", { encoding: "utf8", mode: 0o600 });
    const store = new FsStructuredPreferenceStore(root);
    await expect(store.compareAndSwap(scope, null, "{}\n")).rejects.toThrow(/storage is busy/i);
    expect(await readFile(lockPath, "utf8")).toBe("not-json");
  });

  it("uses atomic replacement and leaves no temporary file", async () => {
    const root = await temporaryRoot();
    const store = new FsStructuredPreferenceStore(root);
    await expect(store.compareAndSwap(scope, null, "{\"revision\":1}\n")).resolves.toBe(true);
    await expect(store.compareAndSwap(scope, "wrong", "{\"revision\":2}\n")).resolves.toBe(false);
    await expect(store.compareAndSwap(
      scope,
      "{\"revision\":1}\n",
      "{\"revision\":2}\n",
    )).resolves.toBe(true);
    expect(await store.read(scope)).toBe("{\"revision\":2}\n");
    const directory = path.join(root, "pilot-local", "testnet", scope.owner);
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps workflow lessons in a separate CAS resource under the same process-safe lock", async () => {
    const root = await temporaryRoot();
    const first = new FsStructuredPreferenceStore(root);
    const second = new FsStructuredPreferenceStore(root);
    await expect(first.compareAndSwap(scope, null, "{\"preference\":1}\n")).resolves.toBe(true);
    const attempts = await Promise.allSettled([
      first.compareAndSwapWorkflowLessons(scope, null, "{\"lesson\":1}\n"),
      second.compareAndSwapWorkflowLessons(scope, null, "{\"lesson\":2}\n"),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled" && attempt.value)).toHaveLength(1);
    expect(await first.read(scope)).toBe("{\"preference\":1}\n");
    expect(["{\"lesson\":1}\n", "{\"lesson\":2}\n"]).toContain(await first.readWorkflowLessons(scope));
    expect(await readdir(root)).not.toContain(".personalization.lock");
  });

  it("rejects symlinked state roots and roots inside the Git-backed vault", async () => {
    const parent = await temporaryRoot();
    const target = path.join(parent, "private-target");
    const link = path.join(parent, "private-link");
    const vault = path.join(parent, "vault");
    await Promise.all([mkdir(target), mkdir(vault)]);
    await symlink(target, link);
    await expect(new FsStructuredPreferenceStore(link).read(scope)).rejects.toThrow(/symbolic link/i);
    await expect(new FsStructuredPreferenceStore(
      path.join(vault, "personalization"),
      vault,
    ).read(scope)).rejects.toThrow(/outside the Git-backed vault/i);
  });

  it("rejects an existing state root with group or world access", async () => {
    const root = await temporaryRoot();
    await chmod(root, 0o755);
    await expect(new FsStructuredPreferenceStore(root).read(scope)).rejects.toThrow(/permissions/i);
  });
});
