import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";

import { validateExistingIsolatedTradingState } from "../scripts/dev-local-trading-isolated-v1.mjs";
import { AccountSequenceLeaseAuthority } from "../src/exec/account-sequence-lease";
import {
  TRADING_ISOLATED_V1_MIGRATION_DIRECTORY,
  TRADING_ISOLATED_V1_MIGRATIONS,
} from "../scripts/isolated-migration-profiles.mjs";

const roots: string[] = [];
const D1_ID = "22222222-2222-2222-2222-222222222222";
const DUMMY_TOKEN = "T".repeat(32);
const DUMMY_KEK = Buffer.alloc(32, 7).toString("base64");
const ACCOUNT = "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn";
const NOW = "2026-10-23T01:00:00.000Z";

function temporaryStateRoot(): string {
  const root = mkdtempSync(join(process.cwd(), ".harbor-miniflare-lifecycle-"));
  roots.push(root);
  const stateRoot = join(root, "state");
  mkdirSync(stateRoot, { mode: 0o700 });
  chmodSync(stateRoot, 0o700);
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

function miniflareOptions(stateRoot: string) {
  const persistence = join(stateRoot, "v3");
  return convertV4MiniflareOptions({
    bindings: {
      HARBOR_API_KEYS: `fixture:${DUMMY_TOKEN}`,
      HARBOR_KEK: DUMMY_KEK,
    },
    cacheAPI: true,
    compatibilityDate: "2026-10-06",
    d1Databases: { DB: D1_ID },
    inspectorPort: 0,
    isolatedResourcePersistencePath: persistence,
    kvNamespaces: { KV: "fixture-kv" },
    logRequests: false,
    modules: true,
    name: "harbor-state-lifecycle-fixture",
    port: 0,
    r2Buckets: { R2: "fixture-r2" },
    resourcePersistencePath: persistence,
    script: `export default {
      async fetch(_request, env) {
        if (!env.HARBOR_API_KEYS || !env.HARBOR_KEK) return new Response("missing", { status: 500 });
        console.log("disposable lifecycle fixture");
        return new Response("ok");
      }
    }`,
    telemetry: { enabled: false },
    unsafeObservability: true,
  });
}

async function executeSqlScript(
  database: Awaited<ReturnType<Miniflare["getD1Database"]>>,
  sql: string,
): Promise<void> {
  const script = sql
    .replaceAll(/--[^\n]*(?:\n|$)/gu, " ")
    .replaceAll(/\s*\n\s*/gu, " ");
  await database.exec(script);
}

async function exerciseMiniflare(stateRoot: string, initialize: boolean) {
  const previousUmask = process.umask(0o077);
  let miniflare: Miniflare | undefined;
  try {
    miniflare = new Miniflare(miniflareOptions(stateRoot));
    const database = await miniflare.getD1Database("DB");
    if (initialize) {
      await executeSqlScript(database, `CREATE TABLE d1_migrations(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      );`);
      for (const name of TRADING_ISOLATED_V1_MIGRATIONS) {
        const migration = readFileSync(
          join(process.cwd(), TRADING_ISOLATED_V1_MIGRATION_DIRECTORY, name),
          "utf8",
        );
        await executeSqlScript(database, migration);
        await database.prepare("INSERT INTO d1_migrations(name) VALUES (?)")
          .bind(name).run();
      }
    }
    const migrations = await database
      .prepare("SELECT id, name FROM d1_migrations ORDER BY id")
      .all();
    expect(migrations.results).toEqual(TRADING_ISOLATED_V1_MIGRATIONS.map(
      (name, index) => ({ id: index + 1, name }),
    ));
    const tables = await database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'links'")
      .all();
    expect(tables.results).toEqual([{ name: "links" }]);

    const sequenceAuthority = new AccountSequenceLeaseAuthority(
      database as unknown as D1Database,
    );
    const owner = await sequenceAuthority.acquire({
      principal: "tenant:manual",
      network: "testnet",
      account: ACCOUNT,
      source: "manual",
      attemptId: "manual:isolated-profile",
      token: "A".repeat(64),
      at: NOW,
    });
    expect(owner.outcome).toBe(initialize ? "acquired" : "replay");
    const crossPrincipal = await sequenceAuthority.acquire({
      principal: "tenant:strategy",
      network: "testnet",
      account: ACCOUNT,
      source: "strategy",
      attemptId: "strategy:isolated-profile",
      token: "B".repeat(64),
      at: NOW,
    });
    expect(crossPrincipal.outcome).toBe("blocked");
    expect(crossPrincipal.lease).toMatchObject({
      principal: "tenant:manual",
      network: "testnet",
      account: ACCOUNT,
      source: "manual",
      state: "preparing",
    });

    const kv = await miniflare.getKVNamespace("KV");
    if (initialize) await kv.put("restart-proof", "yes");
    expect(await kv.get("restart-proof")).toBe("yes");

    const r2 = await miniflare.getR2Bucket("R2");
    if (initialize) await r2.put("restart-proof", "yes");
    expect(await (await r2.get("restart-proof"))?.text()).toBe("yes");

    const caches = await miniflare.getCaches();
    const cacheRequest = new Request("http://fixture.invalid/cache");
    if (initialize) {
      await caches.default.put(
        cacheRequest,
        new Response("yes", { headers: { "Cache-Control": "max-age=60" } }),
      );
    }
    expect(await (await caches.default.match(cacheRequest))?.text()).toBe("yes");

    const response = await miniflare.dispatchFetch("http://fixture.invalid/internal");
    expect(await response.text()).toBe("ok");
  } finally {
    await miniflare?.dispose();
    process.umask(previousUmask);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("isolated trading state across a real Miniflare lifecycle", () => {
  it("keeps canonical migration 0012 idempotent after strategy migration 0011", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(readFileSync(
        join(process.cwd(), "migrations", "0011_autonomous_strategies.sql"),
        "utf8",
      ));
      const before = database.prepare(`SELECT type, name, sql FROM sqlite_schema
        WHERE name IN ('account_sequence_leases', 'idx_account_sequence_state')
        ORDER BY type, name`).all();
      database.exec(readFileSync(
        join(process.cwd(), "migrations", "0012_isolated_sequence_authority.sql"),
        "utf8",
      ));
      const after = database.prepare(`SELECT type, name, sql FROM sqlite_schema
        WHERE name IN ('account_sequence_leases', 'idx_account_sequence_state')
        ORDER BY type, name`).all();
      expect(after).toEqual(before);
      expect(after).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it("validates after startup, shutdown, and restart with ancillary stores", async () => {
    const stateRoot = temporaryStateRoot();

    await exerciseMiniflare(stateRoot, true);
    await expect(validateExistingIsolatedTradingState(stateRoot)).resolves.toBeUndefined();

    const firstPaths = sqlitePaths(stateRoot);
    expect(firstPaths).toContain("v3/cache/miniflare-CacheObject/metadata.sqlite");
    expect(firstPaths).toContain("v3/d1/miniflare-D1DatabaseObject/metadata.sqlite");
    expect(firstPaths).toContain("v3/kv/miniflare-KVNamespaceObject/metadata.sqlite");
    expect(firstPaths).toContain("v3/r2/miniflare-R2BucketObject/metadata.sqlite");
    expect(firstPaths.some((path) =>
      /^v3\/observability\/miniflare-wobs-trace-store\/[0-9a-f]{64}\.sqlite$/.test(path)
    )).toBe(true);

    await exerciseMiniflare(stateRoot, false);
    await expect(validateExistingIsolatedTradingState(stateRoot)).resolves.toBeUndefined();
    expect(sqlitePaths(stateRoot)).toEqual(firstPaths);
  }, 30_000);
});
