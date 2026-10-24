/**
 * Browser-only owner signing for Pilot.
 *
 * This package intentionally exposes no submit operation. Signed blobs are
 * returned to the caller so they can be relayed through Pilot's Harbor proxy.
 */
import type { Network } from "@pilot/contracts";
import { Wallet as XrplWallet, isValidClassicAddress } from "xrpl";
import type { SubmittableTransaction } from "xrpl";
import {
  CrossmarkAdapter,
  GemWalletAdapter,
  XamanAdapter,
  WalletErrorCode as XrplConnectErrorCode,
} from "xrpl-connect";
import type {
  AccountInfo,
  ConnectOptions,
  NetworkConfig,
  SignedTransaction,
} from "xrpl-connect";
import {
  PILOT_ISOLATED_BUILD_MARKER,
  PILOT_ISOLATED_ORIGIN,
} from "./isolation-profile.js";
import { createLedgerWallet } from "./ledger/facade.js";
import { PilotWalletError } from "./types.js";
import type {
  CreateWalletOptions,
  PilotWallet,
  WalletProvider,
} from "./types.js";

export { PilotWalletError } from "./types.js";
export type {
  CreateWalletOptions,
  LedgerDeviceState,
  PilotWallet,
  PilotWalletErrorCode,
  WalletProvider,
} from "./types.js";

export {
  ledgerSigningMode,
  type LedgerSigningMode,
} from "./ledger/clear-sign.js";

export {
  ExactActionPolicyError,
  LedgerApprovalTransitionError,
  createLedgerApprovalState,
  ledgerRuntimeProvenance,
  transitionLedgerApproval,
  validateExactLedgerAction,
  verifyExactLedgerSignedBlob,
  type ExactActionPolicyErrorCode,
  type ExactActionValidationPhase,
  type ExactLedgerActionExpectation,
  type ExactLedgerActionReview,
  type LedgerApprovalEvent,
  type LedgerApprovalState,
  type LedgerApprovalStatus,
  type LedgerRuntime,
  type LedgerRuntimeProvenance,
  type VerifiedExactLedgerSignedBlob,
} from "./ledger/exact-action.js";

export {
  IssuedAssetX402SigningRequestSchema,
  IssuedPaymentPolicyError,
  LedgerIssuedPaymentAppConfigSchema,
  PILOT_ISSUED_PAYMENT_MAX_FEE_DROPS,
  PILOT_ISSUED_PAYMENT_MAX_LEDGER_WINDOW,
  PILOT_ISSUED_PAYMENT_MAX_QUOTE_TTL_MS,
  PILOT_ISSUED_PAYMENT_XRP_APP_VERSION,
  XRPL_TESTNET_CAIP2,
  bindIssuedAssetX402SigningRequest,
  issuedAssetX402ApprovalEnvelope,
  issuedAssetX402AssetId,
  verifyIssuedAssetX402SignedBlob,
  type BoundIssuedAssetX402SigningRequest,
  type IssuedAssetX402SigningRequest,
  type IssuedPaymentPolicyErrorCode,
  type LedgerIssuedPaymentAppConfig,
  type VerifiedIssuedAssetX402SignedBlob,
} from "./ledger/issued-payment.js";
export {
  X402_OWNER_APPROVAL_DOMAIN,
  IssuedX402OwnerApprovalEnvelopeSchema,
  X402ApprovalCommitmentError,
  canonicalIssuedX402ApprovalEnvelope,
  digestIssuedX402ApprovalEnvelope,
  verifyIssuedX402ApprovalCommitment,
  type IssuedX402OwnerApprovalEnvelope,
  type X402ApprovalCommitmentErrorCode,
} from "./ledger/x402-approval-envelope.js";

export const WALLET_PROVIDERS = [
  "ledger",
  "gemwallet",
  "crossmark",
  "xaman",
  "dev",
] as const satisfies readonly WalletProvider[];

interface SignOnlyAdapter {
  isAvailable(): Promise<boolean>;
  connect(options?: ConnectOptions): Promise<AccountInfo>;
  disconnect(): Promise<void>;
  sign(transaction: SubmittableTransaction): Promise<SignedTransaction>;
}

