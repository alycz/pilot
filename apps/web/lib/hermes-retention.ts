import { randomUUID } from "node:crypto";
import { constants, linkSync, unlinkSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  link,
  lstat,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";

import {
  inspectHermesPrivateMacAcl,
} from "./hermes-profile-gate";

const STATE_VERSION = 1 as const;
const MAX_STATE_BYTES = 512 * 1024;
const MAX_SCOPES = 1_024;
const MAX_SESSIONS = 4_096;
const MAX_SESSIONS_PER_SCOPE = 128;
const MAX_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_CREATION_LIFETIME_MS = 90_000;
// The parallel-suite critical section measured about 980ms on the target Mac;
// 1.5s keeps a fixed >50% margin without permitting an unbounded wait.
const LOCK_CONTENTION_RETRY_BUDGET_MS = 1_500;
const LOCK_CONTENTION_RETRY_DELAY_MS = 25;
const LOCK_CONTENTION_RETRY_ATTEMPTS =
  Math.floor(LOCK_CONTENTION_RETRY_BUDGET_MS / LOCK_CONTENTION_RETRY_DELAY_MS) + 1;
const DELETION_LEASE_MS = 60_000;
const LOCK_STALE_MS = 120_000;
const MAX_LOCK_BYTES = 1_024;
const DIGEST = /^[a-f0-9]{64}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const LOCK_OWNER_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const LOCK_CLAIM_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export type HermesRetentionSessionState =
  | "creating"
  | "active"
  | "pending_delete"
  | "deleting"
  | "uncertain"
  | "database_absent";

export type HermesRetentionSession = Readonly<{
  id: string;
  expectedConsentEpoch: number;
  creationDeadline: number;
  deleteAfter: number;
  state: HermesRetentionSessionState;
  attempts: number;
  updatedAt: number;
  databaseAbsentAt?: number;
}>;

type HermesConsentState = "accepted" | "revoked";

type ScopeState = {
  scopeDigest: string;
  consentEpoch: number;
  consentState: HermesConsentState;
  updatedAt: number;
  sessions: HermesRetentionSession[];
};

type JournalState = {
  version: typeof STATE_VERSION;
  scopes: ScopeState[];
};

export type HermesDeletionConfig = Readonly<{
  origin: string;
  profile: string;
  apiKey: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}>;

export type HermesDeletionResult = Readonly<{
  state: "database_absent" | "present" | "uncertain";
  databaseAbsentVerified: boolean;
}>;

type Fetcher = typeof fetch;

export class HermesRetentionCommitUncertainError extends Error {
  constructor() {
    super("Hermes retention state commit is uncertain.");
    this.name = "HermesRetentionCommitUncertainError";
  }
}

class HermesRetentionBusyError extends Error {}

export class HermesRetentionContentionError extends Error {
  constructor(cause?: unknown) {
    super("Hermes retention lock contention retry budget is exhausted.", { cause });
    this.name = "HermesRetentionContentionError";
  }
}

export type HermesRetentionJournalOptions = Readonly<{
  syncParentDirectory?: (parent: string) => Promise<void>;
  now?: () => number;
  processState?: (pid: number) => "alive" | "dead" | "ambiguous";
  lockOwnerId?: string;
  lockRetryDelay?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  afterExistingLockOpen?: (lockPath: string) => Promise<void>;
  beforeLockReclaim?: (lockPath: string) => Promise<void>;
  afterLockReclaim?: (lockPath: string) => Promise<void>;
  beforeLockPublish?: (temporaryPath: string, lockPath: string) => Promise<void>;
  afterLockLink?: (temporaryPath: string, lockPath: string) => Promise<void>;
}>;

function assertDigest(value: string): void {
  if (!DIGEST.test(value)) throw new Error("Invalid Hermes retention scope.");
}

function assertTime(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid Hermes retention ${label}.`);
  }
}

function assertSessionId(value: string): void {
  if (!SESSION_ID.test(value)) throw new Error("Invalid Hermes session identifier.");
}

function privateMode(mode: number): boolean {
  return (mode & 0o077) === 0;
}

function assertPrivateAcl(target: string): void {
  if (process.platform !== "darwin") return;
  try {
    inspectHermesPrivateMacAcl(target);
  } catch {
    throw new Error("Hermes retention state path has an unsafe ACL.");
  }
}

const verifiedAclSnapshots = new Map<string, string>();

async function assertPrivateAclSnapshot(target: string): Promise<void> {
  if (process.platform !== "darwin") return;
  const before = await lstat(target, { bigint: true });
  const snapshot = [before.dev, before.ino, before.ctimeNs, before.mode, before.uid].join(":");
  if (verifiedAclSnapshots.get(target) === snapshot) return;
  assertPrivateAcl(target);
  const after = await lstat(target, { bigint: true });
  const verified = [after.dev, after.ino, after.ctimeNs, after.mode, after.uid].join(":");
  if (before.dev !== after.dev || before.ino !== after.ino ||
      before.mode !== after.mode || before.uid !== after.uid) {
    throw new Error("Hermes retention state path changed during ACL inspection.");
  }
  if (verifiedAclSnapshots.size >= 4_096) verifiedAclSnapshots.clear();
  verifiedAclSnapshots.set(target, verified);
}

async function assertSafeStatePath(statePath: string): Promise<void> {
  if (!isAbsolute(statePath) || normalize(statePath) !== statePath) {
    throw new Error("Hermes retention state path must be canonical and absolute.");
  }
  const parent = dirname(statePath);
  const expectedOwner = typeof process.getuid === "function" ? process.getuid() : undefined;
  let ancestor = parent;
  while (true) {
    const metadata = await lstat(ancestor);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
        (await realpath(ancestor)) !== ancestor ||
        (expectedOwner !== undefined && metadata.uid !== 0 && metadata.uid !== expectedOwner) ||
        ((metadata.mode & 0o022) !== 0 && (metadata.mode & 0o1000) === 0)) {
      throw new Error("Hermes retention state has an unsafe ancestor chain.");
    }
    await assertPrivateAclSnapshot(ancestor);
    const next = dirname(ancestor);
    if (next === ancestor) break;
    ancestor = next;
  }
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new Error("Hermes retention state parent must be a real directory.");
  }
  if ((await realpath(parent)) !== parent || !privateMode(parentInfo.mode)) {
    throw new Error("Hermes retention state parent must be owner-private.");
  }
  if (expectedOwner !== undefined && parentInfo.uid !== expectedOwner) {
    throw new Error("Hermes retention state parent must be owner-controlled.");
  }
  const fileInfo = await lstat(statePath).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return undefined;
    throw cause;
  });
  if (!fileInfo) return;
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.nlink !== 1) {
    throw new Error("Hermes retention state must be a single regular file.");
  }
  if (!privateMode(fileInfo.mode)) {
    throw new Error("Hermes retention state must be owner-private.");
  }
  if (expectedOwner !== undefined && fileInfo.uid !== expectedOwner) {
    throw new Error("Hermes retention state must be owner-controlled.");
  }
  await assertPrivateAclSnapshot(statePath);
  if (fileInfo.size > MAX_STATE_BYTES) {
    throw new Error("Hermes retention state exceeds its bounded size.");
  }
}

function parseState(raw: string): JournalState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Hermes retention state is invalid.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Hermes retention state is invalid.");
  }
  const top = parsed as Record<string, unknown>;
  if (Object.keys(top).sort().join(",") !== "scopes,version" ||
      top.version !== STATE_VERSION || !Array.isArray(top.scopes) ||
      top.scopes.length > MAX_SCOPES) {
    throw new Error("Hermes retention state is invalid.");
  }
  let totalSessions = 0;
  const seenScopes = new Set<string>();
  const seenGlobalSessions = new Set<string>();
  for (const rawScope of top.scopes) {
    if (!rawScope || typeof rawScope !== "object" || Array.isArray(rawScope)) {
      throw new Error("Hermes retention state is invalid.");
    }
    const scope = rawScope as Record<string, unknown>;
    if (Object.keys(scope).sort().join(",") !==
        "consentEpoch,consentState,scopeDigest,sessions,updatedAt" ||
        typeof scope.scopeDigest !== "string" || !DIGEST.test(scope.scopeDigest) ||
        seenScopes.has(scope.scopeDigest) ||
        !Number.isSafeInteger(scope.consentEpoch) || Number(scope.consentEpoch) < 1 ||
        (scope.consentState !== "accepted" && scope.consentState !== "revoked") ||
        !Number.isSafeInteger(scope.updatedAt) || Number(scope.updatedAt) < 0 ||
        !Array.isArray(scope.sessions) || scope.sessions.length > MAX_SESSIONS_PER_SCOPE) {
      throw new Error("Hermes retention state is invalid.");
    }
    seenScopes.add(scope.scopeDigest);
    totalSessions += scope.sessions.length;
    const seenSessions = new Set<string>();
    for (const rawSession of scope.sessions) {
      if (!rawSession || typeof rawSession !== "object" || Array.isArray(rawSession)) {
        throw new Error("Hermes retention state is invalid.");
      }
      const session = rawSession as Record<string, unknown>;
      const keys = Object.keys(session).sort().join(",");
      if ((keys !== "attempts,creationDeadline,deleteAfter,expectedConsentEpoch,id,state,updatedAt" &&
           keys !== "attempts,creationDeadline,databaseAbsentAt,deleteAfter,expectedConsentEpoch,id,state,updatedAt") ||
          typeof session.id !== "string" || !SESSION_ID.test(session.id) ||
          seenSessions.has(session.id) || seenGlobalSessions.has(session.id) ||
          !Number.isSafeInteger(session.expectedConsentEpoch) ||
          Number(session.expectedConsentEpoch) < 1 ||
          Number(session.expectedConsentEpoch) > Number(scope.consentEpoch) ||
          !Number.isSafeInteger(session.creationDeadline) || Number(session.creationDeadline) < 0 ||
          !Number.isSafeInteger(session.deleteAfter) || Number(session.deleteAfter) < 0 ||
          !Number.isSafeInteger(session.attempts) || Number(session.attempts) < 0 ||
          !Number.isSafeInteger(session.updatedAt) || Number(session.updatedAt) < 0 ||
          !["creating", "active", "pending_delete", "deleting", "uncertain", "database_absent"].includes(String(session.state)) ||
          (session.state === "creating" && session.attempts !== 0) ||
          (session.state === "active" &&
            (scope.consentState !== "accepted" ||
              session.expectedConsentEpoch !== scope.consentEpoch || session.attempts !== 0)) ||
          ((session.state === "deleting" || session.state === "database_absent") &&
            Number(session.attempts) < 1) ||
          (session.databaseAbsentAt !== undefined &&
            (!Number.isSafeInteger(session.databaseAbsentAt) || Number(session.databaseAbsentAt) < 0)) ||
          (session.state === "database_absent") !== (session.databaseAbsentAt !== undefined)) {
        throw new Error("Hermes retention state is invalid.");
      }
      seenSessions.add(session.id);
      seenGlobalSessions.add(session.id);
    }
  }
  if (totalSessions > MAX_SESSIONS) {
    throw new Error("Hermes retention state exceeds its bounded session count.");
  }
  return parsed as JournalState;
}

async function readState(statePath: string): Promise<JournalState> {
  await assertSafeStatePath(statePath);
  const raw = await readFile(statePath, "utf8").catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return undefined;
    throw cause;
  });
  return raw === undefined ? { version: STATE_VERSION, scopes: [] } : parseState(raw);
}

async function syncParentDirectory(parent: string): Promise<void> {
  const parentHandle = await open(parent, "r");
  try {
    await parentHandle.sync();
  } finally {
    await parentHandle.close();
  }
}

async function writeState(
  statePath: string,
  state: JournalState,
  syncParent: (parent: string) => Promise<void>,
): Promise<void> {
  const bytes = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(bytes) > MAX_STATE_BYTES) {
    throw new Error("Hermes retention state exceeds its bounded size.");
  }
  const temporary = join(dirname(statePath), `.${basename(statePath)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, statePath);
  } catch (cause) {
    await unlink(temporary).catch(() => undefined);
    throw cause;
  }
  try {
    await syncParent(dirname(statePath));
    await assertSafeStatePath(statePath);
  } catch {
    throw new HermesRetentionCommitUncertainError();
  }
}

