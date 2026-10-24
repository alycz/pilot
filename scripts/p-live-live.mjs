#!/usr/bin/env node

import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { Client, Wallet, hashes, isValidClassicAddress } from "xrpl";

const SECRET_FILE =
  process.env.P_LIVE_SECRET_FILE ??
  "/absolute/private/pilot/pilot-secrets/p-live.env.local";
const PILOT_ENV_FILE =
  process.env.PILOT_ENV_FILE ??
  "/absolute/private/pilot/pilot-secrets/pilot.env.local";
const ACQUISITION_STATE_FILE =
  process.env.P_LIVE_ACQUISITION_STATE_FILE ??
  "/absolute/private/pilot/pilot-state/p-live-rlusd-acquisition.json";

const TESTNET_HTTP = "https://s.altnet.rippletest.net:51234";
const TESTNET_WS = "wss://s.altnet.rippletest.net:51233";
const TESTNET_FAUCET = "https://faucet.altnet.rippletest.net/accounts";
const DEVNET_HTTP = "https://s.devnet.rippletest.net:51234";
const DEVNET_WS = "wss://s.devnet.rippletest.net:51233";
const DEVNET_FAUCET = "https://faucet.devnet.rippletest.net/accounts";
const RLUSD_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const RLUSD_CURRENCY = "524C555344000000000000000000000000000000";
const RLUSD_ACQUISITION_AMOUNT = "75";
const RLUSD_ACQUISITION_XRP_CAP_DROPS = 275_000_000n;
const RLUSD_ACQUISITION_HEADROOM_DROPS = 20_000_100n;
const ACCOUNT_LSF_REQUIRE_AUTH = 0x0004_0000;
const ACCOUNT_LSF_GLOBAL_FREEZE = 0x0040_0000;
const OFFER_TF_FILL_OR_KILL = 0x0004_0000;
const OFFER_TF_SELL = 0x0008_0000;
const RLUSD_ACQUISITION_SLIPPAGE_BPS = 100;
const HARBOR_EXACT_OUTPUT_ROUNDING_REFERENCE =
  "xrpl-exact-output-rounding-v1";
const LEGACY_HARBOR_EXACT_OUTPUT_ROUNDING_REFERENCE =
  "xrpl-exact-output-rounding-legacy-v0";
const MAX_EXACT_OUTPUT_QUOTE_LEDGER_GAP = 1;
const MAX_AMM_REFERENCE_LEDGER_AGE = 4;
const DEVNET_VAULT_ID =
  "148D87773B3AB1A29179C3EC34944720C7C5C468D5D4FC2974609CACF434BD6F";
const DEFAULT_PERMISSIONS = Object.freeze([
  "OfferCreate",
  "OfferCancel",
  "TrustSet",
  "AMMDeposit",
  "AMMWithdraw",
  "EscrowFinish",
  "CheckCash",
]);
const OFFER_CREATE_ONLY_PERMISSIONS = Object.freeze(["OfferCreate"]);

function parseEnv(text) {
  const result = Object.create(null);
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    let value = match[2];
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

async function loadEnv(path) {
  return parseEnv(await readFile(path, "utf8"));
}

const ACQUISITION_STATUSES = new Set([
  "initialized",
  "ready",
  "built",
  "signed_pending",
  "validated",
  "expired_unsubmitted",
  "expired_unincluded",
]);

export function assertAcquisitionStateBinding(state, { operationId, owner }) {
  if (
    !isRecord(state) || ![2, 3].includes(state.version) ||
    state.operation_id !== operationId || state.owner !== owner ||
    state.network !== "testnet" || state.issuer !== RLUSD_ISSUER ||
    state.currency !== RLUSD_CURRENCY || state.amount !== RLUSD_ACQUISITION_AMOUNT ||
    state.cap_drops !== RLUSD_ACQUISITION_XRP_CAP_DROPS.toString() ||
    state.intent_id !== `p-live-acquire-rlusd-${operationId}` ||
    !ACQUISITION_STATUSES.has(state.status)
  ) throw new Error("Persisted RLUSD acquisition state does not match the exact approved operation");
  if (state.version === 2 && !["initialized", "ready"].includes(state.status)) {
    throw new Error("Legacy RLUSD acquisition state cannot carry a build or submission");
  }
  if (
    (state.status === "signed_pending" || state.status === "validated" || state.status === "expired_unincluded") &&
    (typeof state.hash !== "string" || !/^[A-F0-9]{64}$/.test(state.hash) ||
      !Number.isSafeInteger(state.last_ledger_sequence))
  ) throw new Error("Persisted RLUSD acquisition submission state is incomplete");
  if (state.status !== "initialized" && (
    typeof state.balance_before !== "string" ||
    !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(state.balance_before) ||
    !Number.isSafeInteger(state.balance_before_ledger_index) ||
    typeof state.funded_balance_drops !== "string" || !/^[1-9]\d*$/.test(state.funded_balance_drops)
  )) throw new Error("Persisted RLUSD acquisition preflight state is incomplete");
  if (state.version === 2 && state.status !== "initialized" && (
    !Number.isFinite(state.quoted_cap_xrp) || state.quoted_cap_xrp <= 0 ||
    state.quoted_cap_xrp * 1_000_000 > Number(RLUSD_ACQUISITION_XRP_CAP_DROPS) ||
    !Number.isSafeInteger(state.amm_ledger_index)
  )) throw new Error("Persisted RLUSD acquisition preflight state is incomplete");
  if (state.version === 3 && state.status !== "initialized") {
    assertAmmEligibilityReference(state.amm_eligibility_quote, owner);
  }
  if (state.version === 3 && ["built", "signed_pending", "validated", "expired_unsubmitted", "expired_unincluded"].includes(state.status)) {
    assertExactOutputQuoteReference(state.execution_quote, owner);
    if (
      state.status === "built" &&
      state.execution_quote.rounding_reference !== HARBOR_EXACT_OUTPUT_ROUNDING_REFERENCE
    ) throw new Error("Persisted unsigned RLUSD acquisition quote reference is obsolete");
  }
  if (["built", "signed_pending", "validated", "expired_unsubmitted", "expired_unincluded"].includes(state.status) && (
    typeof state.build_id !== "string" || state.build_id.length === 0 || !isRecord(state.tx_json)
  )) throw new Error("Persisted RLUSD acquisition build state is incomplete");
  if (state.status === "validated" && (
    !Number.isSafeInteger(state.ledger_index) || state.ledger_index < 1 ||
    !Number.isSafeInteger(state.balance_after_ledger_index) || state.balance_after_ledger_index < 1 ||
    state.balance_after_ledger_index < state.ledger_index ||
    typeof state.balance_after !== "string" ||
    !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(state.balance_after) ||
    typeof state.maximum_offer_spend_drops !== "string" ||
    !/^[1-9]\d*$/.test(state.maximum_offer_spend_drops)
  )) throw new Error("Persisted RLUSD acquisition completion state is incomplete");
  if (state.status === "validated") {
    assertExactRlusdBalanceDelta(state.balance_before, state.balance_after, RLUSD_ACQUISITION_AMOUNT);
  }
  return state;
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])]),
    );
  }
  return value;
}

function acquisitionStateDigest(state, integrityKey) {
  const { integrity: _ignored, ...unsigned } = state;
  return createHmac("sha256", integrityKey)
    .update(`pilot-p-live-rlusd-acquisition-state-v${state.version}\0`)
    .update(JSON.stringify(canonicalJsonValue(unsigned)))
    .digest("hex");
}

export function sealAcquisitionState(state, integrityKey) {
  if (typeof integrityKey !== "string" || integrityKey.length < 16) {
    throw new Error("Acquisition state integrity key is unavailable");
  }
  const { integrity: _ignored, ...unsigned } = state;
  return { ...unsigned, integrity: acquisitionStateDigest(unsigned, integrityKey) };
}

export function assertAcquisitionStateIntegrity(state, integrityKey) {
  if (!isRecord(state) || typeof state.integrity !== "string" || !/^[a-f0-9]{64}$/.test(state.integrity)) {
    throw new Error("Persisted RLUSD acquisition state integrity is missing");
  }
  const expected = Buffer.from(acquisitionStateDigest(state, integrityKey), "hex");
  const actual = Buffer.from(state.integrity, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Persisted RLUSD acquisition state integrity check failed");
  }
  return state;
}

export function acquisitionApprovalToken(operationId, owner) {
  return [
    "P-LIVE-RLUSD",
    operationId,
    owner,
    "testnet",
    RLUSD_ISSUER,
    RLUSD_CURRENCY,
    RLUSD_ACQUISITION_AMOUNT,
    RLUSD_ACQUISITION_XRP_CAP_DROPS.toString(),
  ].join(":");
}

function acquisitionApproval() {
  const operationId = process.env.P_LIVE_RLUSD_ACQUISITION_OPERATION_ID;
  if (
    typeof operationId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operationId)
  ) {
    throw new Error("RLUSD acquisition requires a canonical lowercase durable operation UUID");
  }
  const approvedOwner = process.env.P_LIVE_RLUSD_ACQUISITION_OWNER;
  if (typeof approvedOwner !== "string" || !isValidClassicAddress(approvedOwner)) {
    throw new Error("RLUSD acquisition requires the exact approved Testnet owner address");
  }
  if (process.env.P_LIVE_RLUSD_ACQUISITION_APPROVED !== acquisitionApprovalToken(operationId, approvedOwner)) {
    throw new Error("RLUSD acquisition is locked until approval binds the operation, owner, network, issuer, amount, and cap");
  }
  return { operationId, approvedOwner };
}

export function acquisitionExecuteArgs(buildId, intentId) {
  return {
    build_id: buildId,
    idempotency_key: intentId,
    require_owner_approval: true,
  };
}

export function acquisitionQuoteExpiredState(state, execution, now = new Date()) {
  if (execution?.status !== "failed" || execution.engine_result !== "QUOTE_EXPIRED") return undefined;
  return {
    ...state,
    status: "expired_unsubmitted",
    reconciled_at: now.toISOString(),
  };
}

export function assertExactOutputApprovalWindow(buildTransaction, approvalTransaction) {
  if (
    !isRecord(buildTransaction) || !isRecord(approvalTransaction) ||
    approvalTransaction.LastLedgerSequence !== buildTransaction.LastLedgerSequence
  ) throw new Error("Harbor approval attempted to refresh the exact-output RLUSD quote window");
}

