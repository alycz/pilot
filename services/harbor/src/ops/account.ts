import { isValidClassicAddress } from "xrpl";
import { z } from "zod";

import {
  AccountLinkSchema,
  type AccountLink,
  type Network,
} from "../contracts";
import { requestXrpl, XrplRpcError } from "../adapters/xrpl-rpc";
import { loadKmsKek, readKmsMode, type KmsEnv } from "../aws/kms";
import type { OpContext, OpDef } from "../catalog/registry";
import { assertLocalTradingTestnet } from "../local-trading";
import { localTradingIsolatedOnboardingV1MarkersPresent } from "../local-trading-isolated-onboarding-v1";
import { localTradingOnboardingMarkersPresent } from "../local-trading-onboarding";
import {
  DEFAULT_DELEGATED_PERMISSIONS,
  DelegationValidationError,
  normalizeDelegatePermissions,
  prepareDelegateRevoke,
  prepareDelegateSet,
  type DelegationLedgerAdapter,
  validatePermissions,
} from "../exec/delegation";
import {
  createWrappedDelegateKey,
  createWrappedDelegateKeyWithCryptoKey,
  fundDelegateAccount,
} from "../exec/keys";
import {
  createKmsDelegateClient,
  createKmsDelegateKey,
  scheduleKmsDelegateKeyDeletion,
  type KmsKeyLifecycleClient,
} from "../exec/kms-signer";
import {
  Store,
  type LinkInsert,
  type LinkRow,
  type LinkUpdate,
} from "../exec/store";
import {
  createQuickNodeKvRegistryForRequest,
  type QuickNodeKvRegistry,
  type QuickNodeRegistryEnv,
} from "../quicknode/kv-registry";

const ExecutionNetworkSchema = z.enum(["testnet", "devnet"]);
const OwnerSchema = z
  .string()
  .refine(isValidClassicAddress, "owner must be a valid XRPL classic address");

export const AccountLinkArgsSchema = z
  .object({
    owner: OwnerSchema,
    network: ExecutionNetworkSchema,
    permissions: z.array(z.string().min(1)).max(10).optional(),
  })
  .strict();

export const AccountLookupArgsSchema = z
  .object({
    owner: OwnerSchema,
    network: ExecutionNetworkSchema,
  })
  .strict();

export type AccountLinkArgs = z.infer<typeof AccountLinkArgsSchema>;
export type AccountLookupArgs = z.infer<typeof AccountLookupArgsSchema>;

export type AccountStore = Pick<
  Store,
  "getLink" | "insertLink" | "updateLink"
>;

type CreateWrappedDelegateKey = typeof createWrappedDelegateKey;
type FundDelegateAccount = typeof fundDelegateAccount;
type CreateKmsDelegateKey = typeof createKmsDelegateKey;
type ScheduleKmsDelegateKeyDeletion = typeof scheduleKmsDelegateKeyDeletion;

export interface AccountServices {
  store?: AccountStore;
  ledger?: DelegationLedgerAdapter;
  createWrappedDelegateKey?: CreateWrappedDelegateKey;
  createKmsDelegateKey?: CreateKmsDelegateKey;
  scheduleKmsDelegateKeyDeletion?: ScheduleKmsDelegateKeyDeletion;
  kmsClient?: KmsKeyLifecycleClient;
  fundDelegateAccount?: FundDelegateAccount;
  /** Optional faucet transport override; production uses the Worker fetch runtime. */
  faucetFetch?: typeof fetch;
  now?: () => Date;
  randomUUID?: () => string;
  quickNodeRegistry?: Pick<QuickNodeKvRegistry, "link" | "revoke">;
}

type AccountEnvironment = KmsEnv & QuickNodeRegistryEnv & {
  HARBOR_KEK?: string;
};

type AccountContext = OpContext & {
  db?: D1Database;
  env?: AccountEnvironment;
  request?: Request;
  accountServices?: AccountServices;
};

function context(input: OpContext): AccountContext {
  return input as AccountContext;
}

type ResolvedAccountServices = AccountServices & {
  ledger: DelegationLedgerAdapter;
};

const MAX_AUTOFILL_FEE_DROPS = 2_000_000n;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformedResponse(command: string): XrplRpcError {
  return new XrplRpcError(
    `XRPL ${command} returned a malformed response`,
    "XRPL_MALFORMED_RESPONSE",
  );
}

function executionNetwork(network: Network): asserts network is "testnet" | "devnet" {
  if (network !== "testnet" && network !== "devnet") {
    throw new XrplRpcError(
      "Account delegation is allowed only on testnet or devnet",
      "MAINNET_EXECUTION_DISABLED",
    );
  }
}

