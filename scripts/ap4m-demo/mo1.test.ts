import { mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  DemoResetError,
  demoPolicy,
  formatResetPublicSummary,
  normalizeStableCurrency,
  requireResetGate,
  runDemoReset,
  type ResetDependencies,
} from "./reset";
import {
  HeadlessRunError,
  createOfflineFixtureDependencies,
  requireHeadlessGate,
  runHeadless,
  writeHeadlessEvidence,
} from "./run-headless";

const ADDRESSES = {
  owner: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
  payer: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
  issuer: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
  merchantA: "rLs1MzkFWCxTbuAHgjeTZK4fcCDDnf2KRv",
  merchantB: "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn",
  stableIssuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
} as const;

function hash(character: string): string {
  return character.repeat(64);
}

function resetDependencies(order: string[]): ResetDependencies {
  let time = 1_000;
  return {
    now: () => {
      time += 1_000;
      return time;
    },
    createFreshOwnerBudget: async () => {
      order.push("owner");
      return { owner: ADDRESSES.owner, faucetTransactionHashes: [hash("A")] };
    },
    readHarborPayer: async () => {
      order.push("payer");
      return ADDRESSES.payer;
    },
    readDemoNetworkIssuer: async () => {
      order.push("issuer");
      return ADDRESSES.issuer;
    },
    issueCredential: async (subject) => {
      order.push(`credential:${subject}`);
      return { transactionHash: subject === ADDRESSES.owner ? hash("B") : hash("C") };
    },
    acceptHarborPayerCredential: async () => {
      order.push("accept-payer");
      return { transactionHash: hash("D") };
    },
    setupMerchants: async () => {
      order.push("merchants");
      return {
        merchants: [ADDRESSES.merchantA, ADDRESSES.merchantB],
        transactionHashes: [hash("E")],
      };
    },
    ensureStableTrustLines: async ({ accounts, currency }) => {
      order.push(`trust:${currency}:${accounts.length}`);
      return { issuer: ADDRESSES.stableIssuer, transactionHashes: [hash("F")] };
    },
    configureHarbor: async ({ policy }) => {
      order.push(`harbor:${policy.max_per_tx_usd}`);
      return { transactionHashes: [hash("1")] };
    },
  };
}

const MOCK_ENV = { HARBOR_MOCK: "1", MASTERCARD_OF_MODE: "mock" } as const;

describe("MO1 reset", () => {
  it("requires exact mock or explicitly authorized event LIVE gates", () => {
    expect(() => requireResetGate(
      { network: "testnet", mode: "mock", stableCurrency: "RLUSD" },
      MOCK_ENV,
    )).not.toThrow();
    expect(() => requireResetGate(
      { network: "testnet", mode: "mock", stableCurrency: "RLUSD" },
      { HARBOR_MOCK: "0", MASTERCARD_OF_MODE: "mock" },
    )).toThrow(expect.objectContaining({ code: "MOCK_GATE_REQUIRED" }));
    expect(() => requireResetGate(
      { network: "testnet", mode: "sandbox", stableCurrency: "RLUSD" },
      {
        LIVE: "1",
        HARBOR_MOCK: "0",
        MASTERCARD_OF_MODE: "sandbox",
        EXEC_NETWORK: "testnet",
      },
    )).not.toThrow();
    expect(() => requireResetGate(
      { network: "testnet", mode: "sandbox", stableCurrency: "RLUSD" },
      { LIVE: "1", HARBOR_MOCK: "0", MASTERCARD_OF_MODE: "sandbox" },
    )).toThrow(expect.objectContaining({ code: "EVENT_LIVE_GATE_REQUIRED" }));
  });

  it("enforces the approved policy floor", () => {
    expect(demoPolicy(5)).toEqual({
      ap4m_enabled: true,
      x402_max_per_call_drops: "100000",
      max_per_tx_usd: 5,
    });
    expect(() => demoPolicy(4.99)).toThrow(
      expect.objectContaining({ code: "MAX_PER_TX_USD_TOO_LOW" }),
    );
  });

  it("runs the bounded reset plan in safety-critical order and returns public data only", async () => {
    const order: string[] = [];
    const result = await runDemoReset(
      { network: "testnet", mode: "mock", stableCurrency: "rlusd", maxPerTxUsd: 8 },
      resetDependencies(order),
      MOCK_ENV,
    );

    expect(order).toEqual([
      "owner",
      "payer",
      "issuer",
      `credential:${ADDRESSES.owner}`,
      `credential:${ADDRESSES.payer}`,
      "accept-payer",
      "merchants",
      `trust:${normalizeStableCurrency("RLUSD")}:4`,
      "harbor:8",
    ]);
    expect(result).toMatchObject({
      version: "ap4m-demo-reset/v1",
      network: "testnet",
      mode: "mock",
      mockOnly: true,
      stableAsset: {
        currency: normalizeStableCurrency("RLUSD"),
        issuer: ADDRESSES.stableIssuer,
      },
      policy: {
        ap4m_enabled: true,
        x402_max_per_call_drops: "100000",
        max_per_tx_usd: 8,
      },
    });
    expect(result.durationMs).toBeLessThan(60_000);
    expect(result.transactionHashes).toHaveLength(7);
    expect(JSON.stringify(result)).not.toMatch(/seed|secret|private|credentialId|tx_blob/iu);
    const summary = formatResetPublicSummary(result);
    expect(summary).toContain(`owner=${ADDRESSES.owner}`);
    expect(summary).not.toMatch(/[A-F0-9]{64}|seed|secret|private|credential/iu);
  });

  it("aborts a non-cooperative reset before the 60 second target", async () => {
    vi.useFakeTimers();
    const dependencies = resetDependencies([]);
    dependencies.createFreshOwnerBudget = async (signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new DemoResetError("ABORTED")), { once: true });
    });
    const pending = runDemoReset(
      { network: "testnet", mode: "mock", stableCurrency: "RLUSD", timeoutMs: 1_000 },
      dependencies,
      MOCK_ENV,
    );
    const rejection = expect(pending).rejects.toMatchObject({ code: "RESET_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    vi.useRealTimers();
  });
});

