import { describe, expect, it, vi } from "vitest";

import type { OpContext, OpDef } from "../src/catalog/registry";
import { DEFAULT_POLICY, type TxBuild } from "../src/contracts";
import { evaluate } from "../src/exec/policy";
import type { BuildInsert } from "../src/exec/store";
import { ops } from "../src/ops/tx";

const ACCOUNT = "rJVUeRqDFNs2xqA7ncVE6ZoAhPUoaJJSQm";
const DESTINATION = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const ISSUER = "rP9jPyP5kyvFRb6ZiRghAGw5u8SGAmU4bd";
const CURRENCY_40 = "524C555344000000000000000000000000000000";
const LP_CURRENCY = "039C99CD9AB0B70B32ECDA51EAAE471625608EA2";
const VAULT_ID = "A".repeat(64);
const MAINNET_RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const TESTNET_RLUSD_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const RLUSD_HEX = "524C555344000000000000000000000000000000";

function operation(name: string): OpDef {
  const op = ops.find((candidate) => candidate.name === name);
  if (!op) throw new Error(`missing operation ${name}`);
  return op;
}

type FixtureOptions = {
  missingTrustLine?: boolean;
  balanceDrops?: string;
  accountLedgerIndex?: number;
  accountLinesLedgerIndex?: number;
  quoteResult?: Record<string, unknown>;
  quoteSourceAmount?: unknown | null;
  simulateResult?: {
    engine_result: string;
    engine_result_message: string;
    applied: false;
  };
};

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
              Balance: options.balanceDrops ?? "100000000",
              OwnerCount: 1,
              Sequence: 22,
              Flags: 0,
            },
            ledger_index: options.accountLedgerIndex ?? 90_000_000,
            validated: true,
          };
        case "account_lines":
          return {
            account: params.account,
            ledger_index: options.accountLinesLedgerIndex ?? 90_000_000,
            lines: options.missingTrustLine
              ? []
              : [
                  {
                    account: params.peer,
                    balance:
                      params.peer === TESTNET_RLUSD_ISSUER ? "100" : "10",
                    currency:
                      params.peer === TESTNET_RLUSD_ISSUER
                        ? RLUSD_HEX
                        : "USD",
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
          return options.simulateResult ?? {
            engine_result: "tesSUCCESS",
            engine_result_message: "provider-controlled simulation text",
            applied: false,
          };
        case "ripple_path_find":
          return options.quoteResult ?? {
            validated: true,
            full_reply: true,
            ledger_index: 90_000_000,
            ledger_hash: "A".repeat(64),
            source_account: params.source_account,
            destination_account: params.destination_account,
            destination_amount: params.destination_amount,
            alternatives:
              options.quoteSourceAmount === null
                ? []
                : [
                    {
                      paths_computed: [],
                      source_amount:
                        options.quoteSourceAmount ?? "150000000",
                    },
                  ],
          };
        case "book_offers": {
          const gets = params.taker_gets as {
            currency?: string;
            issuer?: string;
          };
          const pays = params.taker_pays as {
            currency?: string;
            issuer?: string;
          };
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
                    currency: pays.currency,
                    issuer: pays.issuer,
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
                  currency: gets.currency,
                  issuer: gets.issuer,
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
        status: "active",
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

function reviewedTradingContext(ctx: OpContext): void {
  ctx.localDevRequest = true;
  ctx.env = {
    EXEC_NETWORK: "testnet",
    EXECUTOR: "quickjs",
    MAINNET_EXECUTION: "false",
    HARBOR_LOCAL_DEV: "true",
    HARBOR_LOCAL_READ_ONLY: "false",
    HARBOR_LOCAL_AUTH_REQUIRED: "true",
    HARBOR_LOCAL_CRON_DISABLED: "true",
    HARBOR_LOCAL_X402: "false",
    HARBOR_LOCAL_X402_RUNTIME_ENABLED: "false",
    HARBOR_LOCAL_TRADING_RUNTIME_ENABLED: "true",
    HARBOR_LOCAL_TRADING_SIGNING_PROFILE:
      "reviewed-testnet-local-trading-v1",
    HARBOR_SOURCE_TAG: "2610240",
  };
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

function delegatedSwapPolicy(build: TxBuild, usdValue: number) {
  return evaluate(build, {
    policy: DEFAULT_POLICY,
    linkStatus: "active",
    grantedPermissions: ["OfferCreate"],
    issuerFacts: [
      {
        currency: RLUSD_HEX,
        issuer: TESTNET_RLUSD_ISSUER,
        requireAuth: false,
      },
    ],
    stableAsset: {
      currency: RLUSD_HEX,
      issuer: TESTNET_RLUSD_ISSUER,
    },
    usdValue,
    dailyUsdTotal: 0,
  });
}

describe("transaction operations", () => {
  it("accepts only the exact execution contract literals on swap and trustSet", () => {
    const swap = operation("tx.swap");
    const base = {
      network: "testnet",
      account: ACCOUNT,
      sell: { currency: "XRP" },
      buy: { currency: "USD", issuer: ISSUER },
      amount: "1000000",
      side: "sell",
      max_slippage_bps: 10,
    };
    expect(swap.args.safeParse({ ...base, execution_contract: "xrpl_execution_v2" }).success)
      .toBe(true);
    expect(swap.args.safeParse({ ...base, execution_contract: "v2" }).success)
      .toBe(false);
  });

  it("returns v2 quote and official-RLUSD acquisition evidence only in the reviewed profile", async () => {
    const { ctx } = fixtureContext();
    reviewedTradingContext(ctx);
    const build = (await invoke("tx.swap", ctx, {
      network: "testnet",
      account: ACCOUNT,
      sell: { currency: "XRP" },
      buy: { currency: RLUSD_HEX, issuer: TESTNET_RLUSD_ISSUER },
      amount: { currency: RLUSD_HEX, issuer: TESTNET_RLUSD_ISSUER, value: "75" },
      side: "buy",
      max_slippage_bps: 100,
      execution_mode: "fill_or_kill",
      execution_contract: "xrpl_execution_v2",
    })) as TxBuild;
    expect(build.execution_capability).toMatchObject({
      execution_contract: "xrpl_execution_v2",
      quote_ledger: 90_000_000,
      quote_valid_through_ledger: 90_000_001,
      acquisition_balance_invariant: {
        kind: "issued_balance_unchanged",
        currency: RLUSD_HEX,
        issuer: TESTNET_RLUSD_ISSUER,
        balance: "100",
        ledger_index: 90_000_000,
      },
    });
  });

  it.each([
    ["the build ledger", 90_000_000],
    ["the immediately preceding ledger", 89_999_999],
  ])("accepts official-RLUSD balance evidence from %s", async (_label, accountLinesLedgerIndex) => {
    const { ctx } = fixtureContext({ accountLinesLedgerIndex });
    reviewedTradingContext(ctx);
    const build = (await invoke("tx.swap", ctx, {
      network: "testnet",
      account: ACCOUNT,
      sell: { currency: "XRP" },
      buy: { currency: RLUSD_HEX, issuer: TESTNET_RLUSD_ISSUER },
      amount: { currency: RLUSD_HEX, issuer: TESTNET_RLUSD_ISSUER, value: "75" },
      side: "buy",
      max_slippage_bps: 100,
      execution_mode: "fill_or_kill",
      execution_contract: "xrpl_execution_v2",
    })) as TxBuild;
    expect(build.execution_capability?.acquisition_balance_invariant?.ledger_index)
      .toBe(accountLinesLedgerIndex);
  });

  it.each([89_999_998, 90_000_001])(
    "rejects official-RLUSD balance evidence outside the one-ledger build bound: %s",
    async (accountLinesLedgerIndex) => {
      const { ctx, insertBuild } = fixtureContext({ accountLinesLedgerIndex });
      reviewedTradingContext(ctx);
      await expect(invoke("tx.swap", ctx, {
        network: "testnet",
        account: ACCOUNT,
        sell: { currency: "XRP" },
        buy: { currency: RLUSD_HEX, issuer: TESTNET_RLUSD_ISSUER },
        amount: { currency: RLUSD_HEX, issuer: TESTNET_RLUSD_ISSUER, value: "75" },
        side: "buy",
        max_slippage_bps: 100,
        execution_mode: "fill_or_kill",
        execution_contract: "xrpl_execution_v2",
      })).rejects.toMatchObject({ code: "EXECUTION_SNAPSHOT_STALE" });
      expect(insertBuild).not.toHaveBeenCalled();
    },
  );
  it("exports the complete transaction operation set", () => {
    expect(ops.map(({ name }) => name)).toEqual([
      "tx.swap",
      "tx.offer",
      "tx.offerCancel",
      "tx.payment",
      "tx.escrowCreate",
      "tx.escrowFinish",
      "tx.escrowCancel",
      "tx.checkCreate",
      "tx.checkCash",
      "tx.checkCancel",
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

  it("rejects a non-testnet swap under even a malformed local trading marker before RPC or persistence", async () => {
    const { ctx, request, insertBuild } = fixtureContext();
    ctx.env = { HARBOR_LOCAL_TRADING_SIGNING_PROFILE: "malformed" };

    await expect(
      invoke("tx.swap", ctx, {
        network: "devnet",
        account: ACCOUNT,
        sell: { currency: "XRP" },
        buy: { currency: "USD", issuer: ISSUER },
        amount: "1000000",
        side: "sell",
        max_slippage_bps: 100,
        execution_mode: "fill_or_kill",
      }),
    ).rejects.toThrow(/only testnet state/i);
    expect(request).not.toHaveBeenCalled();
    expect(insertBuild).not.toHaveBeenCalled();
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
      engine_result_message: "The simulated transaction would succeed.",
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
    const { ctx, request } = fixtureContext();
    const build = (await invoke("tx.swap", ctx, {
      network: "testnet",
      account: ACCOUNT,
      sell: { currency: "XRP" },
      buy: { currency: "USD", issuer: ISSUER },
      amount: { currency: "USD", issuer: ISSUER, value: "1" },
      side: "buy",
      max_slippage_bps: 100,
      execution_mode: "immediate_or_cancel",
    })) as Record<string, any>;

    expect(build.tx_json).toMatchObject({
      TransactionType: "OfferCreate",
      TakerGets: "2020203",
      TakerPays: { currency: "USD", issuer: ISSUER, value: "1" },
      Flags: 0x0002_0000,
    });
    expect(
      request.mock.calls.filter(([, command]) => command === "ripple_path_find"),
    ).toHaveLength(0);
  });

  it("quotes and simulates a fixed-buy 75 RLUSD FOK swap within 275 XRP", async () => {
    const { ctx, request } = fixtureContext({
      balanceDrops: "1000000000",
      // This fixture is the rounded-up source_amount returned by the validated
      // live Testnet ripple_path_find reproduction for exact 75 RLUSD.
      quoteSourceAmount: "268428007",
    });
    const rlusd = {
      currency: RLUSD_HEX,
      issuer: TESTNET_RLUSD_ISSUER,
    };
    const build = (await invoke("tx.swap", ctx, {
      network: "testnet",
      account: ACCOUNT,
      sell: { currency: "XRP" },
      buy: rlusd,
      amount: { ...rlusd, value: "75" },
      side: "buy",
      max_slippage_bps: 100,
      execution_mode: "fill_or_kill",
    })) as Record<string, any>;

    expect(build.tx_json.Flags).toBe(0x0004_0000);
    expect(build.tx_json.TakerPays).toEqual({ ...rlusd, value: "75" });
    expect(build.tx_json.TakerGets).toBe("271112288");
    expect(BigInt(build.tx_json.TakerGets)).toBeLessThanOrEqual(275000000n);
    expect(build.simulate.engine_result).toBe("tesSUCCESS");
    expect(build.delegable).toBe(true);
    expect(build.summary.usd_value).toBe("135.556144");
    expect(build.preflight.every(({ pass }: { pass: boolean }) => pass)).toBe(
      true,
    );
    expect(build.summary.est_slippage_bps).toBe(100);
    expect(build.preflight).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "flag-conflicts", pass: true }),
      ]),
    );
    const quoteCalls = request.mock.calls.filter(
      ([network, command]) => network === "testnet" && command === "ripple_path_find",
    );
    expect(quoteCalls).toHaveLength(1);
    expect(quoteCalls[0]?.[2]).toEqual({
      source_account: ACCOUNT,
      destination_account: ACCOUNT,
      destination_amount: { ...rlusd, value: "75" },
      source_currencies: [{ currency: "XRP" }],
      ledger_index: "validated",
    });
    expect(
      request.mock.calls.filter(
        ([network, command]) => network === "testnet" && command === "book_offers",
      ),
    ).toHaveLength(0);
  });

  it("rejects exact-output FOK when validated path liquidity is insufficient", async () => {
    const { ctx, request, insertBuild } = fixtureContext({
      quoteSourceAmount: null,
    });
    const rlusd = {
      currency: RLUSD_HEX,
      issuer: TESTNET_RLUSD_ISSUER,
    };

    await expect(
      invoke("tx.swap", ctx, {
        network: "testnet",
        account: ACCOUNT,
        sell: { currency: "XRP" },
        buy: rlusd,
        amount: { ...rlusd, value: "75" },
        side: "buy",
        max_slippage_bps: 100,
        execution_mode: "fill_or_kill",
      }),
    ).rejects.toMatchObject({ code: "QUOTE_UNAVAILABLE" });
    expect(
      request.mock.calls.filter(([, command]) => command === "simulate"),
    ).toHaveLength(0);
    expect(insertBuild).not.toHaveBeenCalled();
  });

  it("uses the fee-inclusive path source amount exactly once", async () => {
    const source = { currency: "USD", issuer: ISSUER };
    const rlusd = {
      currency: RLUSD_HEX,
      issuer: TESTNET_RLUSD_ISSUER,
    };
    const { ctx } = fixtureContext({
      // rippled marks issued source_amount with the source account as issuer;
      // the requested issuer is restored only after that marker is verified.
      quoteSourceAmount: {
        currency: source.currency,
        issuer: ACCOUNT,
        value: "252.5",
      },
    });
    const build = (await invoke("tx.swap", ctx, {
      network: "testnet",
      account: ACCOUNT,
      sell: source,
      buy: rlusd,
      amount: { ...rlusd, value: "75" },
      side: "buy",
      max_slippage_bps: 100,
      execution_mode: "fill_or_kill",
    })) as Record<string, any>;

    expect(build.tx_json.TakerGets).toEqual({
      ...source,
      value: "255.025",
    });
    expect(build.tx_json.TakerPays).toEqual({ ...rlusd, value: "75" });

    const wrongSourceMarker = fixtureContext({
      quoteSourceAmount: {
        currency: source.currency,
        issuer: DESTINATION,
        value: "252.5",
      },
    });
    await expect(
      invoke("tx.swap", wrongSourceMarker.ctx, {
        network: "testnet",
        account: ACCOUNT,
        sell: source,
        buy: rlusd,
        amount: { ...rlusd, value: "75" },
        side: "buy",
        max_slippage_bps: 100,
        execution_mode: "fill_or_kill",
      }),
    ).rejects.toMatchObject({ code: "QUOTE_UNAVAILABLE" });
  });

  it("applies a reproducible 15-significant-digit issued-source ceiling", async () => {
    const source = { currency: "USD", issuer: ISSUER };
    const rlusd = {
      currency: RLUSD_HEX,
      issuer: TESTNET_RLUSD_ISSUER,
    };
    const { ctx } = fixtureContext({
      quoteSourceAmount: {
        currency: source.currency,
        issuer: ACCOUNT,
        value: "1.234567890123456",
      },
    });
    const build = (await invoke("tx.swap", ctx, {
      network: "testnet",
      account: ACCOUNT,
      sell: source,
      buy: rlusd,
      amount: { ...rlusd, value: "75" },
      side: "buy",
      max_slippage_bps: 1,
      execution_mode: "fill_or_kill",
    })) as Record<string, any>;

    expect(build.tx_json.TakerGets).toEqual({
      ...source,
      value: "1.23469134691247",
    });
  });

  it("rounds an XRP exact-output spend ceiling upward to the next drop", async () => {
    const rlusd = {
      currency: RLUSD_HEX,
      issuer: TESTNET_RLUSD_ISSUER,
    };
    const { ctx } = fixtureContext({ quoteSourceAmount: "250000001" });
    const build = (await invoke("tx.swap", ctx, {
      network: "testnet",
      account: ACCOUNT,
      sell: { currency: "XRP" },
      buy: rlusd,
      amount: { ...rlusd, value: "75" },
      side: "buy",
      max_slippage_bps: 1,
      execution_mode: "fill_or_kill",
    })) as Record<string, any>;

    expect(build.tx_json.TakerGets).toBe("250025002");
  });

  it("rejects an unvalidated quote and a quote stale by final FOK simulation", async () => {
    const rlusd = {
      currency: RLUSD_HEX,
      issuer: TESTNET_RLUSD_ISSUER,
    };
    const args = {
      network: "testnet",
      account: ACCOUNT,
      sell: { currency: "XRP" },
      buy: rlusd,
      amount: { ...rlusd, value: "75" },
      side: "buy",
      max_slippage_bps: 100,
      execution_mode: "fill_or_kill",
    };
    const unvalidated = fixtureContext({
      quoteResult: {
        validated: false,
        full_reply: true,
        ledger_index: 90_000_000,
        ledger_hash: "A".repeat(64),
        source_account: ACCOUNT,
        destination_account: ACCOUNT,
        destination_amount: { ...rlusd, value: "75" },
        alternatives: [{ source_amount: "250000000" }],
      },
    });
    await expect(invoke("tx.swap", unvalidated.ctx, args)).rejects.toMatchObject({
      code: "QUOTE_STALE",
    });
    expect(unvalidated.insertBuild).not.toHaveBeenCalled();

    const changedBeforeSimulation = fixtureContext({
      quoteSourceAmount: "250000000",
      simulateResult: {
        engine_result: "tecKILLED",
        engine_result_message: "The offer could not be fully filled.",
        applied: false,
      },
    });
    await expect(
      invoke("tx.swap", changedBeforeSimulation.ctx, args),
    ).rejects.toMatchObject({ code: "SIMULATION_FAILED" });
    expect(
      changedBeforeSimulation.request.mock.calls.filter(
        ([, command]) => command === "simulate",
      ),
    ).toHaveLength(1);
    expect(changedBeforeSimulation.insertBuild).not.toHaveBeenCalled();
  });

  it.each([
    ["zero ledger", { ledger_index: 0 }],
    ["missing ledger hash", { ledger_hash: undefined }],
    ["wrong source account", { source_account: DESTINATION }],
    ["wrong destination account", { destination_account: DESTINATION }],
    [
      "wrong destination amount",
      {
        destination_amount: {
          currency: RLUSD_HEX,
          issuer: TESTNET_RLUSD_ISSUER,
          value: "74",
        },
      },
    ],
  ])("rejects quote provenance with a %s", async (_label, override) => {
    const rlusd = {
      currency: RLUSD_HEX,
      issuer: TESTNET_RLUSD_ISSUER,
    };
    const { ctx, insertBuild } = fixtureContext({
      quoteResult: {
        validated: true,
        full_reply: true,
        ledger_index: 90_000_000,
        ledger_hash: "A".repeat(64),
        source_account: ACCOUNT,
        destination_account: ACCOUNT,
        destination_amount: { ...rlusd, value: "75" },
        alternatives: [{ source_amount: "250000000" }],
        ...override,
      },
    });

    await expect(
      invoke("tx.swap", ctx, {
        network: "testnet",
        account: ACCOUNT,
        sell: { currency: "XRP" },
        buy: rlusd,
        amount: { ...rlusd, value: "75" },
        side: "buy",
        max_slippage_bps: 100,
        execution_mode: "fill_or_kill",
      }),
    ).rejects.toMatchObject({ code: "QUOTE_STALE" });
    expect(insertBuild).not.toHaveBeenCalled();
  });

  it.each([
    ["older than one ledger", 89_999_998],
    ["newer than the build ledger", 90_000_001],
  ])("rejects a quote reference %s", async (_label, quoteLedgerIndex) => {
    const rlusd = {
      currency: RLUSD_HEX,
      issuer: TESTNET_RLUSD_ISSUER,
    };
    const { ctx, request, insertBuild } = fixtureContext({
      quoteResult: {
        validated: true,
        full_reply: true,
        ledger_index: quoteLedgerIndex,
        ledger_hash: "B".repeat(64),
        source_account: ACCOUNT,
        destination_account: ACCOUNT,
        destination_amount: { ...rlusd, value: "75" },
        alternatives: [{ source_amount: "250000000" }],
      },
    });

    await expect(
      invoke("tx.swap", ctx, {
        network: "testnet",
        account: ACCOUNT,
        sell: { currency: "XRP" },
        buy: rlusd,
        amount: { ...rlusd, value: "75" },
        side: "buy",
        max_slippage_bps: 100,
        execution_mode: "fill_or_kill",
      }),
    ).rejects.toMatchObject({ code: "STALE_LEDGER_REFERENCE" });
    expect(
      request.mock.calls.filter(([, command]) => command === "simulate"),
    ).toHaveLength(0);
    expect(insertBuild).not.toHaveBeenCalled();
  });

  it("builds a fixed-sell 50 RLUSD for XRP Fill-or-Kill swap with tfSell", async () => {
    const { ctx } = fixtureContext();
    const rlusd = {
      currency: RLUSD_HEX,
      issuer: TESTNET_RLUSD_ISSUER,
    };
    const build = (await invoke("tx.swap", ctx, {
      network: "testnet",
      account: ACCOUNT,
      sell: rlusd,
      buy: { currency: "XRP" },
      amount: { ...rlusd, value: "50" },
      side: "sell",
      max_slippage_bps: 100,
      execution_mode: "fill_or_kill",
    })) as Record<string, any>;

    expect(build.tx_json.Flags).toBe(0x000c_0000);
    expect(build.tx_json.Flags & 0x0002_0000).toBe(0);
    expect(build.tx_json.TakerGets).toEqual({ ...rlusd, value: "50" });
    expect(build.tx_json.TakerPays).toBe("99000000");
    expect(build.delegable).toBe(true);
    expect(build.summary.usd_value).toBe("50");
    const policy = delegatedSwapPolicy(build as TxBuild, 50);
    expect({
      verdict: policy.verdict,
      failures: policy.reasons.filter(({ pass }) => !pass),
    }).toEqual({ verdict: "execute", failures: [] });
    expect(build.preflight).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "flag-conflicts", pass: true }),
      ]),
    );
  });

  it("builds a fixed-sell 20 RLUSD for XRP Fill-or-Kill swap with tfSell", async () => {
    const { ctx } = fixtureContext();
    const rlusd = {
      currency: RLUSD_HEX,
      issuer: TESTNET_RLUSD_ISSUER,
    };
    const build = (await invoke("tx.swap", ctx, {
      network: "testnet",
      account: ACCOUNT,
      sell: rlusd,
      buy: { currency: "XRP" },
      amount: { ...rlusd, value: "20" },
      side: "sell",
      max_slippage_bps: 100,
      execution_mode: "fill_or_kill",
    })) as Record<string, any>;

    expect(build.tx_json.Flags).toBe(0x000c_0000);
    expect(build.tx_json.Flags & 0x0002_0000).toBe(0);
    expect(build.tx_json.TakerGets).toEqual({ ...rlusd, value: "20" });
    expect(build.tx_json.TakerPays).toBe("39600000");
    expect(build.delegable).toBe(true);
    expect(build.summary.usd_value).toBe("20");
    const policy = delegatedSwapPolicy(build as TxBuild, 20);
    expect({
      verdict: policy.verdict,
      failures: policy.reasons.filter(({ pass }) => !pass),
    }).toEqual({ verdict: "execute", failures: [] });
    expect(build.preflight).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "flag-conflicts", pass: true }),
      ]),
    );
  });

  it("accepts Fill-or-Kill raw offers without reserving a persistent offer object", async () => {
    const { ctx } = fixtureContext();
    const build = (await invoke("tx.simulate", ctx, {
      network: "testnet",
      account: ACCOUNT,
      tx_json: {
        TransactionType: "OfferCreate",
        Account: ACCOUNT,
        TakerGets: "50000000",
        TakerPays: { currency: "USD", issuer: ISSUER, value: "10" },
        Flags: 0x0004_0000,
      },
    })) as Record<string, any>;

    expect(build.tx_json.Flags).toBe(0x0004_0000);
    expect(build.summary.reserve_delta_drops).toBe("0");
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
    const swap = {
      network: "testnet",
      account: ACCOUNT,
      sell: { currency: "XRP" },
      buy: { currency: "USD", issuer: ISSUER },
      amount: "1000000",
      side: "sell",
      max_slippage_bps: 100,
    };
    expect(
      operation("tx.swap").args.safeParse({
        ...swap,
        execution_mode: "immediate_or_cancel",
      }).success,
    ).toBe(true);
    expect(
      operation("tx.swap").args.safeParse({
        ...swap,
        execution_mode: "fill_or_kill",
      }).success,
    ).toBe(true);
    expect(
      operation("tx.swap").args.safeParse({
        ...swap,
        execution_mode: "good_till_cancelled",
      }).success,
    ).toBe(false);
    expect(
      operation("tx.swap").args.safeParse({
        ...swap,
        executionMode: "fill_or_kill",
      }).success,
    ).toBe(false);
    expect(
      operation("tx.simulate").args.safeParse({
        network: "testnet",
        account: ACCOUNT,
        tx_json: {
          TransactionType: "OfferCreate",
          Account: ACCOUNT,
          TakerGets: "50000000",
          TakerPays: { currency: "USD", issuer: ISSUER, value: "10" },
          Flags: 0x0004_0000,
        },
      }).success,
    ).toBe(true);
    expect(
      operation("tx.simulate").args.safeParse({
        network: "testnet",
        account: ACCOUNT,
        tx_json: {
          TransactionType: "OfferCreate",
          Account: ACCOUNT,
          TakerGets: "50000000",
          TakerPays: { currency: "USD", issuer: ISSUER, value: "10" },
          Flags: 0x0002_0000 | 0x0004_0000,
        },
      }).success,
    ).toBe(false);
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