const NETWORK_CONFIG: Record<Network, NetworkConfig> = {
  mainnet: "mainnet",
  testnet: "testnet",
  devnet: "devnet",
  "lending-devnet": {
    id: "lending-devnet",
    name: "XRPL Lending Devnet",
    wss: "wss://lend.devnet.rippletest.net:51233",
    rpc: "https://lend.devnet.rippletest.net:51234",
  },
};

const LEGACY_DEV_SESSION_PREFIX = "pilot.wallet.dev.v1";
const DEV_SESSION_PREFIX = "pilot.wallet.dev.v2";
const DEV_LIFECYCLE_PREFIX = "pilot.wallet.dev.lifecycle.v1";
const DEV_CLAIM_PREFIX = "pilot.wallet.dev.claim.v1";

type DevLifecycleMarker = {
  version: 1;
  account: string;
  context_binding: string;
  network: "testnet" | "devnet";
  status: "owner_present" | "revoked";
};

let devSignerContextBinding: string | undefined;

/**
 * Create a fixed-provider wallet facade. To change providers, disconnect and
 * create another facade. This keeps a pending wallet prompt bound to the
 * provider the user selected.
 */
export function createWallet(options: CreateWalletOptions = {}): PilotWallet {
  const provider = options.provider ?? "gemwallet";
  const network = options.network ?? "testnet";

  if (provider === "ledger") {
    return createLedgerWallet(network, options.ledger ?? { transport: "webhid" });
  }

  if (provider === "dev") {
    return new DevSignerWallet(network);
  }

  return new XrplConnectWallet(
    provider,
    network,
    createAdapter(provider, options.xamanApiKey),
  );
}

function createAdapter(
  provider: Exclude<WalletProvider, "dev" | "ledger">,
  xamanApiKey: string | undefined,
): SignOnlyAdapter {
  switch (provider) {
    case "gemwallet":
      return new GemWalletAdapter();
    case "crossmark":
      return new CrossmarkAdapter();
    case "xaman":
      return new XamanAdapter({ apiKey: xamanApiKey });
  }
}

