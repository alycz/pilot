import { pathToFileURL } from "node:url";

import {
  Client,
  Wallet,
  isValidClassicAddress,
  type Payment,
  type SubmittableTransaction,
} from "xrpl";

const TESTNET_NETWORK_ID = 1;
const UINT_DROPS = /^(?:0|[1-9]\d*)$/u;
const HASH = /^[A-F0-9]{64}$/u;
const MAX_ROGUE_DROPS = 100_000_000_000_000_000n;

export type RogueEvidenceSource = "offline-injected" | "live-testnet";

export interface RogueEvidence {
  schema: "ap4m_rogue_v1";
  source: RogueEvidenceSource;
  network: "testnet";
  outcome: "rejected";
  engine_result: string;
  tx_hash: string | null;
  rogue_address: string | null;
  submitted: boolean;
  verified_live: boolean;
  at: string;
  label: string;
}

export interface LiveRogueConfig {
  live: boolean;
  network: string;
  endpoint: string;
  merchantAddress: string;
  amountDrops: string;
}

export interface RogueWallet {
  address: string;
  sign(transaction: SubmittableTransaction): { hash: string; tx_blob: string };
}

export interface RogueClient {
  networkID?: number;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  fundWallet(wallet: RogueWallet): Promise<unknown>;
  autofill(transaction: Payment): Promise<SubmittableTransaction>;
  submitAndWait(blob: string): Promise<{
    result: {
      hash?: string;
      validated?: boolean;
      meta?: string | { TransactionResult?: string };
    };
  }>;
}

export interface LiveRogueDependencies {
  createClient(endpoint: string): RogueClient;
  generateWallet(): RogueWallet;
  now(): Date;
}

export class RogueAgentError extends Error {
  constructor(
    message: string,
    readonly code:
      | "LIVE_REQUIRED"
      | "TESTNET_REQUIRED"
      | "INVALID_CONFIG"
      | "TESTNET_REJECTION_UNVERIFIED",
  ) {
    super(message);
    this.name = "RogueAgentError";
  }
}

const liveDependencies: LiveRogueDependencies = {
  createClient: (endpoint) => new Client(endpoint) as unknown as RogueClient,
  generateWallet: () => Wallet.generate() as unknown as RogueWallet,
  now: () => new Date(),
};

function iso(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new RogueAgentError("Rogue evidence clock is invalid.", "INVALID_CONFIG");
  }
  return value.toISOString();
}

function boundedEngineResult(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]{2,63}$/u.test(value)) {
    throw new RogueAgentError("XRPL returned an invalid engine result.", "TESTNET_REJECTION_UNVERIFIED");
  }
  return value;
}

/**
 * Build the exact public safety-evidence envelope. Offline callers must retain
 * the injected label and can never be mistaken for a verified Testnet run.
 */
export function recordRogueRejection(input: {
  source: RogueEvidenceSource;
  engineResult: string;
  txHash?: string | null;
  rogueAddress?: string | null;
  at: Date;
}): RogueEvidence {
  const engineResult = boundedEngineResult(input.engineResult);
  const live = input.source === "live-testnet";
  const txHash = input.txHash ?? null;
  const rogueAddress = input.rogueAddress ?? null;
  if (live) {
    if (engineResult !== "tecNO_PERMISSION" || txHash === null || !HASH.test(txHash)) {
      throw new RogueAgentError(
        "The expected Testnet credential rejection was not proven.",
        "TESTNET_REJECTION_UNVERIFIED",
      );
    }
    if (rogueAddress === null || !isValidClassicAddress(rogueAddress)) {
      throw new RogueAgentError("The rogue Testnet address is invalid.", "TESTNET_REJECTION_UNVERIFIED");
    }
  } else if (txHash !== null || rogueAddress !== null) {
    throw new RogueAgentError(
      "Offline evidence must not carry ledger hashes or generated accounts.",
      "TESTNET_REJECTION_UNVERIFIED",
    );
  }
  return {
    schema: "ap4m_rogue_v1",
    source: input.source,
    network: "testnet",
    outcome: "rejected",
    engine_result: engineResult,
    tx_hash: txHash,
    rogue_address: rogueAddress,
    submitted: live,
    verified_live: live,
    at: iso(input.at),
    label: live
      ? "Verified XRPL Testnet safety evidence"
      : "Mock-only safety evidence · LIVE Testnet check pending",
  };
}

export function offlinePendingRogueEvidence(at = new Date()): RogueEvidence {
  return recordRogueRejection({
    source: "offline-injected",
    engineResult: "tecNO_PERMISSION",
    txHash: null,
    rogueAddress: null,
    at,
  });
}

