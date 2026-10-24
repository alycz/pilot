import { DEFAULT_POLICY } from "@pilot/contracts";
import { createHarborRestClient } from "@pilot/harbor-client";
import { describe, expect, it } from "vitest";

import { createAgentTools, executeProposedIntent } from "../src/tools.js";

const account = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const issuer = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";

function swap(amount: string, id = `intent-swap-${amount}`) {
  return {
    id,
    network: "testnet",
    kind: "swap",
    sell: { currency: "RLUSD", issuer },
    buy: { currency: "XRP" },
    amount,
    side: "sell",
    max_slippage_bps: 100,
  } as const;
}

describe("executeProposedIntent", () => {
  it("takes a 50 RLUSD swap through delegated validation in order", async () => {
    const states: string[] = [];
    const result = await executeProposedIntent(swap("50"), {
      account: {
        main_account: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
        budget_account: account,
      },
      network: "testnet",
      harborRest: createHarborRestClient({ mock: true }),
      emitCard: (event) => {
        states.push(event.state);
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.state).toBe("validated");
    expect(result.exec).toMatchObject({
      status: "executed",
      signed_by: "delegate",
      hash: expect.stringMatching(/^[A-F0-9]+$/),
      ledger_index: expect.any(Number),
    });
    expect(result.build?.tx_json).toMatchObject({
      TransactionType: "OfferCreate",
      Account: account,
    });
    expect(states).toEqual([
      "drafting",
      "planned",
      "simulated",
      "policy_checked",
      "executing",
      "submitted",
      "validated",
    ]);
  });

  it("stops a 1,000 RLUSD swap at awaiting_approval", async () => {
    const states: string[] = [];
    const result = await executeProposedIntent(swap("1000"), {
      account: {
        main_account: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
        budget_account: account,
      },
      network: "testnet",
      harborRest: createHarborRestClient({ mock: true }),
      emitCard: (event) => {
        states.push(event.state);
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.state).toBe("awaiting_approval");
    expect(result.exec).toMatchObject({
      status: "needs_approval",
      policy: { verdict: "needs_approval" },
    });
    expect(states).toEqual([
      "drafting",
      "planned",
      "simulated",
      "policy_checked",
      "awaiting_approval",
    ]);
  });

  it("does not retry an equivalent policy-blocked intent", async () => {
    const harbor = createHarborRestClient({ mock: true });
    let calls = 0;
    const tools = createAgentTools({
      account: {
        main_account: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
        budget_account: account,
      },
      network: "testnet",
      harborRest: {
        op: async (name, args) => {
          calls += 1;
          const call = harbor.op as unknown as (
            operation: string,
            input: Record<string, unknown>,
          ) => Promise<any>;
          return call.call(harbor, name, args);
        },
      },
      harborMcp: { tools: {}, close: async () => undefined },
    });
    const execute = (tools as Record<string, any>).propose_intent.execute as unknown as (
      intent: unknown,
    ) => Promise<{ state: string; error?: string }>;

    const first = await execute(swap("5000", "blocked-1"));
    const callsAfterBlock = calls;
    const second = await execute(swap("5000", "blocked-2"));

    expect(first.state).toBe("blocked");
    expect(second).toMatchObject({
      state: "blocked",
      error: expect.stringContaining("was not retried"),
    });
    expect(calls).toBe(callsAfterBlock);
  });

  it("allows only one sequential propose_intent mutation per authenticated run", async () => {
    const harbor = createHarborRestClient({ mock: true });
    const calls: string[] = [];
    const tools = createAgentTools({
      account: {
        main_account: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
        budget_account: account,
      },
      network: "testnet",
      harborRest: {
        op: async (name, args) => {
          calls.push(name);
          return harbor.op(name, args);
        },
      },
      harborMcp: { tools: {}, close: async () => undefined },
    });
    const execute = (tools as Record<string, any>).propose_intent.execute as unknown as (
      intent: unknown,
    ) => Promise<{ state: string; error?: string }>;

    await expect(execute(swap("50", "one-shot-first"))).resolves.toMatchObject({
      state: "validated",
    });
    await expect(execute(swap("25", "one-shot-second"))).resolves.toMatchObject({
      state: "blocked",
      error: expect.stringContaining("same wallet proof"),
    });
    expect(calls.filter((name) => name === "tx.swap")).toHaveLength(1);
    expect(calls.filter((name) => name === "tx.execute")).toHaveLength(1);
  });

  it("atomically rejects a concurrent second propose_intent mutation", async () => {
    const harbor = createHarborRestClient({ mock: true });
    const calls: string[] = [];
    const tools = createAgentTools({
      account: {
        main_account: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
        budget_account: account,
      },
      network: "testnet",
      harborRest: {
        op: async (name, args) => {
          calls.push(name);
          return harbor.op(name, args);
        },
      },
      harborMcp: { tools: {}, close: async () => undefined },
    });
    const execute = (tools as Record<string, any>).propose_intent.execute as unknown as (
      intent: unknown,
    ) => Promise<{ state: string; error?: string }>;

    const first = execute(swap("50", "concurrent-first"));
    const second = execute(swap("25", "concurrent-second"));
    await expect(first).resolves.toMatchObject({ state: "validated" });
    await expect(second).resolves.toMatchObject({
      state: "blocked",
      error: expect.stringContaining("same wallet proof"),
    });
    expect(calls.filter((name) => name === "tx.swap")).toHaveLength(1);
    expect(calls.filter((name) => name === "tx.execute")).toHaveLength(1);
  });

  it("rejects mainnet or mismatched intents before calling Harbor", async () => {
    let calls = 0;
    const harborRest = {
      op: async () => {
        calls += 1;
        throw new Error("Harbor must not be called");
      },
    };
    const options = {
      account: {
        main_account: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
        budget_account: account,
      },
      network: "testnet" as const,
      harborRest,
    };

    const mainnet = await executeProposedIntent(
      { ...swap("50", "mainnet-intent"), network: "mainnet" },
      options,
    );
    const devnet = await executeProposedIntent(
      { ...swap("50", "devnet-intent"), network: "devnet" },
      options,
    );

    expect(mainnet).toMatchObject({
      state: "failed",
      error: expect.stringContaining("Mainnet"),
    });
    expect(devnet).toMatchObject({
      state: "failed",
      error: expect.stringContaining("server-authorized testnet"),
    });
    expect(calls).toBe(0);
  });

  it.each([
    ["failed simulation", (data: any) => ({
      ...data,
      simulate: { ...data.simulate, engine_result: "tecFAILED" },
    })],
    ["failed preflight", (data: any) => ({
      ...data,
      preflight: data.preflight.map((check: any, index: number) =>
        index === 0 ? { ...check, pass: false } : check),
    })],
  ])("never executes a build with %s", async (_label, mutate) => {
    const harbor = createHarborRestClient({ mock: true });
    let executeCalls = 0;
    const result = await executeProposedIntent(swap("50", `unsafe-${_label}`), {
      account: {
        main_account: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
        budget_account: account,
      },
      network: "testnet",
      harborRest: {
        op: async (name, args) => {
          if (name === "tx.execute") {
            executeCalls += 1;
            throw new Error("unsafe build must not execute");
          }
          const envelope = await harbor.op(name, args);
          return envelope.ok ? { ...envelope, data: mutate(envelope.data) } : envelope;
        },
      },
    });

    expect(result).toMatchObject({
      state: "failed",
      error: expect.stringContaining("simulation and preflight"),
    });
    expect(executeCalls).toBe(0);
  });

  it.each([
    ["transaction type", (data: any) => ({ ...data, tx_json: { ...data.tx_json, TransactionType: "Payment" } })],
    ["fixed amount", (data: any) => ({
      ...data,
      tx_json: { ...data.tx_json, TakerGets: { ...data.tx_json.TakerGets, value: "49" } },
    })],
    ["fixed asset", (data: any) => ({
      ...data,
      tx_json: { ...data.tx_json, TakerGets: { ...data.tx_json.TakerGets, issuer: account } },
    })],
    ["floating asset", (data: any) => ({
      ...data,
      tx_json: { ...data.tx_json, TakerPays: { currency: "USD", issuer: account, value: "97" } },
    })],
    ["unrequested offer field", (data: any) => ({
      ...data,
      tx_json: { ...data.tx_json, OfferSequence: 1 },
    })],
  ])("never executes a build with a changed %s", async (_label, mutate) => {
    const harbor = createHarborRestClient({ mock: true });
    let executeCalls = 0;
    const result = await executeProposedIntent(swap("50", `semantic-${_label}`), {
      account: {
        main_account: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
        budget_account: account,
      },
      network: "testnet",
      harborRest: {
        op: async (name, args) => {
          if (name === "tx.execute") {
            executeCalls += 1;
            throw new Error("mismatched build must not execute");
          }
          const envelope = await harbor.op(name, args);
          return envelope.ok ? { ...envelope, data: mutate(envelope.data) } : envelope;
        },
      },
    });

    expect(result).toMatchObject({
      state: "failed",
      error: expect.stringContaining("does not match the validated intent"),
    });
    expect(executeCalls).toBe(0);
  });

  it("rejects a limit build with a changed ledger expiration", async () => {
    const harbor = createHarborRestClient({ mock: true });
    let executeCalls = 0;
    const result = await executeProposedIntent({
      id: "limit-expiry",
      network: "testnet",
      kind: "limit",
      sell: { currency: "RLUSD", issuer },
      buy: { currency: "XRP" },
      sell_amount: "5",
      buy_amount: "10",
      expires_at: "2030-01-02T03:04:05.000Z",
    }, {
      account: { main_account: account, budget_account: account },
      network: "testnet",
      harborRest: {
        op: async (name, args) => {
          if (name === "tx.execute") { executeCalls += 1; throw new Error("must not execute"); }
          const envelope = await harbor.op(name, args);
          return envelope.ok
            ? { ...envelope, data: { ...envelope.data, tx_json: { ...envelope.data.tx_json, Expiration: envelope.data.tx_json.Expiration + 1 } } }
            : envelope;
        },
      },
    });
    expect(result).toMatchObject({ state: "failed", error: expect.stringContaining("validated intent") });
    expect(executeCalls).toBe(0);
  });

  it("fails closed when a requested payment memo cannot be bound to the transaction", async () => {
    const harbor = createHarborRestClient({ mock: true });
    let executeCalls = 0;
    const result = await executeProposedIntent({
      id: "payment-memo",
      network: "testnet",
      kind: "pay",
      to: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
      asset: { currency: "XRP" },
      amount: "1",
      memo: "must be exact",
    }, {
      account: { main_account: account, budget_account: account },
      network: "testnet",
      harborRest: {
        op: async (name, args) => {
          if (name === "tx.execute") { executeCalls += 1; throw new Error("must not execute"); }
          return harbor.op(name, args);
        },
      },
    });
    expect(result).toMatchObject({ state: "failed", error: expect.stringContaining("validated intent") });
    expect(executeCalls).toBe(0);
  });
});

describe("createAgentTools Harbor boundary", () => {
  it("exposes only canonical read-only Harbor execution", async () => {
    const calls: string[] = [];
    const tools = createAgentTools({
      account: {
        main_account: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
        budget_account: account,
      },
      network: "testnet",
      harborRest: createHarborRestClient({ mock: true }),
      harborMcp: {
        tools: {
          harbor_execute: {
            execute: async ({ code }: { code: string }) => {
              calls.push(code);
              return { ok: true };
            },
          } as any,
          unsafe_extra_tool: { execute: async () => ({ ok: true }) } as any,
        },
        close: async () => undefined,
      },
    });
    const execute = (tools as Record<string, any>).harbor_execute
      .execute as (input: { code: string }) => Promise<unknown>;

    await expect(
      execute({
        code: `return await harbor.ledger.account.info({"network":"testnet","account":"${account}"});`,
      }),
    ).resolves.toEqual({ ok: true });
    expect(calls).toEqual([
      `return await harbor.ledger.account.info({"network":"testnet","account":"${account}"});`,
    ]);
    await expect(
      execute({
        code: 'return await harbor.tx.execute({"build_id":"b","idempotency_key":"i"});',
      }),
    ).rejects.toThrow("not read-only");
    await expect(
      execute({
        code: 'return await harbor.venues.list({"network":"mainnet"});',
      }),
    ).rejects.toThrow("server-authorized network");
    expect(tools).not.toHaveProperty("unsafe_extra_tool");
    expect(calls).toHaveLength(1);
  });

  it("emits only the safe guardrail notice projection for an eligible result", async () => {
    const notices: unknown[] = [];
    const tools = createAgentTools({
      account: {
        main_account: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
        budget_account: account,
      },
      network: "testnet",
      harborRest: createHarborRestClient({ mock: true }),
      harborMcp: {
        tools: {
          harbor_execute: {
            execute: async () => ({
              ok: true,
              data: { document_snippet: "hostile provider text" },
              caveat: ["screened-redacted"],
              trust: {
                screen: {
                  provider: "mock",
                  fields_checked: 2,
                  fields_blocked: 1,
                  blocked_field_kinds: ["document-snippet"],
                },
              },
            }),
          } as any,
        },
        close: async () => undefined,
      },
      emitGuardrailNotice: (notice) => {
        notices.push(notice);
      },
    });
    const execute = (tools as Record<string, any>).harbor_execute
      .execute as (input: { code: string }) => Promise<unknown>;

    await execute({ code: "return await harbor.venues.list({});" });
    await execute({ code: "return await harbor.venues.list({});" });

    expect(notices).toEqual([
      {
        provider: "mock",
        caveat: "screened-redacted",
        fields_checked: 2,
        fields_blocked: 1,
        blocked_field_kinds: ["document-snippet"],
      },
    ]);
    expect(JSON.stringify(notices)).not.toContain("hostile provider text");
  });

  it("streams preference proposals without persisting them", async () => {
    const proposals: unknown[] = [];
    const tools = createAgentTools({
      account: {
        main_account: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
        budget_account: account,
      },
      network: "testnet",
      harborRest: createHarborRestClient({ mock: true }),
      harborMcp: { tools: {}, close: async () => undefined },
      now: () => new Date("2026-10-18T00:00:00.000Z"),
      emitPreference: (event) => {
        proposals.push(event);
      },
    });
    const propose = (tools as Record<string, any>).propose_preference
      .execute as (input: unknown) => Promise<unknown>;

    await expect(
      propose({
        id: "pref-1",
        preference: "Prefer AMM routes",
        reason: "Lower simulated slippage",
      }),
    ).resolves.toMatchObject({ state: "proposed" });
    expect(proposals).toEqual([
      expect.objectContaining({
        id: "pref-1",
        state: "proposed",
        at: "2026-10-18T00:00:00.000Z",
      }),
    ]);
  });
});

describe("Policy.md application", () => {
  it("applies the latest saved policy to the same Harbor client before execute", async () => {
    const harbor = createHarborRestClient({ mock: true });
    const result = await executeProposedIntent(swap("50", "policy-sync"), {
      account: {
        main_account: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
        budget_account: account,
      },
      network: "testnet",
      harborRest: harbor,
      loadPolicy: async () => ({
        ...DEFAULT_POLICY,
        execute_under_usd: 25,
      }),
    });

    expect(result).toMatchObject({
      state: "awaiting_approval",
      exec: { status: "needs_approval" },
    });
  });
});
