#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { encodeAccountID, isValidClassicAddress, Wallet } from "xrpl";

import {
  LIVE_BUY_STABLE_VALUE,
  MAX_AUTOFILL_FEE_DROPS,
  MAX_LIVE_XRP_SPEND_DROPS,
  requireBuyLiquidity,
  requireDelegateFeeHeadroom,
  requireExactStableIncrease,
  requireLivePolicy,
  requireRevocableLiveStatus,
  requireRlusdPurchaseBuild,
  requireStableReceiveCapacity,
  requireSpendableXrp,
} from "./live-guards.mjs";

const FIXED_TESTNET_RLUSD_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const LIVE_ACK = "delegate-offercreate-test-only";
const OWNER_ACTION_ACK = "sign-delegateset-and-submit";
const REVOKE_ACK = "sign-revoke-and-submit";
const DEFAULT_DELEGATED_PERMISSIONS = Object.freeze([
  "OfferCreate",
  "OfferCancel",
  "TrustSet",
  "AMMDeposit",
  "AMMWithdraw",
  "EscrowFinish",
  "CheckCash",
]);
const MAX_OWNER_LEDGER_WINDOW = 256;
const DEV_VAR_ALLOWLIST = new Set([
  "EXEC_NETWORK",
  "HARBOR_API_KEY",
  "HARBOR_API_KEYS",
  "HARBOR_MCP_URL",
  "HARBOR_URL",
  "STABLE_CODE",
  "STABLE_ISSUER_DEVNET",
]);
const DEFAULT_GOLDEN = new URL("./golden.jsonl", import.meta.url);
const FALLBACK_READ_ACCOUNT = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

function usage() {
  process.stdout.write(`Harbor MCP evaluation\n\n` +
    `Score the 30 non-submitting golden cases:\n` +
    `  node eval/run.mjs --url https://<worker>.workers.dev/mcp\n\n` +
    `Run the explicitly opted-in delegated test-network workflow, then score all 30 cases:\n` +
    `  node eval/run.mjs --url https://<worker>.workers.dev/mcp --live\n\n` +
    `Add --revoke to owner-sign and submit the prepared revocation after verification.\n`);
}

function parseArgs(argv) {
  const options = { golden: DEFAULT_GOLDEN, live: false, revoke: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    }
    if (argument === "--live") options.live = true;
    else if (argument === "--revoke") options.revoke = true;
    else if (argument === "--url") options.url = argv[++index];
    else if (argument === "--golden") options.golden = resolve(argv[++index]);
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (options.revoke && !options.live) {
    throw new Error("--revoke requires --live");
  }
  return options;
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function loadDevVars(path = ".dev.vars") {
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (
      !match ||
      !DEV_VAR_ALLOWLIST.has(match[1]) ||
      process.env[match[1]] !== undefined
    ) continue;
    process.env[match[1]] = unquote(match[2]);
  }
}

function requireValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required configuration: ${name}`);
  return value;
}

function mcpUrl(cliUrl) {
  const configured = cliUrl ?? process.env.HARBOR_MCP_URL ?? process.env.HARBOR_URL;
  if (!configured) {
    throw new Error("Provide --url, HARBOR_MCP_URL, or HARBOR_URL");
  }
  const url = new URL(configured);
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/mcp";
  if (url.pathname !== "/mcp") throw new Error("Harbor MCP URL must end in /mcp");
  return url;
}

function requireSafeTransport(url) {
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"))
  ) {
    throw new Error("Harbor MCP URL must use HTTPS or explicit HTTP loopback");
  }
}

function bearerCredential() {
  const direct = process.env.HARBOR_API_KEY?.trim();
  if (direct) return direct;
  const pairs = requireValue("HARBOR_API_KEYS");
  const first = pairs.split(",").map((value) => value.trim()).find(Boolean);
  if (!first || first.indexOf(":") <= 0) {
    throw new Error("HARBOR_API_KEYS must contain at least one principal:key pair");
  }
  return first;
}

async function connect(url) {
  const client = new Client(
    { name: "harbor-golden-eval", version: "1.0.0" },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: { authorization: `Bearer ${bearerCredential()}` },
    },
  });
  await client.connect(transport);
  return { client, transport };
}

function textResult(result) {
  const text = result.content
    ?.filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  if (!text) throw new Error("MCP tool returned no text content");
  if (result.isError) throw new Error("MCP tool reported an error");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("MCP tool returned non-JSON text");
  }
}

async function callTool(client, name, args) {
  return textResult(await client.callTool({ name, arguments: args }));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expectCase(value, expectation) {
  if (expectation.kind === "search_names") {
    if (!Array.isArray(value)) throw new Error("search result is not an array");
    const names = new Set(value.map((entry) => isRecord(entry) ? entry.name : undefined));
    for (const expected of expectation.includes) {
      if (!names.has(expected)) throw new Error(`search did not include ${expected}`);
    }
    return;
  }
  if (expectation.kind === "envelope" || expectation.kind === "envelope_ok") {
    if (!isRecord(value) || typeof value.ok !== "boolean") {
      throw new Error("result is not a Harbor envelope");
    }
    if (expectation.kind === "envelope_ok" && value.ok !== true) {
      const code = isRecord(value.error) && typeof value.error.code === "string"
        ? ` (${value.error.code})`
        : "";
      throw new Error(`operation returned an error envelope${code}`);
    }
    if (
      expectation.contains !== undefined &&
      !JSON.stringify(value).includes(expectation.contains)
    ) {
      throw new Error(`result did not contain ${expectation.contains}`);
    }
    return;
  }
  if (expectation.kind === "envelope_error") {
    if (!isRecord(value) || value.ok !== false || !isRecord(value.error)) {
      throw new Error("result is not a Harbor error envelope");
    }
    if (
      expectation.contains !== undefined &&
      !JSON.stringify(value).includes(expectation.contains)
    ) {
      throw new Error(`error envelope did not contain ${expectation.contains}`);
    }
    return;
  }
  if (expectation.kind === "object_keys") {
    if (!isRecord(value)) throw new Error("result is not an object");
    for (const key of expectation.includes) {
      if (!(key in value)) throw new Error(`result is missing ${key}`);
    }
    return;
  }
  throw new Error(`Unknown expectation kind: ${expectation.kind}`);
}

function currencyCode(value) {
  if (/^[A-Za-z0-9?!@#$%^&*<>(){}\[\]|]{3}$/.test(value)) return value;
  if (/^[A-Fa-f0-9]{40}$/.test(value)) return value.toUpperCase();
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length === 0 || bytes.length > 20) {
    throw new Error("Stable currency must encode to at most 20 bytes");
  }
  return bytes.toString("hex").toUpperCase().padEnd(40, "0");
}

function evalVariables() {
  const network = process.env.HARBOR_EVAL_NETWORK ?? process.env.EXEC_NETWORK ?? "testnet";
  if (network !== "testnet" && network !== "devnet") {
    throw new Error("HARBOR_EVAL_NETWORK must be testnet or devnet");
  }
  const stableCode = network === "testnet"
    ? "RLUSD"
    : requireValue("STABLE_CODE");
  const stableIssuer = network === "testnet"
    ? FIXED_TESTNET_RLUSD_ISSUER
    : requireValue("STABLE_ISSUER_DEVNET");
  const runId = randomUUID();
  // This is only an address-shaped sentinel. No signing key or credential is
  // generated, and a per-run AccountID makes an existing scoped link infeasible.
  const revokeProbeOwner = encodeAccountID(
    createHash("sha256").update(`harbor-revoke-probe:${runId}`).digest().subarray(0, 20),
  );
  // An address-only destination keeps Payment simulation distinct from the
  // owner without creating a wallet or signing credential. The golden corpus
  // never submits this transaction.
  const paymentDestination = encodeAccountID(
    createHash("sha256").update(`harbor-payment-destination:${runId}`).digest().subarray(0, 20),
  );
  return {
    NETWORK: network,
    OWNER: process.env.HARBOR_EVAL_READ_ACCOUNT ??
      process.env.H_SAFETY_TEST_OWNER_TESTNET_ADDRESS ??
      FALLBACK_READ_ACCOUNT,
    DESTINATION: process.env.HARBOR_EVAL_READ_DESTINATION ?? paymentDestination,
    REVOKE_PROBE_OWNER: revokeProbeOwner,
    RUN_ID: runId,
    STABLE_CURRENCY: currencyCode(stableCode),
    STABLE_ISSUER: stableIssuer,
    STABLE_CODE: stableCode,
  };
}

function substitute(value, variables) {
  if (typeof value === "string") {
    return value.replace(/\$([A-Z][A-Z0-9_]*)/g, (_match, name) => {
      if (!(name in variables)) throw new Error(`Unknown golden variable: ${name}`);
      return variables[name];
    });
  }
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, variables));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, substitute(entry, variables)]),
    );
  }
  return value;
}

async function readGolden(source) {
  const contents = await readFile(source, "utf8");
  const lines = contents.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length !== 30) {
    throw new Error(`Golden corpus must contain exactly 30 questions; found ${lines.length}`);
  }
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`Invalid JSON on golden line ${index + 1}`);
    }
  });
}

function safeMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/seed|secret|private|mnemonic|s[A-Za-z0-9]{20,}/i.test(message)) {
    return "sensitive configuration or signing operation failed (details suppressed)";
  }
  return message.slice(0, 240);
}

async function runGolden(client, source, variableOverrides = {}) {
  const questions = await readGolden(source);
  const variables = { ...evalVariables(), ...variableOverrides };
  let passed = 0;
  const failedRequired = [];
  for (const question of questions) {
    try {
      const result = await callTool(
        client,
        question.tool,
        substitute(question.arguments, variables),
      );
      expectCase(result, question.expect);
      passed += 1;
      process.stdout.write(`PASS ${question.id} [${question.category}] ${question.question}\n`);
    } catch (error) {
      if (question.required === true) failedRequired.push(question.id);
      process.stdout.write(`FAIL ${question.id} [${question.category}] ${safeMessage(error)}\n`);
    }
  }
  const threshold = 27;
  process.stdout.write(`\nGolden score: ${passed}/30 (required ${threshold}/30)\n`);
  if (failedRequired.length > 0) {
    process.stdout.write(`Required live-backed cases failed: ${failedRequired.join(", ")}\n`);
  }
  if (passed < threshold || failedRequired.length > 0) process.exitCode = 1;
  return passed;
}

function ownerWalletConfig(network) {
  // Deliberately no fallback to TEST_WALLETS_*: those fixtures may be retired.
  let parsed;
  const raw = process.env.HARBOR_EVAL_FRESH_OWNER_WALLET?.trim();
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("HARBOR_EVAL_FRESH_OWNER_WALLET must be JSON");
    }
  } else if (network === "testnet") {
    parsed = {
      address: requireValue("H_SAFETY_TEST_OWNER_TESTNET_ADDRESS"),
      seed: requireValue("H_SAFETY_TEST_OWNER_TESTNET_SEED"),
    };
  } else {
    throw new Error(
      "Devnet live evaluation requires HARBOR_EVAL_FRESH_OWNER_WALLET",
    );
  }
  if (!isRecord(parsed) || typeof parsed.address !== "string" || typeof parsed.seed !== "string") {
    throw new Error("HARBOR_EVAL_FRESH_OWNER_WALLET must contain address and signing material");
  }
  if (requireValue("HARBOR_EVAL_OWNER_CONFIRM") !== parsed.address) {
    throw new Error("HARBOR_EVAL_OWNER_CONFIRM does not match the fresh owner address");
  }
  const wallet = Wallet.fromSeed(parsed.seed);
  if (wallet.classicAddress !== parsed.address) {
    throw new Error("Fresh owner address does not match its signing material");
  }
  return wallet;
}

function requireLiveGuards(options) {
  if (requireValue("HARBOR_EVAL_LIVE") !== LIVE_ACK) {
    throw new Error(`HARBOR_EVAL_LIVE must equal ${LIVE_ACK}`);
  }
  if (requireValue("HARBOR_EVAL_OWNER_ACTION") !== OWNER_ACTION_ACK) {
    throw new Error(`HARBOR_EVAL_OWNER_ACTION must equal ${OWNER_ACTION_ACK}`);
  }
  if (requireValue("HARBOR_EVAL_FRESH_ACCOUNT") !== "true") {
    throw new Error("HARBOR_EVAL_FRESH_ACCOUNT must equal true");
  }
  if (options.revoke && requireValue("HARBOR_EVAL_REVOKE_ACTION") !== REVOKE_ACK) {
    throw new Error(`HARBOR_EVAL_REVOKE_ACTION must equal ${REVOKE_ACK}`);
  }
}

async function harborOp(client, operation, args) {
  const path = operation.split(".");
  if (
    path.length < 2 ||
    path.length > 3 ||
    !path.every((part) => /^[A-Za-z][A-Za-z0-9]*$/.test(part))
  ) {
    throw new Error("Unsafe operation name");
  }
  const access = path.map((part) => `[${JSON.stringify(part)}]`).join("");
  const code = `return await harbor${access}(${JSON.stringify(args)});`;
  return callTool(client, "execute", { code });
}

function requireOkEnvelope(value, operation) {
  if (!isRecord(value) || value.ok !== true || !("data" in value)) {
    throw new Error(`${operation} did not return a successful Harbor envelope`);
  }
  return value.data;
}

function findStableLine(value, issuer, currency) {
  const lines = isRecord(value) && Array.isArray(value.lines) ? value.lines : [];
  return lines.find((line) =>
    isRecord(line) &&
    line.account === issuer &&
    (line.currency === currency || currencyCode(String(line.currency)) === currency),
  );
}

function requireLedgerIndex(value, operation) {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.ledger_index) ||
    value.ledger_index < 1
  ) {
    throw new Error(`${operation} did not return a validated ledger index`);
  }
  return value.ledger_index;
}

function requireLivePrerequisites(accountInfo, lines, reserves, stable) {
  if (
    !isRecord(accountInfo) ||
    !isRecord(accountInfo.account_data)
  ) {
    throw new Error("Fresh owner is not faucet-funded on the selected network");
  }
  requireLedgerIndex(accountInfo, "ledger.account.info");
  const balance = requireStableReceiveCapacity(
    findStableLine(lines, stable.issuer, stable.currency),
  );
  if (
    !isRecord(reserves) ||
    typeof reserves.reserve_base_xrp !== "number" ||
    !Number.isFinite(reserves.reserve_base_xrp) ||
    reserves.reserve_base_xrp < 0 ||
    typeof reserves.reserve_inc_xrp !== "number" ||
    !Number.isFinite(reserves.reserve_inc_xrp) ||
    reserves.reserve_inc_xrp < 0
  ) {
    throw new Error("server.reserves did not return bounded reserve requirements");
  }
  return balance;
}

function signedBlob(wallet, txJson) {
  if (!isRecord(txJson)) throw new Error("Owner transaction is missing");
  const signed = wallet.sign(txJson);
  if (!signed || typeof signed.tx_blob !== "string") {
    throw new Error("Local owner signing failed");
  }
  return signed.tx_blob;
}

function permissionValues(value) {
  if (!Array.isArray(value)) throw new Error("DelegateSet Permissions must be an array");
  return value.map((entry) => {
    const permission = isRecord(entry) ? entry.Permission : undefined;
    const permissionValue = isRecord(permission) ? permission.PermissionValue : undefined;
    if (typeof permissionValue !== "string") {
      throw new Error("DelegateSet contains a malformed permission");
    }
    return permissionValue;
  });
}

function equalStringArrays(left, right) {
  return left.length === right.length &&
    left.every((entry, index) => entry === right[index]);
}

function requireUnsignedDelegateSet(txJson, expected) {
  if (
    !isRecord(txJson) ||
    txJson.TransactionType !== "DelegateSet" ||
    txJson.Account !== expected.owner ||
    txJson.Authorize !== expected.delegate ||
    "TxnSignature" in txJson ||
    "Signers" in txJson ||
    typeof txJson.Fee !== "string" ||
    !/^\d+$/.test(txJson.Fee) ||
    BigInt(txJson.Fee) < 1n ||
    BigInt(txJson.Fee) > MAX_AUTOFILL_FEE_DROPS ||
    !Number.isSafeInteger(txJson.Sequence) ||
    txJson.Sequence < 1 ||
    !Number.isSafeInteger(txJson.LastLedgerSequence) ||
    txJson.LastLedgerSequence <= expected.ledgerIndex ||
    txJson.LastLedgerSequence > expected.ledgerIndex + MAX_OWNER_LEDGER_WINDOW
  ) {
    throw new Error("Owner transaction is not the expected unsigned DelegateSet");
  }
  const actualPermissions = permissionValues(txJson.Permissions);
  if (!equalStringArrays(actualPermissions, expected.permissions)) {
    throw new Error("DelegateSet permissions differ from the reviewed link permissions");
  }
}

function findValidatedTransaction(value, hash) {
  const stack = [value];
  while (stack.length) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (!isRecord(current)) continue;
    const tx = isRecord(current.tx_json)
      ? current.tx_json
      : isRecord(current.tx)
        ? current.tx
        : current;
    const candidateHash = current.hash ?? tx.hash;
    if (candidateHash === hash && typeof tx.Account === "string") return tx;
    stack.push(...Object.values(current));
  }
  return undefined;
}

async function submitOwnerBlob(client, blob, network) {
  const result = requireOkEnvelope(
    await harborOp(client, "tx.submit", { tx_blob: blob, network }),
    "tx.submit",
  );
  if (!isRecord(result) || typeof result.hash !== "string") {
    throw new Error("tx.submit did not return a validated hash");
  }
  return result;
}

async function revokeLiveLink(client, wallet, owner, network, expectedDelegate) {
  const currentStatus = requireOkEnvelope(
    await harborOp(client, "account.status", { owner, network }),
    "account.status",
  );
  const delegate = requireRevocableLiveStatus(currentStatus, expectedDelegate);
  if (delegate === undefined) {
    process.stdout.write("Revocation already validated; the link is revoked.\n");
    return;
  }
  if (!isValidClassicAddress(delegate)) {
    throw new Error("Revocable delegation has an invalid delegate address");
  }
  const currentAccountInfo = requireOkEnvelope(
    await harborOp(client, "ledger.account.info", {
      network,
      account: owner,
      ledger_index: "validated",
    }),
    "ledger.account.info",
  );
  const revoked = requireOkEnvelope(
    await harborOp(client, "account.revoke", { owner, network }),
    "account.revoke",
  );
  if (!isRecord(revoked) || !isRecord(revoked.revoke_tx)) {
    throw new Error("account.revoke did not return a prepared revocation");
  }
  requireUnsignedDelegateSet(revoked.revoke_tx, {
    owner,
    delegate,
    permissions: [],
    ledgerIndex: requireLedgerIndex(currentAccountInfo, "ledger.account.info"),
  });
  await submitOwnerBlob(client, signedBlob(wallet, revoked.revoke_tx), network);
  const finalStatus = requireOkEnvelope(
    await harborOp(client, "account.status", { owner, network }),
    "account.status",
  );
  if (!isRecord(finalStatus) || finalStatus.status !== "revoked") {
    throw new Error("Revocation did not become validated");
  }
  process.stdout.write("Revocation validated; the link is revoked.\n");
}

async function simulateLivePurchase(client, owner, stable) {
  const build = requireOkEnvelope(
    await harborOp(client, "tx.simulate", {
      network: stable.network,
      account: owner,
      tx_json: {
        TransactionType: "OfferCreate",
        Account: owner,
        TakerGets: MAX_LIVE_XRP_SPEND_DROPS.toString(),
        TakerPays: {
          currency: stable.currency,
          issuer: stable.issuer,
          value: LIVE_BUY_STABLE_VALUE,
        },
        Flags: 0x0004_0000,
      },
      intent_id: `harbor-eval-${Date.now()}`,
    }),
    "tx.simulate",
  );
  if (!isRecord(build) || typeof build.build_id !== "string") {
    throw new Error("tx.simulate did not return a stored build");
  }
  requireRlusdPurchaseBuild(build, { owner, stable });
  return build;
}

function requireLiveBuildPolicy(policy, stable, build) {
  requireLivePolicy(
    policy,
    stable,
    isRecord(build.summary) ? build.summary.usd_value : undefined,
  );
}

async function runLive(client, options) {
  requireLiveGuards(options);
  const variables = evalVariables();
  const wallet = ownerWalletConfig(variables.NETWORK);
  const owner = wallet.classicAddress;
  const stable = {
    network: variables.NETWORK,
    currency: variables.STABLE_CURRENCY,
    issuer: variables.STABLE_ISSUER,
  };

  const [
    accountInfoEnvelope,
    linesEnvelope,
    policyEnvelope,
    reservesEnvelope,
    opposingDepthEnvelope,
    sameSideDepthEnvelope,
  ] = await Promise.all([
    harborOp(client, "ledger.account.info", {
      network: stable.network,
      account: owner,
      ledger_index: "validated",
    }),
    harborOp(client, "ledger.account.lines", {
      network: stable.network,
      account: owner,
      ledger_index: "validated",
    }),
    harborOp(client, "policy.get", { network: stable.network, owner }),
    harborOp(client, "server.reserves", { network: stable.network }),
    harborOp(client, "dex.depth", {
      network: stable.network,
      taker_gets: { currency: stable.currency, issuer: stable.issuer },
      taker_pays: { currency: "XRP" },
      ledger_index: "validated",
      limit: 100,
    }),
    harborOp(client, "dex.depth", {
      network: stable.network,
      taker_gets: { currency: "XRP" },
      taker_pays: { currency: stable.currency, issuer: stable.issuer },
      ledger_index: "validated",
      limit: 100,
    }),
  ]);
  const accountInfo = requireOkEnvelope(accountInfoEnvelope, "ledger.account.info");
  const reserves = requireOkEnvelope(reservesEnvelope, "server.reserves");
  const initialStableBalance = requireLivePrerequisites(
    accountInfo,
    requireOkEnvelope(linesEnvelope, "ledger.account.lines"),
    reserves,
    stable,
  );
  requireBuyLiquidity(
    requireOkEnvelope(opposingDepthEnvelope, "dex.depth"),
    requireOkEnvelope(sameSideDepthEnvelope, "dex.depth"),
  );
  requireSpendableXrp(
    accountInfo,
    reserves,
    MAX_LIVE_XRP_SPEND_DROPS,
    options.revoke ? 2 : 1,
  );

  const policy = requireOkEnvelope(policyEnvelope, "policy.get");
  let build = await simulateLivePurchase(client, owner, stable);
  requireLiveBuildPolicy(policy, stable, build);

  let workflowError;
  let reviewedDelegate;
  try {
    const link = requireOkEnvelope(
      await harborOp(client, "account.link", { owner, network: stable.network }),
      "account.link",
    );
    if (!isRecord(link) || typeof link.delegate !== "string" || !isRecord(link.delegate_set_tx)) {
      throw new Error("account.link did not return a delegate and DelegateSet");
    }
    if (link.owner !== owner || link.network !== stable.network) {
      throw new Error("account.link returned a different owner or network");
    }
    if (!Array.isArray(link.permissions) || !equalStringArrays(
      link.permissions,
      DEFAULT_DELEGATED_PERMISSIONS,
    )) {
      throw new Error("account.link did not return exactly the seven approved default permissions");
    }
    requireUnsignedDelegateSet(link.delegate_set_tx, {
      owner,
      delegate: link.delegate,
      permissions: DEFAULT_DELEGATED_PERMISSIONS,
      ledgerIndex: accountInfo.ledger_index,
    });
    reviewedDelegate = link.delegate;
    process.stdout.write(`Linked fresh owner ${owner} to delegate ${link.delegate}.\n`);

    const grantBlob = signedBlob(wallet, link.delegate_set_tx);
    await submitOwnerBlob(client, grantBlob, stable.network);
    const active = requireOkEnvelope(
      await harborOp(client, "account.status", { owner, network: stable.network }),
      "account.status",
    );
    if (!isRecord(active) || active.status !== "active") {
      throw new Error("Delegation did not become active after DelegateSet validation");
    }
    if (
      active.delegate !== link.delegate ||
      !Array.isArray(active.permissions) ||
      !equalStringArrays(active.permissions, DEFAULT_DELEGATED_PERMISSIONS)
    ) {
      throw new Error("Active delegation differs from the approved link");
    }
    process.stdout.write("DelegateSet validated and link is active.\n");
    // The owner-signed DelegateSet consumes the owner's prior sequence. Rebuild
    // the identical FOK offer after validation, then re-check its current USD
    // notional against the unchanged policy before delegated signing.
    build = await simulateLivePurchase(client, owner, stable);
    requireLiveBuildPolicy(policy, stable, build);
    const delegateAccountInfo = requireOkEnvelope(
      await harborOp(client, "ledger.account.info", {
        network: stable.network,
        account: link.delegate,
        ledger_index: "validated",
      }),
      "ledger.account.info",
    );
    requireDelegateFeeHeadroom(delegateAccountInfo);

    const execution = requireOkEnvelope(
      await harborOp(client, "tx.execute", {
        build_id: build.build_id,
        idempotency_key: `harbor-eval-${randomUUID()}`,
      }),
      "tx.execute",
    );
    if (
      !isRecord(execution) ||
      execution.status !== "executed" ||
      execution.signed_by !== "delegate" ||
      typeof execution.hash !== "string"
    ) {
      throw new Error("Delegated OfferCreate was not executed");
    }

    const [historyEnvelope, postLinesEnvelope] = await Promise.all([
      harborOp(client, "ledger.account.tx", {
        network: stable.network,
        account: owner,
        tx_type: "OfferCreate",
        delegate: {
          delegate_filter: "actor",
          counter_party: link.delegate,
        },
        limit: 10,
        forward: false,
      }),
      harborOp(client, "ledger.account.lines", {
        network: stable.network,
        account: owner,
        ledger_index: "validated",
      }),
    ]);
    const history = requireOkEnvelope(historyEnvelope, "ledger.account.tx");
    const validatedTx = findValidatedTransaction(history, execution.hash);
    if (!validatedTx) throw new Error("Validated OfferCreate was not found in account history");
    if (
      validatedTx.TransactionType !== "OfferCreate" ||
      validatedTx.Account !== owner ||
      validatedTx.Delegate !== link.delegate
    ) {
      throw new Error("Validated OfferCreate type, Account, or Delegate did not match the link");
    }
    const postStableLine = findStableLine(
      requireOkEnvelope(postLinesEnvelope, "ledger.account.lines"),
      stable.issuer,
      stable.currency,
    );
    if (!isRecord(postStableLine) || typeof postStableLine.balance !== "string") {
      throw new Error("Validated OfferCreate removed or malformed the stable trust line");
    }
    requireExactStableIncrease(initialStableBalance, postStableLine.balance);
    process.stdout.write(
      `Validated delegated OfferCreate ${execution.hash}: Account=${owner}, Delegate=${link.delegate}.\n`,
    );
    return owner;
  } catch (error) {
    workflowError = error;
    throw error;
  } finally {
    if (options.revoke) {
      try {
        await revokeLiveLink(client, wallet, owner, stable.network, reviewedDelegate);
      } catch (revokeError) {
        if (workflowError) {
          throw new AggregateError(
            [workflowError, revokeError],
            "Live workflow failed and revocation recovery failed",
          );
        }
        throw revokeError;
      }
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const url = mcpUrl(options.url);
  requireSafeTransport(url);
  await loadDevVars();
  const { client, transport } = await connect(url);
  try {
    const liveOwner = options.live ? await runLive(client, options) : undefined;
    await runGolden(
      client,
      options.golden,
      liveOwner === undefined ? {} : { OWNER: liveOwner },
    );
  } finally {
    await transport.close();
  }
}

main().catch((error) => {
  process.stderr.write(`Evaluation failed: ${safeMessage(error)}\n`);
  process.exitCode = 1;
});
