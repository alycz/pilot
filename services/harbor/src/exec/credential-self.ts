import type { RequiredCredential } from "./credential-ledger";

export const HARBOR_SELF_TRANSACTION_ALLOWLIST = Object.freeze([
  "CredentialAccept",
] as const);

export type HarborSelfTransactionType =
  (typeof HARBOR_SELF_TRANSACTION_ALLOWLIST)[number];

export interface HarborSelfCredentialAcceptTransaction {
  TransactionType: "CredentialAccept";
  Account: string;
  Issuer: string;
  CredentialType: string;
}

/**
 * Build the only owner-independent transaction MH3 permits Harbor to sign.
 * CredentialAccept moves no value, and the Account must be the Credential
 * subject: https://xrpl.org/docs/references/protocol/transactions/types/credentialaccept
 */
export function buildHarborSelfCredentialAccept(
  payerAddress: string,
  requiredCredential: RequiredCredential,
): HarborSelfCredentialAcceptTransaction {
  return Object.freeze({
    TransactionType: "CredentialAccept",
    Account: payerAddress,
    Issuer: requiredCredential.issuer,
    CredentialType: requiredCredential.credentialTypeHex,
  });
}

export function assertHarborSelfCredentialTransaction(
  transaction: unknown,
  payerAddress: string,
): asserts transaction is HarborSelfCredentialAcceptTransaction {
  if (
    typeof transaction !== "object" ||
    transaction === null ||
    Array.isArray(transaction)
  ) {
    throw new TypeError("Transaction is not allowed for the Harbor-self signer");
  }

  const candidate = transaction as Readonly<Record<string, unknown>>;
  if (
    !HARBOR_SELF_TRANSACTION_ALLOWLIST.includes(
      candidate.TransactionType as HarborSelfTransactionType,
    ) ||
    candidate.TransactionType !== "CredentialAccept" ||
    candidate.Account !== payerAddress ||
    typeof candidate.Issuer !== "string" ||
    typeof candidate.CredentialType !== "string" ||
    Object.hasOwn(candidate, "Delegate")
  ) {
    throw new TypeError("Transaction is not allowed for the Harbor-self signer");
  }
}
