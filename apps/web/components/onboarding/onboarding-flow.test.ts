import { DEFAULT_POLICY, type AccountLink, type Envelope } from "@pilot/contracts";
import type { HarborClient, HarborOpName, ResultFor } from "@pilot/harbor-client";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PERMISSIONS,
  TerminalOnboardingSubmissionError,
  acquisitionPreflightChanged,
  acquisitionFaucetRequestBody,
  acquisitionRecoveryHint,
  assertOfficialLiveDevRlusdConfig,
  assertSafeDelegateSet,
  assertSafeRevoke,
  assertSafeTrustSet,
  authorizePersistAndSubmitDirectTrustSet,
  clearPersistedOnboardingPending,
  clearTerminalPendingSubmission,
  confirmLiveOnboardingTrustExecutionCapability,
  confirmPreparedLiveOnboardingPolicy,
  consumeExactOnboardingRevokeAction,
  devFundRequestBody,
  dispatchRequestedOnboardingRevocation,
  defaultOnboardingWalletProvider,
  ensureExactOnboardingPolicy,
  executePreparedLiveOnboardingTrust,
  hasExactOnboardingPermissions,
  hasExactConfiguredTrustLine,
  hasPersistedPendingDelegate,
  hasPersistedPendingSubmission,
  hasUnresolvedDelegateApproval,
  finalizeVerifiedRevocationWallet,
  finalizeValidatedOnboardingRevocation,
  hasVerifiedRevocationContext,
  isExtensionWalletProvider,
  ledgerDelegateSetBlindSigningMessage,
  nextStepAfterValidatedTrust,
  nextStepAfterModelAccess,
  nextStepAfterWalletAuthentication,
  pendingSubmissionRecord,
  parseAcquisitionRecoveryHint,
  parseOnboardingReadinessHint,
  parseRlusdAcquisitionRouteState,
  parseStoredActiveOnboardingRecord,
  parseStoredOnboardingTrustApproval,
  parseStoredPendingSubmission,
  preflightPreparedOnboardingRevocation,
  prepareLiveOnboardingTrust,
  prepareOnboardingRevocation,
  recoverRlusdAcquisition,
  requireActivatedDelegateAccount,
  requireLiveOnboardingReadiness,
  requiresDevRevocationBeforeExit,
  revocationApprovalAction,
  restoreActiveOnboardingLink,
  restoreLedgerOnboardingWithoutDevice,
  requireActivatedAccount,
  rlusdAcquisitionRecoveryRequestBody,
  rlusdAcquisitionPreflightRequestBody,
  rlusdAcquisitionRequestBody,
  shouldUseLiveDevAcquisition,
  shouldOfferRevocationRecovery,
  shouldSuppressOnboardingRestoration,
  shouldShowSimulatedLedgerReplay,
  supportsOnboardingRevocation,
  storedActiveOnboardingRecord,
  storedOnboardingWalletSession,
  submitPreparedOnboardingRevocation,
  waitForActiveOnboardingLink,
  waitForValidatedDirectTrustSet,
  waitForValidatedRlusdAcquisition,
  waitForValidatedSubmission,
  waitForRevokedOnboardingLink,
  walletFirstSessionMetadata,
  walletProviderUnavailableReason,
  walletViewportUnavailableReason,
  shouldLoadOnboardingModels,
  type OnboardingWallet,
} from "./onboarding-flow";
import { signOnlyAfterPreflight } from "../approval/approval-modal";

function ok<T>(data: T): Envelope<T> {
  return {
    ok: true,
    data,
    asOf: "2026-10-18T00:00:00.000Z",
    asOfBasis: "test",
  } as Envelope<T>;
}

function error(message: string): Envelope<never> {
  return { ok: false, error: { service: "harbor", kind: "error", message } };
}

function clientWith(
  implementation: (name: HarborOpName, args: unknown) => Promise<Envelope<unknown>>,
): HarborClient {
  return {
    op: implementation as <K extends HarborOpName>(
      name: K,
      args: unknown,
    ) => Promise<Envelope<ResultFor<K>>>,
  } as HarborClient;
}

const activeLink: AccountLink = {
  owner: "rOwner",
  network: "testnet",
  delegate: "rDelegate",
  permissions: [...DEFAULT_PERMISSIONS],
  status: "active",
};

describe("simulated Ledger onboarding replay gate", () => {
  it("appears only for logged-out demo mode before any account is discovered", () => {
    expect(shouldShowSimulatedLedgerReplay("demo", {})).toBe(true);
    expect(shouldShowSimulatedLedgerReplay("openrouter", {})).toBe(false);
    expect(shouldShowSimulatedLedgerReplay("demo", { 0: "rDiscovered" })).toBe(false);
    expect(shouldShowSimulatedLedgerReplay("openrouter", { 0: "rDiscovered" })).toBe(false);
  });
});

describe("wallet-first model access gate", () => {
  const account = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
  const publicConfig = {
    network: "testnet" as const,
    stableAsset: {
      currency: "524C555344000000000000000000000000000000",
      issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
    },
    devSignerEnabled: false,
    walletActionProofRequired: true,
    walletActionProofConfigured: true,
    mockMode: false,
    ledger: { enabled: false, transports: [], defaultAccountIndex: 0 },
  };
  const storedWallet = JSON.stringify({
    provider: "gemwallet",
    network: "testnet",
    account,
  });

  it("does not load any model catalog until the authenticated wallet reaches the AI step", () => {
    expect(shouldLoadOnboardingModels("wallet", false)).toBe(false);
    expect(shouldLoadOnboardingModels("wallet", true)).toBe(false);
    expect(shouldLoadOnboardingModels("ai", false)).toBe(false);
    expect(shouldLoadOnboardingModels("ai", true)).toBe(true);
    expect(shouldLoadOnboardingModels("access", true)).toBe(false);
    expect(shouldLoadOnboardingModels("fund", true)).toBe(false);
  });

  it("finishes basic readiness before optional trading setup", () => {
    expect(nextStepAfterWalletAuthentication()).toBe("ai");
    expect(nextStepAfterModelAccess()).toBe("access");
  });

  it("suppresses automatic restoration only for the explicit sign-out marker", () => {
    expect(shouldSuppressOnboardingRestoration("?wallet=signed-out")).toBe(true);
    expect(shouldSuppressOnboardingRestoration("?wallet=signed-out&openrouter=error")).toBe(true);
    expect(shouldSuppressOnboardingRestoration("?wallet=connected")).toBe(false);
    expect(shouldSuppressOnboardingRestoration("")).toBe(false);
  });

  it("accepts only exact, unexpired server and browser wallet metadata after OAuth", () => {
    expect(walletFirstSessionMetadata({
      authenticated: true,
      account,
      network: "testnet",
      expiresAt: 2_000,
    }, storedWallet, publicConfig, 1_000)).toEqual({ provider: "gemwallet", account });

    expect(() => walletFirstSessionMetadata({
      authenticated: false,
    }, storedWallet, publicConfig, 1_000)).toThrow("Reconnect the exact wallet");
    expect(() => walletFirstSessionMetadata({
      authenticated: true,
      account,
      network: "testnet",
      expiresAt: 999,
    }, storedWallet, publicConfig, 1_000)).toThrow("Reconnect the exact wallet");
    expect(() => walletFirstSessionMetadata({
      authenticated: true,
      account: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
      network: "testnet",
      expiresAt: 2_000,
    }, storedWallet, publicConfig, 1_000)).toThrow("Reconnect the exact wallet");
    expect(() => walletFirstSessionMetadata({
      authenticated: true,
      account,
      network: "devnet",
      expiresAt: 2_000,
    }, storedWallet, publicConfig, 1_000)).toThrow("Reconnect the exact wallet");
  });

  it("enforces provider policy when restoring an OAuth-return wallet", () => {
    const session = {
      authenticated: true as const,
      account,
      network: "testnet" as const,
      expiresAt: 2_000,
    };
    const stored = (provider: string, extra: object = {}) => JSON.stringify({
      provider,
      network: "testnet",
      account,
      ...extra,
    });

    expect(() => walletFirstSessionMetadata(
      session,
      stored("dev"),
      publicConfig,
      1_000,
    )).toThrow("development wallet cannot be restored");
    expect(() => walletFirstSessionMetadata(
      session,
      stored("ledger", { ledger: { transport: "webhid", accountIndex: 0 } }),
      publicConfig,
      1_000,
    )).toThrow("Ledger transport is not enabled");
    expect(() => walletFirstSessionMetadata(
      session,
      stored("xaman"),
      publicConfig,
      1_000,
    )).toThrow("Xaman needs an app API key");
  });

  it("keeps Xaman unavailable without constructing its adapter", () => {
    expect(walletProviderUnavailableReason("xaman")).toMatch(/app API key/i);
    expect(walletProviderUnavailableReason("xaman")).toMatch(/non-broadcast/i);
    expect(walletProviderUnavailableReason("gemwallet")).toBeUndefined();
    expect(walletProviderUnavailableReason("crossmark")).toBeUndefined();
  });

  it("keeps wallet controls disabled until a desktop viewport is positively resolved", () => {
    expect(walletViewportUnavailableReason("checking")).toMatch(/checking/i);
    expect(walletViewportUnavailableReason("small-screen")).toMatch(/small-screen/i);
    expect(walletViewportUnavailableReason("desktop")).toBeUndefined();
  });
});

describe("desktop extension preflight", () => {
  it("identifies only the two supported desktop extension adapters", () => {
    expect(isExtensionWalletProvider("gemwallet")).toBe(true);
    expect(isExtensionWalletProvider("crossmark")).toBe(true);
    expect(isExtensionWalletProvider("ledger")).toBe(false);
    expect(isExtensionWalletProvider("dev")).toBe(false);
    expect(isExtensionWalletProvider("xaman")).toBe(false);
  });
});

