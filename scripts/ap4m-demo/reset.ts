import { pathToFileURL } from "node:url";

export type DemoMode = "mock" | "sandbox";
export type DemoNetwork = "testnet";

export type PublicAddressBook = {
  owner: string;
  harborPayer: string;
  demoNetworkIssuer: string;
  merchants: readonly [string, string];
  stableIssuer: string;
};

export type DemoPolicy = {
  ap4m_enabled: true;
  x402_max_per_call_drops: "100000";
  max_per_tx_usd: number;
};

export type ResetInput = {
  network: DemoNetwork;
  mode: DemoMode;
  stableCurrency: string;
  maxPerTxUsd?: number;
  timeoutMs?: number;
};

export type ResetResult = {
  version: "ap4m-demo-reset/v1";
  network: DemoNetwork;
  mode: DemoMode;
  mockOnly: boolean;
  durationMs: number;
  publicAddresses: PublicAddressBook;
  stableAsset: { currency: string; issuer: string };
  policy: DemoPolicy;
  transactionHashes: string[];
};

export type ResetDependencies = {
  now?: () => number;
  createFreshOwnerBudget(signal: AbortSignal): Promise<{
    owner: string;
    faucetTransactionHashes: string[];
  }>;
  readHarborPayer(signal: AbortSignal): Promise<string>;
  readDemoNetworkIssuer(signal: AbortSignal): Promise<string>;
  issueCredential(
    subject: string,
    signal: AbortSignal,
  ): Promise<{ transactionHash: string }>;
  acceptHarborPayerCredential(
    payer: string,
    signal: AbortSignal,
  ): Promise<{ transactionHash: string }>;
  setupMerchants(signal: AbortSignal): Promise<{
    merchants: readonly [string, string];
    transactionHashes: string[];
  }>;
  ensureStableTrustLines(input: {
    accounts: readonly string[];
    currency: string;
    signal: AbortSignal;
  }): Promise<{ issuer: string; transactionHashes: string[] }>;
  configureHarbor(input: {
    owner: string;
    payer: string;
    policy: DemoPolicy;
    signal: AbortSignal;
  }): Promise<{ transactionHashes: string[] }>;
};

export class DemoResetError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DemoResetError";
  }
}

const CLASSIC_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/u;
const TX_HASH = /^[A-F0-9]{64}$/u;
const CURRENCY = /^(?:[A-Z0-9]{3}|[A-F0-9]{40})$/u;
const DEFAULT_TIMEOUT_MS = 59_000;

function requireAddress(value: string, label: string): string {
  if (!CLASSIC_ADDRESS.test(value)) throw new DemoResetError(`INVALID_${label}_ADDRESS`);
  return value;
}

function requireHashes(values: readonly string[], label: string): string[] {
  if (!values.every((value) => TX_HASH.test(value))) {
    throw new DemoResetError(`INVALID_${label}_TRANSACTION_HASH`);
  }
  return [...values];
}

export function normalizeStableCurrency(value: string): string {
  const trimmed = value.trim();
  const normalized = trimmed.toUpperCase();
  if (CURRENCY.test(normalized) && normalized !== "XRP") return normalized;
  const bytes = Buffer.from(trimmed, "utf8");
  if (bytes.length < 4 || bytes.length > 20) {
    throw new DemoResetError("INVALID_STABLE_CURRENCY");
  }
  return Buffer.from(normalized, "utf8").toString("hex").toUpperCase().padEnd(40, "0");
}

export function requireResetGate(
  input: ResetInput,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (input.network !== "testnet") throw new DemoResetError("TESTNET_REQUIRED");
  if (input.mode === "mock") {
    if (env.HARBOR_MOCK !== "1" || env.MASTERCARD_OF_MODE !== "mock") {
      throw new DemoResetError("MOCK_GATE_REQUIRED");
    }
    return;
  }
  if (
    env.LIVE !== "1" ||
    env.HARBOR_MOCK !== "0" ||
    env.MASTERCARD_OF_MODE !== "sandbox" ||
    env.EXEC_NETWORK !== "testnet"
  ) {
    throw new DemoResetError("EVENT_LIVE_GATE_REQUIRED");
  }
}

export function demoPolicy(maxPerTxUsd = 5): DemoPolicy {
  if (!Number.isFinite(maxPerTxUsd) || maxPerTxUsd < 5) {
    throw new DemoResetError("MAX_PER_TX_USD_TOO_LOW");
  }
  return {
    ap4m_enabled: true,
    x402_max_per_call_drops: "100000",
    max_per_tx_usd: maxPerTxUsd,
  };
}

