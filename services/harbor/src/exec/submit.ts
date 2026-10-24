import { decode, hashes } from "xrpl";

import type { XrplRpc } from "../adapters/xrpl-rpc";
import { XrplRpcError } from "../adapters/xrpl-rpc";
import type { ExecutionContract, Network } from "../contracts";
import type { ApprovalRow } from "./store";

export const SUBMIT_POLL_INTERVAL_MS = 1_000;
export const SUBMIT_MAX_WAIT_MS = 120_000;

const MAX_BLOB_HEX_LENGTH = 200_000;
const SIGNATURE_FIELDS = new Set(["SigningPubKey", "TxnSignature"]);
const SAFE_ERROR_CODE = /^[A-Za-z][A-Za-z0-9_:-]{0,127}$/;
const TRANSACTION_HASH = /^[A-Fa-f0-9]{64}$/;

export type ExecutionNetwork = Extract<Network, "testnet" | "devnet">;

export type SubmitErrorCode =
  | "EXECUTION_NETWORK_DISABLED"
  | "INVALID_TRANSACTION_BLOB"
  | "UNSIGNED_TRANSACTION"
  | "INVALID_APPROVAL"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_NOT_PENDING"
  | "APPROVAL_TRANSACTION_MISMATCH"
  | "INVALID_LAST_LEDGER_SEQUENCE"
  | "TRANSACTION_EXPIRED"
  | "EXECUTION_CONTRACT_UNSUPPORTED";

/** A validation error that deliberately retains neither a blob nor decoded data. */
export class SubmitValidationError extends Error {
  constructor(
    message: string,
    readonly code: SubmitErrorCode,
  ) {
    super(message);
    this.name = "SubmitValidationError";
  }
}

export interface SubmitRpc {
  request: XrplRpc["request"];
}

