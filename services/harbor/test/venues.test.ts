import { describe, expect, it, vi } from "vitest";

import catalogManifest from "../catalog/manifest.json";
import type { OpContext } from "../src/catalog/registry";
import { VenueSchema, type Venue } from "../src/contracts";
import { ops } from "../src/ops/venues";

const RLUSD_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const RLUSD_CURRENCY = "524C555344000000000000000000000000000000";
const QUOTE_ACCOUNT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";

const expectedVenueIds = [
  "doppler-finance",
  "first-ledger",
  "horizon",
  "hyperliquid-xrp-perps",
  "magnetic-x",
  "marsgate",
  "moai-finance",
  "orchestra-finance",
  "securd",
  "soil",
  "strobe",
  "tx-network-sologenic",
  "xpmarket",
  "xrpl-amm",
  "xrpl-checks",
  "xrpl-dex-clob",
  "xrpl-escrow",
  "xrpl-evm",
  "xrpl-lending",
  "xrpl-payments",
  "xrpl-permissioned-dex",
  "xrpl-single-asset-vault",
  "xrpl-x402",
] as const;

const ctx = { principal: "venues-unit-test" };

function operation(name: "venues.list" | "venues.get" | "venues.compare") {
  const op = ops.find((candidate) => candidate.name === name);
  if (!op) throw new Error(`Missing operation: ${name}`);
  return op;
}

