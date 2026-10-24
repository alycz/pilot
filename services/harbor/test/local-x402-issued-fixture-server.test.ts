import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { Wallet } from "xrpl";
import { describe, expect, it, vi } from "vitest";

import { OpRegistry } from "../src/catalog/registry";
import {
  createLocalIssuedX402FixtureService,
  type LocalIssuedX402RuntimeAdapter,
} from "../src/exec/x402-issued-runtime";
import {
  digestIssuedApprovalEnvelope,
  type X402IssuedPolicy,
} from "../src/exec/x402-issued-offline";
import {
  LOCAL_X402_ISSUED_FIXTURE_PROFILE,
  isLocalX402IssuedFixtureEnvironment,
} from "../src/local-x402-issued-fixture";
import { ops as issuedOps } from "../src/ops/x402-issued";
import { createWorker, type Env } from "../src/server";
import type { X402Service } from "../src/x402-contract";

const MIGRATION = readFileSync(
  new URL("../migrations-local-x402/0010_issued_x402_authority.sql", import.meta.url),
  "utf8",
);
const CURRENCY = "524C555344000000000000000000000000000000";
const RESOURCE_URL = "http://127.0.0.1:8000/api/x402/compare";
const MERCHANT_ID = "merchant-issued-fixture-v1";
const SESSION_SCOPE = "owner-sign-session-0001";
const NOW = new Date("2026-10-24T12:00:00.000Z");
const TOKEN = "I".repeat(32);

type SqlValue = string | number | bigint | null | Uint8Array;

class SqliteD1Statement {
  private values: SqlValue[] = [];
  constructor(private readonly statement: StatementSync) {}
  bind(...values: unknown[]): this {
    this.values = values as SqlValue[];
    return this;
  }
  async run(): Promise<D1Result> {
    const result = this.statement.run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } as D1Result["meta"] };
  }
  async first<T>(column?: string): Promise<T | null> {
    const row = this.statement.get(...this.values) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return (column === undefined ? row : row[column]) as T;
  }
  async all<T>(): Promise<D1Result<T>> {
    return {
      success: true,
      results: this.statement.all(...this.values) as T[],
      meta: {} as D1Result["meta"],
    };
  }
}

class SqliteD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  constructor() { this.sqlite.exec(MIGRATION); }
  prepare(sql: string): SqliteD1Statement {
    return new SqliteD1Statement(this.sqlite.prepare(sql));
  }
  async batch(statements: SqliteD1Statement[]): Promise<D1Result[]> {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results: D1Result[] = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  close(): void { this.sqlite.close(); }
}

function base64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function profileEnv(
  db: SqliteD1,
  adapter?: LocalIssuedX402RuntimeAdapter,
): Env {
  return {
    DB: db as unknown as D1Database,
    HARBOR_API_KEYS: `issued-owner:${TOKEN}`,
    EXEC_NETWORK: "testnet",
    EXECUTOR: "quickjs",
    MAINNET_EXECUTION: "false",
    HARBOR_LOCAL_DEV: "true",
    HARBOR_LOCAL_READ_ONLY: "true",
    HARBOR_LOCAL_AUTH_REQUIRED: "true",
    HARBOR_LOCAL_CRON_DISABLED: "true",
    HARBOR_LOCAL_X402_ISSUED_FIXTURE_ENABLED: "true",
    HARBOR_LOCAL_X402_ISSUED_FIXTURE_PROFILE:
      LOCAL_X402_ISSUED_FIXTURE_PROFILE,
    ...(adapter === undefined
      ? {}
      : { HARBOR_LOCAL_X402_ISSUED_RUNTIME_ADAPTER: adapter }),
  };
}

function request(body: unknown): Request {
  return new Request("http://127.0.0.1:8791/api/ops/x402.payIssuedFixture", {
    method: "POST",
    headers: {
      authorization: `Bearer issued-owner:${TOKEN}`,
      "content-type": "application/json",
      host: "127.0.0.1:8791",
    },
    body: JSON.stringify(body),
  });
}

