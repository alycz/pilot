import { isValidClassicAddress } from "xrpl";

import { createXrplRpc } from "../adapters/xrpl-rpc";
import { DEFAULT_POLICY } from "../contracts";
import type { ValidatedX402Challenge } from "../adapters/x402";
import { LOCAL_X402_COMPARE_PRICE_DROPS } from "../local-x402";
import {
  LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO,
  LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE,
  localX402IsolatedV1MarkersPresent,
} from "../local-x402-isolated-v1";
import type {
  X402PayRequest,
  X402PayResponse,
  X402Service,
} from "../x402-contract";
import { X402MerchantBodySchema } from "../x402-contract";
import { withDelegateSigner, type StoredDelegateKey } from "./keys";
import { PayerSequenceLeaseAuthority } from "./payer-sequence-lease";
import {
  createX402PaymentEngine,
  type EncodePaymentSignatureInput,
  type X402PayerLock,
  type X402PaymentResult,
} from "./x402-pay";
import { X402PayerStore } from "./x402-payer-store";
import { X402Store, type JsonObject, type X402PaymentRow } from "./x402-store";
import { Store } from "./store";

export type LocalX402RuntimeEnv = {
  DB: D1Database;
  HARBOR_KEK?: string;
  HARBOR_SOURCE_TAG?: string;
  HARBOR_LOCAL_X402_RUNTIME_ENABLED?: string;
  HARBOR_LOCAL_X402_MERCHANT_PAY_TO?: string;
  HARBOR_LOCAL_X402_ISOLATED_V1_RUNTIME_ENABLED?: string;
  HARBOR_LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE?: string;
  HARBOR_LOCAL_AP4M_X402_COMBINED_V1_RUNTIME_ENABLED?: string;
  HARBOR_LOCAL_AP4M_X402_COMBINED_V1_SIGNING_PROFILE?: string;
};

const UINT32_MAX = 0xffff_ffff;
const HASH = /^[A-F0-9]{64}$/;
const DROPS = /^[1-9][0-9]*$/;
const RETRY_AFTER_SECONDS = 5;
const COMBINED_SIGNING_PROFILE =
  "reviewed-testnet-ap4m-x402-combined-v1";
const CONFLICTING_LOCAL_PROFILE_MARKERS = [
  "HARBOR_LOCAL_TRADING_RUNTIME_ENABLED",
  "HARBOR_LOCAL_TRADING_SIGNING_PROFILE",
  "HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED",
  "HARBOR_LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE",
  "HARBOR_LOCAL_TRADING_ISOLATED_V1_RUNTIME_ENABLED",
  "HARBOR_LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE",
  "HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_RUNTIME_ENABLED",
  "HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_SIGNING_PROFILE",
] as const;

function combinedProfileState(env: LocalX402RuntimeEnv): {
  present: boolean;
  valid: boolean;
} {
  const present =
    "HARBOR_LOCAL_AP4M_X402_COMBINED_V1_RUNTIME_ENABLED" in env ||
    "HARBOR_LOCAL_AP4M_X402_COMBINED_V1_SIGNING_PROFILE" in env;
  return {
    present,
    valid:
      env.HARBOR_LOCAL_AP4M_X402_COMBINED_V1_RUNTIME_ENABLED === "true" &&
      env.HARBOR_LOCAL_AP4M_X402_COMBINED_V1_SIGNING_PROFILE ===
        COMBINED_SIGNING_PROFILE,
  };
}

function sourceTag(value: string | undefined): number {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("Local x402 source tag is not configured");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > UINT32_MAX) {
    throw new Error("Local x402 source tag is not configured");
  }
  return parsed;
}

function configuredKek(env: LocalX402RuntimeEnv): string {
  if (typeof env.HARBOR_KEK !== "string" || env.HARBOR_KEK.length === 0) {
    throw new Error("Local x402 signing is not configured");
  }
  return env.HARBOR_KEK;
}

function configuredMerchantPayTo(env: LocalX402RuntimeEnv): string {
  const value = env.HARBOR_LOCAL_X402_MERCHANT_PAY_TO;
  if (typeof value !== "string" || !isValidClassicAddress(value)) {
    throw new Error("Local x402 merchant receiver is not configured");
  }
  return value;
}

function boundMerchantPayTo(
  env: LocalX402RuntimeEnv,
  binding: IsolatedPaymentBinding | undefined,
): string {
  const configured = configuredMerchantPayTo(env);
  if (
    binding !== undefined &&
    configured !== LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO
  ) {
    throw new Error("Local x402 merchant receiver is not configured");
  }
  return binding?.payTo ?? configured;
}

