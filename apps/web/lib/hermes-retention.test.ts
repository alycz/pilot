import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const aclInspector = vi.hoisted(() => ({
  inspect: vi.fn<(target: string) => void>(),
}));

vi.mock("./hermes-profile-gate", () => ({
  inspectHermesPrivateMacAcl: aclInspector.inspect,
}));

import {
  deleteAndVerifyHermesSession,
  drainHermesRetention,
  HermesRetentionCommitUncertainError,
  HermesRetentionContentionError,
  HermesRetentionJournal,
} from "./hermes-retention";

const SCOPE = "a".repeat(64);
const NOW = 1_800_000_000_000;
const config = {
  origin: "http://127.0.0.1:8642",
  profile: "pilot-proposal-v1",
  apiKey: "synthetic-hermes-api-key-not-secret",
};

let directory = "";
let statePath = "";

async function writeLock(record: unknown, path = statePath): Promise<string> {
  const lockPath = join(directory, `.${basename(path)}.lock`);
  await writeFile(lockPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return lockPath;
}

beforeEach(async () => {
  aclInspector.inspect.mockReset();
  directory = await mkdtemp(join(await realpath(tmpdir()), "pilot-hermes-retention-"));
  statePath = join(directory, "state.json");
});

afterEach(async () => {
  await chmod(directory, 0o700).catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
});

describe("Hermes durable retention journal", () => {
  it("persists consent epochs and makes revocation monotonic", async () => {
    const journal = new HermesRetentionJournal(statePath);
    expect(await journal.consent(SCOPE)).toEqual({ epoch: 0, state: "missing" });
    expect(await journal.acceptConsent(SCOPE, NOW)).toBe(1);
    expect(await journal.consent(SCOPE)).toEqual({ epoch: 1, state: "accepted" });

    await journal.registerSession({
      scopeDigest: SCOPE,
      sessionId: "session-one",
      expectedConsentEpoch: 1,
      creationDeadline: NOW + 90_000,
      deleteAfter: NOW + 7 * 24 * 60 * 60 * 1_000,
      now: NOW,
    });
    const revoked = await journal.revokeConsent(SCOPE, NOW + 1);
    expect(revoked).toEqual({ epoch: 2, pendingSessionIds: ["session-one"] });
    expect(await journal.consent(SCOPE)).toEqual({ epoch: 2, state: "revoked" });

    const reopened = new HermesRetentionJournal(statePath);
    expect(await reopened.acceptConsent(SCOPE, NOW + 2)).toBe(3);
    const onDisk = await readFile(statePath, "utf8");
    expect(onDisk).not.toContain("owner");
    expect(onDisk).toContain(SCOPE);
  });

  it("serializes concurrent different-scope consent without losing either scope", async () => {
    const otherScope = "b".repeat(64);
    let enteredCriticalSection!: () => void;
    const criticalSectionEntered = new Promise<void>((resolve) => {
      enteredCriticalSection = resolve;
    });
    let releaseCriticalSection!: () => void;
    const criticalSectionRelease = new Promise<void>((resolve) => {
      releaseCriticalSection = resolve;
    });
    const first = new HermesRetentionJournal(statePath, {
      syncParentDirectory: async () => {
        enteredCriticalSection();
        await criticalSectionRelease;
      },
    });
    let retryEntered!: () => void;
    const observedRetry = new Promise<void>((resolve) => { retryEntered = resolve; });
    let releaseRetry!: () => void;
    const retryRelease = new Promise<void>((resolve) => { releaseRetry = resolve; });
    const second = new HermesRetentionJournal(statePath, {
      lockRetryDelay: async () => {
        retryEntered();
        await retryRelease;
      },
    });

    const firstAcceptance = first.acceptConsent(SCOPE, NOW);
    await criticalSectionEntered;
    const secondAcceptance = second.acceptConsent(otherScope, NOW + 1);
    await observedRetry;
    releaseCriticalSection();
    await expect(firstAcceptance).resolves.toBe(1);
    releaseRetry();
    await expect(secondAcceptance).resolves.toBe(1);
    await expect(second.consent(SCOPE)).resolves.toEqual({ epoch: 1, state: "accepted" });
    await expect(second.consent(otherScope)).resolves.toEqual({ epoch: 1, state: "accepted" });
  });

  it("publishes a complete lock before simultaneous first acquisition can inspect it", async () => {
    const otherScope = "b".repeat(64);
    const lockPath = join(directory, `.${basename(statePath)}.lock`);
    let firstPublishEntered!: () => void;
    const firstPublishObserved = new Promise<void>((resolve) => {
      firstPublishEntered = resolve;
    });
    let releaseFirstPublish!: () => void;
    const firstPublishRelease = new Promise<void>((resolve) => {
      releaseFirstPublish = resolve;
    });
    let firstTemporary = "";
    let pauseFirstPublish = true;
    let retryEntered!: () => void;
    const retryObserved = new Promise<void>((resolve) => {
      retryEntered = resolve;
    });
    let releaseRetry!: () => void;
    const retryRelease = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const first = new HermesRetentionJournal(statePath, {
      now: () => NOW + 2,
      beforeLockPublish: async (temporary, target) => {
        if (!pauseFirstPublish) return;
        pauseFirstPublish = false;
        firstTemporary = temporary;
        expect(target).toBe(lockPath);
        firstPublishEntered();
        await firstPublishRelease;
      },
      lockRetryDelay: async () => {
        retryEntered();
        await retryRelease;
      },
    });

    let secondCriticalEntered!: () => void;
    const secondCriticalObserved = new Promise<void>((resolve) => {
      secondCriticalEntered = resolve;
    });
    let releaseSecondCritical!: () => void;
    const secondCriticalRelease = new Promise<void>((resolve) => {
      releaseSecondCritical = resolve;
    });
    const second = new HermesRetentionJournal(statePath, {
      now: () => NOW + 2,
      syncParentDirectory: async () => {
        secondCriticalEntered();
        await secondCriticalRelease;
      },
    });

    const firstAcceptance = first.acceptConsent(SCOPE, NOW);
    await firstPublishObserved;
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    const unpublished = await lstat(firstTemporary);
    expect(unpublished.isFile()).toBe(true);
    expect(unpublished.nlink).toBe(1);
    expect(unpublished.mode & 0o077).toBe(0);
    await expect(readFile(firstTemporary, "utf8")).resolves.toMatch(
      /\{"version":1,"pid":\d+,"ownerId":"[a-f0-9-]+","createdAt":\d+\}/,
    );

    const secondAcceptance = second.acceptConsent(otherScope, NOW + 1);
    await secondCriticalObserved;
    releaseFirstPublish();
    await retryObserved;
    releaseSecondCritical();
    await expect(secondAcceptance).resolves.toBe(1);
    releaseRetry();
    await expect(firstAcceptance).resolves.toBe(1);

    await expect(lstat(firstTemporary)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(first.consent(SCOPE)).resolves.toEqual({ epoch: 1, state: "accepted" });
    await expect(first.consent(otherScope)).resolves.toEqual({ epoch: 1, state: "accepted" });
  });

  it("retries a structurally valid claim caught between link and unlink", async () => {
    const otherScope = "b".repeat(64);
    const lockPath = join(directory, `.${basename(statePath)}.lock`);
    let linkEntered!: () => void;
    const linkObserved = new Promise<void>((resolve) => {
      linkEntered = resolve;
    });
    let releaseLink!: () => void;
    const linkRelease = new Promise<void>((resolve) => {
      releaseLink = resolve;
    });
    let claimPath = "";
    let pauseAfterLink = true;
    const first = new HermesRetentionJournal(statePath, {
      now: () => NOW + 2,
      afterLockLink: async (temporary, target) => {
        if (!pauseAfterLink) return;
        pauseAfterLink = false;
        claimPath = temporary;
        expect(target).toBe(lockPath);
        linkEntered();
        await linkRelease;
      },
    });
    let retryEntered!: () => void;
    const retryObserved = new Promise<void>((resolve) => {
      retryEntered = resolve;
    });
    let releaseRetry!: () => void;
    const retryRelease = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const second = new HermesRetentionJournal(statePath, {
      now: () => NOW + 2,
      lockRetryDelay: async () => {
        retryEntered();
        await retryRelease;
      },
    });

    const firstAcceptance = first.acceptConsent(SCOPE, NOW);
    await linkObserved;
    const [published, claim] = await Promise.all([lstat(lockPath), lstat(claimPath)]);
    expect(published.ino).toBe(claim.ino);
    expect(published.nlink).toBe(2);
    expect(claim.nlink).toBe(2);

    const secondAcceptance = second.acceptConsent(otherScope, NOW + 1);
    await retryObserved;
    releaseLink();
    await expect(firstAcceptance).resolves.toBe(1);
    releaseRetry();
    await expect(secondAcceptance).resolves.toBe(1);

    await expect(lstat(claimPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(second.consent(SCOPE)).resolves.toEqual({ epoch: 1, state: "accepted" });
    await expect(second.consent(otherScope)).resolves.toEqual({ epoch: 1, state: "accepted" });
  });

  it("requires current consent and bounds the deletion window", async () => {
    const journal = new HermesRetentionJournal(statePath);
    await expect(journal.registerSession({
      scopeDigest: SCOPE,
      sessionId: "session-one",
      expectedConsentEpoch: 1,
      creationDeadline: NOW + 45_000,
      deleteAfter: NOW + 1,
      now: NOW,
    })).rejects.toThrow("without current consent");
    await journal.acceptConsent(SCOPE, NOW);
    await expect(journal.registerSession({
      scopeDigest: SCOPE,
      sessionId: "session-one",
      expectedConsentEpoch: 1,
      creationDeadline: NOW + 45_000,
      deleteAfter: NOW + 31 * 24 * 60 * 60 * 1_000,
      now: NOW,
    })).rejects.toThrow("30 days");
    await expect(journal.registerSession({
      scopeDigest: SCOPE,
      sessionId: "session-too-long",
      expectedConsentEpoch: 1,
      creationDeadline: NOW + 90_001,
      deleteAfter: NOW + 60_000,
      now: NOW,
    })).rejects.toThrow("within 90 seconds");
  });

  it("keeps revoked work eligible after re-consent and rejects cross-scope session collisions", async () => {
    const otherScope = "b".repeat(64);
    const journal = new HermesRetentionJournal(statePath);
    await journal.acceptConsent(SCOPE, NOW);
    await journal.registerSession({
      scopeDigest: SCOPE,
      sessionId: "session-shared",
      expectedConsentEpoch: 1,
      creationDeadline: NOW + 45_000,
      deleteAfter: NOW + 7 * 24 * 60 * 60 * 1_000,
      now: NOW,
    });
    await journal.settleSessionCreation({
      scopeDigest: SCOPE,
      sessionId: "session-shared",
      expectedConsentEpoch: 1,
      outcome: "created",
      now: NOW,
    });
    await journal.revokeConsent(SCOPE, NOW + 1);
    await journal.acceptConsent(SCOPE, NOW + 2);
    expect(await journal.sessionsForDeletion(SCOPE, { now: NOW + 2 })).toMatchObject([
      { id: "session-shared", state: "pending_delete" },
    ]);

    await journal.acceptConsent(otherScope, NOW + 2);
    await expect(journal.registerSession({
      scopeDigest: otherScope,
      sessionId: "session-shared",
      expectedConsentEpoch: 1,
      creationDeadline: NOW + 45_000,
      deleteAfter: NOW + 60_000,
      now: NOW + 2,
    })).rejects.toThrow("another scope");
  });

  it("protects creating sessions from premature absence and deletes after settlement", async () => {
    const journal = new HermesRetentionJournal(statePath);
    await journal.acceptConsent(SCOPE, NOW);
    await journal.registerSession({
      scopeDigest: SCOPE,
      sessionId: "session-race",
      expectedConsentEpoch: 1,
      creationDeadline: NOW + 45_000,
      deleteAfter: NOW + 60_000,
      now: NOW,
    });
    const revoked = await journal.revokeConsent(SCOPE, NOW + 1);
    expect(revoked.pendingSessionIds).toEqual(["session-race"]);
    expect(await journal.sessionsForDeletion(SCOPE, {
      now: NOW + 1,
      includeNotDue: true,
    })).toEqual([]);
    await expect(journal.beginDeletion(SCOPE, "session-race", NOW + 1))
      .rejects.toThrow("creation is not settled");
    const beforeSettle = vi.fn<typeof fetch>();
    await expect(drainHermesRetention({
      journal,
      scopeDigest: SCOPE,
      config,
      now: NOW + 1,
      fetcher: beforeSettle,
    })).resolves.toEqual({ attempted: 0, databaseAbsent: 0, blocked: 0, exhausted: 0 });
    expect(beforeSettle).not.toHaveBeenCalled();

    await expect(journal.settleSessionCreation({
      scopeDigest: SCOPE,
      sessionId: "session-race",
      expectedConsentEpoch: 1,
      outcome: "created",
      now: NOW + 2,
    })).resolves.toBe("pending_delete");
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        object: "hermes.session.deleted",
        id: "session-race",
        deleted: true,
      }))
      .mockResolvedValueOnce(Response.json(
        { error: { code: "session_not_found" } },
        { status: 404 },
      ));
    await expect(drainHermesRetention({
      journal,
      scopeDigest: SCOPE,
      config,
      now: NOW + 2,
      fetcher,
    })).resolves.toEqual({ attempted: 1, databaseAbsent: 1, blocked: 0, exhausted: 0 });
  });

  it("keeps an old-epoch session pending after revoke and re-accept", async () => {
    const journal = new HermesRetentionJournal(statePath);
    await journal.acceptConsent(SCOPE, NOW);
    await journal.registerSession({
      scopeDigest: SCOPE,
      sessionId: "session-old-epoch",
      expectedConsentEpoch: 1,
      creationDeadline: NOW + 45_000,
      deleteAfter: NOW + 60_000,
      now: NOW,
    });
    await journal.revokeConsent(SCOPE, NOW + 1);
    await journal.acceptConsent(SCOPE, NOW + 2);
    await expect(journal.settleSessionCreation({
      scopeDigest: SCOPE,
      sessionId: "session-old-epoch",
      expectedConsentEpoch: 1,
      outcome: "created",
      now: NOW + 3,
    })).resolves.toBe("pending_delete");
    expect(await journal.sessionsForDeletion(SCOPE, { now: NOW + 3 })).toMatchObject([
      { id: "session-old-epoch", state: "pending_delete", expectedConsentEpoch: 1 },
    ]);
  });

  it("requires exact creation epoch and preserves uncertain settlement idempotently", async () => {
    const journal = new HermesRetentionJournal(statePath);
    await journal.acceptConsent(SCOPE, NOW);
    await expect(journal.registerSession({
      scopeDigest: SCOPE,
      sessionId: "session-wrong-epoch",
      expectedConsentEpoch: 2,
      creationDeadline: NOW + 45_000,
      deleteAfter: NOW + 60_000,
      now: NOW,
    })).rejects.toThrow("current consent");
    await journal.registerSession({
      scopeDigest: SCOPE,
      sessionId: "session-uncertain-create",
      expectedConsentEpoch: 1,
      creationDeadline: NOW + 45_000,
      deleteAfter: NOW + 60_000,
      now: NOW,
    });
    await expect(journal.settleSessionCreation({
      scopeDigest: SCOPE,
      sessionId: "session-uncertain-create",
      expectedConsentEpoch: 1,
      outcome: "uncertain",
      now: NOW + 1,
    })).resolves.toBe("uncertain");
    await expect(journal.settleSessionCreation({
      scopeDigest: SCOPE,
      sessionId: "session-uncertain-create",
      expectedConsentEpoch: 1,
      outcome: "created",
      now: NOW + 2,
    })).resolves.toBe("uncertain");
  });

  it("retries settlement contention without exposing a live creation to deletion", async () => {
    const setupJournal = new HermesRetentionJournal(statePath);
    await setupJournal.acceptConsent(SCOPE, NOW);
    await setupJournal.registerSession({
      scopeDigest: SCOPE,
      sessionId: "session-contended",
      expectedConsentEpoch: 1,
      creationDeadline: NOW + 45_000,
      deleteAfter: NOW + 60_000,
      now: NOW,
    });
    const lockPath = join(directory, `.${basename(statePath)}.lock`);
    const lock = await open(lockPath, "wx", 0o600);
    await lock.writeFile(`${JSON.stringify({
      version: 1,
      pid: process.pid,
      ownerId: "11111111-1111-4111-8111-111111111111",
      createdAt: Date.now(),
    })}\n`);
    await lock.sync();
    let released = false;
    const journal = new HermesRetentionJournal(statePath, {
      afterExistingLockOpen: async (target) => {
        if (released) return;
        released = true;
        await lock.close();
        await unlink(target);
      },
    });
    const fetcher = vi.fn<typeof fetch>();
    await expect(drainHermesRetention({
      journal,
      scopeDigest: SCOPE,
      config,
      now: NOW + 1,
      includeNotDue: true,
      fetcher,
    })).resolves.toEqual({ attempted: 0, databaseAbsent: 0, blocked: 0, exhausted: 0 });
    expect(fetcher).not.toHaveBeenCalled();

    await expect(journal.settleSessionCreation({
      scopeDigest: SCOPE,
      sessionId: "session-contended",
      expectedConsentEpoch: 1,
      outcome: "created",
      now: NOW + 1,
    })).resolves.toBe("active");
    expect(released).toBe(true);
    expect(await journal.sessionsForDeletion(SCOPE, {
      now: NOW + 1,
      includeNotDue: true,
    })).toMatchObject([{ id: "session-contended", state: "active" }]);
  });

  it("fails closed on public parent permissions and malformed state", async () => {
    await chmod(directory, 0o755);
    await expect(new HermesRetentionJournal(statePath).acceptConsent(SCOPE, NOW))
      .rejects.toThrow("owner-private");
    await chmod(directory, 0o700);
    await writeFile(statePath, '{"version":1,"scopes":"bad"}\n', { mode: 0o600 });
    await expect(new HermesRetentionJournal(statePath).consent(SCOPE))
      .rejects.toThrow("invalid");
  });

  it("rejects a non-sticky writable ancestor and accepts the sticky boundary fixture", async () => {
    const writableAncestor = join(directory, "writable-ancestor");
    const privateParent = join(writableAncestor, "private-state");
    await mkdir(writableAncestor, { mode: 0o700 });
    await mkdir(privateParent, { mode: 0o700 });
    await chmod(writableAncestor, 0o777);
    const nestedPath = join(privateParent, "state.json");
    await expect(new HermesRetentionJournal(nestedPath).acceptConsent(SCOPE, NOW))
      .rejects.toThrow("unsafe ancestor chain");
    await chmod(writableAncestor, 0o1777);
    await expect(new HermesRetentionJournal(nestedPath).acceptConsent(SCOPE, NOW))
      .resolves.toBe(1);
  });

  it("reports commit uncertainty after rename while preserving the committed state", async () => {
    const delay = vi.fn(async () => undefined);
    const journal = new HermesRetentionJournal(statePath, {
      syncParentDirectory: async () => {
        throw new Error("synthetic parent fsync failure");
      },
      lockRetryDelay: delay,
    });
    await expect(journal.acceptConsent(SCOPE, NOW))
      .rejects.toBeInstanceOf(HermesRetentionCommitUncertainError);
    expect(delay).not.toHaveBeenCalled();
    await expect(new HermesRetentionJournal(statePath).consent(SCOPE))
      .resolves.toEqual({ epoch: 1, state: "accepted" });
  });

  it("recovers only an old lock owned by a definitively dead process", async () => {
    const lockPath = await writeLock({
      version: 1,
      pid: 424_242,
      ownerId: "22222222-2222-4222-8222-222222222222",
      createdAt: NOW,
    });
    const journal = new HermesRetentionJournal(statePath, {
      now: () => NOW + 120_000,
      processState: () => "dead",
      lockOwnerId: "33333333-3333-4333-8333-333333333333",
    });
    await expect(journal.acceptConsent(SCOPE, NOW + 120_000)).resolves.toBe(1);
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(journal.consent(SCOPE)).resolves.toEqual({ epoch: 1, state: "accepted" });
  });

  it("retries when another writer wins creation immediately after stale reclaim", async () => {
    const lockPath = await writeLock({
      version: 1,
      pid: 424_242,
      ownerId: "22222222-2222-4222-8222-222222222222",
      createdAt: NOW,
    });
    let rival: Awaited<ReturnType<typeof open>> | undefined;
    const delay = vi.fn(async () => {
      await rival?.close();
      rival = undefined;
      await unlink(lockPath);
    });
    const journal = new HermesRetentionJournal(statePath, {
      now: () => NOW + 120_000,
      processState: () => "dead",
      lockRetryDelay: delay,
      afterLockReclaim: async (target) => {
        rival = await open(target, "wx", 0o600);
        await rival.writeFile(`${JSON.stringify({
          version: 1,
          pid: process.pid,
          ownerId: "33333333-3333-4333-8333-333333333333",
          createdAt: NOW + 120_000,
        })}\n`);
        await rival.sync();
      },
    });

    try {
      await expect(journal.acceptConsent(SCOPE, NOW + 120_000)).resolves.toBe(1);
      expect(delay).toHaveBeenCalledTimes(1);
      await expect(journal.consent(SCOPE)).resolves.toEqual({ epoch: 1, state: "accepted" });
      await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rival?.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  });

  it("bounds retry exhaustion without stealing a live owner's old lock", async () => {
    const lockPath = await writeLock({
      version: 1,
      pid: process.pid,
      ownerId: "44444444-4444-4444-8444-444444444444",
      createdAt: NOW,
    });
    const before = await readFile(lockPath, "utf8");
    const delay = vi.fn(async () => undefined);
    const retryClock = vi.spyOn(performance, "now").mockReturnValue(0);
    const journal = new HermesRetentionJournal(statePath, {
      now: () => NOW + 120_000,
      processState: () => "alive",
      lockRetryDelay: delay,
    });

    try {
      await expect(journal.acceptConsent(SCOPE, NOW + 120_000))
        .rejects.toBeInstanceOf(HermesRetentionContentionError);
      expect(delay).toHaveBeenCalledTimes(60);
      expect(await readFile(lockPath, "utf8")).toBe(before);
    } finally {
      retryClock.mockRestore();
    }
  });

  it("fails immediately when old-lock owner state is ambiguous", async () => {
    const lockPath = await writeLock({
      version: 1,
      pid: process.pid,
      ownerId: "44444444-4444-4444-8444-444444444444",
      createdAt: NOW,
    });
    const before = await readFile(lockPath, "utf8");
    const delay = vi.fn(async () => undefined);
    const journal = new HermesRetentionJournal(statePath, {
      now: () => NOW + 120_000,
      processState: () => "ambiguous",
      lockRetryDelay: delay,
    });

    await expect(journal.acceptConsent(SCOPE, NOW + 120_000))
      .rejects.toThrow("owner state is ambiguous");
    expect(delay).not.toHaveBeenCalled();
    expect(await readFile(lockPath, "utf8")).toBe(before);
  });

  it("aborts while waiting for a contended live lock without mutating state", async () => {
    const lockPath = await writeLock({
      version: 1,
      pid: process.pid,
      ownerId: "55555555-5555-4555-8555-555555555555",
      createdAt: NOW,
    });
    let waiting!: () => void;
    const waitStarted = new Promise<void>((resolve) => { waiting = resolve; });
    const journal = new HermesRetentionJournal(statePath, {
      now: () => NOW + 1,
      lockRetryDelay: async (_delayMs, signal) => {
        waiting();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new DOMException("synthetic abort", "AbortError"));
          }, { once: true });
        });
      },
    });
    const controller = new AbortController();
    const acceptance = journal.acceptConsent(SCOPE, NOW + 1, controller.signal);
    await waitStarted;
    controller.abort();

    await expect(acceptance).rejects.toMatchObject({ name: "AbortError" });
    await expect(lstat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(lockPath, "utf8")).resolves.toContain("55555555");
  });

  it("preserves a racing replacement instead of unlinking or overwriting it", async () => {
    const original = {
      version: 1,
      pid: 424_242,
      ownerId: "77777777-7777-4777-8777-777777777777",
      createdAt: NOW,
    };
    const replacement = `${JSON.stringify({
      version: 1,
      pid: process.pid,
      ownerId: "88888888-8888-4888-8888-888888888888",
      createdAt: NOW + 120_000,
    })}\n`;
    const lockPath = await writeLock(original);
    const displaced = join(directory, "displaced-original-lock");
    const journal = new HermesRetentionJournal(statePath, {
      now: () => NOW + 120_000,
      processState: () => "dead",
      lockRetryDelay: async () => undefined,
      beforeLockReclaim: async (target) => {
        await rename(target, displaced);
        await writeFile(target, replacement, { mode: 0o600 });
      },
    });

    await expect(journal.acceptConsent(SCOPE, NOW + 120_000))
      .rejects.toBeInstanceOf(HermesRetentionContentionError);
    await expect(readFile(lockPath, "utf8")).resolves.toBe(replacement);
    await expect(readFile(displaced, "utf8")).resolves.toContain(original.ownerId);
  });

  it("fails closed for malformed and unsafe lock files without removing them", async () => {
    const malformed = await writeLock({ version: 1 });
    const delay = vi.fn(async () => undefined);
    const journal = new HermesRetentionJournal(statePath, {
      now: () => NOW + 120_000,
      processState: () => "dead",
      lockRetryDelay: delay,
    });
    await expect(journal.acceptConsent(SCOPE, NOW + 120_000))
      .rejects.toThrow("malformed");
    await expect(readFile(malformed, "utf8")).resolves.toContain("version");

    await unlink(malformed);
    const target = join(directory, "lock-target");
    await writeFile(target, "do-not-delete\n", { mode: 0o600 });
    await symlink(target, malformed);
    await expect(journal.acceptConsent(SCOPE, NOW + 120_000))
      .rejects.toThrow("unsafe");
    await expect(readFile(target, "utf8")).resolves.toBe("do-not-delete\n");
    expect(delay).not.toHaveBeenCalled();
  });

  it("keeps a stable hardlinked lock unsafe instead of retrying it", async () => {
    const lockPath = await writeLock({
      version: 1,
      pid: process.pid,
      ownerId: "99999999-9999-4999-8999-999999999999",
      createdAt: NOW,
    });
    const secondLink = join(directory, "second-lock-link");
    await link(lockPath, secondLink);
    const delay = vi.fn(async () => undefined);
    const journal = new HermesRetentionJournal(statePath, {
      now: () => NOW + 1,
      lockRetryDelay: delay,
    });

    await expect(journal.acceptConsent(SCOPE, NOW + 1)).rejects.toThrow("unsafe");
    expect(delay).not.toHaveBeenCalled();
    await expect(readFile(lockPath, "utf8")).resolves.toContain("99999999");
    await expect(readFile(secondLink, "utf8")).resolves.toContain("99999999");
  });

  it("fails closed when a generated claim sibling is left behind", async () => {
    const lockPath = await writeLock({
      version: 1,
      pid: process.pid,
      ownerId: "99999999-9999-4999-8999-999999999999",
      createdAt: NOW,
    });
    const claimPath = join(
      directory,
      `.${basename(lockPath)}.123e4567-e89b-42d3-a456-426614174000.claim`,
    );
    await link(lockPath, claimPath);
    const delay = vi.fn(async () => undefined);
    const journal = new HermesRetentionJournal(statePath, {
      now: () => NOW + 1,
      lockRetryDelay: delay,
    });

    await expect(journal.acceptConsent(SCOPE, NOW + 1))
      .rejects.toBeInstanceOf(HermesRetentionContentionError);
    expect(delay).toHaveBeenCalled();
    await expect(readFile(lockPath, "utf8")).resolves.toContain("99999999");
    await expect(readFile(claimPath, "utf8")).resolves.toContain("99999999");
  });

  it("rejects a malformed generated claim immediately without retrying", async () => {
    const lockPath = await writeLock({ version: 1 });
    const claimPath = join(
      directory,
      `.${basename(lockPath)}.123e4567-e89b-42d3-a456-426614174001.claim`,
    );
    await link(lockPath, claimPath);
    const delay = vi.fn(async () => undefined);
    const journal = new HermesRetentionJournal(statePath, {
      now: () => NOW + 1,
      lockRetryDelay: delay,
    });

    await expect(journal.acceptConsent(SCOPE, NOW + 1)).rejects.toThrow("malformed");
    expect(delay).not.toHaveBeenCalled();
    await expect(readFile(lockPath, "utf8")).resolves.toContain("version");
    await expect(readFile(claimPath, "utf8")).resolves.toContain("version");
  });

  it("rejects a public-mode generated claim immediately without retrying", async () => {
    const lockPath = await writeLock({
      version: 1,
      pid: process.pid,
      ownerId: "99999999-9999-4999-8999-999999999999",
      createdAt: NOW,
    });
    const claimPath = join(
      directory,
      `.${basename(lockPath)}.123e4567-e89b-42d3-a456-426614174002.claim`,
    );
    await link(lockPath, claimPath);
    await chmod(lockPath, 0o644);
    const delay = vi.fn(async () => undefined);
    const journal = new HermesRetentionJournal(statePath, {
      now: () => NOW + 1,
      lockRetryDelay: delay,
    });

    await expect(journal.acceptConsent(SCOPE, NOW + 1)).rejects.toThrow("unsafe");
    expect(delay).not.toHaveBeenCalled();
    expect((await lstat(lockPath)).mode & 0o077).not.toBe(0);
    expect((await lstat(claimPath)).mode & 0o077).not.toBe(0);
  });

  it("rejects malformed creation lifecycle records", async () => {
    const base = {
      id: "session-malformed",
      expectedConsentEpoch: 1,
      creationDeadline: NOW + 45_000,
      deleteAfter: NOW + 60_000,
      state: "creating",
      attempts: 0,
      updatedAt: NOW,
    };
    for (const session of [
      { ...base, expectedConsentEpoch: undefined },
      { ...base, attempts: 1 },
      { ...base, state: "active", expectedConsentEpoch: 2 },
      { ...base, state: "database_absent", attempts: 0, databaseAbsentAt: NOW },
    ]) {
      const state = {
        version: 1,
        scopes: [{
          scopeDigest: SCOPE,
          consentEpoch: 1,
          consentState: "accepted",
          updatedAt: NOW,
          sessions: [session],
        }],
      };
      await writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      await expect(new HermesRetentionJournal(statePath).consent(SCOPE))
        .rejects.toThrow("invalid");
    }
  });

  it("rejects a granting macOS ACL on the state inode", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    try {
      const journal = new HermesRetentionJournal(statePath);
      await journal.acceptConsent(SCOPE, NOW);
      aclInspector.inspect.mockImplementation((target) => {
        if (target === statePath) throw new Error("synthetic granting ACL");
      });
      await utimes(statePath, new Date(NOW - 2_000), new Date(NOW - 2_000));
      await expect(journal.consent(SCOPE)).rejects.toThrow("unsafe ACL");
      expect(aclInspector.inspect).toHaveBeenCalledWith(statePath);
      aclInspector.inspect.mockReset();
      await utimes(statePath, new Date(NOW - 1_000), new Date(NOW - 1_000));
      await expect(journal.consent(SCOPE)).resolves.toEqual({
        epoch: 1,
        state: "accepted",
      });
    } finally {
      platform.mockRestore();
    }
  });

  it("rejects granting write/delete_child ACLs on every state ancestor", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    try {
      const aclAncestor = join(directory, "acl-ancestor");
      const privateParent = join(aclAncestor, "private-state");
      await mkdir(aclAncestor, { mode: 0o700 });
      await mkdir(privateParent, { mode: 0o700 });
      const nestedPath = join(privateParent, "state.json");
      const nested = new HermesRetentionJournal(nestedPath);
      await expect(nested.acceptConsent(SCOPE, NOW)).resolves.toBe(1);
      aclInspector.inspect.mockImplementation((target) => {
        if (target === aclAncestor) throw new Error("synthetic granting ancestor ACL");
      });
      const invalidator = join(aclAncestor, "acl-snapshot-invalidator");
      await writeFile(invalidator, "invalidate\n", { mode: 0o600 });
      await expect(nested.consent(SCOPE))
        .rejects.toThrow("unsafe ACL");
      expect(aclInspector.inspect).toHaveBeenCalledWith(aclAncestor);
      aclInspector.inspect.mockReset();
      await unlink(invalidator);
      await expect(nested.consent(SCOPE))
        .resolves.toEqual({ epoch: 1, state: "accepted" });
    } finally {
      platform.mockRestore();
    }
  });

  it("rejects symlinked and multiply linked state files", async () => {
    const target = join(directory, "target.json");
    await writeFile(target, '{"version":1,"scopes":[]}\n', { mode: 0o600 });
    await symlink(target, statePath);
    await expect(new HermesRetentionJournal(statePath).consent(SCOPE))
      .rejects.toThrow("single regular file");
    await rm(statePath);
    await link(target, statePath);
    await expect(new HermesRetentionJournal(statePath).consent(SCOPE))
      .rejects.toThrow("single regular file");
  });

  it("keeps a durable DB-absence tombstone and never duplicates deletion", async () => {
    const journal = new HermesRetentionJournal(statePath);
    await journal.acceptConsent(SCOPE, NOW);
    await journal.registerSession({
      scopeDigest: SCOPE,
      sessionId: "session-one",
      expectedConsentEpoch: 1,
      creationDeadline: NOW + 45_000,
      deleteAfter: NOW,
      now: NOW,
    });
    await journal.settleSessionCreation({
      scopeDigest: SCOPE,
      sessionId: "session-one",
      expectedConsentEpoch: 1,
      outcome: "created",
      now: NOW,
    });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        object: "hermes.session.deleted",
        id: "session-one",
        deleted: true,
      }))
      .mockResolvedValueOnce(Response.json(
        { error: { code: "session_not_found" } },
        { status: 404 },
      ));

    await expect(drainHermesRetention({
      journal,
      scopeDigest: SCOPE,
      config,
      now: NOW,
      fetcher,
    })).resolves.toEqual({ attempted: 1, databaseAbsent: 1, blocked: 0, exhausted: 0 });
    await expect(drainHermesRetention({
      journal,
      scopeDigest: SCOPE,
      config,
      now: NOW + 1,
      fetcher,
    })).resolves.toEqual({ attempted: 0, databaseAbsent: 0, blocked: 0, exhausted: 0 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await journal.sessionsForDeletion(SCOPE, { now: NOW + 1 }))).toEqual([]);
  });

  it("retains an uncertain marker when DB absence cannot be verified", async () => {
    const journal = new HermesRetentionJournal(statePath);
    await journal.acceptConsent(SCOPE, NOW);
    await journal.registerSession({
      scopeDigest: SCOPE,
      sessionId: "session-one",
      expectedConsentEpoch: 1,
      creationDeadline: NOW + 45_000,
      deleteAfter: NOW,
      now: NOW,
    });
    await journal.settleSessionCreation({
      scopeDigest: SCOPE,
      sessionId: "session-one",
      expectedConsentEpoch: 1,
      outcome: "created",
      now: NOW,
    });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        object: "hermes.session.deleted",
        id: "session-one",
        deleted: true,
      }))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    expect(await drainHermesRetention({
      journal,
      scopeDigest: SCOPE,
      config,
      now: NOW,
      fetcher,
    })).toEqual({ attempted: 1, databaseAbsent: 0, blocked: 1, exhausted: 0 });
    expect(await journal.sessionsForDeletion(SCOPE, { now: NOW + 1 })).toMatchObject([
      { id: "session-one", state: "uncertain", attempts: 1 },
    ]);
  });
});

