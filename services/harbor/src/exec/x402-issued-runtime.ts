import {
  X402_ISSUED_FIXTURE_RESOURCE_URL,
  type X402IssuedFixtureService,
} from "../x402-issued-contract";
import { isLocalX402IssuedFixtureEnvironment } from "../local-x402-issued-fixture";
import { D1IssuedX402Budget, D1IssuedX402State } from "./x402-issued-d1";
import {
  createOfflineIssuedX402Route,
  type X402IssuedChallenge,
  type X402IssuedLedgerPreparation,
  type X402IssuedMerchantTransport,
  type X402IssuedPolicy,
  type X402IssuedSigner,
} from "./x402-issued-offline";
import type {
  X402IssuedReconciliationExpectation,
  X402IssuedReconciliationResult,
} from "./x402-issued-reconciliation";
import { createIssuedX402FixtureService } from "./x402-issued-service";

/**
 * Owner-sign orchestration supplies this local binding. Harbor owns no owner key
 * and never falls back to its native-XRP payer when the binding is absent.
 */
export type LocalIssuedX402RuntimeAdapter = Readonly<{
  owner: string;
  sessionScope: string;
  merchantId: string;
  resourceUrl: typeof X402_ISSUED_FIXTURE_RESOURCE_URL;
  policy: X402IssuedPolicy;
  merchant: X402IssuedMerchantTransport;
  prepare(input: Readonly<{
    idempotencyKey: string;
    merchantId: string;
    sessionScope: string;
    challenge: X402IssuedChallenge;
  }>): Promise<X402IssuedLedgerPreparation>;
  signer: X402IssuedSigner;
  reconciler: Readonly<{
    reconcile(
      expectation: X402IssuedReconciliationExpectation,
    ): Promise<X402IssuedReconciliationResult>;
  }>;
  now?: () => Date;
  operationTimeoutMs?: number;
}>;

export type LocalIssuedX402RuntimeEnv = Readonly<{
  DB: D1Database;
  HARBOR_LOCAL_X402_ISSUED_RUNTIME_ADAPTER?: LocalIssuedX402RuntimeAdapter;
}>;

/** Construct the real issued route only for the exact, separate fixture profile. */
export async function createLocalIssuedX402FixtureService(
  env: LocalIssuedX402RuntimeEnv,
): Promise<X402IssuedFixtureService | undefined> {
  if (!isLocalX402IssuedFixtureEnvironment(env)) return undefined;
  const adapter = env.HARBOR_LOCAL_X402_ISSUED_RUNTIME_ADAPTER;
  if (adapter === undefined) return undefined;
  const authorityOptions = {
    enabled: true,
    ...(adapter.now === undefined ? {} : { now: adapter.now }),
  };
  const state = new D1IssuedX402State(env.DB, authorityOptions);
  await state.recoverAll();
  const route = createOfflineIssuedX402Route({
    enabled: true,
    requestUrl: adapter.resourceUrl,
    merchantId: adapter.merchantId,
    sessionScope: adapter.sessionScope,
    policy: adapter.policy,
    budget: new D1IssuedX402Budget(env.DB, adapter.policy, authorityOptions),
    state,
    merchant: adapter.merchant,
    prepare: adapter.prepare,
    signer: adapter.signer,
    reconciler: adapter.reconciler,
    ...(adapter.now === undefined ? {} : { now: adapter.now }),
    ...(adapter.operationTimeoutMs === undefined
      ? {}
      : { operationTimeoutMs: adapter.operationTimeoutMs }),
  });
  return createIssuedX402FixtureService({
    route,
    owner: adapter.owner,
    sessionScope: adapter.sessionScope,
    merchantId: adapter.merchantId,
    resourceUrl: adapter.resourceUrl,
    policy: adapter.policy,
  });
}
