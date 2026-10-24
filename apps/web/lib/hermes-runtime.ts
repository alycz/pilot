import {
  createHermesProposalProvider,
  deriveHermesProfileBinding,
  type HermesCompletionUsage,
  type HermesFetch,
  type HermesProposalLease,
  type HermesProposalLeaseRequest,
} from "@pilot/agent/hermes-transport";
import type { Network } from "@pilot/contracts";
import { z } from "zod";

import {
  hermesConsentScopeDigest,
  readHermesConsentCookie,
  type HermesConsentDisclosure,
  type HermesConsentScope,
} from "./hermes-consent";
import {
  type HermesBridgeAuthorization,
  type HermesBridgeClient,
  createHermesBridgeClient,
  isHermesBridgeAuthorization,
} from "./hermes-bridge-service";
import {
  assertHermesProfileGateUnchanged,
  verifyHermesProfileGate,
  type HermesProfileGateInput,
  type HermesProfileGateSnapshot,
} from "./hermes-profile-gate";
import {
  HermesRetentionJournal,
  type HermesRetentionSweepController,
} from "./hermes-retention";
import {
  createDisabledHermesWorkflowAdvisor,
  createHermesWorkflowAdvisor,
  createProcessHermesUsageMonitor,
  type HermesWorkflowAdvisor,
  type HermesWorkflowUsageMonitor,
} from "./hermes-workflow-lessons";

const DAY_MS = 86_400_000;
const MAX_USAGE_CACHE = 1_024;
const HERMES_RUNTIME_TIMEOUT_MS = 15_000;
const HERMES_CREATION_DEADLINE_MS = 90_000;

const RuntimeConfigSchema = z.object({
  enabled: z.literal(true),
  origin: z.string().url().max(256),
  profile: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  apiKey: z.string().min(16).max(512).regex(/^[^\0\r\n]+$/),
  provider: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  model: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
  retentionDays: z.number().int().min(1).max(30),
  termsVersion: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  consentSecret: z.string().min(32).max(512).regex(/^[^\0\r\n]+$/),
  retentionStatePath: z.string().min(1).max(2_048),
  dailyCallLimit: z.number().int().min(1).max(20),
  profileGate: z.custom<HermesProfileGateInput>(),
}).strict();

export type HermesRuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export type HermesRuntimeRequest = Readonly<{
  request: Request;
  scope: Readonly<{
    tenantId: string;
    owner: string;
    network: Exclude<Network, "mainnet">;
  }>;
}>;

export type HermesRuntimeBridge = Readonly<{
  /** The same concrete client object is the transport's process-local authority identity. */
  client: HermesBridgeClient;
  usageMonitor: HermesWorkflowUsageMonitor;
}>;

