import { describe, expect, it, vi } from "vitest";

import {
  applyInjectionSeedPlan,
  buildInjectionSeedPlan,
  parseInjectionSeedArgs,
} from "./seed-injection";

const ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const BUDGET = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

describe("AWS-6 injection seed plan", () => {
  it("builds a deterministic testnet-only Domain, trust line and memo Payment plan", () => {
    const first = buildInjectionSeedPlan({ network: "testnet", issuer: ISSUER, budget: BUDGET });
    const second = buildInjectionSeedPlan({ network: "testnet", issuer: ISSUER, budget: BUDGET });

    expect(second).toEqual(first);
    expect(first.planId).toMatch(/^[a-f0-9]{24}$/);
    expect(first.operations.map(({ signer, transaction }) => [signer, transaction.TransactionType]))
      .toEqual([
        ["issuer", "AccountSet"],
        ["budget", "TrustSet"],
        ["issuer", "Payment"],
      ]);
    expect(first.operations[0]?.transaction).toMatchObject({ Account: ISSUER });
    expect(first.operations[1]?.transaction).toMatchObject({ Account: BUDGET });
    expect(first.operations[2]?.transaction).toMatchObject({ Account: ISSUER, Destination: BUDGET });
    expect(first.token.currency).toMatch(/^[A-F0-9]{40}$/);
    expect(JSON.stringify(first)).not.toMatch(/seed|secret|private|mnemonic/i);
  });

  it("is idempotent through explicit operation keys and an injected signer adapter", async () => {
    const plan = buildInjectionSeedPlan({ network: "testnet", issuer: ISSUER, budget: BUDGET });
    const completed = new Set<string>();
    const submit = vi.fn(async (_signer, _transaction, key: string) => {
      completed.add(key);
      return {
        hash: "A".repeat(64),
        validated: true as const,
        engineResult: "tesSUCCESS" as const,
      };
    });
    const adapter = {
      hasOperation: vi.fn(async (key: string) => completed.has(key)),
      submit,
    };

    const first = await applyInjectionSeedPlan(plan, adapter);
    const second = await applyInjectionSeedPlan(plan, adapter);

    expect(first.submitted).toHaveLength(3);
    expect(first.skipped).toEqual([]);
    expect(second.submitted).toEqual([]);
    expect(second.skipped).toEqual(plan.operations.map(({ key }) => key));
    expect(submit).toHaveBeenCalledTimes(3);
  });

  it("rejects a mutated plan or unvalidated event result", async () => {
    const plan = buildInjectionSeedPlan({ network: "testnet", issuer: ISSUER, budget: BUDGET });
    const mutated = structuredClone(plan);
    mutated.operations[2]!.transaction = {
      ...mutated.operations[2]!.transaction,
      Destination: ISSUER,
    };
    const validAdapter = {
      hasOperation: vi.fn(async () => false),
      submit: vi.fn(async () => ({
        hash: "A".repeat(64),
        validated: true as const,
        engineResult: "tesSUCCESS" as const,
      })),
    };
    await expect(applyInjectionSeedPlan(mutated, validAdapter))
      .rejects.toThrow(/not canonical/);

    await expect(applyInjectionSeedPlan(plan, {
      hasOperation: vi.fn(async () => false),
      submit: vi.fn(async () => ({
        hash: "A".repeat(64),
        validated: false as never,
        engineResult: "tesSUCCESS" as const,
      })),
    })).rejects.toThrow(/validated tesSUCCESS/);
  });

  it("rejects mainnet, credential arguments, and invalid public addresses before planning", () => {
    expect(() => parseInjectionSeedArgs([
      "--network", "mainnet", "--issuer", ISSUER, "--budget", BUDGET,
    ])).toThrow(/mainnet/);
    expect(() => parseInjectionSeedArgs([
      "--network", "testnet", "--issuer-seed", "synthetic", "--budget", BUDGET,
    ])).toThrow(/never accepts wallet credentials/);
    expect(() => buildInjectionSeedPlan({
      network: "testnet",
      issuer: "not-an-address",
      budget: BUDGET,
    })).toThrow(/valid XRPL classic addresses/);
  });
});
