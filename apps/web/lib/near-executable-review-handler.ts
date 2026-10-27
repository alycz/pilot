import { createHash, createHmac } from "node:crypto";

import {
  NearArbitrumUsdcToWnearExecutableQuoteBindingSchema,
  NearNativeNearToArbitrumUsdcEconomicApprovalEnvelopeSchema,
  NearNativeNearToArbitrumUsdcExecutableQuoteBindingSchema,
  NearNativeNearToArbitrumUsdcReserveRequestSchema,
  NearNativeNearToArbitrumUsdcReserveResultSchema,
  computeNearNativeNearToArbitrumUsdcApprovalDigest,
  type NearNativeNearToArbitrumUsdcReserveRequest,
  type NearNativeNearToArbitrumUsdcReserveResult,
  type NearPrincipalAuthorization,
} from "@pilot/contracts/near";
import type { Envelope } from "@pilot/contracts";
import { createHarborRestClient } from "@pilot/harbor-client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  isHarborHostedStateConfigured,
  type HostedStateClientDependencies,
  type HostedStateEnvironment,
} from "./harbor-hosted-state-client";
import {
  NEAR_EXECUTABLE_REVIEW_CHALLENGE_COOKIE,
  NEAR_EXECUTABLE_REVIEW_CHALLENGE_COOKIE_OPTIONS,
  NearExecutableReviewProofError,
  digestNearExecutableReviewQuote,
  issueNearExecutableReviewChallenge,
  verifyNearExecutableReviewProof,
  type NearExecutableReviewNonceConsumer,
} from "./near-executable-review-proof";
import {
  NEAR_EXECUTABLE_REVIEW_QUOTE_ATTESTATION_COOKIE,
  NEAR_EXECUTABLE_REVIEW_QUOTE_ATTESTATION_COOKIE_OPTIONS,
  readNearExecutableReviewQuoteAttestation,
  type NearExecutableReviewQuoteAttestation,
} from "./near-executable-review-attestation";
import {
  createHostedNearExecutableReviewNonceConsumer,
  createHostedNearExecutableReviewWalletControlConsumer,
} from "./near-executable-review-replay";
import {
  NEAR_EXECUTABLE_REVIEW_WALLET_CONTROL_COOKIE,
  NEAR_EXECUTABLE_REVIEW_WALLET_CONTROL_COOKIE_OPTIONS,
  issueNearExecutableReviewWalletControlAttestation,
  readNearExecutableReviewWalletControlAttestation,
  type NearExecutableReviewWalletControlAttestation,
  type NearExecutableReviewWalletControlConsumer,
} from "./near-executable-review-wallet-control";
import { createNearNep413FullAccessKeyVerifier } from "./near-nep413-verifier";
import {
  readNearPrincipalAuthorization,
  resolveNearWalletProofRuntime,
  type NearNep413FullAccessKeyVerifier,
  type NearWalletProofEnvironment,
} from "./near-wallet-proof";
import { readCookie } from "./openrouter-session";
import {
  resolveCredentialedHarborUpstream,
  resolvePilotRequestAuthority,
} from "./runtime-profile";

const MAX_BODY_BYTES = 256 * 1_024;

const ChallengeRequestSchema = z.object({
  quote_binding: z.union([
    NearArbitrumUsdcToWnearExecutableQuoteBindingSchema,
    NearNativeNearToArbitrumUsdcExecutableQuoteBindingSchema,
  ]),
}).strict();

const VerifyRequestSchema = ChallengeRequestSchema.extend({
  proof: z.object({
    account_id: z.string(),
    public_key: z.string(),
    signature: z.string(),
  }).strict(),
}).strict();

const ApproveRequestSchema = z.object({
  owner_confirmed: z.literal(true),
  quote_binding: NearNativeNearToArbitrumUsdcExecutableQuoteBindingSchema,
}).strict();

