import { describe, expect, it, vi } from "vitest";

import type { OpContext } from "../src/catalog/registry";
import type { ApprovalRow, BuildRow, ExecutionRow, Store } from "../src/exec/store";
import {
  LOCAL_TRADING_ISOLATED_V1_BUILD_ORIGIN,
  LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE,
} from "../src/local-trading-isolated-v1";
import { LOCAL_TRADING_SIGNING_PROFILE } from "../src/local-trading";
import { LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE } from "../src/local-trading-onboarding";
import {
  handleTxApprovalPreflight,
  handleTxApprovalReconcile,
  handleTxExecute,
  handleTxStatus,
  handleTxSubmit,
  type ExecutionServices,
} from "../src/ops/tx-exec";

const PRINCIPAL = "isolated-execution-tests";
const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const HASH = "A".repeat(64);
const BINDING = "B".repeat(64);

const REVIEWED_ISOLATED_ENV = {
  EXEC_NETWORK: "testnet",
  EXECUTOR: "quickjs",
  MAINNET_EXECUTION: "false",
  HARBOR_LOCAL_DEV: "true",
  HARBOR_LOCAL_READ_ONLY: "false",
  HARBOR_LOCAL_AUTH_REQUIRED: "true",
  HARBOR_LOCAL_CRON_DISABLED: "true",
  HARBOR_LOCAL_X402: "false",
  HARBOR_LOCAL_X402_RUNTIME_ENABLED: "false",
  HARBOR_LOCAL_TRADING_ISOLATED_V1_RUNTIME_ENABLED: "true",
  HARBOR_LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE:
    LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE,
  HARBOR_SOURCE_TAG: "2610240",
} as const;

const REVIEWED_LOCAL_BASE = {
  EXEC_NETWORK: "testnet",
  EXECUTOR: "quickjs",
  MAINNET_EXECUTION: "false",
  HARBOR_LOCAL_DEV: "true",
  HARBOR_LOCAL_READ_ONLY: "false",
  HARBOR_LOCAL_AUTH_REQUIRED: "true",
  HARBOR_LOCAL_CRON_DISABLED: "true",
  HARBOR_LOCAL_X402: "false",
  HARBOR_LOCAL_X402_RUNTIME_ENABLED: "false",
  HARBOR_SOURCE_TAG: "2610240",
} as const;

const REVIEWED_TRADING_ENV = {
  ...REVIEWED_LOCAL_BASE,
  HARBOR_LOCAL_TRADING_RUNTIME_ENABLED: "true",
  HARBOR_LOCAL_TRADING_SIGNING_PROFILE: LOCAL_TRADING_SIGNING_PROFILE,
} as const;

const REVIEWED_ONBOARDING_ENV = {
  ...REVIEWED_LOCAL_BASE,
  HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED: "true",
  HARBOR_LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE:
    LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE,
} as const;

function build(
  originProfile: BuildRow["originProfile"],
  network: BuildRow["network"] = "testnet",
): BuildRow {
  return {
    id: "isolated-build",
    principal: PRINCIPAL,
    owner: OWNER,
    network,
    txJson: {
      TransactionType: "OfferCreate",
      Account: OWNER,
      TakerGets: "1000000",
      TakerPays: {
        currency: "USD",
        issuer: OWNER,
        value: "1",
      },
      Fee: "12",
      Sequence: 1,
      LastLedgerSequence: 100,
    },
    summary: {
      action: "swap",
      account: OWNER,
      amounts: [],
      fee_drops: "12",
      reserve_delta_drops: "0",
      usd_value: "1",
    },
    lastLedgerSeq: 100,
    createdAt: "2026-10-20T00:00:00.000Z",
    originProfile,
    executionContract: null,
    buildRevision: null,
  };
}

function execution(): ExecutionRow {
  return {
    id: "isolated-execution",
    principal: PRINCIPAL,
    buildId: "isolated-build",
    idempotencyKey: `${PRINCIPAL}:replay`,
    status: "failed",
    hash: null,
    usdValue: 0,
    signedBy: null,
    createdAt: "2026-10-20T00:00:00.000Z",
  };
}

