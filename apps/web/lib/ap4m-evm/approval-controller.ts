import {
  AP4M_EVM_APPROVAL_PURPOSE,
  AP4M_EVM_CHAIN_ID,
  AP4M_EVM_PAYMENT_LEDGER,
  AP4M_EVM_REDEEM_SELECTOR,
  AP4M_EVM_RLUSD,
  type Ap4mSubmissionResult,
  type Ap4mVoucherApproval,
  type Eip1193Provider,
  type PreparedAp4mVoucherRedemption,
  type SignedAp4mVoucherApproval,
} from "./types";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const UINT = /^(?:0|[1-9][0-9]*)$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const UINT256_MAX = (1n << 256n) - 1n;
const MAX_APPROVAL_LIFETIME_MS = 10 * 60 * 1_000;

export class Ap4mEvmApprovalError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INVALID_APPROVAL"
      | "APPROVAL_EXPIRED"
      | "WALLET_MISMATCH"
      | "USER_REJECTED"
      | "INVALID_PREPARED_TRANSACTION"
      | "IDEMPOTENCY_MISMATCH",
  ) {
    super(message);
    this.name = "Ap4mEvmApprovalError";
  }
}

function fail(
  message: string,
  code: Ap4mEvmApprovalError["code"] = "INVALID_APPROVAL",
): never {
  throw new Ap4mEvmApprovalError(message, code);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function address(
  value: unknown,
  field: string,
  code: Ap4mEvmApprovalError["code"] = "INVALID_APPROVAL",
): string {
  if (typeof value !== "string" || !ADDRESS.test(value) || /^0x0{40}$/i.test(value)) {
    return fail(`${field} is invalid`, code);
  }
  return value.toLowerCase();
}

function exactAddress(
  value: unknown,
  expected: string,
  field: string,
  code: Ap4mEvmApprovalError["code"] = "INVALID_APPROVAL",
): string {
  const normalized = address(value, field, code);
  if (normalized !== expected.toLowerCase()) return fail(`${field} does not match the reviewed event profile`, code);
  return normalized;
}

function bytes32(value: unknown, field: string): string {
  if (typeof value !== "string" || !BYTES32.test(value) || /^0x0{64}$/i.test(value)) {
    return fail(`${field} is invalid`);
  }
  return value.toLowerCase();
}

function uint(
  value: unknown,
  field: string,
  positive = false,
  code: Ap4mEvmApprovalError["code"] = "INVALID_APPROVAL",
): bigint {
  if (typeof value !== "string" || !UINT.test(value)) return fail(`${field} is not a canonical uint`, code);
  const parsed = BigInt(value);
  if (parsed > UINT256_MAX || (positive && parsed === 0n)) return fail(`${field} is out of range`, code);
  return parsed;
}

function timestamp(value: unknown, field: string): number {
  if (typeof value !== "string") return fail(`${field} is invalid`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return fail(`${field} is invalid`);
  return parsed;
}

function ensureFresh(approval: Ap4mVoucherApproval, now: number): void {
  const issuedAt = timestamp(approval.issuedAt, "approval issuedAt");
  const expiresAt = timestamp(approval.expiresAt, "approval expiresAt");
  const validAfter = timestamp(approval.channelValidAfter, "channel validAfter");
  const validBefore = timestamp(approval.channelValidBefore, "channel validBefore");
  if (issuedAt > now || expiresAt <= now) return fail("AP4M approval has expired or is not active", "APPROVAL_EXPIRED");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_APPROVAL_LIFETIME_MS) {
    return fail("AP4M approval lifetime is invalid");
  }
  if (validAfter > issuedAt || expiresAt > validBefore || validBefore <= validAfter) {
    return fail("AP4M approval is outside the reviewed channel validity window");
  }
}

function validateTypedData(approval: Ap4mVoucherApproval): void {
  const typedData = approval.typedData;
  if (!record(typedData) || !exactKeys(typedData, ["domain", "primaryType", "types", "message"])) {
    return fail("Voucher typed data has unexpected fields");
  }
  if (!record(typedData.domain) || !exactKeys(typedData.domain, ["name", "version", "chainId", "verifyingContract"])) {
    return fail("Voucher typed-data domain is invalid");
  }
  if (
    typedData.domain.name !== "AP4M Payment Ledger" ||
    typedData.domain.version !== "1" ||
    typedData.domain.chainId !== AP4M_EVM_CHAIN_ID
  ) return fail("Voucher typed-data domain is not the reviewed purpose");
  exactAddress(typedData.domain.verifyingContract, AP4M_EVM_PAYMENT_LEDGER, "typed-data verifying contract");
  if (typedData.primaryType !== "Voucher") return fail("Voucher typed-data purpose is invalid");
  if (
    !record(typedData.types) || !exactKeys(typedData.types, ["Voucher"]) ||
    !Array.isArray(typedData.types.Voucher) || typedData.types.Voucher.length !== 2 ||
    !record(typedData.types.Voucher[0]) || !record(typedData.types.Voucher[1]) ||
    !exactKeys(typedData.types.Voucher[0], ["name", "type"]) ||
    !exactKeys(typedData.types.Voucher[1], ["name", "type"]) ||
    typedData.types.Voucher[0].name !== "channelId" || typedData.types.Voucher[0].type !== "bytes32" ||
    typedData.types.Voucher[1].name !== "cumulativeAmount" || typedData.types.Voucher[1].type !== "uint256"
  ) return fail("Voucher typed-data fields are invalid");
  if (!record(typedData.message) || !exactKeys(typedData.message, ["channelId", "cumulativeAmount"])) {
    return fail("Voucher typed-data value is invalid");
  }
  if (bytes32(typedData.message.channelId, "typed-data channel") !== approval.channelId.toLowerCase()) {
    return fail("Voucher typed-data channel does not match the approval");
  }
  if (typedData.message.cumulativeAmount !== approval.nextCumulativeAmount) {
    return fail("Voucher typed-data amount does not match the approval");
  }
}

export function validateAp4mVoucherApproval(value: unknown, now = Date.now()): Ap4mVoucherApproval {
  if (!record(value) || !exactKeys(value, [
    "purpose", "approvalId", "idempotencyKey", "issuedAt", "expiresAt", "channelValidAfter", "channelValidBefore", "chainId",
    "paymentLedger", "tokenAddress", "merchantId", "channelId", "agentWallet",
    "fundingWallet", "merchantPayout", "capBaseUnits", "previousCumulativeAmount",
    "nextCumulativeAmount", "maxGasLimit", "maxGasPriceWei", "typedData",
  ])) return fail("AP4M approval is invalid");
  const approval = value as unknown as Ap4mVoucherApproval;
  if (approval.purpose !== AP4M_EVM_APPROVAL_PURPOSE || approval.chainId !== AP4M_EVM_CHAIN_ID) {
    return fail("AP4M approval purpose or chain is invalid");
  }
  if (!IDENTIFIER.test(approval.approvalId) || !IDENTIFIER.test(approval.idempotencyKey)) {
    return fail("AP4M approval identifiers are invalid");
  }
  if (!IDENTIFIER.test(approval.merchantId)) return fail("AP4M merchant id is invalid");
  exactAddress(approval.paymentLedger, AP4M_EVM_PAYMENT_LEDGER, "PaymentLedger");
  exactAddress(approval.tokenAddress, AP4M_EVM_RLUSD, "RLUSD token");
  const channel = bytes32(approval.channelId, "channel id");
  const agent = address(approval.agentWallet, "agent wallet");
  const funding = address(approval.fundingWallet, "funding wallet");
  const payout = address(approval.merchantPayout, "merchant payout");
  if (payout === agent || payout === funding) return fail("Merchant payout must differ from agent and funding wallets");
  const cap = uint(approval.capBaseUnits, "channel cap", true);
  const previous = uint(approval.previousCumulativeAmount, "previous cumulative amount");
  const next = uint(approval.nextCumulativeAmount, "next cumulative amount", true);
  uint(approval.maxGasLimit, "gas limit cap", true);
  uint(approval.maxGasPriceWei, "gas price cap", true);
  if (next <= previous || next > cap) return fail("Voucher cumulative amount is not monotonic and bounded");
  if (channel !== approval.channelId.toLowerCase()) return fail("Channel normalization failed");
  ensureFresh(approval, now);
  validateTypedData(approval);
  return approval;
}

function word(data: string, start: number): string {
  return data.slice(start, start + 64);
}

function hexUint(value: string, field: string): bigint {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) return fail(`${field} ABI word is invalid`, "INVALID_PREPARED_TRANSACTION");
  return BigInt(`0x${value}`);
}