function fixtureAdapter(): {
  adapter: LocalIssuedX402RuntimeAdapter;
  requestBody: Record<string, unknown>;
  calls: { prepare: ReturnType<typeof vi.fn>; sign: ReturnType<typeof vi.fn> };
} {
  // Process-memory-only keys exercise signature validation; no seed/blob is persisted or logged.
  const payer = Wallet.generate();
  const payee = Wallet.generate();
  const issuer = Wallet.generate();
  const policy: X402IssuedPolicy = {
    asset: {
      kind: "xrpl-issued",
      network: "xrpl:1",
      currency: CURRENCY,
      issuer: issuer.classicAddress,
    },
    payTo: payee.classicAddress,
    sourceTag: 2_610_240,
    maxPerCall: "1",
    dailyCap: "2",
    lifetimeCap: "3",
    maxFeeDrops: "20",
    dailyFeeCapDrops: "40",
    lifetimeFeeCapDrops: "60",
    minimumXrpReserveDrops: "1200000",
  };
  const prepare = vi.fn(async (input: Parameters<LocalIssuedX402RuntimeAdapter["prepare"]>[0]) => {
    const approvalId = `approval-${input.idempotencyKey}`;
    const quoteExpiresAt = "2026-10-24T12:04:00.000Z";
    const approvalDigest = await digestIssuedApprovalEnvelope({
      version: 1,
      domain: "pilot.x402.owner-approval",
      approval_id: approvalId,
      network: "xrpl:1",
      execution_network: "testnet",
      session_scope: SESSION_SCOPE,
      idempotency_key: input.idempotencyKey,
      merchant: {
        id: MERCHANT_ID,
        resource_method: "POST",
        resource_url: RESOURCE_URL,
        pay_to: payee.classicAddress,
      },
      asset: {
        kind: "issued",
        network: "xrpl:1",
        namespace: "token",
        currency: CURRENCY,
        issuer: issuer.classicAddress,
      },
      amount: input.challenge.amount,
      owner: payer.classicAddress,
      quote_expires_at: quoteExpiresAt,
      merchant_invoice_id: input.challenge.invoiceId,
      transaction: {
        fee_drops: "12",
        sequence: 1,
        last_ledger_sequence: 1_014,
        source_tag: policy.sourceTag,
        validated_ledger_index: 1_000,
      },
    });
    return {
      owner: payer.classicAddress,
      approvalId,
      approvalDigest,
      quoteExpiresAt,
      feeDrops: "12",
      validatedLedgerIndex: 1_000,
      reserveBaseDrops: "1000000",
      reserveIncrementDrops: "200000",
      issuer: {
        account: issuer.classicAddress,
        flags: 0x0080_0000,
        transferRate: 1_000_000_000,
      },
      payer: {
        account: payer.classicAddress,
        balanceDrops: "5000000",
        ownerCount: 1,
        sequence: 1,
        flags: 0,
      },
      payee: { account: payee.classicAddress, flags: 0 },
      payerLine: {
        holder: payer.classicAddress,
        issuer: issuer.classicAddress,
        currency: CURRENCY,
        balance: "100",
        limit: "1000",
        frozen: false,
        deepFrozen: false,
        authorized: false,
        issuerNoRipple: false,
        qualitiesDefault: true,
      },
      payeeLine: {
        holder: payee.classicAddress,
        issuer: issuer.classicAddress,
        currency: CURRENCY,
        balance: "0",
        limit: "1000",
        frozen: false,
        deepFrozen: false,
        authorized: false,
        issuerNoRipple: false,
        qualitiesDefault: true,
      },
    };
  });
  let signedHash = "";
  const sign = vi.fn(async (
    signingRequest: Parameters<LocalIssuedX402RuntimeAdapter["signer"]["sign"]>[0],
  ) => {
    const signed = payer.sign(signingRequest.tx_json);
    signedHash = signed.hash;
    return { signedBlob: signed.tx_blob, hash: signed.hash };
  });
  const challenge = base64Json({
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: {
      url: RESOURCE_URL,
      description: "Local issued fixture",
      mimeType: "application/json",
    },
    accepts: [{
      scheme: "exact",
      network: "xrpl:1",
      asset: CURRENCY,
      payTo: payee.classicAddress,
      amount: "0.01",
      maxTimeoutSeconds: 60,
      extra: {
        areFeesSponsored: false,
        assetTransferMethod: "sequence",
        issuer: issuer.classicAddress,
        sourceTag: policy.sourceTag,
        invoiceId: "merchant-invoice-issued-001",
      },
    }],
    extensions: {},
  });
  const adapter: LocalIssuedX402RuntimeAdapter = {
    owner: payer.classicAddress,
    sessionScope: SESSION_SCOPE,
    merchantId: MERCHANT_ID,
    resourceUrl: RESOURCE_URL,
    policy,
    now: () => NOW,
    prepare,
    signer: { sign },
    merchant: {
      challenge: async () => new Response(JSON.stringify({ error: "payment_required" }), {
        status: 402,
        headers: { "content-type": "application/json", "payment-required": challenge },
      }),
      pay: async () => new Response(JSON.stringify({
        comparison: ["dex", "amm"],
        paymentEvidence: "deterministic-offline-fixture-not-live-validation",
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "payment-response": base64Json({
            success: true,
            transaction: signedHash,
            network: "xrpl:1",
            payer: payer.classicAddress,
            evidenceSource: "deterministic-offline-fixture",
          }),
        },
      }),
    },
    reconciler: {
      reconcile: async (expectation) => ({
        status: "validated",
        budgetDisposition: "commit",
        evidence: {
          provenance: {
            kind: "fixture",
            evidenceSource: "deterministic-offline-ledger-fixture",
            sourceId: "issued-server-construction-test",
            notice: "OFFLINE FIXTURE ONLY. This is not live XRPL validated-ledger evidence.",
          },
          transactionHash: expectation.transactionHash,
          network: "xrpl:1",
          merchantInvoiceId: expectation.merchantInvoiceId,
          ledgerIndex: 1_001,
          transactionResult: "tesSUCCESS",
          deliveredAmount: {
            currency: expectation.asset.currency,
            issuer: expectation.asset.issuer,
            value: expectation.amount,
          },
        },
      }),
    },
  };
  return {
    adapter,
    requestBody: {
      owner: payer.classicAddress,
      network: "testnet",
      resource: "compare",
      session_scope: SESSION_SCOPE,
      merchant: {
        id: MERCHANT_ID,
        resource_method: "POST",
        resource_url: RESOURCE_URL,
      },
      asset: policy.asset,
      max_amount: "0.01",
      pay_to: payee.classicAddress,
      idempotency_key: "issued-server-request-001",
    },
    calls: { prepare, sign },
  };
}

