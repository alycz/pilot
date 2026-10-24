import { randomBytes as nodeRandomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AwsClient } from "aws4fetch";

const KEK_ALIAS = "alias/harbor/kek";
const ENV_NAME = "HARBOR_KEK_CIPHERTEXT";
const MAX_CIPHERTEXT_BASE64_LENGTH = 16_384;
const LOCAL_SIGNING_FIXTURE = Object.freeze({
  AWS_ACCESS_KEY_ID: "AWSLOCALTESTONLY",
  AWS_SECRET_ACCESS_KEY: "aws-local-test-only-not-a-credential",
});

type AwsFetch = (
  service: string,
  target: string,
  body: AwsRequestBody,
  options: AwsFetchOptions,
) => Promise<unknown>;

type AwsRequestBody = Readonly<Record<string, unknown>>;

export type CreateKekEnv = {
  AWS_REGION?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_SESSION_TOKEN?: string;
  AWS_ENDPOINT_OVERRIDE?: string;
  EXEC_NETWORK?: "mainnet" | "testnet" | "devnet" | "lending-devnet";
  HARBOR_LOCAL_DEV?: string;
};

type AwsFetchOptions = { env: CreateKekEnv };

export type CreateKekOptions = {
  env: CreateKekEnv;
  envPath?: string;
  fetch?: AwsFetch;
  randomBytes?: (size: number) => Uint8Array;
  output?: (message: string) => void;
};

export type CreateKekResult = {
  alias: typeof KEK_ALIAS;
  envPath: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

function kmsEndpoint(env: CreateKekEnv): string {
  const region = env.AWS_REGION ?? "us-east-1";
  if (region !== "us-east-1") throw new Error("Unsupported AWS region");
  if (!env.AWS_ENDPOINT_OVERRIDE) return `https://kms.${region}.amazonaws.com/`;
  if (
    env.HARBOR_LOCAL_DEV !== "true" ||
    (env.EXEC_NETWORK !== "testnet" && env.EXEC_NETWORK !== "devnet")
  ) {
    throw new Error("KMS endpoint override is not allowed");
  }
  const endpoint = new URL(env.AWS_ENDPOINT_OVERRIDE);
  if (
    !isLoopback(endpoint.hostname) ||
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    endpoint.username !== "" ||
    endpoint.password !== ""
  ) {
    throw new Error("KMS endpoint override must be loopback");
  }
  return endpoint.toString();
}

const defaultKmsFetch: AwsFetch = async (service, target, body, { env }) => {
  if (service !== "kms" || !/^TrentService\.[A-Za-z]+$/.test(target)) {
    throw new Error("Invalid KMS request");
  }
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    throw new Error("AWS signing settings are unavailable");
  }
  const client = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN,
    region: env.AWS_REGION ?? "us-east-1",
    service: "kms",
  });
  let response: Response;
  try {
    response = await client.fetch(kmsEndpoint(env), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": target,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("KMS request failed");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("KMS returned malformed JSON");
  }
  if (!response.ok) throw new Error("KMS rejected the request");
  return payload;
};

function readKeyId(response: unknown): string {
  if (!isRecord(response) || !isRecord(response.KeyMetadata)) {
    throw new Error("KMS CreateKey returned malformed metadata");
  }
  const keyId = response.KeyMetadata.KeyId;
  if (typeof keyId !== "string" || keyId.length === 0) {
    throw new Error("KMS CreateKey returned no key id");
  }
  return keyId;
}

function readCiphertext(response: unknown): string {
  if (!isRecord(response)) {
    throw new Error("KMS Encrypt returned a malformed response");
  }
  const ciphertext = response.CiphertextBlob;
  if (typeof ciphertext !== "string" || ciphertext.length === 0) {
    throw new Error("KMS Encrypt returned no ciphertext");
  }
  if (
    ciphertext.length > MAX_CIPHERTEXT_BASE64_LENGTH ||
    ciphertext.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      ciphertext,
    )
  ) {
    throw new Error("KMS Encrypt returned invalid ciphertext");
  }
  const decoded = Buffer.from(ciphertext, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== ciphertext) {
    throw new Error("KMS Encrypt returned invalid ciphertext");
  }
  return ciphertext;
}

function kmsRequestEnv(env: CreateKekEnv): CreateKekEnv {
  if (!env.AWS_ENDPOINT_OVERRIDE) return env;
  return {
    AWS_REGION: env.AWS_REGION,
    AWS_ENDPOINT_OVERRIDE: env.AWS_ENDPOINT_OVERRIDE,
    EXEC_NETWORK: env.EXEC_NETWORK,
    HARBOR_LOCAL_DEV: env.HARBOR_LOCAL_DEV,
    ...LOCAL_SIGNING_FIXTURE,
  };
}

