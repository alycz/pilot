import { describe, expect, it, vi } from "vitest";

import { createNearReconciliationRpcPort } from "../src/near/reconciliation-rpc";

const NEAR_RPC = "https://rpc.mainnet.near.org";
const ARB_RPC = "https://arb1.arbitrum.io/rpc";
const HASH = "1".repeat(44);
const EVM_HASH = `0x${"1".repeat(64)}`;
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const RECIPIENT_TOPIC = `0x${"0".repeat(24)}${RECIPIENT.slice(2)}`;
const SENDER_TOPIC = `0x${"0".repeat(24)}${"2".repeat(40)}`;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function response(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: "pilot-near-reconcile", result }));
}

describe("trusted reconciliation RPC boundary", () => {
  it("rejects non-pinned origins before fetching", () => {
    expect(() => createNearReconciliationRpcPort({ nearRpcUrl: "https://example.com", arbitrumRpcUrl: ARB_RPC }))
      .toThrow(/pinned mainnet/i);
  });

  it("verifies one exact finalized native NEAR transfer", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({
        final_execution_status: "FINAL",
        status: { SuccessValue: "" },
        transaction: { signer_id: "owner.near", receiver_id: "deposit.near", actions: [{ Transfer: { deposit: "100" } }] },
        receipts_outcome: [{
          id: HASH,
          block_hash: HASH,
          outcome: { executor_id: "deposit.near", status: { SuccessValue: "" } },
        }],
      }))
      .mockResolvedValueOnce(response({ header: { height: 123, timestamp_nanosec: "1761479999000000000" } }));
    const port = createNearReconciliationRpcPort({ nearRpcUrl: NEAR_RPC, arbitrumRpcUrl: ARB_RPC, fetcher });
    const evidence = await port.verifySource({
      transactionHash: HASH,
      sourceAccountId: "owner.near",
      depositAccountId: "deposit.near",
      amountYoctoNear: "100",
      verifiedAt: "2026-10-26T12:00:00.000Z",
    });
    expect(evidence).toMatchObject({ receipt_id: HASH, block_height: 123, amount_yocto_near: "100" });
    const body = JSON.parse(fetcher.mock.calls[0]![1].body);
    expect(body.params).toEqual({ tx_hash: HASH, sender_account_id: "owner.near", wait_until: "FINAL" });
  });

  it("rejects extra source actions", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({
      final_execution_status: "FINAL",
      status: { SuccessValue: "" },
      transaction: { signer_id: "owner.near", receiver_id: "deposit.near", actions: [
        { Transfer: { deposit: "100" } }, { FunctionCall: { method_name: "x" } },
      ] },
      receipts_outcome: [],
    }));
    const port = createNearReconciliationRpcPort({ nearRpcUrl: NEAR_RPC, arbitrumRpcUrl: ARB_RPC, fetcher });
    await expect(port.verifySource({ transactionHash: HASH, sourceAccountId: "owner.near", depositAccountId: "deposit.near", amountYoctoNear: "100", verifiedAt: "2026-10-26T12:00:00.000Z" }))
      .rejects.toThrow(/exact native transfer|approved transfer/i);
  });

  it("verifies one finalized canonical Arbitrum USDC delivery without trusting payout sender", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({
        transactionHash: EVM_HASH,
        status: "0x1",
        blockHash: `0x${"3".repeat(64)}`,
        blockNumber: "0x10",
        transactionIndex: "0x1",
        logs: [{
          address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
          topics: [TRANSFER, SENDER_TOPIC, RECIPIENT_TOPIC],
          data: "0x493e0",
          logIndex: "0x2",
        }],
      }))
      .mockResolvedValueOnce(response({ number: "0x11" }));
    const port = createNearReconciliationRpcPort({ nearRpcUrl: NEAR_RPC, arbitrumRpcUrl: ARB_RPC, fetcher });
    await expect(port.verifyDestination({ transactionHash: EVM_HASH, recipient: RECIPIENT, minimumAmount: "297000", verifiedAt: "2026-10-26T12:00:00.000Z" }))
      .resolves.toMatchObject({ amount_received: "300000", recipient_address: RECIPIENT, sender_address: `0x${"2".repeat(40)}` });
  });

  it("rejects ambiguous qualifying destination logs", async () => {
    const log = { address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", topics: [TRANSFER, SENDER_TOPIC, RECIPIENT_TOPIC], data: "0x493e0", logIndex: "0x2" };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ transactionHash: EVM_HASH, status: "0x1", blockHash: `0x${"3".repeat(64)}`, blockNumber: "0x10", transactionIndex: "0x1", logs: [log, { ...log, logIndex: "0x3" }] }))
      .mockResolvedValueOnce(response({ number: "0x11" }));
    const port = createNearReconciliationRpcPort({ nearRpcUrl: NEAR_RPC, arbitrumRpcUrl: ARB_RPC, fetcher });
    await expect(port.verifyDestination({ transactionHash: EVM_HASH, recipient: RECIPIENT, minimumAmount: "297000", verifiedAt: "2026-10-26T12:00:00.000Z" }))
      .rejects.toThrow(/ambiguous/i);
  });
});
