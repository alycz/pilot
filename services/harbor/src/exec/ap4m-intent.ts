import { isValidClassicAddress } from "xrpl";

import { McIntentSchema, type McIntent } from "../contracts";
import { viDigest } from "./mandate-vi";

type JsonPrimitive = boolean | number | string | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const USD_AMOUNT = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/;
const TOKEN_TEXT_MAX = 200;
const CHECKOUT_TEXT_MAX = 16 * 1024;

export interface BuildMcIntentInput {
  merchantId: string;
  merchantName: string;
  srcDpaId: string;
  sku: string;
  itemName: string;
  priceUsd: string;
}

export interface BuildMcIntentDependencies {
  now(): Date;
  uuid(): string;
}

export interface Ap4mExactPaymentTerms {
  scheme: "exact";
  network: "testnet";
  currency: string;
  issuer: string;
  amount: string;
  payTo: string;
}

export interface Ap4mL2Disclosures {
  baseJwt: string;
  payment: string;
  merchant: string;
  checkout: string;
  item: string;
}

export interface Ap4mCompactJwtSigner {
  (
    protectedHeader: Readonly<{ alg: "ES256"; typ: "kb-sd-jwt"; kid: string }>,
    payload: Readonly<JsonObject>,
  ): Promise<string>;
}

export interface MintAp4mViPairInput {
  intent: McIntent;
  paymentTerms: Ap4mExactPaymentTerms;
  merchant: {
    id: string;
    name: string;
    website: string;
  };
  sku: string;
  itemName: string;
  amountMinorUnits: number;
  paymentInstrument: {
    type: "xrpl.ap4m";
    id: string;
    description?: string;
  };
  agentKid: string;
  agentPublicJwk: JsonWebKey;
  agentIssuer: string;
  networkAudience: string;
  merchantAudience: string;
  l2: Ap4mL2Disclosures;
}

export interface MintAp4mViPairDependencies {
  now(): Date;
  nonce(): string;
  disclosureSalt(): string;
  signCompactJwt: Ap4mCompactJwtSigner;
  crypto?: Crypto;
}

export interface Ap4mViPair {
  intent: McIntent;
  checkoutPayload: string;
  checkoutHash: string;
  l3a: string;
  l3b: string;
  l3aDigest: string;
  l3bDigest: string;
}

export class Ap4mIntentError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INVALID_INPUT"
      | "INVALID_L2_PRESENTATION"
      | "INVALID_SIGNER_OUTPUT",
  ) {
    super(message);
    this.name = "Ap4mIntentError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJson(value: unknown, seen = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Ap4mIntentError("JSON numbers must be finite", "INVALID_INPUT");
    return;
  }
  if (typeof value !== "object") {
    throw new Ap4mIntentError("Value is not canonical JSON", "INVALID_INPUT");
  }
  if (seen.has(value)) throw new Ap4mIntentError("JSON value is cyclic", "INVALID_INPUT");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const entry of value) assertJson(entry, seen);
      return;
    }
    if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0) {
      throw new Ap4mIntentError("Value is not a plain JSON object", "INVALID_INPUT");
    }
    for (const entry of Object.values(value)) assertJson(entry, seen);
  } finally {
    seen.delete(value);
  }
}

