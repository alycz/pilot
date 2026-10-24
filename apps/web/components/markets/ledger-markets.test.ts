import { describe, expect, it, vi } from "vitest";

import {
  assertReadOnly,
  endpointHost,
  LedgerClient,
  LedgerCommandNotAllowedError,
  LEDGER_ENDPOINTS,
  type SocketLike,
} from "./ledger-client";
import {
  ammFromInfo,
  issuerFromAccountInfo,
  levelsFromOffers,
  pairSnapshot,
  quoteRoutes,
  sellIntoAmm,
  serverInfoSummary,
} from "./ledger-markets";
import {
  MARKET_CATALOG,
  RLUSD_CURRENCY,
  RLUSD_MAINNET_ISSUER,
  USDC_CURRENCY,
  USDC_MAINNET_ISSUER,
  XRP_ASSET,
} from "./markets-catalog";

const RLUSD = { currency: RLUSD_CURRENCY, issuer: RLUSD_MAINNET_ISSUER };

/* Recorded-shape rippled results (values illustrative, shapes as returned). */

// book_offers taker_gets = XRP, taker_pays = RLUSD → offers selling XRP (asks).
const ASK_OFFERS = [
  {
    Account: "rAskerOne11111111111111111111111",
    BookDirectory: "AB…",
    Flags: 0,
    LedgerEntryType: "Offer",
    Sequence: 1,
    TakerGets: "2000000000", // 2,000 XRP
    TakerPays: { currency: RLUSD_CURRENCY, issuer: RLUSD_MAINNET_ISSUER, value: "4400" }, // 2.2
    index: "A1",
    owner_funds: "5000000000",
    quality: "0.0000022",
  },
  {
    Account: "rAskerTwo22222222222222222222222",
    Flags: 0,
    TakerGets: "1000000000", // 1,000 XRP nominal
    TakerPays: { currency: RLUSD_CURRENCY, issuer: RLUSD_MAINNET_ISSUER, value: "2210" }, // 2.21
    taker_gets_funded: "500000000", // only 500 XRP funded
    taker_pays_funded: { currency: RLUSD_CURRENCY, issuer: RLUSD_MAINNET_ISSUER, value: "1105" },
    quality: "0.00000221",
  },
];

// book_offers taker_gets = RLUSD, taker_pays = XRP → offers buying XRP (bids).
const BID_OFFERS = [
  {
    Account: "rBidderOne1111111111111111111111",
    TakerGets: { currency: RLUSD_CURRENCY, issuer: RLUSD_MAINNET_ISSUER, value: "2190" }, // 2.19
    TakerPays: "1000000000",
    quality: "456621.0045662100",
  },
  {
    Account: "rBidderTwo2222222222222222222222",
    TakerGets: { currency: RLUSD_CURRENCY, issuer: RLUSD_MAINNET_ISSUER, value: "4360" }, // 2.18
    TakerPays: "2000000000",
    quality: "458715.5963302752",
  },
  {
    Account: "rBidderDup3333333333333333333333",
    TakerGets: { currency: RLUSD_CURRENCY, issuer: RLUSD_MAINNET_ISSUER, value: "2180" }, // 2.18 again → merged
    TakerPays: "1000000000",
    quality: "458715.5963302752",
  },
  { Account: "rUnfunded", TakerGets: { currency: RLUSD_CURRENCY, issuer: RLUSD_MAINNET_ISSUER, value: "0" }, TakerPays: "1000000" },
];

const AMM_INFO = {
  amm: {
    account: "rAMMpoolAccount1111111111111111",
    amount: "5000000000000", // 5,000,000 XRP
    amount2: { currency: RLUSD_CURRENCY, issuer: RLUSD_MAINNET_ISSUER, value: "11000000" }, // 2.2
    asset2_frozen: false,
    auction_slot: {},
    lp_token: { currency: "03930D02208264E2E40EC1B0C09E4DB96EE197B1", issuer: "rAMMpoolAccount1111111111111111", value: "7416198.487" },
    trading_fee: 500,
    vote_slots: [],
  },
  ledger_current_index: 95000001,
  validated: false,
};

