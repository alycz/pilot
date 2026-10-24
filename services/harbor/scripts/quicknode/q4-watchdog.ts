import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  isEntrypoint,
  parseProbeArgs,
  probeMode,
  recordProbeResult,
  type ProbeIo,
} from "./q1-coverage.ts";
import {
  RogueDelegateProofSchema,
  runRogueDelegate,
  type RogueDelegateDependencies,
  type RogueDelegateProof,
} from "./rogue-delegate.ts";
export type Q4Dependencies = ProbeIo &
  RogueDelegateDependencies &
  Readonly<{
    readFile?: typeof readFile;
    runRogueDelegate?: (
      argv: string[],
      dependencies: RogueDelegateDependencies,
    ) => Promise<RogueDelegateProof>;
  }>;

export async function runQ4Watchdog(
  argv = process.argv.slice(2),
  dependencies: Q4Dependencies = {},
): Promise<void> {
  const args = parseProbeArgs(argv);
  const mode = probeMode(args.get("--mode") ?? process.env.QN_MODE);
  const statusInput = args.get("--status") ?? (process.env.HARBOR_PRIVATE_EVIDENCE_ROOT ? resolve(process.env.HARBOR_PRIVATE_EVIDENCE_ROOT, "quicknode.md") : undefined);
  const status = statusInput ? resolve(statusInput) : undefined;
  const proofPath = args.get("--proof");

  try {
    if (mode === "live" && proofPath) {
      throw new Error(
        "Live q4 runs the rogue-delegate chain directly; --proof is mock-only",
      );
    }
    if (mode === "mock" && !proofPath) {
      throw new Error(
        "q4 requires --proof from the stand-in or rogue-delegate runner",
      );
    }
    let proof: RogueDelegateProof;
    if (mode === "mock") {
      const read = dependencies.readFile ?? readFile;
      const rawProof = await read(resolve(proofPath!), "utf8");
      proof = RogueDelegateProofSchema.parse(JSON.parse(rawProof));
    } else {
      proof = await (dependencies.runRogueDelegate ?? runRogueDelegate)(
        argv,
        dependencies,
      );
    }
    const expectedSource = mode === "mock" ? "standin" : "rogue-delegate";
    if (proof.source !== expectedSource) {
      throw new Error(`Expected q4 proof source ${expectedSource}`);
    }
    if (
      proof.tx_hash !== proof.event.tx_hash ||
      proof.event.account !== proof.link.account
    ) {
      throw new Error("Watchdog proof identifiers do not agree");
    }

    if (!status) throw new Error("--status or HARBOR_PRIVATE_EVIDENCE_ROOT is required");
    await recordProbeResult(
      "q4-watchdog",
      mode,
      true,
      mode === "mock"
        ? `local stand-in out_of_band_delegate fixture frozen; next execute=link_frozen; ledger=${proof.event.ledger_index}; hash=${proof.tx_hash}; mock-only`
        : `testnet rogue delegate frozen; next step=${proof.event.next_step}; next execute=link_frozen; ledger=${proof.event.ledger_index}; hash=${proof.tx_hash}`,
      status,
      dependencies,
    );
  } catch (error) {
    if (status) await recordProbeResult(
      "q4-watchdog",
      mode,
      false,
      "watchdog freeze proof failed; no Testnet success recorded",
      status,
      dependencies,
    );
    throw error;
  }
}

if (isEntrypoint(import.meta.url)) {
  runQ4Watchdog().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "q4 watchdog probe failed"}\n`,
    );
    process.exitCode = 1;
  });
}
