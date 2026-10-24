import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  HERMES_CONSENT_COOKIE,
  HERMES_CONSENT_DATA_POLICY,
  issueHermesConsentCookie,
  isValidatedHermesConsentRecordFor,
  readHermesConsentCookie,
  revokeHermesConsentCookie,
  type HermesConsentDisclosure,
  type HermesConsentScope,
} from "./hermes-consent";

const NOW = 1_800_000_000_000;
const SECRET = "pilot-hermes-consent-test-secret-32-chars";
const OWNER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";

const scope: HermesConsentScope = {
  tenantId: "tenant-a",
  owner: OWNER,
  network: "testnet",
};

const disclosure: HermesConsentDisclosure = {
  provider: "example-provider",
  model: "example/model-v1",
  dataPolicy: HERMES_CONSENT_DATA_POLICY,
  retentionDays: 7,
  termsVersion: "2026-10-21",
};

function cookieHeader(value: string): string {
  return `${HERMES_CONSENT_COOKIE}=${encodeURIComponent(value)}`;
}

function read(
  value: string,
  expectedScope: HermesConsentScope = scope,
  expectedDisclosure: HermesConsentDisclosure = disclosure,
  now = NOW,
) {
  return readHermesConsentCookie(
    cookieHeader(value),
    expectedScope,
    expectedDisclosure,
    { secret: SECRET, now },
  );
}

function forgeSignedValue(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", SECRET)
    .update(`pilot.hermes.consent.v1.${encoded}`, "utf8")
    .digest("base64url");
  return `v1.${encoded}.${signature}`;
}

