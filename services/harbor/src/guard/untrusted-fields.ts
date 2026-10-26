import type { BlockedFieldKind } from "../contracts";

export type JsonPath = readonly (string | number)[];

export type UntrustedField = Readonly<{
  kind: BlockedFieldKind;
  path: JsonPath;
  value: string;
}>;

type PathSegment = string | "*" | "**";
type FieldEncoding = "plain" | "hex-utf8";

type UntrustedFieldRule = Readonly<{
  kind: BlockedFieldKind;
  path: readonly PathSegment[];
  encoding?: FieldEncoding;
}>;

export type ScreeningClassification = "structured" | "trusted" | "untrusted";

const hexText = (
  kind: BlockedFieldKind,
  path: readonly PathSegment[],
): UntrustedFieldRule => ({
  kind,
  path,
  encoding: "hex-utf8",
});

/**
 * Attacker-controlled text paths for operation results. `*` matches one array
 * element or object property and `**` recursively matches descendants. Paths
 * describe the public operation result, after provider-specific validation.
 *
 * Forward entries for the Mastercard/AP4M operations intentionally land before
 * their implementations so those results cannot be integrated without the AWS
 * trust boundary already knowing about them.
 */
export const UNTRUSTED_FIELD_RULES: Readonly<
  Record<string, readonly UntrustedFieldRule[]>
> = Object.freeze({
  "amendments.status": [
    { kind: "amendment-name", path: ["amendments", "*", "name"] },
  ],
  "ap4m.purchase": [
    { kind: "purchase-data", path: ["data", "**"] },
  ],
  "docs.search": [
    { kind: "document-title", path: ["*", "title"] },
    { kind: "document-snippet", path: ["*", "snippet"] },
    { kind: "document-source", path: ["*", "source"] },
    { kind: "document-url", path: ["*", "url"] },
  ],
  "ledger.account.info": [
    hexText("domain", ["account_data", "Domain"]),
  ],
  "ledger.account.objects": [
    // XRPL blob fields are hexadecimal UTF-8. Keep identifiers such as
    // Account, issuer, currency, BaseAsset/QuoteAsset, hashes and object IDs
    // out of this list: they are protocol data rather than model-facing text.
    hexText("asset-class", ["account_objects", "*", "**", "AssetClass"]),
    hexText("credential-type", ["account_objects", "*", "**", "CredentialType"]),
    hexText("ledger-data", ["account_objects", "*", "**", "Data"]),
    hexText("did-document", ["account_objects", "*", "**", "DIDDocument"]),
    hexText("domain", ["account_objects", "*", "**", "Domain"]),
    hexText("memo-data", ["account_objects", "*", "**", "MemoData"]),
    hexText("memo-type", ["account_objects", "*", "**", "MemoType"]),
    hexText("mptoken-metadata", ["account_objects", "*", "**", "MPTokenMetadata"]),
    hexText("provider", ["account_objects", "*", "**", "Provider"]),
    hexText("uri", ["account_objects", "*", "**", "URI"]),
  ],
  "ledger.account.tx": [
    hexText("memo-data", ["transactions", "*", "**", "MemoData"]),
    hexText("memo-type", ["transactions", "*", "**", "MemoType"]),
  ],
  "lending.brokers": [
    hexText("ledger-data", ["brokers", "*", "Data"]),
  ],
  "mastercard.docs": [{ kind: "mastercard-content", path: ["**"] }],
  "mastercard.page": [{ kind: "mastercard-content", path: ["**"] }],
  "mastercard.search": [{ kind: "mastercard-content", path: ["**"] }],
  "mastercard.services": [{ kind: "mastercard-content", path: ["**"] }],
  "near.intents.quote": [
    { kind: "provider", path: ["quote", "correlationId"] },
  ],
  "near.intents.status": [
    { kind: "provider", path: ["status", "correlationId"] },
    { kind: "provider", path: ["status", "quoteResponse", "correlationId"] },
    { kind: "provider", path: ["status", "swapDetails", "refundReason"] },
    { kind: "uri", path: ["status", "swapDetails", "originChainTxHashes", "*", "explorerUrl"] },
    { kind: "uri", path: ["status", "swapDetails", "destinationChainTxHashes", "*", "explorerUrl"] },
  ],
  "near.intents.tokens": [
    { kind: "token-name", path: ["tokens", "*", "symbol"] },
    { kind: "provider", path: ["tokens", "*", "coingeckoId"] },
  ],
  "perps.markets": [
    { kind: "market-coin", path: ["markets", "*", "coin"] },
    { kind: "margin-mode", path: ["markets", "*", "marginMode"] },
  ],
  "quicknode.webhookEvidence": [
    { kind: "provider", path: ["tx_type"] },
    { kind: "provider", path: ["result"] },
  ],
  "tokens.lookup": [
    { kind: "token-name", path: ["metadata", "code"] },
    { kind: "token-name", path: ["metadata", "name"] },
    { kind: "token-description", path: ["metadata", "description"] },
    { kind: "token-domain", path: ["metadata", "Domain"] },
    { kind: "token-domain", path: ["metadata", "domain"] },
    { kind: "token-icon", path: ["metadata", "icon"] },
  ],
  "tokens.trending": [
    { kind: "token-name", path: ["data", "*", "code"] },
    { kind: "token-name", path: ["data", "*", "name"] },
    { kind: "token-description", path: ["data", "*", "description"] },
    { kind: "token-domain", path: ["data", "*", "Domain"] },
    { kind: "token-domain", path: ["data", "*", "domain"] },
    { kind: "token-icon", path: ["data", "*", "icon"] },
  ],
  "vault.info": [
    hexText("ledger-data", ["vault", "Data"]),
    hexText("mptoken-metadata", ["vault", "shares", "MPTokenMetadata"]),
  ],
  // The public compare body has a strict fixed-key schema. Screen every
  // remaining merchant-controlled string while keeping arbitrary internal
  // merchant JSON outside the public operation envelope.
  "x402.pay": [
    { kind: "merchant-response", path: ["invoice_id"] },
    {
      kind: "merchant-response",
      path: ["merchant", "body", "comparison", "*"],
    },
  ],
  "x402.payIssuedFixture": [
    { kind: "merchant-response", path: ["merchant_invoice_id"] },
    { kind: "merchant-response", path: ["merchant_body", "**"] },
  ],
});

