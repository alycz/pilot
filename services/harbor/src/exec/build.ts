import type { OpContext } from "../catalog/registry";
import type { ExecutionCapability, ExecutionContract, Network, TxBuild } from "../contracts";
import { requestXrpl, type XrplRpc } from "../adapters/xrpl-rpc";
import {
  createStore,
  type BuildInsert,
  type BuildRow,
  type LinkStatus,
} from "./store";
import {
  LOCAL_TRADING_BUILD_ORIGIN,
  localTradingMarkersPresent,
} from "../local-trading";
import {
  LOCAL_TRADING_ONBOARDING_BUILD_ORIGIN,
  localTradingOnboardingMarkersPresent,
} from "../local-trading-onboarding";
import {
  LOCAL_TRADING_ISOLATED_V1_BUILD_ORIGIN,
  isReviewedLocalTradingIsolatedV1Context,
  localTradingIsolatedV1MarkersPresent,
} from "../local-trading-isolated-v1";
import {
  LOCAL_TRADING_ISOLATED_ONBOARDING_V1_BUILD_ORIGIN,
  isReviewedLocalTradingIsolatedOnboardingV1Context,
  localTradingIsolatedOnboardingV1MarkersPresent,
} from "../local-trading-isolated-onboarding-v1";
import { isReviewedLocalTradingContext } from "../local-trading";
import { isReviewedLocalTradingOnboardingContext } from "../local-trading-onboarding";
import { isHarborDelegableTransactionType } from "./delegation";

export type PreparedTransaction = Record<string, unknown>;
export type XrplAmount =
  | string
  | { currency: string; issuer: string; value: string };
export type IssuedAsset = { currency: string; issuer: string };
export type XrplAsset = { currency: "XRP" } | IssuedAsset;

export type PreflightCheckName =
  | "network"
  | "reserve"
  | "trust-line"
  | "require-auth"
  | "expiry"
  | "flag-conflicts"
  | (string & {});

export interface PreflightCheck {
  check: PreflightCheckName;
  pass: boolean;
  detail?: string;
}

export interface PreflightOptions {
  reserveDeltaDrops?: string;
  spendDrops?: string;
  feeDrops?: string;
  trustLines?: readonly XrplAsset[];
  requireAuthAssets?: readonly XrplAsset[];
  expiresAt?: string | number | Date;
  flagConflicts?: readonly {
    name: string;
    flags: number;
    masks: readonly [number, number];
  }[];
  additional?: readonly PreflightCheck[];
}

export interface BuildStore {
  insertBuild(input: BuildInsert & Partial<V2BuildPersistence>): Promise<unknown>;
  getLink?(
    owner: string,
    network: Network,
  ): Promise<{ permissions: string[]; status: LinkStatus } | null>;
}

export interface V2BuildPersistence {
  executionContract: "xrpl_execution_v2";
  buildRevision: number;
  unsignedTxDigest: string;
  unsignedTxDigestAlg: "sha256-jcs-v1";
  economicFingerprint: string;
  economicFingerprintAlg: "sha256-jcs-economic-v1";
  buildLedger: number;
  firstInclusionLedger: number;
  quoteLedger: number | null;
  quoteValidThroughLedger: number | null;
  executionCapability: ExecutionCapability;
}

export interface BuildContext extends OpContext {
  xrplRpc?: XrplRpc;
  store?: BuildStore;
  db?: D1Database;
  env?: Record<string, unknown>;
  sourceTag?: string | number;
}

export interface BuildInput {
  network: Network;
  owner: string;
  tx_json: PreparedTransaction;
  action: string;
  amounts: string[];
  intent_id?: string;
  build_id?: string;
  delegable?: boolean;
  permissions?: readonly string[];
  reserve_delta_drops?: string;
  est_slippage_bps?: number;
  valuation_amounts?: readonly XrplAmount[];
  preflight?: PreflightOptions;
  /**
   * Bind a market-derived build to a recent validated ledger. The build's
   * auto-filled ledger is `LastLedgerSequence - 4`; reject before simulation
   * or persistence when the reference is newer or older than the allowed gap.
   */
  validated_ledger_reference?: {
    ledger_index: number;
    max_ledger_gap: number;
  };
  /** Refuse to persist a build unless the exact unsigned transaction simulates successfully. */
  require_simulation_success?: boolean;
  now?: Date;
  execution_contract?: ExecutionContract;
  acquisition_balance_invariant?: NonNullable<
    ExecutionCapability["acquisition_balance_invariant"]
  >;
}

export interface UsdValuationInput {
  amounts: readonly XrplAmount[];
  now?: Date;
  aggregation?: "sum" | "max";
  network?: Network;
}

export interface StoredBuildLike {
  network: Network;
  owner: string;
  txJson: PreparedTransaction;
}

export type RevalidatedBuild = Pick<TxBuild, "preflight" | "simulate">;

export type BuildValidationCode =
  | "INVALID_BUILD"
  | "INVALID_TRANSACTION"
  | "SENSITIVE_ARGUMENT"
  | "SIGNED_TRANSACTION"
  | "MAINNET_EXECUTION_DISABLED"
  | "MISSING_SOURCE_TAG"
  | "STALE_LEDGER_REFERENCE"
  | "EXECUTION_CONTRACT_UNSUPPORTED"
  | "EXECUTION_SNAPSHOT_STALE"
  | "QUOTE_EXPIRED"
  | "SIMULATION_FAILED";

export class BuildValidationError extends Error {
  constructor(
    message: string,
    readonly code: BuildValidationCode,
  ) {
    super(message);
    this.name = "BuildValidationError";
  }
}

export function assertExecutionContractSupported(
  ctx: BuildContext,
  requested: unknown,
): ExecutionContract {
  const executionContract = requested ?? "xrpl_execution_v1";
  if (
    executionContract !== "xrpl_execution_v1" &&
    executionContract !== "xrpl_execution_v2"
  ) {
    throw new BuildValidationError(
      "Unsupported execution contract",
      "EXECUTION_CONTRACT_UNSUPPORTED",
    );
  }
  if (
    executionContract === "xrpl_execution_v2" &&
    (localTradingIsolatedOnboardingV1MarkersPresent(ctx.env)
      ? !isReviewedLocalTradingIsolatedOnboardingV1Context(ctx)
      : localTradingIsolatedV1MarkersPresent(ctx.env)
        ? !isReviewedLocalTradingIsolatedV1Context(ctx)
      : !isReviewedLocalTradingContext(ctx) &&
        !isReviewedLocalTradingOnboardingContext(ctx))
  ) {
    throw new BuildValidationError(
      "xrpl_execution_v2 is restricted to an exact reviewed local trading profile",
      "EXECUTION_CONTRACT_UNSUPPORTED",
    );
  }
  return executionContract;
}

