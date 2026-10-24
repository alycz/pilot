import { isValidClassicAddress } from "xrpl";
import { z } from "zod";

import { requestXrpl } from "../adapters/xrpl-rpc";
import { readKmsMode, type KmsEnv } from "../aws/kms";
import type { OpContext, OpDef } from "../catalog/registry";
import type { Policy } from "../contracts";
import { DEFAULT_DELEGATED_PERMISSIONS, normalizeDelegatePermissions } from "../exec/delegation";
import {
  withDelegateSigner,
  type DelegateIdentity,
  type StoredDelegateKey,
} from "../exec/keys";
import {
  createKmsDelegateClient,
  readKmsDelegatePublicIdentity,
  type KmsPublicKeyClient,
} from "../exec/kms-signer";
import {
  Store,
  type BuildRow,
  type ExecutionRow,
  type LinkRow,
  type PolicyRow,
} from "../exec/store";
import {
  LOCAL_TRADING_ONBOARDING_BUILD_ORIGIN,
  isReviewedLocalTradingOnboardingContext,
} from "../local-trading-onboarding";
import {
  LOCAL_TRADING_ISOLATED_ONBOARDING_V1_BUILD_ORIGIN,
  isReviewedLocalTradingIsolatedOnboardingV1Context,
  localTradingIsolatedOnboardingV1MarkersPresent,
} from "../local-trading-isolated-onboarding-v1";
import { SafePolicySchema } from "./policy";

const OwnerSchema = z
  .string()
  .refine(isValidClassicAddress, "owner must be a valid XRPL classic address");
const HashSchema = z.string().regex(/^[A-Fa-f0-9]{64}$/, "hash must be 64 hexadecimal characters");

export const OnboardingReadinessArgsSchema = z
  .object({
    owner: OwnerSchema,
    network: z.literal("testnet"),
    expected_policy: SafePolicySchema,
    trust_set_hash: HashSchema,
  })
  .strict();

export type OnboardingReadinessArgs = z.infer<typeof OnboardingReadinessArgsSchema>;

type ReadinessStore = Pick<
  Store,
  "getLink" | "getPolicy" | "findExecutionByHash" | "getBuild"
>;

type ReadDelegate = (
  network: "testnet",
  owner: string,
  delegate: string,
) => Promise<Record<string, unknown> | null>;

type AttestDelegate = (
  identity: DelegateIdentity,
  wrapped: StoredDelegateKey,
  kek: string,
) => Promise<boolean>;

type ReadTransaction = (
  ctx: OpContext,
  hash: string,
) => Promise<Record<string, unknown>>;

type ReadAccountLines = (
  ctx: OpContext,
  owner: string,
  issuer: string,
) => Promise<Record<string, unknown>>;

type ReadIssuerAccount = (
  ctx: OpContext,
  issuer: string,
  ledgerHash: string,
) => Promise<Record<string, unknown>>;

export interface OnboardingReadinessServices {
  store?: ReadinessStore;
  readDelegate?: ReadDelegate;
  attestDelegate?: AttestDelegate;
  kmsClient?: KmsPublicKeyClient;
  readTransaction?: ReadTransaction;
  readAccountLines?: ReadAccountLines;
  readIssuerAccount?: ReadIssuerAccount;
}

type ReadinessContext = OpContext & {
  db?: D1Database;
  env?: Record<string, unknown>;
  onboardingReadinessServices?: OnboardingReadinessServices;
};

export type OnboardingReadinessResult = {
  ready: boolean;
  scope: { owner: string; network: "testnet" };
  checks: {
    reviewed_runtime: boolean;
    exact_active_link: boolean;
    exact_persisted_policy: boolean;
    usable_encrypted_delegate: boolean;
    validated_trust_set: boolean;
    usable_trust_line: boolean;
  };
  evidence: {
    delegate?: string;
    link_ledger_index?: number;
    trust_set_hash?: string;
    trust_set_ledger_index?: number;
    trust_line_ledger_index?: number;
  };
};