/** Formats only public account coordinates; transaction details stay in evidence. */
export function formatResetPublicSummary(result: ResetResult): string {
  const { publicAddresses } = result;
  return [
    `[ap4m-reset] network=${result.network} mode=${result.mode}`,
    `owner=${publicAddresses.owner}`,
    `harbor_payer=${publicAddresses.harborPayer}`,
    `demo_network_issuer=${publicAddresses.demoNetworkIssuer}`,
    `merchant_1=${publicAddresses.merchants[0]}`,
    `merchant_2=${publicAddresses.merchants[1]}`,
    `stable_issuer=${publicAddresses.stableIssuer}`,
  ].join("\n");
}

/**
 * Executes the reset plan through injected adapters only. This module deliberately
 * has no default wallet, faucet, signer, XRPL or credential implementation: those
 * remain event-day bindings and cannot be reached accidentally by importing it.
 */
export async function runDemoReset(
  input: ResetInput,
  dependencies: ResetDependencies,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ResetResult> {
  requireResetGate(input, env);
  const currency = normalizeStableCurrency(input.stableCurrency);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new DemoResetError("INVALID_TIMEOUT");
  }

  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const signal = controller.signal;

  const guard = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (signal.aborted) throw new DemoResetError("RESET_TIMEOUT");
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const onAbort = (): void => rejectPromise(new DemoResetError("RESET_TIMEOUT"));
      signal.addEventListener("abort", onAbort, { once: true });
      operation().then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolvePromise(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          rejectPromise(signal.aborted ? new DemoResetError("RESET_TIMEOUT") : error);
        },
      );
    });
  };

  try {
    const ownerResult = await guard(() => dependencies.createFreshOwnerBudget(signal));
    const owner = requireAddress(ownerResult.owner, "OWNER");
    const payer = requireAddress(
      await guard(() => dependencies.readHarborPayer(signal)),
      "HARBOR_PAYER",
    );
    const demoNetworkIssuer = requireAddress(
      await guard(() => dependencies.readDemoNetworkIssuer(signal)),
      "DEMO_NETWORK_ISSUER",
    );

    // Credential issue is intentionally explicit for both subjects. Only the
    // Harbor payer accepts on-ledger because it is the autonomous payer.
    const ownerCredential = await guard(() => dependencies.issueCredential(owner, signal));
    const payerCredential = await guard(() => dependencies.issueCredential(payer, signal));
    const accepted = await guard(() => dependencies.acceptHarborPayerCredential(payer, signal));
    const merchantSetup = await guard(() => dependencies.setupMerchants(signal));
    const merchants = merchantSetup.merchants.map((address, index) =>
      requireAddress(address, `MERCHANT_${index + 1}`),
    ) as unknown as readonly [string, string];
    if (new Set(merchants).size !== 2) throw new DemoResetError("MERCHANTS_MUST_BE_DISTINCT");

    const trustLines = await guard(() => dependencies.ensureStableTrustLines({
      accounts: [owner, payer, ...merchants],
      currency,
      signal,
    }));
    const stableIssuer = requireAddress(trustLines.issuer, "STABLE_ISSUER");
    const policy = demoPolicy(input.maxPerTxUsd);
    const harbor = await guard(() => dependencies.configureHarbor({
      owner,
      payer,
      policy,
      signal,
    }));

    const transactionHashes = requireHashes([
      ...ownerResult.faucetTransactionHashes,
      ownerCredential.transactionHash,
      payerCredential.transactionHash,
      accepted.transactionHash,
      ...merchantSetup.transactionHashes,
      ...trustLines.transactionHashes,
      ...harbor.transactionHashes,
    ], "RESET");
    const durationMs = Math.max(0, now() - startedAt);
    if (durationMs >= 60_000) throw new DemoResetError("RESET_EXCEEDED_60_SECONDS");

    return {
      version: "ap4m-demo-reset/v1",
      network: "testnet",
      mode: input.mode,
      mockOnly: input.mode === "mock",
      durationMs,
      publicAddresses: {
        owner,
        harborPayer: payer,
        demoNetworkIssuer,
        merchants,
        stableIssuer,
      },
      stableAsset: { currency, issuer: stableIssuer },
      policy,
      transactionHashes,
    };
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

function parseCli(argv: readonly string[]): ResetInput {
  if (argv.length !== 2 || argv[0] !== "--plan" || argv[1] !== "mock") {
    throw new DemoResetError("INJECTED_ADAPTER_REQUIRED");
  }
  return { network: "testnet", mode: "mock", stableCurrency: "RLUSD" };
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  parseCli(argv);
  // The command intentionally does not invent wallet/network adapters. Operators
  // must call runDemoReset with the approved event-day bindings.
  throw new DemoResetError("INJECTED_ADAPTER_REQUIRED");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    const code = error instanceof DemoResetError ? error.code : "RESET_FAILED";
    console.error(`[ap4m-reset] ${code}`);
    process.exitCode = 1;
  });
}
