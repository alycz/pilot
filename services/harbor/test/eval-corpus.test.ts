import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  MAX_LIVE_XRP_SPEND_DROPS,
  requireBuyLiquidity,
  requireDelegateFeeHeadroom,
  requireExactStableIncrease,
  requireLivePolicy,
  requireRevocableLiveStatus,
  requireRlusdPurchaseBuild,
  requireStableReceiveCapacity,
  requireSpendableXrp,
} from "../eval/live-guards.mjs";

const execFileAsync = promisify(execFile);

describe("deployed MCP evaluation", () => {
  it("contains exactly 30 unique golden cases across every required category", async () => {
    const source = await readFile("eval/golden.jsonl", "utf8");
    const cases = source
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as {
        id: string;
        category: string;
        tool: string;
        arguments: unknown;
        expect: { kind: string };
        required?: boolean;
      });

    expect(cases).toHaveLength(30);
    expect(new Set(cases.map(({ id }) => id)).size).toBe(30);
    expect(new Set(cases.map(({ category }) => category))).toEqual(
      new Set(["reads", "quotes", "builds", "executions", "approvals", "revoke"]),
    );
    expect(cases.every(({ tool }) => tool === "search" || tool === "execute")).toBe(true);
    expect(cases.every(({ arguments: input, expect: result }) =>
      input !== null && typeof input === "object" && typeof result.kind === "string"
    )).toBe(true);
    expect(cases.some(({ expect: result }) => result.kind === "envelope")).toBe(false);

    const requiredExecuteCategories = new Set(
      cases
        .filter(({ tool, required }) => tool === "execute" && required === true)
        .map(({ category }) => category),
    );
    expect(requiredExecuteCategories).toEqual(
      new Set(["reads", "quotes", "builds", "executions", "approvals", "revoke"]),
    );
  });

  it("exposes a standalone SDK runner without requiring secret configuration for help", async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["eval/run.mjs", "--help"],
      { env: { PATH: process.env.PATH } },
    );

    expect(stderr).toBe("");
    expect(stdout).toContain("Score the 30 non-submitting golden cases");
    expect(stdout).toContain("--live");
    expect(stdout).toContain("--revoke");
  });

  it("rejects a non-loopback HTTP endpoint before loading or sending credentials", async () => {
    await expect(execFileAsync(
      process.execPath,
      ["eval/run.mjs", "--url", "http://example.com/mcp"],
      { env: { PATH: process.env.PATH } },
    )).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Harbor MCP URL must use HTTPS or explicit HTTP loopback",
      ),
    });
  });

  it("uses an address-only per-run revoke probe and scores golden cases after live setup", async () => {
    const runner = await readFile("eval/run.mjs", "utf8");
    const golden = await readFile("eval/golden.jsonl", "utf8");

    expect(runner).toContain("encodeAccountID(");
    expect(runner).toContain("harbor-revoke-probe:${runId}");
    expect(runner).toContain("harbor-payment-destination:${runId}");
    expect(runner).toContain("DESTINATION: process.env.HARBOR_EVAL_READ_DESTINATION ?? paymentDestination");
    expect(runner).toContain("path.length > 3");
    expect(runner).toContain('path.map((part) => `[${JSON.stringify(part)}]`)');
    expect(runner).not.toContain("path.length !== 2");
    expect(runner.match(/ledger_index: "validated"/g)).toHaveLength(7);
    expect(runner).not.toContain("Wallet.generate(");
    expect(runner).not.toMatch(/process\.env\.TEST_WALLETS_/);
    expect(runner).toContain("DEV_VAR_ALLOWLIST");
    expect(runner.indexOf("const liveOwner = options.live ? await runLive(client, options)")).toBeLessThan(
      runner.indexOf("await runGolden("),
    );
    expect(runner).toContain("{ OWNER: liveOwner }");
    const goldenCases = golden
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id: string; arguments: { code?: string } });
    expect(goldenCases.find(({ id }) => id === "G12")?.arguments.code).toContain("limit:10");
    expect(goldenCases.find(({ id }) => id === "G13")?.arguments.code).toContain("limit:10");
    expect(goldenCases.find(({ id }) => id === "G14")?.arguments.code).toContain(
      "limit:10,binary:true",
    );
  });

  it("buys exactly 10 stable units with bounded XRP and needs no prefunded stable balance", async () => {
    const runner = await readFile("eval/run.mjs", "utf8");
    const guards = await readFile("eval/live-guards.mjs", "utf8");
    const readme = await readFile("eval/README.md", "utf8");

    expect(guards).toContain('LIVE_BUY_STABLE_VALUE = "10"');
    expect(guards).toContain("MAX_LIVE_XRP_SPEND_DROPS = 50_000_000n");
    expect(runner).toContain('harborOp(client, "tx.simulate"');
    expect(runner).toContain('TransactionType: "OfferCreate"');
    expect(runner).toContain("TakerGets: MAX_LIVE_XRP_SPEND_DROPS.toString()");
    expect(runner).toContain("TakerPays:");
    expect(runner).not.toContain("LIVE_MAX_SLIPPAGE_BPS");
    expect(runner).toContain('harborOp(client, "server.reserves"');
    expect(runner).toContain('harborOp(client, "dex.depth"');
    expect(runner).toContain("MAX_LIVE_XRP_SPEND_DROPS,");
    expect(runner).not.toContain("at least 10 stable units before live evaluation");
    expect(runner.indexOf('harborOp(client, "dex.depth"')).toBeLessThan(
      runner.indexOf('await harborOp(client, "account.link"'),
    );
    expect(runner.indexOf('await harborOp(client, "tx.simulate"')).toBeLessThan(
      runner.indexOf('await harborOp(client, "account.link"'),
    );
    expect(runner.match(/await simulateLivePurchase\(client, owner, stable\)/g)).toHaveLength(2);
    expect(runner).toContain('harborOp(client, "tx.submit", { tx_blob: blob, network })');
    expect(runner.lastIndexOf("await simulateLivePurchase(client, owner, stable)")).toBeGreaterThan(
      runner.indexOf('process.stdout.write("DelegateSet validated and link is active.'),
    );
    expect(runner).toMatch(
      /harborOp\(client, "ledger\.account\.tx", \{\s+network: stable\.network,\s+account: owner,\s+tx_type: "OfferCreate",\s+delegate: \{\s+delegate_filter: "actor",\s+counter_party: link\.delegate,\s+\},\s+limit: 10,\s+forward: false,\s+\}\)/,
    );
    expect(runner).toContain("async function revokeLiveLink(");
    expect(runner).toContain("Live workflow failed and revocation recovery failed");
    expect(runner).toMatch(/finally\s*\{[\s\S]*await revokeLiveLink\(/);
    expect(readme).toContain("hard 50 XRP maximum spend");
    expect(readme).toContain("slippage rule does not price this order");
    expect(readme).toContain("does not relax or replace the scoped policy");
    expect(readme).toContain("does not need a pre-existing RLUSD balance");
    expect(readme).toContain("revoke path is installed before");
  });

  it("validates opposing funded depth and both exact-output swap directions", () => {
    const opposingDepth = {
      ledger_index: 123,
      totals: { taker_gets: "10", taker_pays: "35000000", offer_count: 2 },
    };
    const sameSideDepth = {
      ledger_index: 123,
      totals: { taker_gets: "1000000", taker_pays: "0.3", offer_count: 1 },
    };
    expect(() => requireBuyLiquidity(opposingDepth, sameSideDepth)).not.toThrow();
    expect(() => requireBuyLiquidity({
      ...opposingDepth,
      totals: { ...opposingDepth.totals, taker_gets: "9.999999" },
    }, sameSideDepth)).toThrow(/lacks 10 stable/);

    const expected = {
      owner: "rOwner",
      stable: { currency: "RLUSD", issuer: "rIssuer" },
    };
    const build = {
      simulate: { engine_result: "tesSUCCESS" },
      preflight: [{ check: "trust-line", pass: true }],
      tx_json: {
        TransactionType: "OfferCreate",
        Account: expected.owner,
        TakerGets: "35000000",
        TakerPays: { ...expected.stable, value: "10" },
        Flags: 0x0004_0000,
      },
    };
    expect(requireRlusdPurchaseBuild(build, expected)).toBe(35_000_000n);
    expect(() => requireRlusdPurchaseBuild({
      ...build,
      tx_json: { ...build.tx_json, Flags: 0x0002_0000 },
    }, expected)).toThrow(/exact-output 10 stable/);
    expect(() => requireRlusdPurchaseBuild({
      ...build,
      tx_json: {
        ...build.tx_json,
        TakerGets: { ...expected.stable, value: "10" },
        TakerPays: "35000000",
        Flags: 0x0004_0000 | 0x0008_0000,
      },
    }, expected)).toThrow(/exact-output 10 stable/);
  });

  it("requires a scoped policy that permits the exact live OfferCreate", () => {
    const stable = { network: "testnet", currency: "RLUSD", issuer: "rIssuer" };
    const policy = {
      networks: ["testnet"],
      allowed_tx_types: ["OfferCreate"],
      issuer_allowlist: ["RLUSD"],
      max_per_tx_usd: 500,
      daily_cap_usd: 5000,
      execute_under_usd: 250,
      max_slippage_bps: 100,
    };

    expect(() => requireLivePolicy(policy, stable, "64.55")).not.toThrow();
    expect(() => requireLivePolicy({
      ...policy,
      allowed_tx_types: [],
    }, stable, "64.55")).toThrow(/OfferCreate/);
    expect(() => requireLivePolicy({
      ...policy,
      execute_under_usd: 60,
    }, stable, "64.55")).toThrow(/built USD notional/);
    expect(() => requireLivePolicy(policy, stable, undefined)).toThrow(/built USD notional/);
  });

  it("rejects either trust-line freeze direction and requires delegate fee headroom", () => {
    const line = { balance: "0", limit: "1000" };
    expect(requireStableReceiveCapacity(line)).toBe("0");
    expect(() => requireStableReceiveCapacity({ ...line, freeze: true })).toThrow(/unfrozen trust line/);
    expect(() => requireStableReceiveCapacity({ ...line, freeze_peer: true })).toThrow(/unfrozen trust line/);
    expect(() => requireStableReceiveCapacity({ ...line, limit: "9.999999" })).toThrow(/receive 10/);

    expect(() => requireDelegateFeeHeadroom({
      account_data: { Balance: "2000000" },
    })).not.toThrow();
    expect(() => requireDelegateFeeHeadroom({
      account_data: { Balance: "1999999" },
    })).toThrow(/execution-fee headroom/);
  });

  it("permits cleanup of active or watcher-suspended links only for the exact delegate", () => {
    expect(requireRevocableLiveStatus({ status: "revoked" }, "rDelegate")).toBeUndefined();
    expect(requireRevocableLiveStatus({
      status: "active",
      delegate: "rDelegate",
    }, "rDelegate")).toBe("rDelegate");
    expect(requireRevocableLiveStatus({
      status: "suspended",
      delegate: "rDelegate",
    })).toBe("rDelegate");
    expect(() => requireRevocableLiveStatus({
      status: "suspended",
      delegate: "rDifferent",
    }, "rDelegate")).toThrow(/Revocable delegation/);
    expect(() => requireRevocableLiveStatus({
      status: "pending",
      delegate: "rDelegate",
    }, "rDelegate")).toThrow(/Revocable delegation/);
  });

  it("enforces XRP reserve and fee headroom and proves the validated 10-unit fill", () => {
    const accountInfo = {
      account_data: { Balance: "99999964", OwnerCount: 1 },
    };
    const reserves = { reserve_base_xrp: 1, reserve_inc_xrp: 0.2 };
    expect(() => requireSpendableXrp(
      accountInfo,
      reserves,
      MAX_LIVE_XRP_SPEND_DROPS,
      2,
    )).not.toThrow();
    expect(() => requireSpendableXrp(
      { account_data: { Balance: "55000000", OwnerCount: 1 } },
      reserves,
      MAX_LIVE_XRP_SPEND_DROPS,
      2,
    )).toThrow(/lacks spendable XRP/);
    expect(() => requireExactStableIncrease("0", "10")).not.toThrow();
    expect(() => requireExactStableIncrease("2.5", "12.5")).not.toThrow();
    expect(() => requireExactStableIncrease("0", "9.999999")).toThrow(/exactly 10/);
  });
});
