import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import {
  decode,
  deriveAddress,
  encodeForSigning,
  isValidClassicAddress,
  verifyKeypairSignature,
} from "xrpl";

import {
  PILOT_ISOLATED_BUILD_MARKER,
  PILOT_ISOLATED_DEPLOYMENT_PROFILE,
} from "@pilot/wallet/isolation-profile";

import { readCookie } from "./openrouter-session";

export const WALLET_CHALLENGE_COOKIE = "__Host-pilot-wallet-challenge";
export const WALLET_SESSION_COOKIE = "__Host-pilot-wallet-session";
export const WALLET_SUBMISSIONS_COOKIE = "__Host-pilot-wallet-submissions";

export const WALLET_CHALLENGE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "strict" as const,
  path: "/",
  maxAge: 5 * 60,
};

export const WALLET_SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "strict" as const,
  path: "/",
  maxAge: 60 * 60,
};

export type WalletSessionNetwork = "testnet" | "devnet";

export type WalletSession = {
  version: 1;
  account: string;
  network: WalletSessionNetwork;
  expiresAt: number;
  deployment_profile?: typeof PILOT_ISOLATED_DEPLOYMENT_PROFILE;
};

type WalletChallenge = WalletSession & {
  nonce: string;
};

type WalletSubmissionCapabilities = WalletSession & {
  capabilitySchema: 2;
  hashes: string[];
  buildIds: string[];
  transactionDigests: string[];
  executions?: WalletExecutionCapability[];
  preparedExecutions?: WalletPreparedExecutionCapability[];
  policyDigest?: string;
};

type WalletExecutionCapability = {
  buildId: string;
  idempotencyKey: string;
  requireOwnerApproval: boolean;
};

type WalletPreparedExecutionCapability = {
  buildId: string;
  idempotencyKey: string;
  transactionDigest: string;
};

const VERSION = 1;
const SUBMISSIONS_SCHEMA_VERSION = 2 as const;
const CHALLENGE_AAD = Buffer.from("pilot.wallet.challenge.v1", "utf8");
const SESSION_AAD = Buffer.from("pilot.wallet.session.v1", "utf8");
const SUBMISSIONS_AAD = Buffer.from("pilot.wallet.submissions.v2", "utf8");
const MEMO_TYPE = Buffer.from("pilot-wallet-auth-v1", "utf8")
  .toString("hex")
  .toUpperCase();

type WalletArtifactEnvironment = Readonly<{
  NEXT_PUBLIC_PILOT_BUILD_MARKER?: string;
  PILOT_DEPLOYMENT_PROFILE?: string;
}>;

function expectedWalletArtifactProfile(
  environment: WalletArtifactEnvironment = process.env,
): typeof PILOT_ISOLATED_DEPLOYMENT_PROFILE | undefined {
  if (environment.PILOT_DEPLOYMENT_PROFILE === PILOT_ISOLATED_DEPLOYMENT_PROFILE) {
    if (environment.NEXT_PUBLIC_PILOT_BUILD_MARKER !== PILOT_ISOLATED_BUILD_MARKER) {
      throw new Error("The isolated wallet artifact profile is misconfigured.");
    }
    return PILOT_ISOLATED_DEPLOYMENT_PROFILE;
  }
  if (environment.NEXT_PUBLIC_PILOT_BUILD_MARKER !== undefined) {
    throw new Error("The wallet artifact build marker is misconfigured.");
  }
  if (
    environment.PILOT_DEPLOYMENT_PROFILE !== undefined &&
    environment.PILOT_DEPLOYMENT_PROFILE !== "local-wallet" &&
    environment.PILOT_DEPLOYMENT_PROFILE !== "hosted"
  ) {
    throw new Error("The wallet artifact deployment profile is misconfigured.");
  }
  return undefined;
}

function matchesWalletArtifactProfile(
  value: Record<string, unknown>,
  environment: WalletArtifactEnvironment = process.env,
): boolean {
  const expected = expectedWalletArtifactProfile(environment);
  return expected === undefined
    ? !("deployment_profile" in value)
    : value.deployment_profile === expected;
}