export function upsertEnvValue(
  source: string,
  name: string,
  value: string,
): string {
  const normalized = source.replace(/\r\n/g, "\n");
  const lines = normalized === "" ? [] : normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  const assignment = `${name}=${value}`;
  let replaced = false;
  const next = lines.filter((line) => {
    if (!line.startsWith(`${name}=`)) return true;
    if (!replaced) {
      replaced = true;
      return true;
    }
    return false;
  });

  if (replaced) {
    const index = next.findIndex((line) => line.startsWith(`${name}=`));
    next[index] = assignment;
  } else {
    next.push(assignment);
  }

  return `${next.join("\n")}\n`;
}

async function readExternalEnv(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (
      isRecord(error) &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return "";
    }
    throw error;
  }
}

async function writeExternalEnv(path: string, contents: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, contents, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temporaryPath, 0o600);
    // rename preserves the already-hardened temporary file mode, including
    // when it atomically replaces an existing, more permissive env file.
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Create the event-day KMS KEK and persist only its ciphertext envelope.
 * Callers pass AWS settings explicitly; this function performs no credential
 * discovery and never returns or writes the plaintext key material.
 */
export async function createKek(
  options: CreateKekOptions,
): Promise<CreateKekResult> {
  const fetch = options.fetch ?? defaultKmsFetch;
  const requestEnv = kmsRequestEnv(options.env);
  const envPath = resolve(
    options.envPath ?? resolve("/absolute/private/pilot/harbor-secrets/harbor.dev.vars"),
  );
  const random = options.randomBytes ?? ((size) => nodeRandomBytes(size));

  const createResponse = await fetch(
    "kms",
    "TrentService.CreateKey",
    {
      KeySpec: "SYMMETRIC_DEFAULT",
      KeyUsage: "ENCRYPT_DECRYPT",
      Description: "Harbor key-encryption key",
    },
    { env: requestEnv },
  );
  const keyId = readKeyId(createResponse);

  await fetch(
    "kms",
    "TrentService.CreateAlias",
    { AliasName: KEK_ALIAS, TargetKeyId: keyId },
    { env: requestEnv },
  );

  const plaintext = random(32);
  if (plaintext.byteLength !== 32) {
    plaintext.fill(0);
    throw new Error("KEK plaintext generator must return exactly 32 bytes");
  }

  let ciphertext: string;
  try {
    const plaintextBase64 = Buffer.from(
      plaintext.buffer,
      plaintext.byteOffset,
      plaintext.byteLength,
    ).toString("base64");
    ciphertext = readCiphertext(
      await fetch(
        "kms",
        "TrentService.Encrypt",
        {
          KeyId: KEK_ALIAS,
          Plaintext: plaintextBase64,
          EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        },
        { env: requestEnv },
      ),
    );
  } finally {
    plaintext.fill(0);
  }

  const current = await readExternalEnv(envPath);
  await writeExternalEnv(
    envPath,
    upsertEnvValue(current, ENV_NAME, ciphertext),
  );

  options.output?.(
    "Created alias/harbor/kek and updated the external Harbor environment file.",
  );
  return { alias: KEK_ALIAS, envPath };
}

function cliEnv(): CreateKekEnv {
  return {
    AWS_REGION: process.env.AWS_REGION,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
    AWS_ENDPOINT_OVERRIDE: process.env.AWS_ENDPOINT_OVERRIDE,
    EXEC_NETWORK:
      process.env.EXEC_NETWORK === "mainnet" ||
      process.env.EXEC_NETWORK === "testnet" ||
      process.env.EXEC_NETWORK === "devnet" ||
      process.env.EXEC_NETWORK === "lending-devnet"
        ? process.env.EXEC_NETWORK
        : undefined,
    HARBOR_LOCAL_DEV: process.env.HARBOR_LOCAL_DEV,
  };
}

function cliEnvPath(args: readonly string[]): string | undefined {
  if (args.length === 0) return undefined;
  const path = args[1];
  if (args.length !== 2 || args[0] !== "--env-file" || !path) {
    throw new Error("Usage: create-kek [--env-file /external/harbor.dev.vars]");
  }
  return path;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  createKek({
    env: cliEnv(),
    envPath: cliEnvPath(process.argv.slice(2)),
    output: (message) => console.info(message),
  }).catch(() => {
    console.error("create-kek failed; no key material was printed");
    process.exitCode = 1;
  });
}
