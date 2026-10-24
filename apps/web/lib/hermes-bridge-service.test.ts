import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateHermesBridgeServiceForTest,
  createHermesBridgeClient,
  createHermesBridgeService,
  digestHermesBridgeMessages,
  digestHermesBridgeUserContent,
  HERMES_BRIDGE_PROFILE_INVARIANTS,
  HermesBridgeError,
  isHermesBridgeAuthorization,
  type HermesBridgeConfig,
  type HermesBridgeService,
} from "./hermes-bridge-service";
import { HERMES_PROPOSAL_SYSTEM_INSTRUCTIONS } from "@pilot/agent/hermes-transport";

const roots: string[] = [];
const CONTROL = "http://127.0.0.1:18645";
const INGRESS = "http://127.0.0.1:18644";
const PEER = { remoteAddress: "127.0.0.1" };
const CONTROL_BEARER = "control-fixture-bearer-0000000000000001";
const CONTROL_KEY = "control-response-key-00000000000000001";
const INGRESS_BEARER = "ingress-fixture-bearer-0000000000000001";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixtureRoot(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "pilot-hermes-bridge-"));
  await chmod(created, 0o700);
  const root = await realpath(created);
  roots.push(root);
  return root;
}

function completion(content = "A bounded proposal") {
  return Response.json({
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
  });
}

async function config(overrides: Partial<HermesBridgeConfig> = {}): Promise<HermesBridgeConfig> {
  const root = await fixtureRoot();
  return {
    controlOrigin: CONTROL,
    ingressOrigin: INGRESS,
    controlBearer: CONTROL_BEARER,
    controlResponseKey: CONTROL_KEY,
    ingressBearer: INGRESS_BEARER,
    upstreamUrl: "https://fixture.invalid/v1/chat/completions",
    upstreamCredential: "synthetic-upstream-credential",
    profile: "pilot-proposal-v1",
    provider: "fixture-provider",
    model: "fixture-model",
    tokenParameter: "max_tokens",
    outputTokens: 64,
    maxInputBytes: 8_192,
    maxMessages: 8,
    maxResponseBytes: 8_192,
    timeoutMs: 1_000,
    framingTokenAllowance: 32,
    inputMicrousdPerMillionTokens: 100_000,
    outputMicrousdPerMillionTokens: 200_000,
    maxCallMicrousd: 100,
    maxDailyMicrousd: 200,
    journalRoot: root,
    journalPath: join(root, "journal.json"),
    profileInvariants: HERMES_BRIDGE_PROFILE_INVARIANTS,
    ...overrides,
  };
}

function controlFetch(service: HermesBridgeService): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return service.handleControl(request, PEER);
  }) as typeof fetch;
}

function client(service: HermesBridgeService, now: () => number = Date.now) {
  return createHermesBridgeClient({
    controlOrigin: CONTROL,
    controlBearer: CONTROL_BEARER,
    controlResponseKey: CONTROL_KEY,
    ...service.contract,
  }, controlFetch(service), { now });
}

function ingress(leaseModel: string, messages: unknown, extra: Record<string, unknown> = {}) {
  return new Request(`${INGRESS}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${INGRESS_BEARER}`,
      "content-type": "application/json",
      host: new URL(INGRESS).host,
    },
    body: JSON.stringify({ model: leaseModel, messages, stream: false, tools: [], tool_choice: "none", ...extra }),
  });
}

async function authorization(service: HermesBridgeService, userContent = "Synthetic advice request") {
  return client(service).authorize({
    scopeDigest: "a".repeat(64),
    userContent,
    messageDigest: digestHermesBridgeMessages([
      { role: "system", content: HERMES_PROPOSAL_SYSTEM_INSTRUCTIONS },
      { role: "user", content: userContent },
    ]),
    sessionId: "session_fixture_00000001",
    profile: "pilot-proposal-v1",
    provider: "fixture-provider",
    model: "fixture-model",
  });
}

