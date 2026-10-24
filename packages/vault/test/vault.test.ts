import { DEFAULT_POLICY, type Profile } from "@pilot/contracts";
import matter from "gray-matter";
import { describe, expect, it, vi } from "vitest";

import { writePolicyNote, writeProfileNote, writeTradeNote } from "../src/notes";
import type {
  PolicySync,
  VaultBackend,
  VaultReadSnapshotOptions,
} from "../src/types";
import { VaultService } from "../src/vault";

const account = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";

class MemoryBackend implements VaultBackend {
  readonly files = new Map<string, string>();
  readonly writes: string[] = [];
  listCalls = 0;
  writeAttempts = 0;
  failOnWriteAttempt?: number;

  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async list(prefix = ""): Promise<string[]> {
    this.listCalls += 1;
    return [...this.files.keys()].filter(
      (path) => !prefix || path === prefix || path.startsWith(`${prefix}/`),
    );
  }

  async write(path: string, content: string): Promise<void> {
    this.writeAttempts += 1;
    if (this.writeAttempts === this.failOnWriteAttempt) throw new Error("injected write failure");
    this.files.set(path, content);
    this.writes.push(path);
  }

  async openReadSnapshot(options: VaultReadSnapshotOptions = {}) {
    const prefix = options.prefix ?? "";
    const maxEntries = options.maxEntries ?? Number.MAX_SAFE_INTEGER;
    const captured = new Map(
      [...this.files.entries()]
        .filter(([path]) => !prefix || path === prefix || path.startsWith(`${prefix}/`))
        .slice(0, maxEntries),
    );
    return {
      revision: "memory-1",
      list: async (requestedPrefix = "") => [...captured.entries()]
        .filter(([path]) => !requestedPrefix || path === requestedPrefix || path.startsWith(`${requestedPrefix}/`))
        .map(([path, content]) => ({ path, size: Buffer.byteLength(content, "utf8") })),
      read: async (path: string, maxBytes: number) => {
        const content = captured.get(path) ?? null;
        if (content !== null && Buffer.byteLength(content, "utf8") > maxBytes) {
          throw new Error("bounded read exceeded");
        }
        return content;
      },
    };
  }
}

const profile: Profile = {
  main_account: "rMain",
  budget_account: "rBudget",
  network: "testnet",
  risk: "low",
  preferences: [],
};

