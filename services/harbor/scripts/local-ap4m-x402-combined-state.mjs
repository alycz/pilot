import { constants as FS_CONSTANTS } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, readFile, readdir, realpath, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { isValidClassicAddress } from "xrpl";

import { assertMacAcl } from "./macos-acl.mjs";
import { validateLocalX402StateTree } from "./local-x402-state.mjs";
import {
  LOCAL_X402_ISOLATED_V1_D1_DATABASE_ID,
  LOCAL_X402_ISOLATED_V1_D1_DATABASE_NAME,
  LOCAL_X402_ISOLATED_V1_STATE_CONTRACT,
  LOCAL_X402_ISOLATED_V1_STATE_MARKER,
  acquireIsolatedX402StateLease,
  findIsolatedX402D1Payload,
  isolatedX402StateMarkerContents,
  validateConfiguredIsolatedX402StateRoot,
  validateExistingCombinedUpgradeBaselineState,
  validateIsolatedX402D1Metadata,
  validateIsolatedX402StateMarker,
} from "./local-x402-isolated-state.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMBINED_ERROR = "Combined AP4M/x402 preserved state is missing or unsafe";
const MARKER_MAX_BYTES = 8_192;
const D1_METADATA = join("v3", "d1", "miniflare-D1DatabaseObject", "metadata.sqlite");
const V1_SCHEMA_FINGERPRINT =
  "8087e790ee8db7f69c5c89368017d396ba4061ff952cef7280fa5923dcb6a2cf";
const V1_MIGRATIONS = [
  "0001_init.sql",
  "0002_x402_payments.sql",
  "0003_x402_payers.sql",
  "0004_x402_sequence_safety.sql",
  "0005_x402_durable_lease.sql",
  "0006_x402_budget_accounting.sql",
  "0007_x402_payer_provisioning.sql",
];

export const AP4M_X402_COMBINED_V1_CONTRACT =
  "harbor-local-ap4m-x402-combined-v1";
export const AP4M_X402_COMBINED_V1_MARKER =
  ".harbor-local-ap4m-x402-combined-v1.json";
export const AP4M_X402_COMBINED_V1_MIGRATION =
  "0008_ap4m_shared_runtime.sql";
export const AP4M_X402_COMBINED_V1_SIGNING_PROFILE =
  "reviewed-testnet-ap4m-x402-combined-v1";
export const AP4M_X402_COMBINED_V1_RUNTIME_MARKER =
  "HARBOR_LOCAL_AP4M_X402_COMBINED_V1_RUNTIME_ENABLED";
export const AP4M_X402_COMBINED_V1_PROFILE_MARKER =
  "HARBOR_LOCAL_AP4M_X402_COMBINED_V1_SIGNING_PROFILE";

function fail() {
  throw new Error(COMBINED_ERROR);
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

async function validatePrivateAclTree(path, assertAcl) {
  assertAcl(path, "private");
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) fail();
    assertAcl(child, "private");
    if (entry.isDirectory()) await validatePrivateAclTree(child, assertAcl);
  }
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

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function schemaFingerprint(database) {
  const schema = database.prepare(`SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' AND name <> '_cf_METADATA'
    ORDER BY type, name`).all()
    .map(({ type, name, tbl_name, sql }) => ({
      type,
      name,
      tbl_name,
      sql: normalizeSql(sql),
    }));
  const xinfo = Object.fromEntries(schema
    .filter(({ type }) => type === "table")
    .map(({ name }) => [name, database
      .prepare(`PRAGMA table_xinfo(${quoteIdentifier(name)})`).all()
      .map(({ cid, name: column, type, notnull, dflt_value, pk, hidden }) => ({
        cid: Number(cid),
        name: column,
        type,
        notnull: Number(notnull),
        dflt_value,
        pk: Number(pk),
        hidden: Number(hidden),
      }))]));
  return createHash("sha256").update(JSON.stringify({ schema, xinfo })).digest("hex");
}

function migrationHistory(database) {
  return database.prepare("SELECT id, name FROM d1_migrations ORDER BY id").all()
    .map(({ id, name }) => ({ id: Number(id), name }));
}

function expectedHistory(combined) {
  return [...V1_MIGRATIONS, ...(combined ? [AP4M_X402_COMBINED_V1_MIGRATION] : [])]
    .map((name, index) => ({ id: index + 1, name }));
}

function assertHistory(database, combined) {
  if (JSON.stringify(migrationHistory(database)) !== JSON.stringify(expectedHistory(combined))) {
    fail();
  }
}

