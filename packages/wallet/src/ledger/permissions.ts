export type LedgerPermission = Readonly<{
  permissionValue: number;
  transactionType: string;
  meaning: string;
}>;

/** XLS-75 PermissionValue is the XRPL transaction type code plus one. */
export const LEDGER_PERMISSION_LEGEND: readonly LedgerPermission[] = Object.freeze([
  {
    permissionValue: 8,
    transactionType: "OfferCreate",
    meaning: "Place DEX offers (swaps) within policy",
  },
  {
    permissionValue: 9,
    transactionType: "OfferCancel",
    meaning: "Cancel its own offers",
  },
  {
    permissionValue: 21,
    transactionType: "TrustSet",
    meaning: "Add or adjust trust lines",
  },
  {
    permissionValue: 37,
    transactionType: "AMMDeposit",
    meaning: "Add liquidity to AMM pools",
  },
  {
    permissionValue: 38,
    transactionType: "AMMWithdraw",
    meaning: "Remove liquidity",
  },
  {
    permissionValue: 3,
    transactionType: "EscrowFinish",
    meaning: "Finish escrows",
  },
  {
    permissionValue: 18,
    transactionType: "CheckCash",
    meaning: "Cash checks",
  },
]);

export function ledgerPermission(
  permissionValue: number,
): LedgerPermission | undefined {
  return LEDGER_PERMISSION_LEGEND.find(
    (entry) => entry.permissionValue === permissionValue,
  );
}
