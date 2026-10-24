import { constants as FS_CONSTANTS } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { validateLocalX402StateTree } from "./local-x402-state.mjs";
import { LOCAL_TRADING_ISOLATED_V1_STATE_ROOT } from "./dev-local-trading-isolated-v1.mjs";
import { assertMacAcl } from "./macos-acl.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_ERROR_MESSAGE =
  "Local isolated x402 preserved state is missing or unsafe";
const MARKER_MAX_BYTES = 4_096;
const D1_DIRECTORY = join("v3", "d1", "miniflare-D1DatabaseObject");
const D1_METADATA = join(D1_DIRECTORY, "metadata.sqlite");
const D1_PAYLOAD = /^[0-9a-f]{64}\.sqlite$/;
const BASE_REQUIRED_TABLES = [
  "_cf_METADATA",
  "approvals",
  "builds",
  "events",
  "executions",
  "links",
  "policies",
  "x402_payer_quarantine",
  "x402_payers",
  "x402_payments",
  "d1_migrations",
];
const X402_PAYMENT_COLUMNS = [
    "id", "principal", "idempotency_key", "request_fingerprint", "owner", "network",
    "delegate", "url", "status", "amount_drops", "caller_max_drops",
    "policy_per_call_cap_drops", "daily_cap_drops", "pay_to", "invoice_id",
    "requirements_json", "transaction_json", "signed_blob", "hash", "last_ledger_seq",
    "expires_at", "reserved_at", "signed_at", "settlement_unknown_at", "settled_at",
    "delivered_at", "failed_at", "settlement_json", "delivery_json", "failure_json",
    "created_at", "updated_at", "fee_cap_drops", "reserved_total_drops",
    "signing_started_at", "lease_acquired_at", "budget_consumed_drops",
    "budget_consumed_at",
];
const X402_PAYER_COLUMNS = [
  "principal", "owner", "network", "payer", "public_key", "ciphertext", "iv",
  "status", "funded_ledger_index", "funded_balance_drops", "created_at", "updated_at",
  "faucet_requested_at", "funding_checked_at",
];
const X402_QUARANTINE_COLUMNS = ["network", "payer", "reason", "quarantined_at"];
const PAYER_SEQUENCE_LEASE_COLUMNS = [
  "network", "payer", "generation", "lease_token", "rail", "attempt_id", "state",
  "sequence", "first_eligible_ledger_index", "last_ledger_sequence", "tx_hash",
  "acquired_at", "signing_started_at", "signed_at", "updated_at", "released_at",
  "release_reason", "resolution_ledger_index",
];
const ACCOUNT_SEQUENCE_LEASE_COLUMNS = [
  "principal", "network", "account", "generation", "lease_token", "source", "attempt_id",
  "state", "sequence", "first_ledger_sequence", "last_ledger_sequence", "tx_hash",
  "acquired_at", "updated_at", "released_at", "release_evidence",
];
const BASE_MIGRATION_NAMES = [
  "0001_init.sql",
  "0002_x402_payments.sql",
  "0003_x402_payers.sql",
  "0004_x402_sequence_safety.sql",
  "0005_x402_durable_lease.sql",
  "0006_x402_budget_accounting.sql",
  "0007_x402_payer_provisioning.sql",
];
const MIGRATION_NAMES = [
  ...BASE_MIGRATION_NAMES,
  "0009_isolated_sequence_authority.sql",
];
const COMBINED_UPGRADE_BASELINE_SCHEMA_FINGERPRINT =
  "8087e790ee8db7f69c5c89368017d396ba4061ff952cef7280fa5923dcb6a2cf";
const EXPECTED_SCHEMA_FINGERPRINT =
  "9154aefdcea17dd27f2123d01847d642be1aecc645b7f6f1ab6edd091647172d";

export const LOCAL_X402_DATABASE_PROFILE_ISOLATED_V1 = "isolated-v1";
export const LOCAL_X402_DATABASE_PROFILE_COMBINED_UPGRADE_BASELINE =
  "combined-upgrade-baseline";

