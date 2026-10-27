import { describe, expect, it } from "vitest";

import {
  classifyReceiptReplay,
  verifyFinalizedArbitrumErc20Transfer,
  verifyFinalizedNearNativeTransfer,
  type VerifiedArbitrumUsdcTransfer,
  type VerifiedNearNativeTransfer,
} from "../src/near-receipts";

const nearTransactionHash = "3".repeat(44);
const nearReceiptId = "5".repeat(44);
const nearBlockHash = "4".repeat(44);
const nearExpectation = {
  network: "near:mainnet" as const,
  trusted_rpc_endpoint_id: "near-mainnet-primary",
  owner_account: "owner.near",
  deposit_address: "deposit.near",
  amount_yocto: "1000000000000000000000000",
  wallet_callback_transaction_hash: nearTransactionHash,
};
const nearEvidence = {
  version: "pilot-near-final-native-transfer-v1",
  rpc_endpoint_id: "near-mainnet-primary",
  network: "near:mainnet",
  finality: "final",
  execution_status: "success",
  transaction_hash: nearTransactionHash,
  receipt_id: nearReceiptId,
  signer_id: "owner.near",
  receiver_id: "deposit.near",
  actions: [{ kind: "TRANSFER", deposit_yocto: "1000000000000000000000000" }],
  memo: null,
  block_height: 150_000_000,
  block_hash: nearBlockHash,
  included_at: "2026-10-26T11:59:59.000Z",
  verified_at: "2026-10-26T12:00:00.000Z",
};

const usdc = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const sender = "0x1111111111111111111111111111111111111111";
const recipient = "0x2222222222222222222222222222222222222222";
const arbitrumTransactionHash = `0x${"3".repeat(64)}`;
const arbitrumEvidence = {
  version: "pilot-arbitrum-final-erc20-transfer-v1",
  rpc_endpoint_id: "arbitrum-mainnet-primary",
  chain_id: 42161,
  finality: "final",
  receipt_status: "success",
  transaction_hash: arbitrumTransactionHash,
  block_number: 270_000_000,
  block_hash: `0x${"4".repeat(64)}`,
  transfers: [{
    event: "Transfer",
    token_contract: usdc,
    from: sender,
    to: recipient,
    value_atomic: "995000",
    log_index: 7,
  }],
  verified_at: "2026-10-26T12:05:00.000Z",
};
const arbitrumExpectation = {
  chain_id: 42161 as const,
  trusted_rpc_endpoint_id: "arbitrum-mainnet-primary",
  token_contract: usdc,
  recipient,
  minimum_amount_atomic: "990000",
  transaction_hash: arbitrumTransactionHash,
};

function rejectionCode(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "code" in value
    ? String((value as { code: unknown }).code)
    : undefined;
}

