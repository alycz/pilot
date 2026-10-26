import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  NearNep413VerifierError,
  createNearNep413FullAccessKeyVerifier,
  encodeNearNep413Payload,
  type NearNep413VerifierInput,
} from "./near-nep413-verifier";

const RPC_URL = "https://rpc.mainnet.near.org/";
const RPC_ID = "pilot-nep413-full-access-key-v1";
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function encodeBase58(value: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of value) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const next = digits[index] * 256 + carry;
      digits[index] = next % 58;
      carry = Math.floor(next / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === 0) {
    leadingZeroes += 1;
  }
  return "1".repeat(leadingZeroes) +
    digits.reverse().map((digit) => BASE58_ALPHABET[digit]).join("");
}

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function success(): Response {
  return json({
    jsonrpc: "2.0",
    id: RPC_ID,
    result: {
      block_hash: "11111111111111111111111111111111",
      block_height: 1,
      nonce: 1,
      permission: "FullAccess",
    },
  });
}

function signedInput(): NearNep413VerifierInput {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const rawPublicKey = spki.subarray(spki.length - 32);
  const nonce = new Uint8Array(32);
  nonce.fill(7);
  const input = {
    accountId: "alice.near",
    publicKey: `ed25519:${encodeBase58(rawPublicKey)}`,
    message: "Pilot NEP-413 proof",
    nonce,
    recipient: "pilot.near",
  };
  const digest = createHash("sha256")
    .update(encodeNearNep413Payload(input))
    .digest();
  return {
    ...input,
    signature: sign(null, digest, privateKey).toString("base64"),
  };
}

