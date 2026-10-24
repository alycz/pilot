import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OpContext, OpDef } from "../src/catalog/registry";
import {
  clearVaultPositionsCacheForTests,
  ops,
  VaultPositionsResponseSchema,
} from "../src/ops/vault-positions";

const HOLDER = "rJdYtgaiEgzL7xD2QdPKg5xoHkWc7CZjvm";
const VAULT_ACCOUNT = "rQhUcbJoDfvgXr1EkMwarLP5QT3XinEBDg";
const VAULT_OWNER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const SHARE_MPT_ID = "00000001FCE5D5E313303F3D0C700789108CC6BE7D711493";
const OTHER_MPT_ID = "00000002FCE5D5E313303F3D0C700789108CC6BE7D711493";
const VAULT_ID = "9E48171960CD9F62C3A7B6559315A510AE544C3F51E02947B5D4DAC8AA66C3BA";
const LEDGER_INDEX = 3_280_200;
const LEDGER_HASH = "A".repeat(64);
const ACCOUNT_ID_HEX = SHARE_MPT_ID.slice(8);

function issuanceId(sequence: number): string {
  return `${sequence.toString(16).padStart(8, "0")}${ACCOUNT_ID_HEX}`.toUpperCase();
}

function operation(): OpDef {
  const op = ops.find(({ name }) => name === "vault.positions");
  if (!op) throw new Error("Missing vault.positions");
  return op;
}

function context(request: ReturnType<typeof vi.fn>): OpContext {
  return { principal: "vault-positions-fixture", xrplRpc: { request } };
}

function holderPage(
  accountObjects: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
) {
  return {
    account: HOLDER,
    account_objects: accountObjects,
    ledger_hash: LEDGER_HASH,
    ledger_index: LEDGER_INDEX,
    status: "success",
    validated: true,
    ...overrides,
  };
}

function mptoken(
  issuanceId = SHARE_MPT_ID,
  amount = "25",
  lockedAmount: string | undefined = "2",
) {
  return {
    Account: HOLDER,
    LedgerEntryType: "MPToken",
    ...(lockedAmount === undefined ? {} : { LockedAmount: lockedAmount }),
    MPTAmount: amount,
    MPTokenIssuanceID: issuanceId,
    MPTokenMetadata: "74686973206D757374206E6F7420657363617065",
  };
}

function issuance(overrides: Record<string, unknown> = {}) {
  return {
    ledger_hash: LEDGER_HASH,
    ledger_index: LEDGER_INDEX,
    node: {
      Issuer: VAULT_ACCOUNT,
      LedgerEntryType: "MPTokenIssuance",
      MPTokenMetadata: "6D65746164617461",
      Sequence: 1,
      ...overrides,
    },
    status: "success",
    validated: true,
  };
}

function vault(overrides: Record<string, unknown> = {}) {
  return {
    Account: VAULT_ACCOUNT,
    Asset: { currency: "XRP" },
    AssetsAvailable: "24000000",
    AssetsTotal: "25000000",
    Data: "74657874206D757374206E6F7420657363617065",
    Flags: 65_536,
    LedgerEntryType: "Vault",
    Owner: VAULT_OWNER,
    Sequence: 3_113_728,
    ShareMPTID: SHARE_MPT_ID,
    VaultKind: 0,
    WithdrawalPolicy: 1,
    index: VAULT_ID,
    ...overrides,
  };
}

beforeEach(() => {
  clearVaultPositionsCacheForTests();
});

