import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  LOCAL_X402_DATABASE_PROFILE_COMBINED_UPGRADE_BASELINE,
  LOCAL_X402_ISOLATED_V1_D1_PAYLOAD_FILENAME,
  LOCAL_X402_ISOLATED_V1_STATE_MARKER,
  acquireIsolatedX402StateLease,
  validateExistingCombinedUpgradeBaselineState,
  validateIsolatedX402StateLayout,
  validateIsolatedX402StateMarker,
  writeIsolatedX402StateMarker,
} from "../scripts/local-x402-isolated-state.mjs";
import {
  AP4M_X402_COMBINED_V1_CONTRACT,
  AP4M_X402_COMBINED_V1_MARKER,
  AP4M_X402_COMBINED_V1_MIGRATION,
  assertCombinedPayerBinding,
  combinedStateMarkerContents,
  expectedCombinedSchemaFingerprint,
  upgradeIsolatedX402StateToCombined,
  validateCombinedDatabase,
  validateCombinedStateLayout,
  validateCombinedStateMarker,
  validateExistingCombinedState,
  writeCombinedStateMarker,
} from "../scripts/local-ap4m-x402-combined-state.mjs";

const REPO_ROOT = realpathSync(process.cwd());
const PORTABLE_TEMP_ROOT = realpathSync(homedir());
const roots: string[] = [];
const noAcl = () => undefined;
const PRINCIPAL = "combined-principal";
const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const PAYER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const NOW = "2026-10-21T19:30:00.000Z";
const migrations = [
  "0001_init.sql",
  "0002_x402_payments.sql",
  "0003_x402_payers.sql",
  "0004_x402_sequence_safety.sql",
  "0005_x402_durable_lease.sql",
  "0006_x402_budget_accounting.sql",
  "0007_x402_payer_provisioning.sql",
];

