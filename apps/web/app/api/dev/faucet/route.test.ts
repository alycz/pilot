import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFaucetHandler,
  type FaucetDependencies,
  type FaucetDispatchStore,
} from "./handler";
import type {
  AcquisitionState,
  AcquisitionStateStore,
} from "../rlusd-acquisition/handler";

const ADDRESS = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const OPERATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const SESSION_SECRET = "faucet-dispatch-test-secret-at-least-thirty-two-characters";
const temporaryDirectories: string[] = [];

class MemoryDispatchStore implements FaucetDispatchStore {
  readonly markers = new Map<string, {
    attempt: number;
    state: "dispatched" | "rate_limited_until";
    retryAtMs?: number;
  }>();
  readonly events: string[] = [];
  ready = true;

  async assertReady(): Promise<void> {
    if (!this.ready) throw new Error("state unavailable");
  }

  async claim(
    network: "testnet",
    owner: string,
    operationId: string,
    nowMs: number,
  ) {
    const key = `${network}:${owner}:${operationId}`;
    this.events.push(`claim:${key}`);
    const marker = this.markers.get(key);
    if (!marker) {
      this.markers.set(key, { attempt: 1, state: "dispatched" });
      return { status: "claimed" as const, attempt: 1 };
    }
    if (marker.state === "dispatched") return { status: "dispatched" as const };
    if (marker.retryAtMs! > nowMs) {
      return {
        status: "rate_limited" as const,
        retryAfterSeconds: Math.max(1, Math.ceil((marker.retryAtMs! - nowMs) / 1_000)),
      };
    }
    if (marker.attempt >= 3) return { status: "exhausted" as const };
    const attempt = marker.attempt + 1;
    this.markers.set(key, { attempt, state: "dispatched" });
    return { status: "claimed" as const, attempt };
  }

  async recordRateLimit(
    network: "testnet",
    owner: string,
    operationId: string,
    attempt: number,
    retryAtMs: number,
  ): Promise<void> {
    const key = `${network}:${owner}:${operationId}`;
    const marker = this.markers.get(key);
    if (!marker || marker.state !== "dispatched" || marker.attempt !== attempt) {
      throw new Error("invalid rate-limit transition");
    }
    this.markers.set(key, {
      attempt,
      state: "rate_limited_until",
      retryAtMs,
    });
  }
}

class MemoryAcquisitionStateStore implements Pick<
  AcquisitionStateStore,
  "assertReady" | "load" | "withOwnerLock"
> {
  ready = true;
  state: AcquisitionState | undefined = {
    version: 1,
    operation_id: OPERATION_ID,
    owner: ADDRESS,
    network: "testnet",
    status: "initializing",
    intent_id: `p-live-acquire-rlusd-${OPERATION_ID}`,
    created_at: "2026-10-19T00:00:00.000Z",
    updated_at: "2026-10-19T00:00:00.000Z",
  };
  private tail = Promise.resolve();

  async assertReady(): Promise<void> {
    if (!this.ready) throw new Error("state unavailable");
  }

  async load(owner: string): Promise<AcquisitionState | undefined> {
    return this.state?.owner === owner ? structuredClone(this.state) : undefined;
  }

  async withOwnerLock<T>(_owner: string, callback: () => Promise<T>): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      return await callback();
    } finally {
      release();
    }
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function request(
  body: unknown,
  url = "http://127.0.0.1:3003/api/dev/faucet",
  origin = "http://127.0.0.1:3003",
  additionalHeaders: HeadersInit = {},
) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: new URL(url).host,
      origin,
      ...additionalHeaders,
    },
    body: JSON.stringify(body),
  });
}

