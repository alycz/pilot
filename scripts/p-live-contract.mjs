#!/usr/bin/env tsx

import { readFile } from "node:fs/promises";

import { createHarborRestClient } from "@pilot/harbor-client";

const PILOT_ENV_FILE = process.env.PILOT_ENV_FILE;
const OWNER = process.env.P_LIVE_TEST_ACCOUNT;
const RLUSD_ISSUER = process.env.P_LIVE_RLUSD_ISSUER;
const VAULT_ID = process.env.P_LIVE_VAULT_ID;

for (const [name, value] of Object.entries({ PILOT_ENV_FILE, P_LIVE_TEST_ACCOUNT: OWNER, P_LIVE_RLUSD_ISSUER: RLUSD_ISSUER, P_LIVE_VAULT_ID: VAULT_ID })) {
  if (!value) throw new Error(`${name} is required`);
}
const RLUSD = {
  currency: "524C555344000000000000000000000000000000",
  issuer: RLUSD_ISSUER,
};

function parseEnv(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    result[match[1]] = match[2].replace(/^(?:"(.*)"|'(.*)')$/, "$1$2");
  }
  return result;
}

async function main() {
  const environment = parseEnv(await readFile(PILOT_ENV_FILE, "utf8"));
  if (!environment.HARBOR_URL || !environment.HARBOR_API_KEY) {
    throw new Error("Hosted Harbor configuration is unavailable");
  }
  const client = createHarborRestClient({
    mock: false,
    baseUrl: environment.HARBOR_URL,
    apiKey: environment.HARBOR_API_KEY,
  });

  const results = await Promise.all([
    client.op("ledger.account.info", {
      account: OWNER,
      network: "testnet",
      ledger_index: "validated",
    }),
    client.op("ledger.account.lines", {
      account: OWNER,
      network: "testnet",
      ledger_index: "validated",
      limit: 20,
    }),
    client.op("ledger.account.objects", {
      account: OWNER,
      network: "testnet",
      ledger_index: "validated",
      limit: 20,
    }),
    client.op("ledger.account.tx", {
      account: OWNER,
      network: "testnet",
      limit: 20,
      forward: false,
    }),
    client.op("dex.depth", {
      network: "testnet",
      taker_gets: { currency: "XRP" },
      taker_pays: RLUSD,
      ledger_index: "validated",
      limit: 20,
    }),
    client.op("vault.info", { network: "devnet", vault_id: VAULT_ID }),
  ]);

  const names = [
    "ledger.account.info",
    "ledger.account.lines",
    "ledger.account.objects",
    "ledger.account.tx",
    "dex.depth",
    "vault.info",
  ];
  if (process.argv.includes("--capture")) {
    const requests = [
      { account: OWNER, network: "testnet", ledger_index: "validated" },
      { account: OWNER, network: "testnet", ledger_index: "validated", limit: 20 },
      { account: OWNER, network: "testnet", ledger_index: "validated", limit: 20 },
      { account: OWNER, network: "testnet", limit: 20, forward: false },
      { network: "testnet", taker_gets: { currency: "XRP" }, taker_pays: RLUSD, ledger_index: "validated", limit: 20 },
      { network: "devnet", vault_id: VAULT_ID },
    ];
    const relevant = [0, 1, 4, 5].map((index) => ({
      op: names[index],
      request: requests[index],
      response: results[index],
    }));
    process.stdout.write(`${JSON.stringify({
      capturedAt: new Date().toISOString(),
      captureContext: {
        endpoint: environment.HARBOR_URL,
        provenance: "Operator-requested runtime endpoint; this output does not attest deployment identity or acceptance.",
      },
      note: "Public test-ledger identifiers and typed Harbor envelopes only; no authorization material or signed blobs.",
      reads: relevant,
    }, null, 2)}\n`);
    return;
  }
  const summary = results.map((envelope, index) => {
    if (!envelope.ok) {
      throw new Error(`${names[index]} failed (${envelope.error.code ?? "unknown"})`);
    }
    const data = envelope.data;
    return {
      op: names[index],
      ok: true,
      ledgerIndex: data.ledger_index ?? null,
      validated: data.validated ?? null,
    };
  });
  process.stdout.write(`${JSON.stringify({ action: "hosted-contract-reads", results: summary })}\n`);
}

await main();