describe("Hermes session deletion client", () => {
  it("uses the exact profile session endpoint and only verifies a following GET 404", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        object: "hermes.session.deleted",
        id: "session-one",
        deleted: true,
      }))
      .mockResolvedValueOnce(Response.json(
        { error: { code: "session_not_found" } },
        { status: 404 },
      ));
    await expect(deleteAndVerifyHermesSession({
      config,
      sessionId: "session-one",
      fetcher,
    })).resolves.toEqual({
      state: "database_absent",
      databaseAbsentVerified: true,
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:8642/p/pilot-proposal-v1/api/sessions/session-one",
      expect.objectContaining({ method: "DELETE", redirect: "error" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:8642/p/pilot-proposal-v1/api/sessions/session-one",
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
    const headers = new Headers(fetcher.mock.calls[0]![1]?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${config.apiKey}`);
  });

  it("does not mistake DELETE success for complete or verified erasure", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        object: "hermes.session.deleted",
        id: "session-one",
        deleted: true,
      }))
      .mockResolvedValueOnce(Response.json({
        object: "hermes.session",
        session: { id: "session-one" },
      }));
    await expect(deleteAndVerifyHermesSession({ config, sessionId: "session-one", fetcher }))
      .resolves.toEqual({ state: "present", databaseAbsentVerified: false });
  });

  it("does not treat an unknown-profile 404 as session DB absence", async () => {
    const unknown = () => Response.json(
      { error: "Unknown or unconfigured profile" },
      { status: 404 },
    );
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(unknown())
      .mockResolvedValueOnce(unknown());
    await expect(deleteAndVerifyHermesSession({ config, sessionId: "session-one", fetcher }))
      .resolves.toEqual({ state: "uncertain", databaseAbsentVerified: false });
  });

  it("rejects an oversized streamed response before claiming DB absence", async () => {
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_025));
        controller.close();
      },
    });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(oversized))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await expect(deleteAndVerifyHermesSession({
      config: { ...config, maxResponseBytes: 1_024 },
      sessionId: "session-one",
      fetcher,
    })).resolves.toEqual({ state: "uncertain", databaseAbsentVerified: false });
  });

  it("propagates caller cancellation into both bounded requests", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    await expect(deleteAndVerifyHermesSession({
      config,
      sessionId: "session-one",
      fetcher,
      signal: controller.signal,
    })).resolves.toEqual({ state: "uncertain", databaseAbsentVerified: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ ...config, origin: "https://example.com" }, "non-loopback"],
    [{ ...config, profile: "default" }, "default profile"],
    [{ ...config, origin: "http://127.0.0.1:8642/path" }, "path"],
  ])("rejects unsafe fixed deletion configuration: %s", async (unsafe) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(deleteAndVerifyHermesSession({
      config: unsafe,
      sessionId: "session-one",
      fetcher,
    })).rejects.toThrow("configuration");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