/** RFC 8785-style stable object-key ordering for the bounded AP4M payloads. */
export function canonicalAp4mJson(value: unknown): string {
  assertJson(value);
  if (Array.isArray(value)) return `[${value.map(canonicalAp4mJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalAp4mJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function boundedText(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.length > TOKEN_TEXT_MAX ||
    new TextEncoder().encode(value).length > TOKEN_TEXT_MAX ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Ap4mIntentError(`${label} must be 1-${TOKEN_TEXT_MAX} bytes of visible text`, "INVALID_INPUT");
  }
  return value;
}

function httpsUrl(value: string, label: string): string {
  boundedText(value, label);
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
      throw new TypeError("unsafe URL");
    }
  } catch {
    throw new Ap4mIntentError(`${label} must be a public HTTPS URL`, "INVALID_INPUT");
  }
  return value;
}

function positiveUsd(value: string): string {
  const match = USD_AMOUNT.exec(value);
  if (!match || BigInt(match[1] ?? "0") === 0n && !/[1-9]/.test(match[2] ?? "")) {
    throw new Ap4mIntentError("priceUsd must be a canonical positive USD amount", "INVALID_INPUT");
  }
  return value;
}

function validDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Ap4mIntentError(`${label} is invalid`, "INVALID_INPUT");
  }
  return value;
}

function nextUuid(deps: BuildMcIntentDependencies, label: string): string {
  const value = deps.uuid();
  if (!UUID.test(value)) throw new Ap4mIntentError(`${label} must be a UUID`, "INVALID_INPUT");
  return value.toLowerCase();
}

export function buildMcIntent(
  input: BuildMcIntentInput,
  deps: BuildMcIntentDependencies,
): McIntent {
  const now = validDate(deps.now(), "intent clock");
  const intentUuid = nextUuid(deps, "intent id");
  const orderUuid = nextUuid(deps, "order id");
  const merchantId = boundedText(input.merchantId, "merchant id");
  const merchantName = boundedText(input.merchantName, "merchant name");
  const srcDpaId = boundedText(input.srcDpaId, "srcDpaId");
  const sku = boundedText(input.sku, "sku");
  const itemName = boundedText(input.itemName, "item name");
  const priceUsd = positiveUsd(input.priceUsd);

  return McIntentSchema.parse({
    intentId: `demo-intent-${intentUuid}`,
    intentSummary: `Purchase ${sku} from ${merchantName}`,
    intentStatus: "ACTIVE",
    orders: [
      {
        orderId: `demo-order-${orderUuid}`,
        orderExecutionType: "DEFERRED",
        orderExpiry: Math.floor(now.getTime() / 1_000) + 300,
        orderTotalAmount: { amount: priceUsd, currency: "USD" },
        items: [
          {
            itemId: sku,
            itemName,
            itemUnitPrice: { amount: priceUsd, currency: "USD" },
            itemQuantity: 1,
            itemDeliveryMethod: "DIGITAL",
          },
        ],
        merchants: [{ srcDpaId, merchantName }],
      },
    ],
  });
}

function assertPaymentTerms(value: Ap4mExactPaymentTerms): void {
  if (value.scheme !== "exact" || value.network !== "testnet") {
    throw new Ap4mIntentError("AP4M exact payments are Testnet-only", "INVALID_INPUT");
  }
  for (const [label, entry] of Object.entries(value)) {
    if (typeof entry === "string") boundedText(entry, `payment ${label}`);
  }
  // The demo registry uses the human-readable RLUSD/tUSD aliases and resolves
  // them to the network's canonical issuer/currency tuple before signing.
  if (!/^(?:[A-Z0-9]{3,12}|[A-F0-9]{40})$/.test(value.currency)) {
    throw new Ap4mIntentError("payment currency is invalid", "INVALID_INPUT");
  }
  if (!/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value.amount) || Number(value.amount) <= 0) {
    throw new Ap4mIntentError("payment amount is invalid", "INVALID_INPUT");
  }
  if (!isValidClassicAddress(value.issuer) || !isValidClassicAddress(value.payTo)) {
    throw new Ap4mIntentError("payment issuer and payTo must be XRPL classic addresses", "INVALID_INPUT");
  }
}

/**
 * Build the implementation-defined v0.1 checkout representation. The pinned
 * VI spec leaves checkout_jwt representation implementation-defined; this
 * mock-first profile uses canonical JSON so both languages hash identical bytes.
 */
export function buildAp4mCheckoutPayload(
  intent: McIntent,
  paymentTerms: Ap4mExactPaymentTerms,
): string {
  const parsed = McIntentSchema.parse(intent);
  assertPaymentTerms(paymentTerms);
  const payload = canonicalAp4mJson({ intent: parsed, payment_terms: paymentTerms });
  if (new TextEncoder().encode(payload).length > CHECKOUT_TEXT_MAX) {
    throw new Ap4mIntentError("checkout payload exceeds 16 KiB", "INVALID_INPUT");
  }
  return payload;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeBase64Url(value: string, code: Ap4mIntentError["code"]): Uint8Array {
  if (!BASE64URL.test(value)) throw new Ap4mIntentError("Invalid base64url value", code);
  const padded = `${value.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat((4 - value.length % 4) % 4)}`;
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw new Ap4mIntentError("Invalid base64url value", code);
  }
}

async function digestBase64Url(cryptoImpl: Crypto, value: string): Promise<string> {
  return encodeBase64Url(
    new Uint8Array(await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(value))),
  );
}

function parseDisclosure(value: string, label: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(decodeBase64Url(value, "INVALID_L2_PRESENTATION")));
  } catch (error) {
    if (error instanceof Ap4mIntentError) throw error;
    throw new Ap4mIntentError(`${label} disclosure is malformed`, "INVALID_L2_PRESENTATION");
  }
  if (!Array.isArray(parsed) || ![2, 3].includes(parsed.length) || typeof parsed[0] !== "string") {
    throw new Ap4mIntentError(`${label} disclosure is malformed`, "INVALID_L2_PRESENTATION");
  }
  return parsed.at(-1);
}

/**
 * Build the only L2 selective presentation sent to an AP4M merchant.
 *
 * The payment mandate is required so the merchant/reference verifier can bind
 * `payment.reference` to the disclosed checkout mandate. Merchant and item
 * disclosures resolve the references used by both open mandates. Fixed order
 * keeps the presentation hash stable across TypeScript and Python verifiers.
 */
export function buildAp4mMerchantL2Presentation(input: Ap4mL2Disclosures): string {
  if (input.baseJwt.split(".").length !== 3 || input.baseJwt.includes("~")) {
    throw new Ap4mIntentError("L2 base JWT is malformed", "INVALID_L2_PRESENTATION");
  }
  const payment = parseDisclosure(input.payment, "payment");
  const merchant = parseDisclosure(input.merchant, "merchant");
  const checkout = parseDisclosure(input.checkout, "checkout");
  const item = parseDisclosure(input.item, "item");
  if (!isPlainObject(payment) || payment.vct !== "mandate.payment.open") {
    throw new Ap4mIntentError("L2 payment disclosure is not open", "INVALID_L2_PRESENTATION");
  }
  if (!isPlainObject(merchant) || typeof merchant.id !== "string") {
    throw new Ap4mIntentError("L2 merchant disclosure is malformed", "INVALID_L2_PRESENTATION");
  }
  if (!isPlainObject(checkout) || checkout.vct !== "mandate.checkout.open") {
    throw new Ap4mIntentError("L2 checkout disclosure is not open", "INVALID_L2_PRESENTATION");
  }
  if (
    !isPlainObject(item) ||
    typeof item.id !== "string" && typeof item.sku !== "string"
  ) {
    throw new Ap4mIntentError("L2 item disclosure is malformed", "INVALID_L2_PRESENTATION");
  }
  return `${input.baseJwt}~${input.payment}~${input.merchant}~${input.checkout}~${input.item}~`;
}

function assertL2Disclosures(input: MintAp4mViPairInput): void {
  buildAp4mMerchantL2Presentation(input.l2);
  const payment = parseDisclosure(input.l2.payment, "payment");
  const merchant = parseDisclosure(input.l2.merchant, "merchant");
  const checkout = parseDisclosure(input.l2.checkout, "checkout");
  const item = parseDisclosure(input.l2.item, "item");
  if (!isPlainObject(payment) || payment.vct !== "mandate.payment.open") {
    throw new Ap4mIntentError("L2 payment disclosure is not open", "INVALID_L2_PRESENTATION");
  }
  if (!isPlainObject(checkout) || checkout.vct !== "mandate.checkout.open") {
    throw new Ap4mIntentError("L2 checkout disclosure is not open", "INVALID_L2_PRESENTATION");
  }
  if (!isPlainObject(merchant) || merchant.id !== input.merchant.id) {
    throw new Ap4mIntentError("L2 merchant disclosure does not match purchase", "INVALID_L2_PRESENTATION");
  }
  if (!isPlainObject(item) || item.id !== input.sku && item.sku !== input.sku) {
    throw new Ap4mIntentError("L2 item disclosure does not match purchase", "INVALID_L2_PRESENTATION");
  }
}

function disclosure(salt: string, value: JsonObject): string {
  boundedText(salt, "disclosure salt");
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify([salt, value])));
}

async function signSdJwt(
  header: { alg: "ES256"; typ: "kb-sd-jwt"; kid: string },
  payload: JsonObject,
  disclosures: string[],
  signer: Ap4mCompactJwtSigner,
  agentPublicJwk: JsonWebKey,
  cryptoImpl: Crypto,
): Promise<string> {
  const compact = await signer(header, payload);
  const segments = compact.split(".");
  if (segments.length !== 3 || segments.some((segment) => !BASE64URL.test(segment))) {
    throw new Ap4mIntentError("Signer returned a malformed compact JWT", "INVALID_SIGNER_OUTPUT");
  }
  let actualHeader: unknown;
  let actualPayload: unknown;
  try {
    actualHeader = JSON.parse(new TextDecoder().decode(decodeBase64Url(segments[0]!, "INVALID_SIGNER_OUTPUT")));
    actualPayload = JSON.parse(new TextDecoder().decode(decodeBase64Url(segments[1]!, "INVALID_SIGNER_OUTPUT")));
  } catch (error) {
    if (error instanceof Ap4mIntentError) throw error;
    throw new Ap4mIntentError("Signer returned invalid JWT JSON", "INVALID_SIGNER_OUTPUT");
  }
  if (canonicalAp4mJson(actualHeader) !== canonicalAp4mJson(header)) {
    throw new Ap4mIntentError("Signer changed the protected header", "INVALID_SIGNER_OUTPUT");
  }
  if (canonicalAp4mJson(actualPayload) !== canonicalAp4mJson(payload)) {
    throw new Ap4mIntentError("Signer changed the VI claims", "INVALID_SIGNER_OUTPUT");
  }
  try {
    const verificationKey = await cryptoImpl.subtle.importKey(
      "jwk",
      agentPublicJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const verified = await cryptoImpl.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verificationKey,
      decodeBase64Url(segments[2]!, "INVALID_SIGNER_OUTPUT"),
      new TextEncoder().encode(`${segments[0]}.${segments[1]}`),
    );
    if (!verified) throw new TypeError("invalid signature");
  } catch {
    throw new Ap4mIntentError("Signer did not use the mandate agent key", "INVALID_SIGNER_OUTPUT");
  }
  return `${compact}~${disclosures.join("~")}~`;
}

function assertMintInput(input: MintAp4mViPairInput): void {
  McIntentSchema.parse(input.intent);
  assertPaymentTerms(input.paymentTerms);
  boundedText(input.merchant.id, "merchant id");
  boundedText(input.merchant.name, "merchant name");
  httpsUrl(input.merchant.website, "merchant website");
  boundedText(input.sku, "sku");
  boundedText(input.itemName, "item name");
  boundedText(input.agentKid, "agent key id");
  const publicKid = (input.agentPublicJwk as JsonWebKey & { kid?: unknown }).kid;
  if (
    input.agentPublicJwk.kty !== "EC" ||
    input.agentPublicJwk.crv !== "P-256" ||
    typeof input.agentPublicJwk.x !== "string" ||
    typeof input.agentPublicJwk.y !== "string" ||
    input.agentPublicJwk.d !== undefined ||
    publicKid !== undefined && publicKid !== input.agentKid
  ) {
    throw new Ap4mIntentError("agent public JWK does not match the L3 key id", "INVALID_INPUT");
  }
  httpsUrl(input.agentIssuer, "agent issuer");
  httpsUrl(input.networkAudience, "network audience");
  httpsUrl(input.merchantAudience, "merchant audience");
  if (!Number.isSafeInteger(input.amountMinorUnits) || input.amountMinorUnits <= 0) {
    throw new Ap4mIntentError("USD minor-unit amount is invalid", "INVALID_INPUT");
  }
  if (input.paymentInstrument.type !== "xrpl.ap4m") {
    throw new Ap4mIntentError("payment instrument must be xrpl.ap4m", "INVALID_INPUT");
  }
  boundedText(input.paymentInstrument.id, "payment instrument id");
  if (!isValidClassicAddress(input.paymentInstrument.id)) {
    throw new Ap4mIntentError("payment instrument id must be an XRPL classic address", "INVALID_INPUT");
  }
  if (input.paymentInstrument.description !== undefined) {
    boundedText(input.paymentInstrument.description, "payment instrument description");
  }
  if (input.intent.orders[0]?.items[0]?.itemId !== input.sku) {
    throw new Ap4mIntentError("intent SKU does not match purchase", "INVALID_INPUT");
  }
  assertL2Disclosures(input);
}

/** Mint the pinned VI v0.1 split L3 pair without accepting private key material. */
export async function mintAp4mViPair(
  input: MintAp4mViPairInput,
  deps: MintAp4mViPairDependencies,
): Promise<Ap4mViPair> {
  assertMintInput(input);
  const cryptoImpl = deps.crypto ?? crypto;
  const now = validDate(deps.now(), "L3 clock");
  const iat = Math.floor(now.getTime() / 1_000);
  const exp = iat + 300;
  const l3aNonce = boundedText(deps.nonce(), "L3a nonce");
  const l3bNonce = boundedText(deps.nonce(), "L3b nonce");
  if (l3aNonce === l3bNonce) {
    throw new Ap4mIntentError("L3 nonces must be distinct", "INVALID_INPUT");
  }

  const checkoutPayload = buildAp4mCheckoutPayload(input.intent, input.paymentTerms);
  const checkoutHash = await digestBase64Url(cryptoImpl, checkoutPayload);
  const paymentMandate: JsonObject = {
    vct: "mandate.payment",
    transaction_id: checkoutHash,
    payee: input.merchant,
    payment_amount: { currency: "USD", amount: input.amountMinorUnits },
    payment_instrument: input.paymentInstrument,
  };
  const checkoutMandate: JsonObject = {
    vct: "mandate.checkout",
    checkout_jwt: checkoutPayload,
    checkout_hash: checkoutHash,
    line_items: [
      {
        sku: input.sku,
        name: input.itemName,
        quantity: 1,
        unit_price: input.amountMinorUnits,
        currency: "USD",
      },
    ],
  };

  const paymentDisclosure = disclosure(deps.disclosureSalt(), paymentMandate);
  const merchantDisclosure = disclosure(deps.disclosureSalt(), input.merchant);
  const checkoutDisclosure = disclosure(deps.disclosureSalt(), checkoutMandate);
  const paymentHash = await digestBase64Url(cryptoImpl, paymentDisclosure);
  const merchantHash = await digestBase64Url(cryptoImpl, merchantDisclosure);
  const checkoutDisclosureHash = await digestBase64Url(cryptoImpl, checkoutDisclosure);
  const l2PaymentPresentation = `${input.l2.baseJwt}~${input.l2.payment}~${input.l2.merchant}~`;
  const l2MerchantPresentation = buildAp4mMerchantL2Presentation(input.l2);
  const header = { alg: "ES256", typ: "kb-sd-jwt", kid: input.agentKid } as const;

  const l3a = await signSdJwt(
    header,
    {
      nonce: l3aNonce,
      aud: input.networkAudience,
      iat,
      exp,
      iss: input.agentIssuer,
      sd_hash: await digestBase64Url(cryptoImpl, l2PaymentPresentation),
      delegate_payload: [{ "...": merchantHash }, { "...": paymentHash }],
      _sd_alg: "sha-256",
      _sd: [merchantHash, paymentHash],
    },
    [merchantDisclosure, paymentDisclosure],
    deps.signCompactJwt,
    input.agentPublicJwk,
    cryptoImpl,
  );
  const l3b = await signSdJwt(
    header,
    {
      nonce: l3bNonce,
      aud: input.merchantAudience,
      iat,
      exp,
      iss: input.agentIssuer,
      sd_hash: await digestBase64Url(cryptoImpl, l2MerchantPresentation),
      delegate_payload: [{ "...": checkoutDisclosureHash }],
      _sd_alg: "sha-256",
      _sd: [checkoutDisclosureHash],
    },
    [checkoutDisclosure],
    deps.signCompactJwt,
    input.agentPublicJwk,
    cryptoImpl,
  );

  return {
    intent: input.intent,
    checkoutPayload,
    checkoutHash,
    l3a,
    l3b,
    l3aDigest: await viDigest(l3a, cryptoImpl),
    l3bDigest: await viDigest(l3b, cryptoImpl),
  };
}
