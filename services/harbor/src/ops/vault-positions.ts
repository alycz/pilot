import { decodeAccountID, isValidClassicAddress } from "xrpl";
import { z } from "zod";

import { requestXrpl } from "../adapters/xrpl-rpc";
import type { OpContext, OpDef } from "../catalog/registry";

const DevVaultNetworkSchema = z.enum(["devnet", "lending-devnet"]);
const ClassicAddressSchema = z
  .string()
  .refine(isValidClassicAddress, "must be a valid XRPL classic address");
const Hash256Schema = z.string().regex(/^[A-Fa-f0-9]{64}$/);
const MptIssuanceIdSchema = z.string().regex(/^[A-Fa-f0-9]{48}$/);
const UINT64_MAX = "18446744073709551615";
const UnsignedIntegerStringSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,19})$/)
  .refine(
    (value) => value.length < UINT64_MAX.length || value <= UINT64_MAX,
    "must fit XRPL's unsigned 64-bit amount range",
  );
function isCanonicalXrplDecimal(value: string): boolean {
  // XRPL issued-style numeric fields have at most 16 significant digits and
  // a normalized decimal magnitude from -96 through +80. Public results use
  // the unique plain-decimal form: no sign, exponent, leading integer zero,
  // or insignificant fractional zeroes.
  if (value === "0") return true;
  if (value.length > 98) return false;
  if (!/^(?:0\.\d*[1-9]|[1-9]\d*(?:\.\d*[1-9])?)$/.test(value)) {
    return false;
  }
  const [integer = "", fraction = ""] = value.split(".");
  const digits = `${integer}${fraction}`;
  const firstNonZero = digits.search(/[1-9]/);
  const lastNonZero = Math.max(
    ...Array.from(digits, (digit, index) => (digit === "0" ? -1 : index)),
  );
  const significantDigits = lastNonZero - firstNonZero + 1;
  const magnitude = integer.length - firstNonZero - 1;
  return significantDigits <= 16 && magnitude >= -96 && magnitude <= 80;
}
const DecimalStringSchema = z
  .string()
  .max(98)
  .refine(isCanonicalXrplDecimal, "must be a canonical bounded XRPL decimal");
const CurrencyCodeSchema = z
  .string()
  .refine(
    (currency) =>
      currency === "XRP" ||
      /^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3}$/.test(currency) ||
      /^[A-Fa-f0-9]{40}$/.test(currency),
    "must be XRP, a 3-character currency code, or 40 hexadecimal characters",
  );
const RawMarkerSchema = z.union([
  z.string().min(1).max(512),
  z
    .record(
      z.string().min(1).max(64),
      z.union([
        z.string().min(1).max(512),
        z.number().int().nonnegative().safe(),
      ]),
    )
    .refine(
      (marker) =>
        Object.keys(marker).length >= 1 && Object.keys(marker).length <= 8,
    ),
]);
type RawMarker = z.infer<typeof RawMarkerSchema>;

const ContinuationPayloadSchema = z
  .object({
    account: ClassicAddressSchema,
    ledger_hash: Hash256Schema,
    ledger_index: z.number().int().nonnegative(),
    marker: RawMarkerSchema,
    network: DevVaultNetworkSchema,
  })
  .strict();
type ContinuationPayload = z.infer<typeof ContinuationPayloadSchema>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("value is not JSON serializable");
    return serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

const ContinuationHandleSchema = z
  .string()
  .regex(/^v1\.[a-f0-9]{64}$/u, "must be an opaque vault.positions handle");

const VaultAssetSchema = z.union([
  z.object({ currency: z.literal("XRP") }).strict(),
  z
    .object({
      currency: CurrencyCodeSchema.refine((currency) => currency !== "XRP"),
      issuer: ClassicAddressSchema,
    })
    .strict(),
  z.object({ mpt_issuance_id: MptIssuanceIdSchema }).strict(),
]);

