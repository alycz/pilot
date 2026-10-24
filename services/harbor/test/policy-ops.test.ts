import { describe, expect, it, vi } from "vitest";

import type { OpContext } from "../src/catalog/registry";
import {
  DEFAULT_POLICY,
  type Network,
  type Policy,
} from "../src/contracts";
import type {
  PolicyInsert,
  PolicyRow,
  PolicyUpdate,
} from "../src/exec/store";
import {
  handlePolicyGet,
  handlePolicySet,
  ops,
  PolicyGetArgsSchema,
  PolicySetArgsSchema,
  SafePolicySchema,
  type PolicyStore,
} from "../src/ops/policy";

const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const NOW = "2026-10-18T12:00:00.000Z";

function policy(overrides: Partial<Policy> = {}): Policy {
  return {
    ...DEFAULT_POLICY,
    allowed_tx_types: [...DEFAULT_POLICY.allowed_tx_types],
    issuer_allowlist: [...DEFAULT_POLICY.issuer_allowlist],
    networks: [...DEFAULT_POLICY.networks],
    ...overrides,
  };
}

function key(principal: string, owner: string, network: Network): string {
  return `${principal}:${owner}:${network}`;
}

class MemoryPolicyStore implements PolicyStore {
  constructor(
    private readonly principal: string,
    private readonly rows: Map<string, PolicyRow>,
  ) {}

  readonly getPolicy = vi.fn(
    async (owner: string, network: Network): Promise<PolicyRow | null> =>
      this.rows.get(key(this.principal, owner, network)) ?? null,
  );

  readonly insertPolicy = vi.fn(
    async (input: PolicyInsert): Promise<PolicyRow> => {
      const row: PolicyRow = {
        principal: this.principal,
        ...input,
      };
      this.rows.set(key(this.principal, input.owner, input.network), row);
      return row;
    },
  );

  readonly updatePolicy = vi.fn(
    async (
      owner: string,
      network: Network,
      patch: PolicyUpdate,
    ): Promise<PolicyRow | null> => {
      const rowKey = key(this.principal, owner, network);
      const current = this.rows.get(rowKey);
      if (!current) return null;
      const row = { ...current, ...patch };
      this.rows.set(rowKey, row);
      return row;
    },
  );
}

function harness() {
  const rows = new Map<string, PolicyRow>();
  const stores = new Map<string, MemoryPolicyStore>();
  const storeFor = (principal: string) => {
    let store = stores.get(principal);
    if (!store) {
      store = new MemoryPolicyStore(principal, rows);
      stores.set(principal, store);
    }
    return store;
  };
  const context = (principal: string): OpContext => ({
    principal,
    policyServices: {
      store: storeFor(principal),
      now: () => new Date(NOW),
    },
  });
  return { rows, storeFor, context };
}

