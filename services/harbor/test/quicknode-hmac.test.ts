import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  verifyQuickNode,
  type QuickNodeNonceStore,
} from "../src/quicknode/hmac";

const SECRET = "local-fixture-token";
const NOW = new Date("2026-10-21T18:00:00.000Z");
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1_000));

class MemoryNonceStore implements QuickNodeNonceStore {
  readonly nonces = new Set<string>();

  async claim(nonce: string): Promise<boolean> {
    if (this.nonces.has(nonce)) return false;
    this.nonces.add(nonce);
    return true;
  }
}

async function signature(nonce: string, timestamp: string, body: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${nonce}${timestamp}${body}`),
    ),
  );
  return Array.from(signed, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("QuickNode HMAC verification", () => {
  it("accepts an authentic delivery once, then reports the nonce as a duplicate", async () => {
    const nonceStore = new MemoryNonceStore();
    const body = JSON.stringify({ data: [{ hash: "ABC" }] });
    const nonce = "delivery-1";
    const sig = await signature(nonce, TIMESTAMP, body);
    const options = { nonceStore, now: NOW };

    await expect(
      verifyQuickNode(SECRET, new TextEncoder().encode(body), nonce, TIMESTAMP, sig, options),
    ).resolves.toMatchObject({ status: "verified", text: body });
    await expect(
      verifyQuickNode(SECRET, new TextEncoder().encode(body), nonce, TIMESTAMP, sig, options),
    ).resolves.toEqual({ status: "dup" });
  });

  it("rejects tampering and does not consume the nonce", async () => {
    const nonceStore = new MemoryNonceStore();
    const nonce = "delivery-2";
    const sig = await signature(nonce, TIMESTAMP, '{"ok":true}');

    await expect(
      verifyQuickNode(
        SECRET,
        new TextEncoder().encode('{"ok":false}'),
        nonce,
        TIMESTAMP,
        sig,
        { nonceStore, now: NOW },
      ),
    ).resolves.toEqual({ status: "rejected", reason: "invalid_signature" });
    expect(nonceStore.nonces.size).toBe(0);
  });

  it("rejects stale or implausibly future timestamps", async () => {
    const nonceStore = new MemoryNonceStore();
    const body = "{}";
    for (const timestamp of [
      String(Number(TIMESTAMP) - 301),
      String(Number(TIMESTAMP) + 301),
    ]) {
      await expect(
        verifyQuickNode(
          SECRET,
          new TextEncoder().encode(body),
          `nonce-${timestamp}`,
          timestamp,
          await signature(`nonce-${timestamp}`, timestamp, body),
          { nonceStore, now: NOW },
        ),
      ).resolves.toEqual({ status: "rejected", reason: "stale" });
    }
  });

  it("decompresses gzip before verifying and returns the decompressed payload", async () => {
    const nonceStore = new MemoryNonceStore();
    const body = JSON.stringify({ compressed: true });
    const nonce = "gzip-delivery";
    const result = await verifyQuickNode(
      SECRET,
      gzipSync(body),
      nonce,
      TIMESTAMP,
      await signature(nonce, TIMESTAMP, body),
      { nonceStore, now: NOW },
    );

    expect(result).toMatchObject({ status: "verified", text: body });
    if (result.status === "verified") {
      expect(new TextDecoder().decode(result.body)).toBe(body);
    }
  });
});