// account_objects can return ledger types other than the requested type on
// older amendment-enabled development builds. Parse the envelope strictly
// where it supplies the validated ledger pin, then validate matching objects
// individually before using them.
const AccountObjectsResultSchema = z
  .object({
    account: ClassicAddressSchema,
    account_objects: z.array(z.record(z.string(), z.unknown())).max(400),
    ledger_hash: Hash256Schema,
    ledger_index: z.number().int().nonnegative(),
    marker: RawMarkerSchema.optional(),
    status: z.literal("success").optional(),
    validated: z.literal(true),
  })
  .passthrough();

// MPToken holder objects and their balance field are documented here:
// https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptoken
const MPTokenSchema = z
  .object({
    Account: ClassicAddressSchema,
    LedgerEntryType: z.literal("MPToken"),
    LockedAmount: UnsignedIntegerStringSchema.optional(),
    MPTAmount: UnsignedIntegerStringSchema,
    MPTokenIssuanceID: MptIssuanceIdSchema,
  });

const MPTokenIssuanceSchema = z
  .object({
    AssetScale: z.number().int().min(0).max(18).optional(),
    Issuer: ClassicAddressSchema,
    LedgerEntryType: z.literal("MPTokenIssuance"),
    Sequence: z.number().int().min(0).max(0xffff_ffff),
  });

const LedgerEntryResultSchema = z
  .object({
    ledger_hash: Hash256Schema,
    ledger_index: z.number().int().nonnegative(),
    node: MPTokenIssuanceSchema,
    status: z.literal("success").optional(),
    validated: z.literal(true),
  })
  .passthrough();

const VaultLedgerObjectSchema = z
  .object({
    Account: ClassicAddressSchema,
    Asset: VaultAssetSchema,
    AssetsAvailable: DecimalStringSchema.optional(),
    AssetsTotal: DecimalStringSchema.optional(),
    Flags: z.number().int().nonnegative(),
    LedgerEntryType: z.literal("Vault"),
    Owner: ClassicAddressSchema,
    Sequence: z.number().int().nonnegative(),
    ShareMPTID: MptIssuanceIdSchema,
    VaultKind: z.number().int().min(0).max(1).optional(),
    WithdrawalPolicy: z.number().int().nonnegative(),
    index: Hash256Schema,
  });
type VaultLedgerObject = z.infer<typeof VaultLedgerObjectSchema>;

const VaultPositionSchema = z
  .object({
    asset: VaultAssetSchema,
    assets_available: DecimalStringSchema.optional(),
    assets_total: DecimalStringSchema.optional(),
    flags: z.number().int().nonnegative(),
    locked_balance: UnsignedIntegerStringSchema.optional(),
    mpt_issuance_id: MptIssuanceIdSchema,
    share_balance: UnsignedIntegerStringSchema,
    share_asset_scale: z.number().int().min(0).max(18),
    share_issuer: ClassicAddressSchema,
    vault_account: ClassicAddressSchema,
    vault_id: Hash256Schema,
    vault_kind: z.number().int().min(0).max(1).optional(),
    vault_owner: ClassicAddressSchema,
    vault_sequence: z.number().int().nonnegative(),
    withdrawal_policy: z.number().int().nonnegative(),
  })
  .strict();

export const VaultPositionsResponseSchema = z
  .object({
    account: ClassicAddressSchema,
    ledger_hash: Hash256Schema,
    ledger_index: z.number().int().nonnegative(),
    marker: ContinuationHandleSchema.optional(),
    network: DevVaultNetworkSchema,
    positions: z.array(VaultPositionSchema).max(100),
    validated: z.literal(true),
  })
  .strict();
export type VaultPositionsResponse = z.infer<
  typeof VaultPositionsResponseSchema
>;

type DevVaultNetwork = z.infer<typeof DevVaultNetworkSchema>;
type LedgerPin = { ledger_hash: string; ledger_index: number };
type RequestBudget = { remaining: number };
type ResolvedVault = {
  assetScale: number;
  issuer: string;
  vault: VaultLedgerObject;
};
type CachedContinuation = {
  expiresAt: number;
  payload: ContinuationPayload;
};

