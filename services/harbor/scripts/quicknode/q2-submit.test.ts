import { describe, expect, it } from "vitest";

import { runQ2Submit } from "./q2-submit.ts";

const HASH = "A".repeat(64);

describe("q2 submit probe", () => {
  it("requires the QuickNode mock route for a stand-in Payment", async () => {
    const lines: string[] = [];
    const fixture = JSON.stringify({
      request: {
        operation: "tx.submit",
        network: "testnet",
        transaction_type: "Payment",
        args: { tx_blob: "AB".repeat(16), network: "testnet" },
      },
      response: {
        ok: true,
        data: { status: "executed", hash: HASH },
        trust: {
          rpc: {
            route: "quicknode-mock",
            methods_quicknode: 0,
            methods_fallback: 1,
          },
        },
      },
    });
    await runQ2Submit(
      ["--mode", "mock", "--fixture", "/tmp/q2.json", "--status", "/tmp/status.md"],
      {
        readFile: (async () => fixture) as never,
        appendFile: (async (_path, line) => lines.push(String(line))) as never,
        stdout: { write: () => true },
      },
    );
    expect(lines[0]).toContain("route=quicknode-mock");
    expect(lines[0]).toContain("mock-only");
  });

  it("never promotes fixture evidence to live", async () => {
    await expect(
      runQ2Submit(
        ["--mode", "live", "--fixture", "/tmp/q2.json"],
        {
          readFile: (async () => "{}") as never,
          appendFile: (async () => undefined) as never,
          stdout: { write: () => true },
        },
      ),
    ).rejects.toThrow(/direct Harbor submit/);
  });

  it("rejects unknown and secret-like submit fields before fetch", async () => {
    let fetched = false;
    const request = JSON.stringify({
      operation: "tx.submit",
      network: "testnet",
      transaction_type: "Payment",
      args: {
        tx_blob: "AB".repeat(16),
        network: "testnet",
        seed: "sNeverAccepted",
      },
    });
    await expect(runQ2Submit(
      [
        "--mode", "live", "--request", "/tmp/request.json",
        "--harbor-url", "https://harbor.example/",
      ],
      {
        readFile: (async () => request) as never,
        fetcher: (async () => {
          fetched = true;
          return new Response("{}", { status: 200 });
        }) as typeof fetch,
        appendFile: (async () => undefined) as never,
        stdout: { write: () => true },
      },
    )).rejects.toThrow();
    expect(fetched).toBe(false);
  });

  it("rejects a signed non-Payment blob before fetch", async () => {
    let fetched = false;
    const request = JSON.stringify({
      operation: "tx.submit",
      network: "testnet",
      transaction_type: "Payment",
      args: { tx_blob: "CD".repeat(16), network: "testnet" },
    });
    await expect(runQ2Submit(
      [
        "--mode", "live", "--request", "/tmp/request.json",
        "--harbor-url", "https://harbor.example/",
      ],
      {
        readFile: (async () => request) as never,
        decodeBlob: () => ({ TransactionType: "AccountSet" }),
        fetcher: (async () => {
          fetched = true;
          return new Response("{}", { status: 200 });
        }) as typeof fetch,
        appendFile: (async () => undefined) as never,
        stdout: { write: () => true },
      },
    )).rejects.toThrow(/must be a Payment/);
    expect(fetched).toBe(false);
  });

  it("rejects fallback evidence in mock mode", async () => {
    const fixture = JSON.stringify({
      request: {
        operation: "tx.submit",
        network: "testnet",
        transaction_type: "Payment",
        args: { tx_blob: "AB".repeat(16), network: "testnet" },
      },
      response: {
        ok: true,
        data: { status: "executed", hash: HASH },
        trust: {
          rpc: { route: "fallback", methods_quicknode: 0, methods_fallback: 1 },
        },
      },
    });
    await expect(
      runQ2Submit(["--mode", "mock", "--fixture", "/tmp/q2.json"], {
        readFile: (async () => fixture) as never,
        appendFile: (async () => undefined) as never,
        stdout: { write: () => true },
      }),
    ).rejects.toThrow(/quicknode-mock/);
  });

  it("injects an external bearer without including it or the blob in errors", async () => {
    const previous = process.env.HARBOR_API_KEY;
    process.env.HARBOR_API_KEY = "external-test-bearer";
    let authorization: string | null = null;
    const request = JSON.stringify({
      operation: "tx.submit",
      network: "testnet",
      transaction_type: "Payment",
      args: { tx_blob: "EF".repeat(16), network: "testnet" },
    });
    try {
      const failure = await runQ2Submit(
        [
          "--mode", "live", "--request", "/tmp/request.json",
          "--harbor-url", "https://harbor.example/",
        ],
        {
          readFile: (async () => request) as never,
          fetcher: (async (_input, init) => {
            authorization = new Headers(init?.headers).get("authorization");
            return new Response("failure", { status: 500 });
          }) as typeof fetch,
          decodeBlob: () => ({ TransactionType: "Payment" }),
          appendFile: (async () => undefined) as never,
          stdout: { write: () => true },
        },
      ).then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("Harbor submit returned HTTP 500");
      expect((failure as Error).message).not.toContain("external-test-bearer");
      expect((failure as Error).message).not.toContain("EFEF");
      expect((failure as Error).message).not.toContain("harbor.example");
      expect(authorization).toBe("Bearer external-test-bearer");
    } finally {
      if (previous === undefined) delete process.env.HARBOR_API_KEY;
      else process.env.HARBOR_API_KEY = previous;
    }
  });
});
