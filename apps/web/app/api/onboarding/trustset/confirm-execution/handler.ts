import { DEFAULT_POLICY } from "@pilot/contracts";

import {
  hasWalletPolicyCapability,
  hasWalletPreparedExecutionCapability,
  issueWalletHarborCapability,
  readWalletSession,
  WALLET_SUBMISSIONS_COOKIE,
} from "../../../../../lib/wallet-session";
import { resolvePilotRequestAuthority } from "../../../../../lib/runtime-profile";

type Environment = Readonly<Record<string, string | undefined>>;
type Dependencies = { env: Environment };

const ONBOARDING_TRUST_INTENT =
  /^onboarding-trust-(?:rlusd|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const OFFICIAL_TESTNET_RLUSD = {
  currency: "524C555344000000000000000000000000000000",
  issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
} as const;

function response(status: number, body: object, headers?: Record<string, string>): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function sameOrigin(request: Request, environment: Environment): boolean {
  try {
    return request.headers.get("origin") ===
      resolvePilotRequestAuthority(environment, request).origin;
  } catch {
    return false;
  }
}

function isExactOfficialTrustSet(
  transaction: Record<string, unknown>,
  account: string,
): boolean {
  const allowed = new Set([
    "TransactionType", "Account", "LimitAmount", "Fee", "Sequence", "LastLedgerSequence",
    "Flags", "SourceTag", "Memos",
  ]);
  if (Object.keys(transaction).some((key) => !allowed.has(key))) return false;
  const limit = transaction.LimitAmount;
  const fee = typeof transaction.Fee === "string" ? Number(transaction.Fee) : Number.NaN;
  return transaction.TransactionType === "TrustSet" &&
    transaction.Account === account &&
    limit !== null && typeof limit === "object" && !Array.isArray(limit) &&
    (limit as Record<string, unknown>).currency === OFFICIAL_TESTNET_RLUSD.currency &&
    (limit as Record<string, unknown>).issuer === OFFICIAL_TESTNET_RLUSD.issuer &&
    (limit as Record<string, unknown>).value === "10000" &&
    Number.isSafeInteger(fee) && fee >= 0 && fee <= 100 &&
    Number.isSafeInteger(transaction.Sequence) && Number(transaction.Sequence) >= 0 &&
    Number.isSafeInteger(transaction.LastLedgerSequence) &&
    Number(transaction.LastLedgerSequence) > 0 &&
    (transaction.Flags === undefined || transaction.Flags === 0);
}

export function createTrustSetExecutionConfirmationHandler(
  overrides: Partial<Dependencies> = {},
) {
  const dependencies: Dependencies = { env: process.env, ...overrides };
  return async function POST(request: Request): Promise<Response> {
    if (!sameOrigin(request, dependencies.env)) {
      return response(403, { error: { message: "Same-origin TrustSet confirmation is required." } });
    }
    const session = readWalletSession(request);
    if (!session || session.network !== "testnet" || dependencies.env.EXEC_NETWORK?.trim() !== "testnet") {
      return response(401, { error: { message: "Wallet-bound Testnet authorization is required." } });
    }
    const body = await request.json().catch(() => undefined) as
      | { build_id?: unknown; idempotency_key?: unknown; tx_json?: unknown }
      | undefined;
    if (
      !body || Object.keys(body).some((key) =>
        key !== "build_id" && key !== "idempotency_key" && key !== "tx_json"
      ) ||
      typeof body.build_id !== "string" || !body.build_id || body.build_id.length > 256 ||
      typeof body.idempotency_key !== "string" ||
      !ONBOARDING_TRUST_INTENT.test(body.idempotency_key) ||
      !body.tx_json || typeof body.tx_json !== "object" || Array.isArray(body.tx_json)
    ) {
      return response(400, { error: { message: "An exact prepared TrustSet confirmation is required." } });
    }
    const transaction = body.tx_json as Record<string, unknown>;
    if (
      !isExactOfficialTrustSet(transaction, session.account) ||
      !hasWalletPolicyCapability(request, DEFAULT_POLICY) ||
      !hasWalletPreparedExecutionCapability(
        request,
        body.build_id,
        body.idempotency_key,
        transaction,
      )
    ) {
      return response(403, {
        error: { message: "The TrustSet does not match the wallet-bound prepared transaction." },
      });
    }
    const capability = issueWalletHarborCapability(request, {
      execution: {
        buildId: body.build_id,
        idempotencyKey: body.idempotency_key,
        requireOwnerApproval: false,
      },
    });
    if (!capability) {
      return response(500, { error: { message: "TrustSet execution confirmation could not be recorded." } });
    }
    return response(200, {
      confirmed: true,
      build_id: body.build_id,
      idempotency_key: body.idempotency_key,
    }, {
      "set-cookie": `${WALLET_SUBMISSIONS_COOKIE}=${encodeURIComponent(capability)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`,
    });
  };
}