describe("onboarding live transaction gates", () => {
  const trustAccount = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
  const trustIssuer = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
  const trustHash = "A".repeat(64);
  const trustAction = {
    kind: "trust" as const,
    build: {
      build_id: "trust",
      network: "testnet" as const,
      tx_json: {
        TransactionType: "TrustSet",
        Account: trustAccount,
        LimitAmount: { currency: "524C555344000000000000000000000000000000", issuer: trustIssuer, value: "10000" },
        Fee: "12",
        Sequence: 42,
        LastLedgerSequence: 1_020,
      },
      delegable: true,
      simulate: { engine_result: "tesSUCCESS", engine_result_message: "ok", applied: false as const },
      preflight: [{ check: "schema", pass: true }],
      summary: { action: "Trust", account: trustAccount, amounts: [], fee_drops: "12", reserve_delta_drops: "0" },
    },
  };

  it("does not persist a resumable TrustSet when pre-submit authorization rejects an expired transaction", async () => {
    const storage = { setItem: vi.fn() };
    const transport = vi.fn(async () => {
      throw new Error("The signed TrustSet no longer has a safe validated-ledger window.");
    });

    await expect(authorizePersistAndSubmitDirectTrustSet(
      "SIGNED",
      trustHash,
      trustAction,
      trustAccount,
      "testnet",
      storage,
      transport,
    )).rejects.toThrow("safe validated-ledger window");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith({ action: "authorize", tx_blob: "SIGNED" });
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("persists after authorization and reconnects by hash after an uncertain submit failure", async () => {
    const values = new Map<string, string>();
    const storage = {
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ hash: trustHash, network: "testnet", validated: false })
      .mockRejectedValueOnce(new Error("provider response was lost"));

    await expect(authorizePersistAndSubmitDirectTrustSet(
      "SIGNED",
      trustHash,
      trustAction,
      trustAccount,
      "testnet",
      storage,
      transport,
    )).rejects.toThrow("provider response was lost");
    const stored = parseStoredPendingSubmission(
      values.get("pilot:onboarding-pending") ?? null,
      trustAccount,
      "testnet",
    );
    expect(stored).toMatchObject({ kind: "trust", hash: trustHash, lastLedgerSequence: 1_020 });
    expect(transport.mock.invocationCallOrder[0]).toBeLessThan(storage.setItem.mock.invocationCallOrder[0]);
    expect(storage.setItem.mock.invocationCallOrder[0]).toBeLessThan(transport.mock.invocationCallOrder[1]);

    const fetchImpl = vi.fn(async () => Response.json({
      hash: trustHash,
      network: "testnet",
      validated: true,
      ledger_index: 1_011,
      engine_result: "tesSUCCESS",
    }));
    await expect(waitForValidatedDirectTrustSet(
      clientWith(async () => ok({
        account: trustAccount,
        ledger_index: 1_011,
        validated: true,
        lines: [{
          account: trustIssuer,
          balance: "0",
          currency: "RLUSD",
          limit: "10000",
          limit_peer: "0",
        }],
      })),
      { hash: stored!.hash, network: "testnet", validated: false },
      trustAccount,
      "testnet",
      { currency: "RLUSD", issuer: trustIssuer },
      stored!.lastLedgerSequence,
      { attempts: 1 },
      fetchImpl as typeof fetch,
    )).resolves.toEqual({ status: "validated", hash: trustHash });
  });

  it("polls a pending submit until the transaction validates", async () => {
    const op = vi
      .fn()
      .mockResolvedValueOnce(ok({ hash: "ABC", network: "testnet", validated: false }))
      .mockResolvedValueOnce(
        ok({
          hash: "ABC",
          network: "testnet",
          validated: true,
          ledger_index: 123,
          engine_result: "tesSUCCESS",
          result: "success",
        }),
      );
    const harbor = clientWith(op);

    await expect(
      waitForValidatedSubmission(
        harbor,
        { hash: "ABC", validated: false },
        "rOwner",
        "testnet",
        undefined,
        { attempts: 3, delayMs: 0, sleep: async () => undefined },
      ),
    ).resolves.toEqual({ status: "validated", hash: "ABC" });
    expect(op).toHaveBeenCalledTimes(2);
    expect(op).toHaveBeenCalledWith("tx.status", { hash: "ABC", account: "rOwner", network: "testnet" });
  });

  it("does not treat a persistently pending transaction as complete", async () => {
    const harbor = clientWith(async () => ok({ hash: "ABC", network: "testnet", validated: false }));
    await expect(
      waitForValidatedSubmission(
        harbor,
        { hash: "ABC", validated: false },
        "rOwner",
        "testnet",
        undefined,
        { attempts: 2, delayMs: 0, sleep: async () => undefined },
      ),
    ).resolves.toEqual({ status: "pending", hash: "ABC" });
  });

  it("resumes a known pending hash until late validation without another submit", async () => {
    const op = vi
      .fn()
      .mockResolvedValueOnce(ok({ hash: "ABC", network: "testnet", validated: false }))
      .mockResolvedValueOnce(ok({
        hash: "ABC",
        network: "testnet",
        validated: true,
        ledger_index: 124,
        engine_result: "tesSUCCESS",
        result: "success",
      }));
    const harbor = clientWith(op);
    const submission = { hash: "ABC", validated: false } as const;
    await expect(waitForValidatedSubmission(
      harbor, submission, "rOwner", "testnet", undefined,
      { attempts: 1, delayMs: 0, sleep: async () => undefined },
    )).resolves.toEqual({ status: "pending", hash: "ABC" });
    await expect(waitForValidatedSubmission(
      harbor, submission, "rOwner", "testnet", undefined,
      { attempts: 1, delayMs: 0, sleep: async () => undefined },
    )).resolves.toEqual({ status: "validated", hash: "ABC" });
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("polls TrustSet through the direct provider route and verifies the exact trust line", async () => {
    const hash = "A".repeat(64);
    const issuer = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
    const op = vi.fn().mockResolvedValue(ok({
      account: "rOwner",
      ledger_index: 124,
      validated: true,
      lines: [{
        account: issuer,
        balance: "0",
        currency: "RLUSD",
        limit: "10000",
        limit_peer: "0",
      }],
    }));
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ action: "status", hash });
      return Response.json({
        hash,
        network: "testnet",
        validated: true,
        ledger_index: 124,
        engine_result: "tesSUCCESS",
      });
    });
    await expect(waitForValidatedDirectTrustSet(
      clientWith(op),
      { hash, network: "testnet", validated: false },
      "rOwner", "testnet", { currency: "RLUSD", issuer }, 130,
      { attempts: 1 }, fetchImpl as typeof fetch,
    )).resolves.toEqual({ status: "validated", hash });
    expect(op).toHaveBeenCalledWith("ledger.account.lines", {
      account: "rOwner",
      network: "testnet",
      ledger_index: "validated",
      peer: issuer,
    });
    expect(op).not.toHaveBeenCalledWith("tx.status", expect.anything());
  });

  it("refuses a validated TrustSet without tesSUCCESS", async () => {
    const hash = "B".repeat(64);
    const fetchImpl = vi.fn(async () => Response.json({
      hash,
      network: "testnet",
      validated: true,
      ledger_index: 124,
      engine_result: "tecNO_LINE_INSUF_RESERVE",
    }));
    await expect(waitForValidatedDirectTrustSet(
      clientWith(vi.fn()),
      { hash, network: "testnet", validated: false },
      "rOwner", "testnet",
      { currency: "RLUSD", issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" },
      130, { attempts: 1 }, fetchImpl as typeof fetch,
    )).rejects.toThrow("not tesSUCCESS");
  });

  it("refuses a pending submission after LastLedgerSequence expires", async () => {
    const op = vi
      .fn()
      .mockResolvedValueOnce(ok({ hash: "ABC", network: "testnet", validated: false }))
      .mockResolvedValueOnce(ok({ account: "rOwner", ledger_index: 201, validated: true, account_data: {} }));
    const cause = await waitForValidatedSubmission(
      clientWith(op),
      { hash: "ABC", validated: false },
      "rOwner", "testnet", 200,
      { attempts: 2, delayMs: 0, sleep: async () => undefined },
    ).catch((error: unknown) => error);
    expect(cause).toBeInstanceOf(Error);
    expect(String(cause)).toContain("expired before validation");
    const storage = { removeItem: vi.fn() };
    expect(clearTerminalPendingSubmission(cause, "delegate", storage)).toBe("delegate");
    expect(storage.removeItem).toHaveBeenCalledWith("pilot:onboarding-pending");
  });

  it("clears an expired resumed TrustSet so onboarding can rebuild it", async () => {
    const hash = "C".repeat(64);
    const issuer = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
    const fetchImpl = vi.fn(async () => Response.json({
      hash,
      network: "testnet",
      validated: false,
    }));
    const cause = await waitForValidatedDirectTrustSet(
      clientWith(async () => ok({
        account: "rOwner",
        ledger_index: 201,
        validated: true,
        account_data: {},
      })),
      { hash, network: "testnet", validated: false },
      "rOwner",
      "testnet",
      { currency: "RLUSD", issuer },
      200,
      { attempts: 1 },
      fetchImpl as typeof fetch,
    ).catch((error: unknown) => error);
    expect(cause).toBeInstanceOf(Error);
    expect(String(cause)).toContain("expired before validation");
    const storage = { removeItem: vi.fn() };
    expect(clearTerminalPendingSubmission(cause, "trust", storage)).toBe("fund");
    expect(storage.removeItem).toHaveBeenCalledWith("pilot:onboarding-pending");
  });

  it("clears a ledger-expired TrustSet even when its status capability is missing", async () => {
    const hash = "D".repeat(64);
    const fetchImpl = vi.fn(async () => Response.json(
      { error: { message: "TrustSet status authorization is required." } },
      { status: 401 },
    ));
    const cause = await waitForValidatedDirectTrustSet(
      clientWith(async () => ok({
        account: "rOwner",
        ledger_index: 201,
        validated: true,
        account_data: {},
      })),
      { hash, network: "testnet", validated: false },
      "rOwner",
      "testnet",
      { currency: "RLUSD", issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" },
      200,
      { attempts: 1 },
      fetchImpl as typeof fetch,
    ).catch((error: unknown) => error);
    expect(cause).toBeInstanceOf(TerminalOnboardingSubmissionError);
    expect(String(cause)).toContain("expired before validation");
    const storage = { removeItem: vi.fn() };
    expect(clearTerminalPendingSubmission(cause, "trust", storage)).toBe("fund");
    expect(storage.removeItem).toHaveBeenCalledWith("pilot:onboarding-pending");
  });

  it("retains a TrustSet status failure while its validated ledger window is live", async () => {
    const hash = "E".repeat(64);
    const fetchImpl = vi.fn(async () => Response.json(
      { error: { message: "TrustSet status authorization is required." } },
      { status: 401 },
    ));
    const cause = await waitForValidatedDirectTrustSet(
      clientWith(async () => ok({
        account: "rOwner",
        ledger_index: 199,
        validated: true,
        account_data: {},
      })),
      { hash, network: "testnet", validated: false },
      "rOwner",
      "testnet",
      { currency: "RLUSD", issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" },
      200,
      { attempts: 1 },
      fetchImpl as typeof fetch,
    ).catch((error: unknown) => error);
    expect(cause).toBeInstanceOf(Error);
    expect(cause).not.toBeInstanceOf(TerminalOnboardingSubmissionError);
    expect(String(cause)).toContain("status authorization is required");
    const storage = { removeItem: vi.fn() };
    expect(clearTerminalPendingSubmission(cause, "trust", storage)).toBeUndefined();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it("retains a pending hash for retryable transport failures", () => {
    const storage = { removeItem: vi.fn() };
    expect(clearTerminalPendingSubmission(new Error("provider unavailable"), "trust", storage)).toBeUndefined();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it("waits for active status and requires exactly the seven expected permissions", async () => {
    const op = vi
      .fn()
      .mockResolvedValueOnce(ok({ ...activeLink, status: "pending" }))
      .mockResolvedValueOnce(ok(activeLink))
      .mockResolvedValueOnce(ok({
        account: "rOwner",
        ledger_index_min: 1,
        ledger_index_max: 2,
        transactions: [{
          hash: "HASH",
          validated: true,
          tx: { TransactionType: "DelegateSet", Account: "rOwner", Authorize: "rDelegate" },
          meta: { TransactionResult: "tesSUCCESS" },
        }],
      }));
    await expect(
      waitForActiveOnboardingLink(clientWith(op), "rOwner", "testnet", "rDelegate", "HASH", {
        attempts: 3,
        delayMs: 0,
        sleep: async () => undefined,
      }),
    ).resolves.toEqual(activeLink);
    expect(hasExactOnboardingPermissions(activeLink)).toBe(true);
    expect(
      hasExactOnboardingPermissions({
        ...activeLink,
        permissions: [...DEFAULT_PERMISSIONS.slice(0, 6), "Payment"],
      }),
    ).toBe(false);
    expect(
      hasExactOnboardingPermissions({
        ...activeLink,
        permissions: [...DEFAULT_PERMISSIONS].reverse(),
      }),
    ).toBe(false);
  });

  it("refuses revoked links and active links with the wrong permission set", async () => {
    await expect(
      waitForActiveOnboardingLink(
        clientWith(async () => ok({ ...activeLink, status: "revoked" })),
        "rOwner",
        "testnet",
        "rDelegate",
        "HASH",
        { attempts: 1 },
      ),
    ).rejects.toThrow("revoked");
    await expect(
      waitForActiveOnboardingLink(
        clientWith(async () => ok({ ...activeLink, permissions: ["OfferCreate"] })),
        "rOwner",
        "testnet",
        "rDelegate",
        "HASH",
        { attempts: 1 },
      ),
    ).rejects.toThrow("exactly the seven required permissions");
  });

  it("refuses an active concurrent delegate even with the right permissions", async () => {
    await expect(waitForActiveOnboardingLink(
      clientWith(async () => ok({ ...activeLink, delegate: "rDifferent" })),
      "rOwner", "testnet", "rDelegate", "HASH", { attempts: 1 },
    )).rejects.toThrow("different delegate");
  });
});

describe("live local onboarding contract", () => {
  const account = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
  const delegate = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
  const issuer = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
  const policy = {
    ...DEFAULT_POLICY,
    allowed_tx_types: [...DEFAULT_PERMISSIONS],
    issuer_allowlist: [...DEFAULT_POLICY.issuer_allowlist],
    networks: [...DEFAULT_POLICY.networks],
  };
  const link: AccountLink = {
    owner: account,
    network: "testnet",
    delegate,
    permissions: [...DEFAULT_PERMISSIONS],
    status: "active",
  };
  const build = {
    build_id: "build-trust-live",
    network: "testnet" as const,
    tx_json: {
      TransactionType: "TrustSet",
      Account: account,
      LimitAmount: {
        currency: "524C555344000000000000000000000000000000",
        issuer,
        value: "10000",
      },
      Fee: "12",
      Sequence: 42,
      LastLedgerSequence: 1_020,
    },
    delegable: true,
    simulate: {
      engine_result: "tesSUCCESS",
      engine_result_message: "ok",
      applied: false as const,
    },
    preflight: [{ check: "schema", pass: true }],
    summary: {
      action: "Create RLUSD trust line",
      account,
      amounts: ["10000 RLUSD limit"],
      fee_drops: "12",
      reserve_delta_drops: "0",
    },
  };

  it("sets and reads back the exact seven-permission policy before building", async () => {
    const op = vi.fn(async (name: HarborOpName) => {
      if (name === "policy.set" || name === "policy.get") return ok(policy);
      throw new Error(`unexpected op ${name}`);
    });
    await expect(ensureExactOnboardingPolicy(clientWith(op), account, "testnet"))
      .resolves.toEqual(policy);
    expect(op).toHaveBeenNthCalledWith(1, "policy.set", {
      owner: account,
      network: "testnet",
      policy,
    });
    expect(op).toHaveBeenNthCalledWith(2, "policy.get", {
      owner: account,
      network: "testnet",
    });
  });

  it("fails closed during separately confirmed policy setup when readback differs", async () => {
    const prepared = {
      status: "prepared" as const,
      action: { kind: "trust" as const, build, intentId: "onboarding-trust-rlusd", expectedDelegate: delegate },
    };
    const op = vi.fn(async (name: HarborOpName) => {
      if (name === "policy.set") return ok(policy);
      if (name === "policy.get") return ok({ ...policy, execute_under_usd: 251 });
      throw new Error(`unexpected op ${name}`);
    });
    await expect(confirmPreparedLiveOnboardingPolicy(
      clientWith(op),
      link,
      prepared,
    )).rejects.toThrow("did not match the exact approved onboarding policy");
    expect(op).not.toHaveBeenCalledWith("tx.trustSet", expect.anything());
    expect(op).not.toHaveBeenCalledWith("tx.execute", expect.anything());
  });

  it("requires validated external funding of the returned delegate", async () => {
    await expect(requireActivatedDelegateAccount(
      clientWith(async () => error("account not found")),
      { ...link, status: "pending" },
    )).rejects.toThrow(`Fund Harbor delegate ${delegate} with Testnet XRP outside Harbor`);

    const op = vi.fn(async () => ok({
      account: delegate,
      ledger_index: 1_000,
      validated: true,
      account_data: { Account: delegate, Sequence: 1 },
    }));
    await expect(requireActivatedDelegateAccount(
      clientWith(op),
      { ...link, status: "pending" },
    )).resolves.toBeUndefined();
    expect(op).toHaveBeenCalledWith("ledger.account.info", {
      account: delegate,
      network: "testnet",
      ledger_index: "validated",
    });
  });

  it("requires every authenticated Harbor readiness check and exact evidence", async () => {
    const hash = "A".repeat(64);
    const ready = {
      ready: true,
      scope: { owner: account, network: "testnet" as const },
      checks: {
        reviewed_runtime: true,
        exact_active_link: true,
        exact_persisted_policy: true,
        usable_encrypted_delegate: true,
        validated_trust_set: true,
        usable_trust_line: true,
      },
      evidence: {
        delegate,
        link_ledger_index: 1_001,
        trust_set_hash: hash,
        trust_set_ledger_index: 1_002,
        trust_line_ledger_index: 1_003,
      },
    };
    const op = vi.fn(async () => ok(ready));
    await expect(requireLiveOnboardingReadiness(clientWith(op), link, hash))
      .resolves.toBeUndefined();
    expect(op).toHaveBeenCalledWith("onboarding.readiness", {
      owner: account,
      network: "testnet",
      expected_policy: policy,
      trust_set_hash: hash,
    });
    expect(parseOnboardingReadinessHint(JSON.stringify({
      version: 1,
      account,
      network: "testnet",
      trust_set_hash: hash,
    }), account)).toEqual({ version: 1, account, network: "testnet", trust_set_hash: hash });
    expect(parseOnboardingReadinessHint(JSON.stringify({
      version: 1,
      account,
      network: "testnet",
      trust_set_hash: hash,
      tx_blob: "NEVER",
    }), account)).toBeUndefined();

    await expect(requireLiveOnboardingReadiness(
      clientWith(async () => ok({
        ...ready,
        ready: false,
        checks: { ...ready.checks, usable_encrypted_delegate: false },
      })),
      link,
      hash,
    )).rejects.toThrow("did not attest the exact local onboarding handoff as ready");

    await expect(requireLiveOnboardingReadiness(
      clientWith(async () => ok({
        ...ready,
        evidence: { ...ready.evidence, trust_line_ledger_index: undefined },
      })),
      link,
      hash,
    )).rejects.toThrow("did not attest the exact local onboarding handoff as ready");
  });

  it("prepares by reading and building only, without policy mutation or execution", async () => {
    const op = vi.fn(async (name: HarborOpName) => {
      if (name === "policy.get") return ok({ ...policy, execute_under_usd: 1 });
      if (name === "tx.trustSet") return ok(build);
      if (name === "ledger.account.info") {
        return ok({
          account,
          ledger_index: 1_000,
          validated: true,
          account_data: { Account: account, Sequence: 42 },
        });
      }
      throw new Error(`preparation must not call ${name}`);
    });
    const result = await prepareLiveOnboardingTrust(
      clientWith(op),
      link,
      { currency: "RLUSD", issuer },
    );
    expect(op.mock.calls.map(([name]) => name)).toEqual([
      "policy.get",
      "tx.trustSet",
      "ledger.account.info",
    ]);
    expect(op).not.toHaveBeenCalledWith("policy.set", expect.anything());
    expect(op).not.toHaveBeenCalledWith("tx.execute", expect.anything());
    expect(op).not.toHaveBeenCalledWith("tx.submit", expect.anything());
    expect(result).toMatchObject({
      status: "prepared",
      action: {
        kind: "trust",
        intentId: "onboarding-trust-rlusd",
        expectedDelegate: delegate,
        build: { tx_json: build.tx_json },
      },
    });
  });

  it("requires separate policy and execution confirmations before tx.execute", async () => {
    const expiresAt = "2099-01-01T00:00:00.000Z";
    const prepared = {
      status: "prepared" as const,
      action: { kind: "trust" as const, build, intentId: "onboarding-trust-rlusd", expectedDelegate: delegate },
    };
    const policyOp = vi.fn(async (name: HarborOpName) => {
      if (name === "policy.set" || name === "policy.get") return ok(policy);
      throw new Error(`policy confirmation must not call ${name}`);
    });
    const confirmed = await confirmPreparedLiveOnboardingPolicy(
      clientWith(policyOp),
      link,
      prepared,
    );
    expect(policyOp.mock.calls.map(([name]) => name)).toEqual(["policy.set", "policy.get"]);
    expect(policyOp).not.toHaveBeenCalledWith("tx.execute", expect.anything());

    const prematureOp = vi.fn(async () => {
      throw new Error("premature execution reached Harbor");
    });
    await expect(executePreparedLiveOnboardingTrust(
      clientWith(prematureOp),
      link,
      { currency: "RLUSD", issuer },
      prepared as never,
      vi.fn(),
    )).rejects.toThrow("prepared TrustSet no longer matches");
    expect(prematureOp).not.toHaveBeenCalled();

    const stalePolicyOp = vi.fn(async (name: HarborOpName) => {
      if (name === "account.status") return ok(link);
      if (name === "policy.get") return ok({ ...policy, execute_under_usd: 1 });
      throw new Error(`stale policy must block before ${name}`);
    });
    const staleConfirmation = vi.fn(async () => undefined);
    await expect(executePreparedLiveOnboardingTrust(
      clientWith(stalePolicyOp),
      link,
      { currency: "RLUSD", issuer },
      confirmed,
      staleConfirmation,
    )).rejects.toThrow("policy changed after TrustSet preparation");
    expect(staleConfirmation).not.toHaveBeenCalled();
    expect(stalePolicyOp).not.toHaveBeenCalledWith("tx.execute", expect.anything());

    const fetchImpl = vi.fn(async () => Response.json({
      confirmed: true,
      build_id: build.build_id,
      idempotency_key: "onboarding-trust-rlusd",
    }));
    const executeOp = vi.fn(async (name: HarborOpName) => {
      if (name === "account.status") return ok(link);
      if (name === "policy.get") return ok(policy);
      if (name === "ledger.account.info") {
        return ok({
          account,
          ledger_index: 1_000,
          validated: true,
          account_data: { Account: account, Sequence: 42 },
        });
      }
      if (name === "tx.execute") {
        return ok({
          status: "needs_approval" as const,
          approval_id: "approval-trust-live",
          tx_json: { ...build.tx_json },
          expires_at: expiresAt,
          policy: { verdict: "needs_approval" as const, reasons: [] },
        });
      }
      throw new Error(`unexpected op ${name}`);
    });
    const result = await executePreparedLiveOnboardingTrust(
      clientWith(executeOp),
      link,
      { currency: "RLUSD", issuer },
      confirmed,
      () => confirmLiveOnboardingTrustExecutionCapability(confirmed, fetchImpl as typeof fetch),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/onboarding/trustset/confirm-execution",
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    );
    const executeCall = executeOp.mock.calls.findIndex(([name]) => name === "tx.execute");
    expect(fetchImpl.mock.invocationCallOrder[0])
      .toBeLessThan(executeOp.mock.invocationCallOrder[executeCall]!);
    expect(executeOp.mock.calls.map(([name]) => name)).toEqual([
      "account.status",
      "policy.get",
      "ledger.account.info",
      "tx.execute",
    ]);
    expect(executeOp).toHaveBeenCalledWith("tx.execute", {
      build_id: build.build_id,
      idempotency_key: "onboarding-trust-rlusd",
    });
    expect(result).toMatchObject({
      status: "needs_approval",
      action: {
        kind: "trust",
        approvalId: "approval-trust-live",
        expiresAt,
        expectedDelegate: delegate,
        build: { tx_json: build.tx_json },
      },
    });
    if (result.status !== "needs_approval") throw new Error("expected approval fixture");
    const storedApproval = {
      version: 1 as const,
      account,
      network: "testnet" as const,
      delegate,
      approval_id: result.action.approvalId,
      expires_at: result.action.expiresAt,
      build: result.action.build,
    };
    expect(parseStoredOnboardingTrustApproval(JSON.stringify(storedApproval), account))
      .toEqual(storedApproval);
    expect(parseStoredOnboardingTrustApproval(JSON.stringify({
      ...storedApproval,
      tx_blob: "NEVER",
    }), account)).toBeUndefined();
    const stored = pendingSubmissionRecord(
      result.action,
      "A".repeat(64),
      account,
      "testnet",
    );
    expect(stored).toMatchObject({
      submissionRoute: "harbor",
      expectedDelegate: delegate,
    });
    expect(parseStoredPendingSubmission(JSON.stringify(stored), account, "testnet"))
      .toEqual(stored);
  });

  it("rejects approval transaction changes and accepts only exact validated trust lines", async () => {
    const confirmed = {
      status: "policy_confirmed" as const,
      action: { kind: "trust" as const, build, intentId: "onboarding-trust-rlusd", expectedDelegate: delegate },
    };
    const op = vi.fn(async (name: HarborOpName) => {
      if (name === "account.status") return ok(link);
      if (name === "policy.get") return ok(policy);
      if (name === "ledger.account.info") {
        return ok({
          account,
          ledger_index: 1_000,
          validated: true,
          account_data: { Account: account, Sequence: 42 },
        });
      }
      if (name === "tx.execute") {
        return ok({
          status: "needs_approval" as const,
          approval_id: "approval-trust-live",
          tx_json: { ...build.tx_json, Fee: "13" },
          expires_at: "2099-01-01T00:00:00.000Z",
          policy: { verdict: "needs_approval" as const, reasons: [] },
        });
      }
      throw new Error(`unexpected op ${name}`);
    });
    await expect(executePreparedLiveOnboardingTrust(
      clientWith(op),
      link,
      { currency: "RLUSD", issuer },
      confirmed,
      vi.fn(async () => undefined),
    )).rejects.toThrow("mismatched TrustSet owner approval");

    const lineClient = clientWith(async () => ok({
      account,
      ledger_index: 1_001,
      validated: true,
      lines: [{ account: issuer, currency: "RLUSD", limit: "10000" }],
    }));
    await expect(hasExactConfiguredTrustLine(
      lineClient,
      account,
      "testnet",
      { currency: "RLUSD", issuer },
    )).resolves.toBe(true);
  });
});

describe("onboarding sign-only transaction validation", () => {
  const account = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
  const delegate = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
  const issuer = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
  const base = { Fee: "12", Sequence: 42, LastLedgerSequence: 1_020 };
  const trustBuild = () => ({
    build_id: "trust",
    network: "testnet" as const,
    tx_json: {
      ...base,
      TransactionType: "TrustSet",
      Account: account,
      LimitAmount: { currency: "524C555344000000000000000000000000000000", issuer, value: "10000" },
    },
    delegable: true,
    simulate: { engine_result: "tesSUCCESS", engine_result_message: "ok", applied: false as const },
    preflight: [{ check: "schema", pass: true }],
    summary: { action: "Trust", account, amounts: [], fee_drops: "12", reserve_delta_drops: "0" },
  });
  const delegateLink = (): AccountLink => ({
    owner: account,
    network: "testnet",
    delegate,
    permissions: [...DEFAULT_PERMISSIONS],
    status: "pending",
    delegate_set_tx: {
      ...base,
      TransactionType: "DelegateSet",
      Account: account,
      Authorize: delegate,
      Permissions: DEFAULT_PERMISSIONS.map((PermissionValue) => ({ Permission: { PermissionValue } })),
    },
  });
  const revokeLink = (): AccountLink => ({
    owner: account,
    network: "testnet",
    delegate,
    permissions: [...DEFAULT_PERMISSIONS],
    status: "suspended",
    revoke_tx: {
      ...base,
      TransactionType: "DelegateSet",
      Account: account,
      Authorize: delegate,
      Permissions: [],
    },
  });
  const revokeTxBlob = "120040240000002A201B000003FC68400000000000000C73210211111111111111111111111111111111111111111111111111111111111111117447304444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444481145E7B112523F68D2F5E879DB4EAC51C6698A693048514F667B0CA50CC7709A220B0561B85E53A48461FA8F01DF1";
  const revokeTxHash = "B54A7517ADB837A0B3811C02004B9A21DCA9B726DEACD7B10CA45E2E61F79B94";

  it("accepts only the exact displayed TrustSet and DelegateSet", () => {
    expect(() => assertSafeTrustSet(trustBuild(), account, "testnet", { currency: "RLUSD", issuer }, 1_000, 42)).not.toThrow();
    expect(() => assertSafeDelegateSet(delegateLink(), account, "testnet", 1_000, 42)).not.toThrow();
  });

  it("accepts only an exact unsigned revocation of the current delegate", () => {
    expect(() => assertSafeRevoke(revokeLink(), account, "testnet", delegate, 1_000, 42)).not.toThrow();

    const wrongOwner = revokeLink(); wrongOwner.owner = delegate;
    expect(() => assertSafeRevoke(wrongOwner, account, "testnet", delegate, 1_000, 42)).toThrow("current owner");
    const wrongNetwork = revokeLink(); wrongNetwork.network = "devnet";
    expect(() => assertSafeRevoke(wrongNetwork, account, "testnet", delegate, 1_000, 42)).toThrow("current owner");
    const wrongDelegate = revokeLink(); wrongDelegate.delegate = account;
    expect(() => assertSafeRevoke(wrongDelegate, account, "testnet", delegate, 1_000, 42)).toThrow("current owner");
    const wrongAuthorize = revokeLink(); wrongAuthorize.revoke_tx!.Authorize = account;
    expect(() => assertSafeRevoke(wrongAuthorize, account, "testnet", delegate, 1_000, 42)).toThrow("current owner");
    const wrongStatus = revokeLink(); wrongStatus.status = "revoked";
    expect(() => assertSafeRevoke(wrongStatus, account, "testnet", delegate, 1_000, 42)).toThrow("current owner");
    const missingRetainedPermission = revokeLink(); missingRetainedPermission.permissions.pop();
    expect(() => assertSafeRevoke(missingRetainedPermission, account, "testnet", delegate, 1_000, 42)).toThrow("current owner");
    const reorderedPermissions = revokeLink(); reorderedPermissions.permissions.reverse();
    expect(() => assertSafeRevoke(reorderedPermissions, account, "testnet", delegate, 1_000, 42)).toThrow("current owner");
    const txPermissions = revokeLink(); txPermissions.revoke_tx!.Permissions = [{ Permission: { PermissionValue: "OfferCreate" } }];
    expect(() => assertSafeRevoke(txPermissions, account, "testnet", delegate, 1_000, 42)).toThrow("current owner");
    const staleDelegateSet = revokeLink(); staleDelegateSet.delegate_set_tx = { TransactionType: "DelegateSet" };
    expect(() => assertSafeRevoke(staleDelegateSet, account, "testnet", delegate, 1_000, 42)).toThrow("current owner");
    const highFee = revokeLink(); highFee.revoke_tx!.Fee = "101";
    expect(() => assertSafeRevoke(highFee, account, "testnet", delegate, 1_000, 42)).toThrow("unsafe fee");
    const signed = revokeLink(); signed.revoke_tx!.SigningPubKey = "ABC";
    expect(() => assertSafeRevoke(signed, account, "testnet", delegate, 1_000, 42)).toThrow("unsigned");
    const stale = revokeLink(); stale.revoke_tx!.Sequence = 43;
    expect(() => assertSafeRevoke(stale, account, "testnet", delegate, 1_000, 42)).toThrow("invalid sequence");
    const expired = revokeLink(); expired.revoke_tx!.LastLedgerSequence = 1_000;
    expect(() => assertSafeRevoke(expired, account, "testnet", delegate, 1_000, 42)).toThrow("expired");
    const tooLong = revokeLink(); tooLong.revoke_tx!.LastLedgerSequence = 1_051;
    expect(() => assertSafeRevoke(tooLong, account, "testnet", delegate, 1_000, 42)).toThrow("long-lived");
    const extra = revokeLink(); extra.revoke_tx!.Destination = delegate;
    expect(() => assertSafeRevoke(extra, account, "testnet", delegate, 1_000, 42)).toThrow("unexpected");
  });

  it("prepares only Harbor's suspended revocation contract without signing or submitting", async () => {
    const signOnly = vi.fn();
    const op = vi.fn(async (name: HarborOpName) => {
      if (name === "account.revoke") return ok(revokeLink());
      if (name === "ledger.account.info") return ok({
        account,
        ledger_index: 1_000,
        validated: true,
        account_data: { Sequence: 42 },
      });
      throw new Error(`unexpected operation ${name}`);
    });

    await expect(prepareOnboardingRevocation(
      clientWith(op), account, "testnet", delegate,
    )).resolves.toEqual(revokeLink());
    expect(op.mock.calls.map(([name]) => name)).toEqual([
      "account.revoke",
      "ledger.account.info",
    ]);
    expect(op).not.toHaveBeenCalledWith("tx.submit", expect.anything());
    expect(signOnly).not.toHaveBeenCalled();
  });

  it("rechecks the prepared revocation immediately before explicit sign-only confirmation", async () => {
    const prepared = revokeLink();
    const signedBlob = "SIGNED";
    const signOnly = vi.fn(async () => signedBlob);
    const accountInfo = vi.fn(async () => ok({
      account,
      ledger_index: 1_000,
      validated: true,
      account_data: { Sequence: 42 },
    }));
    const request = {
      txJson: prepared.revoke_tx!,
      summary: {
        action: "Revoke delegation",
        amounts: ["No payment or value transfer"],
        destination: delegate,
        feeDrops: "12",
        network: "testnet" as const,
      },
    };

    await expect(signOnlyAfterPreflight(
      request,
      { signOnly },
      () => preflightPreparedOnboardingRevocation(
        clientWith(accountInfo), prepared, account, "testnet", delegate,
        { getItem: () => null },
      ),
    )).resolves.toBe(signedBlob);
    expect(signOnly).toHaveBeenCalledTimes(1);

    const stored = JSON.stringify(pendingSubmissionRecord(
      { kind: "revoke", link: prepared }, "A".repeat(64), account, "testnet",
    ));
    const repeatSign = vi.fn(async () => signedBlob);
    await expect(signOnlyAfterPreflight(
      request,
      { signOnly: repeatSign },
      () => preflightPreparedOnboardingRevocation(
        clientWith(accountInfo), prepared, account, "testnet", delegate,
        { getItem: () => stored },
      ),
    )).rejects.toThrow("unresolved");
    expect(repeatSign).not.toHaveBeenCalled();

    const stale = revokeLink(); stale.revoke_tx!.LastLedgerSequence = 1_000;
    const staleSign = vi.fn(async () => signedBlob);
    await expect(signOnlyAfterPreflight(
      { ...request, txJson: stale.revoke_tx! },
      { signOnly: staleSign },
      () => preflightPreparedOnboardingRevocation(
        clientWith(accountInfo), stale, account, "testnet", delegate,
        { getItem: () => null },
      ),
    )).rejects.toThrow("expired");
    expect(staleSign).not.toHaveBeenCalled();
  });

  it("progresses from suspended preparation to validated public revocation evidence", async () => {
    const hash = "F".repeat(64);
    const op = vi
      .fn()
      .mockResolvedValueOnce(ok(revokeLink()))
      .mockResolvedValueOnce(ok({
        owner: account,
        network: "testnet",
        delegate,
        permissions: [],
        status: "revoked",
      }))
      .mockResolvedValueOnce(ok({
        account,
        ledger_index_min: 1,
        ledger_index_max: 2,
        transactions: [{
          hash,
          validated: true,
          tx: {
            TransactionType: "DelegateSet",
            Account: account,
            Authorize: delegate,
            Permissions: [],
          },
          meta: { TransactionResult: "tesSUCCESS" },
        }],
      }));
    await expect(waitForRevokedOnboardingLink(
      clientWith(op),
      account,
      "testnet",
      delegate,
      hash,
      { attempts: 2, delayMs: 0, sleep: async () => undefined },
    )).resolves.toMatchObject({ status: "revoked", permissions: [] });
    expect(op.mock.calls.map(([name]) => name)).toEqual([
      "account.status",
      "account.status",
      "ledger.account.tx",
    ]);
  });

  it("never classifies malformed status or public history as revoked", async () => {
    const hash = "F".repeat(64);
    const wrongScope = vi.fn(async () => ok({
      ...revokeLink(),
      owner: delegate,
    }));
    await expect(waitForRevokedOnboardingLink(
      clientWith(wrongScope), account, "testnet", delegate, hash, { attempts: 1 },
    )).rejects.toThrow("different owner");
    expect(wrongScope).toHaveBeenCalledTimes(1);

    const retainedPermissions = vi.fn(async () => ok({
      ...revokeLink(),
      status: "revoked" as const,
    }));
    await expect(waitForRevokedOnboardingLink(
      clientWith(retainedPermissions), account, "testnet", delegate, hash,
      { attempts: 1 },
    )).rejects.toThrow("inconsistent revoked delegation state");
    expect(retainedPermissions).toHaveBeenCalledTimes(1);

    const malformedHistory = vi
      .fn()
      .mockResolvedValueOnce(ok({
        owner: account,
        network: "testnet",
        delegate,
        permissions: [],
        status: "revoked",
      }))
      .mockResolvedValueOnce(ok({
        account,
        ledger_index_min: 1,
        ledger_index_max: 2,
        transactions: [{
          hash: "E".repeat(64),
          validated: false,
          tx: {
            TransactionType: "DelegateSet",
            Account: account,
            Authorize: delegate,
            Permissions: [{ Permission: { PermissionValue: "OfferCreate" } }],
          },
          meta: { TransactionResult: "tecFAILED" },
        }],
      }));
    await expect(waitForRevokedOnboardingLink(
      clientWith(malformedHistory), account, "testnet", delegate, hash,
      { attempts: 1 },
    )).rejects.toThrow("not yet proven");
  });

  it("persists once and recovers an uncertain revoke submission only by hash", async () => {
    const prepared = revokeLink();
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };
    const op = vi.fn(async (name: HarborOpName) => {
      if (name === "tx.submit") throw new Error("submit response was lost");
      if (name === "tx.status") return ok({
        hash: revokeTxHash,
        network: "testnet",
        validated: true,
        ledger_index: 1_010,
        engine_result: "tesSUCCESS",
        result: "success",
      });
      throw new Error(`unexpected operation ${name}`);
    });

    await expect(submitPreparedOnboardingRevocation(
      clientWith(op), prepared, revokeTxBlob, account, "testnet", storage,
      { attempts: 1, delayMs: 0, sleep: async () => undefined },
    )).resolves.toEqual({ status: "validated", hash: revokeTxHash });
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(parseStoredPendingSubmission(
      storage.getItem("pilot:onboarding-pending"), account, "testnet",
    )).toMatchObject({ kind: "revoke", hash: revokeTxHash });
    expect(op.mock.calls.map(([name]) => name)).toEqual(["tx.submit", "tx.status"]);
    expect(op.mock.calls.filter(([name]) => name === "tx.submit")).toHaveLength(1);

    await expect(preflightPreparedOnboardingRevocation(
      clientWith(vi.fn()), prepared, account, "testnet", delegate, storage,
    )).rejects.toThrow("unresolved");
  });

  it("retains the durable guard when submit returns a different hash", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };
    const op = vi.fn(async (name: HarborOpName) => {
      if (name === "tx.submit") return ok({
        hash: "C".repeat(64),
        network: "testnet",
        validated: true,
        ledger_index: 1_010,
        engine_result: "tesSUCCESS",
        result: "success",
      });
      throw new Error(`unexpected operation ${name}`);
    });

    await expect(submitPreparedOnboardingRevocation(
      clientWith(op), revokeLink(), revokeTxBlob, account, "testnet", storage,
      { attempts: 1, delayMs: 0, sleep: async () => undefined },
    )).rejects.toThrow("did not match the signed revocation");
    expect(parseStoredPendingSubmission(
      storage.getItem("pilot:onboarding-pending"), account, "testnet",
    )).toMatchObject({ kind: "revoke", hash: revokeTxHash });

    await expect(submitPreparedOnboardingRevocation(
      clientWith(op), revokeLink(), revokeTxBlob, account, "testnet", storage,
      { attempts: 1, delayMs: 0, sleep: async () => undefined },
    )).rejects.toThrow("unresolved");
    expect(op.mock.calls.filter(([name]) => name === "tx.submit")).toHaveLength(1);
  });

  it("retains the durable guard when status recovery is bound to another transaction", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };
    const op = vi.fn(async (name: HarborOpName) => {
      if (name === "tx.submit") throw new Error("submit response was lost");
      if (name === "tx.status") return ok({
        hash: "D".repeat(64),
        network: "devnet",
        validated: false,
      });
      throw new Error(`unexpected operation ${name}`);
    });

    await expect(submitPreparedOnboardingRevocation(
      clientWith(op), revokeLink(), revokeTxBlob, account, "testnet", storage,
      { attempts: 1, delayMs: 0, sleep: async () => undefined },
    )).rejects.toThrow("different hash or network");
    expect(parseStoredPendingSubmission(
      storage.getItem("pilot:onboarding-pending"), account, "testnet",
    )).toMatchObject({ kind: "revoke", hash: revokeTxHash });

    await expect(submitPreparedOnboardingRevocation(
      clientWith(op), revokeLink(), revokeTxBlob, account, "testnet", storage,
      { attempts: 1, delayMs: 0, sleep: async () => undefined },
    )).rejects.toThrow("unresolved");
    expect(op.mock.calls.filter(([name]) => name === "tx.submit")).toHaveLength(1);
    expect(op.mock.calls.filter(([name]) => name === "tx.status")).toHaveLength(1);
  });

  it("keeps recovery locked after validation when public revocation state is inconsistent", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    };
    const submit = vi.fn(async (name: HarborOpName) => {
      if (name === "tx.submit") return ok({
        hash: revokeTxHash,
        network: "testnet",
        validated: true,
        ledger_index: 1_010,
        engine_result: "tesSUCCESS",
        result: "success",
      });
      throw new Error(`unexpected operation ${name}`);
    });
    await expect(submitPreparedOnboardingRevocation(
      clientWith(submit), revokeLink(), revokeTxBlob, account, "testnet", storage,
      { attempts: 1, delayMs: 0, sleep: async () => undefined },
    )).resolves.toEqual({ status: "validated", hash: revokeTxHash });

    let reconciliationCause: unknown;
    try {
      await waitForRevokedOnboardingLink(
        clientWith(async () => ok({ ...revokeLink(), owner: delegate })),
        account,
        "testnet",
        delegate,
        revokeTxHash,
        { attempts: 1 },
      );
    } catch (cause) {
      reconciliationCause = cause;
    }
    expect(reconciliationCause).toBeInstanceOf(Error);
    expect(clearTerminalPendingSubmission(
      reconciliationCause, "revoke", storage,
    )).toBeUndefined();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(parseStoredPendingSubmission(
      storage.getItem("pilot:onboarding-pending"), account, "testnet",
    )).toMatchObject({ kind: "revoke", hash: revokeTxHash });

    await expect(submitPreparedOnboardingRevocation(
      clientWith(submit), revokeLink(), revokeTxBlob, account, "testnet", storage,
      { attempts: 1, delayMs: 0, sleep: async () => undefined },
    )).rejects.toThrow("unresolved");
    expect(submit.mock.calls.filter(([name]) => name === "tx.submit")).toHaveLength(1);
  });

  it("rejects status recovery for a different hash or network", async () => {
    const hash = "A".repeat(64);
    const wrongHash = clientWith(async () => ok({
      hash: "B".repeat(64),
      network: "testnet",
      validated: false,
    }));
    await expect(waitForValidatedSubmission(
      wrongHash,
      { hash, validated: false },
      account,
      "testnet",
      1_020,
      { attempts: 1 },
    )).rejects.toThrow("different hash or network");

    const wrongNetwork = clientWith(async () => ok({
      hash,
      network: "devnet",
      validated: false,
    }));
    await expect(waitForValidatedSubmission(
      wrongNetwork,
      { hash, validated: false },
      account,
      "testnet",
      1_020,
      { attempts: 1 },
    )).rejects.toThrow("different hash or network");
  });

  it("rejects type, asset/limit, fee, expiry, delegate, and permission mismatches", () => {
    const wrongType = trustBuild(); wrongType.tx_json.TransactionType = "Payment";
    expect(() => assertSafeTrustSet(wrongType, account, "testnet", { currency: "RLUSD", issuer }, 1_000, 42)).toThrow("TrustSet");
    const wrongLimit = trustBuild(); wrongLimit.tx_json.LimitAmount.value = "9999";
    expect(() => assertSafeTrustSet(wrongLimit, account, "testnet", { currency: "RLUSD", issuer }, 1_000, 42)).toThrow("limit");
    const highFee = trustBuild(); highFee.tx_json.Fee = "101";
    expect(() => assertSafeTrustSet(highFee, account, "testnet", { currency: "RLUSD", issuer }, 1_000, 42)).toThrow("unsafe fee");
    const expired = trustBuild(); expired.tx_json.LastLedgerSequence = 999;
    expect(() => assertSafeTrustSet(expired, account, "testnet", { currency: "RLUSD", issuer }, 1_000, 42)).toThrow("expired");
    const closed = trustBuild(); closed.tx_json.LastLedgerSequence = 1_000;
    expect(() => assertSafeTrustSet(closed, account, "testnet", { currency: "RLUSD", issuer }, 1_000, 42)).toThrow("expired");
    const wrongDelegate = delegateLink(); wrongDelegate.delegate_set_tx!.Authorize = account;
    expect(() => assertSafeDelegateSet(wrongDelegate, account, "testnet", 1_000, 42)).toThrow("displayed delegate");
    const wrongPermissions = delegateLink(); wrongPermissions.delegate_set_tx!.Permissions = [];
    expect(() => assertSafeDelegateSet(wrongPermissions, account, "testnet", 1_000, 42)).toThrow("seven permissions");
    const staleSequence = trustBuild(); staleSequence.tx_json.Sequence = 43;
    expect(() => assertSafeTrustSet(staleSequence, account, "testnet", { currency: "RLUSD", issuer }, 1_000, 42)).toThrow("invalid sequence");
    const applied = trustBuild(); applied.simulate.applied = true as false;
    expect(() => assertSafeTrustSet(applied, account, "testnet", { currency: "RLUSD", issuer }, 1_000, 42)).toThrow("simulation");
    const preSigned = trustBuild(); (preSigned.tx_json as Record<string, unknown>).SigningPubKey = "ABC";
    expect(() => assertSafeTrustSet(preSigned, account, "testnet", { currency: "RLUSD", issuer }, 1_000, 42)).toThrow("unsigned");
  });

  it("restores only an exact account-bound pending transaction", () => {
    const hash = "A".repeat(64);
    const stored = JSON.stringify({
      version: 1,
      kind: "delegate",
      hash,
      account,
      network: "testnet",
      expectedDelegate: delegate,
      lastLedgerSequence: 1_020,
      expectedTx: delegateLink().delegate_set_tx,
    });
    expect(parseStoredPendingSubmission(stored, account, "testnet")).toMatchObject({ hash, expectedDelegate: delegate });
    expect(hasPersistedPendingDelegate(stored)).toBe(true);
    expect(hasUnresolvedDelegateApproval(undefined, true)).toBe(true);
    expect(hasUnresolvedDelegateApproval("delegate", false)).toBe(true);
    expect(hasUnresolvedDelegateApproval("trust", false)).toBe(false);
    expect(parseStoredPendingSubmission(stored, delegate, "testnet")).toBeUndefined();
    expect(hasPersistedPendingDelegate(JSON.stringify({ kind: "delegate" }))).toBe(false);
    expect(parseStoredPendingSubmission(stored.replace(delegate, account), account, "testnet")).toBeUndefined();
    expect(pendingSubmissionRecord(
      { kind: "delegate", link: delegateLink() },
      hash,
      account,
      "testnet",
    )).toMatchObject({ hash, expectedDelegate: delegate, lastLedgerSequence: 1_020 });
    const revoke = pendingSubmissionRecord(
      { kind: "revoke", link: revokeLink() },
      hash,
      account,
      "testnet",
    );
    expect(revoke).toMatchObject({ kind: "revoke", expectedDelegate: delegate });
    expect(parseStoredPendingSubmission(JSON.stringify(revoke), account, "testnet"))
      .toMatchObject({ kind: "revoke", expectedDelegate: delegate });
  });
});