/**
 * Every operation is explicitly classified. This is kept separate from the
 * path map so a new operation cannot silently skip a trust-boundary review.
 */
export const OP_SCREENING_CLASSIFICATION: Readonly<
  Record<string, ScreeningClassification>
> = Object.freeze({
  "account.link": "structured",
  "account.revoke": "structured",
  "account.status": "structured",
  "analytics.marketSnapshot": "structured",
  "amendments.status": "untrusted",
  "amm.info": "structured",
  "amm.pools": "structured",
  "amm.position": "structured",
  "ap4m.purchase": "untrusted",
  // The event-EVM surface returns only strict local identifiers, typed-data,
  // transaction fields, and verified on-chain evidence. It never returns
  // merchant prose or an arbitrary service body.
  "ap4m.evmPrepareApproval": "structured",
  "ap4m.evmBindVoucher": "structured",
  "ap4m.evmRecordSubmission": "structured",
  "ap4m.evmReconcile": "structured",
  "ap4m.evmStatus": "structured",
  "channel.list": "structured",
  "channel.status": "structured",
  // Local capability results contain only strict first-party identifiers,
  // counters, timestamps, fixed fixture data, and exact owner-review fields.
  // Secret handles and resolved values never enter an operation result.
  "capability.activate": "structured",
  "capability.invoke": "structured",
  "capability.prepare": "structured",
  "capability.prepareRevoke": "structured",
  "capability.revoke": "structured",
  "capability.status": "structured",
  "credential.ids": "structured",
  "credential.payerAccept": "structured",
  "credential.status": "structured",
  "dex.book": "structured",
  "dex.depth": "structured",
  "dex.quote": "structured",
  "docs.search": "untrusted",
  "ledger.account.info": "untrusted",
  "ledger.account.lines": "structured",
  "ledger.account.objects": "untrusted",
  "ledger.account.tx": "untrusted",
  "ledger.fee": "structured",
  "lending.brokers": "untrusted",
  // mandate.prepare returns locally generated public keys and unsigned XRPL
  // transactions built from validated user constraints plus the trusted
  // merchant registry. The remaining operations return strict MandateSchema
  // records: ledger-derived values are hashes, addresses and amounts, not free
  // text. User-authored payee/SKU constraints are already part of the user's
  // request and do not cross a third-party or ledger-text trust boundary.
  "mandate.prepare": "structured",
  "mandate.register": "structured",
  "mandate.revoke": "structured",
  "mandate.status": "structured",
  "mastercard.docs": "untrusted",
  "mastercard.page": "untrusted",
  "mastercard.search": "untrusted",
  "mastercard.services": "untrusted",
  "merchants.get": "trusted",
  "merchants.list": "trusted",
  // These are live provider reads. Strict schemas retain protocol identifiers
  // and numbers, while the small set of provider-authored display fields is
  // explicitly screened above before model use.
  "near.intents.quote": "untrusted",
  "near.intents.status": "untrusted",
  "near.intents.tokens": "untrusted",
  "onboarding.readiness": "structured",
  "perps.markets": "untrusted",
  "policy.get": "trusted",
  "policy.set": "trusted",
  // QN-2 returns only strict enums, bounded counters, booleans, timestamps,
  // run tags, networks and fixed list names. No provider or catalog text is
  // present in either public result.
  "quicknode.events": "structured",
  "quicknode.kv.reconcile": "structured",
  "quicknode.status": "structured",
  "quicknode.test.deleteLink": "structured",
  "quicknode.test.registerLink": "structured",
  "quicknode.unfreeze": "structured",
  "quicknode.webhookEvidence": "untrusted",
  "server.reserves": "structured",
  "skill.read": "trusted",
  // Strategy output is generated from strict first-party contracts and the
  // requesting owner's own immutable mandate. The runner persists only
  // bounded reason codes, identifiers, amounts and timestamps; raw provider
  // responses never enter the public audit result.
  "strategy.audit": "structured",
  "strategy.authorize": "structured",
  "strategy.create": "structured",
  "strategy.get": "structured",
  "strategy.globalKill.get": "structured",
  "strategy.globalKill.set": "structured",
  "strategy.kill": "structured",
  "strategy.list": "structured",
  "strategy.pause": "structured",
  "strategy.resume": "structured",
  // Validation and paper simulation return only closed-schema diagnostics,
  // fixed explanations, canonical numbers, and normalized identifiers whose
  // character sets and lengths are bounded by the declarative compiler.
  "strategy.simulate": "structured",
  "strategy.stop": "structured",
  "strategy.validate": "structured",
  "tokens.flagged": "structured",
  "tokens.lookup": "untrusted",
  "tokens.trending": "untrusted",
  "tx.ammDeposit": "trusted",
  "tx.ammWithdraw": "trusted",
  "tx.approvalPreflight": "structured",
  "tx.approvalReconcile": "structured",
  "tx.checkCancel": "trusted",
  "tx.checkCash": "trusted",
  "tx.checkCreate": "trusted",
  "tx.escrowCancel": "trusted",
  "tx.escrowCreate": "trusted",
  "tx.escrowFinish": "trusted",
  "tx.execute": "trusted",
  "tx.offer": "trusted",
  "tx.offerCancel": "trusted",
  "tx.payment": "trusted",
  "tx.simulate": "trusted",
  "tx.status": "trusted",
  "tx.submit": "structured",
  "tx.swap": "trusted",
  "tx.trustSet": "trusted",
  "tx.vaultDeposit": "trusted",
  "tx.vaultWithdraw": "trusted",
  "vault.info": "untrusted",
  "vault.positions": "structured",
  "venues.compare": "structured",
  "venues.get": "trusted",
  "venues.list": "trusted",
  "x402.pay": "untrusted",
  "x402.payIssuedFixture": "untrusted",
  "yield.options": "trusted",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function childEntries(value: unknown): Array<[string | number, unknown]> {
  if (Array.isArray(value)) return [...value.entries()];
  if (isRecord(value)) return Object.entries(value);
  return [];
}

function decodeHexUtf8(value: string): string {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[A-Fa-f0-9]+$/.test(value)) {
    return value;
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let offset = 0; offset < value.length; offset += 2) {
    bytes[offset / 2] = Number.parseInt(value.slice(offset, offset + 2), 16);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes,
    );
  } catch {
    return value;
  }
}

