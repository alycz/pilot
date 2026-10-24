import { beforeEach, describe, expect, it, vi } from "vitest";

import { OpRegistry, type OpContext } from "../../src/catalog/registry";
import { TxBuildSchema, type TxBuild } from "../../src/contracts";
import {
  createXrplRpc,
  type XrplRpc,
} from "../../src/adapters/xrpl-rpc";
import {
  clearUsdMidCache,
  type BuildStore,
  type XrplAmount,
} from "../../src/exec/build";
import { createHarborProvider } from "../../src/executor/providers";
import type { BuildInsert } from "../../src/exec/store";
import { ops as txOps } from "../../src/ops/tx";

// Supply only the fresh owner's public address. This smoke never loads a seed
// file and never signs or submits a transaction.
const owner = process.env.H_SAFETY_TEST_OWNER_TESTNET_ADDRESS;
const RLUSD = "524C555344000000000000000000000000000000";
const TESTNET_RLUSD_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";

type BookResult = Record<string, unknown>;

function liveContext() {
  const inserted: BuildInsert[] = [];
  const commands: string[] = [];
  const books: BookResult[] = [];
  const live = createXrplRpc();
  const xrplRpc: XrplRpc = {
    request: async (network, command, params, options) => {
      if (
        command === "submit" ||
        command === "submit_multisigned" ||
        command === "wallet_propose" ||
        command.startsWith("sign")
      ) {
        throw new Error(`forbidden live command: ${command}`);
      }
      commands.push(command);
      const result = await live.request(network, command, params, options);
      if (network === "mainnet" && command === "book_offers") {
        books.push(result);
      }
      return result;
    },
  };
  const store: BuildStore = {
    insertBuild: vi.fn(async (input) => {
      inserted.push(input);
      return input;
    }),
    getLink: vi.fn(async () => null),
  };
  const provider = createHarborProvider(new OpRegistry(txOps), {
    principal: "h-path-p15-live",
    sourceTag: 2610240,
    xrplRpc,
    store,
  } as OpContext);
  return { provider, inserted, commands, books };
}

async function invoke(
  provider: ReturnType<typeof createHarborProvider>,
  name: string,
  args: Record<string, unknown>,
): Promise<TxBuild> {
  const result = await provider.invoke(name, args);
  if (!result.ok) throw new Error(`${name} live operation failed`);
  return TxBuildSchema.parse(result.data);
}

function safeBuild(build: TxBuild): void {
  expect(build.simulate.applied).toBe(false);
  expect(JSON.stringify(build)).not.toMatch(
    /SigningPubKey|TxnSignature|Signers|Signature|tx_blob|txBlob|Delegate/,
  );
}

function amountValue(amount: XrplAmount): { xrp?: number; usd?: number } {
  if (typeof amount === "string") return { xrp: Number(amount) / 1_000_000 };
  if (
    amount.currency.toUpperCase() ===
      "524C555344000000000000000000000000000000" &&
    amount.issuer === "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De"
  ) {
    return { usd: Number(amount.value) };
  }
  return {};
}

function bookPrice(result: BookResult): number {
  const offer = (result.offers as Record<string, unknown>[])[0];
  const gets = amountValue(
    (offer.taker_gets_funded ?? offer.TakerGets) as XrplAmount,
  );
  const pays = amountValue(
    (offer.taker_pays_funded ?? offer.TakerPays) as XrplAmount,
  );
  const xrp = gets.xrp ?? pays.xrp;
  const usd = gets.usd ?? pays.usd;
  if (!xrp || !usd) throw new Error("live book lacks a positive XRP/RLUSD top offer");
  return usd / xrp;
}

describe.skipIf(!owner)("H-path P1.5 live acceptance", () => {
  beforeEach(() => clearUsdMidCache());

  it("simulates named and raw TrustSet builders successfully", async () => {
    const { provider, inserted, commands } = liveContext();
    const limit = {
      currency: RLUSD,
      issuer: TESTNET_RLUSD_ISSUER,
      value: "1",
    };
    const named = await invoke(provider, "tx.trustSet", {
      network: "testnet",
      account: owner,
      limit_amount: limit,
      intent_id: "h-path-live-trustset",
    });
    const raw = await invoke(provider, "tx.simulate", {
      network: "testnet",
      account: owner,
      tx_json: {
        TransactionType: "TrustSet",
        Account: owner,
        LimitAmount: limit,
      },
      intent_id: "h-path-live-raw-trustset",
    });
    for (const build of [named, raw]) {
      safeBuild(build);
      expect(build.simulate.engine_result).toBe("tesSUCCESS");
      expect(build.preflight.every(({ pass }) => pass)).toBe(true);
      expect(build.summary.usd_value).toBeUndefined();
    }
    expect(inserted).toHaveLength(2);
    expect(commands.some((command) => command === "submit")).toBe(false);
    expect(commands.some((command) => command.startsWith("sign"))).toBe(false);
  });

  it("uses both live mainnet book sides once and reuses the midpoint cache", async () => {
    const { provider, inserted, commands, books } = liveContext();
    const input = {
      network: "testnet",
      account: owner,
      taker_gets: { currency: "HBR", issuer: owner, value: "1" },
      taker_pays: "1000",
    };
    const first = await invoke(provider, "tx.offer", {
      ...input,
      intent_id: "h-path-live-offer-one",
    });
    const second = await invoke(provider, "tx.offer", {
      ...input,
      intent_id: "h-path-live-offer-two",
    });
    for (const build of [first, second]) {
      safeBuild(build);
      expect(build.simulate.engine_result).toBe("tesSUCCESS");
      expect(build.preflight.every(({ pass }) => pass)).toBe(true);
      expect(Number(build.summary.usd_value)).toBeGreaterThan(0);
    }
    expect(books).toHaveLength(2);
    const expected = ((bookPrice(books[0]) + bookPrice(books[1])) / 2) * 0.001;
    expect(Number(first.summary.usd_value)).toBeCloseTo(expected, 6);
    expect(second.summary.usd_value).toBe(first.summary.usd_value);
    expect(inserted.map(({ summary }) => summary.usd_value)).toEqual([
      first.summary.usd_value,
      second.summary.usd_value,
    ]);
    expect(commands.filter((command) => command === "book_offers")).toHaveLength(2);
    expect(commands.some((command) => command === "submit")).toBe(false);
  });

  it("returns a typed missing-trust-line preflight failure", async () => {
    const { provider, inserted } = liveContext();
    const build = await invoke(provider, "tx.payment", {
      network: "testnet",
      account: owner,
      destination: TESTNET_RLUSD_ISSUER,
      destination_tag: 0,
      amount: {
        currency: RLUSD,
        issuer: TESTNET_RLUSD_ISSUER,
        value: "1",
      },
      intent_id: "h-path-live-missing-trust-line",
    });
    safeBuild(build);
    expect(
      build.preflight.some(
        ({ check, pass, detail }) =>
          check === "trust-line" &&
          pass === false &&
          detail?.startsWith("MISSING_TRUST_LINE:") === true,
      ),
    ).toBe(true);
    expect(build.simulate.engine_result).not.toBe("tesSUCCESS");
    expect(build.summary.usd_value).toBe("1");
    expect(inserted).toHaveLength(1);
  });
});
