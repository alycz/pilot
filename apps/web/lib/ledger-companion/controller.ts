import type {
  CompanionPairing,
  CompanionSignRequest,
  CompanionSignedAction,
} from "./protocol";

const CAPABILITY = /^[A-Za-z0-9_-]{43,128}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const PAIRING_ID = /^pair_[A-Za-z0-9_-]{32,128}$/;
const HEX_BYTES = /^(?:[A-Fa-f0-9]{2})+$/;
const TRANSACTION_DIGEST = /^[A-F0-9]{64}$/;
const REVIEW_DIGEST = /^[a-f0-9]{64}$/;
const EXACT_ACTIONS = new Set<CompanionSignedAction>([
  "payment",
  "delegate-grant",
  "delegate-revoke",
  "escrow-create",
  "escrow-finish",
  "escrow-cancel",
]);

export type CompanionBrowserContext = Readonly<{
  origin: string;
  sessionId: string;
  network: "testnet";
  account: string;
}>;

export type CompanionRecoveryRequest = Readonly<{
  capability: string;
  pairingId: string;
  sessionId: string;
  network: "testnet";
  account: string;
}>;

type PendingRequest = Readonly<{
  request: CompanionSignRequest;
  state: "prepared" | "unknown";
}>;

export class LedgerCompanionControllerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LedgerCompanionControllerError";
  }
}

function fail(code: string, message: string): never {
  throw new LedgerCompanionControllerError(code, message);
}

function bytesFromHex(value: string): Uint8Array {
  if (!HEX_BYTES.test(value) || value.length > 20_000) {
    return fail("INVALID_TRANSACTION", "The prepared transaction bytes are invalid.");
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) fail("CRYPTO_UNAVAILABLE", "Browser cryptography is unavailable.");
  // Copy into an ArrayBuffer-owned view so DOM crypto does not receive a
  // SharedArrayBuffer-compatible view.
  const payload = new Uint8Array(bytes.byteLength);
  payload.set(bytes);
  const digest = await subtle.digest("SHA-256", payload);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("").toUpperCase();
}

function canonicalOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("ORIGIN_MISMATCH", "The browser origin is invalid.");
  }
  if (value !== url.origin || url.protocol !== "https:") {
    fail("ORIGIN_MISMATCH", "The hosted companion requires one exact HTTPS origin.");
  }
  return url.origin;
}

export class HostedLedgerCompanionController {
  #pairing: CompanionPairing | undefined;
  #pending: PendingRequest | undefined;

  attach(pairing: CompanionPairing, context: CompanionBrowserContext, now = Date.now()): void {
    const origin = canonicalOrigin(context.origin);
    if (!CAPABILITY.test(pairing.capability)) fail("CAPABILITY_INVALID", "The pairing capability is invalid.");
    const expiresAt = Date.parse(pairing.scope.expiresAt);
    if (!IDENTIFIER.test(pairing.scope.sessionId) || !PAIRING_ID.test(pairing.scope.pairingId) ||
      !EXACT_ACTIONS.has(pairing.scope.action) ||
      !TRANSACTION_DIGEST.test(pairing.scope.transactionDigest) ||
      !REVIEW_DIGEST.test(pairing.scope.reviewDigest) || !Number.isFinite(expiresAt)) {
      fail("PAIRING_INVALID", "The pairing scope is invalid.");
    }
    if (
      pairing.scope.approvedOrigin !== origin || pairing.scope.sessionId !== context.sessionId ||
      pairing.scope.network !== context.network || pairing.scope.account !== context.account
    ) fail("PAIRING_SCOPE_MISMATCH", "The pairing does not match the current browser wallet session.");
    if (expiresAt <= now) fail("PAIRING_EXPIRED", "The pairing expired.");
    this.#pairing = Object.freeze({ capability: pairing.capability, scope: Object.freeze({ ...pairing.scope }) });
    this.#pending = undefined;
  }