describe("MO1 headless rehearsal", () => {
  it("runs exactly nine payments, all four ordered safety moments, and one settlement", async () => {
    const evidence = await runHeadless(
      { mode: "mock", network: "testnet", runTag: "offline-1" },
      createOfflineFixtureDependencies("offline-1"),
      MOCK_ENV,
    );

    expect(evidence.result).toBe("PASS");
    expect(evidence.evidenceKind).toBe("mock-only");
    expect(evidence.purchases).toHaveLength(9);
    expect(evidence.purchases.map((purchase) => purchase.paymentNumber)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(evidence.purchases.every((purchase) =>
      purchase.scheme === "xrpl-paychan" && purchase.settlement === "claim_accepted"
    )).toBe(true);
    expect(evidence.safetyMoments.map((moment) => moment.name)).toEqual([
      "over_budget",
      "altered_intent",
      "rogue_agent",
      "revoked_mandate",
    ]);
    expect(evidence.safetyMoments.every((moment) =>
      moment.result === "blocked" && moment.verification === "mock-only"
    )).toBe(true);
    expect(evidence.counters).toEqual({
      payments: 9,
      purchaseLedgerTransactions: 0,
      settlementLedgerTransactions: 1,
    });
    expect(evidence.allTransactionHashes).toHaveLength(2);
    expect(evidence.labels.paymentRail).toContain("no Mastercard-network money movement");
    expect(evidence.labels.merchantValidation).toBe(
      "Validation flow from Mastercard's Level 3 Agentic Commerce guide · payment object: XRPL",
    );
  });

  it("does not allow mock output to masquerade as Testnet evidence", async () => {
    const dependencies = createOfflineFixtureDependencies("offline-2");
    const original = dependencies.exerciseSafetyMoment;
    dependencies.exerciseSafetyMoment = async (input) => ({
      ...(await original(input)),
      verification: "testnet",
    });
    await expect(runHeadless(
      { mode: "mock", network: "testnet", runTag: "offline-2" },
      dependencies,
      MOCK_ENV,
    )).rejects.toMatchObject({ code: "MOCK_EVIDENCE_MISLABELLED" });
  });

  it("requires exact ledger-verifier attestation before sandbox output can pass", async () => {
    const input = { mode: "sandbox", network: "testnet", runTag: "sandbox-1" } as const;
    const liveEnv = {
      LIVE: "1",
      HARBOR_MOCK: "0",
      MASTERCARD_OF_MODE: "sandbox",
      EXEC_NETWORK: "testnet",
    } as const;
    const dependencies = createOfflineFixtureDependencies("sandbox-1");
    dependencies.exerciseSafetyMoment = async ({ name }) => ({
      result: "blocked",
      code: `TESTNET_${name.toUpperCase()}`,
      verification: "testnet",
      transactionHashes: name === "rogue_agent"
        ? [hash("2")]
        : name === "revoked_mandate"
          ? [hash("3")]
          : [],
    });

    await expect(runHeadless(input, dependencies, liveEnv)).rejects.toMatchObject({
      code: "TESTNET_LEDGER_VERIFIER_REQUIRED",
    });

    dependencies.verifyLedgerEvidence = async ({ transactionHashes }) => ({
      verifier: "xrpl-ledger-verifier/v1",
      network: "testnet",
      networkId: 1,
      checkedAt: "2026-10-21T20:00:10.000Z",
      validatedTransactionHashes: [...transactionHashes].reverse(),
    });
    await expect(runHeadless(input, dependencies, liveEnv)).rejects.toMatchObject({
      code: "INVALID_LEDGER_ATTESTATION",
    });

    dependencies.verifyLedgerEvidence = async ({ transactionHashes }) => ({
      verifier: "xrpl-ledger-verifier/v1",
      network: "testnet",
      networkId: 1,
      checkedAt: "2026-10-21T20:00:10.000Z",
      validatedTransactionHashes: [...transactionHashes],
    });
    const evidence = await runHeadless(input, dependencies, liveEnv);
    expect(evidence.evidenceKind).toBe("testnet");
    expect(evidence.ledgerAttestation).toEqual({
      verifier: "xrpl-ledger-verifier/v1",
      network: "testnet",
      networkId: 1,
      checkedAt: "2026-10-21T20:00:10.000Z",
      validatedTransactionHashes: evidence.allTransactionHashes,
    });
  });

  it("fails closed on a malformed receipt, incomplete settlement, or missing gates", async () => {
    const malformed = createOfflineFixtureDependencies("offline-3");
    malformed.purchase = async () => ({
      receiptId: "contains spaces",
      scheme: "xrpl-paychan",
      settlement: "claim_accepted",
      transactionHashes: [],
    });
    await expect(runHeadless(
      { mode: "mock", network: "testnet", runTag: "offline-3" },
      malformed,
      MOCK_ENV,
    )).rejects.toMatchObject({ code: "INVALID_RECEIPT_ID" });

    expect(() => requireHeadlessGate(
      { mode: "mock", network: "testnet", runTag: "offline-3" },
      {},
    )).toThrow(expect.objectContaining({ code: "MOCK_GATE_REQUIRED" }));
  });

  it("writes two independent, creation-only mock evidence files beneath status", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mo1-headless-"));
    for (const runTag of ["rehearsal-1", "rehearsal-2"]) {
      const evidence = await runHeadless(
        { mode: "mock", network: "testnet", runTag },
        createOfflineFixtureDependencies(runTag),
        MOCK_ENV,
      );
      const path = `status/MC-O-evidence-${runTag}.json`;
      await expect(writeHeadlessEvidence(evidence, path, cwd)).resolves.toBe(path);
      const saved = JSON.parse(await readFile(join(cwd, path), "utf8")) as Record<string, unknown>;
      expect(saved).toMatchObject({ result: "PASS", evidenceKind: "mock-only", runTag });
      await expect(writeHeadlessEvidence(evidence, path, cwd)).rejects.toMatchObject({
        code: "EEXIST",
      });
    }
    const evidence = await runHeadless(
      { mode: "mock", network: "testnet", runTag: "rehearsal-3" },
      createOfflineFixtureDependencies("rehearsal-3"),
      MOCK_ENV,
    );
    await expect(writeHeadlessEvidence(evidence, "../outside.json", cwd)).rejects.toBeInstanceOf(
      HeadlessRunError,
    );

    const symlinkCwd = await mkdtemp(join(tmpdir(), "mo1-headless-symlink-"));
    const symlinkTarget = await mkdtemp(join(tmpdir(), "mo1-headless-target-"));
    await mkdir(symlinkTarget, { recursive: true });
    await symlink(symlinkTarget, join(symlinkCwd, "status"));
    await expect(writeHeadlessEvidence(
      evidence,
      "status/MC-O-evidence-symlink.json",
      symlinkCwd,
    )).rejects.toMatchObject({ code: "UNSAFE_EVIDENCE_PARENT" });
  });
});

