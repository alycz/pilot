import { createHash } from "node:crypto";

export function canonicalJson(input: unknown): string {
  if (input === null || typeof input !== "object") return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(",")}]`;
  const record = input as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function rawProviderPayloadHash(metadataText: string, ohlcText: string): string {
  return sha256Utf8(`kraken-asset-pairs-v1\0${metadataText}\0kraken-ohlc-v1\0${ohlcText}`);
}