function assertExactOnboardingPermissions(
  env: unknown,
  permissions: readonly string[],
): void {
  if (
    onboardingMarkersPresent(env) &&
    (permissions.length !== DEFAULT_DELEGATED_PERMISSIONS.length ||
      permissions.some(
        (permission, index) =>
          permission !== DEFAULT_DELEGATED_PERMISSIONS[index],
      ))
  ) {
    throw new DelegationValidationError(
      "Local trading onboarding requires the exact reviewed delegated permissions",
    );
  }
}

function onboardingMarkersPresent(env: unknown): boolean {
  return (
    localTradingOnboardingMarkersPresent(env) ||
    localTradingIsolatedOnboardingV1MarkersPresent(env)
  );
}

function accountSequence(
  result: Record<string, unknown>,
  expectedAccount: string,
): number {
  if (!isRecord(result.account_data)) throw malformedResponse("account_info");
  const sequence = result.account_data.Sequence;
  if (
    result.account_data.Account !== expectedAccount ||
    !Number.isSafeInteger(sequence) ||
    (sequence as number) < 1 ||
    (sequence as number) > 0xffff_ffff
  ) {
    throw malformedResponse("account_info");
  }
  return sequence as number;
}

function openLedgerFee(result: Record<string, unknown>): string {
  if (!isRecord(result.drops)) throw malformedResponse("fee");
  const fee = result.drops.open_ledger_fee;
  if (
    typeof fee !== "string" ||
    !/^[1-9][0-9]*$/.test(fee) ||
    BigInt(fee) > MAX_AUTOFILL_FEE_DROPS
  ) {
    throw malformedResponse("fee");
  }
  return fee;
}

function currentLedgerIndex(result: Record<string, unknown>): number {
  const index = result.ledger_current_index;
  if (!Number.isSafeInteger(index) || (index as number) < 1) {
    throw malformedResponse("ledger_current");
  }
  return index as number;
}

/**
 * Production delegation reads use the shared XRPL RPC boundary. Tests can
 * continue to inject AccountServices.ledger for precise unit isolation.
 */
export function createXrplDelegationLedgerAdapter(
  input: OpContext,
): DelegationLedgerAdapter {
  return {
    async prepareTransaction(network, transaction) {
      executionNetwork(network);
      // Autofill inputs mirror xrpl.js: current AccountRoot sequence, the
      // current open-ledger fee, and a 20-ledger expiry window.
      // https://js.xrpl.org/classes/Client.html#autofill
      const accountInfo = await requestXrpl(input, network, "account_info", {
        account: transaction.Account,
        ledger_index: "current",
      });
      const fee = await requestXrpl(input, network, "fee");
      const ledger = await requestXrpl(input, network, "ledger_current");
      const currentIndex = currentLedgerIndex(ledger);
      const lastLedgerSequence = currentIndex + 20;
      if (
        !Number.isSafeInteger(lastLedgerSequence) ||
        lastLedgerSequence > 0xffff_ffff
      ) {
        throw malformedResponse("ledger_current");
      }
      return {
        ...transaction,
        Fee: openLedgerFee(fee),
        Sequence: accountSequence(accountInfo, transaction.Account),
        LastLedgerSequence: lastLedgerSequence,
      };
    },

    async readDelegate(network, owner, delegate) {
      executionNetwork(network);
      let result: Record<string, unknown>;
      try {
        // The Delegate selector reads the exact owner/authorize pair without
        // relying on paginated owner-directory scans:
        // https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/ledger-methods/ledger_entry#delegate-object
        result = await requestXrpl(input, network, "ledger_entry", {
          ledger_index: "validated",
          delegate: { account: owner, authorize: delegate },
        });
      } catch (error) {
        if (error instanceof XrplRpcError && error.kind === "soft-empty") {
          return null;
        }
        throw error;
      }
      const ledgerIndex = result.ledger_index;
      if (
        result.validated !== true ||
        !Number.isSafeInteger(ledgerIndex) ||
        (ledgerIndex as number) < 1 ||
        !isRecord(result.node) ||
        result.node.LedgerEntryType !== "Delegate" ||
        result.node.Account !== owner ||
        result.node.Authorize !== delegate ||
        !Array.isArray(result.node.Permissions)
      ) {
        throw malformedResponse("ledger_entry");
      }
      return { ...result.node, ledger_index: ledgerIndex as number };
    },

    async isAccountFunded(network, address) {
      executionNetwork(network);
      try {
        const result = await requestXrpl(input, network, "account_info", {
          account: address,
          ledger_index: "validated",
        });
        if (!isRecord(result.account_data)) {
          throw malformedResponse("account_info");
        }
        if (result.account_data.Account !== address) {
          throw malformedResponse("account_info");
        }
        return true;
      } catch (error) {
        if (error instanceof XrplRpcError && error.kind === "soft-empty") {
          return false;
        }
        throw error;
      }
    },
  };
}