export type HermesRuntimeActivationServices = Readonly<{
  /**
   * Launcher-owned operational proof for the already-running dedicated Hermes
   * process. A pinned manifest alone is deliberately insufficient.
   */
  assertImmutableProfile(
    snapshot: HermesProfileGateSnapshot,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Must already be explicitly started by the launcher. */
  retentionSweeper: Pick<
    HermesRetentionSweepController,
    "runOnce" | "status"
  >;
}>;

export type HermesRuntimeDependencies = Readonly<{
  bridge: HermesRuntimeBridge;
  transport?: HermesFetch;
  retentionJournal?: Pick<
    HermesRetentionJournal,
    "consent" | "registerSession" | "settleSessionCreation"
  >;
  verifyProfile?: (input: HermesProfileGateInput) => Promise<HermesProfileGateSnapshot>;
  assertProfileUnchanged?: (snapshot: HermesProfileGateSnapshot) => Promise<void>;
  activation: HermesRuntimeActivationServices;
  now?: () => number;
}>;

export type HermesRuntimeAdvisorFactory = (
  input: HermesRuntimeRequest,
) => Promise<HermesWorkflowAdvisor>;

function disabledFactory(): HermesRuntimeAdvisorFactory {
  return async () => createDisabledHermesWorkflowAdvisor();
}

function disclosure(config: HermesRuntimeConfig): HermesConsentDisclosure {
  return Object.freeze({
    provider: config.provider,
    model: config.model,
    dataPolicy: "bounded-redacted-proposals",
    retentionDays: config.retentionDays,
    termsVersion: config.termsVersion,
  });
}

function exactLease(
  authorization: HermesBridgeAuthorization,
  input: HermesProposalLeaseRequest,
): HermesProposalLease {
  if (
    !isHermesBridgeAuthorization(authorization) ||
    authorization.scopeDigest !== input.scopeDigest ||
    authorization.userContentDigest !== input.payloadDigest ||
    authorization.messageDigest !== input.messageDigest ||
    authorization.sessionId !== input.sessionId ||
    authorization.profile !== input.profile ||
    authorization.provider !== input.provider ||
    authorization.model !== input.model
  ) {
    throw new Error("Hermes bridge authorization did not match the current proposal");
  }
  return Object.freeze({
    leaseModel: authorization.leaseModel,
    scopeDigest: authorization.scopeDigest,
    payloadDigest: authorization.userContentDigest,
    messageDigest: authorization.messageDigest,
    profile: authorization.profile,
    provider: authorization.provider,
    model: authorization.model,
  });
}

/**
 * Compose the request-aware advisory path. This function performs no work when
 * disabled and never falls back to Hermes when consent or any attestation is
 * absent. The ordinary Pilot model and transaction paths are independent.
 */
export function createHermesRuntimeAdvisorFactory(
  rawConfig: HermesRuntimeConfig | { enabled: false },
  dependencies?: HermesRuntimeDependencies,
): HermesRuntimeAdvisorFactory {
  if (rawConfig.enabled === false || !dependencies) return disabledFactory();
  const parsed = RuntimeConfigSchema.safeParse(rawConfig);
  if (!parsed.success) return disabledFactory();
  const config = parsed.data;
  const expectedDisclosure = disclosure(config);
  const retain = dependencies.retentionJournal ??
    new HermesRetentionJournal(config.retentionStatePath);
  const verify = dependencies.verifyProfile ?? verifyHermesProfileGate;
  const assertUnchanged = dependencies.assertProfileUnchanged ??
    assertHermesProfileGateUnchanged;

  return async ({ request, scope }) => {
    if (request.signal.aborted) throw new Error("Hermes runtime request cancelled");
    const consentScope: HermesConsentScope = scope;
    const scopeRetentionDigest = hermesConsentScopeDigest(
      consentScope,
      config.consentSecret,
    );
    if (!dependencies.activation.retentionSweeper.status().ready) {
      return createDisabledHermesWorkflowAdvisor();
    }
    await dependencies.activation.retentionSweeper.runOnce(request.signal);
    if (!dependencies.activation.retentionSweeper.status().ready) {
      return createDisabledHermesWorkflowAdvisor();
    }
    const currentConsent = await retain.consent(scopeRetentionDigest);
    if (currentConsent.state !== "accepted" || currentConsent.epoch < 1) {
      return createDisabledHermesWorkflowAdvisor();
    }
    const consent = readHermesConsentCookie(
      request.headers.get("cookie"),
      consentScope,
      expectedDisclosure,
      {
        secret: config.consentSecret,
        expectedEpoch: currentConsent.epoch,
        now: (dependencies.now ?? Date.now)(),
      },
    );
    if (!consent) return createDisabledHermesWorkflowAdvisor();

    const profileSnapshot = await verify(config.profileGate);
    await dependencies.activation.assertImmutableProfile(
      profileSnapshot,
      request.signal,
    );
    await dependencies.bridge.client.attestReady(request.signal);
    const serverScope = Object.freeze({
      principalId: scope.owner,
      tenantId: scope.tenantId,
      channelId: `${scope.network}:${scope.owner}`,
    });
    const observedUsage = new Map<string, HermesCompletionUsage>();
    const provider = createHermesProposalProvider({
      enabled: true,
      origin: config.origin,
      profile: config.profile,
      profileBinding: deriveHermesProfileBinding(serverScope),
      apiKey: config.apiKey,
      model: config.model,
      timeoutMs: HERMES_RUNTIME_TIMEOUT_MS,
    }, serverScope, dependencies.transport, {
      provider: config.provider,
      leaseAuthority: {
        proof: dependencies.bridge.client,
        async issueLease(input, signal) {
          await dependencies.bridge.client.attestReady(signal);
          const authorization = await dependencies.bridge.client.authorize({
            scopeDigest: input.scopeDigest,
            userContent: input.userContent,
            messageDigest: input.messageDigest,
            sessionId: input.sessionId,
            profile: input.profile,
            provider: input.provider,
            model: input.model,
          }, signal);
          return exactLease(authorization, input);
        },
      },
      sessionLifecycle: {
        async prepare(session, signal) {
          const now = (dependencies.now ?? Date.now)();
          await retain.registerSession({
            scopeDigest: scopeRetentionDigest,
            sessionId: session.sessionId,
            expectedConsentEpoch: currentConsent.epoch,
            deleteAfter: now + config.retentionDays * DAY_MS,
            creationDeadline: now + HERMES_CREATION_DEADLINE_MS,
            now,
            signal,
          });
        },
        async settle(session) {
          const state = await retain.settleSessionCreation({
            scopeDigest: scopeRetentionDigest,
            sessionId: session.sessionId,
            expectedConsentEpoch: currentConsent.epoch,
            outcome: session.outcome,
            now: (dependencies.now ?? Date.now)(),
          });
          if (
            state !== "active" &&
            state !== "pending_delete" &&
            state !== "uncertain"
          ) {
            throw new Error("Hermes retention returned an invalid creation state");
          }
          return state;
        },
      },
      onUsage(usage) {
        if (observedUsage.size >= MAX_USAGE_CACHE && !observedUsage.has(usage.requestId)) {
          throw new Error("Hermes usage cache capacity reached");
        }
        observedUsage.set(usage.requestId, usage);
      },
    });
    await provider.attest(request.signal);

    return createHermesWorkflowAdvisor({
      provider,
      profile: config.profile,
      consent,
      consentScope,
      disclosure: expectedDisclosure,
      usageMonitor: dependencies.bridge.usageMonitor,
      leaseAuthorityProof: dependencies.bridge.client,
      async assertProfileUnchanged() {
        const latestConsent = await retain.consent(scopeRetentionDigest);
        if (
          latestConsent.state !== "accepted" ||
          latestConsent.epoch !== currentConsent.epoch
        ) {
          throw new Error("Hermes consent changed during the advisory");
        }
        await assertUnchanged(profileSnapshot);
        await dependencies.activation.assertImmutableProfile(
          profileSnapshot,
          request.signal,
        );
        if (!dependencies.activation.retentionSweeper.status().ready) {
          throw new Error("Hermes retention sweep is not ready");
        }
        await dependencies.bridge.client.attestReady(request.signal);
      },
      readUsage(requestId) {
        const usage = observedUsage.get(requestId);
        observedUsage.delete(requestId);
        return usage;
      },
      now: () => new Date((dependencies.now ?? Date.now)()),
    });
  };
}

export function disabledHermesRuntimeFactory(): HermesRuntimeAdvisorFactory {
  return disabledFactory();
}

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

let installedActivation: HermesRuntimeActivationServices | undefined;

/**
 * Installs the launcher-owned process gate exactly once. Importing the web app
 * does not install or start it. The returned disposer removes only this exact
 * registration and is intended for orderly launcher shutdown.
 */
export function installHermesRuntimeActivationServices(
  services: HermesRuntimeActivationServices,
): () => void {
  if (installedActivation) throw new Error("Hermes runtime activation is already installed");
  if (
    !services || typeof services.assertImmutableProfile !== "function" ||
    !services.retentionSweeper ||
    typeof services.retentionSweeper.runOnce !== "function" ||
    typeof services.retentionSweeper.status !== "function"
  ) {
    throw new Error("Invalid Hermes runtime activation services");
  }
  installedActivation = Object.freeze(services);
  return () => {
    if (installedActivation === services) installedActivation = undefined;
  };
}

/** Test/consent-surface snapshot; it never starts a service. */
export function hermesRuntimeActivationServices():
  | HermesRuntimeActivationServices
  | undefined {
  return installedActivation;
}

function integerEnvironment(
  value: string | undefined,
  minimum: number,
  maximum: number,
): number {
  if (!value || !/^\d+$/.test(value)) throw new Error("Invalid Hermes runtime configuration");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("Invalid Hermes runtime configuration");
  }
  return parsed;
}

