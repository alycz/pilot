import {
  awsFetch,
  type AwsFetchEnv,
  type AwsFetchOptions,
  type AwsRequestBody,
} from "./sigv4";

const KEK_BYTES = 32;
const LOCAL_STANDIN_ACCESS_KEY_ID = "LOCAL_STANDIN_ONLY_NOT_A_CREDENTIAL";
const LOCAL_STANDIN_SECRET_ACCESS_KEY =
  "local-standin-only-not-a-secret-credential";

export type KmsMode = "off" | "kek" | "sign";

export type KmsEnv = AwsFetchEnv & {
  KMS_MODE?: string;
  HARBOR_KEK_CIPHERTEXT?: string;
};

export type KmsFetch = (
  service: string,
  target: string,
  body: AwsRequestBody,
  options: AwsFetchOptions,
) => Promise<unknown>;

export type KmsKekLoaderDependencies = {
  fetch?: KmsFetch;
  crypto?: Crypto;
};

export type KmsKekErrorCode =
  | "KMS_INVALID_MODE"
  | "KMS_KEK_MODE_REQUIRED"
  | "KMS_CIPHERTEXT_MISSING"
  | "KMS_CIPHERTEXT_INVALID"
  | "KMS_DECRYPT_FAILED"
  | "KMS_DECRYPT_RESPONSE_INVALID"
  | "KMS_KEK_INVALID"
  | "KMS_KEK_IMPORT_FAILED";

/** Secret-safe KMS configuration/decryption error. */
export class KmsKekError extends Error {
  constructor(readonly code: KmsKekErrorCode) {
    super(messageFor(code));
    this.name = "KmsKekError";
  }
}

function messageFor(code: KmsKekErrorCode): string {
  switch (code) {
    case "KMS_INVALID_MODE":
      return "KMS_MODE must be off, kek, or sign";
    case "KMS_KEK_MODE_REQUIRED":
      return "KMS KEK loading is not enabled";
    case "KMS_CIPHERTEXT_MISSING":
      return "HARBOR_KEK_CIPHERTEXT is required in KMS KEK mode";
    case "KMS_CIPHERTEXT_INVALID":
      return "HARBOR_KEK_CIPHERTEXT is invalid";
    case "KMS_DECRYPT_FAILED":
      return "KMS could not decrypt the Harbor KEK";
    case "KMS_DECRYPT_RESPONSE_INVALID":
      return "KMS returned an invalid decrypt response";
    case "KMS_KEK_INVALID":
      return "KMS returned an invalid Harbor KEK";
    case "KMS_KEK_IMPORT_FAILED":
      return "The Harbor KEK could not be imported";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalBase64(value: string): boolean {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    return false;
  }
  try {
    const decoded = atob(value);
    return btoa(decoded) === value;
  } catch {
    return false;
  }
}

function ciphertextFor(env: KmsEnv): string {
  const value = env.HARBOR_KEK_CIPHERTEXT?.trim();
  if (!value) throw new KmsKekError("KMS_CIPHERTEXT_MISSING");
  if (value.length > 16_384 || !isCanonicalBase64(value)) {
    throw new KmsKekError("KMS_CIPHERTEXT_INVALID");
  }
  return value;
}

function plaintextFrom(response: unknown): Uint8Array {
  if (!isRecord(response) || typeof response.Plaintext !== "string") {
    throw new KmsKekError("KMS_DECRYPT_RESPONSE_INVALID");
  }
  const encoded = response.Plaintext;
  if (!isCanonicalBase64(encoded)) {
    throw new KmsKekError("KMS_KEK_INVALID");
  }
  const decoded = Uint8Array.from(atob(encoded), (character) =>
    character.charCodeAt(0),
  );
  if (decoded.byteLength !== KEK_BYTES) {
    decoded.fill(0);
    throw new KmsKekError("KMS_KEK_INVALID");
  }
  return decoded;
}

function validImportedKek(key: CryptoKey): boolean {
  return (
    key.extractable === false &&
    key.algorithm.name === "AES-GCM" &&
    key.usages.length === 2 &&
    key.usages.includes("encrypt") &&
    key.usages.includes("decrypt")
  );
}

function signingEnvFor(env: KmsEnv): AwsFetchEnv {
  const common: AwsFetchEnv = {
    AWS_REGION: env.AWS_REGION,
    AWS_ENDPOINT_OVERRIDE: env.AWS_ENDPOINT_OVERRIDE,
    EXEC_NETWORK: env.EXEC_NETWORK,
    HARBOR_LOCAL_DEV: env.HARBOR_LOCAL_DEV,
  };

  if (env.AWS_ENDPOINT_OVERRIDE) {
    return {
      ...common,
      AWS_ACCESS_KEY_ID: LOCAL_STANDIN_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: LOCAL_STANDIN_SECRET_ACCESS_KEY,
    };
  }

  return {
    ...common,
    AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
    AWS_SESSION_TOKEN: env.AWS_SESSION_TOKEN,
  };
}

export function readKmsMode(env: Pick<KmsEnv, "KMS_MODE">): KmsMode {
  const mode = env.KMS_MODE?.trim() || "off";
  if (mode !== "off" && mode !== "kek" && mode !== "sign") {
    throw new KmsKekError("KMS_INVALID_MODE");
  }
  return mode;
}

/**
 * Validate the synchronous KMS deployment settings before the Worker serves
 * any route. This deliberately performs no decrypt and makes no AWS request.
 */
export function validateKmsConfig(
  env: Pick<KmsEnv, "KMS_MODE" | "HARBOR_KEK_CIPHERTEXT">,
): KmsMode {
  const mode = readKmsMode(env);
  if (mode === "kek") ciphertextFor(env);
  return mode;
}

/**
 * Create an isolate-scoped KEK loader. The default export below owns the
 * production cache; tests can create independent loaders without exposing or
 * resetting cached key material.
 */
export function createKmsKekLoader(
  dependencies: KmsKekLoaderDependencies = {},
): (env: KmsEnv) => Promise<CryptoKey> {
  const fetchKms = dependencies.fetch ?? awsFetch;
  const cryptoImpl = dependencies.crypto ?? crypto;
  let cached: Promise<CryptoKey> | undefined;

  return async (env: KmsEnv): Promise<CryptoKey> => {
    if (readKmsMode(env) !== "kek") {
      throw new KmsKekError("KMS_KEK_MODE_REQUIRED");
    }
    const ciphertext = ciphertextFor(env);
    if (cached) return cached;

    const pending = (async () => {
      let response: unknown;
      try {
        response = await fetchKms(
          "kms",
          "TrentService.Decrypt",
          {
            CiphertextBlob: ciphertext,
            KeyId: "alias/harbor/kek",
            EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
          },
          { env: signingEnvFor(env) },
        );
      } catch {
        throw new KmsKekError("KMS_DECRYPT_FAILED");
      }

      const plaintext = plaintextFrom(response);
      try {
        const key = await cryptoImpl.subtle.importKey(
          "raw",
          plaintext,
          "AES-GCM",
          false,
          ["encrypt", "decrypt"],
        );
        if (!validImportedKek(key)) {
          throw new KmsKekError("KMS_KEK_IMPORT_FAILED");
        }
        return key;
      } catch (error) {
        if (error instanceof KmsKekError) throw error;
        throw new KmsKekError("KMS_KEK_IMPORT_FAILED");
      } finally {
        plaintext.fill(0);
      }
    })();

    cached = pending;
    void pending.catch(() => {
      if (cached === pending) cached = undefined;
    });
    return pending;
  };
}

export const loadKmsKek = createKmsKekLoader();
