import { describe, expect, it } from "vitest";

import { rememberedStateForChat } from "./chat-memory-state";

const config = {
  network: "testnet" as const,
  stableAsset: { currency: "USD", issuer: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59" },
  devSignerEnabled: false,
  walletActionProofRequired: true,
  walletActionProofConfigured: true,
  mockMode: false,
};

describe("rememberedStateForChat", () => {
  it("keeps authenticated memory scoped to the exact wallet and network", () => {
    expect(rememberedStateForChat(config, {
      authenticated: true,
      account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      network: "testnet",
    })).toEqual({
      kind: "ready",
      owner: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      network: "testnet",
    });
  });

  it("does not expose another network's memory", () => {
    expect(rememberedStateForChat(config, {
      authenticated: true,
      account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      network: "devnet",
    }).kind).toBe("unavailable");
  });

  it("does not create a wallet scope for signed-out visitors", () => {
    expect(rememberedStateForChat(config, { authenticated: false })).toEqual({ kind: "signed-out" });
  });
});
