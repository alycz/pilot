const encoder = new TextEncoder();

export function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

export function arrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}

export function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function base64UrlText(value: string): string {
  return base64Url(utf8(value));
}

export async function sha256(
  value: string,
  cryptoImpl: Crypto = globalThis.crypto,
): Promise<Uint8Array> {
  return new Uint8Array(
    await cryptoImpl.subtle.digest("SHA-256", arrayBuffer(utf8(value))),
  );
}

export async function sha256Base64Url(
  value: string,
  cryptoImpl: Crypto = globalThis.crypto,
): Promise<string> {
  return base64Url(await sha256(value, cryptoImpl));
}

export async function sha256Hex(
  value: string,
  cryptoImpl: Crypto = globalThis.crypto,
): Promise<string> {
  return Array.from(await sha256(value, cryptoImpl), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