export const MAINNET_RLUSD_ISSUER =
  "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
export const TESTNET_RLUSD_ISSUER =
  "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
export const RLUSD_HEX_CURRENCY =
  "524C555344000000000000000000000000000000";
export const USD_MID_CACHE_MS = 60_000;

const UINT32_MAX = 0xffff_ffff;
const V1_LAST_LEDGER_OFFSET = 4;
const V2_LAST_LEDGER_OFFSET = 64;
const REQUIRE_AUTH_FLAG = 0x0004_0000;
const SENSITIVE_KEY = /seed|secret|private|mnemonic/i;
const FORBIDDEN_OUTPUT_KEYS = new Set([
  "signingpubkey",
  "txnsignature",
  "signers",
  "signature",
  "sponsorsignature",
  "counterpartysignature",
  "tx_blob",
  "txblob",
  "delegate",
]);
const DROPS = /^(?:0|[1-9][0-9]*)$/;
const SIGNED_DROPS = /^-?(?:0|[1-9][0-9]*)$/;

type MidCache = { value: number; expiresAt: number };
let usdMidCache: MidCache | undefined;
let pendingUsdMid: Promise<number> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number.isFinite(value);
}

function checkObjectKeys(value: unknown, ancestors: WeakSet<object>): void {
  if (value === null || typeof value !== "object") return;
  if (ancestors.has(value)) {
    throw new BuildValidationError(
      "Transaction arguments must not contain cycles",
      "INVALID_TRANSACTION",
    );
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) checkObjectKeys(item, ancestors);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) {
        throw new BuildValidationError(
          "Sensitive key material is not accepted",
          "SENSITIVE_ARGUMENT",
        );
      }
      if (FORBIDDEN_OUTPUT_KEYS.has(key.toLowerCase())) {
        throw new BuildValidationError(
          "Signed transactions and binary transaction blobs are not accepted",
          "SIGNED_TRANSACTION",
        );
      }
      checkObjectKeys(item, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

/** Validate the transaction shell without signing it or contacting XRPL. */
export function validatePreparedTransaction(
  tx: PreparedTransaction,
  owner?: string,
): void {
  if (!isRecord(tx)) {
    throw new BuildValidationError(
      "tx_json must be a plain object",
      "INVALID_TRANSACTION",
    );
  }
  checkObjectKeys(tx, new WeakSet<object>());
  if (typeof tx.Account !== "string" || tx.Account.length === 0) {
    throw new BuildValidationError(
      "tx_json.Account is required",
      "INVALID_TRANSACTION",
    );
  }
  if (owner !== undefined && tx.Account !== owner) {
    throw new BuildValidationError(
      "tx_json.Account must match the build owner",
      "INVALID_TRANSACTION",
    );
  }
  if (
    typeof tx.TransactionType !== "string" ||
    tx.TransactionType.length === 0
  ) {
    throw new BuildValidationError(
      "tx_json.TransactionType is required",
      "INVALID_TRANSACTION",
    );
  }
  if (
    tx.Sequence !== undefined &&
    (!finiteInteger(tx.Sequence) || tx.Sequence < 0 || tx.Sequence > UINT32_MAX)
  ) {
    throw new BuildValidationError(
      "tx_json.Sequence must be a UInt32",
      "INVALID_TRANSACTION",
    );
  }
  if (tx.Fee !== undefined && (typeof tx.Fee !== "string" || !DROPS.test(tx.Fee))) {
    throw new BuildValidationError(
      "tx_json.Fee must be an unsigned drops string",
      "INVALID_TRANSACTION",
    );
  }
  if (
    tx.LastLedgerSequence !== undefined &&
    (!finiteInteger(tx.LastLedgerSequence) ||
      tx.LastLedgerSequence < 1 ||
      tx.LastLedgerSequence > UINT32_MAX)
  ) {
    throw new BuildValidationError(
      "tx_json.LastLedgerSequence must be a positive UInt32",
      "INVALID_TRANSACTION",
    );
  }
  if (
    tx.Flags !== undefined &&
    (!finiteInteger(tx.Flags) || tx.Flags < 0 || tx.Flags > UINT32_MAX)
  ) {
    throw new BuildValidationError(
      "tx_json.Flags must be a UInt32",
      "INVALID_TRANSACTION",
    );
  }
}

function textToHex(value: string): string {
  return [...new TextEncoder().encode(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function sourceTag(ctx: BuildContext): number {
  const configured =
    ctx.sourceTag ??
    (isRecord(ctx.env) ? ctx.env.HARBOR_SOURCE_TAG : undefined);
  const parsed =
    typeof configured === "number"
      ? configured
      : typeof configured === "string" && configured.trim() !== ""
        ? Number(configured)
        : Number.NaN;
  if (!finiteInteger(parsed) || parsed < 0 || parsed > UINT32_MAX) {
    throw new BuildValidationError(
      "HARBOR_SOURCE_TAG must be a UInt32",
      "MISSING_SOURCE_TAG",
    );
  }
  return parsed;
}

/**
 * Apply Harbor's single source tag and single intent memo. These are common
 * transaction fields documented at:
 * https://xrpl.org/docs/references/protocol/transactions/common-fields
 */
export function tagPreparedTransaction(
  tx: PreparedTransaction,
  tag: number,
  memoData: string,
): PreparedTransaction {
  if (!finiteInteger(tag) || tag < 0 || tag > UINT32_MAX) {
    throw new BuildValidationError("SourceTag must be a UInt32", "INVALID_BUILD");
  }
  if (new TextEncoder().encode(memoData).byteLength > 256) {
    throw new BuildValidationError(
      "Intent memo data must not exceed 256 UTF-8 bytes",
      "INVALID_BUILD",
    );
  }
  return {
    ...tx,
    // SourceTag is a UInt32 application identifier.
    SourceTag: tag,
    // MemoType and MemoData are hexadecimal blobs. Harbor intentionally
    // replaces caller memos so every build has exactly one canonical memo.
    Memos: [
      {
        Memo: {
          MemoType: textToHex("pilot/intent"),
          MemoData: textToHex(memoData),
        },
      },
    ],
  };
}

function asAccountData(result: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(result.account_data)) {
    throw new Error("account_info response is missing account_data");
  }
  return result.account_data;
}

function decimalXrpToDrops(value: unknown, field: string): bigint {
  const raw = typeof value === "number" ? String(value) : value;
  if (typeof raw !== "string" || !/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(raw)) {
    throw new Error(`server_info response has invalid ${field}`);
  }
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error(`server_info response has invalid ${field}`);
  }
  return BigInt(Math.round(numeric * 1_000_000));
}

function failure(check: PreflightCheckName, code: string, error: unknown): PreflightCheck {
  const suffix = error instanceof Error && error.message ? `: ${error.message}` : "";
  return { check, pass: false, detail: `${code}${suffix}` };
}

/** Read current account and server reserve values; reserve constants are never hard-coded. */
export async function checkReserve(
  ctx: BuildContext,
  network: Network,
  account: string,
  reserveDeltaDrops = "0",
  spendDrops = "0",
  transactionFeeDrops?: string,
): Promise<PreflightCheck> {
  try {
    if (!SIGNED_DROPS.test(reserveDeltaDrops) || !DROPS.test(spendDrops)) {
      return failure("reserve", "INVALID_RESERVE_DELTA", undefined);
    }
    if (transactionFeeDrops !== undefined && !DROPS.test(transactionFeeDrops)) {
      return failure("reserve", "INVALID_TRANSACTION_FEE", undefined);
    }
    const [accountResult, serverResult, feeResult] = await Promise.all([
      requestXrpl(ctx, network, "account_info", {
        account,
        ledger_index: "validated",
      }),
      requestXrpl(ctx, network, "server_info"),
      transactionFeeDrops === undefined
        ? requestXrpl(ctx, network, "fee")
        : Promise.resolve(undefined),
    ]);
    const data = asAccountData(accountResult);
    if (typeof data.Balance !== "string" || !DROPS.test(data.Balance)) {
      throw new Error("account_info response has invalid Balance");
    }
    if (!finiteInteger(data.OwnerCount) || data.OwnerCount < 0) {
      throw new Error("account_info response has invalid OwnerCount");
    }
    const info = serverResult.info;
    if (!isRecord(info) || !isRecord(info.validated_ledger)) {
      throw new Error("server_info response is missing validated_ledger");
    }
    const base = decimalXrpToDrops(
      info.validated_ledger.reserve_base_xrp,
      "reserve_base_xrp",
    );
    const increment = decimalXrpToDrops(
      info.validated_ledger.reserve_inc_xrp,
      "reserve_inc_xrp",
    );
    const required =
      base +
      increment * BigInt(data.OwnerCount) +
      BigInt(reserveDeltaDrops) +
      BigInt(spendDrops) +
      BigInt(
        transactionFeeDrops ?? feeDrops(feeResult as Record<string, unknown>),
      );
    const balance = BigInt(data.Balance);
    const pass = balance >= required;
    return {
      check: "reserve",
      pass,
      detail: pass
        ? `reserve available (${balance - required} drops headroom)`
        : `INSUFFICIENT_RESERVE: requires ${required} drops; balance ${balance}`,
    };
  } catch (error) {
    return failure("reserve", "RESERVE_CHECK_FAILED", error);
  }
}

function matchingLine(
  result: Record<string, unknown>,
  asset: IssuedAsset,
): Record<string, unknown> | undefined {
  if (!Array.isArray(result.lines)) {
    throw new Error("account_lines response is missing lines");
  }
  return result.lines.find(
    (line): line is Record<string, unknown> =>
      isRecord(line) &&
      line.account === asset.issuer &&
      line.currency === asset.currency,
  );
}

/** Check for the owner's existing trust line to an issued asset. */
export async function checkTrustLine(
  ctx: BuildContext,
  network: Network,
  account: string,
  asset: IssuedAsset,
): Promise<PreflightCheck> {
  if (account === asset.issuer) {
    return { check: "trust-line", pass: true, detail: "account is the issuer" };
  }
  try {
    // account_lines fields and the peer filter are documented at:
    // https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/account-methods/account_lines
    const result = await requestXrpl(ctx, network, "account_lines", {
      account,
      peer: asset.issuer,
      ledger_index: "validated",
      limit: 400,
    });
    const pass = matchingLine(result, asset) !== undefined;
    return {
      check: "trust-line",
      pass,
      detail: pass
        ? `${asset.currency}:${asset.issuer}`
        : `MISSING_TRUST_LINE: ${asset.currency}:${asset.issuer}`,
    };
  } catch (error) {
    return failure("trust-line", "TRUST_LINE_CHECK_FAILED", error);
  }
}

/** Check issuer RequireAuth and, when enabled, the owner's peer authorization. */
export async function checkRequireAuth(
  ctx: BuildContext,
  network: Network,
  account: string,
  asset: IssuedAsset,
): Promise<PreflightCheck> {
  if (account === asset.issuer) {
    return { check: "require-auth", pass: true, detail: "account is the issuer" };
  }
  try {
    // AccountRoot Flags includes lsfRequireAuth (0x00040000):
    // https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/accountroot#accountroot-flags
    const issuerResult = await requestXrpl(ctx, network, "account_info", {
      account: asset.issuer,
      ledger_index: "validated",
    });
    const issuerData = asAccountData(issuerResult);
    const flags = issuerData.Flags;
    if (!finiteInteger(flags) || flags < 0) {
      throw new Error("issuer account_info response has invalid Flags");
    }
    const flagObject = isRecord(issuerResult.account_flags)
      ? issuerResult.account_flags
      : undefined;
    const requiresAuth =
      flagObject?.requireAuth === true ||
      flagObject?.lsfRequireAuth === true ||
      (flags & REQUIRE_AUTH_FLAG) !== 0;
    if (!requiresAuth) {
      return {
        check: "require-auth",
        pass: true,
        detail: `${asset.issuer} does not require authorization`,
      };
    }
    // From the owner's perspective, peer_authorized means the issuer has
    // authorized the line:
    // https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/account-methods/account_lines
    const lineResult = await requestXrpl(ctx, network, "account_lines", {
      account,
      peer: asset.issuer,
      ledger_index: "validated",
      limit: 400,
    });
    const line = matchingLine(lineResult, asset);
    const pass = line?.peer_authorized === true;
    return {
      check: "require-auth",
      pass,
      detail: pass
        ? `${asset.currency}:${asset.issuer} is authorized`
        : `REQUIRE_AUTH_NOT_AUTHORIZED: ${asset.currency}:${asset.issuer}`,
    };
  } catch (error) {
    return failure("require-auth", "REQUIRE_AUTH_CHECK_FAILED", error);
  }
}

function expiryDate(value: string | number | Date): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  if (!Number.isFinite(value)) return undefined;
  // Transaction Expiration values use seconds since the Ripple Epoch.
  return new Date((value + 946_684_800) * 1_000);
}

export function checkExpiry(
  expiresAt: string | number | Date | undefined,
  now: Date = new Date(),
): PreflightCheck {
  if (expiresAt === undefined) {
    return { check: "expiry", pass: true, detail: "no expiry constraint" };
  }
  const expires = expiryDate(expiresAt);
  if (expires === undefined) {
    return failure("expiry", "INVALID_EXPIRY", undefined);
  }
  const pass = expires.getTime() > now.getTime();
  return {
    check: "expiry",
    pass,
    detail: pass
      ? `expires ${expires.toISOString()}`
      : `EXPIRED: expired ${expires.toISOString()}`,
  };
}

function defaultFlagConflicts(tx: PreparedTransaction): PreflightOptions["flagConflicts"] {
  if (!finiteInteger(tx.Flags)) return [];
  switch (tx.TransactionType) {
    case "OfferCreate":
      return [
        {
          name: "OfferCreate ImmediateOrCancel/FillOrKill",
          flags: tx.Flags,
          masks: [0x0002_0000, 0x0004_0000],
        },
        {
          name: "OfferCreate Passive/ImmediateOrCancel",
          flags: tx.Flags,
          masks: [0x0001_0000, 0x0002_0000],
        },
      ];
    case "TrustSet":
      return [
        {
          name: "TrustSet SetNoRipple/ClearNoRipple",
          flags: tx.Flags,
          masks: [0x0002_0000, 0x0004_0000],
        },
        {
          name: "TrustSet SetFreeze/ClearFreeze",
          flags: tx.Flags,
          masks: [0x0010_0000, 0x0020_0000],
        },
      ];
    default:
      return [];
  }
}

/** Detect mutually exclusive flag pairs without rejecting unrelated flags. */
export function checkFlagConflicts(
  conflicts: PreflightOptions["flagConflicts"] = [],
): PreflightCheck {
  const names = conflicts
    .filter(({ flags, masks }) =>
      masks.every((mask) => (flags & mask) === mask),
    )
    .map(({ name }) => name);
  return {
    check: "flag-conflicts",
    pass: names.length === 0,
    detail:
      names.length === 0
        ? "no conflicting flags"
        : `FLAG_CONFLICT: ${names.join(", ")}`,
  };
}

function issuedAssetsIn(value: unknown, assets: Map<string, IssuedAsset>): void {
  if (Array.isArray(value)) {
    for (const item of value) issuedAssetsIn(item, assets);
    return;
  }
  if (!isRecord(value)) return;
  if (
    typeof value.currency === "string" &&
    value.currency !== "XRP" &&
    typeof value.issuer === "string" &&
    typeof value.value === "string"
  ) {
    const asset = { currency: value.currency, issuer: value.issuer };
    assets.set(`${asset.currency}\u0000${asset.issuer}`, asset);
  }
  for (const child of Object.values(value)) issuedAssetsIn(child, assets);
}

function uniqueAssets(...groups: readonly (readonly XrplAsset[])[]): IssuedAsset[] {
  const result = new Map<string, IssuedAsset>();
  for (const group of groups) {
    for (const asset of group) {
      if (asset.currency === "XRP" || !("issuer" in asset)) continue;
      result.set(`${asset.currency}\u0000${asset.issuer}`, asset);
    }
  }
  return [...result.values()];
}

/** Run every check and retain failures as data so policy can evaluate them. */
export async function runPreflightChecks(
  ctx: BuildContext,
  network: Network,
  owner: string,
  tx: PreparedTransaction,
  options: PreflightOptions = {},
  now: Date = new Date(),
): Promise<PreflightCheck[]> {
  const inferred = new Map<string, IssuedAsset>();
  issuedAssetsIn(tx, inferred);
  const inferredAssets = [...inferred.values()];
  // Explicit assets are authoritative. This prevents output-only fields such
  // as AMMDeposit.LPTokenOut from being mistaken for a pre-existing line.
  const trustLines = uniqueAssets(
    options.trustLines === undefined
      ? tx.TransactionType === "TrustSet"
        ? []
        : inferredAssets
      : options.trustLines,
  );
  const authAssets = uniqueAssets(
    options.requireAuthAssets === undefined
      ? options.trustLines === undefined
        ? inferredAssets
        : trustLines
      : options.requireAuthAssets,
  );
  const checks: Promise<PreflightCheck>[] = [
    Promise.resolve({
      check: "network",
      pass: network !== "mainnet",
      detail:
        network === "mainnet"
          ? "MAINNET_EXECUTION_DISABLED"
          : `${network} is an allowed build network`,
    }),
    checkReserve(
      ctx,
      network,
      owner,
      options.reserveDeltaDrops ?? "0",
      options.spendDrops ?? "0",
      options.feeDrops ?? (typeof tx.Fee === "string" ? tx.Fee : undefined),
    ),
    ...trustLines.map((asset) =>
      checkTrustLine(ctx, network, owner, asset),
    ),
    ...authAssets.map((asset) =>
      checkRequireAuth(ctx, network, owner, asset),
    ),
  ];
  const resolved = await Promise.all(checks);
  resolved.push(
    checkExpiry(options.expiresAt ?? (tx.Expiration as number | undefined), now),
    checkFlagConflicts([
      ...(defaultFlagConflicts(tx) ?? []),
      ...(options.flagConflicts ?? []),
    ]),
    ...(options.additional ?? []),
  );
  return resolved;
}

function requiredUInt32(value: unknown, field: string): number {
  if (!finiteInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new Error(`XRPL response has invalid ${field}`);
  }
  return value;
}

function feeDrops(result: Record<string, unknown>): string {
  if (!isRecord(result.drops)) {
    throw new Error("fee response is missing drops");
  }
  const fee = result.drops.open_ledger_fee;
  if (typeof fee !== "string" || !DROPS.test(fee)) {
    throw new Error("fee response has invalid drops.open_ledger_fee");
  }
  return fee;
}

/**
 * Fill Sequence, Fee, and LastLedgerSequence using XRPL reads only. The common
 * fields and their auto-fill behavior are documented at:
 * https://xrpl.org/docs/references/protocol/transactions/common-fields#auto-fillable-fields
 * LastLedgerSequence uses the official +4 reliable-submission recommendation:
 * https://xrpl.org/docs/concepts/transactions/reliable-transaction-submission#lastledgersequence
 */
export async function autofillUnsignedTransaction(
  ctx: BuildContext,
  network: Network,
  tx: PreparedTransaction,
  executionContract: ExecutionContract = "xrpl_execution_v1",
): Promise<PreparedTransaction> {
  validatePreparedTransaction(tx);
  const needsAccount =
    executionContract === "xrpl_execution_v2" ||
    tx.Sequence === undefined ||
    tx.LastLedgerSequence === undefined;
  const needsFee = tx.Fee === undefined;
  const [accountResult, feeResult] = await Promise.all([
    needsAccount
      ? requestXrpl(ctx, network, "account_info", {
          account: tx.Account,
          ledger_index: "validated",
        })
      : Promise.resolve(undefined),
    needsFee
      ? requestXrpl(ctx, network, "fee")
      : Promise.resolve(undefined),
  ]);
  const filled = { ...tx };
  if (
    executionContract === "xrpl_execution_v2" &&
    accountResult?.validated !== true
  ) {
    throw new BuildValidationError(
      "v2 requires account_info from an explicitly validated ledger",
      "INVALID_BUILD",
    );
  }
  if (filled.Sequence === undefined) {
    filled.Sequence = requiredUInt32(
      asAccountData(accountResult!).Sequence,
      "account_data.Sequence",
    );
  }
  if (filled.Fee === undefined) filled.Fee = feeDrops(feeResult!);
  if (filled.LastLedgerSequence === undefined) {
    const validatedLedger =
      accountResult!.ledger_index ??
      (finiteInteger(feeResult?.ledger_current_index)
        ? feeResult.ledger_current_index - 1
        : undefined);
    filled.LastLedgerSequence =
      requiredUInt32(validatedLedger, "ledger_index") +
      (executionContract === "xrpl_execution_v2"
        ? V2_LAST_LEDGER_OFFSET
        : V1_LAST_LEDGER_OFFSET);
  }
  validatePreparedTransaction(filled);
  return filled;
}

/** Simulate an unsigned JSON transaction and expose only TxBuild's safe fields. */
const XRPL_ENGINE_RESULT_PATTERN =
  /^(?:tes|tec|tef|tem|ter|tel)[A-Z][A-Z0-9_]{0,47}$/;

function canonicalEngineResult(engineResult: unknown): string {
  if (
    typeof engineResult !== "string" ||
    !XRPL_ENGINE_RESULT_PATTERN.test(engineResult)
  ) {
    throw new Error("simulate response has invalid engine_result");
  }
  return engineResult;
}

function localSimulationMessage(engineResult: string): string {
  return engineResult === "tesSUCCESS"
    ? "The simulated transaction would succeed."
    : `XRPL simulation result: ${engineResult}.`;
}

export async function simulateUnsignedTransaction(
  ctx: BuildContext,
  network: Network,
  tx: PreparedTransaction,
): Promise<TxBuild["simulate"]> {
  validatePreparedTransaction(tx);
  // simulate is a dry run and does not submit or charge a fee:
  // https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/transaction-methods/simulate
  const result = await requestXrpl(ctx, network, "simulate", {
    tx_json: tx,
    binary: false,
  });
  if (
    typeof result.engine_result_message !== "string" ||
    result.applied !== false
  ) {
    throw new Error("simulate response is missing required result fields");
  }
  const engineResult = canonicalEngineResult(result.engine_result);
  return {
    engine_result: engineResult,
    // rippled's message is provider-controlled text. Preserve TxBuild's shape
    // while exposing only a deterministic local rendering of the validated
    // canonical engine-result code.
    engine_result_message: localSimulationMessage(engineResult),
    applied: false,
  };
}

type StableAsset = { currency: string; issuer: string };

function xrplCurrencyCode(value: string): string | undefined {
  if (/^[A-Fa-f0-9]{40}$/.test(value)) return value.toUpperCase();
  if (value.length === 3) return value;
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength === 0 || bytes.byteLength > 20) return undefined;
  return [...bytes, ...new Array<number>(20 - bytes.byteLength).fill(0)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function configuredStableAsset(
  ctx: BuildContext,
  network: Network | undefined,
): StableAsset | undefined {
  if (network === undefined || !isRecord(ctx.env)) return undefined;
  const suffix = network.toUpperCase().replaceAll("-", "_");
  const currency = ctx.env.STABLE_CODE;
  const issuer = ctx.env[`STABLE_ISSUER_${suffix}`];
  if (typeof currency !== "string" || typeof issuer !== "string") {
    return undefined;
  }
  const normalizedCurrency = xrplCurrencyCode(currency);
  return normalizedCurrency === undefined
    ? undefined
    : { currency: normalizedCurrency, issuer };
}

function stableAssets(
  ctx: BuildContext,
  network: Network | undefined,
): StableAsset[] {
  const assets: StableAsset[] = [];
  if (network === undefined || network === "mainnet") {
    assets.push({
      currency: RLUSD_HEX_CURRENCY,
      issuer: MAINNET_RLUSD_ISSUER,
    });
  } else if (network === "testnet") {
    assets.push({
      currency: RLUSD_HEX_CURRENCY,
      issuer: TESTNET_RLUSD_ISSUER,
    });
  }
  const configured = configuredStableAsset(ctx, network);
  if (
    configured !== undefined &&
    !assets.some(
      ({ currency, issuer }) =>
        currency === configured.currency && issuer === configured.issuer,
    )
  ) {
    assets.push(configured);
  }
  return assets;
}

function matchesStableAsset(amount: Exclude<XrplAmount, string>, asset: StableAsset): boolean {
  const currency =
    amount.currency.length === 40
      ? amount.currency.toUpperCase()
      : amount.currency;
  return currency === asset.currency && amount.issuer === asset.issuer;
}

function amountParts(
  amount: XrplAmount,
  recognizedStable: readonly StableAsset[] = [],
): { kind: "xrp" | "rlusd" | "other"; value: number } {
  if (typeof amount === "string") {
    if (!DROPS.test(amount)) return { kind: "other", value: Number.NaN };
    return { kind: "xrp", value: Number(amount) / 1_000_000 };
  }
  const numeric = Number(amount.value);
  const isRlusd = recognizedStable.some((asset) =>
    matchesStableAsset(amount, asset),
  );
  return {
    kind: isRlusd ? "rlusd" : "other",
    value: numeric,
  };
}

function topOfferPrice(result: Record<string, unknown>): number {
  if (!Array.isArray(result.offers) || !isRecord(result.offers[0])) {
    throw new Error("mainnet XRP/RLUSD book has no offers");
  }
  const offer = result.offers[0];
  const mainnetRlusd = [{
    currency: RLUSD_HEX_CURRENCY,
    issuer: MAINNET_RLUSD_ISSUER,
  }];
  const gets = amountParts(
    offer.taker_gets_funded as XrplAmount ?? offer.TakerGets as XrplAmount,
    mainnetRlusd,
  );
  const pays = amountParts(
    offer.taker_pays_funded as XrplAmount ?? offer.TakerPays as XrplAmount,
    mainnetRlusd,
  );
  const xrp = gets.kind === "xrp" ? gets.value : pays.kind === "xrp" ? pays.value : Number.NaN;
  const stable = gets.kind === "rlusd" ? gets.value : pays.kind === "rlusd" ? pays.value : Number.NaN;
  const price = stable / xrp;
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("mainnet XRP/RLUSD book has an invalid top offer");
  }
  return price;
}

async function readUsdMid(ctx: BuildContext): Promise<number> {
  const rlusd = { currency: RLUSD_HEX_CURRENCY, issuer: MAINNET_RLUSD_ISSUER };
  // book_offers request fields are documented at:
  // https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/path-and-order-book-methods/book_offers
  const [asks, bids] = await Promise.all([
    requestXrpl(ctx, "mainnet", "book_offers", {
      taker_gets: { currency: "XRP" },
      taker_pays: rlusd,
      ledger_index: "validated",
      limit: 1,
    }),
    requestXrpl(ctx, "mainnet", "book_offers", {
      taker_gets: rlusd,
      taker_pays: { currency: "XRP" },
      ledger_index: "validated",
      limit: 1,
    }),
  ]);
  return (topOfferPrice(asks) + topOfferPrice(bids)) / 2;
}

async function cachedUsdMid(ctx: BuildContext, now: Date): Promise<number> {
  const timestamp = now.getTime();
  if (usdMidCache !== undefined && timestamp < usdMidCache.expiresAt) {
    return usdMidCache.value;
  }
  pendingUsdMid ??= readUsdMid(ctx);
  try {
    const value = await pendingUsdMid;
    usdMidCache = { value, expiresAt: timestamp + USD_MID_CACHE_MS };
    return value;
  } finally {
    pendingUsdMid = undefined;
  }
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("USD valuation is not finite");
  }
  return value.toFixed(6).replace(/(?:\.0+|(?:(\.\d*?)0+))$/, "$1");
}