function checkIntegrity(database) {
  const rows = database.prepare("PRAGMA quick_check").all();
  if (rows.length !== 1 || rows[0]?.quick_check !== "ok") fail();
}

function typedCell(value) {
  if (value === null) return ["null", null];
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return ["blob", Buffer.from(value).toString("base64")];
  }
  if (typeof value === "bigint") return ["bigint", value.toString()];
  return [typeof value, value];
}

function tableSnapshot(database, table, pinnedColumns) {
  const columns = pinnedColumns ?? database
    .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all()
    .map(({ name }) => String(name));
  if (columns.length === 0) fail();
  const queryColumns = columns.map(quoteIdentifier).join(", ");
  const rows = database.prepare(`SELECT ${queryColumns} FROM ${quoteIdentifier(table)}`).all()
    .map((row) => columns.map((column) => typedCell(row[column])))
    .map((row) => JSON.stringify(row))
    .sort();
  return createHash("sha256")
    .update(JSON.stringify({ table, columns, rows }))
    .digest("hex");
}

function baselineSnapshots(database) {
  const tables = database.prepare(`SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      AND name NOT IN ('_cf_METADATA', 'd1_migrations')
    ORDER BY name`).all().map(({ name }) => String(name));
  return Object.fromEntries(tables.map((table) => {
    const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all()
      .map(({ name }) => String(name));
    return [table, { columns, digest: tableSnapshot(database, table, columns) }];
  }));
}

function assertSnapshots(database, expected) {
  for (const [table, snapshot] of Object.entries(expected)) {
    if (tableSnapshot(database, table, snapshot.columns) !== snapshot.digest) fail();
  }
}

async function migrationSql(repoRoot) {
  const path = join(repoRoot, "migrations-local-x402", AP4M_X402_COMBINED_V1_MIGRATION);
  const sql = await readFile(path, "utf8");
  if (!sql.trim() || /\b(?:attach|detach|vacuum)\b/iu.test(sql)) fail();
  return sql;
}

export async function expectedCombinedSchemaFingerprint(repoRoot = REPO_ROOT) {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`CREATE TABLE d1_migrations(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`);
    for (const [index, name] of [...V1_MIGRATIONS, AP4M_X402_COMBINED_V1_MIGRATION].entries()) {
      const sql = await readFile(join(repoRoot, "migrations-local-x402", name), "utf8");
      database.exec(sql);
      database.prepare("INSERT INTO d1_migrations(id, name) VALUES (?, ?)")
        .run(index + 1, name);
    }
    checkIntegrity(database);
    return schemaFingerprint(database);
  } catch {
    fail();
  } finally {
    database.close();
  }
}

export function assertCombinedPayerBinding(databasePath, secrets, {
  openDatabase = (path) => new DatabaseSync(path, { readOnly: true }),
} = {}) {
  let database;
  try {
    const credential = secrets?.HARBOR_API_KEYS;
    const separator = typeof credential === "string" ? credential.indexOf(":") : -1;
    const principal = separator > 0 ? credential.slice(0, separator) : "";
    if (
      !principal ||
      typeof secrets?.HARBOR_KEK !== "string" ||
      Buffer.from(secrets.HARBOR_KEK, "base64").length !== 32
    ) fail();
    database = openDatabase(databasePath);
    const rows = database.prepare(`SELECT payer, public_key, length(ciphertext) AS cipher_len,
        length(iv) AS iv_len, status
      FROM x402_payers WHERE principal = ? AND network = 'testnet'`).all(principal);
    if (
      rows.length !== 1 || rows[0]?.status !== "ready" ||
      !isValidClassicAddress(rows[0]?.payer) ||
      typeof rows[0]?.public_key !== "string" || rows[0].public_key.length === 0 ||
      Number(rows[0]?.cipher_len) <= 16 || Number(rows[0]?.iv_len) !== 12
    ) fail();
    return { principal, payer: rows[0].payer };
  } catch {
    fail();
  } finally {
    database?.close();
  }
}

export async function validateCombinedDatabase(databasePath, repoRoot = REPO_ROOT, {
  openDatabase = (path) => new DatabaseSync(path, { readOnly: true }),
} = {}) {
  let database;
  try {
    database = openDatabase(databasePath);
    checkIntegrity(database);
    assertHistory(database, true);
    const expected = await expectedCombinedSchemaFingerprint(repoRoot);
    const actual = schemaFingerprint(database);
    if (actual !== expected) fail();
    for (const table of [
      "ap4m_mandates",
      "ap4m_spend",
      "ap4m_receipts",
      "ap4m_purchase_attempts",
      "payer_sequence_leases",
    ]) {
      const row = database.prepare(
        "SELECT type FROM sqlite_schema WHERE name = ?",
      ).get(table);
      if (row?.type !== "table") fail();
    }
    return { databasePath, schemaFingerprint: actual };
  } catch {
    fail();
  } finally {
    database?.close();
  }
}

