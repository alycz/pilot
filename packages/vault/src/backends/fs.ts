import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { simpleGit, type SimpleGit } from "simple-git";
import { assertNoSensitiveContent } from "../security";
import type {
  VaultBackend,
  VaultReadEntry,
  VaultReadSnapshot,
  VaultReadSnapshotOptions,
} from "../types";

const DEFAULT_GIT_NAME = "Pilot Vault";
const DEFAULT_GIT_EMAIL = "pilot-vault@local";

type Repository = {
  git: SimpleGit;
  root: string;
};

async function streamTreeEntries(
  root: string,
  args: string[],
  maxEntries: number,
  maxScannedEntries: number,
  accept: (row: string) => boolean,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let pending = Buffer.alloc(0);
    let accepted = 0;
    let scanned = 0;
    let cappedByEntries = false;
    let cappedByScan = false;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      error ? reject(error) : resolve();
    };
    child.on("error", () => finish(new Error("Unable to read the pinned vault tree")));
    child.stdout.on("data", (chunk: Buffer) => {
      if (cappedByEntries || cappedByScan) return;
      pending = Buffer.concat([pending, chunk]);
      while (true) {
        const separator = pending.indexOf(0);
        if (separator < 0) break;
        const row = pending.subarray(0, separator).toString("utf8");
        pending = pending.subarray(separator + 1);
        if (row) scanned += 1;
        if (row && accept(row)) accepted += 1;
        if (accepted >= maxEntries) {
          cappedByEntries = true;
          pending = Buffer.alloc(0);
          child.kill("SIGTERM");
          break;
        }
        if (scanned >= maxScannedEntries) {
          cappedByScan = true;
          pending = Buffer.alloc(0);
          child.kill("SIGTERM");
          break;
        }
      }
    });
    // Drain stderr without retaining repository or process details.
    child.stderr.resume();
    child.on("close", (code) => {
      if (cappedByScan) finish(new Error("Vault snapshot metadata scan limit exceeded"));
      else if (cappedByEntries || code === 0) finish();
      else finish(new Error("Unable to read the pinned vault tree"));
    });
  });
}

function configuredVaultPath(env: NodeJS.ProcessEnv): string {
  const rootPath = env.VAULT_PATH;
  if (rootPath === undefined || rootPath.trim() === "") {
    throw new Error("VAULT_PATH must point to a vault directory");
  }
  return rootPath;
}

function normalizeVaultPath(value: string, allowEmpty = false): string {
  if (typeof value !== "string") {
    throw new TypeError("Vault paths must be strings");
  }
  if (value.includes("\0")) {
    throw new Error("Vault paths cannot contain null bytes");
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error("Vault paths must be relative to the vault root");
  }

  const parts = value.replaceAll("\\", "/").split("/").filter(Boolean);
  if (!allowEmpty && parts.length === 0) {
    throw new Error("Vault paths cannot be empty");
  }
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error("Vault path traversal is not allowed");
  }
  if (parts[0]?.toLowerCase() === ".git") {
    throw new Error("Vault paths cannot access git metadata");
  }

  return parts.join("/");
}

