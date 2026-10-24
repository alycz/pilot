import type { Network } from "@pilot/contracts";

export type WalletProvider =
  | "ledger"
  | "gemwallet"
  | "crossmark"
  | "xaman"
  | "dev";

export interface CreateWalletOptions {
  /** GemWallet is the product default. */
  provider?: WalletProvider;
  /** Defaults to Pilot's execution default, testnet. */
  network?: Network;
  /** Xaman's public application API key. It is never persisted by this package. */
  xamanApiKey?: string;
  ledger?: {
    transport: "webhid" | "virtual";
    accountIndex?: number;
    virtualBaseUrl?: string;
  };
}

export type LedgerDeviceState = Readonly<{
  interaction:
    | "none"
    | "unlock-device"
    | "confirm-open-app"
    | "verify-address"
    | "sign-transaction";
  busy: boolean;
}>;

export interface PilotWallet {
  readonly provider: WalletProvider;
  readonly network: Network;
  /** Check extension availability without connecting an account or prompting to sign. */
  checkAvailability?(): Promise<void>;
  /** Connect and return only the public classic address. */
  connect(): Promise<string>;
  /** Return the connected public address, or throw when disconnected. */
  address(): string;
  /** Sign without submitting and return a serialized signed transaction. */
  signOnly(txJson: Record<string, unknown>): Promise<string>;
  readonly custody?: "hardware" | "software";
  verifyAddressOnDevice?(): Promise<void>;
  onDeviceState?(listener: (state: LedgerDeviceState) => void): () => void;
  /** Record independently verified owner revocation before destructive cleanup. */
  markRevocationVerified?(): Promise<void>;
  /**
   * Forget all wallet state owned by this facade. For the development signer,
   * this destroys the selected network's session key only after verified
   * owner revocation has been recorded.
   */
  forget(): Promise<void>;
  /** Disconnect locally while retaining any restorable session state. */
  disconnect(): Promise<void>;
}

export type PilotWalletErrorCode =
  | "DEV_SIGNER_DISABLED"
  | "DEV_SIGNER_CLAIM_UNAVAILABLE"
  | "DEV_SIGNER_RECOVERY_REQUIRED"
  | "DEV_SIGNER_REVOCATION_REQUIRED"
  | "DEV_SIGNER_UNTRUSTED_LOCATION"
  | "DEV_SIGNER_UNSUPPORTED_NETWORK"
  | "MAINNET_SIGNING_DISABLED"
  | "NOT_CONNECTED"
  | "INVALID_TRANSACTION"
  | "ACCOUNT_MISMATCH"
  | "WALLET_NOT_INSTALLED"
  | "WALLET_UNAVAILABLE"
  | "WALLET_NETWORK_MISMATCH"
  | "CONNECT_CANCELLED"
  | "CONNECT_FAILED"
  | "SIGN_CANCELLED"
  | "SIGN_FAILED"
  | "LEDGER_BLIND_SIGNING_DISABLED"
  | "LEDGER_LOCKED"
  | "LEDGER_APP_NOT_OPEN"
  | "LEDGER_UNSUPPORTED_BROWSER"
  | "LEDGER_VIRTUAL_UNAVAILABLE"
  | "MISSING_SIGNED_BLOB"
  | "LEGACY_DEV_SIGNER_RECOVERY_REQUIRED"
  | "LIFECYCLE_STORAGE_UNAVAILABLE"
  | "SESSION_STORAGE_UNAVAILABLE";

/** A sanitized error that never carries wallet or seed material in its text. */
export class PilotWalletError extends Error {
  readonly code: PilotWalletErrorCode;

  constructor(code: PilotWalletErrorCode, message: string) {
    super(message);
    this.name = "PilotWalletError";
    this.code = code;
  }
}
