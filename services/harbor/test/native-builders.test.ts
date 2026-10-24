import { describe, expect, it, vi } from "vitest";

import type { OpContext, OpDef } from "../src/catalog/registry";
import type { BuildInsert } from "../src/exec/store";
import { ops } from "../src/ops/tx";
import fixture from "./fixtures/native-builders/testnet.json";

function operation(name: string): OpDef {
  const op = ops.find((candidate) => candidate.name === name);
  if (!op) throw new Error(`missing operation ${name}`);
  return op;
}

function fixtureContext(permissions = ["EscrowFinish", "CheckCash"]) {
  const inserted: BuildInsert[] = [];
  const request = vi.fn(
    async (
      _network: string,
      command: string,
      params: Readonly<Record<string, unknown>> = {},
    ): Promise<Record<string, unknown>> => {
      switch (command) {
        case "server_info":
          return fixture.server_info;
        case "account_info":
          return {
            ...fixture.account_info,
            account_data: {
              ...fixture.account_info.account_data,
              Account: params.account,
            },
          };
        case "account_lines":
          return {
            account: params.account,
            ledger_index: fixture.ledger_index,
            lines: [],
            validated: true,
          };
        case "fee":
          return fixture.fee;
        case "simulate":
          return fixture.simulate;
        case "book_offers": {
          const gets = params.taker_gets as { currency?: string };
          if (gets.currency === "XRP") {
            return {
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
            };
          }
          return {
            offers: [
              {
                TakerGets: {
                  currency: "524C555344000000000000000000000000000000",
                  issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
                  value: "1",
                },
                TakerPays: "2000000",
              },
            ],
          };
        }
        default:
          throw new Error(`unexpected fixture command: ${command}`);
      }
    },
  );
  const insertBuild = vi.fn(async (input: BuildInsert) => {
    inserted.push(input);
    return input;
  });
  const ctx = {
    principal: "native-builder-fixture",
    sourceTag: 314,
    xrplRpc: { request },
    store: {
      insertBuild,
      getLink: vi.fn(async () => ({ permissions, status: "active" as const })),
    },
  } as OpContext;
  return { ctx, inserted, request };
}

async function invoke(
  name: string,
  ctx: OpContext,
  args: Record<string, unknown>,
): Promise<Record<string, any>> {
  const op = operation(name);
  const parsed = op.args.safeParse(args);
  if (!parsed.success) throw parsed.error;
  return (await op.handler(ctx, parsed.data)) as Record<string, any>;
}

function containsSignedMaterial(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsSignedMaterial);
  return Object.entries(value).some(
    ([key, nested]) =>
      ["SigningPubKey", "TxnSignature", "Signers", "tx_blob"].includes(key) ||
      containsSignedMaterial(nested),
  );
}

const finishAfter = 900_000_000;
const cancelAfter = finishAfter + 600;

const cases = [
  {
    op: "tx.escrowCreate",
    transactionType: "EscrowCreate",
    args: {
      network: fixture.network,
      account: fixture.account,
      destination: fixture.destination,
      amount: "1000000",
      finish_after: finishAfter,
      cancel_after: cancelAfter,
      destination_tag: 7,
    },
    expected: {
      Destination: fixture.destination,
      Amount: "1000000",
      FinishAfter: finishAfter,
      CancelAfter: cancelAfter,
      DestinationTag: 7,
    },
    amounts: ["1000000 drops XRP"],
    reserveDelta: "2000000",
    expectedFee: "12",
    delegable: false,
  },
  {
    op: "tx.escrowFinish",
    transactionType: "EscrowFinish",
    args: {
      network: fixture.network,
      account: fixture.account,
      owner: fixture.owner,
      offer_sequence: 7,
      condition: fixture.condition,
      fulfillment: fixture.fulfillment,
    },
    expected: {
      Owner: fixture.owner,
      OfferSequence: 7,
      Condition: fixture.condition,
      Fulfillment: fixture.fulfillment,
    },
    amounts: [],
    reserveDelta: "0",
    expectedFee: "399",
    delegable: true,
  },
  {
    op: "tx.escrowCancel",
    transactionType: "EscrowCancel",
    args: {
      network: fixture.network,
      account: fixture.account,
      owner: fixture.owner,
      offer_sequence: 7,
    },
    expected: { Owner: fixture.owner, OfferSequence: 7 },
    amounts: [],
    reserveDelta: "0",
    expectedFee: "12",
    delegable: false,
  },
  {
    op: "tx.checkCreate",
    transactionType: "CheckCreate",
    args: {
      network: fixture.network,
      account: fixture.account,
      destination: fixture.destination,
      send_max: "2000000",
      expiration: cancelAfter,
      invoice_id: fixture.invoice_id,
      destination_tag: 11,
    },
    expected: {
      Destination: fixture.destination,
      SendMax: "2000000",
      Expiration: cancelAfter,
      InvoiceID: fixture.invoice_id,
      DestinationTag: 11,
    },
    amounts: ["2000000 drops XRP"],
    reserveDelta: "2000000",
    expectedFee: "12",
    delegable: false,
  },
  {
    op: "tx.checkCash",
    transactionType: "CheckCash",
    args: {
      network: fixture.network,
      account: fixture.account,
      check_id: fixture.check_id,
      amount: "1500000",
    },
    expected: { CheckID: fixture.check_id, Amount: "1500000" },
    amounts: ["1500000 drops XRP"],
    reserveDelta: "0",
    expectedFee: "12",
    delegable: true,
  },
  {
    op: "tx.checkCancel",
    transactionType: "CheckCancel",
    args: {
      network: fixture.network,
      account: fixture.account,
      check_id: fixture.check_id,
    },
    expected: { CheckID: fixture.check_id },
    amounts: [],
    reserveDelta: "0",
    expectedFee: "12",
    delegable: false,
  },
] as const;

