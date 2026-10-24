import type { CardEvent } from "@pilot/contracts";

import { encodeCurrencyCode } from "../approval/normalize-transaction";
import type { ApprovalRequest } from "../approval/approval-modal";

const FOK_FLAG = 0x0004_0000;
const SELL_FLAG = 0x0008_0000;
const MAX_FEE_DROPS = 100;
const MAX_LEDGER_WINDOW = 50;
const BASE_FIELDS = new Set([
  "TransactionType", "Account", "Fee", "Sequence", "LastLedgerSequence", "Flags",
  "SourceTag", "Memos", "SigningPubKey",
]);

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftEntries = Object.entries(left as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    const rightEntries = Object.entries(right as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return leftEntries.length === rightEntries.length && leftEntries.every(([key, value], index) =>
      key === rightEntries[index]?.[0] && jsonEqual(value, rightEntries[index]?.[1]));
  }
  return left === right;
}

function withoutRefreshableFields(transaction: Record<string, unknown>) {
  const copy = { ...transaction };
  delete copy.Fee;
  delete copy.Sequence;
  delete copy.LastLedgerSequence;
  return copy;
}

function xrpToDrops(value: string): string | undefined {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) return undefined;
  return `${match[1]}${(match[2] ?? "").padEnd(6, "0")}`.replace(/^0+(?=\d)/, "");
}

function exactIntentAmount(
  amount: unknown,
  asset: { currency: string; issuer?: string },
  value: string,
): boolean {
  if (asset.currency === "XRP") return amount === xrpToDrops(value);
  return Boolean(amount && typeof amount === "object" && !Array.isArray(amount) &&
    (amount as Record<string, unknown>).currency === encodeCurrencyCode(asset.currency) &&
    (amount as Record<string, unknown>).issuer === asset.issuer &&
    (amount as Record<string, unknown>).value === value &&
    Object.keys(amount as Record<string, unknown>).length === 3);
}

function amountMatchesAsset(amount: unknown, asset: { currency: string; issuer?: string }): boolean {
  if (asset.currency === "XRP") return typeof amount === "string" && /^\d+$/.test(amount);
  return Boolean(amount && typeof amount === "object" && !Array.isArray(amount) &&
    (amount as Record<string, unknown>).currency === encodeCurrencyCode(asset.currency) &&
    (amount as Record<string, unknown>).issuer === asset.issuer);
}

function amountLabel(amount: unknown): string {
  if (typeof amount === "string" && /^\d+$/.test(amount)) {
    const units = Number(amount) / 1_000_000;
    return `${Number.isSafeInteger(Number(amount)) ? units.toString() : amount} XRP`;
  }
  if (amount && typeof amount === "object" && !Array.isArray(amount)) {
    const value = amount as Record<string, unknown>;
    if (typeof value.value === "string" && typeof value.currency === "string") {
      return `${value.value} ${value.currency}`;
    }
  }
  throw new Error("The approval contains an invalid asset amount.");
}

function requireAllowedFields(transaction: Record<string, unknown>, additions: string[]) {
  const allowed = new Set([...BASE_FIELDS, ...additions]);
  if (Object.keys(transaction).some((field) => !allowed.has(field))) {
    throw new Error("The approval transaction contains unsupported fields.");
  }
}

