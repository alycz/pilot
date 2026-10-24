import { hashes } from "xrpl";

import {
  hasWalletSubmissionCapability,
  hasWalletTransactionCapability,
  issueWalletHarborCapability,
  readWalletSession,
  verifiedSignedBlobTransaction,
  WALLET_SUBMISSIONS_COOKIE,
} from "../../../../lib/wallet-session";
import { resolveStableAsset } from "../../../../lib/stable-asset";
import { resolvePilotRequestAuthority } from "../../../../lib/runtime-profile";

type Environment = Readonly<Record<string, string | undefined>>;
type Dependencies = {
  env: Environment;
  fetch: typeof globalThis.fetch;
};

const RPC_ENDPOINTS = {
  testnet: "https://s.altnet.rippletest.net:51234/",
  devnet: "https://s.devnet.rippletest.net:51234/",
} as const;

function response(status: number, body: object, headers?: Record<string, string>): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
  });
}

function sameOrigin(request: Request, environment: Environment): boolean {
  try {
    const authority = resolvePilotRequestAuthority(environment, request);
    return request.headers.get("origin") === authority.origin;
  } catch {
    return false;
  }
}

function exactTrustSet(
  transaction: Record<string, unknown>,
  account: string,
  asset: { currency: string; issuer: string },
): boolean {
  const allowed = new Set([
    "TransactionType", "Account", "LimitAmount", "Fee", "Sequence", "LastLedgerSequence",
    "Flags", "SourceTag", "Memos", "SigningPubKey", "TxnSignature",
  ]);
  if (Object.keys(transaction).some((key) => !allowed.has(key))) return false;
  const limit = transaction.LimitAmount;
  const fee = typeof transaction.Fee === "string" ? Number(transaction.Fee) : Number.NaN;
  return transaction.TransactionType === "TrustSet" &&
    transaction.Account === account &&
    limit !== null && typeof limit === "object" && !Array.isArray(limit) &&
    (limit as Record<string, unknown>).currency === asset.currency &&
    (limit as Record<string, unknown>).issuer === asset.issuer &&
    (limit as Record<string, unknown>).value === "10000" &&
    Number.isSafeInteger(fee) && fee >= 0 && fee <= 100 &&
    Number.isSafeInteger(transaction.Sequence) && Number(transaction.Sequence) >= 0 &&
    Number.isSafeInteger(transaction.LastLedgerSequence) && Number(transaction.LastLedgerSequence) > 0 &&
    (transaction.Flags === undefined || transaction.Flags === 0);
}

async function rpc(fetchImpl: typeof fetch, endpoint: string, method: string, params: object) {
  const upstream = await fetchImpl(endpoint, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ method, params: [params], api_version: 2 }),
    cache: "no-store",
  });
  if (!upstream.ok) throw new Error("XRPL provider unavailable");
  return await upstream.json() as { result?: Record<string, unknown> };
}

