import { describe, expect, it } from "vitest";

import {
  AP4M_MASTERCARD_INTENT_HEADER,
  AP4M_PAYMENT_SIGNATURE_HEADER,
  AP4M_VI_L1_HEADER,
  AP4M_VI_L2_HEADER,
  AP4M_VI_L3B_HEADER,
  Ap4mX402Error,
  buildAp4mRetryHeaders,
  encodeAp4mT54PaymentSignature,
  encodeMastercardIntentHeader,
  validateAp4mX402Challenge,
  xrplCurrencyCodeForAp4m,
  type ValidatedAp4mX402Challenge,
} from "../src/exec/ap4m-x402";

const URL = "https://merchant.example/resource/yield-report";
const MERCHANT = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const RLUSD = "524C555344000000000000000000000000000000";
const SOURCE_TAG = 2_610_240;

function base64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function requirement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scheme: "exact",
    network: "xrpl:1",
    asset: RLUSD,
    payTo: MERCHANT,
    amount: "1",
    maxTimeoutSeconds: 60,
    extra: {
      areFeesSponsored: false,
      assetTransferMethod: "sequence",
      issuer: ISSUER,
      invoiceId: "ap4m-invoice-1",
      sourceTag: SOURCE_TAG,
    },
    ...overrides,
  };
}

function wrapper(accepts: unknown[] = [requirement()]): Record<string, unknown> {
  return {
    x402Version: 2,
    resource: {
      url: URL,
      description: "Typed venue yield report",
      mimeType: "application/json",
      serviceName: "Venue Yield Desk",
      tags: ["ap4m", "yield-report"],
    },
    accepts,
  };
}

const OPTIONS = {
  requestUrl: URL,
  network: "testnet" as const,
  merchantPayTo: MERCHANT,
  expectedAsset: { currency: "RLUSD", issuer: ISSUER },
  maxAmount: "1",
  expectedSourceTag: SOURCE_TAG,
};

function validate(value: unknown = wrapper()): ValidatedAp4mX402Challenge {
  return validateAp4mX402Challenge(base64Json(value), OPTIONS);
}

function code(callback: () => unknown): string | undefined {
  try {
    callback();
  } catch (error) {
    return error instanceof Ap4mX402Error ? error.code : undefined;
  }
  return undefined;
}