function decodeIssuedPayload(value: string): Record<string, unknown> {
  const payload = value.split(".")[1];
  if (!payload) throw new Error("Expected an issued consent payload.");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

describe("Hermes consent cookie", () => {
  it("round-trips exact scoped disclosure with hardened cookie attributes", () => {
    const issued = issueHermesConsentCookie(scope, disclosure, {
      secret: SECRET,
      now: NOW,
      maxAgeSeconds: 600,
    });

    expect(issued.setCookie).toBe(
      `${HERMES_CONSENT_COOKIE}=${encodeURIComponent(issued.value)}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Strict`,
    );
    expect(read(issued.value)).toEqual({
      version: 1,
      epoch: 0,
      scopeDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      disclosureDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      issuedAt: NOW / 1000,
      expiresAt: NOW / 1000 + 600,
    });
  });

  it("does not put the raw owner or tenant in the cookie payload", () => {
    const issued = issueHermesConsentCookie(scope, disclosure, {
      secret: SECRET,
      now: NOW,
    });
    const decodedPayload = Buffer.from(
      issued.value.split(".")[1] ?? "",
      "base64url",
    ).toString("utf8");

    expect(issued.value).not.toContain(scope.owner);
    expect(issued.value).not.toContain(scope.tenantId);
    expect(issued.setCookie).not.toContain(scope.owner);
    expect(issued.setCookie).not.toContain(scope.tenantId);
    expect(decodedPayload).not.toContain(scope.owner);
    expect(decodedPayload).not.toContain(scope.tenantId);
  });

  it("rejects payload and signature tampering", () => {
    const issued = issueHermesConsentCookie(scope, disclosure, {
      secret: SECRET,
      now: NOW,
    });
    const parts = issued.value.split(".");
    expect(parts).toHaveLength(3);

    const changedPayload = `${parts[1]?.slice(0, -1)}A`;
    expect(read(`v1.${changedPayload}.${parts[2]}`)).toBeNull();

    const changedSignature = `${parts[2]?.slice(0, -1)}A`;
    expect(read(`v1.${parts[1]}.${changedSignature}`)).toBeNull();
  });

  it("rejects a different authenticated tenant, owner, or network", () => {
    const issued = issueHermesConsentCookie(scope, disclosure, {
      secret: SECRET,
      now: NOW,
    });

    expect(read(issued.value, { ...scope, tenantId: "tenant-b" })).toBeNull();
    expect(
      read(issued.value, {
        ...scope,
        owner: "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY",
      }),
    ).toBeNull();
    expect(read(issued.value, { ...scope, network: "devnet" })).toBeNull();
  });

  it("rejects any changed provider disclosure field", () => {
    const issued = issueHermesConsentCookie(scope, disclosure, {
      secret: SECRET,
      now: NOW,
    });

    expect(
      read(issued.value, scope, { ...disclosure, provider: "other-provider" }),
    ).toBeNull();
    expect(
      read(issued.value, scope, { ...disclosure, model: "example/model-v2" }),
    ).toBeNull();
    expect(
      read(issued.value, scope, { ...disclosure, retentionDays: 8 }),
    ).toBeNull();
    expect(
      read(issued.value, scope, { ...disclosure, termsVersion: "2026-10-22" }),
    ).toBeNull();
    expect(() =>
      read(issued.value, scope, {
        ...disclosure,
        dataPolicy: "unbounded" as typeof HERMES_CONSENT_DATA_POLICY,
      }),
    ).toThrow(/bounded redacted/);
  });

  it("binds the branded validation to the separately supplied scope and disclosure", () => {
    const issued = issueHermesConsentCookie(scope, disclosure, {
      secret: SECRET,
      now: NOW,
      epoch: 4,
    });
    const record = readHermesConsentCookie(
      cookieHeader(issued.value),
      scope,
      disclosure,
      { secret: SECRET, now: NOW, expectedEpoch: 4 },
    );
    expect(isValidatedHermesConsentRecordFor(record, scope, disclosure)).toBe(true);
    expect(isValidatedHermesConsentRecordFor(
      record,
      { ...scope, tenantId: "tenant-b" },
      disclosure,
    )).toBe(false);
    expect(isValidatedHermesConsentRecordFor(
      record,
      scope,
      { ...disclosure, model: "example/model-v2" },
    )).toBe(false);
    expect(readHermesConsentCookie(
      cookieHeader(issued.value),
      scope,
      disclosure,
      { secret: SECRET, now: NOW, expectedEpoch: 5 },
    )).toBeNull();
  });

  it("expires at the exact expiry boundary", () => {
    const issued = issueHermesConsentCookie(scope, disclosure, {
      secret: SECRET,
      now: NOW,
      maxAgeSeconds: 60,
    });

    expect(read(issued.value, scope, disclosure, NOW + 59_000)).not.toBeNull();
    expect(read(issued.value, scope, disclosure, NOW + 60_000)).toBeNull();
  });

  it("rejects future-issued and over-30-day signed payloads", () => {
    const issued = issueHermesConsentCookie(scope, disclosure, {
      secret: SECRET,
      now: NOW,
    });
    const payload = decodeIssuedPayload(issued.value);

    expect(
      read(
        forgeSignedValue({
          ...payload,
          issuedAt: NOW / 1000 + 1,
          expiresAt: NOW / 1000 + 60,
        }),
      ),
    ).toBeNull();
    expect(
      read(
        forgeSignedValue({
          ...payload,
          issuedAt: NOW / 1000,
          expiresAt: NOW / 1000 + 30 * 24 * 60 * 60 + 1,
        }),
      ),
    ).toBeNull();
  });

  it("strictly rejects malformed tokens, duplicate cookies, and unknown fields", () => {
    const issued = issueHermesConsentCookie(scope, disclosure, {
      secret: SECRET,
      now: NOW,
    });
    const payload = decodeIssuedPayload(issued.value);
    const unknownField = forgeSignedValue({ ...payload, role: "approved" });
    const wrongVersion = forgeSignedValue({ ...payload, version: 2 });
    const missingFieldPayload = { ...payload };
    delete missingFieldPayload.scopeDigest;
    const missingField = forgeSignedValue(missingFieldPayload);

    expect(read("not-a-token")).toBeNull();
    expect(read("v1.%%%%.%%%%")).toBeNull();
    expect(read(`${issued.value}.extra`)).toBeNull();
    expect(read(unknownField)).toBeNull();
    expect(read(wrongVersion)).toBeNull();
    expect(read(missingField)).toBeNull();
    expect(
      readHermesConsentCookie(
        `${cookieHeader(issued.value)}; ${cookieHeader(issued.value)}`,
        scope,
        disclosure,
        { secret: SECRET, now: NOW },
      ),
    ).toBeNull();
  });

  it("fails closed on weak signing secrets", () => {
    expect(() =>
      issueHermesConsentCookie(scope, disclosure, {
        secret: "too-short",
        now: NOW,
      }),
    ).toThrow(/at least 32 characters/);
    expect(() =>
      readHermesConsentCookie(null, scope, disclosure, {
        secret: "too-short",
        now: NOW,
      }),
    ).toThrow(/at least 32 characters/);
  });

  it("enforces the bounded retention and cookie lifetime", () => {
    for (const retentionDays of [0, 31, 1.5]) {
      expect(() =>
        issueHermesConsentCookie(
          scope,
          { ...disclosure, retentionDays },
          { secret: SECRET, now: NOW },
        ),
      ).toThrow(/retention/);
    }
    expect(() =>
      issueHermesConsentCookie(scope, disclosure, {
        secret: SECRET,
        now: NOW,
        maxAgeSeconds: 30 * 24 * 60 * 60 + 1,
      }),
    ).toThrow(/30 days/);
    expect(() =>
      issueHermesConsentCookie(
        { ...scope, unexpected: "field" } as HermesConsentScope,
        disclosure,
        { secret: SECRET, now: NOW },
      ),
    ).toThrow(/scope.*shape/);
  });

  it("returns a host-only revocation cookie with identical protections", () => {
    expect(revokeHermesConsentCookie()).toBe(
      `${HERMES_CONSENT_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`,
    );
  });
});
