import { describe, expect, it, vi } from "vitest";

import type { OpContext } from "../src/catalog/registry";
import { DEFAULT_POLICY, type Policy } from "../src/contracts";
import { DEFAULT_DELEGATED_PERMISSIONS } from "../src/exec/delegation";
import type {
  BuildRow,
  ExecutionRow,
  LinkRow,
  PolicyRow,
} from "../src/exec/store";
import { LOCAL_TRADING_BUILD_ORIGIN } from "../src/local-trading";
import {
  LOCAL_TRADING_ONBOARDING_BUILD_ORIGIN,
  LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE,
} from "../src/local-trading-onboarding";
import {
  handleOnboardingReadiness,
  ops,
  type OnboardingReadinessServices,
} from "../src/ops/onboarding";

const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const DELEGATE = "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn";
const HASH = "A".repeat(64);
const LEDGER_HASH = "B".repeat(64);
const KMS_PUBLIC_KEY = "ED5FECF30EB0A0D79F4DE01D42E43FBF2375A07E03A29F6C5079A5575BAF2A9054";
const KMS_DELEGATE = "rD4gs512CwAsi1Z6JP7xJnt8DDutSiaQJm";
const KMS_ALIAS = "alias/harbor/testnet/link-kms";
const ED25519_SPKI_PREFIX = "302A300506032B6570032100";

function kmsSpki(): string {
  return Buffer.from(`${ED25519_SPKI_PREFIX}${KMS_PUBLIC_KEY.slice(2)}`, "hex").toString("base64");
}

const reviewedEnvironment = {
  EXEC_NETWORK: "testnet",
  EXECUTOR: "quickjs",
  MAINNET_EXECUTION: "false",
  HARBOR_LOCAL_DEV: "true",
  HARBOR_LOCAL_READ_ONLY: "false",
  HARBOR_LOCAL_AUTH_REQUIRED: "true",
  HARBOR_LOCAL_CRON_DISABLED: "true",
  HARBOR_LOCAL_X402: "false",
  HARBOR_LOCAL_X402_RUNTIME_ENABLED: "false",
  HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED: "true",
  HARBOR_LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE:
    LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE,
  HARBOR_SOURCE_TAG: "2610240",
  HARBOR_KEK: "test-kek-never-returned",
};

function policy(): Policy {
  return {
    ...DEFAULT_POLICY,
    allowed_tx_types: [...DEFAULT_POLICY.allowed_tx_types],
    issuer_allowlist: [...DEFAULT_POLICY.issuer_allowlist],
    networks: [...DEFAULT_POLICY.networks],
  };
}

function link(): LinkRow {
  return {
    id: "link-1",
    principal: "operator",
    owner: OWNER,
    network: "testnet",
    delegate: DELEGATE,
    delegateSeedEnc: new Uint8Array([1, 2, 3]).buffer,
    iv: new Uint8Array(12).fill(4).buffer,
    permissions: [...DEFAULT_DELEGATED_PERMISSIONS],
    status: "active",
    lastLedger: 800,
    revokeTx: null,
    createdAt: "2026-10-19T00:00:00.000Z",
  };
}

function storedPolicy(value = policy()): PolicyRow {
  return {
    principal: "operator",
    owner: OWNER,
    network: "testnet",
    json: value,
    updatedAt: "2026-10-19T00:00:00.000Z",
  };
}

const LIMIT_AMOUNT = {
  currency: "RLUSD",
  issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
  value: "1000000",
};
const MEMOS = [
  { Memo: { MemoType: "70696C6F742F696E74656E74", MemoData: "6F6E626F617264696E67" } },
];

function build(): BuildRow {
  return {
    id: "trust-set-build",
    principal: "operator",
    owner: OWNER,
    network: "testnet",
    txJson: {
      TransactionType: "TrustSet",
      Account: OWNER,
      LimitAmount: LIMIT_AMOUNT,
      SourceTag: 2610240,
      Memos: MEMOS,
    },
    summary: {
      action: "Set RLUSD trust line",
      account: OWNER,
      amounts: [],
      fee_drops: "12",
      reserve_delta_drops: "0",
    },
    lastLedgerSeq: 900,
    createdAt: "2026-10-19T00:00:00.000Z",
    originProfile: LOCAL_TRADING_ONBOARDING_BUILD_ORIGIN,
  };
}

