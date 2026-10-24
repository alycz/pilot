import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import {
  decode,
  deriveAddress,
  encode,
  encodeForSigning,
  verifyKeypairSignature,
} from "xrpl";
import { describe, expect, it, vi } from "vitest";

import type { OpContext } from "../src/catalog/registry";
import type { EventInsert, EventRow, LinkRow, Store } from "../src/exec/store";
import {
  SubmitValidationError,
  signedTransactionHash,
  validateApprovedBlob,
} from "../src/exec/submit";
import { handleTxSubmit, type ExecutionServices } from "../src/ops/tx-exec";

import delegateGrant from "./fixtures/ledger/delegate-set-grant.json";
import delegateRevoke from "./fixtures/ledger/delegate-set-revoke.json";
import offerCreate from "./fixtures/ledger/offer-create.json";
import trustSet from "./fixtures/ledger/trust-set.json";

const APPROVAL = {
  expiresAt: "2099-01-01T00:00:00.000Z",
  status: "pending" as const,
};

const fixtures = [trustSet, delegateGrant, delegateRevoke, offerCreate] as const;

type SqlValue = string | number | bigint | null | Uint8Array;

class SequenceDatabaseStatement {
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

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }
}

class SequenceDatabase {
  private readonly sqlite = new DatabaseSync(":memory:");

  constructor() {
    this.sqlite.exec(readFileSync(
      new URL("../migrations/0011_autonomous_strategies.sql", import.meta.url),
      "utf8",
    ));
  }

  prepare(sql: string): SequenceDatabaseStatement {
    return new SequenceDatabaseStatement(this.sqlite.prepare(sql));
  }
}

function decodedSingleSignature(txBlob: string) {
  const decoded = decode(txBlob) as Record<string, unknown>;
  expect(decoded.SigningPubKey).toEqual(expect.any(String));
  expect(decoded.TxnSignature).toEqual(expect.any(String));
  return decoded as Record<string, unknown> & {
    Account: string;
    SigningPubKey: string;
    TxnSignature: string;
  };
}

function fixtureSignatureIsValid(txBlob: string): boolean {
  const transaction = decodedSingleSignature(txBlob);
  return (
    deriveAddress(transaction.SigningPubKey) === transaction.Account &&
    verifyKeypairSignature(
      encodeForSigning(transaction),
      transaction.TxnSignature,
      transaction.SigningPubKey,
    )
  );
}

describe("Ledger XRP app compatibility fixtures", () => {
  it.each(fixtures)("accepts the Ledger-signed $name blob for its stored transaction", (fixture) => {
    expect(fixture.source).toBe("Ledger XRP app 2.8.2 via Speculos");
    expect(fixture.derivation_path).toBe("44'/144'/0'/0/0");
    expect(fixture.seed).toBe("Speculos public default test seed");
    expect(fixtureSignatureIsValid(fixture.tx_blob)).toBe(true);
    expect(signedTransactionHash(fixture.tx_blob)).toBe(fixture.hash);

    expect(
      validateApprovedBlob(fixture.tx_blob, {
        ...APPROVAL,
        txJson: fixture.tx_json,
      }),
    ).toMatchObject(fixture.tx_json);
  });

  it("rejects a Ledger blob whose protected Fee field is changed", () => {
    const decoded = decodedSingleSignature(trustSet.tx_blob);
    const tamperedBlob = encode({ ...decoded, Fee: "13" });

    expect(() =>
      validateApprovedBlob(tamperedBlob, {
        ...APPROVAL,
        txJson: trustSet.tx_json,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<SubmitValidationError>>({
        code: "APPROVAL_TRANSACTION_MISMATCH",
      }),
    );
    expect(fixtureSignatureIsValid(tamperedBlob)).toBe(false);
  });
});

function permissionNames(transaction: Record<string, unknown>): string[] {
  const entries = transaction.Permissions;
  if (!Array.isArray(entries)) {
    throw new Error("fixture Permissions must be an array");
  }
  return entries.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { Permission?: unknown }).Permission !== "object" ||
      (entry as { Permission: object }).Permission === null
    ) {
      throw new Error("fixture Permission entry is malformed");
    }
    const value = (entry as { Permission: { PermissionValue?: unknown } }).Permission
      .PermissionValue;
    if (typeof value !== "string") {
      throw new Error("fixture PermissionValue must decode to a name");
    }
    return value;
  });
}

