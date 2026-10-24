import { describe, expect, it } from "vitest";

import { resolveE2ELane } from "./lanes";

const loopback = "http://127.0.0.1:3004";

describe("E2E lane safety", () => {
  it("defaults to the isolated, non-authoritative fixture lane", () => {
    expect(resolveE2ELane({})).toEqual({
      id: "fixture",
      evidenceKind: "fixture",
      baseURL: loopback,
      authority: "none",
      startsLocalServer: true,
      maySignOrFund: false,
    });
  });

  it("accepts only a strict active loopback origin for a disjoint fixture lane", () => {
    expect(resolveE2ELane({
      PILOT_E2E_FIXTURE_BASE_URL: "http://127.0.0.1:3016",
    })).toMatchObject({
      id: "fixture",
      baseURL: "http://127.0.0.1:3016",
      authority: "none",
      maySignOrFund: false,
    });

    for (const baseURL of [
      "http://localhost:3016",
      "http://127.0.0.2:3016",
      "https://127.0.0.1:3016",
      "http://127.0.0.1:3016/chat",
      "http://127.0.0.1",
    ]) {
      expect(() => resolveE2ELane({ PILOT_E2E_FIXTURE_BASE_URL: baseURL })).toThrow(
        /isolated fixture baseURL/,
      );
    }
  });

  it("rejects unknown lanes instead of falling back to fixtures", () => {
    expect(() => resolveE2ELane({ PILOT_E2E_LANE: "typo" })).toThrow(
      "PILOT_E2E_LANE must be one of fixture, hosted-read, authenticated-live",
    );
  });

  it("rejects hosted reads without the explicit opt-in", () => {
    expect(() => resolveE2ELane({ PILOT_E2E_LANE: "hosted-read" })).toThrow(
      "hosted-read requires the explicit PILOT_E2E_ALLOW_HOSTED_READ=1 gate",
    );
  });

  it("rejects non-loopback hosted-read targets", () => {
    expect(() => resolveE2ELane({
      PILOT_E2E_LANE: "hosted-read",
      PILOT_E2E_ALLOW_HOSTED_READ: "1",
      PILOT_E2E_BASE_URL: "https://example.com/",
    })).toThrow("loopback port 3004");
  });

  it("blocks a fully configured hosted-read command until a live assertion exists", () => {
    expect(() => resolveE2ELane({
      PILOT_E2E_LANE: "hosted-read",
      PILOT_E2E_ALLOW_HOSTED_READ: "1",
      PILOT_E2E_BASE_URL: loopback,
    })).toThrow(
      "BLOCKED: hosted-read has no implemented live assertion",
    );
  });

  it("rejects authenticated live without the explicit opt-in", () => {
    expect(() => resolveE2ELane({ PILOT_E2E_LANE: "authenticated-live" })).toThrow(
      "authenticated-live requires the explicit PILOT_E2E_ALLOW_AUTHENTICATED_LIVE=1 gate",
    );
  });

  it("rejects mainnet for authenticated live", () => {
    expect(() => resolveE2ELane({
      PILOT_E2E_LANE: "authenticated-live",
      PILOT_E2E_ALLOW_AUTHENTICATED_LIVE: "1",
      PILOT_E2E_NETWORK: "mainnet",
      PILOT_E2E_BASE_URL: loopback,
    })).toThrow("PILOT_E2E_NETWORK=testnet or devnet; mainnet is never accepted");
  });

  it.each(["testnet", "devnet"])(
    "blocks fully configured authenticated-live on %s until a live assertion exists",
    (network) => {
      expect(() => resolveE2ELane({
        PILOT_E2E_LANE: "authenticated-live",
        PILOT_E2E_ALLOW_AUTHENTICATED_LIVE: "1",
        PILOT_E2E_NETWORK: network,
        PILOT_E2E_BASE_URL: loopback,
      })).toThrow(
        "BLOCKED: authenticated-live has no implemented live assertion",
      );
    },
  );
});