  async prepareSign(input: Readonly<{
    requestId: string;
    action: CompanionSignedAction;
    unsignedTxBlob: string;
    context: CompanionBrowserContext;
    now?: number;
  }>): Promise<Readonly<{ capability: string; request: CompanionSignRequest }>> {
    const pairing = this.#assertCurrent(input.context, input.now ?? Date.now());
    if (this.#pending !== undefined) fail("REQUEST_ALREADY_PENDING", "A companion request is already pending.");
    if (!IDENTIFIER.test(input.requestId)) fail("REQUEST_INVALID", "The request id is invalid.");
    if (input.action !== pairing.scope.action) fail("PAIRING_SCOPE_MISMATCH", "The requested action changed.");
    const unsignedTxBlob = input.unsignedTxBlob.toUpperCase();
    const transactionDigest = await digestHex(bytesFromHex(unsignedTxBlob));
    if (transactionDigest !== pairing.scope.transactionDigest) {
      fail("TRANSACTION_BINDING_MISMATCH", "The prepared transaction bytes changed after pairing.");
    }
    const request: CompanionSignRequest = Object.freeze({
      version: 1,
      pairing_id: pairing.scope.pairingId,
      request_id: input.requestId,
      session_id: pairing.scope.sessionId,
      network: pairing.scope.network,
      account: pairing.scope.account,
      action: pairing.scope.action,
      review_digest: pairing.scope.reviewDigest,
      transaction_digest: pairing.scope.transactionDigest,
      unsigned_tx_blob: unsignedTxBlob,
    });
    this.#pending = Object.freeze({ request, state: "prepared" });
    return Object.freeze({ capability: pairing.capability, request });
  }

  markDispatchUncertain(requestId: string): void {
    if (this.#pending?.request.request_id !== requestId) fail("REQUEST_NOT_PENDING", "The request is not pending.");
    this.#pending = Object.freeze({ ...this.#pending, state: "unknown" });
  }

  recovery(context: CompanionBrowserContext, now = Date.now()): CompanionRecoveryRequest {
    const pairing = this.#assertBound(context);
    if (this.#pending?.state !== "unknown") fail("RECOVERY_NOT_AVAILABLE", "There is no uncertain request to recover.");
    return Object.freeze({
      capability: pairing.capability,
      pairingId: pairing.scope.pairingId,
      sessionId: pairing.scope.sessionId,
      network: pairing.scope.network,
      account: pairing.scope.account,
    });
  }

  disconnectRequest(context: CompanionBrowserContext, now = Date.now()): CompanionRecoveryRequest {
    void now;
    const pairing = this.#assertBound(context);
    return Object.freeze({
      capability: pairing.capability,
      pairingId: pairing.scope.pairingId,
      sessionId: pairing.scope.sessionId,
      network: pairing.scope.network,
      account: pairing.scope.account,
    });
  }

  resolve(requestId: string): void {
    if (this.#pending?.request.request_id !== requestId) fail("REQUEST_NOT_PENDING", "The request is not pending.");
    this.#pending = undefined;
    // The companion capability is one-shot. A fresh explicit pairing is
    // required for another action, even after a rejection.
    this.#pairing = undefined;
  }

  markSigned(requestId: string): void {
    if (this.#pending?.request.request_id !== requestId) fail("REQUEST_NOT_PENDING", "The request is not pending.");
    this.#pending = undefined;
  }

  disconnect(): void {
    this.#pending = undefined;
    this.#pairing = undefined;
  }

  updateContext(context: CompanionBrowserContext): void {
    if (this.#pairing === undefined) return;
    try {
      this.#assertCurrent(context, Date.now());
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }

  #assertCurrent(context: CompanionBrowserContext, now: number): CompanionPairing {
    const pairing = this.#assertBound(context);
    const expiresAt = Date.parse(pairing.scope.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      this.disconnect();
      fail("PAIRING_INVALID", "The pairing expiry is invalid.");
    }
    if (expiresAt <= now) {
      fail("PAIRING_EXPIRED", "The pairing expired.");
    }
    return pairing;
  }

  #assertBound(context: CompanionBrowserContext): CompanionPairing {
    const pairing = this.#pairing;
    if (pairing === undefined) fail("PAIRING_REQUIRED", "Pair the local emulator companion first.");
    const origin = canonicalOrigin(context.origin);
    if (
      pairing.scope.approvedOrigin !== origin || pairing.scope.sessionId !== context.sessionId ||
      pairing.scope.network !== context.network || pairing.scope.account !== context.account
    ) fail("PAIRING_SCOPE_MISMATCH", "The wallet session changed after pairing.");
    return pairing;
  }
}