export function createTrustSetRelayHandler(overrides: Partial<Dependencies> = {}) {
  const dependencies: Dependencies = {
    env: process.env,
    fetch: (...args) => globalThis.fetch(...args),
    ...overrides,
  };
  return async function POST(request: Request): Promise<Response> {
    if (dependencies.env.HARBOR_MOCK !== "0") {
      return response(503, { error: { message: "Live TrustSet relay is disabled outside live Harbor mode." } });
    }
    if (!sameOrigin(request, dependencies.env)) return response(403, { error: { message: "Same-origin TrustSet access is required." } });
    const session = readWalletSession(request);
    const configuredNetwork = dependencies.env.EXEC_NETWORK?.trim();
    if (!session || configuredNetwork !== session.network || (configuredNetwork !== "testnet" && configuredNetwork !== "devnet")) {
      return response(401, { error: { message: "Wallet-bound test-network authorization is required." } });
    }
    let asset: { currency: string; issuer: string };
    try {
      const configured = resolveStableAsset(dependencies.env, session.network);
      if (!configured.issuer) throw new Error("MISSING_STABLE_ASSET_ISSUER");
      asset = { currency: configured.currency, issuer: configured.issuer };
    } catch {
      return response(503, { error: { message: "The stable asset is not configured." } });
    }
    const body = await request.json().catch(() => undefined) as
      | { action?: unknown; tx_blob?: unknown; hash?: unknown }
      | undefined;
    if (!body || (body.action !== "authorize" && body.action !== "submit" && body.action !== "status")) {
      return response(400, { error: { message: "A valid TrustSet action is required." } });
    }
    const endpoint = RPC_ENDPOINTS[session.network];
    try {
      if (body.action === "authorize" || body.action === "submit") {
        if (typeof body.tx_blob !== "string" || body.hash !== undefined) {
          return response(400, { error: { message: "A signed TrustSet blob is required." } });
        }
        const transaction = verifiedSignedBlobTransaction(body.tx_blob);
        if (
          !transaction || !exactTrustSet(transaction, session.account, asset) ||
          !hasWalletTransactionCapability(request, transaction)
        ) {
          return response(400, { error: { message: "The signed TrustSet does not match the authorized onboarding transaction." } });
        }
        const hash = hashes.hashSignedTx(body.tx_blob).toUpperCase();
        if (body.action === "submit" && !hasWalletSubmissionCapability(request, hash)) {
          return response(401, { error: { message: "TrustSet submission authorization is required." } });
        }
        const ledgerPayload = await rpc(dependencies.fetch, endpoint, "account_info", {
          account: session.account,
          ledger_index: "validated",
          strict: true,
        });
        const ledger = ledgerPayload.result;
        const lastLedgerSequence = transaction.LastLedgerSequence;
        if (
          ledger?.validated !== true || !Number.isSafeInteger(ledger.ledger_index) ||
          !Number.isSafeInteger(lastLedgerSequence) ||
          Number(lastLedgerSequence) <= Number(ledger.ledger_index) ||
          Number(lastLedgerSequence) > Number(ledger.ledger_index) + 50
        ) {
          return response(422, { error: { message: "The signed TrustSet no longer has a safe validated-ledger window." } });
        }
        if (body.action === "authorize") {
          const capability = issueWalletHarborCapability(request, { hash });
          if (!capability) return response(500, { error: { message: "TrustSet status authorization could not be recorded." } });
          return response(200, { hash, network: session.network, validated: false }, {
            "set-cookie": `${WALLET_SUBMISSIONS_COOKIE}=${encodeURIComponent(capability)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`,
          });
        }
        const payload = await rpc(dependencies.fetch, endpoint, "submit", { tx_blob: body.tx_blob, fail_hard: false });
        const result = payload.result;
        const engineResult = typeof result?.engine_result === "string" ? result.engine_result : undefined;
        const returnedHash = typeof result?.tx_json === "object" && result.tx_json !== null
          ? (result.tx_json as Record<string, unknown>).hash
          : undefined;
        if (typeof returnedHash === "string" && returnedHash.toUpperCase() !== hash) {
          return response(502, { error: { message: "The XRPL provider returned a mismatched transaction hash." } });
        }
        if (!engineResult || (!engineResult.startsWith("tes") && !engineResult.startsWith("ter") && engineResult !== "tefALREADY")) {
          return response(422, { error: { message: "The XRPL provider refused the signed TrustSet." } });
        }
        return response(200, { hash, network: session.network, validated: false, engine_result: engineResult });
      }

      if (
        typeof body.hash !== "string" || !/^[A-Fa-f0-9]{64}$/.test(body.hash) ||
        body.tx_blob !== undefined || !hasWalletSubmissionCapability(request, body.hash)
      ) {
        return response(401, { error: { message: "TrustSet status authorization is required." } });
      }
      const hash = body.hash.toUpperCase();
      const payload = await rpc(dependencies.fetch, endpoint, "tx", { transaction: hash, binary: false });
      const result = payload.result;
      if (result?.error === "txnNotFound") {
        return response(200, { hash, network: session.network, validated: false });
      }
      if (!result || result.hash !== hash || result.validated !== true) {
        return response(200, { hash, network: session.network, validated: false });
      }
      const txJson = result.tx_json;
      const meta = result.meta;
      if (
        !txJson || typeof txJson !== "object" || Array.isArray(txJson) ||
        (txJson as Record<string, unknown>).Account !== session.account ||
        (txJson as Record<string, unknown>).TransactionType !== "TrustSet" ||
        !(() => {
          const limit = (txJson as Record<string, unknown>).LimitAmount;
          return limit !== null && typeof limit === "object" && !Array.isArray(limit) &&
            (limit as Record<string, unknown>).currency === asset.currency &&
            (limit as Record<string, unknown>).issuer === asset.issuer &&
            (limit as Record<string, unknown>).value === "10000";
        })() ||
        !meta || typeof meta !== "object" || Array.isArray(meta) ||
        typeof (meta as Record<string, unknown>).TransactionResult !== "string" ||
        !Number.isSafeInteger(result.ledger_index)
      ) return response(502, { error: { message: "The XRPL provider returned an invalid TrustSet status." } });
      return response(200, {
        hash,
        network: session.network,
        validated: true,
        ledger_index: result.ledger_index,
        engine_result: (meta as Record<string, unknown>).TransactionResult,
      });
    } catch {
      return response(502, { error: { message: "The XRPL provider is temporarily unavailable." } });
    }
  };
}
