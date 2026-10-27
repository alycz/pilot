import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

type ProviderUtils = Readonly<{
  fetchWithValidatedEndpoint(input: Readonly<{
    url: string | URL;
    init?: RequestInit;
    fetch?: typeof fetch;
    trustedOrigin?: string;
    redirect?: "error" | "manual";
  }>): Promise<Response>;
  fetchWithValidatedRedirects(input: Readonly<{
    url: string;
    headers?: HeadersInit;
    abortSignal?: AbortSignal;
    maxRedirects?: number;
    fetch?: typeof fetch;
    trustedOrigin?: string;
  }>): Promise<Response>;
  readResponseWithSizeLimit(input: Readonly<{
    response: Response;
    url: string;
    maxBytes?: number;
  }>): Promise<Uint8Array>;
}>;

const requireFromTest = createRequire(import.meta.url);
const bedrockEntry = requireFromTest.resolve("@ai-sdk/amazon-bedrock");
const requireFromBedrock = createRequire(bedrockEntry);
const providerUtilsPackage = requireFromBedrock.resolve("@ai-sdk/provider-utils/package.json");
const providerUtilsEntry = join(dirname(providerUtilsPackage), "dist/index.mjs");
const providerUtilsUndiciPackage = requireFromBedrock.resolve("undici/package.json");
const directUndiciPackage = requireFromTest.resolve("undici/package.json");

async function loadProviderUtils(): Promise<ProviderUtils> {
  return await import(pathToFileURL(providerUtilsEntry).href) as ProviderUtils;
}

describe.sequential("AI SDK provider-utils Undici remediation", () => {
  it("resolves both provider-utils and the web runtime to the reviewed Undici version", () => {
    const nested = requireFromBedrock(providerUtilsUndiciPackage) as { version?: unknown };
    const direct = requireFromTest(directUndiciPackage) as { version?: unknown };
    expect(nested.version).toBe("6.29.1");
    expect(direct.version).toBe("6.29.1");
  });

  it("keeps connect-time DNS pinning and rejects any private resolved address", async () => {
    const originalGetBuiltinModule = process.getBuiltinModule;
    process.getBuiltinModule = ((id: string) => {
      if (id === "node:dns") {
        return {
          lookup: (
            _hostname: string,
            _options: unknown,
            callback: (error: Error | null, addresses?: Array<{ address: string; family: number }>) => void,
          ) => callback(null, [
            { address: "203.0.113.8", family: 4 },
            { address: "127.0.0.1", family: 4 },
          ]),
        };
      }
      return originalGetBuiltinModule(id as never);
    }) as typeof process.getBuiltinModule;

    try {
      const providerUtils = await loadProviderUtils();
      const rejection = await providerUtils.fetchWithValidatedEndpoint({
        url: "http://provider-utils-dns-pin.invalid/resource",
      }).catch((error: unknown) => error);
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error & { cause?: unknown }).cause).toMatchObject({
        message: expect.stringMatching(/resolved to disallowed IP address 127\.0\.0\.1/),
      });
    } finally {
      process.getBuiltinModule = originalGetBuiltinModule;
    }
  });

  it.each([
    "http://127.0.0.1/private",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/private",
    "http://service.internal/private",
  ])("blocks a private or internal target before fetch: %s", async (url) => {
    const providerUtils = await loadProviderUtils();
    const customFetch = vi.fn<typeof fetch>();

    await expect(providerUtils.fetchWithValidatedEndpoint({
      url,
      fetch: customFetch,
    })).rejects.toThrow(/not allowed/);
    expect(customFetch).not.toHaveBeenCalled();
  });

  it("validates every redirect hop and fails closed before a private target", async () => {
    const providerUtils = await loadProviderUtils();
    const customFetch = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      });
    });

    await expect(providerUtils.fetchWithValidatedRedirects({
      url: "https://public-provider.example/download",
      fetch: customFetch,
    })).rejects.toThrow(/not allowed/);
    expect(customFetch).toHaveBeenCalledOnce();
  });

  it("preserves abort signals and streamed response reads", async () => {
    const providerUtils = await loadProviderUtils();
    const controller = new AbortController();
    const abortingFetch = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      expect(init?.signal).toBe(controller.signal);
      if (init?.signal?.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
        once: true,
      });
    }));
    const pending = providerUtils.fetchWithValidatedRedirects({
      url: "https://public-provider.example/abort",
      abortSignal: controller.signal,
      fetch: abortingFetch,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    const response = new Response(new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode("safe "));
        streamController.enqueue(new TextEncoder().encode("stream"));
        streamController.close();
      },
    }));
    const bytes = await providerUtils.readResponseWithSizeLimit({
      response,
      url: "https://public-provider.example/stream",
      maxBytes: 11,
    });
    expect(new TextDecoder().decode(bytes)).toBe("safe stream");
  });

  it("rejects declared and streamed downloads that exceed the byte limit", async () => {
    const providerUtils = await loadProviderUtils();
    await expect(providerUtils.readResponseWithSizeLimit({
      response: new Response("oversized", { headers: { "content-length": "9" } }),
      url: "https://public-provider.example/declared-oversized",
      maxBytes: 8,
    })).rejects.toThrow(/exceeded maximum size/);

    const response = new Response(new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode("12345"));
        streamController.enqueue(new TextEncoder().encode("6789"));
        streamController.close();
      },
    }));
    await expect(providerUtils.readResponseWithSizeLimit({
      response,
      url: "https://public-provider.example/streamed-oversized",
      maxBytes: 8,
    })).rejects.toThrow(/exceeded maximum size/);
  });
});
