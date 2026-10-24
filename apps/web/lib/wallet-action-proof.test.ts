import { createHash } from "node:crypto";
import { chmod, link, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { Wallet } from "xrpl";

import {
  FileWalletActionProofConsumer,
  InMemoryWalletActionProofConsumer,
  issueWalletActionChallenge,
  MAX_CONSUMED_WALLET_ACTION_PROOFS,
  validateWalletActionProofDirectory,
  verifyAndConsumeWalletActionProof,
  walletActionRequestDigest,
} from "./wallet-action-proof";
import type { WalletSession } from "./wallet-session";

const SECRET = "wallet-action-proof-test-secret-with-at-least-thirty-two-characters";
const NOW = 1_000;
const BODY = JSON.stringify({ messages: [{ role: "user", content: "swap 1 XRP" }] });

function nonceHash(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex").toUpperCase();
}

function markerName(hash: string): string {
  return `wallet-action-proof-v1-${hash}.json`;
}

async function proofStore(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const store = entries.find((entry) =>
    entry.isDirectory() && entry.name === "wallet-action-proofs-v1");
  expect(store).toBeDefined();
  return path.join(directory, store!.name);
}

async function addStoredMarkers(
  store: string,
  markers: Array<{ hash: string; expiresAt: number }>,
): Promise<void> {
  const used = new Set((await readdir(store)).filter((name) =>
    name.startsWith("wallet-action-proof-slot-v1-")));
  const additions: Array<{ markerPath: string; slotPath: string; value: string }> = [];
  let slot = 0;
  for (const marker of markers) {
    while (used.has(`wallet-action-proof-slot-v1-${slot.toString().padStart(4, "0")}`)) slot += 1;
    const slotName = `wallet-action-proof-slot-v1-${slot.toString().padStart(4, "0")}`;
    used.add(slotName);
    additions.push({
      markerPath: path.join(store, markerName(marker.hash)),
      slotPath: path.join(store, slotName),
      value: JSON.stringify({
        version: 1,
        nonce_hash: marker.hash,
        expires_at: marker.expiresAt,
      }),
    });
    slot += 1;
  }
  for (let start = 0; start < additions.length; start += 128) {
    await Promise.all(additions.slice(start, start + 128).map(async (addition) => {
      await writeFile(addition.slotPath, addition.value, { mode: 0o600 });
      await link(addition.slotPath, addition.markerPath);
    }));
  }
}

function session(wallet: Wallet, overrides: Partial<WalletSession> = {}): WalletSession {
  return {
    version: 1,
    account: wallet.classicAddress,
    network: "testnet",
    expiresAt: NOW + 10 * 60_000,
    ...overrides,
  };
}

function proof(
  wallet: Wallet,
  walletSession = session(wallet),
  body = BODY,
  nonce = "A".repeat(43),
) {
  const challenge = issueWalletActionChallenge(
    walletSession,
    "chat",
    walletActionRequestDigest(body),
    { now: NOW, nonce, secret: SECRET },
  );
  return {
    challenge,
    txBlob: wallet.sign(challenge.txJson as never).tx_blob,
  };
}

describe("fresh wallet action proof", () => {
  it("accepts one valid proof for the exact account, network, action, and request", async () => {
    const wallet = Wallet.generate();
    const walletSession = session(wallet);
    const issued = proof(wallet, walletSession);
    const consumer = new InMemoryWalletActionProofConsumer();

    await expect(verifyAndConsumeWalletActionProof(
      walletSession,
      issued.challenge.token,
      issued.txBlob,
      "chat",
      BODY,
      { consumer, now: NOW + 1, secret: SECRET },
    )).resolves.toBeUndefined();
  });

  it("consumes the nonce and rejects replay", async () => {
    const wallet = Wallet.generate();
    const walletSession = session(wallet);
    const issued = proof(wallet, walletSession, BODY, "B".repeat(43));
    const consumer = new InMemoryWalletActionProofConsumer();
    const verify = () => verifyAndConsumeWalletActionProof(
      walletSession,
      issued.challenge.token,
      issued.txBlob,
      "chat",
      BODY,
      { consumer, now: NOW + 1, secret: SECRET },
    );

    await expect(verify()).resolves.toBeUndefined();
    await expect(verify()).rejects.toThrow("already used");
  });

  it("fails closed at capacity without evicting any live replay nonce", () => {
    const consumer = new InMemoryWalletActionProofConsumer();
    const expiresAt = NOW + 60_000;
    for (let index = 0; index < MAX_CONSUMED_WALLET_ACTION_PROOFS; index += 1) {
      expect(consumer.consume(`nonce-${index}`, expiresAt, NOW)).toBe(true);
    }
    expect(() => consumer.consume("overflow", expiresAt, NOW)).toThrow("unavailable");
    expect(consumer.consume("nonce-0", expiresAt, NOW)).toBe(false);
  });

  it("rejects a proof under a different account or network session", async () => {
    const wallet = Wallet.generate();
    const other = Wallet.generate();
    const walletSession = session(wallet);
    const issued = proof(wallet, walletSession, BODY, "C".repeat(43));

    for (const mismatch of [
      session(other),
      session(wallet, { network: "devnet" }),
    ]) {
      await expect(verifyAndConsumeWalletActionProof(
        mismatch,
        issued.challenge.token,
        issued.txBlob,
        "chat",
        BODY,
        { consumer: new InMemoryWalletActionProofConsumer(), now: NOW + 1, secret: SECRET },
      )).rejects.toThrow("fresh wallet action proof");
    }
  });

  it("keeps legacy and isolated action proofs mutually unreadable with a reused secret", async () => {
    const wallet = Wallet.generate();
    const legacySession = session(wallet);
    const isolatedSession = session(wallet, {
      deployment_profile: "local-wallet-isolated-v1",
    });
    const legacy = proof(wallet, legacySession, BODY, "P".repeat(43));
    const isolated = proof(wallet, isolatedSession, BODY, "Q".repeat(43));

    await expect(verifyAndConsumeWalletActionProof(
      isolatedSession,
      legacy.challenge.token,
      legacy.txBlob,
      "chat",
      BODY,
      { consumer: new InMemoryWalletActionProofConsumer(), now: NOW + 1, secret: SECRET },
    )).rejects.toThrow("fresh wallet action proof");
    await expect(verifyAndConsumeWalletActionProof(
      legacySession,
      isolated.challenge.token,
      isolated.txBlob,
      "chat",
      BODY,
      { consumer: new InMemoryWalletActionProofConsumer(), now: NOW + 1, secret: SECRET },
    )).rejects.toThrow("fresh wallet action proof");
    await expect(verifyAndConsumeWalletActionProof(
      isolatedSession,
      isolated.challenge.token,
      isolated.txBlob,
      "chat",
      BODY,
      { consumer: new InMemoryWalletActionProofConsumer(), now: NOW + 1, secret: SECRET },
    )).resolves.toBeUndefined();
  });

  it("rejects missing and malformed action-proof deployment tags", () => {
    const wallet = Wallet.generate();
    expect(() => issueWalletActionChallenge(
      session(wallet, { deployment_profile: "wrong-profile" as never }),
      "chat",
      walletActionRequestDigest(BODY),
      { now: NOW, nonce: "T".repeat(43), secret: SECRET },
    )).toThrow("deployment profile is invalid");
  });

  it("rejects a different exact request body or a mutated signed transaction", async () => {
    const wallet = Wallet.generate();
    const walletSession = session(wallet);
    const issued = proof(wallet, walletSession, BODY, "D".repeat(43));
    await expect(verifyAndConsumeWalletActionProof(
      walletSession,
      issued.challenge.token,
      issued.txBlob,
      "chat",
      `${BODY} `,
      { consumer: new InMemoryWalletActionProofConsumer(), now: NOW + 1, secret: SECRET },
    )).rejects.toThrow("fresh wallet action proof");

    const mutated = { ...issued.challenge.txJson, Fee: "12" };
    await expect(verifyAndConsumeWalletActionProof(
      walletSession,
      issued.challenge.token,
      wallet.sign(mutated as never).tx_blob,
      "chat",
      BODY,
      { consumer: new InMemoryWalletActionProofConsumer(), now: NOW + 1, secret: SECRET },
    )).rejects.toThrow("does not match");
  });

  it("rejects an expired challenge and a missing proof", async () => {
    const wallet = Wallet.generate();
    const walletSession = session(wallet);
    const issued = proof(wallet, walletSession, BODY, "E".repeat(43));

    await expect(verifyAndConsumeWalletActionProof(
      walletSession,
      issued.challenge.token,
      issued.txBlob,
      "chat",
      BODY,
      {
        consumer: new InMemoryWalletActionProofConsumer(),
        now: issued.challenge.expiresAt,
        secret: SECRET,
      },
    )).rejects.toThrow("fresh wallet action proof");
    await expect(verifyAndConsumeWalletActionProof(
      walletSession,
      issued.challenge.token,
      null,
      "chat",
      BODY,
      { consumer: new InMemoryWalletActionProofConsumer(), now: NOW + 1, secret: SECRET },
    )).rejects.toThrow("fresh wallet action proof");
  });

  it("allows only one forced concurrent same-nonce consumer across process-style restarts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-wallet-proof-"));
    await chmod(directory, 0o700);
    try {
      const firstProcess = new FileWalletActionProofConsumer(directory);
      const secondProcess = new FileWalletActionProofConsumer(directory);
      const results = await Promise.all([
        firstProcess.consume("durable-nonce", NOW + 60_000, NOW),
        secondProcess.consume("durable-nonce", NOW + 60_000, NOW),
      ]);
      expect(results.sort()).toEqual([false, true]);
      expect(await new FileWalletActionProofConsumer(directory).consume(
        "durable-nonce",
        NOW + 60_000,
        NOW,
      )).toBe(false);

      const store = await proofStore(directory);
      const [persistedMarker] = (await readdir(store)).filter((name) =>
        name.startsWith("wallet-action-proof-v1-"));
      const [persistedSlot] = (await readdir(store)).filter((name) =>
        name.startsWith("wallet-action-proof-slot-v1-"));
      expect(persistedMarker).toBeDefined();
      expect(persistedSlot).toBeDefined();
      expect((await stat(path.join(store, persistedMarker!))).mode & 0o777).toBe(0o600);
      expect((await readdir(store)).filter((name) =>
        name.startsWith("wallet-action-proof-slot-v1-"))).toHaveLength(1);
      expect((await stat(path.join(store, persistedMarker!))).ino).toBe(
        (await stat(path.join(store, persistedSlot!))).ino,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an unsafe or symlinked durable proof directory", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-wallet-proof-unsafe-"));
    const link = `${directory}-link`;
    try {
      await chmod(directory, 0o755);
      await expect(new FileWalletActionProofConsumer(directory).consume(
        "unsafe-mode",
        NOW + 60_000,
        NOW,
      )).rejects.toThrow("mode 0700");

      await chmod(directory, 0o700);
      await symlink(directory, link, "dir");
      await expect(new FileWalletActionProofConsumer(link).consume(
        "unsafe-link",
        NOW + 60_000,
        NOW,
      )).rejects.toThrow("symbolic link");
    } finally {
      await rm(link, { force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("shares exact read-only proof-directory validation across readiness and consumption", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-wallet-proof-validation-"));
    const file = path.join(directory, "regular-file");
    const link = `${directory}-link`;
    try {
      await chmod(directory, 0o700);
      await expect(validateWalletActionProofDirectory(
        path.join(directory, "missing"),
      )).rejects.toThrow();

      await writeFile(file, "not a directory\n", { mode: 0o600 });
      await expect(validateWalletActionProofDirectory(file)).rejects.toThrow("not a directory");

      await symlink(directory, link, "dir");
      await expect(validateWalletActionProofDirectory(link)).rejects.toThrow("symbolic link");

      await chmod(directory, 0o750);
      await expect(validateWalletActionProofDirectory(directory)).rejects.toThrow("mode 0700");

      const currentUid = typeof process.getuid === "function" ? process.getuid() : 1_000;
      await expect(validateWalletActionProofDirectory("/private/proof-state", {
        lstat: async () => ({ isSymbolicLink: () => false }),
        stat: async () => ({
          isDirectory: () => true,
          mode: 0o700,
          uid: currentUid + 1,
        }),
        currentUid: () => currentUid,
      })).rejects.toThrow("owned by the current user");
    } finally {
      await rm(link, { force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("prunes only expired owned proof markers and preserves unrelated state", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-wallet-proof-prune-"));
    await chmod(directory, 0o700);
    try {
      const unrelated = path.join(directory, "acquisition-state.json");
      await writeFile(unrelated, "unrelated\n", { mode: 0o600 });
      const consumer = new FileWalletActionProofConsumer(directory);
      expect(await consumer.consume("expired-proof", NOW + 1, NOW)).toBe(true);
      expect(await consumer.consume("current-proof", NOW + 60_000, NOW + 2)).toBe(true);
      expect(await readdir(directory)).toContain("acquisition-state.json");
      const entries = await readdir(await proofStore(directory));
      expect(entries.filter((name) => name.startsWith("wallet-action-proof-v1-"))).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("sweeps more than 256 mixed markers without starvation and preserves unrelated files", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-wallet-proof-sweep-"));
    await chmod(directory, 0o700);
    try {
      const consumer = new FileWalletActionProofConsumer(directory);
      expect(await consumer.consume("initial-live", NOW + 60_000, NOW)).toBe(true);
      const store = await proofStore(directory);
      const unrelatedParent = path.join(directory, "acquisition-state.json");
      const unrelatedStore = path.join(store, "unrelated-state.json");
      await writeFile(unrelatedParent, "parent\n", { mode: 0o600 });
      await writeFile(unrelatedStore, "store\n", { mode: 0o600 });

      const mixedMarkers = [];
      for (let index = 0; index < 300; index += 1) {
        const liveHash = index.toString(16).toUpperCase().padStart(64, "0");
        const expiredHash = `F${index.toString(16).toUpperCase().padStart(63, "0")}`;
        mixedMarkers.push(
          { hash: liveHash, expiresAt: NOW + 60_000 },
          { hash: expiredHash, expiresAt: NOW + 1 },
        );
      }
      await addStoredMarkers(store, mixedMarkers);

      expect(await new FileWalletActionProofConsumer(directory).consume(
        "post-sweep",
        NOW + 60_000,
        NOW + 2,
      )).toBe(true);
      const entries = await readdir(store);
      expect(entries.filter((name) => name.startsWith("wallet-action-proof-v1-F"))).toHaveLength(0);
      expect(entries.filter((name) => name.startsWith("wallet-action-proof-v1-0"))).toHaveLength(300);
      expect(entries).toContain("unrelated-state.json");
      expect(await readdir(directory)).toContain("acquisition-state.json");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes concurrent consumers at the durable marker cap", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-wallet-proof-cap-"));
    await chmod(directory, 0o700);
    try {
      const consumer = new FileWalletActionProofConsumer(directory);
      expect(await consumer.consume("cap-initial", NOW + 60_000, NOW)).toBe(true);
      const store = await proofStore(directory);
      const syntheticMarkers = Array.from(
        { length: MAX_CONSUMED_WALLET_ACTION_PROOFS - 2 },
        (_, index) => ({
          hash: (index + 1).toString(16).toUpperCase().padStart(64, "0"),
          expiresAt: NOW + 60_000,
        }),
      );
      await addStoredMarkers(store, syntheticMarkers);

      const results = await Promise.allSettled([
        new FileWalletActionProofConsumer(directory).consume(
          "cap-contender-a",
          NOW + 60_000,
          NOW + 1,
        ),
        new FileWalletActionProofConsumer(directory).consume(
          "cap-contender-b",
          NOW + 60_000,
          NOW + 1,
        ),
      ]);
      expect(results.filter((result) =>
        result.status === "fulfilled" && result.value === true)).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected).toBeDefined();
      expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(Error);
      expect((rejected as PromiseRejectedResult).reason.message).toContain("unavailable");
      expect((await readdir(store)).filter((name) =>
        name.startsWith("wallet-action-proof-v1-"))).toHaveLength(
        MAX_CONSUMED_WALLET_ACTION_PROOFS,
      );
      expect((await readdir(store)).filter((name) =>
        name.startsWith("wallet-action-proof-slot-v1-"))).toHaveLength(
        MAX_CONSUMED_WALLET_ACTION_PROOFS,
      );
      await expect(new FileWalletActionProofConsumer(directory).consume(
        "cap-overflow",
        NOW + 60_000,
        NOW + 2,
      )).rejects.toThrow("unavailable");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("contains crash residue to one slot and remains available after restart", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-wallet-proof-cap-crash-"));
    await chmod(directory, 0o700);
    try {
      const consumer = new FileWalletActionProofConsumer(directory);
      expect(await consumer.consume("crash-residue-initial", NOW + 60_000, NOW)).toBe(true);
      const store = await proofStore(directory);
      const used = new Set(await readdir(store));
      let slot = 0;
      while (used.has(`wallet-action-proof-slot-v1-${slot.toString().padStart(4, "0")}`)) {
        slot += 1;
      }
      const residue = path.join(
        store,
        `wallet-action-proof-slot-v1-${slot.toString().padStart(4, "0")}`,
      );
      await writeFile(residue, "partial", { mode: 0o600 });

      expect(await new FileWalletActionProofConsumer(directory).consume(
        "accepted-after-crash",
        NOW + 60_000,
        NOW + 1,
      )).toBe(true);
      expect(await stat(residue)).toBeDefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps truncated markers consumed across restarts while continuing other cleanup", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-wallet-proof-truncated-"));
    await chmod(directory, 0o700);
    try {
      const consumer = new FileWalletActionProofConsumer(directory);
      expect(await consumer.consume("initialize-store", NOW + 60_000, NOW)).toBe(true);
      const store = await proofStore(directory);
      const blockedNonce = "truncated-marker-nonce";
      const blockedHash = nonceHash(blockedNonce);
      const blockedPath = path.join(store, markerName(blockedHash));
      const expiredHash = "E".repeat(64);
      const expiredPath = path.join(store, markerName(expiredHash));
      await writeFile(blockedPath, '{"version":1,"nonce_hash":', { mode: 0o600 });
      await writeFile(expiredPath, JSON.stringify({
        version: 1,
        nonce_hash: expiredHash,
        expires_at: NOW + 1,
      }), { mode: 0o600 });

      expect(await new FileWalletActionProofConsumer(directory).consume(
        "cleanup-trigger",
        NOW + 60_000,
        NOW + 2,
      )).toBe(true);
      expect(await stat(blockedPath)).toBeDefined();
      await expect(stat(expiredPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await new FileWalletActionProofConsumer(directory).consume(
        blockedNonce,
        NOW + 60_000,
        NOW + 3,
      )).toBe(false);
      expect(await stat(blockedPath)).toBeDefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on clock rollback after expiry pruning", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-wallet-proof-clock-"));
    await chmod(directory, 0o700);
    try {
      expect(await new FileWalletActionProofConsumer(directory).consume(
        "rollback-target",
        NOW + 10,
        NOW,
      )).toBe(true);
      expect(await new FileWalletActionProofConsumer(directory).consume(
        "later-proof",
        NOW + 1_000,
        NOW + 10,
      )).toBe(true);
      const store = await proofStore(directory);
      await expect(stat(path.join(store, markerName(nonceHash("rollback-target")))))
        .rejects.toMatchObject({ code: "ENOENT" });

      await expect(new FileWalletActionProofConsumer(directory).consume(
        "rollback-target",
        NOW + 10,
        NOW + 1,
      )).rejects.toThrow("unavailable");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a pre-expiry verifier resumed after a post-expiry prune", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-wallet-proof-interleave-"));
    await chmod(directory, 0o700);
    try {
      const wallet = Wallet.generate();
      const walletSession = session(wallet, { expiresAt: NOW + 10 });
      const issued = proof(wallet, walletSession, BODY, "R".repeat(43));
      const durableConsumer = new FileWalletActionProofConsumer(directory);
      expect(await durableConsumer.consume("R".repeat(43), NOW + 10, NOW + 1)).toBe(true);

      let release!: () => void;
      let entered!: () => void;
      const enteredConsume = new Promise<void>((resolve) => { entered = resolve; });
      const resumeConsume = new Promise<void>((resolve) => { release = resolve; });
      const delayedConsumer = {
        consume: async (nonce: string, expiresAt: number, now: number) => {
          entered();
          await resumeConsume;
          return new FileWalletActionProofConsumer(directory).consume(nonce, expiresAt, now);
        },
      };
      const verification = verifyAndConsumeWalletActionProof(
        walletSession,
        issued.challenge.token,
        issued.txBlob,
        "chat",
        BODY,
        { consumer: delayedConsumer, now: NOW + 5, currentTime: () => NOW + 11, secret: SECRET },
      );
      await enteredConsume;
      expect(await new FileWalletActionProofConsumer(directory).consume(
        "post-expiry-sweep",
        NOW + 1_000,
        NOW + 10,
      )).toBe(true);
      release();
      await expect(verification).rejects.toThrow("unavailable");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rechecks expiry after atomic consumption and retains the consumed marker", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-wallet-proof-expiry-race-"));
    await chmod(directory, 0o700);
    try {
      const wallet = Wallet.generate();
      const walletSession = session(wallet, { expiresAt: NOW + 10 });
      const nonce = "S".repeat(43);
      const issued = proof(wallet, walletSession, BODY, nonce);
      await expect(verifyAndConsumeWalletActionProof(
        walletSession,
        issued.challenge.token,
        issued.txBlob,
        "chat",
        BODY,
        {
          consumer: new FileWalletActionProofConsumer(directory),
          now: NOW + 9,
          currentTime: () => NOW + 10,
          secret: SECRET,
        },
      )).rejects.toThrow("fresh wallet action proof");
      expect(await new FileWalletActionProofConsumer(directory).consume(
        nonce,
        NOW + 10,
        NOW + 9,
      )).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