describe("vault.positions", () => {
  it("pins every dependent read and returns only structured ledger fields", async () => {
    const request = vi.fn(
      async (_network: string, command: string, params: Record<string, unknown>) => {
        if (command === "ledger_entry") return issuance();
        if (params.type === "vault") {
          return holderPage([vault()], {
            account: VAULT_ACCOUNT,
            marker: "unrelated-hostile-next-page-text",
          });
        }
        return holderPage([mptoken()], { marker: "holder-next" });
      },
    );

    const result = await operation().handler(context(request), {
      network: "devnet",
      account: HOLDER,
      limit: 25,
    });

    expect(result).toMatchObject({
      account: HOLDER,
      ledger_hash: LEDGER_HASH,
      ledger_index: LEDGER_INDEX,
      network: "devnet",
      positions: [
        {
          asset: { currency: "XRP" },
          assets_available: "24000000",
          assets_total: "25000000",
          flags: 65_536,
          locked_balance: "2",
          mpt_issuance_id: SHARE_MPT_ID,
          share_balance: "25",
          share_asset_scale: 0,
          share_issuer: VAULT_ACCOUNT,
          vault_account: VAULT_ACCOUNT,
          vault_id: VAULT_ID,
          vault_kind: 0,
          vault_owner: VAULT_OWNER,
          vault_sequence: 3_113_728,
          withdrawal_policy: 1,
        },
      ],
      validated: true,
    });
    expect(result).toHaveProperty(
      "marker",
      expect.stringMatching(/^v1\.[a-f0-9]{64}$/),
    );
    expect(VaultPositionsResponseSchema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(
      /metadata|\bdata\b|apr|usd|holder-next|hostile-next/i,
    );
    expect(request).toHaveBeenNthCalledWith(
      1,
      "devnet",
      "account_objects",
      {
        account: HOLDER,
        ledger_index: "validated",
        limit: 25,
        type: "mptoken",
      },
      undefined,
    );
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenNthCalledWith(
      2,
      "devnet",
      "ledger_entry",
      { ledger_hash: LEDGER_HASH, mpt_issuance: SHARE_MPT_ID },
      undefined,
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      "devnet",
      "account_objects",
      {
        account: VAULT_ACCOUNT,
        ledger_hash: LEDGER_HASH,
        limit: 100,
        type: "vault",
      },
      undefined,
    );
  });

  it("projects MPToken AssetScale so callers never label base units as whole shares", async () => {
    const request = vi.fn(
      async (_network: string, command: string, params: Record<string, unknown>) => {
        if (command === "ledger_entry") return issuance({ AssetScale: 2 });
        if (params.type === "vault") {
          return holderPage([vault()], { account: VAULT_ACCOUNT });
        }
        return holderPage([mptoken(SHARE_MPT_ID, "12345", "67")]);
      },
    );

    await expect(
      operation().handler(context(request), {
        network: "devnet",
        account: HOLDER,
      }),
    ).resolves.toMatchObject({
      positions: [{
        share_balance: "12345",
        locked_balance: "67",
        share_asset_scale: 2,
      }],
    });
  });

  it.each([
    ["negative MPT amount", { share_balance: "-1" }],
    ["leading-zero MPT amount", { share_balance: "01" }],
    ["uint64 overflow", { share_balance: "18446744073709551616" }],
    ["negative locked amount", { locked_balance: "-1" }],
    ["exponent vault amount", { assets_total: "1e3" }],
    ["negative vault amount", { assets_total: "-1" }],
    ["leading-zero vault amount", { assets_total: "01" }],
    ["over-precision vault amount", { assets_total: "12345678901234567" }],
    ["over-magnitude vault amount", { assets_total: "1" + "0".repeat(81) }],
  ])("rejects hostile or noncanonical public numeric strings: %s", (_label, override) => {
    const candidate = {
      asset: { currency: "XRP" },
      assets_available: "24000000",
      assets_total: "25000000",
      flags: 0,
      locked_balance: "2",
      mpt_issuance_id: SHARE_MPT_ID,
      share_balance: "25",
      share_asset_scale: 0,
      share_issuer: VAULT_ACCOUNT,
      vault_account: VAULT_ACCOUNT,
      vault_id: VAULT_ID,
      vault_owner: VAULT_OWNER,
      vault_sequence: 1,
      withdrawal_policy: 1,
      ...override,
    };
    expect(VaultPositionsResponseSchema.safeParse({
      account: HOLDER,
      ledger_hash: LEDGER_HASH,
      ledger_index: LEDGER_INDEX,
      network: "devnet",
      positions: [candidate],
      validated: true,
    }).success).toBe(false);
  });

  it("round-trips an opaque continuation token to the raw XRPL marker", async () => {
    const rawMarker = { ledger: LEDGER_INDEX, token: "hostile raw text" };
    const request = vi
      .fn()
      .mockResolvedValueOnce(holderPage([], { marker: rawMarker }))
      .mockResolvedValueOnce(holderPage([]));

    const first = (await operation().handler(context(request), {
      network: "devnet",
      account: HOLDER,
      ledger_index: LEDGER_INDEX,
      limit: 1,
    })) as { marker: string };
    expect(first.marker).toMatch(/^v1\.[a-f0-9]{64}$/);
    expect(first.marker).not.toContain("hostile raw text");
    expect(first.marker).not.toContain(
      Buffer.from(JSON.stringify(rawMarker), "utf8").toString("base64url"),
    );

    await expect(
      operation().handler(context(request), {
        network: "devnet",
        account: HOLDER,
        ledger_index: LEDGER_INDEX,
        limit: 1,
        marker: first.marker,
      }),
    ).resolves.toEqual({
      account: HOLDER,
      ledger_hash: LEDGER_HASH,
      ledger_index: LEDGER_INDEX,
      network: "devnet",
      positions: [],
      validated: true,
    });
    expect(request).toHaveBeenNthCalledWith(
      2,
      "devnet",
      "account_objects",
      {
        account: HOLDER,
        ledger_hash: LEDGER_HASH,
        limit: 1,
        marker: rawMarker,
        type: "mptoken",
      },
      undefined,
    );
  });

  it("skips unrelated entries, zero balances, and non-vault issuances", async () => {
    const request = vi.fn(
      async (_network: string, command: string, params: Record<string, unknown>) => {
        if (command === "ledger_entry") return issuance();
        if (params.type === "vault") {
          return holderPage([vault({ ShareMPTID: OTHER_MPT_ID })], {
            account: VAULT_ACCOUNT,
          });
        }
        return holderPage([
          { LedgerEntryType: "Offer", TakerGets: "text" },
          mptoken(SHARE_MPT_ID, "0", undefined),
          mptoken(SHARE_MPT_ID, "4"),
        ]);
      },
    );

    await expect(
      operation().handler(context(request), {
        network: "devnet",
        account: HOLDER,
      }),
    ).resolves.toMatchObject({ positions: [] });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("paginates issuer vaults and reuses bounded per-ledger caches", async () => {
    let vaultPageCalls = 0;
    const request = vi.fn(
      async (_network: string, command: string, params: Record<string, unknown>) => {
        if (command === "ledger_entry") return issuance();
        if (params.type === "vault") {
          vaultPageCalls += 1;
          return vaultPageCalls === 1
            ? holderPage([], {
                account: VAULT_ACCOUNT,
                marker: { page: 2 },
              })
            : holderPage([vault()], { account: VAULT_ACCOUNT });
        }
        return holderPage([mptoken()]);
      },
    );
    const args = { network: "devnet", account: HOLDER };

    await expect(operation().handler(context(request), args)).resolves.toMatchObject({
      positions: [{ mpt_issuance_id: SHARE_MPT_ID }],
    });
    await expect(operation().handler(context(request), args)).resolves.toMatchObject({
      positions: [{ mpt_issuance_id: SHARE_MPT_ID }],
    });

    expect(request.mock.calls.filter(([, command]) => command === "ledger_entry"))
      .toHaveLength(1);
    expect(
      request.mock.calls.filter(
        ([, command, params]) =>
          command === "account_objects" && params.type === "vault",
      ),
    ).toHaveLength(2);
    expect(request).toHaveBeenCalledWith(
      "devnet",
      "account_objects",
      {
        account: VAULT_ACCOUNT,
        ledger_hash: LEDGER_HASH,
        limit: 100,
        marker: { page: 2 },
        type: "vault",
      },
      undefined,
    );
  });

  it("rejects repeated issuer pagination markers", async () => {
    const request = vi.fn(
      async (_network: string, command: string, params: Record<string, unknown>) => {
        if (command === "ledger_entry") return issuance();
        if (params.type === "vault") {
          return holderPage([], { account: VAULT_ACCOUNT, marker: "repeat" });
        }
        return holderPage([mptoken()]);
      },
    );

    await expect(
      operation().handler(context(request), {
        network: "devnet",
        account: HOLDER,
      }),
    ).rejects.toThrow(/repeated a pagination marker/i);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("strictly rejects unsupported networks, bad bounds, and extra keys", () => {
    const schema = operation().args;
    expect(schema.safeParse({ network: "devnet", account: HOLDER }).success).toBe(
      true,
    );
    expect(schema.safeParse({ network: "testnet", account: HOLDER }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({ network: "devnet", account: "not-an-address" }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ network: "devnet", account: HOLDER, limit: 101 }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ network: "devnet", account: HOLDER, ledger_index: -1 })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ network: "devnet", account: HOLDER, marker: [] }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ network: "devnet", account: HOLDER, unexpected: true })
        .success,
    ).toBe(false);
  });

  it("accepts only strict opaque public continuation handle syntax", async () => {
    const schema = operation().args;
    const unknownHandle = `v1.${"a".repeat(64)}`;
    expect(
      schema.safeParse({
        network: "devnet",
        account: HOLDER,
        marker: unknownHandle,
      })
        .success,
    ).toBe(true);

    const invalidMarkers: unknown[] = [
      "raw-next-page",
      { page: 2 },
      "v1.",
      `v2.${"a".repeat(64)}`,
      `v1.${"A".repeat(64)}`,
      `v1.${"a".repeat(63)}`,
      `v1.${"a".repeat(65)}`,
      `v1.${"g".repeat(64)}`,
      `v1.${"a".repeat(63)}=`,
      `v1.${Buffer.from("hostile raw text").toString("base64url")}`,
    ];
    for (const marker of invalidMarkers) {
      expect(
        schema.safeParse({ network: "devnet", account: HOLDER, marker }).success,
      ).toBe(false);
    }

    const responseBase = {
      account: HOLDER,
      ledger_hash: LEDGER_HASH,
      ledger_index: LEDGER_INDEX,
      network: "devnet",
      positions: [],
      validated: true,
    };
    expect(
      VaultPositionsResponseSchema.safeParse({
        ...responseBase,
        marker: "raw-next-page",
      }).success,
    ).toBe(false);
    expect(
      VaultPositionsResponseSchema.safeParse({
        ...responseBase,
        marker: { page: 2 },
      }).success,
    ).toBe(false);

    const request = vi.fn();
    await expect(
      operation().handler(context(request), {
        network: "devnet",
        account: HOLDER,
        marker: unknownHandle,
      }),
    ).rejects.toThrow(/unknown or expired/i);
    expect(request).not.toHaveBeenCalled();
  });

  it("binds continuation tokens to network, account, ledger hash, and index", async () => {
    const request = vi.fn().mockResolvedValue(
      holderPage([], { marker: { page: 2 } }),
    );
    const first = (await operation().handler(context(request), {
      network: "devnet",
      account: HOLDER,
    })) as { marker: string };
    request.mockClear();

    await expect(
      operation().handler(context(request), {
        network: "lending-devnet",
        account: HOLDER,
        marker: first.marker,
      }),
    ).rejects.toThrow(/does not match/i);
    await expect(
      operation().handler(context(request), {
        network: "devnet",
        account: VAULT_OWNER,
        marker: first.marker,
      }),
    ).rejects.toThrow(/does not match/i);
    await expect(
      operation().handler(context(request), {
        network: "devnet",
        account: HOLDER,
        ledger_index: LEDGER_INDEX + 1,
        marker: first.marker,
      }),
    ).rejects.toThrow(/does not match/i);
    expect(request).not.toHaveBeenCalled();

    request.mockResolvedValueOnce(
      holderPage([], { ledger_hash: "B".repeat(64) }),
    );
    await expect(
      operation().handler(context(request), {
        network: "devnet",
        account: HOLDER,
        marker: first.marker,
      }),
    ).rejects.toThrow(/different ledger/i);
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects a continuation handle after its private cache entry is cleared", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(holderPage([], { marker: "private-raw-marker" }));
    const first = (await operation().handler(context(request), {
      network: "devnet",
      account: HOLDER,
    })) as { marker: string };
    clearVaultPositionsCacheForTests();
    request.mockClear();

    await expect(
      operation().handler(context(request), {
        network: "devnet",
        account: HOLDER,
        marker: first.marker,
      }),
    ).rejects.toThrow(/unknown or expired/i);
    expect(request).not.toHaveBeenCalled();
  });

  it("expires a continuation handle after the ten-minute TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T18:00:00.000Z"));
    try {
      const request = vi
        .fn()
        .mockResolvedValue(holderPage([], { marker: "ttl-private-marker" }));
      const first = (await operation().handler(context(request), {
        network: "devnet",
        account: HOLDER,
      })) as { marker: string };
      request.mockClear();

      vi.advanceTimersByTime(10 * 60 * 1_000);
      await expect(
        operation().handler(context(request), {
          network: "devnet",
          account: HOLDER,
          marker: first.marker,
        }),
      ).rejects.toThrow(/unknown or expired/i);
      expect(request).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts the oldest continuation handle when the cache exceeds 256 entries", async () => {
    let markerNumber = 0;
    const request = vi.fn(async () => {
      markerNumber += 1;
      return holderPage([], { marker: `private-marker-${markerNumber}` });
    });
    const handles: string[] = [];
    for (let index = 0; index < 257; index += 1) {
      const result = (await operation().handler(context(request), {
        network: "devnet",
        account: HOLDER,
      })) as { marker: string };
      handles.push(result.marker);
    }

    request.mockClear();
    await expect(
      operation().handler(context(request), {
        network: "devnet",
        account: HOLDER,
        marker: handles[0],
      }),
    ).rejects.toThrow(/unknown or expired/i);
    expect(request).not.toHaveBeenCalled();

    request.mockResolvedValueOnce(holderPage([]));
    await expect(
      operation().handler(context(request), {
        network: "devnet",
        account: HOLDER,
        marker: handles[256],
      }),
    ).resolves.toMatchObject({ positions: [] });
    expect(request).toHaveBeenCalledWith(
      "devnet",
      "account_objects",
      {
        account: HOLDER,
        ledger_hash: LEDGER_HASH,
        limit: 100,
        marker: "private-marker-257",
        type: "mptoken",
      },
      undefined,
    );
  });

  it("uses a fresh nonce for identical private continuation payloads", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(holderPage([], { marker: "same-private-marker" }));
    const first = (await operation().handler(context(request), {
      network: "devnet",
      account: HOLDER,
    })) as { marker: string };
    const second = (await operation().handler(context(request), {
      network: "devnet",
      account: HOLDER,
    })) as { marker: string };

    expect(first.marker).toMatch(/^v1\.[a-f0-9]{64}$/);
    expect(second.marker).toMatch(/^v1\.[a-f0-9]{64}$/);
    expect(second.marker).not.toBe(first.marker);
  });

  it.each([
    { validated: false },
    { ledger_index: LEDGER_INDEX + 1 },
    { account: VAULT_OWNER },
    { account: undefined },
    { ledger_hash: undefined },
  ])("rejects an invalid holder ledger response %#", async (override) => {
    const request = vi.fn().mockResolvedValue(holderPage([], override));
    await expect(
      operation().handler(context(request), {
        network: "devnet",
        account: HOLDER,
        ledger_index: LEDGER_INDEX,
      }),
    ).rejects.toThrow();
  });

  it.each([
    { ledger_index: LEDGER_INDEX + 1 },
    { ledger_hash: "B".repeat(64) },
  ])("rejects a dependent response that changes the ledger %#", async (override) => {
    const request = vi.fn(
      async (_network: string, command: string) =>
        command === "ledger_entry"
          ? { ...issuance(), ...override }
          : holderPage([mptoken()]),
    );
    await expect(
      operation().handler(context(request), {
        network: "devnet",
        account: HOLDER,
      }),
    ).rejects.toThrow(/different ledger/i);
  });

  it.each([
    { Issuer: VAULT_OWNER },
    { Sequence: 2 },
  ])("rejects an issuance ID with the wrong issuer or sequence %#", async (override) => {
    const request = vi.fn(
      async (_network: string, command: string) =>
        command === "ledger_entry"
          ? issuance(override)
          : holderPage([mptoken()]),
    );
    await expect(
      operation().handler(context(request), {
        network: "devnet",
        account: HOLDER,
      }),
    ).rejects.toThrow(/does not match its issuance ID/i);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects holder pages larger than the requested limit", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(holderPage([mptoken(), mptoken(OTHER_MPT_ID)]));
    await expect(
      operation().handler(context(request), {
        network: "devnet",
        account: HOLDER,
        limit: 1,
      }),
    ).rejects.toThrow(/exceeded the requested limit/i);
    expect(request).toHaveBeenCalledOnce();
  });

  it("enforces the per-invocation XRPL request budget", async () => {
    const tokens = Array.from({ length: 16 }, (_, index) =>
      mptoken(issuanceId(index + 1)),
    );
    const request = vi.fn(
      async (_network: string, command: string, params: Record<string, unknown>) => {
        if (command === "ledger_entry") {
          const id = params.mpt_issuance as string;
          return issuance({ Sequence: Number.parseInt(id.slice(0, 8), 16) });
        }
        if (params.type === "vault") {
          return holderPage([], { account: VAULT_ACCOUNT });
        }
        return holderPage(tokens);
      },
    );
    await expect(
      operation().handler(context(request), {
        network: "devnet",
        account: HOLDER,
      }),
    ).rejects.toThrow(/request budget/i);
    expect(request).toHaveBeenCalledTimes(32);
  });

  it("caps an issuer scan at four pages", async () => {
    let page = 0;
    const request = vi.fn(
      async (_network: string, command: string, params: Record<string, unknown>) => {
        if (command === "ledger_entry") return issuance();
        if (params.type === "vault") {
          page += 1;
          return holderPage([], {
            account: VAULT_ACCOUNT,
            marker: { page },
          });
        }
        return holderPage([mptoken()]);
      },
    );
    await expect(
      operation().handler(context(request), {
        network: "devnet",
        account: HOLDER,
      }),
    ).rejects.toThrow(/four-page limit/i);
    expect(request).toHaveBeenCalledTimes(6);
  });
});