async function loadAcquisitionState() {
  try {
    const state = JSON.parse(await readFile(ACQUISITION_STATE_FILE, "utf8"));
    if (!isRecord(state)) throw new Error("Acquisition state is not an object");
    return state;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function persistAcquisitionState(state) {
  const temporary = `${ACQUISITION_STATE_FILE}.${process.pid}.${randomUUID()}.tmp`;
  const temporaryHandle = await open(
    temporary,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o600,
  );
  try {
    await temporaryHandle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await temporaryHandle.sync();
  } finally {
    await temporaryHandle.close();
  }
  await rename(temporary, ACQUISITION_STATE_FILE);
  const directoryHandle = await open(dirname(ACQUISITION_STATE_FILE), "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function withAcquisitionLock(operationId, callback) {
  const lockPath = `${ACQUISITION_STATE_FILE}.lock`;
  const token = randomUUID();
  let handle;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, operation_id: operationId, token })}\n`);
      break;
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "EEXIST") || attempt > 0) throw error;
      let lock;
      try {
        lock = JSON.parse(await readFile(lockPath, "utf8"));
      } catch {
        throw new Error("RLUSD acquisition lock exists but cannot be safely inspected");
      }
      if (!Number.isSafeInteger(lock?.pid) || lock.pid < 1) {
        throw new Error("RLUSD acquisition lock is malformed and requires manual inspection");
      }
      try {
        process.kill(lock.pid, 0);
        throw new Error(`RLUSD acquisition operation is already running under process ${lock.pid}`);
      } catch (processError) {
        if (!(processError && typeof processError === "object" && processError.code === "ESRCH")) {
          throw processError;
        }
      }
      await rename(lockPath, `${lockPath}.stale-${Date.now()}-${randomUUID()}`);
    }
  }
  if (!handle) throw new Error("RLUSD acquisition lock could not be acquired");
  try {
    return await callback();
  } finally {
    await handle.close();
    try {
      const current = JSON.parse(await readFile(lockPath, "utf8"));
      if (current.token !== token) {
        throw new Error("RLUSD acquisition lock ownership changed unexpectedly");
      }
      await unlink(lockPath);
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
    }
  }
}

export async function reconcileAcquisitionSubmission(state, { lookup, verify, persist }) {
  if (state.status === "validated") return { state, resumed: true };
  if (state.status !== "signed_pending") return { state, resumed: false };
  let outcome;
  try {
    outcome = await lookup(state.hash, state.last_ledger_sequence);
  } catch (error) {
    throw new AggregateError(
      [error],
      `RLUSD acquisition outcome remains unknown for public hash ${state.hash}; refusing to resubmit`,
    );
  }
  if (!outcome) {
    const expired = {
      ...state,
      status: "expired_unincluded",
      reconciled_at: new Date().toISOString(),
    };
    await persist(expired);
    throw new Error(
      "RLUSD acquisition was not included before LastLedgerSequence; this operation is terminal and requires a new explicit approval and operation identity",
    );
  }
  const completion = await verify(outcome, state);
  const validated = {
    ...state,
    ...completion,
    status: "validated",
    validated_at: new Date().toISOString(),
  };
  await persist(validated);
  return { state: validated, resumed: true };
}

export async function resumeAcquisitionBeforeFreshQuote(
  state,
  { verifyValidated, reconcileSigned, loadFreshQuote },
) {
  if (state.status === "validated") {
    await verifyValidated(state);
    return { handled: true, state };
  }
  if (state.status === "expired_unsubmitted" || state.status === "expired_unincluded") {
    throw new Error(
      "Persisted RLUSD acquisition operation is terminal; a new explicit approval and state file are required",
    );
  }
  if (state.status === "signed_pending") {
    return { handled: true, state: await reconcileSigned(state) };
  }
  if (state.status === "built") return { handled: false, state };
  return { handled: false, state, freshQuote: await loadFreshQuote() };
}

async function loadOrCreateOwner({ allowCreate = true } = {}) {
  try {
    const current = await loadEnv(SECRET_FILE);
    const seed = current.P_LIVE_OWNER_SEED;
    const address = current.P_LIVE_OWNER_ADDRESS;
    if (!seed || !address) throw new Error("P-live secret file is incomplete");
    const wallet = Wallet.fromSeed(seed);
    if (wallet.classicAddress !== address) {
      throw new Error("P-live owner seed and address do not match");
    }
    return wallet;
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
    if (!allowCreate) {
      throw new Error("Persisted acquisition state exists but its scoped owner credential is missing");
    }
  }

  const wallet = Wallet.generate();
  if (!wallet.seed) throw new Error("Fresh test owner generation failed");
  const contents = [
    `P_LIVE_OWNER_ADDRESS=${wallet.classicAddress}`,
    `P_LIVE_OWNER_SEED=${wallet.seed}`,
    "",
  ].join("\n");
  await writeFile(SECRET_FILE, contents, {
    encoding: "utf8",
    flag: fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    mode: 0o600,
  });
  return wallet;
}

function safeResult(action, detail = {}) {
  process.stdout.write(`${JSON.stringify({ action, ...detail })}\n`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonEqual(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every(
      (key, index) => key === rightKeys[index] && jsonEqual(left[key], right[key]),
    );
  }
  return left === right;
}

const SAFE_SIMULATION_RESULTS = new Set([
  "tecKILLED",
  "tecUNFUNDED_OFFER",
  "tecNO_LINE",
  "tecNO_AUTH",
  "tecNO_ISSUER",
  "tecFROZEN",
  "tecINSUF_RESERVE_OFFER",
  "tefMAX_LEDGER",
]);
const SAFE_PREFLIGHT_CHECKS = new Set([
  "network", "reserve", "trust-line", "require-auth", "expiry", "flag-conflicts",
  "schema", "policy",
]);

function safeSimulationResult(value) {
  return typeof value === "string" && SAFE_SIMULATION_RESULTS.has(value) ? value : undefined;
}

function safePreflightCheck(value) {
  return typeof value === "string" && SAFE_PREFLIGHT_CHECKS.has(value) ? value : undefined;
}

export function safeBuildFailureDiagnostics(build, { account, network, transactionType }) {
  if (!isRecord(build)) {
    return Object.freeze({
      failedFields: Object.freeze(["build"]),
      simulationEngineResult: undefined,
      failedPreflightChecks: Object.freeze([]),
    });
  }
  const failedFields = [];
  const failedPreflightChecks = [];
  const fail = (field) => {
    if (!failedFields.includes(field)) failedFields.push(field);
  };
  if (typeof build.build_id !== "string" || build.build_id.length === 0) fail("build_id");
  if (build.network !== network) fail("network");
  if (!isRecord(build.tx_json)) {
    fail("tx_json");
  } else {
    if (build.tx_json.Account !== account) fail("tx_json.Account");
    if (build.tx_json.TransactionType !== transactionType) fail("tx_json.TransactionType");
  }
  if (!isRecord(build.summary)) {
    fail("summary");
  } else if (build.summary.account !== account) {
    fail("summary.account");
  }
  if (!isRecord(build.simulate)) {
    fail("simulate");
  } else {
    if (build.simulate.applied !== false) fail("simulate.applied");
    if (build.simulate.engine_result !== "tesSUCCESS") fail("simulate.engine_result");
  }
  if (!Array.isArray(build.preflight) || build.preflight.length === 0) {
    fail("preflight");
  } else {
    for (const check of build.preflight) {
      if (!isRecord(check)) {
        fail("preflight[]");
      } else if (check.pass !== true) {
        fail("preflight[].pass");
        const checkName = safePreflightCheck(check.check);
        if (checkName && !failedPreflightChecks.includes(checkName)) {
          failedPreflightChecks.push(checkName);
        }
      }
    }
  }
  return Object.freeze({
    failedFields: Object.freeze(failedFields),
    simulationEngineResult: failedFields.includes("simulate.engine_result")
      ? safeSimulationResult(build.simulate?.engine_result)
      : undefined,
    failedPreflightChecks: Object.freeze(failedPreflightChecks),
  });
}

function assertSafeBuild(build, expected) {
  const diagnostics = safeBuildFailureDiagnostics(build, expected);
  if (diagnostics.failedFields.length > 0) {
    const suffix = [
      `failed fields: ${diagnostics.failedFields.join(", ")}`,
      diagnostics.simulationEngineResult
        ? `simulation engine result: ${diagnostics.simulationEngineResult}`
        : undefined,
      diagnostics.failedPreflightChecks.length > 0
        ? `failed preflight checks: ${diagnostics.failedPreflightChecks.join(", ")}`
        : undefined,
    ].filter(Boolean).join("; ");
    const error = new Error(
      `Harbor returned a build that did not pass exact simulation and preflight checks; ${suffix}`,
    );
    error.code = "UNSAFE_HARBOR_BUILD";
    error.diagnostics = diagnostics;
    throw error;
  }
  return build;
}

function assertApprovalMatchesBuild(build, execution) {
  const semantic = (transaction) => {
    if (!isRecord(transaction)) return transaction;
    const copy = { ...transaction };
    delete copy.Fee;
    delete copy.Sequence;
    delete copy.LastLedgerSequence;
    return copy;
  };
  if (
    execution?.status !== "needs_approval" ||
    typeof execution.approval_id !== "string" || execution.approval_id.length === 0 ||
    !Number.isFinite(Date.parse(execution.expires_at)) || Date.parse(execution.expires_at) <= Date.now() ||
    !isRecord(execution.tx_json) || !jsonEqual(semantic(execution.tx_json), semantic(build.tx_json))
  ) {
    throw new Error("Harbor approval did not preserve the exact safe build");
  }
  return execution;
}

async function harborConfig() {
  const env = await loadEnv(PILOT_ENV_FILE);
  if (!env.HARBOR_URL || !env.HARBOR_API_KEY) {
    throw new Error("Hosted Harbor configuration is missing");
  }
  const url = new URL(env.HARBOR_URL);
  if (url.protocol !== "https:") throw new Error("Hosted Harbor must use HTTPS");
  return { baseUrl: url.toString().replace(/\/+$/, ""), apiKey: env.HARBOR_API_KEY };
}

async function harborOp(config, op, args) {
  if (!/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/.test(op)) {
    throw new Error("Unsafe Harbor operation name");
  }
  const response = await fetch(`${config.baseUrl}/api/ops/${encodeURIComponent(op)}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(payload) || payload.ok !== true || !("data" in payload)) {
    const code = isRecord(payload?.error) ? payload.error.code : undefined;
    const message = isRecord(payload?.error) ? payload.error.message : undefined;
    throw new Error(`${op} failed${code ? ` (${code})` : ""}${message ? `: ${message}` : ""}`);
  }
  return payload.data;
}

async function harborOpError(config, op, args) {
  const response = await fetch(`${config.baseUrl}/api/ops/${encodeURIComponent(op)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const payload = await response.json().catch(() => undefined);
  if (!isRecord(payload) || payload.ok !== false || !isRecord(payload.error)) {
    throw new Error(`${op} unexpectedly succeeded or returned an invalid refusal`);
  }
  return { status: response.status, code: payload.error.code, message: payload.error.message };
}

export function assertApprovalExpiredRefusal(refusal) {
  if (
    !isRecord(refusal) || refusal.code !== "APPROVAL_EXPIRED" ||
    typeof refusal.message !== "string" || !/approval\s+(?:has\s+)?expired/i.test(refusal.message)
  ) {
    throw new Error("Harbor did not return the specific APPROVAL_EXPIRED refusal contract");
  }
}

export function assertExactTxnNotFound(error) {
  if (!(error && typeof error === "object" && error.data?.error === "txnNotFound")) {
    throw new Error("Transaction lookup did not return the exact txnNotFound refusal");
  }
}

async function withClient(network, callback) {
  const client = new Client(network === "testnet" ? TESTNET_WS : DEVNET_WS);
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.disconnect();
  }
}

async function accountExists(network, address) {
  return withClient(network, async (client) => {
    try {
      await client.request({ command: "account_info", account: address, ledger_index: "validated" });
      return true;
    } catch (error) {
      if (error && typeof error === "object" && error.data?.error === "actNotFound") return false;
      throw error;
    }
  });
}

async function xrpBalanceDrops(network, address) {
  return withClient(network, async (client) => {
    const response = await client.request({
      command: "account_info",
      account: address,
      ledger_index: "validated",
    });
    const balance = response.result.account_data?.Balance;
    if (response.result.validated !== true || typeof balance !== "string" || !/^\d+$/.test(balance)) {
      throw new Error(`${network} account balance is unavailable`);
    }
    return BigInt(balance);
  });
}

async function validatedAccountState(network, account) {
  return withClient(network, async (client) => {
    const response = await client.request({ command: "account_info", account, ledger_index: "validated" });
    const ledgerIndex = response.result.ledger_index;
    const sequence = response.result.account_data?.Sequence;
    if (
      response.result.validated !== true || !Number.isSafeInteger(ledgerIndex) || ledgerIndex < 1 ||
      !Number.isSafeInteger(sequence) || sequence < 0
    ) throw new Error(`${network} validated account sequence is unavailable`);
    return { ledgerIndex, sequence };
  });
}

async function faucet(network, address) {
  if (await accountExists(network, address)) return;
  const endpoint = network === "testnet" ? TESTNET_FAUCET : DEVNET_FAUCET;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ destination: address }),
  });
  if (!response.ok) throw new Error(`${network} faucet returned HTTP ${response.status}`);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (await accountExists(network, address)) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${network} faucet funding was not validated`);
}

function sign(wallet, txJson) {
  if (!isRecord(txJson) || txJson.Account !== wallet.classicAddress) {
    throw new Error("Refusing to sign a transaction for a different account");
  }
  const signed = wallet.sign(txJson);
  if (!signed?.tx_blob) throw new Error("Owner signing failed");
  return signed.tx_blob;
}

const OWNER_FIELDS = Object.freeze({
  DelegateSet: new Set([
    "TransactionType", "Account", "Authorize", "Permissions", "Fee", "Sequence",
    "LastLedgerSequence", "Flags", "SourceTag", "Memos", "SigningPubKey",
  ]),
  OfferCreate: new Set([
    "TransactionType", "Account", "TakerGets", "TakerPays", "Fee", "Sequence",
    "LastLedgerSequence", "Flags", "Expiration", "SourceTag", "Memos", "SigningPubKey",
  ]),
  VaultDeposit: new Set([
    "TransactionType", "Account", "VaultID", "Amount", "Fee", "Sequence",
    "LastLedgerSequence", "Flags", "SourceTag", "Memos", "SigningPubKey",
  ]),
});

function assertSafeOwnerTransaction(txJson, owner, ledgerIndex, accountSequence) {
  const allowed = OWNER_FIELDS[txJson?.TransactionType];
  const fee = typeof txJson?.Fee === "string" && /^\d+$/.test(txJson.Fee)
    ? Number(txJson.Fee)
    : Number.NaN;
  if (
    !isRecord(txJson) || !allowed || txJson.Account !== owner ||
    Object.keys(txJson).some((field) => !allowed.has(field)) ||
    "TxnSignature" in txJson ||
    (txJson.SigningPubKey !== undefined && txJson.SigningPubKey !== "") ||
    !Number.isSafeInteger(fee) || fee < 0 || fee > 100 ||
    !Number.isSafeInteger(txJson.Sequence) || txJson.Sequence !== accountSequence ||
    !Number.isSafeInteger(txJson.LastLedgerSequence) || txJson.LastLedgerSequence <= ledgerIndex ||
    txJson.LastLedgerSequence > ledgerIndex + 50 ||
    (txJson.Flags !== undefined && (!Number.isSafeInteger(txJson.Flags) || txJson.Flags < 0 || txJson.Flags > 0xffff_ffff)) ||
    (txJson.TransactionType === "DelegateSet" && txJson.Flags !== undefined && txJson.Flags !== 0)
  ) {
    throw new Error("Refusing to sign an unsafe or stale owner transaction");
  }
}

