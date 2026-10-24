#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { isValidClassicAddress } from "xrpl";

const MAX_EVIDENCE_BYTES = 32 * 1024;
const MINIMUM_XRP_APP_VERSION = Object.freeze([2, 8, 2]);
const MINIMUM_CHROME_VERSION = Object.freeze([89, 0, 0, 0]);
const OFFICIAL_RLUSD = Object.freeze({
  currency: "524C555344000000000000000000000000000000",
  issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
});
const REQUIRED_PERMISSIONS = Object.freeze([
  "OfferCreate",
  "OfferCancel",
  "TrustSet",
  "AMMDeposit",
  "AMMWithdraw",
  "EscrowFinish",
  "CheckCash",
]);
const CANONICAL_UINT = /^(?:0|[1-9]\d*)$/;
const CANONICAL_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const CHROME_VERSION = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/;
const APP_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const LEDGER_HASH = /^[A-F0-9]{64}$/;

export class LedgerPreflightError extends Error {
  constructor(check, message) {
    super(`${check}: ${message}`);
    this.name = "LedgerPreflightError";
    this.check = check;
  }
}

function fail(check, message) {
  throw new LedgerPreflightError(check, message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(check, value, expectedKeys) {
  if (!isRecord(value)) fail(check, "report must be an object");
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(check, "report shape is not the approved version");
  }
}

function assertLiteral(check, value, expected, label) {
  if (value !== expected) fail(check, `${label} must be ${JSON.stringify(expected)}`);
}

function assertBoolean(check, value, expected, label) {
  if (value !== expected) fail(check, `${label} must be ${expected}`);
}

function assertClassicAddress(check, value, label) {
  if (typeof value !== "string" || !isValidClassicAddress(value)) {
    fail(check, `${label} is not a canonical XRPL classic address`);
  }
}

function numericVersion(check, value, pattern, label) {
  if (typeof value !== "string") fail(check, `${label} is missing`);
  const match = pattern.exec(value);
  if (!match) fail(check, `${label} is not a canonical version`);
  return match.slice(1).map(Number);
}

function atLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

function assertPositiveCanonical(check, value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value) || Number(value) <= 0) {
    fail(check, `${label} must be a positive canonical number`);
  }
}

function checkBrowser(report) {
  const check = "browser";
  assertExactKeys(check, report, ["source", "product", "version", "navigator_hid"]);
  assertLiteral(check, report.source, "browser-capability-probe", "source");
  assertLiteral(check, report.product, "Chrome", "product");
  const chromeVersion = numericVersion(check, report.version, CHROME_VERSION, "Chrome version");
  if (!atLeast(chromeVersion, MINIMUM_CHROME_VERSION)) {
    fail(check, "Chrome must support WebHID (version 89 or newer)");
  }
  assertBoolean(check, report.navigator_hid, true, "navigator.hid capability");
  return `Chrome ${report.version}; navigator.hid available`;
}

function checkDevice(report, expected) {
  const check = "device";
  assertExactKeys(check, report, [
    "source",
    "transport",
    "connected",
    "app_name",
    "app_version",
    "account_index",
    "address",
    "verified_on_device",
  ]);
  assertLiteral(check, report.source, "ledger-device-probe", "source");
  const expectedTransport = expected.mode === "real" ? "webhid" : "speculos";
  assertLiteral(check, report.transport, expectedTransport, "transport");
  assertBoolean(check, report.connected, true, "connection");
  assertLiteral(check, report.app_name, "XRP", "app name");
  const appVersion = numericVersion(check, report.app_version, APP_VERSION, "XRP app version");
  if (!atLeast(appVersion, MINIMUM_XRP_APP_VERSION)) {
    fail(check, "XRP app must be at least 2.8.2");
  }
  if (!Number.isSafeInteger(report.account_index) || report.account_index < 0 || report.account_index > 9) {
    fail(check, "account index must be an integer from 0 through 9");
  }
  if (report.account_index !== expected.accountIndex) {
    fail(check, "account index does not match the selected index");
  }
  assertClassicAddress(check, report.address, "address");
  assertLiteral(check, report.address, expected.address, "address");
  assertBoolean(check, report.verified_on_device, true, "on-device address verification");
  return `${expectedTransport}; XRP ${report.app_version}; account ${report.account_index}; address verified`;
}

