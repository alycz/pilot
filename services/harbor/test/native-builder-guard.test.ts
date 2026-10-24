import { describe, expect, it } from "vitest";

import {
  collectUntrustedFields,
  OP_SCREENING_CLASSIFICATION,
  UNTRUSTED_FIELD_RULES,
} from "../src/guard/untrusted-fields";

const NATIVE_BUILDER_OPS = [
  "tx.escrowCreate",
  "tx.escrowFinish",
  "tx.escrowCancel",
  "tx.checkCreate",
  "tx.checkCash",
  "tx.checkCancel",
] as const;

const STRICT_TX_JSON_BY_OP: Record<
  (typeof NATIVE_BUILDER_OPS)[number],
  Record<string, unknown>
> = {
  "tx.escrowCreate": {
    TransactionType: "EscrowCreate",
    Destination: "rDestination",
    Amount: "1000000",
    FinishAfter: 900_000_000,
  },
  "tx.escrowFinish": {
    TransactionType: "EscrowFinish",
    Owner: "rEscrowOwner",
    OfferSequence: 7,
  },
  "tx.escrowCancel": {
    TransactionType: "EscrowCancel",
    Owner: "rEscrowOwner",
    OfferSequence: 7,
  },
  "tx.checkCreate": {
    TransactionType: "CheckCreate",
    Destination: "rDestination",
    SendMax: "1000000",
  },
  "tx.checkCash": {
    TransactionType: "CheckCash",
    CheckID: "A".repeat(64),
    Amount: "1000000",
  },
  "tx.checkCancel": {
    TransactionType: "CheckCancel",
    CheckID: "A".repeat(64),
  },
};

function strictTxBuildResult(opName: (typeof NATIVE_BUILDER_OPS)[number]) {
  return {
    build_id: `build-${opName}`,
    network: "testnet",
    tx_json: {
      Account: "rOwner",
      ...STRICT_TX_JSON_BY_OP[opName],
      Fee: "12",
      Sequence: 9,
      LastLedgerSequence: 12349,
      SigningPubKey: "",
    },
    delegable: opName === "tx.escrowFinish" || opName === "tx.checkCash",
    simulate: {
      engine_result: "tesSUCCESS",
      engine_result_message: "The simulated transaction would succeed.",
      applied: false,
    },
    preflight: [
      { check: "network", pass: true, detail: "testnet execution is enabled" },
      { check: "reserve", pass: true, detail: "reserve remains sufficient" },
    ],
    summary: {
      action: opName,
      account: "rOwner",
      amounts: ["1000000 drops XRP"],
      fee_drops: "12",
      reserve_delta_drops: "0",
      usd_value: "0",
    },
  };
}

describe("native builder guard classifications", () => {
  it.each(NATIVE_BUILDER_OPS)(
    "classifies %s as a trusted strict TxBuild result",
    (opName) => {
      expect(OP_SCREENING_CLASSIFICATION[opName]).toBe("trusted");
      expect(UNTRUSTED_FIELD_RULES[opName]).toBeUndefined();
      expect(collectUntrustedFields(opName, strictTxBuildResult(opName))).toEqual(
        [],
      );
    },
  );
});
