import {
  AccountLinkSchema,
  EnvelopeSchema,
  ExecResultSchema,
  PolicySchema,
  TxBuildSchema,
  VenueSchema,
  type AccountLink,
  type Asset,
  type Envelope,
  type Err,
  type ExecResult,
  type Network,
  type Policy,
  type PolicyResult,
  type TxBuild,
} from "@pilot/contracts";
import { z } from "zod";

import builderFixturesJson from "../fixtures/builders.json";
import executionFixturesJson from "../fixtures/execution.json";
import readFixturesJson from "../fixtures/reads.json";
import {
  HarborArgsSchemas,
  type ArgsFor,
  type HarborClient,
  type HarborOpName,
  type ResultFor,
} from "./types.js";

type FixtureTable = Record<string, unknown>;
type JsonRecord = Record<string, unknown>;

type StoredBuild = {
  build: TxBuild;
  amountUsd: number;
  assets: Asset[];
  hasUnknownIssuer: boolean;
  maxSlippageBps?: number;
};

const GenericEnvelopeSchema = EnvelopeSchema(z.unknown());
const FORBIDDEN_ARGUMENT = /seed|secret|private|mnemonic/i;
const TF_IMMEDIATE_OR_CANCEL = 0x0002_0000;
const TF_SELL = 0x0008_0000;
const MOCK_XRP_USD = 0.512;
const KNOWN_ISSUERS = new Set([
  "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
  "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
]);

const fixtures: FixtureTable = {
  ...(readFixturesJson as FixtureTable),
  ...(builderFixturesJson as FixtureTable),
  ...(executionFixturesJson as FixtureTable),
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
  "tx.simulate",
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
    case "policy.get":
    case "policy.set":
      PolicySchema.parse(envelope.data);
      break;
    case "tx.execute":
      ExecResultSchema.parse(envelope.data);
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

function amountUsd(args: JsonRecord, fallback: TxBuild): number {
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

  switch (name) {
    case "tx.swap": {
      const sell = asset(args.sell)!;
      const buy = asset(args.buy)!;
      const amount = String(args.amount);
      const side = args.side === "buy" ? "buy" : "sell";
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

      // TakerGets is sold, TakerPays is bought, IOC prevents a resting order,
      // and tfSell fixes the full TakerGets amount for a fixed-sell swap.
      // https://xrpl.org/docs/references/protocol/transactions/types/offercreate
      return {
        txJson: {
          ...base,
          TransactionType: "OfferCreate",
          TakerGets: ledgerAmount(sell, decimalAmount(sellAmount)),
          TakerPays: ledgerAmount(buy, decimalAmount(buyAmount)),
          Flags:
            TF_IMMEDIATE_OR_CANCEL | (side === "sell" ? TF_SELL : 0),
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
      const trustAsset = asset(args.asset)!;
      const limit = String(args.limit);
      return {
        txJson: {
          ...base,
          TransactionType: "TrustSet",
          LimitAmount: ledgerAmount(trustAsset, limit),
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
      const amount = String(args.amount);
      const amount2 = typeof args.amount2 === "string" ? args.amount2 : undefined;
      const txJson: JsonRecord = {
        ...base,
        TransactionType: transactionTypes[name],
        Asset: assetDescriptor(first),
        Asset2: assetDescriptor(second),
        Amount: ledgerAmount(first, amount),
      };
      delete txJson.LPTokenIn;
      if (amount2) txJson.Amount2 = ledgerAmount(second, amount2);
      else delete txJson.Amount2;
      return {
        txJson,
        action: `${name === "tx.ammDeposit" ? "Deposit to" : "Withdraw from"} ${displayAsset(first)}/${displayAsset(second)} AMM`,
        amounts: [
          `${amount} ${displayAsset(first)}`,
          ...(amount2 ? [`${amount2} ${displayAsset(second)}`] : []),
        ],
        assets: [first, second],
      };
    }
    case "tx.vaultDeposit":
    case "tx.vaultWithdraw": {
      // https://xrpl.org/docs/references/protocol/transactions/types/vaultdeposit
      // https://xrpl.org/docs/references/protocol/transactions/types/vaultwithdraw
      const vaultAsset = asset(args.asset)!;
      const amount = String(args.amount);
      return {
        txJson: {
          ...base,
          TransactionType: transactionTypes[name],
          VaultID: args.vault_id,
          Amount: ledgerAmount(vaultAsset, amount),
        },
        action: `${name === "tx.vaultDeposit" ? "Deposit to" : "Withdraw from"} vault ${String(args.vault_id)}`,
        amounts: [`${amount} ${displayAsset(vaultAsset)}`],
        assets: [vaultAsset],
      };
    }
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
  private readonly builds = new Map<string, StoredBuild>();
  private readonly idempotentExecutions = new Map<string, Envelope<ExecResult>>();
  private readonly links = new Map<string, AccountLink>();
  private readonly policies = new Map<string, Policy>();

  constructor() {
    for (const operation of builderOperations) {
      const envelope = fixtureEnvelope(operation);
      if (!envelope.ok) continue;
      const build = TxBuildSchema.parse(envelope.data);
      this.builds.set(build.build_id, {
        build,
        amountUsd: amountUsd({}, build),
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
    if (builderOperations.has(name)) {
      if ((validArgs as { network: Network }).network === "mainnet") {
        return errorEnvelope(
          "MAINNET_EXECUTION_DISABLED",
          "Mock Harbor never builds mainnet transactions.",
        );
      }
      return this.build(name, validArgs as JsonRecord) as Envelope<ResultFor<K>>;
    }
    if (name === "tx.execute") {
      return this.execute(validArgs as ArgsFor<"tx.execute">) as Envelope<ResultFor<K>>;
    }
    return fixtureEnvelope(name) as Envelope<ResultFor<K>>;
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
    if (args.network === "mainnet") {
      return errorEnvelope(
        "MAINNET_EXECUTION_DISABLED",
        "Mock Harbor never prepares a mainnet delegation.",
      );
    }
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
    if (args.network === "mainnet") {
      return errorEnvelope(
        "MAINNET_EXECUTION_DISABLED",
        "Mock Harbor never prepares a mainnet delegation revoke.",
      );
    }
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
    const usdValue = amountUsd(args, fixture);
    const build = TxBuildSchema.parse({
      ...fixture,
      build_id: `mock-build-${String(++this.buildSequence).padStart(4, "0")}`,
      network: args.network,
      tx_json: details.txJson,
      delegable: isDelegable(transactionType),
      preflight,
      summary: {
        ...fixture.summary,
        action: details.action,
        account: args.account,
        amounts: details.amounts,
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
    if (existing) return clone(existing);

    if (
      args.idempotency_key === "mock-failed" ||
      args.idempotency_key.startsWith("mock-failed:")
    ) {
      const failed = fixtureEnvelope("tx.execute.failed") as Envelope<ExecResult>;
      this.idempotentExecutions.set(args.idempotency_key, failed);
      return clone(failed);
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

    let result: Envelope<ExecResult>;
    if (
      !networkAllowed ||
      stored.hasUnknownIssuer ||
      !issuerAllowed ||
      !withinMaximum ||
      !slippageAllowed
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
          stored.build.delegable,
          stored.build.delegable
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
        !linkActive ||
        !permissionGranted ||
        !stored.build.delegable ||
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
    this.idempotentExecutions.set(args.idempotency_key, clone(result));
    return result;
  }
}

export function createMockHarborClient(): MockHarborClient {
  return new MockHarborClient();
}
