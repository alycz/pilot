import { describe, expect, it, vi } from "vitest";

import type { OpContext } from "../src/catalog/registry";
import { ops } from "../src/ops/dex";

const USD_ISSUER = "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B";
const SOURCE_ACCOUNT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const DESTINATION_ACCOUNT = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

function operation(name: string) {
  const op = ops.find((candidate) => candidate.name === name);
  if (!op) throw new Error(`missing operation ${name}`);
  return op;
}

function contextWithFixture(result: Record<string, unknown>) {
  const request = vi.fn(async () => result);
  const ctx: OpContext = {
    principal: "dex-unit-test",
    xrplRpc: { request },
  };
  return { ctx, request };
}

// Recorded response from the official book_offers command reference. Tests
// replay it through the injected adapter and never contact an XRPL endpoint.
const RECORDED_BOOK_FIXTURE = {
  ledger_current_index: 7_035_305,
  offers: [
    {
      Account: "rM3X3QSr8icjTGpaF52dozhbT2BZSXJQYM",
      BookDirectory:
        "7E5F614417C2D0A7CEFEB73C4AA773ED5B078DE2B5771F6D55055E4C405218EB",
      BookNode: "0000000000000000",
      Flags: 0,
      LedgerEntryType: "Offer",
      OwnerNode: "0000000000000AE0",
      PreviousTxnID:
        "6956221794397C25A53647182E5C78A439766D600724074C99D78982E37599F1",
      PreviousTxnLgrSeq: 7_022_646,
      Sequence: 264_542,
      TakerGets: {
        currency: "EUR",
        issuer: USD_ISSUER,
        value: "17.90363633316433",
      },
      TakerPays: {
        currency: "USD",
        issuer: USD_ISSUER,
        value: "27.05340557506234",
      },
      index:
        "96A9104BF3137131FF8310B9174F3B37170E2144C813CA2A1695DF2C5677E811",
      quality: "1.511056473200875",
    },
    {
      Account: "rhsxKNyN99q6vyYCTHNTC1TqWCeHr7PNgp",
      BookDirectory:
        "7E5F614417C2D0A7CEFEB73C4AA773ED5B078DE2B5771F6D5505DCAA8FE12000",
      BookNode: "0000000000000000",
      Flags: 131_072,
      LedgerEntryType: "Offer",
      OwnerNode: "0000000000000001",
      PreviousTxnID:
        "8AD748CD489F7FF34FCD4FB73F77F1901E27A6EFA52CCBB0CCDAAB934E5E754D",
      PreviousTxnLgrSeq: 7_007_546,
      Sequence: 265,
      TakerGets: {
        currency: "EUR",
        issuer: USD_ISSUER,
        value: "2.542743233917848",
      },
      TakerPays: {
        currency: "USD",
        issuer: USD_ISSUER,
        value: "4.19552633596446",
      },
      index:
        "7001797678E886E22D6DE11AF90DF1E08F4ADC21D763FAFB36AF66894D695235",
      quality: "1.65",
    },
  ],
};

// Purpose-built replay fixture for exact funded-level aggregation edge cases.
const DEPTH_FIXTURE = {
  ledger_hash:
    "8BB204CE37CFA7A021A16B5F6143400831C4D1779E6FE538D9AC561ABBF4A929",
  ledger_index: 61_546_724,
  offers: [
    {
      Account: "rFirst",
      Sequence: 1,
      TakerGets: "2500000",
      TakerPays: { currency: "USD", issuer: USD_ISSUER, value: "1.25" },
      quality: "0.0000005",
    },
    {
      Account: "rSecond",
      Sequence: 2,
      TakerGets: "9000000",
      TakerPays: { currency: "USD", issuer: USD_ISSUER, value: "4.5" },
      taker_gets_funded: "1500000",
      taker_pays_funded: {
        currency: "USD",
        issuer: USD_ISSUER,
        value: "0.75",
      },
      quality: "0.0000005",
    },
    {
      Account: "rThird",
      Sequence: 3,
      TakerGets: "1000000",
      TakerPays: { currency: "USD", issuer: USD_ISSUER, value: "0.6" },
      quality: "0.0000006",
    },
  ],
};