function approvalSubmitArgs(txBlob, network, approvalId) {
  return { tx_blob: txBlob, network, ...(approvalId ? { approval_id: approvalId } : {}) };
}

async function submitOwner(config, wallet, txJson, network, approvalId) {
  const account = await validatedAccountState(network, wallet.classicAddress);
  assertSafeOwnerTransaction(txJson, wallet.classicAddress, account.ledgerIndex, account.sequence);
  const txBlob = sign(wallet, txJson);
  const expectedHash = hashes.hashSignedTx(txBlob).toUpperCase();
  try {
    const result = await harborOp(config, "tx.submit", approvalSubmitArgs(txBlob, network, approvalId));
    if (
      !isRecord(result) || result.status === "failed" || result.validated !== true ||
      result.engine_result !== "tesSUCCESS" || result.hash?.toUpperCase() !== expectedHash ||
      !Number.isSafeInteger(result.ledger_index)
    ) {
      throw new Error(`Owner submission did not validate with tesSUCCESS${result?.engine_result ? ` (${result.engine_result})` : ""}`);
    }
    return result;
  } catch (submitError) {
    const recovered = await recoverSignedSubmission(network, expectedHash, txJson.LastLedgerSequence);
    if (recovered) return recovered;
    throw new AggregateError(
      [submitError],
      `Owner submission outcome could not be recovered before LastLedgerSequence; public hash ${expectedHash}`,
    );
  }
}

async function recoverSignedSubmission(network, hash, lastLedgerSequence) {
  if (!Number.isSafeInteger(lastLedgerSequence)) return undefined;
  return withClient(network, async (client) => {
    for (;;) {
      try {
        const response = await client.request({ command: "tx", transaction: hash, binary: false });
        const meta = response.result.meta;
        if (response.result.validated === true) {
          if (
            !isRecord(meta) || meta.TransactionResult !== "tesSUCCESS" ||
            !Number.isSafeInteger(response.result.ledger_index)
          ) throw new Error(`Recovered transaction ${hash} did not validate with tesSUCCESS`);
          return {
            status: "validated",
            validated: true,
            engine_result: "tesSUCCESS",
            hash,
            ledger_index: response.result.ledger_index,
          };
        }
      } catch (error) {
        if (!(error && typeof error === "object" && error.data?.error === "txnNotFound")) throw error;
      }
      const ledger = await client.request({ command: "ledger", ledger_index: "validated" });
      const ledgerIndex = ledger.result.ledger_index;
      if (!Number.isSafeInteger(ledgerIndex)) {
        throw new Error("Validated ledger progress is unavailable during submission recovery");
      }
      if (ledgerIndex > lastLedgerSequence) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  });
}

async function withTemporaryPolicy(config, owner, network, update, callback) {
  const original = await harborOp(config, "policy.get", { owner, network });
  const temporary = update(structuredClone(original));
  let operationError;
  try {
    if (JSON.stringify(temporary) !== JSON.stringify(original)) {
      await harborOp(config, "policy.set", { owner, network, policy: temporary });
    }
    return await callback(temporary);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await harborOp(config, "policy.set", { owner, network, policy: original });
      const restored = await harborOp(config, "policy.get", { owner, network });
      if (JSON.stringify(restored) !== JSON.stringify(original)) {
        throw new Error("Harbor policy restoration did not round-trip exactly");
      }
    } catch (restoreError) {
      if (operationError) {
        throw new AggregateError([operationError, restoreError], "Operation and policy restoration both failed");
      }
      throw restoreError;
    }
  }
}

async function rlusdBalanceState(config, owner) {
  const lines = await harborOp(config, "ledger.account.lines", {
    network: "testnet",
    account: owner,
    ledger_index: "validated",
  });
  if (
    lines.validated !== true || !Number.isSafeInteger(lines.ledger_index) ||
    typeof lines.ledger_hash !== "string" || !/^[A-F0-9]{64}$/i.test(lines.ledger_hash)
  ) {
    throw new Error("Official RLUSD trust-line balance is not from a validated ledger");
  }
  const line = lines.lines?.find(
    (candidate) =>
      candidate.account === RLUSD_ISSUER &&
      (candidate.currency === "RLUSD" || candidate.currency === RLUSD_CURRENCY),
  );
  if (!line) {
    return {
      balance: undefined,
      ledgerIndex: lines.ledger_index,
      ledgerHash: lines.ledger_hash.toUpperCase(),
      line: undefined,
    };
  }
  if (typeof line.balance !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(line.balance)) {
    throw new Error("Official RLUSD trust-line balance is not a canonical decimal");
  }
  return {
    balance: line.balance,
    ledgerIndex: lines.ledger_index,
    ledgerHash: lines.ledger_hash.toUpperCase(),
    line,
  };
}

async function officialRlusdIssuerFlags(config, trustLineState) {
  const issuer = await harborOp(config, "ledger.account.info", {
    network: "testnet",
    account: RLUSD_ISSUER,
    ledger_hash: trustLineState.ledgerHash,
  });
  const flags = issuer.account_data?.Flags;
  if (
    issuer.validated !== true || issuer.ledger_index !== trustLineState.ledgerIndex ||
    issuer.ledger_hash?.toUpperCase() !== trustLineState.ledgerHash ||
    issuer.account_data?.Account !== RLUSD_ISSUER || !Number.isSafeInteger(flags) || flags < 0
  ) throw new Error("Official RLUSD issuer flags are not from a validated ledger");
  return flags;
}

export function assertUsableOfficialRlusdTrustLine(state, issuerFlags) {
  const line = state?.line;
  if (
    state?.balance === undefined || !isRecord(line) ||
    line.account !== RLUSD_ISSUER ||
    (line.currency !== "RLUSD" && line.currency !== RLUSD_CURRENCY) ||
    line.limit !== "10000" ||
    line.freeze === true || line.freeze_peer === true ||
    line.deep_freeze === true || line.deep_freeze_peer === true ||
    !Number.isSafeInteger(issuerFlags) || issuerFlags < 0 ||
    (issuerFlags & ACCOUNT_LSF_GLOBAL_FREEZE) !== 0 ||
    ((issuerFlags & ACCOUNT_LSF_REQUIRE_AUTH) !== 0 && line.peer_authorized !== true)
  ) throw new Error("Official Testnet RLUSD trust line is not usable with the exact configured limit");
  return state;
}

async function rlusdBalanceText(config, owner) {
  return (await rlusdBalanceState(config, owner)).balance;
}

async function waitForRlusdBalanceAtOrAfter(config, owner, minimumLedgerIndex) {
  return waitForLedgerAtOrAfter(
    () => rlusdBalanceState(config, owner),
    minimumLedgerIndex,
  );
}

export async function waitForLedgerAtOrAfter(
  read,
  minimumLedgerIndex,
  { maxAttempts = 20, wait = () => new Promise((resolve) => setTimeout(resolve, 1_000)) } = {},
) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const state = await read();
    if (!isRecord(state) || !Number.isSafeInteger(state.ledgerIndex)) {
      throw new Error("Validated balance ledger index is unavailable");
    }
    if (state.ledgerIndex >= minimumLedgerIndex) return state;
    if (attempt < maxAttempts - 1) await wait();
  }
  throw new Error("Validated RLUSD balance did not advance to the acquisition transaction ledger");
}

async function rlusdBalance(config, owner) {
  const value = await rlusdBalanceText(config, owner);
  if (value === undefined) return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error("Official RLUSD trust-line balance is not finite");
  }
  return numeric;
}

function decimalParts(value) {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error("RLUSD balance is not a canonical decimal");
  }
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ""] = unsigned.split(".");
  const units = BigInt(`${integer}${fraction}`) * (negative ? -1n : 1n);
  return { units, scale: fraction.length };
}

export function assertExactRlusdBalanceDelta(before, after, expectedIncrease) {
  const values = [decimalParts(before), decimalParts(after), decimalParts(expectedIncrease)];
  const scale = Math.max(...values.map((value) => value.scale));
  const normalize = (value) => value.units * (10n ** BigInt(scale - value.scale));
  if (normalize(values[1]) - normalize(values[0]) !== normalize(values[2])) {
    throw new Error(`Validated RLUSD balance delta was not exactly ${expectedIncrease}`);
  }
}

async function ensureTrustLine(config, wallet) {
  const existing = await rlusdBalanceState(config, wallet.classicAddress);
  if (existing.balance !== undefined) {
    assertUsableOfficialRlusdTrustLine(existing, await officialRlusdIssuerFlags(config, existing));
    return;
  }
  const build = await harborOp(config, "tx.trustSet", {
    account: wallet.classicAddress,
    network: "testnet",
    intent_id: `p-live-trust-${randomUUID()}`,
    limit_amount: {
      currency: RLUSD_CURRENCY,
      issuer: RLUSD_ISSUER,
      value: "10000",
    },
  });
  const ledger = await harborOp(config, "ledger.account.info", {
    account: wallet.classicAddress,
    network: "testnet",
    ledger_index: "validated",
  });
  const accountSequence = ledger.account_data?.Sequence;
  const tx = build.tx_json;
  const trustSetFields = new Set([
    "TransactionType", "Account", "LimitAmount", "Fee", "Sequence", "LastLedgerSequence",
    "Flags", "SourceTag", "Memos", "SigningPubKey",
  ]);
  const fee = typeof tx?.Fee === "string" ? Number(tx.Fee) : Number.NaN;
  if (
    ledger.validated !== true || !Number.isSafeInteger(ledger.ledger_index) ||
    build.network !== "testnet" || build.simulate?.applied !== false || build.simulate?.engine_result !== "tesSUCCESS" ||
    !Array.isArray(build.preflight) || build.preflight.length === 0 ||
    build.preflight.some((check) => check.pass !== true) ||
    !isRecord(tx) || Object.keys(tx).some((field) => !trustSetFields.has(field)) ||
    tx?.TransactionType !== "TrustSet" || tx.Account !== wallet.classicAddress ||
    tx.LimitAmount?.currency !== RLUSD_CURRENCY || tx.LimitAmount?.issuer !== RLUSD_ISSUER ||
    tx.LimitAmount?.value !== "10000" || !Number.isSafeInteger(fee) || fee < 0 || fee > 100 ||
    !Number.isSafeInteger(accountSequence) || !Number.isSafeInteger(tx.Sequence) || tx.Sequence !== accountSequence ||
    (tx.SigningPubKey !== undefined && tx.SigningPubKey !== "") ||
    (tx.Flags !== undefined && tx.Flags !== 0) ||
    !Number.isSafeInteger(tx.LastLedgerSequence) ||
    tx.LastLedgerSequence <= ledger.ledger_index || tx.LastLedgerSequence > ledger.ledger_index + 50
  ) {
    throw new Error("Harbor returned an unsafe TrustSet build");
  }
  const signed = wallet.sign(tx);
  const hash = hashes.hashSignedTx(signed.tx_blob).toUpperCase();
  if (signed.hash?.toUpperCase() !== hash) throw new Error("TrustSet signed hash mismatch");
  await withClient("testnet", async (client) => {
    const submitted = await client.submitAndWait(signed.tx_blob);
    const meta = submitted.result.meta;
    if (
      submitted.result.validated !== true || submitted.result.hash?.toUpperCase() !== hash ||
      !isRecord(meta) || meta.TransactionResult !== "tesSUCCESS"
    ) {
      throw new Error("TrustSet did not validate with tesSUCCESS");
    }
    const lines = await client.request({
      command: "account_lines",
      account: wallet.classicAddress,
      peer: RLUSD_ISSUER,
      ledger_index: "validated",
    });
    const issuer = await client.request({
      command: "account_info",
      account: RLUSD_ISSUER,
      ledger_hash: lines.result.ledger_hash,
    });
    const exact = lines.result.lines?.find(
      (line) => line.account === RLUSD_ISSUER &&
        (line.currency === "RLUSD" || line.currency === RLUSD_CURRENCY),
    );
    const issuerFlags = issuer.result.account_data?.Flags;
    if (
      lines.result.validated !== true || !Number.isSafeInteger(lines.result.ledger_index) ||
      typeof lines.result.ledger_hash !== "string" || !/^[A-F0-9]{64}$/i.test(lines.result.ledger_hash) ||
      issuer.result.validated !== true || issuer.result.ledger_index !== lines.result.ledger_index ||
      issuer.result.ledger_hash?.toUpperCase() !== lines.result.ledger_hash.toUpperCase() ||
      issuer.result.account_data?.Account !== RLUSD_ISSUER
    ) throw new Error("Validated TrustSet state could not be independently verified");
    assertUsableOfficialRlusdTrustLine({
      balance: exact?.balance,
      ledgerIndex: lines.result.ledger_index,
      ledgerHash: lines.result.ledger_hash.toUpperCase(),
      line: exact,
    }, issuerFlags);
  });
  safeResult("trust-line-validated", { hash });
}

