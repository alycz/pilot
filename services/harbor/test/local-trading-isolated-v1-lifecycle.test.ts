import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import type { OpContext, OpDef } from "../src/catalog/registry";
import { OpRegistry } from "../src/catalog/registry";
import type { AccountLink, Envelope, TxBuild } from "../src/contracts";
import { DEFAULT_DELEGATED_PERMISSIONS } from "../src/exec/delegation";
import { Store } from "../src/exec/store";
import {
  LOCAL_TRADING_ONBOARDING_OPERATION_ALLOWLIST,
  LOCAL_TRADING_ONBOARDING_OPERATION_DISABLED,
  LOCAL_TRADING_OPERATION_ALLOWLIST,
  LOCAL_TRADING_OPERATION_DISABLED,
  createHarborProvider,
} from "../src/executor/providers";
import {
  LOCAL_TRADING_ISOLATED_ONBOARDING_V1_BUILD_ORIGIN,
  LOCAL_TRADING_ISOLATED_ONBOARDING_V1_SIGNING_PROFILE,
} from "../src/local-trading-isolated-onboarding-v1";
import {
  LOCAL_TRADING_ISOLATED_V1_BUILD_ORIGIN,
  LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE,
} from "../src/local-trading-isolated-v1";
import { ops as accountOps, type AccountServices } from "../src/ops/account";
import { ops as txOps } from "../src/ops/tx";
import { ops as txExecutionOps } from "../src/ops/tx-exec";

type SqlValue = string | number | bigint | null | Uint8Array;

const PRINCIPAL = "isolated-lifecycle-principal";
const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const DELEGATE = "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn";
const ISSUER = "rP9jPyP5kyvFRb6ZiRghAGw5u8SGAmU4bd";
const GRANT_HASH = "A".repeat(64);
const REVOKE_HASH = "B".repeat(64);
const CREATED_AT = "2026-10-20T10:00:00.000Z";

const expectedOnboardingAllowlist = [
  "onboarding.readiness",
  "account.link",
  "account.status",
  "account.revoke",
  "ledger.account.info",
  "ledger.account.lines",
  "ledger.account.tx",
  "policy.get",
  "policy.set",
  "tx.trustSet",
  "tx.approvalPreflight",
  "tx.execute",
  "tx.submit",
  "tx.status",
];

const expectedTradingAllowlist = [
  "tx.swap",
  "tx.approvalPreflight",
  "tx.approvalReconcile",
  "tx.execute",
  "tx.submit",
  "tx.status",
];

const reviewedBaseEnvironment = {
  EXEC_NETWORK: "testnet",
  EXECUTOR: "quickjs",
  MAINNET_EXECUTION: "false",
  HARBOR_LOCAL_DEV: "true",
  HARBOR_LOCAL_READ_ONLY: "false",
  HARBOR_LOCAL_AUTH_REQUIRED: "true",
  HARBOR_LOCAL_CRON_DISABLED: "true",
  HARBOR_LOCAL_X402: "false",
  HARBOR_LOCAL_X402_RUNTIME_ENABLED: "false",
  HARBOR_SOURCE_TAG: "2610240",
  // The key constructor is replaced below. This marker is never used as key
  // material and no credential file or process environment is read.
  HARBOR_KEK: "offline-lifecycle-placeholder",
} as const;

const isolatedOnboardingEnvironment = {
  ...reviewedBaseEnvironment,
  HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_RUNTIME_ENABLED: "true",
  HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_SIGNING_PROFILE:
    LOCAL_TRADING_ISOLATED_ONBOARDING_V1_SIGNING_PROFILE,
} as const;

const isolatedTradingEnvironment = {
  ...reviewedBaseEnvironment,
  HARBOR_LOCAL_TRADING_ISOLATED_V1_RUNTIME_ENABLED: "true",
  HARBOR_LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE:
    LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE,
} as const;

function sqliteValue(value: unknown): SqlValue {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value as SqlValue;
}

class SqliteD1Statement {
  private values: SqlValue[] = [];

  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): this {
    this.values = values.map(sqliteValue);
    return this;
  }

  execute(): D1Result {
    const result = this.statement.run(...this.values);
    return {
      success: true,
      meta: { changes: Number(result.changes) } as D1Result["meta"],
    };
  }

  async run(): Promise<D1Result> {
    return this.execute();
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.statement.get(...this.values) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return null;
    return (column === undefined ? row : row[column]) as T;
  }

  async all<T>(): Promise<D1Result<T>> {
    return {
      success: true,
      results: this.statement.all(...this.values) as T[],
      meta: {} as D1Result<T>["meta"],
    };
  }
}

