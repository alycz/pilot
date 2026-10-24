import { describe, expect, it, vi } from "vitest";

import {
  createKmsKekLoader,
  KmsKekError,
  readKmsMode,
  type KmsEnv,
  type KmsFetch,
} from "../src/aws/kms";

const CIPHERTEXT = Buffer.from("fixed noncredential ciphertext fixture").toString(
  "base64",
);
const PLAINTEXT = Buffer.from(new Uint8Array(32).fill(23)).toString("base64");

const LOCAL_ENV: KmsEnv = {
  KMS_MODE: "kek",
  HARBOR_KEK_CIPHERTEXT: CIPHERTEXT,
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "TESTONLYACCESSKEY",
  AWS_SECRET_ACCESS_KEY: "test-only-secret",
  AWS_ENDPOINT_OVERRIDE: "http://127.0.0.1:8790",
  EXEC_NETWORK: "testnet",
  HARBOR_LOCAL_DEV: "true",
};

const LOCAL_SIGNING_ENV = {
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "LOCAL_STANDIN_ONLY_NOT_A_CREDENTIAL",
  AWS_SECRET_ACCESS_KEY: "local-standin-only-not-a-secret-credential",
  AWS_ENDPOINT_OVERRIDE: "http://127.0.0.1:8790",
  EXEC_NETWORK: "testnet",
  HARBOR_LOCAL_DEV: "true",
};

function respondingFetch(response: unknown): ReturnType<typeof vi.fn<KmsFetch>> {
  return vi.fn<KmsFetch>().mockResolvedValue(response);
}

describe("KMS mode", () => {
  it.each([
    [undefined, "off"],
    ["off", "off"],
    [" kek ", "kek"],
    ["sign", "sign"],
  ] as const)("parses %s as %s", (configured, expected) => {
    expect(readKmsMode({ KMS_MODE: configured })).toBe(expected);
  });

  it("rejects unknown modes without echoing the configured value", () => {
    expect(() => readKmsMode({ KMS_MODE: "credential-shaped-value" })).toThrow(
      KmsKekError,
    );
    try {
      readKmsMode({ KMS_MODE: "credential-shaped-value" });
    } catch (error) {
      expect(String(error)).not.toContain("credential-shaped-value");
      expect(error).toMatchObject({ code: "KMS_INVALID_MODE" });
    }
  });
});

