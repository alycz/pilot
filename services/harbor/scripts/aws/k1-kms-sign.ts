#!/usr/bin/env -S node --experimental-transform-types

import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

import { deriveAddress, encode, encodeForSigning, hashes, type Transaction } from "xrpl";
import { verify } from "ripple-keypairs";

import { JsonKeyStore, MemoryKeyStore, type LocalKmsStore } from "../../tools/aws-local/src/key-store.ts";
import { handleKms } from "../../tools/aws-local/src/kms.ts";
import {
  appendProbeStatus,
  EVENT_AUTHORITY_REQUIRED,
  parseKmsProbeCli,
  type KmsProbeMode,
} from "./kms-probe-support.ts";

const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const SPKI_PREFIX = "302A300506032B6570032100";

export type K1EventInput = {
  owner: string;
  kmsAlias: string;
  preparedOffer: Transaction;
};

export type K1Result = {
  mode: KmsProbeMode;
  status: "pass";
  evidence: "local-ed25519-signed-blob" | "validated-testnet-offer";
  alias: string;
  signerAddress: string;
  hash: string;
  ledgerIndex?: number;
};

export type K1Options = {
  mode: KmsProbeMode;
  store?: LocalKmsStore;
  statusFile?: string;
  now?: () => Date;
  output?: (line: string) => void;
  eventInput?: K1EventInput;
  eventRunner?: (input: K1EventInput) => Promise<K1Result>;
  linkId?: string;
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("STANDIN_RESPONSE_INVALID");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("STANDIN_RESPONSE_INVALID");
  return value;
}

function standinOffer(delegate: string): Transaction {
  // Synthetic fields only: this transaction is encoded and signed locally but
  // is never submitted or described as Testnet acceptance.
  return {
    TransactionType: "OfferCreate",
    Account: OWNER,
    Delegate: delegate,
    TakerGets: { currency: "USD", issuer: ISSUER, value: "1" },
    TakerPays: "1000000",
    Fee: "12",
    Sequence: 7,
    LastLedgerSequence: 200,
  } as Transaction;
}

export async function runK1(options: K1Options): Promise<K1Result> {
  if (options.mode === "event") {
    if (!options.eventInput || !options.eventRunner) throw new Error(EVENT_AUTHORITY_REQUIRED);
    const result = await options.eventRunner(options.eventInput);
    if (
      result.mode !== "event" ||
      result.status !== "pass" ||
      result.evidence !== "validated-testnet-offer" ||
      !Number.isSafeInteger(result.ledgerIndex) ||
      (result.ledgerIndex ?? 0) < 1 ||
      !/^[A-F0-9]{64}$/.test(result.hash)
    ) {
      throw new Error("EVENT_EVIDENCE_INVALID");
    }
    await appendProbeStatus(options.statusFile, "k1-kms-sign", `event validated hash=${result.hash}`, options.now);
    options.output?.(JSON.stringify(result));
    return result;
  }

  const store = options.store ?? new MemoryKeyStore();
  const created = await handleKms("TrentService.CreateKey", {
    KeySpec: "ECC_NIST_EDWARDS25519",
    KeyUsage: "SIGN_VERIFY",
    Tags: [
      { TagKey: "harbor:principal", TagValue: "aws6-k1-standin" },
      { TagKey: "harbor:owner", TagValue: OWNER },
      { TagKey: "harbor:network", TagValue: "testnet" },
    ],
  }, store);
  const keyId = requiredString(record(created.KeyMetadata).KeyId);
  const linkId = options.linkId ?? `k1-kms-sign-${randomUUID()}`;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(linkId)) throw new Error("INVALID_LINK_ID");
  const keyAlias = `alias/harbor/testnet/${linkId}`;
  await handleKms("TrentService.CreateAlias", {
    AliasName: keyAlias,
    TargetKeyId: keyId,
  }, store);
  const publicResponse = await handleKms("TrentService.GetPublicKey", { KeyId: keyAlias }, store);
  const spki = Buffer.from(requiredString(publicResponse.PublicKey), "base64").toString("hex").toUpperCase();
  if (!spki.startsWith(SPKI_PREFIX) || spki.length !== SPKI_PREFIX.length + 64) {
    throw new Error("STANDIN_PUBLIC_KEY_INVALID");
  }
  const publicKey = `ED${spki.slice(SPKI_PREFIX.length)}`;
  const signerAddress = deriveAddress(publicKey);
  const unsigned = standinOffer(signerAddress) as Transaction & {
    SigningPubKey: string;
    TxnSignature?: string;
  };
  unsigned.SigningPubKey = publicKey;
  delete unsigned.TxnSignature;
  const signingHex = encodeForSigning(unsigned);
  const signResponse = await handleKms("TrentService.Sign", {
    KeyId: keyId,
    Message: Buffer.from(signingHex, "hex").toString("base64"),
    MessageType: "RAW",
    SigningAlgorithm: "ED25519_SHA_512",
  }, store);
  const signature = Buffer.from(requiredString(signResponse.Signature), "base64")
    .toString("hex")
    .toUpperCase();
  if (!verify(signingHex, signature, publicKey)) {
    throw new Error("STANDIN_SIGNATURE_INVALID");
  }
  unsigned.TxnSignature = signature;
  const txBlob = encode(unsigned);
  const signed = {
    tx_blob: txBlob,
    hash: hashes.hashSignedTx(txBlob),
  };
  const result: K1Result = {
    mode: "standin",
    status: "pass",
    evidence: "local-ed25519-signed-blob",
    alias: keyAlias,
    signerAddress,
    hash: signed.hash,
  };
  await appendProbeStatus(
    options.statusFile,
    "k1-kms-sign",
    `standin local-ed25519-signed-blob hash=${result.hash}`,
    options.now,
  );
  options.output?.(JSON.stringify(result));
  return result;
}

async function main(): Promise<void> {
  const args = parseKmsProbeCli(process.argv.slice(2));
  if (args.mode === "event") throw new Error(EVENT_AUTHORITY_REQUIRED);
  await runK1({
    mode: "standin",
    ...(args.storeFile ? { store: new JsonKeyStore(args.storeFile) } : {}),
    statusFile: args.statusFile,
    output: (line) => process.stdout.write(`${line}\n`),
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "K1_FAILED";
    process.stderr.write(`k1-kms-sign: fail ${message}\n`);
    process.exitCode = 1;
  });
}
