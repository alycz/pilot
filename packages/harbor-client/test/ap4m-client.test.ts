import {
  Ap4mReceiptSchema,
  EnvelopeSchema,
  MandateSchema,
  MerchantSchema,
} from "@pilot/contracts";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  createHarborMcpClient,
  createHarborRestClient,
} from "../src/index.js";

type UntypedOp = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

const OWNER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const MANDATE_ID = "mandate-demo-001";
const MERCHANT_ID = "venue-yield-desk";
const CHANNEL_ID =
  "D100000000000000000000000000000000000000000000000000000000000001";

const operations = [
  { name: "merchants.list", args: {} },
  { name: "merchants.get", args: { id: MERCHANT_ID } },
  {
    name: "mandate.prepare",
    args: {
      owner: OWNER,
      network: "testnet",
      constraints: {
        currency: "USD",
        per_payment_max: "5",
        total_max: "25",
        daily_max: "10",
        payees: [MERCHANT_ID, "risk-oracle"],
        skus: ["yield-report", "risk-score"],
      },
      payees: [MERCHANT_ID, "risk-oracle"],
      expires_at: "2026-10-22T00:00:00.000Z",
    },
  },
  {
    name: "mandate.register",
    args: {
      mandate_id: MANDATE_ID,
      l1: "header.payload.signature",
      l2: "header.payload.signature",
      setup_tx_hash:
        "A100000000000000000000000000000000000000000000000000000000000001",
    },
  },
  { name: "mandate.status", args: { mandate_id: MANDATE_ID } },
  { name: "mandate.revoke", args: { mandate_id: MANDATE_ID } },
  { name: "credential.status", args: { account: OWNER } },
  { name: "credential.payerAccept", args: {} },
  { name: "credential.ids", args: { account: OWNER } },
  {
    name: "ap4m.purchase",
    args: {
      mandate_id: MANDATE_ID,
      merchant_id: MERCHANT_ID,
      sku: "yield-report",
      idempotency_key: "purchase-demo-001",
    },
  },
  { name: "channel.status", args: { channel_id: CHANNEL_ID } },
  { name: "channel.list", args: { mandate_id: MANDATE_ID } },
  { name: "mastercard.services", args: {} },
  { name: "mastercard.docs", args: { service_id: "open-finance-us" } },
  { name: "mastercard.page", args: { path: "/open-finance-us" } },
  { name: "mastercard.search", args: { query: "open finance" } },
] as const;

function okData(value: unknown): unknown {
  const envelope = EnvelopeSchema(z.unknown()).parse(value);
  expect(envelope.ok).toBe(true);
  if (!envelope.ok) throw new Error(envelope.error.message);
  return envelope.data;
}

function expectNoSensitiveProjection(value: unknown): void {
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;

    for (const [key, child] of Object.entries(candidate)) {
      expect(key).not.toMatch(/seed|secret|private|mnemonic|sd[-_]?jwt|raw[_-]?pii/i);
      visit(child);
    }
  };
  visit(value);
}

function expectAp4mShape(name: string, data: unknown): void {
  if (name === "merchants.list") {
    expect(MerchantSchema.array().parse(data).length).toBeGreaterThan(0);
    return;
  }
  if (name === "merchants.get") {
    expect(MerchantSchema.parse(data).id).toBe(MERCHANT_ID);
    return;
  }
  if (name === "mandate.prepare") {
    const prepared = z
      .object({
        mandate_id: z.string(),
        agent_public_jwk: z.record(z.string(), z.unknown()),
        claim_public_keys: z.array(
          z
            .object({ merchant_id: z.string(), public_key: z.string() })
            .strict(),
        ),
        unsigned_batch: z.record(z.string(), z.unknown()),
      })
      .passthrough()
      .parse(data);
    expect(prepared.mandate_id).toBeTruthy();
    return;
  }
  if (
    name === "mandate.register" ||
    name === "mandate.status" ||
    name === "mandate.revoke"
  ) {
    MandateSchema.parse(data);
    return;
  }
  if (name === "credential.status") {
    const status = z
      .object({ account: z.string(), accepted: z.boolean() })
      .passthrough()
      .parse(data);
    expect(status.account).toBeTruthy();
    return;
  }
  if (name === "credential.payerAccept") {
    z
      .object({ status: z.string(), account: z.string(), credential_id: z.string() })
      .passthrough()
      .parse(data);
    return;
  }
  if (name === "credential.ids") {
    const ids = z
      .object({ credential_ids: z.array(z.string()) })
      .passthrough()
      .parse(data);
    expect(ids.credential_ids.length).toBeGreaterThan(0);
    return;
  }
  if (name === "ap4m.purchase") {
    const purchase = z
      .object({
        receipt: Ap4mReceiptSchema,
        data: z.record(z.string(), z.unknown()),
      })
      .strict()
      .parse(data);
    expect(purchase.receipt.merchant_id).toBe(MERCHANT_ID);
    return;
  }
  if (name === "channel.status") {
    const channel = z
      .object({ channel_id: z.string() })
      .passthrough()
      .parse(data);
    expect(channel.channel_id).toBeTruthy();
    return;
  }
  if (name === "channel.list") {
    expect(z.array(z.record(z.string(), z.unknown())).parse(data).length).toBeGreaterThan(0);
    return;
  }
  if (name.startsWith("mastercard.")) {
    const mastercard = z
      .object({ source: z.literal("Mastercard Developers") })
      .passthrough()
      .parse(data);
    expect(mastercard.source).toBe("Mastercard Developers");
    return;
  }
  throw new Error(`Missing AP4M result assertion for ${name}`);
}

