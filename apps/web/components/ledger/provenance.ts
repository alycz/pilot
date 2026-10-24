export type LedgerTransportProvenance = "webhid" | "virtual";

export function ledgerSignedCopy(
  transport?: LedgerTransportProvenance,
): string {
  switch (transport) {
    case "webhid":
      return "Signed via Ledger transport";
    case "virtual":
      return "Signed via Virtual Ledger (Speculos)";
    default:
      return "Signed through configured Ledger flow";
  }
}

export function ledgerFlowName(
  transport?: LedgerTransportProvenance,
): string {
  switch (transport) {
    case "webhid":
      return "Ledger transport";
    case "virtual":
      return "Virtual Ledger (Speculos)";
    default:
      return "configured Ledger flow";
  }
}