async function activatedService(
  bridgeConfig: HermesBridgeConfig,
  dependencies: Parameters<typeof createHermesBridgeService>[1] = {},
): Promise<HermesBridgeService> {
  const service = await createHermesBridgeService(bridgeConfig, dependencies);
  await activateHermesBridgeServiceForTest(service);
  return service;
}

describe("Hermes bridge durable one-call boundary", () => {
  it("attests readiness and brands an exact, signed authorization", async () => {
    const service = await activatedService(await config(), { fetch: vi.fn() });
    const bridgeClient = client(service);
    await expect(bridgeClient.attestReady()).resolves.toMatchObject({
      status: "ready",
      singleProcessPortOwnershipRequired: true,
      profile: "pilot-proposal-v1",
    });
    const authorized = await authorization(service);
    expect(isHermesBridgeAuthorization(authorized)).toBe(true);
    expect(authorized.userContentDigest).toBe(digestHermesBridgeUserContent("Synthetic advice request"));
    expect(authorized.bridgeConfigDigest).toBe(service.contract.bridgeConfigDigest);
  });

  it("binds one lease to one normalized Pilot provider envelope", async () => {
    let sent: Record<string, unknown> | undefined;
    const upstream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return completion();
    });
    const bridgeConfig = await config();
    const service = await activatedService(bridgeConfig, { fetch: upstream as typeof fetch });
    const authorized = await authorization(service);
    const receivedMessages = [
      { role: "system", content: "Untrusted Hermes layered prompt" },
      { role: "assistant", content: "Untrusted injected assistant history" },
      { role: "user", content: "Synthetic advice request" },
    ];
    const response = await service.handleIngress(ingress(authorized.leaseModel, receivedMessages), PEER);
    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(sent).toMatchObject({
      model: "fixture-model",
      max_tokens: 64,
      messages: [
        { role: "system", content: HERMES_PROPOSAL_SYSTEM_INSTRUCTIONS },
        { role: "user", content: "Synthetic advice request" },
      ],
    });
    expect(JSON.stringify(sent)).not.toContain("Untrusted Hermes layered prompt");
    expect(JSON.stringify(sent)).not.toContain("Untrusted injected assistant history");
    expect(sent).not.toHaveProperty("provider");
    await expect(service.handleIngress(ingress(authorized.leaseModel, receivedMessages), PEER))
      .rejects.toMatchObject({ code: "invalid_or_spent_lease", status: 409 });
    await expect(service.usage("a".repeat(64))).resolves.toMatchObject({ attempts: 1, completed: 1, uncertain: 0 });
    const stored = JSON.parse(await readFile(bridgeConfig.journalPath, "utf8"));
    expect(stored.records[0]).toMatchObject({
      state: "completed",
      userContentDigest: digestHermesBridgeUserContent("Synthetic advice request"),
      receivedMessagesDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("accepts the pinned Hermes v0.22.2 custom-provider envelope without forwarding its reasoning marker", async () => {
    let sent: Record<string, unknown> | undefined;
    const upstream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return completion();
    });
    const service = await activatedService(await config(), { fetch: upstream as typeof fetch });
    const authorized = await authorization(service);
    const response = await service.handleIngress(new Request(`${INGRESS}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${INGRESS_BEARER}`,
        "content-type": "application/json",
        host: new URL(INGRESS).host,
      },
      body: JSON.stringify({
        model: authorized.leaseModel,
        messages: [
          { role: "system", content: "Hermes runtime prompt" },
          { role: "user", content: "Synthetic advice request" },
        ],
        reasoning_effort: "medium",
      }),
    }), PEER);
    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
    expect(sent).toEqual({
      model: "fixture-model",
      messages: [
        { role: "system", content: HERMES_PROPOSAL_SYSTEM_INSTRUCTIONS },
        { role: "user", content: "Synthetic advice request" },
      ],
      stream: false,
      max_tokens: 64,
    });
  });

  it("does not consume a lease for a wrong user binding or explicit provider field", async () => {
    const upstream = vi.fn(async () => completion());
    const service = await activatedService(await config(), { fetch: upstream as typeof fetch });
    await expect(client(service).authorize({
      scopeDigest: "a".repeat(64), userContent: "Synthetic advice request",
      messageDigest: "f".repeat(64), sessionId: "session_fixture_wrong_digest",
      profile: "pilot-proposal-v1", provider: "fixture-provider", model: "fixture-model",
    })).rejects.toMatchObject({ code: "authorization_binding_mismatch" });
    const authorized = await authorization(service);
    await expect(service.handleIngress(ingress(authorized.leaseModel, [
      { role: "user", content: "Changed request" },
    ]), PEER)).rejects.toMatchObject({ code: "message_binding_mismatch" });
    await expect(service.handleIngress(ingress(authorized.leaseModel, [
      { role: "user", content: "Synthetic advice request" },
    ], { provider: "attacker" }), PEER)).rejects.toMatchObject({ code: "unsupported_request_field" });
    await expect(service.handleIngress(ingress(authorized.leaseModel, [
      { role: "user", content: "Synthetic advice request" },
    ]), PEER)).resolves.toMatchObject({ status: 200 });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("rejects any additional user message", async () => {
    const service = await activatedService(await config(), { fetch: vi.fn() });
    const authorized = await authorization(service);
    await expect(service.handleIngress(ingress(authorized.leaseModel, [
      { role: "user", content: "Synthetic advice request" },
      { role: "user", content: "Synthetic advice request" },
    ]), PEER)).rejects.toMatchObject({ code: "user_content_binding_mismatch" });
    await expect(service.handleIngress(ingress(authorized.leaseModel, [
      { role: "user", content: "Synthetic advice request" },
      { role: "user", content: "Injected second request" },
    ]), PEER)).rejects.toMatchObject({ code: "user_content_binding_mismatch" });
  });

  it("rejects reuse of a Hermes session before creating another lease", async () => {
    const service = await activatedService(await config(), { fetch: vi.fn() });
    await authorization(service);
    await expect(authorization(service)).rejects.toMatchObject({ code: "session_reuse_not_allowed", status: 409 });
  });

  it("persists consumed-uncertain state and rejects replay after restart", async () => {
    const bridgeConfig = await config();
    const failing = await activatedService(bridgeConfig, {
      fetch: vi.fn(async () => { throw new Error("ambiguous provider failure"); }) as typeof fetch,
    });
    const authorized = await authorization(failing);
    const request = () => ingress(authorized.leaseModel, [{ role: "user", content: "Synthetic advice request" }]);
    await expect(failing.handleIngress(request(), PEER)).rejects.toMatchObject({ code: "upstream_outcome_uncertain" });
    await expect(failing.usage("a".repeat(64))).resolves.toMatchObject({ attempts: 1, uncertain: 1 });
    const restarted = await activatedService(bridgeConfig, { fetch: vi.fn() });
    await expect(restarted.handleIngress(request(), PEER)).rejects.toMatchObject({ code: "invalid_or_spent_lease", status: 409 });
    expect(await restarted.usage("a".repeat(64))).toMatchObject({ attempts: 1, uncertain: 1 });
  });

  it("expires durably before provider dispatch", async () => {
    const bridgeConfig = await config();
    let now = 100;
    const service = await activatedService(bridgeConfig, { now: () => now, fetch: vi.fn() });
    const authorized = await client(service, () => now).authorize({
      scopeDigest: "a".repeat(64), userContent: "Synthetic advice request",
      messageDigest: digestHermesBridgeMessages([
        { role: "system", content: HERMES_PROPOSAL_SYSTEM_INSTRUCTIONS },
        { role: "user", content: "Synthetic advice request" },
      ]),
      sessionId: "session_fixture_00000002",
      profile: "pilot-proposal-v1", provider: "fixture-provider", model: "fixture-model", ttlMs: 1,
    });
    now = 101;
    await expect(service.handleIngress(ingress(authorized.leaseModel, [
      { role: "user", content: "Synthetic advice request" },
    ]), PEER)).rejects.toMatchObject({ code: "expired_lease" });
    const restarted = await activatedService(bridgeConfig, { now: () => now, fetch: vi.fn() });
    await expect(restarted.handleIngress(ingress(authorized.leaseModel, [
      { role: "user", content: "Synthetic advice request" },
    ]), PEER)).rejects.toMatchObject({ code: "expired_lease" });
  });

  it("invalidates an armed lease after any cost-relevant bridge configuration change", async () => {
    const bridgeConfig = await config();
    const first = await activatedService(bridgeConfig, { fetch: vi.fn() });
    const authorized = await authorization(first);
    const changed = await activatedService({ ...bridgeConfig, outputTokens: 32 }, { fetch: vi.fn() });
    await expect(changed.handleIngress(ingress(authorized.leaseModel, [
      { role: "user", content: "Synthetic advice request" },
    ]), PEER)).rejects.toMatchObject({ code: "lease_configuration_changed" });
  });

  it("keeps daily reservations durable and fail-closed", async () => {
    const bridgeConfig = await config({
      inputMicrousdPerMillionTokens: 1,
      outputMicrousdPerMillionTokens: 1,
      maxCallMicrousd: 2,
      maxDailyMicrousd: 2,
    });
    const upstream = vi.fn(async () => completion());
    const service = await activatedService(bridgeConfig, { fetch: upstream as typeof fetch });
    const first = await authorization(service, "First bounded request");
    await service.handleIngress(ingress(first.leaseModel, [{ role: "user", content: "First bounded request" }]), PEER);
    const second = await client(service).authorize({
      scopeDigest: "a".repeat(64), userContent: "Second bounded request", sessionId: "session_fixture_00000004",
      messageDigest: digestHermesBridgeMessages([
        { role: "system", content: HERMES_PROPOSAL_SYSTEM_INSTRUCTIONS },
        { role: "user", content: "Second bounded request" },
      ]),
      profile: "pilot-proposal-v1", provider: "fixture-provider", model: "fixture-model",
    });
    const restarted = await activatedService(bridgeConfig, { fetch: upstream as typeof fetch });
    await expect(restarted.handleIngress(ingress(second.leaseModel, [
      { role: "user", content: "Second bounded request" },
    ]), PEER)).rejects.toMatchObject({ code: "daily_cost_cap_exceeded", status: 402 });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("charges a pre-midnight lease to the UTC day of its provider attempt", async () => {
    const day = 86_400_000;
    let now = day - 10;
    const bridgeConfig = await config({
      inputMicrousdPerMillionTokens: 1,
      outputMicrousdPerMillionTokens: 1,
      maxCallMicrousd: 2,
      maxDailyMicrousd: 2,
    });
    const upstream = vi.fn(async () => completion());
    const service = await activatedService(bridgeConfig, { now: () => now, fetch: upstream as typeof fetch });
    const oldLease = await client(service, () => now).authorize({
      scopeDigest: "a".repeat(64), userContent: "Old lease", sessionId: "session_fixture_midnight_old",
      messageDigest: digestHermesBridgeMessages([
        { role: "system", content: HERMES_PROPOSAL_SYSTEM_INSTRUCTIONS },
        { role: "user", content: "Old lease" },
      ]),
      profile: bridgeConfig.profile, provider: bridgeConfig.provider, model: bridgeConfig.model,
    });
    now = day + 1;
    const currentLease = await client(service, () => now).authorize({
      scopeDigest: "a".repeat(64), userContent: "Current lease", sessionId: "session_fixture_midnight_new",
      messageDigest: digestHermesBridgeMessages([
        { role: "system", content: HERMES_PROPOSAL_SYSTEM_INSTRUCTIONS },
        { role: "user", content: "Current lease" },
      ]),
      profile: bridgeConfig.profile, provider: bridgeConfig.provider, model: bridgeConfig.model,
    });
    await service.handleIngress(ingress(currentLease.leaseModel, [{ role: "user", content: "Current lease" }]), PEER);
    await expect(service.handleIngress(ingress(oldLease.leaseModel, [{ role: "user", content: "Old lease" }]), PEER))
      .rejects.toMatchObject({ code: "daily_cost_cap_exceeded", status: 402 });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("rejects tools, streaming, and oversized upstream responses", async () => {
    const bridgeConfig = await config({ maxResponseBytes: 512 });
    const oversized = vi.fn(async () => new Response("x".repeat(513), {
      headers: { "content-length": "513", "content-type": "application/json" },
    }));
    const service = await activatedService(bridgeConfig, { fetch: oversized as typeof fetch });
    const authorized = await authorization(service);
    const base = [{ role: "user", content: "Synthetic advice request" }];
    await expect(service.handleIngress(ingress(authorized.leaseModel, base, { tools: [{ type: "function" }] }), PEER))
      .rejects.toMatchObject({ code: "tools_not_allowed" });
    await expect(service.handleIngress(ingress(authorized.leaseModel, base, { stream: true }), PEER))
      .rejects.toMatchObject({ code: "streaming_not_allowed" });
    await expect(service.handleIngress(ingress(authorized.leaseModel, base, { reasoning_effort: "high" }), PEER))
      .rejects.toMatchObject({ code: "unsupported_reasoning_effort" });
    await expect(service.handleIngress(ingress(authorized.leaseModel, base), PEER))
      .rejects.toMatchObject({ code: "response_too_large", status: 502 });
    await expect(service.usage("a".repeat(64))).resolves.toMatchObject({ uncertain: 1 });
  });

  it("enforces exact peer, host, bearer, path, and bounded body", async () => {
    const service = await activatedService(await config(), { fetch: vi.fn() });
    const authorized = await authorization(service);
    const validMessages = [{ role: "user", content: "Synthetic advice request" }];
    await expect(service.handleIngress(ingress(authorized.leaseModel, validMessages), { remoteAddress: "10.0.0.2" }))
      .rejects.toMatchObject({ code: "non_loopback_peer" });
    const wrongHost = ingress(authorized.leaseModel, validMessages);
    wrongHost.headers.set("host", "127.0.0.1:9999");
    await expect(service.handleIngress(wrongHost, PEER)).rejects.toMatchObject({ code: "invalid_endpoint" });
    const wrongBearer = ingress(authorized.leaseModel, validMessages);
    wrongBearer.headers.set("authorization", "Bearer wrong");
    await expect(service.handleIngress(wrongBearer, PEER)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("propagates caller cancellation through the client", async () => {
    const controller = new AbortController();
    const waiting = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
    const bridgeClient = createHermesBridgeClient({
      controlOrigin: CONTROL, controlBearer: CONTROL_BEARER, controlResponseKey: CONTROL_KEY,
      profile: "pilot-proposal-v1", provider: "fixture-provider", model: "fixture-model",
      profileInvariantsDigest: "b".repeat(64), bridgeConfigDigest: "c".repeat(64),
    }, waiting);
    const pending = bridgeClient.authorize({
      scopeDigest: "a".repeat(64), userContent: "Synthetic advice request",
      messageDigest: digestHermesBridgeMessages([
        { role: "system", content: HERMES_PROPOSAL_SYSTEM_INSTRUCTIONS },
        { role: "user", content: "Synthetic advice request" },
      ]),
      sessionId: "session_fixture_00000003",
      profile: "pilot-proposal-v1", provider: "fixture-provider", model: "fixture-model",
    }, controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
  });

  it("bounds a stalled control peer even without a caller signal", async () => {
    const waiting = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
    const bridgeClient = createHermesBridgeClient({
      controlOrigin: CONTROL, controlBearer: CONTROL_BEARER, controlResponseKey: CONTROL_KEY,
      profile: "pilot-proposal-v1", provider: "fixture-provider", model: "fixture-model",
      profileInvariantsDigest: "b".repeat(64), bridgeConfigDigest: "c".repeat(64),
    }, waiting, { controlTimeoutMs: 100 });
    await expect(bridgeClient.attestReady()).rejects.toBeInstanceOf(Error);
    expect(waiting).toHaveBeenCalledTimes(1);
  });

  it("rejects symlink and oversized journals before reading them", async () => {
    const unsafe = await config();
    const target = join(unsafe.journalRoot, "target.json");
    await writeFile(target, JSON.stringify({ version: 1, records: [] }), { mode: 0o600 });
    await symlink(target, unsafe.journalPath);
    const unsafeService = await createHermesBridgeService(unsafe);
    await expect(activateHermesBridgeServiceForTest(unsafeService)).rejects.toMatchObject({ code: "unsafe_journal_file" });

    const oversized = await config();
    await writeFile(oversized.journalPath, "x".repeat(2 * 1024 * 1024 + 1), { mode: 0o600 });
    const oversizedService = await createHermesBridgeService(oversized);
    await expect(activateHermesBridgeServiceForTest(oversizedService)).rejects.toMatchObject({ code: "unsafe_journal_file" });
  });

  it("rejects a private journal root beneath a non-sticky writable ancestor", async () => {
    const outerCreated = await mkdtemp(join(tmpdir(), "pilot-hermes-unsafe-ancestor-"));
    const outer = await realpath(outerCreated);
    roots.push(outer);
    const nested = join(outer, "private");
    await mkdir(nested, { mode: 0o700 });
    await chmod(outer, 0o777);
    const bridgeConfig = await config({ journalRoot: nested, journalPath: join(nested, "journal.json") });
    const service = await createHermesBridgeService(bridgeConfig);
    await expect(activateHermesBridgeServiceForTest(service))
      .rejects.toMatchObject({ code: "unsafe_journal_ancestor" });
  });

  it("inspects native ACLs across every journal ancestor and rejects a granting ancestor", async () => {
    const safeConfig = await config();
    const inspected: string[] = [];
    const safeService = await createHermesBridgeService(safeConfig, {
      macAclInspectorForTest(target) { inspected.push(target); },
    });
    await expect(activateHermesBridgeServiceForTest(safeService)).resolves.toBeUndefined();
    expect(inspected).toContain(safeConfig.journalRoot);
    expect(inspected).toContain(dirname(safeConfig.journalRoot));
    expect(inspected[0]).toBe("/");

    const grantingConfig = await config();
    const grantingAncestor = dirname(grantingConfig.journalRoot);
    const grantingService = await createHermesBridgeService(grantingConfig, {
      macAclInspectorForTest(target) {
        if (target === grantingAncestor) throw new Error("ACCESS_GRANTING");
      },
    });
    await expect(activateHermesBridgeServiceForTest(grantingService))
      .rejects.toMatchObject({ code: "unsafe_journal_acl" });
  });

  it("rejects malformed journal keys and profile contracts", async () => {
    const malformed = await config();
    await writeFile(malformed.journalPath, JSON.stringify({ version: 1, records: [], extra: true }), { mode: 0o600 });
    const malformedService = await createHermesBridgeService(malformed);
    await expect(activateHermesBridgeServiceForTest(malformedService)).rejects.toMatchObject({ code: "corrupt_journal" });
    const invalid = await config({
      profileInvariants: { ...HERMES_BRIDGE_PROFILE_INVARIANTS, maxTurns: 2 } as unknown as typeof HERMES_BRIDGE_PROFILE_INVARIANTS,
    });
    await expect(createHermesBridgeService(invalid)).rejects.toBeInstanceOf(HermesBridgeError);
    for (const duplicate of [
      { upstreamCredential: CONTROL_BEARER },
      { ingressBearer: CONTROL_BEARER },
      { controlResponseKey: CONTROL_BEARER },
      { upstreamCredential: INGRESS_BEARER },
    ]) {
      await expect(createHermesBridgeService(await config(duplicate)))
        .rejects.toMatchObject({ code: "invalid_configuration" });
    }
  });
});