function execution(): ExecutionRow {
  return {
    id: "trust-set-execution",
    principal: "operator",
    buildId: "trust-set-build",
    idempotencyKey: "operator:onboarding-trust-set",
    status: "executed",
    hash: HASH,
    usdValue: 0,
    signedBy: "delegate",
    createdAt: "2026-10-19T00:00:00.000Z",
  };
}

function services(
  overrides: Partial<OnboardingReadinessServices> = {},
): OnboardingReadinessServices {
  const row = link();
  const storedBuild = build();
  return {
    store: {
      getLink: vi.fn(async () => row),
      getPolicy: vi.fn(async () => storedPolicy()),
      findExecutionByHash: vi.fn(async () => execution()),
      getBuild: vi.fn(async () => storedBuild),
    },
    readDelegate: vi.fn(async () => ({
      LedgerEntryType: "Delegate",
      Account: OWNER,
      Authorize: DELEGATE,
      Permissions: DEFAULT_DELEGATED_PERMISSIONS.map((PermissionValue) => ({
        Permission: { PermissionValue },
      })),
      ledger_index: 801,
    })),
    attestDelegate: vi.fn(async (identity, wrapped) =>
      identity.principal === "operator" &&
      identity.owner === OWNER &&
      identity.network === "testnet" &&
      wrapped.address === DELEGATE,
    ),
    readTransaction: vi.fn(async () => ({
      hash: HASH,
      validated: true,
      ledger_index: 802,
      meta: { TransactionResult: "tesSUCCESS" },
      tx_json: {
        TransactionType: "TrustSet",
        Account: OWNER,
        LimitAmount: LIMIT_AMOUNT,
        SourceTag: 2610240,
        Memos: MEMOS,
      },
    })),
    readAccountLines: vi.fn(async () => ({
      account: OWNER,
      validated: true,
      ledger_index: 803,
      ledger_hash: LEDGER_HASH,
      lines: [{
        account: LIMIT_AMOUNT.issuer,
        currency: LIMIT_AMOUNT.currency,
        balance: "0",
        limit: LIMIT_AMOUNT.value,
      }],
    })),
    readIssuerAccount: vi.fn(async () => ({
      validated: true,
      ledger_index: 803,
      account_data: {
        Account: LIMIT_AMOUNT.issuer,
        Flags: 0,
      },
    })),
    ...overrides,
  };
}

function context(configured: OnboardingReadinessServices, env = reviewedEnvironment): OpContext {
  return {
    principal: "operator",
    localDevRequest: true,
    env,
    onboardingReadinessServices: configured,
  };
}

function args(expectedPolicy = policy()) {
  return {
    owner: OWNER,
    network: "testnet" as const,
    expected_policy: expectedPolicy,
    trust_set_hash: HASH,
  };
}

