const XRPL_TRANSACTION_HASH = /^[0-9A-F]{64}$/;

export function xrplTestnetTransactionUrl(hash: string | undefined): string | undefined {
  const canonical = hash?.toUpperCase();
  if (!canonical || !XRPL_TRANSACTION_HASH.test(canonical)) return undefined;
  return `https://testnet.xrpl.org/transactions/${encodeURIComponent(canonical)}`;
}