class XrplConnectWallet implements PilotWallet {
  private connectedAddress: string | undefined;
  private availableGeneration: number | undefined;
  private availabilityRequest: Promise<void> | undefined;
  private connectRequest: Promise<string> | undefined;
  private connectionGeneration = 0;
  private signQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly provider: Exclude<WalletProvider, "dev" | "ledger">,
    readonly network: Network,
    private readonly adapter: SignOnlyAdapter,
  ) {}

  checkAvailability(): Promise<void> {
    if (this.availableGeneration === this.connectionGeneration) {
      return Promise.resolve();
    }
    if (this.availabilityRequest !== undefined) return this.availabilityRequest;

    const generation = this.connectionGeneration;
    const pending = Promise.resolve()
      .then(async () => {
        let available: boolean;
        try {
          available = await this.adapter.isAvailable();
        } catch {
          throw new PilotWalletError(
            "WALLET_UNAVAILABLE",
            "The selected wallet extension is temporarily unavailable. Unlock it and try again.",
          );
        }
        if (generation !== this.connectionGeneration) {
          throw new PilotWalletError(
            "CONNECT_CANCELLED",
            "The wallet availability check was cancelled.",
          );
        }
        if (!available) {
          throw new PilotWalletError(
            "WALLET_NOT_INSTALLED",
            "The selected wallet extension is not installed or available in this browser.",
          );
        }
        this.availableGeneration = generation;
      })
      .finally(() => {
        if (this.availabilityRequest === pending) this.availabilityRequest = undefined;
      });

    this.availabilityRequest = pending;
    return pending;
  }

  connect(): Promise<string> {
    if (this.connectedAddress !== undefined) {
      return Promise.resolve(this.connectedAddress);
    }
    if (this.connectRequest !== undefined) {
      return this.connectRequest;
    }

    const generation = this.connectionGeneration;
    const pending = Promise.resolve()
      .then(async () => {
        if (generation !== this.connectionGeneration) {
          throw new PilotWalletError(
            "CONNECT_CANCELLED",
            "The wallet connection request was cancelled.",
          );
        }
        await this.checkAvailability();
        if (generation !== this.connectionGeneration) {
          throw new PilotWalletError(
            "CONNECT_CANCELLED",
            "The wallet connection request was cancelled.",
          );
        }
        return this.adapter.connect({ network: NETWORK_CONFIG[this.network] });
      })
      .then((account) => {
        if (generation !== this.connectionGeneration) {
          throw new PilotWalletError(
            "CONNECT_CANCELLED",
            "The wallet connection request was cancelled.",
          );
        }
        if (!isClassicAddress(account.address)) {
          throw new PilotWalletError(
            "CONNECT_FAILED",
            "The wallet did not return a valid XRPL account.",
          );
        }
        if (account.network.id !== this.network) {
          throw new PilotWalletError(
            "WALLET_NETWORK_MISMATCH",
            `The wallet is connected to a different XRPL network. Switch it to ${networkDisplayName(this.network)} and try again.`,
          );
        }
        this.connectedAddress = account.address;
        return account.address;
      })
      .catch((error: unknown) => {
        if (error instanceof PilotWalletError) throw error;
        throw normalizeConnectError(error);
      })
      .finally(() => {
        if (this.connectRequest === pending) this.connectRequest = undefined;
      });

    this.connectRequest = pending;
    return pending;
  }

  address(): string {
    if (this.connectedAddress === undefined) {
      throw new PilotWalletError(
        "NOT_CONNECTED",
        "Connect a wallet before requesting its address.",
      );
    }
    return this.connectedAddress;
  }

  signOnly(txJson: Record<string, unknown>): Promise<string> {
    const run = this.signQueue.then(async () => {
      assertSigningAllowed(this.network);
      const account = this.address();
      const transaction = prepareTransaction(txJson, account);
      const generation = this.connectionGeneration;

      let signed: SignedTransaction;
      try {
        // Deliberately call only sign(). signAndSubmit() is not reachable from
        // Pilot's public wallet interface.
        signed = await this.adapter.sign(transaction);
      } catch (error: unknown) {
        throw normalizeSignError(error);
      }

      if (generation !== this.connectionGeneration) {
        throw new PilotWalletError(
          "SIGN_CANCELLED",
          "The wallet signing request was cancelled.",
        );
      }

      if (typeof signed.tx_blob !== "string" || signed.tx_blob.length === 0) {
        throw new PilotWalletError(
          "MISSING_SIGNED_BLOB",
          "The wallet signed the request but did not return a transaction blob.",
        );
      }
      return signed.tx_blob;
    });

    // A rejected prompt must not poison later signing attempts.
    this.signQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async disconnect(): Promise<void> {
    this.connectionGeneration += 1;
    this.connectedAddress = undefined;
    this.availableGeneration = undefined;
    this.availabilityRequest = undefined;
    this.connectRequest = undefined;
    try {
      await this.adapter.disconnect();
    } catch {
      // Local state is disconnected even when an extension cannot acknowledge
      // teardown. No provider error details are surfaced or logged here.
    }
  }

  forget(): Promise<void> {
    return this.disconnect();
  }
}

class DevSignerWallet implements PilotWallet {
  readonly provider = "dev" as const;
  #wallet: XrplWallet | undefined;
  private lifetimeClaim: DevSignerLifetimeClaim | undefined;
  private connectRequest: Promise<string> | undefined;
  private connectionGeneration = 0;
  private signQueue: Promise<void> = Promise.resolve();

  constructor(readonly network: Network) {}