function databaseProfile(profile) {
  if (profile === LOCAL_X402_DATABASE_PROFILE_ISOLATED_V1) {
    return {
      migrations: MIGRATION_NAMES,
      requiredTables: new Set([
        ...BASE_REQUIRED_TABLES,
        "payer_sequence_leases",
        "account_sequence_leases",
      ]),
      schemaFingerprint: EXPECTED_SCHEMA_FINGERPRINT,
      sequenceAuthority: true,
    };
  }
  if (profile === LOCAL_X402_DATABASE_PROFILE_COMBINED_UPGRADE_BASELINE) {
    return {
      migrations: BASE_MIGRATION_NAMES,
      requiredTables: new Set(BASE_REQUIRED_TABLES),
      schemaFingerprint: COMBINED_UPGRADE_BASELINE_SCHEMA_FINGERPRINT,
      sequenceAuthority: false,
    };
  }
  throw stateError();
}

export const LOCAL_X402_ISOLATED_V1_STATE_CONTRACT =
  "harbor-local-x402-isolated-v1-state-v1";
export const LOCAL_X402_ISOLATED_V1_STATE_MARKER =
  ".harbor-local-x402-isolated-v1-state-v1.json";
export const LOCAL_X402_ISOLATED_V1_STATE_LOCK =
  ".harbor-local-x402-isolated-v1-state-v1.lock";
export const LOCAL_X402_ISOLATED_V1_D1_BINDING = "DB";
export const LOCAL_X402_ISOLATED_V1_D1_DATABASE_ID =
  "33333333-3333-3333-3333-333333333333";
export const LOCAL_X402_ISOLATED_V1_D1_DATABASE_NAME =
  "harbor-local-x402-isolated-v1-only";
export const LOCAL_X402_ISOLATED_V1_NETWORK = "testnet";
export const LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE =
  "reviewed-testnet-isolated-v1";

function durableObjectIdFromName(namespaceKey, name) {
  const key = createHash("sha256").update(namespaceKey).digest();
  const nameMac = createHmac("sha256", key).update(name).digest().subarray(0, 16);
  const checksum = createHmac("sha256", key).update(nameMac).digest().subarray(0, 16);
  return Buffer.concat([nameMac, checksum]).toString("hex");
}

export const LOCAL_X402_ISOLATED_V1_D1_PAYLOAD_FILENAME =
  `${durableObjectIdFromName(
    "miniflare-D1DatabaseObject",
    LOCAL_X402_ISOLATED_V1_D1_DATABASE_ID,
  )}.sqlite`;