describe("ledger client allowlist", () => {
  it("allows only read commands and the ledger stream", () => {
    for (const command of ["server_info", "book_offers", "amm_info", "account_info", "gateway_balances"]) {
      expect(() => assertReadOnly(command)).not.toThrow();
    }
    expect(() => assertReadOnly("subscribe", { streams: ["ledger"] })).not.toThrow();
    expect(() => assertReadOnly("unsubscribe", { streams: ["ledger"] })).not.toThrow();
  });

  it("refuses anything that could sign, submit or stream accounts", () => {
    for (const command of ["submit", "submit_multisigned", "sign", "sign_for", "wallet_propose", "path_find", "ripple_path_find", "tx", "channel_authorize"]) {
      expect(() => assertReadOnly(command)).toThrow(LedgerCommandNotAllowedError);
    }
    expect(() => assertReadOnly("subscribe", { streams: ["transactions"] })).toThrow(LedgerCommandNotAllowedError);
    expect(() => assertReadOnly("subscribe", { streams: ["ledger"], accounts: ["r1"] })).toThrow(LedgerCommandNotAllowedError);
    expect(() => assertReadOnly("subscribe", { streams: ["ledger", "transactions"] })).toThrow(LedgerCommandNotAllowedError);
  });

  it("uses the documented public endpoints", () => {
    expect(LEDGER_ENDPOINTS.mainnet).toEqual(["wss://xrplcluster.com", "wss://s1.ripple.com", "wss://s2.ripple.com"]);
    expect(LEDGER_ENDPOINTS.testnet).toEqual(["wss://s.altnet.rippletest.net:51233"]);
    expect(endpointHost("wss://s.altnet.rippletest.net:51233")).toBe("s.altnet.rippletest.net:51233");
  });
});

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  fail() {
    this.readyState = 3;
    this.onclose?.({});
  }
  reply(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function harness(endpoints: readonly string[]) {
  const sockets: FakeSocket[] = [];
  const statuses: string[] = [];
  const ledgers: number[] = [];
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  const client = new LedgerClient({
    endpoints,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    onStatus: (status) => statuses.push(status),
    onLedgerClosed: (index) => ledgers.push(index),
    setTimer: (callback, ms) => {
      const entry = { callback, ms, cleared: false };
      timers.push(entry);
      return entry as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (handle) => {
      (handle as unknown as { cleared: boolean }).cleared = true;
    },
    now: () => 0,
  });
  const runTimers = () => {
    for (const timer of timers.splice(0)) if (!timer.cleared) timer.callback();
  };
  return { client, sockets, statuses, ledgers, runTimers };
}

describe("ledger client", () => {
  it("sends allowlisted requests with ids and resolves results", async () => {
    const { client, sockets } = harness(["wss://one"]);
    const connected = client.connect();
    sockets[0]!.open();
    await connected;
    const pending = client.request("book_offers", { taker_gets: { currency: "XRP" }, taker_pays: RLUSD, limit: 50 });
    const sent = sockets[0]!.sent[0]!;
    expect(sent.command).toBe("book_offers");
    expect(typeof sent.id).toBe("number");
    sockets[0]!.reply({ id: sent.id, type: "response", status: "success", result: { offers: ASK_OFFERS } });
    const response = await pending;
    expect(response.result).toEqual({ offers: ASK_OFFERS });
    expect(response.endpoint).toBe("wss://one");
  });

  it("rejects rippled errors with their code", async () => {
    const { client, sockets } = harness(["wss://one"]);
    const connected = client.connect();
    sockets[0]!.open();
    await connected;
    const pending = client.request("amm_info", { asset: { currency: "XRP" }, asset2: RLUSD });
    const sent = sockets[0]!.sent[0]!;
    sockets[0]!.reply({ id: sent.id, type: "response", status: "error", error: "actNotFound", error_message: "Account not found." });
    await expect(pending).rejects.toMatchObject({ code: "actNotFound" });
  });

  it("never sends a disallowed command", () => {
    const { client } = harness(["wss://one"]);
    expect(() => client.request("submit" as never, { tx_blob: "00" })).toThrow(LedgerCommandNotAllowedError);
  });

  it("falls back to the next endpoint and reports failure after a full pass", async () => {
    const { client, sockets, statuses, runTimers } = harness(["wss://one", "wss://two"]);
    const connected = client.connect();
    sockets[0]!.fail();
    runTimers();
    expect(sockets[1]!.url).toBe("wss://two");
    sockets[1]!.fail();
    await expect(connected).rejects.toMatchObject({ code: "unreachable" });
    expect(statuses).toContain("failed");
    runTimers();
    // keeps retrying in the background, back on the first endpoint
    expect(sockets[2]!.url).toBe("wss://one");
    client.close();
  });

  it("forwards validated ledger closes and re-subscribes after reconnecting", async () => {
    const { client, sockets, ledgers, runTimers } = harness(["wss://one"]);
    const connected = client.connect();
    sockets[0]!.open();
    await connected;
    const subscribed = client.subscribeLedger();
    const sub = sockets[0]!.sent[0]!;
    expect(sub).toMatchObject({ command: "subscribe", streams: ["ledger"] });
    sockets[0]!.reply({ id: sub.id, type: "response", status: "success", result: { ledger_index: 100 } });
    expect(await subscribed).toBe(100);
    sockets[0]!.reply({ type: "ledgerClosed", ledger_index: 101, ledger_time: 800000000 });
    expect(ledgers).toEqual([101]);
    sockets[0]!.fail();
    runTimers();
    sockets[1]!.open();
    expect(sockets[1]!.sent[0]).toMatchObject({ command: "subscribe", streams: ["ledger"] });
    client.close();
  });

  it("subscribes on recovery after a failed first connection", async () => {
    const { client, sockets, runTimers } = harness(["wss://one"]);
    client.followLedger();
    const connected = client.connect();
    sockets[0]!.fail();
    await expect(connected).rejects.toMatchObject({ code: "unreachable" });
    runTimers();
    sockets[1]!.open();
    expect(sockets[1]!.sent[0]).toMatchObject({ command: "subscribe", streams: ["ledger"] });
    client.close();
  });

  it("rejects in-flight requests when paused", async () => {
    const { client, sockets, statuses } = harness(["wss://one"]);
    const connected = client.connect();
    sockets[0]!.open();
    await connected;
    const pending = client.request("server_info");
    client.pause();
    await expect(pending).rejects.toMatchObject({ code: "paused" });
    expect(statuses.at(-1)).toBe("paused");
  });
});

describe("book derivation from book_offers", () => {
  it("prices asks as quote per base using funded amounts", () => {
    const asks = levelsFromOffers(ASK_OFFERS, "ask");
    expect(asks.map((level) => Number(level.price.toFixed(4)))).toEqual([2.2, 2.21]);
    expect(asks[1]!.size).toBe(500); // funded, not the nominal 1,000
    expect(asks[1]!.cumulative).toBe(2500);
  });

  it("orders bids best first, merges equal prices and skips unfunded offers", () => {
    const bids = levelsFromOffers(BID_OFFERS, "bid");
    expect(bids.map((level) => Number(level.price.toFixed(4)))).toEqual([2.19, 2.18]);
    expect(bids[1]!.size).toBe(3000);
    expect(bids[1]!.offers).toBe(2);
    expect(bids.at(-1)!.cumulative).toBe(4000);
  });

  it("tolerates junk", () => {
    expect(levelsFromOffers(undefined, "ask")).toEqual([]);
    expect(levelsFromOffers([null, { TakerGets: "abc", TakerPays: "1" }], "bid")).toEqual([]);
  });

  it("summarises a pair snapshot", () => {
    const snapshot = pairSnapshot({ askOffers: ASK_OFFERS, bidOffers: BID_OFFERS, ammResult: AMM_INFO, base: XRP_ASSET, quote: RLUSD, ledgerIndex: 95_000_000 });
    expect(snapshot.book.bestBid).toBeCloseTo(2.19);
    expect(snapshot.book.bestAsk).toBeCloseTo(2.2);
    expect(snapshot.book.mid).toBeCloseTo(2.195);
    expect(snapshot.book.spreadBps).toBeCloseTo((0.01 / 2.195) * 10_000, 3);
    expect(snapshot.amm?.price).toBeCloseTo(2.2);
    expect(snapshot.ledgerIndex).toBe(95_000_000);
  });
});

describe("AMM derivation from amm_info", () => {
  it("reads reserves, fee (1/100,000 units) and LP supply", () => {
    const amm = ammFromInfo(AMM_INFO, XRP_ASSET, RLUSD)!;
    expect(amm.baseReserve).toBe(5_000_000);
    expect(amm.quoteReserve).toBe(11_000_000);
    expect(amm.price).toBeCloseTo(2.2);
    expect(amm.feePercent).toBeCloseTo(0.5);
    expect(amm.lpSupply).toBeCloseTo(7416198.487);
    expect(amm.tvlQuote).toBeCloseTo(22_000_000);
  });

  it("returns null for a missing or mismatched pool", () => {
    expect(ammFromInfo({}, XRP_ASSET, RLUSD)).toBeNull();
    expect(ammFromInfo(AMM_INFO, XRP_ASSET, { currency: USDC_CURRENCY, issuer: USDC_MAINNET_ISSUER })).toBeNull();
  });

  it("applies the trading fee in constant-product output", () => {
    const amm = ammFromInfo(AMM_INFO, XRP_ASSET, RLUSD)!;
    const afterFee = 1000 * (1 - 0.005);
    expect(sellIntoAmm(amm, 1000)).toBeCloseTo((11_000_000 * afterFee) / (5_000_000 + afterFee), 6);
  });
});

describe("route quotes computed in the browser", () => {
  const snapshot = pairSnapshot({ askOffers: ASK_OFFERS, bidOffers: BID_OFFERS, ammResult: AMM_INFO, base: XRP_ASSET, quote: RLUSD, ledgerIndex: 1 });

  it("walks the bid book and compares with the pool", () => {
    const routes = quoteRoutes({ size: 1000, bids: snapshot.bids, amm: snapshot.amm, mid: snapshot.book.mid });
    const book = routes.routes.find((route) => route.route === "order-book")!;
    expect(book.output).toBeCloseTo(2190);
    const amm = routes.routes.find((route) => route.route === "amm")!;
    expect(amm.output).toBeCloseTo(sellIntoAmm(snapshot.amm!, 1000));
    expect(routes.best?.output).toBe(Math.max(book.output, amm.output));
    expect(routes.savings).toBeCloseTo(Math.abs(book.output - amm.output));
  });

  it("marks the book unavailable when the size exceeds the depth read", () => {
    const routes = quoteRoutes({ size: 10_000, bids: snapshot.bids, amm: snapshot.amm, mid: snapshot.book.mid });
    expect(routes.unavailable.map((route) => route.route)).toEqual(["order-book"]);
    expect(routes.routes.map((route) => route.route)).toEqual(["amm"]);
  });

  it("reports a missing pool honestly", () => {
    const routes = quoteRoutes({ size: 100, bids: snapshot.bids, amm: null, mid: snapshot.book.mid });
    expect(routes.unavailable.find((route) => route.route === "amm")?.detail).toMatch(/No AMM pool/);
  });
});

describe("issuer and server info", () => {
  it("decodes issuer flags, transfer fee, domain and circulating supply", () => {
    const info = issuerFromAccountInfo(
      {
        account_data: {
          Account: RLUSD_MAINNET_ISSUER,
          // DefaultRipple | AllowTrustLineClawback
          Flags: 0x00800000 + 0x80000000,
          TransferRate: 1_002_000_000,
          Domain: "726970706C652E636F6D", // ripple.com
        },
        ledger_index: 95_000_000,
        validated: true,
      },
      { obligations: { [RLUSD_CURRENCY]: "123456789.5" } },
      RLUSD_CURRENCY,
      "RLUSD",
    )!;
    expect(info.clawback).toBe(true);
    expect(info.defaultRipple).toBe(true);
    expect(info.requireAuth).toBe(false);
    expect(info.globalFreeze).toBe(false);
    expect(info.transferFeePercent).toBeCloseTo(0.2);
    expect(info.domain).toBe("ripple.com");
    expect(info.circulating).toBeCloseTo(123456789.5);
  });

  it("summarises server_info", () => {
    const info = serverInfoSummary({
      info: { build_version: "2.4.0", validated_ledger: { seq: 95_000_000, base_fee_xrp: 0.00001, reserve_base_xrp: 1, reserve_inc_xrp: 0.2, age: 2 } },
    });
    expect(info).toEqual({ validatedLedger: 95_000_000, baseFeeXrp: 0.00001, reserveBaseXrp: 1, reserveIncXrp: 0.2, closeAgeSeconds: 2, buildVersion: "2.4.0" });
  });
});

describe("market catalog", () => {
  it("lists only cited issuers", () => {
    const issuers = new Set(
      Object.values(MARKET_CATALOG)
        .flat()
        .flatMap((pair) => [pair.base.asset.issuer, pair.quote.asset.issuer])
        .filter(Boolean),
    );
    expect([...issuers].sort()).toEqual([RLUSD_MAINNET_ISSUER, "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV", USDC_MAINNET_ISSUER].sort());
    for (const pair of Object.values(MARKET_CATALOG).flat()) {
      for (const side of [pair.base, pair.quote]) if (side.asset.issuer) expect(side.source).toMatch(/^https:\/\//);
    }
  });
});

void vi;
