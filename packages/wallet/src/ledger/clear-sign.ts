export type LedgerSigningMode = "clear" | "blind";

const CLEAR_TRANSACTION_TYPES = new Set([
  "Payment",
  "EscrowCreate",
  "EscrowFinish",
  "EscrowCancel",
  "AccountSet",
  "SetRegularKey",
  "OfferCreate",
  "OfferCancel",
  "TicketCreate",
  "SignerListSet",
  "PaymentChannelCreate",
  "PaymentChannelFund",
  "PaymentChannelClaim",
  "CheckCreate",
  "CheckCash",
  "CheckCancel",
  "DepositPreauth",
  "TrustSet",
  "AccountDelete",
  "NFTokenMint",
  "NFTokenBurn",
  "NFTokenCreateOffer",
  "NFTokenCancelOffer",
  "NFTokenAcceptOffer",
  "Clawback",
  "AMMCreate",
  "AMMDeposit",
  "AMMWithdraw",
  "AMMVote",
  "AMMBid",
  "AMMDelete",
]);

const UNIVERSAL_FLAG = 0x8000_0000;
const UINT32_MAX = 0xffff_ffff;

function flags(...values: number[]): number {
  return values.reduce((mask, value) => (mask | value) >>> 0, UNIVERSAL_FLAG);
}

const KNOWN_FLAGS: Readonly<Record<string, number>> = Object.freeze({
  Payment: flags(0x0001_0000, 0x0002_0000, 0x0004_0000),
  EscrowCreate: flags(),
  EscrowFinish: flags(),
  EscrowCancel: flags(),
  AccountSet: flags(
    0x0001_0000,
    0x0002_0000,
    0x0004_0000,
    0x0008_0000,
    0x0010_0000,
    0x0020_0000,
  ),
  SetRegularKey: flags(),
  OfferCreate: flags(0x0001_0000, 0x0002_0000, 0x0004_0000, 0x0008_0000),
  OfferCancel: flags(),
  TicketCreate: flags(),
  SignerListSet: flags(),
  PaymentChannelCreate: flags(),
  PaymentChannelFund: flags(),
  PaymentChannelClaim: flags(0x0001_0000, 0x0002_0000),
  CheckCreate: flags(),
  CheckCash: flags(),
  CheckCancel: flags(),
  DepositPreauth: flags(),
  TrustSet: flags(
    0x0001_0000,
    0x0002_0000,
    0x0004_0000,
    0x0010_0000,
    0x0020_0000,
    0x0040_0000,
    0x0080_0000,
  ),
  AccountDelete: flags(),
  NFTokenMint: flags(
    0x0000_0001,
    0x0000_0002,
    0x0000_0004,
    0x0000_0008,
    0x0000_0010,
  ),
  NFTokenBurn: flags(),
  NFTokenCreateOffer: flags(0x0000_0001),
  NFTokenCancelOffer: flags(),
  NFTokenAcceptOffer: flags(),
  Clawback: flags(),
  AMMCreate: flags(),
  AMMDeposit: flags(
    0x0001_0000,
    0x0008_0000,
    0x0010_0000,
    0x0020_0000,
    0x0040_0000,
    0x0080_0000,
  ),
  AMMWithdraw: flags(
    0x0001_0000,
    0x0002_0000,
    0x0004_0000,
    0x0008_0000,
    0x0010_0000,
    0x0020_0000,
    0x0040_0000,
  ),
  AMMVote: flags(),
  AMMBid: flags(),
  AMMDelete: flags(),
});

/** Mirror the XRP app 2.8.2 clear-sign table; unknown shapes fail closed. */
export function ledgerSigningMode(
  transaction: Record<string, unknown>,
): LedgerSigningMode {
  const type = transaction.TransactionType;
  if (typeof type !== "string" || !CLEAR_TRANSACTION_TYPES.has(type)) {
    return "blind";
  }

  const flags = transaction.Flags;
  if (flags === undefined) return "clear";
  if (
    !Number.isSafeInteger(flags) ||
    (flags as number) < 0 ||
    (flags as number) > UINT32_MAX
  ) return "blind";
  const known = (KNOWN_FLAGS[type] ?? UNIVERSAL_FLAG) >>> 0;
  const value = (flags as number) >>> 0;
  return (value & ~known) === 0 ? "clear" : "blind";
}
