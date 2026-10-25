import { describe, expect, it } from "vitest";
import { ECDSA, Wallet, encode, hashes, type Payment } from "xrpl";

import {
  ledgerRuntimeProvenance,
  validateExactLedgerAction,
  type ExactLedgerActionExpectation,
} from "@pilot/wallet";
import {
  HOSTED_LEDGER_COMPANION_ORIGIN,
  HostedLedgerCompanionClient,
} from "./client";
import { companionTransactionDigest } from "./protocol";

const ORIGIN = "https://pilot.example";
const DESTINATION = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";

async function fixture() {
  const wallet = Wallet.generate(ECDSA.secp256k1);
  const now = Date.now();
  const expectation: ExactLedgerActionExpectation = {
    kind: "payment",
    network: "testnet",
    account: wallet.classicAddress,
    sequence: 42,
    validatedLedgerIndex: 1_000,
    maxLedgerWindow: 50,
    maxFeeDrops: "20",
    approvalExpiresAtMs: now + 60_000,
    quoteExpiresAtMs: now + 30_000,
    destination: DESTINATION,
    amountDrops: "5000",
  };
  const transaction = {
    TransactionType: "Payment" as const,
    Account: wallet.classicAddress,
    Destination: DESTINATION,
    Amount: "5000",
    Fee: "12",
    Sequence: 42,
    LastLedgerSequence: 1_050,
  };
  const unsignedTxBlob = encode(transaction);
  const review = await validateExactLedgerAction({
    transaction,
    expectation,
    provenance: ledgerRuntimeProvenance("speculos"),
    now,
  });
  const pairing = {
    capability: "A".repeat(43),
    scope: {
      pairingId: `pair_${"B".repeat(43)}`,
      approvedOrigin: ORIGIN,
      sessionId: "session.browser.0001",
      network: "testnet" as const,
      account: wallet.classicAddress,
      action: "payment" as const,
      reviewDigest: review.digest,
      transactionDigest: companionTransactionDigest(unsignedTxBlob),
      expiresAt: new Date(now + 30_000).toISOString(),
    },
  };
  const context = {
    origin: ORIGIN,
    sessionId: pairing.scope.sessionId,
    network: "testnet" as const,
    account: wallet.classicAddress,
  };
  return { wallet, expectation, transaction, unsignedTxBlob, pairing, context };
}