describe("validateAp4mX402Challenge", () => {
  it("binds one exact Testnet IOU requirement to the trusted registry values", () => {
    const result = validate();

    expect(result).toEqual({
      x402Version: 2,
      resource: wrapper().resource,
      scheme: "exact",
      network: "xrpl:1",
      currency: RLUSD,
      issuer: ISSUER,
      payTo: MERCHANT,
      amount: "1",
      maxTimeoutSeconds: 60,
      invoiceId: "ap4m-invoice-1",
      sourceTag: SOURCE_TAG,
      accepted: requirement(),
    });
    expect(xrplCurrencyCodeForAp4m("RLUSD")).toBe(RLUSD);
    expect(xrplCurrencyCodeForAp4m("tUSD")).toBe(
      "7455534400000000000000000000000000000000",
    );
  });

  it("uses exact decimal arithmetic for the registry price cap", () => {
    expect(
      validateAp4mX402Challenge(
        base64Json(wrapper([requirement({ amount: "0.9999999999999999" })])),
        OPTIONS,
      ).amount,
    ).toBe("0.9999999999999999");
    expect(
      code(() =>
        validateAp4mX402Challenge(
          base64Json(wrapper([requirement({ amount: "1.000000000000001" })])),
          OPTIONS,
        ),
      ),
    ).toBe("MAX_PRICE_EXCEEDED");
  });

  it.each([
    ["wrong scheme", requirement({ scheme: "xrpl-paychan" }), "NO_COMPATIBLE_PAYMENT_REQUIREMENT"],
    ["mainnet", requirement({ network: "xrpl:0" }), "NO_COMPATIBLE_PAYMENT_REQUIREMENT"],
    ["wrong asset", requirement({ asset: "USD" }), "NO_COMPATIBLE_PAYMENT_REQUIREMENT"],
    [
      "wrong issuer",
      requirement({ extra: { ...requirement().extra as object, issuer: MERCHANT } }),
      "NO_COMPATIBLE_PAYMENT_REQUIREMENT",
    ],
    ["wrong payTo", requirement({ payTo: ISSUER }), "PAY_TO_MISMATCH"],
    ["zero amount", requirement({ amount: "0" }), "INVALID_AMOUNT"],
    ["noncanonical amount", requirement({ amount: "1.0" }), "INVALID_AMOUNT"],
    ["float amount", requirement({ amount: 1 }), "INVALID_AMOUNT"],
    ["oversized amount", requirement({ amount: "1.0000000000000001" }), "INVALID_AMOUNT"],
    ["zero timeout", requirement({ maxTimeoutSeconds: 0 }), "INVALID_MAX_TIMEOUT_SECONDS"],
    [
      "fees sponsored",
      requirement({ extra: { ...requirement().extra as object, areFeesSponsored: true } }),
      "FEES_SPONSORED_UNSUPPORTED",
    ],
    [
      "tickets",
      requirement({ extra: { ...requirement().extra as object, assetTransferMethod: "ticketSequence" } }),
      "ASSET_TRANSFER_METHOD_UNSUPPORTED",
    ],
    [
      "wrong source tag",
      requirement({ extra: { ...requirement().extra as object, sourceTag: SOURCE_TAG + 1 } }),
      "SOURCE_TAG_MISMATCH",
    ],
    [
      "unknown payment control",
      requirement({ extra: { ...requirement().extra as object, facilitator: "https://evil.example" } }),
      "UNSUPPORTED_PAYMENT_CONTROL",
    ],
  ])("rejects %s", (_label, selected, expected) => {
    expect(code(() => validate(wrapper([selected])))).toBe(expected);
  });

  it("rejects ambiguous and duplicate PAYMENT-REQUIRED headers", () => {
    expect(code(() => validate(wrapper([requirement(), requirement()])))).toBe(
      "AMBIGUOUS_PAYMENT_REQUIREMENTS",
    );
    const header = base64Json(wrapper());
    expect(code(() => validateAp4mX402Challenge([header, header], OPTIONS))).toBe(
      "DUPLICATE_PAYMENT_REQUIRED",
    );
    expect(code(() => validateAp4mX402Challenge(`${header}, ${header}`, OPTIONS))).toBe(
      "DUPLICATE_PAYMENT_REQUIRED",
    );
  });

  it("rejects wrapper/requirement smuggling and a substituted resource", () => {
    expect(code(() => validate({ ...wrapper(), redirect: "https://evil.example" }))).toBe(
      "UNSUPPORTED_PAYMENT_CONTROL",
    );
    expect(
      code(() => validate(wrapper([{ ...requirement(), facilitator: "https://evil.example" }]))),
    ).toBe("UNSUPPORTED_PAYMENT_CONTROL");
    const mismatched = wrapper();
    mismatched.resource = { url: "https://evil.example/resource" };
    expect(code(() => validate(mismatched))).toBeUndefined();
    expect(() => validate(mismatched)).toThrow("RESOURCE_URL_MISMATCH");
  });
});

