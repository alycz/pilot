import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { QuickNodeKvRegistry } from "../src/quicknode/kv-registry";
import { createQnLocalServer } from "../tools/qn-local/src/server";
import type { QnLocalStore } from "../tools/qn-local/src/store";

const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const DELEGATE = "rJdYtgaiEgzL7xD2QdPKg5xoHkWc7CZjvm";

class MemoryQnStore implements QnLocalStore {
  readonly lists = new Map<string, string[]>();
  readonly values = new Map<string, unknown>();

  async putList(key: string, items: string[]): Promise<string[]> {
    const next = [...new Set(items)];
    this.lists.set(key, next);
    return next;
  }

  async patchList(
    key: string,
    addItems: string[],
    removeItems: string[],
  ): Promise<string[]> {
    const removed = new Set(removeItems);
    const next = [...new Set([...(this.lists.get(key) ?? []), ...addItems])]
      .filter((item) => !removed.has(item));
    this.lists.set(key, next);
    return next;
  }

  async getList(key: string): Promise<string[] | undefined> {
    return this.lists.get(key);
  }

  async deleteList(key: string): Promise<boolean> {
    return this.lists.delete(key);
  }

  async putValue(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  async getValue(key: string): Promise<unknown> {
    return this.values.get(key);
  }
}

describe("QuickNode KV registry local stand-in", () => {
  const servers: ReturnType<typeof createQnLocalServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
    );
  });

  it("places a linked testnet account and delegate in run-scoped lists", async () => {
    const store = new MemoryQnStore();
    const server = createQnLocalServer({ store });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const registry = new QuickNodeKvRegistry({
      env: {
        EXEC_NETWORK: "testnet",
        HARBOR_LOCAL_DEV: "true",
        QN_API_BASE: `http://127.0.0.1:${address.port}`,
        QN_MODE: "mock",
        QN_RUN_TAG: "standin",
      },
      runtimeLocal: true,
      requestLocal: true,
    });

    await expect(registry.link("testnet", OWNER, DELEGATE)).resolves.toEqual([
      { ok: true, skipped: false },
      { ok: true, skipped: false },
    ]);
    expect(store.lists.get("harbor_testnet_standin_accounts")).toEqual([
      OWNER,
    ]);
    expect(store.lists.get("harbor_testnet_standin_delegates")).toEqual([
      DELEGATE,
    ]);
  });
});