function decodedValue(value: string, encoding: FieldEncoding): string {
  return encoding === "hex-utf8" ? decodeHexUtf8(value) : value;
}

function collectRuleMatches(
  value: unknown,
  rule: UntrustedFieldRule,
): UntrustedField[] {
  const matches: UntrustedField[] = [];
  const encoding = rule.encoding ?? "plain";

  const visit = (
    current: unknown,
    patternIndex: number,
    concretePath: Array<string | number>,
  ): void => {
    if (patternIndex === rule.path.length) {
      if (typeof current === "string" && current.length > 0) {
        matches.push({
          kind: rule.kind,
          path: [...concretePath],
          value: decodedValue(current, encoding),
        });
      }
      return;
    }

    const segment = rule.path[patternIndex];
    if (segment === "**") {
      // `**` may consume no segment, which lets a terminal recursive rule
      // collect a string at the current location as well as descendants.
      visit(current, patternIndex + 1, concretePath);
      for (const [key, child] of childEntries(current)) {
        visit(child, patternIndex, [...concretePath, key]);
      }
      return;
    }

    if (segment === "*") {
      for (const [key, child] of childEntries(current)) {
        visit(child, patternIndex + 1, [...concretePath, key]);
      }
      return;
    }

    if (Array.isArray(current)) {
      const index = Number(segment);
      if (Number.isInteger(index) && index >= 0 && index < current.length) {
        visit(current[index], patternIndex + 1, [...concretePath, index]);
      }
      return;
    }
    if (isRecord(current) && Object.hasOwn(current, segment)) {
      visit(current[segment], patternIndex + 1, [...concretePath, segment]);
    }
  };

  visit(value, 0, []);
  return matches;
}