const UNPROVEN_CHECKS: OnboardingReadinessResult["checks"] = Object.freeze({
  reviewed_runtime: false,
  exact_active_link: false,
  exact_persisted_policy: false,
  usable_encrypted_delegate: false,
  validated_trust_set: false,
  usable_trust_line: false,
});

function context(input: OpContext): ReadinessContext {
  return input as ReadinessContext;
}

function storeFor(input: OpContext, configured: OnboardingReadinessServices): ReadinessStore {
  if (configured.store) return configured.store;
  const db = context(input).db;
  if (!db) throw new Error("onboarding readiness store is not configured");
  return new Store(db, input.principal);
}

function environment(input: OpContext): Record<string, unknown> {
  const env = context(input).env;
  return typeof env === "object" && env !== null ? env : {};
}

function exactStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function exactPolicy(actual: Policy, expected: Policy): boolean {
  return (
    actual.max_per_tx_usd === expected.max_per_tx_usd &&
    actual.daily_cap_usd === expected.daily_cap_usd &&
    actual.execute_under_usd === expected.execute_under_usd &&
    actual.max_slippage_bps === expected.max_slippage_bps &&
    exactStrings(actual.allowed_tx_types, expected.allowed_tx_types) &&
    exactStrings(actual.issuer_allowlist, expected.issuer_allowlist) &&
    actual.block_requireauth_issuers === expected.block_requireauth_issuers &&
    exactStrings(actual.networks, expected.networks) &&
    actual.x402_max_per_call_drops === expected.x402_max_per_call_drops &&
    actual.x402_daily_cap_drops === expected.x402_daily_cap_drops
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeLedgerIndex(entry: Record<string, unknown>): number | undefined {
  for (const field of ["ledger_index", "ledgerIndex", "PreviousTxnLgrSeq"]) {
    const value = entry[field];
    if (Number.isSafeInteger(value) && (value as number) > 0) return value as number;
  }
  return undefined;
}

async function defaultReadDelegate(
  input: OpContext,
  owner: string,
  delegate: string,
): Promise<Record<string, unknown> | null> {
  const response = await requestXrpl(input, "testnet", "ledger_entry", {
    ledger_index: "validated",
    // Exact Delegate selector:
    // https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/ledger-methods/ledger_entry#delegate-object
    delegate: { account: owner, authorize: delegate },
  });
  if (
    response.validated !== true ||
    !isRecord(response.node) ||
    response.node.LedgerEntryType !== "Delegate"
  ) {
    throw new Error("validated Delegate evidence is malformed");
  }
  const index = response.ledger_index;
  if (!Number.isSafeInteger(index) || (index as number) < 1) {
    throw new Error("validated Delegate evidence is malformed");
  }
  return { ...response.node, ledger_index: index as number };
}

async function defaultAttestDelegate(
  identity: DelegateIdentity,
  wrapped: StoredDelegateKey,
  kek: string,
): Promise<boolean> {
  return withDelegateSigner(identity, wrapped, kek, (signer) =>
    signer.address === wrapped.address && signer.publicKey.length > 0,
  );
}

async function defaultReadTransaction(
  input: OpContext,
  hash: string,
): Promise<Record<string, unknown>> {
  // The tx method supplies fresh validated-ledger evidence for handoff:
  // https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/transaction-methods/tx
  return requestXrpl(input, "testnet", "tx", {
    transaction: hash,
    binary: false,
  });
}

async function defaultReadAccountLines(
  input: OpContext,
  owner: string,
  issuer: string,
): Promise<Record<string, unknown>> {
  // Peer-filtered trust lines at a validated ledger:
  // https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/account-methods/account_lines
  return requestXrpl(input, "testnet", "account_lines", {
    account: owner,
    peer: issuer,
    ledger_index: "validated",
    limit: 400,
  });
}

async function defaultReadIssuerAccount(
  input: OpContext,
  issuer: string,
  ledgerHash: string,
): Promise<Record<string, unknown>> {
  // Read the issuer at the same validated ledger as the trust line so an
  // authorization decision cannot mix ledger snapshots.
  // https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/account-methods/account_info
  return requestXrpl(input, "testnet", "account_info", {
    account: issuer,
    ledger_hash: ledgerHash,
  });
}

function transactionJson(response: Record<string, unknown>): Record<string, unknown> {
  return isRecord(response.tx_json) ? response.tx_json : response;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === null || right === null) return left === right;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]))
    );
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      exactStrings(leftKeys, rightKeys) &&
      leftKeys.every((key) => sameJson(left[key], right[key]))
    );
  }
  if (typeof left !== typeof right) return false;
  if (typeof left === "number") {
    return Number.isFinite(left) && Number.isFinite(right) && Object.is(left, right);
  }
  return (
    (typeof left === "string" || typeof left === "boolean") &&
    left === right
  );
}