/** Value XRP from the cached mainnet XRP/RLUSD mid and RLUSD at exactly $1. */
export async function estimateUsdValue(
  ctx: BuildContext,
  input: UsdValuationInput,
): Promise<string | undefined> {
  if (input.amounts.length === 0) return undefined;
  const recognizedStable = stableAssets(ctx, input.network);
  const parsed = input.amounts.map((amount) =>
    amountParts(amount, recognizedStable),
  );
  const known = parsed.filter(
    ({ kind, value }) => kind !== "other" && Number.isFinite(value),
  );
  if (known.length === 0) return undefined;
  const needsMid = known.some(({ kind }) => kind === "xrp");
  const xrpMid = needsMid ? await cachedUsdMid(ctx, input.now ?? new Date()) : 0;
  const values = known.map(({ kind, value }) =>
    Math.abs(value) * (kind === "xrp" ? xrpMid : 1),
  );
  return formatUsd(
    input.aggregation === "max"
      ? Math.max(...values)
      : values.reduce((sum, value) => sum + value, 0),
  );
}

export function clearUsdMidCache(): void {
  usdMidCache = undefined;
  pendingUsdMid = undefined;
}

function resolveStore(ctx: BuildContext): BuildStore {
  if (ctx.store !== undefined) return ctx.store;
  if (ctx.db !== undefined) return createStore(ctx.db, ctx.principal);
  if (isRecord(ctx.env) && ctx.env.DB !== undefined) {
    return createStore(ctx.env.DB as D1Database, ctx.principal);
  }
  throw new BuildValidationError(
    "A principal-scoped build store is required",
    "INVALID_BUILD",
  );
}