  connect(): Promise<string> {
    const network = this.network;
    try {
      assertDevSignerEnabled();
      assertDevSignerNetwork(network);
      assertDevSignerLocation();
    } catch (error: unknown) {
      return Promise.reject(error);
    }

    if (this.connectRequest !== undefined) return this.connectRequest;

    const generation = this.connectionGeneration;
    const pending = acquireDevSignerLifetimeClaim(network).then(({ claim, created }) => {
      try {
        if (generation !== this.connectionGeneration) {
          throw new PilotWalletError(
            "CONNECT_CANCELLED",
            "The development signer connection was cancelled.",
          );
        }
        assertDevSignerClaimActive(claim, network);
        const contextBinding = getDevSignerContextBinding();
        assertDevSignerLocation();
        const storage = getSessionStorage();
        const legacyKey = devSessionKey(LEGACY_DEV_SESSION_PREFIX, network);
        const key = devSessionKey(DEV_SESSION_PREFIX, network);
        const lifecycleKey = devSessionKey(DEV_LIFECYCLE_PREFIX, network);
        if (safeHasKey(storage, legacyKey)) {
          throw new PilotWalletError(
            "LEGACY_DEV_SIGNER_RECOVERY_REQUIRED",
            "A legacy development signer session requires manual recovery before Pilot can connect.",
          );
        }

        const lifecycleStorage = getLifecycleStorage();
        const marker = readLifecycleMarker(lifecycleStorage, lifecycleKey, network);
        if (this.#wallet !== undefined) {
          if (this.lifetimeClaim !== claim) throw claimUnavailable();
          assertActiveLifecycle(
            marker,
            this.#wallet.address,
            network,
            contextBinding,
          );
          return this.#wallet.address;
        }

        const stored = safeGet(storage, key);
        if (stored !== null) {
          let wallet: XrplWallet;
          try {
            wallet = XrplWallet.fromSeed(stored);
          } catch {
            throw recoveryRequired();
          }
          assertActiveLifecycle(marker, wallet.address, network, contextBinding);
          this.#wallet = wallet;
          this.lifetimeClaim = claim;
          return wallet.address;
        }

        if (marker !== undefined) throw recoveryRequired();

        let wallet: XrplWallet;
        try {
          wallet = XrplWallet.generate();
        } catch {
          throw new PilotWalletError(
            "CONNECT_FAILED",
            "The development signer could not create a test account.",
          );
        }
        if (wallet.seed === undefined) {
          throw new PilotWalletError(
            "CONNECT_FAILED",
            "The development signer could not create a test account.",
          );
        }
        safeSet(storage, key, wallet.seed);
        try {
          writeLifecycleMarker(lifecycleStorage, lifecycleKey, {
            version: 1,
            account: wallet.address,
            context_binding: contextBinding,
            network,
            status: "owner_present",
          });
        } catch (error: unknown) {
          // A seed without its durable public owner marker could be replaced by
          // a later tab. Roll it back before surfacing the sanitized failure.
          safeRemove(storage, key);
          throw error;
        }

        if (generation !== this.connectionGeneration) {
          throw new PilotWalletError(
            "CONNECT_CANCELLED",
            "The development signer connection was cancelled.",
          );
        }
        this.#wallet = wallet;
        this.lifetimeClaim = claim;
        return wallet.address;
      } catch (error: unknown) {
        if (created) releaseDevSignerClaim(claim);
        throw error;
      }
      })
      .finally(() => {
        if (this.connectRequest === pending) this.connectRequest = undefined;
      });

    this.connectRequest = pending;
    return pending;
  }

  address(): string {
    if (this.#wallet === undefined) {
      throw new PilotWalletError(
        "NOT_CONNECTED",
        "Connect the development signer before requesting its address.",
      );
    }
    return this.#wallet.address;
  }

