import { arrayBuffer, canonicalJson, sha256Base64Url } from "./encoding";

const DATABASE_NAME = "pilot-ap4m";
const STORE_NAME = "device-keys";
export const AP4M_DEVICE_KEY_ID = "ap4m-vi-device-es256-v1";

export interface StoredDeviceKey {
  id: typeof AP4M_DEVICE_KEY_ID;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

export interface DeviceKeyStore {
  get(id: typeof AP4M_DEVICE_KEY_ID): Promise<StoredDeviceKey | undefined>;
  put(value: StoredDeviceKey): Promise<void>;
}

export interface DeviceKey {
  id: typeof AP4M_DEVICE_KEY_ID;
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export class IndexedDbDeviceKeyStore implements DeviceKeyStore {
  constructor(private readonly indexedDb: IDBFactory = globalThis.indexedDB) {}

  private async database(): Promise<IDBDatabase> {
    if (!this.indexedDb) throw new Error("IndexedDB is unavailable");
    const request = this.indexedDb.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    return requestResult(request);
  }

  async get(id: typeof AP4M_DEVICE_KEY_ID): Promise<StoredDeviceKey | undefined> {
    const database = await this.database();
    try {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const completed = transactionComplete(transaction);
      const value = await requestResult(
        transaction.objectStore(STORE_NAME).get(id) as IDBRequest<StoredDeviceKey | undefined>,
      );
      await completed;
      return value;
    } finally {
      database.close();
    }
  }

  async put(value: StoredDeviceKey): Promise<void> {
    const database = await this.database();
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const completed = transactionComplete(transaction);
      transaction.objectStore(STORE_NAME).put(value);
      await completed;
    } finally {
      database.close();
    }
  }
}

function assertKeyPair(value: StoredDeviceKey): void {
  if (
    value.privateKey.type !== "private" ||
    value.privateKey.extractable ||
    !value.privateKey.usages.includes("sign") ||
    value.publicKey.type !== "public" ||
    !value.publicKey.usages.includes("verify")
  ) {
    throw new Error("Stored AP4M device key is invalid");
  }
}

async function assertCoherentKeyPair(
  value: StoredDeviceKey,
  cryptoImpl: Crypto,
): Promise<void> {
  assertKeyPair(value);
  const challenge = arrayBuffer(
    new TextEncoder().encode("pilot-ap4m-device-key-check-v1"),
  );
  try {
    const signature = await cryptoImpl.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      value.privateKey,
      challenge,
    );
    const valid = await cryptoImpl.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      value.publicKey,
      signature,
      challenge,
    );
    if (!valid) throw new Error("key mismatch");
  } catch {
    throw new Error("Stored AP4M device key pair is inconsistent");
  }
}

function publicP256Jwk(value: JsonWebKey): JsonWebKey {
  if (
    value.kty !== "EC" ||
    value.crv !== "P-256" ||
    typeof value.x !== "string" ||
    typeof value.y !== "string" ||
    value.d !== undefined
  ) {
    throw new Error("AP4M device public key is invalid");
  }
  return { kty: "EC", crv: "P-256", x: value.x, y: value.y };
}

export async function jwkThumbprint(
  jwk: JsonWebKey,
  cryptoImpl: Crypto = globalThis.crypto,
): Promise<string> {
  const publicJwk = publicP256Jwk(jwk);
  return sha256Base64Url(canonicalJson(publicJwk), cryptoImpl);
}

async function loadOrCreate(
  store: DeviceKeyStore,
  cryptoImpl: Crypto = globalThis.crypto,
): Promise<DeviceKey> {
  let stored = await store.get(AP4M_DEVICE_KEY_ID);
  if (!stored) {
    const pair = (await cryptoImpl.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    stored = {
      id: AP4M_DEVICE_KEY_ID,
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
    };
    await assertCoherentKeyPair(stored, cryptoImpl);
    await store.put(stored);
  }
  await assertCoherentKeyPair(stored, cryptoImpl);
  const publicJwk = publicP256Jwk(
    await cryptoImpl.subtle.exportKey("jwk", stored.publicKey),
  );
  return {
    id: AP4M_DEVICE_KEY_ID,
    kid: await jwkThumbprint(publicJwk, cryptoImpl),
    privateKey: stored.privateKey,
    publicJwk,
  };
}

let defaultDeviceKeyPromise: Promise<DeviceKey> | undefined;

export function loadOrCreateDeviceKey(
  store?: DeviceKeyStore,
  cryptoImpl: Crypto = globalThis.crypto,
): Promise<DeviceKey> {
  if (store) return loadOrCreate(store, cryptoImpl);
  defaultDeviceKeyPromise ??= loadOrCreate(
    new IndexedDbDeviceKeyStore(),
    cryptoImpl,
  ).catch((error: unknown) => {
    defaultDeviceKeyPromise = undefined;
    throw error;
  });
  return defaultDeviceKeyPromise;
}