type LockSnapshot = Readonly<{ dev: number; ino: number }>;
type HeldLock = Readonly<{
  handle: Awaited<ReturnType<typeof open>>;
  snapshot: LockSnapshot;
}>;

function defaultProcessState(pid: number): "alive" | "dead" | "ambiguous" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "ambiguous";
  }
}

function sameLock(snapshot: LockSnapshot, metadata: Readonly<{ dev: number; ino: number }>): boolean {
  return snapshot.dev === metadata.dev && snapshot.ino === metadata.ino;
}

function retentionAbortError(): DOMException {
  return new DOMException("Hermes retention mutation was aborted.", "AbortError");
}

async function waitForLockRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw retentionAbortError();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(retentionAbortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function lockChanged(): HermesRetentionBusyError {
  return new HermesRetentionBusyError("Hermes retention lock changed; no mutation was attempted.");
}

function missingPath(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function rethrowUnlessLockChanged(
  lockPath: string,
  snapshot: Readonly<{ dev: number; ino: number; nlink: number }>,
  cause: unknown,
): Promise<never> {
  const current = await lstat(lockPath).catch((statCause: unknown) => {
    if (missingPath(statCause)) return undefined;
    throw statCause;
  });
  if (!current || !sameLock(snapshot, current) || current.nlink !== snapshot.nlink) {
    throw lockChanged();
  }
  throw cause;
}

async function inspectExistingLock(
  lockPath: string,
  now: number,
  processState: (pid: number) => "alive" | "dead" | "ambiguous",
  afterOpen?: (lockPath: string) => Promise<void>,
): Promise<LockSnapshot> {
  let pathInfo = await lstat(lockPath).catch((cause: unknown) => {
    if (missingPath(cause)) throw lockChanged();
    throw cause;
  });
  let publicationClaimPath: string | undefined;
  // Atomic lock publication momentarily gives the completed inode two names.
  // Only our exact generated sibling name can establish that this is a claim in
  // progress. It remains Busy until the publisher removes that sibling; an
  // arbitrary or crash-corrupted hardlink is never accepted as a lock.
  if (pathInfo.nlink === 2) {
    const prefix = `.${basename(lockPath)}.`;
    const suffix = ".claim";
    const siblingNames = (await readdir(dirname(lockPath))).filter((name) => {
      if (!name.startsWith(prefix) || !name.endsWith(suffix)) return false;
      return LOCK_CLAIM_ID.test(name.slice(prefix.length, -suffix.length));
    });
    let siblingPath: string | undefined;
    for (const name of siblingNames) {
      const candidatePath = join(dirname(lockPath), name);
      const candidate = await lstat(candidatePath).catch((cause: unknown) => {
        if (missingPath(cause)) return undefined;
        throw cause;
      });
      if (candidate && sameLock(pathInfo, candidate)) {
        if (siblingPath) {
          throw new Error("Hermes retention lock is unsafe; no mutation was attempted.");
        }
        siblingPath = candidatePath;
      }
    }
    const settled = await lstat(lockPath).catch((cause: unknown) => {
      if (missingPath(cause)) throw lockChanged();
      throw cause;
    });
    if (!sameLock(pathInfo, settled)) throw lockChanged();
    if (settled.nlink === 1) throw lockChanged();
    if (settled.nlink !== 2 || !siblingPath) {
      throw new Error("Hermes retention lock is unsafe; no mutation was attempted.");
    }
    const sibling = await lstat(siblingPath).catch((cause: unknown) => {
      if (missingPath(cause)) return undefined;
      throw cause;
    });
    if (!sibling) {
      const afterSiblingLoss = await lstat(lockPath).catch((cause: unknown) => {
        if (missingPath(cause)) throw lockChanged();
        throw cause;
      });
      if (sameLock(pathInfo, afterSiblingLoss) && afterSiblingLoss.nlink === 1) {
        throw lockChanged();
      }
      throw new Error("Hermes retention lock is unsafe; no mutation was attempted.");
    }
    if (!sameLock(pathInfo, sibling) || sibling.nlink !== 2) {
      throw new Error("Hermes retention lock is unsafe; no mutation was attempted.");
    }
    publicationClaimPath = siblingPath;
  }
  const expectedLinkCount = publicationClaimPath ? 2 : 1;
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink() ||
      pathInfo.nlink !== expectedLinkCount ||
      !privateMode(pathInfo.mode) || pathInfo.size > MAX_LOCK_BYTES ||
      (typeof process.getuid === "function" && pathInfo.uid !== process.getuid())) {
    throw new Error("Hermes retention lock is unsafe; no mutation was attempted.");
  }
  await assertPrivateAclSnapshot(lockPath).catch((cause: unknown) =>
    rethrowUnlessLockChanged(lockPath, pathInfo, cause));
  const handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    .catch((cause: unknown) => rethrowUnlessLockChanged(lockPath, pathInfo, cause));
  try {
    await afterOpen?.(lockPath);
    const opened = await handle.stat();
    if (!sameLock(pathInfo, opened) || opened.nlink !== pathInfo.nlink) {
      throw lockChanged();
    }
    if (!opened.isFile() || !privateMode(opened.mode) ||
        opened.size > MAX_LOCK_BYTES ||
        (typeof process.getuid === "function" && opened.uid !== process.getuid())) {
      throw new Error("Hermes retention lock is unsafe; no mutation was attempted.");
    }
    let record: unknown;
    try {
      record = JSON.parse(await handle.readFile("utf8"));
    } catch {
      throw new Error("Hermes retention lock is malformed; no mutation was attempted.");
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error("Hermes retention lock is malformed; no mutation was attempted.");
    }
    const lock = record as Record<string, unknown>;
    if (Object.keys(lock).sort().join(",") !== "createdAt,ownerId,pid,version" ||
        lock.version !== 1 || !Number.isSafeInteger(lock.pid) || Number(lock.pid) < 1 ||
        typeof lock.ownerId !== "string" || !LOCK_OWNER_ID.test(lock.ownerId) ||
        !Number.isSafeInteger(lock.createdAt) || Number(lock.createdAt) < 0 ||
        Number(lock.createdAt) > now) {
      throw new Error("Hermes retention lock is malformed; no mutation was attempted.");
    }
    if (publicationClaimPath) {
      const [currentOpened, currentPath, currentClaim] = await Promise.all([
        handle.stat(),
        lstat(lockPath).catch((cause: unknown) => {
          if (missingPath(cause)) return undefined;
          throw cause;
        }),
        lstat(publicationClaimPath).catch((cause: unknown) => {
          if (missingPath(cause)) return undefined;
          throw cause;
        }),
      ]);
      if (!currentPath || currentOpened.nlink === 1 || currentPath.nlink === 1) {
        throw lockChanged();
      }
      if (!currentClaim || !currentOpened.isFile() ||
          !privateMode(currentOpened.mode) || currentOpened.size > MAX_LOCK_BYTES ||
          (typeof process.getuid === "function" && currentOpened.uid !== process.getuid()) ||
          currentOpened.nlink !== 2 || currentPath.nlink !== 2 ||
          currentClaim.nlink !== 2 || !sameLock(currentOpened, currentPath) ||
          !sameLock(currentOpened, currentClaim)) {
        throw new Error("Hermes retention lock is unsafe; no mutation was attempted.");
      }
      throw new HermesRetentionBusyError(
        "Hermes retention lock publication is in progress; no mutation was attempted.",
      );
    }
    if (now - Number(lock.createdAt) < LOCK_STALE_MS) {
      throw new HermesRetentionBusyError("Hermes retention state is busy; no mutation was attempted.");
    }
    const ownerState = processState(Number(lock.pid));
    if (ownerState === "alive") {
      throw new HermesRetentionBusyError("Hermes retention state is busy; no mutation was attempted.");
    }
    if (ownerState === "ambiguous") {
      throw new Error("Hermes retention lock owner state is ambiguous; no mutation was attempted.");
    }
    const beforeClaim = await lstat(lockPath).catch((cause: unknown) => {
      if (missingPath(cause)) throw lockChanged();
      throw cause;
    });
    if (!sameLock(opened, beforeClaim) || beforeClaim.nlink !== opened.nlink) {
      throw lockChanged();
    }
    return { dev: opened.dev, ino: opened.ino };
  } finally {
    await handle.close();
  }
}

async function reclaimExistingLock(lockPath: string, snapshot: LockSnapshot): Promise<void> {
  const quarantine = join(dirname(lockPath), `.${basename(lockPath)}.${randomUUID()}.stale`);
  await rename(lockPath, quarantine).catch(() => {
    throw new HermesRetentionBusyError("Hermes retention lock changed; no mutation was attempted.");
  });
  const claimed = await lstat(quarantine);
  if (!sameLock(snapshot, claimed)) {
    try {
      await link(quarantine, lockPath);
      await unlink(quarantine);
    } catch {
      // Preserve the racing replacement at its quarantine path rather than
      // deleting or overwriting an inode that was not validated.
    }
    throw new HermesRetentionBusyError("Hermes retention lock changed; no mutation was attempted.");
  }
  await unlink(quarantine);
  await syncParentDirectory(dirname(lockPath));
}

async function releaseHeldLock(lockPath: string, held: HeldLock): Promise<void> {
  await held.handle.close().catch(() => undefined);
  const current = await lstat(lockPath).catch(() => undefined);
  if (!current || !sameLock(held.snapshot, current)) return;
  await unlink(lockPath).catch(() => undefined);
  await syncParentDirectory(dirname(lockPath)).catch(() => undefined);
}

async function createHeldLock(
  lockPath: string,
  ownerId: string,
  now: number,
  beforePublish?: (temporaryPath: string, lockPath: string) => Promise<void>,
  afterLink?: (temporaryPath: string, lockPath: string) => Promise<void>,
): Promise<HeldLock> {
  const parent = dirname(lockPath);
  const temporary = join(parent, `.${basename(lockPath)}.${randomUUID()}.claim`);
  const handle = await open(temporary, "wx", 0o600);
  const held: HeldLock = {
    handle,
    snapshot: await handle.stat().then((info) => ({ dev: info.dev, ino: info.ino })),
  };
  try {
    const record = `${JSON.stringify({
      version: 1,
      pid: process.pid,
      ownerId,
      createdAt: now,
    })}\n`;
    if (Buffer.byteLength(record) > MAX_LOCK_BYTES) throw new Error("Hermes retention lock is invalid.");
    await handle.writeFile(record, "utf8");
    await handle.sync();
    await beforePublish?.(temporary, lockPath);
    // link(2) supplies the no-overwrite claim. Production keeps the two-name
    // interval free of an await. Cross-process readers recognize only this
    // exact generated sibling and retry within the shared bounded budget.
    linkSync(temporary, lockPath);
    if (afterLink) await afterLink(temporary, lockPath);
    unlinkSync(temporary);
    const published = await handle.stat();
    if (!sameLock(held.snapshot, published) || published.nlink !== 1) {
      throw lockChanged();
    }
    await syncParentDirectory(parent);
    return held;
  } catch (cause) {
    await releaseHeldLock(lockPath, held);
    await unlink(temporary).catch(() => undefined);
    await syncParentDirectory(parent).catch(() => undefined);
    throw cause;
  }
}

function scopeRecord(state: JournalState, scopeDigest: string): ScopeState | undefined {
  return state.scopes.find((scope) => scope.scopeDigest === scopeDigest);
}

export class HermesRetentionJournal {
  readonly statePath: string;
  readonly #syncParentDirectory: (parent: string) => Promise<void>;
  readonly #now: () => number;
  readonly #processState: (pid: number) => "alive" | "dead" | "ambiguous";
  readonly #lockOwnerId: string;
  readonly #lockRetryDelay: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  readonly #afterExistingLockOpen?: (lockPath: string) => Promise<void>;
  readonly #beforeLockReclaim?: (lockPath: string) => Promise<void>;
  readonly #afterLockReclaim?: (lockPath: string) => Promise<void>;
  readonly #beforeLockPublish?: (temporaryPath: string, lockPath: string) => Promise<void>;
  readonly #afterLockLink?: (temporaryPath: string, lockPath: string) => Promise<void>;

  constructor(statePath: string, options: HermesRetentionJournalOptions = {}) {
    this.statePath = statePath;
    this.#syncParentDirectory = options.syncParentDirectory ?? syncParentDirectory;
    this.#now = options.now ?? Date.now;
    this.#processState = options.processState ?? defaultProcessState;
    this.#lockOwnerId = options.lockOwnerId ?? randomUUID();
    this.#lockRetryDelay = options.lockRetryDelay ?? waitForLockRetry;
    this.#afterExistingLockOpen = options.afterExistingLockOpen;
    this.#beforeLockReclaim = options.beforeLockReclaim;
    this.#afterLockReclaim = options.afterLockReclaim;
    this.#beforeLockPublish = options.beforeLockPublish;
    this.#afterLockLink = options.afterLockLink;
    if (!LOCK_OWNER_ID.test(this.#lockOwnerId)) {
      throw new Error("Invalid Hermes retention lock owner.");
    }
  }

  private async acquireLock(lockPath: string): Promise<HeldLock> {
    const now = this.#now();
    assertTime(now, "lock time");
    try {
      return await createHeldLock(
        lockPath,
        this.#lockOwnerId,
        now,
        this.#beforeLockPublish,
        this.#afterLockLink,
      );
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    }
    const snapshot = await inspectExistingLock(
      lockPath,
      now,
      this.#processState,
      this.#afterExistingLockOpen,
    );
    await this.#beforeLockReclaim?.(lockPath);
    await reclaimExistingLock(lockPath, snapshot);
    await this.#afterLockReclaim?.(lockPath);
    try {
      return await createHeldLock(
        lockPath,
        this.#lockOwnerId,
        now,
        this.#beforeLockPublish,
        this.#afterLockLink,
      );
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") throw lockChanged();
      throw cause;
    }
  }

  private async acquireLockWithRetry(
    lockPath: string,
    signal?: AbortSignal,
  ): Promise<HeldLock> {
    const startedAt = performance.now();
    for (let attempt = 0; attempt < LOCK_CONTENTION_RETRY_ATTEMPTS; attempt += 1) {
      if (signal?.aborted) throw retentionAbortError();
      try {
        return await this.acquireLock(lockPath);
      } catch (cause) {
        if (!(cause instanceof HermesRetentionBusyError)) throw cause;
        const elapsed = performance.now() - startedAt;
        if (attempt === LOCK_CONTENTION_RETRY_ATTEMPTS - 1 ||
            elapsed >= LOCK_CONTENTION_RETRY_BUDGET_MS) {
          throw new HermesRetentionContentionError(cause);
        }
        await this.#lockRetryDelay(Math.min(
          LOCK_CONTENTION_RETRY_DELAY_MS,
          LOCK_CONTENTION_RETRY_BUDGET_MS - elapsed,
        ), signal);
      }
    }
    throw new HermesRetentionContentionError();
  }

  private async mutate<T>(
    mutation: (state: JournalState) => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) throw retentionAbortError();
    await assertSafeStatePath(this.statePath);
    if (signal?.aborted) throw retentionAbortError();
    const lockPath = join(dirname(this.statePath), `.${basename(this.statePath)}.lock`);
    const lock = await this.acquireLockWithRetry(lockPath, signal);
    try {
      if (signal?.aborted) throw retentionAbortError();
      const state = await readState(this.statePath);
      if (signal?.aborted) throw retentionAbortError();
      const result = await mutation(state);
      if (signal?.aborted) throw retentionAbortError();
      await writeState(this.statePath, state, this.#syncParentDirectory);
      return result;
    } finally {
      await releaseHeldLock(lockPath, lock);
    }
  }

  async consent(scopeDigest: string, signal?: AbortSignal): Promise<Readonly<{
    epoch: number;
    state: HermesConsentState | "missing";
  }>> {
    assertDigest(scopeDigest);
    if (signal?.aborted) throw retentionAbortError();
    const scope = scopeRecord(await readState(this.statePath), scopeDigest);
    if (signal?.aborted) throw retentionAbortError();
    return scope
      ? { epoch: scope.consentEpoch, state: scope.consentState }
      : { epoch: 0, state: "missing" };
  }

  async acceptConsent(
    scopeDigest: string,
    now = Date.now(),
    signal?: AbortSignal,
  ): Promise<number> {
    assertDigest(scopeDigest);
    assertTime(now, "time");
    return this.mutate((state) => {
      let scope = scopeRecord(state, scopeDigest);
      if (!scope) {
        if (state.scopes.length >= MAX_SCOPES) {
          throw new Error("Hermes retention scope capacity is exhausted.");
        }
        scope = {
          scopeDigest,
          consentEpoch: 0,
          consentState: "revoked",
          updatedAt: now,
          sessions: [],
        };
        state.scopes.push(scope);
      }
      if (scope.consentEpoch >= Number.MAX_SAFE_INTEGER) {
        throw new Error("Hermes consent epoch is exhausted.");
      }
      scope.consentEpoch += 1;
      scope.consentState = "accepted";
      scope.updatedAt = now;
      return scope.consentEpoch;
    }, signal);
  }

  async revokeConsent(
    scopeDigest: string,
    now = Date.now(),
    signal?: AbortSignal,
  ): Promise<Readonly<{
    epoch: number;
    pendingSessionIds: readonly string[];
  }>> {
    assertDigest(scopeDigest);
    assertTime(now, "time");
    return this.mutate((state) => {
      let scope = scopeRecord(state, scopeDigest);
      if (!scope) {
        if (state.scopes.length >= MAX_SCOPES) {
          throw new Error("Hermes retention scope capacity is exhausted.");
        }
        scope = {
          scopeDigest,
          consentEpoch: 0,
          consentState: "revoked",
          updatedAt: now,
          sessions: [],
        };
        state.scopes.push(scope);
      }
      if (scope.consentEpoch >= Number.MAX_SAFE_INTEGER) {
        throw new Error("Hermes consent epoch is exhausted.");
      }
      scope.consentEpoch += 1;
      scope.consentState = "revoked";
      scope.updatedAt = now;
      for (const session of scope.sessions) {
        if (session.state !== "database_absent" && session.state !== "creating") {
          Object.assign(session, { state: "pending_delete", updatedAt: now });
        }
      }
      return {
        epoch: scope.consentEpoch,
        pendingSessionIds: scope.sessions
          .filter((session) => session.state !== "database_absent")
          .map((session) => session.id),
      };
    }, signal);
  }

  async registerSession(input: Readonly<{
    scopeDigest: string;
    sessionId: string;
    expectedConsentEpoch: number;
    creationDeadline: number;
    deleteAfter: number;
    now?: number;
    signal?: AbortSignal;
  }>): Promise<void> {
    assertDigest(input.scopeDigest);
    assertSessionId(input.sessionId);
    assertTime(input.expectedConsentEpoch, "consent epoch");
    if (input.expectedConsentEpoch < 1) {
      throw new Error("Invalid Hermes retention consent epoch.");
    }
    const now = input.now ?? Date.now();
    assertTime(now, "time");
    assertTime(input.creationDeadline, "creation deadline");
    if (input.creationDeadline <= now ||
        input.creationDeadline - now > MAX_CREATION_LIFETIME_MS) {
      throw new Error("Hermes session creation deadline must be within 90 seconds.");
    }
    assertTime(input.deleteAfter, "deletion time");
    if (input.deleteAfter < now || input.deleteAfter - now > MAX_RETENTION_MS) {
      throw new Error("Hermes session retention must be between now and 30 days.");
    }
    await this.mutate((state) => {
      const scope = scopeRecord(state, input.scopeDigest);
      if (!scope || scope.consentState !== "accepted" ||
          scope.consentEpoch !== input.expectedConsentEpoch) {
        throw new Error("Hermes session cannot be retained without current consent.");
      }
      const existing = scope.sessions.find((session) => session.id === input.sessionId);
      if (existing) {
        if (existing.deleteAfter !== input.deleteAfter ||
            existing.creationDeadline !== input.creationDeadline ||
            existing.expectedConsentEpoch !== input.expectedConsentEpoch ||
            existing.state === "database_absent") {
          throw new Error("Hermes session retention registration conflicts with durable state.");
        }
        return;
      }
      if (state.scopes.some((item) => item.scopeDigest !== input.scopeDigest &&
        item.sessions.some((session) => session.id === input.sessionId))) {
        throw new Error("Hermes session identifier is already bound to another scope.");
      }
      const total = state.scopes.reduce((count, item) => count + item.sessions.length, 0);
      if (scope.sessions.length >= MAX_SESSIONS_PER_SCOPE || total >= MAX_SESSIONS) {
        throw new Error("Hermes retention session capacity is exhausted.");
      }
      scope.sessions.push({
        id: input.sessionId,
        expectedConsentEpoch: input.expectedConsentEpoch,
        creationDeadline: input.creationDeadline,
        deleteAfter: input.deleteAfter,
        state: "creating",
        attempts: 0,
        updatedAt: now,
      });
      scope.updatedAt = now;
    }, input.signal);
  }

  async settleSessionCreation(input: Readonly<{
    scopeDigest: string;
    sessionId: string;
    expectedConsentEpoch: number;
    outcome: "created" | "uncertain";
    now?: number;
    signal?: AbortSignal;
  }>): Promise<HermesRetentionSessionState> {
    assertDigest(input.scopeDigest);
    assertSessionId(input.sessionId);
    assertTime(input.expectedConsentEpoch, "consent epoch");
    if (input.expectedConsentEpoch < 1) {
      throw new Error("Invalid Hermes retention consent epoch.");
    }
    const now = input.now ?? Date.now();
    assertTime(now, "time");
    return this.mutate((state) => {
      const scope = scopeRecord(state, input.scopeDigest);
      const session = scope?.sessions.find((item) => item.id === input.sessionId);
      if (!scope || !session) throw new Error("Hermes retention session is missing.");
      if (session.expectedConsentEpoch !== input.expectedConsentEpoch) {
        throw new Error("Hermes session consent epoch does not match durable state.");
      }
      if (session.state !== "creating") return session.state;
      const nextState = input.outcome === "uncertain"
        ? "uncertain"
        : scope.consentState === "accepted" &&
            scope.consentEpoch === input.expectedConsentEpoch
          ? "active"
          : "pending_delete";
      Object.assign(session, { state: nextState, updatedAt: now });
      scope.updatedAt = now;
      return nextState;
    }, input.signal);
  }

  async recoverStaleCreatingSessions(now = Date.now(), signal?: AbortSignal): Promise<number> {
    assertTime(now, "time");
    return this.mutate((state) => {
      let recovered = 0;
      for (const scope of state.scopes) {
        for (const session of scope.sessions) {
          if (session.state !== "creating" || session.creationDeadline > now) continue;
          Object.assign(session, { state: "uncertain", updatedAt: now });
          scope.updatedAt = now;
          recovered += 1;
        }
      }
      return recovered;
    }, signal);
  }

  async sessionsForDeletion(
    scopeDigest: string,
    options: Readonly<{ now?: number; includeNotDue?: boolean }> = {},
  ): Promise<readonly HermesRetentionSession[]> {
    assertDigest(scopeDigest);
    const now = options.now ?? Date.now();
    assertTime(now, "time");
    const scope = scopeRecord(await readState(this.statePath), scopeDigest);
    if (!scope) return [];
    return scope.sessions
      .filter((session) => session.state !== "database_absent" &&
        session.state !== "creating" &&
        (options.includeNotDue === true || session.deleteAfter <= now ||
          scope.consentState === "revoked" || session.state !== "active"))
      .map((session) => Object.freeze({ ...session }));
  }

  async dueScopeDigests(
    options: Readonly<{ now?: number; limit?: number }> = {},
  ): Promise<readonly string[]> {
    const now = options.now ?? Date.now();
    const limit = options.limit ?? 32;
    assertTime(now, "time");
    if (!Number.isInteger(limit) || limit < 1 || limit > 64) {
      throw new Error("Invalid Hermes retention scope batch size.");
    }
    const state = await readState(this.statePath);
    return state.scopes
      .filter((scope) => scope.sessions.some((session) =>
        session.state !== "database_absent" && session.state !== "creating" &&
        (session.deleteAfter <= now || scope.consentState === "revoked" ||
          session.state !== "active"),
      ))
      .map((scope) => scope.scopeDigest)
      .sort()
      .slice(0, limit);
  }

  async beginDeletion(
    scopeDigest: string,
    sessionId: string,
    now = Date.now(),
    signal?: AbortSignal,
  ): Promise<boolean> {
    assertDigest(scopeDigest);
    assertSessionId(sessionId);
    assertTime(now, "time");
    return this.mutate((state) => {
      const session = scopeRecord(state, scopeDigest)?.sessions
        .find((item) => item.id === sessionId);
      if (!session || session.state === "database_absent") return false;
      if (session.state === "creating") {
        throw new Error("Hermes session creation is not settled for deletion.");
      }
      if (session.state === "deleting" && now - session.updatedAt < DELETION_LEASE_MS) {
        return false;
      }
      if (session.attempts >= 8) {
        throw new Error("Hermes deletion retry limit is exhausted.");
      }
      Object.assign(session, {
        state: "deleting",
        attempts: session.attempts + 1,
        updatedAt: now,
      });
      return true;
    }, signal);
  }

  async completeDeletion(
    scopeDigest: string,
    sessionId: string,
    verified: boolean,
    now = Date.now(),
    signal?: AbortSignal,
  ): Promise<void> {
    assertDigest(scopeDigest);
    assertSessionId(sessionId);
    assertTime(now, "time");
    await this.mutate((state) => {
      const session = scopeRecord(state, scopeDigest)?.sessions
        .find((item) => item.id === sessionId);
      if (!session) throw new Error("Hermes retention session is missing.");
      if (session.state === "database_absent") return;
      if (session.state === "creating") {
        throw new Error("Hermes session creation is not settled for deletion.");
      }
      Object.assign(session, verified
        ? { state: "database_absent", databaseAbsentAt: now, updatedAt: now }
        : { state: "uncertain", updatedAt: now });
    }, signal);
  }
}