  signOnly(txJson: Record<string, unknown>): Promise<string> {
    const generation = this.connectionGeneration;
    const run = this.signQueue.then(() => {
      if (generation !== this.connectionGeneration) {
        throw new PilotWalletError(
          "SIGN_CANCELLED",
          "The development signer request was cancelled.",
        );
      }
      assertDevSignerEnabled();
      assertDevSignerNetwork(this.network);
      assertDevSignerLocation();
      assertDevSignerClaimActive(this.lifetimeClaim, this.network);
      const contextBinding = getDevSignerContextBinding();
      const wallet = this.#wallet;
      if (wallet === undefined) {
        throw new PilotWalletError(
          "NOT_CONNECTED",
          "Connect the development signer before signing.",
        );
      }
      const marker = readLifecycleMarker(
        getLifecycleStorage(),
        devSessionKey(DEV_LIFECYCLE_PREFIX, this.network),
        this.network,
      );
      assertActiveLifecycle(
        marker,
        wallet.address,
        this.network,
        contextBinding,
      );

      const transaction = prepareTransaction(txJson, wallet.address);
      try {
        return wallet.sign(transaction).tx_blob;
      } catch {
        throw new PilotWalletError(
          "SIGN_FAILED",
          "The development signer could not sign the transaction.",
        );
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
    this.#wallet = undefined;
    this.connectRequest = undefined;
    // The seed intentionally remains in this tab's sessionStorage so a page
    // transition or wrapper recreation keeps the same test account.
  }

  async markRevocationVerified(): Promise<void> {
    assertDevSignerEnabled();
    assertDevSignerNetwork(this.network);
    assertDevSignerLocation();
    const wallet = this.#wallet;
    if (wallet === undefined) {
      throw new PilotWalletError(
        "NOT_CONNECTED",
        "Connect the development signer before recording owner revocation.",
      );
    }
    assertDevSignerClaimActive(this.lifetimeClaim, this.network);
    const contextBinding = getDevSignerContextBinding();
    const storage = getLifecycleStorage();
    const key = devSessionKey(DEV_LIFECYCLE_PREFIX, this.network);
    const marker = readLifecycleMarker(storage, key, this.network);
    assertActiveLifecycle(
      marker,
      wallet.address,
      this.network,
      contextBinding,
    );
    writeLifecycleMarker(storage, key, {
      version: 1,
      account: wallet.address,
      context_binding: contextBinding,
      network: this.network,
      status: "revoked",
    });
  }

  async forget(): Promise<void> {
    const network = this.network;
    assertDevSignerNetwork(network);

    const ownedClaim = this.lifetimeClaim;
    const { claim, created } = ownedClaim !== undefined
      ? { claim: ownedClaim, created: false }
      : await acquireDevSignerLifetimeClaim(network);
    try {
      assertDevSignerClaimActive(claim, network);
      const contextBinding = getDevSignerContextBinding();

      const lifecycleStorage = getLifecycleStorage();
      const lifecycleKey = devSessionKey(DEV_LIFECYCLE_PREFIX, network);
      const marker = readLifecycleMarker(lifecycleStorage, lifecycleKey, network);
      if (marker === undefined) throw recoveryRequired();
      if (marker.context_binding !== contextBinding) throw recoveryRequired();
      if (marker.status !== "revoked") {
        throw new PilotWalletError(
          "DEV_SIGNER_REVOCATION_REQUIRED",
          "Verified owner revocation is required before destroying the development signer.",
        );
      }
      const storage = getSessionStorage();
      const key = devSessionKey(DEV_SESSION_PREFIX, network);
      const stored = safeGet(storage, key);
      if (stored !== null) {
        let persistedWallet: XrplWallet;
        try {
          persistedWallet = XrplWallet.fromSeed(stored);
        } catch {
          throw recoveryRequired();
        }
        if (persistedWallet.address !== marker.account) throw recoveryRequired();
      }

      // Only after the durable exact-owner revocation marker is proven do we
      // invalidate queued work and clear the in-memory signer.
      this.connectionGeneration += 1;
      this.#wallet = undefined;
      this.lifetimeClaim = undefined;
      this.connectRequest = undefined;
      this.signQueue = Promise.resolve();

      // Legacy v1 credentials are intentionally outside this facade's cleanup
      // authority. They require an explicit, separately proven recovery path.
      safeRemove(storage, key);
      removeLifecycleMarker(lifecycleStorage, lifecycleKey);
      releaseDevSignerClaim(claim);
    } catch (error: unknown) {
      if (created) releaseDevSignerClaim(claim);
      throw error;
    }
  }
}

interface DevSignerLifetimeClaim {
  readonly network: "testnet" | "devnet";
  readonly locks: LockManager;
  active: boolean;
  released: boolean;
  release(): void;
  readonly acquired: Promise<void>;
}

const devSignerLifetimeClaims = new Map<
  "testnet" | "devnet",
  DevSignerLifetimeClaim
>();

function getDevSignerLockManager(): LockManager {
  let locks: LockManager | undefined;
  try {
    locks = globalThis.navigator?.locks;
  } catch {
    // Fall through to the sanitized claim error below.
  }
  if (locks === undefined) throw claimUnavailable();
  return locks;
}

/**
 * Hold one exclusive claim for the lifetime of this browsing context's signer.
 * Facades in the same module realm share it; another tab has a separate realm
 * and must acquire its own origin-scoped Web Lock. `ifAvailable` prevents a
 * child/opener tab from waiting indefinitely behind the active owner.
 */
async function acquireDevSignerLifetimeClaim(
  network: "testnet" | "devnet",
): Promise<{ claim: DevSignerLifetimeClaim; created: boolean }> {
  const locks = getDevSignerLockManager();
  const current = devSignerLifetimeClaims.get(network);
  if (current !== undefined && current.locks === locks && !current.released) {
    await current.acquired;
    return { claim: current, created: false };
  }
  if (current !== undefined) releaseDevSignerClaim(current);

  let resolveAcquired!: () => void;
  let rejectAcquired!: (error: PilotWalletError) => void;
  let resolveRelease!: () => void;
  let acquisitionSettled = false;
  const acquired = new Promise<void>((resolve, reject) => {
    resolveAcquired = () => {
      acquisitionSettled = true;
      resolve();
    };
    rejectAcquired = (error) => {
      acquisitionSettled = true;
      reject(error);
    };
  });
  const held = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });
  const claim: DevSignerLifetimeClaim = {
    network,
    locks,
    active: false,
    released: false,
    acquired,
    release() {
      if (claim.released) return;
      claim.released = true;
      claim.active = false;
      resolveRelease();
    },
  };
  devSignerLifetimeClaims.set(network, claim);

  let request: Promise<unknown>;
  try {
    request = locks.request(
      `${DEV_CLAIM_PREFIX}.${network}`,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (lock === null) {
          rejectAcquired(claimUnavailable());
          return;
        }
        claim.active = true;
        resolveAcquired();
        await held;
      },
    );
  } catch {
    rejectAcquired(claimUnavailable());
    claim.release();
    if (devSignerLifetimeClaims.get(network) === claim) {
      devSignerLifetimeClaims.delete(network);
    }
    return await acquired.then(() => ({ claim, created: true }));
  }

