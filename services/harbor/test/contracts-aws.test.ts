import { describe, expect, it } from "vitest";
import {
  BLOCKED_FIELD_KIND_LIMIT,
  BlockedFieldKindSchema,
  CardEventSchema,
  CaveatSchema,
  ExecResultSchema,
  OkSchema,
  SignerSchema,
  TrustScreenSchema,
} from "../src/contracts";

const screen = {
  provider: "aws-bedrock-guardrails" as const,
  fields_checked: 3,
  fields_blocked: 1,
  max_score: 0.95,
  blocked_field_kinds: ["memo-data" as const],
};

describe("AWS trust contracts", () => {
  it("parses strict trust-screen metadata and the redaction caveat", () => {
    expect(TrustScreenSchema.parse(screen)).toEqual(screen);
    expect(CaveatSchema.parse("screened-redacted")).toBe(
      "screened-redacted",
    );
    expect(() =>
      TrustScreenSchema.parse({ ...screen, fields_checked: 1.5 }),
    ).toThrow();
    expect(() =>
      TrustScreenSchema.parse({ ...screen, unexpected: true }),
    ).toThrow();
    expect(BlockedFieldKindSchema.parse("merchant-response")).toBe(
      "merchant-response",
    );
    expect(() => BlockedFieldKindSchema.parse("merchant.body.secret")).toThrow();
    expect(() =>
      TrustScreenSchema.parse({
        ...screen,
        blocked_field_kinds: ["memo-data", "memo-data"],
      }),
    ).toThrow();
    expect(() =>
      TrustScreenSchema.parse({ ...screen, blocked_field_kinds: [] }),
    ).toThrow();
    expect(() =>
      TrustScreenSchema.parse({
        ...screen,
        fields_blocked: 0,
        blocked_field_kinds: ["memo-data"],
      }),
    ).toThrow();
    expect(() =>
      TrustScreenSchema.parse({
        ...screen,
        blocked_field_kinds: Array.from(
          { length: BLOCKED_FIELD_KIND_LIMIT + 1 },
          () => "memo-data",
        ),
      }),
    ).toThrow();
  });

  it("keeps trust optional on successful envelopes", () => {
    const schema = OkSchema(TrustScreenSchema);
    const base = {
      ok: true as const,
      data: screen,
      asOf: "2026-10-21T00:00:00.000Z",
      asOfBasis: "fixture",
    };

    expect(schema.parse(base)).toEqual(base);
    expect(
      schema.parse({
        ...base,
        caveat: ["screened-redacted"],
        trust: { screen },
      }).trust?.screen,
    ).toEqual(screen);
  });

  it("adds optional signer provenance only to executed results", () => {
    const executed = {
      status: "executed" as const,
      hash: "ABC",
      ledger_index: 12,
      result: "success" as const,
      signed_by: "delegate" as const,
      signer: {
        kind: "aws-kms" as const,
        key_ref: "alias/harbor/testnet/link-1",
      },
    };

    expect(ExecResultSchema.parse(executed)).toEqual(executed);
    const { signer: _signer, ...legacyExecuted } = executed;
    expect(ExecResultSchema.parse(legacyExecuted)).toEqual(legacyExecuted);
    expect(() =>
      SignerSchema.parse({
        kind: "aws-kms",
        key_ref: "arn:aws:kms:us-east-1:123:key/secret",
      }),
    ).toThrow();
  });

  it("carries optional model, screen and signer metadata on card events", () => {
    const event = {
      intent_id: "intent-1",
      state: "validated" as const,
      at: "2026-10-21T00:00:00.000Z",
      intent: {
        id: "intent-1",
        network: "testnet" as const,
        kind: "cancel" as const,
        offer_sequence: 7,
      },
      trust: {
        model: { provider: "bedrock-mock" as const, id: "mock-sonnet" },
        screen,
        signer: {
          kind: "aws-kms-kek" as const,
          key_ref: "alias/harbor/kek",
        },
      },
    };

    expect(CardEventSchema.parse(event)).toEqual(event);
    const { trust: _trust, ...legacyEvent } = event;
    expect(CardEventSchema.parse(legacyEvent)).toEqual(legacyEvent);
  });
});
