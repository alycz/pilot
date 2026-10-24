import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open as openFile,
  readdir,
  readFile,
  stat,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  decode,
  deriveAddress,
  encodeForSigning,
  isValidClassicAddress,
  verifyKeypairSignature,
} from "xrpl";
import { PILOT_ISOLATED_DEPLOYMENT_PROFILE } from "@pilot/wallet/isolation-profile";

import {
  readWalletSession,
  type WalletSession,
  type WalletSessionNetwork,
} from "./wallet-session";

export const WALLET_ACTION_CHALLENGE_HEADER = "x-pilot-wallet-action-challenge";
export const WALLET_ACTION_PROOF_HEADER = "x-pilot-wallet-action-proof";
export const WALLET_ACTION_CHALLENGE_TTL_MS = 60_000;

type WalletAction = "chat";

type WalletActionChallenge = {
  version: 1;
  account: string;
  network: WalletSessionNetwork;
  action: WalletAction;
  requestDigest: string;
  nonce: string;
  expiresAt: number;
  deployment_profile?: typeof PILOT_ISOLATED_DEPLOYMENT_PROFILE;
};

const VERSION = 1;
const ACTION_AAD = Buffer.from("pilot.wallet.action-challenge.v1", "utf8");
const ISOLATED_ACTION_AAD = Buffer.from(
  `pilot.wallet.action-challenge.v2\0${PILOT_ISOLATED_DEPLOYMENT_PROFILE}`,
  "utf8",
);
const ACTION_MEMO_TYPE = Buffer.from("pilot-wallet-action-v1", "utf8")
  .toString("hex")
  .toUpperCase();
const DIGEST_PATTERN = /^[A-F0-9]{64}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_PROOF_BYTES = 16_384;
export const MAX_CONSUMED_WALLET_ACTION_PROOFS = 4_096;
const PROOF_STORE_DIRECTORY = "wallet-action-proofs-v1";
const PROOF_MARKER_PREFIX = "wallet-action-proof-v1-";
const PROOF_TIME_PREFIX = "wallet-action-proof-time-v1-";
const PROOF_SLOT_PREFIX = "wallet-action-proof-slot-v1-";
const PROOF_MARKER_PATTERN = /^wallet-action-proof-v1-([A-F0-9]{64})\.json$/;
const PROOF_TIME_PATTERN = /^wallet-action-proof-time-v1-([0-9]{1,16})$/;
const PROOF_SLOT_PATTERN = /^wallet-action-proof-slot-v1-([0-9]{4})$/;

class WalletActionProofStoreUnavailableError extends Error {
  constructor() {
    super("Wallet action proof replay protection is unavailable.");
  }
}

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error("Wallet action authorization is not configured.");
  }
  return secret;
}

function encryptionKey(secret: string): Buffer {
  if (secret.length < 32) throw new Error("Wallet action authorization is not configured.");
  return createHash("sha256").update(secret, "utf8").digest();
}

function challengeDeploymentProfile(
  value: Pick<WalletSession, "deployment_profile">,
): typeof PILOT_ISOLATED_DEPLOYMENT_PROFILE | undefined {
  if (value.deployment_profile === undefined) return undefined;
  if (value.deployment_profile === PILOT_ISOLATED_DEPLOYMENT_PROFILE) {
    return PILOT_ISOLATED_DEPLOYMENT_PROFILE;
  }
  throw new Error("The wallet action challenge deployment profile is invalid.");
}

function actionAad(
  deploymentProfile: typeof PILOT_ISOLATED_DEPLOYMENT_PROFILE | undefined,
): Buffer {
  return deploymentProfile === PILOT_ISOLATED_DEPLOYMENT_PROFILE
    ? ISOLATED_ACTION_AAD
    : ACTION_AAD;
}