const MAX_ISSUER_PAGES = 4;
const ISSUER_PAGE_LIMIT = 100;
const MAX_RPC_REQUESTS_PER_INVOCATION = 32;
const MAX_CACHE_ENTRIES = 256;
const CONTINUATION_TTL_MS = 10 * 60 * 1_000;
const resolvedVaultCache = new Map<string, ResolvedVault | null>();
const continuationCache = new Map<string, CachedContinuation>();

function boundedCacheSet(
  cache: Map<string, ResolvedVault | null>,
  key: string,
  value: ResolvedVault | null,
): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Clear module caches so fixture tests never depend on execution order. */
export function clearVaultPositionsCacheForTests(): void {
  resolvedVaultCache.clear();
  continuationCache.clear();
}

function bytesToLowerHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function purgeExpiredContinuations(now: number): void {
  for (const [handle, entry] of continuationCache) {
    if (entry.expiresAt <= now) continuationCache.delete(handle);
  }
}

async function storeContinuation(
  payload: ContinuationPayload,
): Promise<string> {
  const validated = ContinuationPayloadSchema.parse(payload);
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const material = new TextEncoder().encode(
    `${canonicalJson(validated)}:${bytesToLowerHex(nonce)}`,
  );
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", material),
  );
  const handle = `v1.${bytesToLowerHex(digest)}`;
  const now = Date.now();
  purgeExpiredContinuations(now);
  continuationCache.set(handle, {
    expiresAt: now + CONTINUATION_TTL_MS,
    payload: validated,
  });
  while (continuationCache.size > MAX_CACHE_ENTRIES) {
    const oldest = continuationCache.keys().next().value;
    if (oldest === undefined) break;
    continuationCache.delete(oldest);
  }
  return handle;
}

function resolveContinuation(handle: string): ContinuationPayload {
  ContinuationHandleSchema.parse(handle);
  const now = Date.now();
  purgeExpiredContinuations(now);
  const entry = continuationCache.get(handle);
  if (entry === undefined) {
    throw new Error("unknown or expired vault.positions continuation handle");
  }
  return entry.payload;
}

function assertPinnedLedger(
  actual: LedgerPin,
  expected: LedgerPin,
  command: string,
): void {
  if (
    actual.ledger_index !== expected.ledger_index ||
    actual.ledger_hash.toUpperCase() !== expected.ledger_hash.toUpperCase()
  ) {
    throw new Error(`XRPL ${command} returned a different ledger`);
  }
}

async function budgetedRequest(
  ctx: OpContext,
  network: DevVaultNetwork,
  command: string,
  params: Readonly<Record<string, unknown>>,
  budget: RequestBudget,
): Promise<Record<string, unknown>> {
  if (budget.remaining <= 0) {
    throw new Error("vault.positions exceeded its safe XRPL request budget");
  }
  budget.remaining -= 1;
  return requestXrpl(ctx, network, command, params);
}

