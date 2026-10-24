import {
  DEFAULT_POLICY,
  EnvelopeSchema,
  type ExecResult,
  type TxBuild,
} from "@pilot/contracts";
import { describe, expect, it } from "vitest";

import builderFixtures from "../fixtures/builders.json";
import readFixtures from "../fixtures/reads.json";
import {
  HarborArgsSchemas,
  HarborResultSchemas,
  createMockHarborClient,
  type ArgsFor,
  type HarborOpName,
} from "../src/index.js";

const ACCOUNT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const DESTINATION = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const CHECK_ID = "B".repeat(64);
const CONDITION =
  "A0258020E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855810100";
const FULFILLMENT = "A0028000";
const INVOICE_ID = "C".repeat(64);

const nativeCases = [
  {
    name: "tx.escrowCreate",
    transactionType: "EscrowCreate",
    delegable: false,
    feeDrops: "12",
    reserveDeltaDrops: "2000000",
    args: {
      network: "testnet",
      account: ACCOUNT,
      destination: DESTINATION,
      amount: "1000000",
      finish_after: 900_000_000,
      cancel_after: 900_000_600,
      destination_tag: 7,
      intent_id: "native-escrow-create",
    },
    expected: {
      Destination: DESTINATION,
      Amount: "1000000",
      FinishAfter: 900_000_000,
      CancelAfter: 900_000_600,
      DestinationTag: 7,
    },
  },
  {
    name: "tx.escrowFinish",
    transactionType: "EscrowFinish",
    delegable: true,
    feeDrops: "399",
    reserveDeltaDrops: "0",
    args: {
      network: "testnet",
      account: ACCOUNT,
      owner: DESTINATION,
      offer_sequence: 7,
      condition: CONDITION,
      fulfillment: FULFILLMENT,
      intent_id: "native-escrow-finish",
    },
    expected: {
      Owner: DESTINATION,
      OfferSequence: 7,
      Condition: CONDITION,
      Fulfillment: FULFILLMENT,
    },
  },
  {
    name: "tx.escrowCancel",
    transactionType: "EscrowCancel",
    delegable: false,
    feeDrops: "12",
    reserveDeltaDrops: "0",
    args: {
      network: "testnet",
      account: ACCOUNT,
      owner: DESTINATION,
      offer_sequence: 7,
      intent_id: "native-escrow-cancel",
    },
    expected: { Owner: DESTINATION, OfferSequence: 7 },
  },
  {
    name: "tx.checkCreate",
    transactionType: "CheckCreate",
    delegable: false,
    feeDrops: "12",
    reserveDeltaDrops: "2000000",
    args: {
      network: "testnet",
      account: ACCOUNT,
      destination: DESTINATION,
      send_max: "2000000",
      destination_tag: 11,
      expiration: 900_000_600,
      invoice_id: INVOICE_ID,
      intent_id: "native-check-create",
    },
    expected: {
      Destination: DESTINATION,
      SendMax: "2000000",
      DestinationTag: 11,
      Expiration: 900_000_600,
      InvoiceID: INVOICE_ID,
    },
  },
  {
    name: "tx.checkCash",
    transactionType: "CheckCash",
    delegable: true,
    feeDrops: "12",
    reserveDeltaDrops: "0",
    args: {
      network: "testnet",
      account: ACCOUNT,
      check_id: CHECK_ID,
      amount: "1500000",
      intent_id: "native-check-cash",
    },
    expected: { CheckID: CHECK_ID, Amount: "1500000" },
  },
  {
    name: "tx.checkCancel",
    transactionType: "CheckCancel",
    delegable: false,
    feeDrops: "12",
    reserveDeltaDrops: "0",
    args: {
      network: "testnet",
      account: ACCOUNT,
      check_id: CHECK_ID,
      intent_id: "native-check-cancel",
    },
    expected: { CheckID: CHECK_ID },
  },
] as const satisfies ReadonlyArray<{
  name: HarborOpName;
  transactionType: string;
  delegable: boolean;
  feeDrops: string;
  reserveDeltaDrops: string;
  args: Record<string, unknown>;
  expected: Record<string, unknown>;
}>;

