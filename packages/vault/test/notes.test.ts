import {
  DEFAULT_POLICY,
  PolicySchema,
  ProfileSchema,
  TradeSchema,
  type Profile,
} from "@pilot/contracts";
import matter from "gray-matter";
import { describe, expect, it } from "vitest";

import {
  acceptPreference,
  appendJournalNote,
  appendX402JournalNote,
  parsePolicyNote,
  parseProfileNote,
  writePolicyNote,
  writeProfileNote,
  writeReflectionNote,
  writeTokenNote,
  writeTradeNote,
  writeVenueNote,
  writeX402PaymentNote,
} from "../src/notes";

const profile: Profile = {
  main_account: "rMain",
  budget_account: "rBudget",
  network: "testnet",
  risk: "low",
  preferences: [],
};

describe("vault note writers", () => {
  it("writes contract-shaped trade frontmatter and graph links", () => {
    const note = writeTradeNote({
      intent_id: "intent-1",
      kind: "swap",
      network: "testnet",
      hash: "ABC123",
      venue: "xrpl-amm",
      assets: [{ currency: "XRP" }, { currency: "RLUSD", issuer: "rIssuer" }],
      result: "filled",
      fill_price: "0.5",
      slippage_bps: 12,
      signed_by: "delegate",
      explorer: "https://testnet.xrpl.org/transactions/ABC123",
      created: "2026-10-18T12:00:00.000Z",
    });

    expect(note.path).toBe("Pilot/Trades/ABC123.md");
    const parsed = matter(note.content);
    expect(TradeSchema.parse(parsed.data)).toMatchObject({
      type: "trade",
      venue: "[[xrpl-amm]]",
      assets: ["[[XRP]]", "[[RLUSD]]"],
    });
    expect(parsed.content).toContain("[[xrpl-amm]]");
    expect(parsed.content).toContain("[[XRP]]");
  });

  it("appends journal entries and writes linked venue, token, and reflection notes", () => {
    const first = appendJournalNote(null, {
      created: "2026-10-18T12:00:00.000Z",
      tradeHash: "ABC123",
      intentId: "intent-1",
      result: "filled",
    });
    const second = appendJournalNote(first.content, {
      created: "2026-10-18T13:00:00.000Z",
      tradeHash: "DEF456",
      intentId: "intent-2",
      result: "success",
    });
    expect(second.path).toBe("Pilot/Journal/2026-10-18.md");
    expect(second.content).toContain("[[ABC123]]");
    expect(second.content).toContain("[[DEF456]]");

    const venue = writeVenueNote({
      updated: "2026-10-18T13:00:00.000Z",
      relatedAssets: [{ currency: "XRP" }],
      relatedTrades: ["DEF456"],
      venue: {
        id: "xrpl-amm",
        name: "XRPL AMM",
        kind: "execution-primitive",
        layer: "xrpl-l1",
        category: ["spot", "liquidity"],
        status: { testnet: "live" },
        reads: ["amm.info"],
        risks: ["impermanent loss"],
        links: {},
      },
    });
    expect(venue.content).toContain("[[XRP]]");
    expect(venue.content).toContain("[[DEF456]]");

    const token = writeTokenNote({
      asset: { currency: "RLUSD", issuer: "rIssuer" },
      updated: "2026-10-18T13:00:00.000Z",
      venues: ["xrpl-amm"],
      trades: ["DEF456"],
    });
    expect(token.path).toBe("Pilot/Tokens/RLUSD.md");
    expect(token.content).toContain("[[xrpl-amm]]");

    const reflection = writeReflectionNote({
      hash: "DEF456",
      created: "2026-10-18T13:00:00.000Z",
      expected: { fillPrice: "0.51", slippageBps: 10 },
      actual: { fillPrice: "0.50", slippageBps: 8, result: "filled" },
    });
    expect(reflection.content).toContain("[[DEF456]]");
    expect(matter(reflection.content).data).toMatchObject({ type: "reflection" });
  });

  it("round-trips Profile and Policy contract frontmatter", () => {
    const profileNote = writeProfileNote(profile);
    expect(ProfileSchema.parse(matter(profileNote.content).data)).toEqual(profile);
    expect(parseProfileNote(profileNote.content)).toEqual(profile);

    const policyNote = writePolicyNote(DEFAULT_POLICY);
    expect(PolicySchema.parse(matter(policyNote.content).data)).toEqual(DEFAULT_POLICY);
    expect(parsePolicyNote(policyNote.content)).toEqual(DEFAULT_POLICY);
  });

  it("keeps proposals inert until explicitly accepted", () => {
    const proposal = { id: "pref-1", preference: "Prefer low-slippage routes" };
    expect(acceptPreference(profile, proposal, false)).toEqual(profile);
    expect(acceptPreference(profile, proposal, true).preferences).toEqual([
      "Prefer low-slippage routes",
    ]);
    expect(
      acceptPreference(
        { ...profile, preferences: ["Prefer low-slippage routes"] },
        proposal,
        true,
      ).preferences,
    ).toEqual(["Prefer low-slippage routes"]);
  });

  it("rejects unsafe note identifiers", () => {
    expect(() =>
      writeTradeNote({
        intent_id: "intent-1",
        kind: "swap",
        network: "testnet",
        hash: "../outside",
        venue: "xrpl-amm",
        assets: [{ currency: "XRP" }],
        result: "filled",
        fill_price: "1",
        slippage_bps: 0,
        signed_by: "delegate",
        explorer: "https://example.invalid",
        created: "2026-10-18T12:00:00.000Z",
      }),
    ).toThrow(/invalid transaction hash/i);
  });

  it("writes inert x402 evidence and an idempotent journal link", () => {
    const input = {
      paymentId: "payment-402-1",
      idempotencyKey: "pilot-x402:operation-402-1",
      owner: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      network: "testnet" as const,
      resource: "compare" as const,
      invoiceId: "invoice-1",
      amountDrops: "90000",
      feeDrops: "12",
      payer: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
      payTo: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
      txHash: "A".repeat(64),
      validatedLedgerIndex: 12_345,
      merchantStatus: 200 as const,
      merchantContentType: "application/json" as const,
      created: "2026-10-19T12:00:00.000Z",
    };
    const note = writeX402PaymentNote(input);
    expect(note.path).toMatch(/^Pilot\/X402\/payment-[a-f0-9]{64}\.md$/);
    expect(note.content).toContain("validated settlement");
    expect(note.content).not.toContain("merchant_body");
    expect(matter(note.content).data.payment_id).toBe(input.paymentId);

    const first = appendX402JournalNote(null, input);
    const replay = appendX402JournalNote(first.content, input);
    const paymentName = note.path.slice("Pilot/X402/".length, -".md".length);
    expect(first.content).toContain(`[[${paymentName}]]`);
    expect(replay.content).toBe(first.content);
  });

  it("maps contract-valid opaque payment ids to fixed safe names without losing metadata", () => {
    const base = {
      idempotencyKey: "pilot-x402:opaque-payment-id",
      owner: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      network: "testnet" as const,
      resource: "compare" as const,
      invoiceId: "invoice-opaque",
      amountDrops: "90000",
      feeDrops: "12",
      payer: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
      payTo: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
      txHash: "A".repeat(64),
      validatedLedgerIndex: 12_345,
      merchantStatus: 200 as const,
      merchantContentType: "application/json" as const,
      created: "2026-10-19T12:00:00.000Z",
    };
    const ids = ["payment:/\\:支付", "界".repeat(200)];
    const paths = ids.map((paymentId) => {
      const input = { ...base, paymentId };
      const note = writeX402PaymentNote(input);
      expect(note.path).toMatch(/^Pilot\/X402\/payment-[a-f0-9]{64}\.md$/);
      expect(note.path).not.toContain(paymentId);
      expect(matter(note.content).data.payment_id).toBe(paymentId);
      const first = appendX402JournalNote(null, input);
      expect(appendX402JournalNote(first.content, input).content).toBe(first.content);
      return note.path;
    });
    expect(new Set(paths).size).toBe(ids.length);
  });
});
