import { describe, expect, it, vi } from "vitest";
import type { DelegateSet } from "xrpl";

import type { OpContext } from "../src/catalog/registry";
import type { Network } from "../src/contracts";
import { XrplRpcError } from "../src/adapters/xrpl-rpc";
import type { DelegationLedgerAdapter } from "../src/exec/delegation";
import type {
  DelegateIdentity,
  WrappedDelegateKey,
} from "../src/exec/keys";
import type { LinkRow } from "../src/exec/store";
import {
  handleAccountLink,
  handleAccountRevoke,
  handleAccountStatus,
  createXrplDelegationLedgerAdapter,
  ops,
  type AccountServices,
  type AccountStore,
} from "../src/ops/account";

type RawLink = Record<string, unknown>;

class LinkMemoryD1 {
  readonly links: RawLink[] = [];

  prepare(sql: string): LinkMemoryStatement {
    return new LinkMemoryStatement(this, sql);
  }

  run(sql: string, values: unknown[]): void {
    const normalized = normalize(sql);
    const insert = normalized.match(
      /^insert into links \(([^)]+)\) values \(([^)]+)\)$/,
    );
    if (insert) {
      const columns = insert[1].split(",").map((column) => column.trim());
      this.links.push(
        Object.fromEntries(
          columns.map((column, index) => [column, values[index]]),
        ),
      );
      return;
    }

    const update = normalized.match(/^update links set (.+) where (.+)$/);
    if (update) {
      const setColumns = update[1]
        .split(",")
        .map((assignment) => assignment.trim().split(" = ")[0]);
      const whereColumns = update[2]
        .split(" and ")
        .map((condition) => condition.trim().split(" = ")[0]);
      const whereValues = values.slice(setColumns.length);
      const row = this.links.find((candidate) =>
        whereColumns.every(
          (column, index) => candidate[column] === whereValues[index],
        ),
      );
      if (row) {
        setColumns.forEach((column, index) => {
          row[column] = values[index];
        });
      }
      return;
    }

    throw new Error(`Unsupported run SQL: ${normalized}`);
  }

  first(sql: string, values: unknown[]): RawLink | null {
    const normalized = normalize(sql);
    const select = normalized.match(/^select \* from links where (.+)$/);
    if (!select) throw new Error(`Unsupported first SQL: ${normalized}`);
    const columns = select[1]
      .split(" and ")
      .map((condition) => condition.trim().split(" = ")[0]);
    return (
      this.links.find((row) =>
        columns.every((column, index) => row[column] === values[index]),
      ) ?? null
    );
  }
}

class LinkMemoryStatement {
  private values: unknown[] = [];