type IsolatedPaymentBinding = Readonly<{
  exactPriceDrops: typeof LOCAL_X402_COMPARE_PRICE_DROPS;
  payTo: typeof LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO;
}>;

function isolatedPaymentBinding(
  env: LocalX402RuntimeEnv,
): IsolatedPaymentBinding | undefined {
  return env.HARBOR_LOCAL_X402_ISOLATED_V1_RUNTIME_ENABLED === "true" &&
    env.HARBOR_LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE ===
      LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE &&
    !CONFLICTING_LOCAL_PROFILE_MARKERS.some((name) => name in env)
    ? {
        exactPriceDrops: LOCAL_X402_COMPARE_PRICE_DROPS,
        payTo: LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO,
      }
    : undefined;
}

function lowerCap(value: string, hardCap: string): string {
  if (value.length > 16 || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("Stored x402 policy is invalid");
  }
  return BigInt(value) < BigInt(hardCap) ? value : hardCap;
}

function base64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 4096));
  }
  return btoa(binary);
}

function acceptedRequirement(challenge: ValidatedX402Challenge): JsonObject {
  const extra: JsonObject = {
    sourceTag: challenge.sourceTag,
    invoiceId: challenge.invoiceId,
  };
  if (challenge.destinationTag !== undefined) {
    extra.destinationTag = challenge.destinationTag;
  }
  return {
    scheme: "exact",
    network: "xrpl:1",
    asset: "XRP",
    payTo: challenge.payTo,
    amount: challenge.amountDrops,
    maxTimeoutSeconds: challenge.maxTimeoutSeconds,
    extra,
  };
}

/** Encode the exact T54 x402 v2 PAYMENT-SIGNATURE payload. */
export function encodeT54PaymentSignature(
  input: EncodePaymentSignatureInput,
): string {
  return base64Json({
    x402Version: 2,
    resource: input.challenge.resource,
    accepted: acceptedRequirement(input.challenge),
    payload: { signedTxBlob: input.signedBlob },
  });
}

class LocalPayerLock implements X402PayerLock {
  private readonly tails = new Map<string, Promise<void>>();