function services(input: OpContext): ResolvedAccountServices {
  const configured = context(input).accountServices ?? {};
  return {
    ...configured,
    ledger: configured.ledger ?? createXrplDelegationLedgerAdapter(input),
  };
}

function storeFor(input: OpContext, configured: ResolvedAccountServices): AccountStore {
  if (configured.store) return configured.store;
  const db = context(input).db;
  if (!db) throw new Error("account store is not configured");
  return new Store(db, input.principal);
}

function kekFor(input: OpContext): string {
  const kek = context(input).env?.HARBOR_KEK;
  if (!kek) throw new Error("HARBOR_KEK is not configured");
  return kek;
}

function kmsClientFor(
  input: OpContext,
  configured: AccountServices,
): KmsKeyLifecycleClient {
  return configured.kmsClient ?? createKmsDelegateClient(context(input).env ?? {});
}

function quickNodeRegistryFor(
  input: OpContext,
  configured: AccountServices,
): Pick<QuickNodeKvRegistry, "link" | "revoke"> {
  if (configured.quickNodeRegistry) return configured.quickNodeRegistry;
  const ctx = context(input);
  return createQuickNodeKvRegistryForRequest({
    env: ctx.env,
    request: ctx.request,
  });
}

async function syncQuickNodeLinkBestEffort(
  input: OpContext,
  configured: AccountServices,
  action: "link" | "revoke",
  network: "testnet" | "devnet",
  owner: string,
  delegate: string,
): Promise<void> {
  try {
    await quickNodeRegistryFor(input, configured)[action](
      network,
      owner,
      delegate,
    );
  } catch {
    console.warn("kv_sync_failed", {
      evt: "kv_sync_failed",
      action: "patch",
      list: "accounts",
      code: "QN_KV_SYNC_FAILED",
    });
  }
}

function publicLink(
  row: LinkRow,
  transaction?: Record<string, unknown>,
): AccountLink {
  return AccountLinkSchema.parse({
    owner: row.owner,
    network: row.network,
    delegate: row.delegate,
    permissions: row.permissions,
    status: row.status,
    ...(transaction ? { delegate_set_tx: transaction } : {}),
    ...(row.revokeTx ? { revoke_tx: row.revokeTx } : {}),
  });
}

function asJsonObject(value: object): Record<string, unknown> {
  return { ...value };
}

function ledgerIndex(entry: unknown): number | null {
  if (typeof entry !== "object" || entry === null) return null;
  const candidate = entry as Record<string, unknown>;
  for (const field of ["ledger_index", "ledgerIndex", "PreviousTxnLgrSeq"]) {
    const value = candidate[field];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      return value;
    }
  }
  return null;
}

function requireLink(row: LinkRow | null): LinkRow {
  if (!row) throw new Error("account link not found");
  return row;
}

async function updateExistingLink(
  accountStore: AccountStore,
  row: LinkRow,
  permissions: string[],
): Promise<LinkRow> {
  if (row.status === "suspended") {
    throw new Error("suspended account link must be revoked before relinking");
  }
  if (row.status === "revoked" && row.keyBackend === "kms") {
    throw new Error("revoked KMS account link cannot be relinked after key deletion");
  }
  const changed =
    row.permissions.length !== permissions.length ||
    row.permissions.some((permission, index) => permission !== permissions[index]);
  if (!changed && row.status !== "revoked") return row;

  return requireLink(
    await accountStore.updateLink(row.id, {
      permissions,
      status: "pending",
      revokeTx: null,
    }),
  );
}

async function fundPendingDelegate(configured: ResolvedAccountServices, row: LinkRow): Promise<void> {
  if (row.status !== "pending") return;
  if (await configured.ledger.isAccountFunded(row.network, row.delegate)) return;
  if (configured.fundDelegateAccount) {
    await configured.fundDelegateAccount(row.delegate, row.network);
    return;
  }
  // Workerd requires native fetch to retain the Worker-global receiver. Pass a
  // wrapper rather than the ambient function so the key helper can invoke its
  // injected transport without changing that receiver.
  const faucetFetch = configured.faucetFetch ??
    ((input: RequestInfo | URL, init?: RequestInit) =>
      globalThis.fetch(input, init));
  await fundDelegateAccount(
    row.delegate,
    row.network,
    { fetch: faucetFetch },
  );
}