const UPPER_HEX_64 = /^[A-F0-9]{64}$/;
const APPROVAL_ID_DOMAIN = "pilot.near.native-owner-funded.ids.v1";
const REQUEST_DIGEST_DOMAIN = "pilot.near.native-owner-funded.request.v1";
const RESERVE_OPERATION = "near.intents.owner-funded.reserve" as const;

type Environment = NearWalletProofEnvironment & HostedStateEnvironment & Readonly<{
  NEXT_PUBLIC_DEV_SIGNER?: string;
  NEXT_PUBLIC_PILOT_BUILD_MARKER?: string;
  PILOT_PUBLIC_ORIGIN?: string;
  PILOT_NEAR_OWNER_FUNDED_APPROVAL_ENABLED?: string;
  PILOT_NEAR_OWNER_FUNDED_POLICY_DIGEST?: string;
}>;

type CommonDependencies = Readonly<{
  environment?: Environment;
  clock?: () => number;
}>;

export type NearExecutableReviewChallengeHandlerDependencies =
  CommonDependencies & Readonly<{
    nonce?: () => string;
    replayProtectionConfigured?: (environment: Environment) => boolean;
    readQuoteAttestation?: (
      request: Request,
      input: Readonly<{
        authorization: NearPrincipalAuthorization;
        quoteBinding: unknown;
        environment: Environment;
        now: number;
      }>,
    ) => NearExecutableReviewQuoteAttestation | null;
  }>;

export type NearExecutableReviewVerifyHandlerDependencies =
  CommonDependencies & Readonly<{
    verifier?: NearNep413FullAccessKeyVerifier;
    nonceConsumerFactory?: (
      binding: Readonly<{
        principalId: string;
        accountId: string;
        network: "near:mainnet";
        authorizationId: string;
        quoteDigest: string;
        recipient: string;
      }>,
    ) => NearExecutableReviewNonceConsumer;
    hostedStateDependencies?: HostedStateClientDependencies;
    walletControlNonce?: () => string;
  }>;

export type NearOwnerFundedReserveClient = Readonly<{
  op(
    name: typeof RESERVE_OPERATION,
    args: NearNativeNearToArbitrumUsdcReserveRequest,
  ): Promise<Envelope<NearNativeNearToArbitrumUsdcReserveResult>>;
}>;

export type NearExecutableReviewApproveHandlerDependencies =
  CommonDependencies & Readonly<{
    reserveClient?: NearOwnerFundedReserveClient;
    walletControlConsumerFactory?: (
      binding: Readonly<{
        principalId: string;
        accountId: string;
        network: "near:mainnet";
        authorizationId: string;
        quoteDigest: string;
        recipient: string;
      }>,
    ) => NearExecutableReviewWalletControlConsumer;
    hostedStateDependencies?: HostedStateClientDependencies;
  }>;

