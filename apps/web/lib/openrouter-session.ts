import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const OPENROUTER_SESSION_COOKIE = "__Host-pilot-openrouter-session";
export const OPENROUTER_STATE_COOKIE = "__Host-pilot-openrouter-state";
export const OPENROUTER_VERIFIER_COOKIE = "__Host-pilot-openrouter-verifier";
export const OPENROUTER_RETURN_TO_COOKIE = "__Host-pilot-openrouter-return-to";
export const OPENROUTER_WALLET_BINDING_COOKIE =
  "__Host-pilot-openrouter-wallet-binding";
export const OPENROUTER_PENDING_SESSION_COOKIE =
  "__Host-pilot-openrouter-pending-session";

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 60,
};

export const OAUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 10,
};

export const PENDING_SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "strict" as const,
  path: "/",
  maxAge: 5 * 60,
};

const SESSION_VERSION = 2;
const SESSION_AAD = Buffer.from("pilot.openrouter.session.v2", "utf8");
const PENDING_BINDING_AAD = Buffer.from(
  "pilot.openrouter.pending-wallet-binding.v2",
  "utf8",
);
const PENDING_SESSION_AAD = Buffer.from(
  "pilot.openrouter.pending-session.v2",
  "utf8",
);
const DEFAULT_RETURN_TO = "/onboarding?openrouter=connected";
const MAX_RETURN_TO_LENGTH = 512;

export type WalletModelBinding = {
  account: string;
  network: "testnet" | "devnet";
  expiresAt: number;
  /** One-way binding to the exact sealed wallet-session cookie. */
  sessionId: string;
};

type TimedOpenRouterSession = {
  version: 2;
  model: string;
  issuedAt: number;
  expiresAt: number;
  wallet: WalletModelBinding;
};

export type OpenRouterSession =
  | (TimedOpenRouterSession & { mode: "demo" })
  | (TimedOpenRouterSession & { mode: "oauth"; apiKey: string })
  | (TimedOpenRouterSession & { mode: "near-ai"; provider: "near-ai" });

export type PendingOpenRouterSession = {
  version: 2;
  attemptId: string;
  apiKey: string;
  model: string;
  returnTo: string;
  issuedAt: number;
  expiresAt: number;
  wallet: WalletModelBinding;
};

type PendingWalletBinding = {
  version: 2;
  issuedAt: number;
  expiresAt: number;
  wallet: WalletModelBinding;
};

type WalletSessionLike = {
  account: string;
  network: "testnet" | "devnet";
  expiresAt: number;
};

function sessionKey(secret: string): Buffer {
  if (secret.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  }

  return createHash("sha256").update(secret, "utf8").digest();
}

function isWalletModelBinding(value: unknown): value is WalletModelBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  return typeof binding.account === "string" &&
    binding.account.length > 0 &&
    (binding.network === "testnet" || binding.network === "devnet") &&
    typeof binding.expiresAt === "number" &&
    Number.isSafeInteger(binding.expiresAt) &&
    typeof binding.sessionId === "string" &&
    /^[a-f0-9]{64}$/.test(binding.sessionId);
}

function isOpenRouterSession(value: unknown, now = Date.now()): value is OpenRouterSession {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== SESSION_VERSION ||
    (candidate.mode !== "demo" && candidate.mode !== "oauth" && candidate.mode !== "near-ai") ||
    typeof candidate.model !== "string" ||
    typeof candidate.issuedAt !== "number" ||
    !Number.isSafeInteger(candidate.issuedAt) ||
    typeof candidate.expiresAt !== "number" ||
    !Number.isSafeInteger(candidate.expiresAt) ||
    candidate.issuedAt > now ||
    candidate.expiresAt <= now ||
    candidate.expiresAt - candidate.issuedAt > SESSION_COOKIE_OPTIONS.maxAge * 1_000 ||
    !isWalletModelBinding(candidate.wallet) ||
    candidate.expiresAt > candidate.wallet.expiresAt
  ) {
    return false;
  }

  if (candidate.mode === "demo") return true;
  if (candidate.mode === "near-ai") {
    return candidate.provider === "near-ai" && candidate.apiKey === undefined;
  }
  return typeof candidate.apiKey === "string" &&
    candidate.apiKey.trim().length >= 16 &&
    candidate.apiKey.trim().length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(candidate.apiKey);
}

export function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret) throw new Error("SESSION_SECRET is not configured");
  return secret;
}

