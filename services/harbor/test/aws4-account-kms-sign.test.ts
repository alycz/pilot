import { describe, expect, it, vi } from "vitest";
import type { DelegateSet } from "xrpl";

import type { OpContext } from "../src/catalog/registry";
import type { Network } from "../src/contracts";
import type { DelegationLedgerAdapter } from "../src/exec/delegation";
import type { KmsKeyLifecycleClient } from "../src/exec/kms-signer";
import type { KmsLinkRow, LinkInsert, LinkRow, LinkUpdate } from "../src/exec/store";
import {
  handleAccountLink,
  handleAccountRevoke,
  handleAccountStatus,
  type AccountServices,
  type AccountStore,
} from "../src/ops/account";

const PRINCIPAL = "aws4-account-test";
const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const DELEGATE = "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn";
const WINNER = "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY";
const NOW = "2026-10-21T10:00:00.000Z";
const LINK_ID = "link-aws4";
const KEY_ID = "kms-key-aws4";
const KEY_ALIAS = `alias/harbor/testnet/${LINK_ID}`;
const PERMISSIONS = [
  "OfferCreate",
  "OfferCancel",
  "TrustSet",
  "AMMDeposit",
  "AMMWithdraw",
  "EscrowFinish",
  "CheckCash",
] as const;

function kmsClient(): KmsKeyLifecycleClient {
  return {
    createKey: vi.fn(),
    createAlias: vi.fn(),
    tagResource: vi.fn(),
    getPublicKey: vi.fn(),
    scheduleKeyDeletion: vi.fn(),
  };
}

function memoryStore(initial: LinkRow | null = null): {
  store: AccountStore;
  current(): LinkRow | null;
  insertLink: ReturnType<typeof vi.fn>;
  updateLink: ReturnType<typeof vi.fn>;
} {
  let row = initial;
  const insertLink = vi.fn(async (input: LinkInsert) => {
    row = { ...input, principal: PRINCIPAL } as LinkRow;
    return row;
  });
  const updateLink = vi.fn(async (_id: string, patch: LinkUpdate) => {
    if (row === null) return null;
    row = { ...row, ...patch } as LinkRow;
    return row;
  });
  return {
    store: {
      getLink: vi.fn(async () => row),
      insertLink,
      updateLink,
    },
    current: () => row,
    insertLink,
    updateLink,
  };
}

function kmsRow(status: KmsLinkRow["status"] = "active"): KmsLinkRow {
  return {
    id: LINK_ID,
    principal: PRINCIPAL,
    owner: OWNER,
    network: "testnet",
    delegate: DELEGATE,
    keyBackend: "kms",
    delegateSeedEnc: null,
    iv: null,
    kmsKeyId: KEY_ID,
    kmsAlias: KEY_ALIAS,
    permissions: [...PERMISSIONS],
    status,
    lastLedger: 100,
    revokeTx: null,
    createdAt: NOW,
  };
}

function ledger(readDelegate = vi.fn(async () => null)): DelegationLedgerAdapter {
  return {
    prepareTransaction: vi.fn(async (_network: Network, transaction: DelegateSet) => ({
      ...transaction,
      Fee: "12",
      Sequence: 7,
      LastLedgerSequence: 123,
    })),
    readDelegate,
    isAccountFunded: vi.fn(async () => false),
  };
}

function context(store: AccountStore, services: AccountServices): OpContext {
  return {
    principal: PRINCIPAL,
    env: { KMS_MODE: "sign" },
    accountServices: { store, ...services },
  };
}

