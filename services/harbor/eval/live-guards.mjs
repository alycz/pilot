export const LIVE_BUY_STABLE_VALUE = "10";
export const MAX_LIVE_XRP_SPEND_DROPS = 50_000_000n;
export const MAX_AUTOFILL_FEE_DROPS = 2_000_000n;

const OFFER_TF_FILL_OR_KILL = 0x0004_0000;
const OFFER_TF_SELL = 0x0008_0000;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decimal(value, field) {
  if (typeof value !== "string") throw new Error(`${field} is not a decimal string`);
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) throw new Error(`${field} is not a decimal string`);
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? "0");
  if (
    !Number.isSafeInteger(exponent) ||
    exponent < -100 ||
    exponent > 100 ||
    fraction.length > 100
  ) throw new Error(`${field} has an invalid exponent`);
  let coefficient = BigInt(`${match[1]}${match[2]}${fraction}`);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { coefficient, scale };
}

function compare(left, right) {
  const scale = Math.max(left.scale, right.scale);
  const leftValue = left.coefficient * 10n ** BigInt(scale - left.scale);
  const rightValue = right.coefficient * 10n ** BigInt(scale - right.scale);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function subtract(left, right) {
  const scale = Math.max(left.scale, right.scale);
  return {
    coefficient:
      left.coefficient * 10n ** BigInt(scale - left.scale) -
      right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  };
}

function requireDepth(value, name) {
  const totals = isRecord(value) && isRecord(value.totals) ? value.totals : undefined;
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.ledger_index) ||
    value.ledger_index < 1 ||
    !isRecord(totals) ||
    typeof totals.taker_gets !== "string" ||
    typeof totals.taker_pays !== "string" ||
    !Number.isSafeInteger(totals.offer_count) ||
    totals.offer_count < 1
  ) {
    throw new Error(`${name} is not validated funded depth`);
  }
  const gets = decimal(totals.taker_gets, `${name}.totals.taker_gets`);
  const pays = decimal(totals.taker_pays, `${name}.totals.taker_pays`);
  if (compare(gets, decimal("0", "zero")) <= 0 || compare(pays, decimal("0", "zero")) <= 0) {
    throw new Error(`${name} has no positive funded liquidity`);
  }
  return { gets, pays };
}

export function requireBuyLiquidity(opposingDepth, sameSideDepth) {
  // A buyer offering XRP crosses makers who offer stable (TakerGets) for XRP
  // (TakerPays). The same-side book is also required as a validated sanity
  // guard against running the live evaluator in a one-sided market.
  const opposing = requireDepth(opposingDepth, "Opposing stable/XRP book");
  requireDepth(sameSideDepth, "Same-side XRP/stable book");
  if (compare(opposing.gets, decimal(LIVE_BUY_STABLE_VALUE, "target stable")) < 0) {
    throw new Error("Validated opposing book lacks 10 stable units of funded liquidity");
  }
}

export function requireLivePolicy(policy, stable, usdValue) {
	const notional = Number(usdValue);
  if (
    !isRecord(policy) ||
    !Array.isArray(policy.networks) ||
    !policy.networks.includes(stable.network) ||
    !Array.isArray(policy.allowed_tx_types) ||
    !policy.allowed_tx_types.includes("OfferCreate") ||
    !Array.isArray(policy.issuer_allowlist) ||
    !policy.issuer_allowlist.some((entry) =>
      entry === stable.issuer || String(entry).toUpperCase() === "RLUSD"
    ) ||
    !Number.isFinite(notional) ||
    notional <= 0 ||
    !(Number(policy.max_per_tx_usd) >= notional) ||
    !(Number(policy.daily_cap_usd) >= notional) ||
    !(Number(policy.execute_under_usd) > notional)
  ) {
    throw new Error(
      "Policy must allow the stable issuer, OfferCreate, and autonomous execution for the built USD notional",
    );
  }
}

export function requireStableReceiveCapacity(line) {
  const balance = isRecord(line) ? Number(line.balance) : Number.NaN;
  const limit = isRecord(line) ? Number(line.limit) : Number.NaN;
  if (
    !isRecord(line) ||
    typeof line.balance !== "string" ||
    typeof line.limit !== "string" ||
    !Number.isFinite(balance) ||
    !Number.isFinite(limit) ||
    limit - balance < Number(LIVE_BUY_STABLE_VALUE) ||
    line.freeze === true ||
    line.freeze_peer === true
  ) {
    throw new Error("Fresh owner needs an unfrozen trust line able to receive 10 stable units");
  }
  return line.balance;
}

export function requireRevocableLiveStatus(status, expectedDelegate) {
  if (isRecord(status) && status.status === "revoked") return undefined;
  if (
    !isRecord(status) ||
    (status.status !== "active" && status.status !== "suspended") ||
    typeof status.delegate !== "string" ||
    status.delegate.length === 0 ||
    (expectedDelegate !== undefined && status.delegate !== expectedDelegate)
  ) {
    throw new Error("Revocable delegation could not be confirmed before cleanup");
  }
  return status.delegate;
}

