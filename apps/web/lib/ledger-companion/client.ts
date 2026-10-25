import {
  verifyExactLedgerSignedBlob,
  type ExactLedgerActionExpectation,
} from "@pilot/wallet";

import {
  HostedLedgerCompanionController,
  LedgerCompanionControllerError,
  type CompanionBrowserContext,
} from "./controller";
import type { CompanionPairing } from "./protocol";

export const HOSTED_LEDGER_COMPANION_ORIGIN = "http://127.0.0.1:43659";
export const HOSTED_LEDGER_COMPANION_REVIEW_URL = `${HOSTED_LEDGER_COMPANION_ORIGIN}/ui`;

type LoopbackRequestInit = RequestInit & { targetAddressSpace: "loopback" };

export type HostedCompanionSignedResult = Readonly<{
  requestId: string;
  signedBlob: string;
  transactionHash: string;
  provenance: Readonly<{
    runtime: "speculos";
    signatureEvidence: "signing-key-control-only";
    physicalDeviceInferred: false;
    emulator: true;
  }>;
  submitted: false;
}>;

export class HostedLedgerCompanionClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HostedLedgerCompanionClientError";
  }
}

function fail(code: string, message: string): never {
  throw new HostedLedgerCompanionClientError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function speculosProvenance(value: unknown): value is HostedCompanionSignedResult["provenance"] {
  return isRecord(value) && value.runtime === "speculos" && value.emulator === true &&
    value.physicalDeviceInferred === false && value.signatureEvidence === "signing-key-control-only";
}

async function body(response: Response): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return fail("INVALID_RESPONSE", "The local companion returned an invalid response.");
  }
  if (!isRecord(value)) fail("INVALID_RESPONSE", "The local companion returned an invalid response.");
  if (!response.ok) {
    const code = typeof value.error === "string" ? value.error : "COMPANION_REJECTED";
    fail(code.toUpperCase(), "The local companion rejected the request.");
  }
  return value;
}

function requestInit(input: Readonly<{
  sessionId: string;
  value: unknown;
  capability?: string;
}>): LoopbackRequestInit {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-pilot-session": input.sessionId,
  };
  if (input.capability !== undefined) headers.authorization = `Bearer ${input.capability}`;
  return {
    method: "POST",
    mode: "cors",
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    targetAddressSpace: "loopback",
    headers,
    body: JSON.stringify(input.value),
  };
}

export class HostedLedgerCompanionClient {
  readonly #controller = new HostedLedgerCompanionController();
  readonly #fetch: typeof fetch;
  #expectation: ExactLedgerActionExpectation | undefined;

  constructor(fetcher: typeof fetch = fetch) {
    this.#fetch = fetcher;
  }