describe("finalized chain receipt verification", () => {
  it("verifies a finalized successful native NEAR transfer only after RPC evidence", () => {
    const result = verifyFinalizedNearNativeTransfer(nearExpectation, nearEvidence);
    expect(result).toMatchObject({
      kind: "near-native-transfer",
      settlement_eligible: true,
      evidence: {
        receipt_id: nearReceiptId,
        included_at: "2026-10-26T11:59:59.000Z",
      },
    });
    expect(verifyFinalizedNearNativeTransfer(nearExpectation, {
      transaction_hash: nearTransactionHash,
      provider_status: "SUCCESS",
    })).toMatchObject({ ok: false, settlement_eligible: false, code: "INVALID_EVIDENCE" });
  });

  it.each([
    ["missing receipt id", { receipt_id: undefined }],
    ["malformed receipt id", { receipt_id: "not-a-near-receipt" }],
    ["missing inclusion time", { included_at: undefined }],
    ["timezone-ambiguous inclusion time", { included_at: "2026-10-26T11:59:59" }],
    ["impossible inclusion date", { included_at: "2026-02-30T11:59:59.000Z" }],
    ["inclusion after verification", { included_at: "2026-10-26T12:00:00.001Z" }],
  ])("rejects NEAR evidence with %s", (_label, mutation) => {
    const result = verifyFinalizedNearNativeTransfer(nearExpectation, { ...nearEvidence, ...mutation });
    expect(rejectionCode(result)).toBe("INVALID_EVIDENCE");
  });

  it.each([
    ["wrong RPC", { rpc_endpoint_id: "untrusted-rpc" }, "UNTRUSTED_RPC"],
    ["wrong chain", { network: "near:testnet" }, "WRONG_CHAIN"],
    ["nonfinal", { finality: "optimistic" }, "NONFINAL"],
    ["failed", { execution_status: "failure" }, "REVERTED"],
    ["wrong callback hash", { transaction_hash: "5".repeat(44) }, "WRONG_TRANSACTION"],
    ["wrong sender", { signer_id: "attacker.near" }, "WRONG_SENDER"],
    ["wrong recipient", { receiver_id: "attacker.near" }, "WRONG_RECIPIENT"],
    ["wrong amount", { actions: [{ kind: "TRANSFER", deposit_yocto: "999" }] }, "WRONG_AMOUNT"],
    ["memo", { memo: "not-allowed" }, "MEMO_NOT_ALLOWED"],
  ])("rejects NEAR evidence with %s", (_label, mutation, code) => {
    const result = verifyFinalizedNearNativeTransfer(nearExpectation, { ...nearEvidence, ...mutation });
    expect(rejectionCode(result)).toBe(code);
  });

  it("verifies one finalized canonical Arbitrum USDC Transfer at or above minimum output", () => {
    expect(verifyFinalizedArbitrumErc20Transfer(arbitrumExpectation, arbitrumEvidence)).toMatchObject({
      kind: "arbitrum-usdc-transfer",
      settlement_eligible: true,
      matched_transfer: { value_atomic: "995000", log_index: 7 },
    });
  });

  it.each([
    ["wrong RPC", { rpc_endpoint_id: "untrusted-rpc" }, "UNTRUSTED_RPC"],
    ["wrong chain", { chain_id: 1 }, "WRONG_CHAIN"],
    ["nonfinal", { finality: "pending" }, "NONFINAL"],
    ["reverted", { receipt_status: "reverted" }, "REVERTED"],
    ["wrong transaction", { transaction_hash: `0x${"5".repeat(64)}` }, "WRONG_TRANSACTION"],
  ])("rejects Arbitrum receipt metadata with %s", (_label, mutation, code) => {
    const result = verifyFinalizedArbitrumErc20Transfer(arbitrumExpectation, { ...arbitrumEvidence, ...mutation });
    expect(rejectionCode(result)).toBe(code);
  });

  it.each([
    ["wrong token", { token_contract: "0x3333333333333333333333333333333333333333" }, "WRONG_TOKEN"],
    ["wrong recipient", { to: "0x3333333333333333333333333333333333333333" }, "WRONG_RECIPIENT"],
    ["below minimum", { value_atomic: "989999" }, "WRONG_AMOUNT"],
  ])("rejects Arbitrum Transfer with %s", (_label, mutation, code) => {
    const result = verifyFinalizedArbitrumErc20Transfer(arbitrumExpectation, {
      ...arbitrumEvidence,
      transfers: [{ ...arbitrumEvidence.transfers[0], ...mutation }],
    });
    expect(rejectionCode(result)).toBe(code);
  });

  it("accepts an observed payout sender without treating it as a reviewed input", () => {
    const observedSender = "0x3333333333333333333333333333333333333333";
    const result = verifyFinalizedArbitrumErc20Transfer(arbitrumExpectation, {
      ...arbitrumEvidence,
      transfers: [{ ...arbitrumEvidence.transfers[0], from: observedSender }],
    });
    expect(result).toMatchObject({
      kind: "arbitrum-usdc-transfer",
      settlement_eligible: true,
      matched_transfer: { from: observedSender },
    });
  });

  it("rejects ambiguous matching transfers", () => {
    const result = verifyFinalizedArbitrumErc20Transfer(arbitrumExpectation, {
      ...arbitrumEvidence,
      transfers: [arbitrumEvidence.transfers[0], { ...arbitrumEvidence.transfers[0], log_index: 8 }],
    });
    expect(rejectionCode(result)).toBe("AMBIGUOUS_TRANSFER");
  });

  it("classifies duplicate and conflicting evidence without settling either again", () => {
    const near = verifyFinalizedNearNativeTransfer(nearExpectation, nearEvidence) as VerifiedNearNativeTransfer;
    expect(classifyReceiptReplay([], near)).toMatchObject({ decision: "new" });
    expect(classifyReceiptReplay([near], near)).toEqual({
      decision: "duplicate",
      settlement_eligible: false,
      evidence_key: near.evidence_key,
    });

    const first = verifyFinalizedArbitrumErc20Transfer(arbitrumExpectation, arbitrumEvidence) as VerifiedArbitrumUsdcTransfer;
    const conflicting = verifyFinalizedArbitrumErc20Transfer(arbitrumExpectation, {
      ...arbitrumEvidence,
      block_hash: `0x${"6".repeat(64)}`,
    }) as VerifiedArbitrumUsdcTransfer;
    expect(classifyReceiptReplay([first], conflicting)).toEqual({
      decision: "conflict",
      settlement_eligible: false,
      evidence_key: first.evidence_key,
    });
  });
});