function requiredEnvironment(environment: RuntimeEnvironment, key: string): string {
  const value = environment[key];
  if (!value) throw new Error("Invalid Hermes runtime configuration");
  return value;
}

/** Parse only server-owned values. Browser input never selects a provider or scope. */
export function hermesRuntimeConfigFromEnvironment(
  environment: RuntimeEnvironment,
): HermesRuntimeConfig | { enabled: false } {
  if (environment.PILOT_HERMES_ENABLED !== "1") return { enabled: false };
  const origin = requiredEnvironment(environment, "PILOT_HERMES_ORIGIN");
  const profile = requiredEnvironment(environment, "PILOT_HERMES_PROFILE");
  const provider = requiredEnvironment(environment, "PILOT_HERMES_PROVIDER");
  const model = requiredEnvironment(environment, "PILOT_HERMES_MODEL");
  const retentionDays = integerEnvironment(
    environment.PILOT_HERMES_RETENTION_DAYS,
    1,
    30,
  );
  const config: HermesRuntimeConfig = {
    enabled: true,
    origin,
    profile,
    apiKey: requiredEnvironment(environment, "PILOT_HERMES_API_KEY"),
    provider,
    model,
    retentionDays,
    termsVersion: requiredEnvironment(environment, "PILOT_HERMES_TERMS_VERSION"),
    consentSecret: requiredEnvironment(environment, "PILOT_HERMES_CONSENT_SECRET"),
    retentionStatePath: requiredEnvironment(
      environment,
      "PILOT_HERMES_RETENTION_STATE_PATH",
    ),
    dailyCallLimit: integerEnvironment(
      environment.PILOT_HERMES_DAILY_CALL_LIMIT,
      1,
      20,
    ),
    profileGate: {
      privateRoot: requiredEnvironment(environment, "PILOT_HERMES_PRIVATE_ROOT"),
      manifestPath: requiredEnvironment(environment, "PILOT_HERMES_MANIFEST_PATH"),
      manifestSha256: requiredEnvironment(
        environment,
        "PILOT_HERMES_MANIFEST_SHA256",
      ),
      profileConfigPath: requiredEnvironment(
        environment,
        "PILOT_HERMES_PROFILE_CONFIG_PATH",
      ),
      expected: {
        profile,
        hermesOrigin: origin,
        egressOrigin: requiredEnvironment(environment, "PILOT_HERMES_EGRESS_ORIGIN"),
        provider: requiredEnvironment(environment, "PILOT_HERMES_PROFILE_PROVIDER"),
        model: requiredEnvironment(environment, "PILOT_HERMES_PROFILE_MODEL"),
        retentionDays,
      },
    },
  };
  if (!RuntimeConfigSchema.safeParse(config).success) {
    throw new Error("Invalid Hermes runtime configuration");
  }
  return config;
}

