import { describe, expect, it, vi } from "vitest";

import {
  NearIntentsApprovalEnvelopeSchema,
  createNearWallet,
  digestNearIntentsApproval,
  verifyNearIntentsApproval,
  type NearIntentsApprovalEnvelope,
  type NearWalletAdapter,
} from "../src/near.js";

const FUTURE = "2099-01-01T00:00:00.000Z";
const PROVIDER_DEADLINE = "2099-01-02T00:00:00.000Z";

function envelope(
  input: Partial<NearIntentsApprovalEnvelope> = {},
): NearIntentsApprovalEnvelope {
  return {
    version: "pilot-near-1click-approval-v1",
    principal_id: "principal-near-0001",
    network: "near:mainnet",
    idempotency_key: "intent-attempt-0001",
    policy_digest: "A".repeat(64),
    quote_id: "quote-0001",
    quote_hash: "B".repeat(44),
    provider_signature_verified: true,
    origin_asset: "nep141:asset-in.example",
    destination_asset: "nep141:asset-out.example",
    amount_in: "1000000",
    min_amount_out: "900000",
    recipient: "recipient.near",
    refund_to: "refund.near",
    deposit_address: "deposit-address-from-verified-quote",
    deposit_memo: "memo-0001",
    approval_expires_at: FUTURE,
    provider_deadline_at: PROVIDER_DEADLINE,
    ...input,
  };
}

function adapter(): NearWalletAdapter & { signApproval: ReturnType<typeof vi.fn> } {
  return {
    providerId: "test-provider",
    isAvailable: vi.fn(async () => true),
    connect: vi.fn(async ({ network }) => ({
      connection_id: "connection-near-0001",
      provider_id: "test-provider",
      account_id: "alice.near",
      network,
      connected_at: "2098-01-01T00:00:00.000Z",
      capabilities: {
        sign_message: true,
        sign_transaction: false,
        sign_and_send_transaction: false,
      },
    })),
    disconnect: vi.fn(async () => undefined),
    signApproval: vi.fn(async () => ({
      provider_id: "test-provider",
      account_id: "alice.near",
      network: "near:mainnet" as const,
      signed_payload: "opaque-wallet-result",
    })),
  };
}

describe("NEAR Intents approval binding", () => {
  it("verifies the exact provider-verified executable quote", async () => {
    const reviewed = envelope();
    const digest = await digestNearIntentsApproval(reviewed);
    expect(digest).toMatch(/^[A-F0-9]{64}$/);
    await expect(verifyNearIntentsApproval({
      envelope: reviewed,
      approvalDigest: digest,
      now: Date.parse("2098-01-01T00:00:00.000Z"),
    })).resolves.toEqual(reviewed);
  });

  it.each([
    ["amount", { amount_in: "1000001" }],
    ["input asset", { origin_asset: "nep141:different.example" }],
    ["output asset", { destination_asset: "nep141:different.example" }],
    ["recipient", { recipient: "mallory.near" }],
    ["refund", { refund_to: "mallory.near" }],
    ["deposit address", { deposit_address: "different-deposit" }],
    ["deposit memo", { deposit_memo: "different-memo" }],
    ["approval expiry", { approval_expires_at: "2099-01-01T01:00:00.000Z" }],
    ["provider deadline", { provider_deadline_at: "2099-01-02T01:00:00.000Z" }],
  ])("changes the digest when %s changes", async (_name, change) => {
    expect(await digestNearIntentsApproval(envelope(change)))
      .not.toBe(await digestNearIntentsApproval(envelope()));
  });

  it("rejects unverified quote-shaped approvals", () => {
    expect(NearIntentsApprovalEnvelopeSchema.safeParse({
      ...envelope(),
      provider_signature_verified: false,
    }).success).toBe(false);
  });

  it("rejects a digest created before an exact field was tampered", async () => {
    const reviewed = envelope();
    await expect(verifyNearIntentsApproval({
      envelope: envelope({ recipient: "mallory.near" }),
      approvalDigest: await digestNearIntentsApproval(reviewed),
    })).rejects.toMatchObject({ code: "NEAR_APPROVAL_DIGEST_MISMATCH" });
  });
});

describe("guarded NEAR wallet facade", () => {
  it("keeps signing disabled by default", async () => {
    const walletAdapter = adapter();
    const wallet = createNearWallet(walletAdapter);
    await wallet.connect("near:mainnet");
    const reviewed = envelope();
    await expect(wallet.signApproval({
      envelope: reviewed,
      approvalDigest: await digestNearIntentsApproval(reviewed),
    })).rejects.toMatchObject({ code: "NEAR_SIGNING_DISABLED" });
    expect(walletAdapter.signApproval).not.toHaveBeenCalled();
  });

  it("passes only an explicitly enabled, exact approval", async () => {
    const walletAdapter = adapter();
    const wallet = createNearWallet(walletAdapter, {
      policy: { mode: "owner-approval", mainnet_execution_enabled: true },
    });
    await wallet.connect("near:mainnet");
    const reviewed = envelope();
    const approvalDigest = await digestNearIntentsApproval(reviewed);
    const signed = await wallet.signApproval({ envelope: reviewed, approvalDigest });
    expect(signed.account_id).toBe("alice.near");
    expect(walletAdapter.signApproval).toHaveBeenCalledWith({
      envelope: reviewed,
      approvalDigest,
    });
  });

  it("does not sign a mainnet approval from a testnet session", async () => {
    const walletAdapter = adapter();
    const wallet = createNearWallet(walletAdapter, {
      policy: { mode: "owner-approval", mainnet_execution_enabled: true },
    });
    await wallet.connect("near:testnet");
    const reviewed = envelope();
    await expect(wallet.signApproval({
      envelope: reviewed,
      approvalDigest: await digestNearIntentsApproval(reviewed),
    })).rejects.toMatchObject({ code: "NEAR_SIGNATURE_SCOPE_MISMATCH" });
    expect(walletAdapter.signApproval).not.toHaveBeenCalled();
  });
});

