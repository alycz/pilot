import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { LOCAL_TRADING_ISOLATED_V1_STATE_ROOT } from "../scripts/dev-local-trading-isolated-v1.mjs";
import {
  LOCAL_X402_ISOLATED_V1_D1_DATABASE_ID,
  LOCAL_X402_ISOLATED_V1_D1_DATABASE_NAME,
  LOCAL_X402_ISOLATED_V1_D1_PAYLOAD_FILENAME,
  LOCAL_X402_ISOLATED_V1_STATE_CONTRACT,
  LOCAL_X402_ISOLATED_V1_STATE_MARKER,
  LOCAL_X402_ISOLATED_V1_STATE_LOCK,
  acquireIsolatedX402StateLease,
  findIsolatedX402D1Payload,
  initializeIsolatedX402StateDirectory,
  isolatedX402StateMarkerContents,
  validateConfiguredIsolatedX402StateRoot,
  validateExistingIsolatedX402State,
  validateIsolatedX402StateMarker,
  validateIsolatedX402StateLayout,
  writeIsolatedX402StateMarker,
} from "../scripts/local-x402-isolated-state.mjs";

const roots: string[] = [];
const REPO_ROOT = realpathSync(process.cwd());
const PORTABLE_TEMP_ROOT = realpathSync(homedir());
const PAYLOAD_NAME = LOCAL_X402_ISOLATED_V1_D1_PAYLOAD_FILENAME;
const EXTRA_PAYLOAD_NAME = `${"b".repeat(64)}.sqlite`;
const assertEmptyAcl = () => undefined;
const MIGRATIONS = [
  "0001_init.sql",
  "0002_x402_payments.sql",
  "0003_x402_payers.sql",
  "0004_x402_sequence_safety.sql",
  "0005_x402_durable_lease.sql",
  "0006_x402_budget_accounting.sql",
  "0007_x402_payer_provisioning.sql",
  "0009_isolated_sequence_authority.sql",
] as const;

/**
 * These fixtures are portable because ACL policy is represented explicitly as
 * an empty ACL. Production callers retain the native Darwin inspector, which
 * remains fail-closed on unsupported platforms.
 */
function initializePortableStateDirectory(stateRoot: string) {
  return initializeIsolatedX402StateDirectory(stateRoot, { assertAcl: assertEmptyAcl });
}

function validatePortableStateLayout(stateRoot: string) {
  return validateIsolatedX402StateLayout(stateRoot, { assertAcl: assertEmptyAcl });
}

function writePortableStateMarker(stateRoot: string) {
  return writeIsolatedX402StateMarker(stateRoot, {
    validateLayout: validatePortableStateLayout,
  });
}

function validatePortableExistingState(stateRoot: string) {
  return validateExistingIsolatedX402State(stateRoot, {
    validateMarker: (path: string) => validateIsolatedX402StateMarker(path, {
      assertAcl: assertEmptyAcl,
    }),
    validateLayout: validatePortableStateLayout,
  });
}

function acquirePortableStateLease(stateRoot: string) {
  return acquireIsolatedX402StateLease(stateRoot, { assertAcl: assertEmptyAcl });
}

