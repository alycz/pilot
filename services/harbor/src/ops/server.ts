import { z } from "zod";

import { requestXrpl } from "../adapters/xrpl-rpc";
import type { OpContext, OpDef } from "../catalog/registry";
import { NetworkSchema, type Network } from "../contracts";

type ServerReserves = {
  network: Network;
  reserve_base_xrp: number;
  reserve_inc_xrp: number;
  ledger_index: number;
  ledger_hash: string;
};

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`server_info response is missing ${field}`);
  }
  return value as Record<string, unknown>;
}

function requiredNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`server_info response has invalid ${field}`);
  }
  return value;
}

function requiredLedgerIndex(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("server_info response has invalid validated_ledger.seq");
  }
  return value;
}

function requiredLedgerHash(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("server_info response has invalid validated_ledger.hash");
  }
  return value;
}

async function readReserves(
  ctx: OpContext,
  network: Network,
): Promise<ServerReserves> {
  const result = await requestXrpl(ctx, network, "server_info");
  const info = requiredRecord(result.info, "info");
  const validatedLedger = requiredRecord(
    info.validated_ledger,
    "info.validated_ledger",
  );

  // XRPL documents these as the current base and per-owned-object reserves,
  // denominated in XRP, on the server_info validated_ledger object:
  // https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/server-info-methods/server_info
  return {
    network,
    reserve_base_xrp: requiredNonNegativeNumber(
      validatedLedger.reserve_base_xrp,
      "validated_ledger.reserve_base_xrp",
    ),
    reserve_inc_xrp: requiredNonNegativeNumber(
      validatedLedger.reserve_inc_xrp,
      "validated_ledger.reserve_inc_xrp",
    ),
    ledger_index: requiredLedgerIndex(validatedLedger.seq),
    ledger_hash: requiredLedgerHash(validatedLedger.hash),
  };
}

export const ops: OpDef[] = [
  {
    name: "server.reserves",
    family: "server",
    summary: "Read the current XRP Ledger account reserve requirements.",
    tags: ["server", "reserves", "account", "xrp"],
    args: z.object({ network: NetworkSchema }).strict(),
    returns: "validated-ledger base and owner reserves in XRP",
    caveats: [],
    example: 'await harbor.server.reserves({ network: "testnet" })',
    handler: async (ctx, args) =>
      readReserves(ctx, (args as { network: Network }).network),
  },
];