function sessionKey(secret: string): Buffer {
  if (secret.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret) throw new Error("SESSION_SECRET is not configured");
  return secret;
}

function seal(value: object, aad: Buffer, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sessionKey(secret), iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [
    `v${VERSION}`,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function open(value: string | undefined, aad: Buffer, secret: string): unknown {
  if (!value) return undefined;
  try {
    const [version, encodedIv, encodedTag, encodedCiphertext, extra] = value.split(".");
    if (version !== `v${VERSION}` || extra !== undefined) return undefined;
    const iv = Buffer.from(encodedIv, "base64url");
    const tag = Buffer.from(encodedTag, "base64url");
    const ciphertext = Buffer.from(encodedCiphertext, "base64url");
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", sessionKey(secret), iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function isNetwork(value: unknown): value is WalletSessionNetwork {
  return value === "testnet" || value === "devnet";
}

function isWalletSession(value: unknown): value is WalletSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  return session.version === VERSION &&
    typeof session.account === "string" &&
    isValidClassicAddress(session.account) &&
    isNetwork(session.network) &&
    typeof session.expiresAt === "number" &&
    Number.isSafeInteger(session.expiresAt);
}

function isWalletSessionForDeployment(
  value: unknown,
  environment: WalletArtifactEnvironment = process.env,
): value is WalletSession {
  return isWalletSession(value) && matchesWalletArtifactProfile(
    value as Record<string, unknown>,
    environment,
  );
}

function isWalletChallenge(value: unknown): value is WalletChallenge {
  return isWalletSession(value) &&
    typeof (value as Record<string, unknown>).nonce === "string" &&
    /^[A-Za-z0-9_-]{32,128}$/.test((value as Record<string, unknown>).nonce as string);
}

function isWalletSubmissionCapabilities(value: unknown): value is WalletSubmissionCapabilities {
  if (!isWalletSession(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.capabilitySchema !== SUBMISSIONS_SCHEMA_VERSION) return false;
  const hashes = candidate.hashes;
  const buildIds = candidate.buildIds;
  const transactionDigests = candidate.transactionDigests;
  const executions = candidate.executions;
  const preparedExecutions = candidate.preparedExecutions;
  const policyDigest = candidate.policyDigest;
  const opaqueIdsAreSafe = (ids: unknown) => Array.isArray(ids) && ids.length <= 16 && ids.every(
    (id) => typeof id === "string" && id.length > 0 && id.length <= 256,
  );
  const executionsAreSafe = executions === undefined || (
    Array.isArray(executions) && executions.length <= 16 && executions.every((execution) => {
      if (!execution || typeof execution !== "object" || Array.isArray(execution)) return false;
      const entry = execution as Record<string, unknown>;
      return Object.keys(entry).length === 3 &&
        validOpaqueId(entry.buildId) &&
        typeof entry.idempotencyKey === "string" &&
        entry.idempotencyKey.length > 0 && entry.idempotencyKey.length <= 200 &&
        typeof entry.requireOwnerApproval === "boolean";
    })
  );
  const preparedExecutionsAreSafe = preparedExecutions === undefined || (
    Array.isArray(preparedExecutions) && preparedExecutions.length <= 16 &&
    preparedExecutions.every((prepared) => {
      if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) return false;
      const entry = prepared as Record<string, unknown>;
      return Object.keys(entry).length === 3 &&
        validOpaqueId(entry.buildId) &&
        typeof entry.idempotencyKey === "string" &&
        entry.idempotencyKey.length > 0 && entry.idempotencyKey.length <= 200 &&
        typeof entry.transactionDigest === "string" &&
        /^[A-Fa-f0-9]{64}$/.test(entry.transactionDigest);
    })
  );
  const policyDigestIsSafe = policyDigest === undefined ||
    (typeof policyDigest === "string" && /^[A-Fa-f0-9]{64}$/.test(policyDigest));
  return Array.isArray(hashes) && hashes.length <= 16 && hashes.every(
    (hash) => typeof hash === "string" && /^[A-Fa-f0-9]{64}$/.test(hash),
  ) && opaqueIdsAreSafe(buildIds) && Array.isArray(transactionDigests) &&
    transactionDigests.length <= 16 && transactionDigests.every(
      (digest) => typeof digest === "string" && /^[A-Fa-f0-9]{64}$/.test(digest),
    ) && executionsAreSafe && preparedExecutionsAreSafe && policyDigestIsSafe;
}

function memoData(nonce: string): string {
  return Buffer.from(nonce, "utf8").toString("hex").toUpperCase();
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

export function walletTransactionDigest(transaction: Record<string, unknown>): string {
  const unsigned = { ...transaction };
  delete unsigned.SigningPubKey;
  delete unsigned.TxnSignature;
  delete unsigned.Signers;
  return createHash("sha256").update(canonicalJson(unsigned), "utf8").digest("hex").toUpperCase();
}

export function walletPolicyDigest(policy: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(policy), "utf8").digest("hex").toUpperCase();
}

export function walletChallengeTransaction(challenge: WalletChallenge): Record<string, unknown> {
  return {
    TransactionType: "AccountSet",
    Account: challenge.account,
    Sequence: 0,
    Fee: "0",
    LastLedgerSequence: 0,
    Memos: [{ Memo: { MemoType: MEMO_TYPE, MemoData: memoData(challenge.nonce) } }],
  };
}

export function issueWalletChallenge(
  account: string,
  network: WalletSessionNetwork,
  options: {
    now?: number;
    secret?: string;
    nonce?: string;
    environment?: WalletArtifactEnvironment;
  } = {},
): { cookie: string; expiresAt: number; txJson: Record<string, unknown> } {
  if (!isValidClassicAddress(account)) throw new Error("A valid XRPL classic account is required.");
  if (!isNetwork(network)) throw new Error("Wallet authorization is limited to testnet and devnet.");
  const now = options.now ?? Date.now();
  const challenge: WalletChallenge = {
    version: VERSION,
    account,
    network,
    expiresAt: now + WALLET_CHALLENGE_COOKIE_OPTIONS.maxAge * 1_000,
    nonce: options.nonce ?? randomBytes(32).toString("base64url"),
    ...(expectedWalletArtifactProfile(options.environment) ? {
      deployment_profile: PILOT_ISOLATED_DEPLOYMENT_PROFILE,
    } : {}),
  };
  return {
    cookie: seal(challenge, CHALLENGE_AAD, options.secret ?? getSessionSecret()),
    expiresAt: challenge.expiresAt,
    txJson: walletChallengeTransaction(challenge),
  };
}

export function verifyWalletChallenge(
  challengeCookie: string | undefined,
  txBlob: string,
  options: {
    now?: number;
    secret?: string;
    environment?: WalletArtifactEnvironment;
  } = {},
): WalletSession {
  const secret = options.secret ?? getSessionSecret();
  const challenge = open(challengeCookie, CHALLENGE_AAD, secret);
  if (
    !isWalletChallenge(challenge) ||
    !matchesWalletArtifactProfile(challenge as unknown as Record<string, unknown>, options.environment) ||
    challenge.expiresAt <= (options.now ?? Date.now())
  ) {
    throw new Error("The wallet authorization challenge is invalid or expired.");
  }
  if (!/^[A-Fa-f0-9]+$/.test(txBlob) || txBlob.length > 16_384) {
    throw new Error("The wallet authorization proof is invalid.");
  }

  let decoded: Record<string, unknown>;
  try {
    decoded = decode(txBlob) as Record<string, unknown>;
  } catch {
    throw new Error("The wallet authorization proof is invalid.");
  }
  const signature = decoded.TxnSignature;
  const publicKey = decoded.SigningPubKey;
  if (typeof signature !== "string" || typeof publicKey !== "string" || !publicKey) {
    throw new Error("The wallet authorization proof is unsigned.");
  }

  const expected = walletChallengeTransaction(challenge);
  const unsigned = { ...decoded };
  delete unsigned.TxnSignature;
  delete unsigned.SigningPubKey;
  if (canonicalJson(unsigned) !== canonicalJson(expected)) {
    throw new Error("The wallet authorization proof does not match this challenge.");
  }
  if (
    deriveAddress(publicKey) !== challenge.account ||
    !verifyKeypairSignature(encodeForSigning(decoded as never), signature, publicKey)
  ) {
    throw new Error("The wallet authorization signature is invalid.");
  }

  return {
    version: VERSION,
    account: challenge.account,
    network: challenge.network,
    expiresAt: (options.now ?? Date.now()) + WALLET_SESSION_COOKIE_OPTIONS.maxAge * 1_000,
    ...(challenge.deployment_profile ? {
      deployment_profile: challenge.deployment_profile,
    } : {}),
  };
}

export function sealWalletSession(
  session: WalletSession,
  secret = getSessionSecret(),
  environment: WalletArtifactEnvironment = process.env,
): string {
  if (!isWalletSessionForDeployment(session, environment)) {
    throw new Error("The wallet session is invalid for this deployment profile.");
  }
  return seal(session, SESSION_AAD, secret);
}

export function openWalletSession(
  value: string | undefined,
  options: {
    now?: number;
    secret?: string;
    environment?: WalletArtifactEnvironment;
  } = {},
): WalletSession | null {
  const session = open(value, SESSION_AAD, options.secret ?? getSessionSecret());
  if (
    !isWalletSessionForDeployment(session, options.environment) ||
    session.expiresAt <= (options.now ?? Date.now())
  ) return null;
  return session;
}

export function readWalletSession(
  request: Request,
  environment: WalletArtifactEnvironment = process.env,
): WalletSession | null {
  const cookie = readCookie(request, WALLET_SESSION_COOKIE);
  return cookie ? openWalletSession(cookie, { environment }) : null;
}

type WalletHarborCapabilityUpdate = {
  hash?: string;
  transactionDigest?: string;
  execution?: WalletExecutionCapability;
  preparedExecution?: WalletPreparedExecutionCapability;
  policyDigest?: string;
};

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

export function issueWalletHarborCapability(
  request: Request,
  update: WalletHarborCapabilityUpdate,
): string | undefined {
  if (update.hash !== undefined && !/^[A-Fa-f0-9]{64}$/.test(update.hash)) return undefined;
  if (update.transactionDigest !== undefined && !/^[A-Fa-f0-9]{64}$/.test(update.transactionDigest)) return undefined;
  if (update.policyDigest !== undefined && !/^[A-Fa-f0-9]{64}$/.test(update.policyDigest)) return undefined;
  if (update.execution !== undefined && (
    !validOpaqueId(update.execution.buildId) ||
    typeof update.execution.idempotencyKey !== "string" ||
    update.execution.idempotencyKey.length === 0 ||
    update.execution.idempotencyKey.length > 200 ||
    typeof update.execution.requireOwnerApproval !== "boolean"
  )) return undefined;
  if (update.preparedExecution !== undefined && (
    !validOpaqueId(update.preparedExecution.buildId) ||
    typeof update.preparedExecution.idempotencyKey !== "string" ||
    update.preparedExecution.idempotencyKey.length === 0 ||
    update.preparedExecution.idempotencyKey.length > 200 ||
    !/^[A-Fa-f0-9]{64}$/.test(update.preparedExecution.transactionDigest)
  )) return undefined;
  if (
    update.hash === undefined && update.transactionDigest === undefined &&
    update.execution === undefined && update.preparedExecution === undefined &&
    update.policyDigest === undefined
  ) {
    return undefined;
  }
  const session = readWalletSession(request);
  if (!session) return undefined;
  const secret = getSessionSecret();
  const prior = open(readCookie(request, WALLET_SUBMISSIONS_COOKIE), SUBMISSIONS_AAD, secret);
  const priorCapabilities = isWalletSubmissionCapabilities(prior) &&
    matchesWalletArtifactProfile(prior as unknown as Record<string, unknown>) &&
    prior.account === session.account && prior.network === session.network &&
    prior.expiresAt > Date.now()
    ? prior
    : {
      capabilitySchema: SUBMISSIONS_SCHEMA_VERSION,
      hashes: [], buildIds: [], transactionDigests: [], executions: [], preparedExecutions: [],
      policyDigest: undefined,
    };
  const prepend = (value: string | undefined, priorValues: string[]) => value === undefined
    ? priorValues
    : [value, ...priorValues.filter((entry) => entry !== value)].slice(0, 16);
  return seal({
    ...session,
    capabilitySchema: SUBMISSIONS_SCHEMA_VERSION,
    hashes: prepend(update.hash?.toUpperCase(), priorCapabilities.hashes),
    buildIds: priorCapabilities.buildIds,
    transactionDigests: prepend(
      update.transactionDigest?.toUpperCase(),
      priorCapabilities.transactionDigests,
    ),
    executions: update.execution === undefined
      ? (priorCapabilities.executions ?? [])
      : [
        update.execution,
        ...(priorCapabilities.executions ?? []).filter((entry) =>
          entry.buildId !== update.execution?.buildId ||
          entry.idempotencyKey !== update.execution.idempotencyKey ||
          entry.requireOwnerApproval !== update.execution.requireOwnerApproval
        ),
      ].slice(0, 16),
    preparedExecutions: update.preparedExecution === undefined
      ? (priorCapabilities.preparedExecutions ?? [])
      : [
        update.preparedExecution,
        ...(priorCapabilities.preparedExecutions ?? []).filter((entry) =>
          entry.buildId !== update.preparedExecution?.buildId ||
          entry.idempotencyKey !== update.preparedExecution.idempotencyKey ||
          entry.transactionDigest !== update.preparedExecution.transactionDigest
        ),
      ].slice(0, 16),
    policyDigest: update.policyDigest?.toUpperCase() ?? priorCapabilities.policyDigest,
  }, SUBMISSIONS_AAD, secret);
}

export function hasWalletPolicyCapability(
  request: Request,
  policy: Record<string, unknown>,
): boolean {
  const session = readWalletSession(request);
  if (!session) return false;
  const capabilities = open(
    readCookie(request, WALLET_SUBMISSIONS_COOKIE),
    SUBMISSIONS_AAD,
    getSessionSecret(),
  );
  return isWalletSubmissionCapabilities(capabilities) &&
    matchesWalletArtifactProfile(capabilities as unknown as Record<string, unknown>) &&
    capabilities.account === session.account && capabilities.network === session.network &&
    capabilities.expiresAt > Date.now() &&
    capabilities.policyDigest === walletPolicyDigest(policy);
}

export function hasWalletPreparedExecutionCapability(
  request: Request,
  buildId: unknown,
  idempotencyKey: unknown,
  transaction: Record<string, unknown>,
): boolean {
  if (
    typeof buildId !== "string" || !validOpaqueId(buildId) ||
    typeof idempotencyKey !== "string" || idempotencyKey.length === 0 ||
    idempotencyKey.length > 200
  ) return false;
  const session = readWalletSession(request);
  if (!session) return false;
  const capabilities = open(
    readCookie(request, WALLET_SUBMISSIONS_COOKIE),
    SUBMISSIONS_AAD,
    getSessionSecret(),
  );
  if (
    !isWalletSubmissionCapabilities(capabilities) ||
    !matchesWalletArtifactProfile(capabilities as unknown as Record<string, unknown>) ||
    capabilities.account !== session.account || capabilities.network !== session.network ||
    capabilities.expiresAt <= Date.now()
  ) return false;
  const digest = walletTransactionDigest(transaction);
  return (capabilities.preparedExecutions ?? []).some((entry) =>
    entry.buildId === buildId && entry.idempotencyKey === idempotencyKey &&
    entry.transactionDigest.toUpperCase() === digest
  );
}

export function hasWalletSubmissionCapability(request: Request, hash: unknown): boolean {
  if (typeof hash !== "string" || !/^[A-Fa-f0-9]{64}$/.test(hash)) return false;
  const session = readWalletSession(request);
  if (!session) return false;
  const capabilities = open(
    readCookie(request, WALLET_SUBMISSIONS_COOKIE),
    SUBMISSIONS_AAD,
    getSessionSecret(),
  );
  return isWalletSubmissionCapabilities(capabilities) &&
    matchesWalletArtifactProfile(capabilities as unknown as Record<string, unknown>) &&
    capabilities.account === session.account &&
    capabilities.network === session.network &&
    capabilities.expiresAt > Date.now() &&
    capabilities.hashes.some((value) => value.toUpperCase() === hash.toUpperCase());
}

/**
 * Authorize execution only against an exact capability minted from a validated
 * builder request/response pair. Legacy build-only entries remain readable so
 * other capability fields in an older cookie survive migration, but they never
 * grant tx.execute access.
 */
export function hasWalletExecutionCapability(
  request: Request,
  buildId: unknown,
  idempotencyKey: unknown,
  requireOwnerApproval: unknown,
): boolean {
  if (
    typeof buildId !== "string" || !validOpaqueId(buildId) ||
    typeof idempotencyKey !== "string" || idempotencyKey.length === 0 ||
    idempotencyKey.length > 200 ||
    (requireOwnerApproval !== undefined && requireOwnerApproval !== true)
  ) return false;
  const session = readWalletSession(request);
  if (!session) return false;
  const capabilities = open(
    readCookie(request, WALLET_SUBMISSIONS_COOKIE),
    SUBMISSIONS_AAD,
    getSessionSecret(),
  );
  if (
    !isWalletSubmissionCapabilities(capabilities) ||
    !matchesWalletArtifactProfile(capabilities as unknown as Record<string, unknown>) ||
    capabilities.account !== session.account ||
    capabilities.network !== session.network ||
    capabilities.expiresAt <= Date.now()
  ) return false;

  return (capabilities.executions ?? []).some((entry) =>
    entry.buildId === buildId &&
    entry.idempotencyKey === idempotencyKey &&
    entry.requireOwnerApproval === (requireOwnerApproval === true)
  );
}

export function hasWalletTransactionCapability(
  request: Request,
  transaction: Record<string, unknown>,
): boolean {
  const session = readWalletSession(request);
  if (!session) return false;
  const capabilities = open(
    readCookie(request, WALLET_SUBMISSIONS_COOKIE),
    SUBMISSIONS_AAD,
    getSessionSecret(),
  );
  return isWalletSubmissionCapabilities(capabilities) &&
    matchesWalletArtifactProfile(capabilities as unknown as Record<string, unknown>) &&
    capabilities.account === session.account &&
    capabilities.network === session.network &&
    capabilities.expiresAt > Date.now() &&
    capabilities.transactionDigests.includes(walletTransactionDigest(transaction));
}

export function verifiedSignedBlobTransaction(txBlob: unknown): Record<string, unknown> | undefined {
  if (typeof txBlob !== "string" || !/^[A-Fa-f0-9]+$/.test(txBlob) || txBlob.length > 1_048_576) {
    return undefined;
  }
  try {
    const decoded = decode(txBlob) as Record<string, unknown>;
    const account = decoded.Account;
    const signature = decoded.TxnSignature;
    const publicKey = decoded.SigningPubKey;
    if (
      typeof account !== "string" ||
      typeof signature !== "string" ||
      typeof publicKey !== "string" ||
      !publicKey ||
      deriveAddress(publicKey) !== account ||
      !verifyKeypairSignature(encodeForSigning(decoded as never), signature, publicKey)
    ) {
      return undefined;
    }
    return decoded;
  } catch {
    return undefined;
  }
}

export function verifiedSignedBlobAccount(txBlob: unknown): string | undefined {
  return verifiedSignedBlobTransaction(txBlob)?.Account as string | undefined;
}