export function decodePreparedAp4mRedemption(data: unknown): Readonly<{
  channelId: string;
  cumulativeAmount: string;
  signature: string;
}> {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]+$/.test(data) || data.length % 2 !== 0) {
    return fail("Prepared AP4M calldata is invalid", "INVALID_PREPARED_TRANSACTION");
  }
  const encoded = data.slice(2);
  if (encoded.slice(0, 8).toLowerCase() !== AP4M_EVM_REDEEM_SELECTOR.slice(2)) {
    return fail("Prepared AP4M call selector is invalid", "INVALID_PREPARED_TRANSACTION");
  }
  const body = encoded.slice(8);
  if (body.length < 256) return fail("Prepared AP4M calldata is truncated", "INVALID_PREPARED_TRANSACTION");
  const channelWord = word(body, 0);
  const amountWord = word(body, 64);
  const signatureOffset = hexUint(word(body, 128), "signature offset");
  if (signatureOffset !== 96n) return fail("Prepared AP4M signature offset is non-canonical", "INVALID_PREPARED_TRANSACTION");
  const signatureLength = hexUint(word(body, 192), "signature length");
  if (signatureLength !== 65n) return fail("Prepared AP4M signature length is invalid", "INVALID_PREPARED_TRANSACTION");
  const paddedSignatureHexLength = Number(((signatureLength + 31n) / 32n) * 32n) * 2;
  const expectedBodyLength = 256 + paddedSignatureHexLength;
  if (body.length !== expectedBodyLength) return fail("Prepared AP4M calldata has trailing or missing bytes", "INVALID_PREPARED_TRANSACTION");
  const signatureBody = body.slice(256, 256 + Number(signatureLength) * 2);
  const padding = body.slice(256 + Number(signatureLength) * 2);
  if (!/^0*$/.test(padding)) return fail("Prepared AP4M signature padding is invalid", "INVALID_PREPARED_TRANSACTION");
  const channelId = `0x${channelWord}`.toLowerCase();
  const signature = `0x${signatureBody}`.toLowerCase();
  if (!BYTES32.test(channelId) || /^0x0{64}$/i.test(channelId) || !SIGNATURE.test(signature) || /^0x0{130}$/i.test(signature)) {
    return fail("Prepared AP4M call values are invalid", "INVALID_PREPARED_TRANSACTION");
  }
  return { channelId, cumulativeAmount: hexUint(amountWord, "cumulative amount").toString(), signature };
}

