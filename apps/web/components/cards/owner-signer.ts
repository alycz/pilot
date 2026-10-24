import type { LedgerTransportProvenance } from "../ledger/provenance";

export type LedgerOwnerSigner = {
  accountIndex: number;
  kind: "ledger";
  transport?: LedgerTransportProvenance;
};

export function isLedgerOwnerSigner(value: unknown): value is LedgerOwnerSigner {
  if (!value || typeof value !== "object") return false;
  const signer = value as Record<string, unknown>;
  const keys = Object.keys(signer);
  return (
    (keys.length === 2 || keys.length === 3) &&
    keys.every((key) => key === "kind" || key === "accountIndex" || key === "transport") &&
    (keys.length === 2 || Object.hasOwn(signer, "transport")) &&
    signer.kind === "ledger" &&
    (signer.transport === undefined || signer.transport === "webhid" || signer.transport === "virtual") &&
    Number.isInteger(signer.accountIndex) &&
    (signer.accountIndex as number) >= 0 &&
    (signer.accountIndex as number) <= 2
  );
}