export interface SubmitDependencies {
  rpc: SubmitRpc;
  sleep?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

export interface SubmitSignedBlobInput {
  network: Network;
  tx_blob: string;
  /** Omission retains the legacy one-retry submission behavior. */
  executionContract?: ExecutionContract;
}

export interface SubmitApprovedBlobInput extends SubmitSignedBlobInput {
  approval: Pick<ApprovalRow, "id" | "txJson" | "expiresAt" | "status">;
  now?: Date;
}

export interface ValidatedSubmitResult {
  status: "validated";
  hash: string;
  ledger_index: number;
  /** The final result from validated transaction metadata. */
  engine_result: string;
  /** Number of submit requests, either one or the one allowed retry. */
  submit_attempts: 1 | 2;
}

export interface FailedSubmitResult {
  status: "failed";
  hash: string;
  engine_result: string;
  /** A fixed, secret-safe description; raw remote errors are never exposed. */
  detail: string;
  submit_attempts: 1 | 2;
}

export type SubmitResult = ValidatedSubmitResult | FailedSubmitResult;

type WaitResult =
  | Omit<ValidatedSubmitResult, "submit_attempts">
  | Omit<FailedSubmitResult, "submit_attempts">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExecutionNetwork(network: Network): asserts network is ExecutionNetwork {
  if (network !== "testnet" && network !== "devnet") {
    throw new SubmitValidationError(
      "Transaction submission is limited to testnet and devnet",
      "EXECUTION_NETWORK_DISABLED",
    );
  }
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be positive`);
  }
}

function hasSingleSignature(tx: Readonly<Record<string, unknown>>): boolean {
  return (
    tx.Signers === undefined &&
    typeof tx.SigningPubKey === "string" &&
    tx.SigningPubKey.length > 0 &&
    typeof tx.TxnSignature === "string" &&
    tx.TxnSignature.length > 0
  );
}

function hasMultiSignatures(tx: Readonly<Record<string, unknown>>): boolean {
  if (
    tx.SigningPubKey !== "" ||
    tx.TxnSignature !== undefined ||
    !Array.isArray(tx.Signers) ||
    tx.Signers.length === 0
  ) {
    return false;
  }
  return tx.Signers.every((entry) => {
    if (!isRecord(entry) || !isRecord(entry.Signer)) return false;
    const signer = entry.Signer;
    return (
      typeof signer.Account === "string" &&
      signer.Account.length > 0 &&
      typeof signer.SigningPubKey === "string" &&
      signer.SigningPubKey.length > 0 &&
      typeof signer.TxnSignature === "string" &&
      signer.TxnSignature.length > 0
    );
  });
}

/** Decode a signed transaction without retaining or returning the source blob. */
export function decodeSignedBlob(txBlob: string): Readonly<Record<string, unknown>> {
  if (
    typeof txBlob !== "string" ||
    txBlob.length === 0 ||
    txBlob.length > MAX_BLOB_HEX_LENGTH ||
    txBlob.length % 2 !== 0 ||
    !/^[0-9A-Fa-f]+$/.test(txBlob)
  ) {
    throw new SubmitValidationError(
      "Transaction blob is not valid hexadecimal binary data",
      "INVALID_TRANSACTION_BLOB",
    );
  }

  let decoded: Record<string, unknown>;
  try {
    decoded = decode(txBlob);
  } catch {
    throw new SubmitValidationError(
      "Transaction blob could not be decoded",
      "INVALID_TRANSACTION_BLOB",
    );
  }

  // SigningPubKey, TxnSignature, and Signers are the protocol signing fields:
  // https://xrpl.org/docs/references/protocol/transactions/common-fields
  if (!hasSingleSignature(decoded) && !hasMultiSignatures(decoded)) {
    throw new SubmitValidationError(
      "Transaction blob must contain a signature",
      "UNSIGNED_TRANSACTION",
    );
  }
  return decoded;
}

function withoutTopLevelSignatureFields(
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !SIGNATURE_FIELDS.has(key)),
  );
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => jsonEqual(item, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key, index) =>
      key === rightKeys[index] && jsonEqual(left[key], right[key]),
  );
}

/**
 * Validate that a signed approval protects every transaction field. Only the
 * two top-level single-signing proof fields are ignored. In particular,
 * Signers, Delegate, Fee, Sequence, and LastLedgerSequence remain protected.
 * Field definitions: https://xrpl.org/docs/references/protocol/transactions/common-fields
 */
export function validateApprovedBlob(
  txBlob: string,
  approval: Pick<ApprovalRow, "txJson" | "expiresAt" | "status">,
  now: Date = new Date(),
): Readonly<Record<string, unknown>> {
  if (!isRecord(approval) || !isRecord(approval.txJson)) {
    throw new SubmitValidationError("Approval is invalid", "INVALID_APPROVAL");
  }
  if (approval.status !== "pending") {
    throw new SubmitValidationError(
      "Approval is no longer pending",
      "APPROVAL_NOT_PENDING",
    );
  }

  const expiresAt = Date.parse(approval.expiresAt);
  const nowMs = now.getTime();
  if (!Number.isFinite(expiresAt) || !Number.isFinite(nowMs)) {
    throw new SubmitValidationError("Approval is invalid", "INVALID_APPROVAL");
  }
  if (expiresAt <= nowMs) {
    throw new SubmitValidationError("Approval has expired", "APPROVAL_EXPIRED");
  }

  const decoded = decodeSignedBlob(txBlob);
  const expected = withoutTopLevelSignatureFields(approval.txJson);
  const actual = withoutTopLevelSignatureFields(decoded);
  if (!jsonEqual(expected, actual)) {
    throw new SubmitValidationError(
      "Signed transaction does not match the approved transaction",
      "APPROVAL_TRANSACTION_MISMATCH",
    );
  }
  return decoded;
}

export function signedTransactionHash(txBlob: string): string {
  try {
    // The transaction hash is derived locally so a submit response cannot
    // substitute a different transaction identifier:
    // https://xrpl.org/docs/concepts/transactions/transaction-basics#identifying-transactions
    return hashes.hashSignedTx(txBlob);
  } catch {
    throw new SubmitValidationError(
      "Transaction blob could not be hashed",
      "INVALID_TRANSACTION_BLOB",
    );
  }
}

function safeProtocolCode(value: unknown, fallback: string): string {
  return typeof value === "string" && SAFE_ERROR_CODE.test(value)
    ? value
    : fallback;
}

function readEngineResult(response: Readonly<Record<string, unknown>>): string {
  return safeProtocolCode(response.engine_result, "XRPL_MALFORMED_RESPONSE");
}

function safeThrownCode(error: unknown, fallback: string): string {
  const code =
    error instanceof XrplRpcError
      ? error.code
      : isRecord(error) && typeof error.code === "string"
        ? error.code
        : undefined;
  return code !== undefined && SAFE_ERROR_CODE.test(code) ? code : fallback;
}

function isNotFound(error: unknown): boolean {
  return (
    (error instanceof XrplRpcError &&
      (error.kind === "soft-empty" ||
        error.code === "txnNotFound" ||
        error.code === "transactionNotFound")) ||
    (isRecord(error) &&
      (error.code === "txnNotFound" || error.code === "transactionNotFound"))
  );
}

function completeRangeNotFound(error: unknown): boolean {
  if (!isRecord(error) && !(error instanceof XrplRpcError)) return false;
  const code = error instanceof XrplRpcError ? error.code : error.code;
  const searchedAll =
    error instanceof XrplRpcError
      ? error.searchedAll
      : error.searched_all === true || error.searchedAll === true;
  return (
    (code === "txnNotFound" || code === "transactionNotFound") &&
    searchedAll === true
  );
}

function metadataResult(response: Readonly<Record<string, unknown>>): string | undefined {
  const metadata = isRecord(response.meta)
    ? response.meta
    : isRecord(response.meta_blob)
      ? response.meta_blob
      : undefined;
  const value = metadata?.TransactionResult;
  return typeof value === "string" && SAFE_ERROR_CODE.test(value)
    ? value
    : undefined;
}

function lastLedgerSequence(
  transaction: Readonly<Record<string, unknown>>,
): number | undefined {
  const value = transaction.LastLedgerSequence;
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : undefined;
}

function parsedLedgerIndex(value: unknown): number | undefined {
  if (Number.isSafeInteger(value) && Number(value) > 0) return Number(value);
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function validatedLedgerIndex(
  network: ExecutionNetwork,
  dependencies: SubmitDependencies,
): Promise<number> {
  let response: Record<string, unknown>;
  try {
    // Reliable submission uses validated-ledger progress, not the open ledger,
    // as the authoritative expiry basis for LastLedgerSequence:
    // https://xrpl.org/docs/concepts/transactions/reliable-transaction-submission
    response = await dependencies.rpc.request(network, "ledger", {
      ledger_index: "validated",
      transactions: false,
      expand: false,
    });
  } catch {
    throw new SubmitValidationError(
      "Could not verify transaction expiration",
      "INVALID_LAST_LEDGER_SEQUENCE",
    );
  }
  const nested = isRecord(response.ledger) ? response.ledger : undefined;
  const ledgerIndex =
    parsedLedgerIndex(response.ledger_index) ??
    parsedLedgerIndex(nested?.ledger_index) ??
    parsedLedgerIndex(nested?.seqNum);
  if (response.validated !== true || ledgerIndex === undefined) {
    throw new SubmitValidationError(
      "XRPL did not return a valid current ledger index",
      "INVALID_LAST_LEDGER_SEQUENCE",
    );
  }
  return ledgerIndex;
}

async function reconcileExpiredTransaction(
  network: ExecutionNetwork,
  hash: string,
  lastLedger: number,
  dependencies: SubmitDependencies,
  firstLedger: number,
): Promise<WaitResult | null> {
  let response: Record<string, unknown>;
  try {
    // After validated-head advancement, search the complete persisted
    // reliable-submission window. A prior soft tx miss can race with final
    // inclusion and is not absence proof.
    response = await dependencies.rpc.request(
      network,
      "tx",
      {
        transaction: hash,
        binary: false,
        min_ledger: firstLedger,
        max_ledger: lastLedger,
        api_version: 1,
      },
      { intent: "read" },
    );
  } catch (error) {
    return completeRangeNotFound(error)
      ? {
          status: "failed",
          hash,
          engine_result: "tefMAX_LEDGER",
          detail: "Transaction was absent after its LastLedgerSequence",
        }
      : null;
  }
  if (
    response.validated !== true ||
    typeof response.hash !== "string" ||
    response.hash.toUpperCase() !== hash.toUpperCase() ||
    !Number.isSafeInteger(response.ledger_index) ||
    Number(response.ledger_index) < firstLedger ||
    Number(response.ledger_index) > lastLedger
  ) {
    return null;
  }
  const finalResult = metadataResult(response);
  return finalResult === undefined
    ? null
    : {
        status: "validated",
        hash,
        ledger_index: Number(response.ledger_index),
        engine_result: finalResult,
      };
}

async function assertApprovalLedgerCurrent(
  network: ExecutionNetwork,
  transaction: Readonly<Record<string, unknown>>,
  dependencies: SubmitDependencies,
): Promise<number> {
  const lastLedger = lastLedgerSequence(transaction);
  if (lastLedger === undefined) {
    throw new SubmitValidationError(
      "Approved transaction has no valid LastLedgerSequence",
      "INVALID_LAST_LEDGER_SEQUENCE",
    );
  }
  const validatedLedger = await validatedLedgerIndex(network, dependencies);
  if (validatedLedger >= lastLedger) {
    throw new SubmitValidationError(
      "Approved transaction has passed its LastLedgerSequence",
      "TRANSACTION_EXPIRED",
    );
  }
  return validatedLedger + 1;
}

/** Poll the `tx` method until the transaction is included in a validated ledger. */
export async function waitForValidatedTransaction(
  network: Network,
  hash: string,
  decoded: Readonly<Record<string, unknown>>,
  dependencies: SubmitDependencies,
  firstPossibleLedger: number,
): Promise<WaitResult> {
  assertExecutionNetwork(network);
  const pollIntervalMs = dependencies.pollIntervalMs ?? SUBMIT_POLL_INTERVAL_MS;
  const maxWaitMs = dependencies.maxWaitMs ?? SUBMIT_MAX_WAIT_MS;
  assertPositiveFinite(pollIntervalMs, "pollIntervalMs");
  assertPositiveFinite(maxWaitMs, "maxWaitMs");
  if (!TRANSACTION_HASH.test(hash)) {
    throw new SubmitValidationError(
      "Transaction hash is invalid",
      "INVALID_TRANSACTION_BLOB",
    );
  }
  const lastLedger = lastLedgerSequence(decoded);
  if (lastLedger === undefined) {
    throw new SubmitValidationError(
      "Transaction has no valid LastLedgerSequence",
      "INVALID_LAST_LEDGER_SEQUENCE",
    );
  }
  if (
    !Number.isSafeInteger(firstPossibleLedger) ||
    firstPossibleLedger < 1 ||
    firstPossibleLedger > lastLedger ||
    lastLedger - firstPossibleLedger >= 1_000
  ) {
    throw new SubmitValidationError(
      "Transaction has no bounded ledger search window",
      "INVALID_LAST_LEDGER_SEQUENCE",
    );
  }
  const sleep =
    dependencies.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const maxPolls = Math.max(1, Math.ceil(maxWaitMs / pollIntervalMs));

  for (let poll = 0; poll < maxPolls; poll += 1) {
    await sleep(pollIntervalMs);
    let response: Record<string, unknown>;
    try {
      // `validated: true` is the authoritative indication that a transaction
      // result is final. `transaction` is the hash and `binary: false` requests
      // JSON: https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/transaction-methods/tx
      response = await dependencies.rpc.request(network, "tx", {
        transaction: hash,
        binary: false,
      });
    } catch (error) {
      if (isNotFound(error)) {
        if ((await validatedLedgerIndex(network, dependencies)) > lastLedger) {
          const reconciled = await reconcileExpiredTransaction(
            network,
            hash,
            lastLedger,
            dependencies,
            firstPossibleLedger,
          );
          if (reconciled) return reconciled;
        }
        continue;
      }
      return {
        status: "failed",
        hash,
        engine_result: safeThrownCode(error, "XRPL_TX_LOOKUP_ERROR"),
        detail: "Could not confirm the transaction in a validated ledger",
      };
    }

    if (response.validated !== true) {
      if ((await validatedLedgerIndex(network, dependencies)) > lastLedger) {
        const reconciled = await reconcileExpiredTransaction(
          network,
          hash,
          lastLedger,
          dependencies,
          firstPossibleLedger,
        );
        if (reconciled) return reconciled;
      }
      continue;
    }
    if (
      typeof response.hash !== "string" ||
      !TRANSACTION_HASH.test(response.hash) ||
      response.hash.toUpperCase() !== hash.toUpperCase()
    ) {
      return {
        status: "failed",
        hash,
        engine_result: "XRPL_MALFORMED_RESPONSE",
        detail: "Validated transaction response did not match the submitted hash",
      };
    }
    if (
      !Number.isSafeInteger(response.ledger_index) ||
      Number(response.ledger_index) < firstPossibleLedger ||
      Number(response.ledger_index) > lastLedger
    ) {
      return {
        status: "failed",
        hash,
        engine_result: "XRPL_MALFORMED_RESPONSE",
        detail: "Validated transaction response did not include a ledger index",
      };
    }

    const finalResult = metadataResult(response);
    if (finalResult === undefined) {
      return {
        status: "failed",
        hash,
        engine_result: "XRPL_MALFORMED_RESPONSE",
        detail: "Validated transaction response did not include a final result",
      };
    }
    return {
      status: "validated",
      hash,
      ledger_index: Number(response.ledger_index),
      engine_result: finalResult,
    };
  }

  return {
    status: "failed",
    hash,
    engine_result: "XRPL_VALIDATION_TIMEOUT",
    detail: "Transaction was not found in a validated ledger before the wait limit",
  };
}

function cannotReachAValidatedLedger(engineResult: string): boolean {
  return engineResult.startsWith("tem") || engineResult.startsWith("tel");
}

/**
 * Submit a signed binary transaction and wait for its validated outcome.
 *
 * `tx_blob` and `fail_hard` are submit request fields documented at:
 * https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/transaction-methods/submit
 * A first `telCAN_NOT_QUEUE` gets exactly one retry, as that local result says
 * the server did not queue the transaction:
 * https://xrpl.org/docs/references/protocol/transactions/transaction-results/tel-codes
 */
export async function submitSignedBlob(
  input: SubmitSignedBlobInput,
  dependencies: SubmitDependencies,
): Promise<SubmitResult> {
  assertExecutionNetwork(input.network);
  if (
    input.executionContract !== undefined &&
    input.executionContract !== "xrpl_execution_v1" &&
    input.executionContract !== "xrpl_execution_v2"
  ) {
    throw new SubmitValidationError(
      "Execution contract is unsupported",
      "EXECUTION_CONTRACT_UNSUPPORTED",
    );
  }
  const oneShot = input.executionContract === "xrpl_execution_v2";
  const decoded = decodeSignedBlob(input.tx_blob);
  const hash = signedTransactionHash(input.tx_blob);
  const firstPossibleLedger = await assertApprovalLedgerCurrent(
    input.network,
    decoded,
    dependencies,
  );

  let attempts: 1 | 2 = 1;
  let response: Record<string, unknown>;
  try {
    response = await dependencies.rpc.request(
      input.network,
      "submit",
      { tx_blob: input.tx_blob, fail_hard: false },
      { intent: "execute" },
    );
  } catch (error) {
    if (safeThrownCode(error, "") !== "telCAN_NOT_QUEUE") {
      // A transport failure is ambiguous: the node might have received the
      // request before the connection failed. Query the locally derived hash
      // instead of risking a duplicate replacement transaction.
      const waited = await waitForValidatedTransaction(
        input.network,
        hash,
        decoded,
        dependencies,
        firstPossibleLedger,
      );
      return { ...waited, submit_attempts: attempts };
    }
    response = { engine_result: "telCAN_NOT_QUEUE" };
  }

  let engineResult = readEngineResult(response);
  if (engineResult === "telCAN_NOT_QUEUE" && !oneShot) {
    attempts = 2;
    try {
      response = await dependencies.rpc.request(
        input.network,
        "submit",
        { tx_blob: input.tx_blob, fail_hard: false },
        { intent: "execute" },
      );
      engineResult = readEngineResult(response);
    } catch (error) {
      if (safeThrownCode(error, "") !== "telCAN_NOT_QUEUE") {
        const waited = await waitForValidatedTransaction(
          input.network,
          hash,
          decoded,
          dependencies,
          firstPossibleLedger,
        );
        return { ...waited, submit_attempts: attempts };
      }
      return {
        status: "failed",
        hash,
        engine_result: "telCAN_NOT_QUEUE",
        detail: "XRPL did not accept the transaction submission retry",
        submit_attempts: attempts,
      };
    }
  }

  if (cannotReachAValidatedLedger(engineResult)) {
    return {
      status: "failed",
      hash,
      engine_result: engineResult,
      detail: "XRPL rejected the transaction before validation",
      submit_attempts: attempts,
    };
  }

  const waited = await waitForValidatedTransaction(
    input.network,
    hash,
    decoded,
    dependencies,
    firstPossibleLedger,
  );
  return { ...waited, submit_attempts: attempts };
}

/** Validate an owner-signed approval before using the ordinary submit path. */
export async function submitApprovedBlob(
  input: SubmitApprovedBlobInput,
  dependencies: SubmitDependencies,
): Promise<SubmitResult> {
  assertExecutionNetwork(input.network);
  const decoded = validateApprovedBlob(input.tx_blob, input.approval, input.now);
  // submitSignedBlob performs the validated-ledger LastLedgerSequence check
  // for both approval and ordinary relay paths.
  return submitSignedBlob(input, dependencies);
}