function data<T>(envelope: { ok: boolean; data?: T }): T {
  expect(envelope.ok).toBe(true);
  if (!envelope.ok || envelope.data === undefined) throw new Error("expected success");
  return envelope.data;
}

function hasSecretMaterial(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSecretMaterial);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, child]) =>
      /seed|secret|private|mnemonic|TxnSignature|SigningPubKey|Signers/i.test(key) ||
      hasSecretMaterial(child),
  );
}

describe("native Escrow and Check schemas", () => {
  it.each(nativeCases)("accepts strict $name arguments on every build network", ({ name, args }) => {
    const schema = HarborArgsSchemas[name];
    for (const network of ["testnet", "devnet", "lending-devnet"]) {
      expect(schema.safeParse({ ...args, network }).success, `${name} ${network}`).toBe(true);
    }
    expect(schema.safeParse({ ...args, network: "mainnet" }).success).toBe(false);
    expect(schema.safeParse({ ...args, Memos: [] }).success).toBe(false);
    expect(schema.safeParse({ ...args, provider_payload: "untrusted" }).success).toBe(false);
    expect(schema.safeParse({ ...args, execution_contract: "xrpl_execution_v1" }).success).toBe(false);
  });

  it("enforces escrow timing and condition pairs", () => {
    const create = HarborArgsSchemas["tx.escrowCreate"];
    const base = { network: "testnet", account: ACCOUNT, destination: DESTINATION, amount: "1" };
    expect(create.safeParse(base).success).toBe(false);
    expect(create.safeParse({ ...base, finish_after: 5 }).success).toBe(true);
    expect(create.safeParse({ ...base, cancel_after: 5 }).success).toBe(false);
    expect(create.safeParse({ ...base, condition: CONDITION }).success).toBe(false);
    expect(create.safeParse({ ...base, condition: CONDITION, cancel_after: 5 }).success).toBe(true);
    expect(create.safeParse({ ...base, finish_after: 5, cancel_after: 5 }).success).toBe(false);

    const finish = HarborArgsSchemas["tx.escrowFinish"];
    const finishBase = {
      network: "testnet",
      account: ACCOUNT,
      owner: DESTINATION,
      offer_sequence: 1,
    };
    expect(finish.safeParse(finishBase).success).toBe(true);
    expect(finish.safeParse({ ...finishBase, condition: CONDITION }).success).toBe(false);
    expect(finish.safeParse({ ...finishBase, fulfillment: FULFILLMENT }).success).toBe(false);
  });

  it("enforces Check identities, XOR cash mode, UInt32, hashes, blobs, and amount bounds", () => {
    expect(HarborArgsSchemas["tx.checkCreate"].safeParse({
      network: "testnet",
      account: ACCOUNT,
      destination: ACCOUNT,
      send_max: "1",
    }).success).toBe(false);

    const cashBase = { network: "testnet", account: ACCOUNT, check_id: CHECK_ID };
    expect(HarborArgsSchemas["tx.checkCash"].safeParse(cashBase).success).toBe(false);
    expect(HarborArgsSchemas["tx.checkCash"].safeParse({
      ...cashBase,
      amount: "1",
      deliver_min: "1",
    }).success).toBe(false);
    expect(HarborArgsSchemas["tx.checkCash"].safeParse({
      ...cashBase,
      deliver_min: "1",
    }).success).toBe(true);
    expect(HarborArgsSchemas["tx.checkCancel"].safeParse({
      ...cashBase,
      check_id: "0".repeat(64),
    }).success).toBe(false);
    expect(HarborArgsSchemas["tx.checkCancel"].safeParse({
      ...cashBase,
      check_id: "G".repeat(64),
    }).success).toBe(false);

    const finishBase = {
      network: "testnet",
      account: ACCOUNT,
      owner: DESTINATION,
      offer_sequence: 1,
    };
    for (const invalid of [0, -1, 1.5, 0x1_0000_0000]) {
      expect(HarborArgsSchemas["tx.escrowFinish"].safeParse({
        ...finishBase,
        offer_sequence: invalid,
      }).success).toBe(false);
    }
    for (const condition of ["", "A", "GG", "AA".repeat(1025)]) {
      expect(HarborArgsSchemas["tx.escrowFinish"].safeParse({
        ...finishBase,
        condition,
        fulfillment: FULFILLMENT,
      }).success).toBe(false);
    }
    expect(HarborArgsSchemas["tx.checkCash"].safeParse({
      ...cashBase,
      amount: { currency: "USD", issuer: DESTINATION, value: "12345678901234567" },
    }).success).toBe(false);
    expect(HarborArgsSchemas["tx.checkCash"].safeParse({
      ...cashBase,
      amount: { currency: "USD", issuer: DESTINATION, value: "1e81" },
    }).success).toBe(false);
    expect(HarborArgsSchemas["tx.checkCash"].safeParse({
      ...cashBase,
      amount: { currency: "USD", issuer: DESTINATION, value: "1e-96" },
    }).success).toBe(true);
    expect(HarborArgsSchemas["tx.checkCash"].safeParse({
      ...cashBase,
      amount: { currency: "USD", issuer: DESTINATION, value: "1e-97" },
    }).success).toBe(false);
    expect(HarborArgsSchemas["tx.checkCash"].safeParse({
      ...cashBase,
      amount: { currency: "USD", issuer: DESTINATION, value: "0" },
    }).success).toBe(false);
    expect(HarborArgsSchemas["tx.checkCancel"].safeParse({
      ...cashBase,
      intent_id: "i".repeat(128),
    }).success).toBe(true);
    expect(HarborArgsSchemas["tx.checkCancel"].safeParse({
      ...cashBase,
      intent_id: "i".repeat(129),
    }).success).toBe(false);
  });
});