class MigratedSqliteD1 {
  readonly sqlite = new DatabaseSync(":memory:");

  constructor() {
    const migrations = readdirSync(
      new URL("../migrations", import.meta.url),
    )
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort();
    for (const migration of migrations) {
      this.sqlite.exec(
        readFileSync(
          new URL(`../migrations/${migration}`, import.meta.url),
          "utf8",
        ),
      );
    }
    this.sqlite.exec("PRAGMA foreign_keys = ON");
  }

  prepare(sql: string): SqliteD1Statement {
    return new SqliteD1Statement(this.sqlite.prepare(sql));
  }

  async batch(statements: SqliteD1Statement[]): Promise<D1Result[]> {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.execute());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  asD1(): D1Database {
    return this as unknown as D1Database;
  }

  close(): void {
    this.sqlite.close();
  }
}

function operation(definitions: readonly OpDef[], name: string): OpDef {
  const definition = definitions.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`missing operation ${name}`);
  return definition;
}

function lifecycleRegistry(): OpRegistry {
  return new OpRegistry([
    ...accountOps,
    operation(txOps, "tx.swap"),
    operation(txOps, "tx.trustSet"),
    ...txExecutionOps,
  ]);
}

function expectOk<T>(envelope: Envelope<unknown>): T {
  expect(envelope.ok).toBe(true);
  if (!envelope.ok) throw new Error(envelope.error.code ?? envelope.error.message);
  return envelope.data as T;
}

function permissionObjects(permissions: readonly string[]) {
  return permissions.map((PermissionValue) => ({
    Permission: { PermissionValue },
  }));
}

function rpcFixture() {
  return vi.fn(
    async (
      network: string,
      command: string,
      params: Readonly<Record<string, unknown>> = {},
    ): Promise<Record<string, unknown>> => {
      switch (command) {
        case "server_info":
          return {
            info: {
              validated_ledger: {
                reserve_base_xrp: 10,
                reserve_inc_xrp: 2,
              },
            },
          };
        case "account_info":
          return {
            account_data: {
              Account: params.account,
              Balance: "1000000000",
              OwnerCount: 1,
              Sequence: 22,
              Flags: 0,
            },
            ledger_index: 90_000_000,
            validated: true,
          };
        case "account_lines":
          return {
            account: params.account,
            ledger_index: 90_000_000,
            lines: [
              {
                account: params.peer,
                balance: "10",
                currency: "USD",
                limit: "1000",
                peer_authorized: true,
              },
            ],
            validated: true,
          };
        case "fee":
          return {
            drops: { open_ledger_fee: "12" },
            ledger_current_index: 90_000_001,
          };
        case "simulate":
          return {
            engine_result: "tesSUCCESS",
            engine_result_message: "The simulated transaction would succeed.",
            applied: false,
          };
        case "book_offers": {
          const gets = params.taker_gets as { currency?: string };
          if (network === "mainnet") {
            return gets.currency === "XRP"
              ? {
                  offers: [
                    {
                      TakerGets: "2000000",
                      TakerPays: {
                        currency:
                          "524C555344000000000000000000000000000000",
                        issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
                        value: "1",
                      },
                    },
                  ],
                }
              : {
                  offers: [
                    {
                      TakerGets: {
                        currency:
                          "524C555344000000000000000000000000000000",
                        issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
                        value: "1",
                      },
                      TakerPays: "2000000",
                    },
                  ],
                };
          }
          return gets.currency === "XRP"
            ? {
                ledger_index: 90_000_000,
                offers: [
                  {
                    TakerGets: "2000000",
                    TakerPays: {
                      currency: "USD",
                      issuer: ISSUER,
                      value: "1",
                    },
                    quality: "0.0000005",
                  },
                ],
              }
            : {
                ledger_index: 90_000_000,
                offers: [
                  {
                    TakerGets: {
                      currency: "USD",
                      issuer: ISSUER,
                      value: "1",
                    },
                    TakerPays: "2000000",
                    quality: "2000000",
                  },
                ],
              };
        }
        default:
          throw new Error(`unexpected offline RPC command: ${command}`);
      }
    },
  );
}

