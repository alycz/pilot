import type { Ap4mMandateConstraints } from "./constraints";
import { projectAp4mConstraints } from "./constraints";
import {
  base64Url,
  base64UrlText,
  arrayBuffer,
  sha256Base64Url,
  sha256Hex,
  utf8,
} from "./encoding";

export interface BuildAutonomousL2Input {
  agentPublicJwk: JsonWebKey;
  audience: string;
  constraints: Ap4mMandateConstraints;
  deviceKeyId: string;
  devicePrivateKey: CryptoKey;
  expiresAt: string;
  l1: string;
  mandateId: string;
  notBefore: string;
  owner: string;
}

export interface BuiltAutonomousL2 {
  digest: string;
  l2: string;
}

export interface PreparedMandateSetup<T extends Record<string, unknown>> {
  unsignedBatch: T;
  unsignedSequential?: T[];
}

type Disclosure = [string, Record<string, unknown>];

function randomSalt(cryptoImpl: Crypto): string {
  return base64Url(cryptoImpl.getRandomValues(new Uint8Array(16)));
}

async function disclosure(
  value: Record<string, unknown>,
  cryptoImpl: Crypto,
): Promise<{ digest: string; encoded: string }> {
  const item: Disclosure = [randomSalt(cryptoImpl), value];
  const encoded = base64UrlText(JSON.stringify(item));
  return { encoded, digest: await sha256Base64Url(encoded, cryptoImpl) };
}

function seconds(value: string, label: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} is invalid`);
  return Math.floor(milliseconds / 1_000);
}

export async function buildAutonomousL2(
  input: BuildAutonomousL2Input,
  options: { crypto?: Crypto; now?: Date } = {},
): Promise<BuiltAutonomousL2> {
  const cryptoImpl = options.crypto ?? globalThis.crypto;
  const now = options.now ?? new Date();
  if (
    input.devicePrivateKey.type !== "private" ||
    input.devicePrivateKey.extractable ||
    !input.devicePrivateKey.usages.includes("sign")
  ) {
    throw new Error("A non-extractable signing device key is required");
  }
  if (!input.audience.startsWith("https://")) {
    throw new Error("Harbor audience must use HTTPS");
  }
  const issuedAt = Math.floor(now.getTime() / 1_000);
  const notBefore = seconds(input.notBefore, "not_before");
  const expiresAt = seconds(input.expiresAt, "expires_at");
  if (issuedAt < notBefore || issuedAt >= expiresAt) {
    throw new Error("Mandate is not active at L2 signing time");
  }

  const merchantDisclosures = await Promise.all(
    input.constraints.payees.map((id) => disclosure({ id }, cryptoImpl)),
  );
  const skuDisclosures = await Promise.all(
    (input.constraints.skus ?? []).map((sku) =>
      disclosure({ id: sku, sku }, cryptoImpl),
    ),
  );
  const merchantRefs = merchantDisclosures.map(({ digest }) => ({
    "...": digest,
  }));
  const skuRefs = skuDisclosures.map(({ digest }) => ({ "...": digest }));

  // The checkout disclosure's own digest is the conditional transaction id.
  // The checkout projection does not depend on that digest, so it can be
  // encoded once and referenced from the payment projection.
  const checkoutProjection = projectAp4mConstraints({
    ...input,
    checkoutDisclosureDigest: "pending",
    merchantRefs,
    skuRefs,
  }).checkout;
  const checkoutDisclosure = await disclosure(checkoutProjection, cryptoImpl);
  const paymentProjection = projectAp4mConstraints({
    ...input,
    checkoutDisclosureDigest: checkoutDisclosure.digest,
    merchantRefs,
    skuRefs,
  }).payment;
  const paymentDisclosure = await disclosure(paymentProjection, cryptoImpl);
  const disclosures = [
    ...merchantDisclosures,
    ...skuDisclosures,
    checkoutDisclosure,
    paymentDisclosure,
  ];

  const header = {
    alg: "ES256",
    typ: "kb-sd-jwt+kb",
    kid: input.deviceKeyId,
  };
  const payload = {
    nonce: input.mandateId,
    aud: input.audience,
    iat: issuedAt,
    sd_hash: await sha256Base64Url(input.l1, cryptoImpl),
    delegate_payload: [
      { "...": checkoutDisclosure.digest },
      { "...": paymentDisclosure.digest },
    ],
    _sd_alg: "sha-256",
    _sd: disclosures.map(({ digest }) => digest),
    iss: input.owner,
    exp: expiresAt,
  };
  const protectedSegment = base64UrlText(JSON.stringify(header));
  const payloadSegment = base64UrlText(JSON.stringify(payload));
  const signingInput = `${protectedSegment}.${payloadSegment}`;
  const signature = new Uint8Array(
    await cryptoImpl.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      input.devicePrivateKey,
      arrayBuffer(utf8(signingInput)),
    ),
  );
  if (signature.length !== 64) throw new Error("Unexpected ES256 signature format");
  const l2 = `${signingInput}.${base64Url(signature)}~${disclosures
    .map(({ encoded }) => encoded)
    .join("~")}~`;
  return { l2, digest: await sha256Hex(l2, cryptoImpl) };
}

export async function bindL2DigestToBatch<T extends Record<string, unknown>>(
  transaction: T,
  l2: string,
  cryptoImpl: Crypto = globalThis.crypto,
): Promise<T> {
  const memos = transaction.Memos;
  if (!Array.isArray(memos)) throw new Error("Prepared Batch has no AP4M L2 memo");
  const memoType = Array.from(utf8("ap4m/l2"), (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .toUpperCase();
  const matches = memos
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const memo = (entry as { Memo?: unknown }).Memo;
      return Boolean(
        memo &&
          typeof memo === "object" &&
          !Array.isArray(memo) &&
          (memo as { MemoType?: unknown }).MemoType === memoType,
      );
    });
  if (matches.length !== 1) {
    throw new Error("Prepared Batch must contain exactly one AP4M L2 memo");
  }
  const digest = (await sha256Hex(l2, cryptoImpl)).toUpperCase();
  return {
    ...transaction,
    Memos: memos.map((entry, index) => {
      if (index !== matches[0]?.index) return entry;
      const record = entry as { Memo: Record<string, unknown> };
      return { ...record, Memo: { ...record.Memo, MemoData: digest } };
    }),
  };
}

export async function bindL2DigestToSetup<T extends Record<string, unknown>>(
  setup: {
    unsignedBatch: T;
    unsignedSequential?: readonly T[];
  },
  l2: string,
  cryptoImpl: Crypto = globalThis.crypto,
): Promise<PreparedMandateSetup<T>> {
  // Build every copy before returning so the caller never receives a partly
  // bound setup that could be signed after a sequential-path validation error.
  const unsignedBatch = await bindL2DigestToBatch(
    setup.unsignedBatch,
    l2,
    cryptoImpl,
  );
  const unsignedSequential = setup.unsignedSequential
    ? await Promise.all(
        setup.unsignedSequential.map((transaction) =>
          bindL2DigestToBatch(transaction, l2, cryptoImpl),
        ),
      )
    : undefined;
  return { unsignedBatch, unsignedSequential };
}