async function ensureRlusd(config, wallet, minimum = 75) {
  const current = await rlusdBalance(config, wallet.classicAddress);
  if (current === undefined) throw new Error("RLUSD trust line is missing");
  if (current >= minimum) return;
  throw new Error(
    `Official Testnet RLUSD balance is ${current}; ${minimum} is required and the owner-approved fixed-buy acquisition has not been run`,
  );
}

async function assertActiveLinkLedgerProof(
  network,
  owner,
  link,
  expectedPermissions = DEFAULT_PERMISSIONS,
) {
  await withClient(network, async (client) => {
    const response = await client.request({
      command: "account_tx",
      account: owner,
      ledger_index_min: -1,
      ledger_index_max: -1,
      limit: 200,
      forward: false,
    });
    const delegateSets = (response.result.transactions ?? []).filter((entry) => {
      const tx = entry.tx_json ?? entry.tx;
      const meta = entry.meta;
      return entry.validated === true && isRecord(tx) && isRecord(meta) &&
        meta.TransactionResult === "tesSUCCESS" && tx.TransactionType === "DelegateSet" && tx.Account === owner;
    }).sort((left, right) => Number(right.ledger_index ?? 0) - Number(left.ledger_index ?? 0));
    const latest = delegateSets[0];
    const latestTx = latest?.tx_json ?? latest?.tx;
    const permissions = Array.isArray(latestTx?.Permissions)
      ? latestTx.Permissions.map((item) => item?.Permission?.PermissionValue)
      : undefined;
    if (
      !isRecord(latestTx) || latestTx.Authorize !== link.delegate ||
      JSON.stringify(permissions) !== JSON.stringify(expectedPermissions)
    ) throw new Error(`The newest validated DelegateSet does not prove the active ${network} delegation`);
  });
}

async function activeLink(
  config,
  wallet,
  network = "testnet",
  expectedPermissions = DEFAULT_PERMISSIONS,
) {
  if (
    !Array.isArray(expectedPermissions) || expectedPermissions.length === 0 ||
    expectedPermissions.some((permission) => typeof permission !== "string")
  ) throw new Error("Delegation must use an explicit non-empty permission scope");
  const owner = wallet.classicAddress;
  let status;
  try {
    status = await harborOp(config, "account.status", { owner, network });
  } catch {
    status = undefined;
  }
  if (status?.status === "active") {
    if (
      status.owner !== owner || status.network !== network ||
      JSON.stringify(status.permissions) !== JSON.stringify(expectedPermissions)
    ) throw new Error(`Existing ${network} delegation does not match the exact requested permission scope`);
    await assertActiveLinkLedgerProof(network, owner, status, expectedPermissions);
    return status;
  }

  const link = await harborOp(config, "account.link", {
    owner,
    network,
    permissions: [...expectedPermissions],
  });
  const tx = link.delegate_set_tx;
  const txPermissions = Array.isArray(tx?.Permissions)
    ? tx.Permissions.map((entry) => entry?.Permission?.PermissionValue)
    : undefined;
  if (
    link.owner !== owner || link.network !== network || link.status !== "pending" ||
    JSON.stringify(link.permissions) !== JSON.stringify(expectedPermissions) ||
    !isRecord(tx) || tx.TransactionType !== "DelegateSet" || tx.Account !== owner ||
    tx.Authorize !== link.delegate || JSON.stringify(txPermissions) !== JSON.stringify(expectedPermissions)
  ) {
    throw new Error("account.link did not return an owner-signable DelegateSet");
  }
  const submitted = await submitOwner(config, wallet, tx, network);
  const validated = await validatedTransaction(network, submitted.hash);
  const validatedPermissions = Array.isArray(validated.tx.Permissions)
    ? validated.tx.Permissions.map((entry) => entry?.Permission?.PermissionValue)
    : undefined;
  if (
    validated.tx.TransactionType !== "DelegateSet" || validated.tx.Account !== owner ||
    validated.tx.Authorize !== link.delegate || "Delegate" in validated.tx ||
    JSON.stringify(validatedPermissions) !== JSON.stringify(expectedPermissions)
  ) {
    throw new Error("Validated DelegateSet did not match the exact requested delegation");
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    status = await harborOp(config, "account.status", { owner, network });
    if (
      status.owner === owner && status.network === network && status.status === "active" &&
      status.delegate === link.delegate &&
      JSON.stringify(status.permissions) === JSON.stringify(expectedPermissions)
    ) break;
    if (attempt < 19) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (status?.status !== "active") {
    throw new Error(`Delegation did not become active with the exact requested permission scope on ${network}`);
  }
  await assertActiveLinkLedgerProof(network, owner, status, expectedPermissions);
  safeResult("delegation-active", {
    delegate: status.delegate,
    network,
    permissions: [...expectedPermissions],
  });
  return status;
}

async function testnetOfferCreateLink() {
  const config = await harborConfig();
  const wallet = await loadOrCreateOwner({ allowCreate: false });
  const link = await activeLink(
    config,
    wallet,
    "testnet",
    OFFER_CREATE_ONLY_PERMISSIONS,
  );
  safeResult("testnet-offercreate-link-pass", {
    owner: wallet.classicAddress,
    network: "testnet",
    delegate: link.delegate,
    permissions: [...OFFER_CREATE_ONLY_PERMISSIONS],
  });
}

async function validatedTransaction(network, hash) {
  return withClient(network, async (client) => {
    const response = await client.request({ command: "tx", transaction: hash, binary: false });
    const meta = response.result.meta;
    if (
      response.result.validated !== true || !isRecord(meta) ||
      meta.TransactionResult !== "tesSUCCESS" || !Number.isSafeInteger(response.result.ledger_index)
    ) throw new Error("Transaction is not validated with tesSUCCESS");
    return {
      tx: response.result.tx_json ?? response.result,
      meta,
      ledgerIndex: response.result.ledger_index,
    };
  });
}

async function validatedVaultInfo() {
  const response = await fetch(DEVNET_HTTP, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      method: "vault_info",
      params: [{ vault_id: DEVNET_VAULT_ID, ledger_index: "validated" }],
      api_version: 2,
    }),
  });
  const payload = await response.json();
  const result = payload?.result;
  if (
    !response.ok || !isRecord(result) || result.validated !== true ||
    !Number.isSafeInteger(result.ledger_index) || !isRecord(result.vault) ||
    result.vault.index !== DEVNET_VAULT_ID
  ) throw new Error("Devnet provider did not return the configured Vault from a validated ledger");
  return result;
}

function vaultAssetsTotal(result) {
  const value = result.vault.AssetsTotal ?? "0";
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error("Validated Vault AssetsTotal is malformed");
  }
  return BigInt(value);
}

async function provision() {
  const wallet = await loadOrCreateOwner();
  await Promise.all([
    faucet("testnet", wallet.classicAddress),
    faucet("devnet", wallet.classicAddress),
  ]);
  safeResult("fresh-owner-funded", { owner: wallet.classicAddress, networks: ["testnet", "devnet"] });
}

async function topUpDevnetOwner() {
  const wallet = await loadOrCreateOwner();
  const before = await xrpBalanceDrops("devnet", wallet.classicAddress);
  const response = await fetch(DEVNET_FAUCET, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ destination: wallet.classicAddress }),
  });
  if (!response.ok) {
    throw new Error(`Devnet faucet top-up returned HTTP ${response.status}`);
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const after = await xrpBalanceDrops("devnet", wallet.classicAddress);
    if (after > before) {
      safeResult("devnet-owner-topped-up", {
        owner: wallet.classicAddress,
        balanceBeforeDrops: before.toString(),
        balanceAfterDrops: after.toString(),
      });
      return;
    }
    if (attempt < 19) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Devnet faucet accepted the top-up but the validated balance did not increase");
}

function isOfficialRlusdAsset(asset) {
  return isRecord(asset) &&
    (asset.currency === "RLUSD" || asset.currency === RLUSD_CURRENCY) &&
    asset.issuer === RLUSD_ISSUER;
}

function isXrpAsset(asset) {
  return isRecord(asset) && asset.currency === "XRP" && !("issuer" in asset);
}

function parseCanonicalDecimal(value, label) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error(`${label} must be a canonical non-negative decimal`);
  }
  const [integer, fraction = ""] = value.split(".");
  if (fraction.length > 32) throw new Error(`${label} has unsafe precision`);
  const denominator = 10n ** BigInt(fraction.length);
  return { numerator: BigInt(`${integer}${fraction}`), denominator };
}

function ceilDiv(numerator, denominator) {
  if (numerator < 0n || denominator <= 0n) throw new Error("Unsafe rational ceiling");
  return (numerator + denominator - 1n) / denominator;
}

export function maximumInputDrops(sourceAmountDrops, slippageBps) {
  if (
    typeof sourceAmountDrops !== "bigint" || sourceAmountDrops <= 0n ||
    !Number.isSafeInteger(slippageBps) || slippageBps < 0 || slippageBps > 9_999
  ) throw new Error("Exact-output quote amount or slippage is unsafe");
  return ceilDiv(sourceAmountDrops * BigInt(10_000 + slippageBps), 10_000n);
}

export function quoteOfficialRlusdAmm(amm, acquireRlusd = 75, sellRlusd = 50) {
  if (!isRecord(amm)) throw new Error("Official RLUSD AMM is unavailable");
  const firstIsXrp = isXrpAsset(amm.Asset) && isOfficialRlusdAsset(amm.Asset2);
  const secondIsXrp = isOfficialRlusdAsset(amm.Asset) && isXrpAsset(amm.Asset2);
  if (!firstIsXrp && !secondIsXrp) {
    throw new Error("AMM assets do not match official Testnet XRP/RLUSD");
  }
  const xrpAmount = firstIsXrp ? amm.Amount : amm.Amount2;
  const rlusdAmount = firstIsXrp ? amm.Amount2 : amm.Amount;
  const xrpReserveDrops = typeof xrpAmount === "string" && /^[1-9]\d*$/.test(xrpAmount)
    ? BigInt(xrpAmount)
    : undefined;
  const rlusdReserveDecimal = isRecord(rlusdAmount) ? rlusdAmount.value : undefined;
  const xrpReserve = xrpReserveDrops === undefined ? Number.NaN : Number(xrpReserveDrops) / 1_000_000;
  const rlusdReserve = typeof rlusdReserveDecimal === "string" ? Number(rlusdReserveDecimal) : Number.NaN;
  const acquireRlusdNumber = Number(acquireRlusd);
  const sellRlusdNumber = Number(sellRlusd);
  const tradingFee = Number(amm.TradingFee ?? 0);
  if (
    !Number.isFinite(xrpReserve) || xrpReserve <= 0 ||
    !Number.isFinite(rlusdReserve) || rlusdReserve <= acquireRlusdNumber ||
    !Number.isFinite(acquireRlusdNumber) || acquireRlusdNumber <= 0 ||
    !Number.isFinite(sellRlusdNumber) || sellRlusdNumber <= 0 ||
    !Number.isInteger(tradingFee) || tradingFee < 0 || tradingFee > 1_000
  ) throw new Error("Official RLUSD AMM reserves or fee are unsafe");

  const reserve = parseCanonicalDecimal(rlusdReserveDecimal, "RLUSD reserve");
  const acquire = parseCanonicalDecimal(String(acquireRlusd), "RLUSD exact output");
  const reserveAfterNumerator = reserve.numerator * acquire.denominator -
    acquire.numerator * reserve.denominator;
  if (reserveAfterNumerator <= 0n || xrpReserveDrops === undefined) {
    throw new Error("Official RLUSD AMM reserves or fee are unsafe");
  }
  const rawInputNumerator = xrpReserveDrops * acquire.numerator * 100_000n * reserve.denominator;
  const rawInputDenominator = reserveAfterNumerator * BigInt(100_000 - tradingFee);
  const quotedInputDrops = ceilDiv(rawInputNumerator, rawInputDenominator);
  const maximumInput = maximumInputDrops(quotedInputDrops, RLUSD_ACQUISITION_SLIPPAGE_BPS);
  const priceImpactNumerator = acquire.numerator * reserve.denominator * 10_000n;
  const priceImpactDenominator = reserveAfterNumerator;

  // XRPL TradingFee is in 1/100,000 units. Constant-product quotes are a
  // conservative single-AMM floor: autobridging/order-book liquidity may improve them.
  const feeRate = tradingFee / 100_000;
  const feeMultiplier = 1 - feeRate;
  const acquireXrp = xrpReserve * acquireRlusdNumber /
    ((rlusdReserve - acquireRlusdNumber) * feeMultiplier);
  const acquireSpotXrpPerRlusd = xrpReserve / rlusdReserve / feeMultiplier;
  const acquirePriceImpactBps =
    ((acquireXrp / acquireRlusdNumber) / acquireSpotXrpPerRlusd - 1) * 10_000;
  const effectiveSaleRlusd = sellRlusdNumber * feeMultiplier;
  const saleXrp = xrpReserve * effectiveSaleRlusd /
    (rlusdReserve + effectiveSaleRlusd);
  const saleSpotXrpPerRlusd = xrpReserve / rlusdReserve * feeMultiplier;
  const salePriceImpactBps =
    (1 - (saleXrp / sellRlusdNumber) / saleSpotXrpPerRlusd) * 10_000;
  return {
    xrpReserve,
    rlusdReserve,
    tradingFee,
    feeRate,
    acquire: {
      rlusd: acquireRlusdNumber,
      quotedXrp: acquireXrp,
      cappedXrpAtOnePercent: acquireXrp * 1.01,
      priceImpactBps: acquirePriceImpactBps,
      rawInputNumerator: rawInputNumerator.toString(),
      rawInputDenominator: rawInputDenominator.toString(),
      quotedInputDrops: quotedInputDrops.toString(),
      maximumInputDrops: maximumInput.toString(),
      priceImpactNumerator: priceImpactNumerator.toString(),
      priceImpactDenominator: priceImpactDenominator.toString(),
      withinOnePercent: priceImpactNumerator <= 100n * priceImpactDenominator,
    },
    sale: {
      rlusd: sellRlusdNumber,
      quotedXrp: saleXrp,
      flooredXrpAtOnePercent: saleXrp * 0.99,
      priceImpactBps: salePriceImpactBps,
    },
  };
}

