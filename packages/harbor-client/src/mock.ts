import {
  AccountLinkSchema,
  Ap4mReceiptSchema,
  EnvelopeSchema,
  ExecResultSchema,
  MandateSchema,
  MerchantSchema,
  PolicySchema,
  TxBuildSchema,
  VenueSchema,
  type AccountLink,
  type Asset,
  type Envelope,
  type Err,
  type ExecResult,
  type Mandate,
  type Network,
  type Policy,
  type PolicyResult,
  type Strategy,
  type StrategyAuditEvent,
  type StrategyKillSwitch,
  type TxBuild,
} from "@pilot/contracts";
import { z } from "zod";

import builderFixturesJson from "../fixtures/builders.json";
import executionFixturesJson from "../fixtures/execution.json";
import ap4mFixturesJson from "../fixtures/ap4m-operations.json";
import readFixturesJson from "../fixtures/reads.json";
import {
  HarborArgsSchemas,
  HarborResultSchemas,
  OnboardingReadinessResultSchema,
  X402PayResultSchema,
  type ArgsFor,
  type HarborClient,
  type HarborOpName,
  type ResultFor,
  type X402PayResult,
} from "./types.js";

type FixtureTable = Record<string, unknown>;
type JsonRecord = Record<string, unknown>;
type MockCurrencyAmount = string | { currency: string; issuer: string; value: string };

type StoredBuild = {
  build: TxBuild;
  amountUsd: number;
  assets: Asset[];
  hasUnknownIssuer: boolean;
  maxSlippageBps?: number;
};

type StoredMockMandate = {
  args: ArgsFor<"mandate.prepare">;
  notBefore: string;
  prepared: ResultFor<"mandate.prepare">;
  sequence: number;
};

const GenericEnvelopeSchema = EnvelopeSchema(z.unknown());
const MandatePrepareResultSchema = z
  .object({
    mandate_id: z.string(),
    agent_public_jwk: z.record(z.string(), z.unknown()),
    claim_public_keys: z.array(
      z
        .object({ merchant_id: z.string(), public_key: z.string() })
        .strict(),
    ),
    unsigned_batch: z.record(z.string(), z.unknown()),
    unsigned_sequential: z
      .array(z.record(z.string(), z.unknown()))
      .optional(),
  })
  .strict();
const CredentialStatusResultSchema = z
  .object({
    account: z.string(),
    network: z.literal("testnet"),
    issuer: z.string(),
    credential_type_hex: z.string(),
    credential_id: z.string().optional(),
    accepted: z.boolean(),
    expired: z.boolean(),
    expiration: z.string().optional(),
  })
  .strict();
const CredentialPayerAcceptResultSchema = z
  .object({
    account: z.string(),
    credential_id: z.string(),
    status: z.enum(["validated", "pending", "failed"]),
    hash: z.string().optional(),
    engine_result: z.string().optional(),
  })
  .strict();
const CredentialIdsResultSchema = z
  .object({
    account: z.string(),
    network: z.literal("testnet"),
    credential_ids: z.array(z.string()),
  })
  .strict();
const ChannelStatusResultSchema = z
  .object({
    channel_id: z.string(),
    mandate_id: z.string(),
    merchant_id: z.string(),
    network: z.literal("testnet"),
    amount_drops: z.string(),
    highest_claim_drops: z.string(),
    remaining_drops: z.string(),
    status: z.enum(["open", "closing", "closed"]),
    settle_delay: z.number().int().nonnegative(),
  })
  .strict();
