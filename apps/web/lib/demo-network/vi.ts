import { createHash, webcrypto } from "node:crypto";

import {
  DEMO_NETWORK_ISSUER_NAME,
  DemoNetworkError,
} from "./guard";

const L1_LIFETIME_SECONDS = 60 * 60 * 24 * 365;
const VI_L1_VCT = "https://credentials.mastercard.com/card";
const HASH_PATTERN = /^[a-f0-9]{64}$/i;

export interface ViL1Input {
  budget_account: string;
  device_public_jwk: JsonWebKey;
  of_verification: {
    customer_ref_hash: string;
    owner_name_hash: string;
    verified: true;
  };
}

export interface ViL1Claims {
  _sd: string[];
  _sd_alg: "sha-256";
  budget_account: string;
  cnf: { jwk: JsonWebKey };
  exp: number;
  iat: number;
  iss: string;
  pilot_issuer_name: typeof DEMO_NETWORK_ISSUER_NAME;
  nbf: number;
  of_customer_ref: string;
  of_owner_name_hash: string;
  of_verified: true;
  sub: string;
  vct: typeof VI_L1_VCT;
}

export interface IssuedViL1 {
  digest: string;
  expires_at: string;
  issuer: typeof DEMO_NETWORK_ISSUER_NAME;
  l1: string;
  public_jwk: PublicSigningJwk;
}

export type PublicSigningJwk = JsonWebKey & {
  alg: "ES256";
  kid: string;
  use: "sig";
};

function base64Url(input: Uint8Array | string): string {
  return Buffer.from(input).toString("base64url");
}

function decodeBase64UrlJson(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function assertPublicP256Jwk(value: unknown): JsonWebKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DemoNetworkError(
      "INVALID_DEVICE_KEY",
      400,
      "A valid non-private ES256 device public key is required.",
    );
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kty !== "EC" ||
    candidate.crv !== "P-256" ||
    typeof candidate.x !== "string" ||
    candidate.x.length === 0 ||
    typeof candidate.y !== "string" ||
    candidate.y.length === 0 ||
    candidate.d !== undefined
  ) {
    throw new DemoNetworkError(
      "INVALID_DEVICE_KEY",
      400,
      "A valid non-private ES256 device public key is required.",
    );
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: candidate.x,
    y: candidate.y,
  };
}

function assertPrivateP256Jwk(value: unknown): JsonWebKey {
  const publicJwk = assertPublicP256Jwk(
    value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).filter(
            ([key]) => key !== "d",
          ),
        )
      : value,
  );
  const d =
    value && typeof value === "object"
      ? (value as Record<string, unknown>).d
      : undefined;
  if (typeof d !== "string" || d.length === 0) {
    throw new DemoNetworkError(
      "DEMO_NETWORK_NOT_CONFIGURED",
      503,
      "The demo network is not configured.",
    );
  }
  return { ...publicJwk, d };
}

export function parsePrivateIssuerJwk(value: string | undefined): JsonWebKey {
  if (!value) {
    throw new DemoNetworkError(
      "DEMO_NETWORK_NOT_CONFIGURED",
      503,
      "The demo network is not configured.",
    );
  }
  try {
    return assertPrivateP256Jwk(JSON.parse(value));
  } catch (error) {
    if (error instanceof DemoNetworkError) throw error;
    throw new DemoNetworkError(
      "DEMO_NETWORK_NOT_CONFIGURED",
      503,
      "The demo network is not configured.",
    );
  }
}

export function publicIssuerJwk(privateJwk: JsonWebKey): PublicSigningJwk {
  const { d: _privateMaterial, ...withoutPrivateMaterial } = privateJwk;
  const publicJwk = assertPublicP256Jwk(withoutPrivateMaterial);
  const thumbprintInput = JSON.stringify({
    crv: publicJwk.crv,
    kty: publicJwk.kty,
    x: publicJwk.x,
    y: publicJwk.y,
  });
  const kid = createHash("sha256")
    .update(thumbprintInput, "utf8")
    .digest("base64url");
  return { ...publicJwk, alg: "ES256", kid, use: "sig" };
}

