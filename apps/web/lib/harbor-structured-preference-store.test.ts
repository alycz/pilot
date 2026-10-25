import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  MAX_PREFERENCE_STATE_BYTES,
  type StructuredPreferenceScope,
} from "@pilot/vault";

import {
  HarborStructuredPreferenceStore,
  type HostedPersonalizationClient,
  type HostedPersonalizationResource,
} from "./harbor-structured-preference-store";

const SECRET = "test-session-secret-that-is-longer-than-thirty-two-bytes";
const scope: StructuredPreferenceScope = {
  tenantId: "pilot-hosted",
  owner: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
  network: "testnet",
};

class MemoryClient implements HostedPersonalizationClient {
  readonly rows = new Map<string, { ciphertext: string; contentDigest: string }>();
  readonly reads: Array<{ scopeId: string; resource: HostedPersonalizationResource }> = [];
  readonly writes: Array<{
    scopeId: string;
    resource: HostedPersonalizationResource;
    expectedDigest: string | null;
    contentDigest: string;
    ciphertext: string;
  }> = [];

  private key(input: { scopeId: string; resource: HostedPersonalizationResource }): string {
    return `${input.scopeId}:${input.resource}`;
  }

  async readPersonalization(input: {
    version: 1;
    scopeId: string;
    resource: HostedPersonalizationResource;
  }) {
    this.reads.push(input);
    return this.rows.get(this.key(input)) ?? { ciphertext: null, contentDigest: null };
  }

  async compareAndSwapPersonalization(input: {
    version: 1;
    scopeId: string;
    resource: HostedPersonalizationResource;
    expectedDigest: string | null;
    contentDigest: string;
    ciphertext: string;
  }) {
    this.writes.push(input);
    const key = this.key(input);
    const current = this.rows.get(key);
    if ((current?.contentDigest ?? null) !== input.expectedDigest) return { swapped: false };
    this.rows.set(key, {
      ciphertext: input.ciphertext,
      contentDigest: input.contentDigest,
    });
    return { swapped: true };
  }
}

describe("HarborStructuredPreferenceStore", () => {
  it("encrypts private snapshots and round-trips them without disclosing account scope", async () => {
    const client = new MemoryClient();
    const store = new HarborStructuredPreferenceStore(client, SECRET);
    const content = '{"schemaVersion":1,"revision":1,"records":[]}\n';

    await expect(store.compareAndSwap(scope, null, content)).resolves.toBe(true);
    await expect(store.read(scope)).resolves.toBe(content);

    expect(store.privateStorage).toBe("remote");
    expect(client.writes).toHaveLength(1);
    expect(client.writes[0]!.scopeId).toMatch(/^[0-9a-f]{64}$/);
    expect(client.writes[0]!.scopeId).not.toContain(scope.owner);
    expect(client.writes[0]!.ciphertext).not.toContain(content);
    expect(client.writes[0]!.ciphertext).not.toContain(scope.owner);
    expect(client.writes[0]!.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(client.writes[0]!.contentDigest).not.toBe(
      createHash("sha256").update(content, "utf8").digest("hex"),
    );
  });

  it("isolates owner, tenant, network, and resource while using digest CAS", async () => {
    const client = new MemoryClient();
    const store = new HarborStructuredPreferenceStore(client, SECRET);
    const content = '{"revision":1}\n';
    await expect(store.compareAndSwap(scope, null, content)).resolves.toBe(true);
    await expect(store.compareAndSwapWorkflowLessons(scope, null, content)).resolves.toBe(true);
    await expect(store.compareAndSwap(scope, "{}\n", '{"revision":2}\n')).resolves.toBe(false);

    await store.read({ ...scope, tenantId: "another-tenant" });
    await store.read({ ...scope, network: "mainnet" });
    await store.read({ ...scope, owner: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh" });

    const ids = new Set(client.reads.map((read) => read.scopeId));
    expect(ids).toHaveLength(3);
    expect(client.writes[0]!.resource).toBe("preferences");
    expect(client.writes[1]!.resource).toBe("workflow-lessons");
    expect(client.writes[2]!.expectedDigest).not.toBe(client.writes[0]!.contentDigest);
  });

  it("fails closed on a wrong secret, bound resource, digest, or incomplete row", async () => {
    const client = new MemoryClient();
    const store = new HarborStructuredPreferenceStore(client, SECRET);
    await store.compareAndSwap(scope, null, '{"revision":1}\n');
    const [key, row] = [...client.rows.entries()][0]!;

    const wrongSecretStore = new HarborStructuredPreferenceStore(client, `${SECRET}-different`);
    await expect(wrongSecretStore.read(scope)).resolves.toBeNull();
    expect(client.reads.at(-1)!.scopeId).not.toBe(client.writes[0]!.scopeId);

    const tampered = `${row.ciphertext.slice(0, -1)}${row.ciphertext.endsWith("A") ? "B" : "A"}`;
    client.rows.set(key, { ...row, ciphertext: tampered });
    await expect(store.read(scope)).rejects.toThrow(/authentication/i);

    client.rows.set(key, { ...row, contentDigest: "0".repeat(64) });
    await expect(store.read(scope)).rejects.toThrow(/authentication|digest/i);

    client.rows.set(key, { ...row, contentDigest: "not-a-digest" });
    await expect(store.read(scope)).rejects.toThrow(/inconsistent/i);

    client.rows.set(key, { ciphertext: row.ciphertext, contentDigest: null as never });
    await expect(store.read(scope)).rejects.toThrow(/inconsistent/i);
  });

  it("rejects weak keys, secrets in content, oversized content, and remote errors", async () => {
    const client = new MemoryClient();
    expect(() => new HarborStructuredPreferenceStore(client, "too-short")).toThrow(/32 bytes/i);
    const store = new HarborStructuredPreferenceStore(client, SECRET);
    await expect(store.compareAndSwap(scope, null, "secret: do-not-store"))
      .rejects.toThrow(/cannot contain/i);
    await expect(store.compareAndSwap(scope, null, "x".repeat(1_048_577)))
      .rejects.toThrow(/byte limit/i);

    const failing: HostedPersonalizationClient = {
      readPersonalization: async () => {
        throw new Error("hosted state unavailable");
      },
      compareAndSwapPersonalization: async () => {
        throw new Error("hosted state unavailable");
      },
    };
    const failingStore = new HarborStructuredPreferenceStore(failing, SECRET);
    await expect(failingStore.read(scope)).rejects.toThrow("hosted state unavailable");
    await expect(failingStore.compareAndSwap(scope, null, "{}\n"))
      .rejects.toThrow("hosted state unavailable");
  });

  it("round-trips an exact 1 MiB snapshot within the hosted ciphertext cap", async () => {
    const client = new MemoryClient();
    const store = new HarborStructuredPreferenceStore(client, SECRET);
    const first = "x".repeat(MAX_PREFERENCE_STATE_BYTES);
    const replacement = "y".repeat(MAX_PREFERENCE_STATE_BYTES);

    await expect(store.compareAndSwap(scope, null, first)).resolves.toBe(true);
    expect(Buffer.byteLength(client.writes[0]!.ciphertext, "utf8")).toBeLessThanOrEqual(1_398_358);
    await expect(store.read(scope)).resolves.toBe(first);

    await expect(store.compareAndSwap(scope, first, replacement)).resolves.toBe(true);
    expect(Buffer.byteLength(client.writes[1]!.ciphertext, "utf8")).toBeLessThanOrEqual(1_398_358);
    await expect(store.read(scope)).resolves.toBe(replacement);
  });
});