  async pair(input: Readonly<{
    context: CompanionBrowserContext;
    unsignedTxBlob: string;
    expectation: ExactLedgerActionExpectation;
    ttlMs?: number;
  }>): Promise<CompanionPairing> {
    let response: Response;
    try {
      response = await this.#fetch(`${HOSTED_LEDGER_COMPANION_ORIGIN}/v1/pair`, requestInit({
        sessionId: input.context.sessionId,
        value: {
          version: 1,
          session_id: input.context.sessionId,
          network: input.context.network,
          account: input.context.account,
          unsigned_tx_blob: input.unsignedTxBlob,
          expectation: input.expectation,
          ttl_ms: input.ttlMs ?? 120_000,
        },
      }));
    } catch {
      return fail(
        "LOOPBACK_UNAVAILABLE",
        "Allow loopback-network access in a supported Chromium browser, then try again.",
      );
    }
    const value = await body(response);
    if (!isRecord(value.scope) || typeof value.capability !== "string" ||
      !speculosProvenance(value.provenance)) {
      fail("INVALID_RESPONSE", "The local companion pairing response is invalid.");
    }
    const pairing = { capability: value.capability, scope: value.scope } as CompanionPairing;
    this.#controller.attach(pairing, input.context);
    this.#expectation = structuredClone(input.expectation);
    return pairing;
  }

  async sign(input: Readonly<{
    context: CompanionBrowserContext;
    action: ExactLedgerActionExpectation["kind"];
    unsignedTxBlob: string;
    requestId?: string;
  }>): Promise<HostedCompanionSignedResult> {
    const requestId = input.requestId ?? `request.${globalThis.crypto.randomUUID()}`;
    const prepared = await this.#controller.prepareSign({
      requestId,
      action: input.action,
      unsignedTxBlob: input.unsignedTxBlob,
      context: input.context,
    });
    let response: Response;
    try {
      response = await this.#fetch(`${HOSTED_LEDGER_COMPANION_ORIGIN}/v1/sign`, requestInit({
        sessionId: input.context.sessionId,
        capability: prepared.capability,
        value: prepared.request,
      }));
    } catch {
      this.#controller.markDispatchUncertain(requestId);
      return fail(
        "SIGN_OUTCOME_UNKNOWN",
        "The signing connection ended after dispatch. Check status; do not sign again automatically.",
      );
    }
    let value: Record<string, unknown>;
    try {
      value = await body(response);
    } catch {
      this.#controller.markDispatchUncertain(requestId);
      return fail(
        "SIGN_OUTCOME_UNKNOWN",
        "The companion returned an error after dispatch. Check exact status before any new action.",
      );
    }
    if (value.request_id !== requestId || typeof value.signed_blob !== "string" ||
      !/^(?:[A-Fa-f0-9]{2})+$/.test(value.signed_blob) ||
      typeof value.transaction_hash !== "string" || !/^[A-F0-9]{64}$/.test(value.transaction_hash) ||
      value.submitted !== false || !speculosProvenance(value.provenance)) {
      this.#controller.markDispatchUncertain(requestId);
      fail("SIGN_OUTCOME_UNKNOWN", "The local signing result is invalid; check exact status before retrying.");
    }
    const expectation = this.#expectation;
    if (expectation === undefined) {
      this.#controller.markDispatchUncertain(requestId);
      fail("SIGN_OUTCOME_UNKNOWN", "The local signing expectation is unavailable; check exact status before retrying.");
    }
    let verified;
    try {
      verified = verifyExactLedgerSignedBlob({ signedBlob: value.signed_blob, expectation });
    } catch {
      this.#controller.markDispatchUncertain(requestId);
      fail("SIGN_OUTCOME_UNKNOWN", "The local signature did not match the exact reviewed action; check status.");
    }
    if (verified.hash !== value.transaction_hash) {
      this.#controller.markDispatchUncertain(requestId);
      fail("SIGN_OUTCOME_UNKNOWN", "The local transaction hash did not match; check exact status.");
    }
    this.#controller.markSigned(requestId);
    return Object.freeze({
      requestId,
      signedBlob: value.signed_blob,
      transactionHash: value.transaction_hash,
      provenance: value.provenance,
      submitted: false,
    });
  }

  async recover(context: CompanionBrowserContext): Promise<Readonly<Record<string, unknown>>> {
    const recovery = this.#controller.recovery(context);
    const response = await this.#fetch(`${HOSTED_LEDGER_COMPANION_ORIGIN}/v1/status`, requestInit({
      sessionId: context.sessionId,
      capability: recovery.capability,
      value: {
        pairing_id: recovery.pairingId,
        session_id: recovery.sessionId,
        network: recovery.network,
        account: recovery.account,
      },
    })).catch(() => fail("LOOPBACK_UNAVAILABLE", "The local companion status is unavailable."));
    const value = await body(response);
    if (value.status === "signed") {
      const expectation = this.#expectation;
      if (expectation === undefined || typeof value.signed_blob !== "string" ||
        typeof value.transaction_hash !== "string" || typeof value.request_id !== "string") {
        fail("INVALID_RESPONSE", "The recovered signing result is incomplete.");
      }
      const verified = verifyExactLedgerSignedBlob({ signedBlob: value.signed_blob, expectation });
      if (verified.hash !== value.transaction_hash) {
        fail("INVALID_SIGNATURE", "The recovered local signature did not match its transaction hash.");
      }
      this.#controller.markSigned(value.request_id);
    }
    return Object.freeze(value);
  }

  updateContext(context: CompanionBrowserContext): void {
    this.#controller.updateContext(context);
  }

  async disconnectRemote(context: CompanionBrowserContext): Promise<void> {
    const current = this.#controller.disconnectRequest(context);
    const response = await this.#fetch(`${HOSTED_LEDGER_COMPANION_ORIGIN}/v1/disconnect`, requestInit({
      sessionId: context.sessionId,
      capability: current.capability,
      value: {
        pairing_id: current.pairingId,
        session_id: current.sessionId,
        network: current.network,
        account: current.account,
      },
    })).catch(() => fail("LOOPBACK_UNAVAILABLE", "The local companion could not be disconnected."));
    const value = await body(response);
    if (value.status !== "revoked") {
      fail("INVALID_RESPONSE", "The local companion did not confirm revocation.");
    }
    this.disconnect();
  }

  disconnect(): void {
    this.#controller.disconnect();
    this.#expectation = undefined;
  }
}

export { LedgerCompanionControllerError };