/**
 * Build the production server-only composition. Construction performs no I/O;
 * every filesystem/live check still occurs on the scoped request path.
 */
export function createHermesRuntimeAdvisorFactoryFromEnvironment(
  environment: RuntimeEnvironment,
  runtimeFetch: typeof fetch = globalThis.fetch,
): HermesRuntimeAdvisorFactory {
  let config: HermesRuntimeConfig | { enabled: false };
  try {
    config = hermesRuntimeConfigFromEnvironment(environment);
    if (!config.enabled) return disabledFactory();
    const activeConfig = config;
    const client = createHermesBridgeClient({
      controlOrigin: requiredEnvironment(
        environment,
        "PILOT_HERMES_BRIDGE_CONTROL_ORIGIN",
      ),
      controlBearer: requiredEnvironment(
        environment,
        "PILOT_HERMES_BRIDGE_CONTROL_BEARER",
      ),
      controlResponseKey: requiredEnvironment(
        environment,
        "PILOT_HERMES_BRIDGE_CONTROL_RESPONSE_KEY",
      ),
      profile: activeConfig.profile,
      provider: activeConfig.provider,
      model: activeConfig.model,
      profileInvariantsDigest: requiredEnvironment(
        environment,
        "PILOT_HERMES_PROFILE_INVARIANTS_SHA256",
      ),
      bridgeConfigDigest: requiredEnvironment(
        environment,
        "PILOT_HERMES_BRIDGE_CONFIG_SHA256",
      ),
    }, runtimeFetch);
    const journal = new HermesRetentionJournal(activeConfig.retentionStatePath);
    const monitor = createProcessHermesUsageMonitor(activeConfig.dailyCallLimit);
    return async (input) => {
      const activation = installedActivation;
      if (!activation?.retentionSweeper.status().ready) {
        return createDisabledHermesWorkflowAdvisor();
      }
      return createHermesRuntimeAdvisorFactory(activeConfig, {
        bridge: { client, usageMonitor: monitor },
        transport: runtimeFetch,
        retentionJournal: journal,
        activation,
      })(input);
    };
  } catch {
    return disabledFactory();
  }
}