describe("native builder fixtures and mock execution", () => {
  it.each(nativeCases)("parses and dynamically builds $name", async (testCase) => {
    const fixture = builderFixtures[testCase.name as keyof typeof builderFixtures];
    EnvelopeSchema(HarborResultSchemas[testCase.name]).parse(fixture);
    expect(fixture.data.simulate).toEqual({
      engine_result: "tesSUCCESS",
      engine_result_message: "The simulated transaction would succeed.",
      applied: false,
    });
    expect(fixture.data.network).toBe("testnet");
    expect(fixture.data.tx_json).toMatchObject({
      TransactionType: testCase.transactionType,
      ...testCase.expected,
      Fee: testCase.feeDrops,
    });
    expect(fixture.data.delegable).toBe(testCase.delegable);
    expect(fixture.data.summary.reserve_delta_drops).toBe(testCase.reserveDeltaDrops);
    expect(hasSecretMaterial(fixture.data)).toBe(false);

    const client = createMockHarborClient();
    const build = data<TxBuild>(await client.op(testCase.name, testCase.args as never));
    expect(build.tx_json).toMatchObject({
      TransactionType: testCase.transactionType,
      Account: ACCOUNT,
      ...testCase.expected,
    });
    expect(build.delegable).toBe(testCase.delegable);
    expect(build.simulate.applied).toBe(false);
    expect(hasSecretMaterial(build)).toBe(false);
  });

  it("maps native builds through executed, needs_approval, and blocked decisions", async () => {
    const client = createMockHarborClient();
    const finish = data<TxBuild>(await client.op(
      "tx.escrowFinish",
      nativeCases[1].args as ArgsFor<"tx.escrowFinish">,
    ));
    const executed = data<ExecResult>(await client.op("tx.execute", {
      build_id: finish.build_id,
      idempotency_key: "native-executed",
    }));
    expect(executed.status).toBe("executed");

    const create = data<TxBuild>(await client.op(
      "tx.escrowCreate",
      nativeCases[0].args as ArgsFor<"tx.escrowCreate">,
    ));
    const approval = data<ExecResult>(await client.op("tx.execute", {
      build_id: create.build_id,
      idempotency_key: "native-needs-approval",
    }));
    expect(approval.status).toBe("needs_approval");

    const expensive = data<TxBuild>(await client.op("tx.checkCash", {
      network: "testnet",
      account: ACCOUNT,
      check_id: CHECK_ID,
      amount: "4000000000",
    }));
    const blocked = data<ExecResult>(await client.op("tx.execute", {
      build_id: expensive.build_id,
      idempotency_key: "native-blocked",
    }));
    expect(blocked.status).toBe("blocked");
  });

  it("requires an active exact permission and custom policy before a cancel is delegable", async () => {
    const client = createMockHarborClient();
    data(await client.op("account.link", {
      owner: ACCOUNT,
      network: "testnet",
      permissions: ["EscrowCancel"],
    }));
    data(await client.op("account.status", { owner: ACCOUNT, network: "testnet" }));
    data(await client.op("policy.set", {
      owner: ACCOUNT,
      network: "testnet",
      policy: {
        ...DEFAULT_POLICY,
        allowed_tx_types: [...DEFAULT_POLICY.allowed_tx_types, "EscrowCancel"],
      },
    }));

    const cancel = data<TxBuild>(await client.op("tx.escrowCancel", {
      network: "testnet",
      account: ACCOUNT,
      owner: DESTINATION,
      offer_sequence: 7,
    }));
    expect(cancel.delegable).toBe(true);
    const result = data<ExecResult>(await client.op("tx.execute", {
      build_id: cancel.build_id,
      idempotency_key: "native-explicit-cancel",
    }));
    expect(result.status).toBe("executed");
  });

  it("fails closed for missing, pending, or suspended links and routes revoked links to approval", async () => {
    const missingClient = createMockHarborClient();
    const missing = data<TxBuild>(await missingClient.op("tx.escrowFinish", {
      ...nativeCases[1].args,
      account: DESTINATION,
    } as ArgsFor<"tx.escrowFinish">));
    expect(missing.delegable).toBe(false);
    const missingExecution = data<ExecResult>(await missingClient.op("tx.execute", {
      build_id: missing.build_id,
      idempotency_key: "native-missing-link",
    }));
    expect(missingExecution.status).toBe("blocked");

    const pendingClient = createMockHarborClient();
    data(await pendingClient.op("account.link", {
      owner: ACCOUNT,
      network: "testnet",
      permissions: ["EscrowFinish"],
    }));
    const pending = data<TxBuild>(await pendingClient.op(
      "tx.escrowFinish",
      nativeCases[1].args as ArgsFor<"tx.escrowFinish">,
    ));
    expect(pending.delegable).toBe(false);
    const pendingExecution = data<ExecResult>(await pendingClient.op("tx.execute", {
      build_id: pending.build_id,
      idempotency_key: "native-pending-link",
    }));
    expect(pendingExecution.status).toBe("blocked");

    const linkFixture = readFixtures["account.status"].data;
    const originalStatus = linkFixture.status;
    try {
      linkFixture.status = "suspended";
      const suspendedClient = createMockHarborClient();
      const suspendedExecution = data<ExecResult>(await suspendedClient.op("tx.execute", {
        build_id: "build-escrow-finish-001",
        idempotency_key: "native-suspended-link",
      }));
      expect(suspendedExecution.status).toBe("blocked");
    } finally {
      linkFixture.status = originalStatus;
    }

    const revokedClient = createMockHarborClient();
    data(await revokedClient.op("account.revoke", { owner: ACCOUNT, network: "testnet" }));
    const revoked = data<TxBuild>(await revokedClient.op(
      "tx.escrowFinish",
      nativeCases[1].args as ArgsFor<"tx.escrowFinish">,
    ));
    expect(revoked.delegable).toBe(false);
    const rehydrated = data<ExecResult>(await revokedClient.op("tx.execute", {
      build_id: "build-escrow-finish-001",
      idempotency_key: "native-rehydrated-revoked",
    }));
    expect(rehydrated.status).toBe("needs_approval");
  });

  it("omits an intent memo when the caller did not provide an intent id", async () => {
    const client = createMockHarborClient();
    const build = data<TxBuild>(await client.op("tx.checkCancel", {
      network: "testnet",
      account: ACCOUNT,
      check_id: CHECK_ID,
    }));
    expect(build.tx_json).not.toHaveProperty("Memos");
  });

  it("keeps conditioned and unconditioned EscrowFinish fees aligned with the summary", async () => {
    const client = createMockHarborClient();
    const conditioned = data<TxBuild>(await client.op(
      "tx.escrowFinish",
      nativeCases[1].args as ArgsFor<"tx.escrowFinish">,
    ));
    const unconditioned = data<TxBuild>(await client.op("tx.escrowFinish", {
      network: "testnet",
      account: ACCOUNT,
      owner: DESTINATION,
      offer_sequence: 7,
    }));
    expect(conditioned.tx_json.Fee).toBe("399");
    expect(conditioned.summary.fee_drops).toBe("399");
    expect(unconditioned.tx_json.Fee).toBe("12");
    expect(unconditioned.summary.fee_drops).toBe("12");
  });

  it("never delegates a rehydrated create build even with malicious stale fixtures", async () => {
    const createFixture = builderFixtures["tx.escrowCreate"].data;
    const linkFixture = readFixtures["account.status"].data;
    const policyFixture = readFixtures["policy.get"].data;
    const originalDelegable = createFixture.delegable;
    const originalPermissions = [...linkFixture.permissions];
    const originalAllowedTypes = [...policyFixture.allowed_tx_types];
    try {
      createFixture.delegable = true;
      linkFixture.permissions = [...originalPermissions, "EscrowCreate"];
      policyFixture.allowed_tx_types = [...originalAllowedTypes, "EscrowCreate"];
      const client = createMockHarborClient();
      const result = data<ExecResult>(await client.op("tx.execute", {
        build_id: "build-escrow-create-001",
        idempotency_key: "native-malicious-rehydration",
      }));
      expect(result.status).toBe("needs_approval");
    } finally {
      createFixture.delegable = originalDelegable;
      linkFixture.permissions = originalPermissions;
      policyFixture.allowed_tx_types = originalAllowedTypes;
    }
  });
});

