import { describe, expect, it } from "vitest";
import { ECDSA, Wallet, encode, type Payment } from "xrpl";

import { PilotWalletError, type ExactLedgerActionExpectation } from "@pilot/wallet";
import {
  LEDGER_COMPANION_ORIGIN,
  createLedgerCompanionService,
  type LedgerCompanionSigner,
} from "./service";

const HOSTED = "https://pilot.example";
const DESTINATION = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const SESSION = "session.browser.0001";
const REQUEST_ID = "request.browser.0001";
const NOW = 1_800_000_000_000;

function harness(options: Readonly<{
  sign?: "success" | "reject" | "deferred";
  controls?: boolean;
  appVersion?: string;
  identity?: "immediate" | "deferred";
}> = {}) {
  const wallet = Wallet.generate(ECDSA.secp256k1);
  const clock = { value: NOW };
  let generation = 1;
  let signCalls = 0;
  let buttonCalls = 0;
  let disconnectCalls = 0;
  let completeDeferred: (() => void) | undefined;
  const deferred = new Promise<void>((resolve) => { completeDeferred = resolve; });
  let completeIdentity: (() => void) | undefined;
  const identityReady = new Promise<void>((resolve) => { completeIdentity = resolve; });
  const signer: LedgerCompanionSigner = {
    async identity() {
      if (options.identity === "deferred") await identityReady;
      return { account: wallet.classicAddress, generation, appVersion: options.appVersion ?? "2.8.2" };
    },
    async sign(transaction) {
      signCalls += 1;
      if (options.sign === "deferred") await deferred;
      if (options.sign === "reject") throw new PilotWalletError("SIGN_CANCELLED", "cancelled");
      return wallet.sign(transaction as Payment).tx_blob;
    },
    async disconnect() { disconnectCalls += 1; generation += 1; },
  };
  let fill = 1;
  const service = createLedgerCompanionService({
    approvedOrigin: HOSTED,
    signer,
    expectedAccount: wallet.classicAddress,
    now: () => clock.value,
    randomBytes: (size) => new Uint8Array(size).fill(fill++),
    ...(options.controls ? {
      controls: {
        async screen() { return new Uint8Array([137, 80, 78, 71]); },
        async press() { buttonCalls += 1; },
      },
    } : {}),
  });
  const expectation: ExactLedgerActionExpectation = {
    kind: "payment",
    network: "testnet",
    account: wallet.classicAddress,
    sequence: 42,
    validatedLedgerIndex: 1_000,
    maxLedgerWindow: 50,
    maxFeeDrops: "20",
    approvalExpiresAtMs: NOW + 60_000,
    quoteExpiresAtMs: NOW + 30_000,
    destination: DESTINATION,
    amountDrops: "5000",
  };
  const unsignedTxBlob = encode({
    TransactionType: "Payment",
    Account: wallet.classicAddress,
    Destination: DESTINATION,
    Amount: "5000",
    Fee: "12",
    Sequence: 42,
    LastLedgerSequence: 1_050,
  });
  return {
    service, signer, wallet, clock, expectation, unsignedTxBlob,
    signCalls: () => signCalls,
    buttonCalls: () => buttonCalls,
    disconnectCalls: () => disconnectCalls,
    switchGeneration: () => { generation += 1; },
    completeDeferred: () => completeDeferred?.(),
    completeIdentity: () => completeIdentity?.(),
  };
}

