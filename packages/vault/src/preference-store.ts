import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

import {
  structuredPreferencePath,
  type StructuredPreferenceScope,
} from "./preferences";
import { workflowLessonPath } from "./workflow-lessons";
import { assertNoSensitiveContent } from "./security";

export const MAX_PREFERENCE_STATE_BYTES = 1_048_576;

export type StructuredPreferenceStorageKind = "local" | "remote";

export interface StructuredPreferenceStore {
  /** Truthful private-storage capability; callers must not infer remote durability from local storage. */
  readonly privateStorage: StructuredPreferenceStorageKind;
  /** @deprecated Use privateStorage; retained for compatible local-store capability checks. */
  readonly localPrivateStorage?: true;
  read(scope: StructuredPreferenceScope): Promise<string | null>;
  compareAndSwap(
    scope: StructuredPreferenceScope,
    expected: string | null,
    content: string,
  ): Promise<boolean>;
  readWorkflowLessons(scope: StructuredPreferenceScope): Promise<string | null>;
  compareAndSwapWorkflowLessons(
    scope: StructuredPreferenceScope,
    expected: string | null,
    content: string,
  ): Promise<boolean>;
}

async function existsType(target: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

type LockOwner = { pid: number; token: string };

export class FsStructuredPreferenceStore implements StructuredPreferenceStore {
  readonly privateStorage = "local" as const;
  readonly localPrivateStorage = true as const;
  private rootPromise?: Promise<string>;

  constructor(
    readonly configuredRoot: string,
    private readonly forbiddenGitVaultRoot?: string,
  ) {
    if (!configuredRoot.trim()) throw new Error("PILOT_PERSONALIZATION_STATE_DIR is required");
  }

  private async root(): Promise<string> {
    this.rootPromise ??= (async () => {
      const resolved = path.resolve(this.configuredRoot);
      const existing = await existsType(resolved);
      if (existing?.isSymbolicLink()) {
        throw new Error("Personalization state path cannot be a symbolic link");
      }
      await mkdir(resolved, { recursive: true, mode: 0o700 });
      const root = await realpath(resolved);
      if (this.forbiddenGitVaultRoot) {
        const forbidden = await realpath(path.resolve(this.forbiddenGitVaultRoot)).catch(
          () => path.resolve(this.forbiddenGitVaultRoot!),
        );
        if (within(forbidden, root)) {
          throw new Error("Personalization state must be outside the Git-backed vault path");
        }
      }
      const metadata = await stat(root);
      if (!metadata.isDirectory()) throw new Error("Personalization state path must be a directory");
      if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
        throw new Error("Personalization state path must be owned by the current user");
      }
      if ((metadata.mode & 0o077) !== 0) {
        throw new Error("Personalization state path permissions must be 0700 or stricter");
      }
      return root;
    })();
    return this.rootPromise;
  }

  private async targetForPath(relativePath: string): Promise<string> {
    const root = await this.root();
    const relative = relativePath.replace(/^Pilot\/Personalization\//, "");
    const target = path.resolve(root, ...relative.split("/"));
    if (!within(root, target)) throw new Error("Personalization state path escapes its root");
    let current = root;
    for (const part of relative.split("/")) {
      current = path.join(current, part);
      const type = await existsType(current);
      if (type?.isSymbolicLink()) throw new Error("Personalization state cannot traverse symbolic links");
    }
    return target;
  }

  private target(scope: StructuredPreferenceScope): Promise<string> {
    return this.targetForPath(structuredPreferencePath(scope));
  }

  private workflowLessonTarget(scope: StructuredPreferenceScope): Promise<string> {
    return this.targetForPath(workflowLessonPath(scope));
  }

  private async readTarget(target: string): Promise<string | null> {
    try {
      const metadata = await lstat(target);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error("Personalization state must be a regular file");
      }
      if (metadata.size > MAX_PREFERENCE_STATE_BYTES) {
        throw new Error("Personalization state exceeds its byte limit");
      }
      const content = await readFile(target, "utf8");
      if (Buffer.byteLength(content, "utf8") > MAX_PREFERENCE_STATE_BYTES) {
        throw new Error("Personalization state exceeds its byte limit");
      }
      assertNoSensitiveContent(content);
      return content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async read(scope: StructuredPreferenceScope): Promise<string | null> {
    return this.readTarget(await this.target(scope));
  }

  async readWorkflowLessons(scope: StructuredPreferenceScope): Promise<string | null> {
    return this.readTarget(await this.workflowLessonTarget(scope));
  }

  private async acquireLock(root: string): Promise<{ path: string; owner: LockOwner }> {
    const lockPath = path.join(root, ".personalization.lock");
    const owner = { pid: process.pid, token: randomUUID() };
    const encoded = `${JSON.stringify(owner)}\n`;
    const attempt = async () => {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(encoded, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    };
    try {
      await attempt();
      return { path: lockPath, owner };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        // Never recover automatically: deleting or renaming a presumed stale
        // lock races a new live owner. An operator may inspect/remove it only
        // while the service is stopped.
        throw new Error("Local personalization storage is busy; retry with the same idempotency key");
      }
      throw error;
    }
  }

  private async releaseLock(lockPath: string, owner: LockOwner): Promise<void> {
    try {
      const current = JSON.parse(await readFile(lockPath, "utf8")) as LockOwner;
      if (current.pid === owner.pid && current.token === owner.token) {
        await rm(lockPath, { force: true });
      }
    } catch {
      // Missing or replaced locks are never removed by this owner.
    }
  }

  async compareAndSwap(
    scope: StructuredPreferenceScope,
    expected: string | null,
    content: string,
  ): Promise<boolean> {
    return this.compareAndSwapTarget(scope, expected, content, "preferences");
  }

  async compareAndSwapWorkflowLessons(
    scope: StructuredPreferenceScope,
    expected: string | null,
    content: string,
  ): Promise<boolean> {
    return this.compareAndSwapTarget(scope, expected, content, "workflow-lessons");
  }

  private async compareAndSwapTarget(
    scope: StructuredPreferenceScope,
    expected: string | null,
    content: string,
    resource: "preferences" | "workflow-lessons",
  ): Promise<boolean> {
    assertNoSensitiveContent(content);
    if (Buffer.byteLength(content, "utf8") > MAX_PREFERENCE_STATE_BYTES) {
      throw new Error("Personalization state exceeds its byte limit");
    }
    const root = await this.root();
    const lock = await this.acquireLock(root);
    let temporary: string | undefined;
    try {
      const target = resource === "preferences"
        ? await this.target(scope)
        : await this.workflowLessonTarget(scope);
      const current = await this.readTarget(target);
      if (current !== expected) return false;
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const verifiedTarget = resource === "preferences"
        ? await this.target(scope)
        : await this.workflowLessonTarget(scope);
      if (verifiedTarget !== target) throw new Error("Personalization state path changed unexpectedly");
      temporary = path.join(path.dirname(target), `.${resource}-${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
      temporary = undefined;
      const directory = await open(path.dirname(target), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return true;
    } finally {
      if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
      await this.releaseLock(lock.path, lock.owner);
    }
  }
}
