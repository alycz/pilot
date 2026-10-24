import {
  HERMES_CONSENT_DATA_POLICY,
  hermesConsentScopeDigest,
  issueHermesConsentCookie,
  readHermesConsentCookie,
  revokeHermesConsentCookie,
  type HermesConsentDisclosure,
  type HermesConsentScope,
} from "../../../../lib/hermes-consent";
import {
  drainHermesRetention,
  HermesRetentionCommitUncertainError,
  HermesRetentionContentionError,
  HermesRetentionJournal,
  type HermesDeletionConfig,
} from "../../../../lib/hermes-retention";
import { resolvePilotRequestAuthority } from "../../../../lib/runtime-profile";
import { readWalletSession } from "../../../../lib/wallet-session";
import { probeHermesRuntimeReadinessFromEnvironment } from "../../../../lib/hermes-runtime";

export const runtime = "nodejs";

type ConsentConfiguration = Readonly<{
  disclosure: HermesConsentDisclosure;
  secret: string;
  tenantId: string;
  network: "testnet" | "devnet";
  statePath: string;
}>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

async function activationState(): Promise<
  | { activationReady: true }
  | { activationReady: false; activationBlock: string }
> {
  const readiness = await probeHermesRuntimeReadinessFromEnvironment(process.env);
  return readiness.ready
    ? { activationReady: true }
    : { activationReady: false, activationBlock: readiness.reason };
}

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

function unavailable(): Response {
  return json({ error: "Hermes workflow advisory is unavailable." }, 404);
}

function misconfigured(): Response {
  return json({ error: "Hermes workflow advisory configuration is invalid." }, 409);
}

function retryableRetentionContention(cause: unknown): Response | undefined {
  if (cause instanceof Error && cause.name === "AbortError") throw cause;
  return cause instanceof HermesRetentionContentionError
    ? json(
      { error: "Hermes consent state is temporarily busy." },
      503,
      { "retry-after": "1" },
    )
    : undefined;
}

function environmentConfiguration():
  | { state: "disabled" }
  | { state: "invalid" }
  | { state: "enabled"; config: ConsentConfiguration } {
  const enabled = process.env.PILOT_HERMES_ENABLED;
  if (enabled === undefined || enabled === "0") return { state: "disabled" };
  if (enabled !== "1") return { state: "invalid" };

  const provider = process.env.PILOT_HERMES_PROVIDER;
  const model = process.env.PILOT_HERMES_MODEL;
  const retention = process.env.PILOT_HERMES_RETENTION_DAYS;
  const termsVersion = process.env.PILOT_HERMES_TERMS_VERSION;
  const secret = process.env.PILOT_HERMES_CONSENT_SECRET;
  const tenantId = process.env.PILOT_PERSONALIZATION_TENANT_ID;
  const network = process.env.EXEC_NETWORK;
  const statePath = process.env.PILOT_HERMES_RETENTION_STATE_PATH;
  if (
    !provider || provider.length > 64 || !SAFE_ID.test(provider) ||
    !model || model.length > 128 || !SAFE_MODEL.test(model) ||
    !termsVersion || termsVersion.length > 64 || !SAFE_ID.test(termsVersion) ||
    !tenantId || tenantId.length > 64 || !SAFE_ID.test(tenantId) ||
    !secret || secret.length < 32 || /[\0\r\n]/.test(secret) ||
    !/^\d{1,2}$/.test(retention ?? "") ||
    (network !== "testnet" && network !== "devnet") ||
    !statePath || !statePath.startsWith("/") || /[\0\r\n]/.test(statePath)
  ) return { state: "invalid" };
  const retentionDays = Number(retention);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 30) {
    return { state: "invalid" };
  }
  return {
    state: "enabled",
    config: {
      disclosure: {
        provider,
        model,
        dataPolicy: HERMES_CONSENT_DATA_POLICY,
        retentionDays,
        termsVersion,
      },
      secret,
      tenantId,
      network,
      statePath,
    },
  };
}

function authenticatedScope(
  request: Request,
  config: ConsentConfiguration,
): HermesConsentScope | undefined {
  let authority: ReturnType<typeof resolvePilotRequestAuthority>;
  try {
    authority = resolvePilotRequestAuthority(process.env, request);
  } catch {
    return undefined;
  }
  const origin = request.headers.get("origin");
  const originAccepted = request.method === "GET"
    ? origin === null || origin === authority.origin
    : origin === authority.origin;
  if (
    !originAccepted ||
    request.headers.get("sec-fetch-site") !== "same-origin"
  ) return undefined;
  const session = readWalletSession(request);
  if (!session || session.network !== config.network) return undefined;
  return {
    tenantId: config.tenantId,
    owner: session.account,
    network: session.network,
  };
}

function resolveRequest(request: Request):
  | { response: Response }
  | { config: ConsentConfiguration; scope: HermesConsentScope } {
  const configured = environmentConfiguration();
  if (configured.state === "disabled") return { response: unavailable() };
  if (configured.state === "invalid") return { response: misconfigured() };
  const scope = authenticatedScope(request, configured.config);
  if (!scope) {
    return { response: json({ error: "Authenticated same-origin wallet consent is required." }, 401) };
  }
  return { config: configured.config, scope };
}