function markerValue(stateRoot, schema) {
  const v1Contents = isolatedX402StateMarkerContents(stateRoot);
  return {
    contract: AP4M_X402_COMBINED_V1_CONTRACT,
    stateRoot,
    network: "testnet",
    signingProfile: AP4M_X402_COMBINED_V1_SIGNING_PROFILE,
    d1: {
      binding: "DB",
      databaseId: LOCAL_X402_ISOLATED_V1_D1_DATABASE_ID,
      databaseName: LOCAL_X402_ISOLATED_V1_D1_DATABASE_NAME,
      migration: AP4M_X402_COMBINED_V1_MIGRATION,
      schemaFingerprint: schema,
    },
    v1Provenance: {
      contract: LOCAL_X402_ISOLATED_V1_STATE_CONTRACT,
      marker: LOCAL_X402_ISOLATED_V1_STATE_MARKER,
      markerSha256: createHash("sha256").update(v1Contents).digest("hex"),
      schemaFingerprint: V1_SCHEMA_FINGERPRINT,
      migrations: V1_MIGRATIONS,
    },
  };
}

export function combinedStateMarkerContents(stateRoot, schemaFingerprintValue) {
  return `${JSON.stringify(markerValue(stateRoot, schemaFingerprintValue), null, 2)}\n`;
}

export async function writeCombinedStateMarker(stateRoot, schemaFingerprintValue, {
  openFile = open,
  assertAcl = assertMacAcl,
} = {}) {
  const markerPath = join(stateRoot, AP4M_X402_COMBINED_V1_MARKER);
  let handle;
  let directoryHandle;
  let published = false;
  try {
    if (typeof FS_CONSTANTS.O_NOFOLLOW !== "number") fail();
    const directoryFlags = FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW |
      (typeof FS_CONSTANTS.O_DIRECTORY === "number" ? FS_CONSTANTS.O_DIRECTORY : 0);
    directoryHandle = await openFile(stateRoot, directoryFlags);
    const directoryBefore = await directoryHandle.stat();
    if (!directoryBefore.isDirectory() || directoryBefore.nlink < 1) fail();
    handle = await openFile(
      markerPath,
      FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL |
        FS_CONSTANTS.O_NOFOLLOW,
      0o600,
    );
    const contents = combinedStateMarkerContents(stateRoot, schemaFingerprintValue);
    if (Buffer.byteLength(contents, "utf8") > MARKER_MAX_BYTES) fail();
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    const held = await handle.stat();
    const named = await lstat(markerPath);
    if (
      !held.isFile() || held.nlink !== 1 || (held.mode & 0o777) !== 0o600 ||
      named.isSymbolicLink() || named.dev !== held.dev || named.ino !== held.ino ||
      (currentUid() !== undefined && held.uid !== currentUid())
    ) fail();
    assertAcl(markerPath, "private");
    const directoryAfter = await directoryHandle.stat();
    if (
      directoryAfter.dev !== directoryBefore.dev ||
      directoryAfter.ino !== directoryBefore.ino ||
      (await realpath(stateRoot)) !== stateRoot
    ) fail();
    await directoryHandle.sync();
    published = true;
    return markerPath;
  } catch {
    if (handle && !published) {
      try {
        const held = await handle.stat();
        const named = await lstat(markerPath);
        if (!named.isSymbolicLink() && named.dev === held.dev && named.ino === held.ino) {
          await unlink(markerPath);
          await directoryHandle?.sync();
        }
      } catch {
        // Never unlink a marker inode whose identity cannot be proven.
      }
    }
    fail();
  } finally {
    await handle?.close().catch(() => undefined);
    await directoryHandle?.close().catch(() => undefined);
  }
}

