import { loadEnvFile } from "node:process";

import {
  Client,
  Wallet,
  XrplError,
  type DelegateSet,
} from "xrpl";
import { describe, expect, it } from "vitest";

import type { Network } from "../../src/contracts";
import {
  DEFAULT_DELEGATED_PERMISSIONS,
  buildDelegateRevoke,
  type DelegationLedgerAdapter,
} from "../../src/exec/delegation";
import type {
  LinkInsert,
  LinkRow,
  LinkUpdate,
} from "../../src/exec/store";
import {
  handleAccountLink,
  handleAccountRevoke,
  handleAccountStatus,
  type AccountServices,
  type AccountStore,
} from "../../src/ops/account";

const DEFAULT_ENDPOINTS = {
  testnet: "wss://s.altnet.rippletest.net:51233",
  devnet: "wss://s.devnet.rippletest.net:51233",
} as const;

type ExecutionNetwork = keyof typeof DEFAULT_ENDPOINTS;

class MemoryAccountStore implements AccountStore {
  private row: LinkRow | null = null;

  constructor(private readonly principal: string) {}

  async getLink(owner: string, network: Network): Promise<LinkRow | null> {
    return this.row?.owner === owner && this.row.network === network
      ? this.row
      : null;
  }

  async insertLink(input: LinkInsert): Promise<LinkRow> {
    if (this.row) throw new Error("smoke account link already exists");
    this.row = { ...input, principal: this.principal };
    return this.row;
  }

  async updateLink(id: string, patch: LinkUpdate): Promise<LinkRow | null> {
    if (!this.row || this.row.id !== id) return null;
    this.row = { ...this.row, ...patch };
    return this.row;
  }
}