  constructor(
    private readonly db: LinkMemoryD1,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  async run(): Promise<{ success: true }> {
    this.db.run(this.sql, this.values);
    return { success: true };
  }

  async first<T>(): Promise<T | null> {
    return this.db.first(this.sql, this.values) as T | null;
  }
}

function normalize(sql: string): string {
  return sql.trim().replace(/\s+/g, " ").toLowerCase();
}

const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const ALPHA_DELEGATE = "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn";
const BETA_DELEGATE = "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY";
const DEFAULT_PERMISSIONS = [
  "OfferCreate",
  "OfferCancel",
  "TrustSet",
  "AMMDeposit",
  "AMMWithdraw",
  "EscrowFinish",
  "CheckCash",
] as const;

function permissionObjects(permissions: readonly string[]) {
  return permissions.map((PermissionValue) => ({
    Permission: { PermissionValue },
  }));
}

function assertNoSecretShapedOutput(value: unknown): void {
  expect(JSON.stringify(value)).not.toMatch(/seed|secret|private|mnemonic/i);
}

function harness() {
  const db = new LinkMemoryD1();
  const entries = new Map<string, unknown>();
  const funded = new Set<string>();
  const prepareTransaction = vi.fn(async (_network: Network, transaction: DelegateSet) => ({
    ...transaction,
    Fee: "12",
    Sequence: 7,
    LastLedgerSequence: 123,
  }));
  const readDelegate = vi.fn(async (_network: Network, owner: string, delegate: string) =>
    entries.get(`${owner}:${delegate}`) ?? null,
  );
  const ledger: DelegationLedgerAdapter = {
    prepareTransaction,
    readDelegate,
    isAccountFunded: vi.fn(async (network, address) => funded.has(`${network}:${address}`)),
  };
  const createWrappedDelegateKey = vi.fn(
    async (
      identity: DelegateIdentity,
      _kek: string,
    ): Promise<WrappedDelegateKey> => ({
      address:
        identity.principal === "alpha" ? ALPHA_DELEGATE : BETA_DELEGATE,
      publicKey: `public-${identity.principal}`,
      ciphertext: new Uint8Array([1, 2, 3]).buffer,
      iv: new Uint8Array([4, 5, 6]).buffer,
    }),
  );
  const fundDelegateAccount = vi.fn(
    async (address: string, network: Network) => {
      funded.add(`${network}:${address}`);
      return { address, network: network as "testnet" | "devnet" };
    },
  );
  const services: AccountServices = {
    ledger,
    createWrappedDelegateKey,
    fundDelegateAccount,
    now: () => new Date("2026-10-18T10:00:00.000Z"),
    randomUUID: () => `link-${db.links.length + 1}`,
  };
  const context = (principal: string): OpContext => ({
    principal,
    db: db as unknown as D1Database,
    env: { HARBOR_KEK: "test-only-kek" },
    accountServices: services,
  });

  return {
    db,
    entries,
    prepareTransaction,
    readDelegate,
    createWrappedDelegateKey,
    fundDelegateAccount,
    services,
    context,
  };
}

describe("account operations", () => {
  it("exports the account.link, account.status, and account.revoke operations", () => {
    expect(ops.map((operation) => operation.name)).toEqual([
      "account.link",
      "account.status",
      "account.revoke",
    ]);
  });

  it("creates exactly the seven safe defaults and returns an unsigned DelegateSet", async () => {
    const h = harness();
    const result = await handleAccountLink(h.context("alpha"), {
      owner: OWNER,
      network: "testnet",
    });

    expect(result).toEqual({
      owner: OWNER,
      network: "testnet",
      delegate: ALPHA_DELEGATE,
      permissions: [...DEFAULT_PERMISSIONS],
      status: "pending",
      delegate_set_tx: {
        TransactionType: "DelegateSet",
        Account: OWNER,
        Authorize: ALPHA_DELEGATE,
        Permissions: permissionObjects(DEFAULT_PERMISSIONS),
        Fee: "12",
        Sequence: 7,
        LastLedgerSequence: 123,
      },
    });
    expect(h.createWrappedDelegateKey).toHaveBeenCalledWith(
      { principal: "alpha", owner: OWNER, network: "testnet" },
      "test-only-kek",
    );
    expect(h.fundDelegateAccount).toHaveBeenCalledWith(
      ALPHA_DELEGATE,
      "testnet",
    );
    expect(h.db.links[0]).toMatchObject({
      principal: "alpha",
      owner: OWNER,
      network: "testnet",
      delegate: ALPHA_DELEGATE,
      permissions: JSON.stringify(DEFAULT_PERMISSIONS),
      status: "pending",
    });
    expect(result.delegate_set_tx).not.toHaveProperty("TxnSignature");
    assertNoSecretShapedOutput(result);
  });

  it("uses the guarded built-in faucet path when no funding service is injected", async () => {
    const h = harness();
    const faucetFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const services = { ...h.services };
    delete services.fundDelegateAccount;
    vi.stubGlobal("fetch", faucetFetch);
    try {
      await handleAccountLink({
        ...h.context("alpha"),
        accountServices: services,
      } as OpContext, {
        owner: OWNER,
        network: "testnet",
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(faucetFetch).toHaveBeenCalledOnce();
    expect(faucetFetch).toHaveBeenCalledWith(
      "https://faucet.altnet.rippletest.net/accounts",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ destination: ALPHA_DELEGATE }),
      }),
    );
  });

  it.each([
    "Payment",
    "PaymentBurn",
    "AccountSet",
    "VaultDeposit",
    "ConfidentialMPTConvert",
    "EnableAmendment",
    "LedgerStateFix",
    "SetFee",
    "SponsorshipTransfer",
    "UNLModify",
  ])(
    "rejects forbidden or non-delegable permission %s before creating a key",
    async (permission) => {
      const h = harness();
      await expect(
        handleAccountLink(h.context("alpha"), {
          owner: OWNER,
          network: "testnet",
          permissions: [permission],
        }),
      ).rejects.toThrow(/never delegated|non-delegable/i);
      expect(h.createWrappedDelegateKey).not.toHaveBeenCalled();
      expect(h.fundDelegateAccount).not.toHaveBeenCalled();
      expect(h.db.links).toEqual([]);
    },
  );

  it.each(["mainnet", "lending-devnet"])(
    "rejects execution network %s",
    async (network) => {
      const h = harness();
      await expect(
        handleAccountLink(h.context("alpha"), {
          owner: OWNER,
          network,
        } as never),
      ).rejects.toThrow();
      expect(h.createWrappedDelegateKey).not.toHaveBeenCalled();
      expect(h.db.links).toEqual([]);
    },
  );

  it("keeps links principal-isolated and reuses an existing principal link", async () => {
    const h = harness();
    const first = await handleAccountLink(h.context("alpha"), {
      owner: OWNER,
      network: "testnet",
    });
    const repeated = await handleAccountLink(h.context("alpha"), {
      owner: OWNER,
      network: "testnet",
    });

    expect(repeated.delegate).toBe(first.delegate);
    expect(h.createWrappedDelegateKey).toHaveBeenCalledTimes(1);
    expect(h.fundDelegateAccount).toHaveBeenCalledTimes(1);
    expect(h.db.links).toHaveLength(1);

    await expect(
      handleAccountStatus(h.context("beta"), {
        owner: OWNER,
        network: "testnet",
      }),
    ).rejects.toThrow(/link not found/i);

    const beta = await handleAccountLink(h.context("beta"), {
      owner: OWNER,
      network: "testnet",
    });
    expect(beta.delegate).toBe(BETA_DELEGATE);
    expect(h.db.links).toHaveLength(2);
    expect(h.db.links.map((row) => row.principal)).toEqual(["alpha", "beta"]);
  });

  it("persists the wrapped delegate before preparation and does not fund after preparation fails", async () => {
    const h = harness();
    h.prepareTransaction.mockRejectedValueOnce(new Error("autofill unavailable"));

    await expect(
      handleAccountLink(h.context("alpha"), { owner: OWNER, network: "testnet" }),
    ).rejects.toThrow(/autofill unavailable/);
    expect(h.db.links).toHaveLength(1);
    expect(h.db.links[0]).toMatchObject({ delegate: ALPHA_DELEGATE, status: "pending" });
    expect(h.fundDelegateAccount).not.toHaveBeenCalled();
  });

  it("marks a link active only from its matching on-ledger Delegate entry", async () => {
    const h = harness();
    await handleAccountLink(h.context("alpha"), {
      owner: OWNER,
      network: "devnet",
    });
    h.entries.set(`${OWNER}:${ALPHA_DELEGATE}`, {
      LedgerEntryType: "Delegate",
      Account: OWNER,
      Authorize: ALPHA_DELEGATE,
      Permissions: permissionObjects(DEFAULT_PERMISSIONS),
      PreviousTxnLgrSeq: 888,
    });

    const status = await handleAccountStatus(h.context("alpha"), {
      owner: OWNER,
      network: "devnet",
    });

    expect(status).toEqual({
      owner: OWNER,
      network: "devnet",
      delegate: ALPHA_DELEGATE,
      permissions: [...DEFAULT_PERMISSIONS],
      status: "active",
    });
    expect(h.readDelegate).toHaveBeenCalledWith("devnet", OWNER, ALPHA_DELEGATE);
    expect(h.db.links[0]).toMatchObject({ status: "active", last_ledger: 888 });
    assertNoSecretShapedOutput(status);
  });

  it("marks a formerly active link revoked when its Delegate entry disappears", async () => {
    const h = harness();
    await handleAccountLink(h.context("alpha"), {
      owner: OWNER,
      network: "testnet",
    });
    h.entries.set(`${OWNER}:${ALPHA_DELEGATE}`, {
      LedgerEntryType: "Delegate",
      Account: OWNER,
      Authorize: ALPHA_DELEGATE,
      Permissions: permissionObjects(DEFAULT_PERMISSIONS),
    });
    await handleAccountStatus(h.context("alpha"), {
      owner: OWNER,
      network: "testnet",
    });
    h.entries.delete(`${OWNER}:${ALPHA_DELEGATE}`);

    const status = await handleAccountStatus(h.context("alpha"), {
      owner: OWNER,
      network: "testnet",
    });
    expect(status.status).toBe("revoked");
    expect(status.permissions).toEqual([]);
  });

  it("prepares an empty-permission revoke and preserves revoked status after removal", async () => {
    const h = harness();
    await handleAccountLink(h.context("alpha"), {
      owner: OWNER,
      network: "testnet",
    });
    h.entries.set(`${OWNER}:${ALPHA_DELEGATE}`, {
      LedgerEntryType: "Delegate",
      Account: OWNER,
      Authorize: ALPHA_DELEGATE,
      Permissions: permissionObjects(DEFAULT_PERMISSIONS),
    });
    await handleAccountStatus(h.context("alpha"), {
      owner: OWNER,
      network: "testnet",
    });

    const revoked = await handleAccountRevoke(h.context("alpha"), {
      owner: OWNER,
      network: "testnet",
    });
    expect(revoked).toEqual({
      owner: OWNER,
      network: "testnet",
      delegate: ALPHA_DELEGATE,
      permissions: [...DEFAULT_PERMISSIONS],
      status: "suspended",
      revoke_tx: {
        TransactionType: "DelegateSet",
        Account: OWNER,
        Authorize: ALPHA_DELEGATE,
        Permissions: [],
        Fee: "12",
        Sequence: 7,
        LastLedgerSequence: 123,
      },
    });
    expect(revoked.revoke_tx).not.toHaveProperty("TxnSignature");
    assertNoSecretShapedOutput(revoked);

    h.entries.delete(`${OWNER}:${ALPHA_DELEGATE}`);
    const status = await handleAccountStatus(h.context("alpha"), {
      owner: OWNER,
      network: "testnet",
    });
    expect(status.status).toBe("revoked");
    expect(status.permissions).toEqual([]);
    expect(status.revoke_tx).toBeUndefined();
  });

  it("does not reactivate a suspended link while its Delegate entry still exists", async () => {
    const h = harness();
    await handleAccountLink(h.context("alpha"), { owner: OWNER, network: "testnet" });
    h.entries.set(`${OWNER}:${ALPHA_DELEGATE}`, {
      LedgerEntryType: "Delegate",
      Account: OWNER,
      Authorize: ALPHA_DELEGATE,
      Permissions: permissionObjects(DEFAULT_PERMISSIONS),
    });
    await handleAccountStatus(h.context("alpha"), { owner: OWNER, network: "testnet" });
    h.db.links[0].status = "suspended";

    await expect(
      handleAccountStatus(h.context("alpha"), { owner: OWNER, network: "testnet" }),
    ).resolves.toMatchObject({ status: "suspended" });
  });

  it("refuses to prepare a revoke before the Delegate entry is active", async () => {
    const h = harness();
    await handleAccountLink(h.context("alpha"), { owner: OWNER, network: "testnet" });
    await expect(
      handleAccountRevoke(h.context("alpha"), { owner: OWNER, network: "testnet" }),
    ).rejects.toThrow(/must be active/i);
  });

  it("rejects relinking a suspended account until ledger-confirmed revocation", async () => {
    const h = harness();
    await handleAccountLink(h.context("alpha"), { owner: OWNER, network: "testnet" });
    h.db.links[0].status = "suspended";
    await expect(
      handleAccountLink(h.context("alpha"), { owner: OWNER, network: "testnet" }),
    ).rejects.toThrow(/must be revoked/i);
    expect(h.db.links[0].status).toBe("suspended");
  });

  it("retries funding the same durable pending delegate after preparation recovers", async () => {
    const h = harness();
    h.prepareTransaction.mockRejectedValueOnce(new Error("autofill unavailable"));
    await expect(
      handleAccountLink(h.context("alpha"), { owner: OWNER, network: "testnet" }),
    ).rejects.toThrow(/autofill unavailable/);
    expect(h.fundDelegateAccount).not.toHaveBeenCalled();

    const linked = await handleAccountLink(h.context("alpha"), { owner: OWNER, network: "testnet" });
    expect(linked.delegate).toBe(ALPHA_DELEGATE);
    expect(h.createWrappedDelegateKey).toHaveBeenCalledTimes(1);
    expect(h.fundDelegateAccount).toHaveBeenCalledTimes(1);
  });

  it("funds the durable winner when another link request wins the unique insert race", async () => {
    const h = harness();
    const winner: LinkRow = {
      id: "winner",
      principal: "alpha",
      owner: OWNER,
      network: "testnet",
      delegate: BETA_DELEGATE,
      delegateSeedEnc: new Uint8Array([9]).buffer,
      iv: new Uint8Array(12).buffer,
      permissions: [...DEFAULT_PERMISSIONS],
      status: "pending",
      lastLedger: null,
      revokeTx: null,
      createdAt: "2026-10-18T10:00:00.000Z",
    };
    const raceStore: AccountStore = {
      getLink: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(winner),
      insertLink: vi.fn().mockRejectedValue(new Error("unique constraint")),
      updateLink: vi.fn(),
    };
    const ctx: OpContext = {
      principal: "alpha",
      env: { HARBOR_KEK: "test-only-kek" },
      accountServices: { ...h.services, store: raceStore },
    };

    const linked = await handleAccountLink(ctx, { owner: OWNER, network: "testnet" });
    expect(linked.delegate).toBe(BETA_DELEGATE);
    expect(h.fundDelegateAccount).toHaveBeenCalledWith(BETA_DELEGATE, "testnet");
  });
});