export function normalizeExactOutputRlusdQuote(result, account) {
  if (
    !isRecord(result) || result.validated !== true || result.full_reply !== true ||
    !Number.isSafeInteger(result.ledger_index) || result.ledger_index < 1 ||
    typeof result.ledger_hash !== "string" || !/^[A-F0-9]{64}$/i.test(result.ledger_hash) ||
    result.source_account !== account || result.destination_account !== account ||
    !isRecord(result.destination_amount) ||
    result.destination_amount.currency !== RLUSD_CURRENCY ||
    result.destination_amount.issuer !== RLUSD_ISSUER ||
    result.destination_amount.value !== RLUSD_ACQUISITION_AMOUNT ||
    !Array.isArray(result.alternatives)
  ) throw new Error("Validated exact-output RLUSD quote is stale or incomplete");
  const candidates = result.alternatives.flatMap((alternative) => {
    const amount = alternative?.source_amount;
    return typeof amount === "string" && /^[1-9]\d*$/.test(amount) ? [BigInt(amount)] : [];
  });
  if (candidates.length === 0) throw new Error("Validated exact-output RLUSD quote has no XRP source amount");
  const sourceAmount = candidates.reduce((lowest, value) => value < lowest ? value : lowest);
  const cap = maximumInputDrops(sourceAmount, RLUSD_ACQUISITION_SLIPPAGE_BPS);
  if (cap > RLUSD_ACQUISITION_XRP_CAP_DROPS) {
    throw new Error("Validated exact-output RLUSD quote exceeds the approved 275 XRP cap");
  }
  return {
    source: "ripple_path_find.validated.exact_output",
    rounding_reference: HARBOR_EXACT_OUTPUT_ROUNDING_REFERENCE,
    network: "testnet",
    account,
    ledger_index: result.ledger_index,
    ledger_hash: result.ledger_hash.toUpperCase(),
    source_asset: { currency: "XRP" },
    destination_amount: {
      currency: RLUSD_CURRENCY,
      issuer: RLUSD_ISSUER,
      value: RLUSD_ACQUISITION_AMOUNT,
    },
    source_amount_drops: sourceAmount.toString(),
    max_slippage_bps: RLUSD_ACQUISITION_SLIPPAGE_BPS,
    maximum_input_drops: cap.toString(),
  };
}

function ammEligibilityReference(validatedAmm, quote, account) {
  return {
    source: "amm_info.validated.constant_product",
    network: "testnet",
    account,
    ledger_index: validatedAmm.ledgerIndex,
    ledger_hash: validatedAmm.ledgerHash,
    source_asset: { currency: "XRP" },
    destination_amount: {
      currency: RLUSD_CURRENCY,
      issuer: RLUSD_ISSUER,
      value: RLUSD_ACQUISITION_AMOUNT,
    },
    xrp_reserve_drops: validatedAmm.amm.Amount,
    rlusd_reserve: validatedAmm.amm.Amount2.value,
    trading_fee: validatedAmm.amm.TradingFee,
    quoted_input_drops: quote.acquire.quotedInputDrops,
    max_slippage_bps: RLUSD_ACQUISITION_SLIPPAGE_BPS,
    maximum_input_drops: quote.acquire.maximumInputDrops,
  };
}

function assertExactOutputQuoteReference(quote, account) {
  const legacyReference = isRecord(quote) &&
    quote.rounding_reference === LEGACY_HARBOR_EXACT_OUTPUT_ROUNDING_REFERENCE;
  if (
    !isRecord(quote) || quote.source !== "ripple_path_find.validated.exact_output" ||
    ![
      HARBOR_EXACT_OUTPUT_ROUNDING_REFERENCE,
      LEGACY_HARBOR_EXACT_OUTPUT_ROUNDING_REFERENCE,
    ].includes(quote.rounding_reference) ||
    quote.network !== "testnet" || quote.account !== account ||
    !Number.isSafeInteger(quote.ledger_index) || quote.ledger_index < 1 ||
    (!legacyReference && (
      typeof quote.ledger_hash !== "string" || !/^[A-F0-9]{64}$/.test(quote.ledger_hash)
    )) ||
    !isXrpAsset(quote.source_asset) || !isRecord(quote.destination_amount) ||
    quote.destination_amount.currency !== RLUSD_CURRENCY ||
    quote.destination_amount.issuer !== RLUSD_ISSUER ||
    quote.destination_amount.value !== RLUSD_ACQUISITION_AMOUNT ||
    typeof quote.source_amount_drops !== "string" || !/^[1-9]\d*$/.test(quote.source_amount_drops) ||
    quote.max_slippage_bps !== RLUSD_ACQUISITION_SLIPPAGE_BPS ||
    typeof quote.maximum_input_drops !== "string" || !/^[1-9]\d*$/.test(quote.maximum_input_drops)
  ) throw new Error("Exact-output RLUSD quote reference is invalid");
  const recomputed = maximumInputDrops(BigInt(quote.source_amount_drops), quote.max_slippage_bps);
  if (
    recomputed.toString() !== quote.maximum_input_drops ||
    recomputed > RLUSD_ACQUISITION_XRP_CAP_DROPS
  ) throw new Error("Exact-output RLUSD quote reference has an unsafe rounded cap");
  return recomputed;
}

function assertAmmEligibilityReference(reference, account) {
  if (
    !isRecord(reference) || reference.source !== "amm_info.validated.constant_product" ||
    reference.network !== "testnet" || reference.account !== account ||
    !Number.isSafeInteger(reference.ledger_index) || reference.ledger_index < 1 ||
    typeof reference.ledger_hash !== "string" || !/^[A-F0-9]{64}$/.test(reference.ledger_hash) ||
    !isXrpAsset(reference.source_asset) || !isRecord(reference.destination_amount) ||
    reference.destination_amount.currency !== RLUSD_CURRENCY ||
    reference.destination_amount.issuer !== RLUSD_ISSUER ||
    reference.destination_amount.value !== RLUSD_ACQUISITION_AMOUNT ||
    typeof reference.xrp_reserve_drops !== "string" || !/^[1-9]\d*$/.test(reference.xrp_reserve_drops) ||
    typeof reference.rlusd_reserve !== "string" ||
    !Number.isInteger(reference.trading_fee) ||
    reference.max_slippage_bps !== RLUSD_ACQUISITION_SLIPPAGE_BPS
  ) throw new Error("AMM eligibility quote reference is invalid");
  const recomputed = quoteOfficialRlusdAmm({
    Asset: { currency: "XRP" },
    Asset2: { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER },
    Amount: reference.xrp_reserve_drops,
    Amount2: { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER, value: reference.rlusd_reserve },
    TradingFee: reference.trading_fee,
  }, RLUSD_ACQUISITION_AMOUNT, 50);
  if (
    reference.quoted_input_drops !== recomputed.acquire.quotedInputDrops ||
    reference.maximum_input_drops !== recomputed.acquire.maximumInputDrops ||
    !recomputed.acquire.withinOnePercent ||
    BigInt(recomputed.acquire.maximumInputDrops) > RLUSD_ACQUISITION_XRP_CAP_DROPS
  ) throw new Error("AMM eligibility quote reference has inconsistent exact arithmetic");
  return BigInt(reference.maximum_input_drops);
}

export function assertFixedSellXrpFloor(transaction, minimumXrp) {
  const drops = transaction?.TakerPays;
  const minimumDrops = Math.ceil(minimumXrp * 1_000_000);
  if (
    typeof drops !== "string" || !/^\d+$/.test(drops) ||
    !Number.isSafeInteger(minimumDrops) || minimumDrops < 1 ||
    BigInt(drops) < BigInt(minimumDrops)
  ) throw new Error("Swap XRP proceeds fall below the independently quoted slippage floor");
}

export function acquisitionSwapArgs(account, intentId) {
  return {
    account,
    network: "testnet",
    intent_id: intentId,
    sell: { currency: "XRP" },
    buy: { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER },
    amount: { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER, value: RLUSD_ACQUISITION_AMOUNT },
    side: "buy",
    max_slippage_bps: 100,
    execution_mode: "fill_or_kill",
  };
}

export function assertRlusdAcquisitionTransaction(transaction, account, references) {
  if (!isRecord(references)) throw new Error("RLUSD acquisition quote references are unavailable");
  const ammCap = assertAmmEligibilityReference(references.ammEligibilityQuote, account);
  const maxDrops = assertExactOutputQuoteReference(references.executionQuote, account);
  if (
    references.ammEligibilityQuote.source === references.executionQuote.source ||
    !isRecord(transaction) || !Number.isSafeInteger(transaction.LastLedgerSequence)
  ) throw new Error("RLUSD acquisition quote sources or transaction freshness are invalid");
  const buildLedger = transaction.LastLedgerSequence - 4;
  const executionQuoteGap = buildLedger - references.executionQuote.ledger_index;
  const legacyExecutionQuote = references.executionQuote.rounding_reference ===
    LEGACY_HARBOR_EXACT_OUTPUT_ROUNDING_REFERENCE;
  const executionQuoteIsFresh = legacyExecutionQuote
    ? Math.abs(executionQuoteGap) <= MAX_AMM_REFERENCE_LEDGER_AGE
    : executionQuoteGap >= 0 && executionQuoteGap <= MAX_EXACT_OUTPUT_QUOTE_LEDGER_GAP;
  if (
    !executionQuoteIsFresh ||
    references.ammEligibilityQuote.ledger_index >= transaction.LastLedgerSequence ||
    Math.abs(buildLedger - references.ammEligibilityQuote.ledger_index) >
      MAX_AMM_REFERENCE_LEDGER_AGE
  ) {
    throw new Error("RLUSD acquisition quote reference is stale for the transaction window");
  }
  const spendsDrops = transaction?.TakerGets;
  if (
    !isRecord(transaction) || transaction.TransactionType !== "OfferCreate" ||
    transaction.Account !== account || "Delegate" in transaction ||
    transaction.Flags !== OFFER_TF_FILL_OR_KILL ||
    typeof spendsDrops !== "string" || !/^[1-9]\d*$/.test(spendsDrops) ||
    BigInt(spendsDrops) > maxDrops ||
    BigInt(spendsDrops) > RLUSD_ACQUISITION_XRP_CAP_DROPS ||
    !isRecord(transaction.TakerPays) ||
    transaction.TakerPays.currency !== RLUSD_CURRENCY ||
    transaction.TakerPays.issuer !== RLUSD_ISSUER ||
    transaction.TakerPays.value !== RLUSD_ACQUISITION_AMOUNT
  ) throw new Error("RLUSD acquisition did not preserve the exact FOK amount and XRP cap");
  void ammCap;
  return BigInt(spendsDrops);
}