export async function validateCombinedStateMarker(stateRoot, schemaFingerprintValue, {
  assertAcl = assertMacAcl,
} = {}) {
  const markerPath = join(stateRoot, AP4M_X402_COMBINED_V1_MARKER);
  let handle;
  try {
    handle = await open(markerPath, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
    const before = await handle.stat();
    const named = await lstat(markerPath);
    if (
      !before.isFile() || before.nlink !== 1 || before.size > MARKER_MAX_BYTES ||
      (before.mode & 0o777) !== 0o600 || named.isSymbolicLink() ||
      named.dev !== before.dev || named.ino !== before.ino ||
      (currentUid() !== undefined && before.uid !== currentUid())
    ) fail();
    assertAcl(markerPath, "private");
    const contents = await handle.readFile("utf8");
    const after = await handle.stat();
    const namedAfter = await lstat(markerPath);
    if (
      after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
      after.nlink !== 1 || namedAfter.isSymbolicLink() ||
      namedAfter.dev !== before.dev || namedAfter.ino !== before.ino ||
      contents !== combinedStateMarkerContents(stateRoot, schemaFingerprintValue)
    ) fail();
    return markerPath;
  } catch {
    fail();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function validateCombinedStateLayout(stateRoot, repoRoot = REPO_ROOT, {
  assertAcl = assertMacAcl,
} = {}) {
  try {
    await validateConfiguredIsolatedX402StateRoot(stateRoot, { repoRoot });
    validateLocalX402StateTree(stateRoot);
    await validatePrivateAclTree(stateRoot, assertAcl);
    await validateIsolatedX402StateMarker(stateRoot, { assertAcl });
    validateIsolatedX402D1Metadata(join(stateRoot, D1_METADATA));
    const databasePath = await findIsolatedX402D1Payload(stateRoot);
    return await validateCombinedDatabase(databasePath, repoRoot);
  } catch {
    fail();
  }
}

export async function validateExistingCombinedState(stateRoot, repoRoot = REPO_ROOT, {
  assertAcl = assertMacAcl,
} = {}) {
  try {
    const combined = await validateCombinedStateLayout(stateRoot, repoRoot, { assertAcl });
    await validateCombinedStateMarker(stateRoot, combined.schemaFingerprint, { assertAcl });
    return combined;
  } catch {
    fail();
  }
}

export async function upgradeIsolatedX402StateToCombined(stateRoot, {
  repoRoot = REPO_ROOT,
  validateV1 = validateExistingCombinedUpgradeBaselineState,
  acquireLease = acquireIsolatedX402StateLease,
  publishMarker = writeCombinedStateMarker,
  openDatabase = (path) => new DatabaseSync(path),
  assertPayer,
  validateCommitted = validateCombinedStateLayout,
} = {}) {
  let lease;
  let database;
  let transaction = false;
  try {
    await validateConfiguredIsolatedX402StateRoot(stateRoot, { repoRoot });
    if (typeof assertPayer !== "function") fail();
    try {
      await validateV1(stateRoot, { repoRoot });
    } catch {
      // A crash after COMMIT but before the O_EXCL marker publication leaves
      // the v1 marker intact and the exact combined fingerprint on disk. The
      // same explicit upgrade command may complete only that marker publish;
      // no migration is replayed and no other schema is accepted.
      lease = await acquireLease(stateRoot);
      const committed = await validateCommitted(stateRoot, repoRoot);
      await assertPayer(committed.databasePath);
      await publishMarker(stateRoot, committed.schemaFingerprint);
      return committed;
    }
    lease = await acquireLease(stateRoot);
    const { databasePath } = await validateV1(stateRoot, { repoRoot });
    await assertPayer(databasePath);
    const sql = await migrationSql(repoRoot);
    database = openDatabase(databasePath);
    checkIntegrity(database);
    assertHistory(database, false);
    const before = baselineSnapshots(database);
    database.exec("BEGIN EXCLUSIVE");
    transaction = true;
    database.exec(sql);
    database.prepare("INSERT INTO d1_migrations(id, name) VALUES (8, ?)")
      .run(AP4M_X402_COMBINED_V1_MIGRATION);
    checkIntegrity(database);
    assertHistory(database, true);
    assertSnapshots(database, before);
    const expected = await expectedCombinedSchemaFingerprint(repoRoot);
    const actual = schemaFingerprint(database);
    if (actual !== expected) fail();
    database.exec("COMMIT");
    transaction = false;
    database.close();
    database = undefined;
    const combined = await validateCombinedDatabase(databasePath, repoRoot);
    await publishMarker(stateRoot, combined.schemaFingerprint);
    return combined;
  } catch {
    if (database && transaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // A failed rollback leaves the root fail-closed for operator inspection.
      }
    }
    fail();
  } finally {
    database?.close();
    await lease?.release();
  }
}