type ExactDecimal = { coefficient: bigint; exponent: number };

function exactIssuedDecimal(value: unknown): ExactDecimal | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) return undefined;
  const explicitExponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(explicitExponent)) return undefined;

  let digits = `${match[2]}${match[3] ?? ""}`.replace(/^0+/, "");
  let exponent = explicitExponent - (match[3]?.length ?? 0);
  if (digits.length === 0) return { coefficient: 0n, exponent: 0 };
  while (digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    exponent += 1;
  }
  // Issued-currency values have at most 16 significant digits and decimal
  // magnitude -96 through 80. Enforcing those bounds also keeps exact bigint
  // comparison computationally bounded for hostile responses.
  const magnitude = exponent + digits.length - 1;
  if (digits.length > 16 || magnitude < -96 || magnitude > 80) return undefined;
  const coefficient = BigInt(digits) * (match[1] === "-" ? -1n : 1n);
  return { coefficient, exponent };
}

function compareExactDecimals(left: ExactDecimal, right: ExactDecimal): number {
  const exponent = Math.min(left.exponent, right.exponent);
  const leftScaled = left.coefficient * 10n ** BigInt(left.exponent - exponent);
  const rightScaled = right.coefficient * 10n ** BigInt(right.exponent - exponent);
  return leftScaled < rightScaled ? -1 : leftScaled > rightScaled ? 1 : 0;
}

function exactLimitAmount(build: BuildRow): {
  currency: string;
  issuer: string;
  value: ExactDecimal;
} | undefined {
  const amount = build.txJson.LimitAmount;
  if (!isRecord(amount)) return undefined;
  const value = exactIssuedDecimal(amount.value);
  if (
    typeof amount.currency !== "string" ||
    amount.currency.length === 0 ||
    typeof amount.issuer !== "string" ||
    !isValidClassicAddress(amount.issuer) ||
    value === undefined ||
    value.coefficient <= 0n
  ) {
    return undefined;
  }
  return { currency: amount.currency, issuer: amount.issuer, value };
}

function optionalBoolean(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  return value === undefined || typeof value === "boolean";
}

const REQUIRE_AUTH_FLAG = 0x0004_0000;
const GLOBAL_FREEZE_FLAG = 0x0040_0000;