async function validatedOfficialRlusdAmm() {
  return withClient("testnet", async (client) => {
    const response = await client.request({
      command: "amm_info",
      asset: { currency: "XRP" },
      asset2: { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER },
      ledger_index: "validated",
    });
    if (
      response.result.validated !== true ||
      !Number.isSafeInteger(response.result.ledger_index) || response.result.ledger_index < 1 ||
      typeof response.result.ledger_hash !== "string" || !/^[A-F0-9]{64}$/i.test(response.result.ledger_hash)
    ) {
      throw new Error("Validated official RLUSD AMM state is unavailable");
    }
    return {
      ledgerIndex: response.result.ledger_index,
      ledgerHash: response.result.ledger_hash.toUpperCase(),
      amm: normalizeOfficialRlusdAmm(response.result.amm),
    };
  });
}

async function validatedExactOutputRlusdQuote(account) {
  return withClient("testnet", async (client) => {
    const response = await client.request({
      command: "ripple_path_find",
      source_account: account,
      destination_account: account,
      destination_amount: {
        currency: RLUSD_CURRENCY,
        issuer: RLUSD_ISSUER,
        value: RLUSD_ACQUISITION_AMOUNT,
      },
      source_currencies: [{ currency: "XRP" }],
      ledger_index: "validated",
    });
    return normalizeExactOutputRlusdQuote(response.result, account);
  });
}

export function normalizeOfficialRlusdAmm(amm) {
  if (!isRecord(amm)) throw new Error("Validated official RLUSD AMM state is unavailable");
  const positiveXrp = (value) => typeof value === "string" && /^[1-9]\d*$/.test(value);
  const positiveRlusd = (value) => isRecord(value) &&
    value.currency === RLUSD_CURRENCY && value.issuer === RLUSD_ISSUER &&
    typeof value.value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.value) &&
    Number.isFinite(Number(value.value)) && Number(value.value) > 0;
  const xrpFirst = positiveXrp(amm.amount) && positiveRlusd(amm.amount2);
  const xrpSecond = positiveRlusd(amm.amount) && positiveXrp(amm.amount2);
  if (!xrpFirst && !xrpSecond) {
    throw new Error("Validated AMM amounts do not identify the official XRP/RLUSD pool");
  }
  const rlusdFrozen = xrpFirst ? amm.asset2_frozen : amm.asset_frozen;
  if (rlusdFrozen !== false) {
    throw new Error("Official RLUSD AMM pool side is frozen or its eligibility is uncertain");
  }
  if (!Number.isInteger(amm.trading_fee) || amm.trading_fee < 0 || amm.trading_fee > 1_000) {
    throw new Error("Validated official RLUSD AMM fee is unavailable");
  }
  return {
    Asset: { currency: "XRP" },
    Asset2: { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER },
    Amount: xrpFirst ? amm.amount : amm.amount2,
    Amount2: xrpFirst ? amm.amount2 : amm.amount,
    TradingFee: amm.trading_fee,
    RlusdFrozen: rlusdFrozen,
  };
}

async function preflight() {
  const config = await harborConfig();
  const [acquisition, sale, validatedAmm] = await Promise.all([
    harborOp(config, "dex.depth", {
      network: "testnet",
      taker_gets: { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER },
      taker_pays: { currency: "XRP" },
      ledger_index: "validated",
      limit: 400,
    }),
    harborOp(config, "dex.depth", {
      network: "testnet",
      taker_gets: { currency: "XRP" },
      taker_pays: { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER },
      ledger_index: "validated",
      limit: 400,
    }),
    validatedOfficialRlusdAmm(),
  ]);
  const acquisitionAvailable = Number(acquisition.totals?.taker_gets);
  const saleAvailable = Number(sale.totals?.taker_pays);
  const withinOnePercent = (depth, amountField, priceForLevel, acceptable) => {
    const levels = Array.isArray(depth.levels) ? depth.levels : [];
    const best = levels.length ? priceForLevel(levels[0]) : Number.NaN;
    let available = 0;
    for (const level of levels) {
      const price = priceForLevel(level);
      if (!Number.isFinite(price) || !acceptable(price, best)) break;
      available += Number(level[amountField]);
    }
    return { available, best };
  };
  const acquisitionBound = withinOnePercent(
    acquisition,
    "taker_gets",
    (level) => Number(level.taker_pays) / Number(level.taker_gets),
    (price, best) => price <= best * 1.01,
  );
  const saleBound = withinOnePercent(
    sale,
    "taker_pays",
    (level) => Number(level.taker_gets) / Number(level.taker_pays),
    (price, best) => price >= best * 0.99,
  );
  const ammQuote = quoteOfficialRlusdAmm(validatedAmm.amm, 75, 50);
  const ammSufficient =
    ammQuote.acquire.withinOnePercent &&
    ammQuote.sale.priceImpactBps <= 100;
  safeResult("p-live-preflight", {
    acquisition: {
      ledgerIndex: acquisition.ledger_index,
      availableRlusd: Number.isFinite(acquisitionAvailable) ? acquisitionAvailable : null,
      withinOnePercentRlusd: acquisitionBound.available,
      requiredRlusd: 75,
      offerCount: acquisition.totals?.offer_count,
    },
    sale: {
      ledgerIndex: sale.ledger_index,
      availableRlusd: Number.isFinite(saleAvailable) ? saleAvailable : null,
      withinOnePercentRlusd: saleBound.available,
      requiredRlusd: 50,
      offerCount: sale.totals?.offer_count,
    },
    amm: {
      ledgerIndex: validatedAmm.ledgerIndex,
      xrpReserve: ammQuote.xrpReserve,
      rlusdReserve: ammQuote.rlusdReserve,
      tradingFee: ammQuote.tradingFee,
      rlusdFrozen: validatedAmm.amm.RlusdFrozen,
      acquire75RlusdQuotedXrp: ammQuote.acquire.quotedXrp,
      acquire75RlusdCappedXrpAtOnePercent: ammQuote.acquire.cappedXrpAtOnePercent,
      acquirePriceImpactBps: ammQuote.acquire.priceImpactBps,
      sell50RlusdQuotedXrp: ammQuote.sale.quotedXrp,
      sell50RlusdFlooredXrpAtOnePercent: ammQuote.sale.flooredXrpAtOnePercent,
      sellPriceImpactBps: ammQuote.sale.priceImpactBps,
    },
    officialIssuer: RLUSD_ISSUER,
    sufficient: ammSufficient,
    note: "CLOB metrics are diagnostic; the acceptance gate uses the validated executable AMM quote.",
  });
  if (!ammSufficient) {
    throw new Error("Official Testnet RLUSD AMM quote cannot fund and execute the required gate within 1%");
  }
}

async function onboard() {
  const config = await harborConfig();
  const wallet = await loadOrCreateOwner();
  await faucet("testnet", wallet.classicAddress);
  await ensureTrustLine(config, wallet);
  await ensureRlusd(config, wallet);
  const link = await activeLink(config, wallet);
  safeResult("onboarding-pass", {
    owner: wallet.classicAddress,
    delegate: link.delegate,
    permissions: link.permissions.length,
    rlusdBalance: await rlusdBalance(config, wallet.classicAddress),
  });
}

async function ensureTestnetAcquisitionHeadroom(wallet) {
  const minimum = RLUSD_ACQUISITION_XRP_CAP_DROPS + RLUSD_ACQUISITION_HEADROOM_DROPS;
  let balance = await xrpBalanceDrops("testnet", wallet.classicAddress);
  for (let attempt = 0; balance < minimum && attempt < 4; attempt += 1) {
    const response = await fetch(TESTNET_FAUCET, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ destination: wallet.classicAddress }),
    });
    if (!response.ok) throw new Error(`Testnet faucet top-up returned HTTP ${response.status}`);
    const previous = balance;
    for (let poll = 0; poll < 20; poll += 1) {
      balance = await xrpBalanceDrops("testnet", wallet.classicAddress);
      if (balance > previous) break;
      if (poll < 19) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (balance <= previous) throw new Error("Testnet faucet top-up was not validated");
  }
  if (balance < minimum) {
    throw new Error("Testnet owner lacks the conservative XRP headroom required for the capped acquisition");
  }
  return balance;
}

async function prepareRlusdAcquisition() {
  const { operationId, approvedOwner } = acquisitionApproval();
  return withAcquisitionLock(operationId, async () => {
    const wallet = await loadOrCreateOwner({ allowCreate: false });
    const config = await harborConfig();
    return prepareRlusdAcquisitionLocked({ operationId, approvedOwner, wallet, config });
  });
}

export async function prepareRlusdAcquisitionLocked(
  { operationId, approvedOwner, wallet, config },
  {
    activateAccount = faucet,
    readTrustLine = rlusdBalanceState,
    ensureExactTrustLine = ensureTrustLine,
    readXrpBalance = xrpBalanceDrops,
    ensureHeadroom = ensureTestnetAcquisitionHeadroom,
    readIssuerFlags = officialRlusdIssuerFlags,
    report = safeResult,
  } = {},
) {
  if (wallet.classicAddress !== approvedOwner) {
    throw new Error("Scoped acquisition credential does not match the exact approved owner");
  }

  await activateAccount("testnet", wallet.classicAddress);
  const trustBefore = await readTrustLine(config, wallet.classicAddress);
  await ensureExactTrustLine(config, wallet);
  const balanceBeforeDrops = await readXrpBalance("testnet", wallet.classicAddress);
  const balanceAfterDrops = await ensureHeadroom(wallet);
  const trustAfter = await readTrustLine(config, wallet.classicAddress);
  const issuerFlags = await readIssuerFlags(config, trustAfter);
  assertUsableOfficialRlusdTrustLine(trustAfter, issuerFlags);

  const detail = {
    operationId,
    owner: approvedOwner,
    network: "testnet",
    issuer: RLUSD_ISSUER,
    currency: RLUSD_CURRENCY,
    amount: RLUSD_ACQUISITION_AMOUNT,
    capDrops: RLUSD_ACQUISITION_XRP_CAP_DROPS.toString(),
    requiredBalanceDrops: (RLUSD_ACQUISITION_XRP_CAP_DROPS + RLUSD_ACQUISITION_HEADROOM_DROPS).toString(),
    balanceDrops: balanceAfterDrops.toString(),
    trustLineBalance: trustAfter.balance,
    trustLineLedgerIndex: trustAfter.ledgerIndex,
    trustLineLedgerHash: trustAfter.ledgerHash,
    issuerRequiresAuthorization: (issuerFlags & ACCOUNT_LSF_REQUIRE_AUTH) !== 0,
    issuerGlobalFreeze: (issuerFlags & ACCOUNT_LSF_GLOBAL_FREEZE) !== 0,
    trustLineCreated: trustBefore.balance === undefined,
    faucetToppedUp: balanceAfterDrops > balanceBeforeDrops,
    acquisitionAttempted: false,
  };
  report("rlusd-acquisition-prepared", detail);
  return detail;
}

async function acquireRlusd() {
  if (process.env.P_LIVE_HARBOR_FOK_DEPLOYED !== "1") {
    throw new Error("RLUSD acquisition is locked until the reviewed Harbor FOK contract is confirmed deployed");
  }
  if (process.env.P_LIVE_HARBOR_OWNER_APPROVAL_DEPLOYED !== "1") {
    throw new Error("RLUSD acquisition is locked until Harbor force-owner-approval is confirmed deployed");
  }
  const { operationId, approvedOwner } = acquisitionApproval();
  return withAcquisitionLock(operationId, () => acquireRlusdLocked(operationId, approvedOwner));
}

