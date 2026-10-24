import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountOffer } from "xrpl";

import {
  buildLadder,
  normalizeCurrencyCode,
  parseSeedMetadata,
  planReconciliation,
  requireExecutionNetwork,
  sleep,
  type StableAsset,
} from "./mm-loop";

const stable: StableAsset = {
  currency: normalizeCurrencyCode("tUSD"),
  issuer: "rStableIssuer11111111111111111111111",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("market-maker safety", () => {
  it("accepts only testnet and devnet execution", () => {
    expect(requireExecutionNetwork("testnet")).toBe("testnet");
    expect(requireExecutionNetwork("DEVNET")).toBe("devnet");
    expect(() => requireExecutionNetwork("mainnet")).toThrow(/Refusing network/);
    expect(() => requireExecutionNetwork("lending-devnet")).toThrow(/Refusing network/);
  });

  it("reads the address-only seed metadata shape", () => {
    expect(
      parseSeedMetadata(
        {
          testnet: {
            marketMakerAddress: "rMarketMaker11111111111111111111111",
            stableIssuerAddress: stable.issuer,
          },
        },
        "testnet",
        "tUSD",
      ),
    ).toEqual({
      network: "testnet",
      marketMakerAddress: "rMarketMaker11111111111111111111111",
      stable,
    });
  });

  it("encodes non-standard currency codes as 160-bit hex", () => {
    expect(normalizeCurrencyCode("USD")).toBe("USD");
    expect(normalizeCurrencyCode("tUSD")).toBe("74555344".padEnd(40, "0"));
    expect(normalizeCurrencyCode("RLUSD")).toBe("524C555344".padEnd(40, "0"));
  });

  it("refuses an issuer mismatch between env configuration and seed metadata", () => {
    expect(() =>
      parseSeedMetadata(
        {
          devnet: {
            marketMakerAddress: "rMarketMaker11111111111111111111111",
            stableIssuerAddress: stable.issuer,
          },
        },
        "devnet",
        "tUSD",
        "rDifferentIssuer111111111111111111111",
      ),
    ).toThrow(/issuer mismatch/);
  });
});

describe("ladder construction and reconciliation", () => {
  it("builds ten funded levels on each side at 50 bps spacing", () => {
    const ladder = buildLadder(0.5, stable);
    const asks = ladder.filter((offer) => offer.side === "ask");
    const bids = ladder.filter((offer) => offer.side === "bid");

    expect(asks).toHaveLength(10);
    expect(bids).toHaveLength(10);
    expect(asks[0]).toMatchObject({
      level: 1,
      priceStablePerXrp: 0.5025,
      takerGets: "10000000",
      takerPays: { ...stable, value: "5.025" },
    });
    expect(bids[0]).toMatchObject({
      level: 1,
      priceStablePerXrp: 0.4975,
      takerGets: { ...stable, value: "4.975" },
      takerPays: "10000000",
    });
  });

  it("is idempotent when the account already has the desired ladder", () => {
    const ladder = buildLadder(0.5, stable);
    const existing: AccountOffer[] = ladder.map((offer, index) => ({
      flags: 65_536,
      seq: index + 1,
      taker_gets: offer.takerGets,
      taker_pays: offer.takerPays,
      quality: "1",
    }));
    existing.push({
      flags: 0,
      seq: 99,
      taker_gets: { currency: "FREEMONEY", issuer: stable.issuer, value: "1" },
      taker_pays: { ...stable, value: "1" },
      quality: "1",
    });

    expect(planReconciliation(existing, ladder, stable)).toEqual([]);
  });

  it("creates a missing level and replaces a stale level without duplicating offers", () => {
    const ladder = buildLadder(0.5, stable);
    const existing: AccountOffer[] = ladder.slice(0, -1).map((offer, index) => ({
      flags: 65_536,
      seq: index + 1,
      taker_gets: offer.takerGets,
      taker_pays: offer.takerPays,
      quality: "1",
    }));
    existing[0] = { ...existing[0], taker_pays: { ...stable, value: "999" } };

    const actions = planReconciliation(existing, ladder, stable);
    expect(actions.filter((action) => action.kind === "replace")).toHaveLength(1);
    expect(actions.filter((action) => action.kind === "create")).toHaveLength(1);
    expect(actions.filter((action) => action.kind === "cancel")).toHaveLength(0);
  });

  it("cancels the old pair before a large move could self-cross", () => {
    const oldLadder = buildLadder(0.5, stable, { levels: 1 });
    const existing: AccountOffer[] = oldLadder.map((offer, index) => ({
      flags: 65_536,
      seq: index + 1,
      taker_gets: offer.takerGets,
      taker_pays: offer.takerPays,
      quality: "1",
    }));
    const actions = planReconciliation(existing, buildLadder(0.8, stable, { levels: 1 }), stable);

    expect(actions.map((action) => action.kind)).toEqual(["cancel", "cancel", "create", "create"]);
  });
});

describe("continuous loop timing", () => {
  it("removes each abort listener after many normally completed intervals", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");

    for (let iteration = 0; iteration < 25; iteration += 1) {
      const pending = sleep(30_000, controller.signal);
      await vi.advanceTimersByTimeAsync(30_000);
      await pending;
    }

    expect(addListener).toHaveBeenCalledTimes(25);
    expect(removeListener).toHaveBeenCalledTimes(25);
    for (let iteration = 0; iteration < 25; iteration += 1) {
      expect(removeListener.mock.calls[iteration]?.[0]).toBe("abort");
      expect(removeListener.mock.calls[iteration]?.[1]).toBe(addListener.mock.calls[iteration]?.[1]);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer and removes its listener when aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");

    const pending = sleep(30_000, controller.signal);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await pending;

    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith("abort", addListener.mock.calls[0]?.[1]);
  });
});
