import { EnvelopeSchema } from "@pilot/contracts";
import { describe, expect, it } from "vitest";

import { HarborArgsSchemas, HarborResultSchemas } from "../src/index.js";

const account = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const issuer = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const hash = "A".repeat(64);
const mpt = "000000015769E4B6EC73C86F4A12C652FE1261C369B74928";

const artifact = {
  fixture_kind: "deterministic-synthetic-hosted-read",
  note: "Synthetic schema and redaction fixture; not hosted, ledger, deployment, or acceptance evidence.",
  reads: [
    {
      op: "ledger.account.info",
      request: { account, network: "testnet", ledger_index: "validated" },
      response: { ok: true, data: { account_data: { Account: account }, ledger_index: 1, validated: true }, asOf: "1970-01-01T00:00:00.000Z", asOfBasis: "deterministic synthetic fixture" },
    },
    {
      op: "ledger.account.lines",
      request: { account, network: "testnet", ledger_index: "validated", limit: 20 },
      response: { ok: true, data: { account, ledger_index: 1, validated: true, lines: [] }, asOf: "1970-01-01T00:00:00.000Z", asOfBasis: "deterministic synthetic fixture" },
    },
    {
      op: "dex.depth",
      request: {
        network: "testnet",
        taker_gets: { currency: "XRP" },
        taker_pays: { currency: "524C555344000000000000000000000000000000", issuer },
        ledger_index: "validated",
        limit: 20,
      },
      response: {
        ok: true,
        asOf: "1970-01-01T00:00:00.000Z",
        asOfBasis: "deterministic synthetic fixture",
        data: {
          network: "testnet",
          taker_gets: { currency: "XRP" },
          taker_pays: { currency: "524C555344000000000000000000000000000000", issuer },
          ledger_index: 1,
          levels: [],
          totals: { taker_gets: "0", taker_pays: "0", offer_count: 0 },
        },
      },
    },
    {
      op: "vault.info",
      request: { network: "devnet", vault_id: hash },
      response: {
        ok: true,
        asOf: "1970-01-01T00:00:00.000Z",
        asOfBasis: "deterministic synthetic fixture",
        data: {
          network: "devnet",
          ledger_index: 1,
          validated: false,
          vault: {
            Account: account,
            Asset: { currency: "XRP" },
            Flags: 0,
            LedgerEntryType: "Vault",
            Owner: account,
            OwnerNode: "0",
            PreviousTxnID: hash,
            PreviousTxnLgrSeq: 1,
            Sequence: 1,
            ShareMPTID: mpt,
            WithdrawalPolicy: 1,
            index: hash,
            shares: {
              Flags: 0,
              Issuer: account,
              LedgerEntryType: "MPTokenIssuance",
              OutstandingAmount: "0",
              OwnerNode: "0",
              PreviousTxnID: hash,
              PreviousTxnLgrSeq: 1,
              Sequence: 1,
              index: hash,
              mpt_issuance_id: mpt,
            },
          },
          risks: ["Deterministic synthetic fixture only."],
        },
      },
    },
  ],
} as const;

describe("synthetic hosted-read contract fixture", () => {
  it("is visibly synthetic and contains no deployment or authorization evidence", () => {
    expect(artifact.fixture_kind).toBe("deterministic-synthetic-hosted-read");
    expect(artifact.note).toContain("not hosted");
    expect(JSON.stringify(artifact)).not.toMatch(/authorization|api[_-]?key|signed[_-]?blob/i);
  });

  it("parses every request and response through production schemas", () => {
    for (const read of artifact.reads) {
      HarborArgsSchemas[read.op].parse(read.request);
      EnvelopeSchema(HarborResultSchemas[read.op]).parse(read.response);
    }
  });
});
