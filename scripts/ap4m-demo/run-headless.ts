import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { DemoMode, PublicAddressBook } from "./reset";

export type SafetyMomentName =
  | "over_budget"
  | "altered_intent"
  | "rogue_agent"
  | "revoked_mandate";

export type HeadlessRunInput = {
  mode: DemoMode;
  network: "testnet";
  runTag: string;
};

export type OnboardingEvidence = {
  mandateId: string;
  publicAddresses: PublicAddressBook;
  transactionHashes: string[];
};

export type PurchaseEvidence = {
  paymentNumber: number;
  merchantId: string;
  sku: string;
  idempotencyKey: string;
  receiptId: string;
  scheme: "exact" | "xrpl-paychan";
  settlement: "validated" | "claim_accepted";
  transactionHashes: string[];
};

export type SafetyEvidence = {
  name: SafetyMomentName;
  result: "blocked";
  code: string;
  verification: "mock-only" | "testnet";
  transactionHashes: string[];
};

export type SettlementEvidence = {
  result: "redeemed";
  transactionHashes: string[];
};

export type LedgerAttestation = {
  verifier: "xrpl-ledger-verifier/v1";
  network: "testnet";
  networkId: 1;
  checkedAt: string;
  validatedTransactionHashes: string[];
};

export type HeadlessEvidence = {
  version: "ap4m-headless-evidence/v1";
  result: "PASS";
  evidenceKind: "mock-only" | "testnet";
  labels: {
    openFinance: "Mastercard Open Finance · mock" | "Mastercard Open Finance · sandbox";
    network: "XRPL Testnet";
    credentialIssuer: "Demo Network — Mastercard's role in production";
    merchantValidation: "Validation flow from Mastercard's Level 3 Agentic Commerce guide · payment object: XRPL";
    ap4mRail: "ap4m-sandbox · requires Mastercard early-access credentials";
    paymentRail: "XRPL payment object; no Mastercard-network money movement";
  };
  runTag: string;
  startedAt: string;
  finishedAt: string;
  network: "testnet";
  mode: DemoMode;
  onboarding: OnboardingEvidence;
  purchases: PurchaseEvidence[];
  safetyMoments: SafetyEvidence[];
  settlement: SettlementEvidence;
  ledgerAttestation?: LedgerAttestation;
  counters: {
    payments: 9;
    purchaseLedgerTransactions: number;
    settlementLedgerTransactions: number;
  };
  allTransactionHashes: string[];
};

export type HeadlessDependencies = {
  now?: () => Date;
  onboard(input: HeadlessRunInput): Promise<OnboardingEvidence>;
  purchase(input: {
    mandateId: string;
    paymentNumber: number;
    merchantId: string;
    sku: string;
    idempotencyKey: string;
  }): Promise<Omit<PurchaseEvidence, "paymentNumber" | "merchantId" | "sku" | "idempotencyKey">>;
  exerciseSafetyMoment(input: {
    name: SafetyMomentName;
    mandateId: string;
  }): Promise<Omit<SafetyEvidence, "name">>;
  settle(input: { mandateId: string }): Promise<SettlementEvidence>;
  verifyLedgerEvidence?(input: {
    network: "testnet";
    transactionHashes: readonly string[];
  }): Promise<LedgerAttestation>;
};

export class HeadlessRunError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "HeadlessRunError";
  }
}

const TX_HASH = /^[A-F0-9]{64}$/u;
const RUN_TAG = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFETY_MOMENTS: readonly SafetyMomentName[] = [
  "over_budget",
  "altered_intent",
  "rogue_agent",
  "revoked_mandate",
];
const PURCHASE_PLAN = Array.from({ length: 9 }, (_, index) => ({
  merchantId: index % 2 === 0 ? "venue-yield-desk" : "risk-oracle",
  sku: index % 2 === 0 ? "yield-report" : "risk-score",
}));

function validateIdentifier(value: string, code: string): string {
  if (!IDENTIFIER.test(value)) throw new HeadlessRunError(code);
  return value;
}

function validateHashes(values: readonly string[], code: string): string[] {
  if (!Array.isArray(values) || !values.every((value) => TX_HASH.test(value))) {
    throw new HeadlessRunError(code);
  }
  return [...values];
}