describe("NEP-413 full-access-key verifier", () => {
  it("encodes the exact tagged Borsh payload with callbackUrl None", () => {
    const nonce = new Uint8Array(32);
    nonce.fill(9);
    const payload = encodeNearNep413Payload({
      message: "hello",
      nonce,
      recipient: "pilot.near",
    });

    let offset = 0;
    expect(payload.readUInt32LE(offset)).toBe(2 ** 31 + 413);
    offset += 4;
    const messageLength = payload.readUInt32LE(offset);
    offset += 4;
    expect(payload.subarray(offset, offset + messageLength).toString("utf8")).toBe("hello");
    offset += messageLength;
    expect(payload.subarray(offset, offset + 32)).toEqual(Buffer.from(nonce));
    offset += 32;
    const recipientLength = payload.readUInt32LE(offset);
    offset += 4;
    expect(payload.subarray(offset, offset + recipientLength).toString("utf8"))
      .toBe("pilot.near");
    offset += recipientLength;
    expect(payload[offset]).toBe(0);
    expect(offset + 1).toBe(payload.length);
  });

  it("verifies a disposable Ed25519 signature and exact final FullAccess RPC query", async () => {
    const fetchMock = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => success());
    const verifier = createNearNep413FullAccessKeyVerifier({ fetch: fetchMock });
    const input = signedInput();

    await expect(verifier.verify(input)).resolves.toEqual({
      accountId: "alice.near",
      publicKey: input.publicKey,
      signatureValid: true,
      fullAccessKeyVerified: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(RPC_URL);
    expect(init).toEqual(expect.objectContaining({
      method: "POST",
      redirect: "error",
    }));
    expect(JSON.parse(String(init?.body))).toEqual({
      jsonrpc: "2.0",
      id: RPC_ID,
      method: "query",
      params: {
        request_type: "view_access_key",
        finality: "final",
        account_id: "alice.near",
        public_key: input.publicKey,
      },
    });
  });

  it("rejects an invalid signature before any RPC request", async () => {
    const fetchMock = vi.fn(async () => success());
    const verifier = createNearNep413FullAccessKeyVerifier({ fetch: fetchMock });
    const input = signedInput();
    const changed = Buffer.from(input.signature, "base64");
    changed[0] ^= 0xff;

    await expect(verifier.verify({
      ...input,
      signature: changed.toString("base64"),
    })).rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["message", (input: NearNep413VerifierInput) => ({ ...input, message: `${input.message}!` })],
    ["nonce", (input: NearNep413VerifierInput) => ({
      ...input,
      nonce: new Uint8Array(32).fill(8),
    })],
    ["recipient", (input: NearNep413VerifierInput) => ({
      ...input,
      recipient: "other.near",
    })],
  ])("binds the signature to the exact %s", async (_name, mutate) => {
    const fetchMock = vi.fn(async () => success());
    const verifier = createNearNep413FullAccessKeyVerifier({ fetch: fetchMock });
    await expect(verifier.verify(mutate(signedInput())))
      .rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["key type", { publicKey: `secp256k1:${"1".repeat(44)}` }],
    ["base58 alphabet", { publicKey: `ed25519:${"0".repeat(44)}` }],
    ["key length", { publicKey: "ed25519:123" }],
    ["signature base64", { signature: "not-base64" }],
    ["nonce length", { nonce: new Uint8Array(31) }],
    ["account ID", { accountId: "Alice.NEAR" }],
  ])("rejects an invalid %s before RPC", async (_name, change) => {
    const fetchMock = vi.fn(async () => success());
    const verifier = createNearNep413FullAccessKeyVerifier({ fetch: fetchMock });
    await expect(verifier.verify({
      ...signedInput(),
      ...change,
    })).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["RPC error", json({ jsonrpc: "2.0", id: RPC_ID, error: { code: -32_000 } })],
    ["mismatched id", json({
      jsonrpc: "2.0", id: "other", result: { permission: "FullAccess" },
    })],
    ["non-JSON", new Response("ok", { headers: { "content-type": "text/plain" } })],
    ["declared oversize", new Response("{}", {
      headers: { "content-type": "application/json", "content-length": "65537" },
    })],
  ])("rejects %s responses", async (_name, response) => {
    const verifier = createNearNep413FullAccessKeyVerifier({
      fetch: vi.fn(async () => response),
    });
    await expect(verifier.verify(signedInput())).rejects.toMatchObject({
      code: "RPC_PROTOCOL_INVALID",
    });
  });

  it("rejects redirected and wrong-origin RPC responses", async () => {
    const redirected = success();
    Object.defineProperty(redirected, "redirected", { value: true });
    const wrongOrigin = success();
    Object.defineProperty(wrongOrigin, "url", { value: "https://attacker.example/" });

    for (const response of [redirected, wrongOrigin]) {
      const verifier = createNearNep413FullAccessKeyVerifier({
        fetch: vi.fn(async () => response),
      });
      await expect(verifier.verify(signedInput())).rejects.toMatchObject({
        code: "RPC_PROTOCOL_INVALID",
      });
    }
  });

  it("rejects a function-call access key", async () => {
    const verifier = createNearNep413FullAccessKeyVerifier({
      fetch: vi.fn(async () => json({
        jsonrpc: "2.0",
        id: RPC_ID,
        result: {
          permission: {
            FunctionCall: {
              allowance: "1",
              receiver_id: "app.near",
              method_names: [],
            },
          },
        },
      })),
    });
    await expect(verifier.verify(signedInput())).rejects.toMatchObject({
      code: "FULL_ACCESS_KEY_REQUIRED",
    });
  });

  it("rejects an undeclared streamed body over the configured maximum", async () => {
    const verifier = createNearNep413FullAccessKeyVerifier({
      maxResponseBytes: 1_024,
      fetch: vi.fn(async () => new Response(" ".repeat(1_025), {
        headers: { "content-type": "application/json" },
      })),
    });
    await expect(verifier.verify(signedInput())).rejects.toMatchObject({
      code: "RPC_PROTOCOL_INVALID",
    });
  });

  it("fails closed when RPC transport is unavailable", async () => {
    const verifier = createNearNep413FullAccessKeyVerifier({
      fetch: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    await expect(verifier.verify(signedInput())).rejects.toMatchObject({
      code: "RPC_UNAVAILABLE",
    });
  });

  it("aborts an RPC request at the configured timeout", async () => {
    vi.useFakeTimers();
    try {
      const verifier = createNearNep413FullAccessKeyVerifier({
        timeoutMs: 100,
        fetch: vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            }, { once: true });
          })),
      });
      const verification = verifier.verify(signedInput()).then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(100);
      await expect(verification).resolves.toMatchObject({ code: "RPC_UNAVAILABLE" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid verifier limits", () => {
    expect(() => createNearNep413FullAccessKeyVerifier({ timeoutMs: 0 }))
      .toThrow(NearNep413VerifierError);
    expect(() => createNearNep413FullAccessKeyVerifier({ maxResponseBytes: 999 }))
      .toThrow(NearNep413VerifierError);
  });
});