describe("MO1 local launcher source contract", () => {
  it("is mock-gated, fixed-port-safe, and never sources an environment file", async () => {
    const source = await readFile(new URL("./local.sh", import.meta.url), "utf8");
    expect(source).toContain('HARBOR_MOCK:-}" = "1"');
    expect(source).toContain('MASTERCARD_OF_MODE:-}" = "mock"');
    expect(source).toContain("refuses occupied fixed endpoint");
    expect(source).toContain("--local");
    expect(source).toContain("AP4M_DEMO_MM_LOOP_MODE");
    expect(source).toContain('AP4M_DEMO_EVENT_LIVE_APPROVED:-}" = "1"');
    expect(source).toContain("scripts/mm-loop.ts --network testnet");
    expect(source).toContain(
      'AP4M_MERCHANT_EVENTS_URL="http://$MERCHANT_HOST:$MERCHANT_PORT/events"',
    );
    expect(source.match(/\/usr\/bin\/env -i/gu)).toHaveLength(5);
    expect(source).toContain("refusing profile file");
    expect(source).toContain("caller-selected state roots are not accepted");
    expect(source).toContain('STATE_ROOT=$("$MKTEMP_BIN" -d "$TMP_PARENT/ap4m-demo.XXXXXX")');
    expect(source).toContain("-MPOSIX=setsid");
    expect(source).toContain('/bin/kill -TERM "-$pid"');
    expect(source).toContain('/bin/kill -KILL "-$pid"');
    expect(source).not.toMatch(/(^|\n)\s*(?:source|\.)\s+[^\n]*env/iu);
    expect(source).not.toContain("--remote");
    expect(source).not.toContain("kill -9");
  });
});
