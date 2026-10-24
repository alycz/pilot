import { describe, expect, it, vi } from "vitest";

import type { OpContext, OpDef } from "../src/catalog/registry";
import type { BuildInsert } from "../src/exec/store";
import { ops } from "../src/ops/tx";

const ACCOUNT = "rJVUeRqDFNs2xqA7ncVE6ZoAhPUoaJJSQm";
const DESTINATION = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const ISSUER = "rP9jPyP5kyvFRb6ZiRghAGw5u8SGAmU4bd";
const CURRENCY_40 = "524C555344000000000000000000000000000000";
const LP_CURRENCY = "039C99CD9AB0B70B32ECDA51EAAE471625608EA2";
const VAULT_ID = "A".repeat(64);
const MAINNET_RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const RLUSD_HEX = "524C555344000000000000000000000000000000";

function operation(name: string): OpDef {
  const op = ops.find((candidate) => candidate.name === name);
  if (!op) throw new Error(`missing operation ${name}`);
  return op;
}

type FixtureOptions = { missingTrustLine?: boolean };

function fixtureContext(options: FixtureOptions = {}) {
  const inserted: BuildInsert[] = [];
  const insertBuild = vi.fn(async (input: BuildInsert) => {
    inserted.push(input);
    return input;
  });
  const request = vi.fn(
    async (
      network: string,
      command: string,
      params: Readonly<Record<string, unknown>> = {},
    ): Promise<Record<string, unknown>> => {
      switch (command) {
        case "server_info":
          // Recorded public server_info reserve fields, reduced to the fields
          // consumed by the builder so this unit test never contacts a node.
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
              Balance: "100000000",
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
            lines: options.missingTrustLine
              ? []
              : [
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
          // Recorded shape from the official simulate response contract.
          return {
            engine_result: "tesSUCCESS",
            engine_result_message: "The transaction was applied.",
            applied: false,
          };
        case "book_offers": {
          const gets = params.taker_gets as { currency?: string };
          if (network === "mainnet") {
            if (gets.currency === "XRP") {
              return {
                offers: [
                  {
                    TakerGets: "2000000",
                    TakerPays: {
                      currency: RLUSD_HEX,
                      issuer: MAINNET_RLUSD_ISSUER,
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
                    currency: RLUSD_HEX,
                    issuer: MAINNET_RLUSD_ISSUER,
                    value: "1",
                  },
                  TakerPays: "2000000",
                },
              ],
            };
          }
          if (gets.currency === "XRP") {
            return {
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
            };
          }
          return {
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
          throw new Error(`unexpected fixture command: ${command}`);
      }
    },
  );
  const ctx = {
    principal: "tx-ops-fixture",
    sourceTag: 314,
    xrplRpc: { request },
    store: {
      insertBuild,
      getLink: vi.fn(async () => ({
        permissions: [
          "OfferCreate",
          "OfferCancel",
          "TrustSet",
          "AMMDeposit",
          "AMMWithdraw",
        ],
      })),
    },
  } as OpContext;
  return { ctx, request, insertBuild, inserted };
}

async function invoke(
  name: string,
  ctx: OpContext,
  input: Record<string, unknown>,
) {
  const op = operation(name);
  return op.handler(ctx, op.args.parse(input));
}

function containsSignedMaterial(value: unknown): boolean {
  return /SigningPubKey|TxnSignature|tx_blob|"Signers"/.test(
    JSON.stringify(value),
  );
}

describe("transaction operations", () => {
  it("exports exactly the ten P1.5 operation definitions", () => {
    expect(ops.map(({ name }) => name)).toEqual([
      "tx.swap",
      "tx.offer",
      "tx.offerCancel",
      "tx.payment",
      "tx.trustSet",
      "tx.ammDeposit",
      "tx.ammWithdraw",
      "tx.vaultDeposit",
      "tx.vaultWithdraw",
      "tx.simulate",
    ]);
    expect(operation("tx.vaultDeposit").caveats).toEqual(["devnet-only"]);
    expect(operation("tx.vaultWithdraw").caveats).toEqual(["devnet-only"]);
  });

  it("builds, tags, simulates, and stores a valid non-delegable payment", async () => {
    const { ctx, insertBuild } = fixtureContext();
    const build = (await invoke("tx.payment", ctx, {
      network: "testnet",
      account: ACCOUNT,
      destination: DESTINATION,
      amount: "1000000",
      destination_tag: 7,
      intent_id: "intent-payment-1",
    })) as Awaited<ReturnType<OpDef["handler"]>> & Record<string, any>;

    expect(build.simulate).toEqual({
      engine_result: "tesSUCCESS",
      engine_result_message: "The transaction was applied.",
      applied: false,
    });
    expect(build.delegable).toBe(false);
    expect(build.tx_json).toMatchObject({
      TransactionType: "Payment",
      Account: ACCOUNT,
      Destination: DESTINATION,
      Amount: "1000000",
      DestinationTag: 7,
      SourceTag: 314,
      Fee: "12",
      Sequence: 22,
      LastLedgerSequence: 90_000_004,
    });
    expect(build.tx_json.Memos).toEqual([
      {
        Memo: {
          MemoType: "70696C6F742F696E74656E74",
          MemoData: "696E74656E742D7061796D656E742D31",
        },
      },
    ]);
    expect(build.preflight.every(({ pass }: { pass: boolean }) => pass)).toBe(
      true,
    );
    expect(containsSignedMaterial(build)).toBe(false);
    expect(insertBuild).toHaveBeenCalledTimes(1);
  });

  it("returns a typed failed trust-line preflight while still simulating and storing", async () => {
    const { ctx, insertBuild } = fixtureContext({ missingTrustLine: true });
    const amount = { currency: "USD", issuer: ISSUER, value: "5" };
    const build = (await invoke("tx.payment", ctx, {
      network: "testnet",
      account: ACCOUNT,
      destination: DESTINATION,
      amount,
    })) as Record<string, any>;

    expect(build.simulate.engine_result).toBe("tesSUCCESS");
    expect(build.preflight).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: "trust-line",
          pass: false,
          detail: expect.stringContaining("MISSING_TRUST_LINE"),
        }),
      ]),
    );
    expect(insertBuild).toHaveBeenCalledTimes(1);
  });

  it("uses exact execution-network book mid for fixed-sell IOC+Sell swaps", async () => {
    const { ctx, request } = fixtureContext();
    const build = (await invoke("tx.swap", ctx, {
      network: "testnet",
      account: ACCOUNT,
      sell: { currency: "XRP" },
      buy: { currency: "USD", issuer: ISSUER },
      amount: "1000000",
      side: "sell",
      max_slippage_bps: 100,
    })) as Record<string, any>;

    expect(build.tx_json).toMatchObject({
      TransactionType: "OfferCreate",
      TakerGets: "1000000",
      TakerPays: { currency: "USD", issuer: ISSUER, value: "0.495" },
      Flags: 0x0002_0000 | 0x0008_0000,
    });
    expect(build.summary.est_slippage_bps).toBe(100);
    expect(
      request.mock.calls.filter(([, command]) => command === "book_offers"),
    ).toHaveLength(2);
    expect(
      request.mock.calls
        .filter(([, command]) => command === "book_offers")
        .every(([network]) => network === "testnet"),
    ).toBe(true);
  });

  it("orients a fixed-buy swap correctly and rounds maximum XRP spend upward", async () => {
    const { ctx } = fixtureContext();
    const build = (await invoke("tx.swap", ctx, {
      network: "testnet",
      account: ACCOUNT,
      sell: { currency: "XRP" },
      buy: { currency: "USD", issuer: ISSUER },
      amount: { currency: "USD", issuer: ISSUER, value: "1" },
      side: "buy",
      max_slippage_bps: 100,
    })) as Record<string, any>;

    expect(build.tx_json).toMatchObject({
      TransactionType: "OfferCreate",
      TakerGets: "2020203",
      TakerPays: { currency: "USD", issuer: ISSUER, value: "1" },
      Flags: 0x0002_0000,
    });
  });

  it("routes every remaining builder through the common build pipeline", async () => {
    const cases: [string, Record<string, unknown>, string, boolean][] = [
      [
        "tx.offer",
        {
          network: "testnet",
          account: ACCOUNT,
          taker_gets: "1000000",
          taker_pays: { currency: "USD", issuer: ISSUER, value: "0.5" },
        },
        "OfferCreate",
        true,
      ],
      [
        "tx.offerCancel",
        { network: "testnet", account: ACCOUNT, offer_sequence: 7 },
        "OfferCancel",
        true,
      ],
      [
        "tx.trustSet",
        {
          network: "testnet",
          account: ACCOUNT,
          limit_amount: { currency: "USD", issuer: ISSUER, value: "100" },
        },
        "TrustSet",
        true,
      ],
      [
        "tx.ammDeposit",
        {
          network: "testnet",
          account: ACCOUNT,
          asset: { currency: "XRP" },
          asset2: { currency: "USD", issuer: ISSUER },
          amount: "1000000",
          amount2: { currency: "USD", issuer: ISSUER, value: "0.5" },
          flags: 0x0010_0000,
        },
        "AMMDeposit",
        true,
      ],
      [
        "tx.ammWithdraw",
        {
          network: "testnet",
          account: ACCOUNT,
          asset: { currency: "XRP" },
          asset2: { currency: "USD", issuer: ISSUER },
          amount: "1000000",
          flags: 0x0008_0000,
        },
        "AMMWithdraw",
        true,
      ],
      [
        "tx.vaultDeposit",
        {
          network: "devnet",
          account: ACCOUNT,
          vault_id: VAULT_ID,
          amount: "1000000",
        },
        "VaultDeposit",
        false,
      ],
      [
        "tx.vaultWithdraw",
        {
          network: "devnet",
          account: ACCOUNT,
          vault_id: VAULT_ID,
          amount: "500000",
        },
        "VaultWithdraw",
        false,
      ],
      [
        "tx.simulate",
        {
          network: "testnet",
          account: ACCOUNT,
          tx_json: {
            TransactionType: "OfferCancel",
            Account: ACCOUNT,
            OfferSequence: 7,
          },
        },
        "OfferCancel",
        true,
      ],
    ];

    for (const [name, args, transactionType, delegable] of cases) {
      const { ctx, insertBuild } = fixtureContext();
      const build = (await invoke(name, ctx, args)) as Record<string, any>;
      expect(build.tx_json.TransactionType, name).toBe(transactionType);
      expect(build.simulate.engine_result, name).toBe("tesSUCCESS");
      expect(build.delegable, name).toBe(delegable);
      expect(containsSignedMaterial(build), name).toBe(false);
      expect(insertBuild, name).toHaveBeenCalledTimes(1);
      if (["OfferCreate", "TrustSet", "AMMDeposit"].includes(transactionType)) {
        expect(build.summary.reserve_delta_drops, name).toBe("2000000");
      }
    }
  });

  it("uses AMM-mode-specific trust-line preflight", async () => {
    const single = fixtureContext({ missingTrustLine: true });
    const singleBuild = (await invoke("tx.ammDeposit", single.ctx, {
      network: "testnet",
      account: ACCOUNT,
      asset: { currency: "XRP" },
      asset2: { currency: "USD", issuer: ISSUER },
      amount: "1000000",
      flags: 0x0008_0000,
    })) as Record<string, any>;
    expect(singleBuild.preflight).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "trust-line", pass: false }),
      ]),
    );

    const proportional = fixtureContext({ missingTrustLine: true });
    const proportionalBuild = (await invoke("tx.ammDeposit", proportional.ctx, {
      network: "testnet",
      account: ACCOUNT,
      asset: { currency: "XRP" },
      asset2: { currency: "USD", issuer: ISSUER },
      lp_token_out: {
        currency: LP_CURRENCY,
        issuer: DESTINATION,
        value: "1",
      },
      flags: 0x0001_0000,
    })) as Record<string, any>;
    expect(proportionalBuild.preflight).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "trust-line", pass: false }),
      ]),
    );

    const withdrawAll = fixtureContext({ missingTrustLine: true });
    const withdrawBuild = (await invoke("tx.ammWithdraw", withdrawAll.ctx, {
      network: "testnet",
      account: ACCOUNT,
      asset: { currency: "XRP" },
      asset2: { currency: "USD", issuer: ISSUER },
      flags: 0x0002_0000,
    })) as Record<string, any>;
    expect(withdrawBuild.preflight).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "trust-line", pass: false }),
      ]),
    );
  });

  it("strictly rejects mainnet, malformed amounts, unsafe extra keys, and invalid modes", () => {
    expect(
      operation("tx.payment").args.safeParse({
        network: "mainnet",
        account: ACCOUNT,
        destination: DESTINATION,
        amount: "1",
      }).success,
    ).toBe(false);
    expect(
      operation("tx.payment").args.safeParse({
        network: "testnet",
        account: ACCOUNT,
        destination: DESTINATION,
        amount: { currency: "USD", issuer: ISSUER, value: "1e9999" },
      }).success,
    ).toBe(false);
    expect(
      operation("tx.payment").args.safeParse({
        network: "testnet",
        account: ACCOUNT,
        destination: DESTINATION,
        amount: "1.5",
      }).success,
    ).toBe(false);
    expect(
      operation("tx.payment").args.safeParse({
        network: "testnet",
        account: ACCOUNT,
        destination: DESTINATION,
        amount: { currency: "RLUSD", issuer: ISSUER, value: "1" },
      }).success,
    ).toBe(false);
    expect(
      operation("tx.payment").args.safeParse({
        network: "testnet",
        account: ACCOUNT,
        destination: DESTINATION,
        amount: "1",
        private_key: "not accepted",
      }).success,
    ).toBe(false);
    expect(
      operation("tx.vaultDeposit").args.safeParse({
        network: "lending-devnet",
        account: ACCOUNT,
        vault_id: VAULT_ID,
        amount: "1",
      }).success,
    ).toBe(false);
    expect(
      operation("tx.ammDeposit").args.safeParse({
        network: "testnet",
        account: ACCOUNT,
        asset: { currency: "XRP" },
        asset2: { currency: "USD", issuer: ISSUER },
        amount: "1",
        flags: 0x0010_0000,
      }).success,
    ).toBe(false);
  });

  it("accepts 40-hex currencies and strictly constrains raw simulation", () => {
    expect(
      operation("tx.payment").args.safeParse({
        network: "testnet",
        account: ACCOUNT,
        destination: DESTINATION,
        amount: { currency: CURRENCY_40, issuer: ISSUER, value: "1" },
      }).success,
    ).toBe(true);
    expect(
      operation("tx.simulate").args.safeParse({
        network: "testnet",
        account: ACCOUNT,
        tx_json: {
          TransactionType: "OfferCancel",
          Account: ACCOUNT,
          OfferSequence: 7,
          SigningPubKey: "ED00",
        },
      }).success,
    ).toBe(false);
    expect(
      operation("tx.simulate").args.safeParse({
        network: "testnet",
        account: ACCOUNT,
        tx_json: {
          TransactionType: "VaultDeposit",
          Account: ACCOUNT,
          VaultID: VAULT_ID,
          Amount: "1",
        },
      }).success,
    ).toBe(false);
    expect(
      operation("tx.simulate").args.safeParse({
        network: "testnet",
        account: ACCOUNT,
        tx_json: {
          TransactionType: "AMMDeposit",
          Account: ACCOUNT,
          Asset: { currency: "XRP" },
          Asset2: { currency: "USD", issuer: ISSUER },
          Amount: "1",
          LPTokenOut: {
            currency: LP_CURRENCY,
            issuer: DESTINATION,
            value: "1",
          },
          Flags: 0x0008_0000,
        },
      }).success,
    ).toBe(false);
  });

  it("applies transaction-specific trust-line inference to raw simulation", async () => {
    const { ctx, request } = fixtureContext();
    const build = (await invoke("tx.simulate", ctx, {
      network: "testnet",
      account: ACCOUNT,
      tx_json: {
        TransactionType: "AMMDeposit",
        Account: ACCOUNT,
        Asset: { currency: "XRP" },
        Asset2: { currency: "USD", issuer: ISSUER },
        LPTokenOut: {
          currency: LP_CURRENCY,
          issuer: DESTINATION,
          value: "1",
        },
        Flags: 0x0001_0000,
      },
    })) as Record<string, any>;

    expect(build.preflight).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ detail: expect.stringContaining(LP_CURRENCY) }),
      ]),
    );
    expect(
      request.mock.calls.filter(([, command]) => command === "account_lines"),
    ).toHaveLength(1);

    const trustSetFixture = fixtureContext();
    const trustSetBuild = await invoke("tx.simulate", trustSetFixture.ctx, {
      network: "testnet",
      account: ACCOUNT,
      tx_json: {
        TransactionType: "TrustSet",
        Account: ACCOUNT,
        LimitAmount: { currency: "USD", issuer: ISSUER, value: "100" },
      },
    });
    expect(
      trustSetFixture.request.mock.calls.filter(
        ([, command]) => command === "account_lines",
      ),
    ).toHaveLength(0);
    expect(trustSetBuild.summary.usd_value).toBeUndefined();
  });
});
