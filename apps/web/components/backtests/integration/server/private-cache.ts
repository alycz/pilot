import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { PrivateDailyBarCache, PrivateDailyBarCacheRecord } from "../../data";

const CACHE_DIRECTORY_PREFIX = "pilot-private-backtests-";
const MAX_CACHE_RECORD_BYTES = 2_000_000;
const FINAL_NAME = /^[a-f0-9]{64}\.json$/;
const TEMPORARY_NAME = /^\.[a-f0-9]{64}\.[a-f0-9]{32}\.tmp$/;

type CachePathMetadata = Readonly<{
  dev: number | bigint;
  ino: number | bigint;
  mode: number | bigint;
  nlink: number | bigint;
  size: number | bigint;
  uid: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}>;

export type PrivateCacheValidationDependencies = Readonly<{
  lstat(path: string): Promise<CachePathMetadata>;
  realpath(path: string): Promise<string>;
  currentUid(): number | undefined;
  temporaryRoot(): string;
}>;

const validationDependencies: PrivateCacheValidationDependencies = {
  lstat,
  realpath,
  currentUid: () => typeof process.getuid === "function" ? process.getuid() : undefined,
  temporaryRoot: tmpdir,
};

function numeric(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function fileError(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error &&
    (error as { code?: unknown }).code === code;
}

export async function validatePrivateBacktestCacheDirectory(
  directory: string,
  dependencies: PrivateCacheValidationDependencies = validationDependencies,
): Promise<string> {
  if (!isAbsolute(directory) || resolve(directory) !== directory) {
    throw new Error("private backtest cache requires a normalized absolute directory");
  }
  const root = await dependencies.realpath(dependencies.temporaryRoot());
  if (!`${directory}/`.startsWith(`${root}/`)) {
    throw new Error("private backtest cache must stay under the canonical operating-system temp directory");
  }
  const metadata = await dependencies.lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("private backtest cache must be a real directory, not a symbolic link");
  }
  if (await dependencies.realpath(directory) !== directory) {
    throw new Error("private backtest cache directory must use its canonical path");
  }
  if ((numeric(metadata.mode) & 0o777) !== 0o700) {
    throw new Error("private backtest cache directory must have mode 0700");
  }
  const uid = dependencies.currentUid();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error("private backtest cache directory must be owned by the current user");
  }
  return directory;
}

let defaultDirectory: Promise<string> | undefined;

export function privateBacktestCacheDirectory(): Promise<string> {
  defaultDirectory ??= (async () => {
    const root = await realpath(tmpdir());
    const directory = await mkdtemp(join(root, CACHE_DIRECTORY_PREFIX));
    return validatePrivateBacktestCacheDirectory(directory);
  })();
  return defaultDirectory;
}

export class TempPrivateDailyBarCache implements PrivateDailyBarCache {
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory?: string,
    private readonly maximumAgeMs = 24 * 60 * 60 * 1_000,
    private readonly maximumEntries = 8,
  ) {
    if (!Number.isSafeInteger(maximumAgeMs) || maximumAgeMs < 1 ||
      !Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new TypeError("private backtest cache bounds are invalid");
    }
  }

  write(record: PrivateDailyBarCacheRecord): Promise<void> {
    const operation = this.pending.then(() => this.writeRecord(record));
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  private async writeRecord(record: PrivateDailyBarCacheRecord): Promise<void> {
    if (record.scope !== "private-local-outside-repository") {
      throw new TypeError("raw data cache scope must remain private and outside the repository");
    }
    const serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized, "utf8") > MAX_CACHE_RECORD_BYTES) {
      throw new RangeError("private backtest cache record is too large");
    }
    const directory = this.directory
      ? await validatePrivateBacktestCacheDirectory(this.directory)
      : await privateBacktestCacheDirectory();
    await this.prune(directory, Date.now(), this.maximumEntries - 1);
    const digest = createHash("sha256").update(record.cacheKey, "utf8").digest("hex");
    const target = join(directory, `${digest}.json`);
    const temporary = join(directory, `.${digest}.${randomBytes(16).toString("hex")}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(serialized, { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      handle = undefined;
      const existing = await lstat(target).catch((error: unknown) => {
        if (fileError(error, "ENOENT")) return undefined;
        throw error;
      });
      if (existing && (existing.isSymbolicLink() || !existing.isFile() || numeric(existing.nlink) !== 1)) {
        throw new Error("private backtest cache target is not a safe regular file");
      }
      await rename(temporary, target);
      await this.validateCacheFile(target);
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async validateCacheFile(path: string): Promise<CachePathMetadata> {
    const metadata = await lstat(path);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (metadata.isSymbolicLink() || !metadata.isFile() || numeric(metadata.nlink) !== 1 ||
      (numeric(metadata.mode) & 0o777) !== 0o600 ||
      numeric(metadata.size) > MAX_CACHE_RECORD_BYTES ||
      (uid !== undefined && metadata.uid !== uid)) {
      throw new Error("private backtest cache file failed ownership, mode, link, or size validation");
    }
    return metadata;
  }

  private async prune(directory: string, now: number, retainedEntries: number): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    const records: Array<{ path: string; modifiedAt: number; metadata: CachePathMetadata }> = [];
    for (const entry of entries) {
      if (!FINAL_NAME.test(entry.name) && !TEMPORARY_NAME.test(entry.name)) {
        throw new Error("private backtest cache contains an unexpected entry");
      }
      const path = join(directory, entry.name);
      const metadata = await this.validateCacheFile(path);
      const modifiedAt = (await lstat(path)).mtimeMs;
      if (TEMPORARY_NAME.test(entry.name) || now - modifiedAt > this.maximumAgeMs) {
        await this.unlinkValidated(path, metadata);
      } else {
        records.push({ path, modifiedAt, metadata });
      }
    }
    records.sort((left, right) => right.modifiedAt - left.modifiedAt);
    for (const record of records.slice(retainedEntries)) {
      await this.unlinkValidated(record.path, record.metadata);
    }
  }

  private async unlinkValidated(path: string, expected: CachePathMetadata): Promise<void> {
    const current = await this.validateCacheFile(path);
    if (current.dev !== expected.dev || current.ino !== expected.ino) {
      throw new Error("private backtest cache entry changed during validation");
    }
    await unlink(path);
  }
}