async function attestUsableTrustLine(
  input: OpContext,
  configured: OnboardingReadinessServices,
  owner: string,
  build: BuildRow,
): Promise<{ pass: boolean; ledgerIndex?: number }> {
  const expected = exactLimitAmount(build);
  if (!expected) return { pass: false };

  const linesResult = await (configured.readAccountLines ?? defaultReadAccountLines)(
    input,
    owner,
    expected.issuer,
  );
  const ledgerIndex = linesResult.ledger_index;
  const ledgerHash = linesResult.ledger_hash;
  if (
    linesResult.validated !== true ||
    linesResult.account !== owner ||
    !Number.isSafeInteger(ledgerIndex) ||
    (ledgerIndex as number) < 1 ||
    typeof ledgerHash !== "string" ||
    !/^[A-Fa-f0-9]{64}$/.test(ledgerHash) ||
    !Array.isArray(linesResult.lines) ||
    linesResult.lines.length > 400 ||
    linesResult.marker !== undefined
  ) {
    return { pass: false };
  }

  const matches: Record<string, unknown>[] = [];
  for (const candidate of linesResult.lines) {
    if (
      !isRecord(candidate) ||
      typeof candidate.account !== "string" ||
      typeof candidate.currency !== "string"
    ) {
      return { pass: false };
    }
    if (
      candidate.account === expected.issuer &&
      candidate.currency === expected.currency
    ) {
      matches.push(candidate);
    }
  }
  if (matches.length !== 1) return { pass: false };

  const line = matches[0];
  for (const field of [
    "freeze",
    "freeze_peer",
    "deep_freeze",
    "deep_freeze_peer",
    "peer_authorized",
  ]) {
    if (!optionalBoolean(line, field)) return { pass: false };
  }
  if (
    line.freeze === true ||
    line.freeze_peer === true ||
    line.deep_freeze === true ||
    line.deep_freeze_peer === true
  ) {
    return { pass: false };
  }
  const limit = exactIssuedDecimal(line.limit);
  const balance = exactIssuedDecimal(line.balance);
  if (
    limit === undefined ||
    balance === undefined ||
    limit.coefficient <= 0n ||
    compareExactDecimals(limit, expected.value) !== 0 ||
    compareExactDecimals(limit, balance) <= 0
  ) {
    return { pass: false };
  }

  const issuerResult = await (configured.readIssuerAccount ?? defaultReadIssuerAccount)(
    input,
    expected.issuer,
    ledgerHash,
  );
  const accountData = issuerResult.account_data;
  if (
    issuerResult.validated !== true ||
    (issuerResult.ledger_hash !== undefined &&
      issuerResult.ledger_hash !== ledgerHash) ||
    issuerResult.ledger_index !== ledgerIndex ||
    !isRecord(accountData) ||
    accountData.Account !== expected.issuer ||
    !Number.isSafeInteger(accountData.Flags) ||
    (accountData.Flags as number) < 0 ||
    (accountData.Flags as number) > 0xffff_ffff
  ) {
    return { pass: false };
  }
  if (
    (((accountData.Flags as number) & GLOBAL_FREEZE_FLAG) !== 0) ||
    (((accountData.Flags as number) & REQUIRE_AUTH_FLAG) !== 0) &&
    line.peer_authorized !== true
  ) {
    return { pass: false };
  }
  return { pass: true, ledgerIndex: ledgerIndex as number };
}

function validatedTrustSet(
  response: Record<string, unknown>,
  hash: string,
  owner: string,
  build: BuildRow,
): { pass: boolean; ledgerIndex?: number } {
  const transaction = transactionJson(response);
  const metadata = isRecord(response.meta) ? response.meta : undefined;
  const responseHash = response.hash ?? transaction.hash;
  const ledgerIndex = response.ledger_index;
  const taggedFields = ["LimitAmount", "Flags", "SourceTag", "Memos"] as const;
  const exactBuildFields = taggedFields.every(
    (field) =>
      build.txJson[field] === undefined ||
      sameJson(transaction[field], build.txJson[field]),
  );
  const pass =
    response.validated === true &&
    typeof responseHash === "string" &&
    responseHash.toUpperCase() === hash &&
    Number.isSafeInteger(ledgerIndex) &&
    (ledgerIndex as number) > 0 &&
    metadata?.TransactionResult === "tesSUCCESS" &&
    transaction.TransactionType === "TrustSet" &&
    transaction.Account === owner &&
    build.txJson.SourceTag === 2610240 &&
    Array.isArray(build.txJson.Memos) &&
    isRecord(transaction.LimitAmount) &&
    isRecord(build.txJson.LimitAmount) &&
    exactBuildFields;
  return pass ? { pass: true, ledgerIndex: ledgerIndex as number } : { pass: false };
}

