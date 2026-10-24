import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { hashes, Wallet } from "xrpl";
import type { ExecutionCapability } from "@pilot/contracts";
import { chmod, mkdtemp, readFile, readdir, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  sealWalletSession,
  WALLET_SESSION_COOKIE,
} from "../../../../lib/wallet-session";
import {
  createRlusdAcquisitionIdentity,
  createRlusdAcquisitionQuote,
  rlusdAcquisitionTransactionDigest,
  RlusdAcquisitionBuildValidationError,
} from "../../../../lib/rlusd-acquisition";
import {
  createDefaultHarborActions,
  createRlusdAcquisitionHandler,
  FileAcquisitionStateStore,
  HarborOperationError,
  RLUSD_ACQUISITION,
  type AcquisitionHandlerDependencies,
  type AcquisitionState,
  type AcquisitionStateStore,
  type HarborAcquisitionActions,
} from "./handler";

const SECRET = "rlusd-acquisition-test-secret-at-least-thirty-two-characters";
const OPERATION_ID = "01234567-89ab-4cde-8f01-23456789abcd";
const CANONICAL_VECTOR_ACCOUNT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const NOW = new Date("2026-10-19T12:00:00.000Z");
const READY_ENV = {
  HARBOR_MOCK: "0",
  EXEC_NETWORK: "testnet",
  NEXT_PUBLIC_DEV_SIGNER: "1",
  PILOT_DEPLOYMENT_PROFILE: "local-wallet",
  P_LIVE_HARBOR_FOK_DEPLOYED: "1",
  P_LIVE_HARBOR_OWNER_APPROVAL_DEPLOYED: "1",
  HARBOR_URL: "http://127.0.0.1:8791",
  HARBOR_API_KEY: "server-only-api-key",
  P_LIVE_RLUSD_ACQUISITION_STATE_DIR: "/preexisting/state",
  SESSION_SECRET: SECRET,
} as const;

const V2_READY_ENV = {
  ...READY_ENV,
  P_LIVE_HARBOR_EXECUTION_V2: "1",
} as const;

const ISOLATED_READY_ENV = {
  ...READY_ENV,
  HARBOR_URL: "http://127.0.0.2:8791",
  NEXT_PUBLIC_PILOT_BUILD_MARKER: "pilot-local-wallet-isolated-v1",
  PILOT_DEPLOYMENT_PROFILE: "local-wallet-isolated-v1",
} as const;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Upper(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex").toUpperCase();
}

function unsignedForDigest(transaction: Record<string, unknown>): Record<string, unknown> {
  const unsigned = { ...transaction };
  delete unsigned.SigningPubKey;
  delete unsigned.TxnSignature;
  delete unsigned.Signers;
  return unsigned;
}

function economicForDigest(transaction: Record<string, unknown>): Record<string, unknown> {
  const economic = unsignedForDigest(transaction);
  delete economic.Fee;
  delete economic.Sequence;
  delete economic.LastLedgerSequence;
  delete economic.Delegate;
  return economic;
}

function approvedTransaction(wallet: Wallet, overrides: Record<string, unknown> = {}) {
  return {
    TransactionType: "OfferCreate",
    Account: wallet.classicAddress,
    TakerGets: "150000000",
    TakerPays: {
      currency: RLUSD_ACQUISITION.currency,
      issuer: RLUSD_ACQUISITION.issuer,
      value: RLUSD_ACQUISITION.amount,
    },
    Flags: RLUSD_ACQUISITION.fillOrKillFlag,
    Fee: "12",
    Sequence: 1,
    LastLedgerSequence: 500,
    ...overrides,
  };
}

function replacementBuild(
  wallet: Wallet,
  overrides: {
    ledgerIndex?: number;
    quoteLedgerIndex?: number;
    sequence?: number;
    balanceBefore?: string;
    spendDrops?: bigint;
    buildId?: string;
  } = {},
) {
  const ledgerIndex = overrides.ledgerIndex ?? 501;
  const quoteLedgerIndex = overrides.quoteLedgerIndex ?? ledgerIndex;
  const sequence = overrides.sequence ?? 1;
  const spendDrops = overrides.spendDrops ?? 160_000_000n;
  const identity = createRlusdAcquisitionIdentity(wallet.classicAddress, OPERATION_ID);
  const quote = createRlusdAcquisitionQuote(
    identity,
    spendDrops,
    quoteLedgerIndex,
    "B".repeat(64),
  );
  const transaction = approvedTransaction(wallet, {
    TakerGets: spendDrops.toString(),
    Sequence: sequence,
    LastLedgerSequence: ledgerIndex + 4,
  });
  return {
    buildId: overrides.buildId ?? "replacement-build-public-id",
    transaction,
    transactionDigest: rlusdAcquisitionTransactionDigest(transaction),
    quote,
    accountState: { ledgerIndex, sequence },
    balanceBefore: overrides.balanceBefore ?? "10",
    balanceBeforeLedgerIndex: ledgerIndex,
  };
}

function v2Build(
  wallet: Wallet,
  overrides: {
    ledgerIndex?: number;
    quoteLedgerIndex?: number;
    sequence?: number;
    balanceBefore?: string;
    spendDrops?: bigint;
    buildId?: string;
    buildRevision?: number;
    capability?: Partial<ExecutionCapability>;
    transaction?: Record<string, unknown>;
  } = {},
) {
  const ledgerIndex = overrides.ledgerIndex ?? 496;
  const quoteLedgerIndex = overrides.quoteLedgerIndex ?? ledgerIndex;
  const sequence = overrides.sequence ?? 1;
  const balanceBefore = overrides.balanceBefore ?? "10";
  const spendDrops = overrides.spendDrops ?? 150_000_000n;
  const transaction = overrides.transaction ?? approvedTransaction(wallet, {
    TakerGets: spendDrops.toString(),
    Sequence: sequence,
    LastLedgerSequence: ledgerIndex + 64,
  });
  const identity = createRlusdAcquisitionIdentity(wallet.classicAddress, OPERATION_ID);
  const quote = createRlusdAcquisitionQuote(
    identity,
    spendDrops,
    quoteLedgerIndex,
    "D".repeat(64),
  );
  const executionCapability: ExecutionCapability = {
    execution_contract: "xrpl_execution_v2",
    build_revision: overrides.buildRevision ?? 1,
    unsigned_tx_digest: sha256Upper(unsignedForDigest(transaction)),
    unsigned_tx_digest_alg: "sha256-jcs-v1",
    economic_fingerprint: sha256Upper({
      owner: wallet.classicAddress,
      network: "testnet",
      transaction: economicForDigest(transaction),
    }),
    economic_fingerprint_alg: "sha256-jcs-economic-v1",
    build_ledger: ledgerIndex,
    first_inclusion_ledger: ledgerIndex + 1,
    last_ledger_sequence: ledgerIndex + 64,
    minimum_remaining_ledgers: 8,
    approval_expires_in_seconds: 90,
    quote_ledger: quoteLedgerIndex,
    quote_valid_through_ledger: quoteLedgerIndex + 1,
    acquisition_balance_invariant: {
      kind: "issued_balance_unchanged",
      currency: RLUSD_ACQUISITION.currency,
      issuer: RLUSD_ACQUISITION.issuer,
      balance: balanceBefore,
      ledger_index: ledgerIndex,
    },
    ...overrides.capability,
  };
  return {
    buildId: overrides.buildId ?? "v2-build-public-id",
    transaction,
    transactionDigest: rlusdAcquisitionTransactionDigest(transaction),
    quote,
    accountState: { ledgerIndex, sequence },
    balanceBefore,
    balanceBeforeLedgerIndex: ledgerIndex,
    executionCapability,
  };
}

class MemoryStore implements AcquisitionStateStore {
  readonly states = new Map<string, AcquisitionState>();
  readonly events: string[] = [];
  ready = true;
  private readonly tails = new Map<string, Promise<void>>();

  async assertReady() {
    if (!this.ready) throw new Error("missing state directory");
  }

  async load(owner: string) {
    const value = this.states.get(owner);
    return value ? structuredClone(value) : undefined;
  }

  async save(owner: string, state: AcquisitionState) {
    this.events.push(`save:${state.status}`);
    this.states.set(owner, structuredClone(state));
  }

  async withOwnerLock<T>(owner: string, callback: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(owner) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(owner, current);
    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (this.tails.get(owner) === current) this.tails.delete(owner);
    }
  }
}

function harbor(wallet: Wallet, events: string[] = []): HarborAcquisitionActions & {
  refreshPrecheck: ReturnType<typeof vi.fn>;
  build: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  approvalPreflight: ReturnType<typeof vi.fn>;
  approvalReconcile: ReturnType<typeof vi.fn>;
  relay: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  proveCompletion: ReturnType<typeof vi.fn>;
} {
  return {
    refreshPrecheck: vi.fn(async () => ({
      ledgerIndex: 498,
      sequence: 1,
      balance: "10",
    })),
    build: vi.fn(async (owner: string, operationId: string) => {
      const identity = createRlusdAcquisitionIdentity(owner, operationId);
      const quote = createRlusdAcquisitionQuote(identity, 150_000_000n, 496, "A".repeat(64));
      const transaction = approvedTransaction(wallet);
      return {
        buildId: "build-public-id",
        transaction,
        transactionDigest: rlusdAcquisitionTransactionDigest(transaction),
        quote,
        accountState: { ledgerIndex: 496, sequence: 1 },
        balanceBefore: "10",
        balanceBeforeLedgerIndex: 496,
      };
    }),
    execute: vi.fn(async (_owner: string, _operationId: string, built: { transaction: Record<string, unknown> }) => ({
      approvalId: "approval-public-id",
      approvalExpiresAt: "2026-10-19T12:10:00.000Z",
      transaction: built.transaction,
    })),
    approvalPreflight: vi.fn(async () => {
      throw new Error("v2 approval preflight was not configured for this test");
    }),
    approvalReconcile: vi.fn(async () => {
      throw new HarborOperationError("APPROVAL_RECOVERY_NOT_READY", "error");
    }),
    relay: vi.fn(async (blob: string) => {
      events.push("relay");
      return {
        hash: hashes.hashSignedTx(blob).toUpperCase(),
        validated: true as const,
        ledgerIndex: 490,
        engineResult: "tesSUCCESS",
      };
    }),
    status: vi.fn(async (hash: string) => ({
      hash,
      validated: false,
    })),
    proveCompletion: vi.fn(async (hash: string) => ({
      hash,
      ledgerIndex: 490,
      engineResult: "tesSUCCESS" as const,
      balanceAfter: "85",
      balanceAfterLedgerIndex: 490,
    })),
  };
}

function v2Harbor(wallet: Wallet, events: string[] = []) {
  const actions = harbor(wallet, events);
  const built = v2Build(wallet);
  actions.build.mockResolvedValue(built);
  actions.execute.mockImplementation(async (
    _owner: string,
    _operationId: string,
    requestedBuild: typeof built,
  ) => ({
    approvalId: "v2-approval-public-id",
    approvalExpiresAt: new Date(NOW.getTime() + 90_000).toISOString(),
    transaction: requestedBuild.transaction,
  }));
  actions.approvalPreflight.mockImplementation(async (
    approvalId: string,
    capability: ExecutionCapability,
  ) => ({
    approvalId,
    expiresAt: new Date(NOW.getTime() + 90_000).toISOString(),
    validatedLedger: capability.last_ledger_sequence - 8,
    remainingLedgers: 8,
    executionCapability: capability,
  }));
  return actions;
}

function request(
  body: unknown,
  cookie?: string,
  options: { url?: string; origin?: string; headers?: HeadersInit } = {},
) {
  const url = options.url ?? "http://127.0.0.1:3003/api/dev/rlusd-acquisition";
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: new URL(url).host,
      origin: options.origin ?? new URL(url).origin,
      ...(cookie ? { cookie } : {}),
      ...options.headers,
    },
    body: JSON.stringify(body),
  });
}

async function readLockTail(lockPath: string): Promise<{
  path: string;
  record: Record<string, unknown>;
}> {
  let path = lockPath;
  let record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  for (let depth = 0; depth < 4096; depth += 1) {
    const token = record.token;
    if (typeof token !== "string") throw new Error("Invalid lock generation in test");
    const successorPath = `${lockPath}.next-${token}`;
    try {
      record = JSON.parse(await readFile(successorPath, "utf8")) as Record<string, unknown>;
      path = successorPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, record };
      throw error;
    }
  }
  throw new Error("Lock generation limit exceeded in test");
}

function sessionCookie(wallet: Wallet, network: "testnet" | "devnet" = "testnet") {
  return `${WALLET_SESSION_COOKIE}=${encodeURIComponent(sealWalletSession({
    version: 1,
    account: wallet.classicAddress,
    network,
    expiresAt: Date.now() + 60_000,
  }, SECRET))}`;
}