describe("lending.brokers strict read contract", () => {
  it("accepts only bounded Lending-Devnet arguments", () => {
    const schema = HarborArgsSchemas["lending.brokers"];
    expect(schema.safeParse({ network: "lending-devnet", limit: 1, marker: "next" }).success).toBe(true);
    for (const network of ["mainnet", "testnet", "devnet"]) {
      expect(schema.safeParse({ network }).success).toBe(false);
    }
    expect(schema.safeParse({ network: "lending-devnet", limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ network: "lending-devnet", limit: 257 }).success).toBe(false);
    expect(schema.safeParse({ network: "lending-devnet", marker: "" }).success).toBe(false);
    expect(schema.safeParse({ network: "lending-devnet", marker: "m".repeat(256) }).success).toBe(true);
    expect(schema.safeParse({ network: "lending-devnet", marker: "m".repeat(257) }).success).toBe(false);
    expect(schema.safeParse({ network: "lending-devnet", limit: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ network: "lending-devnet", extra: true }).success).toBe(false);
  });

  it("parses the fixture and rejects third-party fields or malformed ledger data", () => {
    const fixture = readFixtures["lending.brokers"];
    EnvelopeSchema(HarborResultSchemas["lending.brokers"]).parse(fixture);
    const result = fixture.data;
    expect(() => HarborResultSchemas["lending.brokers"].parse({
      ...result,
      validated: false,
    })).toThrow();
    expect(() => HarborResultSchemas["lending.brokers"].parse({
      ...result,
      brokers: [{ ...result.brokers[0], provider_text: "untrusted" }],
    })).toThrow();
    expect(() => HarborResultSchemas["lending.brokers"].parse({
      ...result,
      brokers: [{ ...result.brokers[0], LedgerEntryType: "Vault" }],
    })).toThrow();
    expect(() => HarborResultSchemas["lending.brokers"].parse({
      ...result,
      ledger_hash: "not-a-hash",
    })).toThrow();
    expect(() => HarborResultSchemas["lending.brokers"].parse({
      ...result,
      brokers: [{ ...result.brokers[0], Account: "not-an-account", Data: "GG" }],
    })).toThrow();
  });
});