function pathKey(path: JsonPath): string {
  return JSON.stringify(path);
}

export function collectUntrustedFields(
  opName: string,
  data: unknown,
): UntrustedField[] {
  const rules = UNTRUSTED_FIELD_RULES[opName] ?? [];
  const fields = new Map<string, UntrustedField>();
  for (const rule of rules) {
    for (const field of collectRuleMatches(data, rule)) {
      fields.set(pathKey(field.path), field);
    }
  }
  return [...fields.values()];
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneJsonValue(child)]),
    );
  }
  return value;
}

function setAtPath(root: unknown, path: JsonPath, replacement: string): void {
  let current = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    if (Array.isArray(current) && typeof segment === "number") {
      current = current[segment];
    } else if (isRecord(current) && typeof segment === "string") {
      current = current[segment];
    } else {
      return;
    }
  }
  const leaf = path.at(-1);
  if (Array.isArray(current) && typeof leaf === "number") {
    current[leaf] = replacement;
  } else if (isRecord(current) && typeof leaf === "string") {
    current[leaf] = replacement;
  }
}

export function redactUntrustedFields(
  data: unknown,
  fields: readonly UntrustedField[],
  replacementFor: (field: UntrustedField) => string,
): unknown {
  const copy = cloneJsonValue(data);
  for (const field of fields) {
    setAtPath(copy, field.path, replacementFor(field));
  }
  return copy;
}