export type HermesRuntimeReadiness = Readonly<{
  ready: boolean;
  reason:
    | "ready"
    | "disabled"
    | "configuration-invalid"
    | "operational-gate-unavailable"
    | "retention-sweeper-not-ready"
    | "attestation-failed";
}>;

/**
 * Read-only activation probe for the consent surface. It verifies the pinned
 * files, signed bridge control contract, live zero-tool profile, and durable
 * retention journal without issuing a lease or creating a Hermes session.
 */
export async function probeHermesRuntimeReadinessFromEnvironment(
  environment: RuntimeEnvironment,
  runtimeFetch: typeof fetch = globalThis.fetch,
  options: Readonly<{
    verifyProfile?: (input: HermesProfileGateInput) => Promise<HermesProfileGateSnapshot>;
    assertProfileUnchanged?: (snapshot: HermesProfileGateSnapshot) => Promise<void>;
  }> = {},
): Promise<HermesRuntimeReadiness> {
  let config: HermesRuntimeConfig | { enabled: false };
  try {
    config = hermesRuntimeConfigFromEnvironment(environment);
  } catch {
    return { ready: false, reason: "configuration-invalid" };
  }
  if (!config.enabled) return { ready: false, reason: "disabled" };
  const activation = installedActivation;
  if (!activation) {
    return { ready: false, reason: "operational-gate-unavailable" };
  }
  if (!activation.retentionSweeper.status().ready) {
    return { ready: false, reason: "retention-sweeper-not-ready" };
  }
  try {
    const client = createHermesBridgeClient({
      controlOrigin: requiredEnvironment(environment, "PILOT_HERMES_BRIDGE_CONTROL_ORIGIN"),
      controlBearer: requiredEnvironment(environment, "PILOT_HERMES_BRIDGE_CONTROL_BEARER"),
      controlResponseKey: requiredEnvironment(
        environment,
        "PILOT_HERMES_BRIDGE_CONTROL_RESPONSE_KEY",
      ),
      profile: config.profile,
      provider: config.provider,
      model: config.model,
      profileInvariantsDigest: requiredEnvironment(
        environment,
        "PILOT_HERMES_PROFILE_INVARIANTS_SHA256",
      ),
      bridgeConfigDigest: requiredEnvironment(
        environment,
        "PILOT_HERMES_BRIDGE_CONFIG_SHA256",
      ),
    }, runtimeFetch);
    const verify = options.verifyProfile ?? verifyHermesProfileGate;
    const assertUnchanged = options.assertProfileUnchanged ??
      assertHermesProfileGateUnchanged;
    const snapshot = await verify(config.profileGate);
    await activation.assertImmutableProfile(snapshot);
    await client.attestReady();
    const readinessScope = Object.freeze({
      principalId: "pilot-hermes-readiness",
      tenantId: "pilot-hermes-readiness",
      channelId: "pilot-hermes-readiness",
    });
    const provider = createHermesProposalProvider({
      enabled: true,
      origin: config.origin,
      profile: config.profile,
      profileBinding: deriveHermesProfileBinding(readinessScope),
      apiKey: config.apiKey,
      model: config.model,
    }, readinessScope, runtimeFetch, { provider: config.provider });
    await provider.attest();
    await new HermesRetentionJournal(config.retentionStatePath).consent("0".repeat(64));
    await assertUnchanged(snapshot);
    await activation.assertImmutableProfile(snapshot);
    if (!activation.retentionSweeper.status().ready) {
      return { ready: false, reason: "retention-sweeper-not-ready" };
    }
    await client.attestReady();
    return { ready: true, reason: "ready" };
  } catch {
    return { ready: false, reason: "attestation-failed" };
  }
}
