import { isValidClassicAddress } from "xrpl";

import type { OpContext } from "../catalog/registry";
import { requestXrpl, XrplRpcError } from "../adapters/xrpl-rpc";

export const CREDENTIAL_ACCEPTED_FLAG = 0x0001_0000;
const RIPPLE_EPOCH_UNIX_SECONDS = 946_684_800;
const LEDGER_INDEX = /^[A-Fa-f0-9]{64}$/;
const CREDENTIAL_TYPE = /^(?:[A-Fa-f0-9]{2}){1,64}$/;

export interface RequiredCredential {
  issuer: string;
  credentialTypeHex: string;
}

export interface CredentialLedgerStatus {
  account: string;
  issuer: string;
  credentialTypeHex: string;
  credentialId: string;
  accepted: boolean;
  expired: boolean;
  expiration?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(): XrplRpcError {
  return new XrplRpcError(
    "XRPL ledger_entry returned a malformed Credential entry",
    "XRPL_MALFORMED_RESPONSE",
  );
}

export function normalizeRequiredCredential(
  value: RequiredCredential,
): RequiredCredential {
  if (
    !isRecord(value) ||
    typeof value.issuer !== "string" ||
    !isValidClassicAddress(value.issuer) ||
    typeof value.credentialTypeHex !== "string" ||
    !CREDENTIAL_TYPE.test(value.credentialTypeHex)
  ) {
    throw new TypeError("Required credential configuration is invalid");
  }
  return Object.freeze({
    issuer: value.issuer,
    credentialTypeHex: value.credentialTypeHex.toUpperCase(),
  });
}

function expirationIso(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw malformed();
  const unixMilliseconds =
    ((value as number) + RIPPLE_EPOCH_UNIX_SECONDS) * 1_000;
  const date = new Date(unixMilliseconds);
  if (!Number.isFinite(date.getTime())) throw malformed();
  return date.toISOString();
}

/**
 * Read the one AP4M credential identified by subject, issuer, and type.
 * Selector fields follow the official ledger_entry Credential selector:
 * https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/ledger-methods/ledger_entry#get-credential-entry
 */
export async function readCredentialLedgerStatus(
  ctx: OpContext,
  account: string,
  requiredCredential: RequiredCredential,
  now: Date = new Date(),
): Promise<CredentialLedgerStatus | null> {
  const required = normalizeRequiredCredential(requiredCredential);
  let result: Record<string, unknown>;
  try {
    result = await requestXrpl(ctx, "testnet", "ledger_entry", {
      ledger_index: "validated",
      credential: {
        subject: account,
        issuer: required.issuer,
        credential_type: required.credentialTypeHex,
      },
    });
  } catch (error) {
    if (error instanceof XrplRpcError && error.kind === "soft-empty") {
      return null;
    }
    throw error;
  }

  const node = result.node;
  const credentialId = result.index;
  if (
    result.validated !== true ||
    !isRecord(node) ||
    node.LedgerEntryType !== "Credential" ||
    node.Subject !== account ||
    node.Issuer !== required.issuer ||
    typeof node.CredentialType !== "string" ||
    node.CredentialType.toUpperCase() !== required.credentialTypeHex ||
    !Number.isSafeInteger(node.Flags) ||
    (node.Flags as number) < 0 ||
    typeof credentialId !== "string" ||
    !LEDGER_INDEX.test(credentialId)
  ) {
    throw malformed();
  }

  const expiration = expirationIso(node.Expiration);
  const nowMilliseconds = now.getTime();
  if (!Number.isFinite(nowMilliseconds)) throw new TypeError("Current time is invalid");

  return Object.freeze({
    account,
    issuer: required.issuer,
    credentialTypeHex: required.credentialTypeHex,
    credentialId: credentialId.toUpperCase(),
    accepted: ((node.Flags as number) & CREDENTIAL_ACCEPTED_FLAG) !== 0,
    expired:
      expiration !== undefined && Date.parse(expiration) <= nowMilliseconds,
    ...(expiration === undefined ? {} : { expiration }),
  });
}