function request(path: string, input: Readonly<{
  method?: string;
  origin?: string;
  body?: unknown;
  capability?: string;
  session?: string;
  host?: string;
  extraHeaders?: Record<string, string>;
}> = {}): Request {
  const headers: Record<string, string> = {
    host: input.host ?? new URL(LEDGER_COMPANION_ORIGIN).host,
    ...(input.origin === undefined ? {} : { origin: input.origin }),
    ...(input.body === undefined ? {} : { "content-type": "application/json" }),
    ...(input.session === undefined ? {} : { "x-pilot-session": input.session }),
    ...(input.capability === undefined ? {} : { authorization: `Bearer ${input.capability}` }),
    ...input.extraHeaders,
  };
  return new Request(`${LEDGER_COMPANION_ORIGIN}${path}`, {
    method: input.method ?? (input.body === undefined ? "GET" : "POST"),
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
}

async function localReview(service: ReturnType<typeof createLedgerCompanionService>): Promise<{
  token: string;
  challenge: string;
}> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const response = await service.handle(request("/ui"), { remoteAddress: "127.0.0.1" });
    const html = await response.text();
    const token = /const token="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
    const challenge = /const challenge="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
    if (token !== undefined && challenge !== undefined) return { token, challenge };
  }
  throw new Error("local review did not become available");
}

async function localAdminToken(service: ReturnType<typeof createLedgerCompanionService>): Promise<{
  token: string;
  html: string;
}> {
  const response = await service.handle(request("/ui"), { remoteAddress: "127.0.0.1" });
  const html = await response.text();
  const token = /const token="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
  if (token === undefined) throw new Error("local admin token unavailable");
  return { token, html };
}

async function decide(
  service: ReturnType<typeof createLedgerCompanionService>,
  decision: "approve" | "reject",
) {
  const { token, challenge } = await localReview(service);
  return service.handle(request("/v1/local/review", {
    origin: LEDGER_COMPANION_ORIGIN,
    capability: token,
    body: { challenge, decision },
    extraHeaders: { "sec-fetch-site": "same-origin" },
  }), { remoteAddress: "127.0.0.1" });
}

async function pair(h: ReturnType<typeof harness>, ttlMs = 10_000) {
  const responsePromise = h.service.handle(request("/v1/pair", {
    origin: HOSTED,
    session: SESSION,
    body: {
      version: 1,
      session_id: SESSION,
      network: "testnet",
      account: h.wallet.classicAddress,
      unsigned_tx_blob: h.unsignedTxBlob,
      expectation: h.expectation,
      ttl_ms: ttlMs,
    },
  }), { remoteAddress: "127.0.0.1" });
  expect((await decide(h.service, "approve")).status).toBe(200);
  const response = await responsePromise;
  expect(response.status).toBe(200);
  return await response.json() as {
    capability: string;
    scope: {
      pairingId: string;
      action: "payment";
      reviewDigest: string;
      transactionDigest: string;
    };
  };
}

function signBody(h: ReturnType<typeof harness>, paired: Awaited<ReturnType<typeof pair>>) {
  return {
    version: 1,
    pairing_id: paired.scope.pairingId,
    request_id: REQUEST_ID,
    session_id: SESSION,
    network: "testnet",
    account: h.wallet.classicAddress,
    action: paired.scope.action,
    review_digest: paired.scope.reviewDigest,
    transaction_digest: paired.scope.transactionDigest,
    unsigned_tx_blob: h.unsignedTxBlob,
  };
}

