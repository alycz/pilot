export type LedgerOwnerSigner = {
  accountIndex: number;
  kind: "ledger";
};

export function isLedgerOwnerSigner(value: unknown): value is LedgerOwnerSigner {
  if (!value || typeof value !== "object") return false;
  const signer = value as Record<string, unknown>;
  return (
    Object.keys(signer).length === 2 &&
    signer.kind === "ledger" &&
    Number.isInteger(signer.accountIndex) &&
    (signer.accountIndex as number) >= 0 &&
    (signer.accountIndex as number) <= 2
  );
}
