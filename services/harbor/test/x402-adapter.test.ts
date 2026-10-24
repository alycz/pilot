import { describe, expect, it } from "vitest";

import {
  validateX402Challenge,
  validateX402ResourceInfo,
  X402ChallengeError,
  X402_INVOICE_ID_MAX_BYTES,
  X402_PAYMENT_REQUIRED_MAX_DECODED_BYTES,
  X402_PAYMENT_REQUIRED_MAX_ENCODED_BYTES,
} from "../src/adapters/x402";

const REQUEST_URL = "http://127.0.0.1:8787/paid/weather?city=Paris";
const PAY_TO = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const SOURCE_TAG = 2_147_483_647;

type JsonObject = Record<string, unknown>;

function encodeJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encodeBytes(bytes: readonly number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

function fixture(): JsonObject {
  return {
    x402Version: 2,
    error: "Payment required",
    resource: {
      url: REQUEST_URL,
      description: "Weather",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: "xrpl:1",
        asset: "XRP",
        payTo: PAY_TO,
        amount: "1000",
        maxTimeoutSeconds: 60,
        extra: {
          invoiceId: "invoice-123",
          sourceTag: SOURCE_TAG,
          destinationTag: 0,
        },
      },
    ],
    extensions: {},
  };
}

function selected(value: JsonObject): JsonObject {
  return (value.accepts as JsonObject[])[0];
}

function extra(value: JsonObject): JsonObject {
  return selected(value).extra as JsonObject;
}

const options = {
  requestUrl: REQUEST_URL,
  maxPriceDrops: "2000",
  policyPerCallDrops: "1500",
  network: "testnet" as const,
  expectedSourceTag: SOURCE_TAG,
};