function harness(
  exists = false,
  balances: string[] = [],
  dispatchStore = new MemoryDispatchStore(),
  now = () => 1_000,
  acquisitionStateStore = new MemoryAcquisitionStateStore(),
  environment: Record<string, string | undefined> = {
    EXEC_NETWORK: "testnet",
    HARBOR_MOCK: "0",
    NEXT_PUBLIC_DEV_SIGNER: "1",
    PILOT_DEPLOYMENT_PROFILE: "local-wallet",
    NODE_ENV: "development",
  },
) {
  const fetch = vi.fn(async () => {
    dispatchStore.events.push("fetch");
    return new Response("{}", { status: 200 });
  });
  let balanceRead = 0;
  const dependencies: FaucetDependencies = {
    acquisitionStateStore,
    authorize: () => true,
    fetch: fetch as unknown as typeof globalThis.fetch,
    isValidAddress: (value) => value === ADDRESS,
    environment,
    now,
    sleep: vi.fn(async () => undefined),
    createClient: () => ({
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      request: vi.fn(async () => {
        if (exists || balances.length > 0) {
          const balance = balances[Math.min(balanceRead, balances.length - 1)] ?? "100000000";
          balanceRead += 1;
          return {
            result: {
              validated: true,
              account_data: { Account: ADDRESS, Balance: balance },
            },
          } as never;
        }
        throw { data: { error: "actNotFound" } };
      }),
    }),
    dispatchStore,
  };
  return { handler: createFaucetHandler(dependencies), fetch, dispatchStore };
}

function fileBackedHandler(
  directory: string,
  fetch: typeof globalThis.fetch,
  now = () => 1_000,
  acquisitionStateStore = new MemoryAcquisitionStateStore(),
  profile: "legacy" | "isolated" = "legacy",
) {
  return createFaucetHandler({
    acquisitionStateStore,
    authorize: () => true,
    fetch,
    isValidAddress: (value) => value === ADDRESS,
    environment: {
      EXEC_NETWORK: "testnet",
      HARBOR_MOCK: "0",
      NEXT_PUBLIC_DEV_SIGNER: "1",
      PILOT_DEPLOYMENT_PROFILE: profile === "isolated"
        ? "local-wallet-isolated-v1"
        : "local-wallet",
      ...(profile === "isolated" ? {
        NEXT_PUBLIC_PILOT_BUILD_MARKER: "pilot-local-wallet-isolated-v1",
      } : {}),
      P_LIVE_RLUSD_ACQUISITION_STATE_DIR: directory,
      SESSION_SECRET,
    },
    now,
    sleep: async () => undefined,
    createClient: () => ({
      connect: async () => undefined,
      disconnect: async () => undefined,
      request: async () => ({
        result: {
          validated: true,
          account_data: { Account: ADDRESS, Balance: "100000000" },
        },
      }) as never,
    }),
  });
}

