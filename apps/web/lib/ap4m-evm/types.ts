export const AP4M_EVM_CHAIN_ID = 1_449_000;
export const AP4M_EVM_PAYMENT_LEDGER = "0xcAB42800A5ECF0D253Fa2581Bb3334B4DAEfaE91";
export const AP4M_EVM_RLUSD = "0x27b57a9D0b8d24EB97259c4E2279e45255e016f3";
export const AP4M_EVM_REDEEM_SELECTOR = "0x21eb2efb";
export const AP4M_EVM_APPROVAL_PURPOSE = "pilot.ap4m-evm.voucher-redemption.v1";

export type Eip1193RequestArguments = Readonly<{
  method: string;
  params?: readonly unknown[] | Record<string, unknown>;
}>;

export interface Eip1193Provider {
  request(args: Eip1193RequestArguments): Promise<unknown>;
}

export type Ap4mVoucherTypedData = Readonly<{
  domain: Readonly<{
    name: "AP4M Payment Ledger";
    version: "1";
    chainId: typeof AP4M_EVM_CHAIN_ID;
    verifyingContract: string;
  }>;
  primaryType: "Voucher";
  types: Readonly<{
    Voucher: readonly [
      Readonly<{ name: "channelId"; type: "bytes32" }>,
      Readonly<{ name: "cumulativeAmount"; type: "uint256" }>,
    ];
  }>;
  message: Readonly<{
    channelId: string;
    cumulativeAmount: string;
  }>;
}>;

export type Ap4mVoucherApproval = Readonly<{
  purpose: typeof AP4M_EVM_APPROVAL_PURPOSE;
  approvalId: string;
  idempotencyKey: string;
  issuedAt: string;
  expiresAt: string;
  channelValidAfter: string;
  channelValidBefore: string;
  chainId: typeof AP4M_EVM_CHAIN_ID;
  paymentLedger: string;
  tokenAddress: string;
  merchantId: string;
  channelId: string;
  agentWallet: string;
  fundingWallet: string;
  merchantPayout: string;
  capBaseUnits: string;
  previousCumulativeAmount: string;
  nextCumulativeAmount: string;
  maxGasLimit: string;
  maxGasPriceWei: string;
  typedData: Ap4mVoucherTypedData;
}>;

export type SignedAp4mVoucherApproval = Readonly<{
  approval: Ap4mVoucherApproval;
  signature: string;
}>;

export type PreparedAp4mVoucherRedemption = Readonly<{
  chainId: typeof AP4M_EVM_CHAIN_ID;
  from: string;
  to: string;
  data: string;
  value: "0";
  gasLimit: string;
  feeModel: "legacy";
  gasPriceWei: string;
}>;

export type Ap4mSubmissionResult =
  | Readonly<{
      status: "submitted";
      approvalId: string;
      idempotencyKey: string;
      transactionHash: string;
    }>
  | Readonly<{
      status: "reconciliation_required";
      approvalId: string;
      idempotencyKey: string;
      transactionHash?: string;
    }>;