export function validatePreparedAp4mRedemption(
  value: unknown,
  signed: SignedAp4mVoucherApproval,
  now = Date.now(),
): PreparedAp4mVoucherRedemption {
  const approval = validateAp4mVoucherApproval(signed.approval, now);
  if (!SIGNATURE.test(signed.signature) || /^0x0{130}$/i.test(signed.signature)) {
    return fail("Voucher signature is invalid", "INVALID_PREPARED_TRANSACTION");
  }
  if (!record(value) || !exactKeys(value, [
    "chainId", "from", "to", "data", "value", "gasLimit", "feeModel", "gasPriceWei",
  ])) return fail("Prepared AP4M transaction is invalid", "INVALID_PREPARED_TRANSACTION");
  const transaction = value as unknown as PreparedAp4mVoucherRedemption;
  const agent = address(approval.agentWallet, "approval agent", "INVALID_PREPARED_TRANSACTION");
  if (
    transaction.chainId !== AP4M_EVM_CHAIN_ID ||
    transaction.feeModel !== "legacy" ||
    address(transaction.from, "transaction sender", "INVALID_PREPARED_TRANSACTION") !== agent ||
    exactAddress(transaction.to, AP4M_EVM_PAYMENT_LEDGER, "transaction target", "INVALID_PREPARED_TRANSACTION") !== AP4M_EVM_PAYMENT_LEDGER.toLowerCase() ||
    transaction.value !== "0"
  ) return fail("Prepared AP4M transaction target is invalid", "INVALID_PREPARED_TRANSACTION");
  const gas = uint(transaction.gasLimit, "prepared gas limit", true, "INVALID_PREPARED_TRANSACTION");
  const maxGas = uint(approval.maxGasLimit, "approved gas limit", true, "INVALID_PREPARED_TRANSACTION");
  const gasPrice = uint(transaction.gasPriceWei, "prepared gas price", true, "INVALID_PREPARED_TRANSACTION");
  const approvedGasPrice = uint(approval.maxGasPriceWei, "approved gas price", true, "INVALID_PREPARED_TRANSACTION");
  if (gas > maxGas || gasPrice > approvedGasPrice) {
    return fail("Prepared AP4M transaction exceeds approved fee bounds", "INVALID_PREPARED_TRANSACTION");
  }
  const decoded = decodePreparedAp4mRedemption(transaction.data);
  if (
    decoded.channelId !== approval.channelId.toLowerCase() ||
    decoded.cumulativeAmount !== approval.nextCumulativeAmount ||
    decoded.signature !== signed.signature.toLowerCase()
  ) return fail("Prepared AP4M call does not match the signed approval", "INVALID_PREPARED_TRANSACTION");
  return transaction;
}

function userRejected(error: unknown): boolean {
  return record(error) && (error.code === 4001 || error.code === "ACTION_REJECTED");
}

