import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import { getSessionSecret, readCookie } from "../../openrouter-session";

export const OPEN_FINANCE_SESSION_COOKIE = "__Host-pilot-open-finance-session";
export const OPEN_FINANCE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 60 * 2,
};

const AAD = Buffer.from("pilot.mastercard.open-finance.session.v1", "utf8");

export interface OpenFinanceBrowserSession {
  version: 1;
  customer_id: string;
  account_id?: string;
}

function key(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

export function sealOpenFinanceSession(
  session: OpenFinanceBrowserSession,
  secret = getSessionSecret(),
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(session), "utf8"),
    cipher.final(),
  ]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function openOpenFinanceSession(
  value: string | undefined,
  secret = getSessionSecret(),
): OpenFinanceBrowserSession | null {
  if (!value) return null;
  try {
    const [version, ivValue, tagValue, ciphertextValue, extra] = value.split(".");
    if (version !== "v1" || extra !== undefined) return null;
    const iv = Buffer.from(ivValue, "base64url");
    const tag = Buffer.from(tagValue, "base64url");
    const ciphertext = Buffer.from(ciphertextValue, "base64url");
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) return null;
    const decipher = createDecipheriv("aes-256-gcm", key(secret), iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const parsed = JSON.parse(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"),
    ) as Record<string, unknown>;
    if (
      parsed.version !== 1 ||
      typeof parsed.customer_id !== "string" ||
      (parsed.account_id !== undefined && typeof parsed.account_id !== "string")
    ) {
      return null;
    }
    return parsed as unknown as OpenFinanceBrowserSession;
  } catch {
    return null;
  }
}

export function readOpenFinanceSession(request: Request): OpenFinanceBrowserSession | null {
  return openOpenFinanceSession(readCookie(request, OPEN_FINANCE_SESSION_COOKIE));
}