async function publicState(
  request: Request,
  config: ConsentConfiguration,
  scope: HermesConsentScope,
) {
  const scopeDigest = hermesConsentScopeDigest(scope, config.secret);
  const current = await new HermesRetentionJournal(config.statePath).consent(
    scopeDigest,
    request.signal,
  );
  const consent = current.state === "accepted" ? readHermesConsentCookie(
    request.headers.get("cookie"),
    scope,
    config.disclosure,
    { secret: config.secret, expectedEpoch: current.epoch },
  ) : null;
  return {
    configured: true as const,
    ...await activationState(),
    authenticated: true as const,
    disclosure: config.disclosure,
    consented: consent !== null,
    ...(consent ? { expiresAt: consent.expiresAt * 1_000 } : {}),
  };
}

export async function GET(request: Request): Promise<Response> {
  const resolved = resolveRequest(request);
  if ("response" in resolved) return resolved.response;
  try {
    return json(await publicState(request, resolved.config, resolved.scope));
  } catch (cause) {
    return retryableRetentionContention(cause) ?? misconfigured();
  }
}

export async function POST(request: Request): Promise<Response> {
  const resolved = resolveRequest(request);
  if ("response" in resolved) return resolved.response;
  const mediaType = request.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    return json({ error: "Hermes consent requires application/json." }, 415);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Hermes consent body must be valid JSON." }, 400);
  }
  if (
    !body || typeof body !== "object" || Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    (body as Record<string, unknown>).action !== "accept"
  ) {
    return json({ error: "Hermes consent accepts only the explicit accept action." }, 400);
  }
  try {
    const scopeDigest = hermesConsentScopeDigest(
      resolved.scope,
      resolved.config.secret,
    );
    const epoch = await new HermesRetentionJournal(
      resolved.config.statePath,
    ).acceptConsent(scopeDigest, Date.now(), request.signal);
    const issued = issueHermesConsentCookie(
      resolved.scope,
      resolved.config.disclosure,
      { secret: resolved.config.secret, epoch },
    );
    const activation = await activationState();
    return json(
      {
        configured: true,
        ...activation,
        authenticated: true,
        disclosure: resolved.config.disclosure,
        consented: true,
        expiresAt: issued.expiresAt * 1_000,
      },
      200,
      { "set-cookie": issued.setCookie },
    );
  } catch (cause) {
    return retryableRetentionContention(cause) ?? misconfigured();
  }
}

function deletionConfiguration(): HermesDeletionConfig | undefined {
  const origin = process.env.PILOT_HERMES_ORIGIN;
  const profile = process.env.PILOT_HERMES_PROFILE;
  const apiKey = process.env.PILOT_HERMES_API_KEY;
  return origin && profile && apiKey ? { origin, profile, apiKey } : undefined;
}

export async function DELETE(request: Request): Promise<Response> {
  const resolved = resolveRequest(request);
  if ("response" in resolved) return resolved.response;
  const scopeDigest = hermesConsentScopeDigest(
    resolved.scope,
    resolved.config.secret,
  );
  const journal = new HermesRetentionJournal(resolved.config.statePath);
  let revoked: Awaited<ReturnType<HermesRetentionJournal["revokeConsent"]>>;
  try {
    revoked = await journal.revokeConsent(scopeDigest, Date.now(), request.signal);
  } catch (cause) {
    if (cause instanceof HermesRetentionCommitUncertainError) {
      return json(
        {
          configured: true,
          activationReady: false,
          activationBlock: "retention-revocation-commit-uncertain",
          authenticated: true,
          disclosure: resolved.config.disclosure,
          consented: false,
          retention: {
            state: "unverified",
            attempted: 0,
            databaseAbsent: 0,
            remaining: null,
          },
        },
        200,
        { "set-cookie": revokeHermesConsentCookie() },
      );
    }
    return retryableRetentionContention(cause) ?? misconfigured();
  }
  let retention: Readonly<{
    state: "no-sessions" | "database-absence-verified" | "unverified";
    attempted: number;
    databaseAbsent: number;
    remaining: number | null;
  }> = {
    state: "unverified",
    attempted: 0,
    databaseAbsent: 0,
    remaining: revoked.pendingSessionIds.length,
  };
  try {
    if (revoked.pendingSessionIds.length === 0) {
      retention = {
        state: "no-sessions",
        attempted: 0,
        databaseAbsent: 0,
        remaining: 0,
      };
    } else {
      const deletion = deletionConfiguration();
      if (!deletion) {
        retention = {
          state: "unverified",
          attempted: 0,
          databaseAbsent: 0,
          remaining: revoked.pendingSessionIds.length,
        };
      } else {
        const result = await drainHermesRetention({
          journal,
          scopeDigest,
          config: deletion,
          includeNotDue: true,
          signal: request.signal,
        });
        retention = {
          state: result.blocked === 0 &&
            result.databaseAbsent === revoked.pendingSessionIds.length
            ? "database-absence-verified"
            : "unverified",
          attempted: result.attempted,
          databaseAbsent: result.databaseAbsent,
          remaining: revoked.pendingSessionIds.length - result.databaseAbsent,
        };
      }
    }
  } catch {
    // Revocation is already durable. Cleanup uncertainty must not resurrect
    // browser consent or suppress the expiring cookie.
  }
  let activation: Awaited<ReturnType<typeof activationState>>;
  try {
    activation = await activationState();
  } catch {
    activation = {
      activationReady: false,
      activationBlock: "runtime-readiness-unavailable",
    };
    retention = {
      state: "unverified",
      attempted: retention.attempted,
      databaseAbsent: retention.databaseAbsent,
      remaining: retention.remaining,
    };
  }
  return json(
    {
      configured: true,
      ...activation,
      authenticated: true,
      disclosure: resolved.config.disclosure,
      consented: false,
      retention,
    },
    200,
    { "set-cookie": revokeHermesConsentCookie() },
  );
}