describe("policy operations", () => {
  it("exports policy.get and policy.set with accurate registry metadata", () => {
    expect(ops.map((operation) => operation.name)).toEqual([
      "policy.get",
      "policy.set",
    ]);
    expect(ops.every((operation) => operation.family === "policy")).toBe(true);
    expect(ops.every((operation) => operation.caveats.length === 0)).toBe(true);
    expect(ops.every((operation) => operation.example.includes("await harbor.policy."))).toBe(true);
  });

  it("returns a fresh immutable default without inserting it", async () => {
    const h = harness();
    const first = await handlePolicyGet(h.context("alpha"), {
      owner: OWNER,
      network: "testnet",
    });
    const second = await handlePolicyGet(h.context("alpha"), {
      owner: OWNER,
      network: "testnet",
    });

    expect(first).toEqual(DEFAULT_POLICY);
    expect(first).not.toBe(DEFAULT_POLICY);
    expect(second).not.toBe(first);
    expect(first.allowed_tx_types).not.toBe(DEFAULT_POLICY.allowed_tx_types);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.allowed_tx_types)).toBe(true);
    expect(Object.isFrozen(first.issuer_allowlist)).toBe(true);
    expect(Object.isFrozen(first.networks)).toBe(true);
    expect(() => first.allowed_tx_types.push("Payment")).toThrow();
    expect(DEFAULT_POLICY.allowed_tx_types).not.toContain("Payment");
    expect(h.storeFor("alpha").insertPolicy).not.toHaveBeenCalled();
  });

  it("inserts a validated policy with the injected clock", async () => {
    const h = harness();
    const configured = policy({
      max_per_tx_usd: 100,
      daily_cap_usd: 300,
      execute_under_usd: 25,
    });

    const result = await handlePolicySet(h.context("alpha"), {
      owner: OWNER,
      network: "testnet",
      policy: configured,
    });

    expect(result).toEqual(configured);
    expect(result).not.toBe(configured);
    expect(h.storeFor("alpha").insertPolicy).toHaveBeenCalledWith({
      owner: OWNER,
      network: "testnet",
      json: configured,
      updatedAt: NOW,
    });
    expect(h.storeFor("alpha").updatePolicy).not.toHaveBeenCalled();
    expect(
      await handlePolicyGet(h.context("alpha"), {
        owner: OWNER,
        network: "testnet",
      }),
    ).toEqual(configured);
  });

  it("updates an existing policy instead of inserting another row", async () => {
    const h = harness();
    await handlePolicySet(h.context("alpha"), {
      owner: OWNER,
      network: "devnet",
      policy: policy(),
    });
    const replacement = policy({
      max_per_tx_usd: 400,
      daily_cap_usd: 400,
      execute_under_usd: 400,
      max_slippage_bps: 0,
    });

    const result = await handlePolicySet(h.context("alpha"), {
      owner: OWNER,
      network: "devnet",
      policy: replacement,
    });

    expect(result).toEqual(replacement);
    expect(h.storeFor("alpha").insertPolicy).toHaveBeenCalledTimes(1);
    expect(h.storeFor("alpha").updatePolicy).toHaveBeenCalledWith(
      OWNER,
      "devnet",
      { json: replacement, updatedAt: NOW },
    );
    expect(h.rows).toHaveLength(1);
  });

  it("recovers when another first writer wins the insert race", async () => {
    const h = harness();
    const store = h.storeFor("alpha");
    const winner = policy({ max_per_tx_usd: 300, daily_cap_usd: 300 });
    const requested = policy({ max_per_tx_usd: 400, daily_cap_usd: 400 });
    store.insertPolicy.mockImplementationOnce(async (input) => {
      h.rows.set(key("alpha", input.owner, input.network), {
        principal: "alpha",
        ...input,
        json: winner,
      });
      throw new Error("UNIQUE constraint failed");
    });

    await expect(
      handlePolicySet(h.context("alpha"), {
        owner: OWNER,
        network: "testnet",
        policy: requested,
      }),
    ).resolves.toEqual(requested);
    expect(store.updatePolicy).toHaveBeenCalledWith(OWNER, "testnet", {
      json: requested,
      updatedAt: NOW,
    });
    expect(h.rows.get(key("alpha", OWNER, "testnet"))?.json).toEqual(requested);
  });

  it("keeps policies isolated by principal", async () => {
    const h = harness();
    const alpha = policy({ max_per_tx_usd: 1000, daily_cap_usd: 1000 });
    const beta = policy({ daily_cap_usd: 9000 });

    await handlePolicySet(h.context("alpha"), {
      owner: OWNER,
      network: "testnet",
      policy: alpha,
    });
    await handlePolicySet(h.context("beta"), {
      owner: OWNER,
      network: "testnet",
      policy: beta,
    });

    expect(
      await handlePolicyGet(h.context("alpha"), {
        owner: OWNER,
        network: "testnet",
      }),
    ).toEqual(alpha);
    expect(
      await handlePolicyGet(h.context("beta"), {
        owner: OWNER,
        network: "testnet",
      }),
    ).toEqual(beta);
    expect(h.rows).toHaveLength(2);
  });

  it("accepts zero values and equality at every cap boundary", () => {
    expect(
      SafePolicySchema.parse(
        policy({
          max_per_tx_usd: 0,
          daily_cap_usd: 0,
          execute_under_usd: 0,
          max_slippage_bps: 0,
          x402_max_per_call_drops: "0",
          x402_daily_cap_drops: "0",
        }),
      ),
    ).toBeDefined();
    expect(
      SafePolicySchema.parse(
        policy({
          max_per_tx_usd: 50,
          daily_cap_usd: 50,
          execute_under_usd: 50,
          x402_max_per_call_drops: "50",
          x402_daily_cap_drops: "50",
        }),
      ),
    ).toBeDefined();
  });

  it.each([
    ["max_per_tx_usd", -1],
    ["daily_cap_usd", -1],
    ["execute_under_usd", -1],
    ["max_slippage_bps", -1],
    ["max_per_tx_usd", Number.POSITIVE_INFINITY],
    ["daily_cap_usd", Number.NaN],
  ] as const)("rejects unsafe numeric value %s=%s", (field, value) => {
    expect(() => SafePolicySchema.parse(policy({ [field]: value }))).toThrow();
  });

  it.each([
    policy({ execute_under_usd: 2001 }),
    policy({ max_per_tx_usd: 5001 }),
    policy({ x402_max_per_call_drops: "1000001" }),
    policy({ x402_max_per_call_drops: "-1" }),
    policy({ x402_daily_cap_drops: "1.5" }),
  ])("rejects reversed caps and invalid drops", (candidate) => {
    expect(() => SafePolicySchema.parse(candidate)).toThrow();
  });

  it.each([
    policy({ allowed_tx_types: ["OfferCreate", "OfferCreate"] }),
    policy({ issuer_allowlist: ["RLUSD", "RLUSD"] }),
    policy({ networks: ["testnet", "testnet"] }),
  ])("rejects duplicate policy list values", (candidate) => {
    expect(() => SafePolicySchema.parse(candidate)).toThrow(/unique/i);
  });

  it("rejects any attempt to enable mainnet execution", async () => {
    const h = harness();
    await expect(
      handlePolicySet(h.context("alpha"), {
        owner: OWNER,
        network: "mainnet",
        policy: policy({ networks: ["mainnet"] }),
      }),
    ).rejects.toThrow(/mainnet execution/i);
    expect(h.storeFor("alpha").insertPolicy).not.toHaveBeenCalled();
    expect(h.rows).toHaveLength(0);
  });

  it("strictly rejects malformed get and set arguments", () => {
    expect(() =>
      PolicyGetArgsSchema.parse({
        owner: "not-an-address",
        network: "testnet",
      }),
    ).toThrow(/valid XRPL classic address/i);
    expect(() =>
      PolicyGetArgsSchema.parse({
        owner: OWNER,
        network: "sidechain",
      }),
    ).toThrow();
    expect(() =>
      PolicyGetArgsSchema.parse({
        owner: OWNER,
        network: "testnet",
        secret: "never accepted",
      }),
    ).toThrow();
    expect(() =>
      PolicySetArgsSchema.parse({
        owner: OWNER,
        network: "testnet",
        policy: { ...policy(), extra: true },
      }),
    ).toThrow();
    expect(() =>
      PolicySetArgsSchema.parse({
        owner: OWNER,
        network: "testnet",
        policy: { ...policy(), daily_cap_usd: undefined },
      }),
    ).toThrow();
  });
});