describe("venue operations", () => {
  it("exports all three venue operations", () => {
    expect(ops.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["venues.list", "venues.get", "venues.compare"]),
    );
  });

  it("lists all 23 schema-valid manifest venues in stable id order", async () => {
    const list = operation("venues.list");
    expect(list.args.safeParse({}).success).toBe(true);
    expect(list.args.safeParse({ category: "spot" }).success).toBe(false);

    const result = (await list.handler(ctx, {})) as Venue[];

    expect(result).toHaveLength(23);
    expect(result.map(({ id }) => id)).toEqual(expectedVenueIds);
    expect(result).toEqual(VenueSchema.array().parse(catalogManifest.venues));
    expect(result.every((venue) => VenueSchema.safeParse(venue).success)).toBe(
      true,
    );
    expect(result).not.toBe(catalogManifest.venues);
  });

  it("gets an exact venue by id and returns defensive copies", async () => {
    const get = operation("venues.get");
    const manifestVenue = VenueSchema.parse(catalogManifest.venues[0]);
    expect(get.args.safeParse({ id: manifestVenue.id }).success).toBe(true);
    expect(get.args.safeParse({ id: "" }).success).toBe(false);
    expect(get.args.safeParse({ id: manifestVenue.id, extra: true }).success).toBe(
      false,
    );

    const first = (await get.handler(ctx, { id: manifestVenue.id })) as Venue;
    const second = (await get.handler(ctx, { id: manifestVenue.id })) as Venue;

    expect(first).toEqual(manifestVenue);
    expect(VenueSchema.safeParse(first).success).toBe(true);
    expect(first).not.toBe(second);
    expect(first.status).not.toBe(second.status);
    expect(first.links).not.toBe(second.links);
  });

  it("fails clearly when a venue id is not in the manifest", () => {
    expect(() =>
      operation("venues.get").handler(ctx, { id: "not-a-venue" }),
    ).toThrow("Unknown venue: not-a-venue");
  });

  it("returns priced order-book, AMM, and path routes for XRP/RLUSD", async () => {
    // Offline fixtures mirror the documented book_offers, amm_info, and
    // path_find response shapes. No XRPL endpoint is contacted by this test.
    const fixtures: Record<string, Record<string, unknown>> = {
      book_offers: {
        ledger_index: 12_345,
        offers: [
          {
            Account: QUOTE_ACCOUNT,
            TakerGets: {
              currency: RLUSD_CURRENCY,
              issuer: RLUSD_ISSUER,
              value: "100",
            },
            TakerPays: "1000000",
            quality: "10000",
          },
          {
            TakerGets: {
              currency: RLUSD_CURRENCY,
              issuer: RLUSD_ISSUER,
              value: "5",
            },
            TakerPays: "4000000",
            quality: "800000",
          },
          {
            TakerGets: {
              currency: RLUSD_CURRENCY,
              issuer: RLUSD_ISSUER,
              value: "10",
            },
            TakerPays: "8000000",
            quality: "800000",
          },
        ],
      },
      amm_info: {
        ledger_index: 12_345,
        validated: true,
        amm: {
          account: "rp9E3FN3gNmvePGhYnf414T2TkUuoxu8vM",
          amount: "1000000000",
          amount2: {
            currency: RLUSD_CURRENCY,
            issuer: RLUSD_ISSUER,
            value: "1000",
          },
          lp_token: {
            currency: "039C99CD9AB0B70B32ECDA51EAAE471625608EA2",
            issuer: "rp9E3FN3gNmvePGhYnf414T2TkUuoxu8vM",
            value: "1000",
          },
          trading_fee: 300,
        },
      },
      path_find: {
        source_account: QUOTE_ACCOUNT,
        destination_account: QUOTE_ACCOUNT,
        destination_amount: {
          currency: RLUSD_CURRENCY,
          issuer: RLUSD_ISSUER,
          value: "-1",
        },
        alternatives: [
          {
            source_amount: "10000000",
            destination_amount: {
              currency: RLUSD_CURRENCY,
              issuer: RLUSD_ISSUER,
              value: "12.6",
            },
            paths_computed: [[{ currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER }]],
          },
        ],
        full_reply: false,
      },
    };
    const request = vi.fn(
      async (_network: string, command: string) => fixtures[command]!,
    );
    const compare = operation("venues.compare");
    const args = compare.args.parse({
      network: "testnet",
      account: QUOTE_ACCOUNT,
      base: { currency: "XRP" },
      quote: { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER },
      size: "10000000",
    });

    const result = await compare.handler(
      {
        principal: "venues-unit-test",
        xrplRpc: { request },
      } as OpContext,
      args,
    );

    expect(result).toMatchObject({
      network: "testnet",
      pair: {
        base: { currency: "XRP" },
        quote: { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER },
      },
      size: "10000000",
      routes: [
        {
          kind: "order-book",
          venue_id: "xrpl-dex-clob",
          source_amount: "10000000",
          destination_amount: {
            currency: RLUSD_CURRENCY,
            issuer: RLUSD_ISSUER,
            value: "12.5",
          },
          price: "1.25",
          offers_consumed: 2,
        },
        {
          kind: "amm",
          venue_id: "xrpl-amm",
          source_amount: "10000000",
          destination_amount: {
            currency: RLUSD_CURRENCY,
            issuer: RLUSD_ISSUER,
            value: "9.871580343970612",
          },
          price: "0.9871580343970612",
          trading_fee: 300,
        },
        {
          kind: "path",
          venue_id: "xrpl-payments",
          source_amount: "10000000",
          destination_amount: {
            currency: RLUSD_CURRENCY,
            issuer: RLUSD_ISSUER,
            value: "12.6",
          },
          price: "1.26",
          full_reply: false,
          path_count: 1,
        },
      ],
    });
    expect(
      (result as { routes: { price: string }[] }).routes.every(
        ({ price }) => Number(price) > 0,
      ),
    ).toBe(true);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenCalledWith(
      "testnet",
      "book_offers",
      {
        taker_gets: { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER },
        taker_pays: { currency: "XRP" },
        taker: QUOTE_ACCOUNT,
        ledger_index: "validated",
        limit: 400,
      },
      undefined,
    );
    expect(request).toHaveBeenCalledWith(
      "testnet",
      "amm_info",
      {
        asset: { currency: "XRP" },
        asset2: { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER },
        ledger_index: "validated",
      },
      undefined,
    );
    expect(request).toHaveBeenCalledWith(
      "testnet",
      "path_find",
      {
        subcommand: "create",
        source_account: QUOTE_ACCOUNT,
        destination_account: QUOTE_ACCOUNT,
        destination_amount: {
          currency: RLUSD_CURRENCY,
          issuer: RLUSD_ISSUER,
          value: "-1",
        },
        send_max: "10000000",
      },
      undefined,
    );
  });

  it("strictly validates compare pair, XRP size, account, and extra keys", () => {
    const compare = operation("venues.compare");
    const valid = {
      network: "testnet",
      account: QUOTE_ACCOUNT,
      base: { currency: "XRP" },
      quote: { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER },
      size: "10000000",
    };

    expect(compare.args.safeParse(valid).success).toBe(true);
    expect(compare.args.safeParse({ ...valid, network: "mainnet" }).success).toBe(
      true,
    );
    expect(
      compare.args.safeParse({ ...valid, network: "lending-devnet" }).success,
    ).toBe(false);
    expect(compare.args.safeParse({ ...valid, size: "1.5" }).success).toBe(false);
    expect(compare.args.safeParse({ ...valid, account: "not-an-address" }).success).toBe(false);
    expect(
      compare.args.safeParse({ ...valid, quote: { currency: "XRP" } }).success,
    ).toBe(false);
    expect(
      compare.args.safeParse({
        ...valid,
        base: { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER },
        quote: { currency: "XRP" },
        size: "1e100000000",
      }).success,
    ).toBe(false);
    expect(compare.args.safeParse({ ...valid, unexpected: true }).success).toBe(false);
  });

  it("rejects a direct lending-devnet handler call before reaching the XRPL adapter", () => {
    const request = vi.fn();

    expect(() =>
      operation("venues.compare").handler(
        { principal: "venues-unit-test", xrplRpc: { request } } as OpContext,
        {
          network: "lending-devnet",
          account: QUOTE_ACCOUNT,
          base: { currency: "XRP" },
          quote: { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER },
          size: "10000000",
        } as never,
      ),
    ).toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects partial-size and malformed path fixtures", async () => {
    const book = {
      offers: [
        {
          Account: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
          TakerGets: {
            currency: RLUSD_CURRENCY,
            issuer: RLUSD_ISSUER,
            value: "10",
          },
          TakerPays: "10000000",
          quality: "1000000",
        },
      ],
    };
    const amm = {
      amm: {
        amount: "1000000000",
        amount2: {
          currency: RLUSD_CURRENCY,
          issuer: RLUSD_ISSUER,
          value: "1000",
        },
        trading_fee: 300,
      },
    };
    const validAlternative = {
      source_amount: "10000000",
      destination_amount: {
        currency: RLUSD_CURRENCY,
        issuer: RLUSD_ISSUER,
        value: "10",
      },
      paths_computed: [[]],
    };
    const invalidPaths = [
      {
        full_reply: false,
        alternatives: [
          { ...validAlternative, source_amount: "9000000" },
        ],
      },
      { full_reply: "false", alternatives: [validAlternative] },
      {
        full_reply: false,
        alternatives: [{ ...validAlternative, paths_computed: [["bad-step"]] }],
      },
      {
        full_reply: false,
        alternatives: [
          {
            ...validAlternative,
            destination_amount: {
              ...validAlternative.destination_amount,
              unexpected: true,
            },
          },
        ],
      },
    ];
    const compare = operation("venues.compare");
    const args = compare.args.parse({
      network: "testnet",
      account: QUOTE_ACCOUNT,
      base: { currency: "XRP" },
      quote: { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER },
      size: "10000000",
    });

    for (const path of invalidPaths) {
      const request = vi.fn(async (_network: string, command: string) => {
        if (command === "book_offers") return book;
        if (command === "amm_info") return amm;
        return path;
      });
      await expect(
        compare.handler(
          { principal: "venues-unit-test", xrplRpc: { request } } as OpContext,
          args,
        ),
      ).rejects.toThrow();
    }
  });

  it("rejects frozen or malformed AMM fixtures", async () => {
    const book = {
      offers: [
        {
          TakerGets: {
            currency: RLUSD_CURRENCY,
            issuer: RLUSD_ISSUER,
            value: "10",
          },
          TakerPays: "10000000",
          quality: "1000000",
        },
      ],
    };
    const path = {
      full_reply: false,
      alternatives: [
        {
          source_amount: "10000000",
          destination_amount: {
            currency: RLUSD_CURRENCY,
            issuer: RLUSD_ISSUER,
            value: "10",
          },
          paths_computed: [[]],
        },
      ],
    };
    const validAmm = {
      amount: "1000000000",
      amount2: {
        currency: RLUSD_CURRENCY,
        issuer: RLUSD_ISSUER,
        value: "1000",
      },
      trading_fee: 300,
    };
    const invalidAmms = [
      { ...validAmm, asset2_frozen: true },
      { ...validAmm, trading_fee: "300" },
      {
        ...validAmm,
        amount2: { ...validAmm.amount2, unexpected: true },
      },
    ];
    const compare = operation("venues.compare");
    const args = compare.args.parse({
      network: "testnet",
      account: QUOTE_ACCOUNT,
      base: { currency: "XRP" },
      quote: { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER },
      size: "10000000",
    });

    for (const amm of invalidAmms) {
      const request = vi.fn(async (_network: string, command: string) => {
        if (command === "book_offers") return book;
        if (command === "amm_info") return { amm };
        return path;
      });
      await expect(
        compare.handler(
          { principal: "venues-unit-test", xrplRpc: { request } } as OpContext,
          args,
        ),
      ).rejects.toThrow();
    }
  });

  it("rejects malformed or insufficient route fixtures instead of returning partial data", async () => {
    const request = vi.fn(async (_network: string, command: string) => {
      if (command === "book_offers") return { offers: [] };
      if (command === "amm_info") return { amm: {} };
      return { alternatives: [] };
    });
    const compare = operation("venues.compare");
    const args = compare.args.parse({
      network: "testnet",
      account: QUOTE_ACCOUNT,
      base: { currency: "XRP" },
      quote: { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER },
      size: "10000000",
    });

    await expect(
      compare.handler(
        { principal: "venues-unit-test", xrplRpc: { request } } as OpContext,
        args,
      ),
    ).rejects.toThrow(/insufficient funded liquidity/i);
  });
});
