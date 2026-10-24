import type { ExecResult, ExecutionCapability, TxBuild } from "@pilot/contracts";
import { describe, expect, it } from "vitest";

import {
  OFFER_TF_FILL_OR_KILL,
  OFFICIAL_TESTNET_RLUSD_CURRENCY,
  OFFICIAL_TESTNET_RLUSD_ISSUER,
  RLUSD_ACQUISITION_ABSOLUTE_CAP_DROPS,
  RLUSD_ACQUISITION_V2_APPROVAL_TTL_SECONDS,
  RlusdAcquisitionBuildValidationError,
  assertExactRlusdBalanceDelta,
  createRlusdAcquisitionIdentity,
  createRlusdAcquisitionQuote,
  maximumRlusdAcquisitionInputDrops,
  parseRlusdAcquisitionPublicState,
  reduceRlusdAcquisitionPublicState,
  rlusdAcquisitionExecuteArgs,
  rlusdAcquisitionRecoveryAction,
  rlusdAcquisitionSwapArgs,
  validateRlusdAcquisitionApproval,
  validateRlusdAcquisitionBuild,
  type RlusdAcquisitionIdentity,
  type RlusdAcquisitionPublicState,
  type RlusdAcquisitionQuote,
} from "./rlusd-acquisition";

const ACCOUNT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const OTHER_ACCOUNT = "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY";
const OPERATION_ID = "0a7d3248-daab-409b-82c1-39c55c182c00";
const HASH = "A".repeat(64);
const LEDGER_HASH = "C".repeat(64);
const NOW = Date.parse("2026-10-19T00:00:00.000Z");

const identity = createRlusdAcquisitionIdentity(ACCOUNT, OPERATION_ID);

function quote(
  sourceAmountDrops = 100_000_000n,
  ledgerIndex = 1_000,
): RlusdAcquisitionQuote {
  return createRlusdAcquisitionQuote(identity, sourceAmountDrops, ledgerIndex, LEDGER_HASH);
}

function transaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    TransactionType: "OfferCreate",
    Account: ACCOUNT,
    TakerGets: "101000000",
    TakerPays: {
      currency: OFFICIAL_TESTNET_RLUSD_CURRENCY,
      issuer: OFFICIAL_TESTNET_RLUSD_ISSUER,
      value: "75",
    },
    Fee: "12",
    Sequence: 77,
    LastLedgerSequence: 1_004,
    Flags: OFFER_TF_FILL_OR_KILL,
    SigningPubKey: "",
    ...overrides,
  };
}

function build(
  txOverrides: Record<string, unknown> = {},
  buildOverrides: Partial<TxBuild> = {},
): TxBuild {
  return {
    build_id: "build-rlusd-1",
    network: "testnet",
    tx_json: transaction(txOverrides),
    delegable: false,
    simulate: {
      engine_result: "tesSUCCESS",
      engine_result_message: "The simulated transaction would succeed.",
      applied: false,
    },
    preflight: [
      { check: "schema", pass: true },
      { check: "policy", pass: true },
      { check: "expiry", pass: true },
    ],
    summary: {
      action: "Acquire RLUSD",
      account: ACCOUNT,
      amounts: ["75 RLUSD", "up to 101 XRP"],
      fee_drops: "12",
      reserve_delta_drops: "0",
    },
    ...buildOverrides,
  };
}

function v2Capability(overrides: Partial<ExecutionCapability> = {}): ExecutionCapability {
  return {
    execution_contract: "xrpl_execution_v2",
    build_revision: 1,
    unsigned_tx_digest: "A".repeat(64),
    unsigned_tx_digest_alg: "sha256-jcs-v1",
    economic_fingerprint: "B".repeat(64),
    economic_fingerprint_alg: "sha256-jcs-economic-v1",
    build_ledger: 1_000,
    first_inclusion_ledger: 1_001,
    last_ledger_sequence: 1_064,
    minimum_remaining_ledgers: 8,
    approval_expires_in_seconds: 90,
    quote_ledger: 1_000,
    quote_valid_through_ledger: 1_001,
    acquisition_balance_invariant: {
      kind: "issued_balance_unchanged",
      currency: OFFICIAL_TESTNET_RLUSD_CURRENCY,
      issuer: OFFICIAL_TESTNET_RLUSD_ISSUER,
      balance: "12.5",
      ledger_index: 1_000,
    },
    ...overrides,
  };
}