describe("POST /api/dev/faucet", () => {
  it("requires authorization before checking the ledger or faucet", async () => {
    const { fetch } = harness();
    const handler = createFaucetHandler({
      authorize: () => false,
      fetch: fetch as unknown as typeof globalThis.fetch,
      isValidAddress: () => true,
      createClient: () => {
        throw new Error("must not create client");
      },
    });

    const response = await handler(request({ address: ADDRESS, network: "testnet" }));

    expect(response.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects mainnet before any faucet call", async () => {
    const { handler, fetch } = harness();
    const response = await handler(request({ address: ADDRESS, network: "mainnet" }));
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requests activation from the fixed testnet faucet without secret fields", async () => {
    const { handler, fetch, dispatchStore } = harness();
    const response = await handler(request({ address: ADDRESS, network: "testnet" }));
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledWith(
      "https://faucet.altnet.rippletest.net/accounts",
      expect.objectContaining({ body: JSON.stringify({ destination: ADDRESS }) }),
    );
    expect(await response.json()).toEqual({
      address: ADDRESS,
      network: "testnet",
      funded: true,
      alreadySufficient: false,
    });
    expect(dispatchStore.events).toEqual(["fetch"]);
  });

  it("allows the exact isolated profile while rejecting old/new cross-slot requests", async () => {
    const isolatedEnvironment = {
      EXEC_NETWORK: "testnet",
      HARBOR_MOCK: "0",
      NEXT_PUBLIC_DEV_SIGNER: "1",
      NEXT_PUBLIC_PILOT_BUILD_MARKER: "pilot-local-wallet-isolated-v1",
      PILOT_DEPLOYMENT_PROFILE: "local-wallet-isolated-v1",
      NODE_ENV: "development",
    };
    const isolated = harness(
      false,
      ["100000000", "300000000"],
      undefined,
      undefined,
      undefined,
      isolatedEnvironment,
    );
    const accepted = await isolated.handler(request(
      {
        address: ADDRESS,
        network: "testnet",
        purpose: "rlusd-acquisition",
        operation_id: OPERATION_ID,
      },
      "http://127.0.0.2:3003/api/dev/faucet",
      "http://127.0.0.2:3003",
    ));
    expect(accepted.status).toBe(200);
    expect(isolated.fetch).toHaveBeenCalledTimes(1);

    const crossed = harness(false, [], undefined, undefined, undefined, isolatedEnvironment);
    const rejected = await crossed.handler(request(
      {
        address: ADDRESS,
        network: "testnet",
        purpose: "rlusd-acquisition",
        operation_id: OPERATION_ID,
      },
      "http://127.0.0.1:3003/api/dev/faucet",
      "http://127.0.0.1:3003",
    ));
    expect(rejected.status).toBe(403);
    expect(crossed.fetch).not.toHaveBeenCalled();
  });

  it("does not call the faucet for an already active account", async () => {
    const { handler, fetch } = harness(true);
    const response = await handler(request({ address: ADDRESS, network: "devnet" }));
    expect(response.status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
    expect((await response.json()).alreadySufficient).toBe(true);
  });

  it("rejects extra fields", async () => {
    const { handler, fetch } = harness();
    const response = await handler(request({ address: ADDRESS, network: "testnet", seed: "never" }));
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requests exactly 300 test XRP once for the fixed RLUSD acquisition headroom", async () => {
    const { handler, fetch, dispatchStore } = harness(
      false,
      ["100000000", "300000000"],
    );

    const response = await handler(request({
      address: ADDRESS,
      network: "testnet",
      purpose: "rlusd-acquisition",
      operation_id: OPERATION_ID,
    }));

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(dispatchStore.events).toEqual([
      `claim:testnet:${ADDRESS}:${OPERATION_ID}`,
      "fetch",
    ]);
    expect(fetch).toHaveBeenCalledWith(
      "https://faucet.altnet.rippletest.net/accounts",
      expect.objectContaining({
        body: JSON.stringify({ destination: ADDRESS, xrpAmount: "300" }),
        redirect: "error",
      }),
    );
    expect(await response.json()).toEqual({
      address: ADDRESS,
      network: "testnet",
      funded: true,
      alreadySufficient: false,
      balanceDrops: "300000000",
      requiredDrops: "295000100",
    });
  });

  it("rejects a caller-chosen acquisition operation before any ledger read or faucet dispatch", async () => {
    const acquisitionStateStore = new MemoryAcquisitionStateStore();
    const dispatchStore = new MemoryDispatchStore();
    const { handler, fetch } = harness(
      false,
      ["100000000"],
      dispatchStore,
      () => 1_000,
      acquisitionStateStore,
    );

    const response = await handler(request({
      address: ADDRESS,
      network: "testnet",
      purpose: "rlusd-acquisition",
      operation_id: "223e4567-e89b-42d3-a456-426614174001",
    }));

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("ACQUISITION_OPERATION_NOT_AUTHORIZED");
    expect(dispatchStore.events).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects non-canonical operation-id case before durable marker lookup", async () => {
    const { handler, fetch, dispatchStore } = harness(false, ["100000000"]);
    const response = await handler(request({
      address: ADDRESS,
      network: "testnet",
      purpose: "rlusd-acquisition",
      operation_id: OPERATION_ID.toUpperCase(),
    }));

    expect(response.status).toBe(400);
    expect(dispatchStore.events).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects faucet dispatch after the server-owned acquisition leaves its initial phase", async () => {
    const acquisitionStateStore = new MemoryAcquisitionStateStore();
    acquisitionStateStore.state = {
      ...acquisitionStateStore.state!,
      status: "built",
    };
    const dispatchStore = new MemoryDispatchStore();
    const { handler, fetch } = harness(
      false,
      ["100000000"],
      dispatchStore,
      () => 1_000,
      acquisitionStateStore,
    );

    const response = await handler(request({
      address: ADDRESS,
      network: "testnet",
      purpose: "rlusd-acquisition",
      operation_id: OPERATION_ID,
    }));

    expect(response.status).toBe(409);
    expect(dispatchStore.events).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a new operation identity after restart even with a fresh dispatch store", async () => {
    const acquisitionStateStore = new MemoryAcquisitionStateStore();
    const first = harness(
      false,
      Array(10).fill("100000000"),
      new MemoryDispatchStore(),
      () => 1_000,
      acquisitionStateStore,
    );
    const firstResponse = await first.handler(request({
      address: ADDRESS,
      network: "testnet",
      purpose: "rlusd-acquisition",
      operation_id: OPERATION_ID,
    }));
    expect(firstResponse.status).toBe(202);
    expect(first.fetch).toHaveBeenCalledTimes(1);

    const restarted = harness(
      false,
      ["100000000"],
      new MemoryDispatchStore(),
      () => 2_000,
      acquisitionStateStore,
    );
    const replay = await restarted.handler(request({
      address: ADDRESS,
      network: "testnet",
      purpose: "rlusd-acquisition",
      operation_id: "223e4567-e89b-42d3-a456-426614174001",
    }));

    expect(replay.status).toBe(409);
    expect(restarted.fetch).not.toHaveBeenCalled();
    expect(restarted.dispatchStore.events).toEqual([]);
  });

  it("does not call the faucet when validated acquisition headroom already exists", async () => {
    const { handler, fetch } = harness(false, ["295000100"]);
    const response = await handler(request({
      address: ADDRESS,
      network: "testnet",
      purpose: "rlusd-acquisition",
      operation_id: "123e4567-e89b-42d3-a456-426614174000",
    }));

    expect(response.status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
    expect((await response.json()).alreadySufficient).toBe(true);
  });

  it.each<Record<string, string>>([
    { forwarded: "for=127.0.0.1,for=203.0.113.7" },
    { "x-forwarded-host": "127.0.0.1:3003,pilot.example" },
    { "x-forwarded-proto": "http,https" },
    { "x-forwarded-port": "3003,443" },
  ])("rejects ambiguous local forwarding metadata before ledger or faucet access: %o", async (headers) => {
    const { handler, fetch } = harness();
    const response = await handler(request({
      address: ADDRESS,
      network: "testnet",
      purpose: "rlusd-acquisition",
      operation_id: "123e4567-e89b-42d3-a456-426614174000",
    }, undefined, undefined, headers));
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["mock mode", { NODE_ENV: "development", EXEC_NETWORK: "testnet", HARBOR_MOCK: "1", NEXT_PUBLIC_DEV_SIGNER: "1" }, "http://localhost/api/dev/faucet", "http://localhost"],
    ["non-loopback host", { NODE_ENV: "development", EXEC_NETWORK: "testnet", HARBOR_MOCK: "0", NEXT_PUBLIC_DEV_SIGNER: "1" }, "https://pilot.example/api/dev/faucet", "https://pilot.example"],
    ["foreign origin", { NODE_ENV: "development", EXEC_NETWORK: "testnet", HARBOR_MOCK: "0", NEXT_PUBLIC_DEV_SIGNER: "1" }, "http://localhost/api/dev/faucet", "https://evil.example"],
  ] as const)("rejects acquisition in %s before ledger or faucet access", async (_label, environment, url, origin) => {
    const fetch = vi.fn();
    const handler = createFaucetHandler({
      authorize: () => true,
      environment,
      fetch: fetch as unknown as typeof globalThis.fetch,
      isValidAddress: () => true,
      createClient: () => { throw new Error("must not create client"); },
    });

    const response = await handler(request({
      address: ADDRESS,
      network: "testnet",
      purpose: "rlusd-acquisition",
      operation_id: "123e4567-e89b-42d3-a456-426614174000",
    }, url, origin));

    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves an over-maximum upstream Retry-After instead of retrying at the local maximum", async () => {
    const clock = { now: 1_000 };
    const { handler, fetch } = harness(
      false,
      Array(20).fill("100000000"),
      new MemoryDispatchStore(),
      () => clock.now,
    );
    fetch.mockResolvedValueOnce(new Response("private upstream detail", {
      status: 429,
      headers: { "retry-after": "99999" },
    }));
    const response = await handler(request({
      address: ADDRESS,
      network: "testnet",
      purpose: "rlusd-acquisition",
      operation_id: "123e4567-e89b-42d3-a456-426614174000",
    }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("99999");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await response.json())).not.toContain("private upstream detail");

    clock.now = 3_601_000;
    const atLocalMaximum = await handler(request({
      address: ADDRESS,
      network: "testnet",
      purpose: "rlusd-acquisition",
      operation_id: OPERATION_ID,
    }));
    expect(atLocalMaximum.status).toBe(429);
    expect(atLocalMaximum.headers.get("retry-after")).toBe("96399");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("honors an HTTP-date Retry-After using the upstream clock when the local clock is ahead", async () => {
    const serverNow = Date.UTC(2026, 9, 19, 0, 0, 0);
    const clock = { now: serverNow + 5 * 60_000 };
    const h = harness(
      false,
      Array(20).fill("100000000"),
      new MemoryDispatchStore(),
      () => clock.now,
    );
    h.fetch.mockResolvedValueOnce(new Response("rate limited", {
      status: 429,
      headers: {
        date: new Date(serverNow).toUTCString(),
        "retry-after": new Date(serverNow + 120_000).toUTCString(),
      },
    }));

    const operation = {
      address: ADDRESS,
      network: "testnet",
      purpose: "rlusd-acquisition",
      operation_id: OPERATION_ID,
    };
    const first = await h.handler(request(operation));
    expect(first.status).toBe(429);
    expect(first.headers.get("retry-after")).toBe("120");

    clock.now += 119_000;
    const early = await h.handler(request(operation));
    expect(early.status).toBe(429);
    expect(early.headers.get("retry-after")).toBe("1");
    expect(h.fetch).toHaveBeenCalledTimes(1);

    clock.now += 1_001;
    const afterExpiry = await h.handler(request(operation));
    expect(afterExpiry.status).toBe(202);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("uses a conservative delay for an invalid Retry-After header", async () => {
    const clock = { now: 1_000 };
    const h = harness(
      false,
      Array(20).fill("100000000"),
      new MemoryDispatchStore(),
      () => clock.now,
    );
    h.fetch.mockResolvedValueOnce(new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "2 seconds" },
    }));
    const operation = {
      address: ADDRESS,
      network: "testnet",
      purpose: "rlusd-acquisition",
      operation_id: OPERATION_ID,
    };

    const first = await h.handler(request(operation));
    expect(first.status).toBe(429);
    expect(first.headers.get("retry-after")).toBe("60");

    clock.now += 59_999;
    const early = await h.handler(request(operation));
    expect(early.status).toBe(429);
    expect(early.headers.get("retry-after")).toBe("1");
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("uses a conservative delay for an upstream-past HTTP-date", async () => {
    const serverNow = Date.UTC(2026, 9, 19, 0, 0, 0);
    const clock = { now: serverNow };
    const h = harness(
      false,
      Array(20).fill("100000000"),
      new MemoryDispatchStore(),
      () => clock.now,
    );
    h.fetch.mockResolvedValueOnce(new Response("rate limited", {
      status: 429,
      headers: {
        date: new Date(serverNow).toUTCString(),
        "retry-after": new Date(serverNow - 60_000).toUTCString(),
      },
    }));

    const first = await h.handler(request({
      address: ADDRESS,
      network: "testnet",
      purpose: "rlusd-acquisition",
      operation_id: OPERATION_ID,
    }));
    expect(first.status).toBe(429);
    expect(first.headers.get("retry-after")).toBe("60");
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("retries a definite 429 once after Retry-After in the same handler", async () => {
    const operation = {
      address: ADDRESS,
      network: "testnet",
      purpose: "rlusd-acquisition",
      operation_id: OPERATION_ID,
    };
    const clock = { now: 1_000 };
    const h = harness(
      false,
      Array(20).fill("100000000"),
      new MemoryDispatchStore(),
      () => clock.now,
    );
    h.fetch.mockResolvedValueOnce(new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "2" },
    }));

    const first = await h.handler(request(operation));
    const beforeExpiry = await h.handler(request(operation));
    expect(first.status).toBe(429);
    expect(beforeExpiry.status).toBe(429);
    expect(beforeExpiry.headers.get("retry-after")).toBe("2");
    expect(h.fetch).toHaveBeenCalledTimes(1);

    clock.now = 3_001;
    const afterExpiry = await h.handler(request(operation));
    const afterDispatch = await h.handler(request(operation));

    expect(afterExpiry.status).toBe(202);
    expect(afterDispatch.status).toBe(202);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("persists Retry-After across restarts and permits one concurrent retry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-faucet-rate-limit-"));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o700);
    const operation = {
      address: ADDRESS,
      network: "testnet",
      purpose: "rlusd-acquisition",
      operation_id: OPERATION_ID,
    };
    const firstFetch = vi.fn(async () => new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "2" },
    }));
    const first = await fileBackedHandler(
      directory,
      firstFetch as unknown as typeof globalThis.fetch,
      () => 1_000,
    )(request(operation));
    expect(first.status).toBe(429);
    expect(firstFetch).toHaveBeenCalledTimes(1);

    const earlyFetch = vi.fn();
    const beforeExpiry = await fileBackedHandler(
      directory,
      earlyFetch as unknown as typeof globalThis.fetch,
      () => 2_000,
    )(request(operation));
    expect(beforeExpiry.status).toBe(429);
    expect(beforeExpiry.headers.get("retry-after")).toBe("1");
    expect(earlyFetch).not.toHaveBeenCalled();

    const retryFetchA = vi.fn(async () => new Response("{}", { status: 200 }));
    const retryFetchB = vi.fn(async () => new Response("{}", { status: 200 }));
    const retryA = fileBackedHandler(
      directory,
      retryFetchA as unknown as typeof globalThis.fetch,
      () => 3_001,
    );
    const retryB = fileBackedHandler(
      directory,
      retryFetchB as unknown as typeof globalThis.fetch,
      () => 3_001,
    );
    const results = await Promise.all([
      retryA(request(operation)),
      retryB(request(operation)),
    ]);

    expect(results.map((response) => response.status)).toEqual([202, 202]);
    expect(retryFetchA.mock.calls.length + retryFetchB.mock.calls.length).toBe(1);
    expect(await readdir(directory)).toEqual(expect.arrayContaining([
      expect.stringMatching(/\.faucet\.json\.retry-2$/),
    ]));

    // The append-only attempt witness remains after the winner returns, so a
    // delayed process cannot recreate the same claim from a stale marker read.
    const lateFetch = vi.fn();
    const late = await fileBackedHandler(
      directory,
      lateFetch as unknown as typeof globalThis.fetch,
      () => 3_001,
    )(request(operation));
    expect(late.status).toBe(202);
    expect(lateFetch).not.toHaveBeenCalled();
  });

  it("rechecks validated balance but never redispatches the same acquisition operation", async () => {
    const operation = {
      address: ADDRESS,
      network: "testnet",
      purpose: "rlusd-acquisition",
      operation_id: "123e4567-e89b-42d3-a456-426614174000",
    };
    const { handler, fetch } = harness(false, Array(20).fill("100000000"));

    const first = await handler(request(operation));
    const second = await handler(request(operation));

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await second.json()).toMatchObject({ funded: false, pending: true });
  });

  it("persists and enforces a bounded rate-limit retry budget across restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-faucet-budget-"));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o700);
    const operation = {
      address: ADDRESS,
      network: "testnet",
      purpose: "rlusd-acquisition",
      operation_id: OPERATION_ID,
    };
    const acquisitionStateStore = new MemoryAcquisitionStateStore();
    const calls: Array<ReturnType<typeof vi.fn>> = [];

    for (const now of [1_000, 2_001, 3_002]) {
      const fetch = vi.fn(async () => new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "1" },
      }));
      calls.push(fetch);
      const response = await fileBackedHandler(
        directory,
        fetch as unknown as typeof globalThis.fetch,
        () => now,
        acquisitionStateStore,
      )(request(operation));
      expect(response.status).toBe(429);
      expect(fetch).toHaveBeenCalledTimes(1);
    }

    const exhaustedFetch = vi.fn();
    const exhausted = await fileBackedHandler(
      directory,
      exhaustedFetch as unknown as typeof globalThis.fetch,
      () => 4_003,
      acquisitionStateStore,
    )(request(operation));

    expect(exhausted.status).toBe(409);
    expect((await exhausted.json()).error.code).toBe("FAUCET_RETRY_EXHAUSTED");
    expect(exhaustedFetch).not.toHaveBeenCalled();
    expect(calls.reduce((total, call) => total + call.mock.calls.length, 0)).toBe(3);
  });

  it("does not redispatch after a handler restart", async () => {
    const operation = {
      address: ADDRESS,
      network: "testnet",
      purpose: "rlusd-acquisition",
      operation_id: OPERATION_ID,
    };
    const store = new MemoryDispatchStore();
    const first = harness(false, Array(10).fill("100000000"), store);
    const firstResponse = await first.handler(request(operation));
    expect(firstResponse.status).toBe(202);
    expect(first.fetch).toHaveBeenCalledTimes(1);

    const restarted = harness(false, ["100000000"], store);
    const restartedResponse = await restarted.handler(request(operation));

    expect(restartedResponse.status).toBe(202);
    expect(restarted.fetch).not.toHaveBeenCalled();
    expect(await restartedResponse.json()).toMatchObject({
      funded: false,
      pending: true,
    });
  });

  it("retains the dispatch marker across an ambiguous upstream 5xx", async () => {
    const operation = {
      address: ADDRESS,
      network: "testnet",
      purpose: "rlusd-acquisition",
      operation_id: OPERATION_ID,
    };
    const store = new MemoryDispatchStore();
    const first = harness(false, ["100000000"], store);
    first.fetch.mockResolvedValueOnce(new Response("ambiguous", { status: 503 }));

    const firstResponse = await first.handler(request(operation));
    expect(firstResponse.status).toBe(502);
    expect(first.fetch).toHaveBeenCalledTimes(1);

    const restarted = harness(false, ["100000000"], store);
    const restartedResponse = await restarted.handler(request(operation));

    expect(restartedResponse.status).toBe(202);
    expect(restarted.fetch).not.toHaveBeenCalled();
  });

  it("retains the dispatch marker when the upstream request throws", async () => {
    const operation = {
      address: ADDRESS,
      network: "testnet",
      purpose: "rlusd-acquisition",
      operation_id: OPERATION_ID,
    };
    const store = new MemoryDispatchStore();
    const first = harness(false, ["100000000"], store);
    first.fetch.mockRejectedValueOnce(new Error("ambiguous transport failure"));

    const firstResponse = await first.handler(request(operation));
    expect(firstResponse.status).toBe(502);

    const restarted = harness(false, ["100000000"], store);
    const restartedResponse = await restarted.handler(request(operation));
    expect(restartedResponse.status).toBe(202);
    expect(restarted.fetch).not.toHaveBeenCalled();
  });

  it("durably publishes a mode-0600 HMAC marker before restart recovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-faucet-dispatch-"));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o700);
    const firstFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const operation = {
      address: ADDRESS,
      network: "testnet",
      purpose: "rlusd-acquisition",
      operation_id: OPERATION_ID,
    };

    const firstResponse = await fileBackedHandler(
      directory,
      firstFetch as unknown as typeof globalThis.fetch,
    )(request(operation));
    expect(firstResponse.status).toBe(202);
    expect(firstFetch).toHaveBeenCalledTimes(1);

    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.faucet\.json$/);
    const markerPath = join(directory, files[0]!);
    expect((await stat(markerPath)).mode & 0o777).toBe(0o600);
    const persisted = JSON.parse(await readFile(markerPath, "utf8"));
    expect(persisted).toMatchObject({
      version: 1,
      marker: {
        version: 1,
        network: "testnet",
        owner: ADDRESS,
        operation_id: OPERATION_ID,
      },
      integrity: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const restartedFetch = vi.fn();
    const restartedResponse = await fileBackedHandler(
      directory,
      restartedFetch as unknown as typeof globalThis.fetch,
    )(request(operation));
    expect(restartedResponse.status).toBe(202);
    expect(restartedFetch).not.toHaveBeenCalled();

    persisted.marker.operation_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await writeFile(markerPath, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });
    const tamperedFetch = vi.fn();
    const tamperedResponse = await fileBackedHandler(
      directory,
      tamperedFetch as unknown as typeof globalThis.fetch,
    )(request(operation));
    expect(tamperedResponse.status).toBe(503);
    expect(tamperedFetch).not.toHaveBeenCalled();
  });

  it("keeps legacy and isolated dispatch markers mutually unreadable with reused state and secret", async () => {
    const operation = {
      address: ADDRESS,
      network: "testnet",
      purpose: "rlusd-acquisition",
      operation_id: OPERATION_ID,
    };
    for (const [writer, reader] of [
      ["legacy", "isolated"],
      ["isolated", "legacy"],
    ] as const) {
      const directory = await mkdtemp(join(tmpdir(), `pilot-faucet-profile-${writer}-`));
      temporaryDirectories.push(directory);
      await chmod(directory, 0o700);
      const firstFetch = vi.fn(async () => new Response("{}", { status: 200 }));
      const writerUrl = writer === "isolated"
        ? "http://127.0.0.2:3003/api/dev/faucet"
        : "http://127.0.0.1:3003/api/dev/faucet";
      const first = await fileBackedHandler(
        directory,
        firstFetch as unknown as typeof globalThis.fetch,
        () => 1_000,
        new MemoryAcquisitionStateStore(),
        writer,
      )(request(operation, writerUrl, new URL(writerUrl).origin));
      expect(first.status).toBe(202);

      const persistedPath = join(directory, (await readdir(directory))[0]!);
      expect(JSON.parse(await readFile(persistedPath, "utf8"))).toMatchObject(
        writer === "isolated"
          ? { version: 2, deployment_profile: "local-wallet-isolated-v1" }
          : { version: 1 },
      );

      const secondFetch = vi.fn();
      const readerUrl = reader === "isolated"
        ? "http://127.0.0.2:3003/api/dev/faucet"
        : "http://127.0.0.1:3003/api/dev/faucet";
      const second = await fileBackedHandler(
        directory,
        secondFetch as unknown as typeof globalThis.fetch,
        () => 2_000,
        new MemoryAcquisitionStateStore(),
        reader,
      )(request(operation, readerUrl, new URL(readerUrl).origin));
      expect(second.status).toBe(503);
      expect((await second.json()).error.code).toBe("ACQUISITION_STATE_UNAVAILABLE");
      expect(secondFetch).not.toHaveBeenCalled();
    }
  });

  it("rejects a non-user-only acquisition state directory before dispatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-faucet-permissions-"));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o755);
    const fetch = vi.fn();
    const response = await fileBackedHandler(
      directory,
      fetch as unknown as typeof globalThis.fetch,
    )(request({
      address: ADDRESS,
      network: "testnet",
      purpose: "rlusd-acquisition",
      operation_id: OPERATION_ID,
    }));

    expect(response.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it("rejects a configured acquisition state-directory symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilot-faucet-symlink-"));
    temporaryDirectories.push(root);
    const target = join(root, "state");
    const configured = join(root, "configured-state");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, configured);
    const fetch = vi.fn();

    const response = await fileBackedHandler(
      configured,
      fetch as unknown as typeof globalThis.fetch,
    )(request({
      address: ADDRESS,
      network: "testnet",
      purpose: "rlusd-acquisition",
      operation_id: OPERATION_ID,
    }));

    expect(response.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
    expect(await readdir(target)).toEqual([]);
  });
});