const unusedNativeService = (): X402Service => ({
  pay: vi.fn(async () => { throw new Error("native xrp path must remain unused"); }),
});

describe("local issued x402 fixture server construction", () => {
  it("fails closed before exposing the service when bootstrap recovery fails", async () => {
    const db = new SqliteD1();
    const { adapter } = fixtureAdapter();
    const base = profileEnv(db, adapter);
    const failingDb = new Proxy(base.DB, {
      get(target, property, receiver) {
        if (property !== "prepare") return Reflect.get(target, property, receiver);
        return (sql: string) => {
          if (sql.includes("FROM issued_x402_journal")) {
            throw new Error("fixture bootstrap recovery failed");
          }
          return target.prepare(sql);
        };
      },
    });
    await expect(createLocalIssuedX402FixtureService({
      ...base,
      DB: failingDb,
    })).rejects.toThrow("fixture bootstrap recovery failed");
    db.close();
  });

  it("constructs and runs the real D1-backed issued service only from the exact issued profile", async () => {
    const db = new SqliteD1();
    try {
      const fixture = fixtureAdapter();
      const env = profileEnv(db, fixture.adapter);
      expect(isLocalX402IssuedFixtureEnvironment(env)).toBe(true);
      const response = await createWorker(
        new OpRegistry(issuedOps),
        unusedNativeService,
      ).fetch!(request(fixture.requestBody), env, {} as ExecutionContext);
      expect(response.status).toBe(200);
      const responseBody = await response.json();
      expect(responseBody).toMatchObject({
        ok: true,
        data: {
          status: "fixture_delivered",
          evidence: "deterministic-offline-fixture",
          session_scope: SESSION_SCOPE,
          merchant_invoice_id: "merchant-invoice-issued-001",
          idempotency_key: "issued-server-request-001",
          validated_ledger_index: 1_001,
        },
      });
      expect(fixture.calls.prepare).toHaveBeenCalledOnce();
      expect(fixture.calls.sign).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it("cannot be enabled by the native-XRP flags or by a partial issued profile", async () => {
    const db = new SqliteD1();
    try {
      const fixture = fixtureAdapter();
      const nativeOnly: Env = {
        DB: db as unknown as D1Database,
        HARBOR_API_KEYS: `issued-owner:${TOKEN}`,
        EXEC_NETWORK: "testnet",
        EXECUTOR: "quickjs",
        MAINNET_EXECUTION: "false",
        HARBOR_LOCAL_DEV: "true",
        HARBOR_LOCAL_READ_ONLY: "true",
        HARBOR_LOCAL_AUTH_REQUIRED: "true",
        HARBOR_LOCAL_CRON_DISABLED: "true",
        HARBOR_LOCAL_X402: "true",
        HARBOR_LOCAL_X402_RUNTIME_ENABLED: "true",
        HARBOR_LOCAL_X402_SIGNING_PROFILE: "reviewed-testnet-local-v1",
        HARBOR_LOCAL_X402_ISSUED_RUNTIME_ADAPTER: fixture.adapter,
      };
      expect(isLocalX402IssuedFixtureEnvironment(nativeOnly)).toBe(false);
      const nativeResponse = await createWorker(
        new OpRegistry(issuedOps),
        unusedNativeService,
      ).fetch!(request(fixture.requestBody), nativeOnly, {} as ExecutionContext);
      expect(nativeResponse.status).toBe(200);
      await expect(nativeResponse.json()).resolves.toMatchObject({
        ok: false,
        error: { code: "LOCAL_X402_OPERATION_DISABLED" },
      });
      expect(fixture.calls.prepare).not.toHaveBeenCalled();

      const partial = profileEnv(db, fixture.adapter);
      partial.HARBOR_LOCAL_X402_ISSUED_FIXTURE_PROFILE = undefined;
      expect(isLocalX402IssuedFixtureEnvironment(partial)).toBe(false);
      const partialResponse = await createWorker(
        new OpRegistry(issuedOps),
        unusedNativeService,
      ).fetch!(request(fixture.requestBody), partial, {} as ExecutionContext);
      expect(partialResponse.status).toBe(200);
      await expect(partialResponse.json()).resolves.toMatchObject({
        ok: false,
        error: { code: "OPERATION_FAILED" },
      });
      expect(fixture.calls.prepare).not.toHaveBeenCalled();

      const mixed = {
        ...profileEnv(db, fixture.adapter),
        HARBOR_LOCAL_X402: "true",
      };
      expect(isLocalX402IssuedFixtureEnvironment(mixed)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("keeps an exact issued profile fail-closed when owner-sign orchestration is absent", async () => {
    const db = new SqliteD1();
    try {
      const fixture = fixtureAdapter();
      const response = await createWorker(
        new OpRegistry(issuedOps),
        unusedNativeService,
      ).fetch!(request(fixture.requestBody), profileEnv(db), {} as ExecutionContext);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: { code: "OPERATION_FAILED" },
      });
      expect(fixture.calls.prepare).not.toHaveBeenCalled();
      expect(fixture.calls.sign).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});