function checkTestnet(report, expected) {
  const check = "testnet";
  assertExactKeys(check, report, [
    "source",
    "network",
    "address",
    "account_exists",
    "xrp_balance_drops",
    "validated",
    "ledger_index",
    "ledger_hash",
    "rlusd_trust_line",
  ]);
  assertLiteral(check, report.source, "xrpl-testnet-read", "source");
  assertLiteral(check, report.network, "testnet", "network");
  assertLiteral(check, report.address, expected.address, "address");
  assertBoolean(check, report.account_exists, true, "account existence");
  assertPositiveCanonical(check, report.xrp_balance_drops, CANONICAL_UINT, "XRP balance in drops");
  assertBoolean(check, report.validated, true, "validated-ledger evidence");
  if (!Number.isSafeInteger(report.ledger_index) || report.ledger_index < 1) {
    fail(check, "ledger index must be a positive safe integer");
  }
  if (typeof report.ledger_hash !== "string" || !LEDGER_HASH.test(report.ledger_hash)) {
    fail(check, "ledger hash must be uppercase 64-hex");
  }

  const line = report.rlusd_trust_line;
  assertExactKeys(check, line, [
    "currency",
    "issuer",
    "limit",
    "balance",
    "authorized",
    "frozen",
  ]);
  assertLiteral(check, line.currency, OFFICIAL_RLUSD.currency, "RLUSD currency");
  assertLiteral(check, line.issuer, OFFICIAL_RLUSD.issuer, "RLUSD issuer");
  assertLiteral(check, line.limit, "10000", "RLUSD trust limit");
  if (typeof line.balance !== "string" || !CANONICAL_DECIMAL.test(line.balance)) {
    fail(check, "RLUSD balance must be a non-negative canonical decimal");
  }
  assertBoolean(check, line.authorized, true, "RLUSD trust-line authorization");
  assertBoolean(check, line.frozen, false, "RLUSD trust-line freeze state");
  return `funded Testnet account; official RLUSD trust line usable at ledger ${report.ledger_index}`;
}

function checkHarbor(report, expected) {
  const check = "harbor";
  assertExactKeys(check, report, ["source", "network", "owner", "delegate", "status", "permissions"]);
  assertLiteral(check, report.source, "harbor-account-status", "source");
  assertLiteral(check, report.network, "testnet", "network");
  assertLiteral(check, report.owner, expected.address, "owner");
  assertClassicAddress(check, report.delegate, "delegate");
  assertLiteral(check, report.delegate, expected.delegate, "delegate");
  assertLiteral(check, report.status, "active", "link status");
  if (
    !Array.isArray(report.permissions) ||
    report.permissions.length !== REQUIRED_PERMISSIONS.length ||
    report.permissions.some((permission, index) => permission !== REQUIRED_PERMISSIONS[index])
  ) {
    fail(check, "link permissions do not match the seven-permission onboarding grant");
  }
  return `active link; ${report.permissions.length} exact permissions`;
}

function checkSpeculos(report) {
  const check = "speculos";
  assertExactKeys(check, report, [
    "source",
    "api_url",
    "apdu_url",
    "reachable",
    "public_default_seed",
    "conformance",
  ]);
  assertLiteral(check, report.source, "ledger-conformance", "source");
  assertLiteral(check, report.api_url, "http://127.0.0.1:5000", "API URL");
  assertLiteral(check, report.apdu_url, "http://127.0.0.1:9999", "APDU URL");
  assertBoolean(check, report.reachable, true, "loopback fallback reachability");
  assertBoolean(check, report.public_default_seed, true, "public default seed attestation");
  assertExactKeys(check, report.conformance, ["passed", "total"]);
  assertLiteral(check, report.conformance.passed, 10, "conformance passes");
  assertLiteral(check, report.conformance.total, 10, "conformance total");
  return "loopback-only fallback; conformance 10/10";
}

/**
 * Validate reports produced by explicit event-day probes. This function performs
 * no discovery, device, browser, network, signing, faucet, or Harbor action.
 */
