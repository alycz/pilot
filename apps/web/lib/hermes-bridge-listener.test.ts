import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHermesBridgeListeners } from "./hermes-bridge-listener";
import {
  activateHermesBridgeServiceForTest,
  createHermesBridgeClient,
  createHermesBridgeService,
  digestHermesBridgeMessages,
  HERMES_BRIDGE_PROFILE_INVARIANTS,
  type HermesBridgeConfig,
} from "./hermes-bridge-service";
import { HERMES_PROPOSAL_SYSTEM_INSTRUCTIONS } from "@pilot/agent/hermes-transport";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  await new Promise<void>((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()));
  return address.port;
}

async function fixtureConfig(controlOrigin: string, ingressOrigin: string): Promise<HermesBridgeConfig> {
  const created = await mkdtemp(join(tmpdir(), "pilot-hermes-listener-"));
  await chmod(created, 0o700);
  const root = await realpath(created);
  roots.push(root);
  return {
    controlOrigin,
    ingressOrigin,
    controlBearer: "listener-control-bearer-000000000000001",
    controlResponseKey: "listener-response-key-0000000000000001",
    ingressBearer: "listener-ingress-bearer-000000000000001",
    upstreamUrl: "https://fixture.invalid/v1/chat/completions",
    upstreamCredential: "synthetic-listener-upstream",
    profile: "pilot-proposal-v1",
    provider: "fixture-provider",
    model: "fixture-model",
    tokenParameter: "max_tokens",
    outputTokens: 64,
    maxInputBytes: 8_192,
    maxMessages: 8,
    maxResponseBytes: 8_192,
    timeoutMs: 2_000,
    framingTokenAllowance: 32,
    inputMicrousdPerMillionTokens: 10_000,
    outputMicrousdPerMillionTokens: 100_000,
    maxCallMicrousd: 20,
    maxDailyMicrousd: 100,
    journalRoot: root,
    journalPath: join(root, "journal.json"),
    profileInvariants: HERMES_BRIDGE_PROFILE_INVARIANTS,
  };
}