function approval(): ApprovalRow {
  return {
    id: "isolated-approval",
    principal: PRINCIPAL,
    buildId: "isolated-build",
    txJson: {},
    expiresAt: "2026-10-20T00:01:00.000Z",
    status: "pending",
    executionId: "isolated-execution",
    executionContract: "xrpl_execution_v2",
    buildRevision: 1,
  };
}

function recoveryRow() {
  return {
    approval_id: "isolated-approval",
    execution_id: "isolated-execution",
    build_id: "isolated-build",
    build_revision: 1,
    unsigned_tx_digest: BINDING,
    economic_fingerprint: BINDING,
    validated_ledger: 200,
    first_inclusion_ledger: 101,
    last_ledger_sequence: 164,
    approval_status: "expired",
    execution_status: "failed",
    hash: null,
    signed_by: null,
    result_detail: JSON.stringify({
      result: {
        status: "failed",
        engine_result: "APPROVAL_RECOVERED_NONINCLUSION",
      },
    }),
  };
}

function database(first: unknown = null): D1Database {
  const statement = {
    bind: vi.fn(function bind() {
      return statement;
    }),
    first: vi.fn(async () => first),
  };
  return {
    prepare: vi.fn(() => statement),
  } as unknown as D1Database;
}

function context(
  store: Partial<Store>,
  options: {
    db?: D1Database;
    services?: Partial<ExecutionServices>;
    env?: Record<string, unknown>;
  } = {},
): OpContext {
  return {
    principal: PRINCIPAL,
    localDevRequest: true,
    db: options.db ?? database(),
    env: options.env ?? REVIEWED_ISOLATED_ENV,
    executionServices: {
      store: store as Store,
      ...options.services,
    },
  } as OpContext;
}

