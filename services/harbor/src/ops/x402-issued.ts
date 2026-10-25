import type { OpContext, OpDef } from "../catalog/registry";
import {
  X402IssuedFixtureResultSchema,
  X402IssuedPayRequestSchema,
  compareX402IssuedAmounts,
  type X402IssuedFixtureResult,
  type X402IssuedFixtureService,
  type X402IssuedPayRequest,
} from "../x402-issued-contract";
import { isReviewedLocalX402IssuedFixtureContext } from "../local-x402-issued-fixture";

export const X402_ISSUED_FIXTURE_DISABLED = "X402_ISSUED_FIXTURE_DISABLED";
export const X402_ISSUED_FIXTURE_NOT_CONFIGURED = "X402_ISSUED_FIXTURE_NOT_CONFIGURED";

export class X402IssuedOperationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "X402IssuedOperationError";
  }
}

type X402IssuedContext = OpContext & {
  localDevRequest?: unknown;
  env?: unknown;
  x402IssuedFixtureService?: unknown;
};

function service(ctx: X402IssuedContext): X402IssuedFixtureService {
  if (!isReviewedLocalX402IssuedFixtureContext(ctx)) {
    throw new X402IssuedOperationError(X402_ISSUED_FIXTURE_DISABLED);
  }
  const candidate = ctx.x402IssuedFixtureService;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof (candidate as { pay?: unknown }).pay !== "function"
  ) {
    throw new X402IssuedOperationError(X402_ISSUED_FIXTURE_NOT_CONFIGURED);
  }
  return candidate as X402IssuedFixtureService;
}

async function payIssuedFixture(
  ctx: X402IssuedContext,
  request: X402IssuedPayRequest,
): Promise<X402IssuedFixtureResult> {
  const parsed = X402IssuedPayRequestSchema.parse(request);
  const result = X402IssuedFixtureResultSchema.parse(
    await service(ctx).pay(ctx.principal, parsed),
  );
  if (
    result.session_scope !== parsed.session_scope ||
    result.merchant.id !== parsed.merchant.id ||
    result.merchant.resource_method !== parsed.merchant.resource_method ||
    result.merchant.resource_url !== parsed.merchant.resource_url ||
    result.idempotency_key !== parsed.idempotency_key ||
    result.asset.network !== parsed.asset.network ||
    result.asset.currency !== parsed.asset.currency ||
    result.asset.issuer !== parsed.asset.issuer ||
    result.payer !== parsed.owner ||
    result.pay_to !== parsed.pay_to ||
    compareX402IssuedAmounts(result.amount, parsed.max_amount) > 0
  ) {
    throw new Error("issued x402 fixture result is outside the authorized binding");
  }
  return result;
}

export const ops: OpDef[] = [
  {
    name: "x402.payIssuedFixture",
    family: "x402",
    summary: "Run the default-off native XRPL issued-currency x402 offline fixture.",
    tags: ["x402", "xrpl-issued", "offline-fixture", "local-only"],
    args: X402IssuedPayRequestSchema,
    returns: "explicit deterministic offline fixture evidence, never a validated-ledger receipt",
    caveats: ["off-ledger"],
    example:
      'await harbor.x402.payIssuedFixture({ owner: "r...", network: "testnet", resource: "compare", session_scope: "session-scope-001", merchant: { id: "merchant-local-001", resource_method: "POST", resource_url: "http://127.0.0.1:8000/api/x402/compare" }, asset: { kind: "xrpl-issued", network: "xrpl:1", currency: "524C555344000000000000000000000000000000", issuer: "r..." }, max_amount: "0.01", pay_to: "r...", idempotency_key: "issued-request-001" })',
    handler: async (ctx, request) =>
      payIssuedFixture(ctx as X402IssuedContext, request as X402IssuedPayRequest),
  },
];
