import { ledgerSigningMode } from "@pilot/wallet";

import type { CapabilityGrant, CapabilityOwnerReview } from "./ledger-capability-client";

const MEMO_TYPE = "pilot-capability-v1";
const MAX_REVIEW_TTL_MS = 60_000;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function utf8Hex(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

export function exactCapabilityProofTransaction(
  review: CapabilityOwnerReview,
  account: string,
): Readonly<Record<string, unknown>> {
  const memo = {
    action: review.action,
    approvalDigest: review.approval_digest,
    approvedAt: review.approved_at,
    capabilityRef: review.capability_ref,
    expiresAt: review.expires_at,
    generation: review.generation,
    network: review.network,
    nonce: review.nonce,
  };
  return Object.freeze({
    TransactionType: "AccountSet",
    Account: account,
    Sequence: 0,
    Fee: "0",
    LastLedgerSequence: 0,
    Memos: [{ Memo: { MemoType: utf8Hex(MEMO_TYPE), MemoData: utf8Hex(canonical(memo)) } }],
  });
}

export type BoundCapabilityOwnerReview = Readonly<{
  grant: CapabilityGrant;
  review: CapabilityOwnerReview;
  signingMode: "clear";
}>;

export function expectedCapabilityRevocationDigest(grant: CapabilityGrant): Promise<string> {
  return sha256({
    action: "capability.revoke.v1",
    capabilityRef: grant.capabilityRef,
    principal: grant.principal,
    account: grant.account,
    fromGeneration: grant.generation,
    generation: grant.generation + 1,
    grantDigest: grant.approvalDigest,
  });
}

export async function bindCapabilityOwnerReview(
  review: CapabilityOwnerReview,
  grant: CapabilityGrant,
  now = new Date(),
): Promise<BoundCapabilityOwnerReview> {
  const current = now.getTime();
  const approvedAt = Date.parse(review.approved_at);
  const expiresAt = Date.parse(review.expires_at);
  const grantNotBefore = Date.parse(grant.notBefore);
  const grantExpiresAt = Date.parse(grant.expiresAt);
  if (
    !Number.isFinite(current) || !Number.isFinite(approvedAt) || !Number.isFinite(expiresAt) ||
    !Number.isFinite(grantNotBefore) || !Number.isFinite(grantExpiresAt) ||
    review.capability_ref !== grant.capabilityRef ||
    review.network !== grant.network || grant.network !== "testnet" ||
    review.tx_json.Account !== grant.account ||
    approvedAt < grantNotBefore || approvedAt > current ||
    expiresAt <= current || expiresAt <= approvedAt ||
    expiresAt - approvedAt > MAX_REVIEW_TTL_MS || expiresAt > grantExpiresAt
  ) {
    throw new Error("The capability owner review changed its account, network, scope, or time bounds.");
  }

  let expectedDigest: string;
  if (review.action === "activate") {
    if (grant.state !== "prepared" || review.generation !== grant.generation) {
      throw new Error("The capability activation review changed its generation.");
    }
    expectedDigest = grant.approvalDigest;
  } else {
    if (grant.state !== "active" || review.generation !== grant.generation + 1) {
      throw new Error("The capability revocation review changed its generation.");
    }
    expectedDigest = await expectedCapabilityRevocationDigest(grant);
  }
  if (review.approval_digest !== expectedDigest) {
    throw new Error("The capability owner review changed its approval digest.");
  }
  if (canonical(review.tx_json) !== canonical(exactCapabilityProofTransaction(review, grant.account))) {
    throw new Error("The capability owner review changed the exact AccountSet proof.");
  }
  if (ledgerSigningMode(review.tx_json) !== "clear") {
    throw new Error("This capability proof is unsupported; there is no blind-sign fallback.");
  }
  return Object.freeze({ grant, review, signingMode: "clear" as const });
}