describe("isolated local trading durable execution origin", () => {
  it.each([null, "local-trading", "local-trading-onboarding"] as const)(
    "rejects a fresh execute build with origin %j before policy, signing, or submission",
    async (origin) => {
      const getPolicy = vi.fn();
      const signDelegate = vi.fn();
      const submitSigned = vi.fn();
      const store = {
        findExecutionByIdempotencyKey: vi.fn(async () => null),
        getBuild: vi.fn(async () => build(origin)),
        getPolicy,
      };

      await expect(
        handleTxExecute(
          context(store, { services: { signDelegate, submitSigned } }),
          { build_id: "isolated-build", idempotency_key: "fresh" },
        ),
      ).rejects.toThrow(/build created by the isolated profile/i);

      expect(getPolicy).not.toHaveBeenCalled();
      expect(signDelegate).not.toHaveBeenCalled();
      expect(submitSigned).not.toHaveBeenCalled();
    },
  );

  it("accepts the exact isolated origin through the origin gate", async () => {
    const getPolicy = vi.fn(async () => null);
    const signDelegate = vi.fn();
    const submitSigned = vi.fn();
    const store = {
      findExecutionByIdempotencyKey: vi.fn(async () => null),
      getBuild: vi.fn(async () => build(LOCAL_TRADING_ISOLATED_V1_BUILD_ORIGIN)),
      getPolicy,
    };

    await expect(
      handleTxExecute(
        context(store, { services: { signDelegate, submitSigned } }),
        { build_id: "isolated-build", idempotency_key: "fresh" },
      ),
    ).rejects.toThrow(/exact principal, owner, and network policy/i);

    expect(getPolicy).toHaveBeenCalled();
    expect(signDelegate).not.toHaveBeenCalled();
    expect(submitSigned).not.toHaveBeenCalled();
  });

  it("rejects a v2 idempotent execute replay from another build origin", async () => {
    const status = vi.fn();
    const store = {
      findExecutionByIdempotencyKey: vi.fn(async () => execution()),
      getBuild: vi.fn(async () => build("local-trading")),
      getExecutionSnapshot: vi.fn(),
    };

    await expect(
      handleTxExecute(
        context(store, { services: { status } }),
        {
          build_id: "isolated-build",
          idempotency_key: "replay",
          execution_contract: "xrpl_execution_v2",
          build_revision: 1,
        },
      ),
    ).rejects.toThrow(/build created by the isolated profile/i);

    expect(store.getExecutionSnapshot).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it("rejects an isolated-origin execute replay under the legacy trading profile", async () => {
    const getExecutionSnapshot = vi.fn();
    const store = {
      findExecutionByIdempotencyKey: vi.fn(async () => execution()),
      getBuild: vi.fn(async () => build(LOCAL_TRADING_ISOLATED_V1_BUILD_ORIGIN)),
      getExecutionSnapshot,
    };

    await expect(
      handleTxExecute(
        context(store, { env: REVIEWED_TRADING_ENV }),
        {
          build_id: "isolated-build",
          idempotency_key: "replay",
          execution_contract: "xrpl_execution_v2",
          build_revision: 1,
        },
      ),
    ).rejects.toThrow(/exact isolated context/i);

    expect(getExecutionSnapshot).not.toHaveBeenCalled();
  });

  it("rejects an isolated-origin devnet build on an isolated v2 execute replay", async () => {
    const getExecutionSnapshot = vi.fn();
    const store = {
      findExecutionByIdempotencyKey: vi.fn(async () => execution()),
      getBuild: vi.fn(async () =>
        build(LOCAL_TRADING_ISOLATED_V1_BUILD_ORIGIN, "devnet"),
      ),
      getExecutionSnapshot,
    };

    await expect(
      handleTxExecute(context(store), {
        build_id: "isolated-build",
        idempotency_key: "replay",
        execution_contract: "xrpl_execution_v2",
        build_revision: 1,
      }),
    ).rejects.toThrow(/on Testnet/i);

    expect(getExecutionSnapshot).not.toHaveBeenCalled();
  });

  it("rejects a devnet authoritative snapshot on an isolated v2 execute replay", async () => {
    const status = vi.fn();
    const getBuildRevision = vi.fn(async () => ({ network: "devnet" }));
    const store = {
      findExecutionByIdempotencyKey: vi.fn(async () => ({
        ...execution(),
        status: "submitted" as const,
        hash: HASH,
        signedBy: "delegate" as const,
      })),
      getBuild: vi.fn(async () =>
        build(LOCAL_TRADING_ISOLATED_V1_BUILD_ORIGIN),
      ),
      getEvent: vi.fn(async () => null),
      getExecutionSnapshot: vi.fn(async () => ({
        executionId: "isolated-execution",
        snapshotNetwork: "devnet",
      })),
      getBuildRevision,
    };

    await expect(
      handleTxExecute(
        context(store, { services: { status } }),
        {
          build_id: "isolated-build",
          idempotency_key: "replay",
          execution_contract: "xrpl_execution_v2",
          build_revision: 1,
        },
      ),
    ).rejects.toThrow(/authoritative Testnet snapshot/i);

    expect(getBuildRevision).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it("rejects preflight from another build origin before ledger evidence", async () => {
    const getExecution = vi.fn();
    const store = {
      getApproval: vi.fn(async () => approval()),
      getBuild: vi.fn(async () => build("local-trading")),
      getExecution,
    };

    await expect(
      handleTxApprovalPreflight(context(store), {
        approval_id: "isolated-approval",
        execution_contract: "xrpl_execution_v2",
        build_revision: 1,
        unsigned_tx_digest: BINDING,
        economic_fingerprint: BINDING,
      }),
    ).rejects.toThrow(/build created by the isolated profile/i);

    expect(getExecution).not.toHaveBeenCalled();
  });

  it.each([
    ["legacy trading", REVIEWED_TRADING_ENV],
    ["onboarding", REVIEWED_ONBOARDING_ENV],
  ] as const)(
    "rejects isolated-origin preflight under the reviewed %s profile",
    async (_profile, env) => {
      const getExecution = vi.fn();
      const store = {
        getApproval: vi.fn(async () => approval()),
        getBuild: vi.fn(async () =>
          build(LOCAL_TRADING_ISOLATED_V1_BUILD_ORIGIN),
        ),
        getExecution,
      };

      await expect(
        handleTxApprovalPreflight(context(store, { env }), {
          approval_id: "isolated-approval",
          execution_contract: "xrpl_execution_v2",
          build_revision: 1,
          unsigned_tx_digest: BINDING,
          economic_fingerprint: BINDING,
        }),
      ).rejects.toThrow(/exact isolated context/i);

      expect(getExecution).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["legacy trading", REVIEWED_TRADING_ENV],
    ["onboarding", REVIEWED_ONBOARDING_ENV],
  ] as const)(
    "requires an origin-bearing base build for reviewed %s preflight",
    async (_profile, env) => {
      const getExecution = vi.fn();
      const store = {
        getApproval: vi.fn(async () => approval()),
        getBuild: vi.fn(async () => null),
        getExecution,
      };

      await expect(
        handleTxApprovalPreflight(context(store, { env }), {
          approval_id: "isolated-approval",
          execution_contract: "xrpl_execution_v2",
          build_revision: 1,
          unsigned_tx_digest: BINDING,
          economic_fingerprint: BINDING,
        }),
      ).rejects.toThrow(/origin-bearing base build/i);

      expect(getExecution).not.toHaveBeenCalled();
    },
  );

  it("rejects isolated-origin devnet preflight before ledger evidence", async () => {
    const getExecution = vi.fn();
    const store = {
      getApproval: vi.fn(async () => approval()),
      getBuild: vi.fn(async () =>
        build(LOCAL_TRADING_ISOLATED_V1_BUILD_ORIGIN, "devnet"),
      ),
      getExecution,
    };

    await expect(
      handleTxApprovalPreflight(context(store), {
        approval_id: "isolated-approval",
        execution_contract: "xrpl_execution_v2",
        build_revision: 1,
        unsigned_tx_digest: BINDING,
        economic_fingerprint: BINDING,
      }),
    ).rejects.toThrow(/on Testnet/i);

    expect(getExecution).not.toHaveBeenCalled();
  });

  it("rejects a durable reconcile replay from another build origin before RPC", async () => {
    const getApproval = vi.fn();
    const store = {
      getBuild: vi.fn(async () => build("local-trading-onboarding")),
      getApproval,
    };
    const recovery = recoveryRow();

    await expect(
      handleTxApprovalReconcile(
        context(store, { db: database(recovery) }),
        {
          approval_id: "isolated-approval",
          execution_contract: "xrpl_execution_v2",
          build_revision: 1,
          unsigned_tx_digest: BINDING,
          economic_fingerprint: BINDING,
        },
      ),
    ).rejects.toThrow(/build created by the isolated profile/i);

    expect(getApproval).not.toHaveBeenCalled();
  });

  it("rejects an isolated-origin durable reconcile replay under the legacy profile", async () => {
    const getApproval = vi.fn();
    const store = {
      getBuild: vi.fn(async () =>
        build(LOCAL_TRADING_ISOLATED_V1_BUILD_ORIGIN),
      ),
      getApproval,
    };

    await expect(
      handleTxApprovalReconcile(
        context(store, {
          db: database(recoveryRow()),
          env: REVIEWED_TRADING_ENV,
        }),
        {
          approval_id: "isolated-approval",
          execution_contract: "xrpl_execution_v2",
          build_revision: 1,
          unsigned_tx_digest: BINDING,
          economic_fingerprint: BINDING,
        },
      ),
    ).rejects.toThrow(/exact isolated context/i);

    expect(getApproval).not.toHaveBeenCalled();
  });

  it("rejects an isolated-origin devnet durable reconcile replay before returning it", async () => {
    const getApproval = vi.fn();
    const store = {
      getBuild: vi.fn(async () =>
        build(LOCAL_TRADING_ISOLATED_V1_BUILD_ORIGIN, "devnet"),
      ),
      getApproval,
    };

    await expect(
      handleTxApprovalReconcile(
        context(store, { db: database(recoveryRow()) }),
        {
          approval_id: "isolated-approval",
          execution_contract: "xrpl_execution_v2",
          build_revision: 1,
          unsigned_tx_digest: BINDING,
          economic_fingerprint: BINDING,
        },
      ),
    ).rejects.toThrow(/on Testnet/i);

    expect(getApproval).not.toHaveBeenCalled();
  });

  it("rejects a fresh reconcile candidate from another build origin before loading execution state", async () => {
    const getExecution = vi.fn();
    const store = {
      getApproval: vi.fn(async () => approval()),
      getBuild: vi.fn(async () => build("local-trading")),
      getExecution,
    };

    await expect(
      handleTxApprovalReconcile(context(store), {
        approval_id: "isolated-approval",
        execution_contract: "xrpl_execution_v2",
        build_revision: 1,
        unsigned_tx_digest: BINDING,
        economic_fingerprint: BINDING,
      }),
    ).rejects.toThrow(/build created by the isolated profile/i);

    expect(getExecution).not.toHaveBeenCalled();
  });

  it("rejects a fresh reconcile devnet snapshot before ledger proof I/O", async () => {
    const request = vi.fn();
    const store = {
      getApproval: vi.fn(async () => approval()),
      getBuild: vi.fn(async () =>
        build(LOCAL_TRADING_ISOLATED_V1_BUILD_ORIGIN),
      ),
      getExecution: vi.fn(async () => execution()),
      getExecutionSnapshot: vi.fn(async () => ({
        executionId: "isolated-execution",
        snapshotNetwork: "devnet",
      })),
      getBuildRevision: vi.fn(async () => ({ network: "devnet" })),
    };
    const reconcileContext = context(store) as OpContext & {
      xrplRpc?: { request: typeof request };
    };
    reconcileContext.xrplRpc = { request };

    await expect(
      handleTxApprovalReconcile(reconcileContext, {
        approval_id: "isolated-approval",
        execution_contract: "xrpl_execution_v2",
        build_revision: 1,
        unsigned_tx_digest: BINDING,
        economic_fingerprint: BINDING,
      }),
    ).rejects.toThrow(/authoritative Testnet snapshot/i);

    expect(store.getExecution).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });

  it("requires an origin-bearing base build for a legacy durable reconcile replay", async () => {
    const getApproval = vi.fn();
    const store = {
      getBuild: vi.fn(async () => null),
      getApproval,
    };

    await expect(
      handleTxApprovalReconcile(
        context(store, {
          db: database(recoveryRow()),
          env: REVIEWED_TRADING_ENV,
        }),
        {
          approval_id: "isolated-approval",
          execution_contract: "xrpl_execution_v2",
          build_revision: 1,
          unsigned_tx_digest: BINDING,
          economic_fingerprint: BINDING,
        },
      ),
    ).rejects.toThrow(/origin-bearing base build/i);

    expect(getApproval).not.toHaveBeenCalled();
  });

  it("rejects a v2 approval submission from another build origin before relay", async () => {
    const submitApproval = vi.fn();
    const submitSigned = vi.fn();
    const getExecution = vi.fn();
    const store = {
      getApproval: vi.fn(async () => approval()),
      getBuild: vi.fn(async () => build("local-trading")),
      getExecution,
    };

    await expect(
      handleTxSubmit(
        context(store, { services: { submitApproval, submitSigned } }),
        {
          tx_blob: "AA",
          approval_id: "isolated-approval",
          execution_contract: "xrpl_execution_v2",
          build_revision: 1,
          unsigned_tx_digest: BINDING,
          economic_fingerprint: BINDING,
        },
      ),
    ).rejects.toThrow(/build created by the isolated profile/i);

    expect(getExecution).not.toHaveBeenCalled();
    expect(submitApproval).not.toHaveBeenCalled();
    expect(submitSigned).not.toHaveBeenCalled();
  });

  it.each([
    ["legacy trading", REVIEWED_TRADING_ENV],
    ["onboarding", REVIEWED_ONBOARDING_ENV],
  ] as const)(
    "rejects an isolated-origin v2 submission under the reviewed %s profile",
    async (_profile, env) => {
      const submitApproval = vi.fn();
      const submitSigned = vi.fn();
      const getExecution = vi.fn();
      const store = {
        getApproval: vi.fn(async () => approval()),
        getBuild: vi.fn(async () =>
          build(LOCAL_TRADING_ISOLATED_V1_BUILD_ORIGIN),
        ),
        getExecution,
      };

      await expect(
        handleTxSubmit(
          context(store, {
            env,
            services: { submitApproval, submitSigned },
          }),
          {
            tx_blob: "AA",
            approval_id: "isolated-approval",
            execution_contract: "xrpl_execution_v2",
            build_revision: 1,
            unsigned_tx_digest: BINDING,
            economic_fingerprint: BINDING,
          },
        ),
      ).rejects.toThrow(/exact isolated context/i);

      expect(getExecution).not.toHaveBeenCalled();
      expect(submitApproval).not.toHaveBeenCalled();
      expect(submitSigned).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["legacy trading", REVIEWED_TRADING_ENV],
    ["onboarding", REVIEWED_ONBOARDING_ENV],
  ] as const)(
    "requires an origin-bearing base build for reviewed %s v2 submission",
    async (_profile, env) => {
      const submitApproval = vi.fn();
      const submitSigned = vi.fn();
      const getExecution = vi.fn();
      const store = {
        getApproval: vi.fn(async () => approval()),
        getBuild: vi.fn(async () => null),
        getExecution,
      };

      await expect(
        handleTxSubmit(
          context(store, {
            env,
            services: { submitApproval, submitSigned },
          }),
          {
            tx_blob: "AA",
            approval_id: "isolated-approval",
            execution_contract: "xrpl_execution_v2",
            build_revision: 1,
            unsigned_tx_digest: BINDING,
            economic_fingerprint: BINDING,
          },
        ),
      ).rejects.toThrow(/origin-bearing base build/i);

      expect(getExecution).not.toHaveBeenCalled();
      expect(submitApproval).not.toHaveBeenCalled();
      expect(submitSigned).not.toHaveBeenCalled();
    },
  );

  it("rejects an isolated-origin devnet v2 submission before relay", async () => {
    const submitApproval = vi.fn();
    const submitSigned = vi.fn();
    const getExecution = vi.fn();
    const store = {
      getApproval: vi.fn(async () => approval()),
      getBuild: vi.fn(async () =>
        build(LOCAL_TRADING_ISOLATED_V1_BUILD_ORIGIN, "devnet"),
      ),
      getExecution,
    };

    await expect(
      handleTxSubmit(
        context(store, { services: { submitApproval, submitSigned } }),
        {
          tx_blob: "AA",
          approval_id: "isolated-approval",
          execution_contract: "xrpl_execution_v2",
          build_revision: 1,
          unsigned_tx_digest: BINDING,
          economic_fingerprint: BINDING,
        },
      ),
    ).rejects.toThrow(/on Testnet/i);

    expect(getExecution).not.toHaveBeenCalled();
    expect(submitApproval).not.toHaveBeenCalled();
    expect(submitSigned).not.toHaveBeenCalled();
  });

  it("rejects snapshot-backed status from another build origin before status I/O", async () => {
    const status = vi.fn();
    const getBuildRevision = vi.fn();
    const store = {
      findExecutionByHash: vi.fn(async () => execution()),
      getExecutionSnapshot: vi.fn(async () => ({
        executionId: "isolated-execution",
        snapshotNetwork: "testnet",
      })),
      getBuild: vi.fn(async () => build("local-trading")),
      getBuildRevision,
    };

    await expect(
      handleTxStatus(context(store, { services: { status } }), { hash: HASH }),
    ).rejects.toThrow(/build created by the isolated profile/i);

    expect(getBuildRevision).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it.each([
    ["legacy trading", REVIEWED_TRADING_ENV],
    ["onboarding", REVIEWED_ONBOARDING_ENV],
  ] as const)(
    "rejects isolated-origin snapshot status under the reviewed %s profile",
    async (_profile, env) => {
      const status = vi.fn();
      const getBuildRevision = vi.fn();
      const store = {
        findExecutionByHash: vi.fn(async () => execution()),
        getExecutionSnapshot: vi.fn(async () => ({
          executionId: "isolated-execution",
        })),
        getBuild: vi.fn(async () =>
          build(LOCAL_TRADING_ISOLATED_V1_BUILD_ORIGIN),
        ),
        getBuildRevision,
      };

      await expect(
        handleTxStatus(context(store, { env, services: { status } }), {
          hash: HASH,
        }),
      ).rejects.toThrow(/exact isolated context/i);

      expect(getBuildRevision).not.toHaveBeenCalled();
      expect(status).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["legacy trading", REVIEWED_TRADING_ENV],
    ["onboarding", REVIEWED_ONBOARDING_ENV],
  ] as const)(
    "requires an origin-bearing base build for reviewed %s snapshot status",
    async (_profile, env) => {
      const status = vi.fn();
      const getBuildRevision = vi.fn();
      const store = {
        findExecutionByHash: vi.fn(async () => execution()),
        getExecutionSnapshot: vi.fn(async () => ({
          executionId: "isolated-execution",
        })),
        getBuild: vi.fn(async () => null),
        getBuildRevision,
      };

      await expect(
        handleTxStatus(context(store, { env, services: { status } }), {
          hash: HASH,
        }),
      ).rejects.toThrow(/origin-bearing base build/i);

      expect(getBuildRevision).not.toHaveBeenCalled();
      expect(status).not.toHaveBeenCalled();
    },
  );

  it("rejects isolated-origin devnet snapshot status before status I/O", async () => {
    const status = vi.fn();
    const getBuildRevision = vi.fn();
    const store = {
      findExecutionByHash: vi.fn(async () => execution()),
      getExecutionSnapshot: vi.fn(async () => ({
        executionId: "isolated-execution",
        snapshotNetwork: "devnet",
      })),
      getBuild: vi.fn(async () =>
        build(LOCAL_TRADING_ISOLATED_V1_BUILD_ORIGIN),
      ),
      getBuildRevision,
    };

    await expect(
      handleTxStatus(context(store, { services: { status } }), { hash: HASH }),
    ).rejects.toThrow(/authoritative Testnet snapshot/i);

    expect(getBuildRevision).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it("rejects mixed onboarding and isolated markers before direct owner submission", async () => {
    const submitSigned = vi.fn();
    const getLink = vi.fn();
    const store = { getLink };
    const env = {
      ...REVIEWED_ISOLATED_ENV,
      HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED: "true",
      HARBOR_LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE:
        LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE,
    };

    await expect(
      handleTxSubmit(
        context(store, { env, services: { submitSigned } }),
        { tx_blob: "AA", network: "testnet" },
      ),
    ).rejects.toThrow(/only in the reviewed local trading onboarding profile/i);

    expect(getLink).not.toHaveBeenCalled();
    expect(submitSigned).not.toHaveBeenCalled();
  });

  it("never replays a direct owner binding in the isolated profile", async () => {
    const status = vi.fn();
    const getEvent = vi.fn(async () => ({
      id: `direct-owner-submit:${PRINCIPAL}:${HASH}`,
      principal: PRINCIPAL,
      owner: OWNER,
      kind: "direct_owner_submission",
      detail: { hash: HASH, network: "testnet" },
      createdAt: "2026-10-20T00:00:00.000Z",
    }));
    const store = {
      findExecutionByHash: vi.fn(async () => null),
      getEvent,
    };

    await expect(
      handleTxStatus(context(store, { services: { status } }), { hash: HASH }),
    ).rejects.toThrow(/does not permit direct owner submission bindings/i);

    expect(getEvent).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });
});