export function sealOpenRouterSession(
  session: OpenRouterSession,
  secret = getSessionSecret(),
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sessionKey(secret), iv);
  cipher.setAAD(SESSION_AAD);

  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(session), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    `v${SESSION_VERSION}`,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function openOpenRouterSession(
  value: string | undefined,
  secret = getSessionSecret(),
  now = Date.now(),
): OpenRouterSession | null {
  if (!value) return null;

  try {
    const [version, encodedIv, encodedTag, encodedCiphertext, extra] =
      value.split(".");
    if (version !== `v${SESSION_VERSION}` || extra !== undefined) return null;

    const iv = Buffer.from(encodedIv, "base64url");
    const tag = Buffer.from(encodedTag, "base64url");
    const ciphertext = Buffer.from(encodedCiphertext, "base64url");
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
      return null;
    }

    const decipher = createDecipheriv("aes-256-gcm", sessionKey(secret), iv);
    decipher.setAAD(SESSION_AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    const parsed: unknown = JSON.parse(plaintext);
    return isOpenRouterSession(parsed, now) ? parsed : null;
  } catch {
    // Tampered, stale, or otherwise invalid cookies are treated as signed out.
    return null;
  }
}

function sealWithAad(value: object, aad: Buffer, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sessionKey(secret), iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function openWithAad(value: string | undefined, aad: Buffer, secret: string): unknown {
  if (!value) return undefined;
  try {
    const [version, encodedIv, encodedTag, encodedCiphertext, extra] = value.split(".");
    if (version !== "v1" || extra !== undefined) return undefined;
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

export function walletModelBinding(
  request: Request,
  wallet: WalletSessionLike,
): WalletModelBinding | null {
  const cookie = readCookie(request, "__Host-pilot-wallet-session");
  if (!cookie) return null;
  return {
    account: wallet.account,
    network: wallet.network,
    expiresAt: wallet.expiresAt,
    sessionId: createHash("sha256").update(cookie, "utf8").digest("hex"),
  };
}

export function matchesWalletModelBinding(
  binding: WalletModelBinding,
  request: Request,
  wallet: WalletSessionLike,
  now = Date.now(),
): boolean {
  const current = walletModelBinding(request, wallet);
  if (!current || binding.expiresAt <= now || wallet.expiresAt <= now) return false;
  const expected = Buffer.from(binding.sessionId, "hex");
  const received = Buffer.from(current.sessionId, "hex");
  return binding.account === current.account &&
    binding.network === current.network &&
    binding.expiresAt === current.expiresAt &&
    expected.length === received.length &&
    timingSafeEqual(expected, received);
}

export function createOpenRouterSession(
  input:
    | { mode: "demo"; model: string }
    | { mode: "oauth"; model: string; apiKey: string }
    | { mode: "near-ai"; provider: "near-ai"; model: string },
  wallet: WalletModelBinding,
  now = Date.now(),
): OpenRouterSession {
  const expiresAt = Math.min(
    wallet.expiresAt,
    now + SESSION_COOKIE_OPTIONS.maxAge * 1_000,
  );
  if (expiresAt <= now) throw new Error("The wallet session is expired");
  return {
    version: 2,
    ...input,
    issuedAt: now,
    expiresAt,
    wallet,
  };
}

export function sealPendingWalletBinding(
  binding: WalletModelBinding,
  secret = getSessionSecret(),
  now = Date.now(),
): string {
  const expiresAt = Math.min(
    binding.expiresAt,
    now + OAUTH_COOKIE_OPTIONS.maxAge * 1_000,
  );
  if (expiresAt <= now) throw new Error("The wallet session is expired");
  return sealWithAad({
    version: 2,
    issuedAt: now,
    expiresAt,
    wallet: binding,
  } satisfies PendingWalletBinding, PENDING_BINDING_AAD, secret);
}

export function openPendingWalletBinding(
  value: string | undefined,
  secret = getSessionSecret(),
  now = Date.now(),
): WalletModelBinding | null {
  const parsed = openWithAad(value, PENDING_BINDING_AAD, secret);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const pending = parsed as Record<string, unknown>;
  if (
    pending.version !== 2 ||
    typeof pending.issuedAt !== "number" ||
    !Number.isSafeInteger(pending.issuedAt) ||
    typeof pending.expiresAt !== "number" ||
    !Number.isSafeInteger(pending.expiresAt) ||
    pending.issuedAt > now ||
    pending.expiresAt <= now ||
    pending.expiresAt - pending.issuedAt > OAUTH_COOKIE_OPTIONS.maxAge * 1_000 ||
    !isWalletModelBinding(pending.wallet) ||
    pending.expiresAt > pending.wallet.expiresAt
  ) {
    return null;
  }
  return pending.wallet;
}

function isPendingOpenRouterSession(
  value: unknown,
  now = Date.now(),
): value is PendingOpenRouterSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 2 &&
    typeof candidate.attemptId === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(candidate.attemptId) &&
    typeof candidate.apiKey === "string" &&
    candidate.apiKey.trim().length >= 16 &&
    candidate.apiKey.trim().length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(candidate.apiKey) &&
    typeof candidate.model === "string" &&
    typeof candidate.returnTo === "string" &&
    typeof candidate.issuedAt === "number" &&
    Number.isSafeInteger(candidate.issuedAt) &&
    typeof candidate.expiresAt === "number" &&
    Number.isSafeInteger(candidate.expiresAt) &&
    candidate.issuedAt <= now &&
    candidate.expiresAt > now &&
    candidate.expiresAt - candidate.issuedAt <=
      PENDING_SESSION_COOKIE_OPTIONS.maxAge * 1_000 &&
    isWalletModelBinding(candidate.wallet) &&
    candidate.expiresAt <= candidate.wallet.expiresAt;
}

export function createPendingOpenRouterSession(
  input: { apiKey: string; model: string; returnTo: string; attemptId: string },
  wallet: WalletModelBinding,
  now = Date.now(),
): PendingOpenRouterSession {
  const expiresAt = Math.min(
    wallet.expiresAt,
    now + PENDING_SESSION_COOKIE_OPTIONS.maxAge * 1_000,
  );
  if (expiresAt <= now) throw new Error("The wallet session is expired");
  return {
    version: 2,
    ...input,
    issuedAt: now,
    expiresAt,
    wallet,
  };
}

export function openRouterAttemptId(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("base64url");
}

export function sealPendingOpenRouterSession(
  pending: PendingOpenRouterSession,
  secret = getSessionSecret(),
): string {
  return sealWithAad(pending, PENDING_SESSION_AAD, secret);
}

export function openPendingOpenRouterSession(
  value: string | undefined,
  secret = getSessionSecret(),
  now = Date.now(),
): PendingOpenRouterSession | null {
  const parsed = openWithAad(value, PENDING_SESSION_AAD, secret);
  return isPendingOpenRouterSession(parsed, now) ? parsed : null;
}

export function generatePkce(): {
  state: string;
  verifier: string;
  challenge: string;
} {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256")
    .update(verifier, "ascii")
    .digest("base64url");
  return { state, verifier, challenge };
}

export function matchesState(expected: string | undefined, received: string | null): boolean {
  if (!expected || !received) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const receivedBytes = Buffer.from(received, "utf8");
  return (
    expectedBytes.length === receivedBytes.length &&
    timingSafeEqual(expectedBytes, receivedBytes)
  );
}

export function readCookie(request: Request, name: string): string | undefined {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return undefined;

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;

    const encoded = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(encoded);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

export function readOpenRouterSession(request: Request): OpenRouterSession | null {
  return openOpenRouterSession(readCookie(request, OPENROUTER_SESSION_COOKIE));
}

export function readWalletBoundOpenRouterSession(
  request: Request,
  wallet: WalletSessionLike | null,
  now = Date.now(),
): OpenRouterSession | null {
  if (!wallet) return null;
  const session = openOpenRouterSession(
    readCookie(request, OPENROUTER_SESSION_COOKIE),
    getSessionSecret(),
    now,
  );
  return session && matchesWalletModelBinding(session.wallet, request, wallet, now)
    ? session
    : null;
}

export function safeReturnTo(
  value: string | null | undefined,
  publicOrigin: string,
): string {
  if (!value) return DEFAULT_RETURN_TO;

  const candidate = value.slice(0, MAX_RETURN_TO_LENGTH);
  if (
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    /[\\\u0000-\u001f\u007f]/.test(candidate) ||
    /%(?:5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(candidate)
  ) {
    return DEFAULT_RETURN_TO;
  }

  try {
    const trustedOrigin = new URL(publicOrigin).origin;
    const destination = new URL(candidate, trustedOrigin);
    if (
      destination.origin !== trustedOrigin ||
      destination.username !== "" ||
      destination.password !== ""
    ) {
      return DEFAULT_RETURN_TO;
    }
  } catch {
    return DEFAULT_RETURN_TO;
  }

  return candidate;
}