describe("Hermes bridge loopback listeners", () => {
  it("lets only the two-port owner touch the journal", async () => {
    const controlOrigin = "http://127.0.0.1:28645";
    const ingressOrigin = "http://127.0.0.1:28644";
    const bridgeConfig = await fixtureConfig(controlOrigin, ingressOrigin);
    let firstAccesses = 0;
    let secondAccesses = 0;
    const firstService = await createHermesBridgeService(bridgeConfig, {
      onJournalAccess: () => { firstAccesses += 1; },
    });
    const secondService = await createHermesBridgeService(bridgeConfig, {
      onJournalAccess: () => { secondAccesses += 1; },
    });
    expect(firstAccesses).toBe(0);
    expect(secondAccesses).toBe(0);

    const claims = new Set<string>();
    const bind = async (_server: HttpServer, origin: URL) => {
      if (claims.has(origin.origin)) throw new Error("EADDRINUSE");
      claims.add(origin.origin);
      return async () => { claims.delete(origin.origin); };
    };
    const listenerConfig = {
      controlOrigin, ingressOrigin,
      maxControlBodyBytes: 8_192, maxIngressBodyBytes: 8_192,
    };
    const first = createHermesBridgeListeners(firstService, listenerConfig, { bind });
    const second = createHermesBridgeListeners(secondService, listenerConfig, { bind });
    const outcomes = await Promise.allSettled([first.start(), second.start()]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect([firstAccesses > 0, secondAccesses > 0].filter(Boolean)).toHaveLength(1);
    expect(firstAccesses === 0 || secondAccesses === 0).toBe(true);
    await (outcomes[0].status === "fulfilled" ? first : second).stop();
    expect(claims.size).toBe(0);
  });

  it("runs control-to-ingress once, propagates cancellation, and stops both ports", async () => {
    const controlOrigin = `http://127.0.0.1:${await freePort()}`;
    const ingressOrigin = `http://127.0.0.1:${await freePort()}`;
    let cancelObserved!: () => void;
    const sawCancel = new Promise<void>((resolvePromise) => { cancelObserved = resolvePromise; });
    let pendingStarted!: () => void;
    const started = new Promise<void>((resolvePromise) => { pendingStarted = resolvePromise; });
    let allowCancelledProviderToSettle!: () => void;
    const cancelledProviderMaySettle = new Promise<void>((resolvePromise) => { allowCancelledProviderToSettle = resolvePromise; });
    const upstream = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.messages.some((message: { content: string }) => message.content === "Cancel synthetic request")) {
        pendingStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            cancelObserved();
            void cancelledProviderMaySettle.then(() => reject(new Error("cancelled")));
          }, { once: true });
        });
      }
      return Response.json({
        choices: [{ message: { role: "assistant", content: "Synthetic response" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      });
    });
    const bridgeConfig = await fixtureConfig(controlOrigin, ingressOrigin);
    let ownerJournalAccesses = 0;
    const service = await createHermesBridgeService(bridgeConfig, {
      fetch: upstream as typeof fetch,
      onJournalAccess: () => { ownerJournalAccesses += 1; },
    });
    const listeners = createHermesBridgeListeners(service, {
      controlOrigin,
      ingressOrigin,
      maxControlBodyBytes: 8_192,
      maxIngressBodyBytes: 8_192,
    });
    await listeners.start();
    try {
      const bridgeClient = createHermesBridgeClient({
        controlOrigin,
        controlBearer: bridgeConfig.controlBearer,
        controlResponseKey: bridgeConfig.controlResponseKey,
        ...service.contract,
      });
      await expect(bridgeClient.attestReady()).resolves.toMatchObject({ status: "ready" });
      const first = await bridgeClient.authorize({
        scopeDigest: "a".repeat(64), userContent: "First synthetic request", sessionId: "listener_session_000001",
        messageDigest: digestHermesBridgeMessages([
          { role: "system", content: HERMES_PROPOSAL_SYSTEM_INSTRUCTIONS },
          { role: "user", content: "First synthetic request" },
        ]),
        profile: bridgeConfig.profile, provider: bridgeConfig.provider, model: bridgeConfig.model,
      });
      const response = await fetch(`${ingressOrigin}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${bridgeConfig.ingressBearer}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: first.leaseModel,
          messages: [{ role: "system", content: "Fixed" }, { role: "user", content: "First synthetic request" }],
          stream: false, tools: [], tool_choice: "none",
        }),
      });
      expect(response.status).toBe(200);

      const second = await bridgeClient.authorize({
        scopeDigest: "a".repeat(64), userContent: "Cancel synthetic request", sessionId: "listener_session_000002",
        messageDigest: digestHermesBridgeMessages([
          { role: "system", content: HERMES_PROPOSAL_SYSTEM_INSTRUCTIONS },
          { role: "user", content: "Cancel synthetic request" },
        ]),
        profile: bridgeConfig.profile, provider: bridgeConfig.provider, model: bridgeConfig.model,
      });
      const pending = fetch(`${ingressOrigin}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${bridgeConfig.ingressBearer}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: second.leaseModel,
          messages: [{ role: "user", content: "Cancel synthetic request" }],
          stream: false, tools: [], tool_choice: "none",
        }),
      });
      await started;
      const stopping = listeners.stop();
      await sawCancel;
      let contenderJournalAccesses = 0;
      const contenderService = await createHermesBridgeService(bridgeConfig, {
        onJournalAccess: () => { contenderJournalAccesses += 1; },
      });
      const contender = createHermesBridgeListeners(contenderService, {
        controlOrigin, ingressOrigin,
        maxControlBodyBytes: 8_192, maxIngressBodyBytes: 8_192,
      });
      await expect(contender.start()).rejects.toBeInstanceOf(Error);
      expect(contenderJournalAccesses).toBe(0);
      allowCancelledProviderToSettle();
      await expect(pending).resolves.toMatchObject({ status: 502 });
      await stopping;
      const accessesAfterStop = ownerJournalAccesses;
      await expect(service.usage("a".repeat(64))).rejects.toMatchObject({ code: "bridge_not_ready" });
      expect(ownerJournalAccesses).toBe(accessesAfterStop);

      const inspectionService = await createHermesBridgeService(bridgeConfig);
      await activateHermesBridgeServiceForTest(inspectionService);
      await expect(inspectionService.usage("a".repeat(64)))
        .resolves.toMatchObject({ attempts: 2, completed: 1, uncertain: 1 });
    } finally {
      await listeners.stop();
    }
    await expect(fetch(`${controlOrigin}/v1/status`)).rejects.toBeInstanceOf(Error);
  }, 15_000);
});