describe("KMS KEK loading", () => {
  it.each(["off", "sign"] as const)(
    "does not decrypt in %s mode",
    async (mode) => {
      const fetch = respondingFetch({ Plaintext: PLAINTEXT });
      const load = createKmsKekLoader({ fetch });

      await expect(load({ ...LOCAL_ENV, KMS_MODE: mode })).rejects.toMatchObject({
        code: "KMS_KEK_MODE_REQUIRED",
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("requires ciphertext before making a KMS request", async () => {
    const fetch = respondingFetch({ Plaintext: PLAINTEXT });
    const load = createKmsKekLoader({ fetch });

    await expect(
      load({ ...LOCAL_ENV, HARBOR_KEK_CIPHERTEXT: "" }),
    ).rejects.toMatchObject({ code: "KMS_CIPHERTEXT_MISSING" });
    await expect(
      load({ ...LOCAL_ENV, HARBOR_KEK_CIPHERTEXT: "not base64" }),
    ).rejects.toMatchObject({ code: "KMS_CIPHERTEXT_INVALID" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("decrypts through KMS and imports a non-extractable AES-GCM key", async () => {
    const fetch = respondingFetch({ Plaintext: PLAINTEXT });
    const load = createKmsKekLoader({ fetch });

    const key = await load(LOCAL_ENV);

    expect(key).toMatchObject({
      extractable: false,
      algorithm: { name: "AES-GCM" },
      usages: ["encrypt", "decrypt"],
    });
    expect(fetch).toHaveBeenCalledWith(
      "kms",
      "TrentService.Decrypt",
      {
        CiphertextBlob: CIPHERTEXT,
        KeyId: "alias/harbor/kek",
        EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
      },
      { env: LOCAL_SIGNING_ENV },
    );
  });

  it("strips every configured credential from local stand-in requests", async () => {
    const fetch = respondingFetch({ Plaintext: PLAINTEXT });
    const load = createKmsKekLoader({ fetch });
    const env: KmsEnv = {
      ...LOCAL_ENV,
      AWS_ACCESS_KEY_ID: "configured-access-sentinel",
      AWS_SECRET_ACCESS_KEY: "configured-secret-sentinel",
      AWS_SESSION_TOKEN: "configured-session-sentinel",
    };

    await load(env);

    const options = fetch.mock.calls[0]?.[3];
    expect(options).toEqual({ env: LOCAL_SIGNING_ENV });
    expect(JSON.stringify(options)).not.toContain("configured-access-sentinel");
    expect(JSON.stringify(options)).not.toContain("configured-secret-sentinel");
    expect(JSON.stringify(options)).not.toContain("configured-session-sentinel");
    expect(options?.env).not.toHaveProperty("AWS_SESSION_TOKEN");
    expect(options?.env).not.toHaveProperty("KMS_MODE");
    expect(options?.env).not.toHaveProperty("HARBOR_KEK_CIPHERTEXT");
  });

  it("preserves explicitly supplied event-day signing fields without an override", async () => {
    const fetch = respondingFetch({ Plaintext: PLAINTEXT });
    const load = createKmsKekLoader({ fetch });
    const env: KmsEnv = {
      ...LOCAL_ENV,
      AWS_ENDPOINT_OVERRIDE: undefined,
      AWS_ACCESS_KEY_ID: "event-day-access-sentinel",
      AWS_SECRET_ACCESS_KEY: "event-day-secret-sentinel",
      AWS_SESSION_TOKEN: "event-day-session-sentinel",
    };

    await load(env);

    expect(fetch.mock.calls[0]?.[3]).toEqual({
      env: {
        AWS_REGION: "us-east-1",
        AWS_ENDPOINT_OVERRIDE: undefined,
        EXEC_NETWORK: "testnet",
        HARBOR_LOCAL_DEV: "true",
        AWS_ACCESS_KEY_ID: "event-day-access-sentinel",
        AWS_SECRET_ACCESS_KEY: "event-day-secret-sentinel",
        AWS_SESSION_TOKEN: "event-day-session-sentinel",
      },
    });
  });

  it("shares one decrypt/import across concurrent and repeated loads", async () => {
    let resolveResponse: ((value: unknown) => void) | undefined;
    const response = new Promise<unknown>((resolve) => {
      resolveResponse = resolve;
    });
    const fetch = vi.fn<KmsFetch>().mockReturnValue(response);
    const load = createKmsKekLoader({ fetch });

    const first = load(LOCAL_ENV);
    const second = load(LOCAL_ENV);
    expect(fetch).toHaveBeenCalledOnce();
    resolveResponse?.({ Plaintext: PLAINTEXT });

    const [firstKey, secondKey] = await Promise.all([first, second]);
    expect(firstKey).toBe(secondKey);
    expect(await load(LOCAL_ENV)).toBe(firstKey);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("clears a failed cache entry so a later attempt can retry", async () => {
    const fetch = vi
      .fn<KmsFetch>()
      .mockResolvedValueOnce({ Plaintext: "invalid" })
      .mockResolvedValueOnce({ Plaintext: PLAINTEXT });
    const load = createKmsKekLoader({ fetch });

    await expect(load(LOCAL_ENV)).rejects.toMatchObject({
      code: "KMS_KEK_INVALID",
    });
    await expect(load(LOCAL_ENV)).resolves.toMatchObject({
      extractable: false,
      algorithm: { name: "AES-GCM" },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    undefined,
    null,
    {},
    { Plaintext: 23 },
  ])("rejects malformed decrypt response %#", async (response) => {
    const load = createKmsKekLoader({ fetch: respondingFetch(response) });
    await expect(load(LOCAL_ENV)).rejects.toMatchObject({
      code: "KMS_DECRYPT_RESPONSE_INVALID",
    });
  });

  it.each([31, 33])("rejects a %i-byte plaintext KEK", async (length) => {
    const plaintext = Buffer.from(new Uint8Array(length).fill(7)).toString(
      "base64",
    );
    const load = createKmsKekLoader({
      fetch: respondingFetch({ Plaintext: plaintext }),
    });

    await expect(load(LOCAL_ENV)).rejects.toMatchObject({
      code: "KMS_KEK_INVALID",
    });
  });

  it("zeroes plaintext bytes after importing the key", async () => {
    let importedBytes: Uint8Array | undefined;
    const importKey = vi.fn(async (
      _format: KeyFormat,
      keyData: BufferSource,
    ): Promise<CryptoKey> => {
      importedBytes = keyData as Uint8Array;
      const copy = new Uint8Array(importedBytes);
      return globalThis.crypto.subtle.importKey(
        "raw",
        copy,
        "AES-GCM",
        false,
        ["encrypt", "decrypt"],
      );
    });
    const cryptoImpl = {
      subtle: { importKey },
    } as unknown as Crypto;
    const load = createKmsKekLoader({
      fetch: respondingFetch({ Plaintext: PLAINTEXT }),
      crypto: cryptoImpl,
    });

    await load(LOCAL_ENV);

    expect(importKey).toHaveBeenCalledOnce();
    expect(importedBytes).toBeDefined();
    expect([...importedBytes!]).toEqual(new Array(32).fill(0));
  });

  it("normalizes transport and import failures without upstream details", async () => {
    const fetch = vi
      .fn<KmsFetch>()
      .mockRejectedValue(new Error("credential-shaped transport detail"));
    const loadTransport = createKmsKekLoader({ fetch });
    let transportError: unknown;
    try {
      await loadTransport(LOCAL_ENV);
    } catch (error) {
      transportError = error;
    }
    expect(transportError).toMatchObject({ code: "KMS_DECRYPT_FAILED" });
    expect(String(transportError)).not.toContain("credential-shaped");

    const cryptoImpl = {
      subtle: {
        importKey: vi
          .fn()
          .mockRejectedValue(new Error("plaintext-shaped import detail")),
      },
    } as unknown as Crypto;
    const loadImport = createKmsKekLoader({
      fetch: respondingFetch({ Plaintext: PLAINTEXT }),
      crypto: cryptoImpl,
    });
    let importError: unknown;
    try {
      await loadImport(LOCAL_ENV);
    } catch (error) {
      importError = error;
    }
    expect(importError).toMatchObject({ code: "KMS_KEK_IMPORT_FAILED" });
    expect(String(importError)).not.toContain("plaintext-shaped");
  });
});
