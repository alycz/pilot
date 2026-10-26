import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";

const NEP413_TAG = 2 ** 31 + 413;
const RPC_URL = "https://rpc.mainnet.near.org/";
const RPC_ID = "pilot-nep413-full-access-key-v1";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1_024;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_VALUES = new Map(
  Array.from(BASE58_ALPHABET, (character, index) => [character, index]),
);
const ACCOUNT_ID_PATTERN = /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const BASE64_SIGNATURE_PATTERN =
  /^(?:[A-Za-z0-9+/]{4}){21}(?:[A-Za-z0-9+/]{2}==)$/;

export type NearNep413VerifierInput = Readonly<{
  accountId: string;
  publicKey: string;
  signature: string;
  message: string;
  nonce: Uint8Array;
  recipient: string;
}>;

export type NearNep413VerifierResult = Readonly<{
  accountId: string;
  publicKey: string;
  signatureValid: true;
  fullAccessKeyVerified: true;
}>;

export type NearNep413VerifierErrorCode =
  | "INPUT_INVALID"
  | "SIGNATURE_INVALID"
  | "RPC_UNAVAILABLE"
  | "RPC_PROTOCOL_INVALID"
  | "FULL_ACCESS_KEY_REQUIRED";

export class NearNep413VerifierError extends Error {
  constructor(
    readonly code: NearNep413VerifierErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NearNep413VerifierError";
  }
}

export type NearNep413VerifierDependencies = Readonly<{
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}>;

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new NearNep413VerifierError(
      "INPUT_INVALID",
      "The NEP-413 verifier limit is invalid.",
    );
  }
  return resolved;
}

function exactAccountId(value: string): string {
  if (!ACCOUNT_ID_PATTERN.test(value)) {
    throw new NearNep413VerifierError("INPUT_INVALID", "The NEAR account ID is invalid.");
  }
  return value;
}

function decodeBase58(value: string): Uint8Array {
  if (value.length === 0 || value.length > 64) {
    throw new NearNep413VerifierError("INPUT_INVALID", "The NEAR public key is invalid.");
  }
  const littleEndian: number[] = [];
  for (const character of value) {
    const digit = BASE58_VALUES.get(character);
    if (digit === undefined) {
      throw new NearNep413VerifierError("INPUT_INVALID", "The NEAR public key is invalid.");
    }
    let carry = digit;
    for (let index = 0; index < littleEndian.length; index += 1) {
      const next = littleEndian[index] * 58 + carry;
      littleEndian[index] = next & 0xff;
      carry = next >>> 8;
    }
    while (carry > 0) {
      littleEndian.push(carry & 0xff);
      carry >>>= 8;
    }
  }
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === "1") {
    leadingZeroes += 1;
  }
  const decoded = new Uint8Array(leadingZeroes + littleEndian.length);
  for (let index = 0; index < littleEndian.length; index += 1) {
    decoded[decoded.length - 1 - index] = littleEndian[index];
  }
  return decoded;
}

function decodeEd25519PublicKey(value: string): Uint8Array {
  if (!value.startsWith("ed25519:") || value.indexOf(":", 8) !== -1) {
    throw new NearNep413VerifierError(
      "INPUT_INVALID",
      "Only an ed25519 NEAR public key is supported.",
    );
  }
  const decoded = decodeBase58(value.slice(8));
  if (decoded.length !== 32) {
    throw new NearNep413VerifierError(
      "INPUT_INVALID",
      "The ed25519 NEAR public key must contain 32 bytes.",
    );
  }
  return decoded;
}

function decodeSignature(value: string): Buffer {
  if (!BASE64_SIGNATURE_PATTERN.test(value)) {
    throw new NearNep413VerifierError(
      "INPUT_INVALID",
      "The NEP-413 signature encoding is invalid.",
    );
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 64 || decoded.toString("base64") !== value) {
    throw new NearNep413VerifierError(
      "INPUT_INVALID",
      "The NEP-413 signature encoding is invalid.",
    );
  }
  return decoded;
}

function u32LittleEndian(value: number): Buffer {
  const encoded = Buffer.allocUnsafe(4);
  encoded.writeUInt32LE(value, 0);
  return encoded;
}

function borshString(value: string): Buffer {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > 65_535) {
    throw new NearNep413VerifierError("INPUT_INVALID", "The NEP-413 string is too long.");
  }
  return Buffer.concat([u32LittleEndian(encoded.length), encoded]);
}

/** Exact NEP-413 payload with callbackUrl fixed to None. */
export function encodeNearNep413Payload(input: Readonly<{
  message: string;
  nonce: Uint8Array;
  recipient: string;
}>): Buffer {
  if (typeof input.message !== "string" || input.message.length === 0) {
    throw new NearNep413VerifierError("INPUT_INVALID", "The NEP-413 message is invalid.");
  }
  if (!(input.nonce instanceof Uint8Array) || input.nonce.byteLength !== 32) {
    throw new NearNep413VerifierError(
      "INPUT_INVALID",
      "The NEP-413 nonce must contain exactly 32 bytes.",
    );
  }
  exactAccountId(input.recipient);
  return Buffer.concat([
    u32LittleEndian(NEP413_TAG),
    borshString(input.message),
    Buffer.from(input.nonce),
    borshString(input.recipient),
    Buffer.of(0),
  ]);
}

