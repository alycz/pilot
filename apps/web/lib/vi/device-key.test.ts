import { webcrypto } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AP4M_DEVICE_KEY_ID,
  loadOrCreateDeviceKey,
  type DeviceKeyStore,
  type StoredDeviceKey,
} from "./device-key";

class MemoryKeyStore implements DeviceKeyStore {
  value?: StoredDeviceKey;
  puts = 0;

  async get(): Promise<StoredDeviceKey | undefined> {
    return this.value;
  }

  async put(value: StoredDeviceKey): Promise<void> {
    this.puts += 1;
    this.value = value;
  }
}

describe("AP4M device key", () => {
  it("generates one persisted non-extractable ES256 private key", async () => {
    const store = new MemoryKeyStore();
    const first = await loadOrCreateDeviceKey(store, webcrypto as Crypto);
    const second = await loadOrCreateDeviceKey(store, webcrypto as Crypto);

    expect(first.id).toBe(AP4M_DEVICE_KEY_ID);
    expect(first.privateKey.extractable).toBe(false);
    expect(first.privateKey.usages).toEqual(["sign"]);
    expect(first.publicJwk).toMatchObject({ kty: "EC", crv: "P-256" });
    expect(first.publicJwk).not.toHaveProperty("d");
    expect(first.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.privateKey).toBe(first.privateKey);
    expect(second.kid).toBe(first.kid);
    expect(store.puts).toBe(1);
  });

  it("rejects stored extractable private keys", async () => {
    const pair = (await webcrypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const store = new MemoryKeyStore();
    store.value = {
      id: AP4M_DEVICE_KEY_ID,
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
    };
    await expect(
      loadOrCreateDeviceKey(store, webcrypto as Crypto),
    ).rejects.toThrow("Stored AP4M device key is invalid");
  });

  it("rejects a structurally valid but mismatched persisted key pair", async () => {
    const first = (await webcrypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const second = (await webcrypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const store = new MemoryKeyStore();
    store.value = {
      id: AP4M_DEVICE_KEY_ID,
      privateKey: first.privateKey,
      publicKey: second.publicKey,
    };
    await expect(
      loadOrCreateDeviceKey(store, webcrypto as Crypto),
    ).rejects.toThrow("key pair is inconsistent");
  });
});