function exactStoredExecution(
  execution: ExecutionRow | null,
  build: BuildRow | null,
  principal: string,
  owner: string,
  hash: string,
  originProfile: BuildRow["originProfile"],
): build is BuildRow {
  return (
    execution !== null &&
    build !== null &&
    execution.principal === principal &&
    build.principal === principal &&
    execution.status === "executed" &&
    (execution.signedBy === "delegate" || execution.signedBy === "owner") &&
    execution.hash?.toUpperCase() === hash &&
    execution.buildId === build.id &&
    build.owner === owner &&
    build.network === "testnet" &&
    build.originProfile === originProfile &&
    build.txJson.TransactionType === "TrustSet" &&
    build.txJson.Account === owner
  );
}

async function attestLink(
  input: OpContext,
  configured: OnboardingReadinessServices,
  row: LinkRow,
  owner: string,
): Promise<{ pass: boolean; ledgerIndex?: number }> {
  if (
    row.principal !== input.principal ||
    row.owner !== owner ||
    row.network !== "testnet" ||
    row.status !== "active" ||
    !isValidClassicAddress(row.delegate) ||
    row.delegate === owner ||
    !exactStrings(row.permissions, DEFAULT_DELEGATED_PERMISSIONS)
  ) {
    return { pass: false };
  }
  const entry = configured.readDelegate
    ? await configured.readDelegate("testnet", owner, row.delegate)
    : await defaultReadDelegate(input, owner, row.delegate);
  if (entry === null) return { pass: false };
  const permissions = normalizeDelegatePermissions(entry, {
    owner,
    delegate: row.delegate,
  });
  if (!exactStrings(permissions, DEFAULT_DELEGATED_PERMISSIONS)) {
    return { pass: false };
  }
  const ledgerIndex = safeLedgerIndex(entry);
  return ledgerIndex === undefined
    ? { pass: false }
    : { pass: true, ledgerIndex };
}

async function attestStoredDelegate(
  input: OpContext,
  configured: OnboardingReadinessServices,
  row: LinkRow,
  owner: string,
): Promise<boolean> {
  if (row.keyBackend === "kms") {
    const env = environment(input) as KmsEnv;
    if (readKmsMode(env) !== "sign") return false;
    const client = configured.kmsClient ?? createKmsDelegateClient(env);
    const identity = await readKmsDelegatePublicIdentity(client, row.kmsAlias);
    return identity.address === row.delegate;
  }
  const kek = environment(input).HARBOR_KEK;
  if (
    typeof kek !== "string" ||
    kek.length === 0 ||
    !(row.delegateSeedEnc instanceof ArrayBuffer) ||
    row.delegateSeedEnc.byteLength === 0 ||
    !(row.iv instanceof ArrayBuffer) ||
    row.iv.byteLength !== 12
  ) {
    return false;
  }
  const identity = { principal: input.principal, owner, network: "testnet" } as const;
  const wrapped = {
    address: row.delegate,
    ciphertext: row.delegateSeedEnc,
    iv: row.iv,
  };
  return (configured.attestDelegate ?? defaultAttestDelegate)(identity, wrapped, kek);
}

