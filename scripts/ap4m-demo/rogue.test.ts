import { describe, expect, it, vi } from "vitest";

import {
  RogueAgentError,
  liveConfigFromEnvironment,
  offlinePendingRogueEvidence,
  recordRogueRejection,
  runLiveRogueAgent,
  type LiveRogueDependencies,
  type RogueClient,
  type RogueWallet,
} from "./rogue";

const MERCHANT = "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY";
const ROGUE = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const HASH = "A".repeat(64);
const NOW = new Date("2026-10-21T21:30:00.000Z");

function config(overrides: Record<string, unknown> = {}) {
  return {
    live: true,
    network: "testnet",
    endpoint: "wss://s.altnet.rippletest.net:51233",
    merchantAddress: MERCHANT,
    amountDrops: "1",
    ...overrides,
  } as never;
}

function harness(overrides: Partial<RogueClient> = {}) {
  const wallet: RogueWallet = {
    address: ROGUE,
    sign: vi.fn(() => ({ hash: HASH, tx_blob: "signed-test-blob" })),
  };
  const client: RogueClient = {
    networkID: 1,
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    fundWallet: vi.fn(async () => undefined),
    autofill: vi.fn(async (payment) => ({ ...payment, Fee: "12", Sequence: 1 })),
    submitAndWait: vi.fn(async () => ({
      result: {
        hash: HASH,
        validated: true,
        meta: { TransactionResult: "tecNO_PERMISSION" },
      },
    })),
    ...overrides,
  };
  const dependencies: LiveRogueDependencies = {
    createClient: vi.fn(() => client),
    generateWallet: vi.fn(() => wallet),
    now: () => NOW,
  };
  return { client, wallet, dependencies };
}

describe("MO2 rogue-agent safety evidence", () => {
  it("labels offline injected evidence and refuses fake hashes or accounts", () => {
    expect(offlinePendingRogueEvidence(NOW)).toEqual({
      schema: "ap4m_rogue_v1",
      source: "offline-injected",
      network: "testnet",
      outcome: "rejected",
      engine_result: "tecNO_PERMISSION",
      tx_hash: null,
      rogue_address: null,
      submitted: false,
      verified_live: false,
      at: NOW.toISOString(),
      label: "Mock-only safety evidence · LIVE Testnet check pending",
    });
    expect(() => recordRogueRejection({
      source: "offline-injected",
      engineResult: "tecNO_PERMISSION",
      txHash: HASH,
      at: NOW,
    })).toThrow(/must not carry ledger hashes/);
  });

  it.each([
    ["LIVE gate", { live: false }, "LIVE_REQUIRED"],
    ["mainnet", { network: "mainnet" }, "TESTNET_REQUIRED"],
    ["non-wss endpoint", { endpoint: "https://s.altnet.rippletest.net" }, "INVALID_CONFIG"],
    ["credential-bearing endpoint", { endpoint: "wss://secret@s.altnet.rippletest.net" }, "INVALID_CONFIG"],
    ["invalid merchant", { merchantAddress: "not-an-address" }, "INVALID_CONFIG"],
    ["invalid drops", { amountDrops: "01" }, "INVALID_CONFIG"],
    ["unbounded drops", { amountDrops: "100000000000000001" }, "INVALID_CONFIG"],
  ])("fails closed at the %s before connecting", async (_label, change, code) => {
    const test = harness();
    await expect(runLiveRogueAgent(config(change), test.dependencies)).rejects.toMatchObject({ code });
    expect(test.dependencies.createClient).not.toHaveBeenCalled();
    expect(test.dependencies.generateWallet).not.toHaveBeenCalled();
  });

  it("checks the connected network before generating or funding an account", async () => {
    const test = harness({ networkID: 0 });
    await expect(runLiveRogueAgent(config(), test.dependencies)).rejects.toMatchObject({
      code: "TESTNET_REQUIRED",
    });
    expect(test.dependencies.generateWallet).not.toHaveBeenCalled();
    expect(test.client.fundWallet).not.toHaveBeenCalled();
    expect(test.client.disconnect).toHaveBeenCalledOnce();
  });

  it("records exact validated Testnet rejection evidence through injected IO", async () => {
    const test = harness();
    await expect(runLiveRogueAgent(config(), test.dependencies)).resolves.toEqual({
      schema: "ap4m_rogue_v1",
      source: "live-testnet",
      network: "testnet",
      outcome: "rejected",
      engine_result: "tecNO_PERMISSION",
      tx_hash: HASH,
      rogue_address: ROGUE,
      submitted: true,
      verified_live: true,
      at: NOW.toISOString(),
      label: "Verified XRPL Testnet safety evidence",
    });
    expect(test.client.fundWallet).toHaveBeenCalledWith(test.wallet);
    expect(test.client.autofill).toHaveBeenCalledWith({
      TransactionType: "Payment",
      Account: ROGUE,
      Destination: MERCHANT,
      Amount: "1",
    });
    expect(test.client.disconnect).toHaveBeenCalledOnce();
  });

  it.each([
    ["different engine result", { meta: { TransactionResult: "tecUNFUNDED_PAYMENT" } }],
    ["unvalidated result", { validated: false, meta: { TransactionResult: "tecNO_PERMISSION" } }],
    ["inconsistent hash", { hash: "B".repeat(64), meta: { TransactionResult: "tecNO_PERMISSION" } }],
  ])("does not claim success for a %s", async (_label, result) => {
    const test = harness({ submitAndWait: vi.fn(async () => ({ result: { hash: HASH, validated: true, ...result } })) });
    await expect(runLiveRogueAgent(config(), test.dependencies)).rejects.toBeInstanceOf(RogueAgentError);
    expect(test.client.disconnect).toHaveBeenCalledOnce();
  });

  it("maps only explicit environment settings and defaults to live-off", () => {
    expect(liveConfigFromEnvironment({})).toEqual({
      live: false,
      network: "",
      endpoint: "",
      merchantAddress: "",
      amountDrops: "1",
    });
    expect(liveConfigFromEnvironment({
      LIVE: "1",
      EXEC_NETWORK: "testnet",
      XRPL_TESTNET_URL: "wss://testnet.example",
      AP4M_MERCHANT_A_ADDRESS: MERCHANT,
      AP4M_ROGUE_AMOUNT_DROPS: "2",
    })).toEqual({
      live: true,
      network: "testnet",
      endpoint: "wss://testnet.example",
      merchantAddress: MERCHANT,
      amountDrops: "2",
    });
  });
});