describe("XRPL native escrow and check builders", () => {
  for (const testCase of cases) {
    it(`builds ${testCase.op} from the deterministic testnet fixture`, async () => {
      const { ctx, inserted, request } = fixtureContext();
      const build = await invoke(testCase.op, ctx, testCase.args);

      expect(build.network).toBe("testnet");
      expect(build.tx_json).toMatchObject({
        TransactionType: testCase.transactionType,
        Account: fixture.account,
        ...testCase.expected,
        Fee: testCase.expectedFee,
        Sequence: fixture.account_info.account_data.Sequence,
        LastLedgerSequence: fixture.ledger_index + 4,
      });
      expect(build.delegable).toBe(testCase.delegable);
      expect(build.simulate).toEqual(fixture.simulate);
      expect(build.preflight).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ check: "network", pass: true }),
          expect.objectContaining({ check: "reserve", pass: true }),
        ]),
      );
      expect(build.preflight.every(({ pass }: { pass: boolean }) => pass)).toBe(
        true,
      );
      expect(build.summary).toMatchObject({
        account: fixture.account,
        amounts: testCase.amounts,
        fee_drops: testCase.expectedFee,
        reserve_delta_drops: testCase.reserveDelta,
      });
      expect(containsSignedMaterial(build)).toBe(false);
      expect(inserted).toHaveLength(1);
      expect(request).toHaveBeenCalledWith(
        "testnet",
        "simulate",
        expect.objectContaining({
          tx_json: expect.objectContaining({
            TransactionType: testCase.transactionType,
          }),
          binary: false,
        }),
        undefined,
      );
    });
  }

  it("derives delegability from the stored link instead of the builder request", async () => {
    for (const testCase of cases.filter(({ delegable }) => delegable)) {
      const { ctx } = fixtureContext([]);
      const build = await invoke(testCase.op, ctx, testCase.args);
      expect(build.delegable, testCase.op).toBe(false);
    }
  });

  it("recognizes explicit cancel grants but never treats value-creating permissions as delegable", async () => {
    for (const testCase of cases.filter(({ op }) =>
      ["tx.escrowCancel", "tx.checkCancel"].includes(op),
    )) {
      const { ctx } = fixtureContext([testCase.transactionType]);
      const build = await invoke(testCase.op, ctx, testCase.args);
      expect(build.delegable, testCase.op).toBe(true);
    }

    for (const testCase of cases.filter(({ op }) =>
      ["tx.escrowCreate", "tx.checkCreate"].includes(op),
    )) {
      const { ctx } = fixtureContext([testCase.transactionType]);
      const build = await invoke(testCase.op, ctx, testCase.args);
      expect(build.delegable, testCase.op).toBe(false);
    }
  });

  it("strictly rejects malformed escrow and check modes", () => {
    expect(
      operation("tx.escrowCreate").args.safeParse({
        network: "testnet",
        account: fixture.account,
        destination: fixture.destination,
        amount: "1",
      }).success,
    ).toBe(false);
    expect(
      operation("tx.escrowFinish").args.safeParse({
        network: "testnet",
        account: fixture.account,
        owner: fixture.owner,
        offer_sequence: 7,
        fulfillment: fixture.fulfillment,
      }).success,
    ).toBe(false);
    expect(
      operation("tx.checkCash").args.safeParse({
        network: "testnet",
        account: fixture.account,
        check_id: fixture.check_id,
      }).success,
    ).toBe(false);
    expect(
      operation("tx.checkCash").args.safeParse({
        network: "testnet",
        account: fixture.account,
        check_id: fixture.check_id,
        amount: "1",
        deliver_min: "1",
      }).success,
    ).toBe(false);
    expect(
      operation("tx.checkCancel").args.safeParse({
        network: "testnet",
        account: fixture.account,
        check_id: "0".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      operation("tx.checkCancel").args.safeParse({
        network: "testnet",
        account: fixture.account,
        check_id: fixture.check_id,
        provider_payload: "untrusted",
      }).success,
    ).toBe(false);
    expect(
      operation("tx.simulate").args.safeParse({
        network: "testnet",
        account: fixture.account,
        tx_json: {
          TransactionType: "CheckCancel",
          Account: fixture.account,
          CheckID: fixture.check_id,
          Memos: [],
        },
      }).success,
    ).toBe(false);
    expect(
      operation("tx.simulate").args.safeParse({
        network: "testnet",
        account: fixture.account,
        tx_json: {
          TransactionType: "EscrowCancel",
          Account: fixture.account,
          Owner: fixture.owner,
          OfferSequence: 7,
          ArbitraryProviderField: "untrusted",
        },
      }).success,
    ).toBe(false);
  });

  it("supports all six transaction shapes through tx.simulate", async () => {
    for (const testCase of cases) {
      const direct = await invoke(testCase.op, fixtureContext().ctx, testCase.args);
      const txJson = Object.fromEntries(
        Object.entries(direct.tx_json).filter(
          ([key]) =>
            ![
              "Fee",
              "Sequence",
              "LastLedgerSequence",
              "SourceTag",
              "Memos",
            ].includes(key),
        ),
      );
      const simulated = await invoke("tx.simulate", fixtureContext().ctx, {
        network: "testnet",
        account: fixture.account,
        tx_json: txJson,
      });
      expect(simulated.tx_json.TransactionType, testCase.op).toBe(
        testCase.transactionType,
      );
      expect(simulated.simulate, testCase.op).toEqual(fixture.simulate);
      expect(simulated.delegable, testCase.op).toBe(testCase.delegable);
    }
  });
});