function validatePublicAddresses(addresses: PublicAddressBook): PublicAddressBook {
  const address = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/u;
  const values = [
    addresses.owner,
    addresses.harborPayer,
    addresses.demoNetworkIssuer,
    ...addresses.merchants,
    addresses.stableIssuer,
  ];
  if (!values.every((value) => address.test(value))) {
    throw new HeadlessRunError("INVALID_PUBLIC_ADDRESS");
  }
  return {
    owner: addresses.owner,
    harborPayer: addresses.harborPayer,
    demoNetworkIssuer: addresses.demoNetworkIssuer,
    merchants: [addresses.merchants[0], addresses.merchants[1]],
    stableIssuer: addresses.stableIssuer,
  };
}

export function requireHeadlessGate(
  input: HeadlessRunInput,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (input.network !== "testnet") throw new HeadlessRunError("TESTNET_REQUIRED");
  if (!RUN_TAG.test(input.runTag)) throw new HeadlessRunError("INVALID_RUN_TAG");
  if (input.mode === "mock") {
    if (env.HARBOR_MOCK !== "1" || env.MASTERCARD_OF_MODE !== "mock") {
      throw new HeadlessRunError("MOCK_GATE_REQUIRED");
    }
    return;
  }
  if (
    env.LIVE !== "1" ||
    env.HARBOR_MOCK !== "0" ||
    env.MASTERCARD_OF_MODE !== "sandbox" ||
    env.EXEC_NETWORK !== "testnet"
  ) {
    throw new HeadlessRunError("EVENT_LIVE_GATE_REQUIRED");
  }
}