export function hashNearNep413Payload(input: Readonly<{
  message: string;
  nonce: Uint8Array;
  recipient: string;
}>): Buffer {
  return createHash("sha256").update(encodeNearNep413Payload(input)).digest();
}

async function readBoundedJson(response: Response, maximum: number): Promise<unknown> {
  const contentType = response.headers.get("content-type")
    ?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new NearNep413VerifierError(
      "RPC_PROTOCOL_INVALID",
      "The NEAR RPC response is not JSON.",
    );
  }
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^(?:0|[1-9][0-9]*)$/.test(contentLength) || Number(contentLength) > maximum)
  ) {
    throw new NearNep413VerifierError(
      "RPC_PROTOCOL_INVALID",
      "The NEAR RPC response is too large.",
    );
  }
  if (!response.body) {
    throw new NearNep413VerifierError(
      "RPC_PROTOCOL_INVALID",
      "The NEAR RPC response body is unavailable.",
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new NearNep413VerifierError(
          "RPC_PROTOCOL_INVALID",
          "The NEAR RPC response is too large.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new NearNep413VerifierError(
      "RPC_PROTOCOL_INVALID",
      "The NEAR RPC response encoding is invalid.",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new NearNep413VerifierError(
      "RPC_PROTOCOL_INVALID",
      "The NEAR RPC response JSON is invalid.",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function verifyFullAccessKey(
  accountId: string,
  publicKey: string,
  dependencies: Required<NearNep413VerifierDependencies>,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs);
  try {
    const response = await dependencies.fetch(RPC_URL, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: RPC_ID,
        method: "query",
        params: {
          request_type: "view_access_key",
          finality: "final",
          account_id: accountId,
          public_key: publicKey,
        },
      }),
    });
    if (
      !response.ok ||
      response.redirected ||
      (response.url !== "" && response.url !== RPC_URL)
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new NearNep413VerifierError(
        "RPC_PROTOCOL_INVALID",
        "The NEAR RPC response was rejected.",
      );
    }
    const payload = await readBoundedJson(response, dependencies.maxResponseBytes);
    if (
      !isRecord(payload) ||
      payload.jsonrpc !== "2.0" ||
      payload.id !== RPC_ID ||
      "error" in payload ||
      !isRecord(payload.result)
    ) {
      throw new NearNep413VerifierError(
        "RPC_PROTOCOL_INVALID",
        "The NEAR RPC response envelope is invalid.",
      );
    }
    if (payload.result.permission !== "FullAccess") {
      throw new NearNep413VerifierError(
        "FULL_ACCESS_KEY_REQUIRED",
        "The NEP-413 public key is not a full-access key for this account.",
      );
    }
  } catch (error) {
    if (error instanceof NearNep413VerifierError) throw error;
    throw new NearNep413VerifierError("RPC_UNAVAILABLE", "The NEAR RPC is unavailable.");
  } finally {
    clearTimeout(timeout);
  }
}

export function createNearNep413FullAccessKeyVerifier(
  options: NearNep413VerifierDependencies = {},
): Readonly<{ verify(input: NearNep413VerifierInput): Promise<NearNep413VerifierResult> }> {
  const dependencies: Required<NearNep413VerifierDependencies> = {
    fetch: options.fetch ?? fetch,
    timeoutMs: boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 100, 30_000),
    maxResponseBytes: boundedInteger(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      1_024,
      256 * 1_024,
    ),
  };
  return Object.freeze({
    async verify(input) {
      const accountId = exactAccountId(input.accountId);
      const recipient = exactAccountId(input.recipient);
      if (typeof input.message !== "string" || input.message.length === 0) {
        throw new NearNep413VerifierError("INPUT_INVALID", "The NEP-413 message is invalid.");
      }
      const rawPublicKey = decodeEd25519PublicKey(input.publicKey);
      const signature = decodeSignature(input.signature);
      const digest = hashNearNep413Payload({
        message: input.message,
        nonce: input.nonce,
        recipient,
      });
      const publicKey = createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawPublicKey)]),
        format: "der",
        type: "spki",
      });
      let signatureValid = false;
      try {
        signatureValid = verifySignature(null, digest, publicKey, signature);
      } catch {
        signatureValid = false;
      }
      if (!signatureValid) {
        throw new NearNep413VerifierError(
          "SIGNATURE_INVALID",
          "The NEP-413 signature is invalid.",
        );
      }
      await verifyFullAccessKey(accountId, input.publicKey, dependencies);
      return Object.freeze({
        accountId,
        publicKey: input.publicKey,
        signatureValid: true,
        fullAccessKeyVerified: true,
      });
    },
  });
}
