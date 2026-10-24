import { describe, expect, it } from "vitest";

import { readQuickNodeWebhookEvidence } from "../src/quicknode/webhook";

const HASH = "AB".repeat(32);
const ACCOUNT = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const PRINCIPAL = "principal-alpha";

type EvidenceRow = {
  tx_hash: string;
  account: string;
  delegate: string | null;
  tx_type: string;
  result: string;
  ledger_index: number;
  received_at: string;
  execution_id: string;
  execution_created_at: string;
  confirmed_by: string;
  confirmed_at: string;
};

function database(
  owner: string,
  rows: EvidenceRow[],
  observedSql: string[],
  observedBindings: unknown[] = [],
): D1Database {
  return {
    prepare(sql: string) {
      observedSql.push(sql);
      return {
        bind(...values: unknown[]) {
          observedBindings.push(...values);
          return this;
        },
        async all<T>() {
          const requestedPrincipal = observedBindings.at(-2);
          const requestedHash = observedBindings.at(-1);
          const results = requestedPrincipal === owner && requestedHash === HASH ? rows : [];
          return { success: true, results: results as T[], meta: {} } as D1Result<T>;
        },
      };
    },
  } as unknown as D1Database;
}

function row(overrides: Partial<EvidenceRow> = {}): EvidenceRow {
  return {
    tx_hash: HASH,
    account: ACCOUNT,
    delegate: null,
    tx_type: "Payment",
    result: "tesSUCCESS",
    ledger_index: 123,
    received_at: "2026-10-22T00:00:01.000Z",
    execution_id: "execution-fixture",
    execution_created_at: "2026-10-22T00:00:00.250Z",
    confirmed_by: "quicknode-webhook",
    confirmed_at: "2026-10-22T00:00:09.000Z",
    ...overrides,
  };
}

describe("QuickNode webhook evidence", () => {
  it("returns only the strict fixed-field projection bound to webhook confirmation", async () => {
    const sql: string[] = [];
    const bindings: unknown[] = [];
    await expect(readQuickNodeWebhookEvidence(
      database(PRINCIPAL, [row()], sql, bindings),
      PRINCIPAL,
      HASH.toLowerCase(),
    ))
      .resolves.toEqual({
        hash: HASH,
        account: ACCOUNT,
        tx_type: "Payment",
        result: "tesSUCCESS",
        ledger_index: 123,
        received_at: "2026-10-22T00:00:01.000Z",
        execution: {
          id: "execution-fixture",
          confirmed_by: "quicknode-webhook",
          confirmed_at: "2026-10-22T00:00:09.000Z",
          latency_ms: 750,
        },
      });
    expect(sql).toHaveLength(1);
    expect(sql[0]).not.toContain("raw_json");
    expect(sql[0]).toContain("execution.principal = ?");
    expect(sql[0]).toContain("execution.confirmed_by = 'quicknode-webhook'");
    expect(bindings).toEqual([PRINCIPAL, HASH]);
  });

  it("fails closed across principals and for absent, ambiguous, or noncanonical evidence", async () => {
    await expect(readQuickNodeWebhookEvidence(database(PRINCIPAL, [row()], []), "principal-beta", HASH))
      .rejects.toThrow("QN_WEBHOOK_EVIDENCE_NOT_FOUND");
    await expect(readQuickNodeWebhookEvidence(database(PRINCIPAL, [], []), PRINCIPAL, HASH))
      .rejects.toThrow("QN_WEBHOOK_EVIDENCE_NOT_FOUND");
    await expect(readQuickNodeWebhookEvidence(
      database(PRINCIPAL, [row(), row({ execution_id: "other" })], []),
      PRINCIPAL,
      HASH,
    ))
      .rejects.toThrow("QN_WEBHOOK_EVIDENCE_AMBIGUOUS");
    await expect(readQuickNodeWebhookEvidence(
      database(PRINCIPAL, [row({ confirmed_by: "poll" })], []),
      PRINCIPAL,
      HASH,
    ))
      .rejects.toThrow();
  });
});