  void request.catch(() => {
    if (!acquisitionSettled) rejectAcquired(claimUnavailable());
  }).finally(() => {
    claim.active = false;
    claim.released = true;
    if (devSignerLifetimeClaims.get(network) === claim) {
      devSignerLifetimeClaims.delete(network);
    }
  });

  await acquired;
  assertDevSignerClaimActive(claim, network);
  return { claim, created: true };
}

function assertDevSignerClaimActive(
  claim: DevSignerLifetimeClaim | undefined,
  network: "testnet" | "devnet",
): asserts claim is DevSignerLifetimeClaim {
  if (
    claim === undefined || claim.network !== network || !claim.active ||
    claim.released || devSignerLifetimeClaims.get(network) !== claim
  ) throw claimUnavailable();
}

function releaseDevSignerClaim(claim: DevSignerLifetimeClaim): void {
  claim.release();
  if (devSignerLifetimeClaims.get(claim.network) === claim) {
    devSignerLifetimeClaims.delete(claim.network);
  }
}

function prepareTransaction(
  txJson: Record<string, unknown>,
  connectedAddress: string,
): SubmittableTransaction {
  if (
    txJson === null ||
    Array.isArray(txJson) ||
    typeof txJson.TransactionType !== "string" ||
    typeof txJson.Account !== "string"
  ) {
    throw new PilotWalletError(
      "INVALID_TRANSACTION",
      "A signable transaction requires TransactionType and Account.",
    );
  }
  if (txJson.Account !== connectedAddress) {
    throw new PilotWalletError(
      "ACCOUNT_MISMATCH",
      "The transaction account does not match the connected wallet.",
    );
  }
  if (
    txJson.TxnSignature !== undefined ||
    txJson.Signers !== undefined ||
    (txJson.SigningPubKey !== undefined && txJson.SigningPubKey !== "")
  ) {
    throw new PilotWalletError(
      "INVALID_TRANSACTION",
      "Pilot signs only unsigned single-sign transactions.",
    );
  }

  return { ...txJson } as SubmittableTransaction;
}

function assertSigningAllowed(network: Network): void {
  if (network === "mainnet") {
    throw new PilotWalletError(
      "MAINNET_SIGNING_DISABLED",
      "Pilot never signs transactions for XRPL mainnet.",
    );
  }
}

function assertDevSignerNetwork(network: Network): asserts network is
  | "testnet"
  | "devnet" {
  if (network === "mainnet") {
    throw new PilotWalletError(
      "MAINNET_SIGNING_DISABLED",
      "The development signer is restricted to XRPL test networks.",
    );
  }
  if (network === "lending-devnet") {
    throw new PilotWalletError(
      "DEV_SIGNER_UNSUPPORTED_NETWORK",
      "The development signer supports only XRPL testnet and devnet.",
    );
  }
}