export async function persistBuild(
  ctx: BuildContext,
  build: TxBuild,
  createdAt: Date = new Date(),
  v2Persistence?: V2BuildPersistence,
): Promise<void> {
  validatePreparedTransaction(build.tx_json, build.summary.account);
  const lastLedger = build.tx_json.LastLedgerSequence;
  if (!finiteInteger(lastLedger)) {
    throw new BuildValidationError(
      "Autofilled transaction is missing LastLedgerSequence",
      "INVALID_TRANSACTION",
    );
  }
  let originProfile: BuildInsert["originProfile"];
  if (localTradingIsolatedOnboardingV1MarkersPresent(ctx.env)) {
    if (!isReviewedLocalTradingIsolatedOnboardingV1Context(ctx)) {
      throw new BuildValidationError(
        "Invalid local trading isolated v1 onboarding profile",
        "INVALID_BUILD",
      );
    }
    originProfile = LOCAL_TRADING_ISOLATED_ONBOARDING_V1_BUILD_ORIGIN;
  } else if (localTradingIsolatedV1MarkersPresent(ctx.env)) {
    if (!isReviewedLocalTradingIsolatedV1Context(ctx)) {
      throw new BuildValidationError(
        "Invalid local trading isolated v1 profile",
        "INVALID_BUILD",
      );
    }
    originProfile = LOCAL_TRADING_ISOLATED_V1_BUILD_ORIGIN;
  } else if (localTradingOnboardingMarkersPresent(ctx.env)) {
    originProfile = LOCAL_TRADING_ONBOARDING_BUILD_ORIGIN;
  } else if (localTradingMarkersPresent(ctx.env)) {
    originProfile = LOCAL_TRADING_BUILD_ORIGIN;
  } else {
    originProfile = null;
  }
  await resolveStore(ctx).insertBuild({
    id: build.build_id,
    owner: build.summary.account,
    network: build.network,
    txJson: build.tx_json,
    summary: build.summary,
    lastLedgerSeq: lastLedger,
    createdAt: createdAt.toISOString(),
    originProfile,
    ...v2Persistence,
  });
}

