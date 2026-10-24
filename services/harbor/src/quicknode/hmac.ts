const MAX_TIMESTAMP_AGE_SECONDS = 300;

export interface QuickNodeNonceStore {
  /** Atomically records the nonce and returns false when it already exists. */
  claim(nonce: string, receivedAt: string): Promise<boolean>;
}

export type QuickNodeVerification =
  | {
      status: "verified";
      body: Uint8Array;
      text: string;
    }
  | { status: "dup" }
  | {
      status: "rejected";
      reason: "invalid_headers" | "invalid_signature" | "stale" | "invalid_body";
    };

export type VerifyQuickNodeOptions = {
  nonceStore: QuickNodeNonceStore;
  now?: Date;
};

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function decompressedBody(rawBody: Uint8Array): Promise<Uint8Array> {
  if (rawBody[0] !== 0x1f || rawBody[1] !== 0x8b) return rawBody;

  try {
    const stream = new Response(exactArrayBuffer(rawBody)).body;
    if (!stream) throw new Error("missing response stream");
    const decompressed = stream.pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(decompressed).arrayBuffer());
  } catch {
    throw new Error("invalid gzip body");
  }
}

function decodeHex(value: string): Uint8Array | undefined {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) return undefined;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.byteLength ^ right.byteLength;
  const length = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function timestampSeconds(value: string): number | undefined {
  if (!/^\d{10}$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Verify one QuickNode webhook or Streams delivery.
 *
 * QuickNode signs `nonce + timestamp + decompressed payload` with HMAC-SHA256.
 * The nonce is claimed only after authentication succeeds, so an unauthenticated
 * request cannot consume a legitimate delivery's nonce.
 */
export async function verifyQuickNode(
  secret: string,
  rawBody: Uint8Array,
  nonce: string,
  timestamp: string,
  signature: string,
  options: VerifyQuickNodeOptions,
): Promise<QuickNodeVerification> {
  const seconds = timestampSeconds(timestamp);
  if (!secret || !nonce || nonce.length > 256 || seconds === undefined) {
    return { status: "rejected", reason: "invalid_headers" };
  }

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1_000);
  if (Math.abs(nowSeconds - seconds) > MAX_TIMESTAMP_AGE_SECONDS) {
    return { status: "rejected", reason: "stale" };
  }

  let body: Uint8Array;
  let text: string;
  try {
    body = await decompressedBody(rawBody);
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body);
  } catch {
    return { status: "rejected", reason: "invalid_body" };
  }

  const supplied = decodeHex(signature);
  if (!supplied) {
    return { status: "rejected", reason: "invalid_signature" };
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${nonce}${timestamp}${text}`),
    ),
  );
  if (!constantTimeEqual(expected, supplied)) {
    return { status: "rejected", reason: "invalid_signature" };
  }

  const receivedAt = new Date(nowSeconds * 1_000).toISOString();
  if (!(await options.nonceStore.claim(nonce, receivedAt))) {
    return { status: "dup" };
  }

  return { status: "verified", body, text };
}