describe("AP4M Harbor mock contract", () => {
  const client = createHarborRestClient({ mock: true });
  const op = client.op.bind(client) as unknown as UntypedOp;

  it("covers every AP4M op from the addendum index", () => {
    expect(operations.map(({ name }) => name)).toEqual([
      "merchants.list",
      "merchants.get",
      "mandate.prepare",
      "mandate.register",
      "mandate.status",
      "mandate.revoke",
      "credential.status",
      "credential.payerAccept",
      "credential.ids",
      "ap4m.purchase",
      "channel.status",
      "channel.list",
      "mastercard.services",
      "mastercard.docs",
      "mastercard.page",
      "mastercard.search",
    ]);
  });

  it.each(operations)("serves $name from contract-shaped mock fixtures", async ({ name, args }) => {
    const result = await op(name, args as Record<string, unknown>);
    expectNoSensitiveProjection(result);
    expectAp4mShape(name, okData(result));
  });

  it("derives signable Batch and ordered sequential setup from the caller", async () => {
    const isolated = createHarborRestClient({ mock: true });
    const prepared = await isolated.op("mandate.prepare", {
      owner: OWNER,
      network: "testnet",
      constraints: {
        currency: "USD",
        per_payment_max: "2",
        daily_max: "4",
        total_max: "6",
        payees: [MERCHANT_ID],
      },
      payees: [MERCHANT_ID],
      expires_at: "2026-10-23T00:00:00.000Z",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.asOfBasis).toContain("mock mandate preparation");
    expect(prepared.asOfBasis).toContain("nothing submitted");
    expectNoSensitiveProjection(prepared);
    const batch = prepared.data.unsigned_batch;
    const sequential = prepared.data.unsigned_sequential ?? [];
    const raw = batch.RawTransactions as Array<{ RawTransaction: Record<string, unknown> }>;

    expect(batch).toMatchObject({
      Account: OWNER,
      Fee: expect.any(String),
      Flags: 0x00010000,
      LastLedgerSequence: expect.any(Number),
      Sequence: expect.any(Number),
      TransactionType: "Batch",
    });
    expect(raw.map(({ RawTransaction }) => RawTransaction.Account)).toEqual([
      OWNER,
      OWNER,
    ]);
    expect(raw.every(({ RawTransaction }) =>
      RawTransaction.Fee === "0" &&
      RawTransaction.SigningPubKey === "" &&
      RawTransaction.Flags === 0x40000000,
    )).toBe(true);
    expect(sequential.map((transaction) => transaction.TransactionType)).toEqual([
      "CredentialAccept",
      "PaymentChannelCreate",
    ]);
    expect(sequential.map((transaction) => transaction.Account)).toEqual([
      OWNER,
      OWNER,
    ]);
    expect(sequential[0]).toMatchObject({
      CredentialType: "4150344D2D4167656E74",
      Issuer: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
    });
    expect(raw[0]!.RawTransaction).toMatchObject({
      CredentialType: sequential[0]!.CredentialType,
      Issuer: sequential[0]!.Issuer,
    });
    expect(sequential.map((transaction) => transaction.Sequence)).toEqual([
      110,
      111,
    ]);
    expect(sequential.every((transaction) =>
      typeof transaction.Fee === "string" &&
      typeof transaction.LastLedgerSequence === "number" &&
      Array.isArray(transaction.Memos),
    )).toBe(true);

    const active = await isolated.op("mandate.register", {
      mandate_id: prepared.data.mandate_id,
      l1: "header.payload.signature",
      l2: "header.payload.signature",
      setup_tx_hash:
        "A100000000000000000000000000000000000000000000000000000000000001",
    });
    expect(active.ok).toBe(true);
  });

  it("propagates caller constraints to ACTIVE with ordered sequential evidence", async () => {
    const isolated = createHarborRestClient({ mock: true });
    const constraints = {
      currency: "USD" as const,
      per_payment_max: "3",
      daily_max: "7",
      total_max: "9",
      payees: [MERCHANT_ID, "risk-oracle"],
      skus: ["yield-report"],
    };
    const expiresAt = "2026-10-24T00:00:00.000Z";
    const prepared = await isolated.op("mandate.prepare", {
      owner: OWNER,
      network: "testnet",
      constraints,
      payees: constraints.payees,
      expires_at: expiresAt,
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    const count = prepared.data.unsigned_sequential?.length ?? 0;
    const hashes = Array.from({ length: count }, (_, index) =>
      `${index + 1}`.padStart(64, "A"),
    );
    const active = await isolated.op("mandate.register", {
      mandate_id: prepared.data.mandate_id,
      l1: "header.payload.signature",
      l2: "header.payload.signature",
      setup_tx_hash: hashes,
    });

    expect(active.ok).toBe(true);
    if (!active.ok) throw new Error(active.error.message);
    expect(active.data).toMatchObject({
      constraints,
      expires_at: expiresAt,
      owner: OWNER,
      setup_batch_hash: hashes.join(","),
      status: "ACTIVE",
    });
    expect(active.data.channels.map(({ merchant_id }) => merchant_id)).toEqual(
      constraints.payees,
    );
    expect(active.asOfBasis).toContain("mock mandate registration");
    expect(active.asOfBasis).toContain("no ledger validation");
    expectNoSensitiveProjection(active);
  });

  it("rejects unknown and mismatched mock registration evidence", async () => {
    const isolated = createHarborRestClient({ mock: true });
    const unknown = await isolated.op("mandate.register", {
      mandate_id: "unknown-mandate",
      l1: "header.payload.signature",
      l2: "header.payload.signature",
      setup_tx_hash: "A".repeat(64),
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("MANDATE_NOT_FOUND");

    const prepared = await isolated.op("mandate.prepare", {
      owner: OWNER,
      network: "testnet",
      constraints: {
        currency: "USD",
        per_payment_max: "2",
        daily_max: "4",
        total_max: "6",
        payees: [MERCHANT_ID],
      },
      payees: [MERCHANT_ID],
      expires_at: "2026-10-23T00:00:00.000Z",
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    const mismatch = await isolated.op("mandate.register", {
      mandate_id: prepared.data.mandate_id,
      l1: "header.payload.signature",
      l2: "header.payload.signature",
      setup_tx_hash: ["A".repeat(64)],
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.code).toBe("MANDATE_SETUP_MISMATCH");
  });

  it.each([
    { label: "an empty ordered set", setup_tx_hash: [] },
    { label: "an empty ordered member", setup_tx_hash: ["valid", ""] },
  ])("rejects $label", async ({ setup_tx_hash }) => {
    const result = await op("mandate.register", {
      mandate_id: MANDATE_ID,
      l1: "header.payload.signature",
      l2: "header.payload.signature",
      setup_tx_hash,
    });
    const envelope = EnvelopeSchema(z.unknown()).parse(result);

    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.code).toBe("INVALID_ARGUMENT");
  });

  it("discovers the AP4M and Mastercard operations through mock MCP search", async () => {
    const mcp = createHarborMcpClient({ mock: true });
    const ap4m = okData(await mcp.search("ap4m")) as Array<{ name: string }>;
    const mastercard = okData(await mcp.search("open finance")) as Array<{
      name: string;
    }>;

    expect(ap4m.map(({ name }) => name)).toContain("ap4m.purchase");
    expect(mastercard.map(({ name }) => name)).toContain("mastercard.search");
  });
});