function validatedDeletionConfig(input: HermesDeletionConfig): Required<HermesDeletionConfig> {
  let origin: URL;
  try {
    origin = new URL(input.origin);
  } catch {
    throw new Error("Invalid Hermes deletion configuration.");
  }
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" ||
      !origin.port || origin.pathname !== "/" || origin.search || origin.hash ||
      origin.username || origin.password || !PROFILE.test(input.profile) ||
      input.profile === "default" || typeof input.apiKey !== "string" ||
      input.apiKey.length < 16 || input.apiKey.length > 512 || /[\0\r\n]/.test(input.apiKey)) {
    throw new Error("Invalid Hermes deletion configuration.");
  }
  const timeoutMs = input.timeoutMs ?? 5_000;
  const maxResponseBytes = input.maxResponseBytes ?? 64 * 1024;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000 ||
      !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1_024 ||
      maxResponseBytes > 256 * 1024) {
    throw new Error("Invalid Hermes deletion configuration.");
  }
  return { ...input, origin: origin.origin, timeoutMs, maxResponseBytes };
}

async function boundedJson(response: Response, maximum: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Hermes deletion response is too large.");
  }
  if (!response.body) throw new Error("Hermes deletion response is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Hermes deletion response is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

async function requestWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetcher: Fetcher,
  callerSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  callerSignal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (callerSignal?.aborted) controller.abort();
    return await fetcher(url, { ...init, redirect: "error", signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", cancel);
  }
}

async function verifyAbsent(
  url: string,
  headers: HeadersInit,
  config: Required<HermesDeletionConfig>,
  fetcher: Fetcher,
  signal?: AbortSignal,
): Promise<"absent" | "present" | "uncertain"> {
  try {
    const response = await requestWithTimeout(
      url,
      { method: "GET", headers },
      config.timeoutMs,
      fetcher,
      signal,
    );
    if (response.status === 404) {
      const payload = await boundedJson(response, config.maxResponseBytes) as Record<string, unknown>;
      const error = payload?.error;
      return error && typeof error === "object" && !Array.isArray(error) &&
        (error as Record<string, unknown>).code === "session_not_found"
        ? "absent"
        : "uncertain";
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return "uncertain";
    }
    const payload = await boundedJson(response, config.maxResponseBytes) as Record<string, unknown>;
    return payload?.object === "hermes.session" &&
      typeof payload.session === "object" && payload.session !== null
      ? "present"
      : "uncertain";
  } catch {
    return "uncertain";
  }
}

/**
 * Uses Hermes v0.22.2 DELETE /api/sessions/{id}, then independently GETs the
 * same fixed profile resource. A successful DELETE alone is never represented
 * as verified DB absence. This does not claim that Hermes removed every file,
 * compressed ancestor, or other history artifact.
 */
export async function deleteAndVerifyHermesSession(
  input: Readonly<{
    config: HermesDeletionConfig;
    sessionId: string;
    fetcher?: Fetcher;
    signal?: AbortSignal;
  }>,
): Promise<HermesDeletionResult> {
  const config = validatedDeletionConfig(input.config);
  assertSessionId(input.sessionId);
  const fetcher = input.fetcher ?? globalThis.fetch;
  const url = `${config.origin}/p/${encodeURIComponent(config.profile)}/api/sessions/${encodeURIComponent(input.sessionId)}`;
  const headers = { authorization: `Bearer ${config.apiKey}` };
  try {
    const response = await requestWithTimeout(
      url,
      { method: "DELETE", headers },
      config.timeoutMs,
      fetcher,
      input.signal,
    );
    if (response.status === 200) {
      const payload = await boundedJson(response, config.maxResponseBytes) as Record<string, unknown>;
      if (payload?.object !== "hermes.session.deleted" || payload.id !== input.sessionId ||
          typeof payload.deleted !== "boolean") {
        return { state: "uncertain", databaseAbsentVerified: false };
      }
    } else {
      await response.body?.cancel().catch(() => undefined);
    }
  } catch {
    // The outcome may be ambiguous; the independent GET below is authoritative.
  }
  const state = await verifyAbsent(url, headers, config, fetcher, input.signal);
  if (state === "absent") {
    return { state: "database_absent", databaseAbsentVerified: true };
  }
  if (state === "present") return { state: "present", databaseAbsentVerified: false };
  return { state: "uncertain", databaseAbsentVerified: false };
}

export async function drainHermesRetention(
  input: Readonly<{
    journal: HermesRetentionJournal;
    scopeDigest: string;
    config: HermesDeletionConfig;
    now?: number;
    includeNotDue?: boolean;
    maxSessions?: number;
    fetcher?: Fetcher;
    signal?: AbortSignal;
  }>,
): Promise<Readonly<{
  attempted: number;
  databaseAbsent: number;
  blocked: number;
  exhausted: number;
}>> {
  const now = input.now ?? Date.now();
  const maximum = input.maxSessions ?? 16;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 32) {
    throw new Error("Invalid Hermes deletion batch size.");
  }
  const candidates = (await input.journal.sessionsForDeletion(input.scopeDigest, {
    now,
    includeNotDue: input.includeNotDue,
  })).slice(0, maximum);
  let attempted = 0;
  let databaseAbsent = 0;
  let blocked = 0;
  let exhausted = 0;
  for (const session of candidates) {
    if (input.signal?.aborted) break;
    if (session.attempts >= 8) {
      blocked += 1;
      exhausted += 1;
      continue;
    }
    if (!await input.journal.beginDeletion(
      input.scopeDigest,
      session.id,
      now,
      input.signal,
    )) continue;
    attempted += 1;
    const result = await deleteAndVerifyHermesSession({
      config: input.config,
      sessionId: session.id,
      fetcher: input.fetcher,
      signal: input.signal,
    });
    await input.journal.completeDeletion(
      input.scopeDigest,
      session.id,
      result.databaseAbsentVerified,
      now,
      input.signal,
    );
    if (result.databaseAbsentVerified) databaseAbsent += 1;
    else blocked += 1;
  }
  return { attempted, databaseAbsent, blocked, exhausted };
}

