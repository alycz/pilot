import { describe, expect, it, vi } from "vitest";

import { LOCAL_X402_ISSUED_FIXTURE_PROFILE } from "../src/local-x402-issued-fixture";
import { ops } from "../src/ops/x402-issued";
import {
  X402_ISSUED_FIXTURE_DISABLED,
} from "../src/ops/x402-issued";
import type {
  X402IssuedFixtureResult,
  X402IssuedPayRequest,
} from "../src/x402-issued-contract";

const OWNER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const PAY_TO = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const CURRENCY = "524C555344000000000000000000000000000000";

const request: X402IssuedPayRequest = {
  owner: OWNER,
  network: "testnet",
  resource: "compare",
  session_scope: "session-scope-001",
  merchant: {
    id: "merchant-local-001",
    resource_method: "POST",
    resource_url: "http://127.0.0.1:8000/api/x402/compare",
  },
  asset: { kind: "xrpl-issued", network: "xrpl:1", currency: CURRENCY, issuer: ISSUER },
  max_amount: "0.01",
  pay_to: PAY_TO,
  idempotency_key: "issued-request-001",
};

const result: X402IssuedFixtureResult = {
  status: "fixture_delivered",
  evidence: "deterministic-offline-fixture",
  session_scope: request.session_scope,
  merchant: request.merchant,
  merchant_invoice_id: "merchant-invoice-raw-001",
  idempotency_key: request.idempotency_key,
  approval_digest: "A".repeat(64),
  asset: request.asset,
  amount: "0.01",
  payer: OWNER,
  pay_to: PAY_TO,
  fee_drops: "12",
  transaction_hash: "B".repeat(64),
  validated_ledger_index: 1_000,
  merchant_body: {
    comparison: ["dex", "amm"],
    paymentEvidence: "deterministic-offline-fixture-not-live-validation",
  },
};

const enabledContext = (serviceResult: X402IssuedFixtureResult = result) => ({
  principal: "principal-001",
  localDevRequest: true,
  env: {
    HARBOR_LOCAL_DEV: "true",
    HARBOR_LOCAL_READ_ONLY: "true",
    HARBOR_LOCAL_AUTH_REQUIRED: "true",
    HARBOR_LOCAL_CRON_DISABLED: "true",
    HARBOR_LOCAL_X402_ISSUED_FIXTURE_ENABLED: "true",
    HARBOR_LOCAL_X402_ISSUED_FIXTURE_PROFILE:
      LOCAL_X402_ISSUED_FIXTURE_PROFILE,
    EXECUTOR: "quickjs",
    EXEC_NETWORK: "testnet",
    MAINNET_EXECUTION: "false",
  },
  x402IssuedFixtureService: { pay: vi.fn(async () => serviceResult) },
});

describe("x402.payIssuedFixture operation", () => {
  const operation = ops[0]!;

  it("is disabled by default and cannot be enabled by native-XRP flags", async () => {
    await expect(operation.handler({
      principal: "principal-001",
      localDevRequest: true,
      env: {
        HARBOR_LOCAL_DEV: "true",
        HARBOR_LOCAL_READ_ONLY: "true",
        HARBOR_LOCAL_X402_RUNTIME_ENABLED: "true",
        HARBOR_LOCAL_X402_SIGNING_PROFILE: "reviewed-testnet-local-v1",
        EXEC_NETWORK: "testnet",
        MAINNET_EXECUTION: "false",
      },
      x402IssuedFixtureService: { pay: vi.fn(async () => result) },
    }, request)).rejects.toMatchObject({
      code: X402_ISSUED_FIXTURE_DISABLED,
    });
  });

  it("returns only explicitly labelled, request-bound fixture evidence", async () => {
    const context = enabledContext();
    await expect(operation.handler(context, request)).resolves.toEqual(result);
    expect(context.x402IssuedFixtureService.pay).toHaveBeenCalledWith(
      "principal-001",
      request,
    );
  });

  it("rejects a response above the exact decimal authorization", async () => {
    await expect(operation.handler(
      enabledContext({ ...result, amount: "0.02" }),
      request,
    )).rejects.toThrow("outside the authorized binding");
  });
});