const MastercardSourceSchema = z.literal("Mastercard Developers");
const MastercardServicesResultSchema = z
  .object({
    source: MastercardSourceSchema,
    services: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          description: z.string().optional(),
          docs_url: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();
const MastercardDocsResultSchema = z
  .object({
    source: MastercardSourceSchema,
    service_id: z.string(),
    pages: z.array(
      z
        .object({
          title: z.string(),
          path: z.string(),
          url: z.string().optional(),
          summary: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();
const MastercardPageResultSchema = z
  .object({
    source: MastercardSourceSchema,
    title: z.string(),
    path: z.string(),
    summary: z.string(),
    url: z.string(),
  })
  .strict();
const MastercardSearchResultSchema = z
  .object({
    source: MastercardSourceSchema,
    query: z.string(),
    results: z.array(
      z
        .object({
          service_id: z.string(),
          title: z.string(),
          summary: z.string().optional(),
          url: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();
const FORBIDDEN_ARGUMENT = /seed|secret|private|mnemonic/i;
const TF_IMMEDIATE_OR_CANCEL = 0x0002_0000;
const TF_FILL_OR_KILL = 0x0004_0000;
const TF_SELL = 0x0008_0000;
const MOCK_XRP_USD = 0.512;
const RLUSD_HEX = "524C555344000000000000000000000000000000";
const MAX_PREPARED_MANDATES = 32;
const MOCK_AP4M_L2_MEMO_TYPE = "6170346D2F6C32";
const KNOWN_ISSUERS = new Set([
  "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
  "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
]);

const fixtures: FixtureTable = {
  ...(readFixturesJson as FixtureTable),
  ...(builderFixturesJson as FixtureTable),
  ...(executionFixturesJson as FixtureTable),
  ...(ap4mFixturesJson as FixtureTable),
};

const builderOperations = new Set<HarborOpName>([
  "tx.swap",
  "tx.offer",
  "tx.offerCancel",
  "tx.payment",
  "tx.trustSet",
  "tx.ammDeposit",
  "tx.ammWithdraw",
  "tx.vaultDeposit",
  "tx.vaultWithdraw",
  "tx.escrowCreate",
  "tx.escrowFinish",
  "tx.escrowCancel",
  "tx.checkCreate",
  "tx.checkCash",
  "tx.checkCancel",
  "tx.simulate",
]);

const nativeBuilderOperations = new Set<HarborOpName>([
  "tx.escrowCreate",
  "tx.escrowFinish",
  "tx.escrowCancel",
  "tx.checkCreate",
  "tx.checkCash",
  "tx.checkCancel",
]);

const nativeTransactionTypes = new Set([
  "EscrowCreate",
  "EscrowFinish",
  "EscrowCancel",
  "CheckCreate",
  "CheckCash",
  "CheckCancel",
]);

const delegableNativeTypes = new Set([
  "EscrowFinish",
  "EscrowCancel",
  "CheckCash",
  "CheckCancel",
]);

const transactionTypes: Partial<Record<HarborOpName, string>> = {
  "tx.swap": "OfferCreate",
  "tx.offer": "OfferCreate",
  "tx.offerCancel": "OfferCancel",
  "tx.payment": "Payment",
  "tx.trustSet": "TrustSet",
  "tx.ammDeposit": "AMMDeposit",
  "tx.ammWithdraw": "AMMWithdraw",
  "tx.vaultDeposit": "VaultDeposit",
  "tx.vaultWithdraw": "VaultWithdraw",
  "tx.escrowCreate": "EscrowCreate",
  "tx.escrowFinish": "EscrowFinish",
  "tx.escrowCancel": "EscrowCancel",
  "tx.checkCreate": "CheckCreate",
  "tx.checkCash": "CheckCash",
  "tx.checkCancel": "CheckCancel",
};

const nonDelegableTypes = new Set([
  "Payment",
  "EscrowCreate",
  "CheckCreate",
  "PaymentChannelCreate",
  "PaymentChannelFund",
  "NFTokenCreateOffer",
  "PaymentBurn",
  "PaymentMint",
  "VaultDeposit",
  "VaultWithdraw",
  "AccountSet",
  "SetRegularKey",
  "SignerListSet",
  "DelegateSet",
  "AccountDelete",
  "Batch",
]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function currencyAmount(value: unknown): MockCurrencyAmount {
  if (typeof value === "string") return value;
  if (
    value && typeof value === "object" && !Array.isArray(value) &&
    typeof (value as JsonRecord).currency === "string" &&
    typeof (value as JsonRecord).issuer === "string" &&
    typeof (value as JsonRecord).value === "string"
  ) {
    return value as MockCurrencyAmount;
  }
  throw new Error("Mock transaction amount is malformed");
}

function amountValue(value: MockCurrencyAmount): string {
  return typeof value === "string" ? String(Number(value) / 1_000_000) : value.value;
}

function amountAsset(value: MockCurrencyAmount): Asset {
  return typeof value === "string"
    ? { currency: "XRP" }
    : { currency: value.currency, issuer: value.issuer };
}

function fixtureEnvelope(key: string): Envelope<unknown> {
  const fixture = fixtures[key];
  if (fixture === undefined) throw new Error(`Missing Harbor mock fixture for ${key}`);
  const envelope = GenericEnvelopeSchema.parse(clone(fixture));
  if (!envelope.ok) return envelope;

  const op = key.startsWith("tx.execute.") ? "tx.execute" : key;
  switch (op) {
    case "venues.list":
      VenueSchema.array().parse(envelope.data);
      break;
    case "venues.get":
      VenueSchema.parse(envelope.data);
      break;
    case "account.link":
    case "account.status":
    case "account.revoke":
      AccountLinkSchema.parse(envelope.data);
      break;
    case "onboarding.readiness":
      OnboardingReadinessResultSchema.parse(envelope.data);
      break;
    case "policy.get":
    case "policy.set":
      PolicySchema.parse(envelope.data);
      break;
    case "merchants.list":
      MerchantSchema.array().parse(envelope.data);
      break;
    case "merchants.get":
      MerchantSchema.parse(envelope.data);
      break;
    case "mandate.prepare":
      MandatePrepareResultSchema.parse(envelope.data);
      break;
    case "mandate.register":
    case "mandate.status":
    case "mandate.revoke":
      MandateSchema.parse(envelope.data);
      break;
    case "credential.status":
      CredentialStatusResultSchema.parse(envelope.data);
      break;
    case "credential.payerAccept":
      CredentialPayerAcceptResultSchema.parse(envelope.data);
      break;
    case "credential.ids":
      CredentialIdsResultSchema.parse(envelope.data);
      break;
    case "ap4m.purchase": {
      const purchase = z
        .object({
          receipt: Ap4mReceiptSchema,
          data: z.record(z.string(), z.unknown()),
        })
        .strict()
        .parse(envelope.data);
      void purchase;
      break;
    }
    case "channel.status":
      ChannelStatusResultSchema.parse(envelope.data);
      break;
    case "channel.list":
      ChannelStatusResultSchema.array().parse(envelope.data);
      break;
    case "mastercard.services":
      MastercardServicesResultSchema.parse(envelope.data);
      break;
    case "mastercard.docs":
      MastercardDocsResultSchema.parse(envelope.data);
      break;
    case "mastercard.page":
      MastercardPageResultSchema.parse(envelope.data);
      break;
    case "mastercard.search":
      MastercardSearchResultSchema.parse(envelope.data);
      break;
    case "lending.brokers":
      HarborResultSchemas["lending.brokers"].parse(envelope.data);
      break;
    case "vault.positions":
      HarborResultSchemas["vault.positions"].parse(envelope.data);
      break;
    case "tx.execute":
      ExecResultSchema.parse(envelope.data);
      break;
    case "x402.pay":
      X402PayResultSchema.parse(envelope.data);
      break;
    default:
      if (builderOperations.has(op as HarborOpName)) TxBuildSchema.parse(envelope.data);
  }
  return envelope;
}

function errorEnvelope(code: string, message: string): Err {
  return { ok: false, error: { service: "harbor-mock", kind: "error", code, message } };
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function containsForbiddenMaterial(value: unknown): boolean {
  if (typeof value === "string") return FORBIDDEN_ARGUMENT.test(value);
  if (Array.isArray(value)) return value.some(containsForbiddenMaterial);
  const record = asRecord(value);
  if (!record) return false;
  return Object.entries(record).some(
    ([key, child]) => FORBIDDEN_ARGUMENT.test(key) || containsForbiddenMaterial(child),
  );
}

function validationMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "args"}: ${issue.message}`)
    .join("; ");
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replaceAll(",", ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  const record = asRecord(value);
  return record ? numericValue(record.value) : undefined;
}

function amountUsd(name: HarborOpName, args: JsonRecord, fallback: TxBuild): number {
  if (nativeBuilderOperations.has(name)) {
    const amount = args.amount ?? args.send_max ?? args.deliver_min;
    if (typeof amount === "string" && /^\d+$/.test(amount)) {
      return Number(amount) / 1_000_000 * MOCK_XRP_USD;
    }
    const issuedValue = numericValue(amount);
    if (issuedValue !== undefined) return Math.abs(issuedValue);
    return Math.abs(numericValue(fallback.summary.usd_value) ?? 0);
  }
  for (const key of ["usd_value", "amount", "sell_amount", "buy_amount", "amount2"]) {
    const amount = numericValue(args[key]);
    if (amount !== undefined) return Math.abs(amount);
  }
  return Math.abs(numericValue(fallback.summary.usd_value) ?? 0);
}

function asset(value: unknown): Asset | undefined {
  const record = asRecord(value);
  return record && typeof record.currency === "string"
    ? {
        currency: record.currency,
        ...(typeof record.issuer === "string" ? { issuer: record.issuer } : {}),
      }
    : undefined;
}

function assetsFromArgs(args: JsonRecord): Asset[] {
  return [args.sell, args.buy, args.asset, args.asset2]
    .map(asset)
    .filter((entry): entry is Asset => entry !== undefined);
}

function isUnknownAsset(candidate: Asset): boolean {
  const currency = candidate.currency.toUpperCase();
  if (currency === "XRP") return candidate.issuer !== undefined;
  return !candidate.issuer || !KNOWN_ISSUERS.has(candidate.issuer);
}

function containsUnknownIssuer(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsUnknownIssuer);
  const record = asRecord(value);
  if (!record) return false;
  const candidate = asset(record);
  if (candidate && isUnknownAsset(candidate)) return true;
  return Object.values(record).some(containsUnknownIssuer);
}

function toDrops(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  const micros = `${fraction}000000`.slice(0, 6);
  return (BigInt(whole) * 1_000_000n + BigInt(micros)).toString();
}

function ledgerAmount(candidate: Asset, value: string): unknown {
  return candidate.currency.toUpperCase() === "XRP"
    ? toDrops(value)
    : { currency: candidate.currency, issuer: candidate.issuer ?? "", value };
}

function assetDescriptor(candidate: Asset): JsonRecord {
  return {
    currency: candidate.currency,
    ...(candidate.issuer ? { issuer: candidate.issuer } : {}),
  };
}

function hex(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("").toUpperCase();
}

function stripSigningFields(txJson: JsonRecord): JsonRecord {
  const unsigned = clone(txJson);
  delete unsigned.SigningPubKey;
  delete unsigned.TxnSignature;
  delete unsigned.Signers;
  return unsigned;
}

function rippleTime(iso: string): number {
  return Math.floor(Date.parse(iso) / 1_000) - 946_684_800;
}

function isDelegable(transactionType: string): boolean {
  return (
    !nonDelegableTypes.has(transactionType) &&
    !transactionType.startsWith("Vault") &&
    !transactionType.startsWith("Loan")
  );
}

function displayAsset(candidate: Asset): string {
  return candidate.issuer ? `${candidate.currency}:${candidate.issuer}` : candidate.currency;
}

function nativeAmountLabel(amount: MockCurrencyAmount): string {
  return typeof amount === "string"
    ? `${amount} drops XRP`
    : `${amount.value} ${displayAsset(amountAsset(amount))}`;
}

function mockUsdRate(candidate: Asset): number {
  return candidate.currency.toUpperCase() === "XRP" ? MOCK_XRP_USD : 1;
}

function decimalAmount(value: number): string {
  return value
    .toFixed(12)
    .replace(/(?:\.0+|(?<fraction>\.\d*?[1-9])0+)$/, "$<fraction>");
}

function transactionDetails(
  name: HarborOpName,
  args: JsonRecord,
  fixtureTx: JsonRecord,
): { txJson: JsonRecord; action: string; amounts: string[]; assets: Asset[] } {
  const account = String(args.account);
  const intentId = typeof args.intent_id === "string" ? args.intent_id : undefined;
  const base: JsonRecord = {
    ...stripSigningFields(fixtureTx),
    Account: account,
    ...(intentId
      ? {
          Memos: [{ Memo: { MemoType: hex("pilot/intent"), MemoData: hex(intentId) } }],
        }
      : {}),
  };
  if (nativeBuilderOperations.has(name) && intentId === undefined) {
    delete base.Memos;
  }

  switch (name) {
    case "tx.swap": {
      const sell = asset(args.sell)!;
      const buy = asset(args.buy)!;
      const requestedAmount = currencyAmount(args.amount);
      const amount = amountValue(requestedAmount);
      const side = args.side === "buy" ? "buy" : "sell";
      const executionMode = args.execution_mode === "fill_or_kill"
        ? "fill_or_kill"
        : "immediate_or_cancel";
      const numericAmount = Number(amount);
      const slippage = Number(args.max_slippage_bps) / 10_000;
      const baseSellPerBuy = mockUsdRate(buy) / mockUsdRate(sell);
      const sellAmount =
        side === "sell"
          ? numericAmount
          : numericAmount * baseSellPerBuy * (1 + slippage);
      const buyAmount =
        side === "buy"
          ? numericAmount
          : numericAmount / baseSellPerBuy / (1 + slippage);

      // TakerGets is sold, TakerPays is bought, the selected immediate mode
      // prevents a resting order, and tfSell fixes the full TakerGets amount.
      // https://xrpl.org/docs/references/protocol/transactions/types/offercreate
      return {
        txJson: {
          ...base,
          TransactionType: "OfferCreate",
          TakerGets: ledgerAmount(sell, decimalAmount(sellAmount)),
          TakerPays: ledgerAmount(buy, decimalAmount(buyAmount)),
          Flags:
            (executionMode === "fill_or_kill" ? TF_FILL_OR_KILL : TF_IMMEDIATE_OR_CANCEL) |
            (side === "sell" ? TF_SELL : 0),
        },
        action:
          side === "sell"
            ? `Sell ${amount} ${displayAsset(sell)} for at least ${decimalAmount(buyAmount)} ${displayAsset(buy)}`
            : `Buy ${amount} ${displayAsset(buy)} for at most ${decimalAmount(sellAmount)} ${displayAsset(sell)}`,
        amounts: [
          `${decimalAmount(sellAmount)} ${displayAsset(sell)}`,
          `${decimalAmount(buyAmount)} ${displayAsset(buy)}`,
        ],
        assets: [sell, buy],
      };
    }
    case "tx.offer": {
      // https://xrpl.org/docs/references/protocol/transactions/types/offercreate
      const sell = asset(args.sell)!;
      const buy = asset(args.buy)!;
      const sellAmount = String(args.sell_amount);
      const buyAmount = String(args.buy_amount);
      return {
        txJson: {
          ...base,
          TransactionType: "OfferCreate",
          TakerGets: ledgerAmount(sell, sellAmount),
          TakerPays: ledgerAmount(buy, buyAmount),
          ...(typeof args.expires_at === "string"
            ? { Expiration: rippleTime(args.expires_at) }
            : {}),
        },
        action: `Offer ${sellAmount} ${displayAsset(sell)} for ${buyAmount} ${displayAsset(buy)}`,
        amounts: [
          `${sellAmount} ${displayAsset(sell)}`,
          `${buyAmount} ${displayAsset(buy)}`,
        ],
        assets: [sell, buy],
      };
    }
    case "tx.offerCancel":
      // https://xrpl.org/docs/references/protocol/transactions/types/offercancel
      return {
        txJson: {
          ...base,
          TransactionType: "OfferCancel",
          OfferSequence: args.offer_sequence,
        },
        action: `Cancel offer ${String(args.offer_sequence)}`,
        amounts: [],
        assets: [],
      };
    case "tx.payment": {
      // https://xrpl.org/docs/references/protocol/transactions/types/payment
      const paymentAsset = asset(args.asset)!;
      const amount = String(args.amount);
      return {
        txJson: {
          ...base,
          TransactionType: "Payment",
          Destination: args.to,
          Amount: ledgerAmount(paymentAsset, amount),
        },
        action: `Pay ${amount} ${displayAsset(paymentAsset)} to ${String(args.to)}`,
        amounts: [`${amount} ${displayAsset(paymentAsset)}`],
        assets: [paymentAsset],
      };
    }
    case "tx.trustSet": {
      // https://xrpl.org/docs/references/protocol/transactions/types/trustset
      const limitAmount = currencyAmount(args.limit_amount);
      if (typeof limitAmount === "string") throw new Error("TrustSet requires an issued limit");
      const trustAsset = amountAsset(limitAmount);
      const limit = limitAmount.value;
      return {
        txJson: {
          ...base,
          TransactionType: "TrustSet",
          LimitAmount: limitAmount,
        },
        action: `Set ${displayAsset(trustAsset)} trust limit`,
        amounts: [`${limit} ${displayAsset(trustAsset)}`],
        assets: [trustAsset],
      };
    }
    case "tx.ammDeposit":
    case "tx.ammWithdraw": {
      // https://xrpl.org/docs/references/protocol/transactions/types/ammdeposit
      // https://xrpl.org/docs/references/protocol/transactions/types/ammwithdraw
      const first = asset(args.asset)!;
      const second = asset(args.asset2)!;
      const amount = args.amount === undefined ? undefined : currencyAmount(args.amount);
      const amount2 = args.amount2 === undefined ? undefined : currencyAmount(args.amount2);
      const txJson: JsonRecord = {
        ...base,
        TransactionType: transactionTypes[name],
        Asset: assetDescriptor(first),
        Asset2: assetDescriptor(second),
        ...(amount === undefined ? {} : { Amount: amount }),
        Flags: args.flags,
      };
      delete txJson.LPTokenIn;
      if (amount2) txJson.Amount2 = amount2;
      else delete txJson.Amount2;
      return {
        txJson,
        action: `${name === "tx.ammDeposit" ? "Deposit to" : "Withdraw from"} ${displayAsset(first)}/${displayAsset(second)} AMM`,
        amounts: [
          ...(amount ? [`${amountValue(amount)} ${displayAsset(first)}`] : []),
          ...(amount2 ? [`${amountValue(amount2)} ${displayAsset(second)}`] : []),
        ],
        assets: [first, second],
      };
    }
    case "tx.vaultDeposit":
    case "tx.vaultWithdraw": {
      // https://xrpl.org/docs/references/protocol/transactions/types/vaultdeposit
      // https://xrpl.org/docs/references/protocol/transactions/types/vaultwithdraw
      const amount = currencyAmount(args.amount);
      const vaultAsset = amountAsset(amount);
      return {
        txJson: {
          ...base,
          TransactionType: transactionTypes[name],
          VaultID: args.vault_id,
          Amount: amount,
        },
        action: `${name === "tx.vaultDeposit" ? "Deposit to" : "Withdraw from"} vault ${String(args.vault_id)}`,
        amounts: [`${amountValue(amount)} ${displayAsset(vaultAsset)}`],
        assets: [vaultAsset],
      };
    }
    case "tx.escrowCreate": {
      const amount = currencyAmount(args.amount);
      const txJson: JsonRecord = {
        ...base,
        TransactionType: "EscrowCreate",
        Destination: args.destination,
        Amount: amount,
      };
      delete txJson.CancelAfter;
      delete txJson.FinishAfter;
      delete txJson.Condition;
      delete txJson.DestinationTag;
      if (args.cancel_after !== undefined) txJson.CancelAfter = args.cancel_after;
      if (args.finish_after !== undefined) txJson.FinishAfter = args.finish_after;
      if (args.condition !== undefined) txJson.Condition = args.condition;
      if (args.destination_tag !== undefined) txJson.DestinationTag = args.destination_tag;
      return {
        txJson,
        action: `Create escrow for ${nativeAmountLabel(amount)}`,
        amounts: [nativeAmountLabel(amount)],
        assets: [amountAsset(amount)],
      };
    }
    case "tx.escrowFinish": {
      const txJson: JsonRecord = {
        ...base,
        TransactionType: "EscrowFinish",
        Owner: args.owner,
        OfferSequence: args.offer_sequence,
        Fee: typeof args.fulfillment === "string"
          ? String(Math.ceil(12 * (33 + args.fulfillment.length / 2 / 16)))
          : "12",
      };
      delete txJson.Condition;
      delete txJson.Fulfillment;
      if (args.condition !== undefined) txJson.Condition = args.condition;
      if (args.fulfillment !== undefined) txJson.Fulfillment = args.fulfillment;
      return {
        txJson,
        action: `Finish escrow ${String(args.offer_sequence)}`,
        amounts: [],
        assets: [],
      };
    }
    case "tx.escrowCancel":
      return {
        txJson: {
          ...base,
          TransactionType: "EscrowCancel",
          Owner: args.owner,
          OfferSequence: args.offer_sequence,
        },
        action: `Cancel escrow ${String(args.offer_sequence)}`,
        amounts: [],
        assets: [],
      };
    case "tx.checkCreate": {
      const sendMax = currencyAmount(args.send_max);
      const txJson: JsonRecord = {
        ...base,
        TransactionType: "CheckCreate",
        Destination: args.destination,
        SendMax: sendMax,
      };
      delete txJson.DestinationTag;
      delete txJson.Expiration;
      delete txJson.InvoiceID;
      if (args.destination_tag !== undefined) txJson.DestinationTag = args.destination_tag;
      if (args.expiration !== undefined) txJson.Expiration = args.expiration;
      if (args.invoice_id !== undefined) txJson.InvoiceID = args.invoice_id;
      return {
        txJson,
        action: `Create Check for ${nativeAmountLabel(sendMax)}`,
        amounts: [nativeAmountLabel(sendMax)],
        assets: [amountAsset(sendMax)],
      };
    }
    case "tx.checkCash": {
      const amount = currencyAmount(args.amount ?? args.deliver_min);
      const txJson: JsonRecord = {
        ...base,
        TransactionType: "CheckCash",
        CheckID: args.check_id,
      };
      delete txJson.Amount;
      delete txJson.DeliverMin;
      if (args.amount !== undefined) txJson.Amount = amount;
      if (args.deliver_min !== undefined) txJson.DeliverMin = amount;
      return {
        txJson,
        action: "Cash Check",
        amounts: [nativeAmountLabel(amount)],
        assets: [amountAsset(amount)],
      };
    }
    case "tx.checkCancel":
      return {
        txJson: {
          ...base,
          TransactionType: "CheckCancel",
          CheckID: args.check_id,
        },
        action: "Cancel Check",
        amounts: [],
        assets: [],
      };
    case "tx.simulate": {
      const requested = stripSigningFields(asRecord(args.tx_json) ?? {});
      return {
        txJson: { ...base, ...requested, Account: account },
        action: `Simulate ${String(requested.TransactionType ?? "transaction")}`,
        amounts: [],
        assets: [],
      };
    }
    default:
      return { txJson: base, action: name, amounts: [], assets: assetsFromArgs(args) };
  }
}

function withEnvelopeData<T>(template: Envelope<unknown>, data: T): Envelope<T> {
  return template.ok ? ({ ...template, data } as Envelope<T>) : template;
}

function withMockEnvelopeData<T>(
  template: Envelope<unknown>,
  data: T,
  asOfBasis: string,
): Envelope<T> {
  return template.ok ? ({ ...template, data, asOfBasis } as Envelope<T>) : template;
}

function mockMemo(): JsonRecord {
  return {
    Memo: {
      MemoType: MOCK_AP4M_L2_MEMO_TYPE,
      MemoData: "0".repeat(64),
    },
  };
}

function mockObjectId(sequence: number, index: number): string {
  return (sequence * 256 + index).toString(16).toUpperCase().padStart(64, "0");
}

function mockDigest(value: string): string {
  let state = 0x811c9dc5;
  for (const character of value) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 0x01000193) >>> 0;
  }
  return state.toString(16).padStart(8, "0").repeat(8);
}

function scopedKey(owner: string, network: Network): string {
  return `${owner}:${network}`;
}

function policyReason(
  rule: string,
  pass: boolean,
  detail: string,
): PolicyResult["reasons"][number] {
  return { rule, pass, detail };
}

/** A stateful, fixture-backed Harbor implementation used by both REST and MCP. */
export class MockHarborClient implements HarborClient {
  private buildSequence = 0;
  private mandateSequence = 0;
  private readonly builds = new Map<string, StoredBuild>();
  private readonly idempotentExecutions = new Map<
    string,
    { buildId: string; requireOwnerApproval: boolean; result: Envelope<ExecResult> }
  >();
  private readonly links = new Map<string, AccountLink>();
  private readonly policies = new Map<string, Policy>();
  private readonly x402Payments = new Map<
    string,
    { args: ArgsFor<"x402.pay">; result: Envelope<X402PayResult> }
  >();
  private readonly preparedMandates = new Map<string, StoredMockMandate>();

  constructor() {
    for (const operation of builderOperations) {
      const envelope = fixtureEnvelope(operation);
      if (!envelope.ok) continue;
      const build = TxBuildSchema.parse(envelope.data);
      this.builds.set(build.build_id, {
        build,
        amountUsd: amountUsd(operation, {}, build),
        assets: [],
        hasUnknownIssuer: containsUnknownIssuer(build.tx_json),
      });
    }

    const linkEnvelope = fixtureEnvelope("account.status");
    if (linkEnvelope.ok) {
      const link = AccountLinkSchema.parse(linkEnvelope.data);
      this.links.set(scopedKey(link.owner, link.network), link);
    }
    const policyEnvelope = fixtureEnvelope("policy.get");
    if (policyEnvelope.ok && linkEnvelope.ok) {
      const link = AccountLinkSchema.parse(linkEnvelope.data);
      this.policies.set(
        scopedKey(link.owner, link.network),
        PolicySchema.parse(policyEnvelope.data),
      );
    }
  }

  async op<K extends HarborOpName>(
    name: K,
    args: ArgsFor<K>,
  ): Promise<Envelope<ResultFor<K>>> {
    if (containsForbiddenMaterial(args)) {
      return errorEnvelope(
        "FORBIDDEN_ARGUMENT",
        "Harbor arguments cannot contain seed, secret, private, or mnemonic material.",
      );
    }
    const validation = HarborArgsSchemas[name].safeParse(args);
    if (!validation.success) {
      return errorEnvelope(
        "INVALID_ARGUMENT",
        `Invalid arguments for ${name}: ${validationMessage(validation.error)}`,
      );
    }
    const validArgs = validation.data as ArgsFor<K>;

    if (name === "venues.get") {
      return this.venue(validArgs as ArgsFor<"venues.get">) as Envelope<ResultFor<K>>;
    }
    if (name.startsWith("ledger.account.")) {
      return this.accountRead(name, validArgs as { account: string }) as Envelope<ResultFor<K>>;
    }
    if (name === "account.link") {
      return this.link(validArgs as ArgsFor<"account.link">) as Envelope<ResultFor<K>>;
    }
    if (name === "account.status") {
      return this.status(validArgs as ArgsFor<"account.status">) as Envelope<ResultFor<K>>;
    }
    if (name === "account.revoke") {
      return this.revoke(validArgs as ArgsFor<"account.revoke">) as Envelope<ResultFor<K>>;
    }
    if (name === "policy.set") {
      return this.setPolicy(validArgs as ArgsFor<"policy.set">) as Envelope<ResultFor<K>>;
    }
    if (name === "policy.get") {
      return this.getPolicy(validArgs as ArgsFor<"policy.get">) as Envelope<ResultFor<K>>;
    }
    if (name === "mandate.prepare") {
      return this.prepareMandate(
        validArgs as ArgsFor<"mandate.prepare">,
      ) as Envelope<ResultFor<K>>;
    }
    if (name === "mandate.register") {
      return this.registerMandate(
        validArgs as ArgsFor<"mandate.register">,
      ) as Envelope<ResultFor<K>>;
    }
    if (builderOperations.has(name)) {
      if ((validArgs as { execution_contract?: string }).execution_contract === "xrpl_execution_v2") {
        return errorEnvelope(
          "EXECUTION_CONTRACT_UNSUPPORTED",
          "Mock Harbor does not fabricate v2 execution capability evidence.",
        );
      }
      if ((validArgs as { network: Network }).network === "mainnet") {
        return errorEnvelope(
          "MAINNET_EXECUTION_DISABLED",
          "Mock Harbor never builds mainnet transactions.",
        );
      }
      return this.build(name, validArgs as JsonRecord) as Envelope<ResultFor<K>>;
    }
    if (name === "tx.execute") {
      if ((validArgs as { execution_contract?: string }).execution_contract === "xrpl_execution_v2") {
        return errorEnvelope(
          "EXECUTION_CONTRACT_UNSUPPORTED",
          "Mock Harbor does not fabricate v2 execution snapshot evidence.",
        );
      }
      return this.execute(validArgs as ArgsFor<"tx.execute">) as Envelope<ResultFor<K>>;
    }
    if (name === "tx.approvalPreflight") {
      return errorEnvelope(
        "EXECUTION_CONTRACT_UNSUPPORTED",
        "Mock Harbor does not fabricate durable v2 approval preflight evidence.",
      );
    }
    if (name === "tx.approvalReconcile") {
      return errorEnvelope(
        "EXECUTION_CONTRACT_UNSUPPORTED",
        "Mock Harbor does not fabricate atomic v2 approval recovery evidence.",
      );
    }
    if (
      name === "tx.submit" &&
      (validArgs as { execution_contract?: string }).execution_contract === "xrpl_execution_v2"
    ) {
      return errorEnvelope(
        "APPROVAL_PREFLIGHT_REQUIRED",
        "Mock Harbor cannot establish the durable v2 preflight and relay claim.",
      );
    }
    if (name === "x402.pay") {
      return this.x402Pay(validArgs as ArgsFor<"x402.pay">) as Envelope<ResultFor<K>>;
    }
    if (name.startsWith("strategy.")) {
      return this.strategy(name, validArgs as JsonRecord) as Envelope<ResultFor<K>>;
    }
    return fixtureEnvelope(name) as Envelope<ResultFor<K>>;
  }

  private strategy(name: HarborOpName, args: JsonRecord): Envelope<unknown> {
    const now = "2026-10-22T00:00:00.000Z";
    const owner = String(args.account ?? args.owner);
    const strategyId = String(args.strategy_id ?? "strategy-mock-001");
    const digest = "C100000000000000000000000000000000000000000000000000000000000002";
    const mandateExpiresAt = String(args.expires_at ?? "2026-10-29T00:00:00.000Z");
    const authorized = ["strategy.authorize", "strategy.pause", "strategy.resume", "strategy.stop", "strategy.kill"].includes(name);
    const lifecycle: Strategy["lifecycle"] = name === "strategy.authorize" || name === "strategy.resume"
      ? "active" : name === "strategy.pause" ? "paused" : name === "strategy.stop" || name === "strategy.kill"
        ? "stopped" : "draft";
    const authorization = authorized ? (args.authorization ?? {
      authorization_id: `authorization-${strategyId}`,
      method: "wallet_action_proof_v1",
      owner,
      mandate_digest: digest,
      mandate_version: 1,
      approved_at: now,
      expires_at: mandateExpiresAt,
    }) as Strategy["mandate"]["authorization"] : undefined;
    const strategy: Strategy = {
      strategy_id: strategyId,
      lifecycle,
      mandate: {
        mandate_id: `mandate-${strategyId}`,
        strategy_id: strategyId,
        version: Number(args.mandate_version ?? 1),
        digest: String(args.mandate_digest ?? digest),
        status: authorized ? "approved" : "draft",
        kind: "xrp_issued_rebalancer_v1",
        network: "testnet",
        account: owner,
        issued_asset: (args.issued_asset as Strategy["mandate"]["issued_asset"] | undefined) ?? {
          currency: "524C555344000000000000000000000000000000",
          issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
        },
        allocation: (args.allocation as Strategy["mandate"]["allocation"] | undefined) ?? {
          target_xrp_bps: 5_000, lower_xrp_bps: 4_500, upper_xrp_bps: 5_500,
        },
        limits: (args.limits as Strategy["mandate"]["limits"] | undefined) ?? {
          max_order_value: "10", max_daily_value: "25", min_order_value: "1",
          max_fee_drops: "20", max_slippage_bps: 100, max_price_impact_bps: 100,
          min_xrp_reserve_drops: "12000000", fee_buffer_drops: "1000000",
          max_xrp_exposure_drops: "100000000", max_issued_exposure: "100",
          min_liquidity_value: "25", cooldown_seconds: 300,
          max_quote_age_seconds: 30, max_ledger_gap: 2,
        },
        schedule: { interval_seconds: Number(args.interval_seconds ?? 300), next_evaluation_at: now },
        execution_mode: "offer_create_fok",
        not_before: String(args.not_before ?? now),
        expires_at: mandateExpiresAt,
        ...(authorization ? { authorization } : {}),
      },
      generation: authorized ? 1 : 0,
      ...(lifecycle === "active" ? { next_evaluation_at: now } : {}),
      created_at: now,
      updated_at: now,
    };
    const event: StrategyAuditEvent = {
      event_id: "event-strategy-mock-001", strategy_id: strategyId,
      actor: "owner", kind: "created", detail: { source: "offline-mock" }, at: now,
    };
    const killSwitch: StrategyKillSwitch = {
      enabled: Boolean(args.enabled),
      ...(args.reason ? { reason: String(args.reason) } : {}),
      updated_at: now,
    };
    const data = name === "strategy.list" ? [strategy]
      : name === "strategy.audit" ? [event]
        : name === "strategy.globalKill.get" || name === "strategy.globalKill.set" ? killSwitch
          : strategy;
    return {
      ok: true,
      data,
      asOf: now,
      asOfBasis: "offline deterministic strategy mock",
    } as Envelope<unknown>;
  }

  private x402Pay(args: ArgsFor<"x402.pay">): Envelope<X402PayResult> {
    const existing = this.x402Payments.get(args.idempotency_key);
    if (existing) {
      if (JSON.stringify(existing.args) !== JSON.stringify(args)) {
        return errorEnvelope(
          "X402_IDEMPOTENCY_MISMATCH",
          "The x402 idempotency key is already bound to different arguments",
        );
      }
      return clone(existing.result);
    }
    const template = fixtureEnvelope("x402.pay");
    if (!template.ok) return template;
    const fixture = X402PayResultSchema.parse(template.data);
    const result = X402PayResultSchema.parse({
      ...fixture,
      idempotency_key: args.idempotency_key,
      network: args.network,
      ...(fixture.status === "delivered"
        ? { owner: args.owner, resource: args.resource }
        : {}),
    });
    const envelope = withEnvelopeData(template, result);
    this.x402Payments.set(args.idempotency_key, {
      args: clone(args),
      result: clone(envelope),
    });
    return envelope;
  }

  private prepareMandate(
    args: ArgsFor<"mandate.prepare">,
  ): Envelope<ResultFor<"mandate.prepare">> {
    const template = fixtureEnvelope("mandate.prepare");
    if (!template.ok) return template;
    const fixture = MandatePrepareResultSchema.parse(template.data);
    const merchantEnvelope = fixtureEnvelope("merchants.list");
    if (!merchantEnvelope.ok) return merchantEnvelope;
    const merchants = MerchantSchema.array().parse(merchantEnvelope.data);
    const byId = new Map(merchants.map((merchant) => [merchant.id, merchant]));
    const requested = args.payees.map((id) => byId.get(id));
    const missingIndex = requested.findIndex((merchant) => merchant === undefined);
    if (missingIndex !== -1) {
      return errorEnvelope(
        "MERCHANT_NOT_FOUND",
        `No mock AP4M merchant exists for ${args.payees[missingIndex]}`,
      );
    }
    const requiredCredential = requested[0]!.required_credential;
    if (
      requested.some(
        (merchant) =>
          merchant!.required_credential.issuer !== requiredCredential.issuer ||
          merchant!.required_credential.credential_type_hex !==
            requiredCredential.credential_type_hex,
      )
    ) {
      return errorEnvelope(
        "CREDENTIAL_MISMATCH",
        "Mock AP4M setup requires selected merchants to share one credential.",
      );
    }

    this.mandateSequence += 1;
    const sequence = this.mandateSequence;
    const mandateId = `mandate-demo-${String(sequence).padStart(3, "0")}`;
    const ledgerSequence = 10_000_000 + sequence * 100;
    const transactionSequence = 100 + sequence * 10;
    const amountDrops = toDrops(args.constraints.total_max);
    const claimPublicKeys = args.payees.map((merchantId, index) => ({
      merchant_id: merchantId,
      public_key:
        fixture.claim_public_keys.find((key) => key.merchant_id === merchantId)
          ?.public_key ?? fixture.claim_public_keys[index % fixture.claim_public_keys.length]!.public_key,
    }));
    const credential: JsonRecord = {
      Account: args.owner,
      CredentialType: requiredCredential.credential_type_hex,
      Issuer: requiredCredential.issuer,
      TransactionType: "CredentialAccept",
    };
    const channels = requested.map((merchant, index): JsonRecord => ({
      Account: args.owner,
      Amount: amountDrops,
      CancelAfter: rippleTime(args.expires_at) + 86_400,
      Destination: merchant!.xrpl_address,
      PublicKey: claimPublicKeys[index]!.public_key,
      SettleDelay: 3_600,
      TransactionType: "PaymentChannelCreate",
    }));
    const sequential = [credential, ...channels].map((transaction, index) => ({
      ...transaction,
      Fee: "12",
      LastLedgerSequence: ledgerSequence + index,
      Memos: [mockMemo()],
      Sequence: transactionSequence + index,
    }));
    const inner = [credential, ...channels].map((transaction, index) => ({
      RawTransaction: {
        ...transaction,
        Fee: "0",
        Flags: 0x40000000,
        Sequence: transactionSequence + index + 1,
        SigningPubKey: "",
      },
    }));
    const prepared: ResultFor<"mandate.prepare"> = {
      agent_public_jwk: clone(fixture.agent_public_jwk),
      claim_public_keys: claimPublicKeys,
      mandate_id: mandateId,
      unsigned_batch: {
        Account: args.owner,
        Fee: String(12 * (inner.length + 1)),
        Flags: 0x00010000,
        LastLedgerSequence: ledgerSequence,
        Memos: [mockMemo()],
        RawTransactions: inner,
        Sequence: transactionSequence,
        TransactionType: "Batch",
      },
      unsigned_sequential: sequential,
    };
    this.preparedMandates.set(mandateId, {
      args: clone(args),
      notBefore: "2026-10-21T12:00:00.000Z",
      prepared: clone(prepared),
      sequence,
    });
    while (this.preparedMandates.size > MAX_PREPARED_MANDATES) {
      const oldest = this.preparedMandates.keys().next().value as string | undefined;
      if (!oldest) break;
      this.preparedMandates.delete(oldest);
    }
    return withMockEnvelopeData(
      template,
      prepared,
      "mock mandate preparation; deterministic unsigned transactions only; nothing submitted",
    );
  }

  private registerMandate(
    args: ArgsFor<"mandate.register">,
  ): Envelope<ResultFor<"mandate.register">> {
    const stored = this.preparedMandates.get(args.mandate_id);
    if (!stored) {
      return errorEnvelope(
        "MANDATE_NOT_FOUND",
        "No matching prepared mock mandate exists.",
      );
    }
    const setupHashes = Array.isArray(args.setup_tx_hash)
      ? args.setup_tx_hash
      : [args.setup_tx_hash];
    const validHashes = setupHashes.every((hash) => /^[A-Fa-f0-9]{64}$/.test(hash));
    const expectedSequentialCount = stored.prepared.unsigned_sequential?.length ?? 0;
    const validBatchEvidence =
      typeof args.setup_tx_hash === "string" && setupHashes.length === 1;
    const validSequentialEvidence =
      Array.isArray(args.setup_tx_hash) &&
      expectedSequentialCount > 0 &&
      setupHashes.length === expectedSequentialCount;
    if (!validHashes || (!validBatchEvidence && !validSequentialEvidence)) {
      return errorEnvelope(
        "MANDATE_SETUP_MISMATCH",
        "Mock setup evidence does not match the prepared Batch or ordered sequential set.",
      );
    }

    const template = fixtureEnvelope("mandate.register");
    if (!template.ok) return template;
    const fixture = MandateSchema.parse(template.data);
    const amountDrops = toDrops(stored.args.constraints.total_max);
    const mandate = MandateSchema.parse({
      ...fixture,
      agent_public_jwk: clone(stored.prepared.agent_public_jwk),
      channels: stored.args.payees.map((merchantId, index) => ({
        amount_drops: amountDrops,
        channel_id: mockObjectId(stored.sequence, index + 1),
        merchant_id: merchantId,
      })),
      constraints: clone(stored.args.constraints),
      expires_at: stored.args.expires_at,
      id: args.mandate_id,
      l1_digest: mockDigest(args.l1),
      l2_digest: mockDigest(args.l2),
      network: "testnet",
      not_before: stored.notBefore,
      owner: stored.args.owner,
      setup_batch_hash: setupHashes.join(","),
      spent_usd: "0",
      status: "ACTIVE",
    } satisfies Mandate);
    this.preparedMandates.delete(args.mandate_id);
    return withMockEnvelopeData(
      template,
      mandate,
      "mock mandate registration; setup shape checked in memory; no ledger validation performed",
    );
  }

  private venue(args: ArgsFor<"venues.get">): Envelope<ResultFor<"venues.get">> {
    const template = fixtureEnvelope("venues.get");
    const list = fixtureEnvelope("venues.list");
    if (!list.ok) return list;
    const venue = VenueSchema.array().parse(list.data).find(({ id }) => id === args.id);
    return venue
      ? withEnvelopeData(template, venue)
      : errorEnvelope("VENUE_NOT_FOUND", `No mock venue exists for ${args.id}`);
  }

  private accountRead(name: HarborOpName, args: { account: string }): Envelope<unknown> {
    const template = fixtureEnvelope(name);
    if (!template.ok) return template;
    const data = asRecord(template.data);
    if (!data) return template;

    const accountData = asRecord(data.account_data);
    return withEnvelopeData(template, {
      ...data,
      account: args.account,
      ...(accountData
        ? { account_data: { ...accountData, Account: args.account } }
        : {}),
    });
  }

  private link(args: ArgsFor<"account.link">): Envelope<AccountLink> {
    const forbiddenPermission = args.permissions?.find(
      (permission) => !isDelegable(permission),
    );
    if (forbiddenPermission) {
      return errorEnvelope(
        "PERMISSION_NOT_DELEGABLE",
        `${forbiddenPermission} cannot be granted to a delegate.`,
      );
    }
    const template = fixtureEnvelope("account.link");
    if (!template.ok) return template;
    const fixture = AccountLinkSchema.parse(template.data);
    const permissions = args.permissions ?? fixture.permissions;
    // https://xrpl.org/docs/references/protocol/transactions/types/delegateset
    const link = AccountLinkSchema.parse({
      ...fixture,
      owner: args.owner,
      network: args.network,
      permissions,
      status: "pending",
      delegate_set_tx: {
        ...fixture.delegate_set_tx,
        Account: args.owner,
        Permissions: permissions.map((permission) => ({
          Permission: { PermissionValue: permission },
        })),
      },
    });
    this.links.set(scopedKey(args.owner, args.network), link);
    return withEnvelopeData(template, link);
  }

  private status(args: ArgsFor<"account.status">): Envelope<AccountLink> {
    const template = fixtureEnvelope("account.status");
    if (!template.ok) return template;
    const stored = this.links.get(scopedKey(args.owner, args.network));
    if (!stored) {
      return errorEnvelope(
        "LINK_NOT_FOUND",
        `No mock delegation link exists for ${args.owner} on ${args.network}.`,
      );
    }
    const fixture = AccountLinkSchema.parse(template.data);
    const link = AccountLinkSchema.parse({
      ...fixture,
      ...stored,
      owner: args.owner,
      network: args.network,
      status: stored?.status === "revoked" ? "revoked" : "active",
      delegate_set_tx: undefined,
    });
    this.links.set(scopedKey(args.owner, args.network), link);
    return withEnvelopeData(template, link);
  }

  private revoke(args: ArgsFor<"account.revoke">): Envelope<AccountLink> {
    const template = fixtureEnvelope("account.revoke");
    if (!template.ok) return template;
    const stored = this.links.get(scopedKey(args.owner, args.network));
    const fixture = AccountLinkSchema.parse(template.data);
    // https://xrpl.org/docs/references/protocol/transactions/types/delegateset
    const link = AccountLinkSchema.parse({
      ...fixture,
      ...stored,
      owner: args.owner,
      network: args.network,
      permissions: [],
      status: "revoked",
      delegate_set_tx: undefined,
      revoke_tx: { ...fixture.revoke_tx, Account: args.owner, Permissions: [] },
    });
    this.links.set(scopedKey(args.owner, args.network), link);
    return withEnvelopeData(template, link);
  }

  private setPolicy(args: ArgsFor<"policy.set">): Envelope<Policy> {
    if (args.policy.networks.includes("mainnet")) {
      return errorEnvelope(
        "MAINNET_EXECUTION_DISABLED",
        "Mock Harbor policies cannot enable mainnet execution.",
      );
    }
    const template = fixtureEnvelope("policy.set");
    this.policies.set(scopedKey(args.owner, args.network), clone(args.policy));
    return withEnvelopeData(template, args.policy);
  }

  private getPolicy(args: ArgsFor<"policy.get">): Envelope<Policy> {
    const template = fixtureEnvelope("policy.get");
    const stored = this.policies.get(scopedKey(args.owner, args.network));
    return stored ? withEnvelopeData(template, clone(stored)) : (template as Envelope<Policy>);
  }

  private build(name: HarborOpName, args: JsonRecord): Envelope<TxBuild> {
    const template = fixtureEnvelope(name);
    if (!template.ok) return template;

    const fixture = TxBuildSchema.parse(template.data);
    const details = transactionDetails(name, args, fixture.tx_json);
    const transactionType = String(
      details.txJson.TransactionType ?? transactionTypes[name] ?? "Unknown",
    );
    const unknownIssuer = details.assets.some(isUnknownAsset);
    const preflight = fixture.preflight
      .filter(({ check }) => !/issuer|trust_line/.test(check))
      .concat({
        check: "issuer_allowlist",
        pass: !unknownIssuer,
        ...(unknownIssuer
          ? { detail: "The requested issued asset has an unknown issuer." }
          : {}),
      });
    const usdValue = amountUsd(name, args, fixture);
    const link = nativeBuilderOperations.has(name)
      ? this.links.get(scopedKey(String(args.account), args.network as Network))
      : undefined;
    const delegable = nativeBuilderOperations.has(name)
      ? delegableNativeTypes.has(transactionType) &&
        link?.status === "active" &&
        link.permissions.includes(transactionType)
      : isDelegable(transactionType);
    const build = TxBuildSchema.parse({
      ...fixture,
      build_id: `mock-build-${String(++this.buildSequence).padStart(4, "0")}`,
      network: args.network,
      tx_json: details.txJson,
      delegable,
      preflight,
      summary: {
        ...fixture.summary,
        action: details.action,
        account: args.account,
        amounts: details.amounts,
        fee_drops:
          nativeBuilderOperations.has(name) &&
          typeof details.txJson.Fee === "string"
            ? details.txJson.Fee
            : fixture.summary.fee_drops,
        usd_value: String(usdValue),
      },
    });
    this.builds.set(build.build_id, {
      build,
      amountUsd: usdValue,
      assets: details.assets,
      hasUnknownIssuer: unknownIssuer,
      maxSlippageBps:
        typeof args.max_slippage_bps === "number" ? args.max_slippage_bps : undefined,
    });
    return withEnvelopeData(template, build);
  }

  private defaultPolicy(): Policy {
    const envelope = fixtureEnvelope("policy.get");
    if (!envelope.ok) throw new Error(envelope.error.message);
    return PolicySchema.parse(envelope.data);
  }

  private execute(args: ArgsFor<"tx.execute">): Envelope<ExecResult> {
    const existing = this.idempotentExecutions.get(args.idempotency_key);
    if (existing) {
      if (existing.requireOwnerApproval !== (args.require_owner_approval === true)) {
        return errorEnvelope(
          "IDEMPOTENCY_MODE_MISMATCH",
          "The idempotency key belongs to a different owner-approval mode",
        );
      }
      if (args.require_owner_approval === true && existing.buildId !== args.build_id) {
        return errorEnvelope(
          "OWNER_APPROVAL_IDEMPOTENCY_MISMATCH",
          "The owner-approval idempotency key belongs to a different build",
        );
      }
      return clone(existing.result);
    }

    const remember = (result: Envelope<ExecResult>): Envelope<ExecResult> => {
      this.idempotentExecutions.set(args.idempotency_key, {
        buildId: args.build_id,
        requireOwnerApproval: args.require_owner_approval === true,
        result: clone(result),
      });
      return result;
    };

    if (
      args.idempotency_key === "mock-failed" ||
      args.idempotency_key.startsWith("mock-failed:")
    ) {
      const failed = fixtureEnvelope("tx.execute.failed") as Envelope<ExecResult>;
      return clone(remember(failed));
    }

    const stored = this.builds.get(args.build_id);
    if (!stored) {
      return errorEnvelope(
        "BUILD_NOT_FOUND",
        `No mock transaction build exists for ${args.build_id}`,
      );
    }

    const account = stored.build.summary.account;
    const network = stored.build.network;
    const scope = scopedKey(account, network);
    const policy = this.policies.get(scope) ?? this.defaultPolicy();
    const link = this.links.get(scope);
    const transactionType = String(stored.build.tx_json.TransactionType ?? "Unknown");
    const issuerAllowed = stored.assets.every(
      (candidate) =>
        candidate.currency.toUpperCase() === "XRP" ||
        policy.issuer_allowlist.includes(candidate.currency) ||
        (candidate.currency.toUpperCase() === RLUSD_HEX &&
          policy.issuer_allowlist.includes("RLUSD")) ||
        (candidate.issuer !== undefined && policy.issuer_allowlist.includes(candidate.issuer)),
    );
    const networkAllowed = policy.networks.includes(network) && network !== "mainnet";
    const withinMaximum = stored.amountUsd <= policy.max_per_tx_usd;
    const slippageAllowed =
      stored.maxSlippageBps === undefined || stored.maxSlippageBps <= policy.max_slippage_bps;

    const blockReasons = [
      policyReason(
        "network",
        networkAllowed,
        networkAllowed ? `${network} is allowed.` : `${network} execution is blocked.`,
      ),
      policyReason(
        "issuer_allowlist",
        !stored.hasUnknownIssuer && issuerAllowed,
        stored.hasUnknownIssuer
          ? "A requested asset has an unknown issuer."
          : issuerAllowed
            ? "All requested issuers are allowlisted."
            : "A requested issuer is not allowlisted.",
      ),
      policyReason(
        "max_per_tx_usd",
        withinMaximum,
        withinMaximum
          ? `${stored.amountUsd} USD is within the ${policy.max_per_tx_usd} USD maximum.`
          : `${stored.amountUsd} USD exceeds the ${policy.max_per_tx_usd} USD maximum.`,
      ),
      policyReason(
        "max_slippage_bps",
        slippageAllowed,
        slippageAllowed
          ? "Requested slippage is within policy."
          : `Requested slippage exceeds ${policy.max_slippage_bps} bps.`,
      ),
      ...stored.build.preflight
        .filter(({ pass }) => !pass)
        .map(({ check, pass, detail }) =>
          policyReason(`preflight.${check}`, pass, detail ?? `${check} failed.`),
        ),
    ];
    const nativeTransaction = nativeTransactionTypes.has(transactionType);
    const inactiveNativeLinkBlocked =
      nativeTransaction && link?.status !== "active" && link?.status !== "revoked";
    if (nativeTransaction) {
      blockReasons.push(
        policyReason(
          "link_status",
          !inactiveNativeLinkBlocked,
          link === undefined
            ? "Delegation link is missing."
            : `Delegation link is ${link.status}.`,
        ),
      );
    }

    let result: Envelope<ExecResult>;
    if (
      !networkAllowed ||
      stored.hasUnknownIssuer ||
      !issuerAllowed ||
      !withinMaximum ||
      !slippageAllowed ||
      inactiveNativeLinkBlocked
    ) {
      const template = fixtureEnvelope("tx.execute.blocked");
      result = withEnvelopeData(template, {
        status: "blocked",
        policy: { verdict: "block", reasons: blockReasons },
      });
    } else {
      const linkActive = link?.status === "active";
      const permissionGranted = link?.permissions.includes(transactionType) ?? false;
      const typeAllowed = policy.allowed_tx_types.includes(transactionType);
      const underThreshold = stored.amountUsd < policy.execute_under_usd;
      const buildDelegable = nativeTransaction
        ? delegableNativeTypes.has(transactionType) &&
          linkActive &&
          permissionGranted
        : stored.build.delegable;
      const approvalReasons = [
        policyReason(
          "link_active",
          linkActive,
          linkActive ? "Delegation link is active." : "Delegation link is missing or inactive.",
        ),
        policyReason(
          "permission_granted",
          permissionGranted,
          permissionGranted
            ? `${transactionType} is granted on-ledger.`
            : `${transactionType} is not granted on-ledger.`,
        ),
        policyReason(
          "delegable_transaction_type",
          buildDelegable,
          buildDelegable
            ? `${transactionType} is delegable.`
            : `${transactionType} requires an owner signature.`,
        ),
        policyReason(
          "allowed_tx_types",
          typeAllowed,
          typeAllowed
            ? `${transactionType} is allowed by policy.`
            : `${transactionType} is not allowed by policy.`,
        ),
        policyReason(
          "execute_under_usd",
          underThreshold,
          underThreshold
            ? `${stored.amountUsd} USD is below ${policy.execute_under_usd} USD.`
            : `${stored.amountUsd} USD requires approval at the ${policy.execute_under_usd} USD threshold.`,
        ),
      ];
      const needsApproval =
        args.require_owner_approval === true ||
        !linkActive ||
        !permissionGranted ||
        !buildDelegable ||
        !typeAllowed ||
        !underThreshold;

      if (needsApproval) {
        const template = fixtureEnvelope("tx.execute.needs_approval");
        result = withEnvelopeData(template, {
          status: "needs_approval",
          approval_id: `mock-approval-${stored.build.build_id}`,
          tx_json: clone(stored.build.tx_json),
          expires_at: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
          policy: { verdict: "needs_approval", reasons: approvalReasons },
        });
      } else {
        result = fixtureEnvelope("tx.execute.executed") as Envelope<ExecResult>;
      }
    }

    if (result.ok) ExecResultSchema.parse(result.data);
    return remember(result);
  }
}

export function createMockHarborClient(): MockHarborClient {
  return new MockHarborClient();
}