  async withLock<T>(key: string, callback: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.tails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await callback();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

const localPayerLock = new LocalPayerLock();

function requiredText(value: string | null, field: string): string {
  if (value === null || value.length === 0) throw new Error(`Missing ${field}`);
  return value;
}

function feeDrops(row: X402PaymentRow): string {
  const value = row.transaction?.Fee;
  if (typeof value !== "string" || !DROPS.test(value) || BigInt(value) > 100n) {
    throw new Error("Stored x402 fee is invalid");
  }
  return value;
}

function validatedLedgerIndex(row: X402PaymentRow): number {
  const value = row.settlement?.ledger_index;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error("Stored x402 settlement is invalid");
  }
  return value as number;
}

export function publicX402Result(
  principal: string,
  request: X402PayRequest,
  result: X402PaymentResult,
  merchantPayTo: string,
): X402PayResponse {
  const { row } = result;
  if (
    row.principal !== principal ||
    row.owner !== request.owner ||
    row.network !== "testnet" ||
    row.idempotencyKey !== request.idempotency_key ||
    row.url !== "http://127.0.0.1:8000/api/x402/compare" ||
    row.payTo !== merchantPayTo ||
    row.hash !== result.hash
  ) {
    throw new Error("Stored x402 binding is invalid");
  }
  if (result.status === "settlement_unknown") {
    if (row.status !== "settlement_unknown" || !HASH.test(result.hash) || row.lastLedgerSeq === null) {
      throw new Error("Stored x402 recovery record is invalid");
    }
    return {
      status: "settlement_unknown",
      payment_id: row.id,
      idempotency_key: request.idempotency_key,
      network: "testnet",
      owner: request.owner,
      resource: "compare",
      request_fingerprint: row.requestFingerprint,
      tx_hash: result.hash,
      last_ledger_sequence: row.lastLedgerSeq,
      retry_after_seconds: RETRY_AFTER_SECONDS,
    };
  }
  if (
    row.status !== "delivered" ||
    row.delivery?.http_status !== 200 ||
    row.delivery.content_type !== "application/json" ||
    !Object.prototype.hasOwnProperty.call(row.delivery, "body")
  ) {
    throw new Error("Stored x402 delivery is invalid");
  }
  return {
    status: "delivered",
    payment_id: row.id,
    idempotency_key: request.idempotency_key,
    owner: request.owner,
    network: "testnet",
    resource: "compare",
    invoice_id: requiredText(row.invoiceId, "invoice id"),
    amount_drops: requiredText(row.amountDrops, "amount"),
    fee_drops: feeDrops(row),
    payer: row.delegate,
    pay_to: requiredText(row.payTo, "pay-to address"),
    tx_hash: result.hash,
    validated_ledger_index: validatedLedgerIndex(row),
    merchant: {
      status: 200,
      content_type: "application/json",
      body: X402MerchantBodySchema.parse(row.delivery.body),
    },
  };
}

export function createLocalX402Service(env: LocalX402RuntimeEnv): X402Service {
  // The x402 runtime always uses Harbor's compiled official Testnet endpoint;
  // environment-selected RPC URLs are deliberately outside this local rail.
  const xrpl = createXrplRpc();
  const isolatedMarkersPresent = localX402IsolatedV1MarkersPresent(env);
  const isolatedBinding = isolatedPaymentBinding(env);
  const combined = combinedProfileState(env);
  const engine = createX402PaymentEngine({
    enabled: env.HARBOR_LOCAL_X402_RUNTIME_ENABLED === "true",
    fetch: (input, init) => globalThis.fetch(input, init),
    xrpl,
    lock: localPayerLock,
    // Every signing-capable profile shares the ledger-account fence. The
    // combined profile is not a prerequisite for sequence safety.
    sequenceLeases: new PayerSequenceLeaseAuthority(env.DB),
    resolvePayer: async ({ principal, owner, network }) => {
      const merchantPayTo = boundMerchantPayTo(env, isolatedBinding);
      const payer = await new X402PayerStore(env.DB, principal).get(owner, network);
      if (payer === null || payer.status !== "ready") {
        throw new Error("Local x402 payer is not ready");
      }
      const policy =
        (await new Store(env.DB, principal).getPolicy(owner, network))?.json ??
        DEFAULT_POLICY;
      const policyPerCallCapDrops = lowerCap(
        policy.x402_max_per_call_drops,
        "100000",
      );
      const dailyCapDrops = lowerCap(
        policy.x402_daily_cap_drops,
        "1000000",
      );
      if (BigInt(policyPerCallCapDrops) > BigInt(dailyCapDrops)) {
        throw new Error("Stored x402 policy is invalid");
      }
      return {
        dedicated: true as const,
        merchantPayTo,
        identity: {
          principal,
          owner,
          network,
          payer: payer.payer,
          sourceTag: sourceTag(env.HARBOR_SOURCE_TAG),
        },
        store: new X402Store(env.DB, principal),
        policyPerCallCapDrops,
        dailyCapDrops,
      };
    },
    withDelegateSigner: async (identity, callback) => {
      const payer = await new X402PayerStore(env.DB, identity.principal).get(
        identity.owner,
        identity.network,
      );
      if (payer === null || payer.status !== "ready" || payer.payer !== identity.payer) {
        throw new Error("Local x402 payer binding changed");
      }
      const wrapped: StoredDelegateKey = {
        address: payer.payer,
        publicKey: payer.publicKey,
        ciphertext: payer.ciphertext,
        iv: payer.iv,
      };
      return withDelegateSigner(
        {
          principal: identity.principal,
          owner: identity.owner,
          network: identity.network,
        },
        wrapped,
        configuredKek(env),
        callback,
      );
    },
    encodePaymentSignature: encodeT54PaymentSignature,
  });

  return Object.freeze({
    async pay(principal, request) {
      if (combined.present && !combined.valid) {
        throw new Error("Combined AP4M x402 profile is invalid");
      }
      if (isolatedMarkersPresent && isolatedBinding === undefined) {
        throw new Error("Local x402 isolated profile is invalid");
      }
      if (
        (isolatedBinding === undefined && request.pay_to !== undefined) ||
        (isolatedBinding !== undefined &&
          request.pay_to !== isolatedBinding.payTo)
      ) {
        throw new Error("Local x402 pay-to binding is invalid");
      }
      const merchantPayTo = boundMerchantPayTo(env, isolatedBinding);
      const result = await engine.execute({
        principal,
        owner: request.owner,
        network: request.network,
        idempotencyKey: request.idempotency_key,
        maxPriceDrops: request.max_price_drops,
        ...(isolatedBinding === undefined ? {} : isolatedBinding),
      });
      return publicX402Result(principal, request, result, merchantPayTo);
    },
  });
}