function validateLiveConfig(config: LiveRogueConfig): void {
  if (!config.live) {
    throw new RogueAgentError("Rogue Testnet execution requires explicit LIVE=1.", "LIVE_REQUIRED");
  }
  if (config.network !== "testnet") {
    throw new RogueAgentError("Rogue execution is restricted to XRPL Testnet.", "TESTNET_REQUIRED");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    throw new RogueAgentError("XRPL Testnet endpoint is invalid.", "INVALID_CONFIG");
  }
  if (
    endpoint.protocol !== "wss:"
    || !endpoint.hostname
    || endpoint.username.length > 0
    || endpoint.password.length > 0
    || endpoint.hash.length > 0
  ) {
    throw new RogueAgentError("XRPL Testnet endpoint must use wss.", "INVALID_CONFIG");
  }
  if (!isValidClassicAddress(config.merchantAddress)) {
    throw new RogueAgentError("Merchant A address is invalid.", "INVALID_CONFIG");
  }
  if (
    !UINT_DROPS.test(config.amountDrops)
    || config.amountDrops.length > 18
    || BigInt(config.amountDrops) <= 0n
    || BigInt(config.amountDrops) > MAX_ROGUE_DROPS
  ) {
    throw new RogueAgentError("Rogue payment amount must be positive canonical drops.", "INVALID_CONFIG");
  }
}

function transactionResult(meta: string | { TransactionResult?: string } | undefined): string {
  if (typeof meta !== "object" || meta === null || typeof meta.TransactionResult !== "string") {
    throw new RogueAgentError("Validated Testnet metadata is missing.", "TESTNET_REJECTION_UNVERIFIED");
  }
  return boundedEngineResult(meta.TransactionResult);
}

/**
 * Event-day LIVE check only. The explicit gates and connected-network check run
 * before account generation, funding, signing, or submission.
 */
export async function runLiveRogueAgent(
  config: LiveRogueConfig,
  dependencies: LiveRogueDependencies = liveDependencies,
): Promise<RogueEvidence> {
  validateLiveConfig(config);
  const client = dependencies.createClient(config.endpoint);
  await client.connect();
  try {
    if (client.networkID !== TESTNET_NETWORK_ID) {
      throw new RogueAgentError(
        `Connected XRPL network ${String(client.networkID)} is not Testnet.`,
        "TESTNET_REQUIRED",
      );
    }
    const wallet = dependencies.generateWallet();
    if (!isValidClassicAddress(wallet.address)) {
      throw new RogueAgentError("Generated Testnet account is invalid.", "INVALID_CONFIG");
    }
    await client.fundWallet(wallet);
    const prepared = await client.autofill({
      TransactionType: "Payment",
      Account: wallet.address,
      Destination: config.merchantAddress,
      Amount: config.amountDrops,
    });
    const signed = wallet.sign(prepared);
    const response = await client.submitAndWait(signed.tx_blob);
    if (response.result.validated !== true) {
      throw new RogueAgentError(
        "Rogue transaction was not validated on Testnet.",
        "TESTNET_REJECTION_UNVERIFIED",
      );
    }
    const hash = response.result.hash ?? signed.hash;
    if (!HASH.test(hash) || hash !== signed.hash) {
      throw new RogueAgentError("Validated transaction hash is inconsistent.", "TESTNET_REJECTION_UNVERIFIED");
    }
    return recordRogueRejection({
      source: "live-testnet",
      engineResult: transactionResult(response.result.meta),
      txHash: hash,
      rogueAddress: wallet.address,
      at: dependencies.now(),
    });
  } finally {
    await client.disconnect();
  }
}

export function liveConfigFromEnvironment(env: NodeJS.ProcessEnv): LiveRogueConfig {
  return {
    live: env.LIVE === "1",
    network: env.EXEC_NETWORK ?? "",
    endpoint: env.XRPL_TESTNET_URL ?? "",
    merchantAddress: env.AP4M_MERCHANT_A_ADDRESS ?? "",
    amountDrops: env.AP4M_ROGUE_AMOUNT_DROPS ?? "1",
  };
}

async function main(): Promise<void> {
  const evidence = await runLiveRogueAgent(liveConfigFromEnvironment(process.env));
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const safe = error instanceof RogueAgentError
      ? { ok: false, code: error.code, message: error.message }
      : { ok: false, code: "ROGUE_CHECK_FAILED", message: "Rogue Testnet check failed." };
    process.stderr.write(`${JSON.stringify(safe)}\n`);
    process.exitCode = 1;
  });
}