function validatedV2Build(
  txOverrides: Record<string, unknown> = {},
  capabilityOverrides: Partial<ExecutionCapability> = {},
) {
  return validateRlusdAcquisitionBuild(
    build(
      { LastLedgerSequence: 1_064, ...txOverrides },
      { execution_capability: v2Capability(capabilityOverrides) },
    ),
    identity,
    quote(),
    { ledgerIndex: 1_000, sequence: 77 },
    "xrpl_execution_v2",
  );
}

function validatedBuild(
  txOverrides: Record<string, unknown> = {},
  buildOverrides: Partial<TxBuild> = {},
  quoteOverride = quote(),
) {
  return validateRlusdAcquisitionBuild(
    build(txOverrides, buildOverrides),
    identity,
    quoteOverride,
    { ledgerIndex: 1_000, sequence: 77 },
  );
}

function approval(
  txOverrides: Record<string, unknown> = {},
  resultOverrides: Partial<Extract<ExecResult, { status: "needs_approval" }>> = {},
): Extract<ExecResult, { status: "needs_approval" }> {
  return {
    status: "needs_approval",
    approval_id: "approval-rlusd-1",
    tx_json: transaction(txOverrides),
    expires_at: "2026-10-19T00:05:00.000Z",
    policy: {
      verdict: "needs_approval",
      reasons: [{ rule: "owner", pass: true, detail: "Explicit owner approval required." }],
    },
    ...resultOverrides,
  };
}

function builtState(): RlusdAcquisitionPublicState {
  return reduceRlusdAcquisitionPublicState(identity, undefined, {
    type: "built",
    validatedBuild: validatedBuild(),
    balanceBefore: "12.5",
  });
}

