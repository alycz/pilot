import { ECDSA, Wallet } from "xrpl";
import { describe, expect, it } from "vitest";

import {
  IssuedPaymentPolicyError,
  PILOT_ISSUED_PAYMENT_XRP_APP_VERSION,
  XRPL_TESTNET_CAIP2,
  bindIssuedAssetX402SigningRequest,
  issuedAssetX402ApprovalEnvelope,
  issuedAssetX402AssetId,
  verifyIssuedAssetX402SignedBlob,
  type IssuedAssetX402SigningRequest,
} from "../src/ledger/issued-payment.js";
import {
  canonicalIssuedX402ApprovalEnvelope,
  digestIssuedX402ApprovalEnvelope,
} from "../src/ledger/x402-approval-envelope.js";

const OWNER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const PAYEE = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const ISSUER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const CURRENCY = "524C555344000000000000000000000000000000";
const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const EXPIRES = "2026-10-24T12:01:00.000Z";
const APPROVAL_DIGEST = "7E9C53C776814D340A3D37840F2983D2EECC4376355E7F4526C7D787A4C4181F";

function request(overrides: Partial<IssuedAssetX402SigningRequest> = {}): IssuedAssetX402SigningRequest {
  const base: IssuedAssetX402SigningRequest = {
    version: 1,
    approval_id: "rlusd-approval-0001",
    approval_digest: APPROVAL_DIGEST,
    session_scope: "principal-owner-review-0001",
    idempotency_key: "owner-review-operation-0001",
    owner: OWNER,
    execution_network: "testnet",
    asset: {
      kind: "issued",
      network: XRPL_TESTNET_CAIP2,
      namespace: "token",
      currency: CURRENCY,
      issuer: ISSUER,
    },
    amount: "1.25",
    pay_to: PAYEE,
    merchant: {
      id: "merchant-weather-api-v1",
      resource_method: "POST",
      resource_url: "https://merchant.example/v1/weather",
    },
    merchant_invoice_id: "invoice-merchant-0001",
    quote_expires_at: EXPIRES,
    validated_ledger_index: 500,
    sequence: 7,
    last_ledger_sequence: 512,
    fee_drops: "12",
    source_tag: 2_610_240,
    invoice_id: APPROVAL_DIGEST,
    tx_json: {},
  };
  const merged = {
    ...base,
    ...overrides,
    asset: { ...base.asset, ...overrides.asset },
    merchant: { ...base.merchant, ...overrides.merchant },
  };
  const issued = {
    currency: merged.asset.currency,
    issuer: merged.asset.issuer,
    value: merged.amount,
  };
  return {
    ...merged,
    tx_json: overrides.tx_json ?? {
      TransactionType: "Payment",
      Account: merged.owner,
      Destination: merged.pay_to,
      Amount: issued,
      SendMax: issued,
      Fee: merged.fee_drops,
      Sequence: merged.sequence,
      LastLedgerSequence: merged.last_ledger_sequence,
      SourceTag: merged.source_tag,
      InvoiceID: merged.invoice_id,
    },
  };
}

async function committedRequest(
  overrides: Partial<IssuedAssetX402SigningRequest> = {},
): Promise<IssuedAssetX402SigningRequest> {
  const candidate = request(overrides);
  const digest = await digestIssuedX402ApprovalEnvelope(issuedAssetX402ApprovalEnvelope(candidate));
  return {
    ...candidate,
    approval_digest: digest,
    invoice_id: digest,
    tx_json: { ...candidate.tx_json, InvoiceID: digest },
  };
}

const APP = {
  app_name: "XRP" as const,
  app_version: PILOT_ISSUED_PAYMENT_XRP_APP_VERSION,
  source: "speculos-app-config" as const,
};

async function bind(candidate: unknown = request(), overrides: Readonly<Record<string, unknown>> = {}) {
  return bindIssuedAssetX402SigningRequest({
    request: candidate,
    connectedAccount: OWNER,
    appConfig: APP,
    now: NOW,
    ...overrides,
  });
}

