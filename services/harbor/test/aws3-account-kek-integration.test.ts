import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DelegateSet } from "xrpl";

const { loadKmsKekMock } = vi.hoisted(() => ({
  loadKmsKekMock: vi.fn(),
}));

vi.mock("../src/aws/kms", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/aws/kms")>();
  return { ...actual, loadKmsKek: loadKmsKekMock };
});

import type { OpContext } from "../src/catalog/registry";
import type { Network } from "../src/contracts";
import type { DelegationLedgerAdapter } from "../src/exec/delegation";
import type {
  LinkInsert,
  LinkRow,
  LinkUpdate,
} from "../src/exec/store";
import {
  handleAccountLink,
  handleAccountRevoke,
  type AccountServices,
  type AccountStore,
} from "../src/ops/account";

const PRINCIPAL = "aws3-account-test";
const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

class MemoryAccountStore implements AccountStore {
  row: LinkRow | null = null;

  async getLink(owner: string, network: Network): Promise<LinkRow | null> {
    return this.row?.owner === owner && this.row.network === network
      ? this.row
      : null;
  }

  async insertLink(input: LinkInsert): Promise<LinkRow> {
    this.row = { ...input, principal: PRINCIPAL };
    return this.row;
  }

  async updateLink(id: string, patch: LinkUpdate): Promise<LinkRow | null> {
    if (!this.row || this.row.id !== id) return null;
    this.row = { ...this.row, ...patch };
    return this.row;
  }
}

function harness(mode: "off" | "kek" | "sign") {
  const store = new MemoryAccountStore();
  const ledger: DelegationLedgerAdapter = {
    prepareTransaction: vi.fn(
      async (_network: Network, transaction: DelegateSet) => ({
        ...transaction,
        Fee: "12",
        Sequence: 7,
        LastLedgerSequence: 200,
      }),
    ),
    readDelegate: vi.fn(async () => null),
    isAccountFunded: vi.fn(async () => true),
  };
  const services: AccountServices = {
    store,
    ledger,
    now: () => new Date("2026-10-21T00:00:00.000Z"),
    randomUUID: () => "aws3-link",
  };
  const context: OpContext = {
    principal: PRINCIPAL,
    env: {
      KMS_MODE: mode,
      HARBOR_KEK_CIPHERTEXT: Buffer.from(
        "noncredential ciphertext fixture",
      ).toString("base64"),
    },
    accountServices: services,
  };
  return { context, ledger, store };
}

describe("AWS-3 account KEK integration", () => {
  beforeEach(async () => {
    loadKmsKekMock.mockReset();
    loadKmsKekMock.mockResolvedValue(
      await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      ),
    );
  });

  it("links and prepares revocation in kek mode without HARBOR_KEK", async () => {
    const h = harness("kek");

    const linked = await handleAccountLink(h.context, {
      owner: OWNER,
      network: "testnet",
      permissions: ["OfferCancel"],
    });

    expect(linked.status).toBe("pending");
    expect(linked.delegate_set_tx).toMatchObject({
      TransactionType: "DelegateSet",
      Account: OWNER,
      Authorize: linked.delegate,
    });
    expect(loadKmsKekMock).toHaveBeenCalledOnce();
    expect(loadKmsKekMock.mock.calls[0]?.[0]).not.toHaveProperty("HARBOR_KEK");
    expect(h.store.row?.delegateSeedEnc.byteLength).toBeGreaterThan(0);
    expect(h.store.row?.iv.byteLength).toBe(12);

    if (!h.store.row) throw new Error("link was not persisted");
    h.store.row = { ...h.store.row, status: "active" };
    const revoked = await handleAccountRevoke(h.context, {
      owner: OWNER,
      network: "testnet",
    });

    expect(revoked).toMatchObject({
      status: "suspended",
      revoke_tx: {
        TransactionType: "DelegateSet",
        Account: OWNER,
        Authorize: linked.delegate,
        Permissions: [],
      },
    });
    expect(loadKmsKekMock).toHaveBeenCalledOnce();
  });

  it("does not silently use the kek path in off mode", async () => {
    const h = harness("off");
    await expect(
      handleAccountLink(h.context, {
        owner: OWNER,
        network: "testnet",
        permissions: ["OfferCancel"],
      }),
    ).rejects.toThrow("HARBOR_KEK is not configured");
    expect(loadKmsKekMock).not.toHaveBeenCalled();
    expect(h.store.row).toBeNull();
  });

  it("uses the KMS key lifecycle, not the kek path, in sign mode", async () => {
    const h = harness("sign");
    await expect(
      handleAccountLink(h.context, {
        owner: OWNER,
        network: "testnet",
        permissions: ["OfferCancel"],
      }),
    ).rejects.toThrow("KMS could not create the delegate key");
    expect(loadKmsKekMock).not.toHaveBeenCalled();
    expect(h.store.row).toBeNull();
  });
});