function sameOrigin(request: NextRequest, expectedOrigin: string): boolean {
  return request.headers.get("origin") === expectedOrigin;
}

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function clearWalletControlCookie(response: NextResponse): NextResponse {
  response.cookies.set(NEAR_EXECUTABLE_REVIEW_WALLET_CONTROL_COOKIE, "", {
    ...NEAR_EXECUTABLE_REVIEW_WALLET_CONTROL_COOKIE_OPTIONS,
    maxAge: 0,
  });
  return response;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, entry]) => `${JSON.stringify(name)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function upperSha256(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain, "utf8").update("\0", "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex").toUpperCase();
}

function serverIdentifier(
  environment: Environment,
  label: string,
  attestation: NearExecutableReviewWalletControlAttestation,
  policyDigest: string,
): string {
  const secret = environment.SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error("NEAR owner-funded approval is unavailable.");
  }
  return `near-${label}-${createHmac("sha256", secret)
    .update(APPROVAL_ID_DOMAIN, "utf8").update("\0", "utf8")
    .update(label, "utf8").update("\0", "utf8")
    .update(attestation.authorization.authorization_id, "utf8")
    .update("\0", "utf8").update(attestation.quote_digest, "utf8")
    .update("\0", "utf8").update(attestation.one_time_nonce, "utf8")
    .update("\0", "utf8").update(policyDigest, "utf8")
    .digest("hex")}`;
}

function configuredPolicyDigest(environment: Environment): string {
  const digest = environment.PILOT_NEAR_OWNER_FUNDED_POLICY_DIGEST?.trim();
  if (
    environment.PILOT_NEAR_OWNER_FUNDED_APPROVAL_ENABLED !== "true" ||
    !digest || !UPPER_HEX_64.test(digest)
  ) {
    throw new Error("NEAR owner-funded approval is unavailable.");
  }
  return digest;
}

function proofError(error: unknown): NextResponse {
  if (!(error instanceof NearExecutableReviewProofError)) {
    return jsonError(503, "NEAR executable-review wallet proof is unavailable.");
  }
  const status =
    error.code === "PRINCIPAL_MISMATCH" || error.code === "ACCOUNT_MISMATCH"
      ? 403
      : error.code === "QUOTE_MUTATED" || error.code === "QUOTE_EXPIRED" ||
          error.code === "CHALLENGE_EXPIRED" || error.code === "PROOF_REPLAYED"
        ? 409
        : error.code === "RUNTIME_DISABLED" || error.code === "RUNTIME_INVALID" ||
            error.code === "VERIFIER_UNAVAILABLE" ||
            error.code === "REPLAY_PROTECTION_UNAVAILABLE"
          ? 503
          : 401;
  return jsonError(status, error.message);
}

async function boundedJson(request: NextRequest): Promise<unknown> {
  const mediaType = request.headers.get("content-type")
    ?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new NearExecutableReviewProofError(
      "CHALLENGE_INVALID",
      "NEAR executable-review requests must use application/json.",
    );
  }
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_BODY_BYTES)
  ) {
    throw new NearExecutableReviewProofError(
      "CHALLENGE_INVALID",
      "The NEAR executable-review request is invalid.",
    );
  }
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    throw new NearExecutableReviewProofError(
      "CHALLENGE_INVALID",
      "The NEAR executable-review request is invalid.",
    );
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new NearExecutableReviewProofError(
      "CHALLENGE_INVALID",
      "The NEAR executable-review request is invalid.",
    );
  }
}

function authority(
  request: NextRequest,
  environment: Environment,
): NextResponse | undefined {
  let expectedOrigin: string;
  try {
    expectedOrigin = resolvePilotRequestAuthority(environment, request).origin;
  } catch {
    return jsonError(
      403,
      "NEAR executable-review wallet proof is unavailable for this request.",
    );
  }
  if (!sameOrigin(request, expectedOrigin)) {
    return jsonError(
      403,
      "Same-origin NEAR executable-review wallet proof is required.",
    );
  }
  return undefined;
}

function activeAuthorization(
  request: NextRequest,
  environment: Environment,
  now: number,
): NearPrincipalAuthorization | NextResponse {
  let authorization: NearPrincipalAuthorization | null;
  try {
    authorization = readNearPrincipalAuthorization(request, { environment, now });
  } catch {
    return jsonError(503, "NEAR executable-review wallet proof is unavailable.");
  }
  if (
    authorization === null ||
    authorization.network !== "near:mainnet" ||
    !authorization.operations.includes("near.intents.executable-quote.review")
  ) {
    return jsonError(
      401,
      "An active executable-review NEAR principal authorization is required.",
    );
  }
  return authorization;
}

export function createNearExecutableReviewChallengeHandler(
  dependencies: NearExecutableReviewChallengeHandlerDependencies = {},
): (request: NextRequest) => Promise<NextResponse> {
  return async function handleChallenge(request): Promise<NextResponse> {
    const environment = dependencies.environment ?? process.env;
    const denied = authority(request, environment);
    if (denied) return denied;
    const now = (dependencies.clock ?? Date.now)();
    const authorization = activeAuthorization(request, environment, now);
    if (authorization instanceof NextResponse) return authorization;
    try {
      if (
        environment.PILOT_DEPLOYMENT_PROFILE !== "hosted" ||
        !(dependencies.replayProtectionConfigured ??
          isHarborHostedStateConfigured)(environment)
      ) {
        throw new NearExecutableReviewProofError(
          "REPLAY_PROTECTION_UNAVAILABLE",
          "Executable-review replay protection is unavailable.",
        );
      }
      const runtime = resolveNearWalletProofRuntime(environment);
      const body = ChallengeRequestSchema.safeParse(await boundedJson(request));
      if (!body.success) {
        throw new NearExecutableReviewProofError(
          "QUOTE_INVALID",
          "The executable quote binding is invalid.",
        );
      }
      let attestation: NearExecutableReviewQuoteAttestation | null;
      try {
        attestation = (dependencies.readQuoteAttestation ??
          readNearExecutableReviewQuoteAttestation)(request, {
          authorization,
          quoteBinding: body.data.quote_binding,
          environment,
          now,
        });
      } catch {
        attestation = null;
      }
      if (!attestation) {
        throw new NearExecutableReviewProofError(
          "QUOTE_INVALID",
          "A current server-attested executable quote is required.",
        );
      }
      const challenge = issueNearExecutableReviewChallenge({
        authorization,
        quoteBinding: body.data.quote_binding,
        runtime,
        environment,
        now,
        ...(dependencies.nonce ? { nonce: dependencies.nonce() } : {}),
      });
      const response = NextResponse.json({
        account_id: authorization.account_id,
        network: authorization.network,
        operation: "near.intents.executable-quote.review",
        quote_digest: challenge.quoteDigest,
        expires_at: new Date(challenge.expiresAt).toISOString(),
        sign_message: challenge.signMessage,
        execution_enabled: false,
      });
      response.cookies.set(
        NEAR_EXECUTABLE_REVIEW_CHALLENGE_COOKIE,
        challenge.cookie,
        NEAR_EXECUTABLE_REVIEW_CHALLENGE_COOKIE_OPTIONS,
      );
      response.cookies.set(NEAR_EXECUTABLE_REVIEW_QUOTE_ATTESTATION_COOKIE, "", {
        ...NEAR_EXECUTABLE_REVIEW_QUOTE_ATTESTATION_COOKIE_OPTIONS,
        maxAge: 0,
      });
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch (error) {
      return proofError(error);
    }
  };
}

export function createNearExecutableReviewVerifyHandler(
  dependencies: NearExecutableReviewVerifyHandlerDependencies = {},
): (request: NextRequest) => Promise<NextResponse> {
  return async function handleVerify(request): Promise<NextResponse> {
    const environment = dependencies.environment ?? process.env;
    const denied = authority(request, environment);
    if (denied) return denied;
    const clock = dependencies.clock ?? Date.now;
    const now = clock();
    const authorization = activeAuthorization(request, environment, now);
    if (authorization instanceof NextResponse) return authorization;
    try {
      if (environment.PILOT_DEPLOYMENT_PROFILE !== "hosted") {
        throw new NearExecutableReviewProofError(
          "RUNTIME_INVALID",
          "NEAR executable-review wallet proof verification is unavailable.",
        );
      }
      const runtime = resolveNearWalletProofRuntime(environment);
      const body = VerifyRequestSchema.safeParse(await boundedJson(request));
      if (!body.success) {
        throw new NearExecutableReviewProofError(
          "PROOF_INVALID",
          "The executable-review proof request is invalid.",
        );
      }
      const quoteDigest = digestNearExecutableReviewQuote(body.data.quote_binding);
      const replayBinding = {
        principalId: authorization.principal_id,
        accountId: authorization.account_id,
        network: authorization.network,
        authorizationId: authorization.authorization_id,
        quoteDigest,
        recipient: runtime.recipient,
      } as const;
      const nonceConsumer = dependencies.nonceConsumerFactory?.(replayBinding) ??
        createHostedNearExecutableReviewNonceConsumer(
          replayBinding,
          environment,
          dependencies.hostedStateDependencies,
        );
      const verified = await verifyNearExecutableReviewProof({
        challengeCookie: readCookie(
          request,
          NEAR_EXECUTABLE_REVIEW_CHALLENGE_COOKIE,
        ),
        currentAuthorization: authorization,
        currentQuoteBinding: body.data.quote_binding,
        proof: body.data.proof,
        runtime,
        environment,
        verifier: dependencies.verifier ??
          createNearNep413FullAccessKeyVerifier(),
        nonceConsumer,
        now,
        clock,
      });
      const response = NextResponse.json({
        authenticated: true,
        wallet_control_verified: true,
        account_id: verified.account_id,
        network: verified.authorization.network,
        operation: "near.intents.executable-quote.review",
        quote_digest: verified.quote_digest,
        execution_enabled: false,
      });
      const walletControl = issueNearExecutableReviewWalletControlAttestation({
        verified,
        environment,
        now,
        ...(dependencies.walletControlNonce
          ? { oneTimeNonce: dependencies.walletControlNonce() }
          : {}),
      });
      response.cookies.set(NEAR_EXECUTABLE_REVIEW_CHALLENGE_COOKIE, "", {
        ...NEAR_EXECUTABLE_REVIEW_CHALLENGE_COOKIE_OPTIONS,
        maxAge: 0,
      });
      if (walletControl) {
        response.cookies.set(
          NEAR_EXECUTABLE_REVIEW_WALLET_CONTROL_COOKIE,
          walletControl.cookie,
          {
            ...NEAR_EXECUTABLE_REVIEW_WALLET_CONTROL_COOKIE_OPTIONS,
            maxAge: Math.max(
              1,
              Math.ceil((walletControl.expiresAt - now) / 1_000),
            ),
          },
        );
      } else {
        response.cookies.set(NEAR_EXECUTABLE_REVIEW_WALLET_CONTROL_COOKIE, "", {
          ...NEAR_EXECUTABLE_REVIEW_WALLET_CONTROL_COOKIE_OPTIONS,
          maxAge: 0,
        });
      }
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch (error) {
      return proofError(error);
    }
  };
}

export function createNearExecutableReviewApproveHandler(
  dependencies: NearExecutableReviewApproveHandlerDependencies = {},
): (request: NextRequest) => Promise<NextResponse> {
  return async function handleApproval(request): Promise<NextResponse> {
    const environment = dependencies.environment ?? process.env;
    const denied = authority(request, environment);
    if (denied) return denied;
    const now = (dependencies.clock ?? Date.now)();
    const authorization = activeAuthorization(request, environment, now);
    if (authorization instanceof NextResponse) return authorization;

    let body: z.infer<typeof ApproveRequestSchema>;
    try {
      const parsed = ApproveRequestSchema.safeParse(await boundedJson(request));
      if (!parsed.success) {
        return clearWalletControlCookie(jsonError(
          400,
          "An explicit owner confirmation for the exact native NEAR quote is required.",
        ));
      }
      body = parsed.data;
    } catch {
      return clearWalletControlCookie(jsonError(
        400,
        "The NEAR owner-funded approval request is invalid.",
      ));
    }

    const fail = (status: number, message: string) =>
      clearWalletControlCookie(jsonError(status, message));

    try {
      if (environment.PILOT_DEPLOYMENT_PROFILE !== "hosted") {
        return fail(503, "NEAR owner-funded approval is unavailable.");
      }
      const policyDigest = configuredPolicyDigest(environment);
      const runtime = resolveNearWalletProofRuntime(environment);
      if (runtime.mode !== "verify") {
        return fail(503, "NEAR owner-funded approval is unavailable.");
      }
      const attestation = readNearExecutableReviewWalletControlAttestation(
        request,
        {
          authorization,
          quoteBinding: body.quote_binding,
          environment,
          now,
        },
      );
      if (!attestation) {
        return fail(401, "A fresh quote-bound NEAR wallet-control proof is required.");
      }
      const replayBinding = {
        principalId: authorization.principal_id,
        accountId: authorization.account_id,
        network: authorization.network,
        authorizationId: authorization.authorization_id,
        quoteDigest: attestation.quote_digest,
        recipient: runtime.recipient,
      } as const;
      const consumer = dependencies.walletControlConsumerFactory?.(replayBinding) ??
        createHostedNearExecutableReviewWalletControlConsumer(
          replayBinding,
          environment,
          dependencies.hostedStateDependencies,
        );
      const consumed = await consumer.consume({
        version: "pilot-near-native-wallet-control-consumption-v1",
        principalId: authorization.principal_id,
        accountId: authorization.account_id,
        network: authorization.network,
        authorizationId: authorization.authorization_id,
        quoteDigest: attestation.quote_digest,
        oneTimeNonce: attestation.one_time_nonce,
        expiresAt: attestation.proof_expires_at_ms,
        now,
      });
      if (!consumed) {
        return fail(409, "The NEAR wallet-control proof was already used or rejected.");
      }
      const reserveClient = dependencies.reserveClient ?? (() => {
        const upstream = resolveCredentialedHarborUpstream(environment, request);
        return createHarborRestClient({
          ...upstream,
          mock: false,
          signal: request.signal,
          timeoutMs: 10_000,
        });
      })();

      const quote = body.quote_binding;
      if (
        authorization.account_id !== quote.refund_to ||
        Date.parse(quote.approval_expires_at) <= now ||
        Date.parse(quote.provider_time_when_inactive_at) <= now ||
        Date.parse(quote.provider_deadline_at) <= now
      ) {
        return fail(409, "The executable quote is no longer valid for approval.");
      }
      const idempotencyKey = serverIdentifier(
        environment,
        "idempotency",
        attestation,
        policyDigest,
      );
      const attemptId = serverIdentifier(
        environment,
        "attempt",
        attestation,
        policyDigest,
      );
      const reservationId = serverIdentifier(
        environment,
        "reservation",
        attestation,
        policyDigest,
      );
      const approvalId = serverIdentifier(
        environment,
        "approval",
        attestation,
        policyDigest,
      );
      const requestDigest = upperSha256(REQUEST_DIGEST_DOMAIN, {
        principal_id: authorization.principal_id,
        near_account_id: authorization.account_id,
        network: authorization.network,
        policy_digest: policyDigest,
        quote_digest: attestation.quote_digest,
        quote_binding: quote,
        idempotency_key: idempotencyKey,
        attempt_id: attemptId,
        reservation_id: reservationId,
      });
      const approvedAt = new Date(now).toISOString();
      const payload = {
        version: "pilot-near-native-near-to-arbitrum-usdc-approval-payload-v1" as const,
        route: quote.route,
        principal_id: authorization.principal_id,
        near_account_id: authorization.account_id,
        network: authorization.network,
        policy_digest: policyDigest,
        quote_hash: quote.quote_hash,
        correlation_id: quote.correlation_id,
        origin_asset_id: quote.route.origin_asset_id,
        destination_asset_id: quote.route.destination_asset_id,
        amount_in: quote.amount_in,
        min_amount_out: quote.min_amount_out,
        recipient: quote.recipient,
        refund_to: quote.refund_to,
        deposit_address: quote.deposit_address,
        deposit_memo_present: quote.deposit_memo_present,
        provider_deadline_at: quote.provider_deadline_at,
        approved_at: approvedAt,
        approval_expires_at: quote.approval_expires_at,
        reservation: {
          version:
            "pilot-near-native-near-to-arbitrum-usdc-reservation-v1" as const,
          reservation_id: reservationId,
          attempt_id: attemptId,
          principal_id: authorization.principal_id,
          near_account_id: authorization.account_id,
          network: authorization.network,
          idempotency_version: "pilot-near-idempotency-v1" as const,
          idempotency_key: idempotencyKey,
          request_digest: requestDigest,
          asset_id: quote.route.origin_asset_id,
          amount_atomic: quote.amount_in,
          expected_revision: 0,
          reserved_revision: 1,
        },
      };
      const approvalDigest = await
        computeNearNativeNearToArbitrumUsdcApprovalDigest(payload);
      const approval = NearNativeNearToArbitrumUsdcEconomicApprovalEnvelopeSchema.parse({
        version:
          "pilot-near-native-near-to-arbitrum-usdc-economic-approval-v1",
        payload,
        approval_digest: approvalDigest,
        account_control: {
          version: "pilot-near-account-control-proof-v1",
          proof_kind: "nep413",
          scope: "source-account-control-only",
          grants_economic_transfer_approval: false,
          authorization_id: authorization.authorization_id,
          principal_id: authorization.principal_id,
          near_account_id: authorization.account_id,
          network: authorization.network,
          verified_at: attestation.proof_verified_at,
        },
        economic_approval: {
          approval_id: approvalId,
          method: "owner-reviewed-native-near-transfer",
          owner_confirmed: true,
          approved_payload_digest: approvalDigest,
          confirmed_at: approvedAt,
        },
      });
      const reserveRequest = NearNativeNearToArbitrumUsdcReserveRequestSchema.parse({
        version: "pilot-near-native-to-arbitrum-usdc-reserve-request-v1",
        quote_binding: quote,
        approval,
        idempotency_version: "pilot-near-idempotency-v1",
        idempotency_key: idempotencyKey,
        attempt_id: attemptId,
        reservation_id: reservationId,
      });
      const envelope = await reserveClient.op(
        RESERVE_OPERATION,
        reserveRequest,
      );
      if (!envelope.ok) {
        return fail(503, "NEAR owner-funded reservation was not durably confirmed.");
      }
      const result = NearNativeNearToArbitrumUsdcReserveResultSchema.safeParse(
        envelope.data,
      );
      if (
        !result.success ||
        result.data.quote_hash !== quote.quote_hash ||
        result.data.correlation_id !== quote.correlation_id ||
        result.data.admission_id !== approvalId ||
        result.data.approval_digest !== approvalDigest ||
        result.data.request_digest !== requestDigest ||
        result.data.idempotency_key !== idempotencyKey ||
        result.data.attempt_id !== attemptId ||
        result.data.reservation_id !== reservationId ||
        result.data.reservation_state !== "reserved" ||
        result.data.attempt_revision !== 1 ||
        result.data.reservation_revision !== 1 ||
        result.data.funding_instructions.route_version !== quote.route.version ||
        result.data.funding_instructions.quote_hash !== quote.quote_hash ||
        result.data.funding_instructions.correlation_id !==
          quote.correlation_id ||
        result.data.funding_instructions.source_account_id !==
          authorization.account_id ||
        result.data.funding_instructions.refund_account_id !== quote.refund_to ||
        result.data.funding_instructions.destination_recipient.toLowerCase() !==
          quote.recipient.toLowerCase() ||
        result.data.funding_instructions.deposit_account_id !==
          quote.deposit_address ||
        result.data.funding_instructions.amount_yocto_near !== quote.amount_in ||
        result.data.funding_instructions.provider_deadline_at !==
          quote.provider_deadline_at
      ) {
        return fail(503, "NEAR owner-funded reservation was not durably confirmed.");
      }
      return clearWalletControlCookie(NextResponse.json({
        approved: true,
        reserved: true,
        action: result.data.action,
        replayed_existing: result.data.replayed_existing,
        approval_digest: approvalDigest,
        reservation_id: reservationId,
        attempt_id: attemptId,
        idempotency_key: idempotencyKey,
        funding_instructions: result.data.funding_instructions,
        execution_enabled: false,
        manual_owner_funding_only: true,
      }, { headers: { "Cache-Control": "no-store" } }));
    } catch {
      return fail(503, "NEAR owner-funded approval is unavailable.");
    }
  };
}