async function acquireRlusdLocked(operationId, approvedOwner) {
  let state = await loadAcquisitionState();
  const wallet = await loadOrCreateOwner({ allowCreate: false });
  if (wallet.classicAddress !== approvedOwner) {
    throw new Error("Scoped acquisition credential does not match the exact approved owner");
  }
  const integrityKey = wallet.privateKey;
  if (state !== undefined) {
    assertAcquisitionStateIntegrity(state, integrityKey);
    assertAcquisitionStateBinding(state, { operationId, owner: approvedOwner });
  }
  const persistSealedState = async (nextState) => {
    const sealed = sealAcquisitionState(nextState, integrityKey);
    await persistAcquisitionState(sealed);
    return sealed;
  };

  const config = await harborConfig();
  if (state === undefined) {
    state = await persistSealedState({
      version: 3,
      operation_id: operationId,
      owner: approvedOwner,
      network: "testnet",
      issuer: RLUSD_ISSUER,
      currency: RLUSD_CURRENCY,
      amount: RLUSD_ACQUISITION_AMOUNT,
      cap_drops: RLUSD_ACQUISITION_XRP_CAP_DROPS.toString(),
      intent_id: `p-live-acquire-rlusd-${operationId}`,
      status: "initialized",
      created_at: new Date().toISOString(),
    });
  }
  const verify = async (outcome, persisted) => {
    if (
      !isRecord(outcome) || outcome.hash?.toUpperCase() !== persisted.hash ||
      outcome.validated !== true || outcome.engine_result !== "tesSUCCESS" ||
      !Number.isSafeInteger(outcome.ledger_index)
    ) throw new Error("RLUSD acquisition reconciliation did not return the exact validated transaction");
    const validated = await validatedTransaction("testnet", persisted.hash);
    if (outcome.ledger_index !== validated.ledgerIndex) {
      throw new Error("RLUSD acquisition reconciliation ledger does not match the validated transaction");
    }
    const maximumOfferSpendDrops = assertRlusdAcquisitionTransaction(
      validated.tx,
      wallet.classicAddress,
      {
        ammEligibilityQuote: persisted.amm_eligibility_quote,
        executionQuote: persisted.execution_quote,
      },
    );
    const after = await waitForRlusdBalanceAtOrAfter(
      config,
      wallet.classicAddress,
      validated.ledgerIndex,
    );
    if (after.balance === undefined) {
      throw new Error("Official Testnet RLUSD trust line disappeared after acquisition");
    }
    assertExactRlusdBalanceDelta(persisted.balance_before, after.balance, RLUSD_ACQUISITION_AMOUNT);
    return {
      ledger_index: validated.ledgerIndex,
      balance_after: after.balance,
      balance_after_ledger_index: after.ledgerIndex,
      maximum_offer_spend_drops: maximumOfferSpendDrops.toString(),
    };
  };
  const report = (persisted, resumed) => safeResult("rlusd-acquisition-pass", {
    operationId: persisted.operation_id,
    hash: persisted.hash,
    ledgerIndex: persisted.ledger_index,
    balanceLedgerIndex: persisted.balance_after_ledger_index,
    ammLedgerIndex: persisted.amm_eligibility_quote.ledger_index,
    executionQuoteLedgerIndex: persisted.execution_quote.ledger_index,
    acquiredRlusd: RLUSD_ACQUISITION_AMOUNT,
    maximumOfferSpendDrops: persisted.maximum_offer_spend_drops,
    fundedBalanceDrops: persisted.funded_balance_drops,
    executionMode: "fill_or_kill",
    resumed,
  });

  const resume = await resumeAcquisitionBeforeFreshQuote(state, {
    verifyValidated: async (persisted) => {
      const validated = await validatedTransaction("testnet", persisted.hash);
      const maximumOfferSpendDrops = assertRlusdAcquisitionTransaction(
        validated.tx,
        wallet.classicAddress,
        {
          ammEligibilityQuote: persisted.amm_eligibility_quote,
          executionQuote: persisted.execution_quote,
        },
      );
      if (
        validated.ledgerIndex !== persisted.ledger_index ||
        maximumOfferSpendDrops.toString() !== persisted.maximum_offer_spend_drops
      ) throw new Error("Persisted RLUSD acquisition completion does not match the validated transaction");
      assertExactRlusdBalanceDelta(
        persisted.balance_before,
        persisted.balance_after,
        RLUSD_ACQUISITION_AMOUNT,
      );
      report(persisted, true);
    },
    reconcileSigned: async (persisted) => {
      const reconciled = await reconcileAcquisitionSubmission(persisted, {
        lookup: (hash, lastLedgerSequence) =>
          recoverSignedSubmission("testnet", hash, lastLedgerSequence),
        verify,
        persist: persistSealedState,
      });
      report(reconciled.state, true);
      return reconciled.state;
    },
    loadFreshQuote: validatedOfficialRlusdAmm,
  });
  if (resume.handled) return;

  if (state.status === "initialized" || state.status === "ready") {
    const eligibilityAmm = resume.freshQuote;
    const eligibilityQuote = quoteOfficialRlusdAmm(
      eligibilityAmm.amm,
      RLUSD_ACQUISITION_AMOUNT,
      50,
    );
    if (
      !eligibilityQuote.acquire.withinOnePercent ||
      BigInt(eligibilityQuote.acquire.maximumInputDrops) > RLUSD_ACQUISITION_XRP_CAP_DROPS
    ) throw new Error("Validated AMM eligibility exceeds the approved one-percent or 275 XRP acquisition cap");
    let eligibilityReference = ammEligibilityReference(
      eligibilityAmm,
      eligibilityQuote,
      wallet.classicAddress,
    );

    await faucet("testnet", wallet.classicAddress);
    await ensureTrustLine(config, wallet);
    const fundedBalanceDrops = await ensureTestnetAcquisitionHeadroom(wallet);
    if (state.status === "initialized") {
      const before = await rlusdBalanceState(config, wallet.classicAddress);
      if (before.balance === undefined) throw new Error("Official Testnet RLUSD trust line is missing before acquisition");
      const validatedAmm = await validatedOfficialRlusdAmm();
      const quote = quoteOfficialRlusdAmm(validatedAmm.amm, RLUSD_ACQUISITION_AMOUNT, 50);
      if (
        !quote.acquire.withinOnePercent ||
        BigInt(quote.acquire.maximumInputDrops) > RLUSD_ACQUISITION_XRP_CAP_DROPS
      ) throw new Error("Fresh validated AMM quote exceeds the approved one-percent or 275 XRP acquisition cap");
      eligibilityReference = ammEligibilityReference(validatedAmm, quote, wallet.classicAddress);
      state = await persistSealedState({
        ...Object.fromEntries(Object.entries(state).filter(
          ([key]) => !["quoted_cap_xrp", "amm_ledger_index", "integrity"].includes(key),
        )),
        version: 3,
        status: "ready",
        balance_before: before.balance,
        balance_before_ledger_index: before.ledgerIndex,
        amm_eligibility_quote: eligibilityReference,
        funded_balance_drops: fundedBalanceDrops.toString(),
      });
    }

    if (state.status === "ready") {
      const executionQuote = await validatedExactOutputRlusdQuote(wallet.classicAddress);
      const build = await harborOp(config, "tx.swap", acquisitionSwapArgs(wallet.classicAddress, state.intent_id));
      assertSafeBuild(build, {
        account: wallet.classicAddress,
        network: "testnet",
        transactionType: "OfferCreate",
      });
      const buildAccount = await validatedAccountState("testnet", wallet.classicAddress);
      assertSafeOwnerTransaction(build.tx_json, wallet.classicAddress, buildAccount.ledgerIndex, buildAccount.sequence);
      assertRlusdAcquisitionTransaction(build.tx_json, wallet.classicAddress, {
        ammEligibilityQuote: eligibilityReference,
        executionQuote,
      });
      state = await persistSealedState({
        ...Object.fromEntries(Object.entries(state).filter(
          ([key]) => !["quoted_cap_xrp", "amm_ledger_index", "integrity"].includes(key),
        )),
        version: 3,
        status: "built",
        build_id: build.build_id,
        tx_json: build.tx_json,
        amm_eligibility_quote: eligibilityReference,
        execution_quote: executionQuote,
      });
    }
  }
  const current = await validatedAccountState("testnet", wallet.classicAddress);
  if (
    current.sequence !== state.tx_json?.Sequence ||
    current.ledgerIndex >= state.tx_json?.LastLedgerSequence
  ) {
    state = await persistSealedState({
      ...state,
      status: "expired_unsubmitted",
      reconciled_at: new Date().toISOString(),
    });
    throw new Error("Persisted unsigned RLUSD acquisition build is stale and definitively unsubmitted");
  }
  const execution = await harborOp(
    config,
    "tx.execute",
    acquisitionExecuteArgs(state.build_id, state.intent_id),
  );
  const quoteExpiredState = acquisitionQuoteExpiredState(state, execution);
  if (quoteExpiredState) {
    state = await persistSealedState(quoteExpiredState);
    throw new Error("Persisted exact-output RLUSD quote expired before approval and was not submitted");
  }
  if (
    execution?.status === "needs_approval" &&
    Number.isFinite(Date.parse(execution.expires_at)) &&
    Date.parse(execution.expires_at) <= Date.now()
  ) {
    state = await persistSealedState({
      ...state,
      status: "expired_unsubmitted",
      reconciled_at: new Date().toISOString(),
    });
    throw new Error("Persisted RLUSD acquisition approval expired before signing and was not submitted");
  }
  assertApprovalMatchesBuild({ tx_json: state.tx_json }, execution);
  assertExactOutputApprovalWindow(state.tx_json, execution.tx_json);
  assertSafeOwnerTransaction(
    execution.tx_json,
    wallet.classicAddress,
    current.ledgerIndex,
    current.sequence,
  );
  assertRlusdAcquisitionTransaction(execution.tx_json, wallet.classicAddress, {
    ammEligibilityQuote: state.amm_eligibility_quote,
    executionQuote: state.execution_quote,
  });
  const txBlob = sign(wallet, execution.tx_json);
  const hash = hashes.hashSignedTx(txBlob).toUpperCase();
  state = await persistSealedState({
    ...state,
    status: "signed_pending",
    hash,
    last_ledger_sequence: execution.tx_json.LastLedgerSequence,
    tx_json: execution.tx_json,
    signed_at: new Date().toISOString(),
  });
  let result;
  try {
    result = await harborOp(
      config,
      "tx.submit",
      approvalSubmitArgs(txBlob, "testnet", execution.approval_id),
    );
    if (
      !isRecord(result) || result.hash?.toUpperCase() !== hash || result.validated !== true ||
      result.engine_result !== "tesSUCCESS" || !Number.isSafeInteger(result.ledger_index)
    ) throw new Error("RLUSD acquisition submission did not return exact validated success");
    const completion = await verify(result, state);
    state = await persistSealedState({
      ...state,
      ...completion,
      status: "validated",
      validated_at: new Date().toISOString(),
    });
  } catch (submitError) {
    try {
      const reconciled = await reconcileAcquisitionSubmission(state, {
        lookup: (publicHash, lastLedgerSequence) =>
          recoverSignedSubmission("testnet", publicHash, lastLedgerSequence),
        verify,
        persist: persistSealedState,
      });
      state = reconciled.state;
    } catch (reconcileError) {
      throw new AggregateError([submitError, reconcileError], "RLUSD acquisition submission could not be safely reconciled");
    }
  }
  report(state, false);
}

async function gate() {
  throw new Error(
    "Direct P2.4 execution is disabled to prevent a duplicate 50 RLUSD trade; run it exactly once through the chat/card acceptance path",
  );
}

async function approval() {
  const config = await harborConfig();
  const wallet = await loadOrCreateOwner();
  const approvalAmm = await validatedOfficialRlusdAmm();
  const approvalQuote = quoteOfficialRlusdAmm(approvalAmm.amm, 75, 20);
  await withTemporaryPolicy(
    config,
    wallet.classicAddress,
    "testnet",
    (policy) => ({ ...policy, execute_under_usd: 10 }),
    async () => {
      const balanceBefore = await rlusdBalanceText(config, wallet.classicAddress);
      if (balanceBefore === undefined) throw new Error("Official RLUSD balance is unavailable before approval flow");
      const intentId = `p-live-approval-${randomUUID()}`;
      const build = await harborOp(config, "tx.swap", {
        account: wallet.classicAddress,
        network: "testnet",
        intent_id: intentId,
        sell: { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER },
        buy: { currency: "XRP" },
        amount: { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER, value: "20" },
        side: "sell",
        max_slippage_bps: 100,
        execution_mode: "fill_or_kill",
      });
      assertSafeBuild(build, {
        account: wallet.classicAddress,
        network: "testnet",
        transactionType: "OfferCreate",
      });
      if (
        !isRecord(build.tx_json.TakerGets) ||
        build.tx_json.TakerGets.currency !== RLUSD_CURRENCY ||
        build.tx_json.TakerGets.issuer !== RLUSD_ISSUER ||
        build.tx_json.TakerGets.value !== "20" ||
        typeof build.tx_json.TakerPays !== "string" ||
        Number(build.tx_json.Flags) !== (OFFER_TF_FILL_OR_KILL | OFFER_TF_SELL)
      ) throw new Error("Over-limit approval build did not preserve the exact 20 RLUSD sale intent");
      assertFixedSellXrpFloor(build.tx_json, approvalQuote.sale.flooredXrpAtOnePercent);
      const execution = await harborOp(config, "tx.execute", {
        build_id: build.build_id,
        idempotency_key: intentId,
      });
      if (execution.status !== "needs_approval") {
        throw new Error(`Over-limit swap returned ${execution.status}`);
      }
      assertApprovalMatchesBuild(build, execution);
      const result = await submitOwner(config, wallet, execution.tx_json, "testnet", execution.approval_id);
      const validated = await validatedTransaction("testnet", result.hash);
      const flags = Number(validated.tx.Flags ?? 0);
      if (
        validated.tx.TransactionType !== "OfferCreate" || validated.tx.Account !== wallet.classicAddress ||
        "Delegate" in validated.tx || !isRecord(validated.tx.TakerGets) ||
        validated.tx.TakerGets.currency !== RLUSD_CURRENCY || validated.tx.TakerGets.issuer !== RLUSD_ISSUER ||
        validated.tx.TakerGets.value !== "20" || typeof validated.tx.TakerPays !== "string" ||
        flags !== (OFFER_TF_FILL_OR_KILL | OFFER_TF_SELL)
      ) {
        throw new Error("Over-limit swap was not validated as owner-signed only");
      }
      assertFixedSellXrpFloor(validated.tx, approvalQuote.sale.flooredXrpAtOnePercent);
      const balanceAfter = await rlusdBalanceText(config, wallet.classicAddress);
      if (balanceAfter === undefined) throw new Error("Official RLUSD balance is unavailable after approval flow");
      assertExactRlusdBalanceDelta(balanceBefore, balanceAfter, "-20");
      safeResult("over-limit-approval-pass", { hash: result.hash, ledgerIndex: validated.ledgerIndex });
    },
  );
}