describe("authenticated onboarding readiness attestation", () => {
  it("exports only the explicit readiness operation from this module", () => {
    expect(ops.map((operation) => operation.name)).toEqual([
      "onboarding.readiness",
    ]);
  });

  it("reports ready only with every exact persisted and validated fact", async () => {
    const result = await handleOnboardingReadiness(context(services()), args());

    expect(result).toEqual({
      ready: true,
      scope: { owner: OWNER, network: "testnet" },
      checks: {
        reviewed_runtime: true,
        exact_active_link: true,
        exact_persisted_policy: true,
        usable_encrypted_delegate: true,
        validated_trust_set: true,
        usable_trust_line: true,
      },
      evidence: {
        delegate: DELEGATE,
        link_ledger_index: 801,
        trust_set_hash: HASH,
        trust_set_ledger_index: 802,
        trust_line_ledger_index: 803,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/seed|secret|private|mnemonic|test-kek/i);
  });

  it("accepts recursively reordered object keys in validated TrustSet fields", async () => {
    const configured = services({
      readTransaction: vi.fn(async () => ({
        hash: HASH,
        validated: true,
        ledger_index: 802,
        meta: { TransactionResult: "tesSUCCESS" },
        tx_json: {
          Account: OWNER,
          TransactionType: "TrustSet",
          LimitAmount: {
            value: LIMIT_AMOUNT.value,
            issuer: LIMIT_AMOUNT.issuer,
            currency: LIMIT_AMOUNT.currency,
          },
          Memos: [{
            Memo: {
              MemoData: MEMOS[0].Memo.MemoData,
              MemoType: MEMOS[0].Memo.MemoType,
            },
          }],
          SourceTag: 2610240,
        },
      })),
    });

    const result = await handleOnboardingReadiness(context(configured), args());

    expect(result.ready).toBe(true);
    expect(result.checks.validated_trust_set).toBe(true);
    expect(result.checks.usable_trust_line).toBe(true);
  });

  it.each([
    ["nested value", {
      LimitAmount: LIMIT_AMOUNT,
      Memos: [{ Memo: { ...MEMOS[0].Memo, MemoData: "00" } }],
    }],
    ["nested type", {
      LimitAmount: { ...LIMIT_AMOUNT, value: 1000000 },
      Memos: MEMOS,
    }],
    ["extra nested field", {
      LimitAmount: LIMIT_AMOUNT,
      Memos: [{ Memo: { ...MEMOS[0].Memo, Unexpected: "field" } }],
    }],
  ])("rejects a validated TrustSet with a %s mismatch", async (_case, fields) => {
    const configured = services({
      readTransaction: vi.fn(async () => ({
        hash: HASH,
        validated: true,
        ledger_index: 802,
        meta: { TransactionResult: "tesSUCCESS" },
        tx_json: {
          TransactionType: "TrustSet",
          Account: OWNER,
          SourceTag: 2610240,
          ...fields,
        },
      })),
    });

    const result = await handleOnboardingReadiness(context(configured), args());

    expect(result.ready).toBe(false);
    expect(result.checks.validated_trust_set).toBe(false);
    expect(result.checks.usable_trust_line).toBe(false);
  });

  it("preserves memo array order when comparing the validated TrustSet", async () => {
    const secondMemo = {
      Memo: { MemoType: "7365636F6E64", MemoData: "6D656D6F" },
    };
    const storedBuild = build();
    storedBuild.txJson = {
      ...storedBuild.txJson,
      Memos: [MEMOS[0], secondMemo],
    };
    const configured = services({
      store: {
        getLink: vi.fn(async () => link()),
        getPolicy: vi.fn(async () => storedPolicy()),
        findExecutionByHash: vi.fn(async () => execution()),
        getBuild: vi.fn(async () => storedBuild),
      },
      readTransaction: vi.fn(async () => ({
        hash: HASH,
        validated: true,
        ledger_index: 802,
        meta: { TransactionResult: "tesSUCCESS" },
        tx_json: {
          TransactionType: "TrustSet",
          Account: OWNER,
          LimitAmount: LIMIT_AMOUNT,
          SourceTag: 2610240,
          Memos: [secondMemo, MEMOS[0]],
        },
      })),
    });

    const result = await handleOnboardingReadiness(context(configured), args());

    expect(result.ready).toBe(false);
    expect(result.checks.validated_trust_set).toBe(false);
    expect(result.checks.usable_trust_line).toBe(false);
  });

  it("fails closed before reading state outside the exact reviewed runtime", async () => {
    const configured = services();
    const result = await handleOnboardingReadiness(
      context(configured, { ...reviewedEnvironment, EXECUTOR: "dynamic" }),
      args(),
    );

    expect(result.ready).toBe(false);
    expect(result.checks).toEqual({
      reviewed_runtime: false,
      exact_active_link: false,
      exact_persisted_policy: false,
      usable_encrypted_delegate: false,
      validated_trust_set: false,
      usable_trust_line: false,
    });
    expect(configured.store?.getLink).not.toHaveBeenCalled();
  });

  it("rejects reordered stored permission and issuer allowlists", async () => {
    const widenedLink = link();
    widenedLink.permissions = [...DEFAULT_DELEGATED_PERMISSIONS].reverse();
    const reorderedPolicy = policy();
    reorderedPolicy.issuer_allowlist = ["rIssuer", ...reorderedPolicy.issuer_allowlist];
    const configured = services({
      store: {
        getLink: vi.fn(async () => widenedLink),
        getPolicy: vi.fn(async () => storedPolicy(reorderedPolicy)),
        findExecutionByHash: vi.fn(async () => execution()),
        getBuild: vi.fn(async () => build()),
      },
    });

    const result = await handleOnboardingReadiness(context(configured), args());
    expect(result.ready).toBe(false);
    expect(result.checks.exact_active_link).toBe(false);
    expect(result.checks.exact_persisted_policy).toBe(false);
  });

  it("does not treat an unavailable encrypted delegate as handoff-ready", async () => {
    const configured = services({
      attestDelegate: vi.fn(async () => {
        throw new Error("secret decryption diagnostic must not escape");
      }),
    });
    const result = await handleOnboardingReadiness(context(configured), args());

    expect(result.ready).toBe(false);
    expect(result.checks.usable_encrypted_delegate).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/secret|diagnostic/i);
  });

  it("attests a KMS-backed delegate by exact alias and public address in sign mode", async () => {
    const kmsLink: LinkRow = {
      ...link(),
      id: "link-kms",
      delegate: KMS_DELEGATE,
      keyBackend: "kms",
      delegateSeedEnc: null,
      iv: null,
      kmsKeyId: "standin-key-id",
      kmsAlias: KMS_ALIAS,
    };
    const getPublicKey = vi.fn(async () => ({ PublicKey: kmsSpki() }));
    const configured = services({
      store: {
        getLink: vi.fn(async () => kmsLink),
        getPolicy: vi.fn(async () => storedPolicy()),
        findExecutionByHash: vi.fn(async () => execution()),
        getBuild: vi.fn(async () => build()),
      },
      readDelegate: vi.fn(async () => ({
        LedgerEntryType: "Delegate",
        Account: OWNER,
        Authorize: KMS_DELEGATE,
        Permissions: DEFAULT_DELEGATED_PERMISSIONS.map((PermissionValue) => ({
          Permission: { PermissionValue },
        })),
        ledger_index: 801,
      })),
      kmsClient: { getPublicKey },
      attestDelegate: vi.fn(async () => {
        throw new Error("local delegate attestation must not run");
      }),
    });
    const result = await handleOnboardingReadiness(
      context(configured, {
        ...reviewedEnvironment,
        KMS_MODE: "sign",
        HARBOR_KEK: undefined,
      }),
      args(),
    );

    expect(result.ready).toBe(true);
    expect(result.checks.usable_encrypted_delegate).toBe(true);
    expect(result.evidence.delegate).toBe(KMS_DELEGATE);
    expect(getPublicKey).toHaveBeenCalledWith({ KeyId: KMS_ALIAS });
    expect(configured.attestDelegate).not.toHaveBeenCalled();
  });

  it.each([
    ["missing execution", null, build(), "tesSUCCESS", true],
    ["non-terminal execution", { ...execution(), status: "submitted" as const }, build(), "tesSUCCESS", true],
    ["wrong build type", execution(), { ...build(), txJson: { ...build().txJson, TransactionType: "OfferCreate" } }, "tesSUCCESS", true],
    ["legacy build provenance", execution(), { ...build(), originProfile: null }, "tesSUCCESS", true],
    ["trading build provenance", execution(), { ...build(), originProfile: LOCAL_TRADING_BUILD_ORIGIN }, "tesSUCCESS", true],
    ["failed ledger result", execution(), build(), "tecNO_LINE", true],
    ["unvalidated ledger result", execution(), build(), "tesSUCCESS", false],
  ])("returns ready:false for %s", async (_case, storedExecution, storedBuild, engineResult, validated) => {
    const configured = services({
      store: {
        getLink: vi.fn(async () => link()),
        getPolicy: vi.fn(async () => storedPolicy()),
        findExecutionByHash: vi.fn(async () => storedExecution),
        getBuild: vi.fn(async () => storedBuild),
      },
      readTransaction: vi.fn(async () => ({
        hash: HASH,
        validated,
        ledger_index: 802,
        meta: { TransactionResult: engineResult },
        tx_json: {
          TransactionType: "TrustSet",
          Account: OWNER,
          LimitAmount: LIMIT_AMOUNT,
          SourceTag: 2610240,
          Memos: MEMOS,
        },
      })),
    });
    const result = await handleOnboardingReadiness(context(configured), args());

    expect(result.ready).toBe(false);
    expect(result.checks.validated_trust_set).toBe(false);
    expect(result.evidence).not.toHaveProperty("trust_set_hash");
  });

  it.each([
    ["removed", []],
    ["changed issuer", [{
      account: DELEGATE,
      currency: LIMIT_AMOUNT.currency,
      balance: "0",
      limit: LIMIT_AMOUNT.value,
    }]],
    ["changed currency", [{
      account: LIMIT_AMOUNT.issuer,
      currency: "USD",
      balance: "0",
      limit: LIMIT_AMOUNT.value,
    }]],
  ])("rejects a %s current trust line", async (_case, lines) => {
    const configured = services({
      readAccountLines: vi.fn(async () => ({
        account: OWNER,
        validated: true,
        ledger_index: 803,
        ledger_hash: LEDGER_HASH,
        lines,
      })),
    });

    const result = await handleOnboardingReadiness(context(configured), args());

    expect(result.ready).toBe(false);
    expect(result.checks.validated_trust_set).toBe(true);
    expect(result.checks.usable_trust_line).toBe(false);
    expect(result.evidence).not.toHaveProperty("trust_line_ledger_index");
    expect(configured.readIssuerAccount).not.toHaveBeenCalled();
  });

  it.each([
    ["owner freeze", { freeze: true }],
    ["issuer freeze", { freeze_peer: true }],
    ["owner deep freeze", { deep_freeze: true }],
    ["issuer deep freeze", { deep_freeze_peer: true }],
    ["reduced limit", { limit: "999999.999999999" }],
    ["increased limit", { limit: "1000001" }],
    ["exhausted limit", { balance: LIMIT_AMOUNT.value }],
  ])("rejects an unusable current trust line with %s", async (_case, state) => {
    const configured = services({
      readAccountLines: vi.fn(async () => ({
        account: OWNER,
        validated: true,
        ledger_index: 803,
        ledger_hash: LEDGER_HASH,
        lines: [{
          account: LIMIT_AMOUNT.issuer,
          currency: LIMIT_AMOUNT.currency,
          balance: "0",
          limit: LIMIT_AMOUNT.value,
          ...state,
        }],
      })),
    });

    const result = await handleOnboardingReadiness(context(configured), args());

    expect(result.ready).toBe(false);
    expect(result.checks.validated_trust_set).toBe(true);
    expect(result.checks.usable_trust_line).toBe(false);
  });

  it("requires issuer authorization when the current issuer has RequireAuth", async () => {
    const configured = services({
      readIssuerAccount: vi.fn(async () => ({
        validated: true,
        ledger_index: 803,
        account_data: {
          Account: LIMIT_AMOUNT.issuer,
          Flags: 0x0004_0000,
        },
      })),
    });

    const unauthorized = await handleOnboardingReadiness(context(configured), args());
    expect(unauthorized.ready).toBe(false);
    expect(unauthorized.checks.usable_trust_line).toBe(false);

    configured.readAccountLines = vi.fn(async () => ({
      account: OWNER,
      validated: true,
      ledger_index: 803,
      ledger_hash: LEDGER_HASH,
      lines: [{
        account: LIMIT_AMOUNT.issuer,
        currency: LIMIT_AMOUNT.currency,
        balance: "0",
        limit: LIMIT_AMOUNT.value,
        peer_authorized: true,
      }],
    }));
    const authorized = await handleOnboardingReadiness(context(configured), args());
    expect(authorized.ready).toBe(true);
    expect(authorized.checks.usable_trust_line).toBe(true);
  });

  it("rejects a current issuer GlobalFreeze", async () => {
    const configured = services({
      readIssuerAccount: vi.fn(async () => ({
        validated: true,
        ledger_index: 803,
        account_data: {
          Account: LIMIT_AMOUNT.issuer,
          Flags: 0x0040_0000,
        },
      })),
    });

    const result = await handleOnboardingReadiness(context(configured), args());
    expect(result.ready).toBe(false);
    expect(result.checks.validated_trust_set).toBe(true);
    expect(result.checks.usable_trust_line).toBe(false);
  });

  it("uses bounded adapter reads and binds issuer state to the trust-line ledger", async () => {
    const configured = services();
    delete configured.readAccountLines;
    delete configured.readIssuerAccount;
    const request = vi.fn(async (
      _network: string,
      command: string,
    ): Promise<Record<string, unknown>> => {
      if (command === "account_lines") {
        return {
          account: OWNER,
          validated: true,
          ledger_index: 803,
          ledger_hash: LEDGER_HASH,
          lines: [{
            account: LIMIT_AMOUNT.issuer,
            currency: LIMIT_AMOUNT.currency,
            balance: "0",
            limit: LIMIT_AMOUNT.value,
          }],
        };
      }
      if (command === "account_info") {
        return {
          validated: true,
          ledger_index: 803,
          account_data: { Account: LIMIT_AMOUNT.issuer, Flags: 0 },
        };
      }
      throw new Error("unexpected XRPL method");
    });
    const ctx = {
      ...context(configured),
      xrplRpc: { request },
    };

    const result = await handleOnboardingReadiness(ctx, args());

    expect(result.ready).toBe(true);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "testnet",
      "account_lines",
      {
        account: OWNER,
        peer: LIMIT_AMOUNT.issuer,
        ledger_index: "validated",
        limit: 400,
      },
      undefined,
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "testnet",
      "account_info",
      {
        account: LIMIT_AMOUNT.issuer,
        ledger_hash: LEDGER_HASH,
      },
      undefined,
    );
  });

  it("preserves validated TrustSet provenance when current line evidence cannot be read", async () => {
    const configured = services({
      readAccountLines: vi.fn(async () => {
        throw new Error("current ledger unavailable");
      }),
    });

    const result = await handleOnboardingReadiness(context(configured), args());

    expect(result.ready).toBe(false);
    expect(result.checks.validated_trust_set).toBe(true);
    expect(result.checks.usable_trust_line).toBe(false);
    expect(result.evidence).toMatchObject({
      trust_set_hash: HASH,
      trust_set_ledger_index: 802,
    });
  });

  it.each([
    ["unvalidated lines", { validated: false }],
    ["paginated lines", { marker: "more" }],
    ["wrong owner", { account: DELEGATE }],
  ])("fails closed for %s evidence", async (_case, override) => {
    const configured = services({
      readAccountLines: vi.fn(async () => ({
        account: OWNER,
        validated: true,
        ledger_index: 803,
        ledger_hash: LEDGER_HASH,
        lines: [{
          account: LIMIT_AMOUNT.issuer,
          currency: LIMIT_AMOUNT.currency,
          balance: "0",
          limit: LIMIT_AMOUNT.value,
        }],
        ...override,
      })),
    });

    const result = await handleOnboardingReadiness(context(configured), args());
    expect(result.ready).toBe(false);
    expect(result.checks.usable_trust_line).toBe(false);
  });

  it.each([
    ["unvalidated issuer", { validated: false }],
    ["different issuer ledger", { ledger_hash: "C".repeat(64) }],
    ["malformed issuer flags", { account_data: { Account: LIMIT_AMOUNT.issuer, Flags: "0" } }],
  ])("fails closed for %s evidence", async (_case, override) => {
    const configured = services({
      readIssuerAccount: vi.fn(async () => ({
        validated: true,
        ledger_index: 803,
        account_data: {
          Account: LIMIT_AMOUNT.issuer,
          Flags: 0,
        },
        ...override,
      })),
    });

    const result = await handleOnboardingReadiness(context(configured), args());
    expect(result.ready).toBe(false);
    expect(result.checks.validated_trust_set).toBe(true);
    expect(result.checks.usable_trust_line).toBe(false);
  });
});