describe("hosted Ledger companion service", () => {
  it("requires local review, signs one exact action, verifies it, and rejects replay", async () => {
    const h = harness();
    const paired = await pair(h);
    const signed = await h.service.handle(request("/v1/sign", {
      origin: HOSTED, session: SESSION, capability: paired.capability,
      body: signBody(h, paired),
    }), { remoteAddress: "127.0.0.1" });
    expect(signed.status).toBe(200);
    expect(await signed.json()).toMatchObject({
      request_id: REQUEST_ID,
      provenance: { runtime: "speculos", emulator: true, physicalDeviceInferred: false },
      submitted: false,
    });
    const replay = await h.service.handle(request("/v1/sign", {
      origin: HOSTED, session: SESSION, capability: paired.capability,
      body: signBody(h, paired),
    }), { remoteAddress: "127.0.0.1" });
    expect(replay.status).toBe(409);
    expect(h.signCalls()).toBe(1);
  });

  it("preserves one verified signed result for exact recovery after response loss and expiry", async () => {
    const h = harness();
    const paired = await pair(h, 1_000);
    const signed = await h.service.handle(request("/v1/sign", {
      origin: HOSTED, session: SESSION, capability: paired.capability, body: signBody(h, paired),
    }), { remoteAddress: "127.0.0.1" });
    expect(signed.status).toBe(200);
    h.clock.value += 1_000;
    const status = await h.service.handle(request("/v1/status", {
      origin: HOSTED, session: SESSION, capability: paired.capability,
      body: {
        pairing_id: paired.scope.pairingId,
        session_id: SESSION,
        network: "testnet",
        account: h.wallet.classicAddress,
      },
    }), { remoteAddress: "127.0.0.1" });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      status: "signed",
      request_id: REQUEST_ID,
      transaction_hash: expect.stringMatching(/^[A-F0-9]{64}$/),
      signed_blob: expect.stringMatching(/^[A-F0-9]+$/),
    });
    expect(h.signCalls()).toBe(1);
  });

  it("rejects wrong origins, hosts, forwarded callers, non-loopback peers and raw proxy paths", async () => {
    const h = harness();
    const cases = [
      [request("/v1/pair", { origin: "https://attacker.example", body: {} }), "127.0.0.1"],
      [request("/v1/pair", { origin: HOSTED, body: {}, host: "127.0.0.1:9999" }), "127.0.0.1"],
      [request("/v1/pair", { origin: HOSTED, body: {}, extraHeaders: { forwarded: "for=127.0.0.1" } }), "127.0.0.1"],
      [request("/v1/pair", { origin: HOSTED, body: {} }), "192.168.1.8"],
      [request("/apdu", { origin: HOSTED, body: {} }), "127.0.0.1"],
      [request("/button/both", { origin: HOSTED, body: {} }), "127.0.0.1"],
    ] as const;
    for (const [candidate, peer] of cases) {
      const response = await h.service.handle(candidate, { remoteAddress: peer });
      expect(response.status).toBeGreaterThanOrEqual(400);
      if (candidate.headers.get("origin") !== HOSTED) {
        expect(response.headers.has("access-control-allow-origin")).toBe(false);
      }
    }
  });

  it("allows only exact CORS preflights and treats legacy PNA as non-authorizing", async () => {
    const h = harness();
    const accepted = await h.service.handle(request("/v1/sign", {
      method: "OPTIONS",
      origin: HOSTED,
      extraHeaders: {
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type, x-pilot-session",
        "access-control-request-private-network": "true",
      },
    }), { remoteAddress: "127.0.0.1" });
    expect(accepted.status).toBe(204);
    expect(accepted.headers.get("access-control-allow-origin")).toBe(HOSTED);
    expect(accepted.headers.get("access-control-allow-private-network")).toBe("true");
    expect(accepted.headers.has("access-control-allow-credentials")).toBe(false);
    const denied = await h.service.handle(request("/v1/sign", {
      method: "OPTIONS", origin: HOSTED,
      extraHeaders: {
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-arbitrary-proxy",
      },
    }), { remoteAddress: "127.0.0.1" });
    expect(denied.status).toBe(403);
  });

  it("requires the local same-origin admin challenge and leaves rejection terminal", async () => {
    const h = harness();
    const pairPromise = h.service.handle(request("/v1/pair", {
      origin: HOSTED, session: SESSION,
      body: {
        version: 1, session_id: SESSION, network: "testnet", account: h.wallet.classicAddress,
        unsigned_tx_blob: h.unsignedTxBlob, expectation: h.expectation, ttl_ms: 10_000,
      },
    }), { remoteAddress: "127.0.0.1" });
    const { token, challenge } = await localReview(h.service);
    const forged = await h.service.handle(request("/v1/local/review", {
      origin: HOSTED, capability: token, body: { challenge, decision: "approve" },
      extraHeaders: { "sec-fetch-site": "cross-site" },
    }), { remoteAddress: "127.0.0.1" });
    expect(forged.status).toBe(403);
    expect((await decide(h.service, "reject")).status).toBe(200);
    expect((await pairPromise).status).toBe(400);
  });

  it("keeps emulator screen and button controls on the authenticated local UI only", async () => {
    const h = harness({ controls: true });
    const pairPromise = h.service.handle(request("/v1/pair", {
      origin: HOSTED, session: SESSION,
      body: {
        version: 1, session_id: SESSION, network: "testnet", account: h.wallet.classicAddress,
        unsigned_tx_blob: h.unsignedTxBlob, expectation: h.expectation, ttl_ms: 10_000,
      },
    }), { remoteAddress: "127.0.0.1" });
    const { token, challenge } = await localReview(h.service);
    const crossSite = await h.service.handle(request("/v1/local/button", {
      origin: HOSTED, capability: token, body: { button: "both" },
      extraHeaders: { "sec-fetch-site": "cross-site" },
    }), { remoteAddress: "127.0.0.1" });
    expect(crossSite.status).toBe(403);
    const pressed = await h.service.handle(request("/v1/local/button", {
      origin: LEDGER_COMPANION_ORIGIN, capability: token, body: { button: "both" },
      extraHeaders: { "sec-fetch-site": "same-origin" },
    }), { remoteAddress: "127.0.0.1" });
    expect(pressed.status).toBe(200);
    expect(h.buttonCalls()).toBe(1);
    const screen = await h.service.handle(request("/v1/local/screen", {
      origin: LEDGER_COMPANION_ORIGIN, capability: token, body: {},
      extraHeaders: { "sec-fetch-site": "same-origin" },
    }), { remoteAddress: "127.0.0.1" });
    expect(screen.status).toBe(200);
    expect(screen.headers.get("content-type")).toBe("image/png");
    const rejected = await h.service.handle(request("/v1/local/review", {
      origin: LEDGER_COMPANION_ORIGIN, capability: token, body: { challenge, decision: "reject" },
      extraHeaders: { "sec-fetch-site": "same-origin" },
    }), { remoteAddress: "127.0.0.1" });
    expect(rejected.status).toBe(200);
    expect((await pairPromise).status).toBe(400);
  });

  it("invalidates a changed emulator session before dispatch and never calls the signer", async () => {
    const h = harness();
    const paired = await pair(h);
    h.switchGeneration();
    const response = await h.service.handle(request("/v1/sign", {
      origin: HOSTED, session: SESSION, capability: paired.capability, body: signBody(h, paired),
    }), { remoteAddress: "127.0.0.1" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "sign_outcome_unknown" });
    expect(h.signCalls()).toBe(0);
  });

  it("serializes signing so a double click cannot dispatch a second emulator request", async () => {
    const h = harness({ sign: "deferred" });
    const paired = await pair(h);
    const first = h.service.handle(request("/v1/sign", {
      origin: HOSTED, session: SESSION, capability: paired.capability, body: signBody(h, paired),
    }), { remoteAddress: "127.0.0.1" });
    while (h.signCalls() === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await h.service.handle(request("/v1/sign", {
      origin: HOSTED, session: SESSION, capability: paired.capability,
      body: { ...signBody(h, paired), request_id: "request.browser.0002" },
    }), { remoteAddress: "127.0.0.1" });
    expect(second.status).toBe(409);
    h.completeDeferred();
    expect((await first).status).toBe(200);
    expect(h.signCalls()).toBe(1);
  });

  it("records device rejection and expiry without retrying", async () => {
    const rejectedHarness = harness({ sign: "reject" });
    const rejectedPair = await pair(rejectedHarness);
    const rejected = await rejectedHarness.service.handle(request("/v1/sign", {
      origin: HOSTED, session: SESSION, capability: rejectedPair.capability,
      body: signBody(rejectedHarness, rejectedPair),
    }), { remoteAddress: "127.0.0.1" });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ error: "sign_outcome_unknown" });
    expect(rejectedHarness.signCalls()).toBe(1);

    const expiredHarness = harness();
    const expiredPair = await pair(expiredHarness, 1_000);
    expiredHarness.clock.value += 1_000;
    const expired = await expiredHarness.service.handle(request("/v1/sign", {
      origin: HOSTED, session: SESSION, capability: expiredPair.capability,
      body: signBody(expiredHarness, expiredPair),
    }), { remoteAddress: "127.0.0.1" });
    expect(expired.status).toBe(400);
    expect(expiredHarness.signCalls()).toBe(0);
  });

  it("times out an abandoned emulator review, fences the signer, and records unknown", async () => {
    const h = harness({ sign: "deferred" });
    const paired = await pair(h, 1_000);
    const signing = h.service.handle(request("/v1/sign", {
      origin: HOSTED, session: SESSION, capability: paired.capability, body: signBody(h, paired),
    }), { remoteAddress: "127.0.0.1" });
    while (h.signCalls() === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.signCalls()).toBe(1);
    const response = await signing;
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "sign_outcome_unknown" });
    expect(h.disconnectCalls()).toBe(1);
  });

  it("refuses disconnect while signing and preserves the in-flight result", async () => {
    const h = harness({ sign: "deferred" });
    const paired = await pair(h);
    const signing = h.service.handle(request("/v1/sign", {
      origin: HOSTED, session: SESSION, capability: paired.capability, body: signBody(h, paired),
    }), { remoteAddress: "127.0.0.1" });
    while (h.signCalls() === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    const disconnected = await h.service.handle(request("/v1/disconnect", {
      origin: HOSTED, session: SESSION, capability: paired.capability,
      body: {
        pairing_id: paired.scope.pairingId,
        session_id: SESSION,
        network: "testnet",
        account: h.wallet.classicAddress,
      },
    }), { remoteAddress: "127.0.0.1" });
    expect(disconnected.status).toBe(409);
    expect(h.disconnectCalls()).toBe(0);
    h.completeDeferred();
    expect((await signing).status).toBe(200);
  });

  it("fails closed on any XRP app version outside the pinned public fixture", async () => {
    const h = harness({ appVersion: "2.8.1" });
    const response = await h.service.handle(request("/v1/pair", {
      origin: HOSTED, session: SESSION,
      body: {
        version: 1, session_id: SESSION, network: "testnet", account: h.wallet.classicAddress,
        unsigned_tx_blob: h.unsignedTxBlob, expectation: h.expectation, ttl_ms: 10_000,
      },
    }), { remoteAddress: "127.0.0.1" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "unsupported_xrp_app" });
  });

  it("lets the authenticated local UI revoke an orphaned pair response before another pairing", async () => {
    const h = harness();
    await pair(h);
    const { token, html } = await localAdminToken(h.service);
    expect(html).toContain("A paired or recovery-held action remains");
    const reset = await h.service.handle(request("/v1/local/reset", {
      origin: LEDGER_COMPANION_ORIGIN,
      capability: token,
      body: {},
      extraHeaders: { "sec-fetch-site": "same-origin" },
    }), { remoteAddress: "127.0.0.1" });
    expect(reset.status).toBe(200);
    expect(h.disconnectCalls()).toBe(1);
    await expect(pair(h)).resolves.toMatchObject({ scope: { action: "payment" } });
  });

  it("atomically rejects a concurrent pair before a second identity or local review", async () => {
    const h = harness({ identity: "deferred" });
    const pairRequest = () => h.service.handle(request("/v1/pair", {
      origin: HOSTED, session: SESSION,
      body: {
        version: 1, session_id: SESSION, network: "testnet", account: h.wallet.classicAddress,
        unsigned_tx_blob: h.unsignedTxBlob, expectation: h.expectation, ttl_ms: 10_000,
      },
    }), { remoteAddress: "127.0.0.1" });
    const first = pairRequest();
    await Promise.resolve();
    const second = await pairRequest();
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "pairing_already_exists" });
    h.completeIdentity();
    expect((await decide(h.service, "approve")).status).toBe(200);
    expect((await first).status).toBe(200);
  });
});