async function bindValidatedDirectOwnerBoundary(
  db: MigratedSqliteD1,
  transaction: Record<string, unknown>,
  expectedPermissions: readonly string[],
  hash: string,
): Promise<void> {
  expect(transaction).toMatchObject({
    TransactionType: "DelegateSet",
    Account: OWNER,
    Authorize: DELEGATE,
    Permissions: permissionObjects(expectedPermissions),
  });
  expect(transaction).not.toHaveProperty("TxnSignature");
  expect(transaction).not.toHaveProperty("SigningPubKey");

  // This is the only substituted boundary: the wallet-owned blob is treated
  // as validated and represented by a deterministic hash. No wallet, seed,
  // signing primitive, submission transport, or network is involved.
  const eventId = `direct-owner-submit:${PRINCIPAL}:${hash}`;
  const detail = JSON.stringify({ hash, network: "testnet" });
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO events (id, principal, owner, kind, detail, created_at)
         VALUES (?, ?, ?, 'direct_owner_submission', ?, ?)`,
      )
      .bind(eventId, PRINCIPAL, OWNER, detail, CREATED_AT),
    db
      .prepare(
        `INSERT INTO direct_submission_bindings
          (principal, hash, owner, network, origin_profile, created_at)
         VALUES (?, ?, ?, 'testnet', ?, ?)`,
      )
      .bind(
        PRINCIPAL,
        hash,
        OWNER,
        LOCAL_TRADING_ISOLATED_ONBOARDING_V1_BUILD_ORIGIN,
        CREATED_AT,
      ),
  ]);
  expect(results.map((result) => result.meta?.changes)).toEqual([1, 1]);
}

describe("local trading isolated v1 sequential wallet lifecycle", () => {
  it("hands one migrated D1 from onboarding to trading and back without crossing profile capabilities", async () => {
    const db = new MigratedSqliteD1();
    const d1 = db.asD1();
    const entries = new Map<string, Record<string, unknown>>();
    const rpc = rpcFixture();
    const status = vi.fn(async (_ctx, network: "testnet" | "devnet", hash: string) => ({
      hash,
      network,
      validated: true,
      ledger_index: 90_000_010,
      engine_result: "tesSUCCESS",
    }));
    const fundDelegateAccount = vi.fn(async () => {
      throw new Error("isolated onboarding must not invoke a faucet");
    });
    const accountServices: AccountServices = {
      ledger: {
        prepareTransaction: vi.fn(async (_network, transaction) => ({
          ...transaction,
          Fee: "12",
          Sequence: 7,
          LastLedgerSequence: 90_000_020,
        })),
        readDelegate: vi.fn(async (_network, owner, delegate) =>
          entries.get(`${owner}:${delegate}`) ?? null,
        ),
        isAccountFunded: vi.fn(async () => false),
      },
      createWrappedDelegateKey: vi.fn(async () => ({
        address: DELEGATE,
        publicKey: "offline-public-key-placeholder",
        ciphertext: new Uint8Array([1, 2, 3]).buffer,
        iv: new Uint8Array([4, 5, 6]).buffer,
      })),
      fundDelegateAccount,
      now: () => new Date(CREATED_AT),
      randomUUID: () => "isolated-lifecycle-link",
    };
    const registry = lifecycleRegistry();
    let activeProfile: "onboarding" | "trading" | null = null;

    const start = (
      profile: "onboarding" | "trading",
    ): ReturnType<typeof createHarborProvider> => {
      expect(activeProfile).toBeNull();
      activeProfile = profile;
      const env =
        profile === "onboarding"
          ? isolatedOnboardingEnvironment
          : isolatedTradingEnvironment;
      const ctx: OpContext = {
        principal: PRINCIPAL,
        localDevRequest: true,
        db: d1,
        env,
        sourceTag: 2_610_240,
        xrplRpc: { request: rpc },
        accountServices,
        executionServices: {
          status,
          now: () => new Date(CREATED_AT),
          randomUUID: () => "offline-execution-id",
        },
      };
      return createHarborProvider(registry, ctx);
    };
    const stop = (): void => {
      expect(activeProfile).not.toBeNull();
      activeProfile = null;
    };

    try {
      expect([...LOCAL_TRADING_ONBOARDING_OPERATION_ALLOWLIST]).toEqual(
        expectedOnboardingAllowlist,
      );
      expect([...LOCAL_TRADING_OPERATION_ALLOWLIST]).toEqual(
        expectedTradingAllowlist,
      );

      const onboarding = start("onboarding");
      for (const operationName of ["tx.swap", "tx.approvalReconcile"]) {
        expect(await onboarding.invoke(operationName, {})).toMatchObject({
          ok: false,
          error: { code: LOCAL_TRADING_ONBOARDING_OPERATION_DISABLED },
        });
      }
      const pending = expectOk<AccountLink>(
        await onboarding.invoke("account.link", {
          owner: OWNER,
          network: "testnet",
        }),
      );
      expect(pending).toMatchObject({
        owner: OWNER,
        network: "testnet",
        delegate: DELEGATE,
        permissions: [...DEFAULT_DELEGATED_PERMISSIONS],
        status: "pending",
      });
      expect(fundDelegateAccount).not.toHaveBeenCalled();

      await bindValidatedDirectOwnerBoundary(
        db,
        pending.delegate_set_tx!,
        DEFAULT_DELEGATED_PERMISSIONS,
        GRANT_HASH,
      );
      entries.set(`${OWNER}:${DELEGATE}`, {
        LedgerEntryType: "Delegate",
        Account: OWNER,
        Authorize: DELEGATE,
        Permissions: permissionObjects(DEFAULT_DELEGATED_PERMISSIONS),
        ledger_index: 90_000_001,
      });
      const active = expectOk<AccountLink>(
        await onboarding.invoke("account.status", {
          owner: OWNER,
          network: "testnet",
        }),
      );
      expect(active).toMatchObject({
        delegate: DELEGATE,
        permissions: [...DEFAULT_DELEGATED_PERMISSIONS],
        status: "active",
      });
      expectOk(
        await onboarding.invoke("tx.status", { hash: GRANT_HASH }),
      );

      const trustSet = expectOk<TxBuild>(
        await onboarding.invoke("tx.trustSet", {
          network: "testnet",
          account: OWNER,
          limit_amount: { currency: "USD", issuer: ISSUER, value: "100" },
          execution_contract: "xrpl_execution_v2",
        }),
      );
      expect(trustSet.tx_json).toMatchObject({
        TransactionType: "TrustSet",
        Account: OWNER,
      });
      const durableTrustSet = await new Store(d1, PRINCIPAL).getBuild(
        trustSet.build_id,
      );
      expect(durableTrustSet).toMatchObject({
        originProfile: LOCAL_TRADING_ISOLATED_ONBOARDING_V1_BUILD_ORIGIN,
        executionContract: "xrpl_execution_v2",
        buildRevision: 1,
      });

      const capability = trustSet.execution_capability!;
      await new Store(d1, PRINCIPAL).insertApproval({
        id: "isolated-onboarding-recovery-candidate",
        buildId: trustSet.build_id,
        txJson: trustSet.tx_json,
        expiresAt: "2026-10-20T10:01:30.000Z",
        status: "pending",
        executionId: "isolated-onboarding-recovery-execution",
        executionContract: "xrpl_execution_v2",
        buildRevision: capability.build_revision,
      });
      stop();

      const trading = start("trading");
      expect(await new Store(d1, PRINCIPAL).getLink(OWNER, "testnet"))
        .toMatchObject({ id: "isolated-lifecycle-link", status: "active" });

      const swap = expectOk<TxBuild>(
        await trading.invoke("tx.swap", {
          network: "testnet",
          account: OWNER,
          sell: { currency: "XRP" },
          buy: { currency: "USD", issuer: ISSUER },
          amount: "1000000",
          side: "sell",
          max_slippage_bps: 100,
        }),
      );
      expect(await new Store(d1, PRINCIPAL).getBuild(swap.build_id))
        .toMatchObject({
          originProfile: LOCAL_TRADING_ISOLATED_V1_BUILD_ORIGIN,
        });

      for (const [name, args] of [
        ["account.status", { owner: OWNER, network: "testnet" }],
        [
          "tx.trustSet",
          {
            network: "testnet",
            account: OWNER,
            limit_amount: { currency: "USD", issuer: ISSUER, value: "1" },
          },
        ],
      ] as const) {
        const excluded = await trading.invoke(name, args);
        expect(excluded).toMatchObject({
          ok: false,
          error: { code: LOCAL_TRADING_OPERATION_DISABLED },
        });
      }

      const crossProfileBuild = await trading.invoke("tx.execute", {
        build_id: trustSet.build_id,
        idempotency_key: "cross-profile-build",
        execution_contract: "xrpl_execution_v2",
        build_revision: capability.build_revision,
      });
      expect(crossProfileBuild).toMatchObject({
        ok: false,
        error: { code: "OPERATION_FAILED" },
      });
      expect(
        db.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM build_consumptions WHERE principal = ? AND build_id = ?",
          )
          .get(PRINCIPAL, trustSet.build_id),
      ).toEqual({ count: 0 });

      const statusCallsBeforeCrossProfile = status.mock.calls.length;
      const crossProfileBinding = await trading.invoke("tx.status", {
        hash: GRANT_HASH,
      });
      expect(crossProfileBinding).toMatchObject({
        ok: false,
        error: { code: "OPERATION_FAILED" },
      });
      expect(status).toHaveBeenCalledTimes(statusCallsBeforeCrossProfile);

      const crossProfileRecovery = await trading.invoke(
        "tx.approvalReconcile",
        {
          approval_id: "isolated-onboarding-recovery-candidate",
          execution_contract: "xrpl_execution_v2",
          build_revision: capability.build_revision,
          unsigned_tx_digest: capability.unsigned_tx_digest,
          economic_fingerprint: capability.economic_fingerprint,
        },
      );
      expect(crossProfileRecovery).toMatchObject({
        ok: false,
        error: { code: "OPERATION_FAILED" },
      });
      expect(
        db.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM approval_recoveries WHERE principal = ?",
          )
          .get(PRINCIPAL),
      ).toEqual({ count: 0 });
      stop();

      const cleanup = start("onboarding");
      const suspended = expectOk<AccountLink>(
        await cleanup.invoke("account.revoke", {
          owner: OWNER,
          network: "testnet",
        }),
      );
      expect(suspended).toMatchObject({
        status: "suspended",
        revoke_tx: {
          TransactionType: "DelegateSet",
          Account: OWNER,
          Authorize: DELEGATE,
          Permissions: [],
        },
      });
      await bindValidatedDirectOwnerBoundary(
        db,
        suspended.revoke_tx!,
        [],
        REVOKE_HASH,
      );
      entries.delete(`${OWNER}:${DELEGATE}`);
      const revoked = expectOk<AccountLink>(
        await cleanup.invoke("account.status", {
          owner: OWNER,
          network: "testnet",
        }),
      );
      expect(revoked).toMatchObject({
        owner: OWNER,
        delegate: DELEGATE,
        permissions: [],
        status: "revoked",
      });
      expectOk(await cleanup.invoke("tx.status", { hash: REVOKE_HASH }));

      expect(
        db.sqlite
          .prepare(
            `SELECT hash, origin_profile
               FROM direct_submission_bindings
              WHERE principal = ?
              ORDER BY hash`,
          )
          .all(PRINCIPAL),
      ).toEqual([
        {
          hash: GRANT_HASH,
          origin_profile:
            LOCAL_TRADING_ISOLATED_ONBOARDING_V1_BUILD_ORIGIN,
        },
        {
          hash: REVOKE_HASH,
          origin_profile:
            LOCAL_TRADING_ISOLATED_ONBOARDING_V1_BUILD_ORIGIN,
        },
      ]);
      expect(
        db.sqlite
          .prepare(
            `SELECT id, origin_profile
               FROM builds
              WHERE principal = ? AND id IN (?, ?)
              ORDER BY origin_profile`,
          )
          .all(PRINCIPAL, trustSet.build_id, swap.build_id),
      ).toEqual([
        {
          id: trustSet.build_id,
          origin_profile:
            LOCAL_TRADING_ISOLATED_ONBOARDING_V1_BUILD_ORIGIN,
        },
        {
          id: swap.build_id,
          origin_profile: LOCAL_TRADING_ISOLATED_V1_BUILD_ORIGIN,
        },
      ]);
      expect(activeProfile).toBe("onboarding");
      stop();
      expect(activeProfile).toBeNull();
    } finally {
      db.close();
    }
  });
});