describe("AWS-4 account KMS key lifecycle", () => {
  it("creates and persists a KMS-backed delegate without invoking the local key path", async () => {
    const state = memoryStore();
    const client = kmsClient();
    const createKmsDelegateKey = vi.fn(async () => ({
      address: DELEGATE,
      publicKey: `ED${"11".repeat(32)}`,
      keyId: KEY_ID,
      keyAlias: KEY_ALIAS,
    }));
    const createWrappedDelegateKey = vi.fn();
    const fundDelegateAccount = vi.fn(async () => ({ address: DELEGATE, network: "testnet" as const }));
    const quickNodeRegistry = { link: vi.fn(), revoke: vi.fn() };

    const result = await handleAccountLink(context(state.store, {
      ledger: ledger(),
      kmsClient: client,
      createKmsDelegateKey,
      createWrappedDelegateKey,
      fundDelegateAccount,
      quickNodeRegistry,
      randomUUID: () => LINK_ID,
      now: () => new Date(NOW),
    }), { owner: OWNER, network: "testnet" });

    expect(createKmsDelegateKey).toHaveBeenCalledWith({
      principal: PRINCIPAL,
      owner: OWNER,
      network: "testnet",
      linkId: LINK_ID,
      client,
    });
    expect(createWrappedDelegateKey).not.toHaveBeenCalled();
    expect(state.current()).toMatchObject({
      id: LINK_ID,
      delegate: DELEGATE,
      keyBackend: "kms",
      delegateSeedEnc: null,
      iv: null,
      kmsKeyId: KEY_ID,
      kmsAlias: KEY_ALIAS,
      status: "pending",
    });
    expect(fundDelegateAccount).toHaveBeenCalledWith(DELEGATE, "testnet");
    expect(quickNodeRegistry.link).toHaveBeenCalledWith("testnet", OWNER, DELEGATE);
    expect(result).toMatchObject({
      owner: OWNER,
      network: "testnet",
      delegate: DELEGATE,
      status: "pending",
    });
    expect(JSON.stringify(result)).not.toMatch(/kmsKeyId|kmsAlias|seed|secret|private/i);
  });

  it("fails closed without persisting, funding, or falling back when KMS key creation fails", async () => {
    const state = memoryStore();
    const createWrappedDelegateKey = vi.fn();
    const fundDelegateAccount = vi.fn();
    const createKmsDelegateKey = vi.fn(async () => {
      throw new Error("fixed synthetic KMS failure");
    });

    await expect(handleAccountLink(context(state.store, {
      ledger: ledger(),
      kmsClient: kmsClient(),
      createKmsDelegateKey,
      createWrappedDelegateKey,
      fundDelegateAccount,
      randomUUID: () => LINK_ID,
    }), { owner: OWNER, network: "testnet" })).rejects.toThrow(/synthetic KMS failure/);

    expect(createWrappedDelegateKey).not.toHaveBeenCalled();
    expect(state.insertLink).not.toHaveBeenCalled();
    expect(fundDelegateAccount).not.toHaveBeenCalled();
  });

  it("schedules deletion only after the suspended Delegate is absent, then makes revocation terminal", async () => {
    const state = memoryStore(kmsRow("active"));
    const client = kmsClient();
    const scheduleKmsDelegateKeyDeletion = vi.fn(async () => undefined);
    const readDelegate = vi.fn(async () => null);
    const services: AccountServices = {
      ledger: ledger(readDelegate),
      kmsClient: client,
      scheduleKmsDelegateKeyDeletion,
      quickNodeRegistry: { link: vi.fn(), revoke: vi.fn() },
    };

    const prepared = await handleAccountRevoke(
      context(state.store, services),
      { owner: OWNER, network: "testnet" },
    );
    expect(prepared.status).toBe("suspended");
    expect(scheduleKmsDelegateKeyDeletion).not.toHaveBeenCalled();

    const revoked = await handleAccountStatus(
      context(state.store, services),
      { owner: OWNER, network: "testnet" },
    );
    expect(scheduleKmsDelegateKeyDeletion).toHaveBeenCalledWith(client, KEY_ID);
    expect(revoked).toMatchObject({ status: "revoked", permissions: [] });

    await expect(handleAccountStatus(
      context(state.store, services),
      { owner: OWNER, network: "testnet" },
    )).resolves.toMatchObject({ status: "revoked" });
    expect(scheduleKmsDelegateKeyDeletion).toHaveBeenCalledTimes(1);
    expect(readDelegate).toHaveBeenCalledTimes(1);
  });

  it("retires the KMS key when an active Delegate was removed externally", async () => {
    const state = memoryStore(kmsRow("active"));
    const client = kmsClient();
    const scheduleKmsDelegateKeyDeletion = vi.fn(async () => undefined);

    const revoked = await handleAccountStatus(
      context(state.store, {
        ledger: ledger(vi.fn(async () => null)),
        kmsClient: client,
        scheduleKmsDelegateKeyDeletion,
      }),
      { owner: OWNER, network: "testnet" },
    );

    expect(scheduleKmsDelegateKeyDeletion).toHaveBeenCalledWith(client, KEY_ID);
    expect(revoked).toMatchObject({ status: "revoked", permissions: [] });
  });

  it("keeps the link suspended when KMS deletion cannot be scheduled", async () => {
    const row = kmsRow("suspended");
    row.revokeTx = { TransactionType: "DelegateSet" };
    const state = memoryStore(row);
    const scheduleKmsDelegateKeyDeletion = vi.fn(async () => {
      throw new Error("fixed deletion failure");
    });

    await expect(handleAccountStatus(context(state.store, {
      ledger: ledger(),
      kmsClient: kmsClient(),
      scheduleKmsDelegateKeyDeletion,
    }), { owner: OWNER, network: "testnet" })).rejects.toThrow(/deletion failure/);

    expect(state.current()).toMatchObject({ status: "suspended", kmsKeyId: KEY_ID });
    expect(state.updateLink).not.toHaveBeenCalled();
  });

  it("retires a created race loser before reusing the durable winner", async () => {
    const winner = { ...kmsRow("pending"), delegate: WINNER, kmsKeyId: "winner-key" };
    const getLink = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(winner);
    const store: AccountStore = {
      getLink,
      insertLink: vi.fn(async () => { throw new Error("unique constraint"); }),
      updateLink: vi.fn(),
    };
    const client = kmsClient();
    const scheduleKmsDelegateKeyDeletion = vi.fn(async () => undefined);
    const fundDelegateAccount = vi.fn(async () => ({ address: WINNER, network: "testnet" as const }));

    const result = await handleAccountLink(context(store, {
      ledger: ledger(),
      kmsClient: client,
      createKmsDelegateKey: vi.fn(async () => ({
        address: DELEGATE,
        publicKey: `ED${"11".repeat(32)}`,
        keyId: KEY_ID,
        keyAlias: KEY_ALIAS,
      })),
      scheduleKmsDelegateKeyDeletion,
      fundDelegateAccount,
      randomUUID: () => LINK_ID,
    }), { owner: OWNER, network: "testnet" });

    expect(scheduleKmsDelegateKeyDeletion).toHaveBeenCalledWith(client, KEY_ID);
    expect(result.delegate).toBe(WINNER);
    expect(fundDelegateAccount).toHaveBeenCalledWith(WINNER, "testnet");
  });

  it("never reactivates a revoked KMS key that is pending deletion", async () => {
    const state = memoryStore(kmsRow("revoked"));
    const createKmsDelegateKey = vi.fn();
    await expect(handleAccountLink(context(state.store, {
      ledger: ledger(),
      kmsClient: kmsClient(),
      createKmsDelegateKey,
    }), { owner: OWNER, network: "testnet" })).rejects.toThrow(/cannot be relinked/i);
    expect(createKmsDelegateKey).not.toHaveBeenCalled();
  });
});