function expectCode(value: unknown, code: string): void {
  try {
    validateX402Challenge(value as string, options);
    throw new Error("expected validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(X402ChallengeError);
    expect((error as X402ChallengeError).code).toBe(code);
    expect((error as Error).message).toBe(code);
  }
}

describe("validateX402Challenge", () => {
  it("returns only canonical fields for one valid Testnet XRP requirement", () => {
    expect(validateX402Challenge(encodeJson(fixture()), options)).toEqual({
      x402Version: 2,
      resource: {
        url: REQUEST_URL,
        description: "Weather",
        mimeType: "application/json",
      },
      scheme: "exact",
      network: "xrpl:1",
      asset: "XRP",
      payTo: PAY_TO,
      amountDrops: "1000",
      maxTimeoutSeconds: 60,
      invoiceId: "invoice-123",
      sourceTag: SOURCE_TAG,
      destinationTag: 0,
    });
  });

  it("omits destinationTag when the challenge omits it", () => {
    const value = fixture();
    delete extra(value).destinationTag;
    expect(validateX402Challenge(encodeJson(value), options)).not.toHaveProperty(
      "destinationTag",
    );
  });

  it("allows unrelated, incompatible payment methods without making selection ambiguous", () => {
    const value = fixture();
    (value.accepts as unknown[]).unshift({
      scheme: "exact",
      network: "eip155:84532",
      asset: "USDC",
      payTo: "0x0000000000000000000000000000000000000000",
      amount: "1",
      maxTimeoutSeconds: 60,
      extra: { arbitraryOtherRailField: true },
    });
    expect(validateX402Challenge(encodeJson(value), options).network).toBe(
      "xrpl:1",
    );
  });

  describe("strict header decoding", () => {
    it.each([
      ["empty", ""],
      ["whitespace", `${encodeJson(fixture())}\n`],
      ["unpadded", "e30"],
      ["base64url alphabet", "____"],
      ["misplaced padding", "A==="]
    ])("rejects %s base64", (_name, header) => {
      expectCode(header, "INVALID_PAYMENT_REQUIRED_ENCODING");
    });

    it("rejects an encoded header over its cap before decoding", () => {
      expectCode(
        "A".repeat(X402_PAYMENT_REQUIRED_MAX_ENCODED_BYTES + 4),
        "PAYMENT_REQUIRED_TOO_LARGE",
      );
    });

    it("rejects decoded bytes over their independent cap", () => {
      const decoded = " ".repeat(X402_PAYMENT_REQUIRED_MAX_DECODED_BYTES + 1);
      const header = btoa(decoded);
      expect(header.length).toBeLessThan(X402_PAYMENT_REQUIRED_MAX_ENCODED_BYTES);
      expectCode(header, "PAYMENT_REQUIRED_TOO_LARGE");
    });

    it("rejects invalid UTF-8", () => {
      expectCode(encodeBytes([0xc3, 0x28]), "INVALID_PAYMENT_REQUIRED_UTF8");
    });

    it("rejects invalid JSON", () => {
      expectCode(btoa("{"), "INVALID_PAYMENT_REQUIRED_JSON");
    });

    it.each([null, [], "object", 2])(
      "rejects a non-object JSON wrapper: %j",
      (value) => {
        expectCode(encodeJson(value), "INVALID_PAYMENT_REQUIRED_WRAPPER");
      },
    );
  });

  describe("wrapper and resource binding", () => {
    it.each([1, "2", null, undefined])("rejects x402Version %j", (version) => {
      const value = fixture();
      value.x402Version = version;
      expectCode(encodeJson(value), "UNSUPPORTED_X402_VERSION");
    });

    it.each([
      ["unknown wrapper field", { unknown: true }],
      ["declared extension", { extensions: { custom: {} } }],
      ["non-string error", { error: 7 }],
    ])("rejects %s", (_name, patch) => {
      expect(() => validateX402Challenge(
        encodeJson({ ...fixture(), ...patch }),
        options,
      )).toThrow("UNSUPPORTED_PAYMENT_CONTROL");
    });

    it.each([
      `${REQUEST_URL}/`,
      REQUEST_URL.replace("127.0.0.1", "localhost"),
      REQUEST_URL.replace("Paris", "paris"),
      undefined,
    ])("requires an exact resource.url match: %j", (url) => {
      const value = fixture();
      (value.resource as JsonObject).url = url;
      expectCode(encodeJson(value), "RESOURCE_URL_MISMATCH");
    });

    it.each([null, {}, "requirements"])("rejects accepts=%j", (accepts) => {
      const value = fixture();
      value.accepts = accepts;
      expectCode(encodeJson(value), "INVALID_ACCEPTS");
    });

    it("preserves every standard optional ResourceInfo field", () => {
      const value = fixture();
      value.resource = {
        ...(value.resource as JsonObject),
        serviceName: "Weather Service",
        tags: ["weather", "local"],
        iconUrl: "https://example.test/weather.png",
      };
      expect(validateX402Challenge(encodeJson(value), options).resource).toEqual(
        value.resource,
      );
    });

    it("does not impose non-T54 micro-caps on standard metadata", () => {
      const value = fixture();
      value.resource = {
        ...(value.resource as JsonObject),
        serviceName: "x".repeat(33),
        tags: ["a", "b", "c", "d", "e", "f"],
      };
      expect(validateX402Challenge(encodeJson(value), options).resource).toEqual(
        value.resource,
      );
    });

    it.each([
      ["unknown field", { unknown: true }],
      ["non-http icon", { iconUrl: "file:///tmp/icon.png" }],
    ])("rejects ResourceInfo with %s", (_name, patch) => {
      const value = fixture();
      value.resource = { ...(value.resource as JsonObject), ...patch };
      expect(() => validateX402Challenge(encodeJson(value), options)).toThrow();
    });

    it("bounds directly revalidated durable ResourceInfo fields", () => {
      expect(() => validateX402ResourceInfo({
        url: REQUEST_URL,
        description: "x".repeat(X402_PAYMENT_REQUIRED_MAX_DECODED_BYTES + 1),
      }, REQUEST_URL)).toThrow("INVALID_RESOURCE_DESCRIPTION");
    });

    it("rejects malformed entries even when another entry is compatible", () => {
      const value = fixture();
      (value.accepts as unknown[]).push(null);
      expectCode(encodeJson(value), "INVALID_ACCEPTS");
    });
  });

  describe("unambiguous compatible selection", () => {
    it.each([
      ["scheme", "upto"],
      ["network", "xrpl:0"],
      ["network", "testnet"],
      ["asset", "xrp"],
      ["asset", { currency: "USD", issuer: PAY_TO }],
    ])("rejects unsupported %s=%j", (field, valueForField) => {
      const value = fixture();
      selected(value)[field] = valueForField;
      expectCode(encodeJson(value), "NO_COMPATIBLE_PAYMENT_REQUIREMENT");
    });

    it("rejects duplicate compatible entries even when identical", () => {
      const value = fixture();
      const duplicate = JSON.parse(JSON.stringify(selected(value))) as JsonObject;
      (value.accepts as JsonObject[]).push(duplicate);
      expectCode(encodeJson(value), "AMBIGUOUS_PAYMENT_REQUIREMENTS");
    });

    it("rejects two differing compatible entries rather than choosing one", () => {
      const value = fixture();
      const duplicate = JSON.parse(JSON.stringify(selected(value))) as JsonObject;
      duplicate.amount = "999";
      (value.accepts as JsonObject[]).push(duplicate);
      expectCode(encodeJson(value), "AMBIGUOUS_PAYMENT_REQUIREMENTS");
    });
  });

  describe("amount and price policy", () => {
    it.each(["0", "-1", "+1", "01", "1.0", "1e3", " 1", 1, null])(
      "rejects non-canonical amount %j",
      (amount) => {
        const value = fixture();
        selected(value).amount = amount;
        expectCode(encodeJson(value), "INVALID_AMOUNT");
      },
    );

    it("rejects amounts outside JavaScript's safe integer range", () => {
      const value = fixture();
      selected(value).amount = "9007199254740992";
      expectCode(encodeJson(value), "AMOUNT_OUT_OF_RANGE");
    });

    it("enforces maxPriceDrops", () => {
      const value = fixture();
      selected(value).amount = "1001";
      expect(() =>
        validateX402Challenge(encodeJson(value), {
          ...options,
          maxPriceDrops: "1000",
          policyPerCallDrops: "2000",
        }),
      ).toThrowError("MAX_PRICE_EXCEEDED");
    });

    it("enforces policyPerCallDrops independently", () => {
      const value = fixture();
      selected(value).amount = "1001";
      expect(() =>
        validateX402Challenge(encodeJson(value), {
          ...options,
          maxPriceDrops: "2000",
          policyPerCallDrops: "1000",
        }),
      ).toThrowError("POLICY_PER_CALL_EXCEEDED");
    });

    it.each(["01", "-1", "1.0", "9007199254740992", 1000, null])(
      "rejects invalid configured price bounds: %j",
      (bound) => {
        expect(() =>
          validateX402Challenge(encodeJson(fixture()), {
            ...options,
            maxPriceDrops: bound as string,
          }),
        ).toThrowError("INVALID_MAX_PRICE_DROPS");
      },
    );
  });

  describe("XRPL destination and timeout", () => {
    it.each([
      "not-an-address",
      "XVLhHMPHU98es4dbozjVtdWzVrDjtVBrEQ4Q2s9wgaBJYQn",
      "",
      null,
    ])("rejects non-classic payTo %j", (payTo) => {
      const value = fixture();
      selected(value).payTo = payTo;
      expectCode(encodeJson(value), "INVALID_PAY_TO");
    });

    it.each([0, -1, 601, 1.5, "60", null])(
      "rejects maxTimeoutSeconds=%j",
      (timeout) => {
        const value = fixture();
        selected(value).maxTimeoutSeconds = timeout;
        expectCode(encodeJson(value), "INVALID_MAX_TIMEOUT_SECONDS");
      },
    );

    it("accepts the maximum bounded timeout", () => {
      const value = fixture();
      selected(value).maxTimeoutSeconds = 600;
      expect(validateX402Challenge(encodeJson(value), options).maxTimeoutSeconds).toBe(
        600,
      );
    });
  });

  describe("invoice and tag bindings", () => {
    it.each([undefined, null, "not-an-object", []])(
      "rejects invalid extra=%j",
      (paymentExtra) => {
        const value = fixture();
        selected(value).extra = paymentExtra;
        expectCode(encodeJson(value), "INVALID_PAYMENT_EXTRA");
      },
    );

    it.each([undefined, null, "", "   "])(
      "rejects invoiceId=%j",
      (invoiceId) => {
        const value = fixture();
        extra(value).invoiceId = invoiceId;
        expectCode(encodeJson(value), "INVALID_INVOICE_ID");
      },
    );

    it("bounds invoiceId by UTF-8 bytes rather than UTF-16 units", () => {
      const value = fixture();
      extra(value).invoiceId = "€".repeat(
        Math.floor(X402_INVOICE_ID_MAX_BYTES / 3) + 1,
      );
      expectCode(encodeJson(value), "INVALID_INVOICE_ID");
    });

    it.each([undefined, null, -1, 4_294_967_296, 1.5, "2147483647"])(
      "rejects invalid sourceTag=%j",
      (sourceTag) => {
        const value = fixture();
        extra(value).sourceTag = sourceTag;
        expectCode(encodeJson(value), "INVALID_SOURCE_TAG");
      },
    );

    it("requires the merchant source tag to match configuration exactly", () => {
      const value = fixture();
      extra(value).sourceTag = SOURCE_TAG + 1;
      expectCode(encodeJson(value), "SOURCE_TAG_MISMATCH");
    });

    it.each([-1, 4_294_967_296, 1.5, "0", null])(
      "rejects invalid optional destinationTag=%j",
      (destinationTag) => {
        const value = fixture();
        extra(value).destinationTag = destinationTag;
        expectCode(encodeJson(value), "INVALID_DESTINATION_TAG");
      },
    );

    it("accepts the full UInt32 range for tags", () => {
      const value = fixture();
      extra(value).sourceTag = 4_294_967_295;
      extra(value).destinationTag = 4_294_967_295;
      expect(
        validateX402Challenge(encodeJson(value), {
          ...options,
          expectedSourceTag: 4_294_967_295,
        }),
      ).toMatchObject({ sourceTag: 4_294_967_295, destinationTag: 4_294_967_295 });
    });
  });

  describe("transaction-control rejection", () => {
    it.each([
      ["issuer", PAY_TO],
      ["currency", "USD"],
      ["sendMax", "2000"],
      ["paths", []],
      ["flags", 0],
      ["sequence", 1],
      ["lastLedgerSequence", 99],
      ["fee", "12"],
      ["memos", []],
    ])("rejects selected requirement field %s", (field, control) => {
      const value = fixture();
      selected(value)[field] = control;
      expectCode(encodeJson(value), "UNSUPPORTED_PAYMENT_CONTROL");
    });

    it.each([
      ["issuer", PAY_TO],
      ["currency", "USD"],
      ["sendMax", "2000"],
      ["paths", []],
      ["flags", 0],
      ["fee", "12"],
      ["memo", "merchant-controlled"],
      ["assetTransferMethod", "iou"],
    ])("rejects extra field %s", (field, control) => {
      const value = fixture();
      extra(value)[field] = control;
      expectCode(encodeJson(value), "UNSUPPORTED_PAYMENT_CONTROL");
    });
  });
});
