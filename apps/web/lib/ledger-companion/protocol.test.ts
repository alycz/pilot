import { describe, expect, it } from "vitest";
import { encode } from "xrpl";

import type { ExactLedgerActionExpectation } from "@pilot/wallet";
import { HostedLedgerCompanionController } from "./controller";
import {
  CompanionSignRequestSchema,
  LedgerCompanionPairingRegistry,
  type CompanionPairing,
  type CompanionSignRequest,
} from "./protocol";

const ORIGIN = "https://pilot.example";
const ACCOUNT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const OTHER_ACCOUNT = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const DESTINATION = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const SESSION = "session.test.0001";
const REQUEST = "request.test.0001";
const NOW = 1_800_000_000_000;

const EXPECTATION: ExactLedgerActionExpectation = {
  kind: "payment",
  network: "testnet",
  account: ACCOUNT,
  sequence: 42,
  validatedLedgerIndex: 1_000,
  maxLedgerWindow: 50,
  maxFeeDrops: "20",
  approvalExpiresAtMs: NOW + 60_000,
  quoteExpiresAtMs: NOW + 30_000,
  destination: DESTINATION,
  amountDrops: "5000",
};

const TRANSACTION = {
  TransactionType: "Payment" as const,
  Account: ACCOUNT,
  Destination: DESTINATION,
  Amount: "5000",
  Fee: "12",
  Sequence: 42,
  LastLedgerSequence: 1_050,
};
const UNSIGNED_BLOB = encode(TRANSACTION);

function protocolError(code: string) {
  return expect.objectContaining({ code });
}

function context(overrides: Partial<{
  origin: string;
  sessionId: string;
  network: "testnet";
  account: string;
}> = {}) {
  return {
    origin: ORIGIN,
    sessionId: SESSION,
    network: "testnet" as const,
    account: ACCOUNT,
    ...overrides,
  };
}

async function harness(options: Readonly<{
  now?: { value: number };
  approve?: boolean;
  expectation?: ExactLedgerActionExpectation;
  unsignedTxBlob?: string;
  ttlMs?: number;
}> = {}): Promise<{
  registry: LedgerCompanionPairingRegistry;
  pairing: CompanionPairing;
  request: CompanionSignRequest;
  now: { value: number };
}> {
  const clock = options.now ?? { value: NOW };
  let randomFill = 1;
  const registry = new LedgerCompanionPairingRegistry({
    approvedOrigin: ORIGIN,
    approveLocalPairing: async () => options.approve ?? true,
    now: () => clock.value,
    randomBytes: (size) => new Uint8Array(size).fill(randomFill++),
  });
  const pairing = await registry.issueFromLocalControl({
    sessionId: SESSION,
    network: "testnet",
    account: ACCOUNT,
    unsignedTxBlob: options.unsignedTxBlob ?? UNSIGNED_BLOB,
    expectation: options.expectation ?? EXPECTATION,
    ttlMs: options.ttlMs ?? 10_000,
  });
  const controller = new HostedLedgerCompanionController();
  controller.attach(pairing, context(), clock.value);
  const prepared = await controller.prepareSign({
    requestId: REQUEST,
    action: "payment",
    unsignedTxBlob: options.unsignedTxBlob ?? UNSIGNED_BLOB,
    context: context(),
    now: clock.value,
  });
  return { registry, pairing, request: prepared.request, now: clock };
}