function expectBuildValidationCode(
  run: () => unknown,
  code: RlusdAcquisitionBuildValidationError["code"],
): void {
  try {
    run();
    throw new Error("Expected RLUSD acquisition build validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(RlusdAcquisitionBuildValidationError);
    expect((error as RlusdAcquisitionBuildValidationError).code).toBe(code);
  }
}

describe("official Testnet RLUSD acquisition identity and arguments", () => {
  it("binds a canonical UUID to the only permitted owner, network, asset, amount, and cap", () => {
    expect(identity).toEqual({
      operation_id: OPERATION_ID,
      owner: ACCOUNT,
      network: "testnet",
      asset: {
        currency: OFFICIAL_TESTNET_RLUSD_CURRENCY,
        issuer: OFFICIAL_TESTNET_RLUSD_ISSUER,
      },
      amount: "75",
      cap_drops: "275000000",
      intent_id: `p-live-acquire-rlusd-${OPERATION_ID}`,
    });
    expect(() => createRlusdAcquisitionIdentity(ACCOUNT, OPERATION_ID.toUpperCase())).toThrow();
  });

  it("uses one stable root intent and deterministic attempt-scoped owner approval keys", () => {
    expect(rlusdAcquisitionSwapArgs(identity)).toEqual({
      account: ACCOUNT,
      network: "testnet",
      intent_id: identity.intent_id,
      sell: { currency: "XRP" },
      buy: identity.asset,
      amount: { ...identity.asset, value: "75" },
      side: "buy",
      max_slippage_bps: 100,
      execution_mode: "fill_or_kill",
    });
    expect(rlusdAcquisitionExecuteArgs(identity, "build-rlusd-1")).toEqual({
      build_id: "build-rlusd-1",
      idempotency_key: identity.intent_id,
      require_owner_approval: true,
    });
    expect(rlusdAcquisitionExecuteArgs(identity, "build-rlusd-2", 1)).toEqual({
      build_id: "build-rlusd-2",
      idempotency_key: `${identity.intent_id}:attempt:1`,
      require_owner_approval: true,
    });
    expect(rlusdAcquisitionExecuteArgs(identity, "build-rlusd-2", 2)).toEqual({
      build_id: "build-rlusd-2",
      idempotency_key: `${identity.intent_id}:attempt:2`,
      require_owner_approval: true,
    });
    expect(rlusdAcquisitionSwapArgs(identity, "xrpl_execution_v2")).toMatchObject({
      execution_contract: "xrpl_execution_v2",
    });
    expect(rlusdAcquisitionExecuteArgs(
      identity,
      "build-rlusd-v2",
      0,
      v2Capability(),
    )).toEqual({
      build_id: "build-rlusd-v2",
      idempotency_key: identity.intent_id,
      require_owner_approval: true,
      execution_contract: "xrpl_execution_v2",
      build_revision: 1,
    });
    expect(() => rlusdAcquisitionExecuteArgs(identity, "build-rlusd-2", -1)).toThrow(/attempt/i);
  });
});
describe("exact quote cap arithmetic", () => {
  it("ceil-rounds the exact one-percent boundary in drops", () => {
    expect(maximumRlusdAcquisitionInputDrops(100_000_001n)).toBe(101_000_002n);
    expect(maximumRlusdAcquisitionInputDrops(272_277_227n)).toBe(
      RLUSD_ACQUISITION_ABSOLUTE_CAP_DROPS,
    );
    expect(() => createRlusdAcquisitionQuote(identity, 272_277_228n, 1_000, LEDGER_HASH)).toThrow(
      /absolute acquisition cap/i,
    );
  });

  it("does not overflow through Number arithmetic", () => {
    const enormous = (2n ** 200n) + 1n;
    expect(maximumRlusdAcquisitionInputDrops(enormous)).toBe(
      (enormous * 10_100n + 9_999n) / 10_000n,
    );
    expect(() => createRlusdAcquisitionQuote(identity, enormous, 1_000, LEDGER_HASH)).toThrow(
      /absolute acquisition cap/i,
    );
  });
});

describe("strict RLUSD OfferCreate build validation", () => {
  it("accepts only the exact v2 +64 capability while quote freshness remains one ledger", () => {
    expect(validatedV2Build().executionCapability).toMatchObject({
      build_ledger: 1_000,
      first_inclusion_ledger: 1_001,
      last_ledger_sequence: 1_064,
      minimum_remaining_ledgers: 8,
      approval_expires_in_seconds: RLUSD_ACQUISITION_V2_APPROVAL_TTL_SECONDS,
    });
    expectBuildValidationCode(() => validatedV2Build(
      { LastLedgerSequence: 1_063 },
      { last_ledger_sequence: 1_063 },
    ), "EXECUTION_CONTRACT_MISMATCH");
    expectBuildValidationCode(() => validatedV2Build(
      { LastLedgerSequence: 1_065 },
      { last_ledger_sequence: 1_065 },
    ), "EXCESS_LEDGER_HORIZON");
    expectBuildValidationCode(() => validateRlusdAcquisitionBuild(
      build(
        { LastLedgerSequence: 1_065 },
        { execution_capability: v2Capability({
          build_ledger: 1_001,
          first_inclusion_ledger: 1_002,
          last_ledger_sequence: 1_065,
        }) },
      ),
      identity,
      quote(100_000_000n, 999),
      { ledgerIndex: 1_001, sequence: 77 },
      "xrpl_execution_v2",
    ), "QUOTE_STALE");
    const laterSnapshot = validateRlusdAcquisitionBuild(
      build(
        { LastLedgerSequence: 1_064 },
        { execution_capability: v2Capability() },
      ),
      identity,
      quote(100_000_000n, 1_000),
      { ledgerIndex: 1_001, sequence: 77 },
      "xrpl_execution_v2",
    );
    expect(laterSnapshot.executionCapability?.build_ledger).toBe(1_000);
    expect(laterSnapshot.accountState.ledgerIndex).toBe(1_001);
    const independentlyAdvancedHarborQuote = validateRlusdAcquisitionBuild(
      build(
        { LastLedgerSequence: 1_065 },
        { execution_capability: v2Capability({
          build_ledger: 1_001,
          first_inclusion_ledger: 1_002,
          last_ledger_sequence: 1_065,
          quote_ledger: 1_001,
          quote_valid_through_ledger: 1_002,
          acquisition_balance_invariant: {
            kind: "issued_balance_unchanged",
            currency: OFFICIAL_TESTNET_RLUSD_CURRENCY,
            issuer: OFFICIAL_TESTNET_RLUSD_ISSUER,
            balance: "12.5",
            ledger_index: 1_000,
          },
        }) },
      ),
      identity,
      quote(100_000_000n, 1_000),
      { ledgerIndex: 1_001, sequence: 77 },
      "xrpl_execution_v2",
    );
    expect(independentlyAdvancedHarborQuote.executionCapability).toMatchObject({
      quote_ledger: 1_001,
      build_ledger: 1_001,
    });
    expect(validatedV2Build({}, {
      acquisition_balance_invariant: {
        kind: "issued_balance_unchanged",
        currency: OFFICIAL_TESTNET_RLUSD_CURRENCY,
        issuer: OFFICIAL_TESTNET_RLUSD_ISSUER,
        balance: "12.5",
        ledger_index: 999,
      },
    }).executionCapability?.acquisition_balance_invariant?.ledger_index).toBe(999);
  });

  it("rejects v2 downgrade, unsolicited v2, missing balance invariant, and insufficient fee", () => {
    expectBuildValidationCode(() => validateRlusdAcquisitionBuild(
      build({ LastLedgerSequence: 1_064 }),
      identity,
      quote(),
      { ledgerIndex: 1_000, sequence: 77 },
      "xrpl_execution_v2",
    ), "EXECUTION_CONTRACT_MISMATCH");
    expectBuildValidationCode(() => validateRlusdAcquisitionBuild(
      build({}, { execution_capability: v2Capability() }),
      identity,
      quote(),
      { ledgerIndex: 1_000, sequence: 77 },
    ), "EXECUTION_CONTRACT_MISMATCH");
    expectBuildValidationCode(() => validatedV2Build({}, {
      acquisition_balance_invariant: undefined,
    }), "EXECUTION_CONTRACT_MISMATCH");
    expectBuildValidationCode(() => validatedV2Build({}, {
      build_revision: 2,
    }), "EXECUTION_CONTRACT_MISMATCH");
    expectBuildValidationCode(() => validatedV2Build({}, {
      quote_ledger: 1_001,
      quote_valid_through_ledger: 1_002,
    }), "EXECUTION_CONTRACT_MISMATCH");
    expectBuildValidationCode(() => validatedV2Build({}, {
      quote_valid_through_ledger: 1_002,
    }), "EXECUTION_CONTRACT_MISMATCH");
    expectBuildValidationCode(() => validatedV2Build({}, {
      acquisition_balance_invariant: {
        kind: "issued_balance_unchanged",
        currency: OFFICIAL_TESTNET_RLUSD_CURRENCY,
        issuer: OFFICIAL_TESTNET_RLUSD_ISSUER,
        balance: "12.5",
        ledger_index: 1_001,
      },
    }), "EXECUTION_CONTRACT_MISMATCH");
    expectBuildValidationCode(() => validatedV2Build({}, {
      acquisition_balance_invariant: {
        kind: "issued_balance_unchanged",
        currency: OFFICIAL_TESTNET_RLUSD_CURRENCY,
        issuer: OFFICIAL_TESTNET_RLUSD_ISSUER,
        balance: "12.5",
        ledger_index: 998,
      },
    }), "EXECUTION_CONTRACT_MISMATCH");
    expect(() => validatedV2Build({ Fee: "9" })).toThrow(/fee/i);
  });

  it("accepts the exact owner-signed FOK boundary build", () => {
    const boundaryQuote = quote(272_277_227n);
    const result = validatedBuild(
      { TakerGets: RLUSD_ACQUISITION_ABSOLUTE_CAP_DROPS.toString() },
      {},
      boundaryQuote,
    );
    expect(result.transaction.TakerGets).toBe("275000000");
  });

  it("binds a one-ledger quote-to-build advance to the post-build account ledger", () => {
    const postBuildLedger = 1_001;
    const checked = validateRlusdAcquisitionBuild(
      build({ LastLedgerSequence: postBuildLedger + 4 }),
      identity,
      quote(100_000_000n, 1_000),
      { ledgerIndex: postBuildLedger, sequence: 77 },
    );
    expect(checked.accountState.ledgerIndex).toBe(postBuildLedger);
    expect(checked.quote.ledger_index).toBe(1_000);

    const approved = validateRlusdAcquisitionApproval(
      approval({ LastLedgerSequence: postBuildLedger + 4 }),
      checked,
      identity,
      { ledgerIndex: postBuildLedger, sequence: 77 },
      NOW + 2 * 60_000,
    );
    expect(approved.approval_id).toBe("approval-rlusd-1");
  });

  it.each([
    ["expired deadline", 1_000, 1_001, 1_001, "BUILD_EXPIRED"],
    ["excess deadline horizon", 1_000, 1_001, 1_006, "EXCESS_LEDGER_HORIZON"],
    ["reversed quote ledger", 1_002, 1_001, 1_005, "QUOTE_LEDGER_MISMATCH"],
    ["stale quote ledger", 999, 1_001, 1_005, "QUOTE_STALE"],
  ] as const)("rejects a %s against the authoritative post-build ledger", (
    _label,
    quoteLedger,
    postBuildLedger,
    lastLedgerSequence,
    code,
  ) => {
    expectBuildValidationCode(() => validateRlusdAcquisitionBuild(
      build({ LastLedgerSequence: lastLedgerSequence }),
      identity,
      quote(100_000_000n, quoteLedger),
      { ledgerIndex: postBuildLedger, sequence: 77 },
    ), code);
  });

  it.each([
    ["IOC", { Flags: 0x0002_0000 }],
    ["tfSell", { Flags: OFFER_TF_FILL_OR_KILL | 0x0008_0000 }],
    ["Delegate", { Delegate: OTHER_ACCOUNT }],
    ["wrong asset", { TakerPays: { currency: "USD", issuer: OFFICIAL_TESTNET_RLUSD_ISSUER, value: "75" } }],
    ["wrong owner", { Account: OTHER_ACCOUNT }],
    ["stale sequence", { Sequence: 76 }],
    ["excess fee", { Fee: "101" }],
    ["long expiry", { LastLedgerSequence: 1_005 }],
    ["unsupported field", { Destination: OTHER_ACCOUNT }],
  ])("rejects %s", (_label, override) => {
    expect(() => validatedBuild(override)).toThrow();
  });

  it("rejects a wrong build network", () => {
    expect(() => validatedBuild({}, { network: "devnet" })).toThrow(/network/i);
  });

  it("rejects failed/applied simulation and any failed or absent preflight", () => {
    expect(() => validatedBuild({}, {
      simulate: { engine_result: "tecKILLED", engine_result_message: "failed", applied: false },
    })).toThrow(/simulation/i);
    expect(() => validatedBuild({}, {
      simulate: { engine_result: "tesSUCCESS", engine_result_message: "bad", applied: true },
    } as unknown as Partial<TxBuild>)).toThrow(/simulation/i);
    expect(() => validatedBuild({}, {
      preflight: [{ check: "policy", pass: false }],
    })).toThrow(/preflight/i);
    expect(() => validatedBuild({}, { preflight: [] })).toThrow(/preflight/i);
  });

  it("rejects a stale, future, or operation-mismatched quote", () => {
    expectBuildValidationCode(() => validateRlusdAcquisitionBuild(
      build(), identity, quote(100_000_000n, 998), { ledgerIndex: 1_000, sequence: 77 },
    ), "QUOTE_STALE");
    expectBuildValidationCode(() => validateRlusdAcquisitionBuild(
      build(), identity, quote(100_000_000n, 1_001), { ledgerIndex: 1_000, sequence: 77 },
    ), "QUOTE_LEDGER_MISMATCH");
    const otherIdentity = createRlusdAcquisitionIdentity(OTHER_ACCOUNT, OPERATION_ID);
    const otherQuote = createRlusdAcquisitionQuote(
      otherIdentity,
      100_000_000n,
      1_000,
      LEDGER_HASH,
    );
    expect(() => validateRlusdAcquisitionBuild(
      build(), identity, otherQuote, { ledgerIndex: 1_000, sequence: 77 },
    )).toThrow(/bound/i);
  });

  it("rejects one drop over either independent ceiling", () => {
    expect(() => validatedBuild({ TakerGets: "101000001" })).toThrow(/rounded cap/i);
    const boundaryQuote = quote(272_277_227n);
    expect(() => validatedBuild({ TakerGets: "275000001" }, {}, boundaryQuote)).toThrow(
      /rounded cap/i,
    );
  });
});

describe("approval semantics", () => {
  it("bounds v2 owner approval by the independent 90-second wall lifetime", () => {
    const checked = validatedV2Build();
    expect(validateRlusdAcquisitionApproval(
      approval(
        { LastLedgerSequence: 1_064 },
        { expires_at: new Date(NOW + 90_000).toISOString() },
      ),
      checked,
      identity,
      { ledgerIndex: 1_000, sequence: 77 },
      NOW,
    ).approval_id).toBe("approval-rlusd-1");
    expect(() => validateRlusdAcquisitionApproval(
      approval(
        { LastLedgerSequence: 1_064 },
        { expires_at: new Date(NOW + 90_001).toISOString() },
      ),
      checked,
      identity,
      { ledgerIndex: 1_000, sequence: 77 },
      NOW,
    )).toThrow(/wall-clock lifetime/i);
    expect(() => validateRlusdAcquisitionApproval(
      approval(
        { LastLedgerSequence: 1_064 },
        { expires_at: new Date(NOW).toISOString() },
      ),
      checked,
      identity,
      { ledgerIndex: 1_000, sequence: 77 },
      NOW,
    )).toThrow(/expired/i);
  });

  it("accepts only the exact unchanged build envelope and semantic digest", () => {
    const checked = validateRlusdAcquisitionApproval(
      approval(),
      validatedBuild(),
      identity,
      { ledgerIndex: 1_000, sequence: 77 },
      NOW,
    );
    expect(checked.approval_id).toBe("approval-rlusd-1");
  });

  it("rejects expiry, Fee/Sequence/LLS refresh, and semantic approval drift", () => {
    expect(() => validateRlusdAcquisitionApproval(
      approval({}, { expires_at: "2026-10-18T23:59:59.000Z" }),
      validatedBuild(), identity, { ledgerIndex: 1_000, sequence: 77 }, NOW,
    )).toThrow(/expired/i);
    expect(() => validateRlusdAcquisitionApproval(
      approval({ LastLedgerSequence: 1_003 }),
      validatedBuild(), identity, { ledgerIndex: 1_000, sequence: 77 }, NOW,
    )).toThrow(/deadline/i);
    expect(() => validateRlusdAcquisitionApproval(
      approval({ Fee: "13" }),
      validatedBuild(), identity, { ledgerIndex: 1_000, sequence: 77 }, NOW,
    )).toThrow(/envelope/i);
    expect(() => validateRlusdAcquisitionApproval(
      approval({ Sequence: 78 }),
      validatedBuild(), identity, { ledgerIndex: 1_000, sequence: 78 }, NOW,
    )).toThrow(/envelope/i);
    expect(() => validateRlusdAcquisitionApproval(
      approval({ SourceTag: 7 }),
      validatedBuild(), identity, { ledgerIndex: 1_000, sequence: 77 }, NOW,
    )).toThrow(/digest/i);
    expect(() => validateRlusdAcquisitionApproval(
      approval({ TakerGets: "100000000" }),
      validatedBuild(), identity, { ledgerIndex: 1_000, sequence: 77 }, NOW,
    )).toThrow(/digest/i);
  });
});

describe("public recovery state", () => {
  it("binds persisted state to the exact account, network, and operation", () => {
    const state = builtState();
    expect(parseRlusdAcquisitionPublicState(state, identity).status).toBe("built");

    const mismatchedOperation = createRlusdAcquisitionIdentity(
      ACCOUNT,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(() => parseRlusdAcquisitionPublicState(state, mismatchedOperation)).toThrow(/different operation/i);
    expect(() => parseRlusdAcquisitionPublicState(
      { ...state, owner: OTHER_ACCOUNT },
      identity,
    )).toThrow();
    expect(() => parseRlusdAcquisitionPublicState(
      { ...state, network: "devnet" },
      identity,
    )).toThrow();

    const otherOperation = createRlusdAcquisitionIdentity(
      ACCOUNT,
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    );
    const otherBuild = validateRlusdAcquisitionBuild(
      build(),
      otherOperation,
      createRlusdAcquisitionQuote(otherOperation, 100_000_000n, 1_000, LEDGER_HASH),
      { ledgerIndex: 1_000, sequence: 77 },
    );
    expect(() => reduceRlusdAcquisitionPublicState(identity, undefined, {
      type: "built",
      validatedBuild: otherBuild,
      balanceBefore: "0",
    })).toThrow(/different operation/i);
  });

  it("refuses signed blobs and secrets in public persisted state", () => {
    expect(() => parseRlusdAcquisitionPublicState(
      { ...builtState(), tx_blob: "signed" },
      identity,
    )).toThrow(/signed material|secret/i);
  });

  it("marks signed_pending as reconcile-only and never a resubmit", () => {
    const pending = reduceRlusdAcquisitionPublicState(identity, builtState(), {
      type: "signed_pending",
      hash: HASH,
    });
    expect(rlusdAcquisitionRecoveryAction(pending, identity)).toEqual({
      action: "reconcile_hash",
      hash: HASH,
      lastLedgerSequence: 1_004,
      resubmit: false,
    });
  });

  it("accepts validated recovery only with the same hash and exact +75 balance delta", () => {
    const pending = reduceRlusdAcquisitionPublicState(identity, builtState(), {
      type: "signed_pending",
      hash: HASH,
    });
    const validated = reduceRlusdAcquisitionPublicState(identity, pending, {
      type: "validated",
      hash: HASH,
      ledgerIndex: 1_003,
      balanceAfter: "87.500",
    });
    expect(rlusdAcquisitionRecoveryAction(validated, identity)).toEqual({
      action: "complete",
      hash: HASH,
      ledgerIndex: 1_003,
      resubmit: false,
    });
    expect(() => reduceRlusdAcquisitionPublicState(identity, pending, {
      type: "validated",
      hash: "B".repeat(64),
      ledgerIndex: 1_003,
      balanceAfter: "87.5",
    })).toThrow();
    expect(() => reduceRlusdAcquisitionPublicState(identity, pending, {
      type: "validated",
      hash: HASH,
      ledgerIndex: 1_003,
      balanceAfter: "87.499999",
    })).toThrow(/exactly 75/i);
  });
});

describe("exact RLUSD balance arithmetic", () => {
  it("accepts exactly +75 across decimal scales", () => {
    expect(() => assertExactRlusdBalanceDelta("-0.25", "74.7500")).not.toThrow();
  });

  it("rejects any fractional difference", () => {
    expect(() => assertExactRlusdBalanceDelta("0", "74.999999999999999999")).toThrow(
      /exactly 75/i,
    );
  });
});