function temporaryRoot(label: string) {
  const root = realpathSync(mkdtempSync(join(PORTABLE_TEMP_ROOT, `.combined-${label}-`)));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function makePrivate(path: string) {
  chmodSync(path, 0o700);
}

function applyV1(database: DatabaseSync) {
  database.exec(`CREATE TABLE _cf_METADATA (key INTEGER PRIMARY KEY, value BLOB)`);
  database.exec("INSERT INTO _cf_METADATA(key, value) VALUES (2, 36)");
  database.exec(`CREATE TABLE d1_migrations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`);
  for (const [index, name] of migrations.entries()) {
    database.exec(readFileSync(join(REPO_ROOT, "migrations-local-x402", name), "utf8"));
    database.prepare("INSERT INTO d1_migrations(id, name) VALUES (?, ?)").run(index + 1, name);
  }
}

function payloadPath(stateRoot: string) {
  return join(
    stateRoot,
    "v3",
    "d1",
    "miniflare-D1DatabaseObject",
    LOCAL_X402_ISOLATED_V1_D1_PAYLOAD_FILENAME,
  );
}

async function fixture(label: string) {
  const parent = temporaryRoot(label);
  const stateRoot = join(parent, "state");
  const d1 = join(stateRoot, "v3", "d1", "miniflare-D1DatabaseObject");
  mkdirSync(d1, { recursive: true, mode: 0o700 });
  for (const path of [stateRoot, join(stateRoot, "v3"), join(stateRoot, "v3", "d1"), d1]) {
    makePrivate(path);
  }
  const metadataPath = join(d1, "metadata.sqlite");
  const metadata = new DatabaseSync(metadataPath);
  metadata.exec(`CREATE TABLE _cf_ALARM (
    actor_id TEXT PRIMARY KEY,
    scheduled_time INTEGER,
    actor_name TEXT
  ) WITHOUT ROWID`);
  metadata.close();
  chmodSync(metadataPath, 0o600);

  const databasePath = payloadPath(stateRoot);
  const database = new DatabaseSync(databasePath);
  applyV1(database);
  database.prepare(`INSERT INTO links (
      id, principal, owner, network, delegate, delegate_seed_enc, iv, permissions,
      status, last_ledger, created_at
    ) VALUES (?, ?, ?, 'testnet', ?, ?, ?, ?, 'active', 8, ?)`)
    .run(
      "link-existing",
      PRINCIPAL,
      OWNER,
      PAYER,
      Buffer.alloc(32, 0x33),
      Buffer.alloc(12, 0x44),
      '["Payment"]',
      NOW,
    );
  database.prepare(`INSERT INTO builds (
      id, principal, owner, network, tx_json, summary, last_ledger_seq, created_at
    ) VALUES (?, ?, ?, 'testnet', '{}', '{}', 99, ?)`)
    .run("build-existing", PRINCIPAL, OWNER, NOW);
  database.prepare(`INSERT INTO executions (
      id, principal, build_id, idempotency_key, status, hash, usd_value, signed_by, created_at
    ) VALUES (?, ?, ?, ?, 'executed', ?, 1.25, 'delegate', ?)`)
    .run("execution-existing", PRINCIPAL, "build-existing", "execution-key", "B".repeat(64), NOW);
  database.prepare(`INSERT INTO x402_payers (
      principal, owner, network, payer, public_key, ciphertext, iv, status,
      funded_ledger_index, funded_balance_drops, created_at, updated_at,
      faucet_requested_at, funding_checked_at
    ) VALUES (?, ?, 'testnet', ?, ?, ?, ?, 'ready', 10, '1000', ?, ?, ?, ?)`)
    .run(
      PRINCIPAL,
      OWNER,
      PAYER,
      "02".padEnd(66, "A"),
      Buffer.alloc(32, 0x5a),
      Buffer.alloc(12, 0x7b),
      NOW,
      NOW,
      NOW,
      NOW,
    );
  database.prepare(`INSERT INTO x402_payments (
      id, principal, idempotency_key, request_fingerprint, owner, network, delegate,
      url, status, amount_drops, caller_max_drops, policy_per_call_cap_drops,
      daily_cap_drops, pay_to, invoice_id, requirements_json, transaction_json,
      last_ledger_seq, expires_at, reserved_at, signing_started_at, lease_acquired_at,
      created_at, updated_at, fee_cap_drops, reserved_total_drops
    ) VALUES (?, ?, ?, ?, ?, 'testnet', ?, ?, 'prepared', 1, 1, 1, 2, ?, ?, '{}', '{}',
      99, ?, ?, ?, ?, ?, ?, 100, 101)`)
    .run(
      "legacy-active",
      PRINCIPAL,
      "legacy-key",
      "A".repeat(64),
      OWNER,
      PAYER,
      "https://merchant.example/resource",
      OWNER,
      "invoice-1",
      NOW,
      NOW,
      NOW,
      NOW,
      NOW,
      NOW,
    );
  database.close();
  chmodSync(databasePath, 0o600);

  await writeIsolatedX402StateMarker(stateRoot, {
    validateLayout: (root: string) => validateIsolatedX402StateLayout(root, {
      assertAcl: noAcl,
      databaseProfile: LOCAL_X402_DATABASE_PROFILE_COMBINED_UPGRADE_BASELINE,
    }),
  });
  return { stateRoot, databasePath };
}

function portableV1(stateRoot: string) {
  return validateExistingCombinedUpgradeBaselineState(stateRoot, {
    validateMarker: (root: string) => validateIsolatedX402StateMarker(root, {
      assertAcl: noAcl,
    }),
    validateLayout: (root: string) => validateIsolatedX402StateLayout(root, {
      assertAcl: noAcl,
      databaseProfile: LOCAL_X402_DATABASE_PROFILE_COMBINED_UPGRADE_BASELINE,
    }),
  });
}

function secrets() {
  return {
    HARBOR_API_KEYS: `${PRINCIPAL}:${"T".repeat(32)}`,
    HARBOR_KEK: Buffer.alloc(32, 0x22).toString("base64"),
  };
}

function normalizeSql(sql: unknown) {
  return String(sql)
    .toLowerCase()
    .replaceAll(/if\s+not\s+exists\s+/gu, "")
    .replaceAll(/"([a-z0-9_]+)"/gu, "$1")
    .replaceAll(/\s+/gu, " ")
    .replaceAll(/\s*([(),])\s*/gu, "$1")
    .trim();
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("combined AP4M/x402 offline state upgrade", () => {
  it("upgrades only migration 0008, preserves v1 rows and encrypted bytes, and publishes provenance", async () => {
    const { stateRoot, databasePath } = await fixture("upgrade");
    const before = new DatabaseSync(databasePath, { readOnly: true });
    const payerBefore = before.prepare(
      "SELECT hex(ciphertext) AS ciphertext, hex(iv) AS iv, * FROM x402_payers",
    ).get();
    const paymentBefore = before.prepare("SELECT * FROM x402_payments").get();
    const linkBefore = before.prepare(`SELECT id, principal, owner, network, delegate,
      hex(delegate_seed_enc) AS delegate_seed_enc, hex(iv) AS iv, permissions, status,
      last_ledger, revoke_tx, created_at FROM links`).get();
    const executionBefore = before.prepare(`SELECT id, principal, build_id, idempotency_key,
      status, hash, usd_value, signed_by, created_at FROM executions`).get();
    before.close();

    const combined = await upgradeIsolatedX402StateToCombined(stateRoot, {
      repoRoot: REPO_ROOT,
      validateV1: portableV1,
      acquireLease: (root: string) => acquireIsolatedX402StateLease(root, { assertAcl: noAcl }),
      publishMarker: (root: string, fingerprint: string) =>
        writeCombinedStateMarker(root, fingerprint, { assertAcl: noAcl }),
      assertPayer: (path: string) => assertCombinedPayerBinding(path, secrets()),
    });

    expect(combined.schemaFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(combined.schemaFingerprint)
      .toBe("d8f804711b21999434cb64df34434e9d8fc3f284096e94116404a687affa8813");
    expect(combined.schemaFingerprint).toBe(await expectedCombinedSchemaFingerprint(REPO_ROOT));
    expect(existsSync(join(stateRoot, LOCAL_X402_ISOLATED_V1_STATE_MARKER))).toBe(true);
    expect(existsSync(join(stateRoot, AP4M_X402_COMBINED_V1_MARKER))).toBe(true);

    const after = new DatabaseSync(databasePath, { readOnly: true });
    expect(after.prepare("PRAGMA quick_check").all()).toEqual([{ quick_check: "ok" }]);
    expect(after.prepare("SELECT id, name FROM d1_migrations ORDER BY id").all().at(-1))
      .toEqual({ id: 8, name: AP4M_X402_COMBINED_V1_MIGRATION });
    expect(after.prepare(
      "SELECT hex(ciphertext) AS ciphertext, hex(iv) AS iv, * FROM x402_payers",
    ).get()).toEqual(payerBefore);
    expect(after.prepare("SELECT * FROM x402_payments").get()).toEqual(paymentBefore);
    expect(after.prepare(`SELECT id, principal, owner, network, delegate,
      hex(delegate_seed_enc) AS delegate_seed_enc, hex(iv) AS iv, permissions, status,
      last_ledger, revoke_tx, created_at FROM links`).get()).toEqual(linkBefore);
    expect(after.prepare(`SELECT id, principal, build_id, idempotency_key,
      status, hash, usd_value, signed_by, created_at FROM executions`).get())
      .toEqual(executionBefore);
    expect(after.prepare(`SELECT execution_id, principal, build_id, snapshot_owner,
      snapshot_network, created_at FROM execution_snapshots`).get()).toEqual({
      execution_id: "execution-existing",
      principal: PRINCIPAL,
      build_id: "build-existing",
      snapshot_owner: OWNER,
      snapshot_network: "testnet",
      created_at: NOW,
    });
    expect(after.prepare("SELECT frozen_at, frozen_reason FROM links").get())
      .toEqual({ frozen_at: null, frozen_reason: null });
    expect(after.prepare("SELECT confirmed_by, confirmed_at FROM executions").get())
      .toEqual({ confirmed_by: null, confirmed_at: null });
    expect(after.prepare(`SELECT rail, attempt_id, state, tx_hash, released_at
      FROM payer_sequence_leases WHERE network = 'testnet' AND payer = ?`).get(PAYER))
      .toEqual({
        rail: "legacy",
        attempt_id: "legacy-x402:legacy-active",
        state: "legacy_ambiguous",
        tx_hash: null,
        released_at: null,
      });
    after.close();

    const marker = JSON.parse(readFileSync(
      join(stateRoot, AP4M_X402_COMBINED_V1_MARKER),
      "utf8",
    ));
    expect(marker).toMatchObject({
      contract: AP4M_X402_COMBINED_V1_CONTRACT,
      stateRoot,
      d1: {
        databaseName: "harbor-local-x402-isolated-v1-only",
        migration: AP4M_X402_COMBINED_V1_MIGRATION,
        schemaFingerprint: combined.schemaFingerprint,
      },
      v1Provenance: {
        contract: "harbor-local-x402-isolated-v1-state-v1",
        marker: LOCAL_X402_ISOLATED_V1_STATE_MARKER,
      },
    });
    await expect(validateCombinedStateMarker(stateRoot, combined.schemaFingerprint, {
      assertAcl: noAcl,
    })).resolves.toBe(join(stateRoot, AP4M_X402_COMBINED_V1_MARKER));
    await expect(validateExistingCombinedState(stateRoot, REPO_ROOT, { assertAcl: noAcl }))
      .resolves.toEqual(combined);
  }, 30_000);

  it("rolls back on validation failure and refuses a missing payer, an old schema, and a second upgrade", async () => {
    const missingPayer = await fixture("missing-payer");
    const db = new DatabaseSync(missingPayer.databasePath);
    db.exec("DELETE FROM x402_payers");
    db.close();
    await expect(upgradeIsolatedX402StateToCombined(missingPayer.stateRoot, {
      repoRoot: REPO_ROOT,
      validateV1: portableV1,
      acquireLease: (root: string) => acquireIsolatedX402StateLease(root, { assertAcl: noAcl }),
      assertPayer: (path: string) => assertCombinedPayerBinding(path, secrets()),
    })).rejects.toThrow(/missing or unsafe/u);
    expect(existsSync(join(missingPayer.stateRoot, AP4M_X402_COMBINED_V1_MARKER))).toBe(false);

    const valid = await fixture("single-use");
    await upgradeIsolatedX402StateToCombined(valid.stateRoot, {
      repoRoot: REPO_ROOT,
      validateV1: portableV1,
      acquireLease: (root: string) => acquireIsolatedX402StateLease(root, { assertAcl: noAcl }),
      publishMarker: (root: string, fingerprint: string) =>
        writeCombinedStateMarker(root, fingerprint, { assertAcl: noAcl }),
      assertPayer: (path: string) => assertCombinedPayerBinding(path, secrets()),
    });
    await expect(upgradeIsolatedX402StateToCombined(valid.stateRoot, {
      repoRoot: REPO_ROOT,
      validateV1: portableV1,
      acquireLease: (root: string) => acquireIsolatedX402StateLease(root, { assertAcl: noAcl }),
      assertPayer: (path: string) => assertCombinedPayerBinding(path, secrets()),
    })).rejects.toThrow(/missing or unsafe/u);
  }, 30_000);

  it("resumes only marker publication after a verified post-commit crash", async () => {
    const { stateRoot, databasePath } = await fixture("marker-resume");
    await expect(upgradeIsolatedX402StateToCombined(stateRoot, {
      repoRoot: REPO_ROOT,
      validateV1: portableV1,
      acquireLease: (root: string) => acquireIsolatedX402StateLease(root, { assertAcl: noAcl }),
      publishMarker: async () => { throw new Error("simulated marker crash"); },
      assertPayer: (path: string) => assertCombinedPayerBinding(path, secrets()),
    })).rejects.toThrow(/missing or unsafe/u);
    expect(existsSync(join(stateRoot, AP4M_X402_COMBINED_V1_MARKER))).toBe(false);
    const committed = new DatabaseSync(databasePath, { readOnly: true });
    expect(committed.prepare("SELECT name FROM d1_migrations WHERE id = 8").get())
      .toEqual({ name: AP4M_X402_COMBINED_V1_MIGRATION });
    committed.close();

    const recovered = await upgradeIsolatedX402StateToCombined(stateRoot, {
      repoRoot: REPO_ROOT,
      validateV1: portableV1,
      acquireLease: (root: string) => acquireIsolatedX402StateLease(root, { assertAcl: noAcl }),
      validateCommitted: (root: string, repoRoot: string) =>
        validateCombinedStateLayout(root, repoRoot, { assertAcl: noAcl }),
      publishMarker: (root: string, fingerprint: string) =>
        writeCombinedStateMarker(root, fingerprint, { assertAcl: noAcl }),
      assertPayer: (path: string) => assertCombinedPayerBinding(path, secrets()),
    });
    expect(recovered.schemaFingerprint).toBe(await expectedCombinedSchemaFingerprint(REPO_ROOT));
    expect(existsSync(join(stateRoot, AP4M_X402_COMBINED_V1_MARKER))).toBe(true);
  }, 30_000);

  it("matches the authoritative QN table, column, index, and constraint shape on a fresh schema", async () => {
    const combined = new DatabaseSync(":memory:");
    for (const name of [...migrations, AP4M_X402_COMBINED_V1_MIGRATION]) {
      combined.exec(readFileSync(join(REPO_ROOT, "migrations-local-x402", name), "utf8"));
    }
    const authoritative = new DatabaseSync(":memory:");
    authoritative.exec(readFileSync(join(REPO_ROOT, "migrations", "0001_init.sql"), "utf8"));
    authoritative.exec(readFileSync(join(REPO_ROOT, "migrations", "0002_quicknode.sql"), "utf8"));
    authoritative.exec(readFileSync(
      join(REPO_ROOT, "migrations", "0008_quicknode_rpc_counters.sql"),
      "utf8",
    ));

    for (const name of [
      "qn_nonces",
      "qn_wallet_events",
      "qn_watchdog_events",
      "qn_rpc_counters",
      "idx_qn_wallet_account",
      "idx_qn_watchdog_account",
    ]) {
      const sql = (database: DatabaseSync) => database.prepare(
        "SELECT type, tbl_name, sql FROM sqlite_schema WHERE name = ?",
      ).get(name) as { type: string; tbl_name: string; sql: string };
      expect({ ...sql(combined), sql: normalizeSql(sql(combined).sql) })
        .toEqual({ ...sql(authoritative), sql: normalizeSql(sql(authoritative).sql) });
    }
    for (const table of ["links", "executions"]) {
      expect(combined.prepare(`PRAGMA table_xinfo(${table})`).all())
        .toEqual(authoritative.prepare(`PRAGMA table_xinfo(${table})`).all());
    }
    combined.close();
    authoritative.close();
  });

  it("rejects a tampered combined schema or marker fingerprint", async () => {
    const { stateRoot, databasePath } = await fixture("tamper");
    const combined = await upgradeIsolatedX402StateToCombined(stateRoot, {
      repoRoot: REPO_ROOT,
      validateV1: portableV1,
      acquireLease: (root: string) => acquireIsolatedX402StateLease(root, { assertAcl: noAcl }),
      publishMarker: (root: string, fingerprint: string) =>
        writeCombinedStateMarker(root, fingerprint, { assertAcl: noAcl }),
      assertPayer: (path: string) => assertCombinedPayerBinding(path, secrets()),
    });
    await expect(validateCombinedDatabase(databasePath, REPO_ROOT)).resolves.toEqual(combined);
    const markerPath = join(stateRoot, AP4M_X402_COMBINED_V1_MARKER);
    writeFileSync(markerPath, '{"contract":"partial"}\n', { mode: 0o600 });
    await expect(validateExistingCombinedState(stateRoot, REPO_ROOT, { assertAcl: noAcl }))
      .rejects.toThrow(/missing or unsafe/u);
    const mixed = JSON.parse(combinedStateMarkerContents(
      stateRoot,
      combined.schemaFingerprint,
    ));
    mixed.signingProfile = "reviewed-testnet-isolated-v1";
    writeFileSync(markerPath, `${JSON.stringify(mixed, null, 2)}\n`, { mode: 0o600 });
    await expect(validateExistingCombinedState(stateRoot, REPO_ROOT, { assertAcl: noAcl }))
      .rejects.toThrow(/missing or unsafe/u);
    writeFileSync(
      markerPath,
      combinedStateMarkerContents(stateRoot, combined.schemaFingerprint),
      { mode: 0o600 },
    );
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE unexpected_table(id TEXT)");
    database.close();
    await expect(validateCombinedDatabase(databasePath, REPO_ROOT))
      .rejects.toThrow(/missing or unsafe/u);
  }, 30_000);

  it("rejects an access-broadening permission change anywhere in the combined state tree", async () => {
    const { stateRoot, databasePath } = await fixture("permissions");
    await upgradeIsolatedX402StateToCombined(stateRoot, {
      repoRoot: REPO_ROOT,
      validateV1: portableV1,
      acquireLease: (root: string) => acquireIsolatedX402StateLease(root, { assertAcl: noAcl }),
      publishMarker: (root: string, fingerprint: string) =>
        writeCombinedStateMarker(root, fingerprint, { assertAcl: noAcl }),
      assertPayer: (path: string) => assertCombinedPayerBinding(path, secrets()),
    });
    chmodSync(databasePath, 0o640);
    await expect(validateExistingCombinedState(stateRoot, REPO_ROOT, { assertAcl: noAcl }))
      .rejects.toThrow(/missing or unsafe/u);
  }, 30_000);
});