export function validateLedgerPreflightEvidence(evidence, expected) {
  assertExactKeys("evidence", evidence, [
    "version",
    "mode",
    "browser",
    "device",
    "testnet",
    "harbor",
    "speculos",
  ]);
  assertLiteral("evidence", evidence.version, 2, "version");
  if (evidence.mode !== "real" && evidence.mode !== "virtual") {
    fail("evidence", "mode must be real or virtual");
  }
  if (evidence.mode !== expected.mode) fail("evidence", "mode does not match the requested mode");
  if (!Number.isSafeInteger(expected.accountIndex) || expected.accountIndex < 0 || expected.accountIndex > 9) {
    fail("arguments", "account index must be an integer from 0 through 9");
  }
  assertClassicAddress("arguments", expected.address, "expected address");
  assertClassicAddress("arguments", expected.delegate, "expected event-build delegate");

  const checks = Object.freeze([
    Object.freeze({ name: "browser", detail: checkBrowser(evidence.browser) }),
    Object.freeze({ name: "device", detail: checkDevice(evidence.device, expected) }),
    Object.freeze({ name: "testnet", detail: checkTestnet(evidence.testnet, expected) }),
    Object.freeze({ name: "harbor", detail: checkHarbor(evidence.harbor, expected) }),
    Object.freeze({ name: "speculos", detail: checkSpeculos(evidence.speculos) }),
  ]);
  return Object.freeze({
    ok: true,
    mode: expected.mode,
    address: expected.address,
    delegate: expected.delegate,
    checks,
  });
}

function usage() {
  return [
    "Usage:",
    "  node scripts/ledger/preflight.mjs --mode <real|virtual> --account-index <0..9> \\",
    "    --address <rOwnerAddress> --delegate <rDelegateAddress> \\",
    "    --evidence <event-day-report.json> [--json]",
    "",
    "The evidence file must contain only public, read-only probe results. The command",
    "does not discover a device, access a wallet, call a faucet, or contact XRPL/Harbor.",
  ].join("\n");
}

export function parseCliArguments(argv) {
  const parsed = { json: false };
  const valued = new Set(["--mode", "--account-index", "--address", "--delegate", "--evidence"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      parsed.json = true;
      continue;
    }
    if (argument === "--help") return { help: true };
    if (!valued.has(argument)) fail("arguments", `unknown argument ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail("arguments", `${argument} needs a value`);
    index += 1;
    const key = argument.slice(2).replace("account-index", "accountIndex");
    if (parsed[key] !== undefined) fail("arguments", `${argument} was provided more than once`);
    parsed[key] = value;
  }
  if (parsed.mode !== "real" && parsed.mode !== "virtual") fail("arguments", "--mode must be real or virtual");
  if (typeof parsed.address !== "string") fail("arguments", "--address is required");
  if (typeof parsed.delegate !== "string") fail("arguments", "--delegate is required");
  if (typeof parsed.evidence !== "string") fail("arguments", "--evidence is required");
  if (typeof parsed.accountIndex !== "string" || !/^(?:[0-9])$/.test(parsed.accountIndex)) {
    fail("arguments", "--account-index must be an integer from 0 through 9");
  }
  return { ...parsed, accountIndex: Number(parsed.accountIndex) };
}

export async function readEvidence(path) {
  const contents = await readFile(path);
  if (contents.byteLength === 0 || contents.byteLength > MAX_EVIDENCE_BYTES) {
    fail("evidence", `file must be between 1 and ${MAX_EVIDENCE_BYTES} bytes`);
  }
  try {
    return JSON.parse(contents.toString("utf8"));
  } catch {
    fail("evidence", "file is not valid JSON");
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCliArguments(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const evidence = await readEvidence(options.evidence);
  const result = validateLedgerPreflightEvidence(evidence, options);
  if (options.json) {
    console.log(JSON.stringify(result));
    return;
  }
  for (const check of result.checks) console.log(`PASS  ${check.name} — ${check.detail}`);
  console.log(`\n${result.checks.length}/${result.checks.length} preflight checks passed (${result.mode})`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    const message = error instanceof LedgerPreflightError ? error.message : "unexpected preflight failure";
    console.error(`FAIL  ${message}`);
    process.exitCode = 1;
  });
}