function accountIdHex(account: string): string {
  return Array.from(decodeAccountID(account), (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .toUpperCase();
}

function assertIssuanceAssociation(
  issuanceId: string,
  issuance: z.infer<typeof MPTokenIssuanceSchema>,
): void {
  // An issuance ID is the big-endian 32-bit creation sequence followed by the
  // issuer's 20-byte AccountID:
  // https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/mptokenissuance#mptokenissuance-id-format
  const expected = `${issuance.Sequence.toString(16).padStart(8, "0")}${accountIdHex(issuance.Issuer)}`.toUpperCase();
  if (issuanceId.toUpperCase() !== expected) {
    throw new Error("XRPL MPTokenIssuance does not match its issuance ID");
  }
}

async function resolveVault(
  ctx: OpContext,
  network: DevVaultNetwork,
  pin: LedgerPin,
  issuanceId: string,
  budget: RequestBudget,
): Promise<ResolvedVault | null> {
  const key = `${network}:${pin.ledger_hash.toUpperCase()}:${issuanceId.toUpperCase()}`;
  if (resolvedVaultCache.has(key)) {
    return resolvedVaultCache.get(key) ?? null;
  }

  // ledger_entry accepts the MPToken issuance ID as the mpt_issuance selector:
  // https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/ledger-methods/ledger_entry#mptokenissuance-object
  const raw = await budgetedRequest(
    ctx,
    network,
    "ledger_entry",
    { ledger_hash: pin.ledger_hash, mpt_issuance: issuanceId },
    budget,
  );
  const result = LedgerEntryResultSchema.parse(raw);
  assertPinnedLedger(result, pin, "ledger_entry");
  assertIssuanceAssociation(issuanceId, result.node);

  const seenMarkers = new Set<string>();
  let marker: RawMarker | undefined;

  // account_objects supports a ledger pin, type filter, limit, and marker:
  // https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/account-methods/account_objects
  for (let page = 0; page < MAX_ISSUER_PAGES; page += 1) {
    const vaultRaw = await budgetedRequest(
      ctx,
      network,
      "account_objects",
      {
        account: result.node.Issuer,
        ledger_hash: pin.ledger_hash,
        limit: ISSUER_PAGE_LIMIT,
        type: "vault",
        ...(marker === undefined ? {} : { marker }),
      },
      budget,
    );
    const vaultPage = AccountObjectsResultSchema.parse(vaultRaw);
    assertPinnedLedger(vaultPage, pin, "account_objects");
    if (vaultPage.account !== result.node.Issuer) {
      throw new Error("XRPL account_objects returned a different account");
    }
    if (vaultPage.account_objects.length > ISSUER_PAGE_LIMIT) {
      throw new Error("XRPL account_objects exceeded the requested limit");
    }

    for (const object of vaultPage.account_objects) {
      if (object.LedgerEntryType !== "Vault") continue;
      if (
        typeof object.ShareMPTID !== "string" ||
        object.ShareMPTID.toUpperCase() !== issuanceId.toUpperCase()
      ) {
        continue;
      }
      const vault = VaultLedgerObjectSchema.parse(object);
      if (vault.Account !== result.node.Issuer) {
        throw new Error("XRPL Vault belongs to a different pseudo-account");
      }
      const resolved = {
        assetScale: result.node.AssetScale ?? 0,
        issuer: result.node.Issuer,
        vault,
      };
      boundedCacheSet(resolvedVaultCache, key, resolved);
      return resolved;
    }

    marker = vaultPage.marker;
    if (marker === undefined) {
      boundedCacheSet(resolvedVaultCache, key, null);
      return null;
    }
    const markerKey = canonicalJson(marker);
    if (seenMarkers.has(markerKey)) {
      throw new Error("XRPL account_objects repeated a pagination marker");
    }
    seenMarkers.add(markerKey);
  }

  throw new Error("XRPL Vault pagination exceeded its safe four-page limit");
}

function toPosition(
  token: z.infer<typeof MPTokenSchema>,
  assetScale: number,
  issuer: string,
  vault: VaultLedgerObject,
): z.infer<typeof VaultPositionSchema> {
  return VaultPositionSchema.parse({
    asset: vault.Asset,
    ...(vault.AssetsAvailable === undefined
      ? {}
      : { assets_available: vault.AssetsAvailable }),
    ...(vault.AssetsTotal === undefined
      ? {}
      : { assets_total: vault.AssetsTotal }),
    flags: vault.Flags,
    ...(token.LockedAmount === undefined
      ? {}
      : { locked_balance: token.LockedAmount }),
    mpt_issuance_id: token.MPTokenIssuanceID,
    share_balance: token.MPTAmount,
    share_asset_scale: assetScale,
    share_issuer: issuer,
    vault_account: vault.Account,
    vault_id: vault.index,
    ...(vault.VaultKind === undefined ? {} : { vault_kind: vault.VaultKind }),
    vault_owner: vault.Owner,
    vault_sequence: vault.Sequence,
    withdrawal_policy: vault.WithdrawalPolicy,
  });
}

async function readVaultPositions(
  ctx: OpContext,
  args: {
    network: DevVaultNetwork;
    account: string;
    ledger_index?: number;
    limit?: number;
    marker?: string;
  },
): Promise<VaultPositionsResponse> {
  const limit = args.limit ?? 100;
  const continuation =
    args.marker === undefined ? undefined : resolveContinuation(args.marker);
  if (
    continuation !== undefined &&
    (continuation.network !== args.network ||
      continuation.account !== args.account ||
      (args.ledger_index !== undefined &&
        continuation.ledger_index !== args.ledger_index))
  ) {
    throw new Error("continuation token does not match this vault.positions query");
  }

  const budget = { remaining: MAX_RPC_REQUESTS_PER_INVOCATION };
  const raw = await budgetedRequest(
    ctx,
    args.network,
    "account_objects",
    {
      account: args.account,
      ...(continuation === undefined
        ? { ledger_index: args.ledger_index ?? "validated" }
        : { ledger_hash: continuation.ledger_hash }),
      limit,
      type: "mptoken",
      ...(continuation === undefined
        ? {}
        : { marker: continuation.marker }),
    },
    budget,
  );
  const holderPage = AccountObjectsResultSchema.parse(raw);
  if (holderPage.account !== args.account) {
    throw new Error("XRPL account_objects returned a different account");
  }
  if (holderPage.account_objects.length > limit) {
    throw new Error("XRPL account_objects exceeded the requested limit");
  }
  if (
    args.ledger_index !== undefined &&
    holderPage.ledger_index !== args.ledger_index
  ) {
    throw new Error("XRPL account_objects returned a different ledger");
  }
  const pin = {
    ledger_hash: holderPage.ledger_hash,
    ledger_index: holderPage.ledger_index,
  };
  if (continuation !== undefined) {
    assertPinnedLedger(continuation, pin, "account_objects");
  }

  const positions: z.infer<typeof VaultPositionSchema>[] = [];
  const seenIssuances = new Set<string>();
  for (const object of holderPage.account_objects) {
    if (object.LedgerEntryType !== "MPToken") continue;
    const token = MPTokenSchema.parse(object);
    if (token.Account !== args.account) {
      throw new Error("XRPL MPToken belongs to a different account");
    }
    if (BigInt(token.MPTAmount) === 0n) continue;

    const issuanceId = token.MPTokenIssuanceID.toUpperCase();
    if (seenIssuances.has(issuanceId)) continue;
    seenIssuances.add(issuanceId);

    const resolved = await resolveVault(
      ctx,
      args.network,
      pin,
      issuanceId,
      budget,
    );
    if (resolved === null) continue;
    positions.push(
      toPosition(token, resolved.assetScale, resolved.issuer, resolved.vault),
    );
  }

  const continuationHandle =
    holderPage.marker === undefined
      ? undefined
      : await storeContinuation({
          account: args.account,
          ledger_hash: holderPage.ledger_hash,
          ledger_index: holderPage.ledger_index,
          marker: holderPage.marker,
          network: args.network,
        });

  return VaultPositionsResponseSchema.parse({
    account: args.account,
    ledger_hash: holderPage.ledger_hash,
    ledger_index: holderPage.ledger_index,
    ...(continuationHandle === undefined
      ? {}
      : { marker: continuationHandle }),
    network: args.network,
    positions,
    validated: true,
  });
}

export const ops: OpDef[] = [
  {
    name: "vault.positions",
    family: "vault",
    summary:
      "Read nonzero Single Asset Vault share positions from one validated ledger.",
    tags: ["vault", "positions", "mptoken", "devnet", "lending"],
    args: z
      .object({
        network: DevVaultNetworkSchema,
        account: ClassicAddressSchema,
        ledger_index: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        marker: ContinuationHandleSchema.optional(),
      })
      .strict(),
    returns: "strict validated-ledger VaultPositionsResponse",
    caveats: ["devnet-only", "amendment-pending"],
    example:
      'await harbor.vault.positions({ network: "devnet", account: "rQhUcbJoDfvgXr1EkMwarLP5QT3XinEBDg", limit: 25 })',
    handler: async (ctx, rawArgs) =>
      readVaultPositions(ctx, rawArgs as Parameters<typeof readVaultPositions>[1]),
  },
];
