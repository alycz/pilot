import type {
  ArgsFor,
  HarborClient,
  NearIntentsExecutableQuoteReviewResult,
  NearIntentsStatusResult,
} from "@pilot/harbor-client";

type NearReviewClient = Pick<HarborClient, "op">;
export type LiveNearOwnerFundedReview = Extract<
  NearIntentsExecutableQuoteReviewResult,
  { source: "live" }
>;
export type LiveNearOwnerFundedStatus = NearIntentsStatusResult & {
  source: "live";
  signature_verified: true;
};

function errorMessage(envelope: { error?: { message?: string } }, fallback: string): string {
  const message = envelope.error?.message;
  return typeof message === "string" && message.trim() ? message : fallback;
}

/**
 * Requests the single supported owner-funded route. This boundary never turns
 * a local fixture into a fundable review and never exposes provider credentials.
 */
export async function loadLiveNearOwnerFundedReview(
  client: NearReviewClient,
  args: ArgsFor<"near.intents.executable-quote.review">,
  nowMs = Date.now(),
): Promise<LiveNearOwnerFundedReview> {
  const envelope = await client.op("near.intents.executable-quote.review", args);
  if (!envelope.ok) {
    throw new Error(errorMessage(envelope, "The NEAR Intents executable quote review is unavailable."));
  }
  if (envelope.data.source !== "live" || envelope.data.provider_signature_verified !== true) {
    throw new Error("Harbor returned fixture data; no provider-verified owner-funding review is available.");
  }
  if (Date.parse(envelope.data.quote_binding.approval_expires_at) <= nowMs) {
    throw new Error("The provider-verified owner-funding review has expired; request a fresh quote.");
  }
  return envelope.data;
}

/** Reads status with the exact quote hash, correlation id, and deposit address. */
export async function loadLiveNearOwnerFundedStatus(
  client: NearReviewClient,
  review: LiveNearOwnerFundedReview,
): Promise<LiveNearOwnerFundedStatus> {
  const lookup = review.owner_review.status_lookup;
  const envelope = await client.op("near.intents.status", {
    deposit_address: lookup.deposit_address,
    expected_correlation_id: lookup.expected_correlation_id,
    expected_quote_hash: lookup.expected_quote_hash,
  });
  if (!envelope.ok) {
    throw new Error(errorMessage(envelope, "The NEAR Intents settlement status is unavailable."));
  }
  if (envelope.data.source !== "live" || envelope.data.signature_verified !== true) {
    throw new Error("Harbor returned fixture data; no provider-verified settlement status is available.");
  }
  return envelope.data;
}