export async function handleAccountLink(
  input: OpContext,
  rawArgs: AccountLinkArgs,
): Promise<AccountLink> {
  const args = AccountLinkArgsSchema.parse(rawArgs);
  assertLocalTradingTestnet(input, args.network);
  const configured = services(input);
  const accountStore = storeFor(input, configured);
  const permissions = validatePermissions(args.permissions);
  assertExactOnboardingPermissions(input.env, permissions);
  const existing = await accountStore.getLink(args.owner, args.network);

  if (existing) {
    const row = await updateExistingLink(accountStore, existing, permissions);
    const transaction = await prepareDelegateSet(
      configured.ledger,
      args.network,
      args.owner,
      row.delegate,
      permissions,
    );
    if (!onboardingMarkersPresent(input.env)) {
      await fundPendingDelegate(configured, row);
    }
    await syncQuickNodeLinkBestEffort(
      input,
      configured,
      "link",
      args.network,
      row.owner,
      row.delegate,
    );
    return publicLink(row, asJsonObject(transaction));
  }

  const identity = {
    principal: input.principal,
    owner: args.owner,
    network: args.network as Network,
  };
  const linkId = (configured.randomUUID ?? (() => crypto.randomUUID()))();
  const kmsMode = readKmsMode(context(input).env ?? {});
  const kmsClient = kmsMode === "sign" ? kmsClientFor(input, configured) : null;
  const kmsKey = kmsMode === "sign"
    ? await (configured.createKmsDelegateKey ?? createKmsDelegateKey)({
        principal: input.principal,
        owner: args.owner,
        network: args.network,
        linkId,
        client: kmsClient!,
      })
    : null;
  const wrapped = kmsMode === "sign"
    ? null
    : configured.createWrappedDelegateKey
      ? await configured.createWrappedDelegateKey(identity, kekFor(input))
      : kmsMode === "kek"
        ? await createWrappedDelegateKeyWithCryptoKey(
            identity,
            await loadKmsKek(context(input).env ?? {}),
          )
        : await createWrappedDelegateKey(identity, kekFor(input));

  // Persist the wrapped key before any external call. If another request wins
  // the unique (principal, owner, network) race, reuse its durable delegate and
  // never fund this request's discarded key.
  let row: LinkRow;
  try {
    const common = {
      id: linkId,
      owner: args.owner,
      network: args.network,
      permissions,
      status: "pending" as const,
      lastLedger: null,
      revokeTx: null,
      createdAt: (configured.now ?? (() => new Date()))().toISOString(),
    };
    row = await accountStore.insertLink(kmsKey
      ? {
          ...common,
          delegate: kmsKey.address,
          keyBackend: "kms",
          delegateSeedEnc: null,
          iv: null,
          kmsKeyId: kmsKey.keyId,
          kmsAlias: kmsKey.keyAlias,
        }
      : {
          ...common,
          delegate: wrapped!.address,
          delegateSeedEnc: wrapped!.ciphertext,
          iv: wrapped!.iv,
        } satisfies LinkInsert);
  } catch (error) {
    const raced = await accountStore.getLink(args.owner, args.network);
    if (kmsKey && kmsClient) {
      await (configured.scheduleKmsDelegateKeyDeletion ?? scheduleKmsDelegateKeyDeletion)(
        kmsClient,
        kmsKey.keyId,
      );
    }
    if (!raced) throw error;
    row = await updateExistingLink(accountStore, raced, permissions);
  }

  // DelegateSet fields and the nested Permission shape follow:
  // https://xrpl.org/docs/references/protocol/transactions/types/delegateset
  const transaction = await prepareDelegateSet(
    configured.ledger,
    args.network,
    args.owner,
    row.delegate,
    permissions,
  );
  if (!onboardingMarkersPresent(input.env)) {
    await fundPendingDelegate(configured, row);
  }
  await syncQuickNodeLinkBestEffort(
    input,
    configured,
    "link",
    args.network,
    row.owner,
    row.delegate,
  );

  return publicLink(row, asJsonObject(transaction));
}

