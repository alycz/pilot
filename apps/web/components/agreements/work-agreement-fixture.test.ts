import { describe, expect, it } from "vitest";

import {
  WORK_AGREEMENT_FIXTURE_WARNING,
  WorkAgreementFixtureError,
  WorkAgreementFixtureService,
  parseWorkAgreementFixtureRequest,
} from "./work-agreement-fixture";

const NOW = Date.parse("2026-10-24T12:00:00.000Z");

describe("offline work-agreement fixture service", () => {
  it.each(["release", "cancel"] as const)(
    "runs create then owner-reviewed %s without live authority",
    (phase) => {
      const service = new WorkAgreementFixtureService();
      const create = service.handle({ action: "start" }, NOW);
      expect(create).toMatchObject({
        status: "awaiting_create",
        simulation: true,
        ledgerSignatureValid: false,
        speculosConformanceClaimed: false,
        networkRequestsMade: 0,
        warning: WORK_AGREEMENT_FIXTURE_WARNING,
        approval: { action: "create", requireOwnerApproval: true },
      });
      const active = service.handle({
        action: "submit_recorded_blob",
        phase: "create",
        signed_blob: create.approval!.recordedFixtureBlob,
      }, NOW);
      expect(active).toMatchObject({
        status: "active",
        offerSequence: 42,
        validation: { action: "create", source: "deterministic-fixture" },
      });
      const awaitingTerminal = service.handle({ action: "prepare", phase }, NOW);
      expect(awaitingTerminal).toMatchObject({
        status: phase === "release" ? "awaiting_release" : "awaiting_cancel",
        approval: { action: phase, requireOwnerApproval: true },
      });
      const terminal = service.handle({
        action: "submit_recorded_blob",
        phase,
        signed_blob: awaitingTerminal.approval!.recordedFixtureBlob,
      }, NOW);
      expect(terminal).toMatchObject({
        status: phase === "release" ? "released" : "cancelled",
        networkRequestsMade: 0,
        validation: { action: phase, source: "deterministic-fixture" },
      });
    },
  );

  it("rejects arbitrary blobs, phase changes, replay, and premature settlement", () => {
    const service = new WorkAgreementFixtureService();
    expect(() => service.handle({ action: "prepare", phase: "release" }, NOW))
      .toThrow(/Start the fixture/i);
    const create = service.handle({ action: "start" }, NOW);
    expect(() => service.handle({
      action: "submit_recorded_blob",
      phase: "cancel",
      signed_blob: create.approval!.recordedFixtureBlob,
    }, NOW)).toThrow(/does not match/i);
    expect(() => service.handle({
      action: "submit_recorded_blob",
      phase: "create",
      signed_blob: "AA",
    }, NOW)).toThrow(/does not match/i);
    service.handle({
      action: "submit_recorded_blob",
      phase: "create",
      signed_blob: create.approval!.recordedFixtureBlob,
    }, NOW);
    expect(() => service.handle({
      action: "submit_recorded_blob",
      phase: "create",
      signed_blob: create.approval!.recordedFixtureBlob,
    }, NOW)).toThrow(/No recorded owner approval/i);
  });

  it("strictly parses only the three bounded fixture request shapes", () => {
    expect(parseWorkAgreementFixtureRequest({ action: "start" })).toEqual({ action: "start" });
    expect(parseWorkAgreementFixtureRequest({ action: "prepare", phase: "release" }))
      .toEqual({ action: "prepare", phase: "release" });
    expect(() => parseWorkAgreementFixtureRequest({ action: "start", url: "https://example.com" }))
      .toThrow(WorkAgreementFixtureError);
    expect(() => parseWorkAgreementFixtureRequest({
      action: "submit_recorded_blob",
      phase: "create",
      signed_blob: "AA",
      api_key: "secret",
    })).toThrow(/invalid/i);
  });
});
