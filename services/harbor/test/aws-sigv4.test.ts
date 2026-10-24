import { describe, expect, it, vi } from "vitest";

import {
  AwsError,
  awsFetch,
  type AwsSigningClientFactory,
  type AwsSigningClientOptions,
} from "../src/aws/sigv4";

const LOCAL_ENV = {
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "TESTONLYACCESSKEY",
  AWS_SECRET_ACCESS_KEY: "test-only-secret",
  AWS_ENDPOINT_OVERRIDE: "http://127.0.0.1:8790",
  EXEC_NETWORK: "testnet" as const,
  HARBOR_LOCAL_DEV: "true",
};

function clientFactory(response: Response) {
  const fetcher = vi.fn().mockResolvedValue(response);
  const observed: AwsSigningClientOptions[] = [];
  const factory: AwsSigningClientFactory = (options) => {
    observed.push(options);
    return { fetch: fetcher };
  };
  return { factory, fetcher, observed };
}

describe("AWS SigV4 transport", () => {
  it("sends the target and JSON body to the loopback stand-in", async () => {
    const harness = clientFactory(
      Response.json({ KeyMetadata: { KeyId: "fixture-key" } }),
    );

    await expect(
      awsFetch(
        "kms",
        "TrentService.CreateKey",
        { KeyUsage: "SIGN_VERIFY" },
        { env: LOCAL_ENV, clientFactory: harness.factory },
      ),
    ).resolves.toEqual({ KeyMetadata: { KeyId: "fixture-key" } });

    expect(harness.observed).toEqual([
      {
        accessKeyId: "TESTONLYACCESSKEY",
        secretAccessKey: "test-only-secret",
        sessionToken: undefined,
        region: "us-east-1",
        service: "kms",
      },
    ]);
    const [input, init] = harness.fetcher.mock.calls[0]!;
    expect(String(input)).toBe("http://127.0.0.1:8790/");
    expect(init).toMatchObject({
      method: "POST",
      body: JSON.stringify({ KeyUsage: "SIGN_VERIFY" }),
    });
    expect(new Headers(init?.headers).get("x-amz-target")).toBe(
      "TrentService.CreateKey",
    );
  });

  it.each([
    [{ ...LOCAL_ENV, EXEC_NETWORK: "mainnet" as const }],
    [{ ...LOCAL_ENV, HARBOR_LOCAL_DEV: "false" }],
    [{ ...LOCAL_ENV, AWS_ENDPOINT_OVERRIDE: "https://kms.amazonaws.com" }],
  ])(
    "rejects unsafe endpoint overrides before creating a client",
    async (env) => {
      const factory = vi.fn<AwsSigningClientFactory>();
      await expect(
        awsFetch("kms", "TrentService.Sign", {}, {
          env,
          clientFactory: factory,
        }),
      ).rejects.toBeInstanceOf(AwsError);
      expect(factory).not.toHaveBeenCalled();
    },
  );

  it("requires explicit credentials without inspecting the ambient environment", async () => {
    const factory = vi.fn<AwsSigningClientFactory>();
    await expect(
      awsFetch(
        "kms",
        "TrentService.DescribeKey",
        {},
        {
          env: {
            EXEC_NETWORK: "testnet",
            HARBOR_LOCAL_DEV: "true",
            AWS_ENDPOINT_OVERRIDE: "http://localhost:8790",
          },
          clientFactory: factory,
        },
      ),
    ).rejects.toMatchObject({ code: "AWS_CREDENTIALS_MISSING" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("normalizes service errors without retaining messages or request data", async () => {
    const secretBody = { material: "must-not-escape" };
    const harness = clientFactory(
      Response.json(
        { __type: "com.amazonaws.kms#DisabledException", message: "echoed secret" },
        { status: 400 },
      ),
    );

    const error = await awsFetch(
      "kms",
      "TrentService.Sign",
      secretBody,
      { env: LOCAL_ENV, clientFactory: harness.factory },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AwsError);
    expect(error).toMatchObject({
      code: "AWS_SERVICE_DisabledException",
      message: "AWS service rejected the request",
      retryable: false,
    });
    expect(JSON.stringify(error)).not.toContain("must-not-escape");
    expect(JSON.stringify(error)).not.toContain("echoed secret");
    expect(JSON.stringify(error)).not.toContain("test-only-secret");
  });

  it("normalizes transport and malformed JSON failures", async () => {
    const transportFactory: AwsSigningClientFactory = () => ({
      fetch: vi.fn().mockRejectedValue(new Error("signed request details")),
    });
    await expect(
      awsFetch("kms", "TrentService.Sign", {}, {
        env: LOCAL_ENV,
        clientFactory: transportFactory,
      }),
    ).rejects.toMatchObject({ code: "AWS_TRANSPORT_ERROR", retryable: true });

    const malformed = clientFactory(new Response("not json"));
    await expect(
      awsFetch("kms", "TrentService.Sign", {}, {
        env: LOCAL_ENV,
        clientFactory: malformed.factory,
      }),
    ).rejects.toMatchObject({ code: "AWS_MALFORMED_RESPONSE" });
  });

  it("uses the Bedrock Guardrails REST path and JSON protocol", async () => {
    const harness = clientFactory(Response.json({ ok: true }));
    await awsFetch("bedrock-runtime", "InvokeGuardrailChecks", {}, {
      env: {
        AWS_ACCESS_KEY_ID: "TESTONLYACCESSKEY",
        AWS_SECRET_ACCESS_KEY: "test-only-secret",
      },
      clientFactory: harness.factory,
    });

    expect(String(harness.fetcher.mock.calls[0]?.[0])).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/guardrail-checks/invoke",
    );
    const headers = new Headers(harness.fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-amz-target")).toBeNull();
  });

  it("maps the Bedrock Guardrails REST path onto the loopback stand-in", async () => {
    const harness = clientFactory(Response.json({ assessments: [] }));
    await awsFetch(
      "bedrock-runtime",
      "BedrockRuntime.InvokeGuardrailChecks",
      { source: "INPUT" },
      { env: LOCAL_ENV, clientFactory: harness.factory },
    );

    expect(String(harness.fetcher.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:8790/guardrail-checks/invoke",
    );
    const headers = new Headers(harness.fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-amz-target")).toBeNull();
  });
});
