import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";

import { AccountSequenceLeaseAuthority } from "../src/exec/account-sequence-lease";
import { PayerSequenceLeaseAuthority } from "../src/exec/payer-sequence-lease";
import {
  LOCAL_X402_ISOLATED_V1_D1_DATABASE_ID,
  LOCAL_X402_ISOLATED_V1_D1_PAYLOAD_FILENAME,
  findIsolatedX402D1Payload,
  validateIsolatedX402D1Metadata,
  validateIsolatedX402Database,
  validateExistingIsolatedX402State,
  validateIsolatedX402StateLayout,
  validateIsolatedX402StateMarker,
  writeIsolatedX402StateMarker,
} from "../scripts/local-x402-isolated-state.mjs";

const roots: string[] = [];
const REPO_ROOT = realpathSync(process.cwd());
const MIGRATIONS = [
  "0001_init.sql",
  "0002_x402_payments.sql",
  "0003_x402_payers.sql",
  "0004_x402_sequence_safety.sql",
  "0005_x402_durable_lease.sql",
  "0006_x402_budget_accounting.sql",
  "0007_x402_payer_provisioning.sql",
  "0009_isolated_sequence_authority.sql",
  "0010_issued_x402_authority.sql",
];
const PAYER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const ATTEMPT_ID = "isolated-x402-payment-1";
const LEASE_TOKEN = "A".repeat(64);
const TX_HASH = "B".repeat(64);

const portableAclInspector = () => undefined;

function validatePortableStateLayout(stateRoot: string) {
  return validateIsolatedX402StateLayout(stateRoot, {
    assertAcl: portableAclInspector,
  });
}

function validatePortableStateMarker(stateRoot: string) {
  return validateIsolatedX402StateMarker(stateRoot, {
    assertAcl: portableAclInspector,
  });
}

function validatePortableExistingState(stateRoot: string) {
  return validateExistingIsolatedX402State(stateRoot, {
    validateLayout: validatePortableStateLayout,
    validateMarker: validatePortableStateMarker,
  });
}

function temporaryStateRoot(): string {
  const parent = realpathSync(mkdtempSync(join(
    (process.platform === "darwin" ? realpathSync(tmpdir()) : realpathSync(homedir())),
    ".harbor-x402-miniflare-",
  )));
  roots.push(parent);
  chmodSync(parent, 0o700);
  const stateRoot = join(parent, "state");
  mkdirSync(stateRoot, { mode: 0o700 });
  return stateRoot;
}

function sqlitePaths(stateRoot: string): string[] {
  const paths: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".sqlite")) {
        paths.push(relative(stateRoot, path));
      }
    }
  };
  visit(stateRoot);
  return paths.sort();
}

function options(stateRoot: string) {
  const persistence = join(stateRoot, "v3");
  return convertV4MiniflareOptions({
    bindings: {
      HARBOR_API_KEYS: `fixture:${"T".repeat(32)}`,
      HARBOR_KEK: Buffer.alloc(32, 7).toString("base64"),
    },
    cacheAPI: true,
    compatibilityDate: "2026-10-06",
    d1Databases: { DB: LOCAL_X402_ISOLATED_V1_D1_DATABASE_ID },
    inspectorPort: 0,
    isolatedResourcePersistencePath: persistence,
    kvNamespaces: { KV: "fixture-kv" },
    logRequests: false,
    modules: true,
    name: "harbor-local-x402-isolated-v1-lifecycle-fixture",
    port: 0,
    r2Buckets: { R2: "fixture-r2" },
    resourcePersistencePath: persistence,
    script: `export default {
      async fetch(_request, env) {
        if (!env.HARBOR_API_KEYS || !env.HARBOR_KEK) return new Response("missing", { status: 500 });
        return new Response("ok");
      }
    }`,
    telemetry: { enabled: false },
  });
}

async function executeSqlScript(
  database: Awaited<ReturnType<Miniflare["getD1Database"]>>,
  sql: string,
): Promise<void> {
  const statements = sql
    .replaceAll(/--[^\n]*(?:\n|$)/gu, " ")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await database.prepare(statement).run();
}