describe("issued-asset x402 Ledger binder", () => {
  it("binds one exact Testnet issued-asset Payment and CAIP-19 asset id", async () => {
    const bound = await bind();
    expect(bound.signingMode).toBe("clear");
    expect(bound.appSupport).toEqual({
      appName: "XRP",
      appVersion: "2.8.2",
      source: "speculos-app-config",
      evidence: "pinned-version-profile-only",
      physicalDeviceInferred: false,
    });
    expect(issuedAssetX402AssetId(bound.request))
      .toBe(`${XRPL_TESTNET_CAIP2}/token:${CURRENCY}.${ISSUER}`);
    expect(bound.transaction.Amount).toEqual(bound.transaction.SendMax);
  });

  it.each([
    ["livenet CAIP-2", { asset: { network: "xrpl:0" } }],
    ["devnet CAIP-2", { asset: { network: "xrpl:2" } }],
    ["runtime devnet", { execution_network: "devnet" }],
  ])("rejects %s disagreement", async (_label, change) => {
    const candidate = request(change as never);
    await expect(bind(candidate)).rejects.toThrow(IssuedPaymentPolicyError);
  });

  it.each([
    ["lowercase currency", { asset: { currency: CURRENCY.toLowerCase() } }],
    ["short currency", { asset: { currency: "RLUSD" } }],
    ["reserved XRP currency", { asset: { currency: "0000000000000000000000005852500000000000" } }],
    ["empty currency", { asset: { currency: "0".repeat(40) } }],
    ["invalid issuer", { asset: { issuer: PAYEE.slice(0, -1) } }],
    ["zero amount", { amount: "0" }],
    ["prefixed amount", { amount: "01.25" }],
    ["trailing decimal zero", { amount: "1.250" }],
    ["scientific amount", { amount: "1.25e0" }],
    ["excess precision", { amount: "1234567890123456" }],
  ])("rejects %s", async (_label, change) => {
    await expect(bind(request(change as never))).rejects.toThrow(IssuedPaymentPolicyError);
  });

  it.each([
    ["account", { Account: PAYEE }],
    ["payee", { Destination: OWNER }],
    ["amount", { Amount: { currency: CURRENCY, issuer: ISSUER, value: "1.24" } }],
    ["SendMax value", { SendMax: { currency: CURRENCY, issuer: ISSUER, value: "1.26" } }],
    ["SendMax issuer", { SendMax: { currency: CURRENCY, issuer: PAYEE, value: "1.25" } }],
    ["fee", { Fee: "13" }],
    ["sequence", { Sequence: 8 }],
    ["last ledger", { LastLedgerSequence: 513 }],
    ["source tag", { SourceTag: 2_610_241 }],
    ["invoice", { InvoiceID: "C".repeat(64) }],
    ["partial payment flag", { Flags: 0x0002_0000 }],
    ["paths", { Paths: [] }],
  ])("rejects transaction %s drift", async (_label, change) => {
    const original = request();
    await expect(bind(request({ tx_json: { ...original.tx_json, ...change } })))
      .rejects.toThrow(IssuedPaymentPolicyError);
  });

  it("enforces fee, ledger, and quote bounds", async () => {
    await expect(bind(request({ fee_drops: "101" }))).rejects.toThrow(/fee exceeds/i);
    await expect(bind(request({ last_ledger_sequence: 500 }))).rejects.toThrow(/ledger window/i);
    await expect(bind(request({ last_ledger_sequence: 521 }))).rejects.toThrow(/ledger window/i);
    await expect(bind(request({ quote_expires_at: "2026-10-24T12:00:00.000Z" })))
      .rejects.toThrow(/stale/i);
    await expect(bind(request({ quote_expires_at: "2026-10-24T12:05:01.000Z" })))
      .rejects.toThrow(/lifetime/i);
  });

  it("fails closed for unknown, older, newer, or wrongly named app profiles", async () => {
    for (const appConfig of [
      undefined,
      { ...APP, app_version: "2.8.1" },
      { ...APP, app_version: "2.9.0" },
      { ...APP, app_name: "Ethereum" },
      { ...APP, source: "claimed-by-request" },
    ]) {
      await expect(bind(request(), { appConfig })).rejects.toThrow(/pinned XRP app/i);
    }
  });

  it("rejects a connected-account switch", async () => {
    await expect(bind(request(), { connectedAccount: PAYEE })).rejects.toThrow(/connected account/i);
  });

  it("offline-verifies the exact signed blob and owner signature", async () => {
    const wallet = Wallet.generate(ECDSA.secp256k1);
    const candidate = await committedRequest({ owner: wallet.classicAddress });
    const bound = await bindIssuedAssetX402SigningRequest({
      request: candidate,
      connectedAccount: wallet.classicAddress,
      appConfig: APP,
      now: NOW,
    });
    const signed = wallet.sign(bound.transaction as never);
    const verified = verifyIssuedAssetX402SignedBlob({ signedBlob: signed.tx_blob, bound, now: NOW });
    expect(verified.hash).toBe(signed.hash);
    expect(verified.signingMode).toBe("clear");
    expect(verified.transaction.Amount).toEqual(verified.transaction.SendMax);
  });

  it("rejects signed blobs from another owner and post-sign expiry", async () => {
    const owner = Wallet.generate(ECDSA.secp256k1);
    const impostor = Wallet.generate(ECDSA.secp256k1);
    const candidate = await committedRequest({ owner: owner.classicAddress });
    const bound = await bindIssuedAssetX402SigningRequest({
      request: candidate,
      connectedAccount: owner.classicAddress,
      appConfig: APP,
      now: NOW,
    });
    const impostorBlob = impostor.sign({
      ...bound.transaction,
      Account: impostor.classicAddress,
    } as never).tx_blob;
    expect(() => verifyIssuedAssetX402SignedBlob({ signedBlob: impostorBlob, bound, now: NOW }))
      .toThrow();

    const ownerBlob = owner.sign(bound.transaction as never).tx_blob;
    expect(() => verifyIssuedAssetX402SignedBlob({
      signedBlob: ownerBlob,
      bound,
      now: Date.parse(EXPIRES),
    })).toThrow(/stale/i);
  });

  it("does not persist or expose key material in the bound request", async () => {
    const serialized = JSON.stringify(await bind());
    expect(serialized).not.toMatch(/seed|private.?key|secret/i);
  });

  it("matches the shared canonical envelope golden vector", async () => {
    const envelope = issuedAssetX402ApprovalEnvelope(request());
    expect(canonicalIssuedX402ApprovalEnvelope(envelope)).toBe(
      '{"amount":"1.25","approval_id":"rlusd-approval-0001","asset":{"currency":"524C555344000000000000000000000000000000","issuer":"rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh","kind":"issued","namespace":"token","network":"xrpl:1"},"domain":"pilot.x402.owner-approval","execution_network":"testnet","idempotency_key":"owner-review-operation-0001","merchant":{"id":"merchant-weather-api-v1","pay_to":"rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe","resource_method":"POST","resource_url":"https://merchant.example/v1/weather"},"merchant_invoice_id":"invoice-merchant-0001","network":"xrpl:1","owner":"r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59","quote_expires_at":"2026-10-24T12:01:00.000Z","session_scope":"principal-owner-review-0001","transaction":{"fee_drops":"12","last_ledger_sequence":512,"sequence":7,"source_tag":2610240,"validated_ledger_index":500},"version":1}',
    );
    expect(await digestIssuedX402ApprovalEnvelope(envelope)).toBe(APPROVAL_DIGEST);
  });

  it.each([
    ["approval", (value: IssuedAssetX402SigningRequest) => ({ ...value, approval_id: "rlusd-approval-0002" })],
    ["session", (value: IssuedAssetX402SigningRequest) => ({ ...value, session_scope: "principal-owner-review-0002" })],
    ["idempotency", (value: IssuedAssetX402SigningRequest) => ({ ...value, idempotency_key: "owner-review-operation-0002" })],
    ["merchant", (value: IssuedAssetX402SigningRequest) => ({ ...value, merchant: { ...value.merchant, id: "merchant-weather-api-v2" } })],
    ["resource", (value: IssuedAssetX402SigningRequest) => ({ ...value, merchant: { ...value.merchant, resource_url: "https://merchant.example/v1/climate" } })],
    ["payee", (value: IssuedAssetX402SigningRequest) => ({ ...value, pay_to: OWNER })],
    ["asset", (value: IssuedAssetX402SigningRequest) => ({ ...value, asset: { ...value.asset, currency: `4${value.asset.currency.slice(1)}` } })],
    ["amount", (value: IssuedAssetX402SigningRequest) => ({ ...value, amount: "1.24" })],
    ["owner", (value: IssuedAssetX402SigningRequest) => ({ ...value, owner: PAYEE })],
    ["expiry", (value: IssuedAssetX402SigningRequest) => ({ ...value, quote_expires_at: "2026-10-24T12:02:00.000Z" })],
    ["merchant invoice", (value: IssuedAssetX402SigningRequest) => ({ ...value, merchant_invoice_id: "invoice-merchant-0002" })],
    ["fee", (value: IssuedAssetX402SigningRequest) => ({ ...value, fee_drops: "13" })],
    ["sequence", (value: IssuedAssetX402SigningRequest) => ({ ...value, sequence: 8 })],
    ["ledger basis", (value: IssuedAssetX402SigningRequest) => ({ ...value, validated_ledger_index: 501 })],
    ["ledger expiry", (value: IssuedAssetX402SigningRequest) => ({ ...value, last_ledger_sequence: 513 })],
    ["source tag", (value: IssuedAssetX402SigningRequest) => ({ ...value, source_tag: 2_610_241 })],
  ])("changes the semantic digest after a %s mutation", async (_label, mutate) => {
    const changed = mutate(request()) as IssuedAssetX402SigningRequest;
    expect(await digestIssuedX402ApprovalEnvelope(issuedAssetX402ApprovalEnvelope(changed)))
      .not.toBe(APPROVAL_DIGEST);
  });

  it.each([
    ["session", { session_scope: "principal-owner-review-0002" }],
    ["idempotency", { idempotency_key: "owner-review-operation-0002" }],
    ["merchant", { merchant: { id: "merchant-weather-api-v2" } }],
    ["resource method", { merchant: { resource_method: "GET" } }],
    ["resource", { merchant: { resource_url: "https://merchant.example/v1/climate" } }],
    ["merchant invoice", { merchant_invoice_id: "invoice-merchant-0002" }],
    ["expiry", { quote_expires_at: "2026-10-24T12:02:00.000Z" }],
  ])("rejects an approval digest replay across a changed %s", async (_label, change) => {
    await expect(bind(request(change as never))).rejects.toThrow(IssuedPaymentPolicyError);
  });

  it("cannot reuse a signed payment for a different approved service or idempotency scope", async () => {
    const owner = Wallet.generate(ECDSA.secp256k1);
    const firstRequest = await committedRequest({ owner: owner.classicAddress });
    const first = await bindIssuedAssetX402SigningRequest({
      request: firstRequest,
      connectedAccount: owner.classicAddress,
      appConfig: APP,
      now: NOW,
    });
    const firstBlob = owner.sign(first.transaction as never).tx_blob;

    const secondRequest = await committedRequest({
      owner: owner.classicAddress,
      idempotency_key: "owner-review-operation-0002",
      merchant: {
        ...firstRequest.merchant,
        resource_url: "https://merchant.example/v1/climate",
      },
    });
    const second = await bindIssuedAssetX402SigningRequest({
      request: secondRequest,
      connectedAccount: owner.classicAddress,
      appConfig: APP,
      now: NOW,
    });
    expect(second.request.approval_digest).not.toBe(first.request.approval_digest);
    expect(() => verifyIssuedAssetX402SignedBlob({ signedBlob: firstBlob, bound: second, now: NOW }))
      .toThrow(/changed/i);
  });
});
