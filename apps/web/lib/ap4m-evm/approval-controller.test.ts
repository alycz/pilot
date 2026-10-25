import { describe, expect, it, vi } from "vitest";

import {
  Ap4mEvmApprovalError,
  createAp4mEvmApprovalController,
  decodePreparedAp4mRedemption,
  validateAp4mVoucherApproval,
  validatePreparedAp4mRedemption,
} from "./approval-controller";
import {
  AP4M_EVM_APPROVAL_PURPOSE,
  AP4M_EVM_CHAIN_ID,
  AP4M_EVM_PAYMENT_LEDGER,
  AP4M_EVM_REDEEM_SELECTOR,
  AP4M_EVM_RLUSD,
  type Ap4mVoucherApproval,
  type Eip1193Provider,
  type PreparedAp4mVoucherRedemption,
} from "./types";

const NOW = Date.parse("2026-10-25T00:00:00.000Z");
const CHANNEL = `0x${"ab".repeat(32)}`;
const AGENT = `0x${"11".repeat(20)}`;
const FUNDING = `0x${"22".repeat(20)}`;
const PAYOUT = `0x${"33".repeat(20)}`;
const SIGNATURE = `0x${"44".repeat(65)}`;
const TX_HASH = `0x${"55".repeat(32)}`;

function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function redemptionData(
  channelId = CHANNEL,
  cumulativeAmount = "20",
  signature = SIGNATURE,
): string {
  const signatureBody = signature.slice(2);
  const padding = "0".repeat((64 - signatureBody.length % 64) % 64);
  return `0x${[
    AP4M_EVM_REDEEM_SELECTOR.slice(2),
    channelId.slice(2),
    word(BigInt(cumulativeAmount)),
    word(96n),
    word(BigInt(signatureBody.length / 2)),
    signatureBody,
    padding,
  ].join("")}`;
}

function approval(overrides: Partial<Ap4mVoucherApproval> = {}): Ap4mVoucherApproval {
  const base: Ap4mVoucherApproval = {
    purpose: AP4M_EVM_APPROVAL_PURPOSE,
    approvalId: "ap4m-approval-1",
    idempotencyKey: "ap4m-voucher-1",
    issuedAt: "2026-10-24T23:59:00.000Z",
    expiresAt: "2026-10-25T00:05:00.000Z",
    channelValidAfter: "2026-10-24T23:00:00.000Z",
    channelValidBefore: "2026-10-25T01:00:00.000Z",
    chainId: AP4M_EVM_CHAIN_ID,
    paymentLedger: AP4M_EVM_PAYMENT_LEDGER,
    tokenAddress: AP4M_EVM_RLUSD,
    merchantId: "merchant-1",
    channelId: CHANNEL,
    agentWallet: AGENT,
    fundingWallet: FUNDING,
    merchantPayout: PAYOUT,
    capBaseUnits: "100",
    previousCumulativeAmount: "10",
    nextCumulativeAmount: "20",
    maxGasLimit: "300000",
    maxGasPriceWei: "1000000000",
    typedData: {
      domain: {
        name: "AP4M Payment Ledger",
        version: "1",
        chainId: AP4M_EVM_CHAIN_ID,
        verifyingContract: AP4M_EVM_PAYMENT_LEDGER,
      },
      primaryType: "Voucher",
      types: {
        Voucher: [
          { name: "channelId", type: "bytes32" },
          { name: "cumulativeAmount", type: "uint256" },
        ],
      },
      message: { channelId: CHANNEL, cumulativeAmount: "20" },
    },
  };
  return { ...base, ...overrides };
}

function transaction(
  overrides: Partial<PreparedAp4mVoucherRedemption> = {},
): PreparedAp4mVoucherRedemption {
  return {
    chainId: AP4M_EVM_CHAIN_ID,
    from: AGENT,
    to: AP4M_EVM_PAYMENT_LEDGER,
    data: redemptionData(),
    value: "0",
    gasLimit: "250000",
    feeModel: "legacy",
    gasPriceWei: "900000000",
    ...overrides,
  };
}

function provider(
  send: () => Promise<unknown> = async () => TX_HASH,
): Eip1193Provider & { request: ReturnType<typeof vi.fn> } {
  return {
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_chainId") return `0x${AP4M_EVM_CHAIN_ID.toString(16)}`;
      if (method === "eth_accounts") return [AGENT];
      if (method === "eth_signTypedData_v4") return SIGNATURE;
      if (method === "eth_sendTransaction") return send();
      throw new Error(`Unexpected method ${method}`);
    }),
  };
}

