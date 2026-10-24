import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { OpRegistry } from "../../src/catalog/registry";
import type { Network } from "../../src/contracts";
import { createHarborProvider } from "../../src/executor/providers";
import { ops as ammOps } from "../../src/ops/amm";
import { ops as dexOps } from "../../src/ops/dex";
import { ops as ledgerOps } from "../../src/ops/ledger";
import { ops as serverOps } from "../../src/ops/server";

function localDevValue(name: string): string | undefined {
  try {
    const line = readFileSync(".dev.vars", "utf8")
      .split(/\r?\n/)
      .find((candidate) => candidate.startsWith(`${name}=`));
    return line?.slice(name.length + 1).trim();
  } catch {
    return undefined;
  }
}

function configuredValue(name: string): string | undefined {
  return process.env[name] ?? localDevValue(name);
}

function walletAddresses(networkName: Network): string[] {
  const value = configuredValue(`TEST_WALLETS_${networkName.toUpperCase()}`);
  if (!value) return [];
  // Extract public addresses without parsing, printing, or otherwise using the
  // test-only signing material stored beside them.
  return [...value.matchAll(/"address"\s*:\s*"([^"]+)"/g)].map(
    (match) => match[1],
  );
}

function currencyCode(value: string): string | undefined {
  if (/^[A-Za-z0-9?!@#$%^&*<>(){}\[\]|]{3}$/.test(value)) return value;
  if (/^[A-Fa-f0-9]{40}$/.test(value)) return value.toUpperCase();
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length === 0 || bytes.length > 20) return undefined;
  return bytes.toString("hex").toUpperCase().padEnd(40, "0");
}

const configuredNetwork = configuredValue("EXEC_NETWORK");
const network: Network = configuredNetwork === "devnet" ? "devnet" : "testnet";
const addresses = walletAddresses(network);
const account = process.env.XRPL_SMOKE_ACCOUNT ?? addresses[0];
const destination = process.env.XRPL_SMOKE_DESTINATION ?? addresses[1];
const stableCode =
  network === "testnet" ? "RLUSD" : configuredValue("STABLE_CODE");
const stableIssuer =
  network === "testnet"
    ? "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV"
    : configuredValue("STABLE_ISSUER_DEVNET");
const stableCurrency = stableCode ? currencyCode(stableCode) : undefined;
const configured = Boolean(
  account && destination && stableIssuer && stableCurrency,
);

// The fixed Testnet RLUSD issuer is part of the build blueprint. Its longer
// currency code uses the canonical 40-hex XRPL representation.
const stable = {
  currency: stableCurrency ?? "",
  issuer: stableIssuer ?? "",
};

const calls: [string, Record<string, unknown>][] = account && destination
  ? [
      ["ledger.account.info", { network, account }],
      ["ledger.account.lines", { network, account }],
      ["ledger.account.objects", { network, account }],
      ["ledger.account.tx", { network, account, limit: 10 }],
      ["ledger.fee", { network }],
      ["server.reserves", { network }],
      [
        "dex.book",
        {
          network,
          taker_gets: { currency: "XRP" },
          taker_pays: stable,
        },
      ],
      [
        "dex.quote",
        {
          network,
          source_account: account,
          destination_account: destination,
          destination_amount: "1000000",
        },
      ],
      [
        "dex.depth",
        {
          network,
          taker_gets: { currency: "XRP" },
          taker_pays: stable,
        },
      ],
      [
        "amm.info",
        {
          network,
          asset: { currency: "XRP" },
          asset2: stable,
        },
      ],
      [
        "amm.position",
        {
          network,
          account,
          asset: { currency: "XRP" },
          asset2: stable,
        },
      ],
    ]
  : [];

describe.skipIf(!configured)("live XRPL P1.2 operations", () => {
  const registry = new OpRegistry([
    ...ledgerOps,
    ...serverOps,
    ...dexOps,
    ...ammOps,
  ]);
  const provider = createHarborProvider(registry, {
    principal: "live-smoke",
    env: {
      XRPL_TESTNET_URL: configuredValue("XRPL_TESTNET_URL"),
      XRPL_DEVNET_URL: configuredValue("XRPL_DEVNET_URL"),
    },
  });

  it.each(calls)("%s returns ok:true", async (operation, args) => {
    const result = await provider.invoke(operation, args);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.data).toBeTypeOf("object");
  });
});
