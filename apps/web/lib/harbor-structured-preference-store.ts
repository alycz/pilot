import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  assertNoSensitiveContent,
  MAX_PREFERENCE_STATE_BYTES,
  type StructuredPreferenceScope,
  type StructuredPreferenceStore,
} from "@pilot/vault";

export type HostedPersonalizationResource = "preferences" | "workflow-lessons";

export interface HostedPersonalizationClient {
  readPersonalization(input: {
    version: 1;
    scopeId: string;
    resource: HostedPersonalizationResource;
  }): Promise<{ ciphertext: string | null; contentDigest: string | null }>;
  compareAndSwapPersonalization(input: {
    version: 1;
    scopeId: string;
    resource: HostedPersonalizationResource;
    expectedDigest: string | null;
    contentDigest: string;
    ciphertext: string;
  }): Promise<{ swapped: boolean }>;
}

const VERSION = 1 as const;
const HEX_64 = /^[0-9a-f]{64}$/;
const MAX_CIPHERTEXT_BYTES = Math.ceil(MAX_PREFERENCE_STATE_BYTES * 4 / 3) + 256;

function key(secret: string, purpose: "scope" | "encryption" | "digest"): Buffer {
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 bytes");
  }
  return createHmac("sha256", secret)
    .update(`pilot.hosted-personalization.${purpose}-key.v1`, "utf8")
    .digest();
}

function contentDigest(content: string, digestKey: Buffer): string {
  return createHmac("sha256", digestKey).update(content, "utf8").digest("hex");
}

function validateContent(content: string): void {
  if (Buffer.byteLength(content, "utf8") > MAX_PREFERENCE_STATE_BYTES) {
    throw new Error("Personalization state exceeds its byte limit");
  }
  assertNoSensitiveContent(content);
}

function scopeId(scope: StructuredPreferenceScope, scopeKey: Buffer): string {
  const canonical = JSON.stringify({
    version: VERSION,
    tenantId: scope.tenantId,
    owner: scope.owner,
    network: scope.network,
  });
  return createHmac("sha256", scopeKey).update(canonical, "utf8").digest("hex");
}

function additionalData(
  scopedId: string,
  resource: HostedPersonalizationResource,
  digest: string,
): Buffer {
  return Buffer.from(JSON.stringify({
    version: VERSION,
    scopeId: scopedId,
    resource,
    contentDigest: digest,
  }), "utf8");
}

function seal(
  content: string,
  scopedId: string,
  resource: HostedPersonalizationResource,
  digest: string,
  encryptionKey: Buffer,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(additionalData(scopedId, resource, digest));
  const encrypted = Buffer.concat([cipher.update(content, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")]
    .join(".");
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error("Encrypted personalization state is malformed");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error("Encrypted personalization state is malformed");
  }
  return decoded;
}

function open(
  ciphertext: string,
  scopedId: string,
  resource: HostedPersonalizationResource,
  digest: string,
  encryptionKey: Buffer,
  digestKey: Buffer,
): string {
  if (Buffer.byteLength(ciphertext, "utf8") > MAX_CIPHERTEXT_BYTES) {
    throw new Error("Encrypted personalization state exceeds its byte limit");
  }
  const parts = ciphertext.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Encrypted personalization state has an unsupported envelope");
  }
  let iv: Buffer;
  let tag: Buffer;
  let encrypted: Buffer;
  try {
    iv = decodeBase64Url(parts[1]!);
    tag = decodeBase64Url(parts[2]!);
    encrypted = decodeBase64Url(parts[3]!);
  } catch {
    throw new Error("Encrypted personalization state is malformed");
  }
  if (iv.length !== 12 || tag.length !== 16 || encrypted.length > MAX_PREFERENCE_STATE_BYTES) {
    throw new Error("Encrypted personalization state is malformed");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
    decipher.setAAD(additionalData(scopedId, resource, digest));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    validateContent(plaintext);
    const actualDigest = Buffer.from(contentDigest(plaintext, digestKey), "hex");
    const expectedDigest = Buffer.from(digest, "hex");
    if (actualDigest.length !== expectedDigest.length || !timingSafeEqual(actualDigest, expectedDigest)) {
      throw new Error("Encrypted personalization state digest does not match its content");
    }
    return plaintext;
  } catch (error) {
    if (error instanceof Error && error.message.includes("digest does not match")) throw error;
    if (error instanceof Error && error.message.includes("cannot contain")) throw error;
    if (error instanceof Error && error.message.includes("byte limit")) throw error;
    throw new Error("Encrypted personalization state failed authentication");
  }
}

export class HarborStructuredPreferenceStore implements StructuredPreferenceStore {
  readonly privateStorage = "remote" as const;
  private readonly scopeKey: Buffer;
  private readonly encryptionKey: Buffer;
  private readonly digestKey: Buffer;

  constructor(
    private readonly client: HostedPersonalizationClient,
    sessionSecret: string,
  ) {
    this.scopeKey = key(sessionSecret, "scope");
    this.encryptionKey = key(sessionSecret, "encryption");
    this.digestKey = key(sessionSecret, "digest");
  }

  read(scope: StructuredPreferenceScope): Promise<string | null> {
    return this.readResource(scope, "preferences");
  }

  readWorkflowLessons(scope: StructuredPreferenceScope): Promise<string | null> {
    return this.readResource(scope, "workflow-lessons");
  }

  compareAndSwap(
    scope: StructuredPreferenceScope,
    expected: string | null,
    content: string,
  ): Promise<boolean> {
    return this.compareAndSwapResource(scope, expected, content, "preferences");
  }

  compareAndSwapWorkflowLessons(
    scope: StructuredPreferenceScope,
    expected: string | null,
    content: string,
  ): Promise<boolean> {
    return this.compareAndSwapResource(scope, expected, content, "workflow-lessons");
  }

  private async readResource(
    scope: StructuredPreferenceScope,
    resource: HostedPersonalizationResource,
  ): Promise<string | null> {
    const scopedId = scopeId(scope, this.scopeKey);
    const result = await this.client.readPersonalization({
      version: VERSION,
      scopeId: scopedId,
      resource,
    });
    if (result.ciphertext === null && result.contentDigest === null) return null;
    if (
      result.ciphertext === null ||
      result.contentDigest === null ||
      !HEX_64.test(result.contentDigest)
    ) {
      throw new Error("Harbor returned inconsistent encrypted personalization state");
    }
    return open(
      result.ciphertext,
      scopedId,
      resource,
      result.contentDigest,
      this.encryptionKey,
      this.digestKey,
    );
  }

  private async compareAndSwapResource(
    scope: StructuredPreferenceScope,
    expected: string | null,
    content: string,
    resource: HostedPersonalizationResource,
  ): Promise<boolean> {
    validateContent(content);
    if (expected !== null) validateContent(expected);
    const scopedId = scopeId(scope, this.scopeKey);
    const digest = contentDigest(content, this.digestKey);
    const result = await this.client.compareAndSwapPersonalization({
      version: VERSION,
      scopeId: scopedId,
      resource,
      expectedDigest: expected === null ? null : contentDigest(expected, this.digestKey),
      contentDigest: digest,
      ciphertext: seal(content, scopedId, resource, digest, this.encryptionKey),
    });
    return result.swapped;
  }
}