describe("AP4M EVM approval validation", () => {
  it("accepts the exact reviewed role, cap, expiry and typed-data bindings", () => {
    expect(validateAp4mVoucherApproval(approval(), NOW)).toEqual(approval());
  });

  it.each([
    ["wrong chain", { chainId: 1 }],
    ["wrong ledger", { paymentLedger: PAYOUT }],
    ["wrong token", { tokenAddress: PAYOUT }],
    ["payout equals agent", { merchantPayout: AGENT }],
    ["payout equals funding", { merchantPayout: FUNDING }],
    ["non-monotonic cumulative", { nextCumulativeAmount: "10" }],
    ["over-cap cumulative", { nextCumulativeAmount: "101" }],
    ["unbounded expiry", { expiresAt: "2026-10-25T00:20:00.000Z" }],
    ["expiry after channel", { channelValidBefore: "2026-10-25T00:04:00.000Z" }],
    ["issued before channel", { channelValidAfter: "2026-10-24T23:59:30.000Z" }],
  ])("rejects %s", (_label, patch) => {
    expect(() => validateAp4mVoucherApproval(approval(patch as never), NOW))
      .toThrow(Ap4mEvmApprovalError);
  });

  it("rejects expired approvals and typed data whose purpose or value drifted", () => {
    expect(() => validateAp4mVoucherApproval(approval(), Date.parse("2026-10-25T00:05:00.000Z")))
      .toThrowError(expect.objectContaining({ code: "APPROVAL_EXPIRED" }));
    expect(() => validateAp4mVoucherApproval(approval({
      typedData: { ...approval().typedData, message: { channelId: CHANNEL, cumulativeAmount: "21" } },
    }), NOW)).toThrow(/amount does not match/i);
    expect(() => validateAp4mVoucherApproval(approval({
      typedData: { ...approval().typedData, domain: { ...approval().typedData.domain, verifyingContract: PAYOUT } },
    }), NOW)).toThrow(/reviewed event profile/i);
  });

  it("decodes only canonical tuple-form voucher redemption calldata", () => {
    expect(decodePreparedAp4mRedemption(redemptionData())).toEqual({
      channelId: CHANNEL,
      cumulativeAmount: "20",
      signature: SIGNATURE,
    });
    for (const altered of [
      redemptionData().replace(AP4M_EVM_REDEEM_SELECTOR.slice(2), "413bbf5e"),
      `${redemptionData()}00`,
      `${AP4M_EVM_REDEEM_SELECTOR}${CHANNEL.slice(2)}${word(20n)}${word(128n)}${redemptionData().slice(2 + 8 + 64 * 3)}`,
      redemptionData(CHANNEL, "20", `0x${"00".repeat(65)}`),
    ]) {
      expect(() => decodePreparedAp4mRedemption(altered)).toThrowError(
        expect.objectContaining({ code: "INVALID_PREPARED_TRANSACTION" }),
      );
    }
  });

  it("validates the exact signed call and fee bounds", () => {
    const signed = { approval: approval(), signature: SIGNATURE };
    expect(validatePreparedAp4mRedemption(transaction(), signed, NOW)).toEqual(transaction());
    for (const altered of [
      transaction({ chainId: 1 as typeof AP4M_EVM_CHAIN_ID }),
      transaction({ from: FUNDING }),
      transaction({ to: PAYOUT }),
      transaction({ value: "1" as "0" }),
      transaction({ gasLimit: "300001" }),
      transaction({ gasPriceWei: "1000000001" }),
      transaction({ feeModel: "eip1559" as "legacy" }),
      transaction({ data: redemptionData(CHANNEL, "21") }),
      transaction({ data: redemptionData(CHANNEL, "20", `0x${"66".repeat(65)}`) }),
    ]) {
      expect(() => validatePreparedAp4mRedemption(altered, signed, NOW)).toThrowError(
        expect.objectContaining({ code: "INVALID_PREPARED_TRANSACTION" }),
      );
    }
  });
});