function stateError() {
  return new Error(STATE_ERROR_MESSAGE);
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function isContainedBy(parent, candidate) {
  const child = relative(parent, candidate);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function pathComponents(path) {
  return path.split(sep).filter(Boolean);
}

async function canonicalExistingDirectory(path, { privateDirectory = false } = {}) {
  const metadata = await lstat(path);
  const uid = currentUid();
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (await realpath(path)) !== path ||
    (metadata.mode & 0o022) !== 0 ||
    (privateDirectory && (metadata.mode & 0o777) !== 0o700) ||
    (uid !== undefined && metadata.uid !== uid && metadata.uid !== 0) ||
    (privateDirectory && uid !== undefined && metadata.uid !== uid)
  ) throw stateError();
  return metadata;
}

async function validateSafeParentChain(path) {
  await canonicalExistingDirectory(path, { privateDirectory: true });
  let ancestor = dirname(path);
  while (true) {
    await canonicalExistingDirectory(ancestor);
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
}

async function validatePrivateAclTree(path, assertAcl = assertMacAcl) {
  assertAcl(path, "private");
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    assertAcl(child, "private");
    if (entry.isDirectory()) await validatePrivateAclTree(child, assertAcl);
  }
}

async function isInsideCheckout(path) {
  let current = path;
  while (true) {
    for (const marker of [".git", ".hg", ".svn"]) {
      try {
        await lstat(join(current, marker));
        return true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Validate an operator-selected external persistence root. The leaf may be
 * absent for the one explicit initialization flow; its parent must already
 * exist, be canonical, and be owner-private.
 */
export async function validateConfiguredIsolatedX402StateRoot(
  stateRoot,
  {
    repoRoot = REPO_ROOT,
    tradingStateRoot = LOCAL_TRADING_ISOLATED_V1_STATE_ROOT,
  } = {},
) {
  try {
    if (
      typeof stateRoot !== "string" ||
      stateRoot.length === 0 ||
      /[\u0000-\u001f\u007f]/u.test(stateRoot) ||
      !isAbsolute(stateRoot) ||
      resolve(stateRoot) !== stateRoot ||
      pathComponents(stateRoot).includes(".wrangler") ||
      isContainedBy(resolve(repoRoot), stateRoot) ||
      isContainedBy(tradingStateRoot, stateRoot) ||
      isContainedBy(stateRoot, tradingStateRoot)
    ) throw stateError();

    // These are the historical checkout-local roots even when a caller passes
    // a lexical checkout alias through the test seam.
    const legacyRoots = [
      join(resolve(repoRoot), ".wrangler", "harbor-local-x402"),
      join(resolve(repoRoot), ".wrangler", "harbor-local-x402-isolated-v1"),
    ];
    if (legacyRoots.includes(stateRoot)) throw stateError();
    if (await isInsideCheckout(stateRoot)) throw stateError();

    try {
      const metadata = await lstat(stateRoot);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw stateError();
      if ((await realpath(stateRoot)) !== stateRoot) throw stateError();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if ((await realpath(dirname(stateRoot))) !== dirname(stateRoot)) throw stateError();
    }
    return stateRoot;
  } catch {
    throw stateError();
  }
}

/** Create exactly one absent leaf below an existing owner-private parent. */
export async function initializeIsolatedX402StateDirectory(
  stateRoot,
  options = {},
) {
  await validateConfiguredIsolatedX402StateRoot(stateRoot, options);
  const parent = dirname(stateRoot);
  try {
    await validateSafeParentChain(parent);
    (options.assertAcl ?? assertMacAcl)(parent, "private");
    try {
      await lstat(stateRoot);
      throw stateError();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await mkdir(stateRoot, { mode: 0o700, recursive: false });
    await canonicalExistingDirectory(stateRoot, { privateDirectory: true });
    (options.assertAcl ?? assertMacAcl)(stateRoot, "private");
    return stateRoot;
  } catch {
    throw stateError();
  }
}

async function collectSqliteFiles(path, files = []) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await collectSqliteFiles(child, files);
    else if (entry.isFile() && entry.name.endsWith(".sqlite")) files.push(child);
    else if (entry.isSymbolicLink()) throw stateError();
  }
  return files;
}

export async function findIsolatedX402D1Payload(
  stateRoot,
  { findSqliteFiles = collectSqliteFiles } = {},
) {
  try {
    const directory = join(stateRoot, D1_DIRECTORY);
    const metadata = join(stateRoot, D1_METADATA);
    const sqliteFiles = await findSqliteFiles(directory);
    if (!Array.isArray(sqliteFiles) || !sqliteFiles.includes(metadata)) throw stateError();
    const payloads = sqliteFiles.filter((path) =>
      dirname(path) === directory && D1_PAYLOAD.test(basename(path))
    );
    if (
      payloads.length !== 1 ||
      basename(payloads[0]) !== LOCAL_X402_ISOLATED_V1_D1_PAYLOAD_FILENAME ||
      sqliteFiles.length !== 2 ||
      sqliteFiles.some((path) => path !== metadata && path !== payloads[0])
    ) throw stateError();
    return payloads[0];
  } catch {
    throw stateError();
  }
}

function columnShape(rows) {
  return rows.map(({ cid, name, type, notnull, dflt_value, pk }) => ({
    cid: Number(cid), name, type, notnull: Number(notnull), dflt_value, pk: Number(pk),
  }));
}

function expectedColumnShape(names, types, notNull, primaryKeys = new Map()) {
  return names.map((name, cid) => ({
    cid,
    name,
    type: types.get(name) ?? "TEXT",
    notnull: notNull.has(name) ? 1 : 0,
    dflt_value: null,
    pk: primaryKeys.get(name) ?? 0,
  }));
}

function normalizeSql(sql) {
  return String(sql)
    .toLowerCase()
    .replaceAll(/if\s+not\s+exists\s+/gu, "")
    .replaceAll(/"([a-z0-9_]+)"/gu, "$1")
    .replaceAll(/\s+/gu, " ")
    .replaceAll(/\s*([(),])\s*/gu, "$1")
    .trim();
}

function completeSchemaFingerprint(database) {
  const schema = database.prepare(`SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' AND name <> '_cf_METADATA'
    ORDER BY type, name`).all()
    .map(({ type, name, tbl_name, sql }) => ({
      type, name, tbl_name, sql: normalizeSql(sql),
    }));
  const xinfo = Object.fromEntries(schema
    .filter(({ type }) => type === "table")
    .map(({ name }) => {
      const identifier = `"${name.replaceAll('"', '""')}"`;
      return [name, database.prepare(`PRAGMA table_xinfo(${identifier})`).all()
        .map(({ cid, name: column, type, notnull, dflt_value, pk, hidden }) => ({
          cid: Number(cid), name: column, type, notnull: Number(notnull), dflt_value,
          pk: Number(pk), hidden: Number(hidden),
        }))];
    }));
  return createHash("sha256").update(JSON.stringify({ schema, xinfo })).digest("hex");
}

function assertD1SystemMetadataTable(database) {
  const row = database.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name = '_cf_METADATA'",
  ).get();
  if (
    row?.type !== "table" || row.name !== "_cf_METADATA" ||
    row.tbl_name !== "_cf_METADATA" ||
    normalizeSql(row.sql) !== normalizeSql(`CREATE TABLE _cf_METADATA (
      key INTEGER PRIMARY KEY,
      value BLOB
    )`)
  ) throw stateError();
  const expected = [
    { cid: 0, name: "key", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1, hidden: 0 },
    { cid: 1, name: "value", type: "BLOB", notnull: 0, dflt_value: null, pk: 0, hidden: 0 },
  ];
  const actual = database.prepare("PRAGMA table_xinfo(_cf_METADATA)").all()
    .map(({ cid, name, type, notnull, dflt_value, pk, hidden }) => ({
      cid: Number(cid), name, type, notnull: Number(notnull), dflt_value,
      pk: Number(pk), hidden: Number(hidden),
    }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw stateError();
  const rows = database.prepare(
    `SELECT key, typeof(value) AS value_type, CAST(value AS TEXT) AS value_text
     FROM _cf_METADATA ORDER BY key`,
  ).all().map(({ key, value_type, value_text }) => ({
    key: Number(key), value_type, value_text,
  }));
  // Miniflare advances this sole bookmark on each legitimate reopen, so its
  // canonical positive decimal value is dynamic while key/type/cardinality
  // remain part of the pinned runtime layout.
  if (
    rows.length !== 1 || rows[0]?.key !== 2 || rows[0]?.value_type !== "integer" ||
    typeof rows[0]?.value_text !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(rows[0].value_text) ||
    !Number.isSafeInteger(Number(rows[0].value_text))
  ) {
    throw stateError();
  }
}

function assertMetadataDatabase(database) {
  const quickCheck = database.prepare("PRAGMA quick_check").all();
  if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== "ok") throw stateError();
  const schemas = database.prepare(
    "SELECT name, type, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all();
  if (
    schemas.length !== 1 || schemas[0]?.name !== "_cf_ALARM" ||
    schemas[0]?.type !== "table" ||
    normalizeSql(schemas[0]?.sql) !== normalizeSql(`CREATE TABLE _cf_ALARM (
      actor_id TEXT PRIMARY KEY,
      scheduled_time INTEGER,
      actor_name TEXT
    ) WITHOUT ROWID`)
  ) throw stateError();
  const expected = [
    { cid: 0, name: "actor_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
    { cid: 1, name: "scheduled_time", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
    { cid: 2, name: "actor_name", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
  ];
  if (JSON.stringify(columnShape(database.prepare("PRAGMA table_info(_cf_ALARM)").all())) !==
    JSON.stringify(expected)) throw stateError();
  if (database.prepare("SELECT COUNT(*) AS count FROM _cf_ALARM").get()?.count !== 0) {
    throw stateError();
  }
}

export function validateIsolatedX402D1Metadata(
  metadataPath,
  { openDatabase = (path) => new DatabaseSync(path, { readOnly: true }) } = {},
) {
  let database;
  try {
    database = openDatabase(metadataPath);
    assertMetadataDatabase(database);
    return metadataPath;
  } catch {
    throw stateError();
  } finally {
    database?.close();
  }
}

export function validateIsolatedX402Database(
  databasePath,
  {
    openDatabase = (path) => new DatabaseSync(path, { readOnly: true }),
    profile = LOCAL_X402_DATABASE_PROFILE_ISOLATED_V1,
  } = {},
) {
  let database;
  try {
    const contract = databaseProfile(profile);
    database = openDatabase(databasePath);
    const quickCheck = database.prepare("PRAGMA quick_check").all();
    if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== "ok") throw stateError();
    const tables = new Set(database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .all()
      .map(({ name }) => name));
    if ([...contract.requiredTables].some((table) => !tables.has(table))) throw stateError();
    assertD1SystemMetadataTable(database);

    const paymentIntegerColumns = new Set([
      "amount_drops", "caller_max_drops", "policy_per_call_cap_drops", "daily_cap_drops",
      "last_ledger_seq", "fee_cap_drops", "reserved_total_drops", "budget_consumed_drops",
    ]);
    const paymentTypes = new Map([...paymentIntegerColumns].map((name) => [name, "INTEGER"]));
    const paymentNotNull = new Set([
      "principal", "idempotency_key", "request_fingerprint", "owner", "network", "delegate",
      "url", "status", "created_at", "updated_at",
    ]);
    const payerTypes = new Map([
      ["ciphertext", "BLOB"], ["iv", "BLOB"], ["funded_ledger_index", "INTEGER"],
    ]);
    const payerNotNull = new Set([
      "principal", "owner", "network", "payer", "public_key", "ciphertext", "iv", "status",
      "created_at", "updated_at",
    ]);
    const payerLeaseIntegerColumns = new Set([
      "generation", "sequence", "first_eligible_ledger_index", "last_ledger_sequence",
      "resolution_ledger_index",
    ]);
    const payerLeaseTypes = new Map(
      [...payerLeaseIntegerColumns].map((name) => [name, "INTEGER"]),
    );
    const payerLeaseNotNull = new Set([
      "network", "payer", "generation", "lease_token", "rail", "attempt_id", "state",
      "acquired_at", "updated_at",
    ]);
    const accountLeaseIntegerColumns = new Set([
      "generation", "sequence", "first_ledger_sequence", "last_ledger_sequence",
    ]);
    const accountLeaseTypes = new Map(
      [...accountLeaseIntegerColumns].map((name) => [name, "INTEGER"]),
    );
    const accountLeaseNotNull = new Set([
      "principal", "network", "account", "generation", "lease_token", "source",
      "attempt_id", "state", "acquired_at", "updated_at",
    ]);
    const expectedColumns = new Map([
      ["x402_payments", expectedColumnShape(
        X402_PAYMENT_COLUMNS, paymentTypes, paymentNotNull, new Map([["id", 1]]),
      )],
      ["x402_payers", expectedColumnShape(
        X402_PAYER_COLUMNS, payerTypes, payerNotNull,
        new Map([["principal", 1], ["owner", 2], ["network", 3]]),
      )],
      ["x402_payer_quarantine", expectedColumnShape(
        X402_QUARANTINE_COLUMNS, new Map(), new Set(X402_QUARANTINE_COLUMNS),
        new Map([["network", 1], ["payer", 2]]),
      )],
      ["d1_migrations", [
        { cid: 0, name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
        { cid: 1, name: "name", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
        {
          cid: 2, name: "applied_at", type: "TIMESTAMP", notnull: 1,
          dflt_value: "CURRENT_TIMESTAMP", pk: 0,
        },
      ]],
    ]);
    if (contract.sequenceAuthority) {
      expectedColumns.set("payer_sequence_leases", expectedColumnShape(
        PAYER_SEQUENCE_LEASE_COLUMNS, payerLeaseTypes, payerLeaseNotNull,
        new Map([["network", 1], ["payer", 2]]),
      ));
      expectedColumns.set("account_sequence_leases", expectedColumnShape(
        ACCOUNT_SEQUENCE_LEASE_COLUMNS, accountLeaseTypes, accountLeaseNotNull,
        new Map([["network", 1], ["account", 2]]),
      ));
    }
    for (const [table, expected] of expectedColumns) {
      const actual = columnShape(database.prepare(`PRAGMA table_info(${table})`).all());
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw stateError();
    }

    const migrations = database.prepare("SELECT id, name FROM d1_migrations ORDER BY id").all()
      .map(({ id, name }) => ({ id: Number(id), name }));
    const expectedMigrations = contract.migrations
      .map((name, index) => ({ id: index + 1, name }));
    if (JSON.stringify(migrations) !== JSON.stringify(expectedMigrations)) throw stateError();

    const expectedIndexes = new Map([
      ["idx_exec_hash", "CREATE INDEX idx_exec_hash ON executions(hash)"],
      ["idx_x402_payments_budget", `CREATE INDEX idx_x402_payments_budget
        ON x402_payments (principal, owner, network, reserved_at, status)`],
      ["idx_x402_payments_hash", `CREATE UNIQUE INDEX idx_x402_payments_hash
        ON x402_payments (principal, hash) WHERE hash IS NOT NULL`],
      ["idx_x402_payers_network_address", `CREATE UNIQUE INDEX idx_x402_payers_network_address
        ON x402_payers (network, payer)`],
      ["idx_x402_payments_active_payer", `CREATE UNIQUE INDEX idx_x402_payments_active_payer
        ON x402_payments (network, delegate)
        WHERE status NOT IN ('failed', 'delivered') AND lease_acquired_at IS NOT NULL`],
      ["idx_x402_payments_budget_consumed", `CREATE INDEX idx_x402_payments_budget_consumed
        ON x402_payments (principal, owner, network, budget_consumed_at)`],
    ]);
    if (contract.sequenceAuthority) {
      expectedIndexes.set(
        "idx_payer_sequence_leases_active_attempt",
        `CREATE INDEX idx_payer_sequence_leases_active_attempt
          ON payer_sequence_leases(rail, attempt_id, state)`,
      );
      expectedIndexes.set(
        "idx_account_sequence_leases_state",
        `CREATE INDEX idx_account_sequence_leases_state
          ON account_sequence_leases(network, account, state)`,
      );
    }
    const actualIndexes = database.prepare(
      "SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL ORDER BY name",
    ).all();
    if (actualIndexes.length !== expectedIndexes.size) throw stateError();
    for (const { name, sql } of actualIndexes) {
      if (!expectedIndexes.has(name) ||
        normalizeSql(sql) !== normalizeSql(expectedIndexes.get(name))) throw stateError();
    }

    const requiredTableSql = new Map([
      ["x402_payments", [
        "check (network in ('testnet', 'devnet'))",
        "unique (principal, idempotency_key)",
        "unique (principal, network, invoice_id)",
        "status not in ('claimed', 'failed') and amount_drops is not null",
      ]],
      ["x402_payers", [
        "check (network = 'testnet')", "check (length(ciphertext) > 16)",
        "check (length(iv) = 12)", "primary key (principal, owner, network)",
        "funded_ledger_index is not null and funded_balance_drops is not null",
      ]],
      ["x402_payer_quarantine", ["primary key (network, payer)"]],
    ]);
    if (contract.sequenceAuthority) {
      requiredTableSql.set("payer_sequence_leases", [
        "primary key (network, payer)",
        "rail in ('ap4m', 'x402', 'legacy')",
        "state = 'legacy_ambiguous' and rail = 'legacy'",
        "release_reason in ('validated_terminal', 'expired_absent')",
      ]);
      requiredTableSql.set("account_sequence_leases", [
        "primary key (network, account)",
        "unique (network, account, generation)",
        "unique (network, account, source, attempt_id)",
        "source in ('strategy', 'manual', 'ap4m', 'x402')",
      ]);
    }
    for (const [table, fragments] of requiredTableSql) {
      const row = database.prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
      ).get(table);
      const sql = normalizeSql(row?.sql);
      if (fragments.some((fragment) => !sql.includes(normalizeSql(fragment)))) throw stateError();
    }
    if (completeSchemaFingerprint(database) !== contract.schemaFingerprint) throw stateError();
    return databasePath;
  } catch {
    throw stateError();
  } finally {
    database?.close();
  }
}

export async function validateIsolatedX402StateLayout(
  stateRoot,
  {
    validateTree = validateLocalX402StateTree,
    validateAcl = validatePrivateAclTree,
    findDatabase = findIsolatedX402D1Payload,
    validateMetadata = validateIsolatedX402D1Metadata,
    validateDatabase = validateIsolatedX402Database,
    assertAcl = assertMacAcl,
    databaseProfile = LOCAL_X402_DATABASE_PROFILE_ISOLATED_V1,
  } = {},
) {
  try {
    validateTree(stateRoot);
    await validateAcl(stateRoot, assertAcl);
    validateMetadata(join(stateRoot, D1_METADATA));
    const databasePath = await findDatabase(stateRoot);
    if (typeof databasePath !== "string") throw stateError();
    validateDatabase(databasePath, { profile: databaseProfile });
    return { databasePath };
  } catch {
    throw stateError();
  }
}

function expectedMarker(stateRoot) {
  return {
    contract: LOCAL_X402_ISOLATED_V1_STATE_CONTRACT,
    stateRoot,
    network: LOCAL_X402_ISOLATED_V1_NETWORK,
    signingProfile: LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE,
    d1: {
      binding: LOCAL_X402_ISOLATED_V1_D1_BINDING,
      databaseId: LOCAL_X402_ISOLATED_V1_D1_DATABASE_ID,
      databaseName: LOCAL_X402_ISOLATED_V1_D1_DATABASE_NAME,
    },
  };
}

export function isolatedX402StateMarkerContents(stateRoot) {
  return `${JSON.stringify(expectedMarker(stateRoot), null, 2)}\n`;
}

export async function writeIsolatedX402StateMarker(
  stateRoot,
  {
    validateLayout = validateIsolatedX402StateLayout,
    openFile = open,
  } = {},
) {
  await validateLayout(stateRoot);
  if (
    typeof FS_CONSTANTS.O_NOFOLLOW !== "number" ||
    typeof FS_CONSTANTS.O_EXCL !== "number"
  ) throw stateError();
  const markerPath = join(stateRoot, LOCAL_X402_ISOLATED_V1_STATE_MARKER);
  let handle;
  let parentHandle;
  let published = false;
  try {
    const directoryFlags = FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW |
      (typeof FS_CONSTANTS.O_DIRECTORY === "number" ? FS_CONSTANTS.O_DIRECTORY : 0);
    parentHandle = await openFile(stateRoot, directoryFlags);
    const parentBefore = await parentHandle.stat();
    if (!parentBefore.isDirectory() || parentBefore.nlink < 1) throw stateError();
    handle = await openFile(
      markerPath,
      FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL |
        FS_CONSTANTS.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(isolatedX402StateMarkerContents(stateRoot), "utf8");
    await handle.sync();
    const metadata = await handle.stat();
    if (
      !metadata.isFile() || metadata.nlink !== 1 ||
      (metadata.mode & 0o777) !== 0o600 ||
      (currentUid() !== undefined && metadata.uid !== currentUid())
    ) throw stateError();
    const named = await lstat(markerPath);
    if (
      named.isSymbolicLink() || named.dev !== metadata.dev || named.ino !== metadata.ino
    ) throw stateError();
    const parentAfter = await parentHandle.stat();
    if (
      parentAfter.dev !== parentBefore.dev || parentAfter.ino !== parentBefore.ino ||
      (await realpath(stateRoot)) !== stateRoot
    ) throw stateError();
    await parentHandle.sync();
    published = true;
    return markerPath;
  } catch {
    if (handle && !published) {
      try {
        const held = await handle.stat();
        const named = await lstat(markerPath);
        if (!named.isSymbolicLink() && named.dev === held.dev && named.ino === held.ino) {
          await unlink(markerPath);
          await parentHandle?.sync();
        }
      } catch {
        // Fail closed. SIGKILL or an unverifiable inode may leave an orphaned
        // marker that requires operator inspection; it is never overwritten.
      }
    }
    throw stateError();
  } finally {
    await handle?.close().catch(() => undefined);
    await parentHandle?.close().catch(() => undefined);
  }
}

export async function validateIsolatedX402StateMarker(
  stateRoot,
  { assertAcl = assertMacAcl } = {},
) {
  const markerPath = join(stateRoot, LOCAL_X402_ISOLATED_V1_STATE_MARKER);
  let handle;
  try {
    if (typeof FS_CONSTANTS.O_NOFOLLOW !== "number") throw stateError();
    handle = await open(markerPath, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
    const before = await handle.stat();
    if (
      !before.isFile() || before.nlink !== 1 || before.size > MARKER_MAX_BYTES ||
      (before.mode & 0o777) !== 0o600 ||
      (currentUid() !== undefined && before.uid !== currentUid())
    ) throw stateError();
    const namedBefore = await lstat(markerPath);
    if (
      namedBefore.isSymbolicLink() || namedBefore.dev !== before.dev ||
      namedBefore.ino !== before.ino
    ) throw stateError();
    assertAcl(markerPath, "private");
    const contents = await handle.readFile("utf8");
    const after = await handle.stat();
    const namedAfter = await lstat(markerPath);
    if (
      after.dev !== before.dev || after.ino !== before.ino ||
      after.nlink !== 1 || after.size !== before.size ||
      namedAfter.isSymbolicLink() || namedAfter.dev !== before.dev ||
      namedAfter.ino !== before.ino ||
      Buffer.byteLength(contents, "utf8") > MARKER_MAX_BYTES
    ) throw stateError();
    if (contents !== isolatedX402StateMarkerContents(stateRoot)) throw stateError();
    return markerPath;
  } catch {
    throw stateError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Exclusively lease an existing state root. A process killed before release
 * leaves a fail-closed lock that must be inspected and removed by an operator.
 */
export async function acquireIsolatedX402StateLease(
  stateRoot,
  { openFile = open, assertAcl = assertMacAcl } = {},
) {
  await validateConfiguredIsolatedX402StateRoot(stateRoot);
  await canonicalExistingDirectory(stateRoot, { privateDirectory: true });
  assertAcl(stateRoot, "private");
  if (
    typeof FS_CONSTANTS.O_NOFOLLOW !== "number" ||
    typeof FS_CONSTANTS.O_EXCL !== "number"
  ) throw stateError();
  const lockPath = join(stateRoot, LOCAL_X402_ISOLATED_V1_STATE_LOCK);
  let handle;
  let directoryHandle;
  try {
    const directoryFlags = FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW |
      (typeof FS_CONSTANTS.O_DIRECTORY === "number" ? FS_CONSTANTS.O_DIRECTORY : 0);
    directoryHandle = await openFile(stateRoot, directoryFlags);
    handle = await openFile(
      lockPath,
      FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL |
        FS_CONSTANTS.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${process.pid}\n`, "utf8");
    await handle.sync();
    const held = await handle.stat();
    const named = await lstat(lockPath);
    if (
      !held.isFile() || held.nlink !== 1 || (held.mode & 0o777) !== 0o600 ||
      named.isSymbolicLink() || named.dev !== held.dev || named.ino !== held.ino ||
      (currentUid() !== undefined && held.uid !== currentUid())
    ) throw stateError();
    assertAcl(lockPath, "private");
    await directoryHandle.sync();
    let released = false;
    return {
      path: lockPath,
      async release() {
        if (released) return;
        try {
          const currentHeld = await handle.stat();
          const currentNamed = await lstat(lockPath);
          if (
            currentNamed.isSymbolicLink() || currentNamed.dev !== currentHeld.dev ||
            currentNamed.ino !== currentHeld.ino
          ) throw stateError();
          await unlink(lockPath);
          await directoryHandle.sync();
          released = true;
        } finally {
          await handle.close().catch(() => undefined);
          await directoryHandle.close().catch(() => undefined);
        }
      },
    };
  } catch {
    if (handle) {
      try {
        const held = await handle.stat();
        const named = await lstat(lockPath);
        if (!named.isSymbolicLink() && named.dev === held.dev && named.ino === held.ino) {
          await unlink(lockPath);
          await directoryHandle?.sync();
        }
      } catch {
        // Never unlink an inode we cannot prove belongs to this acquisition.
      }
    }
    await handle?.close().catch(() => undefined);
    await directoryHandle?.close().catch(() => undefined);
    throw stateError();
  }
}

export async function validateExistingIsolatedX402State(
  stateRoot,
  {
    validateConfigured = validateConfiguredIsolatedX402StateRoot,
    validateMarker = validateIsolatedX402StateMarker,
    validateLayout = validateIsolatedX402StateLayout,
    repoRoot = REPO_ROOT,
    databaseProfile = LOCAL_X402_DATABASE_PROFILE_ISOLATED_V1,
  } = {},
) {
  try {
    await validateConfigured(stateRoot, { repoRoot });
    await validateMarker(stateRoot);
    return await validateLayout(stateRoot, { databaseProfile });
  } catch {
    throw stateError();
  }
}

export async function validateExistingCombinedUpgradeBaselineState(stateRoot, options = {}) {
  return validateExistingIsolatedX402State(stateRoot, {
    ...options,
    databaseProfile: LOCAL_X402_DATABASE_PROFILE_COMBINED_UPGRADE_BASELINE,
  });
}