describe("production XRPL delegation adapter", () => {
  const delegateSet: DelegateSet = {
    TransactionType: "DelegateSet",
    Account: OWNER,
    Authorize: ALPHA_DELEGATE,
    Permissions: permissionObjects(DEFAULT_PERMISSIONS),
  };

  function rpcContext(request: ReturnType<typeof vi.fn>): OpContext {
    return {
      principal: "alpha",
      xrplRpc: { request },
    };
  }

  it("autofills DelegateSet fields from account_info, fee, and ledger_current in order", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ account_data: { Account: OWNER, Sequence: 41 } })
      .mockResolvedValueOnce({ drops: { open_ledger_fee: "12" } })
      .mockResolvedValueOnce({ ledger_current_index: 8_000_000 });
    const adapter = createXrplDelegationLedgerAdapter(rpcContext(request));

    await expect(
      adapter.prepareTransaction("testnet", delegateSet),
    ).resolves.toEqual({
      ...delegateSet,
      Fee: "12",
      Sequence: 41,
      LastLedgerSequence: 8_000_020,
    });
    expect(request.mock.calls).toEqual([
      [
        "testnet",
        "account_info",
        { account: OWNER, ledger_index: "current" },
        undefined,
      ],
      ["testnet", "fee", undefined, undefined],
      ["testnet", "ledger_current", undefined, undefined],
    ]);
  });

  it("reads the exact Delegate through its validated ledger_entry selector", async () => {
    const exact = {
      LedgerEntryType: "Delegate",
      Account: OWNER,
      Authorize: ALPHA_DELEGATE,
      Permissions: permissionObjects(DEFAULT_PERMISSIONS),
    };
    const request = vi.fn().mockResolvedValue({
      validated: true,
      ledger_index: 8_000_100,
      node: exact,
    });
    const adapter = createXrplDelegationLedgerAdapter(rpcContext(request));

    await expect(
      adapter.readDelegate("devnet", OWNER, ALPHA_DELEGATE),
    ).resolves.toEqual({ ...exact, ledger_index: 8_000_100 });
    expect(request).toHaveBeenCalledWith(
      "devnet",
      "ledger_entry",
      {
        ledger_index: "validated",
        delegate: { account: OWNER, authorize: ALPHA_DELEGATE },
      },
      undefined,
    );
  });

  it("returns no Delegate on a soft-empty exact ledger_entry read", async () => {
    const request = vi.fn().mockRejectedValue(
      new XrplRpcError("missing", "entryNotFound", "soft-empty"),
    );
    const adapter = createXrplDelegationLedgerAdapter(rpcContext(request));

    await expect(
      adapter.readDelegate("testnet", OWNER, ALPHA_DELEGATE),
    ).resolves.toBeNull();
  });

  it("treats a soft-empty account_info response as an unfunded delegate", async () => {
    const request = vi.fn().mockRejectedValue(
      new XrplRpcError(
        "XRPL request failed with actNotFound",
        "actNotFound",
        "soft-empty",
      ),
    );
    const adapter = createXrplDelegationLedgerAdapter(rpcContext(request));

    await expect(
      adapter.isAccountFunded("testnet", ALPHA_DELEGATE),
    ).resolves.toBe(false);
    expect(request).toHaveBeenCalledWith(
      "testnet",
      "account_info",
      { account: ALPHA_DELEGATE, ledger_index: "validated" },
      undefined,
    );
  });

  it("validates successful funded-account responses", async () => {
    const request = vi.fn().mockResolvedValue({
      account_data: { Account: ALPHA_DELEGATE, Sequence: 1 },
    });
    const adapter = createXrplDelegationLedgerAdapter(rpcContext(request));
    await expect(
      adapter.isAccountFunded("devnet", ALPHA_DELEGATE),
    ).resolves.toBe(true);

    request.mockResolvedValueOnce({ account_data: { Account: BETA_DELEGATE } });
    await expect(
      adapter.isAccountFunded("devnet", ALPHA_DELEGATE),
    ).rejects.toMatchObject({ code: "XRPL_MALFORMED_RESPONSE" });
  });

  it.each([
    [
      "account_info",
      [{}, { drops: { open_ledger_fee: "12" } }, { ledger_current_index: 100 }],
    ],
    [
      "fee",
      [{ account_data: { Account: OWNER, Sequence: 1 } }, { drops: { open_ledger_fee: 12 } }, { ledger_current_index: 100 }],
    ],
    [
      "fee cap",
      [{ account_data: { Account: OWNER, Sequence: 1 } }, { drops: { open_ledger_fee: "2000001" } }, { ledger_current_index: 100 }],
    ],
    [
      "ledger_current",
      [{ account_data: { Account: OWNER, Sequence: 1 } }, { drops: { open_ledger_fee: "12" } }, { ledger_current_index: "100" }],
    ],
  ] as const)("rejects a malformed %s autofill response", async (_command, responses) => {
    const request = vi.fn();
    for (const response of responses) request.mockResolvedValueOnce(response);
    const adapter = createXrplDelegationLedgerAdapter(rpcContext(request));

    await expect(
      adapter.prepareTransaction("testnet", delegateSet),
    ).rejects.toMatchObject({ code: "XRPL_MALFORMED_RESPONSE" });
  });

  it.each([
    {},
    { node: {}, validated: true, ledger_index: 10 },
    { node: delegateSet, validated: false, ledger_index: 10 },
    { node: delegateSet, validated: true, ledger_index: "10" },
    {
      node: { LedgerEntryType: "Offer" },
      validated: true,
      ledger_index: 10,
    },
  ])("rejects malformed ledger_entry result %#", async (response) => {
    const request = vi.fn().mockResolvedValue(response);
    const adapter = createXrplDelegationLedgerAdapter(rpcContext(request));

    await expect(
      adapter.readDelegate("testnet", OWNER, ALPHA_DELEGATE),
    ).rejects.toMatchObject({ code: "XRPL_MALFORMED_RESPONSE" });
  });

  it("uses the production adapter when AccountServices does not inject a ledger", async () => {
    const h = harness();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ account_data: { Account: OWNER, Sequence: 7 } })
      .mockResolvedValueOnce({ drops: { open_ledger_fee: "12" } })
      .mockResolvedValueOnce({ ledger_current_index: 103 })
      .mockRejectedValueOnce(
        new XrplRpcError("missing", "actNotFound", "soft-empty"),
      );
    const { ledger: _ledger, ...withoutLedger } = h.services;
    const ctx: OpContext = {
      principal: "alpha",
      db: h.db as unknown as D1Database,
      env: { HARBOR_KEK: "test-only-kek" },
      xrplRpc: { request },
      accountServices: withoutLedger,
    };

    const linked = await handleAccountLink(ctx, {
      owner: OWNER,
      network: "testnet",
    });
    expect(linked.delegate_set_tx).toMatchObject({
      Fee: "12",
      Sequence: 7,
      LastLedgerSequence: 123,
    });
    expect(h.fundDelegateAccount).toHaveBeenCalledWith(
      ALPHA_DELEGATE,
      "testnet",
    );
    expect(request.mock.calls.map((call) => call[1])).toEqual([
      "account_info",
      "fee",
      "ledger_current",
      "account_info",
    ]);
  });

  it("rejects mainnet before issuing any production RPC request", async () => {
    const request = vi.fn();
    const adapter = createXrplDelegationLedgerAdapter(rpcContext(request));

    await expect(
      adapter.prepareTransaction("mainnet", delegateSet),
    ).rejects.toMatchObject({ code: "MAINNET_EXECUTION_DISABLED" });
    await expect(
      adapter.isAccountFunded("lending-devnet", ALPHA_DELEGATE),
    ).rejects.toMatchObject({ code: "MAINNET_EXECUTION_DISABLED" });
    expect(request).not.toHaveBeenCalled();
  });
});
