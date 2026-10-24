import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createKek,
  upsertEnvValue,
} from "../scripts/aws/create-kek";

const TEST_ENV = {
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "AWSLOCALTESTONLY",
  AWS_SECRET_ACCESS_KEY: "aws-local-test-only-not-a-credential",
  AWS_ENDPOINT_OVERRIDE: "http://127.0.0.1:8790",
  EXEC_NETWORK: "testnet" as const,
  HARBOR_LOCAL_DEV: "true",
};

const directories: string[] = [];

async function temporaryEnv(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "harbor-create-kek-"));
  directories.push(directory);
  return { directory, path: join(directory, "harbor.dev.vars") };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("AWS create-kek", () => {
  it("creates a symmetric key and alias, encrypts 32 bytes, and upserts only ciphertext", async () => {
    const { path } = await temporaryEnv();
    await writeFile(
      path,
      [
        "HARBOR_API_KEYS=keep-me",
        "HARBOR_KEK_CIPHERTEXT=old-value",
        "EXEC_NETWORK=testnet",
        "HARBOR_KEK_CIPHERTEXT=duplicate-old-value",
        "",
      ].join("\n"),
    );
    const plaintext = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const originalPlaintext = Uint8Array.from(plaintext);
    const ciphertext = Buffer.from("encrypted-envelope", "utf8").toString(
      "base64",
    );
    const calls: Array<{ target: string; body: Record<string, unknown> }> = [];
    const requestOptions: unknown[] = [];
    const fetch = vi.fn(async (_service, target, body, options) => {
      calls.push({ target, body });
      requestOptions.push(options);
      if (target === "TrentService.CreateKey") {
        return { KeyMetadata: { KeyId: "test-key-id" } };
      }
      if (target === "TrentService.CreateAlias") return {};
      if (target === "TrentService.Encrypt") {
        return { CiphertextBlob: ciphertext };
      }
      throw new Error("unexpected target");
    });
    const output = vi.fn();

    await expect(
      createKek({
        env: {
          ...TEST_ENV,
          AWS_ACCESS_KEY_ID: "SENTINEL_ACCESS",
          AWS_SECRET_ACCESS_KEY: "SENTINEL_SECRET",
          AWS_SESSION_TOKEN: "SENTINEL_SESSION",
        },
        envPath: path,
        fetch,
        randomBytes: () => plaintext,
        output,
      }),
    ).resolves.toEqual({ alias: "alias/harbor/kek", envPath: path });

    expect(calls).toEqual([
      {
        target: "TrentService.CreateKey",
        body: {
          KeySpec: "SYMMETRIC_DEFAULT",
          KeyUsage: "ENCRYPT_DECRYPT",
          Description: "Harbor key-encryption key",
        },
      },
      {
        target: "TrentService.CreateAlias",
        body: { AliasName: "alias/harbor/kek", TargetKeyId: "test-key-id" },
      },
      {
        target: "TrentService.Encrypt",
        body: {
          KeyId: "alias/harbor/kek",
          Plaintext: Buffer.from(originalPlaintext).toString("base64"),
          EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        },
      },
    ]);
    expect([...plaintext]).toEqual(new Array(32).fill(0));
    const serializedOptions = JSON.stringify(requestOptions);
    expect(serializedOptions).not.toContain("SENTINEL_ACCESS");
    expect(serializedOptions).not.toContain("SENTINEL_SECRET");
    expect(serializedOptions).not.toContain("SENTINEL_SESSION");
    for (const options of requestOptions) {
      expect(options).toEqual({
        env: {
          AWS_REGION: "us-east-1",
          AWS_ENDPOINT_OVERRIDE: "http://127.0.0.1:8790",
          EXEC_NETWORK: "testnet",
          HARBOR_LOCAL_DEV: "true",
          AWS_ACCESS_KEY_ID: "AWSLOCALTESTONLY",
          AWS_SECRET_ACCESS_KEY: "aws-local-test-only-not-a-credential",
        },
      });
    }
    expect(await readFile(path, "utf8")).toBe(
      [
        "HARBOR_API_KEYS=keep-me",
        `HARBOR_KEK_CIPHERTEXT=${ciphertext}`,
        "EXEC_NETWORK=testnet",
        "",
      ].join("\n"),
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(output).toHaveBeenCalledOnce();
    const serializedOutput = JSON.stringify(output.mock.calls);
    expect(serializedOutput).not.toContain(ciphertext);
    expect(serializedOutput).not.toContain(
      Buffer.from(originalPlaintext).toString("base64"),
    );
  });

  it("zeros plaintext and does not create the env file when Encrypt fails", async () => {
    const { path } = await temporaryEnv();
    const plaintext = new Uint8Array(32).fill(7);
    const fetch = vi.fn(async (_service, target) => {
      if (target === "TrentService.CreateKey") {
        return { KeyMetadata: { KeyId: "test-key-id" } };
      }
      if (target === "TrentService.CreateAlias") return {};
      throw new Error("encrypt failed safely");
    });

    await expect(
      createKek({
        env: TEST_ENV,
        envPath: path,
        fetch,
        randomBytes: () => plaintext,
        output: vi.fn(),
      }),
    ).rejects.toThrow("encrypt failed safely");
    expect([...plaintext]).toEqual(new Array(32).fill(0));
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a generator that does not return exactly 32 bytes and zeros it", async () => {
    const { path } = await temporaryEnv();
    const plaintext = new Uint8Array(31).fill(9);
    const fetch = vi.fn(async (_service, target) => {
      if (target === "TrentService.CreateKey") {
        return { KeyMetadata: { KeyId: "test-key-id" } };
      }
      return {};
    });

    await expect(
      createKek({
        env: TEST_ENV,
        envPath: path,
        fetch,
        randomBytes: () => plaintext,
      }),
    ).rejects.toThrow("exactly 32 bytes");
    expect([...plaintext]).toEqual(new Array(31).fill(0));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["embedded newline", "YWJj\n"],
    ["non-base64 characters", "not!base64"],
    ["oversized ciphertext", Buffer.alloc(12_289, 1).toString("base64")],
  ])(
    "rejects %s before mutating an existing env file",
    async (_label, invalidCiphertext) => {
      const { path } = await temporaryEnv();
      const original = "HARBOR_API_KEYS=sentinel\nEXEC_NETWORK=testnet\n";
      await writeFile(path, original, { mode: 0o640 });
      const plaintext = new Uint8Array(32).fill(5);
      const fetch = vi.fn(async (_service, target) => {
        if (target === "TrentService.CreateKey") {
          return { KeyMetadata: { KeyId: "test-key-id" } };
        }
        if (target === "TrentService.CreateAlias") return {};
        return { CiphertextBlob: invalidCiphertext };
      });

      await expect(
        createKek({
          env: TEST_ENV,
          envPath: path,
          fetch,
          randomBytes: () => plaintext,
          output: vi.fn(),
        }),
      ).rejects.toThrow("ciphertext");
      expect(await readFile(path, "utf8")).toBe(original);
      expect((await stat(path)).mode & 0o777).toBe(0o640);
      expect([...plaintext]).toEqual(new Array(32).fill(0));
    },
  );

  it("appends the ciphertext assignment while preserving unrelated lines", () => {
    expect(
      upsertEnvValue("# event settings\nEXEC_NETWORK=testnet\n", "KEY", "value"),
    ).toBe("# event settings\nEXEC_NETWORK=testnet\nKEY=value\n");
  });
});