async function exercise(stateRoot: string, initialize: boolean): Promise<void> {
  const previousUmask = process.umask(0o077);
  let miniflare: Miniflare | undefined;
  try {
    miniflare = new Miniflare(options(stateRoot));
    const database = await miniflare.getD1Database("DB");
    if (initialize) {
      await executeSqlScript(database, `CREATE TABLE d1_migrations(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      );`);
      for (const name of MIGRATIONS) {
        await executeSqlScript(database, readFileSync(
          join(process.cwd(), "migrations-profile-x402-isolated-v1", name),
          "utf8",
        ));
        await database.prepare("INSERT INTO d1_migrations(name) VALUES (?)").bind(name).run();
      }
    }
    const rows = await database.prepare("SELECT name FROM d1_migrations ORDER BY id").all();
    expect(rows.results).toEqual(MIGRATIONS.map((name) => ({ name })));

    const payerLeases = new PayerSequenceLeaseAuthority(database);
    const accountLeases = new AccountSequenceLeaseAuthority(database);
    if (initialize) {
      const acquired = await payerLeases.acquire({
        network: "testnet",
        payer: PAYER,
        rail: "x402",
        attemptId: ATTEMPT_ID,
        token: LEASE_TOKEN,
        at: "2026-10-23T00:00:00.000Z",
      });
      expect(acquired.outcome).toBe("acquired");
      const identity = {
        network: acquired.lease.network,
        payer: acquired.lease.payer,
        generation: acquired.lease.generation,
        token: acquired.lease.token,
        rail: "x402" as const,
        attemptId: acquired.lease.attemptId,
      };
      expect(await accountLeases.get({ network: "testnet", account: PAYER }))
        .toMatchObject({ principal: "payer-runtime:x402", source: "x402", state: "preparing" });
      expect((await payerLeases.markSigningStarted({
        ...identity,
        sequence: 7,
        firstEligibleLedgerIndex: 101,
        lastLedgerSequence: 164,
        at: "2026-10-23T00:00:01.000Z",
      })).outcome).toBe("transitioned");
      expect((await payerLeases.markSigned({
        ...identity,
        hash: TX_HASH,
        at: "2026-10-23T00:00:02.000Z",
      })).outcome).toBe("transitioned");
      expect((await payerLeases.markSettlementUnknown({
        ...identity,
        hash: TX_HASH,
        at: "2026-10-23T00:00:03.000Z",
      })).outcome).toBe("transitioned");
    } else {
      const restored = await payerLeases.get({ network: "testnet", payer: PAYER });
      expect(restored).toMatchObject({
        generation: 1,
        rail: "x402",
        attemptId: ATTEMPT_ID,
        state: "settlement_unknown",
        hash: TX_HASH,
      });
      expect(await accountLeases.get({ network: "testnet", account: PAYER }))
        .toMatchObject({ source: "x402", attemptId: ATTEMPT_ID, state: "ambiguous", hash: TX_HASH });
      expect((await payerLeases.acquire({
        network: "testnet",
        payer: PAYER,
        rail: "x402",
        attemptId: "isolated-x402-payment-2",
        token: "C".repeat(64),
        at: "2026-10-23T00:01:00.000Z",
      })).outcome).toBe("blocked");
      const identity = {
        network: restored!.network,
        payer: restored!.payer,
        generation: restored!.generation,
        token: restored!.token,
        rail: "x402" as const,
        attemptId: restored!.attemptId,
      };
      expect((await payerLeases.releaseValidatedTerminal({
        ...identity,
        hash: TX_HASH,
        at: "2026-10-23T00:01:01.000Z",
        evidence: { validated: true, transactionFound: true, ledgerIndex: 120 },
      })).outcome).toBe("released");
      expect(await accountLeases.get({ network: "testnet", account: PAYER }))
        .toMatchObject({ state: "released", releaseEvidence: { kind: "validated_terminal" } });
      const recycled = await payerLeases.acquire({
        network: "testnet",
        payer: PAYER,
        rail: "x402",
        attemptId: "isolated-x402-payment-2",
        token: "C".repeat(64),
        at: "2026-10-23T00:01:02.000Z",
      });
      expect(recycled).toMatchObject({ outcome: "acquired", lease: { generation: 2 } });
      expect((await payerLeases.releasePreSign({
        network: recycled.lease.network,
        payer: recycled.lease.payer,
        generation: recycled.lease.generation,
        token: recycled.lease.token,
        rail: "x402",
        attemptId: recycled.lease.attemptId,
        at: "2026-10-23T00:01:03.000Z",
        proof: {
          code: "signing_never_began",
          signingStarted: false,
          signedBlobPersisted: false,
          hashPersisted: false,
        },
      })).outcome).toBe("released");
    }

    const kv = await miniflare.getKVNamespace("KV");
    if (initialize) await kv.put("restart-proof", "yes");
    expect(await kv.get("restart-proof")).toBe("yes");
    const r2 = await miniflare.getR2Bucket("R2");
    if (initialize) await r2.put("restart-proof", "yes");
    expect(await (await r2.get("restart-proof"))?.text()).toBe("yes");
    const caches = await miniflare.getCaches();
    const request = new Request("http://fixture.invalid/cache");
    if (initialize) await caches.default.put(
      request,
      new Response("yes", { headers: { "Cache-Control": "max-age=60" } }),
    );
    expect(await (await caches.default.match(request))?.text()).toBe("yes");
    expect(await (await miniflare.dispatchFetch("http://fixture.invalid/internal")).text())
      .toBe("ok");
  } finally {
    await miniflare?.dispose();
    process.umask(previousUmask);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("isolated x402 state across a real Miniflare lifecycle", () => {
  it("validates the exact D1 identity after shutdown and restart with ancillary stores", async () => {
    const stateRoot = temporaryStateRoot();
    await exercise(stateRoot, true);
    const d1Directory = join(stateRoot, "v3", "d1", "miniflare-D1DatabaseObject");
    validateIsolatedX402D1Metadata(join(d1Directory, "metadata.sqlite"));
    validateIsolatedX402Database(await findIsolatedX402D1Payload(stateRoot));
    await writeIsolatedX402StateMarker(stateRoot, {
      validateLayout: validatePortableStateLayout,
    });
    await expect(validatePortableExistingState(stateRoot)).resolves.toEqual({
      databasePath: join(
        stateRoot,
        "v3",
        "d1",
        "miniflare-D1DatabaseObject",
        LOCAL_X402_ISOLATED_V1_D1_PAYLOAD_FILENAME,
      ),
    });
    const first = sqlitePaths(stateRoot);
    expect(first).toContain("v3/cache/miniflare-CacheObject/metadata.sqlite");
    expect(first).toContain("v3/d1/miniflare-D1DatabaseObject/metadata.sqlite");
    expect(first).toContain("v3/kv/miniflare-KVNamespaceObject/metadata.sqlite");
    expect(first).toContain("v3/r2/miniflare-R2BucketObject/metadata.sqlite");

    await exercise(stateRoot, false);
    await expect(validatePortableExistingState(stateRoot)).resolves.toBeDefined();
    expect(sqlitePaths(stateRoot)).toEqual(first);
  }, 30_000);
});