function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function existingType(target: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function assertNoSymlinks(root: string, relativePath: string): Promise<void> {
  let current = root;
  for (const part of relativePath.split("/").filter(Boolean)) {
    current = path.join(current, part);
    const stats = await existingType(current);
    if (stats?.isSymbolicLink()) {
      throw new Error("Vault paths cannot traverse symbolic links");
    }
  }
}

export class FsVaultBackend implements VaultBackend {
  readonly rootPath: string;

  private repositoryPromise: Promise<Repository> | undefined;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(rootPath: string = configuredVaultPath(process.env)) {
    if (rootPath.trim() === "") {
      throw new Error("Vault root cannot be empty");
    }
    this.rootPath = path.resolve(rootPath);
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): FsVaultBackend {
    return new FsVaultBackend(configuredVaultPath(env));
  }

  async read(vaultPath: string): Promise<string | null> {
    await this.writeQueue;
    const relativePath = normalizeVaultPath(vaultPath);
    const { root } = await this.repository();
    const target = path.resolve(root, ...relativePath.split("/"));
    if (!isWithinRoot(root, target)) {
      throw new Error("Vault path escapes the vault root");
    }
    await assertNoSymlinks(root, relativePath);

    try {
      const content = await readFile(target, "utf8");
      assertNoSensitiveContent(content);
      return content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async list(prefix = ""): Promise<string[]> {
    await this.writeQueue;
    const normalizedPrefix = normalizeVaultPath(prefix, true);
    const { root } = await this.repository();
    if (normalizedPrefix !== "") {
      await assertNoSymlinks(root, normalizedPrefix);
    }

    const start = normalizedPrefix === "" ? root : path.resolve(root, ...normalizedPrefix.split("/"));
    if (!isWithinRoot(root, start)) {
      throw new Error("Vault path escapes the vault root");
    }
    const startStats = await existingType(start);
    if (startStats === null) {
      return [];
    }
    if (startStats.isSymbolicLink()) {
      throw new Error("Vault paths cannot traverse symbolic links");
    }
    if (startStats.isFile()) {
      return [normalizedPrefix];
    }
    if (!startStats.isDirectory()) {
      return [];
    }

    const files: string[] = [];
    const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (relativeDirectory === "" && entry.name === ".git") {
          continue;
        }
        const relativeEntry = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
        if (entry.isSymbolicLink()) {
          continue;
        }
        if (entry.isDirectory()) {
          await walk(path.join(directory, entry.name), relativeEntry);
        } else if (entry.isFile()) {
          files.push(relativeEntry);
        }
      }
    };

    await walk(start, normalizedPrefix);
    return files.sort((left, right) => left.localeCompare(right));
  }

  async openReadSnapshot(options: VaultReadSnapshotOptions = {}): Promise<VaultReadSnapshot> {
    await this.writeQueue;
    const { git, root } = await this.repository();
    let revision: string;
    try {
      revision = (await git.revparse(["HEAD"])).trim();
    } catch {
      return {
        revision: null,
        list: async () => [],
        read: async () => null,
      };
    }

    const requestedPrefix = options.prefix ? normalizeVaultPath(options.prefix) : "";
    const maxEntries = options.maxEntries ?? Number.MAX_SAFE_INTEGER;
    const maxScannedEntries = options.maxScannedEntries ?? Number.MAX_SAFE_INTEGER;
    const suffix = options.suffix;
    if (
      !Number.isSafeInteger(maxEntries) || maxEntries < 1 ||
      !Number.isSafeInteger(maxScannedEntries) || maxScannedEntries < maxEntries
    ) {
      throw new Error("Vault snapshot entry limit is invalid");
    }
    const entries = new Map<string, VaultReadEntry>();
    await streamTreeEntries(root, [
      "ls-tree",
      "-r",
      "-l",
      "-z",
      revision,
      ...(requestedPrefix ? ["--", requestedPrefix] : []),
    ], maxEntries, maxScannedEntries, (row) => {
      const match = /^\d+ blob [0-9a-f]+\s+(\d+)\t(.+)$/s.exec(row);
      if (!match) return false;
      const entryPath = match[2]!;
      if (suffix && !entryPath.endsWith(suffix)) return false;
      entries.set(entryPath, { path: entryPath, size: Number(match[1]) });
      return true;
    });

    return {
      revision,
      list: async (prefix = "") => {
        const normalized = prefix ? normalizeVaultPath(prefix) : "";
        return [...entries.values()]
          .filter((entry) => !normalized || entry.path === normalized || entry.path.startsWith(`${normalized}/`))
          .sort((left, right) => left.path.localeCompare(right.path));
      },
      read: async (vaultPath, maxBytes) => {
        const normalized = normalizeVaultPath(vaultPath);
        const entry = entries.get(normalized);
        if (!entry) return null;
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || entry.size > maxBytes) {
          throw new Error("Vault blob exceeds the bounded read limit");
        }
        const content = await git.show([`${revision}:${normalized}`]);
        if (Buffer.byteLength(content, "utf8") > maxBytes) {
          throw new Error("Vault blob exceeds the bounded read limit");
        }
        assertNoSensitiveContent(content);
        return content;
      },
    };
  }

  write(vaultPath: string, content: string, message?: string): Promise<void> {
    const operation = this.writeQueue.then(() => this.performWrite(vaultPath, content, message));
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  private async performWrite(vaultPath: string, content: string, message?: string): Promise<void> {
    const relativePath = normalizeVaultPath(vaultPath);
    const commitMessage = message?.trim() || `Update ${relativePath}`;
    assertNoSensitiveContent(`${relativePath}\n${commitMessage}\n${content}`);
    const { git, root } = await this.repository();
    const target = path.resolve(root, ...relativePath.split("/"));
    if (!isWithinRoot(root, target)) {
      throw new Error("Vault path escapes the vault root");
    }
    await assertNoSymlinks(root, relativePath);

    await mkdir(path.dirname(target), { recursive: true });
    await assertNoSymlinks(root, relativePath);
    const previousStats = await existingType(target);
    const previousContent = previousStats?.isFile() ? await readFile(target, "utf8") : null;
    await writeFile(target, content, "utf8");

    try {
      await git.add([relativePath]);
      await git.raw(["commit", "--allow-empty", "--only", "-m", commitMessage, "--", relativePath]);
    } catch (error) {
      if (previousContent === null) {
        await unlink(target).catch(() => undefined);
        await git.raw(["rm", "--cached", "--ignore-unmatch", "--", relativePath]).catch(() => undefined);
      } else {
        await writeFile(target, previousContent, "utf8");
        await git.add([relativePath]).catch(() => undefined);
      }
      throw error;
    }
  }

  private repository(): Promise<Repository> {
    this.repositoryPromise ??= this.initializeRepository();
    return this.repositoryPromise;
  }

  private async initializeRepository(): Promise<Repository> {
    await mkdir(this.rootPath, { recursive: true });
    const root = await realpath(this.rootPath);
    const gitMetadata = await existingType(path.join(root, ".git"));
    if (gitMetadata?.isSymbolicLink()) {
      throw new Error("Vault git metadata cannot be a symbolic link");
    }
    if (gitMetadata !== null && !gitMetadata.isDirectory()) {
      throw new Error("Vault git metadata must be a directory");
    }

    const git = simpleGit({ baseDir: root });
    if (gitMetadata === null) {
      await git.init();
    }

    const [name, email] = await Promise.all([
      git.getConfig("user.name", "local"),
      git.getConfig("user.email", "local"),
    ]);
    if (name.value === null) {
      await git.addConfig("user.name", DEFAULT_GIT_NAME, false, "local");
    }
    if (email.value === null) {
      await git.addConfig("user.email", DEFAULT_GIT_EMAIL, false, "local");
    }

    return { git, root };
  }
}

export function createFsVaultBackend(rootPath: string = configuredVaultPath(process.env)): FsVaultBackend {
  return new FsVaultBackend(rootPath);
}
