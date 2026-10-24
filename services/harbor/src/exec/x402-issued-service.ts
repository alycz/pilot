import {
  X402IssuedFixtureResultSchema,
  X402IssuedPayRequestSchema,
  type X402IssuedFixtureService,
  type X402IssuedPayRequest,
} from "../x402-issued-contract";
import type {
  X402IssuedFixtureResult,
  X402IssuedPolicy,
  createOfflineIssuedX402Route,
} from "./x402-issued-offline";

type IssuedRoute = ReturnType<typeof createOfflineIssuedX402Route>;

function sameRequestBinding(
  request: X402IssuedPayRequest,
  binding: Readonly<{
    owner: string;
    sessionScope: string;
    merchantId: string;
    resourceUrl: string;
    policy: X402IssuedPolicy;
  }>,
): boolean {
  return request.owner === binding.owner &&
    request.session_scope === binding.sessionScope &&
    request.merchant.id === binding.merchantId &&
    request.merchant.resource_method === "POST" &&
    request.merchant.resource_url === binding.resourceUrl &&
    request.asset.kind === binding.policy.asset.kind &&
    request.asset.network === binding.policy.asset.network &&
    request.asset.currency === binding.policy.asset.currency &&
    request.asset.issuer === binding.policy.asset.issuer &&
    request.pay_to === binding.policy.payTo;
}

/**
 * Bind the public, default-off issued fixture operation to the strict offline
 * engine without widening or dispatching through the existing XRP service.
 */
export function createIssuedX402FixtureService(deps: Readonly<{
  route: IssuedRoute;
  owner: string;
  sessionScope: string;
  merchantId: string;
  resourceUrl: string;
  policy: X402IssuedPolicy;
}>): X402IssuedFixtureService {
  return Object.freeze({
    async pay(_principal, rawRequest) {
      const request = X402IssuedPayRequestSchema.parse(rawRequest);
      if (!sameRequestBinding(request, deps)) {
        throw new Error("issued x402 fixture request is outside the configured binding");
      }
      const result: X402IssuedFixtureResult = await deps.route.execute({
        idempotencyKey: request.idempotency_key,
      });
      if (
        result.sessionScope !== request.session_scope ||
        result.merchantId !== request.merchant.id ||
        result.payer !== request.owner ||
        result.payTo !== request.pay_to
      ) throw new Error("issued x402 fixture result binding changed");
      return X402IssuedFixtureResultSchema.parse({
        status: result.status,
        evidence: result.evidence,
        session_scope: result.sessionScope,
        merchant: request.merchant,
        merchant_invoice_id: result.invoiceId,
        idempotency_key: result.idempotencyKey,
        approval_digest: result.approvalDigest,
        asset: result.asset,
        amount: result.amount,
        payer: result.payer,
        pay_to: result.payTo,
        fee_drops: result.feeDrops,
        transaction_hash: result.transactionHash,
        validated_ledger_index: result.validatedLedgerIndex,
        merchant_body: result.merchantBody,
      });
    },
  });
}