async function vaultApproval() {
  const config = await harborConfig();
  const wallet = await loadOrCreateOwner();
  await faucet("devnet", wallet.classicAddress);
  const link = await activeLink(config, wallet, "devnet");
  const before = await validatedVaultInfo();
  const intentId = `p-live-vault-${randomUUID()}`;
  const build = await harborOp(config, "tx.vaultDeposit", {
    account: wallet.classicAddress,
    network: "devnet",
    intent_id: intentId,
    vault_id: DEVNET_VAULT_ID,
    amount: "100000000",
  });
  assertSafeBuild(build, {
    account: wallet.classicAddress,
    network: "devnet",
    transactionType: "VaultDeposit",
  });
  const buildAccount = await validatedAccountState("devnet", wallet.classicAddress);
  assertSafeOwnerTransaction(
    build.tx_json,
    wallet.classicAddress,
    buildAccount.ledgerIndex,
    buildAccount.sequence,
  );
  if (build.tx_json.VaultID !== DEVNET_VAULT_ID || build.tx_json.Amount !== "100000000") {
    throw new Error("Devnet vault build did not preserve the exact vault and amount");
  }
  const execution = await harborOp(config, "tx.execute", {
    build_id: build.build_id,
    idempotency_key: intentId,
  });
  if (execution.status !== "needs_approval") {
    throw new Error(`Devnet vault deposit returned ${execution.status}`);
  }
  assertApprovalMatchesBuild(build, execution);
  const result = await submitOwner(
    config,
    wallet,
    execution.tx_json,
    "devnet",
    execution.approval_id,
  );
  const validated = await validatedTransaction("devnet", result.hash);
  const tx = validated.tx;
  if (
    tx.TransactionType !== "VaultDeposit" || tx.Account !== wallet.classicAddress ||
    tx.VaultID !== DEVNET_VAULT_ID || tx.Amount !== "100000000" || "Delegate" in tx
  ) {
    throw new Error("Vault deposit was not validated as owner-signed only");
  }
  const after = await validatedVaultInfo();
  if (after.ledger_index < validated.ledgerIndex || vaultAssetsTotal(after) - vaultAssetsTotal(before) !== 100000000n) {
    throw new Error("Validated Vault AssetsTotal did not increase by exactly 100 XRP");
  }
  safeResult("vault-approval-pass", {
    hash: result.hash,
    network: "devnet",
    ledgerIndex: validated.ledgerIndex,
    delegate: link.delegate,
    vaultLedgerBefore: before.ledger_index,
    vaultLedgerAfter: after.ledger_index,
    depositedDrops: "100000000",
  });
}

async function devnetLink() {
  const config = await harborConfig();
  const wallet = await loadOrCreateOwner();
  await faucet("devnet", wallet.classicAddress);
  const link = await activeLink(config, wallet, "devnet");
  safeResult("devnet-link-pass", {
    owner: wallet.classicAddress,
    delegate: link.delegate,
    permissions: link.permissions.length,
  });
}

async function linkStatus() {
  const config = await harborConfig();
  const wallet = await loadOrCreateOwner();
  const outcomes = {};
  for (const network of ["testnet", "devnet"]) {
    try {
      const link = await harborOp(config, "account.status", {
        owner: wallet.classicAddress,
        network,
      });
      outcomes[network] = {
        status: link.status,
        ownerMatches: link.owner === wallet.classicAddress,
        networkMatches: link.network === network,
        permissionCount: Array.isArray(link.permissions) ? link.permissions.length : null,
        hasPreparedDelegateSet: isRecord(link.delegate_set_tx),
        delegateFunded: typeof link.delegate === "string"
          ? await accountExists(network, link.delegate)
          : false,
      };
    } catch (error) {
      outcomes[network] = { error: error instanceof Error ? error.message : "unknown failure" };
    }
  }
  safeResult("link-status", { owner: wallet.classicAddress, outcomes });
}

async function fundPendingDevnetDelegate() {
  const config = await harborConfig();
  const wallet = await loadOrCreateOwner();
  const link = await harborOp(config, "account.status", {
    owner: wallet.classicAddress,
    network: "devnet",
  });
  if (
    link.owner !== wallet.classicAddress || link.network !== "devnet" ||
    link.status !== "pending" || typeof link.delegate !== "string" ||
    JSON.stringify(link.permissions) !== JSON.stringify(DEFAULT_PERMISSIONS)
  ) {
    throw new Error("Refusing to fund a delegate that is not the exact scoped pending Devnet link");
  }
  await faucet("devnet", link.delegate);
  safeResult("pending-devnet-delegate-funded", {
    owner: wallet.classicAddress,
    permissionCount: link.permissions.length,
    note: "Manual recovery evidence only; this does not satisfy automated Harbor faucet onboarding.",
  });
}

async function expiredApproval() {
  const config = await harborConfig();
  const wallet = await loadOrCreateOwner();
  if (!(await accountExists("devnet", wallet.classicAddress))) {
    throw new Error("Expired-approval acceptance requires an existing funded Devnet owner");
  }
  await activeLink(config, wallet, "devnet");
  const before = await validatedVaultInfo();
  const intentId = `p-live-expired-vault-${randomUUID()}`;
  const build = await harborOp(config, "tx.vaultDeposit", {
    account: wallet.classicAddress,
    network: "devnet",
    intent_id: intentId,
    vault_id: DEVNET_VAULT_ID,
    amount: "1000000",
  });
  assertSafeBuild(build, {
    account: wallet.classicAddress,
    network: "devnet",
    transactionType: "VaultDeposit",
  });
  const buildAccount = await validatedAccountState("devnet", wallet.classicAddress);
  assertSafeOwnerTransaction(
    build.tx_json,
    wallet.classicAddress,
    buildAccount.ledgerIndex,
    buildAccount.sequence,
  );
  if (build.tx_json.VaultID !== DEVNET_VAULT_ID || build.tx_json.Amount !== "1000000") {
    throw new Error("Expired approval build did not preserve the exact vault and amount");
  }
  const execution = await harborOp(config, "tx.execute", {
    build_id: build.build_id,
    idempotency_key: intentId,
  });
  if (execution.status !== "needs_approval") {
    throw new Error(`Expired-approval setup returned ${execution.status}`);
  }
  assertApprovalMatchesBuild(build, execution);
  const expiry = Date.parse(execution.expires_at);
  if (!Number.isFinite(expiry)) throw new Error("Harbor returned an invalid approval expiry");
  while (Date.now() <= expiry + 2_000) {
    safeResult("expired-approval-wait", { remainingSeconds: Math.max(0, Math.ceil((expiry - Date.now()) / 1_000)) });
    await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, Math.max(1_000, expiry + 2_001 - Date.now()))));
  }
  const txBlob = sign(wallet, execution.tx_json);
  const hash = hashes.hashSignedTx(txBlob).toUpperCase();
  const args = { tx_blob: txBlob, approval_id: execution.approval_id, network: "devnet" };
  const first = await harborOpError(config, "tx.submit", args);
  assertApprovalExpiredRefusal(first);
  const second = await harborOpError(config, "tx.submit", args);
  assertApprovalExpiredRefusal(second);
  if (first.code !== second.code) {
    throw new Error("Harbor did not return a stable expired-approval refusal");
  }
  await withClient("devnet", async (client) => {
    try {
      await client.request({ command: "tx", transaction: hash, binary: false });
      throw new Error("Expired approval transaction lookup returned a transaction");
    } catch (error) {
      assertExactTxnNotFound(error);
    }
  });
  const after = await validatedVaultInfo();
  if (vaultAssetsTotal(after) !== vaultAssetsTotal(before)) {
    throw new Error("Expired approval changed validated Vault state");
  }
  safeResult("expired-approval-pass", {
    hash,
    code: first.code,
    refusalCount: 2,
    repeatedCode: second.code,
    approvalSpecificMessageVerified: true,
    transactionLookup: { error: "txnNotFound" },
    refusalAttempts: [
      { status: first.status, code: first.code, message: first.message },
      { status: second.status, code: second.code, message: second.message },
    ],
    vaultLedgerBefore: before.ledger_index,
    vaultLedgerAfter: after.ledger_index,
    vaultAssetsTotalBefore: vaultAssetsTotal(before).toString(),
    vaultAssetsTotalAfter: vaultAssetsTotal(after).toString(),
    validatedVaultAssetsUnchanged: true,
  });
}

export async function revokeTestnetOfferCreateLink(
  { config, wallet },
  {
    readActiveLink = activeLink,
    callHarbor = harborOp,
    submit = submitOwner,
    readValidatedTransaction = validatedTransaction,
  } = {},
) {
  const current = await readActiveLink(
    config,
    wallet,
    "testnet",
    OFFER_CREATE_ONLY_PERMISSIONS,
  );
  const prepared = await callHarbor(config, "account.revoke", {
    owner: wallet.classicAddress,
    network: "testnet",
  });
  const revokePermissions = Array.isArray(prepared.revoke_tx?.Permissions)
    ? prepared.revoke_tx.Permissions.map((entry) => entry?.Permission?.PermissionValue)
    : undefined;
  if (
    prepared.owner !== wallet.classicAddress || prepared.network !== "testnet" ||
    prepared.delegate !== current.delegate || !isRecord(prepared.revoke_tx) ||
    prepared.revoke_tx.TransactionType !== "DelegateSet" ||
    prepared.revoke_tx.Account !== wallet.classicAddress ||
    prepared.revoke_tx.Authorize !== current.delegate ||
    !Array.isArray(revokePermissions) || revokePermissions.length !== 0
  ) throw new Error("Revocation did not preserve the exact active delegation");
  const result = await submit(config, wallet, prepared.revoke_tx, "testnet");
  const validated = await readValidatedTransaction("testnet", result.hash);
  const validatedPermissions = Array.isArray(validated.tx?.Permissions)
    ? validated.tx.Permissions.map((entry) => entry?.Permission?.PermissionValue)
    : undefined;
  if (
    validated.tx?.TransactionType !== "DelegateSet" ||
    validated.tx.Account !== wallet.classicAddress ||
    validated.tx.Authorize !== current.delegate || "Delegate" in validated.tx ||
    !Array.isArray(validatedPermissions) || validatedPermissions.length !== 0
  ) throw new Error("Validated revocation transaction did not clear the exact active delegation");
  const status = await callHarbor(config, "account.status", {
    owner: wallet.classicAddress,
    network: "testnet",
  });
  if (
    status.owner !== wallet.classicAddress || status.network !== "testnet" ||
    status.delegate !== current.delegate || status.status !== "revoked" ||
    !Array.isArray(status.permissions) || status.permissions.length !== 0
  ) throw new Error("Revocation did not validate against the exact active delegation");
  return { current, result, status, validated };
}

async function revoke() {
  const config = await harborConfig();
  const wallet = await loadOrCreateOwner({ allowCreate: false });
  const { current, result, status } = await revokeTestnetOfferCreateLink({ config, wallet });
  safeResult("revoke-pass", {
    hash: result.hash,
    previousDelegate: current.delegate,
    status: status.status,
    permissions: status.permissions,
  });
}

const actions = {
  preflight,
  provision,
  "topup-devnet-owner": topUpDevnetOwner,
  onboard,
  "prepare-rlusd-acquisition": prepareRlusdAcquisition,
  "acquire-rlusd": acquireRlusd,
  "testnet-offercreate-link": testnetOfferCreateLink,
  gate,
  approval,
  "link-status": linkStatus,
  "fund-pending-devnet-delegate": fundPendingDevnetDelegate,
  "devnet-link": devnetLink,
  "vault-approval": vaultApproval,
  "expired-approval": expiredApproval,
  revoke,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const requested = process.argv[2];
  if (!(requested in actions)) {
    throw new Error(`Usage: p-live-live.mjs ${Object.keys(actions).join("|")}`);
  }
  await actions[requested]();
}

export {
  actions,
  approvalSubmitArgs,
  assertApprovalMatchesBuild,
  assertSafeBuild,
  assertSafeOwnerTransaction,
  validatedTransaction,
  withTemporaryPolicy,
};