export function canonicalizeJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("JCS does not permit non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError("JCS input must contain only JSON values");
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

async function sha256Upper(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalizeJson(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

export async function v2CanonicalBindings(
  txJson: Readonly<Record<string, unknown>>,
  owner: string,
  network: Network,
): Promise<{ unsignedTxDigest: string; economicFingerprint: string }> {
  const unsignedExcluded = new Set(["SigningPubKey", "TxnSignature", "Signers"]);
  const economicExcluded = new Set([
    "Fee", "Sequence", "LastLedgerSequence", "SigningPubKey", "TxnSignature",
    "Signers", "Delegate",
  ]);
  const unsignedTransaction = Object.fromEntries(
    Object.entries(txJson).filter(([key]) => !unsignedExcluded.has(key)),
  );
  const economicTransaction = Object.fromEntries(
    Object.entries(txJson).filter(([key]) => !economicExcluded.has(key)),
  );
  return {
    unsignedTxDigest: await sha256Upper(unsignedTransaction),
    economicFingerprint: await sha256Upper({ owner, network, transaction: economicTransaction }),
  };
}

async function v2Capability(
  input: BuildInput,
  txJson: PreparedTransaction,
): Promise<ExecutionCapability> {
  const lastLedger = requiredUInt32(txJson.LastLedgerSequence, "LastLedgerSequence");
  const buildLedger = lastLedger - V2_LAST_LEDGER_OFFSET;
  const invariantLedger = input.acquisition_balance_invariant?.ledger_index;
  const takerPays = txJson.TakerPays;
  const acquiresOfficialTestnetRlusd =
    input.network === "testnet" &&
    txJson.TransactionType === "OfferCreate" &&
    typeof takerPays === "object" &&
    takerPays !== null &&
    !Array.isArray(takerPays) &&
    String((takerPays as Record<string, unknown>).currency).toUpperCase() ===
      RLUSD_HEX_CURRENCY &&
    (takerPays as Record<string, unknown>).issuer === TESTNET_RLUSD_ISSUER;
  if (acquiresOfficialTestnetRlusd && invariantLedger === undefined) {
    throw new BuildValidationError(
      "official testnet RLUSD acquisition requires a validated balance invariant",
      "INVALID_BUILD",
    );
  }
  if (
    invariantLedger !== undefined &&
    (invariantLedger > buildLedger || buildLedger - invariantLedger > 1)
  ) {
    throw new BuildValidationError(
      "official testnet RLUSD balance evidence must be from the build ledger or the immediately preceding validated ledger",
      "EXECUTION_SNAPSHOT_STALE",
    );
  }
  const bindings = await v2CanonicalBindings(txJson, input.owner, input.network);
  const quoteLedger = input.validated_ledger_reference?.ledger_index;
  return {
    execution_contract: "xrpl_execution_v2",
    build_revision: 1,
    unsigned_tx_digest: bindings.unsignedTxDigest,
    unsigned_tx_digest_alg: "sha256-jcs-v1",
    economic_fingerprint: bindings.economicFingerprint,
    economic_fingerprint_alg: "sha256-jcs-economic-v1",
    build_ledger: buildLedger,
    first_inclusion_ledger: buildLedger + 1,
    last_ledger_sequence: lastLedger,
    minimum_remaining_ledgers: 8,
    approval_expires_in_seconds: 90,
    ...(quoteLedger === undefined
      ? {}
      : {
          quote_ledger: quoteLedger,
          quote_valid_through_ledger: quoteLedger + 1,
        }),
    ...(input.acquisition_balance_invariant === undefined
      ? {}
      : { acquisition_balance_invariant: input.acquisition_balance_invariant }),
  };
}

export function hasPreflightFailures(
  checks: readonly PreflightCheck[],
): boolean {
  return checks.some(({ pass }) => !pass);
}

async function isDelegableBuild(
  store: BuildStore,
  owner: string,
  network: Network,
  transactionType: string,
): Promise<boolean> {
  if (!isHarborDelegableTransactionType(transactionType)) return false;
  if (store.getLink === undefined) return false;
  const link = await store.getLink(owner, network);
  return (
    link?.status === "active" && link.permissions.includes(transactionType)
  );
}

/** Main validate -> preflight -> autofill -> simulate -> principal-store pipeline. */
export async function buildTransaction(
  ctx: BuildContext,
  input: BuildInput,
): Promise<TxBuild> {
  const executionContract = assertExecutionContractSupported(
    ctx,
    input.execution_contract,
  );
  if (!ctx.principal?.trim()) {
    throw new BuildValidationError("principal is required", "INVALID_BUILD");
  }
  if (input.network === "mainnet") {
    throw new BuildValidationError(
      "Mainnet transaction building is disabled; only valuation reads are allowed",
      "MAINNET_EXECUTION_DISABLED",
    );
  }
  if (!input.owner || !input.action || !Array.isArray(input.amounts)) {
    throw new BuildValidationError(
      "owner, action, and amounts are required",
      "INVALID_BUILD",
    );
  }
  if (input.tx_json.LastLedgerSequence !== undefined) {
    throw new BuildValidationError(
      "LastLedgerSequence is assigned by Harbor",
      "INVALID_BUILD",
    );
  }
  if (executionContract === "xrpl_execution_v2" && input.tx_json.Fee !== undefined) {
    throw new BuildValidationError(
      "Fee is assigned by Harbor for xrpl_execution_v2",
      "INVALID_BUILD",
    );
  }
  validatePreparedTransaction(input.tx_json, input.owner);
  const buildId = input.build_id ?? crypto.randomUUID();
  const tagged = tagPreparedTransaction(
    input.tx_json,
    sourceTag(ctx),
    input.intent_id ?? buildId,
  );
  const preflightOptions: PreflightOptions = {
    ...input.preflight,
    reserveDeltaDrops:
      input.preflight?.reserveDeltaDrops ?? input.reserve_delta_drops ?? "0",
  };
  const preflight = await runPreflightChecks(
    ctx,
    input.network,
    input.owner,
    tagged,
    preflightOptions,
    input.now,
  );
  const txJson = await autofillUnsignedTransaction(
    ctx,
    input.network,
    tagged,
    executionContract,
  );
  if (input.validated_ledger_reference !== undefined) {
    const { ledger_index: referenceLedger, max_ledger_gap: maxLedgerGap } =
      input.validated_ledger_reference;
    if (
      !Number.isSafeInteger(referenceLedger) ||
      referenceLedger < 1 ||
      !Number.isSafeInteger(maxLedgerGap) ||
      maxLedgerGap < 0
    ) {
      throw new BuildValidationError(
        "validated ledger reference is invalid",
        "INVALID_BUILD",
      );
    }
    const lastLedgerSequence = requiredUInt32(
      txJson.LastLedgerSequence,
      "LastLedgerSequence",
    );
    const buildLedger =
      lastLedgerSequence -
      (executionContract === "xrpl_execution_v2"
        ? V2_LAST_LEDGER_OFFSET
        : V1_LAST_LEDGER_OFFSET);
    const ledgerGap = buildLedger - referenceLedger;
    const effectiveMaxGap =
      executionContract === "xrpl_execution_v2" ? 1 : maxLedgerGap;
    if (buildLedger < 1 || ledgerGap < 0 || ledgerGap > effectiveMaxGap) {
      throw new BuildValidationError(
        `Validated ledger reference is stale or mismatched (quote ${referenceLedger}, build ${buildLedger}, maximum gap ${effectiveMaxGap})`,
        executionContract === "xrpl_execution_v2"
          ? "QUOTE_EXPIRED"
          : "STALE_LEDGER_REFERENCE",
      );
    }
  }
  const simulate = await simulateUnsignedTransaction(ctx, input.network, txJson);
  if (
    input.require_simulation_success === true &&
    simulate.engine_result !== "tesSUCCESS"
  ) {
    throw new BuildValidationError(
      `Exact transaction simulation returned ${simulate.engine_result}`,
      "SIMULATION_FAILED",
    );
  }
  const usdValue =
    input.valuation_amounts === undefined
      ? undefined
      : await estimateUsdValue(ctx, {
          amounts: input.valuation_amounts,
          now: input.now,
          network: input.network,
          aggregation:
            txJson.TransactionType === "OfferCreate" ? "max" : "sum",
        });
  const transactionType = txJson.TransactionType as string;
  const store = resolveStore(ctx);
  const executionCapability =
    executionContract === "xrpl_execution_v2"
      ? await v2Capability(input, txJson)
      : undefined;
  const build: TxBuild = {
    build_id: buildId,
    network: input.network,
    tx_json: txJson,
    // Delegability is ledger-link state, never a caller assertion. Link status
    // is evaluated later by policy; this records only the granted permission.
    delegable: await isDelegableBuild(
      store,
      input.owner,
      input.network,
      transactionType,
    ),
    simulate,
    preflight,
    summary: {
      action: input.action,
      account: input.owner,
      amounts: [...input.amounts],
      fee_drops: txJson.Fee as string,
      reserve_delta_drops: preflightOptions.reserveDeltaDrops ?? "0",
      ...(input.est_slippage_bps === undefined
        ? {}
        : { est_slippage_bps: input.est_slippage_bps }),
      ...(usdValue === undefined ? {} : { usd_value: usdValue }),
    },
    ...(executionCapability === undefined
      ? {}
      : { execution_capability: executionCapability }),
  };
  await persistBuild(
    { ...ctx, store },
    build,
    input.now,
    executionCapability === undefined
      ? undefined
      : {
          executionContract: "xrpl_execution_v2",
          buildRevision: 1,
          unsignedTxDigest: executionCapability.unsigned_tx_digest,
          unsignedTxDigestAlg: executionCapability.unsigned_tx_digest_alg,
          economicFingerprint: executionCapability.economic_fingerprint,
          economicFingerprintAlg:
            executionCapability.economic_fingerprint_alg,
          buildLedger: executionCapability.build_ledger,
          firstInclusionLedger: executionCapability.first_inclusion_ledger,
          quoteLedger: executionCapability.quote_ledger ?? null,
          quoteValidThroughLedger:
            executionCapability.quote_valid_through_ledger ?? null,
          executionCapability,
        },
  );
  return build;
}

/**
 * Minimal Store-row rehydration seam for execution: repeat live preflight and
 * simulation immediately before policy/signing. Store intentionally persists
 * only the fixed schema's transaction and summary.
 */
export async function revalidateStoredBuild(
  ctx: BuildContext,
  build: StoredBuildLike | BuildRow,
  preflight: PreflightOptions = {},
  now: Date = new Date(),
): Promise<RevalidatedBuild> {
  if (build.network === "mainnet") {
    throw new BuildValidationError(
      "Mainnet transaction revalidation is disabled",
      "MAINNET_EXECUTION_DISABLED",
    );
  }
  validatePreparedTransaction(build.txJson, build.owner);
  const effectivePreflight: PreflightOptions = {
    ...preflight,
    reserveDeltaDrops:
      preflight.reserveDeltaDrops ??
      ("summary" in build && isRecord(build.summary)
        ? typeof build.summary.reserve_delta_drops === "string"
          ? build.summary.reserve_delta_drops
          : undefined
        : undefined),
  };
  const checks = await runPreflightChecks(
    ctx,
    build.network,
    build.owner,
    build.txJson,
    effectivePreflight,
    now,
  );
  const simulate = await simulateUnsignedTransaction(
    ctx,
    build.network,
    build.txJson,
  );
  return { preflight: checks, simulate };
}
