"use strict";

const NETWORK = "__NET__";
const RUN_TAG = "__RUN__";
const MAX_LEDGERS = 64;
const MAX_TRANSACTIONS = 256;
const MAX_LIST_ITEMS = 100_000;
const RIPPLE_EPOCH_SECONDS = 946_684_800;
const IOU_FIELDS = [
  "Amount",
  "SendMax",
  "TakerGets",
  "TakerPays",
  "Amount2",
  "LimitAmount",
];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function registryKey(list) {
  return `harbor_${NETWORK}_${RUN_TAG}_${list}`;
}

function classicAddress(value) {
  return typeof value === "string" && /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(value)
    ? value
    : null;
}

function hash(value) {
  return typeof value === "string" && /^[A-Fa-f0-9]{64}$/.test(value)
    ? value.toUpperCase()
    : null;
}

function transactionType(value) {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value)
    ? value
    : null;
}

function transactionResult(value) {
  return typeof value === "string" && /^(?:tes|tec|tef|tel|tem|ter)[A-Za-z0-9_]{0,61}$/.test(value)
    ? value
    : "unknown";
}

function ledgerIndex(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function closeTime(value) {
  if (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  ) return value;
  if (Number.isSafeInteger(value) && value >= 0) {
    return new Date((value + RIPPLE_EPOCH_SECONDS) * 1_000).toISOString();
  }
  return "1970-01-01T00:00:00.000Z";
}

function decodeCurrency(value) {
  if (typeof value !== "string") return null;
  if (/^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3}$/.test(value)) return value;
  if (!/^[A-Fa-f0-9]{40}$/.test(value)) return null;
  let decoded = "";
  for (let index = 0; index < value.length; index += 2) {
    const byte = Number.parseInt(value.slice(index, index + 2), 16);
    if (byte === 0) {
      if (!/^0+$/.test(value.slice(index))) return null;
      break;
    }
    if (byte > 0x7f) return null;
    decoded += String.fromCharCode(byte);
  }
  return /^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{1,20}$/.test(decoded)
    ? decoded
    : null;
}

function iouIssuerKey(value) {
  if (typeof value === "string" || value === null || value === undefined) return null;
  if (!isRecord(value)) return "__invalid_iou__";
  const currency = decodeCurrency(value.currency);
  const issuer = classicAddress(value.issuer);
  return currency && issuer ? `${currency}.${issuer}` : "__invalid_iou__";
}

function hasUnlistedIssuer(transaction, issuers) {
  for (const field of IOU_FIELDS) {
    const key = iouIssuerKey(transaction[field]);
    if (key !== null && !issuers.has(key)) return true;
  }
  return false;
}

function ledgerItems(data) {
  const items = Array.isArray(data) ? data : [data];
  if (items.length > MAX_LEDGERS) throw new Error("watchdog ledger batch too large");
  return items.filter(isRecord);
}

function collectTransactions(data) {
  const collected = [];
  for (const ledger of ledgerItems(data)) {
    if (!Array.isArray(ledger.transactions)) continue;
    if (collected.length + ledger.transactions.length > MAX_TRANSACTIONS) {
      throw new Error("watchdog transaction batch too large");
    }
    for (const candidate of ledger.transactions) {
      if (!isRecord(candidate)) continue;
      const txHash = hash(candidate.hash);
      const account = classicAddress(candidate.Account);
      const txType = transactionType(candidate.TransactionType);
      if (!txHash || !account || !txType) continue;
      const meta = isRecord(candidate.metaData)
        ? candidate.metaData
        : isRecord(candidate.meta)
          ? candidate.meta
          : {};
      collected.push({
        transaction: candidate,
        txHash,
        account,
        delegate: classicAddress(candidate.Delegate),
        txType,
        result: transactionResult(meta.TransactionResult),
        ledgerIndex: ledgerIndex(candidate.ledger_index ?? ledger.ledger_index),
        closeTime: closeTime(
          candidate.close_time_iso ?? candidate.close_time ??
          ledger.close_time_iso ?? ledger.close_time,
        ),
      });
    }
  }
  return collected;
}

function strictList(value, name) {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new Error(`watchdog ${name} list is invalid`);
  }
  const result = new Set();
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > 256) {
      throw new Error(`watchdog ${name} list is invalid`);
    }
    result.add(item);
  }
  return result;
}

async function main(stream) {
  const transactions = collectTransactions(isRecord(stream) ? stream.data : undefined);
  if (transactions.length === 0) return null;

  const watched = await qnLib.qnContainsListItems(
    registryKey("accounts"),
    transactions.map((item) => item.account),
  );
  if (
    !Array.isArray(watched) ||
    watched.length !== transactions.length ||
    watched.some((item) => typeof item !== "boolean")
  ) throw new Error("watchdog account lookup is invalid");
  if (!watched.some(Boolean)) return null;

  const [delegatesRaw, frozenRaw, txTypesRaw, issuersRaw] = await Promise.all([
    qnLib.qnGetList(registryKey("delegates")),
    qnLib.qnGetList(registryKey("frozen")),
    qnLib.qnGetList(registryKey("tx_types")),
    qnLib.qnGetList(registryKey("issuers")),
  ]);
  const delegates = strictList(delegatesRaw, "delegates");
  const frozen = strictList(frozenRaw, "frozen");
  const txTypes = strictList(txTypesRaw, "tx_types");
  const issuers = strictList(issuersRaw, "issuers");
  const events = [];

  for (let index = 0; index < transactions.length; index += 1) {
    if (!watched[index]) continue;
    const item = transactions[index];
    const flags = [];
    if (frozen.has(item.account)) flags.push("frozen_account");
    if (
      item.delegate !== null &&
      delegates.has(item.delegate) &&
      !txTypes.has(item.txType)
    ) flags.push("tx_type_not_delegated");
    if (hasUnlistedIssuer(item.transaction, issuers)) {
      flags.push("issuer_not_allowlisted");
    }
    events.push({
      tx_hash: item.txHash,
      account: item.account,
      delegate: item.delegate,
      tx_type: item.txType,
      result: item.result,
      ledger_index: item.ledgerIndex,
      close_time: item.closeTime,
      flags,
    });
  }
  return events.length === 0 ? null : { events };
}
