import { Wallet, type AccountSet } from "xrpl";
import { describe, expect, it, vi } from "vitest";

import { XrplRpcError } from "../src/adapters/xrpl-rpc";
import {
  SubmitValidationError,
  submitApprovedBlob,
  submitSignedBlob,
  type SubmitRpc,
} from "../src/exec/submit";

const APPROVAL_EXPIRY = "2099-01-01T00:00:00.000Z";

function signedAccountSet(lastLedgerSequence = 100) {
  const wallet = Wallet.generate();
  const tx: AccountSet = {
    TransactionType: "AccountSet",
    Account: wallet.classicAddress,
    Fee: "12",
    Sequence: 1,
    LastLedgerSequence: lastLedgerSequence,
  };
  return { wallet, tx, signed: wallet.sign(tx) };
}

function validatedResponse(hash: string) {
  return {
    validated: true,
    hash,
    ledger_index: 100,
    meta: { TransactionResult: "tesSUCCESS" },
  };
}

describe("signed approval protection", () => {
  it.each([
    ["Fee", (tx: AccountSet) => ({ ...tx, Fee: "13" })],
    ["Flags", (tx: AccountSet) => ({ ...tx, Flags: 1 })],
    [
      "LastLedgerSequence",
      (tx: AccountSet) => ({ ...tx, LastLedgerSequence: 101 }),
    ],
  ] as const)("rejects a blob with a changed %s before any RPC", async (_field, mutate) => {
    const { wallet, tx } = signedAccountSet();
    const tampered = wallet.sign(mutate(tx));
    const request = vi.fn<SubmitRpc["request"]>();

    await expect(
      submitApprovedBlob(
        {
          network: "testnet",
          tx_blob: tampered.tx_blob,
          approval: {
            id: "approval-1",
            txJson: tx,
            expiresAt: APPROVAL_EXPIRY,
            status: "pending",
          },
        },
        { rpc: { request } },
      ),
    ).rejects.toMatchObject<Partial<SubmitValidationError>>({
      code: "APPROVAL_TRANSACTION_MISMATCH",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("does not ignore an unexpected Signers field in the approved transaction", async () => {
    const { tx, signed } = signedAccountSet();
    const request = vi.fn<SubmitRpc["request"]>();

    await expect(
      submitApprovedBlob(
        {
          network: "devnet",
          tx_blob: signed.tx_blob,
          approval: {
            id: "approval-2",
            txJson: {
              ...tx,
              Signers: [{ Signer: { Account: tx.Account } }],
            },
            expiresAt: APPROVAL_EXPIRY,
            status: "pending",
          },
        },
        { rpc: { request } },
      ),
    ).rejects.toMatchObject<Partial<SubmitValidationError>>({
      code: "APPROVAL_TRANSACTION_MISMATCH",
    });
    expect(request).not.toHaveBeenCalled();
  });
});

describe("ambiguous submission recovery", () => {
  it("recovers a validated result by the local hash after a submit transport error", async () => {
    const { signed } = signedAccountSet();
    const request = vi.fn<SubmitRpc["request"]>(
      async (_network, command, params) => {
        if (command === "ledger") return { validated: true, ledger_index: 99 };
        if (command === "submit") throw new Error("ambiguous transport failure");
        if (command === "tx") {
          expect(params).toEqual({ transaction: signed.hash, binary: false });
          return validatedResponse(signed.hash);
        }
        throw new Error(`unexpected command ${command}`);
      },
    );

    const result = await submitSignedBlob(
      { network: "testnet", tx_blob: signed.tx_blob },
      {
        rpc: { request },
        sleep: async () => undefined,
        pollIntervalMs: 1,
        maxWaitMs: 1,
      },
    );

    expect(result).toEqual({
      status: "validated",
      hash: signed.hash,
      ledger_index: 100,
      engine_result: "tesSUCCESS",
      submit_attempts: 1,
    });
    expect(request.mock.calls.map((call) => call[1])).toEqual([
      "ledger",
      "submit",
      "tx",
    ]);
  });

  it("rejects an exact-hash validated poll outside the submission window", async () => {
    const { signed } = signedAccountSet();
    const request = vi.fn<SubmitRpc["request"]>(
      async (_network, command) => {
        if (command === "ledger") {
          return { validated: true, ledger_index: 99 };
        }
        if (command === "submit") return { engine_result: "tesSUCCESS" };
        if (command === "tx") {
          return {
            validated: true,
            hash: signed.hash,
            ledger_index: 99,
            meta: { TransactionResult: "tesSUCCESS" },
          };
        }
        throw new Error(`unexpected command ${command}`);
      },
    );

    await expect(
      submitSignedBlob(
        { network: "testnet", tx_blob: signed.tx_blob },
        {
          rpc: { request },
          sleep: async () => undefined,
          pollIntervalMs: 1,
          maxWaitMs: 1,
        },
      ),
    ).resolves.toMatchObject({
      status: "failed",
      hash: signed.hash,
      engine_result: "XRPL_MALFORMED_RESPONSE",
      submit_attempts: 1,
    });
  });

  it("returns a hash-bound timeout without resubmitting an indeterminate transaction", async () => {
    const { signed } = signedAccountSet();
    const request = vi.fn<SubmitRpc["request"]>(
      async (_network, command) => {
        if (command === "ledger") return { validated: true, ledger_index: 99 };
        if (command === "submit") return { engine_result: "tesSUCCESS" };
        if (command === "tx") throw { code: "txnNotFound" };
        throw new Error(`unexpected command ${command}`);
      },
    );

    const result = await submitSignedBlob(
      { network: "testnet", tx_blob: signed.tx_blob },
      {
        rpc: { request },
        sleep: async () => undefined,
        pollIntervalMs: 1,
        maxWaitMs: 2,
      },
    );

    expect(result).toEqual({
      status: "failed",
      hash: signed.hash,
      engine_result: "XRPL_VALIDATION_TIMEOUT",
      detail: "Transaction was not found in a validated ledger before the wait limit",
      submit_attempts: 1,
    });
    expect(request.mock.calls.filter((call) => call[1] === "submit")).toHaveLength(1);
    expect(request.mock.calls.filter((call) => call[1] === "tx")).toHaveLength(2);
  });

  it("lets exact final-ledger inclusion win after a soft miss and validated-head advancement", async () => {
    const { signed } = signedAccountSet();
    const order: string[] = [];
    let ledgerCalls = 0;
    let txCalls = 0;
    const request = vi.fn<SubmitRpc["request"]>(
      async (_network, command, params) => {
        if (command === "ledger") {
          ledgerCalls += 1;
          order.push(ledgerCalls === 1 ? "start-head" : "expiry-head");
          return {
            validated: true,
            ledger_index: ledgerCalls === 1 ? 99 : 101,
          };
        }
        if (command === "submit") {
          order.push("submit");
          return { engine_result: "tesSUCCESS" };
        }
        if (command === "tx") {
          txCalls += 1;
          if (txCalls === 1) {
            order.push("soft-miss");
            throw new XrplRpcError(
              "transaction not found",
              "txnNotFound",
              "soft-empty",
            );
          }
          order.push("bounded-range");
          expect(params).toEqual({
            transaction: signed.hash,
            binary: false,
            min_ledger: 100,
            max_ledger: 100,
            api_version: 1,
          });
          return validatedResponse(signed.hash);
        }
        throw new Error(`unexpected command ${command}`);
      },
    );

    await expect(
      submitSignedBlob(
        { network: "testnet", tx_blob: signed.tx_blob },
        {
          rpc: { request },
          sleep: async () => undefined,
          pollIntervalMs: 1,
          maxWaitMs: 1,
        },
      ),
    ).resolves.toEqual({
      status: "validated",
      hash: signed.hash,
      ledger_index: 100,
      engine_result: "tesSUCCESS",
      submit_attempts: 1,
    });
    expect(order).toEqual([
      "start-head",
      "submit",
      "soft-miss",
      "expiry-head",
      "bounded-range",
    ]);
  });

  it.each([
    [true, "tefMAX_LEDGER"],
    [false, "XRPL_VALIDATION_TIMEOUT"],
    [undefined, "XRPL_VALIDATION_TIMEOUT"],
  ] as const)(
    "accepts terminal absence only when searched_all is %s",
    async (searchedAll, expectedEngineResult) => {
      const { signed } = signedAccountSet();
      let ledgerCalls = 0;
      let txCalls = 0;
      const request = vi.fn<SubmitRpc["request"]>(
        async (_network, command) => {
          if (command === "ledger") {
            ledgerCalls += 1;
            return {
              validated: true,
              ledger_index: ledgerCalls === 1 ? 99 : 101,
            };
          }
          if (command === "submit") return { engine_result: "tesSUCCESS" };
          if (command === "tx") {
            txCalls += 1;
            throw new XrplRpcError(
              "transaction not found",
              "transactionNotFound",
              "soft-empty",
              false,
              txCalls === 1 ? undefined : searchedAll,
            );
          }
          throw new Error(`unexpected command ${command}`);
        },
      );

      const result = await submitSignedBlob(
        { network: "testnet", tx_blob: signed.tx_blob },
        {
          rpc: { request },
          sleep: async () => undefined,
          pollIntervalMs: 1,
          maxWaitMs: 1,
        },
      );
      expect(result).toMatchObject({
        status: "failed",
        hash: signed.hash,
        engine_result: expectedEngineResult,
        submit_attempts: 1,
      });
      expect(txCalls).toBe(2);
    },
  );

  it.each([
    ["unvalidated", { validated: false }],
    [
      "partial",
      { validated: true, ledger_index: 100 },
    ],
    [
      "out-of-window",
      {
        validated: true,
        ledger_index: 98,
        meta: { TransactionResult: "tesSUCCESS" },
      },
    ],
  ])("keeps %s bounded range evidence non-terminal", async (_name, rangeResponse) => {
    const { signed } = signedAccountSet();
    let ledgerCalls = 0;
    let txCalls = 0;
    const request = vi.fn<SubmitRpc["request"]>(
      async (_network, command) => {
        if (command === "ledger") {
          ledgerCalls += 1;
          return {
            validated: true,
            ledger_index: ledgerCalls === 1 ? 99 : 101,
          };
        }
        if (command === "submit") return { engine_result: "tesSUCCESS" };
        if (command === "tx") {
          txCalls += 1;
          if (txCalls === 1) {
            throw new XrplRpcError(
              "transaction not found",
              "txnNotFound",
              "soft-empty",
            );
          }
          return { hash: signed.hash, ...rangeResponse };
        }
        throw new Error(`unexpected command ${command}`);
      },
    );

    await expect(
      submitSignedBlob(
        { network: "testnet", tx_blob: signed.tx_blob },
        {
          rpc: { request },
          sleep: async () => undefined,
          pollIntervalMs: 1,
          maxWaitMs: 1,
        },
      ),
    ).resolves.toMatchObject({
      status: "failed",
      engine_result: "XRPL_VALIDATION_TIMEOUT",
    });
  });

  it("retries telCAN_NOT_QUEUE exactly once and recovers after an ambiguous retry", async () => {
    const { signed } = signedAccountSet();
    let submitCalls = 0;
    const request = vi.fn<SubmitRpc["request"]>(
      async (_network, command, params) => {
        if (command === "ledger") return { validated: true, ledger_index: 99 };
        if (command === "submit") {
          submitCalls += 1;
          if (submitCalls === 1) return { engine_result: "telCAN_NOT_QUEUE" };
          throw new Error("retry outcome unknown");
        }
        if (command === "tx") {
          expect(params).toEqual({ transaction: signed.hash, binary: false });
          return validatedResponse(signed.hash);
        }
        throw new Error(`unexpected command ${command}`);
      },
    );

    const result = await submitSignedBlob(
      {
        network: "devnet",
        tx_blob: signed.tx_blob,
        executionContract: "xrpl_execution_v1",
      },
      {
        rpc: { request },
        sleep: async () => undefined,
        pollIntervalMs: 1,
        maxWaitMs: 1,
      },
    );

    expect(result).toMatchObject({
      status: "validated",
      hash: signed.hash,
      submit_attempts: 2,
    });
    expect(submitCalls).toBe(2);
    expect(request.mock.calls.filter((call) => call[1] === "tx")).toHaveLength(1);
  });

  it("does not make a third submit after telCAN_NOT_QUEUE is returned twice", async () => {
    const { signed } = signedAccountSet();
    let submitCalls = 0;
    const request = vi.fn<SubmitRpc["request"]>(
      async (_network, command) => {
        if (command === "ledger") return { validated: true, ledger_index: 99 };
        if (command === "submit") {
          submitCalls += 1;
          return { engine_result: "telCAN_NOT_QUEUE" };
        }
        throw new Error(`unexpected command ${command}`);
      },
    );

    const result = await submitSignedBlob(
      { network: "testnet", tx_blob: signed.tx_blob },
      { rpc: { request } },
    );

    expect(result).toEqual({
      status: "failed",
      hash: signed.hash,
      engine_result: "telCAN_NOT_QUEUE",
      detail: "XRPL rejected the transaction before validation",
      submit_attempts: 2,
    });
    expect(submitCalls).toBe(2);
    expect(request.mock.calls.some((call) => call[1] === "tx")).toBe(false);
  });

  it("does not retry telCAN_NOT_QUEUE for one-shot v2 submission", async () => {
    const { signed } = signedAccountSet();
    let submitCalls = 0;
    const request = vi.fn<SubmitRpc["request"]>(
      async (_network, command) => {
        if (command === "ledger") return { validated: true, ledger_index: 99 };
        if (command === "submit") {
          submitCalls += 1;
          return { engine_result: "telCAN_NOT_QUEUE" };
        }
        throw new Error(`unexpected command ${command}`);
      },
    );

    const result = await submitSignedBlob(
      {
        network: "testnet",
        tx_blob: signed.tx_blob,
        executionContract: "xrpl_execution_v2",
      },
      { rpc: { request } },
    );

    expect(result).toEqual({
      status: "failed",
      hash: signed.hash,
      engine_result: "telCAN_NOT_QUEUE",
      detail: "XRPL rejected the transaction before validation",
      submit_attempts: 1,
    });
    expect(submitCalls).toBe(1);
    expect(request.mock.calls.some((call) => call[1] === "tx")).toBe(false);
  });
});
