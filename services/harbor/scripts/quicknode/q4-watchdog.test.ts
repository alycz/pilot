import { describe, expect, it } from "vitest";

import { runQ4Watchdog } from "./q4-watchdog.ts";

const HASH = "D".repeat(64);
const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const DELEGATE = "rJdYtgaiEgzL7xD2QdPKg5xoHkWc7CZjvm";

function proof(source = "standin") {
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

describe("q4 watchdog probe", () => {
  it("accepts the complete stand-in freeze chain", async () => {
    const lines: string[] = [];
    await runQ4Watchdog(
      ["--mode", "mock", "--proof", "/tmp/proof.json", "--status", "/tmp/status.md"],
      {
        readFile: (async () => proof()) as never,
        appendFile: (async (_path, line) => lines.push(String(line))) as never,
        stdout: { write: () => true },
      },
    );
    expect(lines[0]).toContain("next execute=link_frozen");
    expect(lines[0]).toContain("mock-only");
  });

  it("does not accept stand-in evidence as live evidence", async () => {
    let read = false;
    await expect(runQ4Watchdog(
      ["--mode", "live", "--proof", "/tmp/proof.json"],
      {
        readFile: (async () => { read = true; return proof(); }) as never,
        appendFile: (async () => undefined) as never,
        stdout: { write: () => true },
      },
    )).rejects.toThrow(/--proof is mock-only/);
    expect(read).toBe(false);
  });

  it("runs the strict rogue-delegate proof chain in live mode", async () => {
    const lines: string[] = [];
    await runQ4Watchdog(
      ["--mode", "live", "--status", "/tmp/status.md"],
      {
        runRogueDelegate: async () => JSON.parse(proof("rogue-delegate")),
        appendFile: (async (_path, line) => lines.push(String(line))) as never,
        stdout: { write: () => true },
      },
    );
    expect(lines[0]).toContain("testnet rogue delegate frozen");
    expect(lines[0]).toContain("owner_revoke_onledger");
    expect(lines[0]).not.toContain("mock-only");
  });
});