describe("VaultService", () => {
  it("rebuilds MiniSearch after every write", async () => {
    const backend = new MemoryBackend();
    const vault = new VaultService(backend);
    await vault.write(
      "Pilot/Tokens/XRP.md",
      "---\ntype: token\ncode: XRP\n---\n# XRP\n\nNative ledger asset and bridge currency.",
    );
    expect(backend.listCalls).toBe(1);
    expect(await vault.search("bridge")).toMatchObject([
      { path: "Pilot/Tokens/XRP.md", title: "XRP" },
    ]);
    expect(backend.listCalls).toBe(2);

    await vault.write(
      "Pilot/Tokens/RLUSD.md",
      "---\ntype: token\ncode: RLUSD\n---\n# RLUSD\n\nDollar stablecoin.",
    );
    expect(backend.listCalls).toBe(3);
    expect((await vault.search("stablecoin"))[0]?.path).toBe("Pilot/Tokens/RLUSD.md");
    expect(backend.listCalls).toBe(4);
  });

  it("rejects credential material before it reaches a backend", async () => {
    const backend = new MemoryBackend();
    const vault = new VaultService(backend);
    await expect(
      vault.write("Pilot/Profile.md", "---\nseed: sEd123456789ABCDEFGHJKLMNPQ\n---\n"),
    ).rejects.toThrow(/cannot contain seeds/i);
    expect(backend.writes).toEqual([]);
  });

  it("reserves private personalization state from generic vault writes", async () => {
    const backend = new MemoryBackend();
    const vault = new VaultService(backend);
    await expect(vault.write(
      "Pilot/Personalization/tenant/testnet/owner/Preferences.json",
      "{}",
    )).rejects.toThrow(/cannot be written through the Markdown vault API/i);
    expect(backend.writes).toEqual([]);
  });

  it("syncs policy.set before saving Policy.md", async () => {
    const backend = new MemoryBackend();
    backend.files.set("Pilot/Profile.md", writeProfileNote(profile).content);
    const policySync = vi.fn<PolicySync>().mockResolvedValue(undefined);
    const vault = new VaultService(backend, { policySync });
    const policy = { ...DEFAULT_POLICY, execute_under_usd: 100 };
    await vault.write("Pilot/Policy.md", writePolicyNote(policy).content);
    expect(policySync).toHaveBeenCalledWith({
      owner: "rBudget",
      network: "testnet",
      policy,
    });
    expect(backend.files.has("Pilot/Policy.md")).toBe(true);
  });

  it("does not persist a policy when Harbor rejects it", async () => {
    const backend = new MemoryBackend();
    backend.files.set("Pilot/Profile.md", writeProfileNote(profile).content);
    const vault = new VaultService(backend, {
      policySync: vi.fn().mockRejectedValue(new Error("policy.set rejected")),
    });
    await expect(vault.write("Pilot/Policy.md", writePolicyNote(DEFAULT_POLICY).content)).rejects.toThrow(
      /policy\.set rejected/,
    );
    expect(backend.files.has("Pilot/Policy.md")).toBe(false);
  });

  it("writes a complete linked note set for validated execution", async () => {
    const backend = new MemoryBackend();
    const vault = new VaultService(backend);
    const paths = await vault.recordValidatedTransaction({
      intent: {
        id: "intent-1",
        network: "testnet",
        kind: "swap",
        sell: { currency: "RLUSD", issuer: "rIssuer" },
        buy: { currency: "XRP" },
        amount: "50",
        side: "sell",
        max_slippage_bps: 100,
      },
      hash: "ABC123",
      venue: "xrpl-amm",
      assets: [{ currency: "RLUSD", issuer: "rIssuer" }, { currency: "XRP" }],
      result: "filled",
      fillPrice: "0.5",
      slippageBps: 9,
      signedBy: "delegate",
      created: "2026-10-18T12:00:00.000Z",
      expected: { fillPrice: "0.51", slippageBps: 10 },
    });

    expect(paths).toEqual([
      "Pilot/Trades/ABC123.md",
      "Pilot/Journal/2026-10-18.md",
      "Pilot/Venues/xrpl-amm.md",
      "Pilot/Tokens/RLUSD.md",
      "Pilot/Tokens/XRP.md",
      "Pilot/Reflections/ABC123.md",
    ]);
    expect(backend.writes).toEqual(paths);
    expect(backend.listCalls).toBe(paths.length);
    expect(backend.files.get("Pilot/Venues/xrpl-amm.md")).toContain("[[ABC123]]");
    expect(backend.files.get("Pilot/Tokens/XRP.md")).toContain("[[xrpl-amm]]");
    expect(backend.files.get("Pilot/Reflections/ABC123.md")).toContain("[[ABC123]]");
  });

  it("writes Profile.md only for an explicitly accepted preference", async () => {
    const backend = new MemoryBackend();
    backend.files.set("Pilot/Profile.md", writeProfileNote(profile).content);
    const vault = new VaultService(backend);
    const proposal = { id: "pref-1", preference: "Prefer AMM routes" };
    expect((await vault.applyPreference(proposal, false)).preferences).toEqual([]);
    expect(backend.writes).toEqual([]);
    expect((await vault.applyPreference(proposal, true)).preferences).toEqual([
      "Prefer AMM routes",
    ]);
    expect((await vault.applyPreference(proposal, true)).preferences).toEqual([
      "Prefer AMM routes",
    ]);
    expect(backend.writes).toEqual(["Pilot/Profile.md"]);
  });

  it("accepts a preference only in the authenticated wallet scope", async () => {
    const backend = new MemoryBackend();
    const owner = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
    const other = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
    const scope = { owner, network: "testnet" as const };
    const scopedPath = `Pilot/Scopes/testnet/${owner}/Profile.md`;
    backend.files.set(scopedPath, writeProfileNote({
      ...profile,
      main_account: owner,
      budget_account: owner,
    }).content);
    backend.files.set("Pilot/Profile.md", writeProfileNote(profile).content);
    const vault = new VaultService(backend);

    const updated = await vault.applyScopedPreference(
      scope,
      { id: "pref-scoped", preference: "Keep 25 XRP liquid" },
      true,
    );
    await vault.applyScopedPreference(
      scope,
      { id: "pref-scoped", preference: "Keep 25 XRP liquid" },
      true,
    );
    expect(updated.preferences).toEqual(["Keep 25 XRP liquid"]);
    expect(backend.files.get(scopedPath)).toContain("Keep 25 XRP liquid");
    expect(backend.files.get("Pilot/Profile.md")).not.toContain("Keep 25 XRP liquid");
    expect(backend.writes).toEqual([scopedPath]);
    await expect(vault.applyScopedPreference(
      { owner: other, network: "testnet" },
      { id: "pref-foreign", preference: "Change another profile" },
      true,
    )).rejects.toThrow(/matching scoped Profile\.md/i);
  });

  it("bounds accepted preference fields and profile growth", async () => {
    const backend = new MemoryBackend();
    backend.files.set("Pilot/Profile.md", writeProfileNote(profile).content);
    const vault = new VaultService(backend);
    await expect(vault.applyPreference({
      id: "x".repeat(129),
      preference: "bounded",
    }, true)).rejects.toThrow(/id is invalid/i);
    await expect(vault.applyPreference({
      id: "bounded",
      preference: "x".repeat(501),
    }, true)).rejects.toThrow(/1 to 500/i);
    backend.files.set("Pilot/Profile.md", writeProfileNote({
      ...profile,
      preferences: Array.from({ length: 256 }, (_, index) => `existing-${index}`),
    }).content);
    await expect(vault.applyPreference({
      id: "overflow",
      preference: "one-too-many",
    }, true)).rejects.toThrow(/more than 256/i);
    expect(backend.writes).toEqual([]);
  });

  it("blocks preference changes through the generic Profile.md writer", async () => {
    const backend = new MemoryBackend();
    backend.files.set("Pilot/Profile.md", writeProfileNote(profile).content);
    const vault = new VaultService(backend);
    await expect(
      vault.write(
        "Pilot/Profile.md",
        writeProfileNote({ ...profile, preferences: ["Unapproved preference"] }).content,
      ),
    ).rejects.toThrow(/explicit preference acceptance/i);
    expect(backend.writes).toEqual([]);
  });

  it("records only delivered x402 evidence in the matching Testnet scope", async () => {
    const backend = new MemoryBackend();
    const vault = new VaultService(backend);
    const scope = { owner: account, network: "testnet" as const, mainAccount: "rMain" };
    const input = {
      paymentId: "payment:/\\:支付",
      idempotencyKey: "pilot-x402:operation-402-1",
      owner: account,
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

    const paths = await vault.recordScopedX402Payment(scope, input);
    expect(paths[0]).toMatch(new RegExp(`^Pilot/Scopes/testnet/${account}/X402/Receipts/receipt-[a-f0-9]{64}\\.md$`));
    expect(paths[1]).toMatch(new RegExp(`^Pilot/Scopes/testnet/${account}/X402/payment-[a-f0-9]{64}\\.md$`));
    expect(paths[2]).toBe(`Pilot/Scopes/testnet/${account}/Journal/2026-10-19.md`);
    expect(backend.files.get(paths[0]!)).not.toContain("merchant_body");
    expect(matter(backend.files.get(paths[1]!)!).data.payment_id).toBe(input.paymentId);
    await vault.recordScopedX402Payment(scope, input);
    const paymentName = paths[1]!.split("/").at(-1)!.replace(/\.md$/, "");
    expect(backend.files.get(paths[2]!)?.split(`[[${paymentName}]]`)).toHaveLength(2);

    await expect(vault.recordScopedX402Payment(
      { ...scope, owner: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe" },
      input,
    )).rejects.toThrow(/does not match/i);
  });

  it("reconciles a partial x402 journal after restart without changing its date", async () => {
    const backend = new MemoryBackend();
    const scope = { owner: account, network: "testnet" as const, mainAccount: "rMain" };
    const input = {
      paymentId: "payment-restart-1",
      idempotencyKey: "pilot-x402:operation-restart-1",
      owner: account,
      network: "testnet" as const,
      resource: "compare" as const,
      invoiceId: "invoice-restart-1",
      amountDrops: "90000",
      feeDrops: "12",
      payer: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
      payTo: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
      txHash: "B".repeat(64),
      validatedLedgerIndex: 12_346,
      merchantStatus: 200 as const,
      merchantContentType: "application/json" as const,
      created: "2026-10-19T23:59:59.000Z",
    };
    backend.failOnWriteAttempt = 4;
    await expect(new VaultService(backend).recordScopedX402Payment(scope, input)).rejects.toThrow("injected");
    const receiptPath = [...backend.files.keys()].find((path) => path.includes("/X402/Receipts/"))!;
    const paymentPath = [...backend.files.keys()].find((path) => /\/X402\/payment-[a-f0-9]{64}\.md$/.test(path))!;
    expect(backend.files.get(receiptPath)).toContain("phase: pending");
    expect(backend.files.has(paymentPath)).toBe(true);
    expect(backend.files.has(`Pilot/Scopes/testnet/${account}/Journal/2026-10-19.md`)).toBe(false);

    backend.failOnWriteAttempt = undefined;
    await new VaultService(backend).recordScopedX402Payment(scope, {
      ...input,
      created: "2026-10-20T00:00:10.000Z",
    });
    expect(backend.files.get(receiptPath)).toContain("phase: complete");
    const paymentName = paymentPath.split("/").at(-1)!.replace(/\.md$/, "");
    expect(backend.files.get(`Pilot/Scopes/testnet/${account}/Journal/2026-10-19.md`)).toContain(`[[${paymentName}]]`);
    expect(backend.files.has(`Pilot/Scopes/testnet/${account}/Journal/2026-10-20.md`)).toBe(false);
    const writesAfterComplete = backend.writes.length;
    await new VaultService(backend).recordScopedX402Payment(scope, {
      ...input,
      created: "2026-10-21T00:00:10.000Z",
    });
    expect(backend.writes).toHaveLength(writesAfterComplete);
    await expect(new VaultService(backend).recordScopedX402Payment(scope, {
      ...input,
      feeDrops: "13",
      created: "2026-10-21T00:00:10.000Z",
    })).rejects.toThrow(/receipt does not match/i);
  });

  it("keeps journal retries idempotent and preserves rich upsert metadata", async () => {
    const backend = new MemoryBackend();
    const vault = new VaultService(backend);
    const base = {
      intent: {
        id: "intent-retry",
        network: "testnet" as const,
        kind: "cancel" as const,
        offer_sequence: 7,
      },
      hash: "RETRYHASH",
      venue: "xrpl-dex-clob",
      assets: [{ currency: "XRP" }],
      result: "success" as const,
      fillPrice: "1",
      slippageBps: 0,
      signedBy: "delegate" as const,
      created: "2026-10-18T12:00:00.000Z",
    };
    await vault.recordValidatedTransaction({
      ...base,
      venueDetails: {
        id: "xrpl-dex-clob",
        name: "XRPL DEX",
        kind: "execution-primitive",
        layer: "xrpl-l1",
        category: ["spot"],
        status: { testnet: "live" },
        reads: ["dex.book"],
        risks: ["price movement"],
        links: { docs: "https://xrpl.org/docs" },
      },
      tokenDetails: [{ asset: { currency: "XRP" }, name: "XRP", description: "Native asset" }],
    });
    await vault.recordValidatedTransaction({
      ...base,
      assets: [{ currency: "RLUSD", issuer: "rIssuer" }],
    });

    const journal = backend.files.get("Pilot/Journal/2026-10-18.md") ?? "";
    expect(journal.match(/\[\[RETRYHASH\]\]/g)).toHaveLength(1);
    expect(backend.files.get("Pilot/Venues/xrpl-dex-clob.md")).toContain("price movement");
    expect(backend.files.get("Pilot/Venues/xrpl-dex-clob.md")).toContain("[[XRP]]");
    expect(backend.files.get("Pilot/Venues/xrpl-dex-clob.md")).toContain("[[RLUSD]]");
    expect(backend.files.get("Pilot/Tokens/XRP.md")).toContain("Native asset");
  });

  it("writes validated notes only into a proven owner and network scope", async () => {
    const backend = new MemoryBackend();
    backend.files.set("Pilot/Profile.md", writeProfileNote(profile).content);
    const vault = new VaultService(backend);
    const owner = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
    const paths = await vault.recordScopedValidatedTransaction(
      { owner, network: "testnet", mainAccount: owner },
      {
        intent: {
          id: "scoped-intent",
          network: "testnet",
          kind: "cancel",
          offer_sequence: 7,
        },
        hash: "SCOPEDHASH",
        venue: "xrpl-dex-clob",
        assets: [],
        result: "success",
        fillPrice: "unavailable",
        slippageBps: 0,
        signedBy: "delegate",
        created: "2026-10-19T12:00:00.000Z",
      },
    );
    const prefix = `Pilot/Scopes/testnet/${owner}`;

    expect(paths.every((path) => path.startsWith(`${prefix}/`))).toBe(true);
    expect(backend.files.has(`${prefix}/Profile.md`)).toBe(true);
    expect(backend.files.has(`${prefix}/Trades/SCOPEDHASH.md`)).toBe(true);
    expect(backend.files.has("Pilot/Trades/SCOPEDHASH.md")).toBe(false);
    expect(backend.files.get("Pilot/Profile.md")).toBe(writeProfileNote(profile).content);
  });

  it("does not treat a legacy global profile as authorization for scoped writes", async () => {
    const backend = new MemoryBackend();
    backend.files.set("Pilot/Profile.md", writeProfileNote(profile).content);
    const vault = new VaultService(backend);
    await expect(vault.writeScoped(
      { owner: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59", network: "testnet" },
      "Pilot/Journal/new.md",
      "# New\n",
    )).rejects.toThrow(/matching scoped Profile/i);
    expect(backend.files.has("Pilot/Scopes/testnet/r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59/Journal/new.md"))
      .toBe(false);
  });

  it("initializes an authenticated empty scoped profile once without replacing existing state", async () => {
    const backend = new MemoryBackend();
    const vault = new VaultService(backend);
    const owner = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
    const scope = { owner, network: "testnet" as const, mainAccount: owner };
    const initial: Profile = {
      main_account: owner,
      budget_account: owner,
      network: "testnet",
      risk: "low",
      preferences: [],
    };

    const [first, replay] = await Promise.all([
      vault.ensureScopedProfile(scope, initial),
      vault.ensureScopedProfile(scope, initial),
    ]);
    expect(first).toEqual(initial);
    expect(replay).toEqual(initial);
    expect(backend.writes).toEqual([
      `Pilot/Scopes/testnet/${owner}/Profile.md`,
    ]);

    const retained = { ...initial, risk: "medium" as const, preferences: ["Concise research"] };
    backend.files.set(
      `Pilot/Scopes/testnet/${owner}/Profile.md`,
      writeProfileNote(retained).content,
    );
    await expect(vault.ensureScopedProfile(scope, initial)).resolves.toEqual(retained);
    expect(backend.files.get(`Pilot/Scopes/testnet/${owner}/Profile.md`))
      .toBe(writeProfileNote(retained).content);
    expect(backend.writes).toHaveLength(1);
  });

  it("fails closed when scoped profile initialization is not an empty exact identity", async () => {
    const backend = new MemoryBackend();
    const vault = new VaultService(backend);
    const owner = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
    const scope = { owner, network: "testnet" as const, mainAccount: owner };
    const initial: Profile = {
      main_account: owner,
      budget_account: owner,
      network: "testnet",
      risk: "low",
      preferences: [],
    };

    await expect(vault.ensureScopedProfile(scope, {
      ...initial,
      main_account: "r3vi7mWxru9rJCxETCyA1CHvzL96eZWx5z",
    })).rejects.toThrow(/authenticated identity namespace/i);
    await expect(vault.ensureScopedProfile(scope, {
      ...initial,
      preferences: ["client-selected"],
    })).rejects.toThrow(/start without accepted preferences/i);

    backend.files.set(
      `Pilot/Scopes/testnet/${owner}/Profile.md`,
      writeProfileNote({
        ...initial,
        main_account: "r3vi7mWxru9rJCxETCyA1CHvzL96eZWx5z",
      }).content,
    );
    await expect(vault.ensureScopedProfile(scope, initial))
      .rejects.toThrow(/authenticated identity namespace/i);
    expect(backend.writes).toEqual([]);
  });

  it("keeps scoped search and reads isolated when the owner changes", async () => {
    const backend = new MemoryBackend();
    const vault = new VaultService(backend);
    const ownerA = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
    const ownerB = "r3vi7mWxru9rJCxETCyA1CHvzL96eZWx5z";
    const scopeA = { owner: ownerA, network: "testnet" as const };
    const scopeB = { owner: ownerB, network: "testnet" as const };
    await vault.saveScopedProfile(scopeA, {
      main_account: ownerA,
      budget_account: ownerA,
      network: "testnet",
      risk: "low",
      preferences: [],
    });
    await vault.writeScoped(scopeA, "Pilot/Journal/private-a.md", "# Alpha owner\n\nsecret-alpha-marker\n");
    await vault.saveScopedProfile(scopeB, {
      main_account: ownerB,
      budget_account: ownerB,
      network: "testnet",
      risk: "low",
      preferences: [],
    });
    await vault.writeScoped(scopeB, "Pilot/Journal/private-b.md", "# Beta owner\n\nsecret-beta-marker\n");

    const crossOwnerSearch = await vault.searchScoped(scopeB, "secret-alpha-marker");
    expect(crossOwnerSearch.every((result) => result.path !== "Pilot/Journal/private-a.md")).toBe(true);
    expect(JSON.stringify(crossOwnerSearch)).not.toContain("secret-alpha-marker");
    expect(await vault.searchScoped(scopeB, "secret-beta-marker")).toMatchObject([
      { path: "Pilot/Journal/private-b.md" },
    ]);
    expect(await vault.readScoped(scopeB, "Pilot/Journal/private-a.md")).toBeNull();
    expect(await vault.readScoped(scopeB, "Pilot/Journal/private-b.md")).toContain("secret-beta-marker");
    await expect(vault.readScoped(scopeB, `Pilot/Scopes/testnet/${ownerA}/Journal/private-a.md`))
      .rejects.toThrow(/outside the scope namespace/i);
  });

  it("derives and revalidates exact scoped validated trade evidence without trusting a client path", async () => {
    const backend = new MemoryBackend();
    const vault = new VaultService(backend);
    const ownerA = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
    const ownerB = "r3vi7mWxru9rJCxETCyA1CHvzL96eZWx5z";
    const scopeA = { tenantId: "pilot-local", owner: ownerA, network: "testnet" as const };
    const scopeB = { tenantId: "pilot-local", owner: ownerB, network: "testnet" as const };
    for (const owner of [ownerA, ownerB]) {
      backend.files.set(`Pilot/Scopes/testnet/${owner}/Profile.md`, writeProfileNote({
        main_account: owner,
        budget_account: owner,
        network: "testnet",
        risk: "low",
        preferences: [],
      }).content);
    }
    const hash = "A".repeat(64);
    const note = writeTradeNote({
      intent_id: "intent-evidence-1",
      kind: "swap",
      network: "testnet",
      hash,
      venue: "xrpl-amm",
      assets: [{ currency: "XRP" }],
      result: "filled",
      fill_price: "1",
      slippage_bps: 0,
      signed_by: "owner",
      explorer: `https://testnet.xrpl.org/transactions/${hash}`,
      created: "2026-10-21T01:00:00.000Z",
    });
    backend.files.set(`Pilot/Scopes/testnet/${ownerA}/${note.path.slice("Pilot/".length)}`, note.content);

    const proof = await vault.latestScopedValidatedTradeEvidence(scopeA);
    expect(proof).toMatchObject({
      transactionHash: hash,
      observedAt: "2026-10-21T01:00:00.000Z",
      experienceKind: "validated_outcome_reviewed",
    });
    expect(proof?.sourceRef).toMatch(/^[0-9a-f]{64}$/);
    await expect(vault.verifyScopedValidatedTradeEvidence(scopeA, proof!.sourceRef)).resolves.toEqual(proof);
    await expect(vault.verifyScopedValidatedTradeEvidence(scopeB, proof!.sourceRef)).rejects.toThrow(/not found/i);
    await expect(vault.verifyScopedValidatedTradeEvidence(scopeA, "f".repeat(64))).rejects.toThrow(/not found/i);

    backend.files.set(`Pilot/Scopes/testnet/${ownerA}/Trades/${"B".repeat(64)}.md`, "---\ntype: trade\nnetwork: testnet\nhash: malformed\n---\n");
    await expect(vault.latestScopedValidatedTradeEvidence(scopeA)).rejects.toThrow(/malformed/i);
  });

  it("abstains from a trade-observation candidate when only one validated event exists", async () => {
    const backend = new MemoryBackend();
    const vault = new VaultService(backend);
    const owner = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
    const scope = { tenantId: "pilot-local", owner, network: "testnet" as const };
    backend.files.set(`Pilot/Scopes/testnet/${owner}/Profile.md`, writeProfileNote({
      main_account: owner,
      budget_account: owner,
      network: "testnet",
      risk: "low",
      preferences: [],
    }).content);
    const hash = "C".repeat(64);
    const note = writeTradeNote({
      intent_id: "intent-observation-1",
      kind: "swap",
      network: "testnet",
      hash,
      venue: "xrpl-amm",
      assets: [{ currency: "XRP" }],
      result: "filled",
      fill_price: "unavailable",
      slippage_bps: 9999,
      signed_by: "owner",
      explorer: `https://testnet.xrpl.org/transactions/${hash}`,
      created: "2026-10-21T01:00:00.000Z",
    });
    backend.files.set(`Pilot/Scopes/testnet/${owner}/${note.path.slice("Pilot/".length)}`, note.content);

    const summary = await vault.scopedTradeObservationSummary(scope);
    expect(summary).toMatchObject({
      status: "insufficient_evidence",
      totalValidatedTransactions: 1,
      minimumCandidateSupport: 2,
      kindCounts: [{ kind: "swap", count: 1 }],
      assetCounts: [{ asset: "XRP", count: 1 }],
      cancellationCount: 0,
      unavailableFeedback: ["approval", "rejection"],
    });
    expect(summary).not.toHaveProperty("candidate");
    expect(JSON.stringify(summary)).not.toMatch(/fill|slippage|profit|risk|venue/i);
  });

  it("summarizes repeated scoped facts and emits one deterministic factual candidate", async () => {
    const backend = new MemoryBackend();
    const vault = new VaultService(backend);
    const owner = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
    const scope = { tenantId: "pilot-local", owner, network: "testnet" as const };
    backend.files.set(`Pilot/Scopes/testnet/${owner}/Profile.md`, writeProfileNote({
      main_account: owner,
      budget_account: owner,
      network: "testnet",
      risk: "low",
      preferences: [],
    }).content);
    for (const [index, kind] of ["swap", "limit"].entries()) {
      const hash = (index === 0 ? "D" : "E").repeat(64);
      const note = writeTradeNote({
        intent_id: `intent-observation-${index + 2}`,
        kind: kind as "swap" | "limit",
        network: "testnet",
        hash,
        venue: "xrpl-dex",
        assets: [{ currency: "XRP" }],
        result: index === 0 ? "filled" : "resting",
        fill_price: "unavailable",
        slippage_bps: index === 0 ? 0 : 10_000,
        signed_by: index === 0 ? "owner" : "delegate",
        explorer: `https://testnet.xrpl.org/transactions/${hash}`,
        created: `2026-10-21T0${index + 1}:00:00.000Z`,
      });
      backend.files.set(`Pilot/Scopes/testnet/${owner}/${note.path.slice("Pilot/".length)}`, note.content);
    }

    const summary = await vault.scopedTradeObservationSummary(scope);
    expect(summary).toMatchObject({
      status: "summary",
      totalValidatedTransactions: 2,
      firstObservedAt: "2026-10-21T01:00:00.000Z",
      lastObservedAt: "2026-10-21T02:00:00.000Z",
      kindCounts: [
        { kind: "limit", count: 1 },
        { kind: "swap", count: 1 },
      ],
      assetCounts: [{ asset: "XRP", count: 2 }],
      candidate: {
        kind: "frequent_asset_context",
        subject: "XRP",
        supportCount: 2,
        confidence: 0.5,
      },
    });
    expect(summary.candidate?.evidenceRefs).toHaveLength(2);
    expect(summary.candidate?.evidenceRefs.every((value) => /^[0-9a-f]{64}$/.test(value))).toBe(true);
    expect(JSON.stringify(summary)).not.toMatch(/fill|slippage|profit|risk|venue/i);
  });

  it("abstains when multiple validated events contain no repeated kind or asset", async () => {
    const backend = new MemoryBackend();
    const vault = new VaultService(backend);
    const owner = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
    const scope = { tenantId: "pilot-local", owner, network: "testnet" as const };
    backend.files.set(`Pilot/Scopes/testnet/${owner}/Profile.md`, writeProfileNote({
      main_account: owner,
      budget_account: owner,
      network: "testnet",
      risk: "low",
      preferences: [],
    }).content);
    const fixtures = [
      { hash: "1".repeat(64), kind: "swap" as const, asset: "XRP" },
      { hash: "2".repeat(64), kind: "limit" as const, asset: "RLUSD" },
    ];
    fixtures.forEach((fixture, index) => {
      const note = writeTradeNote({
        intent_id: `intent-unique-${index}`,
        kind: fixture.kind,
        network: "testnet",
        hash: fixture.hash,
        venue: "xrpl-dex",
        assets: [{ currency: fixture.asset }],
        result: "success",
        fill_price: "unavailable",
        slippage_bps: 0,
        signed_by: "owner",
        explorer: `https://testnet.xrpl.org/transactions/${fixture.hash}`,
        created: `2026-10-21T0${index + 1}:00:00.000Z`,
      });
      backend.files.set(`Pilot/Scopes/testnet/${owner}/${note.path.slice("Pilot/".length)}`, note.content);
    });

    const summary = await vault.scopedTradeObservationSummary(scope);
    expect(summary.status).toBe("insufficient_evidence");
    expect(summary).not.toHaveProperty("candidate");
  });

  it("counts only validated cancellation actions and does not invent approval feedback", async () => {
    const backend = new MemoryBackend();
    const vault = new VaultService(backend);
    const owner = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
    const scope = { tenantId: "pilot-local", owner, network: "testnet" as const };
    backend.files.set(`Pilot/Scopes/testnet/${owner}/Profile.md`, writeProfileNote({
      main_account: owner,
      budget_account: owner,
      network: "testnet",
      risk: "low",
      preferences: [],
    }).content);
    ["XRP", "RLUSD"].forEach((asset, index) => {
      const hash = (index === 0 ? "3" : "4").repeat(64);
      const note = writeTradeNote({
        intent_id: `intent-cancel-${index}`,
        kind: "cancel",
        network: "testnet",
        hash,
        venue: "xrpl-dex",
        assets: [{ currency: asset }],
        result: "success",
        fill_price: "unavailable",
        slippage_bps: 0,
        signed_by: "owner",
        explorer: `https://testnet.xrpl.org/transactions/${hash}`,
        created: `2026-10-21T0${index + 1}:00:00.000Z`,
      });
      backend.files.set(`Pilot/Scopes/testnet/${owner}/${note.path.slice("Pilot/".length)}`, note.content);
    });

    const summary = await vault.scopedTradeObservationSummary(scope);
    expect(summary.cancellationCount).toBe(2);
    expect(summary.unavailableFeedback).toEqual(["approval", "rejection"]);
    expect(summary.candidate).toMatchObject({
      kind: "frequent_transaction_context",
      subject: "cancel",
      supportCount: 2,
    });
  });

  it("fails closed on unsafe or unbounded asset observation subjects", async () => {
    const backend = new MemoryBackend();
    const vault = new VaultService(backend);
    const owner = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
    const scope = { tenantId: "pilot-local", owner, network: "testnet" as const };
    backend.files.set(`Pilot/Scopes/testnet/${owner}/Profile.md`, writeProfileNote({
      main_account: owner,
      budget_account: owner,
      network: "testnet",
      risk: "low",
      preferences: [],
    }).content);
    const hash = "5".repeat(64);
    const note = writeTradeNote({
      intent_id: "intent-malformed-subject",
      kind: "swap",
      network: "testnet",
      hash,
      venue: "xrpl-dex",
      assets: [{ currency: "XRP" }],
      result: "filled",
      fill_price: "unavailable",
      slippage_bps: 0,
      signed_by: "owner",
      explorer: `https://testnet.xrpl.org/transactions/${hash}`,
      created: "2026-10-21T01:00:00.000Z",
    });
    const parsed = matter(note.content);
    parsed.data.assets = ["[[<script>]]"];
    backend.files.set(
      `Pilot/Scopes/testnet/${owner}/${note.path.slice("Pilot/".length)}`,
      matter.stringify(parsed.content, parsed.data),
    );
    await expect(vault.scopedTradeObservationSummary(scope)).rejects.toThrow(/owner\/network snapshot/i);

    parsed.data.assets = Array.from({ length: 17 }, (_, index) => `[[A${index}]]`);
    backend.files.set(
      `Pilot/Scopes/testnet/${owner}/${note.path.slice("Pilot/".length)}`,
      matter.stringify(parsed.content, parsed.data),
    );
    await expect(vault.scopedTradeObservationSummary(scope)).rejects.toThrow(/owner\/network snapshot/i);
  });
});