export type HermesRetentionSweepStatus = Readonly<{
  phase: "stopped" | "ready" | "sweeping" | "blocked";
  started: boolean;
  ready: boolean;
  inFlight: boolean;
  completedCycles: number;
  attempted: number;
  databaseAbsent: number;
  blocked: number;
  lastCycleStartedAt?: number;
  lastCycleCompletedAt?: number;
  lastError?: "private-state-unavailable" | "cycle-failed" | "retry-exhausted";
}>;

export type HermesRetentionSweepResult = Readonly<{
  scopes: number;
  attempted: number;
  databaseAbsent: number;
  blocked: number;
  exhausted: number;
}>;

export interface HermesRetentionSweepController {
  start(): Promise<void>;
  stop(): Promise<void>;
  runOnce(signal?: AbortSignal): Promise<HermesRetentionSweepResult>;
  status(): HermesRetentionSweepStatus;
}

export type HermesRetentionSweeperOptions = Readonly<{
  journal: HermesRetentionJournal;
  deletion: HermesDeletionConfig;
  intervalMs: number;
  cycleTimeoutMs: number;
  maxScopesPerCycle?: number;
  maxSessionsPerScope?: number;
  fetcher?: Fetcher;
  now?: () => number;
}>;

/**
 * Creates a default-stopped retention sweep controller. Constructing or
 * importing this module never schedules work; the production runtime/launcher
 * must explicitly own start/stop and must include `status().ready` in its
 * activation attestation.
 */