function seal(challenge: WalletActionChallenge, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  cipher.setAAD(actionAad(challengeDeploymentProfile(challenge)));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(challenge), "utf8"),
    cipher.final(),
  ]);
  return [
    `v${VERSION}`,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function open(
  token: string,
  secret: string,
  deploymentProfile: typeof PILOT_ISOLATED_DEPLOYMENT_PROFILE | undefined,
): unknown {
  try {
    const [version, encodedIv, encodedTag, encodedCiphertext, extra] = token.split(".");
    if (version !== `v${VERSION}` || extra !== undefined) return undefined;
    const iv = Buffer.from(encodedIv, "base64url");
    const tag = Buffer.from(encodedTag, "base64url");
    const ciphertext = Buffer.from(encodedCiphertext, "base64url");
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), iv);
    decipher.setAAD(actionAad(deploymentProfile));
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function isChallenge(value: unknown): value is WalletActionChallenge {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const challenge = value as Record<string, unknown>;
  const deploymentProfile = challenge.deployment_profile;
  const expectedKeys = deploymentProfile === PILOT_ISOLATED_DEPLOYMENT_PROFILE
    ? "account\0action\0deployment_profile\0expiresAt\0network\0nonce\0requestDigest\0version"
    : "account\0action\0expiresAt\0network\0nonce\0requestDigest\0version";
  return Object.keys(challenge).sort().join("\0") === expectedKeys &&
    challenge.version === VERSION &&
    typeof challenge.account === "string" &&
    isValidClassicAddress(challenge.account) &&
    (challenge.network === "testnet" || challenge.network === "devnet") &&
    challenge.action === "chat" &&
    typeof challenge.requestDigest === "string" &&
    DIGEST_PATTERN.test(challenge.requestDigest) &&
    typeof challenge.nonce === "string" &&
    NONCE_PATTERN.test(challenge.nonce) &&
    typeof challenge.expiresAt === "number" &&
    Number.isSafeInteger(challenge.expiresAt);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function memoData(challenge: WalletActionChallenge): string {
  return Buffer.from(canonicalJson({
    action: challenge.action,
    ...(challenge.deployment_profile ? {
      deployment_profile: challenge.deployment_profile,
    } : {}),
    network: challenge.network,
    nonce: challenge.nonce,
    requestDigest: challenge.requestDigest,
  }), "utf8").toString("hex").toUpperCase();
}

export function walletActionChallengeTransaction(
  challenge: WalletActionChallenge,
): Record<string, unknown> {
  return {
    TransactionType: "AccountSet",
    Account: challenge.account,
    Sequence: 0,
    Fee: "0",
    LastLedgerSequence: 0,
    Memos: [{ Memo: { MemoType: ACTION_MEMO_TYPE, MemoData: memoData(challenge) } }],
  };
}

export function walletActionRequestDigest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex").toUpperCase();
}

export function issueWalletActionChallenge(
  session: WalletSession,
  action: WalletAction,
  requestDigest: string,
  options: { now?: number; nonce?: string; secret?: string } = {},
): { token: string; expiresAt: number; txJson: Record<string, unknown> } {
  const now = options.now ?? Date.now();
  const deploymentProfile = challengeDeploymentProfile(session);
  const normalizedDigest = requestDigest.toUpperCase();
  if (
    !isValidClassicAddress(session.account) ||
    (session.network !== "testnet" && session.network !== "devnet") ||
    session.expiresAt <= now ||
    action !== "chat" ||
    !DIGEST_PATTERN.test(normalizedDigest)
  ) {
    throw new Error("The wallet action challenge is invalid.");
  }
  const challenge: WalletActionChallenge = {
    version: VERSION,
    account: session.account,
    network: session.network,
    action,
    requestDigest: normalizedDigest,
    nonce: options.nonce ?? randomBytes(32).toString("base64url"),
    expiresAt: Math.min(session.expiresAt, now + WALLET_ACTION_CHALLENGE_TTL_MS),
    ...(deploymentProfile ? { deployment_profile: deploymentProfile } : {}),
  };
  if (!NONCE_PATTERN.test(challenge.nonce)) {
    throw new Error("The wallet action challenge is invalid.");
  }
  return {
    token: seal(challenge, options.secret ?? sessionSecret()),
    expiresAt: challenge.expiresAt,
    txJson: walletActionChallengeTransaction(challenge),
  };
}

export interface WalletActionProofConsumer {
  consume(nonce: string, expiresAt: number, now: number): boolean | Promise<boolean>;
}

export class InMemoryWalletActionProofConsumer implements WalletActionProofConsumer {
  private readonly consumed = new Map<string, number>();

  consume(nonce: string, expiresAt: number, now: number): boolean {
    for (const [candidate, candidateExpiry] of this.consumed) {
      if (candidateExpiry <= now) this.consumed.delete(candidate);
    }
    if (this.consumed.has(nonce)) return false;
    // Never evict a live nonce: that would make its otherwise-valid proof
    // replayable. Saturation fails closed until prior entries expire.
    if (this.consumed.size >= MAX_CONSUMED_WALLET_ACTION_PROOFS) {
      throw new WalletActionProofStoreUnavailableError();
    }
    this.consumed.set(nonce, expiresAt);
    return true;
  }
}

function isFileError(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" &&
    "code" in error && (error as { code?: unknown }).code === code;
}

type ProofMarker = {
  version: 1;
  nonce_hash: string;
  expires_at: number;
};

type WalletActionProofDirectoryValidationDependencies = Readonly<{
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>;
  stat(path: string): Promise<{ isDirectory(): boolean; mode: number; uid: number }>;
  currentUid(): number | undefined;
}>;

const walletActionProofDirectoryValidationDependencies: WalletActionProofDirectoryValidationDependencies = {
  lstat,
  stat,
  currentUid: () => typeof process.getuid === "function" ? process.getuid() : undefined,
};

export async function validateWalletActionProofDirectory(
  directory: string | undefined,
  dependencies: WalletActionProofDirectoryValidationDependencies =
    walletActionProofDirectoryValidationDependencies,
): Promise<string> {
  if (!directory || !isAbsolute(directory)) {
    throw new Error("A private absolute wallet action proof directory is required.");
  }
  const linkInfo = await dependencies.lstat(directory);
  if (linkInfo.isSymbolicLink()) {
    throw new Error("The wallet action proof directory must not be a symbolic link.");
  }
  const info = await dependencies.stat(directory);
  if (!info.isDirectory()) throw new Error("The wallet action proof path is not a directory.");
  const currentUid = dependencies.currentUid();
  if (currentUid !== undefined && info.uid !== currentUid) {
    throw new Error("The wallet action proof directory must be owned by the current user.");
  }
  if ((info.mode & 0o777) !== 0o700) {
    throw new Error("The wallet action proof directory must have mode 0700.");
  }
  return directory;
}

/**
 * Cross-process replay protection rooted in Pilot's already-required private
 * local state directory. Fixed O_EXCL slot names bound capacity; hard-linking
 * a durable slot to the nonce name is the consume operation, so only one
 * process can publish that replay marker. Directory fsync makes acceptance
 * durable before model or tool execution begins.
 */
export class FileWalletActionProofConsumer implements WalletActionProofConsumer {
  constructor(
    private readonly directory: string | undefined,
    private readonly storeDirectory = PROOF_STORE_DIRECTORY,
  ) {}

  private async resolvedDirectories(): Promise<{ parent: string; store: string }> {
    const parent = await validateWalletActionProofDirectory(this.directory);
    if (!/^[a-z0-9-]{1,64}$/.test(this.storeDirectory)) {
      throw new Error("The wallet action proof store namespace is invalid.");
    }
    const store = join(parent, this.storeDirectory);
    let created = false;
    try {
      await mkdir(store, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!isFileError(error, "EEXIST")) throw error;
    }
    await validateWalletActionProofDirectory(store);
    if (created) await this.syncDirectory(parent);
    return { parent, store };
  }

  private markerName(nonceHash: string): string {
    return `${PROOF_MARKER_PREFIX}${nonceHash}.json`;
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await openFile(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private slotName(index: number): string {
    return `${PROOF_SLOT_PREFIX}${index.toString().padStart(4, "0")}`;
  }

  private isSlotName(name: string): boolean {
    const match = name.match(PROOF_SLOT_PATTERN);
    return !!match && Number(match[1]) < MAX_CONSUMED_WALLET_ACTION_PROOFS;
  }

  private inodeKey(info: { dev: number | bigint; ino: number | bigint }): string {
    return `${info.dev}:${info.ino}`;
  }

  private async unlinkOwnedPath(
    path: string,
    expected: { dev: number | bigint; ino: number | bigint },
  ): Promise<boolean> {
    try {
      const current = await lstat(path);
      if (current.dev !== expected.dev || current.ino !== expected.ino) return false;
      await unlink(path);
      return true;
    } catch (error) {
      if (isFileError(error, "ENOENT")) return false;
      throw error;
    }
  }

  /** Give pre-slot nonce markers bounded capacity before admitting new work. */
  private async migrateLegacyMarkers(directory: string): Promise<void> {
    const entries = (await readdir(directory)).sort();
    const slottedInodes = new Set<string>();
    for (const name of entries) {
      if (!this.isSlotName(name)) continue;
      try {
        slottedInodes.add(this.inodeKey(await lstat(join(directory, name))));
      } catch (error) {
        if (!isFileError(error, "ENOENT")) throw error;
      }
    }

    let added = false;
    for (const name of entries) {
      if (!PROOF_MARKER_PATTERN.test(name)) continue;
      const markerPath = join(directory, name);
      let markerInfo;
      try {
        markerInfo = await lstat(markerPath);
      } catch (error) {
        if (isFileError(error, "ENOENT")) continue;
        throw error;
      }
      const key = this.inodeKey(markerInfo);
      if (slottedInodes.has(key)) continue;

      let linked = false;
      const start = Number.parseInt(
        createHash("sha256").update(name, "utf8").digest("hex").slice(0, 8),
        16,
      ) % MAX_CONSUMED_WALLET_ACTION_PROOFS;
      for (let offset = 0; offset < MAX_CONSUMED_WALLET_ACTION_PROOFS; offset += 1) {
        const index = (start + offset) % MAX_CONSUMED_WALLET_ACTION_PROOFS;
        try {
          await link(markerPath, join(directory, this.slotName(index)));
          slottedInodes.add(key);
          added = true;
          linked = true;
          break;
        } catch (error) {
          if (isFileError(error, "EEXIST")) continue;
          if (isFileError(error, "ENOENT")) {
            linked = true;
            break;
          }
          throw error;
        }
      }
      if (!linked) throw new WalletActionProofStoreUnavailableError();
    }
    if (added) await this.syncDirectory(directory);
  }

  private async reserveSlot(
    directory: string,
    marker: ProofMarker,
    nonceHash: string,
  ): Promise<{ handle: FileHandle; path: string }> {
    const start = Number.parseInt(nonceHash.slice(0, 8), 16) %
      MAX_CONSUMED_WALLET_ACTION_PROOFS;
    for (let offset = 0; offset < MAX_CONSUMED_WALLET_ACTION_PROOFS; offset += 1) {
      const slotPath = join(
        directory,
        this.slotName((start + offset) % MAX_CONSUMED_WALLET_ACTION_PROOFS),
      );
      let handle: FileHandle;
      try {
        handle = await openFile(
          slotPath,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
          0o600,
        );
      } catch (error) {
        if (isFileError(error, "EEXIST")) continue;
        throw error;
      }

      let publicationError: unknown;
      try {
        const info = await handle.stat();
        if (!info.isFile() || (info.mode & 0o077) !== 0 ||
          (typeof process.getuid === "function" && info.uid !== process.getuid())) {
          throw new Error("The wallet action proof slot is not a private owned file.");
        }
        await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
      } catch (error) {
        publicationError = error;
      }
      try {
        await handle.sync();
      } catch (error) {
        publicationError ??= error;
      }
      try {
        await this.syncDirectory(directory);
      } catch (error) {
        publicationError ??= error;
      }
      if (publicationError) {
        await handle.close().catch(() => undefined);
        throw publicationError;
      }
      return { handle, path: slotPath };
    }
    throw new WalletActionProofStoreUnavailableError();
  }

  private async releaseSlot(
    directory: string,
    reservation: { handle: FileHandle; path: string },
  ): Promise<void> {
    const held = await reservation.handle.stat();
    if (!await this.unlinkOwnedPath(reservation.path, held)) {
      await reservation.handle.close().catch(() => undefined);
      throw new WalletActionProofStoreUnavailableError();
    }
    let releaseError: unknown;
    try {
      await this.syncDirectory(directory);
    } catch (error) {
      releaseError = error;
    }
    try {
      await reservation.handle.close();
    } catch (error) {
      releaseError ??= error;
    }
    if (releaseError) throw releaseError;
  }

  private timeFromName(name: string): number | undefined {
    const match = name.match(PROOF_TIME_PATTERN);
    if (!match) return undefined;
    const value = Number(match[1]);
    return Number.isSafeInteger(value) ? value : undefined;
  }

  private async durableTime(directory: string): Promise<number> {
    let maximum = 0;
    for (const name of await readdir(directory)) {
      const value = this.timeFromName(name);
      if (value !== undefined && value > maximum) maximum = value;
    }
    return maximum;
  }

  /**
   * Publish time before pruning. The timestamp is in the filename so even a
   * truncated file is a durable, fail-closed fence. Older fences are safe to
   * remove only after the new one and its directory entry have been synced.
   */
  private async advanceTimeFence(directory: string, now: number): Promise<boolean> {
    const previous = await this.durableTime(directory);
    if (previous > now) return false;
    if (previous < now) {
      const fencePath = join(directory, `${PROOF_TIME_PREFIX}${now}`);
      let handle;
      try {
        handle = await openFile(
          fencePath,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
          0o600,
        );
      } catch (error) {
        if (!isFileError(error, "EEXIST")) throw error;
      }
      if (handle) {
        let publicationError: unknown;
        try {
          await handle.writeFile(`${now}\n`, "utf8");
        } catch (error) {
          publicationError = error;
        } finally {
          try {
            await handle.sync();
          } catch (error) {
            publicationError ??= error;
          }
          try {
            await handle.close();
          } catch (error) {
            publicationError ??= error;
          }
        }
        try {
          await this.syncDirectory(directory);
        } catch (error) {
          publicationError ??= error;
        }
        if (publicationError) throw publicationError;
      }
    }

    let removed = false;
    for (const name of await readdir(directory)) {
      const value = this.timeFromName(name);
      if (value === undefined || value >= now) continue;
      const candidate = join(directory, name);
      try {
        const info = await lstat(candidate);
        if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) continue;
        if (typeof process.getuid === "function" && info.uid !== process.getuid()) continue;
        await unlink(candidate);
        removed = true;
      } catch (error) {
        if (!isFileError(error, "ENOENT")) throw error;
      }
    }
    if (removed) await this.syncDirectory(directory);
    return true;
  }

  private async pruneExpired(directory: string, now: number): Promise<void> {
    await this.migrateLegacyMarkers(directory);
    let pruned = false;
    // This directory is proof-only and this consumer never admits more than
    // the explicit cap. A complete deterministic pass therefore stays bounded
    // and cannot starve expired entries behind live or unrelated ones.
    for (const name of (await readdir(directory)).sort()) {
      if (!this.isSlotName(name)) continue;
      const slotPath = join(directory, name);
      let slotInfo;
      try {
        slotInfo = await lstat(slotPath);
        if (
          slotInfo.isSymbolicLink() || !slotInfo.isFile() || (slotInfo.mode & 0o077) !== 0 ||
          slotInfo.size < 1 || slotInfo.size > 512 ||
          (typeof process.getuid === "function" && slotInfo.uid !== process.getuid())
        ) continue;
        let value: unknown;
        try {
          value = JSON.parse(await readFile(slotPath, "utf8")) as unknown;
        } catch (error) {
          if (isFileError(error, "ENOENT")) continue;
          // Partial crash/ENOSPC reservations remain opaque occupied slots.
          continue;
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const marker = value as Record<string, unknown>;
        if (
          Object.keys(marker).sort().join("\0") !== "expires_at\0nonce_hash\0version" ||
          marker.version !== 1 || typeof marker.nonce_hash !== "string" ||
          !DIGEST_PATTERN.test(marker.nonce_hash) ||
          !Number.isSafeInteger(marker.expires_at) || Number(marker.expires_at) < 1
        ) continue;
        if (Number(marker.expires_at) > now) continue;

        const replayPath = join(directory, this.markerName(marker.nonce_hash));
        let replayInfo;
        try {
          replayInfo = await lstat(replayPath);
        } catch (error) {
          if (!isFileError(error, "ENOENT")) throw error;
        }
        if (replayInfo && this.inodeKey(replayInfo) !== this.inodeKey(slotInfo)) continue;
        if (replayInfo && !await this.unlinkOwnedPath(replayPath, slotInfo)) continue;
        if (await this.unlinkOwnedPath(slotPath, slotInfo)) pruned = true;
      } catch (error) {
        if (isFileError(error, "ENOENT")) continue;
        throw error;
      }
    }
    if (pruned) await this.syncDirectory(directory);
  }

  async consume(nonce: string, expiresAt: number, now: number): Promise<boolean> {
    if (!Number.isSafeInteger(now) || now < 1 ||
      !Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
    const nonceHash = createHash("sha256").update(nonce, "utf8").digest("hex").toUpperCase();
    const { parent, store } = await this.resolvedDirectories();
    // Releases prior to the proof-only subdirectory wrote markers in the
    // parent. Preserve their one-use meaning across an in-place upgrade.
    try {
      await lstat(join(parent, this.markerName(nonceHash)));
      return false;
    } catch (error) {
      if (!isFileError(error, "ENOENT")) throw error;
    }
    if (!await this.advanceTimeFence(store, now)) {
      throw new WalletActionProofStoreUnavailableError();
    }
    await this.pruneExpired(store, now);

    const marker: ProofMarker = { version: 1, nonce_hash: nonceHash, expires_at: expiresAt };
    const markerPath = join(store, this.markerName(nonceHash));
    const reservation = await this.reserveSlot(store, marker, nonceHash);
    try {
      await link(reservation.path, markerPath);
    } catch (error) {
      if (isFileError(error, "EEXIST")) {
        await this.releaseSlot(store, reservation);
        return false;
      }
      await reservation.handle.close().catch(() => undefined);
      throw error;
    }

    let publicationError: unknown;
    try {
      await this.syncDirectory(store);
    } catch (error) {
      publicationError = error;
    }
    try {
      await reservation.handle.close();
    } catch (error) {
      publicationError ??= error;
    }
    if (publicationError) throw publicationError;
    if (await this.durableTime(store) > now) {
      // The slot and replay link remain consumed across the clock race.
      throw new WalletActionProofStoreUnavailableError();
    }
    return true;
  }
}

function verifySignature(
  challenge: WalletActionChallenge,
  txBlob: string,
): void {
  if (
    txBlob.length === 0 ||
    Buffer.byteLength(txBlob, "utf8") > MAX_PROOF_BYTES ||
    !/^[A-Fa-f0-9]+$/.test(txBlob)
  ) {
    throw new Error("The wallet action proof is invalid.");
  }
  let decoded: Record<string, unknown>;
  try {
    decoded = decode(txBlob) as Record<string, unknown>;
  } catch {
    throw new Error("The wallet action proof is invalid.");
  }
  const signature = decoded.TxnSignature;
  const publicKey = decoded.SigningPubKey;
  if (typeof signature !== "string" || typeof publicKey !== "string" || !publicKey) {
    throw new Error("The wallet action proof is unsigned.");
  }
  const unsigned = { ...decoded };
  delete unsigned.TxnSignature;
  delete unsigned.SigningPubKey;
  if (canonicalJson(unsigned) !== canonicalJson(walletActionChallengeTransaction(challenge))) {
    throw new Error("The wallet action proof does not match this request.");
  }
  if (
    deriveAddress(publicKey) !== challenge.account ||
    !verifyKeypairSignature(encodeForSigning(decoded as never), signature, publicKey)
  ) {
    throw new Error("The wallet action proof signature is invalid.");
  }
}

export async function verifyAndConsumeWalletActionProof(
  session: WalletSession,
  challengeToken: string | null,
  txBlob: string | null,
  action: WalletAction,
  requestBody: string,
  options: {
    consumer?: WalletActionProofConsumer;
    now?: number;
    currentTime?: () => number;
    secret?: string;
  } = {},
): Promise<void> {
  const now = options.now ?? Date.now();
  const deploymentProfile = challengeDeploymentProfile(session);
  const challenge = challengeToken
    ? open(challengeToken, options.secret ?? sessionSecret(), deploymentProfile)
    : undefined;
  if (
    !isChallenge(challenge) ||
    challenge.expiresAt <= now ||
    challenge.deployment_profile !== deploymentProfile ||
    challenge.account !== session.account ||
    challenge.network !== session.network ||
    challenge.action !== action ||
    challenge.requestDigest !== walletActionRequestDigest(requestBody) ||
    !txBlob
  ) {
    throw new Error("A fresh wallet action proof is required.");
  }
  verifySignature(challenge, txBlob);
  const consumer = options.consumer ?? new FileWalletActionProofConsumer(
    process.env.P_LIVE_RLUSD_ACQUISITION_STATE_DIR,
  );
  if (!await consumer.consume(
    challenge.nonce,
    challenge.expiresAt,
    now,
  )) {
    throw new Error("The wallet action proof was already used.");
  }
  const completionNow = options.currentTime?.() ??
    (options.now === undefined ? Date.now() : options.now);
  if (!Number.isSafeInteger(completionNow) || challenge.expiresAt <= completionNow) {
    // Consumption is intentionally not rolled back: a proof that expires while
    // waiting must remain one-use and must never reach model or tool execution.
    throw new Error("A fresh wallet action proof is required.");
  }
}

export async function verifyLocalChatWalletActionProof(
  request: Request,
  requestBody: string,
): Promise<void> {
  const session = readWalletSession(request);
  if (!session) throw new Error("A wallet-bound session is required.");
  await verifyAndConsumeWalletActionProof(
    session,
    request.headers.get(WALLET_ACTION_CHALLENGE_HEADER),
    request.headers.get(WALLET_ACTION_PROOF_HEADER),
    "chat",
    requestBody,
  );
}