function devSessionKey(prefix: string, network: "testnet" | "devnet"): string {
  return `${prefix}.${network}`;
}

function assertDevSignerEnabled(): void {
  if (
    typeof process === "undefined" ||
    process.env.NEXT_PUBLIC_DEV_SIGNER !== "1"
  ) {
    throw new PilotWalletError(
      "DEV_SIGNER_DISABLED",
      "The development signer is disabled.",
    );
  }
}

function assertDevSignerLocation(): void {
  let origin: unknown;
  let protocol: unknown;
  let hostname: unknown;
  let port: unknown;
  try {
    const location = globalThis.location;
    origin = location?.origin;
    protocol = location?.protocol;
    hostname = location?.hostname;
    port = location?.port;
  } catch {
    // Fall through to the sanitized location error below.
  }
  const expectedOrigin = process.env.NEXT_PUBLIC_PILOT_BUILD_MARKER === undefined
    ? "http://127.0.0.1:3003"
    : process.env.NEXT_PUBLIC_PILOT_BUILD_MARKER === PILOT_ISOLATED_BUILD_MARKER
      ? PILOT_ISOLATED_ORIGIN
      : undefined;
  const expectedHostname = expectedOrigin === PILOT_ISOLATED_ORIGIN
    ? "127.0.0.2"
    : expectedOrigin === "http://127.0.0.1:3003"
      ? "127.0.0.1"
      : undefined;
  if (
    expectedOrigin === undefined ||
    origin !== expectedOrigin ||
    protocol !== "http:" ||
    hostname !== expectedHostname ||
    port !== "3003"
  ) {
    throw new PilotWalletError(
      "DEV_SIGNER_UNTRUSTED_LOCATION",
      "The development signer is available only from Pilot's exact local browser origin.",
    );
  }
}

/**
 * This public random identifier exists only in the current module realm. It is
 * deliberately not stored with the seed, so a duplicated tab cannot inherit
 * signer authority by cloning sessionStorage. A full reload/crash loses the
 * binding and therefore requires manual recovery rather than silent takeover.
 */
function getDevSignerContextBinding(): string {
  if (devSignerContextBinding !== undefined) return devSignerContextBinding;
  let binding: unknown;
  try {
    binding = globalThis.crypto?.randomUUID();
  } catch {
    // Fall through to the sanitized claim error below.
  }
  if (
    typeof binding !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      binding,
    )
  ) throw claimUnavailable();
  devSignerContextBinding = binding;
  return binding;
}

function getSessionStorage(): Storage {
  try {
    const storage = globalThis.sessionStorage;
    if (storage !== undefined) return storage;
  } catch {
    // Fall through to the sanitized storage error below.
  }
  throw new PilotWalletError(
    "SESSION_STORAGE_UNAVAILABLE",
    "The development signer requires browser session storage.",
  );
}

function getLifecycleStorage(): Storage {
  try {
    const storage = globalThis.localStorage;
    if (storage !== undefined) return storage;
  } catch {
    // Fall through to the sanitized lifecycle-storage error below.
  }
  throw lifecycleStorageError();
}

function readLifecycleMarker(
  storage: Storage,
  key: string,
  network: "testnet" | "devnet",
): DevLifecycleMarker | undefined {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    throw lifecycleStorageError();
  }
  if (raw === null) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw recoveryRequired();
  }
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !==
      "account\0context_binding\0network\0status\0version"
  ) throw recoveryRequired();
  const marker = value as Record<string, unknown>;
  if (
    marker.version !== 1 || marker.network !== network ||
    !isClassicAddress(marker.account) ||
    typeof marker.context_binding !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      marker.context_binding,
    ) ||
    (marker.status !== "owner_present" && marker.status !== "revoked")
  ) throw recoveryRequired();
  return marker as DevLifecycleMarker;
}

function writeLifecycleMarker(
  storage: Storage,
  key: string,
  marker: DevLifecycleMarker,
): void {
  try {
    storage.setItem(key, JSON.stringify(marker));
  } catch {
    throw lifecycleStorageError();
  }
}

function removeLifecycleMarker(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    throw lifecycleStorageError();
  }
}