function quantity(value: string): string {
  return `0x${BigInt(value).toString(16)}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`).join(",")}}`;
  return JSON.stringify(value);
}

export type Ap4mEvmApprovalController = ReturnType<typeof createAp4mEvmApprovalController>;

export function createAp4mEvmApprovalController(
  provider: Eip1193Provider,
  options: Readonly<{ now?: () => number }> = {},
) {
  const now = options.now ?? Date.now;
  const signedByKey = new Map<string, Readonly<{ fingerprint: string; value: SignedAp4mVoucherApproval }>>();
  const submittedByKey = new Map<string, Readonly<{ fingerprint: string; result: Ap4mSubmissionResult }>>();
  const submitting = new Set<string>();

  async function exactWalletChainAndAccount(approval: Ap4mVoucherApproval): Promise<void> {
    const chain = await provider.request({ method: "eth_chainId" });
    if (typeof chain !== "string" || BigInt(chain) !== BigInt(AP4M_EVM_CHAIN_ID)) {
      return fail("Wallet is not connected to the reviewed AP4M chain", "WALLET_MISMATCH");
    }
    const accounts = await provider.request({ method: "eth_accounts" });
    const agent = address(approval.agentWallet, "approval agent");
    if (
      !Array.isArray(accounts) || accounts.length === 0 ||
      !accounts.some((account) => address(account, "wallet account", "WALLET_MISMATCH") === agent)
    ) {
      return fail("Wallet account does not match the approved AP4M agent", "WALLET_MISMATCH");
    }
  }

  return Object.freeze({
    review(value: unknown): Ap4mVoucherApproval {
      return validateAp4mVoucherApproval(value, now());
    },

    async signVoucher(value: unknown): Promise<SignedAp4mVoucherApproval> {
      const approval = validateAp4mVoucherApproval(value, now());
      const fingerprint = canonical(approval);
      const existing = signedByKey.get(approval.idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) return fail("Idempotency key is bound to another approval", "IDEMPOTENCY_MISMATCH");
        return existing.value;
      }
      await exactWalletChainAndAccount(approval);
      let response: unknown;
      try {
        response = await provider.request({
          method: "eth_signTypedData_v4",
          params: [approval.agentWallet, JSON.stringify(approval.typedData)],
        });
      } catch (error) {
        if (userRejected(error)) return fail("User rejected AP4M voucher signing", "USER_REJECTED");
        throw error;
      }
      if (typeof response !== "string" || !SIGNATURE.test(response) || /^0x0{130}$/i.test(response)) {
        return fail("Wallet returned an invalid voucher signature", "WALLET_MISMATCH");
      }
      const signed = Object.freeze({ approval, signature: response });
      signedByKey.set(approval.idempotencyKey, { fingerprint, value: signed });
      return signed;
    },

    async confirmAndSend(
      signed: SignedAp4mVoucherApproval,
      preparedValue: unknown,
    ): Promise<Ap4mSubmissionResult> {
      const transaction = validatePreparedAp4mRedemption(preparedValue, signed, now());
      const fingerprint = canonical({ signed, transaction });
      const key = signed.approval.idempotencyKey;
      const locallySigned = signedByKey.get(key);
      if (
        locallySigned === undefined || locallySigned.fingerprint !== canonical(signed.approval) ||
        locallySigned.value.signature.toLowerCase() !== signed.signature.toLowerCase()
      ) return fail("Transaction was not authorized by this explicit wallet approval", "IDEMPOTENCY_MISMATCH");
      const existing = submittedByKey.get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) return fail("Idempotency key is bound to another transaction", "IDEMPOTENCY_MISMATCH");
        return existing.result;
      }
      if (submitting.has(key)) return fail("This approval is already being submitted", "IDEMPOTENCY_MISMATCH");
      await exactWalletChainAndAccount(signed.approval);
      submitting.add(key);
      const reconciliationRequired = (transactionHash?: string): Ap4mSubmissionResult => Object.freeze({
        status: "reconciliation_required" as const,
        approvalId: signed.approval.approvalId,
        idempotencyKey: key,
        ...(transactionHash ? { transactionHash } : {}),
      });
      try {
        let response: unknown;
        try {
          response = await provider.request({
            method: "eth_sendTransaction",
            params: [{
              chainId: quantity(String(transaction.chainId)),
              from: transaction.from,
              to: transaction.to,
              data: transaction.data,
              value: "0x0",
              gas: quantity(transaction.gasLimit),
              gasPrice: quantity(transaction.gasPriceWei),
            }],
          });
        } catch (error) {
          if (userRejected(error)) return fail("User rejected AP4M transaction submission", "USER_REJECTED");
          const result = reconciliationRequired();
          submittedByKey.set(key, { fingerprint, result });
          return result;
        }
        if (typeof response !== "string" || !TX_HASH.test(response) || /^0x0{64}$/i.test(response)) {
          const result = reconciliationRequired();
          submittedByKey.set(key, { fingerprint, result });
          return result;
        }
        const result = Object.freeze({
          status: "submitted" as const,
          approvalId: signed.approval.approvalId,
          idempotencyKey: key,
          transactionHash: response,
        });
        submittedByKey.set(key, { fingerprint, result });
        return result;
      } finally {
        submitting.delete(key);
      }
    },
  });
}