function requireExecutableBuild(build) {
  if (!isRecord(build) || !isRecord(build.simulate) || build.simulate.engine_result !== "tesSUCCESS") {
    throw new Error("OfferCreate simulation did not return tesSUCCESS");
  }
  if (
    !Array.isArray(build.preflight) ||
    build.preflight.length === 0 ||
    build.preflight.some((check) => !isRecord(check) || check.pass !== true)
  ) {
    throw new Error("OfferCreate did not pass every preflight check");
  }
}

export function requireRlusdPurchaseBuild(build, expected) {
  requireExecutableBuild(build);
  const txJson = isRecord(build) && isRecord(build.tx_json) ? build.tx_json : undefined;
  const received = isRecord(txJson?.TakerPays) ? txJson.TakerPays : undefined;
  // OfferCreate defines TakerGets as what the account gives and TakerPays as
  // what it receives. For this exact-output purchase the owner gives bounded
  // XRP and receives exactly 10 RLUSD:
  // https://xrpl.org/docs/references/protocol/transactions/types/offercreate
  if (
    !isRecord(txJson) ||
    txJson.TransactionType !== "OfferCreate" ||
    txJson.Account !== expected.owner ||
    typeof txJson.TakerGets !== "string" ||
    !/^\d+$/.test(txJson.TakerGets) ||
    BigInt(txJson.TakerGets) < 1n ||
    BigInt(txJson.TakerGets) > MAX_LIVE_XRP_SPEND_DROPS ||
    !isRecord(received) ||
    received.currency !== expected.stable.currency ||
    received.issuer !== expected.stable.issuer ||
    received.value !== LIVE_BUY_STABLE_VALUE ||
    txJson.Flags !== OFFER_TF_FILL_OR_KILL ||
    (txJson.Flags & OFFER_TF_SELL) !== 0
  ) {
    throw new Error("Builder did not produce the bounded exact-output 10 stable purchase");
  }
  return BigInt(txJson.TakerGets);
}

export function requireDelegateFeeHeadroom(accountInfo) {
  const accountData = isRecord(accountInfo) && isRecord(accountInfo.account_data)
    ? accountInfo.account_data
    : undefined;
  if (
    !isRecord(accountData) ||
    typeof accountData.Balance !== "string" ||
    !/^\d+$/.test(accountData.Balance)
  ) {
    throw new Error("Delegate balance is malformed");
  }
  if (BigInt(accountData.Balance) < MAX_AUTOFILL_FEE_DROPS) {
    throw new Error("Delegate lacks conservative execution-fee headroom");
  }
}

function xrpToDrops(value, field) {
  const drops = value * 1_000_000;
  if (!Number.isSafeInteger(drops) || drops < 0) {
    throw new Error(`${field} is not an exact XRP drop amount`);
  }
  return BigInt(drops);
}

export function requireSpendableXrp(accountInfo, reserves, spendDrops, ownerActionCount) {
  const accountData = isRecord(accountInfo) && isRecord(accountInfo.account_data)
    ? accountInfo.account_data
    : undefined;
  if (
    !isRecord(accountData) ||
    typeof accountData.Balance !== "string" ||
    !/^\d+$/.test(accountData.Balance) ||
    !Number.isSafeInteger(accountData.OwnerCount) ||
    accountData.OwnerCount < 0 ||
    !isRecord(reserves) ||
    typeof reserves.reserve_base_xrp !== "number" ||
    !Number.isFinite(reserves.reserve_base_xrp) ||
    reserves.reserve_base_xrp < 0 ||
    typeof reserves.reserve_inc_xrp !== "number" ||
    !Number.isFinite(reserves.reserve_inc_xrp) ||
    reserves.reserve_inc_xrp < 0 ||
    typeof spendDrops !== "bigint" ||
    spendDrops < 0n ||
    !Number.isSafeInteger(ownerActionCount) ||
    ownerActionCount < 1
  ) {
    throw new Error("Fresh owner balance, reserves, or spend budget is malformed");
  }
  const futureOwnerCount = accountData.OwnerCount + 2;
  const reserveDrops = xrpToDrops(
    reserves.reserve_base_xrp + (futureOwnerCount * reserves.reserve_inc_xrp),
    "Future account reserve",
  );
  const ownerFeeBudget = MAX_AUTOFILL_FEE_DROPS * BigInt(ownerActionCount);
  const required = reserveDrops + spendDrops + ownerFeeBudget;
  if (BigInt(accountData.Balance) < required) {
    throw new Error("Fresh owner lacks spendable XRP after reserves, bounded trade spend, and owner-action fees");
  }
}

export function requireExactStableIncrease(before, after) {
  const increase = subtract(
    decimal(after, "Post-trade stable balance"),
    decimal(before, "Pre-trade stable balance"),
  );
  if (compare(increase, decimal(LIVE_BUY_STABLE_VALUE, "target stable")) !== 0) {
    throw new Error("Validated OfferCreate did not deliver exactly 10 stable units");
  }
}