function assertActiveLifecycle(
  marker: DevLifecycleMarker | undefined,
  account: string,
  network: "testnet" | "devnet",
  contextBinding: string,
): asserts marker is DevLifecycleMarker & { status: "owner_present" } {
  if (
    marker === undefined || marker.account !== account ||
    marker.network !== network || marker.context_binding !== contextBinding ||
    marker.status !== "owner_present"
  ) throw recoveryRequired();
}

function recoveryRequired(): PilotWalletError {
  return new PilotWalletError(
    "DEV_SIGNER_RECOVERY_REQUIRED",
    "The development signer lifecycle requires manual recovery before Pilot can continue.",
  );
}

function claimUnavailable(): PilotWalletError {
  return new PilotWalletError(
    "DEV_SIGNER_CLAIM_UNAVAILABLE",
    "The development signer could not acquire its browser lifecycle claim.",
  );
}

function lifecycleStorageError(): PilotWalletError {
  return new PilotWalletError(
    "LIFECYCLE_STORAGE_UNAVAILABLE",
    "The development signer could not access its public lifecycle storage.",
  );
}

function safeGet(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    throw storageError();
  }
}

function safeHasKey(storage: Storage, expectedKey: string): boolean {
  try {
    for (let index = 0; index < storage.length; index += 1) {
      if (storage.key(index) === expectedKey) return true;
    }
    return false;
  } catch {
    throw storageError();
  }
}

function safeSet(storage: Storage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    throw storageError();
  }
}

function safeRemove(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    throw storageError();
  }
}

function storageError(): PilotWalletError {
  return new PilotWalletError(
    "SESSION_STORAGE_UNAVAILABLE",
    "The development signer could not access browser session storage.",
  );
}

function normalizeConnectError(error: unknown): PilotWalletError {
  if (
    hasErrorCode(error, XrplConnectErrorCode.CONNECTION_REJECTED) ||
    hasErrorCategory(error, "USER_ACTION")
  ) {
    return new PilotWalletError(
      "CONNECT_CANCELLED",
      "The wallet connection request was cancelled.",
    );
  }
  if (
    hasErrorCode(error, XrplConnectErrorCode.WALLET_NOT_FOUND) ||
    hasErrorCode(error, XrplConnectErrorCode.WALLET_NOT_INSTALLED)
  ) {
    return new PilotWalletError(
      "WALLET_NOT_INSTALLED",
      "The selected wallet extension is not installed or available in this browser.",
    );
  }
  if (
    hasErrorCode(error, XrplConnectErrorCode.NETWORK_MISMATCH) ||
    hasErrorCode(error, XrplConnectErrorCode.NETWORK_NOT_SUPPORTED)
  ) {
    return new PilotWalletError(
      "WALLET_NETWORK_MISMATCH",
      "The wallet is connected to a different or unsupported XRPL network.",
    );
  }
  if (
    hasErrorCode(error, XrplConnectErrorCode.WALLET_NOT_AVAILABLE) ||
    hasErrorCategory(error, "WALLET_UNAVAILABLE")
  ) {
    return new PilotWalletError(
      "WALLET_UNAVAILABLE",
      "The selected wallet extension is temporarily unavailable. Unlock it and try again.",
    );
  }
  return new PilotWalletError(
    "CONNECT_FAILED",
    "The wallet connection failed.",
  );
}

function networkDisplayName(network: Network): string {
  switch (network) {
    case "mainnet":
      return "XRPL Mainnet";
    case "testnet":
      return "XRPL Testnet";
    case "devnet":
      return "XRPL Devnet";
    case "lending-devnet":
      return "XRPL Lending Devnet";
  }
}

function normalizeSignError(error: unknown): PilotWalletError {
  if (
    hasErrorCode(error, XrplConnectErrorCode.SIGN_REJECTED) ||
    hasErrorCategory(error, "USER_ACTION")
  ) {
    return new PilotWalletError(
      "SIGN_CANCELLED",
      "The wallet signing request was cancelled.",
    );
  }
  return new PilotWalletError("SIGN_FAILED", "The wallet could not sign the transaction.");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function hasErrorCategory(error: unknown, category: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "category" in error &&
    error.category === category
  );
}

function isClassicAddress(address: unknown): address is string {
  return typeof address === "string" && isValidClassicAddress(address);
}
