import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import {
  ledgerRuntimeProvenance,
  validateExactLedgerAction,
  type ExactLedgerActionExpectation,
  type ExactLedgerActionReview,
} from "@pilot/wallet";
import { decode, isValidClassicAddress } from "xrpl";
import { z } from "zod";

const MAX_PAIRING_TTL_MS = 5 * 60_000;
const CAPABILITY_BYTES = 32;
const MAX_PAIRINGS = 128;
const IdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/);
const PairingIdSchema = z.string().regex(/^pair_[A-Za-z0-9_-]{32,128}$/);
const TransactionDigestSchema = z.string().regex(/^[A-F0-9]{64}$/);
const ReviewDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const CapabilitySchema = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/);

/** Only actions covered by the wallet's exact-action policy may cross the bridge. */
const ExactActionKindSchema = z.enum([
  "payment",
  "delegate-grant",
  "delegate-revoke",
  "escrow-create",
  "escrow-finish",
  "escrow-cancel",
]);

export const CompanionSignRequestSchema = z.object({
  version: z.literal(1),
  pairing_id: PairingIdSchema,
  request_id: IdentifierSchema,
  session_id: IdentifierSchema,
  network: z.literal("testnet"),
  account: z.string().refine(isValidClassicAddress, "account must be a classic XRPL address"),
  action: ExactActionKindSchema,
  review_digest: ReviewDigestSchema,
  transaction_digest: TransactionDigestSchema,
  unsigned_tx_blob: z.string().min(2).max(20_000).regex(/^(?:[A-Fa-f0-9]{2})+$/),
}).strict();

export type CompanionSignRequest = z.infer<typeof CompanionSignRequestSchema>;
export type CompanionSignedAction = z.infer<typeof ExactActionKindSchema>;

export type CompanionPairingScope = Readonly<{
  pairingId: string;
  approvedOrigin: string;
  sessionId: string;
  network: "testnet";
  account: string;
  action: CompanionSignedAction;
  reviewDigest: string;
  transactionDigest: string;
  expiresAt: string;
}>;

export type CompanionPairing = Readonly<{
  capability: string;
  scope: CompanionPairingScope;
}>;

export type LocalPairingReview = Readonly<{
  approvedOrigin: string;
  sessionId: string;
  pairingExpiresAt: string;
  expectation: ExactLedgerActionExpectation;
  transaction: Readonly<Record<string, unknown>>;
  review: ExactLedgerActionReview;
}>;

export type LocalPairingApproval = (
  input: LocalPairingReview,
) => boolean | Promise<boolean>;

type PairingStatus = "active" | "reserved" | "signed" | "rejected" | "unknown" | "revoked";
type StoredPairing = Readonly<{
  tokenHash: Buffer;
  scope: CompanionPairingScope;
  expectation: ExactLedgerActionExpectation;
  status: PairingStatus;
  requestId?: string;
}>;

export class LedgerCompanionProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LedgerCompanionProtocolError";
  }
}

function fail(code: string, message: string): never {
  throw new LedgerCompanionProtocolError(code, message);
}

function exactHttpsOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("INVALID_ORIGIN", "The approved web origin is invalid.");
  }
  if (
    url.protocol !== "https:" || value !== url.origin || url.username || url.password ||
    url.pathname !== "/" || url.search || url.hash || value.includes("*")
  ) return fail("INVALID_ORIGIN", "The approved web origin must be one exact HTTPS origin.");
  return url.origin;
}