describe("DEX operations", () => {
  it("sends dex.book to book_offers with validated-ledger defaults", async () => {
    const { ctx, request } = contextWithFixture(RECORDED_BOOK_FIXTURE);
    const result = await operation("dex.book").handler(ctx, {
      network: "testnet",
      taker_gets: { currency: "XRP" },
      taker_pays: { currency: "USD", issuer: USD_ISSUER },
      limit: 25,
    });

    expect(request).toHaveBeenCalledWith(
      "testnet",
      "book_offers",
      {
        taker_gets: { currency: "XRP" },
        taker_pays: { currency: "USD", issuer: USD_ISSUER },
        ledger_index: "validated",
        limit: 25,
      },
      undefined,
    );
    expect(result).toEqual(RECORDED_BOOK_FIXTURE);
  });

  it("sends dex.quote to path_find without transforming XRPL amounts", async () => {
    // Recorded initial response from the official path_find reference. Its
    // false full_reply is intentional: dex.quote is an indicative first pass.
    const fixture = {
      alternatives: [
        {
          paths_computed: [
            [
              { currency: "USD", issuer: "rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y", type: 48 },
              { account: "rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y", type: 1 },
              { account: "rLzpfEnrB2Ro2LtaGd6Af7znRqGxULc4rW", type: 1 },
            ],
            [
              { currency: "USD", issuer: USD_ISSUER, type: 48 },
            ],
          ],
          source_amount: "390",
        },
      ],
      destination_account: SOURCE_ACCOUNT,
      destination_amount: {
        currency: "USD",
        issuer: USD_ISSUER,
        value: "0.001",
      },
      source_account: SOURCE_ACCOUNT,
      full_reply: false,
    };
    const { ctx, request } = contextWithFixture(fixture);
    const args = operation("dex.quote").args.parse({
      network: "devnet",
      source_account: SOURCE_ACCOUNT,
      destination_account: SOURCE_ACCOUNT,
      destination_amount: {
        currency: "USD",
        issuer: USD_ISSUER,
        value: "0.001",
      },
      send_max: "3000000",
    });

    await expect(operation("dex.quote").handler(ctx, args)).resolves.toEqual(
      fixture,
    );
    expect(request).toHaveBeenCalledWith(
      "devnet",
      "path_find",
      {
        subcommand: "create",
        source_account: SOURCE_ACCOUNT,
        destination_account: SOURCE_ACCOUNT,
        destination_amount: {
          currency: "USD",
          issuer: USD_ISSUER,
          value: "0.001",
        },
        send_max: "3000000",
      },
      undefined,
    );
  });

  it("aggregates funded offers at equal quality without floating-point loss", async () => {
    const { ctx } = contextWithFixture(DEPTH_FIXTURE);

    await expect(
      operation("dex.depth").handler(ctx, {
        network: "mainnet",
        taker_gets: { currency: "XRP" },
        taker_pays: { currency: "USD", issuer: USD_ISSUER },
      }),
    ).resolves.toEqual({
      network: "mainnet",
      taker_gets: { currency: "XRP" },
      taker_pays: { currency: "USD", issuer: USD_ISSUER },
      ledger_hash: DEPTH_FIXTURE.ledger_hash,
      ledger_index: DEPTH_FIXTURE.ledger_index,
      levels: [
        {
          price: "0.5",
          quality: "0.0000005",
          taker_gets: "4000000",
          taker_pays: "2",
          offer_count: 2,
        },
        {
          price: "0.6",
          quality: "0.0000006",
          taker_gets: "1000000",
          taker_pays: "0.6",
          offer_count: 1,
        },
      ],
      totals: {
        taker_gets: "5000000",
        taker_pays: "2.6",
        offer_count: 3,
      },
    });
  });

  it("normalizes depth price when XRP is the taker-pays asset", async () => {
    const reverseBook = {
      ledger_index: 61_546_725,
      offers: [
        {
          TakerGets: { currency: "USD", issuer: USD_ISSUER, value: "2" },
          TakerPays: "1000000",
          quality: "500000",
        },
      ],
    };
    const { ctx } = contextWithFixture(reverseBook);
    const result = await operation("dex.depth").handler(ctx, {
      network: "testnet",
      taker_gets: { currency: "USD", issuer: USD_ISSUER },
      taker_pays: { currency: "XRP" },
    });

    expect(result).toMatchObject({
      levels: [{ price: "0.5", quality: "500000" }],
      totals: { taker_gets: "2", taker_pays: "1000000" },
    });
  });

  it("strictly rejects invalid networks, asset shapes, and amount encodings", () => {
    const book = operation("dex.book");
    const quote = operation("dex.quote");

    expect(() =>
      book.args.parse({
        network: "sidechain",
        taker_gets: { currency: "XRP" },
        taker_pays: { currency: "USD", issuer: USD_ISSUER },
      }),
    ).toThrow();
    expect(() =>
      book.args.parse({
        network: "testnet",
        taker_gets: { currency: "XRP", issuer: USD_ISSUER },
        taker_pays: { currency: "RLUSD", issuer: USD_ISSUER },
      }),
    ).toThrow();
    expect(() =>
      quote.args.parse({
        network: "testnet",
        source_account: SOURCE_ACCOUNT,
        destination_account: DESTINATION_ACCOUNT,
        destination_amount: "1.5",
      }),
    ).toThrow();
    expect(() =>
      quote.args.parse({
        network: "testnet",
        source_account: SOURCE_ACCOUNT,
        destination_account: DESTINATION_ACCOUNT,
        destination_amount: {
          currency: "USD",
          issuer: USD_ISSUER,
          value: 1,
        },
      }),
    ).toThrow();
    expect(() =>
      book.args.parse({
        network: "testnet",
        taker_gets: { currency: "XRP" },
        taker_pays: { currency: "USD", issuer: USD_ISSUER },
        ledger_index: "current",
      }),
    ).toThrow();
  });

  it("accepts a 40-hex issued currency and rejects send_max with source_currencies", async () => {
    const quote = operation("dex.quote");
    const args = quote.args.parse({
      network: "testnet",
      source_account: SOURCE_ACCOUNT,
      destination_account: DESTINATION_ACCOUNT,
      destination_amount: {
        currency: "524C555344000000000000000000000000000000",
        issuer: USD_ISSUER,
        value: "10",
      },
      send_max: "10000000",
      source_currencies: [{ currency: "XRP" }],
    });
    const { ctx, request } = contextWithFixture({ alternatives: [] });

    await expect(quote.handler(ctx, args)).rejects.toThrow(/not compatible/i);
    expect(request).not.toHaveBeenCalled();
  });
});
