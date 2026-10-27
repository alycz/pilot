import {
  NearNativeNearToArbitrumUsdcExecutableQuoteBindingSchema,
  NearNativeNearToArbitrumUsdcFundingInstructionsSchema,
  NearNativeNearToArbitrumUsdcReconcileResultSchema,
  NearNativeNearToArbitrumUsdcReserveRequestSchema,
  type NearNativeNearToArbitrumUsdcExecutableQuoteBinding,
  type NearNativeNearToArbitrumUsdcReconcileResult,
  type NearNativeNearToArbitrumUsdcReserveRequest,
} from "@pilot/contracts/near";
import { z } from "zod";

import type { NearConnectMessageProof } from "./near-connect-adapter";

const MAX_RESPONSE_BYTES = 256 * 1_024;
export const NEAR_NATIVE_LIVE_REQUEST_TIMEOUT_MS = 10_000;
const AccountIdSchema = z.string().regex(/^[a-z0-9._-]{2,64}$/);
const SignMessageBindingSchema = z.object({
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  recipient: AccountIdSchema,
});

export const NearBootstrapResponseSchema = z.object({
  preauthorized: z.literal(true),
  account_id: AccountIdSchema,
  network: z.literal("near:mainnet"),
  operations: z.tuple([z.literal("near.intents.approval.review")]),
  expires_at: z.string().datetime({ offset: true }),
  wallet_control_verified: z.literal(false),
  execution_enabled: z.literal(false),
}).strict();

export const NearGenericChallengeResponseSchema = z.object({
  account_id: AccountIdSchema,
  network: z.literal("near:mainnet"),
  provider: z.literal("nep413-full-access-key"),
  expires_at: z.string().datetime({ offset: true }),
  sign_message: SignMessageBindingSchema.extend({
    message: z.string().min(1).max(2_048),
  }).strict(),
  verification_available: z.literal(true),
  execution_enabled: z.literal(false),
}).strict();

export const NearSessionUpgradeResponseSchema = z.object({
  authenticated: z.literal(true),
  wallet_control_verified: z.literal(true),
  account_id: AccountIdSchema,
  network: z.literal("near:mainnet"),
  authorization_upgraded: z.literal(true),
  operations: z.array(z.enum([
    "near.intents.approval.review",
    "near.intents.executable-quote.review",
    "near.intents.status",
    "near.intents.owner-funded.reserve",
    "near.intents.owner-funded.reconcile",
  ])).length(5),
  execution_enabled: z.literal(false),
}).strict();

