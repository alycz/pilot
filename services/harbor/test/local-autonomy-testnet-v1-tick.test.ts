import { describe, expect, it, vi } from "vitest";

import {
  LOCAL_AUTONOMY_TESTNET_V1_ORIGIN,
  LOCAL_AUTONOMY_TESTNET_V1_SCHEDULED_URL,
} from "../scripts/dev-local-autonomy-testnet-v1.mjs";
import {
  collectTickEvidence,
  main,
  parseTickArguments,
  scrubEvidence,
} from "../scripts/run-local-autonomy-testnet-v1-tick.mjs";

const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const options = {
  acceptanceId: "scheduled-buy-001",
  owner: OWNER,
  strategyId: "strategy:test:1",
};
const apiCredential = `autonomy-acceptance:${"A".repeat(32)}`;
const kek = Buffer.alloc(32, 7).toString("base64");

describe("local autonomy Testnet v1 tick evidence", () => {
  it("requires an exact bounded Testnet scope and rejects remote controls", () => {
    expect(parseTickArguments([
      "--strategy-id=strategy:test:1",
      `--owner=${OWNER}`,
      "--acceptance-id=scheduled-buy-001",
    ])).toEqual(options);
    for (const args of [
      ["--remote"],
      ["--acceptance-id=x", `--owner=${OWNER}`],
      ["--acceptance-id=../x", `--owner=${OWNER}`, "--strategy-id=s"],
      ["--acceptance-id=x", "--owner=not-an-account", "--strategy-id=s"],
      ["--acceptance-id=x", `--owner=${OWNER}`, "--strategy-id=s", "--output=/tmp/x"],
    ]) expect(() => parseTickArguments(args)).toThrow();
  });

  it("removes credentials, proofs, signatures, transaction blobs, and secret-valued strings", () => {
    const evidence = scrubEvidence({
      transaction_hash: "ABC123",
      mandate_digest: "DEF456",
      authorization: { signature: "signed", public_key: "public" },
      tx_blob: "blob",
      idempotency_key: "decision-key",
      nested: { note: `leak ${apiCredential}` },
    }, [apiCredential]);
    expect(evidence).toEqual({
      transaction_hash: "ABC123",
      mandate_digest: "DEF456",
      nested: { note: "[REDACTED]" },
    });
  });

  it("captures authenticated before/after state around one bounded local scheduler tick", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === LOCAL_AUTONOMY_TESTNET_V1_SCHEDULED_URL) {
        expect(init?.method).toBe("GET");
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        return new Response("scheduled", { status: 200 });
      }
      expect(url.startsWith(`${LOCAL_AUTONOMY_TESTNET_V1_ORIGIN}/api/ops/`)).toBe(true);
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${apiCredential}`,
      );
      const operation = url.split("/").at(-1);
      const body = JSON.parse(String(init?.body));
      expect(body.network).toBe("testnet");
      expect(body.owner).toBe(OWNER);
      if (operation?.startsWith("strategy.")) {
        expect(body.strategy_id).toBe(options.strategyId);
      }
      return Response.json({
        ok: true,
        data: operation === "strategy.audit"
          ? [{ kind: "submitted", detail: { transaction_hash: "ABC123", tx_blob: "secret-blob" } }]
          : { operation, mandate_digest: "D".repeat(64), authorization: { signature: "secret" } },
      });
    });

    const evidence = await collectTickEvidence(options, {
      fetchImpl,
      readCredentials: async () => ({
        HARBOR_API_KEYS: apiCredential,
        HARBOR_KEK: kek,
      }),
      now: () => new Date("2026-10-23T12:00:00.000Z"),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(7);
    expect(evidence).toMatchObject({
      schema: "harbor.local-autonomy-testnet.tick-evidence.v1",
      acceptance_id: options.acceptanceId,
      captured_at: "2026-10-23T12:00:00.000Z",
      profile: { network: "testnet", mainnet: false },
      scope: { owner: OWNER, strategy_id: options.strategyId },
      scheduled: { status: 200, body: "scheduled" },
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).toContain("ABC123");
    expect(serialized).toContain("mandate_digest");
    expect(serialized).not.toContain(apiCredential);
    expect(serialized).not.toContain(kek);
    expect(serialized).not.toContain("secret-blob");
    expect(serialized).not.toContain("signature");
  });

  it("writes once to the fixed evidence directory only after state checks", async () => {
    const sequence: string[] = [];
    const writeEvidence = vi.fn(async (path: string, contents: string, options: object) => {
      sequence.push("write");
      expect(path).toMatch(/\/absolute\/private\/pilot\/harbor-state\/harbor-autonomy-testnet-v1\/evidence\/scheduled-buy-001\.json$/);
      expect(options).toEqual({ encoding: "utf8", flag: "wx", mode: 0o600 });
      expect(JSON.parse(contents)).toEqual({ schema: "test" });
    });
    await main([
      "--acceptance-id=scheduled-buy-001",
      `--owner=${OWNER}`,
      "--strategy-id=strategy:test:1",
    ], {
      ensureState: async () => { sequence.push("state"); },
      ensureEvidence: async () => { sequence.push("evidence"); },
      collect: async () => ({ schema: "test" }),
      writeEvidence,
    });
    expect(sequence).toEqual(["state", "evidence", "write"]);
  });
});