describe("AP4M retry headers", () => {
  const intent = {
    intentId: "demo-intent-00000000-0000-4000-8000-000000000004",
    intentStatus: "ACTIVE",
    orders: [{ orderId: "order-1" }],
  };
  const vi = "eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJkZW1vIn0.signature~";

  it("echoes the accepted requirement in the T54 payment signature", () => {
    const challenge = validate();
    const encoded = encodeAp4mT54PaymentSignature({
      challenge,
      signedTxBlob: "ABCD",
    });
    expect(JSON.parse(atob(encoded))).toEqual({
      x402Version: 2,
      resource: challenge.resource,
      accepted: challenge.accepted,
      payload: { signedTxBlob: "ABCD" },
    });
  });

  it("preserves original headers and emits bounded intent plus all three VI layers", () => {
    const challenge = validate();
    const paymentSignature = encodeAp4mT54PaymentSignature({
      challenge,
      signedTxBlob: "ABCD",
    });
    const original = new Headers({ accept: "application/json", "x-request-id": "request-1" });
    const headers = buildAp4mRetryHeaders(original, {
      paymentSignature,
      mastercardIntent: intent,
      viL1: vi,
      viL2: vi,
      viL3b: vi,
    });

    expect([...original.entries()]).toEqual([
      ["accept", "application/json"],
      ["x-request-id", "request-1"],
    ]);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get(AP4M_PAYMENT_SIGNATURE_HEADER)).toBe(paymentSignature);
    expect(headers.get(AP4M_VI_L1_HEADER)).toBe(vi);
    expect(headers.get(AP4M_VI_L2_HEADER)).toBe(vi);
    expect(headers.get(AP4M_VI_L3B_HEADER)).toBe(vi);
    const encodedIntent = headers.get(AP4M_MASTERCARD_INTENT_HEADER)!;
    expect(encodedIntent).toBe(encodeMastercardIntentHeader(intent));
    expect(JSON.parse(Buffer.from(encodedIntent, "base64url").toString("utf8"))).toEqual(intent);
  });

  it.each([
    AP4M_PAYMENT_SIGNATURE_HEADER,
    AP4M_MASTERCARD_INTENT_HEADER,
    AP4M_VI_L1_HEADER,
    AP4M_VI_L2_HEADER,
    AP4M_VI_L3B_HEADER,
  ])("rejects a preexisting reserved %s header", (name) => {
    expect(
      code(() =>
        buildAp4mRetryHeaders({ [name]: "injected" }, {
          paymentSignature: encodeAp4mT54PaymentSignature({
            challenge: validate(),
            signedTxBlob: "ABCD",
          }),
          mastercardIntent: intent,
          viL1: vi,
          viL2: vi,
          viL3b: vi,
        }),
      ),
    ).toBe("RESERVED_HEADER_PRESENT");
  });

  it("rejects duplicate original headers before Headers coalesces them", () => {
    expect(
      code(() =>
        buildAp4mRetryHeaders(
          [["accept", "application/json"], ["Accept", "text/plain"]],
          {
            paymentSignature: encodeAp4mT54PaymentSignature({
              challenge: validate(),
              signedTxBlob: "ABCD",
            }),
            mastercardIntent: intent,
            viL1: vi,
            viL2: vi,
            viL3b: vi,
          },
        ),
      ),
    ).toBe("DUPLICATE_REQUEST_HEADER");
  });

  it.each([
    ["L1", { viL1: "bad\r\nvalue" }, "INVALID_VI_L1"],
    ["L2", { viL2: "bad value" }, "INVALID_VI_L2"],
    ["L3B", { viL3b: "" }, "INVALID_VI_L3B"],
  ])("rejects malformed %s", (_label, patch, expected) => {
    expect(
      code(() =>
        buildAp4mRetryHeaders(undefined, {
          paymentSignature: encodeAp4mT54PaymentSignature({
            challenge: validate(),
            signedTxBlob: "ABCD",
          }),
          mastercardIntent: intent,
          viL1: vi,
          viL2: vi,
          viL3b: vi,
          ...patch,
        }),
      ),
    ).toBe(expected);
  });

  it("rejects malformed payment signatures, signed blobs, and cyclic intents", () => {
    expect(
      code(() =>
        buildAp4mRetryHeaders(undefined, {
          paymentSignature: "not base64url",
          mastercardIntent: intent,
          viL1: vi,
          viL2: vi,
          viL3b: vi,
        }),
      ),
    ).toBe("INVALID_PAYMENT_SIGNATURE");
    expect(
      code(() =>
        encodeAp4mT54PaymentSignature({ challenge: validate(), signedTxBlob: "abc" }),
      ),
    ).toBe("INVALID_SIGNED_TX_BLOB");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(code(() => encodeMastercardIntentHeader(cyclic))).toBe(
      "INVALID_MASTERCARD_INTENT",
    );
  });
});