function directSubmissionHarness(
  fixture: typeof delegateGrant | typeof delegateRevoke,
  status: "pending" | "suspended",
) {
  const transaction = decodedSingleSignature(fixture.tx_blob);
  const owner = transaction.Account;
  const delegate = transaction.Authorize;
  if (typeof delegate !== "string") throw new Error("fixture Authorize is missing");
  const permissions =
    status === "pending"
      ? permissionNames(transaction)
      : permissionNames(decodedSingleSignature(delegateGrant.tx_blob));
  const link: LinkRow = {
    id: `ledger-${status}`,
    principal: "ledger-compat-test",
    owner,
    network: "testnet",
    delegate,
    delegateSeedEnc: new Uint8Array([1]).buffer,
    iv: new Uint8Array([2]).buffer,
    permissions,
    status,
    lastLedger: null,
    revokeTx: null,
    createdAt: "2026-10-21T00:00:00.000Z",
  };
  const events = new Map<string, EventRow>();
  const store = {
    getLink: vi.fn(async (candidateOwner: string, network: string) =>
      candidateOwner === owner && network === "testnet" ? link : null,
    ),
    getEvent: vi.fn(async (id: string) => events.get(id) ?? null),
    insertEvent: vi.fn(async (input: EventInsert) => {
      const row = { ...input, principal: link.principal } as EventRow;
      events.set(input.id, row);
      return row;
    }),
    findExecutionByHash: vi.fn(async () => null),
    getBuild: vi.fn(async () => null),
  } as unknown as Store;
  const submitSigned = vi.fn(async () => ({
    hash: fixture.hash,
    ledger_index: 99_999_951,
    engine_result: "tesSUCCESS",
    validated: true as const,
  }));
  const services = {
    store,
    submitSigned,
    now: () => new Date("2026-10-21T00:00:00.000Z"),
  } satisfies ExecutionServices;
  const ctx = {
    principal: link.principal,
    env: { EXEC_NETWORK: "testnet" },
    db: new SequenceDatabase() as unknown as D1Database,
    xrplRpc: {
      request: vi.fn(async (_network: string, command: string) => {
        if (command === "ledger") {
          return { validated: true, ledger_index: 99_999_950 };
        }
        if (command === "account_info") {
          return {
            validated: true,
            ledger_index: 99_999_950,
            account_data: { Account: owner, Flags: 0 },
          };
        }
        throw new Error(`unexpected XRPL command ${command}`);
      }),
    },
    executionServices: services,
  } as OpContext;
  return { ctx, events, link, submitSigned };
}

describe("Ledger-signed account link relay", () => {
  it.each([
    ["grant", delegateGrant, "pending"],
    ["revoke", delegateRevoke, "suspended"],
  ] as const)("accepts the Ledger-signed DelegateSet %s", async (_name, fixture, status) => {
    const { ctx, events, link, submitSigned } = directSubmissionHarness(fixture, status);

    await expect(
      handleTxSubmit(ctx, { tx_blob: fixture.tx_blob, network: "testnet" }),
    ).resolves.toMatchObject({
      hash: fixture.hash,
      validated: true,
    });
    expect(submitSigned).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx,
        network: "testnet",
        txBlob: fixture.tx_blob,
      }),
    );
    expect([...events.values()]).toEqual([
      expect.objectContaining({
        owner: link.owner,
        kind: "direct_owner_submission",
        detail: { hash: fixture.hash, network: "testnet" },
      }),
    ]);
  });
});