export async function handleOnboardingReadiness(
  input: OpContext,
  rawArgs: OnboardingReadinessArgs,
): Promise<OnboardingReadinessResult> {
  const args = OnboardingReadinessArgsSchema.parse(rawArgs);
  const checks = { ...UNPROVEN_CHECKS };
  const evidence: OnboardingReadinessResult["evidence"] = {};
  const result = (): OnboardingReadinessResult => ({
    ready: Object.values(checks).every(Boolean),
    scope: { owner: args.owner, network: "testnet" },
    checks: { ...checks },
    evidence: { ...evidence },
  });

  const isolatedOnboarding =
    localTradingIsolatedOnboardingV1MarkersPresent(input.env);
  checks.reviewed_runtime = isolatedOnboarding
    ? isReviewedLocalTradingIsolatedOnboardingV1Context(input)
    : isReviewedLocalTradingOnboardingContext(input);
  if (!checks.reviewed_runtime) return result();
  const expectedBuildOrigin = isolatedOnboarding
    ? LOCAL_TRADING_ISOLATED_ONBOARDING_V1_BUILD_ORIGIN
    : LOCAL_TRADING_ONBOARDING_BUILD_ORIGIN;

  const configured = context(input).onboardingReadinessServices ?? {};
  let store: ReadinessStore;
  let row: LinkRow | null;
  try {
    store = storeFor(input, configured);
    row = await store.getLink(args.owner, "testnet");
  } catch {
    return result();
  }
  if (!row) return result();

  try {
    const link = await attestLink(input, configured, row, args.owner);
    checks.exact_active_link = link.pass;
    if (link.pass) {
      evidence.delegate = row.delegate;
      if (link.ledgerIndex !== undefined) evidence.link_ledger_index = link.ledgerIndex;
    }
  } catch {
    checks.exact_active_link = false;
  }

  try {
    const policy: PolicyRow | null = await store.getPolicy(args.owner, "testnet");
    checks.exact_persisted_policy =
      policy !== null &&
      policy.principal === input.principal &&
      policy.owner === args.owner &&
      policy.network === "testnet" &&
      exactPolicy(policy.json, args.expected_policy);
  } catch {
    checks.exact_persisted_policy = false;
  }

  try {
    checks.usable_encrypted_delegate = await attestStoredDelegate(
      input,
      configured,
      row,
      args.owner,
    );
  } catch {
    checks.usable_encrypted_delegate = false;
  }

  const hash = args.trust_set_hash.toUpperCase();
  try {
    const execution = await store.findExecutionByHash(hash);
    const build = execution ? await store.getBuild(execution.buildId) : null;
    if (
      exactStoredExecution(
        execution,
        build,
        input.principal,
        args.owner,
        hash,
        expectedBuildOrigin,
      )
    ) {
      const response = await (configured.readTransaction ?? defaultReadTransaction)(input, hash);
      const trustSet = validatedTrustSet(response, hash, args.owner, build);
      checks.validated_trust_set = trustSet.pass;
      if (trustSet.pass) {
        evidence.trust_set_hash = hash;
        evidence.trust_set_ledger_index = trustSet.ledgerIndex;
        try {
          const trustLine = await attestUsableTrustLine(
            input,
            configured,
            args.owner,
            build,
          );
          checks.usable_trust_line = trustLine.pass;
          if (trustLine.pass) {
            evidence.trust_line_ledger_index = trustLine.ledgerIndex;
          }
        } catch {
          checks.usable_trust_line = false;
        }
      }
    }
  } catch {
    checks.validated_trust_set = false;
  }

  return result();
}

export const ops: OpDef[] = [
  {
    name: "onboarding.readiness",
    family: "onboarding",
    summary: "Attest whether the authenticated local Testnet onboarding state is safe to hand off.",
    tags: ["onboarding", "readiness", "delegation", "policy"],
    args: z
      .object({
        owner: OwnerSchema,
        network: z.literal("testnet"),
        expected_policy: SafePolicySchema,
        trust_set_hash: HashSchema,
      })
      .strict(),
    returns: "OnboardingReadinessResult",
    caveats: [],
    example:
      'await harbor.onboarding.readiness({ owner: "r...", network: "testnet", expected_policy: policy, trust_set_hash: "64_HEX_TRANSACTION_HASH" })',
    handler: (ctx, args) =>
      handleOnboardingReadiness(ctx, OnboardingReadinessArgsSchema.parse(args)),
  },
];