export async function handleAccountStatus(
  input: OpContext,
  rawArgs: AccountLookupArgs,
): Promise<AccountLink> {
  const args = AccountLookupArgsSchema.parse(rawArgs);
  assertLocalTradingTestnet(input, args.network);
  const configured = services(input);
  const accountStore = storeFor(input, configured);
  const row = requireLink(await accountStore.getLink(args.owner, args.network));
  if (row.status === "revoked") return publicLink(row);
  const entry = await configured.ledger.readDelegate(
    args.network,
    args.owner,
    row.delegate,
  );

  if (entry !== null) {
    const permissions = normalizeDelegatePermissions(entry, {
      owner: args.owner,
      delegate: row.delegate,
    });
    assertExactOnboardingPermissions(input.env, permissions);
    const updated = requireLink(
      await accountStore.updateLink(row.id, {
        permissions,
        status: row.status === "suspended" ? "suspended" : "active",
        lastLedger: ledgerIndex(entry) ?? row.lastLedger,
      }),
    );
    return publicLink(updated);
  }

  if (row.status === "pending") return publicLink(row);
  // A validated missing Delegate makes every non-pending KMS link terminal,
  // including links revoked outside this process. Retire the exact stored key
  // before marking the row revoked so a failed deletion remains retryable.
  if (row.keyBackend === "kms") {
    await (configured.scheduleKmsDelegateKeyDeletion ?? scheduleKmsDelegateKeyDeletion)(
      kmsClientFor(input, configured),
      row.kmsKeyId,
    );
  }
  // Keep both watcher paths enrolled while the locally suspended link may
  // still exist on-ledger. Registry removal is safe only after this validated
  // missing-entry proof; Harbor execution remains blocked throughout.
  await syncQuickNodeLinkBestEffort(
    input,
    configured,
    "revoke",
    args.network,
    row.owner,
    row.delegate,
  );
  const status: LinkRow["status"] = "revoked";
  return publicLink(
    requireLink(await accountStore.updateLink(row.id, { status, permissions: [], revokeTx: null })),
  );
}

export async function handleAccountRevoke(
  input: OpContext,
  rawArgs: AccountLookupArgs,
): Promise<AccountLink> {
  const args = AccountLookupArgsSchema.parse(rawArgs);
  assertLocalTradingTestnet(input, args.network);
  const configured = services(input);
  const accountStore = storeFor(input, configured);
  const row = requireLink(await accountStore.getLink(args.owner, args.network));
  if (row.status !== "active" && row.status !== "suspended") {
    throw new Error("account link must be active before revocation");
  }

  // An empty Permissions array deletes an existing Delegate ledger entry:
  // https://xrpl.org/docs/references/protocol/transactions/types/delegateset
  const transaction = await prepareDelegateRevoke(configured.ledger, args.network, args.owner, row.delegate);
  const revokeTx = asJsonObject(transaction);
  const updated = requireLink(
    await accountStore.updateLink(row.id, {
      status: "suspended",
      revokeTx,
    } satisfies LinkUpdate),
  );
  return publicLink(updated);
}

export const ops: OpDef[] = [
  {
    name: "account.link",
    family: "account",
    summary: "Create or reuse a test-network delegate account and prepare its permission grant.",
    tags: ["account", "delegation", "safety"],
    args: z
      .object({
        owner: OwnerSchema,
        network: ExecutionNetworkSchema,
        permissions: z.array(z.string().min(1)).max(10).optional(),
      })
      .strict(),
    returns: "AccountLink",
    caveats: [],
    example: 'await harbor.account.link({ owner: "r...", network: "testnet" })',
    handler: (ctx, args) =>
      handleAccountLink(ctx, AccountLinkArgsSchema.parse(args)),
  },
  {
    name: "account.status",
    family: "account",
    summary: "Read the on-ledger delegation and refresh the principal-scoped account link.",
    tags: ["account", "delegation", "status"],
    args: z
      .object({
        owner: OwnerSchema,
        network: ExecutionNetworkSchema,
      })
      .strict(),
    returns: "AccountLink",
    caveats: [],
    example: 'await harbor.account.status({ owner: "r...", network: "testnet" })',
    handler: (ctx, args) =>
      handleAccountStatus(ctx, AccountLookupArgsSchema.parse(args)),
  },
  {
    name: "account.revoke",
    family: "account",
    summary: "Prepare an empty-permission DelegateSet and suspend execution until revocation is confirmed.",
    tags: ["account", "delegation", "revoke"],
    args: z
      .object({
        owner: OwnerSchema,
        network: ExecutionNetworkSchema,
      })
      .strict(),
    returns: "AccountLink",
    caveats: [],
    example: 'await harbor.account.revoke({ owner: "r...", network: "testnet" })',
    handler: (ctx, args) =>
      handleAccountRevoke(ctx, AccountLookupArgsSchema.parse(args)),
  },
];