function requireExecutionNetwork(value: string | undefined): ExecutionNetwork {
  const network = value ?? "testnet";
  if (network !== "testnet" && network !== "devnet") {
    throw new Error("EXEC_NETWORK must be testnet or devnet for delegation smoke testing");
  }
  return network;
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for delegation smoke testing`);
  return value;
}

function ownerWallet(network: ExecutionNetwork): Wallet {
  if (network !== "testnet") {
    throw new Error("The approved delegation smoke owner is testnet-only");
  }
  const wallet = Wallet.fromSeed(
    requireEnvironment("H_SAFETY_TEST_OWNER_TESTNET_SEED"),
  );
  const expectedAddress = requireEnvironment(
    "H_SAFETY_TEST_OWNER_TESTNET_ADDRESS",
  );
  if (wallet.classicAddress !== expectedAddress) {
    throw new Error(
      "H_SAFETY_TEST_OWNER_TESTNET_ADDRESS does not match its credential",
    );
  }
  return wallet;
}

function endpointFor(network: ExecutionNetwork): string {
  return (
    process.env[`XRPL_${network.toUpperCase()}_URL`] ??
    DEFAULT_ENDPOINTS[network]
  );
}

function rippledErrorCode(error: unknown): string | undefined {
  if (
    !(error instanceof XrplError) ||
    typeof error.data !== "object" ||
    error.data === null ||
    !("error" in error.data)
  ) {
    return undefined;
  }
  return typeof error.data.error === "string" ? error.data.error : undefined;
}

function ledgerAdapter(client: Client): DelegationLedgerAdapter {
  return {
    prepareTransaction: (_network, transaction) => client.autofill(transaction),
    async readDelegate(_network, owner, delegate) {
      try {
        const response = await client.request({
          command: "ledger_entry",
          ledger_index: "validated",
          delegate: { account: owner, authorize: delegate },
        });
        return response.result.node ?? null;
      } catch (error) {
        if (
          rippledErrorCode(error) === "entryNotFound" ||
          rippledErrorCode(error) === "objectNotFound"
        ) {
          return null;
        }
        throw error;
      }
    },
    async isAccountFunded(_network, address) {
      try {
        await client.request({
          command: "account_info",
          account: address,
          ledger_index: "validated",
        });
        return true;
      } catch (error) {
        if (rippledErrorCode(error) === "actNotFound") return false;
        throw error;
      }
    },
  };
}

function transactionResult(response: unknown): string | undefined {
  if (typeof response !== "object" || response === null || !("result" in response)) {
    return undefined;
  }
  const result = response.result;
  if (typeof result !== "object" || result === null || !("meta" in result)) {
    return undefined;
  }
  const meta = result.meta;
  if (
    typeof meta !== "object" ||
    meta === null ||
    !("TransactionResult" in meta)
  ) {
    return undefined;
  }
  return typeof meta.TransactionResult === "string"
    ? meta.TransactionResult
    : undefined;
}

async function submitOwnerTransaction(
  client: Client,
  owner: Wallet,
  transaction: DelegateSet,
): Promise<void> {
  const signed = owner.sign(transaction);
  const response = await client.submitAndWait(signed.tx_blob);
  expect(transactionResult(response)).toBe("tesSUCCESS");
}

// LIVE MUTATION OPT-IN: set ALLOW_DELEGATE_KEY_CREATION=true and run
// `npm run test:smoke -- test/smoke/account-delegation.test.ts`. This creates,
// funds, and retains a wrapped delegate credential for the test lifetime and
// submits both DelegateSet grant and revoke transactions on testnet. The owner
// must be a fresh, dedicated credential loaded from the owner-controlled external secrets directory; the
// retired TEST_WALLETS_TESTNET entries are never used.
const liveIt =
  process.env.ALLOW_DELEGATE_KEY_CREATION === "true" ? it : it.skip;

describe("live account delegation", () => {
  liveIt(
    "links, observes, and revokes an Ed25519 delegate",
    { timeout: 120_000 },
    async () => {
      loadEnvFile(".dev.vars");
      const network = requireExecutionNetwork(process.env.EXEC_NETWORK);
      const owner = ownerWallet(network);
      const client = new Client(endpointFor(network));
      const store = new MemoryAccountStore("p1.7-live-smoke");
      const ledger = ledgerAdapter(client);
      const services: AccountServices = {
        store,
        ledger,
        faucetFetch: fetch,
      };
      const context = {
        principal: "p1.7-live-smoke",
        env: { HARBOR_KEK: requireEnvironment("HARBOR_KEK") },
        accountServices: services,
      };
      let delegate: string | undefined;
      let grantValidated = false;
      let revokeValidated = false;

      try {
        await client.connect();
        const linked = await handleAccountLink(context, {
          owner: owner.classicAddress,
          network,
        });
        delegate = linked.delegate;
        expect(linked.permissions).toEqual([
          ...DEFAULT_DELEGATED_PERMISSIONS,
        ]);
        expect(linked.delegate_set_tx).toBeDefined();

        await submitOwnerTransaction(
          client,
          owner,
          linked.delegate_set_tx as DelegateSet,
        );
        grantValidated = true;

        const active = await handleAccountStatus(context, {
          owner: owner.classicAddress,
          network,
        });
        expect(active.status).toBe("active");
        expect(active.permissions).toEqual([
          ...DEFAULT_DELEGATED_PERMISSIONS,
        ]);

        const revoked = await handleAccountRevoke(context, {
          owner: owner.classicAddress,
          network,
        });
        expect(revoked.status).toBe("suspended");
        expect(revoked.revoke_tx?.Permissions).toEqual([]);
        await submitOwnerTransaction(
          client,
          owner,
          revoked.revoke_tx as DelegateSet,
        );
        revokeValidated = true;

        const status = await handleAccountStatus(context, {
          owner: owner.classicAddress,
          network,
        });
        expect(status.status).toBe("revoked");
      } finally {
        if (grantValidated && !revokeValidated && delegate && client.isConnected()) {
          try {
            const cleanup = await client.autofill(
              buildDelegateRevoke(owner.classicAddress, delegate),
            );
            await submitOwnerTransaction(client, owner, cleanup);
          } catch {
            // Preserve the original test failure; cleanup is best-effort only.
          }
        }
        if (client.isConnected()) await client.disconnect();
      }
    },
  );
});