export async function runHeadless(
  input: HeadlessRunInput,
  dependencies: HeadlessDependencies,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<HeadlessEvidence> {
  requireHeadlessGate(input, env);
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now().toISOString();

  const rawOnboarding = await dependencies.onboard(input);
  const onboarding: OnboardingEvidence = {
    mandateId: validateIdentifier(rawOnboarding.mandateId, "INVALID_MANDATE_ID"),
    publicAddresses: validatePublicAddresses(rawOnboarding.publicAddresses),
    transactionHashes: validateHashes(rawOnboarding.transactionHashes, "INVALID_ONBOARDING_HASH"),
  };

  const purchases: PurchaseEvidence[] = [];
  for (const [index, plan] of PURCHASE_PLAN.entries()) {
    const paymentNumber = index + 1;
    const idempotencyKey = `${input.runTag}-payment-${paymentNumber}`;
    const raw = await dependencies.purchase({
      mandateId: onboarding.mandateId,
      paymentNumber,
      merchantId: plan.merchantId,
      sku: plan.sku,
      idempotencyKey,
    });
    if (raw.scheme === "exact" && raw.settlement !== "validated") {
      throw new HeadlessRunError("EXACT_PURCHASE_NOT_VALIDATED");
    }
    if (raw.scheme === "xrpl-paychan" && raw.settlement !== "claim_accepted") {
      throw new HeadlessRunError("PAYCHAN_CLAIM_NOT_ACCEPTED");
    }
    purchases.push({
      paymentNumber,
      merchantId: plan.merchantId,
      sku: plan.sku,
      idempotencyKey,
      receiptId: validateIdentifier(raw.receiptId, "INVALID_RECEIPT_ID"),
      scheme: raw.scheme,
      settlement: raw.settlement,
      transactionHashes: validateHashes(raw.transactionHashes, "INVALID_PURCHASE_HASH"),
    });
  }

  const safetyMoments: SafetyEvidence[] = [];
  for (const name of SAFETY_MOMENTS) {
    const raw = await dependencies.exerciseSafetyMoment({
      name,
      mandateId: onboarding.mandateId,
    });
    if (raw.result !== "blocked") throw new HeadlessRunError(`SAFETY_${name.toUpperCase()}_NOT_BLOCKED`);
    if (input.mode === "mock" && raw.verification !== "mock-only") {
      throw new HeadlessRunError("MOCK_EVIDENCE_MISLABELLED");
    }
    if (input.mode === "sandbox" && raw.verification !== "testnet") {
      throw new HeadlessRunError("TESTNET_EVIDENCE_REQUIRED");
    }
    safetyMoments.push({
      name,
      result: "blocked",
      code: validateIdentifier(raw.code, `INVALID_SAFETY_${name.toUpperCase()}_CODE`),
      verification: raw.verification,
      transactionHashes: validateHashes(raw.transactionHashes, "INVALID_SAFETY_HASH"),
    });
  }

  const rawSettlement = await dependencies.settle({ mandateId: onboarding.mandateId });
  if (rawSettlement.result !== "redeemed") throw new HeadlessRunError("SETTLEMENT_NOT_REDEEMED");
  const settlement: SettlementEvidence = {
    result: "redeemed",
    transactionHashes: validateHashes(rawSettlement.transactionHashes, "INVALID_SETTLEMENT_HASH"),
  };
  if (settlement.transactionHashes.length === 0) {
    throw new HeadlessRunError("SETTLEMENT_HASH_REQUIRED");
  }

  const allTransactionHashes = [
    ...onboarding.transactionHashes,
    ...purchases.flatMap((purchase) => purchase.transactionHashes),
    ...safetyMoments.flatMap((moment) => moment.transactionHashes),
    ...settlement.transactionHashes,
  ];
  if (new Set(allTransactionHashes).size !== allTransactionHashes.length) {
    throw new HeadlessRunError("DUPLICATE_TRANSACTION_HASH");
  }

  let ledgerAttestation: LedgerAttestation | undefined;
  if (input.mode === "sandbox") {
    if (
      onboarding.transactionHashes.length === 0 ||
      purchases.some((purchase) =>
        purchase.scheme === "exact" && purchase.transactionHashes.length === 0
      ) ||
      safetyMoments.find((moment) => moment.name === "rogue_agent")?.transactionHashes.length === 0 ||
      safetyMoments.find((moment) => moment.name === "revoked_mandate")?.transactionHashes.length === 0
    ) {
      throw new HeadlessRunError("TESTNET_TRANSACTION_HASH_REQUIRED");
    }
    if (!dependencies.verifyLedgerEvidence) {
      throw new HeadlessRunError("TESTNET_LEDGER_VERIFIER_REQUIRED");
    }
    const rawAttestation = await dependencies.verifyLedgerEvidence({
      network: "testnet",
      transactionHashes: allTransactionHashes,
    });
    const validatedTransactionHashes = validateHashes(
      rawAttestation.validatedTransactionHashes,
      "INVALID_LEDGER_ATTESTATION_HASH",
    );
    if (
      rawAttestation.verifier !== "xrpl-ledger-verifier/v1" ||
      rawAttestation.network !== "testnet" ||
      rawAttestation.networkId !== 1 ||
      !Number.isFinite(Date.parse(rawAttestation.checkedAt)) ||
      validatedTransactionHashes.length !== allTransactionHashes.length ||
      validatedTransactionHashes.some((value, index) => value !== allTransactionHashes[index])
    ) {
      throw new HeadlessRunError("INVALID_LEDGER_ATTESTATION");
    }
    ledgerAttestation = {
      verifier: "xrpl-ledger-verifier/v1",
      network: "testnet",
      networkId: 1,
      checkedAt: new Date(rawAttestation.checkedAt).toISOString(),
      validatedTransactionHashes,
    };
  } else if (dependencies.verifyLedgerEvidence) {
    throw new HeadlessRunError("MOCK_LEDGER_ATTESTATION_FORBIDDEN");
  }

  return {
    version: "ap4m-headless-evidence/v1",
    result: "PASS",
    evidenceKind: input.mode === "mock" ? "mock-only" : "testnet",
    labels: {
      openFinance: input.mode === "mock"
        ? "Mastercard Open Finance · mock"
        : "Mastercard Open Finance · sandbox",
      network: "XRPL Testnet",
      credentialIssuer: "Demo Network — Mastercard's role in production",
      merchantValidation: "Validation flow from Mastercard's Level 3 Agentic Commerce guide · payment object: XRPL",
      ap4mRail: "ap4m-sandbox · requires Mastercard early-access credentials",
      paymentRail: "XRPL payment object; no Mastercard-network money movement",
    },
    runTag: input.runTag,
    startedAt,
    finishedAt: now().toISOString(),
    network: "testnet",
    mode: input.mode,
    onboarding,
    purchases,
    safetyMoments,
    settlement,
    ...(ledgerAttestation ? { ledgerAttestation } : {}),
    counters: {
      payments: 9,
      purchaseLedgerTransactions: purchases.reduce(
        (count, purchase) => count + purchase.transactionHashes.length,
        0,
      ),
      settlementLedgerTransactions: settlement.transactionHashes.length,
    },
    allTransactionHashes,
  };
}

function hash(label: string): string {
  return createHash("sha256").update(`MOCK-ONLY:${label}`).digest("hex").toUpperCase();
}

/** A bounded, network-free adapter for CI. It is never a Mastercard payment stand-in. */
export function createOfflineFixtureDependencies(runTag: string): HeadlessDependencies {
  let clock = Date.parse("2026-10-21T20:00:00.000Z");
  return {
    now: () => {
      const value = new Date(clock);
      clock += 1_000;
      return value;
    },
    onboard: async () => ({
      mandateId: `demo-intent-${runTag}`,
      publicAddresses: {
        owner: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
        harborPayer: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
        demoNetworkIssuer: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
        merchants: [
          "rLs1MzkFWCxTbuAHgjeTZK4fcCDDnf2KRv",
          "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn",
        ],
        stableIssuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
      },
      transactionHashes: [hash(`${runTag}:onboard`)],
    }),
    purchase: async ({ paymentNumber }) => ({
      receiptId: `mock-receipt-${runTag}-${paymentNumber}`,
      scheme: "xrpl-paychan",
      settlement: "claim_accepted",
      transactionHashes: [],
    }),
    exerciseSafetyMoment: async ({ name }) => ({
      result: "blocked",
      code: `MOCK_ONLY_${name.toUpperCase()}`,
      verification: "mock-only",
      transactionHashes: [],
    }),
    settle: async () => ({
      result: "redeemed",
      transactionHashes: [hash(`${runTag}:settle`)],
    }),
  };
}

export async function writeHeadlessEvidence(
  evidence: HeadlessEvidence,
  outputPath: string,
  cwd = process.cwd(),
): Promise<string> {
  if (isAbsolute(outputPath)) throw new HeadlessRunError("INVALID_EVIDENCE_PATH");
  const normalized = relative(cwd, resolve(cwd, outputPath));
  if (!/^status\/MC-O-evidence-[a-z0-9._-]+\.json$/u.test(normalized)) {
    throw new HeadlessRunError("INVALID_EVIDENCE_PATH");
  }
  const absolute = resolve(cwd, normalized);
  const statusRoot = dirname(absolute);
  await mkdir(statusRoot, { recursive: true, mode: 0o700 });
  const [cwdMetadata, statusMetadata, realCwd, realStatusRoot] = await Promise.all([
    lstat(cwd),
    lstat(statusRoot),
    realpath(cwd),
    realpath(statusRoot),
  ]);
  if (
    cwdMetadata.isSymbolicLink() ||
    statusMetadata.isSymbolicLink() ||
    !statusMetadata.isDirectory() ||
    realStatusRoot !== resolve(realCwd, "status")
  ) {
    throw new HeadlessRunError("UNSAFE_EVIDENCE_PARENT");
  }
  const handle = await open(
    absolute,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return normalized;
}

type CliOptions = { runTag: string; outputPath: string };

function parseCli(argv: readonly string[]): CliOptions {
  if (argv[0] !== "--offline-fixture") throw new HeadlessRunError("INJECTED_ADAPTER_REQUIRED");
  let runTag: string | undefined;
  let outputPath: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === "--run-tag") {
      runTag = argv[index + 1];
      index += 1;
    } else if (argv[index] === "--output") {
      outputPath = argv[index + 1];
      index += 1;
    } else {
      throw new HeadlessRunError("UNKNOWN_ARGUMENT");
    }
  }
  if (!runTag || !outputPath) throw new HeadlessRunError("RUN_TAG_AND_OUTPUT_REQUIRED");
  return { runTag, outputPath };
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseCli(argv);
  const input: HeadlessRunInput = { mode: "mock", network: "testnet", runTag: options.runTag };
  const evidence = await runHeadless(
    input,
    createOfflineFixtureDependencies(options.runTag),
  );
  const output = await writeHeadlessEvidence(evidence, options.outputPath);
  console.log(
    `[ap4m-headless] PASS evidence=mock-only payments=9 ledger_transactions=${evidence.allTransactionHashes.length} output=${output}`,
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    const code = error instanceof HeadlessRunError ? error.code : "HEADLESS_RUN_FAILED";
    console.error(`[ap4m-headless] ${code}`);
    process.exitCode = 1;
  });
}
