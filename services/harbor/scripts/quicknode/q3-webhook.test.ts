import { describe, expect, it } from "vitest";

import { runQ3Webhook, sanitizeWalletPayload } from "./q3-webhook.ts";

const HASH = "B".repeat(64);
const ACCOUNT = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

function payload(extra: Record<string, unknown> = {}): unknown {
  return {
    data: [{
      transaction: {
        hash: HASH,
        Account: ACCOUNT,
        TransactionType: "Payment",
        ledger_index: 123,
        metaData: { TransactionResult: "tesSUCCESS" },
        Memo: "hostile text must not persist",
        ...extra,
      },
    }],
    metadata: { network: "xrp-testnet", arbitrary: "discard" },
  };
}

describe("q3 webhook probe", () => {
  it("persists only the canonical fixed-field projection", async () => {
    const sanitized = sanitizeWalletPayload(payload());
    expect(JSON.stringify(sanitized)).not.toContain("hostile");
    expect(sanitized.data[0]).toEqual({
      hash: HASH,
      Account: ACCOUNT,
      TransactionType: "Payment",
      ledger_index: 123,
      metaData: { TransactionResult: "tesSUCCESS" },
    });

    let written = "";
    let statusLine = "";
    const files = new Map([
      ["/tmp/real.json", JSON.stringify(payload())],
      ["/tmp/standin.json", JSON.stringify(payload())],
      ["/tmp/execution.json", JSON.stringify({
        ok: true,
        data: {
          status: "executed",
          hash: HASH,
          confirmation: {
            provider: "quicknode-mock",
            at: "2026-10-21T20:00:00.000Z",
            latency_ms: 42,
          },
        },
      })],
    ]);
    await runQ3Webhook(
      [
        "--mode", "mock",
        "--payload", "/tmp/real.json",
        "--standin-payload", "/tmp/standin.json",
        "--execution", "/tmp/execution.json",
        "--output", "/tmp/sanitized.json",
        "--status", "/tmp/status.md",
      ],
      {
        readFile: (async (path) => files.get(String(path)) ?? "") as never,
        mkdir: (async () => undefined) as never,
        writeFile: (async (_path, value) => { written = String(value); }) as never,
        appendFile: (async (_path, value) => { statusLine = String(value); }) as never,
        stdout: { write: () => true },
      },
    );
    expect(written).not.toContain("hostile");
    expect(written).toContain(HASH);
    expect(statusLine).toContain("mock-only");
  });

  it("reads live evidence only through the authenticated fixed-field Harbor projection", async () => {
    const files = new Map([
      ["/tmp/standin.json", JSON.stringify(payload())],
    ]);
    let request: { url: string; init?: RequestInit } | undefined;
    let written = "";
    let statusLine = "";
    await runQ3Webhook([
      "--mode", "live", "--hash", HASH,
      "--standin-payload", "/tmp/standin.json",
      "--harbor-url", "http://127.0.0.1:8799",
      "--output", "/tmp/live-sanitized.json",
      "--status", "/tmp/status.md",
    ], {
      env: { HARBOR_API_KEY: "event-harbor-key" },
      fetcher: (async (url, init) => {
        request = { url: String(url), init };
        return new Response(JSON.stringify({
          ok: true,
          data: {
            hash: HASH,
            account: ACCOUNT,
            tx_type: "Payment",
            result: "tesSUCCESS",
            ledger_index: 123,
            received_at: "2026-10-21T20:00:00.000Z",
            execution: {
              id: "execution-live",
              confirmed_by: "quicknode-webhook",
              confirmed_at: "2026-10-21T20:00:09.000Z",
              latency_ms: 875,
            },
          },
        }), { status: 200 });
      }) as typeof fetch,
      readFile: (async (path) => files.get(String(path)) ?? "") as never,
      mkdir: (async () => undefined) as never,
      writeFile: (async (_path, value) => { written = String(value); }) as never,
      appendFile: (async (_path, value) => { statusLine = String(value); }) as never,
      stdout: { write: () => true },
    });
    expect(request?.url).toBe("http://127.0.0.1:8799/api/ops/quicknode.webhookEvidence");
    expect(new Headers(request?.init?.headers).get("authorization")).toBe("Bearer event-harbor-key");
    expect(request?.init?.body).toBe(JSON.stringify({ hash: HASH }));
    expect(written).toContain(HASH);
    expect(written).not.toContain("event-harbor-key");
    expect(statusLine).toContain("provider=quicknode-webhook");
    expect(statusLine).toContain("latency_ms=875");
    expect(statusLine).not.toContain("mock-only");
  });

  it("rejects non-webhook or mismatched live evidence", async () => {
    const files = new Map([
      ["/tmp/standin.json", JSON.stringify(payload())],
    ]);
    const evidence = (provider: string, hash = HASH) => new Response(JSON.stringify({
        ok: true,
        data: {
          hash,
          account: ACCOUNT,
          tx_type: "Payment",
          result: "tesSUCCESS",
          ledger_index: 123,
          received_at: "2026-10-21T20:00:00.000Z",
          execution: {
            id: "execution-live",
            confirmed_by: provider,
            confirmed_at: "2026-10-21T20:00:01.000Z",
            latency_ms: 1_000,
          },
        },
      }), { status: 200 });
    const dependencies = {
      env: { HARBOR_API_KEY: "event-harbor-key" },
      readFile: (async (path: unknown) => files.get(String(path)) ?? "") as never,
      appendFile: (async () => undefined) as never,
      stdout: { write: () => true },
    };
    await expect(runQ3Webhook([
      "--mode", "live", "--hash", HASH,
      "--standin-payload", "/tmp/standin.json",
      "--harbor-url", "http://127.0.0.1:8799",
    ], {
      ...dependencies,
      fetcher: (async () => evidence("poll")) as typeof fetch,
    })).rejects.toThrow("QN_WEBHOOK_EVIDENCE_INVALID");
    await expect(runQ3Webhook([
      "--mode", "live", "--hash", HASH,
      "--standin-payload", "/tmp/standin.json",
      "--harbor-url", "http://127.0.0.1:8799",
    ], {
      ...dependencies,
      fetcher: (async () => evidence("quicknode-webhook", "C".repeat(64))) as typeof fetch,
    })).rejects.toThrow(/does not match/);
  });

  it("requires the bounded xrp-testnet delivery envelope", () => {
    expect(() => sanitizeWalletPayload({
      data: (payload() as { data: unknown[] }).data,
      metadata: { network: "xrp-mainnet" },
    })).toThrow();
    expect(() => sanitizeWalletPayload({
      payload: (payload() as { data: unknown[] }).data,
      metadata: { network: "xrp-testnet" },
    })).toThrow();
  });

  it("rejects an execution hash absent from the delivery", async () => {
    const files = new Map([
      ["/tmp/real.json", JSON.stringify(payload())],
      ["/tmp/standin.json", JSON.stringify(payload())],
      ["/tmp/execution.json", JSON.stringify({
        ok: true,
        data: {
          status: "executed",
          hash: "C".repeat(64),
          confirmation: {
            provider: "quicknode-mock",
            at: "2026-10-21T20:00:00.000Z",
            latency_ms: 1,
          },
        },
      })],
    ]);
    await expect(runQ3Webhook([
      "--mode", "mock", "--payload", "/tmp/real.json",
      "--standin-payload", "/tmp/standin.json",
      "--execution", "/tmp/execution.json",
    ], {
      readFile: (async (path) => files.get(String(path)) ?? "") as never,
      appendFile: (async () => undefined) as never,
      stdout: { write: () => true },
    })).rejects.toThrow(/absent/);
  });
});
