import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  privateBacktestCacheDirectory,
  TempPrivateDailyBarCache,
  validatePrivateBacktestCacheDirectory,
} from "./private-cache";

const cleanup = new Set<string>();

async function temporaryDirectory(prefix = "pilot-cache-test-"): Promise<string> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), prefix));
  cleanup.add(directory);
  return directory;
}

function record(cacheKey = "test/private-cache") {
  return {
    cacheKey,
    scope: "private-local-outside-repository" as const,
    metadataRaw: "metadata",
    ohlcRaw: "ohlc",
    dataset: {} as never,
  };
}

afterEach(async () => {
  await Promise.all([...cleanup].map((path) => rm(path, { recursive: true, force: true })));
  cleanup.clear();
});

describe("private daily-bar cache", () => {
  it("creates one unpredictable owner-private canonical directory under the OS temp root", async () => {
    const directory = await privateBacktestCacheDirectory();
    const root = await realpath(tmpdir());
    expect(`${directory}/`.startsWith(`${root}/`)).toBe(true);
    expect(directory).toMatch(/pilot-private-backtests-[A-Za-z0-9_-]{6}$/);
    expect(await realpath(directory)).toBe(directory);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it("writes bounded private records with restrictive permissions and exact retention", async () => {
    const directory = await temporaryDirectory();
    const cache = new TempPrivateDailyBarCache(directory, 60_000, 2);
    await cache.write(record("first"));
    await cache.write(record("second"));
    await cache.write(record("third"));
    const files = await readdir(directory);
    expect(files).toHaveLength(2);
    expect(files.every((file) => /^[a-f0-9]{64}\.json$/.test(file))).toBe(true);
    const modes = await Promise.all(files.map((file) => stat(join(directory, file)).then((value) => value.mode & 0o777)));
    expect(modes).toEqual([0o600, 0o600]);
  });

  it("rejects a symlinked cache directory without modifying its target", async () => {
    const target = await temporaryDirectory("pilot-cache-target-");
    const parent = await temporaryDirectory("pilot-cache-parent-");
    const link = join(parent, "cache-link");
    await symlink(target, link, "dir");
    await expect(new TempPrivateDailyBarCache(link).write(record())).rejects.toThrow(/symbolic link|canonical/i);
    expect((await stat(target)).mode & 0o777).toBe(0o700);
    expect(await readdir(target)).toEqual([]);
  });

  it("rejects wrong ownership and mode instead of repairing an untrusted directory", async () => {
    const directory = await temporaryDirectory();
    const actual = await stat(directory);
    const root = await realpath(tmpdir());
    await expect(validatePrivateBacktestCacheDirectory(directory, {
      lstat: async () => ({
        dev: actual.dev,
        ino: actual.ino,
        mode: actual.mode,
        nlink: actual.nlink,
        size: actual.size,
        uid: actual.uid + 1,
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false,
      }),
      realpath: async (path) => path,
      currentUid: () => actual.uid,
      temporaryRoot: () => root,
    })).rejects.toThrow(/owned by the current user/i);

    await chmod(directory, 0o755);
    await expect(new TempPrivateDailyBarCache(directory).write(record())).rejects.toThrow(/mode 0700/i);
    expect((await stat(directory)).mode & 0o777).toBe(0o755);
  });

  it("rejects a symlink at the digest target and leaves the external target unchanged", async () => {
    const directory = await temporaryDirectory();
    const externalDirectory = await temporaryDirectory("pilot-cache-external-");
    const external = join(externalDirectory, "outside.json");
    await writeFile(external, "unchanged", { mode: 0o600 });
    const key = "symlink-target";
    const digest = createHash("sha256").update(key, "utf8").digest("hex");
    await symlink(external, join(directory, `${digest}.json`));
    await expect(new TempPrivateDailyBarCache(directory).write(record(key))).rejects.toThrow(/cache file|safe regular file/i);
    expect(await readFile(external, "utf8")).toBe("unchanged");
  });
});