describe("AP4M EVM explicit wallet controller", () => {
  it("separates review, signing and transaction confirmation", async () => {
    const wallet = provider();
    const controller = createAp4mEvmApprovalController(wallet, { now: () => NOW });

    controller.review(approval());
    expect(wallet.request).not.toHaveBeenCalled();

    const signed = await controller.signVoucher(approval());
    expect(signed.signature).toBe(SIGNATURE);
    expect(wallet.request.mock.calls.map(([value]) => value.method)).toEqual([
      "eth_chainId", "eth_accounts", "eth_signTypedData_v4",
    ]);
    expect(wallet.request.mock.calls[2]?.[0]).toEqual({
      method: "eth_signTypedData_v4",
      params: [AGENT, JSON.stringify(approval().typedData)],
    });

    const result = await controller.confirmAndSend(signed, transaction());
    expect(result).toEqual({
      status: "submitted",
      approvalId: "ap4m-approval-1",
      idempotencyKey: "ap4m-voucher-1",
      transactionHash: TX_HASH,
    });
    expect(wallet.request.mock.calls.map(([value]) => value.method)).toEqual([
      "eth_chainId", "eth_accounts", "eth_signTypedData_v4",
      "eth_chainId", "eth_accounts", "eth_sendTransaction",
    ]);
    expect(wallet.request.mock.calls[5]?.[0]).toEqual({
      method: "eth_sendTransaction",
      params: [{
        chainId: `0x${AP4M_EVM_CHAIN_ID.toString(16)}`,
        from: AGENT,
        to: AP4M_EVM_PAYMENT_LEDGER,
        data: transaction().data,
        value: "0x0",
        gas: "0x3d090",
        gasPrice: "0x35a4e900",
      }],
    });
  });

  it("requires the exact reviewed wallet chain and agent account", async () => {
    const wrongChain = provider();
    wrongChain.request.mockImplementation(async ({ method }: { method: string }) =>
      method === "eth_chainId" ? "0x1" : [AGENT]);
    await expect(createAp4mEvmApprovalController(wrongChain, { now: () => NOW }).signVoucher(approval()))
      .rejects.toMatchObject({ code: "WALLET_MISMATCH" });
    expect(wrongChain.request).toHaveBeenCalledTimes(1);

    const wrongAccount = provider();
    wrongAccount.request.mockImplementation(async ({ method }: { method: string }) =>
      method === "eth_chainId" ? `0x${AP4M_EVM_CHAIN_ID.toString(16)}` : [FUNDING]);
    await expect(createAp4mEvmApprovalController(wrongAccount, { now: () => NOW }).signVoucher(approval()))
      .rejects.toMatchObject({ code: "WALLET_MISMATCH" });
    expect(wrongAccount.request).toHaveBeenCalledTimes(2);
  });

  it("requires the sign step from the same controller before transaction confirmation", async () => {
    const wallet = provider();
    const controller = createAp4mEvmApprovalController(wallet, { now: () => NOW });
    await expect(controller.confirmAndSend(
      { approval: approval(), signature: SIGNATURE },
      transaction(),
    )).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    expect(wallet.request).not.toHaveBeenCalled();
  });

  it("replays identical sign and send requests without another wallet effect", async () => {
    const wallet = provider();
    const controller = createAp4mEvmApprovalController(wallet, { now: () => NOW });
    const signed = await controller.signVoucher(approval());
    expect(await controller.signVoucher(approval())).toBe(signed);
    const first = await controller.confirmAndSend(signed, transaction());
    expect(await controller.confirmAndSend(signed, transaction())).toBe(first);
    expect(wallet.request.mock.calls.filter(([value]) => value.method === "eth_signTypedData_v4")).toHaveLength(1);
    expect(wallet.request.mock.calls.filter(([value]) => value.method === "eth_sendTransaction")).toHaveLength(1);
  });

  it("returns reconciliation-required for an ambiguous send and never retries it", async () => {
    const wallet = provider(async () => { throw new Error("provider response lost"); });
    const controller = createAp4mEvmApprovalController(wallet, { now: () => NOW });
    const signed = await controller.signVoucher(approval());
    const first = await controller.confirmAndSend(signed, transaction());
    expect(first).toEqual({
      status: "reconciliation_required",
      approvalId: "ap4m-approval-1",
      idempotencyKey: "ap4m-voucher-1",
    });
    expect(await controller.confirmAndSend(signed, transaction())).toBe(first);
    expect(wallet.request.mock.calls.filter(([value]) => value.method === "eth_sendTransaction")).toHaveLength(1);
  });

  it("treats an invalid provider response as unknown and rejects changed idempotent payloads", async () => {
    const wallet = provider(async () => "not-a-transaction-hash");
    const controller = createAp4mEvmApprovalController(wallet, { now: () => NOW });
    const signed = await controller.signVoucher(approval());
    await expect(controller.confirmAndSend(signed, transaction())).resolves.toMatchObject({
      status: "reconciliation_required",
    });
    await expect(controller.confirmAndSend(signed, transaction({ gasLimit: "240000" })))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    expect(wallet.request.mock.calls.filter(([value]) => value.method === "eth_sendTransaction")).toHaveLength(1);
  });

  it("does not classify an explicit user rejection as an unknown submission", async () => {
    const wallet = provider(async () => { throw { code: 4001 }; });
    const controller = createAp4mEvmApprovalController(wallet, { now: () => NOW });
    const signed = await controller.signVoucher(approval());
    await expect(controller.confirmAndSend(signed, transaction()))
      .rejects.toMatchObject({ code: "USER_REJECTED" });
  });
});