function temporaryRoot(label: string): string {
  const root = realpathSync(mkdtempSync(join(
    PORTABLE_TEMP_ROOT,
    `.harbor-x402-${label}-`,
  )));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function createSqlite(path: string, sql?: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let current = dirname(path);
  while (current !== dirname(current) && current.startsWith(roots.at(-1)!)) {
    chmodSync(current, 0o700);
    current = dirname(current);
  }
  const database = new DatabaseSync(path);
  if (sql) database.exec(sql);
  database.close();
  chmodSync(path, 0o600);
}

function applyX402Migrations(database: DatabaseSync, through = MIGRATIONS.length): void {
  database.exec(`CREATE TABLE _cf_METADATA (
    key INTEGER PRIMARY KEY,
    value BLOB
  )`);
  database.exec("INSERT INTO _cf_METADATA(key, value) VALUES (2, 36)");
  database.exec(`CREATE TABLE d1_migrations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`);
  for (const name of MIGRATIONS.slice(0, through)) {
    database.exec(readFileSync(
      join(process.cwd(), "migrations-profile-x402-isolated-v1", name),
      "utf8",
    ));
    database.prepare("INSERT INTO d1_migrations(name) VALUES (?)").run(name);
  }
}

function stateFixture(
  label: string,
  {
    ancillary = true,
    metadata = true,
    migrations = MIGRATIONS.length,
    payloadName = PAYLOAD_NAME,
    secondPayload = false,
  }: {
    ancillary?: boolean;
    metadata?: boolean;
    migrations?: number;
    payloadName?: string;
    secondPayload?: boolean;
  } = {},
): string {
  const parent = temporaryRoot(label);
  const stateRoot = join(parent, "state");
  const d1Directory = join(stateRoot, "v3", "d1", "miniflare-D1DatabaseObject");
  mkdirSync(d1Directory, { recursive: true, mode: 0o700 });
  for (const path of [
    stateRoot,
    join(stateRoot, "v3"),
    join(stateRoot, "v3", "d1"),
    d1Directory,
  ]) chmodSync(path, 0o700);
  if (metadata) createSqlite(join(d1Directory, "metadata.sqlite"), `CREATE TABLE _cf_ALARM (
    actor_id TEXT PRIMARY KEY,
    scheduled_time INTEGER,
    actor_name TEXT
  ) WITHOUT ROWID`);
  const payload = join(d1Directory, payloadName);
  const database = new DatabaseSync(payload);
  applyX402Migrations(database, migrations);
  database.close();
  chmodSync(payload, 0o600);
  if (secondPayload) createSqlite(join(d1Directory, EXTRA_PAYLOAD_NAME));
  if (ancillary) {
    createSqlite(join(stateRoot, "v3", "cache", "miniflare-CacheObject", "metadata.sqlite"));
    createSqlite(join(stateRoot, "v3", "kv", "miniflare-KVNamespaceObject", "metadata.sqlite"));
    createSqlite(join(stateRoot, "v3", "r2", "miniflare-R2BucketObject", "metadata.sqlite"));
    createSqlite(join(
      stateRoot,
      "v3",
      "observability",
      "miniflare-wobs-trace-store",
      `${"c".repeat(64)}.sqlite`,
    ));
  }
  return stateRoot;
}

function payloadPath(stateRoot: string): string {
  return join(
    stateRoot,
    "v3",
    "d1",
    "miniflare-D1DatabaseObject",
    PAYLOAD_NAME,
  );
}

function markerPath(stateRoot: string): string {
  return join(stateRoot, LOCAL_X402_ISOLATED_V1_STATE_MARKER);
}

function writeMarker(stateRoot: string, value: unknown): void {
  writeFileSync(markerPath(stateRoot), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(markerPath(stateRoot), 0o600);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local isolated x402 state-root contract", () => {
  it("exports the pinned state and D1 identities", () => {
    expect(LOCAL_X402_ISOLATED_V1_STATE_CONTRACT)
      .toBe("harbor-local-x402-isolated-v1-state-v1");
    expect(LOCAL_X402_ISOLATED_V1_STATE_MARKER)
      .toBe(".harbor-local-x402-isolated-v1-state-v1.json");
    expect(LOCAL_X402_ISOLATED_V1_D1_DATABASE_ID)
      .toBe("33333333-3333-3333-3333-333333333333");
    expect(LOCAL_X402_ISOLATED_V1_D1_DATABASE_NAME)
      .toBe("harbor-local-x402-isolated-v1-only");
  });

  it("accepts only an explicit canonical external root", async () => {
    const parent = temporaryRoot("configured");
    const stateRoot = join(parent, "state");
    await expect(validateConfiguredIsolatedX402StateRoot(stateRoot)).resolves.toBe(stateRoot);

    const checkout = resolve(process.cwd());
    for (const rejected of [
      "relative/state",
      `${stateRoot}/../state`,
      `${stateRoot}\nreplacement`,
      join(parent, ".wrangler", "state"),
      checkout,
      join(checkout, "external-looking-state"),
      join(checkout, ".wrangler", "harbor-local-x402"),
      join(checkout, ".wrangler", "harbor-local-x402-isolated-v1"),
      LOCAL_TRADING_ISOLATED_V1_STATE_ROOT,
      join(LOCAL_TRADING_ISOLATED_V1_STATE_ROOT, "nested-x402"),
      dirname(LOCAL_TRADING_ISOLATED_V1_STATE_ROOT),
    ]) {
      await expect(validateConfiguredIsolatedX402StateRoot(rejected)).rejects.toThrow(
        "preserved state is missing or unsafe",
      );
    }

    const otherCheckout = temporaryRoot("other-checkout");
    writeFileSync(join(otherCheckout, ".git"), "gitdir: /private/elsewhere\n", { mode: 0o600 });
    await expect(validateConfiguredIsolatedX402StateRoot(join(otherCheckout, "state")))
      .rejects.toThrow("preserved state is missing or unsafe");
  });

  it("initializes only one absent leaf beneath an existing private parent", async () => {
    const parent = temporaryRoot("initialize");
    const stateRoot = join(parent, "state");
    await expect(initializePortableStateDirectory(stateRoot)).resolves.toBe(stateRoot);
    await expect(initializePortableStateDirectory(stateRoot)).rejects.toThrow(
      "preserved state is missing or unsafe",
    );

    const missingAncestors = join(temporaryRoot("missing-parent"), "missing", "state");
    await expect(initializePortableStateDirectory(missingAncestors)).rejects.toThrow(
      "preserved state is missing or unsafe",
    );

    const unsafeParent = temporaryRoot("unsafe-parent");
    chmodSync(unsafeParent, 0o755);
    await expect(initializePortableStateDirectory(join(unsafeParent, "state")))
      .rejects.toThrow("preserved state is missing or unsafe");

    const worldWritableAncestor = temporaryRoot("world-writable-tmp-ancestor");
    chmodSync(worldWritableAncestor, 0o777);
    const privateParent = join(worldWritableAncestor, "private-parent");
    mkdirSync(privateParent, { mode: 0o700 });
    await expect(initializePortableStateDirectory(join(privateParent, "state")))
      .rejects.toThrow("preserved state is missing or unsafe");
  });

  it("validates the real Miniflare D1 location and permits ancillary stores", async () => {
    const stateRoot = stateFixture("valid-layout");
    await expect(findIsolatedX402D1Payload(stateRoot)).resolves.toBe(payloadPath(stateRoot));
    await expect(validatePortableStateLayout(stateRoot)).resolves.toEqual({
      databasePath: payloadPath(stateRoot),
    });
  });

  it("adds only the isolated sequence authorities and safely fences a legacy active payment", () => {
    const database = new DatabaseSync(":memory:");
    applyX402Migrations(database, 7);
    const payer = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
    database.prepare(`INSERT INTO x402_payments (
      id, principal, idempotency_key, request_fingerprint, owner, network, delegate,
      url, status, created_at, updated_at, lease_acquired_at
    ) VALUES (?, ?, ?, ?, ?, 'testnet', ?, ?, 'claimed', ?, ?, ?)`)
      .run(
        "legacy-payment", "x402-only", "legacy-idempotency", "A".repeat(64), payer,
        payer, "http://127.0.0.1:8000/api/x402/compare",
        "2026-10-23T00:00:00.000Z", "2026-10-23T00:00:00.000Z",
        "2026-10-23T00:00:00.000Z",
      );
    const localMigration = readFileSync(
      join(process.cwd(), "migrations-local-x402", MIGRATIONS.at(-1)!),
      "utf8",
    );
    const profileMigration = readFileSync(
      join(process.cwd(), "migrations-profile-x402-isolated-v1", MIGRATIONS.at(-1)!),
      "utf8",
    );
    expect(profileMigration).toBe(localMigration);
    database.exec(profileMigration);
    database.exec(profileMigration);

    expect(database.prepare(`SELECT rail, attempt_id, state
      FROM payer_sequence_leases WHERE network = 'testnet' AND payer = ?`).get(payer))
      .toEqual({ rail: "legacy", attempt_id: "legacy-x402:legacy-payment", state: "legacy_ambiguous" });
    expect(database.prepare(`SELECT principal, source, attempt_id, state
      FROM account_sequence_leases WHERE network = 'testnet' AND account = ?`).get(payer))
      .toEqual({
        principal: "legacy:payer-runtime",
        source: "x402",
        attempt_id: "legacy-x402:legacy-payment",
        state: "ambiguous",
      });
    expect(database.prepare("SELECT COUNT(*) AS count FROM payer_sequence_leases").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM account_sequence_leases").get())
      .toEqual({ count: 1 });
    const tables = database.prepare(`SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name LIKE 'ap4m_%'`).all();
    expect(tables).toEqual([]);
    database.close();
  });

  it.runIf(process.platform === "darwin")(
    "retains native Darwin ACL inspection for state, marker, and lease validation",
    async () => {
      const initialized = join(temporaryRoot("native-initialize"), "state");
      await expect(initializeIsolatedX402StateDirectory(initialized)).resolves.toBe(initialized);

      const stateRoot = stateFixture("native-validation");
      await expect(validateIsolatedX402StateLayout(stateRoot)).resolves.toEqual({
        databasePath: payloadPath(stateRoot),
      });
      await expect(writeIsolatedX402StateMarker(stateRoot)).resolves.toBe(markerPath(stateRoot));
      await expect(validateExistingIsolatedX402State(stateRoot)).resolves.toEqual({
        databasePath: payloadPath(stateRoot),
      });
      const lease = await acquireIsolatedX402StateLease(stateRoot);
      await lease.release();
      expect(existsSync(lease.path)).toBe(false);
    },
    15_000,
  );

  it.runIf(process.platform !== "darwin")(
    "fails closed through the native ACL path on unsupported platforms",
    async () => {
      await expect(validateIsolatedX402StateLayout(stateFixture("native-unsupported")))
        .rejects.toThrow("preserved state is missing or unsafe");
    },
  );

  it("fails closed without mutation when native ACL inspection is unavailable", async () => {
    const unsupportedAcl = () => { throw new Error("UNSUPPORTED_PLATFORM"); };
    const absent = join(temporaryRoot("unsupported-initialize"), "state");
    await expect(initializeIsolatedX402StateDirectory(absent, {
      assertAcl: unsupportedAcl,
    })).rejects.toThrow("preserved state is missing or unsafe");
    expect(existsSync(absent)).toBe(false);

    const stateRoot = stateFixture("unsupported-validation");
    await expect(validateIsolatedX402StateLayout(stateRoot, {
      assertAcl: unsupportedAcl,
    })).rejects.toThrow("preserved state is missing or unsafe");

    await writePortableStateMarker(stateRoot);
    await expect(validateIsolatedX402StateMarker(stateRoot, {
      assertAcl: unsupportedAcl,
    })).rejects.toThrow("preserved state is missing or unsafe");
    expect(readFileSync(markerPath(stateRoot), "utf8"))
      .toBe(isolatedX402StateMarkerContents(stateRoot));

    await expect(acquireIsolatedX402StateLease(stateRoot, {
      assertAcl: unsupportedAcl,
    })).rejects.toThrow("UNSUPPORTED_PLATFORM");
    expect(existsSync(join(stateRoot, LOCAL_X402_ISOLATED_V1_STATE_LOCK))).toBe(false);
  });

  it("rejects missing, empty, partial, ambiguous, and old-schema layouts", async () => {
    const missing = join(temporaryRoot("missing"), "state");
    await expect(validatePortableStateLayout(missing)).rejects.toThrow(
      "preserved state is missing or unsafe",
    );
    const empty = join(temporaryRoot("empty"), "state");
    mkdirSync(empty, { mode: 0o700 });
    await expect(validatePortableStateLayout(empty)).rejects.toThrow(
      "preserved state is missing or unsafe",
    );
    await expect(validatePortableStateLayout(stateFixture("no-metadata", {
      metadata: false,
    }))).rejects.toThrow("preserved state is missing or unsafe");
    await expect(validatePortableStateLayout(stateFixture("bad-payload-name", {
      payloadName: "payload.sqlite",
    }))).rejects.toThrow("preserved state is missing or unsafe");
    await expect(validatePortableStateLayout(stateFixture("wrong-d1-identity", {
      payloadName: EXTRA_PAYLOAD_NAME,
    }))).rejects.toThrow("preserved state is missing or unsafe");
    await expect(validatePortableStateLayout(stateFixture("two-payloads", {
      secondPayload: true,
    }))).rejects.toThrow("preserved state is missing or unsafe");
    await expect(validatePortableStateLayout(stateFixture("old-schema", {
      migrations: 6,
    }))).rejects.toThrow("preserved state is missing or unsafe");
    await expect(validatePortableStateLayout(stateFixture("pre-sequence-authority", {
      migrations: 7,
    }))).rejects.toThrow("preserved state is missing or unsafe");
    const badMetadata = stateFixture("bad-metadata");
    writeFileSync(join(
      badMetadata, "v3", "d1", "miniflare-D1DatabaseObject", "metadata.sqlite",
    ), "", { mode: 0o600 });
    await expect(validatePortableStateLayout(badMetadata)).rejects.toThrow(
      "preserved state is missing or unsafe",
    );
    const persistedAlarm = stateFixture("persisted-alarm");
    const alarmDatabase = new DatabaseSync(join(
      persistedAlarm, "v3", "d1", "miniflare-D1DatabaseObject", "metadata.sqlite",
    ));
    alarmDatabase.prepare(
      "INSERT INTO _cf_ALARM(actor_id, scheduled_time, actor_name) VALUES (?, ?, ?)",
    ).run("unexpected", 1, "unexpected");
    alarmDatabase.close();
    await expect(validatePortableStateLayout(persistedAlarm)).rejects.toThrow(
      "preserved state is missing or unsafe",
    );
    const missingIndex = stateFixture("missing-index");
    const database = new DatabaseSync(payloadPath(missingIndex));
    database.exec("DROP INDEX idx_x402_payments_active_payer");
    database.close();
    await expect(validatePortableStateLayout(missingIndex)).rejects.toThrow(
      "preserved state is missing or unsafe",
    );
  }, 30_000);

  it("rejects symlinks, hardlinks, and unsafe permissions", async () => {
    const target = stateFixture("symlink-target");
    const aliasParent = temporaryRoot("symlink-alias");
    const alias = join(aliasParent, "state");
    symlinkSync(target, alias, "dir");
    await expect(validatePortableStateLayout(alias)).rejects.toThrow(
      "preserved state is missing or unsafe",
    );

    const linked = stateFixture("hardlinked");
    linkSync(payloadPath(linked), join(dirname(payloadPath(linked)), "payload-backup"));
    await expect(validatePortableStateLayout(linked)).rejects.toThrow(
      "preserved state is missing or unsafe",
    );

    const permissive = stateFixture("permissive");
    chmodSync(payloadPath(permissive), 0o644);
    await expect(validatePortableStateLayout(permissive)).rejects.toThrow(
      "preserved state is missing or unsafe",
    );

    const accessGrantingAcl = stateFixture("access-granting-acl");
    await expect(validateIsolatedX402StateLayout(accessGrantingAcl, {
      assertAcl: () => { throw new Error("ACCESS_GRANTING"); },
    })).rejects.toThrow("preserved state is missing or unsafe");
  });

  it("rejects complete-schema tampering across tables, indexes, views, triggers, and migration ids", async () => {
    for (const [label, sql] of [
      ["table", "CREATE TABLE unexpected_table(id TEXT)"],
      ["index", "CREATE INDEX unexpected_index ON links(id)"],
      ["view", "CREATE VIEW unexpected_view AS SELECT id FROM links"],
      ["trigger", `CREATE TRIGGER unexpected_trigger AFTER INSERT ON links
        BEGIN UPDATE links SET status = status WHERE id = NEW.id; END`],
      ["d1-system-metadata", "ALTER TABLE _cf_METADATA ADD COLUMN injected TEXT"],
      ["d1-system-metadata-row", "UPDATE _cf_METADATA SET value = X'00' WHERE key = 2"],
      ["d1-system-metadata-extra", "INSERT INTO _cf_METADATA(key, value) VALUES (3, X'31')"],
      ["migration-id", "UPDATE d1_migrations SET id = 10 WHERE id = 8"],
    ] as const) {
      const stateRoot = stateFixture(`schema-tamper-${label}`);
      const database = new DatabaseSync(payloadPath(stateRoot));
      database.exec(sql);
      database.close();
      await expect(validatePortableStateLayout(stateRoot)).rejects.toThrow(
        "preserved state is missing or unsafe",
      );
    }
  });

  it("creates the exact root-bound marker only once and only after valid layout", async () => {
    const stateRoot = stateFixture("marker");
    await expect(writePortableStateMarker(stateRoot)).resolves.toBe(markerPath(stateRoot));
    expect(readFileSync(markerPath(stateRoot), "utf8"))
      .toBe(isolatedX402StateMarkerContents(stateRoot));
    await expect(writePortableStateMarker(stateRoot)).rejects.toThrow(
      "preserved state is missing or unsafe",
    );

    const invalid = stateFixture("marker-invalid", { migrations: 6 });
    await expect(writePortableStateMarker(invalid)).rejects.toThrow(
      "preserved state is missing or unsafe",
    );
  });

  it("holds an exclusive state lease and removes only its owned lock on release", async () => {
    const stateRoot = join(temporaryRoot("lease"), "state");
    mkdirSync(stateRoot, { mode: 0o700 });
    const first = await acquirePortableStateLease(stateRoot);
    expect(first.path).toBe(join(stateRoot, LOCAL_X402_ISOLATED_V1_STATE_LOCK));
    await expect(acquirePortableStateLease(stateRoot)).rejects.toThrow(
      "preserved state is missing or unsafe",
    );
    await first.release();
    expect(existsSync(first.path)).toBe(false);
    const second = await acquirePortableStateLease(stateRoot);
    await second.release();
  });

  it("rejects missing, empty, partial, moved, or wrong-identity markers", async () => {
    const missing = stateFixture("marker-missing");
    await expect(validatePortableExistingState(missing)).rejects.toThrow(
      "preserved state is missing or unsafe",
    );

    for (const [label, marker] of [
      ["empty", ""],
      ["partial", { contract: LOCAL_X402_ISOLATED_V1_STATE_CONTRACT }],
      ["duplicate-key", "DUPLICATE"],
    ] as const) {
      const stateRoot = stateFixture(`marker-${label}`);
      if (typeof marker === "string") {
        const contents = marker === "DUPLICATE"
          ? `${isolatedX402StateMarkerContents(stateRoot).trimEnd().slice(0, -1)},\n  "network": "testnet"\n}\n`
          : marker;
        writeFileSync(markerPath(stateRoot), contents, { mode: 0o600 });
      } else writeMarker(stateRoot, marker);
      await expect(validatePortableExistingState(stateRoot)).rejects.toThrow(
        "preserved state is missing or unsafe",
      );
    }

    for (const [label, mutate] of [
      ["root", (marker: any) => { marker.stateRoot = "WRONG"; }],
      ["network", (marker: any) => { marker.network = "devnet"; }],
      ["profile", (marker: any) => { marker.signingProfile = "wrong"; }],
      ["binding", (marker: any) => { marker.d1.binding = "OTHER"; }],
      ["id", (marker: any) => { marker.d1.databaseId = "wrong"; }],
      ["name", (marker: any) => { marker.d1.databaseName = "wrong"; }],
    ] as const) {
      const stateRoot = stateFixture(`marker-wrong-${label}`);
      const marker = JSON.parse(isolatedX402StateMarkerContents(stateRoot));
      mutate(marker);
      writeMarker(stateRoot, marker);
      await expect(validatePortableExistingState(stateRoot)).rejects.toThrow(
        "preserved state is missing or unsafe",
      );
    }

    const source = stateFixture("marker-moved-source");
    await writePortableStateMarker(source);
    const destination = join(temporaryRoot("marker-moved-destination"), "state");
    // A copied root would retain the source binding in its marker.
    mkdirSync(destination, { mode: 0o700 });
    writeFileSync(markerPath(destination), readFileSync(markerPath(source)), { mode: 0o600 });
    await expect(validatePortableExistingState(destination)).rejects.toThrow(
      "preserved state is missing or unsafe",
    );
  });
});