function sha256Bytes(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

function tokenHash(value: string): Buffer {
  return sha256Bytes(Buffer.from(value, "utf8"));
}

function equalHash(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function decodeUnsignedTransaction(unsignedTxBlob: string): Readonly<Record<string, unknown>> {
  let transaction: Record<string, unknown>;
  try {
    transaction = decode(unsignedTxBlob) as Record<string, unknown>;
  } catch {
    return fail("INVALID_TRANSACTION", "The prepared transaction could not be decoded.");
  }
  return Object.freeze({ ...transaction });
}

function immutableCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (child: unknown): void => {
    if (child === null || typeof child !== "object" || Object.isFrozen(child)) return;
    for (const nested of Object.values(child as Record<string, unknown>)) freeze(nested);
    Object.freeze(child);
  };
  freeze(copy);
  return copy;
}

export function companionTransactionDigest(unsignedTxBlob: string): string {
  if (!/^(?:[A-Fa-f0-9]{2})+$/.test(unsignedTxBlob) || unsignedTxBlob.length > 20_000) {
    return fail("INVALID_TRANSACTION", "The prepared transaction bytes are invalid.");
  }
  return createHash("sha256").update(Buffer.from(unsignedTxBlob, "hex")).digest("hex").toUpperCase();
}

export class LedgerCompanionPairingRegistry {
  readonly #approvedOrigin: string;
  readonly #approveLocalPairing: LocalPairingApproval;
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #pairings = new Map<string, StoredPairing>();

  constructor(input: Readonly<{
    approvedOrigin: string;
    /**
     * This callback belongs to the companion's local control surface. A hosted
     * request must never be allowed to supply or bypass it.
     */
    approveLocalPairing?: LocalPairingApproval;
    now?: () => number;
    randomBytes?: (size: number) => Uint8Array;
  }>) {
    this.#approvedOrigin = exactHttpsOrigin(input.approvedOrigin);
    this.#approveLocalPairing = input.approveLocalPairing ?? (() => false);
    this.#now = input.now ?? Date.now;
    this.#randomBytes = input.randomBytes ?? ((size) => randomBytes(size));
  }

  /**
   * Issue only from a loopback local-control handler after it has rendered the
   * full semantic review. There is deliberately no caller-controlled
   * `approved: true` field in this API.
   */
  async issueFromLocalControl(input: Readonly<{
    sessionId: string;
    network: "testnet";
    account: string;
    unsignedTxBlob: string;
    expectation: ExactLedgerActionExpectation;
    ttlMs: number;
  }>): Promise<CompanionPairing> {
    this.#pruneExpired();
    if (this.#pairings.size >= MAX_PAIRINGS) {
      fail("PAIRING_CAPACITY", "The companion pairing capacity is full.");
    }
    const sessionId = IdentifierSchema.parse(input.sessionId);
    if (input.network !== "testnet") fail("NETWORK_UNSUPPORTED", "The emulator companion is Testnet-only.");
    if (!isValidClassicAddress(input.account)) fail("INVALID_ACCOUNT", "The paired account is invalid.");
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1_000 || input.ttlMs > MAX_PAIRING_TTL_MS) {
      fail("INVALID_PAIRING_TTL", "Pairing expiry must be between one second and five minutes.");
    }
    if (input.expectation.network !== input.network || input.expectation.account !== input.account) {
      fail("PAIRING_SCOPE_MISMATCH", "The reviewed action does not match the paired account and network.");
    }

    const expectation = immutableCopy(input.expectation);
    const transaction = decodeUnsignedTransaction(input.unsignedTxBlob);
    const firstNow = this.#validNow();
    const firstReview = await validateExactLedgerAction({
      transaction,
      expectation,
      provenance: ledgerRuntimeProvenance("speculos"),
      phase: "before-sign",
      now: firstNow,
    });
    const pairingExpiryMs = Math.min(
      firstNow + input.ttlMs,
      expectation.approvalExpiresAtMs,
      expectation.quoteExpiresAtMs ?? Number.POSITIVE_INFINITY,
    );
    if (pairingExpiryMs <= firstNow) fail("PAIRING_EXPIRED", "The reviewed pairing is already expired.");
    const pairingExpiresAt = new Date(pairingExpiryMs).toISOString();
    const approved = await this.#approveLocalPairing(Object.freeze({
      approvedOrigin: this.#approvedOrigin,
      sessionId,
      pairingExpiresAt,
      expectation,
      transaction,
      review: firstReview,
    }));
    if (approved !== true) fail("LOCAL_APPROVAL_REQUIRED", "Explicit approval in the local companion is required.");

    // Approval may take time. Re-run the exact validator immediately before
    // issuing the capability so a stale quote or approval cannot be paired.
    const issueNow = this.#validNow();
    const review = await validateExactLedgerAction({
      transaction,
      expectation,
      provenance: ledgerRuntimeProvenance("speculos"),
      phase: "before-sign",
      now: issueNow,
    });
    if (review.digest !== firstReview.digest || pairingExpiryMs <= issueNow) {
      fail("PAIRING_EXPIRED", "The reviewed pairing expired before it could be issued.");
    }

    const pairBytes = this.#randomBytes(CAPABILITY_BYTES);
    const capabilityBytes = this.#randomBytes(CAPABILITY_BYTES);
    if (pairBytes.byteLength !== CAPABILITY_BYTES || capabilityBytes.byteLength !== CAPABILITY_BYTES) {
      fail("RANDOMNESS_UNAVAILABLE", "Secure pairing randomness is unavailable.");
    }
    const pairingId = `pair_${Buffer.from(pairBytes).toString("base64url")}`;
    const capability = Buffer.from(capabilityBytes).toString("base64url");
    const scope: CompanionPairingScope = Object.freeze({
      pairingId,
      approvedOrigin: this.#approvedOrigin,
      sessionId,
      network: "testnet",
      account: input.account,
      action: ExactActionKindSchema.parse(review.action),
      reviewDigest: ReviewDigestSchema.parse(review.digest),
      transactionDigest: companionTransactionDigest(input.unsignedTxBlob),
      expiresAt: pairingExpiresAt,
    });
    this.#pairings.set(pairingId, Object.freeze({
      tokenHash: tokenHash(capability),
      scope,
      expectation,
      status: "active",
    }));
    return Object.freeze({ capability, scope });
  }

  async authorizeSign(input: Readonly<{
    origin: string | null;
    capability: string | null;
    request: unknown;
  }>): Promise<Readonly<{
    request: CompanionSignRequest;
    transaction: Readonly<Record<string, unknown>>;
    review: ExactLedgerActionReview;
  }>> {
    const request = CompanionSignRequestSchema.parse(input.request);
    const stored = this.#pairings.get(request.pairing_id);
    if (stored === undefined) fail("PAIRING_NOT_FOUND", "The pairing is unavailable.");
    this.#assertTransportBinding(stored, input.origin, input.capability);
    this.#assertUnexpired(request.pairing_id, stored);
    if (stored.status !== "active") fail("PAIRING_REPLAY", "The pairing has already been used or revoked.");
    if (
      request.session_id !== stored.scope.sessionId || request.network !== stored.scope.network ||
      request.account !== stored.scope.account || request.action !== stored.scope.action ||
      request.review_digest !== stored.scope.reviewDigest ||
      request.transaction_digest !== stored.scope.transactionDigest
    ) fail("PAIRING_SCOPE_MISMATCH", "The request changed the approved pairing scope.");
    const digest = companionTransactionDigest(request.unsigned_tx_blob);
    if (digest !== request.transaction_digest) fail("TRANSACTION_BINDING_MISMATCH", "The prepared transaction bytes changed.");
    const transaction = decodeUnsignedTransaction(request.unsigned_tx_blob);
    const review = await validateExactLedgerAction({
      transaction,
      expectation: stored.expectation,
      provenance: ledgerRuntimeProvenance("speculos"),
      phase: "before-sign",
      now: this.#validNow(),
    });
    if (review.action !== request.action || review.digest !== request.review_digest) {
      fail("REVIEW_BINDING_MISMATCH", "The exact semantic review changed after pairing.");
    }
    this.#pairings.set(request.pairing_id, Object.freeze({
      ...stored,
      status: "reserved",
      requestId: request.request_id,
    }));
    return Object.freeze({ request: Object.freeze(request), transaction, review });
  }

  resolve(input: Readonly<{
    pairingId: string;
    requestId: string;
    outcome: "signed" | "rejected" | "unknown";
  }>): void {
    const pairingId = PairingIdSchema.parse(input.pairingId);
    const requestId = IdentifierSchema.parse(input.requestId);
    const stored = this.#pairings.get(pairingId);
    if (stored === undefined || stored.status !== "reserved" || stored.requestId !== requestId) {
      fail("REQUEST_NOT_RESERVED", "The companion request is not reserved.");
    }
    // A signer may finish exactly as the approval clock crosses its boundary.
    // Preserve the terminal tombstone so callers cannot redispatch; release of
    // a late result remains a separate service policy decision.
    this.#pairings.set(pairingId, Object.freeze({ ...stored, status: input.outcome }));
  }

  status(input: Readonly<{
    origin: string | null;
    capability: string | null;
    pairingId: string;
    sessionId: string;
    account: string;
    network: "testnet";
  }>): Readonly<{ status: PairingStatus; requestId?: string }> {
    const pairingId = PairingIdSchema.parse(input.pairingId);
    const stored = this.#pairings.get(pairingId);
    if (stored === undefined) fail("PAIRING_NOT_FOUND", "The pairing is unavailable.");
    this.#assertTransportBinding(stored, input.origin, input.capability);
    if (
      input.sessionId !== stored.scope.sessionId || input.account !== stored.scope.account ||
      input.network !== stored.scope.network
    ) fail("PAIRING_SCOPE_MISMATCH", "The recovery scope changed.");
    let current = stored;
    if (Date.parse(stored.scope.expiresAt) <= this.#validNow()) {
      if (stored.status === "active") current = Object.freeze({ ...stored, status: "revoked" });
      if (stored.status === "reserved") current = Object.freeze({ ...stored, status: "unknown" });
      if (current !== stored) this.#pairings.set(pairingId, current);
    }
    return Object.freeze({
      status: current.status,
      ...(current.requestId === undefined ? {} : { requestId: current.requestId }),
    });
  }

  revoke(pairingId: string): void {
    const id = PairingIdSchema.parse(pairingId);
    const stored = this.#pairings.get(id);
    if (stored !== undefined) this.#pairings.set(id, Object.freeze({ ...stored, status: "revoked" }));
  }

  #validNow(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) fail("CLOCK_INVALID", "The companion clock is invalid.");
    return now;
  }

  #pruneExpired(): void {
    const now = this.#validNow();
    for (const [pairingId, stored] of this.#pairings) {
      if (Date.parse(stored.scope.expiresAt) <= now) this.#pairings.delete(pairingId);
    }
  }

  #assertUnexpired(pairingId: string, stored: StoredPairing): void {
    if (Date.parse(stored.scope.expiresAt) <= this.#validNow()) {
      this.#pairings.set(pairingId, Object.freeze({ ...stored, status: "revoked" }));
      fail("PAIRING_EXPIRED", "The pairing expired.");
    }
  }

  #assertTransportBinding(stored: StoredPairing, origin: string | null, capability: string | null): void {
    if (origin !== stored.scope.approvedOrigin) fail("ORIGIN_DENIED", "The requesting web origin is not paired.");
    if (capability === null || !CapabilitySchema.safeParse(capability).success ||
      !equalHash(stored.tokenHash, tokenHash(capability))) {
      fail("CAPABILITY_DENIED", "A valid pairing capability is required.");
    }
  }
}