function initializingState(wallet: Wallet): AcquisitionState {
  return {
    version: 1,
    operation_id: OPERATION_ID,
    owner: wallet.classicAddress,
    network: "testnet",
    status: "initializing",
    intent_id: `p-live-acquire-rlusd-${OPERATION_ID}`,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

function harness(options: {
  env?: Record<string, string | undefined>;
  wallet?: Wallet;
  store?: MemoryStore;
  harbor?: HarborAcquisitionActions;
  now?: () => Date;
  recordTiming?: AcquisitionHandlerDependencies["recordTiming"];
  readSession?: AcquisitionHandlerDependencies["readSession"];
} = {}) {
  const wallet = options.wallet ?? Wallet.generate();
  const store = options.store ?? new MemoryStore();
  const actions = options.harbor ?? harbor(wallet, store.events);
  const handler = createRlusdAcquisitionHandler({
    env: options.env ?? READY_ENV,
    harbor: actions,
    now: options.now ?? (() => new Date(NOW)),
    randomUUID: () => OPERATION_ID,
    recordTiming: options.recordTiming ?? vi.fn(),
    readSession: options.readSession ?? (() => ({
      version: 1,
      account: wallet.classicAddress,
      network: "testnet",
      expiresAt: NOW.getTime() + 60_000,
    })),
    stateStore: store,
  });
  return { actions, handler, store, wallet };
}

async function prepare(h: ReturnType<typeof harness>) {
  return h.handler(request({ action: "prepare" }));
}

function signingPreflightBody(state: Record<string, unknown>) {
  return {
    action: "preflight",
    operation_id: state.operation_id,
    approval_binding: state.approval_binding,
  };
}

beforeEach(() => {
  process.env.SESSION_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.SESSION_SECRET;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("POST /api/dev/rlusd-acquisition", () => {
  it("reads the authoritative account and balance ledger only after Harbor builds", async () => {
    const wallet = Wallet.generate();
    // Synthetic indices reproduce the captured live shape Q=P-1 and LLS=P+4;
    // the failed run did not preserve its exact public ledger numbers.
    const quoteLedger = 480;
    const buildLedger = 481;
    const quoteHash = "A".repeat(64);
    const buildHash = "B".repeat(64);
    const events: string[] = [];
    const transaction = approvedTransaction(wallet, {
      LastLedgerSequence: buildLedger + 4,
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.endsWith("/api/ops/tx.swap")) {
        events.push("harbor-build");
        return Response.json({
          ok: true,
          data: {
            build_id: "build-public-id",
            network: "testnet",
            tx_json: transaction,
            delegable: false,
            simulate: {
              engine_result: "tesSUCCESS",
              engine_result_message: "The simulated transaction would succeed.",
              applied: false,
            },
            preflight: Array.from({ length: 6 }, (_, index) => ({
              check: `preflight-${index + 1}`,
              pass: true,
            })),
            summary: {
              action: "Acquire RLUSD",
              account: wallet.classicAddress,
              amounts: ["75 RLUSD"],
              fee_drops: "12",
              reserve_delta_drops: "0",
            },
          },
          asOf: NOW.toISOString(),
          asOfBasis: `validated ledger ${buildLedger}`,
        });
      }
      const method = body.method;
      const params = (body.params as Array<Record<string, unknown>>)[0]!;
      if (method === "ripple_path_find") {
        events.push("quote");
        return Response.json({ result: {
          validated: true,
          full_reply: true,
          source_account: wallet.classicAddress,
          destination_account: wallet.classicAddress,
          destination_amount: {
            currency: RLUSD_ACQUISITION.currency,
            issuer: RLUSD_ACQUISITION.issuer,
            value: RLUSD_ACQUISITION.amount,
          },
          alternatives: [{ source_amount: "150000000" }],
          ledger_index: quoteLedger,
          ledger_hash: quoteHash,
        } });
      }
      if (method === "account_info" && params.account === wallet.classicAddress) {
        events.push("post-build-account");
        return Response.json({ result: {
          validated: true,
          ledger_index: buildLedger,
          ledger_hash: buildHash,
          account_data: { Account: wallet.classicAddress, Sequence: 1 },
        } });
      }
      if (method === "account_lines") {
        events.push("post-build-balance");
        expect(params.ledger_hash).toBe(buildHash);
        return Response.json({ result: {
          validated: true,
          ledger_index: buildLedger,
          ledger_hash: buildHash,
          lines: [{
            account: RLUSD_ACQUISITION.issuer,
            currency: "RLUSD",
            balance: "10",
            limit: "10000",
          }],
        } });
      }
      if (method === "account_info" && params.account === RLUSD_ACQUISITION.issuer) {
        events.push("post-build-issuer");
        expect(params.ledger_hash).toBe(buildHash);
        return Response.json({ result: {
          validated: true,
          ledger_index: buildLedger,
          ledger_hash: buildHash,
          account_data: { Account: RLUSD_ACQUISITION.issuer, Flags: 0 },
        } });
      }
      throw new Error(`Unexpected test request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const built = await createDefaultHarborActions(READY_ENV, () => new Date(NOW))
      .build(wallet.classicAddress, OPERATION_ID, "xrpl_execution_v1");

    expect(events).toEqual([
      "quote",
      "harbor-build",
      "post-build-account",
      "post-build-balance",
      "post-build-issuer",
    ]);
    expect(built.quote.ledger_index).toBe(quoteLedger);
    expect(built.accountState).toEqual({ ledgerIndex: buildLedger, sequence: 1 });
    expect(built.balanceBeforeLedgerIndex).toBe(buildLedger);
    expect(built.transaction.LastLedgerSequence).toBe(buildLedger + 4);
  });

  it("reconciles local-trading expiry through tx.status and the fixed validated snapshot only", async () => {
    const wallet = Wallet.generate();
    const store = new MemoryStore();
    const setupActions = harbor(wallet, store.events);
    setupActions.relay.mockRejectedValueOnce(new Error("uncertain submit response"));
    const setup = harness({ wallet, store, harbor: setupActions });
    await prepare(setup);
    const blob = wallet.sign(approvedTransaction(wallet) as never).tx_blob;
    const hash = hashes.hashSignedTx(blob).toUpperCase();
    expect((await setup.handler(request({
      action: "submit",
      operation_id: OPERATION_ID,
      tx_blob: blob,
    }))).status).toBe(202);

    const ledgerIndex = 501;
    const ledgerHash = "C".repeat(64);
    const events: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.startsWith("http://127.0.0.1:8791/")) {
        expect(url).toBe("http://127.0.0.1:8791/api/ops/tx.status");
        expect(body).toEqual({ hash, account: wallet.classicAddress, network: "testnet" });
        events.push("harbor:tx.status");
        return Response.json({
          ok: true,
          data: { hash, network: "testnet", validated: false },
          asOf: NOW.toISOString(),
          asOfBasis: "local trading Testnet transaction status",
        });
      }
      expect(url).toBe("https://s.altnet.rippletest.net:51234/");
      const method = body.method;
      const params = (body.params as Array<Record<string, unknown>>)[0]!;
      if (method === "account_info" && params.account === wallet.classicAddress) {
        events.push("ledger:owner");
        return Response.json({ result: {
          validated: true,
          ledger_index: ledgerIndex,
          ledger_hash: ledgerHash,
          account_data: { Account: wallet.classicAddress, Sequence: 1 },
        } });
      }
      if (method === "account_lines") {
        events.push("ledger:balance");
        expect(params.ledger_hash).toBe(ledgerHash);
        return Response.json({ result: {
          validated: true,
          ledger_index: ledgerIndex,
          ledger_hash: ledgerHash,
          lines: [{
            account: RLUSD_ACQUISITION.issuer,
            currency: "RLUSD",
            balance: "10",
            limit: "10000",
          }],
        } });
      }
      if (method === "account_info" && params.account === RLUSD_ACQUISITION.issuer) {
        events.push("ledger:issuer");
        expect(params.ledger_hash).toBe(ledgerHash);
        return Response.json({ result: {
          validated: true,
          ledger_index: ledgerIndex,
          ledger_hash: ledgerHash,
          account_data: { Account: RLUSD_ACQUISITION.issuer, Flags: 0 },
        } });
      }
      throw new Error(`Unexpected reconciliation request: ${String(method)} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const restarted = createRlusdAcquisitionHandler({
      env: READY_ENV,
      harbor: createDefaultHarborActions(READY_ENV, () => new Date(NOW)),
      now: () => new Date(NOW),
      randomUUID: () => OPERATION_ID,
      readSession: () => ({
        version: 1,
        account: wallet.classicAddress,
        network: "testnet",
        expiresAt: NOW.getTime() + 60_000,
      }),
      stateStore: store,
    });

    const result = await restarted(request({ action: "status", operation_id: OPERATION_ID }));

    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ status: "expired_unincluded", hash });
    expect(events).toEqual([
      "harbor:tx.status",
      "ledger:owner",
      "ledger:balance",
      "ledger:issuer",
    ]);
    expect(setupActions.relay).toHaveBeenCalledTimes(1);
  });

  it("preserves a typed Harbor approval-preflight rejection code", async () => {
    const wallet = Wallet.generate();
    const capability = v2Build(wallet).executionCapability;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      ok: false,
      error: {
        service: "tx.approvalPreflight",
        kind: "error",
        code: "TRANSACTION_WINDOW_TOO_SHORT",
        message: "Fewer than eight validated ledgers remain",
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await createDefaultHarborActions(V2_READY_ENV, () => new Date(NOW))
      .approvalPreflight("v2-approval-public-id", capability)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(HarborOperationError);
    expect(error).toMatchObject({
      code: "TRANSACTION_WINDOW_TOO_SHORT",
      kind: "error",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends the exact immutable binding to Harbor approval recovery", async () => {
    const wallet = Wallet.generate();
    const capability = v2Build(wallet).executionCapability;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      ok: true,
      data: {
        status: "expired_nonincluded",
        approval_id: "v2-approval-public-id",
        execution_id: "v2-execution-public-id",
        validated_ledger: capability.last_ledger_sequence + 1,
        first_inclusion_ledger: capability.first_inclusion_ledger,
        last_ledger_sequence: capability.last_ledger_sequence,
        next_action: "request_fresh_build",
      },
      asOf: NOW.toISOString(),
      asOfBasis: "offline recovery fixture",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createDefaultHarborActions(V2_READY_ENV, () => new Date(NOW))
      .approvalReconcile("v2-approval-public-id", capability)).resolves.toMatchObject({
      status: "expired_nonincluded",
      approvalId: "v2-approval-public-id",
      executionId: "v2-execution-public-id",
      nextAction: "request_fresh_build",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:8791/api/ops/tx.approvalReconcile",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      approval_id: "v2-approval-public-id",
      execution_contract: "xrpl_execution_v2",
      build_revision: capability.build_revision,
      unsigned_tx_digest: capability.unsigned_tx_digest,
      economic_fingerprint: capability.economic_fingerprint,
    });
  });

  it("persists and prepares a build one ledger newer than its independent quote", async () => {
    const wallet = Wallet.generate();
    const actions = harbor(wallet);
    const advanced = replacementBuild(wallet, {
      quoteLedgerIndex: 480,
      ledgerIndex: 481,
      spendDrops: 150_000_000n,
      buildId: "advanced-build-public-id",
    });
    actions.build.mockResolvedValueOnce(advanced);
    const h = harness({ wallet, harbor: actions });

    const result = await prepare(h);
    const replay = await prepare(h);

    expect(result.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(actions.build).toHaveBeenCalledTimes(1);
    expect(actions.execute).toHaveBeenCalledTimes(1);
    expect(h.store.states.get(wallet.classicAddress)).toMatchObject({
      status: "prepared",
      quote: { ledger_index: 480 },
      account_state: { ledgerIndex: 481, sequence: 1 },
      balance_before_ledger_index: 481,
      last_ledger_sequence: 485,
    });
  });

  it("permits signing preflight with the minimum two-ledger cushion and unchanged state", async () => {
    const recordTiming = vi.fn();
    const h = harness({ recordTiming });
    const prepared = await (await prepare(h)).json() as Record<string, unknown>;
    vi.mocked(h.actions.refreshPrecheck).mockResolvedValueOnce({ ledgerIndex: 498, sequence: 1, balance: "10" });

    const result = await h.handler(request(signingPreflightBody(prepared)));

    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      status: "prepared",
      approval_binding: prepared.approval_binding,
    });
    expect(h.store.states.get(h.wallet.classicAddress)?.status).toBe("prepared");
    expect(h.actions.refreshPrecheck).toHaveBeenCalledTimes(1);
    expect(h.actions.relay).not.toHaveBeenCalled();
    expect(recordTiming).toHaveBeenCalledWith({
      operationId: OPERATION_ID,
      refreshAttempt: 0,
      stage: "preflight_snapshot_completed",
      at: NOW.toISOString(),
      lastLedgerSequence: 500,
      ledgerIndex: 498,
      remainingLedgers: 2,
    });
  });

  it.each([
    ["one", 499],
    ["zero", 500],
    ["negative", 501],
  ])("blocks signing preflight with %s remaining-ledger cushion", async (_label, ledgerIndex) => {
    const h = harness();
    const prepared = await (await prepare(h)).json() as Record<string, unknown>;
    vi.mocked(h.actions.refreshPrecheck).mockResolvedValueOnce({ ledgerIndex, sequence: 1, balance: "10" });

    const result = await h.handler(request(signingPreflightBody(prepared)));

    expect(result.status).toBe(409);
    expect((await result.json()).error.code).toBe("ACQUISITION_SIGNING_WINDOW_TOO_SHORT");
    expect(h.store.states.get(h.wallet.classicAddress)?.status).toBe("prepared");
    expect(h.actions.relay).not.toHaveBeenCalled();
  });

  it("negotiates and persists the exact v2 contract without changing legacy defaults", async () => {
    const wallet = Wallet.generate();
    const actions = v2Harbor(wallet);
    actions.build.mockResolvedValueOnce(v2Build(wallet, {
      capability: {
        acquisition_balance_invariant: {
          kind: "issued_balance_unchanged",
          currency: RLUSD_ACQUISITION.currency,
          issuer: RLUSD_ACQUISITION.issuer,
          balance: "10",
          ledger_index: 495,
        },
      },
    }));
    const h = harness({ wallet, harbor: actions, env: V2_READY_ENV });

    const result = await prepare(h);
    const body = await result.json() as Record<string, unknown>;

    expect(result.status).toBe(200);
    expect(body).toMatchObject({
      status: "prepared",
      execution_contract: "xrpl_execution_v2",
      build_revision: 1,
    });
    expect(actions.build).toHaveBeenCalledWith(
      wallet.classicAddress,
      OPERATION_ID,
      "xrpl_execution_v2",
    );
    expect(actions.execute.mock.calls[0]?.[2]).toMatchObject({
      executionCapability: {
        execution_contract: "xrpl_execution_v2",
        build_revision: 1,
        minimum_remaining_ledgers: 8,
        approval_expires_in_seconds: 90,
      },
    });
    expect(h.store.states.get(wallet.classicAddress)).toMatchObject({
      requested_execution_contract: "xrpl_execution_v2",
      execution_capability: {
        build_revision: 1,
        build_ledger: 496,
        first_inclusion_ledger: 497,
        last_ledger_sequence: 560,
      },
      approval_received_at: NOW.toISOString(),
      last_ledger_sequence: 560,
    });
  });

  it("keeps Pilot and Harbor quote ledgers independent while bounding both to the build", async () => {
    const wallet = Wallet.generate();
    const actions = v2Harbor(wallet);
    actions.build.mockResolvedValueOnce(v2Build(wallet, {
      ledgerIndex: 497,
      quoteLedgerIndex: 496,
      capability: {
        quote_ledger: 497,
        quote_valid_through_ledger: 498,
        acquisition_balance_invariant: {
          kind: "issued_balance_unchanged",
          currency: RLUSD_ACQUISITION.currency,
          issuer: RLUSD_ACQUISITION.issuer,
          balance: "10",
          ledger_index: 496,
        },
      },
    }));
    const h = harness({ wallet, harbor: actions, env: V2_READY_ENV });

    const result = await prepare(h);

    expect(result.status).toBe(200);
    expect(h.store.states.get(wallet.classicAddress)).toMatchObject({
      quote: { ledger_index: 496 },
      account_state: { ledgerIndex: 497 },
      execution_capability: {
        quote_ledger: 497,
        build_ledger: 497,
      },
    });
  });

  it("matches Harbor's fixed canonical OfferCreate digest vector", async () => {
    const wallet = { classicAddress: CANONICAL_VECTOR_ACCOUNT } as Wallet;
    const transaction = approvedTransaction(wallet, {
      Fee: "12",
      Sequence: 22,
      LastLedgerSequence: 1_064,
      SigningPubKey: "",
    });
    const actions = v2Harbor(wallet);
    actions.build.mockResolvedValueOnce(v2Build(wallet, {
      ledgerIndex: 1_000,
      quoteLedgerIndex: 1_000,
      sequence: 22,
      transaction,
      capability: {
        unsigned_tx_digest: "830816E5E5A568B80D28F4219A09319E618250452F1F210D0BCFF8C5A004EE91",
        economic_fingerprint: "4426B04C200DBEDE6AD33641E008317B2CCEFEA341E3DD452356D29145194C5C",
        acquisition_balance_invariant: {
          kind: "issued_balance_unchanged",
          currency: RLUSD_ACQUISITION.currency,
          issuer: RLUSD_ACQUISITION.issuer,
          balance: "10",
          ledger_index: 1_000,
        },
      },
    }));
    const h = harness({ wallet, harbor: actions, env: V2_READY_ENV });

    const result = await prepare(h);

    expect(result.status).toBe(200);
    expect(actions.execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["v2 request downgraded to legacy", V2_READY_ENV, false],
    ["legacy request receives unsolicited v2", READY_ENV, true],
  ] as const)("fails closed when %s", async (_label, env, returnV2) => {
    const wallet = Wallet.generate();
    const actions = returnV2 ? v2Harbor(wallet) : harbor(wallet);
    const h = harness({ wallet, harbor: actions, env });

    const result = await prepare(h);

    expect(result.status).toBe(502);
    expect((await result.json()).error.code).toBe("UNSAFE_HARBOR_BUILD");
    expect(h.store.states.get(wallet.classicAddress)?.status).toBe("initializing");
    expect(actions.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["build revision", { build_revision: 2 }],
    ["unsigned digest", { unsigned_tx_digest: "C".repeat(64) }],
    ["economic fingerprint", { economic_fingerprint: "D".repeat(64) }],
    ["official RLUSD balance", {
      acquisition_balance_invariant: {
        kind: "issued_balance_unchanged" as const,
        currency: RLUSD_ACQUISITION.currency,
        issuer: RLUSD_ACQUISITION.issuer,
        balance: "11",
        ledger_index: 496,
      },
    }],
    ["future official RLUSD balance ledger", {
      acquisition_balance_invariant: {
        kind: "issued_balance_unchanged" as const,
        currency: RLUSD_ACQUISITION.currency,
        issuer: RLUSD_ACQUISITION.issuer,
        balance: "10",
        ledger_index: 497,
      },
    }],
    ["stale official RLUSD balance ledger", {
      acquisition_balance_invariant: {
        kind: "issued_balance_unchanged" as const,
        currency: RLUSD_ACQUISITION.currency,
        issuer: RLUSD_ACQUISITION.issuer,
        balance: "10",
        ledger_index: 494,
      },
    }],
  ])("rejects a mutated v2 %s binding before approval", async (_label, capability) => {
    const wallet = Wallet.generate();
    const actions = v2Harbor(wallet);
    actions.build.mockResolvedValueOnce(v2Build(wallet, { capability }));
    const h = harness({ wallet, harbor: actions, env: V2_READY_ENV });

    const result = await prepare(h);

    expect(result.status).toBe(502);
    expect((await result.json()).error.code).toBe("UNSAFE_HARBOR_BUILD");
    expect(actions.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["seven", 553, 409],
    ["eight", 552, 200],
  ] as const)("enforces the v2 pre-sign %s-ledger boundary", async (
    _label,
    ledgerIndex,
    expectedStatus,
  ) => {
    const wallet = Wallet.generate();
    const actions = v2Harbor(wallet);
    const h = harness({ wallet, harbor: actions, env: V2_READY_ENV });
    const prepared = await (await prepare(h)).json() as Record<string, unknown>;
    actions.refreshPrecheck.mockResolvedValueOnce({ ledgerIndex, sequence: 1, balance: "10" });

    const result = await h.handler(request(signingPreflightBody(prepared)));

    expect(result.status).toBe(expectedStatus);
    expect(actions.approvalPreflight).toHaveBeenCalledTimes(expectedStatus === 200 ? 1 : 0);
    expect(actions.relay).not.toHaveBeenCalled();
    expect(h.store.states.get(wallet.classicAddress)?.status).toBe("prepared");
    if (expectedStatus === 200) {
      expect(h.store.states.get(wallet.classicAddress)).toMatchObject({
        approval_preflight_ledger: 552,
        approval_preflight_remaining_ledgers: 8,
      });
    } else {
      expect((await result.json()).error.code).toBe("ACQUISITION_SIGNING_WINDOW_TOO_SHORT");
    }
  });

  it("rejects an approval exactly at its v2 wall-clock deadline before Harbor preflight", async () => {
    let now = new Date(NOW);
    const wallet = Wallet.generate();
    const actions = v2Harbor(wallet);
    const h = harness({ wallet, harbor: actions, env: V2_READY_ENV, now: () => new Date(now) });
    const prepared = await (await prepare(h)).json() as Record<string, unknown>;
    now = new Date(NOW.getTime() + 90_000);

    const result = await h.handler(request(signingPreflightBody(prepared)));

    expect(result.status).toBe(409);
    expect((await result.json()).error.code).toBe("ACQUISITION_APPROVAL_EXPIRED");
    expect(actions.approvalPreflight).not.toHaveBeenCalled();
  });

  it("rejects stale or mutated Harbor v2 preflight evidence without authorizing signing", async () => {
    const wallet = Wallet.generate();
    const actions = v2Harbor(wallet);
    const h = harness({ wallet, harbor: actions, env: V2_READY_ENV });
    const prepared = await (await prepare(h)).json() as Record<string, unknown>;
    actions.refreshPrecheck.mockResolvedValueOnce({ ledgerIndex: 552, sequence: 1, balance: "10" });
    const capability = v2Build(wallet).executionCapability;
    actions.approvalPreflight.mockResolvedValueOnce({
      approvalId: "different-approval",
      expiresAt: new Date(NOW.getTime() + 90_000).toISOString(),
      validatedLedger: 552,
      remainingLedgers: 8,
      executionCapability: { ...capability, build_revision: 2 },
    });

    const result = await h.handler(request(signingPreflightBody(prepared)));

    expect(result.status).toBe(502);
    expect((await result.json()).error.code).toBe("INVALID_HARBOR_APPROVAL");
    expect(h.store.states.get(wallet.classicAddress)?.approval_preflight_completed_at).toBeUndefined();
    expect(actions.relay).not.toHaveBeenCalled();
  });

  it("rejects Harbor v2 preflight evidence that regresses behind the local signing checkpoint", async () => {
    const wallet = Wallet.generate();
    const actions = v2Harbor(wallet);
    const h = harness({ wallet, harbor: actions, env: V2_READY_ENV });
    const prepared = await (await prepare(h)).json() as Record<string, unknown>;
    actions.refreshPrecheck.mockResolvedValueOnce({ ledgerIndex: 552, sequence: 1, balance: "10" });
    const capability = v2Build(wallet).executionCapability;
    actions.approvalPreflight.mockResolvedValueOnce({
      approvalId: "v2-approval-public-id",
      expiresAt: new Date(NOW.getTime() + 90_000).toISOString(),
      validatedLedger: 551,
      remainingLedgers: 9,
      executionCapability: capability,
    });

    const result = await h.handler(request(signingPreflightBody(prepared)));

    expect(result.status).toBe(502);
    expect((await result.json()).error.code).toBe("INVALID_HARBOR_APPROVAL");
    expect(h.store.states.get(wallet.classicAddress)?.approval_preflight_completed_at).toBeUndefined();
    expect(actions.relay).not.toHaveBeenCalled();
  });

  it.each([
    "TRANSACTION_WINDOW_TOO_SHORT",
    "APPROVAL_EXPIRED",
    "ACCOUNT_SEQUENCE_CHANGED",
    "BALANCE_INVARIANT_CHANGED",
    "FEE_LOAD_UNSAFE",
  ] as const)("keeps a first-dispatch %s rejection frozen until atomic recovery proof", async (code) => {
    const wallet = Wallet.generate();
    const actions = v2Harbor(wallet);
    const h = harness({ wallet, harbor: actions, env: V2_READY_ENV });
    const prepared = await (await prepare(h)).json() as Record<string, unknown>;
    actions.refreshPrecheck.mockResolvedValue({ ledgerIndex: 552, sequence: 1, balance: "10" });
    actions.approvalPreflight.mockRejectedValueOnce(new HarborOperationError(code, "error"));

    const rejected = await h.handler(request(signingPreflightBody(prepared)));
    const refresh = await h.handler(request({ action: "refresh", operation_id: OPERATION_ID }));
    const recovery = await h.handler(request({ action: "status", operation_id: OPERATION_ID }));

    expect(rejected.status).toBe(502);
    expect((await rejected.json()).error.code).toBe(code);
    expect(refresh.status).toBe(409);
    expect(recovery.status).toBe(409);
    expect((await recovery.json()).error.code).toBe("APPROVAL_RECOVERY_NOT_READY");
    expect(h.store.states.get(wallet.classicAddress)).toMatchObject({
      status: "prepared",
      approval_preflight_started_at: NOW.toISOString(),
    });
    expect(actions.build).toHaveBeenCalledTimes(1);
    expect(actions.execute).toHaveBeenCalledTimes(1);
    expect(actions.relay).not.toHaveBeenCalled();
  });

  it("accepts only an exact atomic burned-tuple proof before refreshing an ambiguous preflight", async () => {
    const wallet = Wallet.generate();
    const actions = v2Harbor(wallet);
    const h = harness({ wallet, harbor: actions, env: V2_READY_ENV });
    const prepared = await (await prepare(h)).json() as Record<string, unknown>;
    const capability = v2Build(wallet).executionCapability;
    actions.refreshPrecheck
      .mockResolvedValueOnce({ ledgerIndex: 552, sequence: 1, balance: "10" })
      .mockResolvedValueOnce({ ledgerIndex: 561, sequence: 1, balance: "10" });
    actions.approvalPreflight.mockRejectedValueOnce(new Error("preflight response lost"));
    actions.approvalReconcile.mockResolvedValue({
      status: "expired_nonincluded",
      approvalId: "v2-approval-public-id",
      executionId: "v2-execution-public-id",
      validatedLedger: 561,
      firstInclusionLedger: capability.first_inclusion_ledger,
      lastLedgerSequence: capability.last_ledger_sequence,
      nextAction: "request_fresh_build",
    });
    actions.build.mockResolvedValueOnce(v2Build(wallet, {
      ledgerIndex: 561,
      quoteLedgerIndex: 561,
      buildId: "post-reconcile-fresh-build",
    }));

    expect((await h.handler(request(signingPreflightBody(prepared)))).status).toBe(503);
    const reconciled = await h.handler(request({ action: "status", operation_id: OPERATION_ID }));
    const refreshed = await h.handler(request({ action: "refresh", operation_id: OPERATION_ID }));

    expect(reconciled.status).toBe(200);
    expect(await reconciled.json()).toMatchObject({ status: "expired_unsubmitted" });
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({ status: "prepared", build_revision: 1 });
    expect(actions.approvalReconcile).toHaveBeenCalledWith(
      "v2-approval-public-id",
      capability,
    );
    expect(h.store.states.get(wallet.classicAddress)).toMatchObject({
      status: "prepared",
      refresh_attempt: 1,
      build_id: "post-reconcile-fresh-build",
    });
    expect(actions.build).toHaveBeenCalledTimes(2);
    expect(actions.execute).toHaveBeenCalledTimes(2);
    expect(actions.relay).not.toHaveBeenCalled();
  });

  it("can burn an authorized but still unsigned approval and rejects every late submit", async () => {
    const wallet = Wallet.generate();
    const actions = v2Harbor(wallet);
    const h = harness({ wallet, harbor: actions, env: V2_READY_ENV });
    const prepared = await (await prepare(h)).json() as Record<string, unknown>;
    const capability = v2Build(wallet).executionCapability;
    actions.refreshPrecheck.mockResolvedValueOnce({ ledgerIndex: 552, sequence: 1, balance: "10" });
    actions.approvalReconcile.mockResolvedValueOnce({
      status: "expired_nonincluded",
      approvalId: "v2-approval-public-id",
      executionId: "v2-execution-public-id",
      validatedLedger: 561,
      firstInclusionLedger: capability.first_inclusion_ledger,
      lastLedgerSequence: capability.last_ledger_sequence,
      nextAction: "request_fresh_build",
    });

    expect((await h.handler(request(signingPreflightBody(prepared)))).status).toBe(200);
    const reconciled = await h.handler(request({ action: "status", operation_id: OPERATION_ID }));
    const lateSubmit = await h.handler(request({
      action: "submit",
      operation_id: OPERATION_ID,
      tx_blob: "ABCD",
    }));

    expect(reconciled.status).toBe(200);
    expect(await reconciled.json()).toMatchObject({ status: "expired_unsubmitted" });
    expect(lateSubmit.status).toBe(409);
    expect((await lateSubmit.json()).error.code).toBe("ACQUISITION_APPROVAL_RECOVERED");
    expect(h.store.states.get(wallet.classicAddress)).toMatchObject({
      status: "expired_unsubmitted",
      approval_preflight_completed_at: NOW.toISOString(),
      approval_reconcile_execution_id: "v2-execution-public-id",
    });
    expect(actions.relay).not.toHaveBeenCalled();
  });

  it("rejects a refresh snapshot that regresses behind Harbor's terminal proof ledger", async () => {
    const wallet = Wallet.generate();
    const actions = v2Harbor(wallet);
    const h = harness({ wallet, harbor: actions, env: V2_READY_ENV });
    const prepared = await (await prepare(h)).json() as Record<string, unknown>;
    const capability = v2Build(wallet).executionCapability;
    actions.refreshPrecheck
      .mockResolvedValueOnce({ ledgerIndex: 552, sequence: 1, balance: "10" })
      .mockResolvedValueOnce({ ledgerIndex: 561, sequence: 1, balance: "10" });
    actions.approvalPreflight.mockRejectedValueOnce(new Error("preflight response lost"));
    actions.approvalReconcile.mockResolvedValueOnce({
      status: "expired_nonincluded",
      approvalId: "v2-approval-public-id",
      executionId: "v2-execution-public-id",
      validatedLedger: 562,
      firstInclusionLedger: capability.first_inclusion_ledger,
      lastLedgerSequence: capability.last_ledger_sequence,
      nextAction: "request_fresh_build",
    });

    expect((await h.handler(request(signingPreflightBody(prepared)))).status).toBe(503);
    expect((await h.handler(request({ action: "status", operation_id: OPERATION_ID }))).status).toBe(200);
    const refresh = await h.handler(request({ action: "refresh", operation_id: OPERATION_ID }));

    expect(refresh.status).toBe(409);
    expect((await refresh.json()).error.code).toBe("REFRESH_NOT_SAFE");
    expect(actions.build).toHaveBeenCalledTimes(1);
    expect(actions.execute).toHaveBeenCalledTimes(1);
    expect(actions.relay).not.toHaveBeenCalled();
  });

  it("persists and reloads the complete atomic recovery proof", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-rlusd-approval-reconcile-"));
    const wallet = Wallet.generate();
    const actions = v2Harbor(wallet);
    const capability = v2Build(wallet).executionCapability;
    const store = new FileAcquisitionStateStore(directory, SECRET);
    const handler = createRlusdAcquisitionHandler({
      env: { ...V2_READY_ENV, P_LIVE_RLUSD_ACQUISITION_STATE_DIR: directory },
      harbor: actions,
      now: () => new Date(NOW),
      randomUUID: () => OPERATION_ID,
      recordTiming: vi.fn(),
      readSession: () => ({
        version: 1,
        account: wallet.classicAddress,
        network: "testnet",
        expiresAt: NOW.getTime() + 60_000,
      }),
      stateStore: store,
    });
    try {
      const prepared = await (await handler(request({ action: "prepare" }))).json() as Record<string, unknown>;
      actions.refreshPrecheck.mockResolvedValueOnce({ ledgerIndex: 552, sequence: 1, balance: "10" });
      actions.approvalPreflight.mockRejectedValueOnce(new Error("preflight response lost"));
      actions.approvalReconcile.mockResolvedValueOnce({
        status: "expired_nonincluded",
        approvalId: "v2-approval-public-id",
        executionId: "v2-execution-public-id",
        validatedLedger: 561,
        firstInclusionLedger: capability.first_inclusion_ledger,
        lastLedgerSequence: capability.last_ledger_sequence,
        nextAction: "request_fresh_build",
      });

      expect((await handler(request(signingPreflightBody(prepared)))).status).toBe(503);
      expect((await handler(request({ action: "status", operation_id: OPERATION_ID }))).status).toBe(200);
      const reloaded = await store.withOwnerLock(wallet.classicAddress, () =>
        store.load(wallet.classicAddress));

      expect(reloaded).toMatchObject({
        status: "expired_unsubmitted",
        approval_preflight_started_at: NOW.toISOString(),
        approval_reconcile_completed_at: NOW.toISOString(),
        approval_reconcile_execution_id: "v2-execution-public-id",
        approval_reconcile_validated_ledger: 561,
        approval_reconcile_first_inclusion_ledger: capability.first_inclusion_ledger,
        approval_reconcile_last_ledger_sequence: capability.last_ledger_sequence,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["APPROVAL_RECOVERY_NOT_READY", 409],
    ["APPROVAL_RECOVERY_STATE_CHANGED", 409],
    ["APPROVAL_RECOVERY_INCOMPLETE", 503],
    ["APPROVAL_RECOVERY_CONFLICT", 409],
  ] as const)("propagates %s and keeps the ambiguous tuple frozen", async (code, status) => {
    const wallet = Wallet.generate();
    const actions = v2Harbor(wallet);
    const h = harness({ wallet, harbor: actions, env: V2_READY_ENV });
    const prepared = await (await prepare(h)).json() as Record<string, unknown>;
    actions.refreshPrecheck.mockResolvedValue({ ledgerIndex: 552, sequence: 1, balance: "10" });
    actions.approvalPreflight.mockRejectedValueOnce(new Error("preflight response lost"));
    actions.approvalReconcile.mockRejectedValueOnce(new HarborOperationError(code, "error"));

    expect((await h.handler(request(signingPreflightBody(prepared)))).status).toBe(503);
    const result = await h.handler(request({ action: "status", operation_id: OPERATION_ID }));

    expect(result.status).toBe(status);
    expect((await result.json()).error.code).toBe(code);
    expect(h.store.states.get(wallet.classicAddress)).toMatchObject({
      status: "prepared",
      approval_preflight_started_at: NOW.toISOString(),
    });
    expect(actions.build).toHaveBeenCalledTimes(1);
    expect(actions.execute).toHaveBeenCalledTimes(1);
    expect(actions.relay).not.toHaveBeenCalled();
  });

  it("rejects partial Harbor recovery evidence and leaves the tuple frozen", async () => {
    const wallet = Wallet.generate();
    const actions = v2Harbor(wallet);
    const h = harness({ wallet, harbor: actions, env: V2_READY_ENV });
    const prepared = await (await prepare(h)).json() as Record<string, unknown>;
    actions.refreshPrecheck.mockResolvedValue({ ledgerIndex: 552, sequence: 1, balance: "10" });
    actions.approvalPreflight.mockRejectedValueOnce(new Error("preflight response lost"));
    actions.approvalReconcile.mockResolvedValueOnce({
      status: "expired_nonincluded",
      approvalId: "v2-approval-public-id",
    } as never);

    expect((await h.handler(request(signingPreflightBody(prepared)))).status).toBe(503);
    const result = await h.handler(request({ action: "status", operation_id: OPERATION_ID }));

    expect(result.status).toBe(502);
    expect((await result.json()).error.code).toBe("INVALID_HARBOR_RECOVERY_PROOF");
    expect(h.store.states.get(wallet.classicAddress)).toMatchObject({
      status: "prepared",
      approval_preflight_started_at: NOW.toISOString(),
    });
    expect(actions.relay).not.toHaveBeenCalled();
  });

  it("does not redispatch preflight after a prior authorization may have succeeded", async () => {
    const wallet = Wallet.generate();
    const actions = v2Harbor(wallet);
    const h = harness({ wallet, harbor: actions, env: V2_READY_ENV });
    const prepared = await (await prepare(h)).json() as Record<string, unknown>;
    actions.refreshPrecheck.mockResolvedValue({ ledgerIndex: 552, sequence: 1, balance: "10" });
    actions.approvalPreflight.mockRejectedValueOnce(
      new Error("response lost after possible atomic preflight"),
    );

    const ambiguous = await h.handler(request(signingPreflightBody(prepared)));
    const repeated = await h.handler(request(signingPreflightBody(prepared)));
    const refresh = await h.handler(request({ action: "refresh", operation_id: OPERATION_ID }));

    expect(ambiguous.status).toBe(503);
    expect(repeated.status).toBe(409);
    expect((await repeated.json()).error.code).toBe("ACQUISITION_PREFLIGHT_OUTCOME_UNKNOWN");
    expect(refresh.status).toBe(409);
    expect(h.store.states.get(wallet.classicAddress)).toMatchObject({
      status: "prepared",
      approval_preflight_started_at: NOW.toISOString(),
    });
    expect(actions.approvalPreflight).toHaveBeenCalledTimes(1);
    expect(actions.build).toHaveBeenCalledTimes(1);
    expect(actions.relay).not.toHaveBeenCalled();
  });

  it("retries the exact recovery tuple after a crash persisting replayed terminal proof", async () => {
    const wallet = Wallet.generate();
    class RecoveryWriteCrashStore extends MemoryStore {
      failRecoveryWrite = true;
      override async save(owner: string, state: AcquisitionState) {
        if (state.approval_reconcile_execution_id && this.failRecoveryWrite) {
          this.failRecoveryWrite = false;
          throw new Error("simulated crash after Harbor burned the tuple");
        }
        await super.save(owner, state);
      }
    }
    const store = new RecoveryWriteCrashStore();
    const actions = v2Harbor(wallet);
    const h = harness({ wallet, store, harbor: actions, env: V2_READY_ENV });
    const prepared = await (await prepare(h)).json() as Record<string, unknown>;
    const capability = v2Build(wallet).executionCapability;
    actions.refreshPrecheck.mockResolvedValue({ ledgerIndex: 552, sequence: 1, balance: "10" });
    actions.approvalPreflight.mockRejectedValueOnce(new Error("preflight response lost"));
    actions.approvalReconcile.mockResolvedValue({
      status: "expired_nonincluded",
      approvalId: "v2-approval-public-id",
      executionId: "v2-execution-public-id",
      validatedLedger: 561,
      firstInclusionLedger: capability.first_inclusion_ledger,
      lastLedgerSequence: capability.last_ledger_sequence,
      nextAction: "request_fresh_build",
    });

    expect((await h.handler(request(signingPreflightBody(prepared)))).status).toBe(503);
    const crashed = await h.handler(request({ action: "status", operation_id: OPERATION_ID }));
    const repeated = await h.handler(request({ action: "status", operation_id: OPERATION_ID }));

    expect(crashed.status).toBe(500);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ status: "expired_unsubmitted" });
    expect(store.states.get(wallet.classicAddress)).toMatchObject({
      status: "expired_unsubmitted",
      approval_preflight_started_at: NOW.toISOString(),
      approval_reconcile_execution_id: "v2-execution-public-id",
    });
    expect(actions.approvalReconcile).toHaveBeenCalledTimes(2);
    expect(actions.approvalReconcile.mock.calls[0]).toEqual(actions.approvalReconcile.mock.calls[1]);
    expect(actions.build).toHaveBeenCalledTimes(1);
    expect(actions.relay).not.toHaveBeenCalled();
  });

  it("freezes v2 refresh once approval preflight starts even when Harbor outcome is unavailable", async () => {
    const wallet = Wallet.generate();
    const actions = v2Harbor(wallet);
    const h = harness({ wallet, harbor: actions, env: V2_READY_ENV });
    const prepared = await (await prepare(h)).json() as Record<string, unknown>;
    actions.refreshPrecheck.mockResolvedValueOnce({ ledgerIndex: 552, sequence: 1, balance: "10" });
    actions.approvalPreflight.mockRejectedValueOnce(new Error("ambiguous preflight response"));

    const preflight = await h.handler(request(signingPreflightBody(prepared)));
    const refresh = await h.handler(request({ action: "refresh", operation_id: OPERATION_ID }));
    const repeatedPreflight = await h.handler(request(signingPreflightBody(prepared)));
    const refreshAfterRepeat = await h.handler(request({ action: "refresh", operation_id: OPERATION_ID }));

    expect(preflight.status).toBe(503);
    expect(refresh.status).toBe(409);
    expect(repeatedPreflight.status).toBe(409);
    expect((await repeatedPreflight.json()).error.code).toBe("ACQUISITION_PREFLIGHT_OUTCOME_UNKNOWN");
    expect(refreshAfterRepeat.status).toBe(409);
    expect(h.store.states.get(wallet.classicAddress)).toMatchObject({
      status: "prepared",
      approval_preflight_started_at: NOW.toISOString(),
    });
    expect(actions.approvalPreflight).toHaveBeenCalledTimes(1);
    expect(actions.build).toHaveBeenCalledTimes(1);
    expect(actions.relay).not.toHaveBeenCalled();
  });

  it("serializes concurrent v2 preflight and freezes refresh after the durable authorization", async () => {
    const wallet = Wallet.generate();
    const actions = v2Harbor(wallet);
    const h = harness({ wallet, harbor: actions, env: V2_READY_ENV });
    const prepared = await (await prepare(h)).json() as Record<string, unknown>;
    actions.refreshPrecheck.mockResolvedValue({ ledgerIndex: 552, sequence: 1, balance: "10" });

    const [first, second] = await Promise.all([
      h.handler(request(signingPreflightBody(prepared))),
      h.handler(request(signingPreflightBody(prepared))),
    ]);
    const refresh = await h.handler(request({ action: "refresh", operation_id: OPERATION_ID }));

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(actions.approvalPreflight).toHaveBeenCalledTimes(1);
    expect(refresh.status).toBe(409);
    expect(actions.build).toHaveBeenCalledTimes(1);
    expect(actions.relay).not.toHaveBeenCalled();
  });

  it("refreshes only an unsigned expired v2 approval to a fresh revision-1 build identity", async () => {
    let now = new Date(NOW);
    const wallet = Wallet.generate();
    const actions = v2Harbor(wallet);
    actions.execute.mockImplementation(async (
      _owner: string,
      _operationId: string,
      requestedBuild: ReturnType<typeof v2Build>,
    ) => ({
      approvalId: `v2-approval-${requestedBuild.buildId}`,
      approvalExpiresAt: new Date(now.getTime() + 90_000).toISOString(),
      transaction: requestedBuild.transaction,
    }));
    const h = harness({ wallet, harbor: actions, env: V2_READY_ENV, now: () => new Date(now) });
    const first = await (await prepare(h)).json() as Record<string, unknown>;
    now = new Date(NOW.getTime() + 91_000);
    actions.refreshPrecheck.mockResolvedValueOnce({ ledgerIndex: 561, sequence: 1, balance: "10" });
    actions.build.mockResolvedValueOnce(v2Build(wallet, {
      ledgerIndex: 561,
      quoteLedgerIndex: 561,
      buildId: "v2-fresh-build-public-id",
      buildRevision: 1,
    }));

    const refreshed = await h.handler(request({ action: "refresh", operation_id: OPERATION_ID }));
    const stale = await h.handler(request(signingPreflightBody(first)));

    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({
      status: "prepared",
      execution_contract: "xrpl_execution_v2",
      build_revision: 1,
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("STALE_ACQUISITION_APPROVAL");
    expect(actions.build).toHaveBeenCalledTimes(2);
    expect(actions.execute).toHaveBeenCalledTimes(2);
    expect(actions.approvalPreflight).not.toHaveBeenCalled();
  });

  it("rejects a v2 unsigned refresh that reuses the expired build identity", async () => {
    let now = new Date(NOW);
    const wallet = Wallet.generate();
    const actions = v2Harbor(wallet);
    const h = harness({ wallet, harbor: actions, env: V2_READY_ENV, now: () => new Date(now) });
    await prepare(h);
    now = new Date(NOW.getTime() + 91_000);
    actions.refreshPrecheck.mockResolvedValueOnce({ ledgerIndex: 561, sequence: 1, balance: "10" });
    actions.build.mockResolvedValueOnce(v2Build(wallet, {
      ledgerIndex: 561,
      quoteLedgerIndex: 561,
      buildId: "v2-build-public-id",
      buildRevision: 1,
    }));

    const refreshed = await h.handler(request({ action: "refresh", operation_id: OPERATION_ID }));

    expect(refreshed.status).toBe(409);
    expect((await refreshed.json()).error.code).toBe("REFRESH_NOT_SAFE");
    expect(h.store.states.get(wallet.classicAddress)?.status).toBe("expired_unsubmitted");
    expect(actions.execute).toHaveBeenCalledTimes(1);
  });

  it("requires durable v2 approval preflight before accepting a signed hash", async () => {
    const wallet = Wallet.generate();
    const actions = v2Harbor(wallet);
    const h = harness({ wallet, harbor: actions, env: V2_READY_ENV });
    await prepare(h);
    const blob = wallet.sign(v2Build(wallet).transaction as never).tx_blob;

    const result = await h.handler(request({
      action: "submit",
      operation_id: OPERATION_ID,
      tx_blob: blob,
    }));

    expect(result.status).toBe(409);
    expect((await result.json()).error.code).toBe("ACQUISITION_PREFLIGHT_REQUIRED");
    expect(h.store.states.get(wallet.classicAddress)).toMatchObject({ status: "prepared" });
    expect(h.store.states.get(wallet.classicAddress)?.hash).toBeUndefined();
    expect(actions.relay).not.toHaveBeenCalled();
  });

  it.each([
    ["seven", 553, 0],
    ["eight", 552, 1],
    ["stale below preflight", 551, 0],
  ] as const)("enforces the v2 first-relay %s-ledger boundary without replay", async (
    _label,
    submissionLedger,
    expectedRelayCalls,
  ) => {
    const wallet = Wallet.generate();
    const actions = v2Harbor(wallet);
    const h = harness({ wallet, harbor: actions, env: V2_READY_ENV });
    const prepared = await (await prepare(h)).json() as Record<string, unknown>;
    actions.refreshPrecheck
      .mockResolvedValueOnce({ ledgerIndex: 552, sequence: 1, balance: "10" })
      .mockResolvedValueOnce({ ledgerIndex: submissionLedger, sequence: 1, balance: "10" });
    expect((await h.handler(request(signingPreflightBody(prepared)))).status).toBe(200);
    const transaction = v2Build(wallet).transaction;
    const blob = wallet.sign(transaction as never).tx_blob;
    const hash = hashes.hashSignedTx(blob).toUpperCase();
    actions.relay.mockResolvedValueOnce({
      hash,
      validated: true,
      ledgerIndex: submissionLedger,
      engineResult: "tesSUCCESS",
    });
    actions.proveCompletion.mockResolvedValueOnce({
      hash,
      ledgerIndex: submissionLedger,
      engineResult: "tesSUCCESS",
      balanceAfter: "85",
      balanceAfterLedgerIndex: submissionLedger,
    });

    const result = await h.handler(request({
      action: "submit",
      operation_id: OPERATION_ID,
      tx_blob: blob,
    }));
    const retry = await h.handler(request({
      action: "submit",
      operation_id: OPERATION_ID,
      tx_blob: blob,
    }));

    expect(actions.relay).toHaveBeenCalledTimes(expectedRelayCalls);
    expect(h.store.states.get(wallet.classicAddress)).toMatchObject({ hash });
    if (expectedRelayCalls === 0) {
      expect(result.status).toBe(202);
      expect(retry.status).toBe(202);
      expect(h.store.states.get(wallet.classicAddress)?.status).toBe("signed_pending");
    } else {
      expect(result.status).toBe(200);
      expect(retry.status).toBe(409);
      expect(actions.relay).toHaveBeenLastCalledWith(
        blob,
        "v2-approval-public-id",
        expect.objectContaining({ execution_contract: "xrpl_execution_v2", build_revision: 1 }),
      );
    }
  });

  it.each([
    ["sequence", { ledgerIndex: 498, sequence: 2, balance: "10" }],
    ["balance", { ledgerIndex: 498, sequence: 1, balance: "11" }],
  ])("blocks signing preflight when the owner %s changed", async (_label, checkpoint) => {
    const h = harness();
    const prepared = await (await prepare(h)).json() as Record<string, unknown>;
    vi.mocked(h.actions.refreshPrecheck).mockResolvedValueOnce(checkpoint);

    const result = await h.handler(request(signingPreflightBody(prepared)));

    expect(result.status).toBe(409);
    expect((await result.json()).error.code).toBe("ACQUISITION_ACCOUNT_CHANGED");
    expect(h.store.states.get(h.wallet.classicAddress)?.status).toBe("prepared");
    expect(h.actions.relay).not.toHaveBeenCalled();
  });

  it.each([
    ["unavailable", new Error("ledger unavailable")],
    ["malformed", { ledgerIndex: 498, sequence: Number.NaN, balance: "10" }],
    ["unvalidated", { ledgerIndex: 0, sequence: 1, balance: "10" }],
  ])("blocks signing preflight when the validated snapshot is %s", async (_label, failure) => {
    const h = harness();
    const prepared = await (await prepare(h)).json() as Record<string, unknown>;
    if (failure instanceof Error) vi.mocked(h.actions.refreshPrecheck).mockRejectedValueOnce(failure);
    else vi.mocked(h.actions.refreshPrecheck).mockResolvedValueOnce(failure);

    const result = await h.handler(request(signingPreflightBody(prepared)));

    expect(result.status).toBe(503);
    expect((await result.json()).error.code).toBe("ACQUISITION_PREFLIGHT_UNAVAILABLE");
    expect(h.store.states.get(h.wallet.classicAddress)?.status).toBe("prepared");
    expect(h.actions.relay).not.toHaveBeenCalled();
  });

  it("blocks signing preflight when the validated snapshot predates the build baseline", async () => {
    const h = harness();
    const prepared = await (await prepare(h)).json() as Record<string, unknown>;
    vi.mocked(h.actions.refreshPrecheck).mockResolvedValueOnce({ ledgerIndex: 495, sequence: 1, balance: "10" });

    const result = await h.handler(request(signingPreflightBody(prepared)));

    expect(result.status).toBe(503);
    expect((await result.json()).error.code).toBe("ACQUISITION_PREFLIGHT_STALE");
    expect(h.store.states.get(h.wallet.classicAddress)?.status).toBe("prepared");
    expect(h.actions.relay).not.toHaveBeenCalled();
  });

  it("binds signing preflight to the exact current build, attempt, and transaction", async () => {
    const h = harness();
    const prepared = await (await prepare(h)).json() as Record<string, unknown>;

    const result = await h.handler(request({
      ...signingPreflightBody(prepared),
      approval_binding: "0".repeat(64),
    }));
    expect(result.status).toBe(409);
    expect((await result.json()).error.code).toBe("STALE_ACQUISITION_APPROVAL");
    expect(h.actions.refreshPrecheck).not.toHaveBeenCalled();
    expect(h.actions.relay).not.toHaveBeenCalled();
  });

  it.each([
    ["ACCOUNT_STATE_CHANGED", 409, "ACQUISITION_ACCOUNT_CHANGED"],
    ["BUILD_EXPIRED", 409, "ACQUISITION_BUILD_EXPIRED"],
    ["QUOTE_LEDGER_MISMATCH", 409, "ACQUISITION_QUOTE_STALE"],
    ["QUOTE_STALE", 409, "ACQUISITION_QUOTE_STALE"],
    ["EXCESS_LEDGER_HORIZON", 502, "UNSAFE_HARBOR_BUILD"],
  ] as const)("maps %s build validation without a generic HTTP 500", async (
    validationCode,
    status,
    responseCode,
  ) => {
    const actions = harbor(Wallet.generate());
    actions.build.mockRejectedValueOnce(new RlusdAcquisitionBuildValidationError(
      validationCode,
      "test validation failure",
    ));
    const h = harness({ harbor: actions });

    const result = await prepare(h);

    expect(result.status).toBe(status);
    expect((await result.json()).error.code).toBe(responseCode);
    expect(h.store.states.get(h.wallet.classicAddress)?.status).toBe("initializing");
    expect(actions.execute).not.toHaveBeenCalled();
  });

  it("requires loopback and a same-origin browser request before any Harbor action", async () => {
    const h = harness();
    const remote = await h.handler(request(
      { action: "prepare" },
      undefined,
      { url: "https://pilot.example/api/dev/rlusd-acquisition" },
    ));
    const crossOrigin = await h.handler(request(
      { action: "prepare" },
      undefined,
      { origin: "http://attacker.example" },
    ));

    expect(remote.status).toBe(403);
    expect((await remote.json()).error.code).toBe("LOOPBACK_REQUIRED");
    expect(crossOrigin.status).toBe(403);
    expect((await crossOrigin.json()).error.code).toBe("SAME_ORIGIN_REQUIRED");
    expect(h.actions.build).not.toHaveBeenCalled();
  });

  it.each<Record<string, string>>([
    { forwarded: "for=127.0.0.1,for=203.0.113.7" },
    { "x-forwarded-host": "127.0.0.1:3003,pilot.example" },
    { "x-forwarded-proto": "http,https" },
    { "x-forwarded-port": "3003,443" },
  ])("rejects ambiguous local forwarding metadata before Harbor access: %o", async (headers) => {
    const h = harness();
    const result = await h.handler(request(
      { action: "prepare" },
      sessionCookie(h.wallet),
      { headers },
    ));
    expect(result.status).toBe(403);
    expect((await result.json()).error.code).toBe("LOOPBACK_REQUIRED");
    expect(h.actions.build).not.toHaveBeenCalled();
  });

  it.each([
    ["HARBOR_MOCK", "1"],
    ["EXEC_NETWORK", "devnet"],
    ["NEXT_PUBLIC_DEV_SIGNER", "0"],
    ["P_LIVE_HARBOR_FOK_DEPLOYED", "0"],
    ["P_LIVE_HARBOR_OWNER_APPROVAL_DEPLOYED", "0"],
    ["P_LIVE_HARBOR_EXECUTION_V2", "true"],
    ["HARBOR_URL", undefined],
    ["HARBOR_API_KEY", undefined],
    ["SESSION_SECRET", "too-short"],
  ])("fails closed when %s is not ready", async (key, value) => {
    const h = harness({ env: { ...READY_ENV, [key]: value } });
    const result = await prepare(h);
    expect(result.status).toBe(503);
    expect((await result.json()).error.code).toBe("ACQUISITION_DISABLED");
    expect(h.actions.build).not.toHaveBeenCalled();
  });

  it.each([
    "https://harbor.example",
    "http://localhost:8791",
    "http://[::1]:8791",
    "https://127.0.0.1:8791",
    "http://127.0.0.1:8787",
    "http://127.0.0.1:8792",
    "ftp://127.0.0.1:8791",
    "http://user:password@127.0.0.1:8791",
    "http://127.0.0.1:8791/api",
    "http://127.0.0.1:8791?api_key=bad",
    "http://127.0.0.1:8791/#fragment",
    "not a URL",
  ])("rejects any Harbor URL except the reviewed local origin %s before Harbor use", async (harborUrl) => {
    const h = harness({ env: { ...READY_ENV, HARBOR_URL: harborUrl } });
    const result = await prepare(h);
    expect(result.status).toBe(503);
    expect((await result.json()).error.code).toBe("ACQUISITION_DISABLED");
    expect(h.actions.build).not.toHaveBeenCalled();
  });

  it("accepts only the reviewed local Harbor origin", async () => {
    const h = harness();
    expect((await prepare(h)).status).toBe(200);
    expect(h.actions.build).toHaveBeenCalledTimes(1);
  });

  it("accepts only the exact isolated profile tuple before acquisition build", async () => {
    const accepted = harness({ env: ISOLATED_READY_ENV });
    const acceptedResult = await accepted.handler(request(
      { action: "prepare" },
      undefined,
      { url: "http://127.0.0.2:3003/api/dev/rlusd-acquisition" },
    ));
    expect(acceptedResult.status).toBe(200);
    expect(accepted.actions.build).toHaveBeenCalledTimes(1);

    const crossed = harness({ env: ISOLATED_READY_ENV });
    const crossedResult = await prepare(crossed);
    expect(crossedResult.status).toBe(403);
    expect((await crossedResult.json()).error.code).toBe("LOOPBACK_REQUIRED");
    expect(crossed.actions.build).not.toHaveBeenCalled();

    const wrongHarbor = harness({
      env: { ...ISOLATED_READY_ENV, HARBOR_URL: "http://127.0.0.1:8791" },
    });
    const wrongHarborResult = await wrongHarbor.handler(request(
      { action: "prepare" },
      undefined,
      { url: "http://127.0.0.2:3003/api/dev/rlusd-acquisition" },
    ));
    expect(wrongHarborResult.status).toBe(503);
    expect(wrongHarbor.actions.build).not.toHaveBeenCalled();
  });

  it("initializes one durable server-owned operation without calling Harbor", async () => {
    const h = harness();
    const first = await h.handler(request({ action: "initialize" }));
    const second = await h.handler(request({ action: "initialize" }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toMatchObject({
      operation_id: OPERATION_ID,
      owner: h.wallet.classicAddress,
      network: "testnet",
      status: "initializing",
    });
    expect(await second.json()).toMatchObject({ operation_id: OPERATION_ID, status: "initializing" });
    expect(h.store.events).toEqual(["save:initializing"]);
    expect(h.actions.build).not.toHaveBeenCalled();
    expect(h.actions.execute).not.toHaveBeenCalled();
  });

  it("requires a preexisting configured state store", async () => {
    const store = new MemoryStore();
    store.ready = false;
    const h = harness({ store });
    const result = await prepare(h);
    expect(result.status).toBe(503);
    expect((await result.json()).error.code).toBe("STATE_STORE_NOT_READY");
    expect(h.actions.build).not.toHaveBeenCalled();
  });

  it("does not create a missing configured state directory", async () => {
    const wallet = Wallet.generate();
    const actions = harbor(wallet);
    const handler = createRlusdAcquisitionHandler({
      env: {
        ...READY_ENV,
        P_LIVE_RLUSD_ACQUISITION_STATE_DIR:
          `/tmp/pilot-rlusd-acquisition-intentionally-missing-${process.pid}`,
      },
      harbor: actions,
      now: () => new Date(NOW),
      randomUUID: () => OPERATION_ID,
      readSession: () => ({
        version: 1,
        account: wallet.classicAddress,
        network: "testnet",
        expiresAt: Date.now() + 60_000,
      }),
    });

    const result = await handler(request({ action: "prepare" }));
    expect(result.status).toBe(503);
    expect((await result.json()).error.code).toBe("STATE_STORE_NOT_READY");
    expect(actions.build).not.toHaveBeenCalled();
  });

  it("rejects a state directory accessible by group or world", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-rlusd-open-state-"));
    const wallet = Wallet.generate();
    const actions = harbor(wallet);
    try {
      await chmod(directory, 0o755);
      const handler = createRlusdAcquisitionHandler({
        env: { ...READY_ENV, P_LIVE_RLUSD_ACQUISITION_STATE_DIR: directory },
        harbor: actions,
        readSession: () => ({
          version: 1,
          account: wallet.classicAddress,
          network: "testnet",
          expiresAt: Date.now() + 60_000,
        }),
      });
      const result = await handler(request({ action: "prepare" }));
      expect(result.status).toBe(503);
      expect((await result.json()).error.code).toBe("STATE_STORE_NOT_READY");
      expect(actions.build).not.toHaveBeenCalled();
    } finally {
      await chmod(directory, 0o700);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a configured state-directory symbolic link", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-rlusd-real-state-"));
    const link = `${directory}-link`;
    const wallet = Wallet.generate();
    const actions = harbor(wallet);
    try {
      await symlink(directory, link, "dir");
      const handler = createRlusdAcquisitionHandler({
        env: { ...READY_ENV, P_LIVE_RLUSD_ACQUISITION_STATE_DIR: link },
        harbor: actions,
        readSession: () => ({
          version: 1,
          account: wallet.classicAddress,
          network: "testnet",
          expiresAt: Date.now() + 60_000,
        }),
      });
      const result = await handler(request({ action: "prepare" }));
      expect(result.status).toBe(503);
      expect((await result.json()).error.code).toBe("STATE_STORE_NOT_READY");
      expect(actions.build).not.toHaveBeenCalled();
    } finally {
      await unlink(link).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps legacy and isolated acquisition envelopes mutually unreadable with reused state and secret", async () => {
    const legacyDirectory = await mkdtemp(join(tmpdir(), "pilot-rlusd-profile-legacy-"));
    const isolatedDirectory = await mkdtemp(join(tmpdir(), "pilot-rlusd-profile-isolated-"));
    const migrationDirectory = await mkdtemp(join(tmpdir(), "pilot-rlusd-profile-migration-"));
    const wallet = Wallet.generate();
    const state = initializingState(wallet);
    const isolatedRuntime = { deploymentProfile: "local-wallet-isolated-v1" as const };
    const save = async (store: FileAcquisitionStateStore) => store.withOwnerLock(
      wallet.classicAddress,
      () => store.save(wallet.classicAddress, state),
    );
    const load = async (store: FileAcquisitionStateStore) => store.withOwnerLock(
      wallet.classicAddress,
      () => store.load(wallet.classicAddress),
    );
    try {
      const legacy = new FileAcquisitionStateStore(legacyDirectory, SECRET);
      await save(legacy);
      expect(await load(new FileAcquisitionStateStore(legacyDirectory, SECRET))).toEqual(state);
      await expect(load(new FileAcquisitionStateStore(
        legacyDirectory,
        SECRET,
        isolatedRuntime,
      ))).rejects.toThrow();

      const isolated = new FileAcquisitionStateStore(
        isolatedDirectory,
        SECRET,
        isolatedRuntime,
      );
      await save(isolated);
      expect(await load(new FileAcquisitionStateStore(
        isolatedDirectory,
        SECRET,
        isolatedRuntime,
      ))).toEqual(state);
      await expect(load(new FileAcquisitionStateStore(
        isolatedDirectory,
        SECRET,
      ))).rejects.toThrow();

      const stateName = `${createHash("sha256")
        .update(`testnet:${wallet.classicAddress}`, "utf8").digest("hex")}.json`;
      const legacyTail = await readLockTail(join(legacyDirectory, `${stateName}.lock`));
      const isolatedTail = await readLockTail(join(isolatedDirectory, `${stateName}.lock`));
      expect(legacyTail.record.state)
        .toMatchObject({ version: 1, state });
      expect(isolatedTail.record.state)
        .toMatchObject({
          version: 2,
          deployment_profile: "local-wallet-isolated-v1",
          state,
        });

      // Preserve the original standalone v1 recovery path only for legacy.
      await writeFile(
        join(migrationDirectory, stateName),
        `${JSON.stringify(legacyTail.record.state)}\n`,
        { mode: 0o600 },
      );
      expect(await load(new FileAcquisitionStateStore(
        migrationDirectory,
        SECRET,
      ))).toEqual(state);
      await expect(load(new FileAcquisitionStateStore(
        migrationDirectory,
        SECRET,
        isolatedRuntime,
      ))).rejects.toThrow();
    } finally {
      await rm(legacyDirectory, { recursive: true, force: true });
      await rm(isolatedDirectory, { recursive: true, force: true });
      await rm(migrationDirectory, { recursive: true, force: true });
    }
  });

  it("rejects missing and malformed isolated acquisition envelope tags", async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), "pilot-rlusd-profile-source-"));
    const targetDirectory = await mkdtemp(join(tmpdir(), "pilot-rlusd-profile-target-"));
    const wallet = Wallet.generate();
    const runtime = { deploymentProfile: "local-wallet-isolated-v1" as const };
    const stateName = `${createHash("sha256")
      .update(`testnet:${wallet.classicAddress}`, "utf8").digest("hex")}.json`;
    try {
      const source = new FileAcquisitionStateStore(sourceDirectory, SECRET, runtime);
      await source.withOwnerLock(wallet.classicAddress, () =>
        source.save(wallet.classicAddress, initializingState(wallet)));
      const sourceTail = await readLockTail(join(sourceDirectory, `${stateName}.lock`));
      const envelope = sourceTail.record.state as Record<string, unknown>;

      for (const mutation of [
        { ...envelope, deployment_profile: undefined },
        { ...envelope, deployment_profile: "wrong-isolated-profile" },
        { ...envelope, version: 1 },
      ]) {
        await writeFile(join(targetDirectory, stateName), `${JSON.stringify(mutation)}\n`, {
          mode: 0o600,
        });
        const target = new FileAcquisitionStateStore(targetDirectory, SECRET, runtime);
        await expect(target.withOwnerLock(wallet.classicAddress, () =>
          target.load(wallet.classicAddress))).rejects.toThrow("integrity is missing");
        await unlink(join(targetDirectory, stateName));
      }
    } finally {
      await rm(sourceDirectory, { recursive: true, force: true });
      await rm(targetDirectory, { recursive: true, force: true });
    }
  });

  it("derives the owner and testnet from the sealed wallet session", async () => {
    const wallet = Wallet.generate();
    const store = new MemoryStore();
    const actions = harbor(wallet, store.events);
    const handler = createRlusdAcquisitionHandler({
      env: READY_ENV,
      harbor: actions,
      now: () => new Date(NOW),
      randomUUID: () => OPERATION_ID,
      stateStore: store,
    });

    const result = await handler(request({ action: "prepare" }, sessionCookie(wallet)));
    expect(result.status).toBe(200);
    expect(actions.build).toHaveBeenCalledWith(wallet.classicAddress, OPERATION_ID, "xrpl_execution_v1");
    expect(await result.json()).toMatchObject({
      operation_id: OPERATION_ID,
      owner: wallet.classicAddress,
      network: "testnet",
      status: "prepared",
    });

    const selected = await handler(request(
      { action: "prepare", owner: Wallet.generate().classicAddress, network: "testnet" },
      sessionCookie(wallet),
    ));
    expect(selected.status).toBe(400);
  });

  it("rejects a missing or devnet wallet session", async () => {
    const wallet = Wallet.generate();
    const missing = harness({ readSession: () => null });
    expect((await prepare(missing)).status).toBe(401);

    const devnet = harness({
      wallet,
      readSession: () => ({
        version: 1,
        account: wallet.classicAddress,
        network: "devnet",
        expiresAt: NOW.getTime() + 60_000,
      }),
    });
    expect((await prepare(devnet)).status).toBe(401);
  });

  it("uses one durable per-owner identity and does not prepare twice", async () => {
    const h = harness();
    const first = await prepare(h);
    const second = await prepare(h);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(h.actions.build).toHaveBeenCalledTimes(1);
    expect(h.actions.execute).toHaveBeenCalledTimes(1);
    expect((await first.json()).operation_id).toBe(OPERATION_ID);
    expect((await second.json()).operation_id).toBe(OPERATION_ID);
    expect(h.store.events.slice(0, 3)).toEqual(["save:initializing", "save:built", "save:prepared"]);
  });

  it("resumes a durable initializing state with the same operation identity", async () => {
    const wallet = Wallet.generate();
    const store = new MemoryStore();
    store.states.set(wallet.classicAddress, {
      version: 1,
      operation_id: OPERATION_ID,
      owner: wallet.classicAddress,
      network: "testnet",
      status: "initializing",
      intent_id: `p-live-acquire-rlusd-${OPERATION_ID}`,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    });
    const actions = harbor(wallet, store.events);
    const h = harness({ wallet, store, harbor: actions });

    const result = await prepare(h);
    expect(result.status).toBe(200);
    expect((await result.json()).operation_id).toBe(OPERATION_ID);
    expect(actions.build).toHaveBeenCalledWith(wallet.classicAddress, OPERATION_ID, "xrpl_execution_v1");
    expect(actions.execute).toHaveBeenCalledTimes(1);
    expect(store.states.get(wallet.classicAddress)?.status).toBe("prepared");
    expect(store.events).toEqual(["save:built", "save:prepared"]);
  });

  it("replays execute for the same durable build after a crash before the prepared-state write", async () => {
    const wallet = Wallet.generate();
    class CrashBoundaryStore extends MemoryStore {
      failPreparedWrite = true;
      override async save(owner: string, state: AcquisitionState) {
        if (state.status === "prepared" && this.failPreparedWrite) {
          this.failPreparedWrite = false;
          throw new Error("simulated process death before durable prepared state");
        }
        await super.save(owner, state);
      }
    }
    const store = new CrashBoundaryStore();
    const actions = harbor(wallet, store.events);
    let executionBinding: string | undefined;
    actions.execute.mockImplementation(async (
      _owner: string,
      operationId: string,
      built: { buildId: string; transaction: Record<string, unknown> },
    ) => {
      const binding = `${operationId}:${built.buildId}`;
      if (executionBinding && executionBinding !== binding) {
        throw new Error("same idempotency key was reused for a different build");
      }
      executionBinding = binding;
      return {
        approvalId: "approval-public-id",
        approvalExpiresAt: "2026-10-19T12:10:00.000Z",
        transaction: built.transaction,
      };
    });
    const h = harness({ wallet, store, harbor: actions });

    const interrupted = await prepare(h);
    expect(interrupted.status).toBe(500);
    expect(store.states.get(wallet.classicAddress)?.status).toBe("built");

    const resumed = await prepare(h);
    expect(resumed.status).toBe(200);
    expect((await resumed.json()).operation_id).toBe(OPERATION_ID);
    expect(actions.build).toHaveBeenCalledTimes(1);
    expect(actions.execute).toHaveBeenCalledTimes(2);
    expect(actions.execute.mock.calls[0]?.[1]).toBe(OPERATION_ID);
    expect(actions.execute.mock.calls[1]?.[1]).toBe(OPERATION_ID);
    expect(actions.execute.mock.calls[0]?.[2].buildId).toBe("build-public-id");
    expect(actions.execute.mock.calls[1]?.[2].buildId).toBe("build-public-id");
    expect(store.states.get(wallet.classicAddress)?.status).toBe("prepared");
  });

  it("serializes concurrent prepare attempts without duplicate Harbor work", async () => {
    const wallet = Wallet.generate();
    const store = new MemoryStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const actions = harbor(wallet, store.events);
    const build = actions.build.getMockImplementation()!;
    actions.build.mockImplementationOnce(async (...args: [string, string, "xrpl_execution_v1"]) => {
      await gate;
      return build(...args);
    });
    const h = harness({ wallet, store, harbor: actions });
    const first = prepare(h);
    await vi.waitFor(() => expect(actions.build).toHaveBeenCalledTimes(1));
    const concurrent = prepare(h);
    release();
    expect((await first).status).toBe(200);
    expect((await concurrent).status).toBe(200);
    expect(actions.build).toHaveBeenCalledTimes(1);
    expect(actions.execute).toHaveBeenCalledTimes(1);
  });

  it("recovers a dead-process lock only after its bounded lease expires", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-rlusd-dead-lock-"));
    const wallet = Wallet.generate();
    const actions = harbor(wallet);
    const stateName = `${createHash("sha256")
      .update(`testnet:${wallet.classicAddress}`, "utf8").digest("hex")}.json`;
    const lockPath = join(directory, `${stateName}.lock`);
    const deadPid = 2_147_483_647;
    const lock = (expiresAt: number) => ({
      version: 3,
      released: false,
      pid: deadPid,
      process_instance_id: "31234567-89ab-4cde-8f01-23456789abcd",
      token: "11234567-89ab-4cde-8f01-23456789abcd",
      acquired_at: expiresAt - 30_000,
      heartbeat_at: expiresAt - 30_000,
      lease_expires_at: expiresAt,
    });
    const handler = createRlusdAcquisitionHandler({
      env: { ...READY_ENV, P_LIVE_RLUSD_ACQUISITION_STATE_DIR: directory },
      harbor: actions,
      now: () => new Date(NOW),
      randomUUID: () => OPERATION_ID,
      readSession: () => ({
        version: 1,
        account: wallet.classicAddress,
        network: "testnet",
        expiresAt: Date.now() + 60_000,
      }),
    });
    try {
      await writeFile(lockPath, `${JSON.stringify(lock(Date.now() + 60_000))}\n`, { mode: 0o600 });
      const leased = await handler(request({ action: "prepare" }));
      expect(leased.status).toBe(409);
      expect(actions.build).not.toHaveBeenCalled();

      await writeFile(lockPath, `${JSON.stringify(lock(Date.now() - 1))}\n`, { mode: 0o600 });
      const recovered = await handler(request({ action: "prepare" }));
      expect(recovered.status).toBe(200);
      expect(actions.build).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("never steals an expired lock from a live process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-rlusd-live-lock-"));
    const wallet = Wallet.generate();
    const actions = harbor(wallet);
    const stateName = `${createHash("sha256")
      .update(`testnet:${wallet.classicAddress}`, "utf8").digest("hex")}.json`;
    const lockPath = join(directory, `${stateName}.lock`);
    const acquiredAt = Date.now() - 60_000;
    const liveInstance = "41234567-89ab-4cde-8f01-23456789abcd";
    await writeFile(lockPath, `${JSON.stringify({
      version: 3,
      released: false,
      pid: process.pid,
      process_instance_id: liveInstance,
      token: "21234567-89ab-4cde-8f01-23456789abcd",
      acquired_at: acquiredAt,
      heartbeat_at: acquiredAt,
      lease_expires_at: acquiredAt + 30_000,
    })}\n`, { mode: 0o600 });
    const stateStore = new FileAcquisitionStateStore(directory, SECRET, {
      pid: process.pid,
      processInstanceId: liveInstance,
    });
    const handler = createRlusdAcquisitionHandler({
      env: { ...READY_ENV, P_LIVE_RLUSD_ACQUISITION_STATE_DIR: directory },
      harbor: actions,
      stateStore,
      readSession: () => ({
        version: 1,
        account: wallet.classicAddress,
        network: "testnet",
        expiresAt: Date.now() + 60_000,
      }),
    });
    try {
      const result = await handler(request({ action: "prepare" }));
      expect(result.status).toBe(409);
      expect((await result.json()).error.code).toBe("OPERATION_IN_PROGRESS");
      expect(actions.build).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(lockPath, "utf8")).pid).toBe(process.pid);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers an expired lock after restart even when the numeric PID is reused", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-rlusd-reused-pid-lock-"));
    const wallet = Wallet.generate();
    const actions = harbor(wallet);
    const stateName = `${createHash("sha256")
      .update(`testnet:${wallet.classicAddress}`, "utf8").digest("hex")}.json`;
    const lockPath = join(directory, `${stateName}.lock`);
    const expiredAt = Date.now() - 1;
    await writeFile(lockPath, `${JSON.stringify({
      version: 3,
      released: false,
      pid: process.pid,
      process_instance_id: "51234567-89ab-4cde-8f01-23456789abcd",
      token: "61234567-89ab-4cde-8f01-23456789abcd",
      acquired_at: expiredAt - 30_000,
      heartbeat_at: expiredAt - 30_000,
      lease_expires_at: expiredAt,
    })}\n`, { mode: 0o600 });
    const stateStore = new FileAcquisitionStateStore(directory, SECRET, {
      pid: process.pid,
      processInstanceId: "71234567-89ab-4cde-8f01-23456789abcd",
    });
    const handler = createRlusdAcquisitionHandler({
      env: { ...READY_ENV, P_LIVE_RLUSD_ACQUISITION_STATE_DIR: directory },
      harbor: actions,
      stateStore,
      now: () => new Date(NOW),
      randomUUID: () => OPERATION_ID,
      readSession: () => ({
        version: 1,
        account: wallet.classicAddress,
        network: "testnet",
        expiresAt: Date.now() + 60_000,
      }),
    });
    try {
      const result = await handler(request({ action: "prepare" }));
      expect(result.status).toBe(200);
      expect(actions.build).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers an expired foreign lock even when its numeric PID belongs to an unrelated live process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-rlusd-foreign-reused-pid-"));
    const wallet = Wallet.generate();
    const stateName = `${createHash("sha256")
      .update(`testnet:${wallet.classicAddress}`, "utf8").digest("hex")}.json`;
    const lockPath = join(directory, `${stateName}.lock`);
    const expiredAt = Date.now() - 1;
    await writeFile(lockPath, `${JSON.stringify({
      version: 3,
      released: false,
      pid: 1,
      process_instance_id: "91234567-89ab-4cde-8f01-23456789abcd",
      token: "a1234567-89ab-4cde-8f01-23456789abcd",
      acquired_at: expiredAt - 30_000,
      heartbeat_at: expiredAt - 30_000,
      lease_expires_at: expiredAt,
    })}\n`, { mode: 0o600 });
    const store = new FileAcquisitionStateStore(directory, SECRET, {
      pid: process.pid,
      processInstanceId: "b1234567-89ab-4cde-8f01-23456789abcd",
    });
    try {
      await expect(store.withOwnerLock(wallet.classicAddress, async () => "claimed"))
        .resolves.toBe("claimed");
      expect(JSON.parse(await readFile(lockPath, "utf8")).token)
        .toBe("a1234567-89ab-4cde-8f01-23456789abcd");
      expect((await readdir(directory)).some((entry) => entry.includes(".next-"))).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("renews an active process-instance lease while rejecting a concurrent owner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-rlusd-renew-lock-"));
    const wallet = Wallet.generate();
    const stateName = `${createHash("sha256")
      .update(`testnet:${wallet.classicAddress}`, "utf8").digest("hex")}.json`;
    const lockPath = join(directory, `${stateName}.lock`);
    const store = new FileAcquisitionStateStore(directory, SECRET, {
      pid: process.pid,
      processInstanceId: "81234567-89ab-4cde-8f01-23456789abcd",
      leaseMs: 60,
      heartbeatMs: 10,
    });
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { acquired = resolve; });
    let owner: Promise<void> | undefined;
    try {
      owner = store.withOwnerLock(wallet.classicAddress, async () => {
        acquired();
        await gate;
      });
      await locked;
      const initial = JSON.parse(await readFile(lockPath, "utf8"));
      let renewed!: Record<string, unknown>;
      await vi.waitFor(async () => {
        renewed = JSON.parse(await readFile(`${lockPath}.next-${initial.token}`, "utf8"));
        expect(renewed.token).not.toBe(initial.token);
      });
      expect(renewed.process_instance_id).toBe(initial.process_instance_id);
      expect(renewed.heartbeat_at).toBeGreaterThan(initial.heartbeat_at);
      expect(renewed.lease_expires_at).toBeGreaterThan(initial.lease_expires_at);
      await expect(store.withOwnerLock(wallet.classicAddress, async () => undefined))
        .rejects.toMatchObject({ code: "OPERATION_IN_PROGRESS" });
      release();
      await owner;
    } finally {
      release?.();
      await owner?.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses one atomic successor when stale contenders read the same expired owner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-rlusd-stale-cas-"));
    const wallet = Wallet.generate();
    const stateName = `${createHash("sha256")
      .update(`testnet:${wallet.classicAddress}`, "utf8").digest("hex")}.json`;
    const lockPath = join(directory, `${stateName}.lock`);
    const staleToken = "c1234567-89ab-4cde-8f01-23456789abcd";
    await writeFile(lockPath, `${JSON.stringify({
      version: 3,
      released: false,
      pid: 111,
      process_instance_id: "d1234567-89ab-4cde-8f01-23456789abcd",
      token: staleToken,
      acquired_at: 1_000,
      heartbeat_at: 1_000,
      lease_expires_at: 1_100,
    })}\n`, { mode: 0o600 });
    let releaseFirstPublish!: () => void;
    let releaseSecondPublish!: () => void;
    let firstObserved!: () => void;
    let secondObserved!: () => void;
    let releaseCallback!: () => void;
    const firstPublishGate = new Promise<void>((resolve) => { releaseFirstPublish = resolve; });
    const secondPublishGate = new Promise<void>((resolve) => { releaseSecondPublish = resolve; });
    const firstRead = new Promise<void>((resolve) => { firstObserved = resolve; });
    const secondRead = new Promise<void>((resolve) => { secondObserved = resolve; });
    const callbackGate = new Promise<void>((resolve) => { releaseCallback = resolve; });
    let active = 0;
    let maxActive = 0;
    const first = new FileAcquisitionStateStore(directory, SECRET, {
      pid: 201,
      processInstanceId: "e1234567-89ab-4cde-8f01-23456789abcd",
      now: () => 2_000,
      beforePublish: async (kind, predecessor) => {
        if (kind === "acquire" && predecessor === staleToken) {
          firstObserved();
          await firstPublishGate;
        }
      },
    });
    const second = new FileAcquisitionStateStore(directory, SECRET, {
      pid: 202,
      processInstanceId: "f1234567-89ab-4cde-8f01-23456789abcd",
      now: () => 2_000,
      beforePublish: async (kind, predecessor) => {
        if (kind === "acquire" && predecessor === staleToken) {
          secondObserved();
          await secondPublishGate;
        }
      },
    });
    let firstOwner: Promise<void> | undefined;
    try {
      firstOwner = first.withOwnerLock(wallet.classicAddress, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await callbackGate;
        active -= 1;
      });
      await firstRead;
      const delayed = second.withOwnerLock(wallet.classicAddress, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        active -= 1;
      });
      await secondRead;
      releaseFirstPublish();
      await vi.waitFor(() => expect(active).toBe(1));
      const successorPath = `${lockPath}.next-${staleToken}`;
      const fresh = JSON.parse(await readFile(successorPath, "utf8"));
      releaseSecondPublish();
      await expect(delayed).rejects.toMatchObject({ code: "OPERATION_IN_PROGRESS" });
      expect(JSON.parse(await readFile(successorPath, "utf8")).token).toBe(fresh.token);
      expect(maxActive).toBe(1);
      releaseCallback();
      await firstOwner;
    } finally {
      releaseFirstPublish?.();
      releaseSecondPublish?.();
      releaseCallback?.();
      await firstOwner?.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a detached stale acquire that links after its predecessor was compacted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-rlusd-acquire-aba-"));
    const wallet = Wallet.generate();
    let staleObserved!: () => void;
    let resumeStale!: () => void;
    let canonicalEntered!: () => void;
    let releaseCanonical!: () => void;
    const atStalePublish = new Promise<void>((resolve) => { staleObserved = resolve; });
    const staleGate = new Promise<void>((resolve) => { resumeStale = resolve; });
    const atCanonical = new Promise<void>((resolve) => { canonicalEntered = resolve; });
    const canonicalGate = new Promise<void>((resolve) => { releaseCanonical = resolve; });
    let pauseOnce = true;
    let active = 0;
    let maxActive = 0;
    const seed = new FileAcquisitionStateStore(directory, SECRET, {
      processInstanceId: "11234567-89ab-4cde-8f01-23456789abcd",
      compactAfterGenerations: 4,
    });
    const stale = new FileAcquisitionStateStore(directory, SECRET, {
      processInstanceId: "21234567-89ab-4cde-8f01-23456789abcd",
      compactAfterGenerations: 4,
      beforePublish: async (kind) => {
        if (kind === "acquire" && pauseOnce) {
          pauseOnce = false;
          staleObserved();
          await staleGate;
        }
      },
    });
    const winner = new FileAcquisitionStateStore(directory, SECRET, {
      processInstanceId: "31234567-89ab-4cde-8f01-23456789abcd",
      compactAfterGenerations: 4,
    });
    const canonical = new FileAcquisitionStateStore(directory, SECRET, {
      processInstanceId: "41234567-89ab-4cde-8f01-23456789abcd",
      compactAfterGenerations: 4,
    });
    let staleOwner: Promise<void> | undefined;
    let canonicalOwner: Promise<void> | undefined;
    try {
      await seed.withOwnerLock(wallet.classicAddress, async () => undefined);
      staleOwner = stale.withOwnerLock(wallet.classicAddress, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        active -= 1;
      });
      await atStalePublish;

      await winner.withOwnerLock(wallet.classicAddress, async () => undefined);
      canonicalOwner = canonical.withOwnerLock(wallet.classicAddress, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        canonicalEntered();
        await canonicalGate;
        active -= 1;
      });
      await atCanonical;
      resumeStale();
      await expect(staleOwner).rejects.toMatchObject({ code: "OPERATION_IN_PROGRESS" });
      expect(active).toBe(1);
      expect(maxActive).toBe(1);
      releaseCanonical();
      await canonicalOwner;
    } finally {
      resumeStale?.();
      releaseCanonical?.();
      await staleOwner?.catch(() => undefined);
      await canonicalOwner?.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("cannot let a delayed heartbeat overwrite a replacement generation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-rlusd-renew-cas-"));
    const wallet = Wallet.generate();
    const stateName = `${createHash("sha256")
      .update(`testnet:${wallet.classicAddress}`, "utf8").digest("hex")}.json`;
    const lockPath = join(directory, `${stateName}.lock`);
    let clock = 1_000;
    let renewObserved!: () => void;
    let releaseRenewal!: () => void;
    let callbackEntered!: () => void;
    let releaseCallback!: () => void;
    const renewalRead = new Promise<void>((resolve) => { renewObserved = resolve; });
    const renewalGate = new Promise<void>((resolve) => { releaseRenewal = resolve; });
    const entered = new Promise<void>((resolve) => { callbackEntered = resolve; });
    const callbackGate = new Promise<void>((resolve) => { releaseCallback = resolve; });
    let blockRenewal = true;
    const original = new FileAcquisitionStateStore(directory, SECRET, {
      pid: 301,
      processInstanceId: "11234567-89ab-4cde-8f01-23456789abcd",
      leaseMs: 60,
      heartbeatMs: 10,
      now: () => clock,
      beforePublish: async (kind) => {
        if (kind === "renew" && blockRenewal) {
          blockRenewal = false;
          renewObserved();
          await renewalGate;
        }
      },
    });
    let originalOwner: Promise<void> | undefined;
    try {
      originalOwner = original.withOwnerLock(wallet.classicAddress, async () => {
        callbackEntered();
        await callbackGate;
      });
      await entered;
      const root = JSON.parse(await readFile(lockPath, "utf8"));
      await renewalRead;
      clock = 2_000;
      const replacement = new FileAcquisitionStateStore(directory, SECRET, {
        pid: 302,
        processInstanceId: "21234567-89ab-4cde-8f01-23456789abcd",
        leaseMs: 60,
        heartbeatMs: 10,
        now: () => clock,
      });
      await replacement.withOwnerLock(wallet.classicAddress, async () => undefined);
      const successorPath = `${lockPath}.next-${root.token}`;
      const replacementGeneration = JSON.parse(await readFile(successorPath, "utf8"));
      releaseRenewal();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(JSON.parse(await readFile(successorPath, "utf8")).token)
        .toBe(replacementGeneration.token);
      releaseCallback();
      await expect(originalOwner).rejects.toThrow(/ownership changed/i);
    } finally {
      releaseRenewal?.();
      releaseCallback?.();
      await originalOwner?.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fences an ordinary renewal that links after takeover compacts its predecessor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-rlusd-renew-aba-"));
    const wallet = Wallet.generate();
    let clock = 1_000;
    let renewalPaused!: () => void;
    let resumeRenewal!: () => void;
    let ownerEntered!: () => void;
    let releaseOwner!: () => void;
    const atRenewal = new Promise<void>((resolve) => { renewalPaused = resolve; });
    const renewalGate = new Promise<void>((resolve) => { resumeRenewal = resolve; });
    const atOwner = new Promise<void>((resolve) => { ownerEntered = resolve; });
    const ownerGate = new Promise<void>((resolve) => { releaseOwner = resolve; });
    const seed = new FileAcquisitionStateStore(directory, SECRET, {
      processInstanceId: "d1234567-89ab-4cde-8f01-23456789abcd",
      compactAfterGenerations: 5,
      now: () => clock,
    });
    let pauseOnce = true;
    const original = new FileAcquisitionStateStore(directory, SECRET, {
      processInstanceId: "e1234567-89ab-4cde-8f01-23456789abcd",
      leaseMs: 60,
      heartbeatMs: 10,
      compactAfterGenerations: 5,
      now: () => clock,
      beforePublish: async (kind) => {
        if (kind === "renew" && pauseOnce) {
          pauseOnce = false;
          renewalPaused();
          await renewalGate;
        }
      },
    });
    let held: Promise<void> | undefined;
    try {
      await seed.withOwnerLock(wallet.classicAddress, async () => undefined);
      held = original.withOwnerLock(wallet.classicAddress, async () => {
        ownerEntered();
        await ownerGate;
      });
      await atOwner;
      await atRenewal;
      clock = 2_000;
      const replacement = new FileAcquisitionStateStore(directory, SECRET, {
        processInstanceId: "f1234567-89ab-4cde-8f01-23456789abcd",
        leaseMs: 60,
        heartbeatMs: 10,
        compactAfterGenerations: 5,
        now: () => clock,
      });
      await replacement.withOwnerLock(wallet.classicAddress, async () => undefined);
      resumeRenewal();
      await new Promise((resolve) => setTimeout(resolve, 20));
      releaseOwner();
      await expect(held).rejects.toThrow(/fenced|ownership changed/i);
    } finally {
      resumeRenewal?.();
      releaseOwner?.();
      await held?.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a detached release after takeover compacts its predecessor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-rlusd-release-aba-"));
    const wallet = Wallet.generate();
    let clock = 1_000;
    let releasePaused!: () => void;
    let resumeRelease!: () => void;
    const atRelease = new Promise<void>((resolve) => { releasePaused = resolve; });
    const releaseGate = new Promise<void>((resolve) => { resumeRelease = resolve; });
    const seed = new FileAcquisitionStateStore(directory, SECRET, {
      processInstanceId: "11234567-89ab-4cde-8f01-23456789abcd",
      compactAfterGenerations: 5,
      now: () => clock,
    });
    const original = new FileAcquisitionStateStore(directory, SECRET, {
      processInstanceId: "21234567-89ab-4cde-8f01-23456789abcd",
      leaseMs: 60,
      heartbeatMs: 10,
      compactAfterGenerations: 5,
      now: () => clock,
      beforePublish: async (kind) => {
        if (kind === "release") {
          releasePaused();
          await releaseGate;
        }
      },
    });
    let releasing: Promise<void> | undefined;
    try {
      await seed.withOwnerLock(wallet.classicAddress, async () => undefined);
      releasing = original.withOwnerLock(wallet.classicAddress, async () => undefined);
      await atRelease;
      clock = 2_000;
      const replacement = new FileAcquisitionStateStore(directory, SECRET, {
        processInstanceId: "31234567-89ab-4cde-8f01-23456789abcd",
        leaseMs: 60,
        heartbeatMs: 10,
        compactAfterGenerations: 5,
        now: () => clock,
      });
      await replacement.withOwnerLock(wallet.classicAddress, async () => undefined);
      resumeRelease();
      await expect(releasing).rejects.toThrow(/fenced/i);
    } finally {
      resumeRelease?.();
      await releasing?.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a long-running callback renewable across repeated active compactions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-rlusd-active-compact-"));
    const wallet = Wallet.generate();
    const stateName = `${createHash("sha256")
      .update(`testnet:${wallet.classicAddress}`, "utf8").digest("hex")}.json`;
    let replacements = 0;
    let releaseCallback!: () => void;
    const callbackGate = new Promise<void>((resolve) => { releaseCallback = resolve; });
    const owner = new FileAcquisitionStateStore(directory, SECRET, {
      processInstanceId: "51234567-89ab-4cde-8f01-23456789abcd",
      leaseMs: 5_000,
      heartbeatMs: 10,
      compactAfterGenerations: 4,
      beforeCompactionStep: async (step) => {
        if (step === "replace_root") replacements += 1;
      },
    });
    const contender = new FileAcquisitionStateStore(directory, SECRET, {
      processInstanceId: "61234567-89ab-4cde-8f01-23456789abcd",
      leaseMs: 5_000,
      heartbeatMs: 10,
      compactAfterGenerations: 4,
    });
    let held: Promise<string> | undefined;
    try {
      held = owner.withOwnerLock(wallet.classicAddress, async () => {
        await callbackGate;
        return "completed";
      });
      await vi.waitFor(() => expect(replacements).toBeGreaterThanOrEqual(2));
      await expect(contender.withOwnerLock(wallet.classicAddress, async () => undefined))
        .rejects.toMatchObject({ code: "OPERATION_IN_PROGRESS" });
      releaseCallback();
      await expect(held).resolves.toBe("completed");
      expect(replacements).toBeGreaterThanOrEqual(2);
      const lockFiles = (await readdir(directory))
        .filter((entry) => entry.startsWith(`${stateName}.lock`));
      expect(lockFiles.length).toBeLessThanOrEqual(4);
      expect(lockFiles.some((entry) => entry.includes(".compacting-"))).toBe(false);
    } finally {
      releaseCallback?.();
      await held?.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes state publication ahead of a heartbeat on the same owner generation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-rlusd-save-heartbeat-"));
    const wallet = Wallet.generate();
    let savePaused!: () => void;
    let resumeSave!: () => void;
    const atSave = new Promise<void>((resolve) => { savePaused = resolve; });
    const saveGate = new Promise<void>((resolve) => { resumeSave = resolve; });
    let pauseSave = true;
    let renewals = 0;
    const store = new FileAcquisitionStateStore(directory, SECRET, {
      processInstanceId: "71234567-89ab-4cde-8f01-23456789abcd",
      leaseMs: 120,
      heartbeatMs: 10,
      compactAfterGenerations: 32,
      beforePublish: async (kind) => {
        if (kind === "save" && pauseSave) {
          pauseSave = false;
          savePaused();
          await saveGate;
        }
        if (kind === "renew") renewals += 1;
      },
    });
    let held: Promise<void> | undefined;
    try {
      held = store.withOwnerLock(wallet.classicAddress, async () => {
        await store.save(wallet.classicAddress, initializingState(wallet));
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect((await store.load(wallet.classicAddress))?.status).toBe("initializing");
      });
      await atSave;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(renewals).toBe(0);
      resumeSave();
      await expect(held).resolves.toBeUndefined();
      expect(renewals).toBeGreaterThan(0);
    } finally {
      resumeSave?.();
      await held?.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves embedded state through active and released generation compaction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-rlusd-state-compact-"));
    const wallet = Wallet.generate();
    let replacements = 0;
    let releaseCallback!: () => void;
    const callbackGate = new Promise<void>((resolve) => { releaseCallback = resolve; });
    const store = new FileAcquisitionStateStore(directory, SECRET, {
      processInstanceId: "81234567-89ab-4cde-8f01-23456789abcd",
      leaseMs: 120,
      heartbeatMs: 10,
      compactAfterGenerations: 4,
      beforeCompactionStep: async (step) => {
        if (step === "replace_root") replacements += 1;
      },
    });
    let held: Promise<void> | undefined;
    try {
      held = store.withOwnerLock(wallet.classicAddress, async () => {
        await store.save(wallet.classicAddress, initializingState(wallet));
        await vi.waitFor(() => expect(replacements).toBeGreaterThanOrEqual(1));
        expect(await store.load(wallet.classicAddress)).toEqual(initializingState(wallet));
        await callbackGate;
      });
      await vi.waitFor(() => expect(replacements).toBeGreaterThanOrEqual(1));
      releaseCallback();
      await expect(held).resolves.toBeUndefined();
      const activeReplacements = replacements;

      for (let attempt = 0; attempt < 4 && replacements === activeReplacements; attempt += 1) {
        await store.withOwnerLock(wallet.classicAddress, async () => {
          expect(await store.load(wallet.classicAddress)).toEqual(initializingState(wallet));
        });
      }
      expect(replacements).toBeGreaterThan(activeReplacements);
      await store.withOwnerLock(wallet.classicAddress, async () => {
        expect(await store.load(wallet.classicAddress)).toEqual(initializingState(wallet));
      });
    } finally {
      releaseCallback?.();
      await held?.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts an exact active checkpoint installed by a helping contender", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-rlusd-active-help-"));
    const wallet = Wallet.generate();
    let published!: () => void;
    let resumeOwner!: () => void;
    let releaseCallback!: () => void;
    let renewedAfterHelp!: () => void;
    const clock = 1_000;
    const atPublished = new Promise<void>((resolve) => { published = resolve; });
    const publishGate = new Promise<void>((resolve) => { resumeOwner = resolve; });
    const callbackGate = new Promise<void>((resolve) => { releaseCallback = resolve; });
    const afterHelp = new Promise<void>((resolve) => { renewedAfterHelp = resolve; });
    let delayOnce = true;
    let renewals = 0;
    const owner = new FileAcquisitionStateStore(directory, SECRET, {
      processInstanceId: "a1234567-89ab-4cde-8f01-23456789abcd",
      leaseMs: 120,
      heartbeatMs: 10,
      compactAfterGenerations: 4,
      now: () => clock,
      beforePublish: async (kind) => {
        if (kind === "renew") {
          renewals += 1;
          if (renewals >= 4) renewedAfterHelp();
        }
      },
      afterActiveCompactionPublish: async () => {
        if (delayOnce) {
          delayOnce = false;
          published();
          await publishGate;
        }
      },
    });
    const helper = new FileAcquisitionStateStore(directory, SECRET, {
      processInstanceId: "b1234567-89ab-4cde-8f01-23456789abcd",
      leaseMs: 120,
      heartbeatMs: 10,
      compactAfterGenerations: 4,
      now: () => clock,
    });
    let held: Promise<string> | undefined;
    try {
      held = owner.withOwnerLock(wallet.classicAddress, async () => {
        await callbackGate;
        return "completed";
      });
      await atPublished;
      await expect(helper.withOwnerLock(wallet.classicAddress, async () => undefined))
        .rejects.toMatchObject({ code: "OPERATION_IN_PROGRESS" });
      resumeOwner();
      await afterHelp;
      releaseCallback();
      await expect(held).resolves.toBe("completed");
    } finally {
      resumeOwner?.();
      releaseCallback?.();
      await held?.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers active root installation when its first cleanup attempt fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-rlusd-active-cleanup-"));
    const wallet = Wallet.generate();
    const stateName = `${createHash("sha256")
      .update(`testnet:${wallet.classicAddress}`, "utf8").digest("hex")}.json`;
    let cleanupAttempts = 0;
    let releaseCallback!: () => void;
    const callbackGate = new Promise<void>((resolve) => { releaseCallback = resolve; });
    const owner = new FileAcquisitionStateStore(directory, SECRET, {
      processInstanceId: "c1234567-89ab-4cde-8f01-23456789abcd",
      leaseMs: 120,
      heartbeatMs: 10,
      compactAfterGenerations: 4,
      beforeCompactionStep: async (step) => {
        if (step === "cleanup") {
          cleanupAttempts += 1;
          if (cleanupAttempts === 1) throw new Error("simulated cleanup interruption");
        }
      },
    });
    let held: Promise<string> | undefined;
    try {
      held = owner.withOwnerLock(wallet.classicAddress, async () => {
        await callbackGate;
        return "completed";
      });
      await vi.waitFor(() => expect(cleanupAttempts).toBeGreaterThanOrEqual(2));
      releaseCallback();
      await expect(held).resolves.toBe("completed");
      const lockFiles = (await readdir(directory))
        .filter((entry) => entry.startsWith(`${stateName}.lock`));
      expect(lockFiles.some((entry) => entry.includes(".compacting-"))).toBe(false);
    } finally {
      releaseCallback?.();
      await held?.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("finishes and renews its own exact active compaction after its lease clock passes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-rlusd-active-expired-self-"));
    const wallet = Wallet.generate();
    let clock = 1_000;
    let compactionPaused!: () => void;
    let resumeCompaction!: () => void;
    let releaseCallback!: () => void;
    let renewedAfterPause!: () => void;
    const atCompaction = new Promise<void>((resolve) => { compactionPaused = resolve; });
    const compactionGate = new Promise<void>((resolve) => { resumeCompaction = resolve; });
    const callbackGate = new Promise<void>((resolve) => { releaseCallback = resolve; });
    const afterPause = new Promise<void>((resolve) => { renewedAfterPause = resolve; });
    let pauseOnce = true;
    let renewals = 0;
    const owner = new FileAcquisitionStateStore(directory, SECRET, {
      processInstanceId: "d1234567-89ab-4cde-8f01-23456789abcd",
      leaseMs: 60,
      heartbeatMs: 10,
      compactAfterGenerations: 4,
      now: () => clock,
      beforePublish: async (kind) => {
        if (kind === "renew") {
          renewals += 1;
          if (!pauseOnce && renewals >= 4) renewedAfterPause();
        }
      },
      beforeCompactionStep: async (step) => {
        if (step === "replace_root" && pauseOnce) {
          pauseOnce = false;
          compactionPaused();
          await compactionGate;
        }
      },
    });
    let held: Promise<string> | undefined;
    try {
      held = owner.withOwnerLock(wallet.classicAddress, async () => {
        await callbackGate;
        return "completed";
      });
      await atCompaction;
      clock = 2_000;
      resumeCompaction();
      await afterPause;
      releaseCallback();
      await expect(held).resolves.toBe("completed");
    } finally {
      resumeCompaction?.();
      releaseCallback?.();
      await held?.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("compacts immutable lock generations on release so repeated calls stay bounded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-rlusd-lock-compact-"));
    const wallet = Wallet.generate();
    const stateName = `${createHash("sha256")
      .update(`testnet:${wallet.classicAddress}`, "utf8").digest("hex")}.json`;
    const store = new FileAcquisitionStateStore(directory, SECRET, {
      processInstanceId: "31234567-89ab-4cde-8f01-23456789abcd",
      compactAfterGenerations: 6,
    });
    try {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await expect(store.withOwnerLock(wallet.classicAddress, async () => attempt))
          .resolves.toBe(attempt);
        const lockFiles = (await readdir(directory))
          .filter((entry) => entry.startsWith(`${stateName}.lock`));
        expect(lockFiles.length).toBeLessThanOrEqual(5);
        expect(lockFiles.some((entry) => entry.includes(".candidate-"))).toBe(false);
        expect(lockFiles.some((entry) => entry.includes(".compacting-"))).toBe(false);
        expect(lockFiles.some((entry) => entry.includes(".checkpoint-"))).toBe(false);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("scavenges only exact private expired candidate files and leaves no unbounded residue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-rlusd-candidate-cleanup-"));
    const wallet = Wallet.generate();
    const stateName = `${createHash("sha256")
      .update(`testnet:${wallet.classicAddress}`, "utf8").digest("hex")}.json`;
    const prefix = `${stateName}.lock.candidate-`;
    const old = new Date(Date.now() - 120_000);
    const freshToken = "f1234567-89ab-4cde-8f01-23456789abcd";
    const freshPath = join(directory, `${prefix}${freshToken}`);
    const ignoredPath = join(directory, `${prefix}not-a-uuid`);
    const store = new FileAcquisitionStateStore(directory, SECRET, {
      processInstanceId: "71234567-89ab-4cde-8f01-23456789abcd",
    });
    try {
      for (let index = 0; index < 16; index += 1) {
        const token = `a0000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
        const path = join(directory, `${prefix}${token}`);
        await writeFile(path, "crash residue", { mode: 0o600 });
        await utimes(path, old, old);
      }
      await writeFile(freshPath, "in flight", { mode: 0o600 });
      await writeFile(ignoredPath, "not a candidate identity", { mode: 0o600 });

      await store.withOwnerLock(wallet.classicAddress, async () => undefined);
      let candidates = (await readdir(directory)).filter((entry) => entry.startsWith(prefix));
      expect(candidates).toEqual(expect.arrayContaining([
        `${prefix}${freshToken}`,
        `${prefix}not-a-uuid`,
      ]));
      expect(candidates).toHaveLength(2);

      await utimes(freshPath, old, old);
      await store.withOwnerLock(wallet.classicAddress, async () => undefined);
      candidates = (await readdir(directory)).filter((entry) => entry.startsWith(prefix));
      expect(candidates).toEqual([`${prefix}not-a-uuid`]);

      const target = join(directory, "candidate-target");
      const symlinkToken = "e1234567-89ab-4cde-8f01-23456789abcd";
      const candidateSymlink = join(directory, `${prefix}${symlinkToken}`);
      await writeFile(target, "must remain", { mode: 0o600 });
      await symlink(target, candidateSymlink);
      await expect(store.withOwnerLock(wallet.classicAddress, async () => undefined))
        .rejects.toMatchObject({ code: "OPERATION_IN_PROGRESS" });
      expect(await readFile(target, "utf8")).toBe("must remain");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("scavenges only old detached successor tombstones and preserves canonical generations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-rlusd-detached-cleanup-"));
    const wallet = Wallet.generate();
    const stateName = `${createHash("sha256")
      .update(`testnet:${wallet.classicAddress}`, "utf8").digest("hex")}.json`;
    const lockPath = join(directory, `${stateName}.lock`);
    const store = new FileAcquisitionStateStore(directory, SECRET, {
      processInstanceId: "e1234567-89ab-4cde-8f01-23456789abcd",
    });
    const old = new Date(Date.now() - 120_000);
    const detachedPredecessor = "f1234567-89ab-4cde-8f01-23456789abcd";
    const detachedPath = `${lockPath}.next-${detachedPredecessor}`;
    try {
      await store.withOwnerLock(wallet.classicAddress, async () => undefined);
      const root = JSON.parse(await readFile(lockPath, "utf8"));
      const canonicalPath = `${lockPath}.next-${root.token}`;
      await utimes(canonicalPath, old, old);
      await writeFile(detachedPath, `${JSON.stringify({
        version: 3,
        released: true,
        pid: process.pid,
        process_instance_id: "11234567-89ab-4cde-8f01-23456789abcd",
        token: "21234567-89ab-4cde-8f01-23456789abcd",
        acquired_at: 1_000,
        heartbeat_at: 1_000,
        lease_expires_at: 1_000,
      })}\n`, { mode: 0o600 });
      await utimes(detachedPath, old, old);

      await store.withOwnerLock(wallet.classicAddress, async () => undefined);
      await expect(readFile(detachedPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.parse(await readFile(canonicalPath, "utf8")).token).toBeDefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers a crash after publishing compaction state but before root replacement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-rlusd-compact-before-root-"));
    const wallet = Wallet.generate();
    const stateName = `${createHash("sha256")
      .update(`testnet:${wallet.classicAddress}`, "utf8").digest("hex")}.json`;
    let crash = true;
    const crashing = new FileAcquisitionStateStore(directory, SECRET, {
      processInstanceId: "41234567-89ab-4cde-8f01-23456789abcd",
      compactAfterGenerations: 4,
      beforeCompactionStep: async (step) => {
        if (step === "replace_root" && crash) {
          crash = false;
          throw new Error("simulated crash before root replacement");
        }
      },
    });
    try {
      await crashing.withOwnerLock(wallet.classicAddress, async () => undefined);
      await expect(crashing.withOwnerLock(wallet.classicAddress, async () => undefined))
        .rejects.toThrow("simulated crash before root replacement");
      let files = await readdir(directory);
      expect(files.some((entry) => entry.startsWith(`${stateName}.lock.compacting-`) &&
        !entry.includes(".checkpoint-"))).toBe(true);
      expect(files.some((entry) => entry.includes(".checkpoint-"))).toBe(true);

      const restarted = new FileAcquisitionStateStore(directory, SECRET, {
        processInstanceId: "51234567-89ab-4cde-8f01-23456789abcd",
        compactAfterGenerations: 4,
      });
      await expect(restarted.withOwnerLock(wallet.classicAddress, async () => "recovered"))
        .resolves.toBe("recovered");
      files = await readdir(directory);
      expect(files.some((entry) => entry.startsWith(`${stateName}.lock.compacting-`))).toBe(false);
      expect(files.some((entry) => entry.includes(".checkpoint-"))).toBe(false);
      expect(files.filter((entry) => entry.startsWith(`${stateName}.lock`)).length)
        .toBeLessThanOrEqual(3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers a crash after root replacement but before old-generation cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-rlusd-compact-after-root-"));
    const wallet = Wallet.generate();
    const stateName = `${createHash("sha256")
      .update(`testnet:${wallet.classicAddress}`, "utf8").digest("hex")}.json`;
    let crash = true;
    const crashing = new FileAcquisitionStateStore(directory, SECRET, {
      processInstanceId: "61234567-89ab-4cde-8f01-23456789abcd",
      compactAfterGenerations: 4,
      beforeCompactionStep: async (step) => {
        if (step === "cleanup" && crash) {
          crash = false;
          throw new Error("simulated crash before generation cleanup");
        }
      },
    });
    try {
      await crashing.withOwnerLock(wallet.classicAddress, async () => undefined);
      await expect(crashing.withOwnerLock(wallet.classicAddress, async () => undefined))
        .rejects.toThrow("simulated crash before generation cleanup");
      let files = await readdir(directory);
      expect(files.some((entry) => entry.startsWith(`${stateName}.lock.compacting-`) &&
        !entry.includes(".checkpoint-"))).toBe(true);
      expect(files.some((entry) => entry.includes(".next-"))).toBe(true);

      const restarted = new FileAcquisitionStateStore(directory, SECRET, {
        processInstanceId: "71234567-89ab-4cde-8f01-23456789abcd",
        compactAfterGenerations: 4,
      });
      await expect(restarted.withOwnerLock(wallet.classicAddress, async () => "recovered"))
        .resolves.toBe("recovered");
      files = await readdir(directory);
      expect(files.some((entry) => entry.startsWith(`${stateName}.lock.compacting-`))).toBe(false);
      expect(files.some((entry) => entry.includes(".checkpoint-"))).toBe(false);
      expect(files.filter((entry) => entry.startsWith(`${stateName}.lock`)).length)
        .toBeLessThanOrEqual(3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects compaction markers whose cleanup paths are not exact UUID successors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-rlusd-compact-path-"));
    const wallet = Wallet.generate();
    const stateName = `${createHash("sha256")
      .update(`testnet:${wallet.classicAddress}`, "utf8").digest("hex")}.json`;
    const lockPath = join(directory, `${stateName}.lock`);
    const rootToken = "a1234567-89ab-4cde-8f01-23456789abcd";
    const compactionToken = "b1234567-89ab-4cde-8f01-23456789abcd";
    const checkpointToken = "c1234567-89ab-4cde-8f01-23456789abcd";
    const instance = "d1234567-89ab-4cde-8f01-23456789abcd";
    const root = {
      version: 3, released: true, pid: process.pid, process_instance_id: instance,
      token: rootToken, acquired_at: 1_000, heartbeat_at: 1_000, lease_expires_at: 1_000,
    };
    const compaction = {
      version: 3, released: false, compacting: true, checkpoint_token: checkpointToken,
      pid: process.pid, process_instance_id: instance, token: compactionToken,
      acquired_at: 1_000, heartbeat_at: 1_000, lease_expires_at: 2_000,
    };
    const checkpoint = { ...root, token: checkpointToken };
    const victim = join(directory, "must-not-be-unlinked");
    try {
      await writeFile(lockPath, `${JSON.stringify(root)}\n`, { mode: 0o600 });
      await writeFile(`${lockPath}.next-${rootToken}`, `${JSON.stringify(compaction)}\n`, { mode: 0o600 });
      await writeFile(victim, "public state", { mode: 0o600 });
      await writeFile(`${lockPath}.compacting-${compactionToken}`, `${JSON.stringify({
        version: 1,
        compaction_token: compactionToken,
        checkpoint,
        old_paths: [`${lockPath}.next-${rootToken}/../../must-not-be-unlinked`],
      })}\n`, { mode: 0o600 });
      const store = new FileAcquisitionStateStore(directory, SECRET, {
        processInstanceId: "e1234567-89ab-4cde-8f01-23456789abcd",
        now: () => 1_500,
      });
      await expect(store.withOwnerLock(wallet.classicAddress, async () => undefined))
        .rejects.toMatchObject({ code: "OPERATION_IN_PROGRESS" });
      expect(await readFile(victim, "utf8")).toBe("public state");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("abandons an expired delayed compaction without orphaning its live takeover", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-rlusd-compact-expired-"));
    const wallet = Wallet.generate();
    const stateName = `${createHash("sha256")
      .update(`testnet:${wallet.classicAddress}`, "utf8").digest("hex")}.json`;
    const lockPath = join(directory, `${stateName}.lock`);
    let clock = 1_000;
    let compactionObserved!: () => void;
    let resumeCompaction!: () => void;
    let takeoverEntered!: () => void;
    let releaseTakeover!: () => void;
    const atCompaction = new Promise<void>((resolve) => { compactionObserved = resolve; });
    const compactionGate = new Promise<void>((resolve) => { resumeCompaction = resolve; });
    const atTakeover = new Promise<void>((resolve) => { takeoverEntered = resolve; });
    const takeoverGate = new Promise<void>((resolve) => { releaseTakeover = resolve; });
    let delayOnce = true;
    let active = 0;
    let maxActive = 0;
    const original = new FileAcquisitionStateStore(directory, SECRET, {
      processInstanceId: "81234567-89ab-4cde-8f01-23456789abcd",
      leaseMs: 60,
      heartbeatMs: 10,
      compactAfterGenerations: 4,
      now: () => clock,
      beforeCompactionStep: async (step) => {
        if (step === "replace_root" && delayOnce) {
          delayOnce = false;
          compactionObserved();
          await compactionGate;
        }
      },
    });
    let delayed: Promise<void> | undefined;
    let takeover: Promise<void> | undefined;
    try {
      await original.withOwnerLock(wallet.classicAddress, async () => undefined);
      delayed = original.withOwnerLock(wallet.classicAddress, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        active -= 1;
      });
      await atCompaction;
      const markerName = (await readdir(directory)).find((entry) =>
        entry.startsWith(`${stateName}.lock.compacting-`) && !entry.includes(".checkpoint-"));
      expect(markerName).toBeDefined();
      const marker = JSON.parse(await readFile(join(directory, markerName!), "utf8"));
      clock = 2_000;
      const replacement = new FileAcquisitionStateStore(directory, SECRET, {
        processInstanceId: "91234567-89ab-4cde-8f01-23456789abcd",
        leaseMs: 60,
        heartbeatMs: 10,
        compactAfterGenerations: 4,
        now: () => clock,
      });
      takeover = replacement.withOwnerLock(wallet.classicAddress, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        takeoverEntered();
        await takeoverGate;
        active -= 1;
      });
      await atTakeover;
      const rootDuringTakeover = JSON.parse(await readFile(lockPath, "utf8"));
      expect(rootDuringTakeover.token).not.toBe(marker.checkpoint.token);
      expect(active).toBe(1);

      resumeCompaction();
      await delayed;
      expect(JSON.parse(await readFile(lockPath, "utf8")).token)
        .toBe(rootDuringTakeover.token);
      expect(maxActive).toBe(1);
      releaseTakeover();
      await takeover;
    } finally {
      resumeCompaction?.();
      releaseTakeover?.();
      await delayed?.catch(() => undefined);
      await takeover?.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unsafe Harbor approvals before exposing them", async () => {
    const wallet = Wallet.generate();
    const actions = harbor(wallet);
    actions.execute.mockResolvedValueOnce({
      approvalId: "approval",
      approvalExpiresAt: "2026-10-19T12:10:00.000Z",
      transaction: approvedTransaction(wallet, { Flags: 0, TakerGets: "999999999" }),
    });
    const h = harness({ wallet, harbor: actions });
    const result = await prepare(h);
    expect(result.status).toBe(502);
    expect((await result.json()).error.code).toBe("UNSAFE_HARBOR_APPROVAL");
    expect(h.store.states.get(wallet.classicAddress)?.status).toBe("built");
  });

  it("rejects signed material from an injected prepare action", async () => {
    const wallet = Wallet.generate();
    const actions = harbor(wallet);
    actions.execute.mockResolvedValueOnce({
      approvalId: "approval",
      approvalExpiresAt: "2026-10-19T12:10:00.000Z",
      transaction: approvedTransaction(wallet, { TxnSignature: "DEADBEEF" }),
    });
    const h = harness({ wallet, harbor: actions });

    const result = await prepare(h);
    expect(result.status).toBe(502);
    expect(h.store.states.get(wallet.classicAddress)?.status).toBe("built");
  });

  it("accepts only the operation id and exact owner-signed approved transaction", async () => {
    const h = harness();
    await prepare(h);
    const wrongWallet = Wallet.generate();
    const wrongAccountBlob = wrongWallet.sign(approvedTransaction(wrongWallet) as never).tx_blob;
    const tamperedBlob = h.wallet.sign(approvedTransaction(h.wallet, { TakerGets: "150000001" }) as never).tx_blob;

    const wrong = await h.handler(request({
      action: "submit",
      operation_id: OPERATION_ID,
      tx_blob: wrongAccountBlob,
    }));
    const tampered = await h.handler(request({
      action: "submit",
      operation_id: OPERATION_ID,
      tx_blob: tamperedBlob,
    }));
    const unknown = await h.handler(request({
      action: "submit",
      operation_id: "11234567-89ab-4cde-8f01-23456789abcd",
      tx_blob: h.wallet.sign(approvedTransaction(h.wallet) as never).tx_blob,
    }));

    expect(wrong.status).toBe(400);
    expect(tampered.status).toBe(400);
    expect(unknown.status).toBe(404);
    expect(h.actions.relay).not.toHaveBeenCalled();
  });

  it("persists only public hash and LLS before exactly one relay", async () => {
    const h = harness();
    await prepare(h);
    const blob = h.wallet.sign(approvedTransaction(h.wallet) as never).tx_blob;
    const result = await h.handler(request({
      action: "submit",
      operation_id: OPERATION_ID,
      tx_blob: blob,
    }));

    expect(result.status).toBe(200);
    expect(h.store.events).toEqual([
      "save:initializing", "save:built", "save:prepared", "save:signed_pending", "relay", "save:validated",
    ]);
    expect(h.actions.relay).toHaveBeenCalledTimes(1);
    const persisted = h.store.states.get(h.wallet.classicAddress)!;
    expect(persisted.hash).toBe(hashes.hashSignedTx(blob).toUpperCase());
    expect(persisted.last_ledger_sequence).toBe(500);
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain(blob);
    expect(serialized).not.toContain("server-only-api-key");
    expect(serialized).not.toContain("seed");
  });

  it("persists a directly validated non-success result as terminal failed", async () => {
    const wallet = Wallet.generate();
    const store = new MemoryStore();
    const actions = harbor(wallet, store.events);
    actions.relay.mockImplementationOnce(async (blob: string) => ({
      hash: hashes.hashSignedTx(blob).toUpperCase(),
      validated: true as const,
      ledgerIndex: 491,
      engineResult: "tecPATH_DRY",
    }));
    const h = harness({ wallet, store, harbor: actions });
    await prepare(h);
    const blob = wallet.sign(approvedTransaction(wallet) as never).tx_blob;
    const hash = hashes.hashSignedTx(blob).toUpperCase();

    const result = await h.handler(request({ action: "submit", operation_id: OPERATION_ID, tx_blob: blob }));
    expect(result.status).toBe(422);
    expect(await result.json()).toMatchObject({
      status: "failed",
      hash,
      ledger_index: 491,
      engine_result: "tecPATH_DRY",
    });
    expect(store.states.get(wallet.classicAddress)).toMatchObject({
      status: "failed",
      hash,
      ledger_index: 491,
      engine_result: "tecPATH_DRY",
    });
    const retry = await h.handler(request({ action: "submit", operation_id: OPERATION_ID, tx_blob: blob }));
    expect(retry.status).toBe(409);
    expect(actions.relay).toHaveBeenCalledTimes(1);
    expect(actions.proveCompletion).not.toHaveBeenCalled();
  });

  it("keeps an uncertain relay signed_pending and never relays it again", async () => {
    const wallet = Wallet.generate();
    const store = new MemoryStore();
    const actions = harbor(wallet, store.events);
    actions.relay.mockRejectedValueOnce(new Error("connection reset after send"));
    const h = harness({ wallet, store, harbor: actions });
    await prepare(h);
    const blob = wallet.sign(approvedTransaction(wallet) as never).tx_blob;

    const first = await h.handler(request({ action: "submit", operation_id: OPERATION_ID, tx_blob: blob }));
    const retry = await h.handler(request({ action: "submit", operation_id: OPERATION_ID, tx_blob: blob }));

    expect(first.status).toBe(202);
    expect(retry.status).toBe(202);
    expect((await retry.json()).status).toBe("signed_pending");
    expect(actions.relay).toHaveBeenCalledTimes(1);
    expect(actions.status).toHaveBeenCalledTimes(1);
  });

  it("recovers a signed operation through status polling only", async () => {
    const wallet = Wallet.generate();
    const store = new MemoryStore();
    const actions = harbor(wallet, store.events);
    actions.relay.mockRejectedValueOnce(new Error("uncertain"));
    const h = harness({ wallet, store, harbor: actions });
    await prepare(h);
    const blob = wallet.sign(approvedTransaction(wallet) as never).tx_blob;
    const hash = hashes.hashSignedTx(blob).toUpperCase();
    await h.handler(request({ action: "submit", operation_id: OPERATION_ID, tx_blob: blob }));
    actions.status.mockResolvedValueOnce({
      hash,
      validated: true,
      ledgerIndex: 490,
      engineResult: "tesSUCCESS",
    });

    const status = await h.handler(request({ action: "status", operation_id: OPERATION_ID }));
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ status: "validated", hash, ledger_index: 490 });
    expect(actions.relay).toHaveBeenCalledTimes(1);
    expect(actions.status).toHaveBeenCalledTimes(1);
    expect(actions.proveCompletion).toHaveBeenCalledTimes(1);
  });

  it("persists a validated non-success result as terminal failed after restart reconciliation", async () => {
    const wallet = Wallet.generate();
    const store = new MemoryStore();
    const actions = harbor(wallet, store.events);
    actions.relay.mockRejectedValueOnce(new Error("uncertain submit response"));
    const firstProcess = harness({ wallet, store, harbor: actions });
    await prepare(firstProcess);
    const blob = wallet.sign(approvedTransaction(wallet) as never).tx_blob;
    const hash = hashes.hashSignedTx(blob).toUpperCase();
    expect((await firstProcess.handler(request({
      action: "submit",
      operation_id: OPERATION_ID,
      tx_blob: blob,
    }))).status).toBe(202);

    actions.status.mockResolvedValueOnce({
      hash,
      validated: true,
      ledgerIndex: 492,
      engineResult: "tecUNFUNDED_OFFER",
    });
    const restarted = harness({ wallet, store, harbor: actions });
    const recovered = await restarted.handler(request({ action: "status", operation_id: OPERATION_ID }));
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      status: "failed",
      hash,
      ledger_index: 492,
      engine_result: "tecUNFUNDED_OFFER",
    });
    expect(store.states.get(wallet.classicAddress)).toMatchObject({
      status: "failed",
      hash,
      ledger_index: 492,
      engine_result: "tecUNFUNDED_OFFER",
    });
    const forbiddenRetry = await restarted.handler(request({
      action: "submit",
      operation_id: OPERATION_ID,
      tx_blob: blob,
    }));
    expect(forbiddenRetry.status).toBe(409);
    expect(actions.relay).toHaveBeenCalledTimes(1);
    expect(actions.status).toHaveBeenCalledTimes(1);
    expect(actions.proveCompletion).not.toHaveBeenCalled();
  });

  it("does not trust Harbor tx.status without an independent ledger completion proof", async () => {
    const wallet = Wallet.generate();
    const store = new MemoryStore();
    const actions = harbor(wallet, store.events);
    actions.relay.mockRejectedValueOnce(new Error("uncertain"));
    const h = harness({ wallet, store, harbor: actions });
    await prepare(h);
    const blob = wallet.sign(approvedTransaction(wallet) as never).tx_blob;
    const hash = hashes.hashSignedTx(blob).toUpperCase();
    await h.handler(request({ action: "submit", operation_id: OPERATION_ID, tx_blob: blob }));
    actions.status.mockResolvedValueOnce({
      hash,
      validated: true,
      ledgerIndex: 495,
      engineResult: "tesSUCCESS",
    });
    actions.proveCompletion.mockRejectedValueOnce(new Error("wrong validated transaction"));

    const status = await h.handler(request({ action: "status", operation_id: OPERATION_ID }));
    expect(status.status).toBe(502);
    expect((await status.json()).error.code).toBe("COMPLETION_NOT_PROVEN");
    expect(store.states.get(wallet.classicAddress)?.status).toBe("signed_pending");
    expect(actions.relay).toHaveBeenCalledTimes(1);
  });

  it("rejects a completion proof whose official RLUSD delta is not exactly 75", async () => {
    const wallet = Wallet.generate();
    const store = new MemoryStore();
    const actions = harbor(wallet, store.events);
    actions.relay.mockRejectedValueOnce(new Error("uncertain"));
    const h = harness({ wallet, store, harbor: actions });
    await prepare(h);
    const blob = wallet.sign(approvedTransaction(wallet) as never).tx_blob;
    const hash = hashes.hashSignedTx(blob).toUpperCase();
    await h.handler(request({ action: "submit", operation_id: OPERATION_ID, tx_blob: blob }));
    actions.status.mockResolvedValueOnce({
      hash,
      validated: true,
      ledgerIndex: 495,
      engineResult: "tesSUCCESS",
    });
    actions.proveCompletion.mockResolvedValueOnce({
      hash,
      ledgerIndex: 495,
      engineResult: "tesSUCCESS",
      balanceAfter: "86",
      balanceAfterLedgerIndex: 496,
    });

    const status = await h.handler(request({ action: "status", operation_id: OPERATION_ID }));
    expect(status.status).toBe(502);
    expect((await status.json()).error.code).toBe("COMPLETION_NOT_PROVEN");
    expect(store.states.get(wallet.classicAddress)?.status).toBe("signed_pending");
  });

  it("requires independent proof even after an immediate validated submit result", async () => {
    const wallet = Wallet.generate();
    const store = new MemoryStore();
    const actions = harbor(wallet, store.events);
    actions.proveCompletion.mockRejectedValueOnce(new Error("ledger proof unavailable"));
    const h = harness({ wallet, store, harbor: actions });
    await prepare(h);
    const blob = wallet.sign(approvedTransaction(wallet) as never).tx_blob;

    const result = await h.handler(request({
      action: "submit",
      operation_id: OPERATION_ID,
      tx_blob: blob,
    }));
    expect(result.status).toBe(202);
    expect((await result.json()).status).toBe("signed_pending");
    expect(store.states.get(wallet.classicAddress)?.status).toBe("signed_pending");
    expect(actions.proveCompletion).toHaveBeenCalledTimes(1);
  });

  it("makes signed expiry terminal only after validated ledger progress proves non-inclusion", async () => {
    const wallet = Wallet.generate();
    const store = new MemoryStore();
    const actions = harbor(wallet, store.events);
    actions.relay.mockRejectedValueOnce(new Error("uncertain"));
    const h = harness({ wallet, store, harbor: actions });
    await prepare(h);
    const blob = wallet.sign(approvedTransaction(wallet) as never).tx_blob;
    const hash = hashes.hashSignedTx(blob).toUpperCase();
    await h.handler(request({ action: "submit", operation_id: OPERATION_ID, tx_blob: blob }));
    actions.refreshPrecheck.mockClear();
    actions.status.mockResolvedValueOnce({ hash, validated: false });
    actions.refreshPrecheck.mockResolvedValueOnce({ ledgerIndex: 501, sequence: 1, balance: "10" });

    const status = await h.handler(request({ action: "status", operation_id: OPERATION_ID }));
    const repeated = await h.handler(request({ action: "status", operation_id: OPERATION_ID }));
    expect((await status.json()).status).toBe("expired_unincluded");
    expect((await repeated.json()).status).toBe("expired_unincluded");
    expect(actions.status).toHaveBeenCalledTimes(1);
    expect(actions.refreshPrecheck).toHaveBeenCalledTimes(1);
    expect(actions.relay).toHaveBeenCalledTimes(1);
  });

  it("keeps the post-sign pre-relay state check and never retries a blocked signed attempt", async () => {
    const wallet = Wallet.generate();
    const store = new MemoryStore();
    const actions = harbor(wallet, store.events);
    const h = harness({ wallet, store, harbor: actions });
    await prepare(h);
    const blob = wallet.sign(approvedTransaction(wallet) as never).tx_blob;
    const hash = hashes.hashSignedTx(blob).toUpperCase();
    actions.refreshPrecheck.mockResolvedValueOnce({ ledgerIndex: 500, sequence: 1, balance: "10" });

    const first = await h.handler(request({ action: "submit", operation_id: OPERATION_ID, tx_blob: blob }));
    const retry = await h.handler(request({ action: "submit", operation_id: OPERATION_ID, tx_blob: blob }));

    expect(first.status).toBe(202);
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ status: "signed_pending", hash });
    expect(store.states.get(wallet.classicAddress)?.status).toBe("signed_pending");
    expect(actions.relay).not.toHaveBeenCalled();
    expect(actions.build).toHaveBeenCalledTimes(1);
    expect(actions.execute).toHaveBeenCalledTimes(1);
  });

  it("never relays when the post-sign validated snapshot regresses behind the build ledger", async () => {
    const wallet = Wallet.generate();
    const store = new MemoryStore();
    const actions = harbor(wallet, store.events);
    const h = harness({ wallet, store, harbor: actions });
    await prepare(h);
    const blob = wallet.sign(approvedTransaction(wallet) as never).tx_blob;
    const hash = hashes.hashSignedTx(blob).toUpperCase();
    actions.refreshPrecheck.mockResolvedValueOnce({ ledgerIndex: 495, sequence: 1, balance: "10" });

    const first = await h.handler(request({ action: "submit", operation_id: OPERATION_ID, tx_blob: blob }));
    const retry = await h.handler(request({ action: "submit", operation_id: OPERATION_ID, tx_blob: blob }));

    expect(first.status).toBe(202);
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ status: "signed_pending", hash });
    expect(actions.relay).not.toHaveBeenCalled();
  });

  it("permits the first relay one ledger before LastLedgerSequence", async () => {
    const wallet = Wallet.generate();
    const store = new MemoryStore();
    const actions = harbor(wallet, store.events);
    const recordTiming = vi.fn();
    const h = harness({ wallet, store, harbor: actions, recordTiming });
    await prepare(h);
    const blob = wallet.sign(approvedTransaction(wallet) as never).tx_blob;
    actions.refreshPrecheck.mockResolvedValueOnce({ ledgerIndex: 499, sequence: 1, balance: "10" });

    const result = await h.handler(request({ action: "submit", operation_id: OPERATION_ID, tx_blob: blob }));

    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ status: "validated", ledger_index: 490 });
    expect(actions.relay).toHaveBeenCalledTimes(1);
    expect(recordTiming.mock.calls.map(([event]) => event)).toEqual([
      {
        operationId: OPERATION_ID,
        refreshAttempt: 0,
        stage: "post_sign_proof_completed",
        at: NOW.toISOString(),
        lastLedgerSequence: 500,
        ledgerIndex: 499,
        remainingLedgers: 1,
      },
      {
        operationId: OPERATION_ID,
        refreshAttempt: 0,
        stage: "harbor_submit_started",
        at: NOW.toISOString(),
        lastLedgerSequence: 500,
      },
      {
        operationId: OPERATION_ID,
        refreshAttempt: 0,
        stage: "harbor_submit_responded",
        at: NOW.toISOString(),
        lastLedgerSequence: 500,
        ledgerIndex: 490,
        engineResult: "tesSUCCESS",
      },
    ]);
  });

  it.each([
    ["advanced sequence", { ledgerIndex: 501, sequence: 2, balance: "10" }],
    ["lower sequence", { ledgerIndex: 501, sequence: 0, balance: "10" }],
    ["changed balance", { ledgerIndex: 501, sequence: 1, balance: "11" }],
  ])("keeps signed reconciliation pending after %s", async (_label, checkpoint) => {
    const wallet = Wallet.generate();
    const store = new MemoryStore();
    const actions = harbor(wallet, store.events);
    actions.relay.mockRejectedValueOnce(new Error("uncertain"));
    const h = harness({ wallet, store, harbor: actions });
    await prepare(h);
    const blob = wallet.sign(approvedTransaction(wallet) as never).tx_blob;
    const hash = hashes.hashSignedTx(blob).toUpperCase();
    await h.handler(request({ action: "submit", operation_id: OPERATION_ID, tx_blob: blob }));
    actions.status.mockResolvedValueOnce({ hash, validated: false });
    actions.refreshPrecheck.mockResolvedValueOnce(checkpoint);

    const result = await h.handler(request({ action: "status", operation_id: OPERATION_ID }));

    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ status: "signed_pending", hash });
    expect(store.states.get(wallet.classicAddress)?.status).toBe("signed_pending");
    expect(actions.relay).toHaveBeenCalledTimes(1);
    expect(actions.build).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["unavailable", new Error("validated ledger unavailable")],
    ["malformed", { ledgerIndex: 501, sequence: Number.NaN, balance: "10" }],
    ["unvalidated", { ledgerIndex: 0, sequence: 1, balance: "10" }],
  ])("keeps signed reconciliation pending when the state proof is %s", async (_label, failure) => {
    const wallet = Wallet.generate();
    const store = new MemoryStore();
    const actions = harbor(wallet, store.events);
    actions.relay.mockRejectedValueOnce(new Error("uncertain"));
    const h = harness({ wallet, store, harbor: actions });
    await prepare(h);
    const blob = wallet.sign(approvedTransaction(wallet) as never).tx_blob;
    const hash = hashes.hashSignedTx(blob).toUpperCase();
    await h.handler(request({ action: "submit", operation_id: OPERATION_ID, tx_blob: blob }));
    actions.status.mockResolvedValueOnce({ hash, validated: false });
    if (failure instanceof Error) actions.refreshPrecheck.mockRejectedValueOnce(failure);
    else actions.refreshPrecheck.mockResolvedValueOnce(failure);

    const result = await h.handler(request({ action: "status", operation_id: OPERATION_ID }));

    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ status: "signed_pending", hash });
    expect(store.states.get(wallet.classicAddress)?.status).toBe("signed_pending");
    expect(actions.relay).toHaveBeenCalledTimes(1);
    expect(actions.build).toHaveBeenCalledTimes(1);
  });

  it("makes an unsigned expired approval terminal without relaying", async () => {
    const wallet = Wallet.generate();
    const store = new MemoryStore();
    const actions = harbor(wallet, store.events);
    actions.execute.mockResolvedValueOnce({
      approvalId: "approval",
      approvalExpiresAt: "2026-10-19T12:00:01.000Z",
      transaction: approvedTransaction(wallet),
    });
    let now = new Date(NOW);
    const h = harness({ wallet, store, harbor: actions, now: () => now });
    await prepare(h);
    now = new Date("2026-10-19T12:00:02.000Z");

    const status = await h.handler(request({ action: "status", operation_id: OPERATION_ID }));
    expect((await status.json()).status).toBe("expired_unsubmitted");
    expect(actions.relay).not.toHaveBeenCalled();
    expect(actions.status).not.toHaveBeenCalled();
  });

  it("explicitly requotes a provably unsigned expired acquisition under the same operation", async () => {
    const wallet = Wallet.generate();
    const store = new MemoryStore();
    const actions = harbor(wallet, store.events);
    actions.execute.mockResolvedValueOnce({
      approvalId: "expired-approval",
      approvalExpiresAt: "2026-10-19T12:00:01.000Z",
      transaction: approvedTransaction(wallet),
    });
    let now = new Date(NOW);
    const h = harness({ wallet, store, harbor: actions, now: () => now });
    const initialPrepared = await (await prepare(h)).json() as Record<string, unknown>;
    const staleBlob = wallet.sign(approvedTransaction(wallet) as never).tx_blob;
    now = new Date("2026-10-19T12:00:02.000Z");
    await h.handler(request({ action: "status", operation_id: OPERATION_ID }));

    const replacement = replacementBuild(wallet);
    actions.refreshPrecheck.mockResolvedValueOnce({ ledgerIndex: 501, sequence: 1, balance: "10" });
    actions.build.mockResolvedValueOnce(replacement);
    actions.execute.mockImplementationOnce(async (
      _owner: string,
      _operationId: string,
      built: { transaction: Record<string, unknown> },
    ) => ({
      approvalId: "replacement-approval",
      approvalExpiresAt: "2026-10-19T12:10:00.000Z",
      transaction: built.transaction,
    }));
    const refreshed = await h.handler(request({ action: "refresh", operation_id: OPERATION_ID }));
    const refreshedBody = await refreshed.json() as Record<string, unknown>;

    expect(refreshed.status).toBe(200);
    expect(refreshedBody).toMatchObject({
      operation_id: OPERATION_ID,
      owner: wallet.classicAddress,
      network: "testnet",
      status: "prepared",
      tx_json: replacement.transaction,
    });
    expect(refreshedBody.approval_binding).not.toBe(initialPrepared.approval_binding);
    expect(actions.build).toHaveBeenCalledTimes(2);
    expect(actions.execute).toHaveBeenCalledTimes(2);
    expect(actions.execute.mock.calls[0]?.[3]).toBe(0);
    expect(actions.execute.mock.calls[1]?.[3]).toBe(1);
    expect(store.states.get(wallet.classicAddress)).toMatchObject({
      operation_id: OPERATION_ID,
      intent_id: `p-live-acquire-rlusd-${OPERATION_ID}`,
      status: "prepared",
      refresh_attempt: 1,
      build_id: replacement.buildId,
      build_tx_json: replacement.transaction,
      quote: replacement.quote,
      account_state: replacement.accountState,
      approval_id: "replacement-approval",
      tx_json: replacement.transaction,
      balance_before: "10",
      balance_before_ledger_index: 501,
      last_ledger_sequence: 505,
    });
    expect(store.states.get(wallet.classicAddress)?.approval_id).not.toBe("expired-approval");

    const stalePreflight = await h.handler(request(signingPreflightBody(initialPrepared)));
    expect(stalePreflight.status).toBe(409);
    expect((await stalePreflight.json()).error.code).toBe("STALE_ACQUISITION_APPROVAL");

    const staleSubmit = await h.handler(request({
      action: "submit",
      operation_id: OPERATION_ID,
      tx_blob: staleBlob,
    }));
    expect(staleSubmit.status).toBe(400);
    expect((await staleSubmit.json()).error.code).toBe("SIGNED_TRANSACTION_MISMATCH");
    expect(actions.relay).not.toHaveBeenCalled();
  });

  it("serializes concurrent refresh retries onto one durable replacement attempt", async () => {
    const wallet = Wallet.generate();
    const store = new MemoryStore();
    const actions = harbor(wallet, store.events);
    actions.execute.mockResolvedValueOnce({
      approvalId: "expired-approval",
      approvalExpiresAt: "2026-10-19T12:00:01.000Z",
      transaction: approvedTransaction(wallet),
    });
    let now = new Date(NOW);
    const h = harness({ wallet, store, harbor: actions, now: () => now });
    await prepare(h);
    now = new Date("2026-10-19T12:00:02.000Z");
    await h.handler(request({ action: "status", operation_id: OPERATION_ID }));

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const replacement = replacementBuild(wallet);
    actions.refreshPrecheck.mockResolvedValueOnce({ ledgerIndex: 501, sequence: 1, balance: "10" });
    actions.build.mockImplementationOnce(async () => {
      await gate;
      return replacement;
    });
    const first = h.handler(request({ action: "refresh", operation_id: OPERATION_ID }));
    await vi.waitFor(() => expect(actions.build).toHaveBeenCalledTimes(2));
    const concurrent = h.handler(request({ action: "refresh", operation_id: OPERATION_ID }));
    release();

    expect((await first).status).toBe(200);
    expect((await concurrent).status).toBe(200);
    expect((await h.handler(request({ action: "refresh", operation_id: OPERATION_ID }))).status).toBe(200);
    expect(actions.build).toHaveBeenCalledTimes(2);
    expect(actions.execute).toHaveBeenCalledTimes(2);
    expect(store.states.get(wallet.classicAddress)?.refresh_attempt).toBe(1);
  });

  it("resumes the same replacement build and attempt key after a prepared-write crash", async () => {
    const wallet = Wallet.generate();
    class RefreshCrashStore extends MemoryStore {
      failReplacementPreparedWrite = false;
      override async save(owner: string, state: AcquisitionState) {
        if (
          state.status === "prepared" && state.refresh_attempt === 1 &&
          this.failReplacementPreparedWrite
        ) {
          this.failReplacementPreparedWrite = false;
          throw new Error("simulated crash after refreshed execute");
        }
        await super.save(owner, state);
      }
    }
    const store = new RefreshCrashStore();
    const actions = harbor(wallet, store.events);
    actions.execute.mockResolvedValueOnce({
      approvalId: "expired-approval",
      approvalExpiresAt: "2026-10-19T12:00:01.000Z",
      transaction: approvedTransaction(wallet),
    });
    let now = new Date(NOW);
    const firstProcess = harness({ wallet, store, harbor: actions, now: () => now });
    await prepare(firstProcess);
    now = new Date("2026-10-19T12:00:02.000Z");
    await firstProcess.handler(request({ action: "status", operation_id: OPERATION_ID }));
    actions.refreshPrecheck.mockResolvedValueOnce({ ledgerIndex: 501, sequence: 1, balance: "10" });
    actions.build.mockResolvedValueOnce(replacementBuild(wallet));
    store.failReplacementPreparedWrite = true;

    const interrupted = await firstProcess.handler(request({ action: "refresh", operation_id: OPERATION_ID }));
    expect(interrupted.status).toBe(500);
    expect(store.states.get(wallet.classicAddress)).toMatchObject({
      status: "built",
      refresh_attempt: 1,
      build_id: "replacement-build-public-id",
    });

    const restarted = harness({ wallet, store, harbor: actions, now: () => now });
    const recovered = await restarted.handler(request({ action: "refresh", operation_id: OPERATION_ID }));
    expect(recovered.status).toBe(200);
    expect((await recovered.json()).status).toBe("prepared");
    expect(actions.build).toHaveBeenCalledTimes(2);
    expect(actions.execute).toHaveBeenCalledTimes(3);
    expect(actions.execute.mock.calls[1]?.[2].buildId).toBe("replacement-build-public-id");
    expect(actions.execute.mock.calls[2]?.[2].buildId).toBe("replacement-build-public-id");
    expect(actions.execute.mock.calls[1]?.[3]).toBe(1);
    expect(actions.execute.mock.calls[2]?.[3]).toBe(1);
  });

  it("rebuilds under the root intent after a crash before replacement persistence", async () => {
    const wallet = Wallet.generate();
    class BuiltWriteCrashStore extends MemoryStore {
      failReplacementBuiltWrite = false;
      override async save(owner: string, state: AcquisitionState) {
        if (
          state.status === "built" && state.refresh_attempt === 1 &&
          this.failReplacementBuiltWrite
        ) {
          this.failReplacementBuiltWrite = false;
          throw new Error("simulated crash before refreshed build persistence");
        }
        await super.save(owner, state);
      }
    }
    const store = new BuiltWriteCrashStore();
    const actions = harbor(wallet, store.events);
    actions.execute.mockResolvedValueOnce({
      approvalId: "expired-approval",
      approvalExpiresAt: "2026-10-19T12:00:01.000Z",
      transaction: approvedTransaction(wallet),
    });
    let now = new Date(NOW);
    const firstProcess = harness({ wallet, store, harbor: actions, now: () => now });
    await prepare(firstProcess);
    now = new Date("2026-10-19T12:00:02.000Z");
    await firstProcess.handler(request({ action: "status", operation_id: OPERATION_ID }));
    const replacement = replacementBuild(wallet);
    actions.refreshPrecheck.mockResolvedValue({ ledgerIndex: 501, sequence: 1, balance: "10" });
    actions.build.mockResolvedValue(replacement);
    store.failReplacementBuiltWrite = true;

    const interrupted = await firstProcess.handler(request({ action: "refresh", operation_id: OPERATION_ID }));
    expect(interrupted.status).toBe(500);
    expect(store.states.get(wallet.classicAddress)).toMatchObject({
      status: "expired_unsubmitted",
      refresh_attempt: 0,
      approval_id: "expired-approval",
    });

    const restarted = harness({ wallet, store, harbor: actions, now: () => now });
    const recovered = await restarted.handler(request({ action: "refresh", operation_id: OPERATION_ID }));
    expect(recovered.status).toBe(200);
    expect(actions.build).toHaveBeenCalledTimes(3);
    expect(actions.build.mock.calls[1]).toEqual([wallet.classicAddress, OPERATION_ID, "xrpl_execution_v1"]);
    expect(actions.build.mock.calls[2]).toEqual([wallet.classicAddress, OPERATION_ID, "xrpl_execution_v1"]);
    expect(actions.execute).toHaveBeenCalledTimes(2);
    expect(actions.execute.mock.calls[1]?.[3]).toBe(1);
  });

  it.each([
    ["ledger has not passed the old deadline", { ledgerIndex: 500 }],
    ["owner sequence changed", { sequence: 2 }],
    ["official RLUSD balance changed", { balanceBefore: "85" }],
  ])("fails closed when refresh cannot prove the old unsigned envelope is dead: %s", async (_label, overrides) => {
    const wallet = Wallet.generate();
    const store = new MemoryStore();
    const actions = harbor(wallet, store.events);
    actions.execute.mockResolvedValueOnce({
      approvalId: "expired-approval",
      approvalExpiresAt: "2026-10-19T12:00:01.000Z",
      transaction: approvedTransaction(wallet),
    });
    let now = new Date(NOW);
    const h = harness({ wallet, store, harbor: actions, now: () => now });
    await prepare(h);
    now = new Date("2026-10-19T12:00:02.000Z");
    await h.handler(request({ action: "status", operation_id: OPERATION_ID }));
    actions.refreshPrecheck.mockResolvedValueOnce({
      ledgerIndex: "ledgerIndex" in overrides ? overrides.ledgerIndex : 501,
      sequence: "sequence" in overrides ? overrides.sequence : 1,
      balance: "balanceBefore" in overrides ? overrides.balanceBefore : "10",
    });

    const result = await h.handler(request({ action: "refresh", operation_id: OPERATION_ID }));
    expect(result.status).toBe(409);
    expect((await result.json()).error.code).toBe("REFRESH_NOT_SAFE");
    expect(store.states.get(wallet.classicAddress)).toMatchObject({
      status: "expired_unsubmitted",
      refresh_attempt: 0,
      approval_id: "expired-approval",
    });
    expect(actions.execute).toHaveBeenCalledTimes(1);
    expect(actions.build).toHaveBeenCalledTimes(1);
    expect(actions.relay).not.toHaveBeenCalled();
  });

  it("refreshes when the old ledger deadline passed even though approval TTL is still open", async () => {
    const wallet = Wallet.generate();
    const store = new MemoryStore();
    const actions = harbor(wallet, store.events);
    const h = harness({ wallet, store, harbor: actions });
    await prepare(h);
    const order: string[] = [];
    const replacement = replacementBuild(wallet);
    actions.refreshPrecheck.mockImplementationOnce(async () => {
      order.push("precheck");
      return { ledgerIndex: 501, sequence: 1, balance: "10" };
    });
    actions.build.mockImplementationOnce(async () => {
      order.push("build");
      return replacement;
    });
    actions.execute.mockImplementationOnce(async (
      _owner: string,
      _operationId: string,
      built: { transaction: Record<string, unknown> },
      attempt: number,
    ) => {
      order.push(`execute:${attempt}`);
      return {
        approvalId: "replacement-approval",
        approvalExpiresAt: "2026-10-19T12:10:00.000Z",
        transaction: built.transaction,
      };
    });

    const result = await h.handler(request({ action: "refresh", operation_id: OPERATION_ID }));
    expect(result.status).toBe(200);
    expect((await result.json()).status).toBe("prepared");
    expect(order).toEqual(["precheck", "build", "execute:1"]);
    expect(actions.build).toHaveBeenLastCalledWith(wallet.classicAddress, OPERATION_ID, "xrpl_execution_v1");
    expect(store.events.slice(-3)).toEqual([
      "save:expired_unsubmitted", "save:built", "save:prepared",
    ]);
  });

  it("never refreshes after signing becomes possible or the operation crosses the point of no return", async () => {
    const wallet = Wallet.generate();
    const store = new MemoryStore();
    const actions = harbor(wallet, store.events);
    const h = harness({ wallet, store, harbor: actions });
    await prepare(h);
    const unexpired = await h.handler(request({ action: "refresh", operation_id: OPERATION_ID }));
    expect(unexpired.status).toBe(409);
    expect(h.actions.build).toHaveBeenCalledTimes(1);

    const blob = h.wallet.sign(approvedTransaction(h.wallet) as never).tx_blob;
    actions.relay.mockRejectedValueOnce(new Error("unknown after send"));
    expect((await h.handler(request({
      action: "submit",
      operation_id: OPERATION_ID,
      tx_blob: blob,
    }))).status).toBe(202);
    const uncertain = await h.handler(request({ action: "refresh", operation_id: OPERATION_ID }));
    expect(uncertain.status).toBe(409);
    expect((await uncertain.json()).status).toBe("signed_pending");
    expect(h.actions.build).toHaveBeenCalledTimes(1);
    expect(h.actions.execute).toHaveBeenCalledTimes(1);
    expect(h.actions.relay).toHaveBeenCalledTimes(1);
  });

  it("permanently closes refresh when an expired transaction is signed but never relays it", async () => {
    const wallet = Wallet.generate();
    const store = new MemoryStore();
    const actions = harbor(wallet, store.events);
    actions.execute.mockResolvedValueOnce({
      approvalId: "expired-approval",
      approvalExpiresAt: "2026-10-19T12:00:01.000Z",
      transaction: approvedTransaction(wallet),
    });
    let now = new Date(NOW);
    const h = harness({ wallet, store, harbor: actions, now: () => now });
    await prepare(h);
    now = new Date("2026-10-19T12:00:02.000Z");
    await h.handler(request({ action: "status", operation_id: OPERATION_ID }));
    const blob = wallet.sign(approvedTransaction(wallet) as never).tx_blob;

    const signed = await h.handler(request({
      action: "submit",
      operation_id: OPERATION_ID,
      tx_blob: blob,
    }));
    expect(signed.status).toBe(202);
    expect(await signed.json()).toMatchObject({
      status: "signed_pending",
      hash: hashes.hashSignedTx(blob).toUpperCase(),
    });
    expect(actions.relay).not.toHaveBeenCalled();

    const forbidden = await h.handler(request({ action: "refresh", operation_id: OPERATION_ID }));
    expect(forbidden.status).toBe(409);
    expect((await forbidden.json()).status).toBe("signed_pending");
    expect(actions.build).toHaveBeenCalledTimes(1);
    expect(actions.execute).toHaveBeenCalledTimes(1);
    expect(actions.relay).not.toHaveBeenCalled();
  });

  it("never refreshes a validated acquisition", async () => {
    const wallet = Wallet.generate();
    const store = new MemoryStore();
    const actions = harbor(wallet, store.events);
    const h = harness({ wallet, store, harbor: actions });
    await prepare(h);
    const blob = wallet.sign(approvedTransaction(wallet) as never).tx_blob;
    const submitted = await h.handler(request({
      action: "submit",
      operation_id: OPERATION_ID,
      tx_blob: blob,
    }));
    expect((await submitted.json()).status).toBe("validated");

    const forbidden = await h.handler(request({ action: "refresh", operation_id: OPERATION_ID }));
    expect(forbidden.status).toBe(409);
    expect(await forbidden.json()).toMatchObject({
      status: "validated",
      hash: hashes.hashSignedTx(blob).toUpperCase(),
    });
    expect(actions.build).toHaveBeenCalledTimes(1);
    expect(actions.execute).toHaveBeenCalledTimes(1);
    expect(actions.relay).toHaveBeenCalledTimes(1);
  });

  it("never returns or persists the API key, signed blob, or wallet secret", async () => {
    const h = harness();
    const prepared = await prepare(h);
    const preparedText = await prepared.text();
    expect(preparedText).not.toContain(READY_ENV.HARBOR_API_KEY);
    expect(preparedText).not.toContain("approval-public-id");
    expect(preparedText).not.toContain("build-public-id");

    const blob = h.wallet.sign(approvedTransaction(h.wallet) as never).tx_blob;
    const submitted = await h.handler(request({ action: "submit", operation_id: OPERATION_ID, tx_blob: blob }));
    const combined = `${await submitted.text()}${JSON.stringify([...h.store.states.values()])}`;
    expect(combined).not.toContain(READY_ENV.HARBOR_API_KEY);
    expect(combined).not.toContain(blob);
    expect(combined).not.toContain(h.wallet.seed ?? "impossible-seed");
  });

  it("HMAC-seals filesystem state and refuses a tampered state file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-rlusd-state-"));
    const wallet = Wallet.generate();
    const actions = harbor(wallet);
    const handler = createRlusdAcquisitionHandler({
      env: { ...READY_ENV, P_LIVE_RLUSD_ACQUISITION_STATE_DIR: directory },
      harbor: actions,
      now: () => new Date(NOW),
      randomUUID: () => OPERATION_ID,
      readSession: () => ({
        version: 1,
        account: wallet.classicAddress,
        network: "testnet",
        expiresAt: Date.now() + 60_000,
      }),
    });
    try {
      expect((await handler(request({ action: "prepare" }))).status).toBe(200);
      const lockFile = (await readdir(directory)).find((entry) => entry.endsWith(".json.lock"));
      expect(lockFile).toBeDefined();
      const tail = await readLockTail(join(directory, lockFile!));
      const persisted = tail.record.state as {
        integrity: string;
        state: AcquisitionState;
      };
      expect(persisted.integrity).toMatch(/^[a-f0-9]{64}$/);
      persisted.state.balance_before = "999";
      await writeFile(tail.path, `${JSON.stringify(tail.record)}\n`, "utf8");

      const result = await handler(request({ action: "status", operation_id: OPERATION_ID }));
      expect(result.status).toBe(409);
      expect((await result.json()).error.code).toBe("OPERATION_IN_PROGRESS");
      expect(actions.status).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fences a stale callback state write after takeover and preserves the successor terminal state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-rlusd-state-takeover-"));
    const wallet = Wallet.generate();
    const actions = harbor(wallet);
    let clock = NOW.getTime();
    let staleSavePaused!: () => void;
    let resumeStaleSave!: () => void;
    const atStaleSave = new Promise<void>((resolve) => { staleSavePaused = resolve; });
    const staleSaveGate = new Promise<void>((resolve) => { resumeStaleSave = resolve; });
    let saves = 0;
    const originalStore = new FileAcquisitionStateStore(directory, SECRET, {
      processInstanceId: "41234567-89ab-4cde-8f01-23456789abcd",
      leaseMs: 60,
      heartbeatMs: 10,
      now: () => clock,
      beforePublish: async (kind) => {
        if (kind === "save" && ++saves === 3) {
          staleSavePaused();
          await staleSaveGate;
        }
      },
    });
    const createHandler = (stateStore: FileAcquisitionStateStore) =>
      createRlusdAcquisitionHandler({
        env: { ...READY_ENV, P_LIVE_RLUSD_ACQUISITION_STATE_DIR: directory },
        harbor: actions,
        now: () => new Date(clock),
        randomUUID: () => OPERATION_ID,
        readSession: () => ({
          version: 1,
          account: wallet.classicAddress,
          network: "testnet",
          expiresAt: clock + 60_000,
        }),
        stateStore,
      });
    const originalHandler = createHandler(originalStore);
    let stalePrepare: Promise<Response> | undefined;
    try {
      stalePrepare = originalHandler(request({ action: "prepare" }));
      await atStaleSave;
      clock += 100;

      const successorStore = new FileAcquisitionStateStore(directory, SECRET, {
        processInstanceId: "51234567-89ab-4cde-8f01-23456789abcd",
        leaseMs: 60,
        heartbeatMs: 10,
        now: () => clock,
      });
      const successorHandler = createHandler(successorStore);
      expect((await successorHandler(request({ action: "prepare" }))).status).toBe(200);
      const blob = wallet.sign(approvedTransaction(wallet) as never).tx_blob;
      const expectedHash = hashes.hashSignedTx(blob).toUpperCase();
      const submitted = await successorHandler(request({
        action: "submit",
        operation_id: OPERATION_ID,
        tx_blob: blob,
      }));
      expect(submitted.status).toBe(200);
      expect((await submitted.json()).status).toBe("validated");

      resumeStaleSave();
      const staleResult = await stalePrepare;
      expect(staleResult.status).toBe(500);

      const status = await successorHandler(request({
        action: "status",
        operation_id: OPERATION_ID,
      }));
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({ status: "validated", hash: expectedHash });

      await expect(successorStore.withOwnerLock(wallet.classicAddress, async () => {
        const terminal = await successorStore.load(wallet.classicAddress);
        expect(terminal?.status).toBe("validated");
        await successorStore.save(wallet.classicAddress, {
          ...terminal!,
          status: "prepared",
          updated_at: new Date(clock + 1).toISOString(),
        });
      })).rejects.toThrow(/validated -> prepared|Unsigned acquisition state/i);
    } finally {
      resumeStaleSave?.();
      await stalePrepare?.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("strictly rejects malformed or over-specified action bodies", async () => {
    const h = harness();
    for (const body of [
      {},
      { action: "prepare", operation_id: OPERATION_ID },
      { action: "refresh" },
      { action: "refresh", operation_id: OPERATION_ID, tx_blob: "ABCD" },
      { action: "status" },
      { action: "submit", operation_id: OPERATION_ID },
      { action: "retry", operation_id: OPERATION_ID },
    ]) {
      const result = await h.handler(request(body));
      expect(result.status).toBe(400);
    }
    expect(h.actions.build).not.toHaveBeenCalled();
  });
});
