import { describe, expect, it } from "vitest";

import { WorkAgreementFixtureService } from "../../../../components/agreements/work-agreement-fixture";
import { createWorkAgreementFixtureHandler } from "./handler";

const ENDPOINT = "http://127.0.0.1:3003/api/agreements/fixture";
const NOW = Date.parse("2026-10-24T12:00:00.000Z");

function request(body: unknown, origin = "http://127.0.0.1:3003") {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

function harness() {
  return createWorkAgreementFixtureHandler({
    enabled: true,
    service: new WorkAgreementFixtureService(),
    now: () => NOW,
  });
}

async function body(response: Response) {
  return await response.json() as Record<string, any>;
}

describe("POST /api/agreements/fixture", () => {
  it("is fail-closed and unavailable by default", async () => {
    const response = await createWorkAgreementFixtureHandler()(request({ action: "start" }));
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("requires same-origin bounded JSON", async () => {
    const post = harness();
    expect((await post(request({ action: "start" }, "https://example.com"))).status).toBe(403);
    expect((await post(new Request(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: new URL(ENDPOINT).origin },
      body: "{}",
    }))).status).toBe(415);
    expect((await post(request({ action: "start", url: "https://example.com" }))).status).toBe(400);
  });

  it("integrates the recorded create and release fixture without network authority", async () => {
    const post = harness();
    const startResponse = await post(request({ action: "start" }));
    expect(startResponse.status).toBe(200);
    const start = await body(startResponse);
    expect(start).toMatchObject({
      status: "awaiting_create",
      simulation: true,
      ledgerSignatureValid: false,
      networkRequestsMade: 0,
    });
    const active = await body(await post(request({
      action: "submit_recorded_blob",
      phase: "create",
      signed_blob: start.approval.recordedFixtureBlob,
    })));
    expect(active).toMatchObject({ status: "active", offerSequence: 42 });
    const release = await body(await post(request({ action: "prepare", phase: "release" })));
    expect(release).toMatchObject({
      status: "awaiting_release",
      approval: { action: "release", requireOwnerApproval: true },
    });
    const terminal = await body(await post(request({
      action: "submit_recorded_blob",
      phase: "release",
      signed_blob: release.approval.recordedFixtureBlob,
    })));
    expect(terminal).toMatchObject({
      status: "released",
      validation: { action: "release", source: "deterministic-fixture" },
      networkRequestsMade: 0,
    });
    expect(JSON.stringify(terminal)).not.toMatch(/seed|private.?key|api.?key|credential/i);
  });

  it("integrates the mutually exclusive cancel path and rejects blob tampering", async () => {
    const post = harness();
    const start = await body(await post(request({ action: "start" })));
    expect((await post(request({
      action: "submit_recorded_blob",
      phase: "create",
      signed_blob: `${start.approval.recordedFixtureBlob}00`,
    }))).status).toBe(400);
    await post(request({
      action: "submit_recorded_blob",
      phase: "create",
      signed_blob: start.approval.recordedFixtureBlob,
    }));
    const cancel = await body(await post(request({ action: "prepare", phase: "cancel" })));
    const terminal = await body(await post(request({
      action: "submit_recorded_blob",
      phase: "cancel",
      signed_blob: cancel.approval.recordedFixtureBlob,
    })));
    expect(terminal.status).toBe("cancelled");
    expect((await post(request({ action: "prepare", phase: "release" }))).status).toBe(400);
  });
});