async function validateInput(input: ViL1Input): Promise<ViL1Input> {
  const devicePublicJwk = assertPublicP256Jwk(input.device_public_jwk);
  try {
    // Importing the point ensures x/y encode a real P-256 public key before
    // it is bound into cnf. The imported key is never retained or exported.
    await webcrypto.subtle.importKey(
      "jwk",
      devicePublicJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    throw new DemoNetworkError(
      "INVALID_DEVICE_KEY",
      400,
      "A valid non-private ES256 device public key is required.",
    );
  }
  if (
    input.of_verification?.verified !== true ||
    !HASH_PATTERN.test(input.of_verification.owner_name_hash) ||
    !HASH_PATTERN.test(input.of_verification.customer_ref_hash)
  ) {
    throw new DemoNetworkError(
      "OPEN_FINANCE_VERIFICATION_REQUIRED",
      400,
      "A hashed, verified Open Finance identity is required.",
    );
  }
  return {
    budget_account: input.budget_account,
    device_public_jwk: devicePublicJwk,
    of_verification: {
      customer_ref_hash:
        input.of_verification.customer_ref_hash.toLowerCase(),
      owner_name_hash: input.of_verification.owner_name_hash.toLowerCase(),
      verified: true,
    },
  };
}

export async function issueViL1(
  rawInput: ViL1Input,
  privateJwk: JsonWebKey,
  nowMilliseconds = Date.now(),
): Promise<IssuedViL1> {
  const input = await validateInput(rawInput);
  const publicJwk = publicIssuerJwk(privateJwk);
  const issuedAt = Math.floor(nowMilliseconds / 1_000);
  const claims: ViL1Claims = {
    _sd: [],
    _sd_alg: "sha-256",
    budget_account: input.budget_account,
    cnf: { jwk: input.device_public_jwk },
    exp: issuedAt + L1_LIFETIME_SECONDS,
    iat: issuedAt,
    iss: DEMO_NETWORK_ISSUER_NAME,
    pilot_issuer_name: DEMO_NETWORK_ISSUER_NAME,
    nbf: issuedAt,
    of_customer_ref: input.of_verification.customer_ref_hash,
    of_owner_name_hash: input.of_verification.owner_name_hash,
    of_verified: true,
    sub: input.budget_account,
    vct: VI_L1_VCT,
  };
  const header = {
    alg: "ES256",
    kid: publicJwk.kid,
    typ: "sd+jwt",
  };
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedClaims = base64Url(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const key = await webcrypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await webcrypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      Buffer.from(signingInput, "ascii"),
    ),
  );
  if (signature.length !== 64) {
    throw new DemoNetworkError(
      "VI_ISSUANCE_FAILED",
      500,
      "The Verifiable Intent credential could not be issued.",
    );
  }

  // The trailing '~' is the SD-JWT compact form with no selectively disclosed
  // claims and no key-binding JWT. L1 binds the non-extractable device key in cnf.
  const l1 = `${signingInput}.${base64Url(signature)}~`;
  return {
    digest: createHash("sha256").update(l1, "utf8").digest("hex"),
    expires_at: new Date(claims.exp * 1_000).toISOString(),
    issuer: DEMO_NETWORK_ISSUER_NAME,
    l1,
    public_jwk: publicJwk,
  };
}

export async function verifyViL1(
  compact: string,
  publicJwk: JsonWebKey,
): Promise<ViL1Claims> {
  const serialized = compact.endsWith("~") ? compact.slice(0, -1) : compact;
  const [encodedHeader, encodedClaims, encodedSignature, extra] =
    serialized.split(".");
  if (!encodedHeader || !encodedClaims || !encodedSignature || extra) {
    throw new Error("Invalid L1 compact serialization");
  }
  const header = decodeBase64UrlJson(encodedHeader) as Record<string, unknown>;
  if (header.alg !== "ES256" || header.typ !== "sd+jwt") {
    throw new Error("Invalid L1 protected header");
  }
  const key = await webcrypto.subtle.importKey(
    "jwk",
    assertPublicP256Jwk(publicJwk),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid = await webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    Buffer.from(encodedSignature, "base64url"),
    Buffer.from(`${encodedHeader}.${encodedClaims}`, "ascii"),
  );
  if (!valid) throw new Error("Invalid L1 signature");
  return decodeBase64UrlJson(encodedClaims) as ViL1Claims;
}
