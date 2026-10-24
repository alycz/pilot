import { chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createHermesRetentionSweeper,
  HermesRetentionJournal,
} from "./hermes-retention";

const NOW = 1_800_000_000_000;
const SCOPE = "c".repeat(64);
const deletion = {
  origin: "http://127.0.0.1:8642",
  profile: "pilot-proposal-v1",
  apiKey: "synthetic-hermes-api-key-not-secret",
};

let directory = "";
let journal: HermesRetentionJournal;

function absent(): Response {
  return Response.json(
    { error: { code: "session_not_found" } },
    { status: 404 },
  );
}

function deleted(sessionId: string): Response {
  return Response.json({
    object: "hermes.session.deleted",
    id: sessionId,
    deleted: true,
  });
}

async function register(sessionId: string, deleteAfter: number): Promise<void> {
  await journal.registerSession({
    scopeDigest: SCOPE,
    sessionId,
    expectedConsentEpoch: 1,
    creationDeadline: NOW + 45_000,
    deleteAfter,
    now: NOW,
  });
  await journal.settleSessionCreation({
    scopeDigest: SCOPE,
    sessionId,
    expectedConsentEpoch: 1,
    outcome: "created",
    now: NOW,
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  directory = await mkdtemp(join(await realpath(tmpdir()), "pilot-hermes-sweeper-"));
  journal = new HermesRetentionJournal(join(directory, "state.json"));
  await journal.acceptConsent(SCOPE, NOW);
});

afterEach(async () => {
  vi.useRealTimers();
  await chmod(directory, 0o700).catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
});

describe("Hermes retention sweeper", () => {
  it("is default-stopped and becomes ready only while explicitly started", async () => {
    const sweeper = createHermesRetentionSweeper({
      journal,
      deletion,
      intervalMs: 1_000,
      cycleTimeoutMs: 500,
      fetcher: vi.fn<typeof fetch>(),
    });
    expect(sweeper.status()).toMatchObject({
      phase: "stopped",
      started: false,
      ready: false,
      inFlight: false,
    });
    expect(vi.getTimerCount()).toBe(0);
    await sweeper.start();
    expect(sweeper.status()).toMatchObject({ phase: "ready", started: true, ready: true });
    expect(vi.getTimerCount()).toBe(1);
    await sweeper.stop();
    expect(sweeper.status()).toMatchObject({ phase: "stopped", started: false, ready: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("serializes consent acceptance against sweeper startup", async () => {
    const otherScope = "d".repeat(64);
    let enteredCriticalSection!: () => void;
    const criticalSectionEntered = new Promise<void>((resolve) => {
      enteredCriticalSection = resolve;
    });
    let releaseCriticalSection!: () => void;
    const criticalSectionRelease = new Promise<void>((resolve) => {
      releaseCriticalSection = resolve;
    });
    const accepting = new HermesRetentionJournal(journal.statePath, {
      syncParentDirectory: async () => {
        enteredCriticalSection();
        await criticalSectionRelease;
      },
    });
    let retryEntered!: () => void;
    const observedRetry = new Promise<void>((resolve) => { retryEntered = resolve; });
    let releaseRetry!: () => void;
    const retryRelease = new Promise<void>((resolve) => { releaseRetry = resolve; });
    const sweeping = new HermesRetentionJournal(journal.statePath, {
      lockRetryDelay: async () => {
        retryEntered();
        await retryRelease;
      },
    });
    const sweeper = createHermesRetentionSweeper({
      journal: sweeping,
      deletion,
      intervalMs: 1_000,
      cycleTimeoutMs: 500,
      fetcher: vi.fn<typeof fetch>(),
    });

    const acceptance = accepting.acceptConsent(otherScope, NOW + 1);
    await criticalSectionEntered;
    const startup = sweeper.start();
    await observedRetry;
    releaseCriticalSection();
    await expect(acceptance).resolves.toBe(1);
    releaseRetry();
    await expect(startup).resolves.toBeUndefined();
    expect(sweeper.status()).toMatchObject({ phase: "ready", ready: true });
    await expect(sweeping.consent(otherScope)).resolves.toEqual({
      epoch: 1,
      state: "accepted",
    });
    await sweeper.stop();
  });

  it("deletes at the registered deadline and never repeats a DB-absence tombstone", async () => {
    await register("session-deadline", NOW + 1_000);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(deleted("session-deadline"))
      .mockResolvedValueOnce(absent());
    const sweeper = createHermesRetentionSweeper({
      journal,
      deletion,
      intervalMs: 1_000,
      cycleTimeoutMs: 500,
      fetcher,
    });
    await sweeper.start();
    expect(fetcher).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await sweeper.runOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sweeper.status()).toMatchObject({
      ready: true,
      attempted: 1,
      databaseAbsent: 1,
      blocked: 0,
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await sweeper.stop();
  });

  it("protects live creation and periodically recovers it only at its durable deadline", async () => {
    await journal.registerSession({
      scopeDigest: SCOPE,
      sessionId: "session-crash-left",
      expectedConsentEpoch: 1,
      creationDeadline: NOW + 90_000,
      deleteAfter: NOW + 60_000,
      now: NOW,
    });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(deleted("session-crash-left"))
      .mockResolvedValueOnce(absent());
    const restarted = new HermesRetentionJournal(journal.statePath);
    let clock = NOW;
    const sweeper = createHermesRetentionSweeper({
      journal: restarted,
      deletion,
      intervalMs: 1_000,
      cycleTimeoutMs: 500,
      fetcher,
      now: () => clock,
    });

    await sweeper.start();
    expect(fetcher).not.toHaveBeenCalled();
    clock = NOW + 89_999;
    await sweeper.runOnce();
    expect(fetcher).not.toHaveBeenCalled();
    clock = NOW + 90_000;
    await sweeper.runOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sweeper.status()).toMatchObject({
      phase: "ready",
      attempted: 1,
      databaseAbsent: 1,
    });
    expect(await restarted.sessionsForDeletion(SCOPE, {
      now: NOW,
      includeNotDue: true,
    })).toEqual([]);
    await sweeper.stop();
  });

  it("recovers a crash-left stale lock before reporting startup ready", async () => {
    await journal.registerSession({
      scopeDigest: SCOPE,
      sessionId: "session-stale-lock",
      expectedConsentEpoch: 1,
      creationDeadline: NOW + 90_000,
      deleteAfter: NOW + 120_000,
      now: NOW,
    });
    const lockPath = join(directory, `.${basename(journal.statePath)}.lock`);
    await writeFile(lockPath, `${JSON.stringify({
      version: 1,
      pid: 424_242,
      ownerId: "55555555-5555-4555-8555-555555555555",
      createdAt: NOW - 120_000,
    })}\n`, { mode: 0o600 });
    const restarted = new HermesRetentionJournal(journal.statePath, {
      now: () => NOW + 90_000,
      processState: () => "dead",
    });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(deleted("session-stale-lock"))
      .mockResolvedValueOnce(absent());
    const sweeper = createHermesRetentionSweeper({
      journal: restarted,
      deletion,
      intervalMs: 1_000,
      cycleTimeoutMs: 500,
      fetcher,
      now: () => NOW + 90_000,
    });

    await sweeper.start();
    expect(sweeper.status()).toMatchObject({
      phase: "ready",
      ready: true,
      attempted: 1,
      databaseAbsent: 1,
    });
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await sweeper.stop();
  });

  it("serializes manual and scheduled cycles without overlapping deletion", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const sweeper = createHermesRetentionSweeper({
      journal,
      deletion,
      intervalMs: 1_000,
      cycleTimeoutMs: 5_000,
      fetcher,
    });
    await sweeper.start();
    await register("session-serialized", NOW);
    let release!: (response: Response) => void;
    let entered!: () => void;
    const requestEntered = new Promise<void>((resolve) => { entered = resolve; });
    fetcher
      .mockImplementationOnce(() => {
        entered();
        return new Promise<Response>((resolve) => { release = resolve; });
      })
      .mockResolvedValueOnce(absent());

    const first = sweeper.runOnce();
    const second = sweeper.runOnce();
    expect(second).toBe(first);
    await requestEntered;
    expect(fetcher).toHaveBeenCalledTimes(1);
    release(deleted("session-serialized"));
    await expect(first).resolves.toMatchObject({ attempted: 1, databaseAbsent: 1 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await sweeper.stop();
  });

  it("stops readiness when the bounded uncertain retry budget is exhausted", async () => {
    await register("session-uncertain", NOW);
    const fetcher = vi.fn<typeof fetch>(async () => new Response("unavailable", { status: 503 }));
    const sweeper = createHermesRetentionSweeper({
      journal,
      deletion,
      intervalMs: 1_000,
      cycleTimeoutMs: 500,
      fetcher,
    });
    await sweeper.start();
    for (let attempt = 1; attempt < 8; attempt += 1) {
      await sweeper.runOnce();
    }
    await sweeper.runOnce();
    expect(fetcher).toHaveBeenCalledTimes(16);
    expect(sweeper.status()).toMatchObject({
      phase: "blocked",
      started: false,
      ready: false,
      lastError: "retry-exhausted",
      attempted: 8,
      databaseAbsent: 0,
      blocked: 9,
    });
    expect(vi.getTimerCount()).toBe(0);
  }, 15_000);

  it("cancels an in-flight cycle and fail-closes readiness", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      }));
    const sweeper = createHermesRetentionSweeper({
      journal,
      deletion,
      intervalMs: 1_000,
      cycleTimeoutMs: 5_000,
      fetcher,
    });
    await sweeper.start();
    await register("session-cancelled", NOW);
    const abort = new AbortController();
    const cycle = sweeper.runOnce(abort.signal);
    await Promise.resolve();
    abort.abort();
    await expect(cycle).rejects.toThrow("sweep failed");
    expect(sweeper.status()).toMatchObject({
      phase: "blocked",
      ready: false,
      lastError: "cycle-failed",
    });
    await sweeper.stop();
  });

  it("does not become ready when private state validation fails", async () => {
    await chmod(directory, 0o755);
    const sweeper = createHermesRetentionSweeper({
      journal,
      deletion,
      intervalMs: 1_000,
      cycleTimeoutMs: 500,
      fetcher: vi.fn<typeof fetch>(),
    });
    await expect(sweeper.start()).rejects.toThrow("private state is unavailable");
    expect(sweeper.status()).toMatchObject({
      phase: "blocked",
      started: false,
      ready: false,
      lastError: "private-state-unavailable",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never reports ready while a live owner holds the durable journal lock", async () => {
    const lockPath = join(directory, `.${basename(journal.statePath)}.lock`);
    const record = `${JSON.stringify({
      version: 1,
      pid: process.pid,
      ownerId: "66666666-6666-4666-8666-666666666666",
      createdAt: NOW - 120_000,
    })}\n`;
    await writeFile(lockPath, record, { mode: 0o600 });
    const blockedJournal = new HermesRetentionJournal(journal.statePath, {
      lockRetryDelay: async () => undefined,
    });
    const sweeper = createHermesRetentionSweeper({
      journal: blockedJournal,
      deletion,
      intervalMs: 1_000,
      cycleTimeoutMs: 500,
      fetcher: vi.fn<typeof fetch>(),
    });

    await expect(sweeper.start()).rejects.toThrow("private state is unavailable");
    expect(sweeper.status()).toMatchObject({
      phase: "blocked",
      started: false,
      ready: false,
      lastError: "private-state-unavailable",
    });
    expect(await readFile(lockPath, "utf8")).toBe(record);
  });
});