export const NearQuoteChallengeResponseSchema = z.object({
  account_id: AccountIdSchema,
  network: z.literal("near:mainnet"),
  operation: z.literal("near.intents.executable-quote.review"),
  quote_digest: z.string().regex(/^[a-f0-9]{64}$/),
  expires_at: z.string().datetime({ offset: true }),
  sign_message: SignMessageBindingSchema.extend({
    message: z.string().min(1).max(8_192),
    message_digest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  execution_enabled: z.literal(false),
}).strict();

export const NearQuoteVerifyResponseSchema = z.object({
  authenticated: z.literal(true),
  wallet_control_verified: z.literal(true),
  account_id: AccountIdSchema,
  network: z.literal("near:mainnet"),
  operation: z.literal("near.intents.executable-quote.review"),
  quote_digest: z.string().regex(/^[a-f0-9]{64}$/),
  execution_enabled: z.literal(false),
}).strict();

export const NearOwnerApproveResponseSchema = z.object({
  approved: z.literal(true),
  reserved: z.literal(true),
  action: z.enum(["reserved", "replay"]),
  replayed_existing: z.boolean(),
  approval_digest: z.string().regex(/^[A-F0-9]{64}$/),
  reservation_id: z.string().min(1).max(200),
  attempt_id: z.string().min(1).max(200),
  idempotency_key: z.string().min(1).max(200),
  funding_instructions: NearNativeNearToArbitrumUsdcFundingInstructionsSchema,
  reconciliation_context: NearNativeNearToArbitrumUsdcReserveRequestSchema,
  execution_enabled: z.literal(false),
  manual_owner_funding_only: z.literal(true),
}).strict();

export type NearBootstrapResponse = z.infer<typeof NearBootstrapResponseSchema>;
export type NearGenericChallengeResponse = z.infer<
  typeof NearGenericChallengeResponseSchema
>;
export type NearSessionUpgradeResponse = z.infer<
  typeof NearSessionUpgradeResponseSchema
>;
export type NearQuoteChallengeResponse = z.infer<
  typeof NearQuoteChallengeResponseSchema
>;
export type NearQuoteVerifyResponse = z.infer<typeof NearQuoteVerifyResponseSchema>;
export type NearOwnerApproveResponse = z.infer<typeof NearOwnerApproveResponseSchema>;

const NearOwnerReconcileResponseSchema = NearNativeNearToArbitrumUsdcReconcileResultSchema;

export type NearOwnerReconcileResponse = NearNativeNearToArbitrumUsdcReconcileResult;

async function post<T>(
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.min(Math.max(1, timeoutMs), NEAR_NATIVE_LIVE_REQUEST_TIMEOUT_MS));
  try {
    let response: Response;
    try {
      response = await fetchImpl(path, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (cause) {
      if (timedOut) throw new Error("The NEAR authorization request timed out.");
      if (controller.signal.aborted) {
        throw new DOMException("The NEAR authorization request was cancelled.", "AbortError");
      }
      throw cause;
    }
    const declared = response.headers.get("content-length");
    if (declared && Number(declared) > MAX_RESPONSE_BYTES) {
      throw new Error("The NEAR authorization response was too large.");
    }
    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      if (timedOut) throw new Error("The NEAR authorization request timed out.");
      if (controller.signal.aborted) {
        throw new DOMException("The NEAR authorization request was cancelled.", "AbortError");
      }
      throw cause;
    }
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      throw new Error("The NEAR authorization response was too large.");
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error("The NEAR authorization response was not valid JSON.");
    }
    if (!response.ok) {
      const parsed = z.object({ error: z.string().min(1).max(1_024) })
        .passthrough().safeParse(value);
      throw new Error(parsed.success ? parsed.data.error : "The NEAR authorization request failed.");
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new Error("The NEAR authorization response failed strict validation.");
    }
    return parsed.data;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export function createNearNativeLiveClient(
  fetchImpl: typeof fetch = fetch,
  options: Readonly<{ timeoutMs?: number }> = {},
) {
  const timeoutMs = options.timeoutMs ?? NEAR_NATIVE_LIVE_REQUEST_TIMEOUT_MS;
  return Object.freeze({
    bootstrap(accountId: string, signal?: AbortSignal): Promise<NearBootstrapResponse> {
      return post("/api/auth/near/bootstrap", {
        bootstrap: true,
        account_id: accountId,
        network: "near:mainnet",
      }, NearBootstrapResponseSchema, fetchImpl, signal, timeoutMs);
    },
    genericChallenge(signal?: AbortSignal): Promise<NearGenericChallengeResponse> {
      return post(
        "/api/auth/near/challenge",
        {},
        NearGenericChallengeResponseSchema,
        fetchImpl,
        signal,
        timeoutMs,
      );
    },
    upgradeSession(
      proof: NearConnectMessageProof,
      signal?: AbortSignal,
    ): Promise<NearSessionUpgradeResponse> {
      return post(
        "/api/auth/near/session",
        proof,
        NearSessionUpgradeResponseSchema,
        fetchImpl,
        signal,
        timeoutMs,
      );
    },
    quoteChallenge(
      quoteBinding: NearNativeNearToArbitrumUsdcExecutableQuoteBinding,
      signal?: AbortSignal,
    ): Promise<NearQuoteChallengeResponse> {
      return post(
        "/api/auth/near/executable-review/challenge",
        { quote_binding: quoteBinding },
        NearQuoteChallengeResponseSchema,
        fetchImpl,
        signal,
        timeoutMs,
      );
    },
    verifyQuoteProof(
      quoteBinding: NearNativeNearToArbitrumUsdcExecutableQuoteBinding,
      proof: NearConnectMessageProof,
      signal?: AbortSignal,
    ): Promise<NearQuoteVerifyResponse> {
      return post(
        "/api/auth/near/executable-review/verify",
        { quote_binding: quoteBinding, proof },
        NearQuoteVerifyResponseSchema,
        fetchImpl,
        signal,
        timeoutMs,
      );
    },
    approveAndReserve(
      quoteBinding: NearNativeNearToArbitrumUsdcExecutableQuoteBinding,
      signal?: AbortSignal,
    ): Promise<NearOwnerApproveResponse> {
      const exact = NearNativeNearToArbitrumUsdcExecutableQuoteBindingSchema.parse(
        quoteBinding,
      );
      return post(
        "/api/auth/near/executable-review/approve",
        { owner_confirmed: true, quote_binding: exact },
        NearOwnerApproveResponseSchema,
        fetchImpl,
        signal,
        timeoutMs,
      );
    },
    reconcile(
      input: Readonly<{
        context: NearNativeNearToArbitrumUsdcReserveRequest;
        stage: "source-funding" | "settlement";
        transitionId: string;
        expectedEntryRevision: number;
        nearTransactionHash?: string;
      }>,
      signal?: AbortSignal,
    ): Promise<NearOwnerReconcileResponse> {
      const context = NearNativeNearToArbitrumUsdcReserveRequestSchema.parse(
        input.context,
      );
      return post(
        "/api/auth/near/owner-funded/reconcile",
        {
          reconciliation_context: context,
          stage: input.stage,
          transition_id: input.transitionId,
          expected_entry_revision: input.expectedEntryRevision,
          ...(input.nearTransactionHash === undefined
            ? {}
            : { near_transaction_hash: input.nearTransactionHash }),
        },
        NearOwnerReconcileResponseSchema,
        fetchImpl,
        signal,
        timeoutMs,
      );
    },
  });
}