export function createHermesRetentionSweeper(
  options: HermesRetentionSweeperOptions,
): HermesRetentionSweepController {
  validatedDeletionConfig(options.deletion);
  if (!Number.isInteger(options.intervalMs) || options.intervalMs < 1_000 ||
      options.intervalMs > 24 * 60 * 60 * 1_000 ||
      !Number.isInteger(options.cycleTimeoutMs) || options.cycleTimeoutMs < 100 ||
      options.cycleTimeoutMs > 30_000) {
    throw new Error("Invalid Hermes retention sweep configuration.");
  }
  const maxScopes = options.maxScopesPerCycle ?? 16;
  const maxSessions = options.maxSessionsPerScope ?? 8;
  if (!Number.isInteger(maxScopes) || maxScopes < 1 || maxScopes > 64 ||
      !Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 32) {
    throw new Error("Invalid Hermes retention sweep configuration.");
  }
  const now = options.now ?? Date.now;
  let phase: HermesRetentionSweepStatus["phase"] = "stopped";
  let activated = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeController: AbortController | undefined;
  let inFlight: Promise<HermesRetentionSweepResult> | undefined;
  let completedCycles = 0;
  let attempted = 0;
  let databaseAbsent = 0;
  let blocked = 0;
  let lastCycleStartedAt: number | undefined;
  let lastCycleCompletedAt: number | undefined;
  let lastError: HermesRetentionSweepStatus["lastError"];

  const currentStatus = (): HermesRetentionSweepStatus => Object.freeze({
    phase,
    started: activated && (phase === "ready" || phase === "sweeping"),
    ready: activated && (phase === "ready" || phase === "sweeping"),
    inFlight: inFlight !== undefined,
    completedCycles,
    attempted,
    databaseAbsent,
    blocked,
    ...(lastCycleStartedAt === undefined ? {} : { lastCycleStartedAt }),
    ...(lastCycleCompletedAt === undefined ? {} : { lastCycleCompletedAt }),
    ...(lastError === undefined ? {} : { lastError }),
  });

  const currentPhase = (): HermesRetentionSweepStatus["phase"] => phase;
  const block = (reason: NonNullable<HermesRetentionSweepStatus["lastError"]>) => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    phase = "blocked";
    activated = false;
    lastError = reason;
  };

  const schedule = () => {
    if (phase !== "ready" || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void controller.runOnce().then(
        () => schedule(),
        () => {
          // runOnce records the bounded public failure and fail-closes readiness.
        },
      );
    }, options.intervalMs);
  };

  const executeCycle = async (callerSignal?: AbortSignal): Promise<HermesRetentionSweepResult> => {
    const cycleNow = now();
    assertTime(cycleNow, "sweep time");
    const cycleController = new AbortController();
    activeController = cycleController;
    const cancel = () => cycleController.abort();
    callerSignal?.addEventListener("abort", cancel, { once: true });
    if (callerSignal?.aborted) cycleController.abort();
    const timeout = setTimeout(cancel, options.cycleTimeoutMs);
    try {
      await options.journal.recoverStaleCreatingSessions(cycleNow, cycleController.signal);
      const scopes = await options.journal.dueScopeDigests({
        now: cycleNow,
        limit: maxScopes,
      });
      let cycleAttempted = 0;
      let cycleAbsent = 0;
      let cycleBlocked = 0;
      let cycleExhausted = 0;
      for (const scopeDigest of scopes) {
        if (cycleController.signal.aborted) break;
        const result = await drainHermesRetention({
          journal: options.journal,
          scopeDigest,
          config: options.deletion,
          now: cycleNow,
          maxSessions,
          fetcher: options.fetcher,
          signal: cycleController.signal,
        });
        cycleAttempted += result.attempted;
        cycleAbsent += result.databaseAbsent;
        cycleBlocked += result.blocked;
        cycleExhausted += result.exhausted;
      }
      if (cycleController.signal.aborted) {
        throw new Error("Hermes retention sweep was cancelled.");
      }
      return {
        scopes: scopes.length,
        attempted: cycleAttempted,
        databaseAbsent: cycleAbsent,
        blocked: cycleBlocked,
        exhausted: cycleExhausted,
      };
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", cancel);
      if (activeController === cycleController) activeController = undefined;
    }
  };

  const controller: HermesRetentionSweepController = {
    async start() {
      if (phase === "ready" || phase === "sweeping") return;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      lastError = undefined;
      activated = false;
      try {
        await options.journal.recoverStaleCreatingSessions(now());
        await options.journal.dueScopeDigests({ now: now(), limit: maxScopes });
      } catch {
        block("private-state-unavailable");
        throw new Error("Hermes retention sweep private state is unavailable.");
      }
      phase = "ready";
      try {
        await controller.runOnce();
      } catch (cause) {
        if (currentPhase() !== "blocked") block("cycle-failed");
        throw cause;
      }
      activated = true;
      if (currentPhase() === "ready") schedule();
    },

    async stop() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      phase = "stopped";
      activated = false;
      activeController?.abort();
      await inFlight?.catch(() => undefined);
    },

    runOnce(signal?: AbortSignal): Promise<HermesRetentionSweepResult> {
      if (phase !== "ready" && phase !== "sweeping") {
        return Promise.reject(new Error("Hermes retention sweep is not started."));
      }
      if (inFlight) return inFlight;
      phase = "sweeping";
      lastCycleStartedAt = now();
      const cycle = executeCycle(signal).then(
        (result) => {
          completedCycles += 1;
          attempted += result.attempted;
          databaseAbsent += result.databaseAbsent;
          blocked += result.blocked;
          lastCycleCompletedAt = now();
          if (result.exhausted > 0) {
            block("retry-exhausted");
          } else if (currentPhase() !== "stopped") {
            phase = "ready";
          }
          return result;
        },
        () => {
          if (currentPhase() !== "stopped") block("cycle-failed");
          throw new Error("Hermes retention sweep failed.");
        },
      );
      const tracked = cycle.finally(() => {
        if (inFlight === tracked) inFlight = undefined;
      });
      inFlight = tracked;
      return tracked;
    },

    status: currentStatus,
  };
  return controller;
}