export function bindApprovalTransaction(
  event: CardEvent,
  account: string,
  validatedLedgerIndex: number,
  validatedAccountSequence: number,
  now = Date.now(),
): ApprovalRequest {
  const approval = event.exec?.status === "needs_approval" ? event.exec : undefined;
  if (!approval || !event.build) throw new Error("This card does not contain a complete Harbor approval.");
  if (event.intent.network !== "testnet" && event.intent.network !== "devnet") {
    throw new Error("Owner approval is limited to Testnet and Devnet.");
  }
  if (event.build.network !== event.intent.network) throw new Error("The approval network does not match the intent.");
  const expiry = Date.parse(approval.expires_at);
  if (!Number.isFinite(expiry) || expiry <= now) {
    throw new Error("This approval expired. Build a fresh transaction before signing.");
  }
  if (
    event.build.simulate.applied !== false ||
    event.build.simulate.engine_result !== "tesSUCCESS" ||
    event.build.preflight.length === 0 ||
    event.build.preflight.some((check) => check.pass !== true)
  ) {
    throw new Error("The approval build did not pass simulation and preflight checks.");
  }

  const transaction = approval.tx_json;
  if (transaction.Account !== account || event.build.summary.account !== account) {
    throw new Error("This approval belongs to a different wallet account.");
  }
  const fee = typeof transaction.Fee === "string" && /^\d+$/.test(transaction.Fee)
    ? Number(transaction.Fee)
    : Number.NaN;
  const sequence = transaction.Sequence;
  const lastLedgerSequence = transaction.LastLedgerSequence;
  if (!Number.isSafeInteger(fee) || fee < 0 || fee > MAX_FEE_DROPS) {
    throw new Error("The approval fee is outside Pilot's safe limit.");
  }
  if (!Number.isSafeInteger(sequence) || Number(sequence) !== validatedAccountSequence ||
      !Number.isSafeInteger(lastLedgerSequence) || Number(lastLedgerSequence) <= validatedLedgerIndex ||
      Number(lastLedgerSequence) > validatedLedgerIndex + MAX_LEDGER_WINDOW) {
    throw new Error("The approval transaction does not have a safe validated-ledger window.");
  }
  if (!jsonEqual(withoutRefreshableFields(transaction), withoutRefreshableFields(event.build.tx_json))) {
    throw new Error("The approval transaction does not match the simulated build.");
  }

  let action: string;
  let amounts: string[];
  let destination: string | undefined;
  if (event.intent.kind === "swap") {
    requireAllowedFields(transaction, ["TakerGets", "TakerPays"]);
    if (transaction.TransactionType !== "OfferCreate") throw new Error("The approval transaction is not the requested swap.");
    const expectedFlags = FOK_FLAG | (event.intent.side === "sell" ? SELL_FLAG : 0);
    if (transaction.Flags !== expectedFlags) throw new Error("The approval swap flags do not match the requested execution mode.");
    const fixedAmount = event.intent.side === "sell" ? transaction.TakerGets : transaction.TakerPays;
    const fixedAsset = event.intent.side === "sell" ? event.intent.sell : event.intent.buy;
    const floatingAmount = event.intent.side === "sell" ? transaction.TakerPays : transaction.TakerGets;
    const floatingAsset = event.intent.side === "sell" ? event.intent.buy : event.intent.sell;
    if (!exactIntentAmount(fixedAmount, fixedAsset, event.intent.amount)) {
      throw new Error("The approval amount does not match the requested swap.");
    }
    if (!amountMatchesAsset(floatingAmount, floatingAsset)) {
      throw new Error("The approval counter-asset does not match the requested swap.");
    }
    for (const field of ["TransactionType", "Account", "TakerGets", "TakerPays", "Flags"] as const) {
      if (!jsonEqual(transaction[field], event.build.tx_json[field])) {
        throw new Error(`The approval ${field} does not match the simulated build.`);
      }
    }
    action = `Swap ${event.intent.sell.currency} for ${event.intent.buy.currency}`;
    amounts = [amountLabel(transaction.TakerGets), amountLabel(transaction.TakerPays)];
  } else if (event.intent.kind === "vault_deposit") {
    requireAllowedFields(transaction, ["VaultID", "Amount"]);
    if (transaction.TransactionType !== "VaultDeposit" || transaction.VaultID !== event.intent.vault_id ||
        !exactIntentAmount(transaction.Amount, event.intent.asset, event.intent.amount)) {
      throw new Error("The approval transaction does not match the requested vault deposit.");
    }
    for (const field of ["TransactionType", "Account", "VaultID", "Amount"] as const) {
      if (!jsonEqual(transaction[field], event.build.tx_json[field])) {
        throw new Error(`The approval ${field} does not match the simulated build.`);
      }
    }
    action = "Deposit into XRPL vault";
    amounts = [amountLabel(transaction.Amount)];
    destination = event.intent.vault_id;
  } else {
    throw new Error(`Owner approval for ${event.intent.kind.replaceAll("_", " ")} is not supported by this sprint.`);
  }

  return {
    approvalId: approval.approval_id,
    expiresAt: approval.expires_at,
    txJson: transaction,
    summary: {
      action,
      amounts,
      destination,
      feeDrops: String(transaction.Fee),
      network: event.intent.network,
    },
  };
}
