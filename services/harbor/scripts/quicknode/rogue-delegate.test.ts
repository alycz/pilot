import { describe, expect, it } from "vitest";

import { runRogueDelegate } from "./rogue-delegate.ts";

const HASH = "D".repeat(64);
const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const DELEGATE = "rJdYtgaiEgzL7xD2QdPKg5xoHkWc7CZjvm";

function fixture(source = "standin"): string {
  return JSON.stringify({
    source,
    network: "testnet",
    tx_hash: HASH,
    event: {
      tx_hash: HASH,
      account: OWNER,
      delegate: DELEGATE,
      class: "out_of_band_delegate",
      ledger_index: 456,
      action: "frozen",
      next_step: "owner_revoke_onledger",
    },
    link: { account: OWNER, frozen: true },
    next_execute: {
      ok: false,
      error: { code: "link_frozen" },
    },
  });
}

describe("rogue-delegate runner", () => {
  it("replays only the strict stand-in proof in mock mode", async () => {
    await expect(runRogueDelegate(
      ["--mode", "mock", "--fixture", "/tmp/q4.json"],
      { readFile: (async () => fixture()) as never },
    )).resolves.toMatchObject({
      source: "standin",
      event: { next_step: "owner_revoke_onledger" },
      next_execute: { error: { code: "link_frozen" } },
    });
  });

  it("rejects malformed or mislabeled mock evidence", async () => {
    await expect(runRogueDelegate(
      ["--mode", "mock", "--fixture", "/tmp/q4.json"],
      { readFile: (async () => fixture("rogue-delegate")) as never },
    )).rejects.toThrow(/stand-in/);
  });

  it("fails closed before network access without an explicit Testnet lane", async () => {
    const previous = process.env.EXEC_NETWORK;
    delete process.env.EXEC_NETWORK;
    try {
      await expect(runRogueDelegate(["--mode", "live"], {}))
        .rejects.toThrow(/EXEC_NETWORK=testnet/);
    } finally {
      if (previous === undefined) delete process.env.EXEC_NETWORK;
      else process.env.EXEC_NETWORK = previous;
    }
  });

  it("projects real event fields into the strict proof without leaking extras", async () => {
    const requests: string[] = [];
    const wallet = {
      address: OWNER,
      sign: () => ({ tx_blob: "AB", hash: HASH }),
    };
    let generated = 0;
    let cleanupData: unknown = {
      owner: OWNER,
      network: "testnet",
      deleted: true,
    };
    let loseRegistrationResponse = false;
    const client = {
      connect: async () => undefined,
      disconnect: async () => undefined,
      fundWallet: async () => undefined,
      autofill: async (transaction: unknown) => transaction,
      submitAndWait: async () => ({
        result: {
          hash: HASH,
          validated: true,
          meta: { TransactionResult: "tesSUCCESS" },
        },
      }),
    };
    const fetcher = async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requests.push(url.pathname);
      if (
        loseRegistrationResponse &&
        url.pathname.endsWith("quicknode.test.registerLink")
      ) {
        throw new Error("registration response lost after insert");
      }
      if (url.pathname.endsWith("quicknode.events")) {
        return Response.json({ ok: true, data: [{
          tx_hash: HASH,
          account: OWNER,
          delegate: DELEGATE,
          class: "out_of_band_delegate",
          flags: ["tx_type_not_delegated"],
          ledger_index: 456,
          close_time: "2026-10-21T19:00:00.000Z",
          action: "frozen",
          next_step: "owner_revoke_onledger",
        }] });
      }
      if (url.pathname.endsWith("tx.execute")) {
        return Response.json({
          ok: false,
          error: { code: "link_frozen", message: "provider text" },
        });
      }
      if (url.pathname.endsWith("tx.trustSet")) {
        return Response.json({ ok: true, data: { build_id: "build-1" } });
      }
      if (url.pathname.endsWith("quicknode.test.deleteLink")) {
        return Response.json({ ok: true, data: cleanupData });
      }
      return Response.json({ ok: true, data: {} });
    };
    const runLive = () => {
      generated = 0;
      return runRogueDelegate([
        "--mode", "live",
        "--harbor-url", "http://127.0.0.1:8794/",
        "--xrpl-url", "wss://s.altnet.rippletest.net:51233/",
      ], {
        createClient: () => client as never,
        generateWallet: () => {
          generated += 1;
          return generated === 1
            ? wallet as never
            : { ...wallet, address: DELEGATE } as never;
        },
        fetcher: fetcher as typeof fetch,
      });
    };
    const previous = process.env.EXEC_NETWORK;
    process.env.EXEC_NETWORK = "testnet";
    try {
      await expect(runLive()).resolves.toMatchObject({
        event: {
          tx_hash: HASH,
          next_step: "owner_revoke_onledger",
        },
        next_execute: { error: { code: "link_frozen" } },
      });
      expect(requests).toContain("/api/ops/quicknode.events");
      expect(requests.at(-1)).toBe("/api/ops/quicknode.test.deleteLink");

      cleanupData = { owner: OWNER, network: "testnet", deleted: false };
      await expect(runLive()).rejects.toThrow();

      cleanupData = { owner: OWNER, network: "testnet" };
      await expect(runLive()).rejects.toThrow();

      cleanupData = { owner: OWNER, network: "testnet", deleted: true };
      loseRegistrationResponse = true;
      await expect(runLive()).rejects.toThrow(/registration response lost/);
      expect(requests.at(-1)).toBe("/api/ops/quicknode.test.deleteLink");
    } finally {
      if (previous === undefined) delete process.env.EXEC_NETWORK;
      else process.env.EXEC_NETWORK = previous;
    }
  });
});
