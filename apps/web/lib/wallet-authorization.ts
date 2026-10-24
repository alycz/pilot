import { EnvelopeSchema } from "@pilot/contracts";
import { HarborResultSchemas, type HarborOpName } from "@pilot/harbor-client";
import { hashes } from "xrpl";

import {
  hasWalletExecutionCapability,
  hasWalletSubmissionCapability,
  hasWalletTransactionCapability,
  issueWalletHarborCapability,
  readWalletSession,
  verifiedSignedBlobTransaction,
  walletPolicyDigest,
  walletTransactionDigest,
  WALLET_SUBMISSIONS_COOKIE,
  type WalletSessionNetwork,
} from "./wallet-session";

type AuthEnvironment = Readonly<Record<string, string | undefined>>;

const RLUSD_ACQUISITION_INTENT =
  /^p-live-acquire-rlusd-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ONBOARDING_TRUST_INTENT =
  /^onboarding-trust-(?:rlusd|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const OFFICIAL_TESTNET_RLUSD = {
  currency: "524C555344000000000000000000000000000000",
  issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
} as const;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isExactOnboardingTrustBuilder(
  op: HarborOpName,
  args: Record<string, unknown>,
): boolean {
  if (
    op !== "tx.trustSet" || args.network !== "testnet" ||
    typeof args.intent_id !== "string" || !ONBOARDING_TRUST_INTENT.test(args.intent_id)
  ) return false;
  const limit = args.limit_amount;
  return !!limit && typeof limit === "object" && !Array.isArray(limit) &&
    (limit as Record<string, unknown>).currency === OFFICIAL_TESTNET_RLUSD.currency &&
    (limit as Record<string, unknown>).issuer === OFFICIAL_TESTNET_RLUSD.issuer &&
    (limit as Record<string, unknown>).value === "10000";
}

function isExactRlusdAcquisitionBuilder(
  op: HarborOpName,
  args: Record<string, unknown>,
): boolean {
  if (op !== "tx.swap" || args.network !== "testnet" || args.side !== "buy" ||
      args.max_slippage_bps !== 100 || args.execution_mode !== "fill_or_kill") return false;
  const sell = args.sell;
  const buy = args.buy;
  const amount = args.amount;
  return !!sell && typeof sell === "object" && !Array.isArray(sell) &&
    (sell as Record<string, unknown>).currency === "XRP" &&
    !!buy && typeof buy === "object" && !Array.isArray(buy) &&
    (buy as Record<string, unknown>).currency === OFFICIAL_TESTNET_RLUSD.currency &&
    (buy as Record<string, unknown>).issuer === OFFICIAL_TESTNET_RLUSD.issuer &&
    !!amount && typeof amount === "object" && !Array.isArray(amount) &&
    (amount as Record<string, unknown>).currency === OFFICIAL_TESTNET_RLUSD.currency &&
    (amount as Record<string, unknown>).issuer === OFFICIAL_TESTNET_RLUSD.issuer &&
    (amount as Record<string, unknown>).value === "75";
}

function configuredNetwork(environment: AuthEnvironment): WalletSessionNetwork | undefined {
  const value = environment.EXEC_NETWORK?.trim();
  return value === "testnet" || value === "devnet" ? value : undefined;
}

export function authorizeWalletResource(
  request: Request,
  account: string,
  network: WalletSessionNetwork,
  environment: AuthEnvironment = process.env,
): boolean {
  const session = readWalletSession(request, environment);
  return session?.account === account && session.network === network;
}

/**
 * Bind every credentialed Harbor browser operation to the wallet-authenticated
 * account and execution network. Forced-owner execution is additionally bound
 * to the exact validated build, stable intent id, and approval mode. Approval
 * submissions are bound by the verified signed transaction Account; approval
 * capabilities cannot be issued here for the common server-chat path because
 * its tx.execute response does not traverse this browser proxy. Harbor remains
 * responsible for binding approval_id to its stored build, network, exact
 * transaction fields, and expiry.
 */
export function authorizeWalletHarborOperation(
  request: Request,
  op: HarborOpName,
  args: Record<string, unknown>,
  environment: AuthEnvironment = process.env,
): boolean {
  const session = readWalletSession(request, environment);
  if (!session) return false;
  const executionNetwork = configuredNetwork(environment);
  if (!executionNetwork || executionNetwork !== session.network) return false;

  if (typeof args.network === "string" && args.network !== session.network) return false;
  if (typeof args.owner === "string" && args.owner !== session.account) return false;
  if (typeof args.account === "string" && args.account !== session.account) return false;

  // x402 payment is authorized only by the fresh, single-use wallet action
  // proof on /api/chat. A long-lived wallet session is insufficient and this
  // browser-reachable proxy must never dispatch a payment.
  if (op === "x402.pay") return false;

  // These sponsor operations have irreversible or privileged effects and are
  // intentionally unavailable through the browser proxy. Harbor's internal
  // policy checks remain defense in depth, not browser authorization.
  if (
    op === "mandate.revoke" ||
    op === "credential.payerAccept" ||
    op === "ap4m.purchase"
  ) return false;

  if (op === "tx.execute") {
    return hasWalletExecutionCapability(
      request,
      args.build_id,
      args.idempotency_key,
      args.require_owner_approval,
    );
  }
  if (op === "tx.simulate") {
    const transaction = args.tx_json;
    if (
      !transaction || typeof transaction !== "object" || Array.isArray(transaction) ||
      (transaction as Record<string, unknown>).Account !== session.account
    ) return false;
  }
  if (op === "tx.submit") {
    const signed = verifiedSignedBlobTransaction(args.tx_blob);
    if (signed?.Account !== session.account) return false;
    if (typeof args.approval_id === "string") {
      // Harbor binds approval_id to its authenticated principal, stored build,
      // network, exact owner transaction fields, and expiry. Pilot cannot
      // require a proxy-issued approval capability because chat executes on the
      // server, but independently binds the verified signature Account to this
      // wallet session before relaying the signed blob.
      return true;
    }
    return signed.TransactionType === "DelegateSet" &&
      hasWalletTransactionCapability(request, signed);
  }
  if (op === "tx.status") {
    return typeof args.account === "string" || hasWalletSubmissionCapability(request, args.hash);
  }

  return op === "onboarding.readiness" ||
    op === "account.link" ||
    op === "account.revoke" ||
    op === "account.status" ||
    op === "mandate.prepare" ||
    op === "mandate.register" ||
    op === "policy.get" ||
    op === "policy.set" ||
    op.startsWith("tx.");
}

export function authorizeBrowserHarborOperation(
  request: Request,
  op: HarborOpName,
  args: Record<string, unknown>,
): boolean {
  // /api/chat verifies the fresh single-use proof. The browser Harbor proxy
  // has only a long-lived session and therefore cannot authorize x402.
  if (op === "x402.pay") return false;
  return authorizeWalletHarborOperation(request, op, args);
}

export function walletHarborResponseHeaders(
  request: Request,
  op: HarborOpName,
  args: Record<string, unknown>,
  body: ArrayBuffer,
  status: number,
): Record<string, string> {
  if (status < 200 || status >= 300 || body.byteLength === 0) return {};
  try {
    const schema = EnvelopeSchema(HarborResultSchemas[op]);
    const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(body)));
    if (!parsed.success || !parsed.data.ok) return {};
    const data = parsed.data.data as {
      build_id?: unknown;
      delegate?: unknown;
      delegate_set_tx?: unknown;
      hash?: unknown;
      network?: unknown;
      owner?: unknown;
      permissions?: unknown;
      preflight?: unknown;
      simulate?: unknown;
      summary?: unknown;
      status?: unknown;
      tx_json?: unknown;
      revoke_tx?: unknown;
    };
    const session = readWalletSession(request);
    if (!session) return {};
    const isBuilder = op.startsWith("tx.") &&
      op !== "tx.status" && op !== "tx.execute" && op !== "tx.submit";
    let transactionDigest: string | undefined;
    if (isBuilder) {
      const summary = data.summary;
      const transaction = data.tx_json;
      if (
        args.account !== session.account || data.network !== session.network ||
        !summary || typeof summary !== "object" || Array.isArray(summary) ||
        (summary as Record<string, unknown>).account !== session.account ||
        !transaction || typeof transaction !== "object" || Array.isArray(transaction) ||
        (transaction as Record<string, unknown>).Account !== session.account
      ) return {};
      const simulate = data.simulate;
      const preflight = data.preflight;
      if (
        !simulate || typeof simulate !== "object" || Array.isArray(simulate) ||
        (simulate as Record<string, unknown>).engine_result !== "tesSUCCESS" ||
        (simulate as Record<string, unknown>).applied !== false ||
        !Array.isArray(preflight) || preflight.length === 0 || preflight.some((check) =>
          !check || typeof check !== "object" || Array.isArray(check) ||
          (check as Record<string, unknown>).pass !== true
        )
      ) return {};
      transactionDigest = walletTransactionDigest(transaction as Record<string, unknown>);
    }
    if (op === "account.link" || op === "account.revoke") {
      const transaction = op === "account.link" ? data.delegate_set_tx : data.revoke_tx;
      const permissions = data.permissions;
      const encodedPermissions = transaction && typeof transaction === "object" && !Array.isArray(transaction)
        ? (transaction as Record<string, unknown>).Permissions
        : undefined;
      const transactionPermissions = Array.isArray(encodedPermissions)
        ? encodedPermissions.map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
          const permission = (entry as Record<string, unknown>).Permission;
          return permission && typeof permission === "object" && !Array.isArray(permission)
            ? (permission as Record<string, unknown>).PermissionValue
            : undefined;
        })
        : undefined;
      if (
        args.owner !== session.account || args.network !== session.network ||
        data.owner !== session.account || data.network !== session.network ||
        !transaction || typeof transaction !== "object" || Array.isArray(transaction) ||
        (transaction as Record<string, unknown>).TransactionType !== "DelegateSet" ||
        (transaction as Record<string, unknown>).Account !== session.account ||
        (op === "account.link" && (
          data.status !== "pending" || typeof data.delegate !== "string" ||
          (transaction as Record<string, unknown>).Authorize !== data.delegate ||
          !Array.isArray(permissions) ||
          JSON.stringify(transactionPermissions) !== JSON.stringify(permissions)
        ))
      ) return {};
      transactionDigest = walletTransactionDigest(transaction as Record<string, unknown>);
    }
    const onboardingPreparation = isBuilder &&
      isExactOnboardingTrustBuilder(op, args) &&
      typeof data.build_id === "string" &&
      typeof args.intent_id === "string" &&
      typeof transactionDigest === "string"
      ? {
        buildId: data.build_id,
        idempotencyKey: args.intent_id,
        transactionDigest,
      }
      : undefined;
    const policyDigest = op === "policy.set" && args.owner === session.account &&
      args.network === session.network && args.policy && typeof args.policy === "object" &&
      !Array.isArray(args.policy) && canonicalJson(data) === canonicalJson(args.policy)
      ? walletPolicyDigest(data as Record<string, unknown>)
      : undefined;
    const update = op === "tx.submit" &&
          typeof data.hash === "string"
        ? (() => {
          if (typeof data.hash !== "string" || typeof args.tx_blob !== "string") return {};
          try {
            return hashes.hashSignedTx(args.tx_blob).toUpperCase() === data.hash.toUpperCase()
              ? { hash: data.hash }
              : {};
          } catch {
            return {};
          }
        })()
        : isBuilder || op === "account.link" || op === "account.revoke"
          ? {
            transactionDigest,
            preparedExecution: onboardingPreparation,
            execution: isBuilder && op !== "tx.trustSet" &&
                typeof data.build_id === "string" &&
                typeof args.intent_id === "string" &&
                args.intent_id.length > 0 && args.intent_id.length <= 200
              ? {
                buildId: data.build_id,
                idempotencyKey: args.intent_id,
                requireOwnerApproval: RLUSD_ACQUISITION_INTENT.test(args.intent_id) &&
                  isExactRlusdAcquisitionBuilder(op, args),
              }
              : undefined,
          }
          : { policyDigest };
    const capability = issueWalletHarborCapability(request, update);
    if (!capability) return {};
    return {
      "set-cookie": `${WALLET_SUBMISSIONS_COOKIE}=${encodeURIComponent(capability)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`,
    };
  } catch {
    return {};
  }
}