describe("Ledger companion exact pairing protocol", () => {
  it("defaults local issuance to denied and has no caller-controlled approval flag", async () => {
    const registry = new LedgerCompanionPairingRegistry({ approvedOrigin: ORIGIN, now: () => NOW });
    await expect(registry.issueFromLocalControl({
      sessionId: SESSION,
      network: "testnet",
      account: ACCOUNT,
      unsignedTxBlob: UNSIGNED_BLOB,
      expectation: EXPECTATION,
      ttlMs: 10_000,
    })).rejects.toEqual(protocolError("LOCAL_APPROVAL_REQUIRED"));
  });

  it("binds local review to full semantics and software-emulator provenance", async () => {
    let observed: Parameters<NonNullable<ConstructorParameters<typeof LedgerCompanionPairingRegistry>[0]["approveLocalPairing"]>>[0] | undefined;
    const registry = new LedgerCompanionPairingRegistry({
      approvedOrigin: ORIGIN,
      now: () => NOW,
      approveLocalPairing: (review) => {
        observed = review;
        return true;
      },
      randomBytes: (size) => new Uint8Array(size).fill(7),
    });
    const pairing = await registry.issueFromLocalControl({
      sessionId: SESSION,
      network: "testnet",
      account: ACCOUNT,
      unsignedTxBlob: UNSIGNED_BLOB,
      expectation: EXPECTATION,
      ttlMs: 10_000,
    });
    expect(observed).toMatchObject({
      approvedOrigin: ORIGIN,
      sessionId: SESSION,
      expectation: { kind: "payment", destination: DESTINATION, amountDrops: "5000" },
      transaction: { TransactionType: "Payment", Destination: DESTINATION, Amount: "5000" },
      review: {
        action: "payment",
        account: ACCOUNT,
        network: "testnet",
        provenance: {
          runtime: "speculos",
          emulator: true,
          physicalDeviceInferred: false,
          signatureEvidence: "signing-key-control-only",
        },
      },
    });
    expect(pairing.scope.reviewDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(pairing.scope.transactionDigest).toMatch(/^[A-F0-9]{64}$/);
  });

  it("rejects an unsigned transaction whose semantics differ from the local review", async () => {
    const changed = encode({ ...TRANSACTION, Amount: "5001" });
    const registry = new LedgerCompanionPairingRegistry({
      approvedOrigin: ORIGIN,
      approveLocalPairing: () => true,
      now: () => NOW,
    });
    await expect(registry.issueFromLocalControl({
      sessionId: SESSION,
      network: "testnet",
      account: ACCOUNT,
      unsignedTxBlob: changed,
      expectation: EXPECTATION,
      ttlMs: 10_000,
    })).rejects.toEqual(protocolError("SEMANTIC_MISMATCH"));
  });

  it("rejects pre-signed input before pairing", async () => {
    const signedShape = encode({ ...TRANSACTION, SigningPubKey: `02${"A".repeat(64)}` });
    const registry = new LedgerCompanionPairingRegistry({
      approvedOrigin: ORIGIN,
      approveLocalPairing: () => true,
      now: () => NOW,
    });
    await expect(registry.issueFromLocalControl({
      sessionId: SESSION,
      network: "testnet",
      account: ACCOUNT,
      unsignedTxBlob: signedShape,
      expectation: EXPECTATION,
      ttlMs: 10_000,
    })).rejects.toEqual(protocolError("INVALID_SIGNATURE_SHAPE"));
  });

  it("accepts only actions covered by the exact-action validator", () => {
    expect(CompanionSignRequestSchema.safeParse({
      version: 1,
      pairing_id: `pair_${"A".repeat(43)}`,
      request_id: REQUEST,
      session_id: SESSION,
      network: "testnet",
      account: ACCOUNT,
      action: "TrustSet",
      review_digest: "a".repeat(64),
      transaction_digest: "A".repeat(64),
      unsigned_tx_blob: "00",
    }).success).toBe(false);
  });

  it.each([
    ["wrong origin", (pairing: CompanionPairing, request: CompanionSignRequest) => ({
      origin: "https://attacker.example", capability: pairing.capability, request,
    }), "ORIGIN_DENIED"],
    ["forged capability", (pairing: CompanionPairing, request: CompanionSignRequest) => ({
      origin: ORIGIN, capability: "Z".repeat(43), request,
    }), "CAPABILITY_DENIED"],
    ["session switch", (pairing: CompanionPairing, request: CompanionSignRequest) => ({
      origin: ORIGIN, capability: pairing.capability,
      request: { ...request, session_id: "session.changed.0001" },
    }), "PAIRING_SCOPE_MISMATCH"],
    ["account switch", (pairing: CompanionPairing, request: CompanionSignRequest) => ({
      origin: ORIGIN, capability: pairing.capability,
      request: { ...request, account: OTHER_ACCOUNT },
    }), "PAIRING_SCOPE_MISMATCH"],
    ["action switch", (pairing: CompanionPairing, request: CompanionSignRequest) => ({
      origin: ORIGIN, capability: pairing.capability,
      request: { ...request, action: "escrow-create" },
    }), "PAIRING_SCOPE_MISMATCH"],
    ["review digest forgery", (pairing: CompanionPairing, request: CompanionSignRequest) => ({
      origin: ORIGIN, capability: pairing.capability,
      request: { ...request, review_digest: "0".repeat(64) },
    }), "PAIRING_SCOPE_MISMATCH"],
    ["transaction digest forgery", (pairing: CompanionPairing, request: CompanionSignRequest) => ({
      origin: ORIGIN, capability: pairing.capability,
      request: { ...request, transaction_digest: "0".repeat(64) },
    }), "PAIRING_SCOPE_MISMATCH"],
  ] as const)("rejects %s without consuming the pairing", async (_label, forge, expectedCode) => {
    const { registry, pairing, request } = await harness();
    await expect(registry.authorizeSign(forge(pairing, request))).rejects.toEqual(protocolError(expectedCode));
    expect(registry.status({
      origin: ORIGIN,
      capability: pairing.capability,
      pairingId: pairing.scope.pairingId,
      sessionId: SESSION,
      account: ACCOUNT,
      network: "testnet",
    })).toEqual({ status: "active" });
  });

  it("reserves once and rejects replay and double dispatch", async () => {
    const { registry, pairing, request } = await harness();
    const authorized = await registry.authorizeSign({
      origin: ORIGIN,
      capability: pairing.capability,
      request,
    });
    expect(authorized.review.digest).toBe(pairing.scope.reviewDigest);
    await expect(registry.authorizeSign({
      origin: ORIGIN,
      capability: pairing.capability,
      request,
    })).rejects.toEqual(protocolError("PAIRING_REPLAY"));
    registry.resolve({ pairingId: pairing.scope.pairingId, requestId: REQUEST, outcome: "unknown" });
    expect(registry.status({
      origin: ORIGIN,
      capability: pairing.capability,
      pairingId: pairing.scope.pairingId,
      sessionId: SESSION,
      account: ACCOUNT,
      network: "testnet",
    })).toEqual({ status: "unknown", requestId: REQUEST });
  });

  it("expires stale pairings during status recovery as well as signing", async () => {
    const clock = { value: NOW };
    const { registry, pairing } = await harness({ now: clock, ttlMs: 1_000 });
    clock.value += 1_000;
    expect(registry.status({
      origin: ORIGIN,
      capability: pairing.capability,
      pairingId: pairing.scope.pairingId,
      sessionId: SESSION,
      account: ACCOUNT,
      network: "testnet",
    })).toEqual({ status: "revoked" });
  });

  it("rejects wildcard and non-HTTPS approved origins", () => {
    expect(() => new LedgerCompanionPairingRegistry({ approvedOrigin: "https://*.example" }))
      .toThrowError(protocolError("INVALID_ORIGIN"));
    expect(() => new LedgerCompanionPairingRegistry({ approvedOrigin: "http://pilot.example" }))
      .toThrowError(protocolError("INVALID_ORIGIN"));
  });
});

describe("hosted Ledger companion controller", () => {
  it("invalidates pairing on session, account and network context changes", async () => {
    for (const changed of [
      context({ sessionId: "session.changed.0001" }),
      context({ account: OTHER_ACCOUNT }),
      { ...context(), network: "devnet" as "testnet" },
    ]) {
      const { pairing } = await harness();
      const controller = new HostedLedgerCompanionController();
      controller.attach(pairing, context(), NOW);
      expect(() => controller.updateContext(changed)).toThrowError(protocolError("PAIRING_SCOPE_MISMATCH"));
      await expect(controller.prepareSign({
        requestId: REQUEST,
        action: "payment",
        unsignedTxBlob: UNSIGNED_BLOB,
        context: context(),
        now: NOW,
      })).rejects.toEqual(protocolError("PAIRING_REQUIRED"));
    }
  });

  it("supports status-only recovery after uncertain dispatch and clears on disconnect", async () => {
    const { pairing } = await harness();
    const controller = new HostedLedgerCompanionController();
    controller.attach(pairing, context(), NOW);
    await controller.prepareSign({
      requestId: REQUEST,
      action: "payment",
      unsignedTxBlob: UNSIGNED_BLOB,
      context: context(),
      now: NOW,
    });
    controller.markDispatchUncertain(REQUEST);
    expect(controller.recovery(context(), NOW)).toEqual({
      capability: pairing.capability,
      pairingId: pairing.scope.pairingId,
      sessionId: SESSION,
      network: "testnet",
      account: ACCOUNT,
    });
    controller.disconnect();
    expect(() => controller.recovery(context(), NOW)).toThrowError(protocolError("PAIRING_REQUIRED"));
  });

  it("retains only recovery and revocation authority after the pairing clock expires", async () => {
    const { pairing } = await harness({ ttlMs: 1_000 });
    const controller = new HostedLedgerCompanionController();
    controller.attach(pairing, context(), NOW);
    await controller.prepareSign({
      requestId: REQUEST,
      action: "payment",
      unsignedTxBlob: UNSIGNED_BLOB,
      context: context(),
      now: NOW,
    });
    controller.markDispatchUncertain(REQUEST);
    expect(controller.recovery(context(), NOW + 1_000)).toMatchObject({ pairingId: pairing.scope.pairingId });
    expect(controller.disconnectRequest(context(), NOW + 1_000)).toMatchObject({ pairingId: pairing.scope.pairingId });
    await expect(controller.prepareSign({
      requestId: "request.test.0002",
      action: "payment",
      unsignedTxBlob: UNSIGNED_BLOB,
      context: context(),
      now: NOW + 1_000,
    })).rejects.toEqual(protocolError("PAIRING_EXPIRED"));
  });

  it("blocks double-click and rejects bytes changed after local review", async () => {
    const { pairing } = await harness();
    const controller = new HostedLedgerCompanionController();
    controller.attach(pairing, context(), NOW);
    await expect(controller.prepareSign({
      requestId: REQUEST,
      action: "payment",
      unsignedTxBlob: encode({ ...TRANSACTION, Fee: "13" }),
      context: context(),
      now: NOW,
    })).rejects.toEqual(protocolError("TRANSACTION_BINDING_MISMATCH"));
    await controller.prepareSign({
      requestId: REQUEST,
      action: "payment",
      unsignedTxBlob: UNSIGNED_BLOB,
      context: context(),
      now: NOW,
    });
    await expect(controller.prepareSign({
      requestId: "request.test.0002",
      action: "payment",
      unsignedTxBlob: UNSIGNED_BLOB,
      context: context(),
      now: NOW,
    })).rejects.toEqual(protocolError("REQUEST_ALREADY_PENDING"));
  });
});