describe("onboarding test-network funding", () => {
  it("uses the dev funding route's address contract", () => {
    expect(devFundRequestBody("rOwner", "devnet")).toEqual({
      address: "rOwner",
      network: "devnet",
    });
    expect(devFundRequestBody("rOwner", "devnet")).not.toHaveProperty("destination");
  });

  it("surfaces the exact safe blocker for an unfunded development signer", async () => {
    const harbor = clientWith(async () => error("account not found"));
    await expect(
      requireActivatedAccount(harbor, "rFresh", "testnet", "dev", {
        attempts: 1,
        delayMs: 0,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("after the public faucet request");
  });

  it("passes an activated account and polls wallet-provider activation failures", async () => {
    await expect(
      requireActivatedAccount(
        clientWith(async () => ok({
          account: "rOwner",
          ledger_index: 123,
          validated: true,
          account_data: {},
        })),
        "rOwner",
        "testnet",
        "gemwallet",
        { attempts: 2, delayMs: 0, sleep: async () => undefined },
      ),
    ).resolves.toBeUndefined();
    await expect(
      requireActivatedAccount(
        clientWith(async () => error("account missing")),
        "rOwner",
        "testnet",
        "gemwallet",
        { attempts: 2, delayMs: 0, sleep: async () => undefined },
      ),
    ).rejects.toThrow("account missing");
  });
});

describe("live development-signer RLUSD onboarding", () => {
  const account = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
  const operationId = "123e4567-e89b-42d3-a456-426614174000";
  const hash = "A".repeat(64);
  const expiresAt = "2030-01-01T00:00:00.000Z";
  const txJson = {
    TransactionType: "OfferCreate",
    Account: account,
    TakerGets: "275000000",
    TakerPays: {
      currency: "524C555344000000000000000000000000000000",
      issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
      value: "75",
    },
    Flags: 0x0004_0000,
    Fee: "100",
    Sequence: 42,
    LastLedgerSequence: 1_004,
    SigningPubKey: "",
  };

  const response = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

  it("uses the strict acquisition faucet shape with a caller-generated operation UUID", () => {
    expect(acquisitionFaucetRequestBody(account, operationId)).toEqual({
      address: account,
      network: "testnet",
      purpose: "rlusd-acquisition",
      operation_id: operationId,
    });
    expect(() => acquisitionFaucetRequestBody(account, "not-a-uuid")).toThrow("operation id");
  });

  it("fails closed on a non-official asset before faucet or wallet signing", () => {
    const faucet = vi.fn();
    const signOnly = vi.fn();
    const begin = (currency: string, issuer: string) => {
      assertOfficialLiveDevRlusdConfig({
        network: "testnet",
        stableAsset: { currency, issuer },
        devSignerEnabled: true,
        walletActionProofRequired: true,
        walletActionProofConfigured: true,
        mockMode: false,
      }, "dev");
      faucet();
      signOnly();
    };

    expect(() => begin(
      "tUSD",
      "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
    )).toThrow("exact official Testnet RLUSD");
    expect(faucet).not.toHaveBeenCalled();
    expect(signOnly).not.toHaveBeenCalled();

    expect(() => assertOfficialLiveDevRlusdConfig({
      network: "testnet",
      stableAsset: {
        currency: "RLUSD",
        issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
      },
      devSignerEnabled: true,
      walletActionProofRequired: true,
      walletActionProofConfigured: true,
      mockMode: false,
    }, "dev")).not.toThrow();
    expect(() => assertOfficialLiveDevRlusdConfig({
      network: "testnet",
      stableAsset: {
        currency: "524C555344000000000000000000000000000000",
        issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
      },
      devSignerEnabled: true,
      walletActionProofRequired: true,
      walletActionProofConfigured: true,
      mockMode: false,
    }, "dev")).not.toThrow();
  });

  it("sends only the route-owned initialize, prepare, refresh, submit, and status fields", () => {
    expect(rlusdAcquisitionRequestBody("initialize")).toEqual({ action: "initialize" });
    expect(rlusdAcquisitionRequestBody("prepare")).toEqual({ action: "prepare" });
    expect(rlusdAcquisitionRequestBody("submit", operationId, "ABCD")).toEqual({
      action: "submit",
      operation_id: operationId,
      tx_blob: "ABCD",
    });
    expect(rlusdAcquisitionRequestBody("status", operationId)).toEqual({
      action: "status",
      operation_id: operationId,
    });
    expect(rlusdAcquisitionRequestBody("refresh", operationId)).toEqual({
      action: "refresh",
      operation_id: operationId,
    });
    const preflight = rlusdAcquisitionPreflightRequestBody({
      operation_id: operationId,
      owner: account,
      network: "testnet",
      status: "prepared",
      tx_json: txJson,
      approval_expires_at: expiresAt,
      approval_binding: "a".repeat(64),
    });
    expect(preflight).toEqual({
      action: "preflight",
      operation_id: operationId,
      approval_binding: "a".repeat(64),
    });
    for (const body of [
      rlusdAcquisitionRequestBody("initialize"),
      rlusdAcquisitionRequestBody("prepare"),
      rlusdAcquisitionRequestBody("submit", operationId, "ABCD"),
      rlusdAcquisitionRequestBody("status", operationId),
      rlusdAcquisitionRequestBody("refresh", operationId),
      preflight,
    ]) {
      expect(body).not.toHaveProperty("account");
      expect(body).not.toHaveProperty("owner");
      expect(body).not.toHaveProperty("network");
    }
  });

  it("checks status after reload and refreshes only after observing unsigned expiry", () => {
    const hint = { operation_id: operationId, account, network: "testnet" as const };
    expect(rlusdAcquisitionRecoveryRequestBody(hint)).toEqual({
      action: "status",
      operation_id: operationId,
    });
    expect(rlusdAcquisitionRecoveryRequestBody(hint, {
      operation_id: operationId,
      owner: account,
      network: "testnet",
      status: "expired_unsubmitted",
    })).toEqual({
      action: "refresh",
      operation_id: operationId,
    });
    expect(rlusdAcquisitionRecoveryRequestBody(hint, {
      operation_id: operationId,
      owner: account,
      network: "testnet",
      status: "signed_pending",
      hash,
    })).toEqual({
      action: "status",
      operation_id: operationId,
    });
  });

  it("accepts only the exact prepared owner approval and public recovery state", () => {
    const prepared = parseRlusdAcquisitionRouteState({
      operation_id: operationId,
      owner: account,
      network: "testnet",
      status: "prepared",
      tx_json: txJson,
      approval_expires_at: expiresAt,
      approval_binding: "a".repeat(64),
    }, account);
    const hint = acquisitionRecoveryHint(prepared);
    expect(hint).toEqual({ operation_id: operationId, account, network: "testnet" });
    expect(parseAcquisitionRecoveryHint(JSON.stringify(hint), account)).toEqual(hint);
    expect(parseAcquisitionRecoveryHint(JSON.stringify({ ...hint, tx_blob: "NEVER" }), account)).toBeUndefined();
    expect(() => parseRlusdAcquisitionRouteState({
      ...prepared,
      tx_json: { ...txJson, TakerGets: "275000001" },
    }, account)).toThrow("exact safe 75 RLUSD");
    expect(() => parseRlusdAcquisitionRouteState({
      ...prepared,
      tx_json: { ...txJson, Delegate: account },
    }, account)).toThrow("exact safe 75 RLUSD");
    expect(() => parseRlusdAcquisitionRouteState({
      ...prepared,
      tx_json: { ...txJson, Sequence: -1 },
    }, account)).toThrow("exact safe 75 RLUSD");
    expect(() => parseRlusdAcquisitionRouteState({
      ...prepared,
      tx_json: { ...txJson, TxnSignature: "ABC" },
    }, account)).toThrow("exact safe 75 RLUSD");
  });

  it("parses only consistently versioned v2 acquisition public states", () => {
    expect(parseRlusdAcquisitionRouteState({
      operation_id: operationId,
      owner: account,
      network: "testnet",
      status: "initializing",
      execution_contract: "xrpl_execution_v2",
    }, account)).toMatchObject({
      status: "initializing",
      execution_contract: "xrpl_execution_v2",
    });
    expect(parseRlusdAcquisitionRouteState({
      operation_id: operationId,
      owner: account,
      network: "testnet",
      status: "prepared",
      execution_contract: "xrpl_execution_v2",
      build_revision: 1,
      tx_json: txJson,
      approval_expires_at: expiresAt,
      approval_binding: "a".repeat(64),
    }, account)).toMatchObject({
      status: "prepared",
      execution_contract: "xrpl_execution_v2",
      build_revision: 1,
    });
    expect(parseRlusdAcquisitionRouteState({
      operation_id: operationId,
      owner: account,
      network: "testnet",
      status: "signed_pending",
      execution_contract: "xrpl_execution_v2",
      build_revision: 1,
      hash,
    }, account)).toMatchObject({ status: "signed_pending", build_revision: 1 });
    for (const evidence of [
      { execution_contract: "xrpl_execution_v1" },
      { build_revision: 1 },
      { execution_contract: "xrpl_execution_v2", build_revision: 0 },
      { execution_contract: "xrpl_execution_v2", build_revision: 2 },
      { execution_contract: "xrpl_execution_v2" },
    ]) {
      expect(() => parseRlusdAcquisitionRouteState({
        operation_id: operationId,
        owner: account,
        network: "testnet",
        status: "signed_pending",
        hash,
        ...evidence,
      }, account)).toThrow(/execution contract|mismatched public state/);
    }
  });

  it("recovers signed_pending exclusively through status and never submits again", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(response(200, {
        operation_id: operationId,
        owner: account,
        network: "testnet",
        status: "signed_pending",
        hash,
      }))
      .mockResolvedValueOnce(response(200, {
        operation_id: operationId,
        owner: account,
        network: "testnet",
        status: "validated",
        hash,
        ledger_index: 1_002,
        engine_result: "tesSUCCESS",
      }));
    const hint = { operation_id: operationId, account, network: "testnet" as const };

    await expect(recoverRlusdAcquisition(hint, transport)).resolves.toMatchObject({
      status: "signed_pending",
      hash,
    });
    await expect(waitForValidatedRlusdAcquisition(
      hint,
      { attempts: 1, delayMs: 0, sleep: async () => undefined },
      transport,
    )).resolves.toMatchObject({ status: "validated", hash });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenNthCalledWith(1, { action: "status", operation_id: operationId });
    expect(transport).toHaveBeenNthCalledWith(2, { action: "status", operation_id: operationId });
    expect(transport).not.toHaveBeenCalledWith(expect.objectContaining({ action: "submit" }));
  });

  it("gates delegation behind validated acquisition only for live dev Testnet", () => {
    expect(shouldUseLiveDevAcquisition("dev", "testnet", false)).toBe(true);
    expect(nextStepAfterValidatedTrust("dev", "testnet", false)).toBe("acquire");
    expect(nextStepAfterValidatedTrust("dev", "testnet", true)).toBe("delegate");
    expect(nextStepAfterValidatedTrust("gemwallet", "testnet", false)).toBe("delegate");
    expect(nextStepAfterValidatedTrust("dev", "devnet", false)).toBe("delegate");
  });

  it("starts every supported profile with the primary desktop extension", () => {
    expect(defaultOnboardingWalletProvider({
      devSignerEnabled: true,
      ledger: { enabled: true, transports: ["virtual"], defaultAccountIndex: 0 },
    })).toBe("gemwallet");
    expect(defaultOnboardingWalletProvider({
      devSignerEnabled: true,
      ledger: { enabled: false, transports: [], defaultAccountIndex: 0 },
    })).toBe("gemwallet");
    expect(defaultOnboardingWalletProvider({
      devSignerEnabled: false,
      ledger: undefined,
    })).toBe("gemwallet");
  });

  it("stores only the bounded public Ledger wallet selection", () => {
    const account = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
    expect(storedOnboardingWalletSession(
      "ledger",
      "testnet",
      account,
      { transport: "virtual", accountIndex: 2 },
    )).toEqual({
      provider: "ledger",
      network: "testnet",
      account,
      ledger: { transport: "virtual", accountIndex: 2 },
    });
    expect(() => storedOnboardingWalletSession(
      "ledger",
      "testnet",
      account,
      { transport: "virtual", accountIndex: 3 },
    )).toThrow("wallet session record is invalid");
    expect(() => storedOnboardingWalletSession(
      "gemwallet",
      "testnet",
      account,
      { transport: "virtual", accountIndex: 0 },
    )).toThrow("wallet session record is invalid");
  });

  it("restores only an exact public active or cleanup-only link verified against Harbor", async () => {
    const link: AccountLink = {
      owner: account,
      network: "testnet",
      delegate: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
      permissions: [...DEFAULT_PERMISSIONS],
      status: "active",
    };
    const record = storedActiveOnboardingRecord(
      link,
      "dev",
      "test/model",
      "demo",
      hash,
    );
    expect(parseStoredActiveOnboardingRecord(JSON.stringify(record))).toEqual(record);
    expect(parseStoredActiveOnboardingRecord(JSON.stringify({
      ...record,
      permissions: [...DEFAULT_PERMISSIONS.slice(0, 6), "Payment"],
    }))).toBeUndefined();
    const ledgerRecord = storedActiveOnboardingRecord(
      link,
      "ledger",
      "test/model",
      "demo",
      hash,
      { transport: "virtual", accountIndex: 2 },
    );
    expect(parseStoredActiveOnboardingRecord(JSON.stringify(ledgerRecord))).toEqual(ledgerRecord);
    expect(parseStoredActiveOnboardingRecord(JSON.stringify({
      ...ledgerRecord,
      ledger: { transport: "virtual", accountIndex: 2, seed: "never" },
    }))).toBeUndefined();
    expect(() => storedActiveOnboardingRecord(
      link,
      "ledger",
      "test/model",
      "demo",
      hash,
    )).toThrow("exact active onboarding delegation");

    const op = vi.fn(async () => ok(link));
    await expect(restoreActiveOnboardingLink(clientWith(op), record)).resolves.toEqual(link);
    expect(op).toHaveBeenCalledWith("account.status", {
      owner: account,
      network: "testnet",
    });
    expect(requiresDevRevocationBeforeExit("dev", link)).toBe(true);
    expect(requiresDevRevocationBeforeExit("gemwallet", link)).toBe(false);
    const suspended = { ...link, status: "suspended" as const };
    await expect(restoreActiveOnboardingLink(
      clientWith(async () => ok(suspended)),
      record,
    )).resolves.toEqual(suspended);
    expect(requiresDevRevocationBeforeExit("dev", suspended)).toBe(true);

    for (const provider of ["gemwallet", "crossmark"] as const) {
      const externalRecord = storedActiveOnboardingRecord(
        link,
        provider,
        "test/model",
        "demo",
        hash,
      );
      await expect(restoreActiveOnboardingLink(
        clientWith(async () => ok(suspended)),
        externalRecord,
      )).resolves.toEqual(suspended);
    }
    await expect(restoreActiveOnboardingLink(
      clientWith(async () => ok(suspended)),
      ledgerRecord,
    )).resolves.toEqual(suspended);
    const xamanRecord = storedActiveOnboardingRecord(
      link,
      "xaman",
      "test/model",
      "demo",
      hash,
    );
    await expect(restoreActiveOnboardingLink(
      clientWith(async () => ok(suspended)),
      xamanRecord,
    )).rejects.toThrow("no longer matches Harbor's exact active or cleanup-only owner");

    await expect(restoreActiveOnboardingLink(
      clientWith(async () => ok({ ...link, delegate: account })),
      record,
    )).rejects.toThrow("no longer matches Harbor's exact active or cleanup-only owner");
    await expect(restoreActiveOnboardingLink(
      clientWith(async () => ok({ ...link, permissions: ["OfferCreate"] })),
      record,
    )).rejects.toThrow("no longer matches Harbor's exact active or cleanup-only owner");
  });

  it("restores an unexpired Ledger session without reconnecting and expires to an explicit reconnect", async () => {
    const now = Date.now();
    const ledgerLink: AccountLink = {
      owner: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      network: "testnet",
      delegate: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
      permissions: [...DEFAULT_PERMISSIONS],
      status: "active",
    };
    const ledgerRecord = storedActiveOnboardingRecord(
      ledgerLink,
      "ledger",
      "test/model",
      "demo",
      "A".repeat(64),
      { transport: "virtual", accountIndex: 1 },
    );
    const dependencies = {
      restoreLink: vi.fn(async () => ledgerLink),
      createWallet: vi.fn(),
      connectWallet: vi.fn(),
      bindSession: vi.fn(),
    };

    await expect(restoreLedgerOnboardingWithoutDevice({
      authenticated: true,
      account: ledgerLink.owner,
      network: "testnet",
      expiresAt: now + 30 * 60_000,
    }, ledgerRecord, dependencies)).resolves.toEqual({
      status: "ready-without-device",
      link: ledgerLink,
    });
    expect(dependencies.restoreLink).toHaveBeenCalledTimes(1);
    expect(dependencies.createWallet).not.toHaveBeenCalled();
    expect(dependencies.connectWallet).not.toHaveBeenCalled();
    expect(dependencies.bindSession).not.toHaveBeenCalled();

    dependencies.restoreLink.mockClear();
    await expect(restoreLedgerOnboardingWithoutDevice({
      authenticated: true,
      account: ledgerLink.owner,
      network: "testnet",
      expiresAt: now - 1,
    }, ledgerRecord, dependencies)).resolves.toEqual({
      status: "explicit-reconnect-required",
    });
    expect(dependencies.restoreLink).not.toHaveBeenCalled();
    expect(dependencies.createWallet).not.toHaveBeenCalled();
    expect(dependencies.connectWallet).not.toHaveBeenCalled();
    expect(dependencies.bindSession).not.toHaveBeenCalled();
  });

  describe("blocked onboarding revocation recovery", () => {
    const owner = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
    const verifiedLink: AccountLink = {
      owner,
      network: "testnet",
      delegate: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
      permissions: [...DEFAULT_PERMISSIONS],
      status: "active",
    };
    const base = {
      provider: "dev" as const,
      walletConnected: true,
      sessionAuthenticated: true,
      account: owner,
      network: "testnet" as const,
      link: verifiedLink,
      step: "acquire" as const,
      acquisitionStatus: undefined,
      blocked: false,
      pendingKind: undefined,
      persistedPendingSubmission: false,
    };

    it("accepts and strips only the exact one-shot revoke action URL", () => {
      const replace = vi.fn();
      expect(consumeExactOnboardingRevokeAction({
        pathname: "/onboarding",
        search: "?action=revoke",
        hash: "",
      }, replace)).toBe(true);
      expect(replace).toHaveBeenCalledWith("/onboarding");

      for (const location of [
        { pathname: "/", search: "?action=revoke", hash: "" },
        { pathname: "/onboarding/", search: "?action=revoke", hash: "" },
        { pathname: "/onboarding", search: "?action=Revoke", hash: "" },
        { pathname: "/onboarding", search: "?action=revoke&next=chat", hash: "" },
        { pathname: "/onboarding", search: "?action=revoke&action=revoke", hash: "" },
        { pathname: "/onboarding", search: "?action=revoke", hash: "#again" },
      ]) expect(consumeExactOnboardingRevokeAction(location, replace)).toBe(false);
      expect(replace).toHaveBeenCalledTimes(1);
    });

    it("dispatches one valid restored-owner action once and only opens preparation", async () => {
      const record = storedActiveOnboardingRecord(
        verifiedLink,
        "dev",
        "model",
        "openrouter",
        "A".repeat(64),
      );
      const request = { current: record };
      const accountRevokePreparation = vi.fn(async () => undefined);
      const context = {
        provider: "dev" as const,
        walletConnected: true,
        sessionAuthenticated: true,
        account: owner,
        network: "testnet" as const,
        link: verifiedLink,
        step: "ready" as const,
        busy: false,
        error: undefined,
        pendingKind: undefined,
        persistedPendingSubmission: false,
      };

      await expect(dispatchRequestedOnboardingRevocation(
        request,
        context,
        accountRevokePreparation,
      )).resolves.toBe(true);
      await expect(dispatchRequestedOnboardingRevocation(
        request,
        context,
        accountRevokePreparation,
      )).resolves.toBe(false);
      expect(accountRevokePreparation).toHaveBeenCalledTimes(1);
    });

    it.each(["ledger", "gemwallet", "crossmark"] as const)(
      "dispatches one exact authenticated %s owner revocation request",
      async (provider) => {
        const record = storedActiveOnboardingRecord(
          verifiedLink,
          provider,
          "model",
          "openrouter",
          "A".repeat(64),
          provider === "ledger" ? { transport: "virtual", accountIndex: 0 } : undefined,
        );
        const prepare = vi.fn(async () => undefined);
        await expect(dispatchRequestedOnboardingRevocation({ current: record }, {
          provider,
          walletConnected: true,
          sessionAuthenticated: true,
          account: owner,
          network: "testnet",
          link: verifiedLink,
          step: "ready",
          busy: false,
          error: undefined,
          pendingKind: undefined,
          persistedPendingSubmission: false,
        }, prepare)).resolves.toBe(true);
        expect(prepare).toHaveBeenCalledTimes(1);
      },
    );

    it("dispatches a suspended exact-owner cleanup but rejects provider or session drift", async () => {
      const record = storedActiveOnboardingRecord(
        verifiedLink,
        "gemwallet",
        "model",
        "openrouter",
        "A".repeat(64),
      );
      const suspended = { ...verifiedLink, status: "suspended" as const };
      const prepare = vi.fn(async () => undefined);
      const valid = {
        provider: "gemwallet" as const,
        walletConnected: true,
        sessionAuthenticated: true,
        account: owner,
        network: "testnet" as const,
        link: suspended,
        step: "ready" as const,
        busy: false,
        error: undefined,
        pendingKind: undefined,
        persistedPendingSubmission: false,
      };
      await expect(dispatchRequestedOnboardingRevocation(
        { current: record }, valid, prepare,
      )).resolves.toBe(true);
      await expect(dispatchRequestedOnboardingRevocation(
        { current: record }, { ...valid, provider: "crossmark" }, prepare,
      )).resolves.toBe(false);
      await expect(dispatchRequestedOnboardingRevocation(
        { current: record }, { ...valid, walletConnected: false }, prepare,
      )).resolves.toBe(false);
      await expect(dispatchRequestedOnboardingRevocation(
        { current: record }, { ...valid, sessionAuthenticated: false }, prepare,
      )).resolves.toBe(false);
      expect(prepare).toHaveBeenCalledTimes(1);
    });

    it("keeps unauthenticated, inactive, error, and unresolved states at zero preparations", async () => {
      const record = storedActiveOnboardingRecord(
        verifiedLink,
        "dev",
        "model",
        "openrouter",
        "A".repeat(64),
      );
      const valid = {
        provider: "dev" as const,
        walletConnected: true,
        sessionAuthenticated: true,
        account: owner,
        network: "testnet" as const,
        link: verifiedLink,
        step: "ready" as const,
        busy: false,
        error: undefined,
        pendingKind: undefined,
        persistedPendingSubmission: false,
      };
      const blocked = [
        { ...valid, walletConnected: false },
        { ...valid, sessionAuthenticated: false },
        { ...valid, account: undefined },
        { ...valid, provider: "gemwallet" as const },
        { ...valid, step: "ai" as const },
        { ...valid, link: { ...verifiedLink, status: "pending" as const } },
        { ...valid, link: { ...verifiedLink, status: "revoked" as const, permissions: [] } },
        { ...valid, error: "restoration failed" },
        { ...valid, pendingKind: "revoke" as const },
        { ...valid, persistedPendingSubmission: true },
      ];
      const accountRevokePreparation = vi.fn(async () => undefined);
      for (const context of blocked) {
        await expect(dispatchRequestedOnboardingRevocation(
          { current: record },
          context,
          accountRevokePreparation,
        )).resolves.toBe(false);
      }
      const demoRecord = storedActiveOnboardingRecord(
        verifiedLink,
        "dev",
        "model",
        "demo",
        "A".repeat(64),
      );
      await expect(dispatchRequestedOnboardingRevocation(
        { current: demoRecord },
        valid,
        accountRevokePreparation,
      )).resolves.toBe(false);
      expect(accountRevokePreparation).not.toHaveBeenCalled();
      expect(parseStoredActiveOnboardingRecord("{malformed")).toBeUndefined();
    });

    it.each(["failed", "expired_unsubmitted", "expired_unincluded"] as const)(
      "offers cleanup for terminal acquisition state %s without fabricating Ready",
      (acquisitionStatus) => {
        expect(shouldOfferRevocationRecovery({ ...base, acquisitionStatus })).toBe(true);
      },
    );

    it("offers cleanup after a closed preflight-blocked approval", () => {
      expect(shouldOfferRevocationRecovery({
        ...base,
        acquisitionStatus: "prepared",
        blocked: true,
      })).toBe(true);
      expect(shouldOfferRevocationRecovery({
        ...base,
        acquisitionStatus: "prepared",
        blocked: true,
        pendingKind: "acquire",
      })).toBe(false);
    });

    it("marks non-prepared or differently bound preflight responses as blocked", () => {
      const approvalBinding = "binding-1";
      expect(acquisitionPreflightChanged(approvalBinding, {
        operation_id: "01234567-89ab-4cde-8f01-23456789abcd",
        owner,
        network: "testnet",
        status: "prepared",
        approval_binding: approvalBinding,
      })).toBe(false);
      expect(acquisitionPreflightChanged(approvalBinding, {
        operation_id: "01234567-89ab-4cde-8f01-23456789abcd",
        owner,
        network: "testnet",
        status: "prepared",
        approval_binding: "binding-2",
      })).toBe(true);
      expect(acquisitionPreflightChanged(approvalBinding, {
        operation_id: "01234567-89ab-4cde-8f01-23456789abcd",
        owner,
        network: "testnet",
        status: "failed",
      })).toBe(true);
    });

    it("requires a supported authenticated Testnet provider and exact owner link", () => {
      for (const provider of ["dev", "ledger", "gemwallet", "crossmark"] as const) {
        expect(supportsOnboardingRevocation(provider)).toBe(true);
        expect(hasVerifiedRevocationContext({ ...base, provider })).toBe(true);
      }
      expect(supportsOnboardingRevocation("xaman")).toBe(false);
      expect(hasVerifiedRevocationContext({ ...base, provider: "xaman" })).toBe(false);
      expect(hasVerifiedRevocationContext({ ...base, walletConnected: false })).toBe(false);
      expect(hasVerifiedRevocationContext({ ...base, sessionAuthenticated: false })).toBe(false);
      expect(hasVerifiedRevocationContext({ ...base, account: undefined })).toBe(false);
      expect(hasVerifiedRevocationContext({ ...base, account: verifiedLink.delegate })).toBe(false);
      expect(hasVerifiedRevocationContext({ ...base, network: "devnet" })).toBe(false);
      expect(hasVerifiedRevocationContext({ ...base, link: undefined })).toBe(false);
      expect(hasVerifiedRevocationContext({
        ...base,
        link: { ...verifiedLink, owner: verifiedLink.delegate },
      })).toBe(false);
      expect(hasVerifiedRevocationContext({
        ...base,
        link: { ...verifiedLink, network: "devnet" },
      })).toBe(false);
      expect(hasVerifiedRevocationContext({
        ...base,
        link: { ...verifiedLink, delegate: "" },
      })).toBe(false);
      for (const status of ["pending", "revoked"] as const) {
        expect(hasVerifiedRevocationContext({
          ...base,
          link: { ...verifiedLink, status },
        })).toBe(false);
      }
      expect(hasVerifiedRevocationContext({
        ...base,
        link: { ...verifiedLink, status: "suspended" },
      })).toBe(true);
      expect(hasVerifiedRevocationContext({
        ...base,
        link: { ...verifiedLink, permissions: ["OfferCreate"] },
      })).toBe(false);
    });

    it("keeps external-wallet copy distinct from development-key destruction", () => {
      expect(revocationApprovalAction("dev")).toContain("destroying this browser key");
      for (const provider of ["ledger", "gemwallet", "crossmark"] as const) {
        expect(revocationApprovalAction(provider)).toBe(
          "Revoke Harbor's delegation for this exact Testnet account",
        );
        expect(revocationApprovalAction(provider)).not.toContain("destroy");
      }
      expect(ledgerDelegateSetBlindSigningMessage("revoke")).toContain("empty permission list");
      expect(ledgerDelegateSetBlindSigningMessage("delegate")).toContain(
        "all seven permission values",
      );
    });

    it("finalizes only the development wallet as a destroyed local key", async () => {
      const markRevocationVerified = vi.fn(async () => undefined);
      const forget = vi.fn(async () => undefined);
      const disconnect = vi.fn(async () => undefined);
      const wallet = {
        signOnly: vi.fn(),
        connect: vi.fn(),
        address: vi.fn(),
        markRevocationVerified,
        forget,
        disconnect,
      } as unknown as OnboardingWallet;

      await expect(finalizeVerifiedRevocationWallet("dev", wallet)).resolves.toBeUndefined();
      expect(markRevocationVerified).toHaveBeenCalledTimes(1);
      expect(forget).toHaveBeenCalledTimes(1);
      expect(disconnect).not.toHaveBeenCalled();
      expect(markRevocationVerified.mock.invocationCallOrder[0]!).toBeLessThan(
        forget.mock.invocationCallOrder[0]!,
      );
    });

    it.each(["ledger", "gemwallet", "crossmark"] as const)(
      "disconnects the %s facade without claiming key destruction",
      async (provider) => {
        const markRevocationVerified = vi.fn(async () => undefined);
        const forget = vi.fn(async () => undefined);
        const disconnect = vi.fn(async () => undefined);
        const wallet = {
          signOnly: vi.fn(),
          connect: vi.fn(),
          address: vi.fn(),
          markRevocationVerified,
          forget,
          disconnect,
        } as unknown as OnboardingWallet;

        await expect(finalizeVerifiedRevocationWallet(provider, wallet)).resolves.toBeUndefined();
        expect(markRevocationVerified).not.toHaveBeenCalled();
        expect(forget).toHaveBeenCalledTimes(1);
        expect(disconnect).not.toHaveBeenCalled();
      },
    );

    it("falls back to disconnect for an external facade and excludes Xaman", async () => {
      const disconnect = vi.fn(async () => undefined);
      const wallet = {
        signOnly: vi.fn(),
        connect: vi.fn(),
        address: vi.fn(),
        disconnect,
      } as unknown as OnboardingWallet;
      await expect(finalizeVerifiedRevocationWallet("gemwallet", wallet)).resolves.toBeUndefined();
      expect(disconnect).toHaveBeenCalledTimes(1);
      await expect(finalizeVerifiedRevocationWallet("xaman", wallet)).rejects.toThrow(
        "does not support onboarding revocation",
      );
      expect(disconnect).toHaveBeenCalledTimes(1);
    });

    it("fails closed when a provider cannot perform its required finalization", async () => {
      const wallet = {
        signOnly: vi.fn(),
        connect: vi.fn(),
        address: vi.fn(),
      } as unknown as OnboardingWallet;
      await expect(finalizeVerifiedRevocationWallet("dev", wallet)).rejects.toThrow(
        "cannot destroy the local development key",
      );
      await expect(finalizeVerifiedRevocationWallet("crossmark", wallet)).rejects.toThrow(
        "cannot safely disconnect",
      );
    });

    it("clears server authority before provider finalization and local metadata", async () => {
      const clearServerSession = vi.fn(async () => undefined);
      const forget = vi.fn(async () => undefined);
      const removeItem = vi.fn();
      const wallet = {
        signOnly: vi.fn(),
        connect: vi.fn(),
        address: vi.fn(),
        forget,
      } as unknown as OnboardingWallet;
      await expect(finalizeValidatedOnboardingRevocation(
        "ledger",
        wallet,
        clearServerSession,
        { removeItem },
      )).resolves.toBeUndefined();
      expect(clearServerSession).toHaveBeenCalledTimes(1);
      expect(forget).toHaveBeenCalledTimes(1);
      expect(removeItem).toHaveBeenCalledWith("pilot:onboarding-pending");
      expect(clearServerSession.mock.invocationCallOrder[0]!).toBeLessThan(
        forget.mock.invocationCallOrder[0]!,
      );
      expect(forget.mock.invocationCallOrder[0]!).toBeLessThan(
        removeItem.mock.invocationCallOrder[0]!,
      );
    });

    it("retains wallet and recovery metadata if server-session clearing fails", async () => {
      const clearServerSession = vi.fn(async () => {
        throw new Error("server session unavailable");
      });
      const forget = vi.fn(async () => undefined);
      const removeItem = vi.fn();
      const wallet = {
        signOnly: vi.fn(),
        connect: vi.fn(),
        address: vi.fn(),
        forget,
      } as unknown as OnboardingWallet;
      await expect(finalizeValidatedOnboardingRevocation(
        "gemwallet",
        wallet,
        clearServerSession,
        { removeItem },
      )).rejects.toThrow("server session unavailable");
      expect(forget).not.toHaveBeenCalled();
      expect(removeItem).not.toHaveBeenCalled();
    });

    it("never replaces or races an unresolved transaction", () => {
      for (const pendingKind of ["trust", "delegate", "revoke", "acquire"] as const) {
        expect(shouldOfferRevocationRecovery({
          ...base,
          acquisitionStatus: "failed",
          pendingKind,
        })).toBe(false);
      }
      expect(shouldOfferRevocationRecovery({
        ...base,
        acquisitionStatus: "failed",
        persistedPendingSubmission: true,
      })).toBe(false);
      expect(shouldOfferRevocationRecovery({
        ...base,
        acquisitionStatus: "signed_pending",
        blocked: true,
      })).toBe(false);
    });

    it("keeps the existing Ready revocation path without a duplicate recovery control", () => {
      expect(requiresDevRevocationBeforeExit("dev", verifiedLink)).toBe(true);
      expect(hasVerifiedRevocationContext(base)).toBe(true);
      expect(hasVerifiedRevocationContext({ ...base, walletConnected: false })).toBe(false);
      expect(hasVerifiedRevocationContext({ ...base, account: verifiedLink.delegate })).toBe(false);
      expect(shouldOfferRevocationRecovery({
        ...base,
        step: "ready",
        acquisitionStatus: "failed",
        blocked: true,
      })).toBe(false);
    });

    it("recognizes every valid persisted onboarding transaction as unresolved", () => {
      const stored = JSON.stringify({
        version: 1,
        kind: "revoke",
        hash: "A".repeat(64),
        account: owner,
        network: "testnet",
        expectedDelegate: verifiedLink.delegate,
        lastLedgerSequence: 1_024,
        expectedTx: {
          TransactionType: "DelegateSet",
          Account: owner,
          Authorize: verifiedLink.delegate,
          Permissions: [],
          LastLedgerSequence: 1_024,
        },
      });
      expect(hasPersistedPendingSubmission(stored)).toBe(true);
      expect(hasPersistedPendingSubmission(JSON.stringify({ kind: "revoke" }))).toBe(false);
    });

    it("clears the persisted guard when restored TrustSet success advances to acquisition", () => {
      const storage = { removeItem: vi.fn() };
      const setGuard = vi.fn();
      clearPersistedOnboardingPending(storage, setGuard);
      expect(storage.removeItem).toHaveBeenCalledWith("pilot:onboarding-pending");
      expect(setGuard).toHaveBeenCalledWith(false);
    });
  });
});
