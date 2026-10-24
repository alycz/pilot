import type { Network } from "@pilot/contracts";
import {
  decode,
  deriveAddress,
  encode,
  encodeForSigning,
  verifyKeypairSignature,
} from "xrpl";

import {
  PilotWalletError,
  type LedgerDeviceState,
  type PilotWallet,
} from "../types.js";
import {
  acquireLedgerDevice,
  type LedgerDeviceLease,
  type LedgerTransport,
} from "./device-manager.js";
import { ledgerSigningMode } from "./clear-sign.js";
import { normalizeLedgerFailure } from "./errors.js";
import {
  bytesFromHex,
  hexFromBytes,
  ledgerDerivationPath,
} from "./xrp.js";

export type LedgerWalletOptions = Readonly<{
  transport: LedgerTransport;
  accountIndex?: number;
  virtualBaseUrl?: string;
}>;

export type LedgerFacadeDependencies = Readonly<{
  acquireDevice?: typeof acquireLedgerDevice;
}>;

const IDLE_STATE: LedgerDeviceState = Object.freeze({
  interaction: "none",
  busy: false,
});

function versionBelow(version: string, minimum: string): boolean {
  const parsed = version.split(".").map((part) => Number.parseInt(part, 10));
  const floor = minimum.split(".").map((part) => Number.parseInt(part, 10));
  if (
    parsed.length !== 3 || parsed.some((part) => !Number.isSafeInteger(part))
  ) return true;
  for (let index = 0; index < floor.length; index += 1) {
    if ((parsed[index] ?? 0) !== floor[index]) {
      return (parsed[index] ?? 0) < (floor[index] ?? 0);
    }
  }
  return false;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function withoutSignatures(
  transaction: Record<string, unknown>,
): Record<string, unknown> {
  const unsigned = { ...transaction };
  delete unsigned.SigningPubKey;
  delete unsigned.TxnSignature;
  return unsigned;
}

export function assertLedgerSignedFields(
  original: Record<string, unknown>,
  blob: string,
): Record<string, unknown> {
  const decoded = decode(blob) as Record<string, unknown>;
  const expected = decode(encode(original as never)) as Record<string, unknown>;
  if (
    canonical(withoutSignatures(decoded)) !==
    canonical(withoutSignatures(expected))
  ) {
    throw new PilotWalletError(
      "SIGN_FAILED",
      "The Ledger returned a transaction with changed fields.",
    );
  }
  return decoded;
}

function signingAllowed(network: Network): asserts network is "testnet" | "devnet" {
  if (network !== "testnet" && network !== "devnet") {
    throw new PilotWalletError(
      "MAINNET_SIGNING_DISABLED",
      "Ledger signing is limited to XRPL testnet and devnet.",
    );
  }
}

function unsignedTransaction(
  transaction: Record<string, unknown>,
  account: string,
  publicKey: string,
): Record<string, unknown> {
  if (
    transaction === null || Array.isArray(transaction) ||
    typeof transaction.TransactionType !== "string" ||
    typeof transaction.Account !== "string"
  ) {
    throw new PilotWalletError(
      "INVALID_TRANSACTION",
      "A signable transaction requires TransactionType and Account.",
    );
  }
  if (transaction.Account !== account) {
    throw new PilotWalletError(
      "ACCOUNT_MISMATCH",
      "The transaction account does not match the connected wallet.",
    );
  }
  if (
    transaction.TxnSignature !== undefined || transaction.Signers !== undefined ||
    (transaction.SigningPubKey !== undefined && transaction.SigningPubKey !== "")
  ) {
    throw new PilotWalletError(
      "INVALID_TRANSACTION",
      "Ledger signs only unsigned single-sign transactions.",
    );
  }
  const result: Record<string, unknown> = {
    ...transaction,
    SigningPubKey: publicKey,
  };
  delete result.TxnSignature;
  delete result.Signers;
  return result;
}

function walletError(error: unknown, phase: "connect" | "sign", tx?: Record<string, unknown>): PilotWalletError {
  if (error instanceof PilotWalletError) return error;
  const failure = normalizeLedgerFailure(
    error,
    phase,
    tx === undefined ? "clear" : ledgerSigningMode(tx),
  );
  return new PilotWalletError(failure.code, failure.message);
}

class LedgerWallet implements PilotWallet {
  readonly provider = "ledger" as const;
  readonly custody: "hardware" | "software";
  readonly ledgerTransport: LedgerTransport;
  private readonly path: string;
  private readonly listeners = new Set<(state: LedgerDeviceState) => void>();
  private lease: LedgerDeviceLease | undefined;
  private forgetLease: LedgerDeviceLease | undefined;
  private connectedAddress: string | undefined;
  private publicKey: string | undefined;
  private connectRequest: Promise<string> | undefined;
  private connectionGeneration = 0;
  private signQueue: Promise<void> = Promise.resolve();
  private state: LedgerDeviceState = IDLE_STATE;

  constructor(
    readonly network: Network,
    private readonly options: LedgerWalletOptions,
    private readonly acquireDevice: typeof acquireLedgerDevice,
  ) {
    this.ledgerTransport = options.transport;
    this.custody = options.transport === "webhid" ? "hardware" : "software";
    try {
      this.path = ledgerDerivationPath(options.accountIndex ?? 0);
    } catch {
      throw new PilotWalletError(
        "CONNECT_FAILED",
        "The Ledger account index is invalid.",
      );
    }
  }

  private emit = (state: LedgerDeviceState): void => {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  };

  connect(): Promise<string> {
    if (this.connectedAddress !== undefined) {
      return Promise.resolve(this.connectedAddress);
    }
    if (this.connectRequest !== undefined) return this.connectRequest;
    const generation = this.connectionGeneration;
    const pending = Promise.resolve().then(async () => {
      signingAllowed(this.network);
      const lease = await this.acquireDevice({
        transport: this.options.transport,
        ...(this.options.virtualBaseUrl === undefined
          ? {}
          : { virtualBaseUrl: this.options.virtualBaseUrl }),
      });
      if (generation !== this.connectionGeneration) {
        lease.release();
        throw new PilotWalletError(
          "CONNECT_CANCELLED",
          "The Ledger connection request was cancelled.",
        );
      }
      this.lease = lease;
      this.forgetLease = lease;
      const app = await lease.getAppConfig(this.emit);
      if (versionBelow(app.version, "2.8.2")) {
        console.warn("Ledger XRP app 2.8.2 or newer is recommended.");
      }
      const result = await lease.getAddress(this.path, {}, this.emit);
      const publicKey = result.publicKey.toUpperCase();
      if (
        !/^(02|03)[A-F0-9]{64}$/.test(publicKey) ||
        deriveAddress(publicKey) !== result.address
      ) {
        throw new PilotWalletError(
          "CONNECT_FAILED",
          "The Ledger returned an invalid XRP account.",
        );
      }
      if (generation !== this.connectionGeneration) {
        lease.release();
        throw new PilotWalletError(
          "CONNECT_CANCELLED",
          "The Ledger connection request was cancelled.",
        );
      }
      this.publicKey = publicKey;
      this.connectedAddress = result.address;
      return result.address;
    }).catch((error: unknown) => {
      if (generation === this.connectionGeneration) {
        this.lease?.release();
        this.lease = undefined;
        this.connectedAddress = undefined;
        this.publicKey = undefined;
      }
      throw walletError(error, "connect");
    }).finally(() => {
      if (this.connectRequest === pending) this.connectRequest = undefined;
    });
    this.connectRequest = pending;
    return pending;
  }

  address(): string {
    if (this.connectedAddress === undefined) {
      throw new PilotWalletError(
        "NOT_CONNECTED",
        "Connect the Ledger before requesting its address.",
      );
    }
    return this.connectedAddress;
  }

  async verifyAddressOnDevice(): Promise<void> {
    const lease = this.lease;
    const address = this.address();
    if (lease === undefined) {
      throw new PilotWalletError("NOT_CONNECTED", "Connect the Ledger first.");
    }
    try {
      const verified = await lease.getAddress(
        this.path,
        { checkOnDevice: true },
        this.emit,
      );
      if (verified.address !== address) {
        throw new PilotWalletError(
          "CONNECT_FAILED",
          "The address shown on the Ledger did not match.",
        );
      }
    } catch (error: unknown) {
      throw walletError(error, "connect");
    }
  }

  onDeviceState(listener: (state: LedgerDeviceState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  signOnly(transaction: Record<string, unknown>): Promise<string> {
    const generation = this.connectionGeneration;
    const run = this.signQueue.then(async () => {
      if (generation !== this.connectionGeneration) {
        throw new PilotWalletError(
          "SIGN_CANCELLED",
          "The Ledger signing request was cancelled.",
        );
      }
      signingAllowed(this.network);
      const lease = this.lease;
      const account = this.address();
      const publicKey = this.publicKey;
      if (lease === undefined || publicKey === undefined) {
        throw new PilotWalletError("NOT_CONNECTED", "Connect the Ledger first.");
      }
      const unsigned = unsignedTransaction(transaction, account, publicKey);
      try {
        const bytes = bytesFromHex(encode(unsigned as never));
        const der = await lease.signTransaction(this.path, bytes, this.emit);
        if (generation !== this.connectionGeneration) {
          throw new PilotWalletError(
            "SIGN_CANCELLED",
            "The Ledger signing request was cancelled.",
          );
        }
        const signature = hexFromBytes(der);
        const blob = encode({ ...unsigned, TxnSignature: signature } as never);
        const decoded = assertLedgerSignedFields(transaction, blob);
        if (
          decoded.SigningPubKey !== publicKey ||
          decoded.TxnSignature !== signature ||
          !verifyKeypairSignature(
            encodeForSigning(decoded as never),
            signature,
            publicKey,
          )
        ) {
          throw new PilotWalletError(
            "SIGN_FAILED",
            "The Ledger signature could not be verified.",
          );
        }
        return blob;
      } catch (error: unknown) {
        throw walletError(error, "sign", transaction);
      }
    });
    this.signQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async disconnect(): Promise<void> {
    this.connectionGeneration += 1;
    this.connectRequest = undefined;
    this.connectedAddress = undefined;
    this.publicKey = undefined;
    this.lease?.release();
    this.lease = undefined;
    this.emit(IDLE_STATE);
  }

  async forget(): Promise<void> {
    this.connectionGeneration += 1;
    this.connectRequest = undefined;
    this.connectedAddress = undefined;
    this.publicKey = undefined;
    const lease = this.lease;
    this.lease = undefined;
    const forgetLease = lease ?? this.forgetLease;
    this.forgetLease = undefined;
    if (forgetLease !== undefined) await forgetLease.forget();
    this.signQueue = Promise.resolve();
    this.emit(IDLE_STATE);
  }
}

export function createLedgerWallet(
  network: Network,
  options: LedgerWalletOptions,
  dependencies: LedgerFacadeDependencies = {},
): PilotWallet {
  return new LedgerWallet(
    network,
    options,
    dependencies.acquireDevice ?? acquireLedgerDevice,
  );
}