describe("hosted Ledger companion HTTP client", () => {
  it("requests loopback permission explicitly and verifies the returned signed blob", async () => {
    const f = await fixture();
    const observed: Array<{ url: string; init: RequestInit & { targetAddressSpace?: string } }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      observed.push({ url: String(input), init: init as RequestInit & { targetAddressSpace?: string } });
      if (String(input).endsWith("/v1/pair")) {
        return Response.json({
          ...f.pairing,
          provenance: ledgerRuntimeProvenance("speculos"),
        });
      }
      if (String(input).endsWith("/v1/disconnect")) return Response.json({ status: "revoked" });
      const signedBlob = f.wallet.sign(f.transaction as Payment).tx_blob;
      return Response.json({
        request_id: JSON.parse(String(init?.body)).request_id,
        signed_blob: signedBlob,
        transaction_hash: hashes.hashSignedTx(signedBlob).toUpperCase(),
        provenance: ledgerRuntimeProvenance("speculos"),
        submitted: false,
      });
    };
    const client = new HostedLedgerCompanionClient(fetcher);
    await client.pair({
      context: f.context,
      unsignedTxBlob: f.unsignedTxBlob,
      expectation: f.expectation,
    });
    const signed = await client.sign({
      context: f.context,
      action: "payment",
      unsignedTxBlob: f.unsignedTxBlob,
      requestId: "request.browser.0001",
    });
    expect(signed).toMatchObject({ submitted: false, provenance: { runtime: "speculos", emulator: true } });
    await expect(client.disconnectRemote(f.context)).resolves.toBeUndefined();
    expect(observed).toHaveLength(3);
    for (const call of observed) {
      expect(call.url.startsWith(HOSTED_LEDGER_COMPANION_ORIGIN)).toBe(true);
      expect(call.init).toMatchObject({
        method: "POST",
        mode: "cors",
        credentials: "omit",
        redirect: "error",
        targetAddressSpace: "loopback",
      });
    }
  });

  it("fails closed on account changes and freezes an uncertain dispatch for status recovery", async () => {
    const f = await fixture();
    let calls = 0;
    const fetcher: typeof fetch = async (input) => {
      calls += 1;
      if (String(input).endsWith("/v1/pair")) {
        return Response.json({ ...f.pairing, provenance: ledgerRuntimeProvenance("speculos") });
      }
      if (String(input).endsWith("/v1/sign")) throw new TypeError("connection closed");
      return Response.json({ status: "unknown", request_id: "request.browser.0001" });
    };
    const client = new HostedLedgerCompanionClient(fetcher);
    await client.pair({ context: f.context, unsignedTxBlob: f.unsignedTxBlob, expectation: f.expectation });
    expect(() => client.updateContext({ ...f.context, account: DESTINATION }))
      .toThrow(expect.objectContaining({ code: "PAIRING_SCOPE_MISMATCH" }));

    const retry = new HostedLedgerCompanionClient(fetcher);
    await retry.pair({ context: f.context, unsignedTxBlob: f.unsignedTxBlob, expectation: f.expectation });
    await expect(retry.sign({
      context: f.context,
      action: "payment",
      unsignedTxBlob: f.unsignedTxBlob,
      requestId: "request.browser.0001",
    })).rejects.toEqual(expect.objectContaining({ code: "SIGN_OUTCOME_UNKNOWN" }));
    await expect(retry.sign({
      context: f.context,
      action: "payment",
      unsignedTxBlob: f.unsignedTxBlob,
      requestId: "request.browser.0002",
    })).rejects.toEqual(expect.objectContaining({ code: "REQUEST_ALREADY_PENDING" }));
    await expect(retry.recover(f.context)).resolves.toMatchObject({ status: "unknown" });
    expect(calls).toBe(4);
  });

  it("keeps a non-2xx post-dispatch response recoverable and revokes through the server", async () => {
    const f = await fixture();
    const paths: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === "/v1/pair") {
        return Response.json({ ...f.pairing, provenance: ledgerRuntimeProvenance("speculos") });
      }
      if (path === "/v1/sign") {
        return Response.json({ error: "sign_outcome_unknown" }, { status: 409 });
      }
      if (path === "/v1/status") return Response.json({ status: "unknown", request_id: "request.browser.0001" });
      return Response.json({ status: "revoked" });
    };
    const client = new HostedLedgerCompanionClient(fetcher);
    await client.pair({ context: f.context, unsignedTxBlob: f.unsignedTxBlob, expectation: f.expectation });
    await expect(client.sign({
      context: f.context,
      action: "payment",
      unsignedTxBlob: f.unsignedTxBlob,
      requestId: "request.browser.0001",
    })).rejects.toEqual(expect.objectContaining({ code: "SIGN_OUTCOME_UNKNOWN" }));
    await expect(client.recover(f.context)).resolves.toMatchObject({ status: "unknown" });
    await expect(client.disconnectRemote(f.context)).resolves.toBeUndefined();
    expect(paths).toEqual(["/v1/pair", "/v1/sign", "/v1/status", "/v1/disconnect"]);
  });

  it("retains the capability when a 200 response does not confirm revocation", async () => {
    const f = await fixture();
    let disconnects = 0;
    const fetcher: typeof fetch = async (input) => {
      if (String(input).endsWith("/v1/pair")) {
        return Response.json({ ...f.pairing, provenance: ledgerRuntimeProvenance("speculos") });
      }
      disconnects += 1;
      return Response.json(disconnects === 1 ? { status: "still_active" } : { status: "revoked" });
    };
    const client = new HostedLedgerCompanionClient(fetcher);
    await client.pair({ context: f.context, unsignedTxBlob: f.unsignedTxBlob, expectation: f.expectation });
    await expect(client.disconnectRemote(f.context)).rejects.toEqual(
      expect.objectContaining({ code: "INVALID_RESPONSE" }),
    );
    await expect(client.disconnectRemote(f.context)).resolves.toBeUndefined();
    expect(disconnects).toBe(2);
  });
});
