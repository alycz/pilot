import {
  Ap4mReceiptSchema,
  McIntentSchema,
  type Ap4mReceipt,
  type Mandate,
  type McIntent,
} from "@pilot/contracts";
import matter from "gray-matter";
import { z } from "zod";

import { safeNoteName } from "./path";
import { assertNoSensitiveContent } from "./security";
import type { VaultNote, VaultReadSnapshotOptions, VaultScope } from "./types";
import { vaultScopePrefix } from "./vault";

const SHA256_HEX = /^[A-Fa-f0-9]{64}$/;
const XRPL_OBJECT_ID = /^[A-Fa-f0-9]{64}$/;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const ISO_DATE_MAX_LENGTH = 35;
const MAX_MANDATE_NOTES = 64;
const MAX_MANDATE_NOTE_BYTES = 32 * 1024;
const MAX_MANDATE_SCAN_ENTRIES = 1_024;

export type ActiveAp4mMandateReference = {
  mandate_id: string;
  owner: string;
};

export type Ap4mMandateSnapshotSource = {
  openReadSnapshot(options?: VaultReadSnapshotOptions): Promise<{
    readonly revision: string | null;
    list(prefix?: string): Promise<Array<{ path: string; size: number }>>;
    read(path: string, maxBytes: number): Promise<string | null>;
  }>;
};

const MandateNameSchema = z.string().trim().min(1).max(128)
  .regex(/^[^\\/\0:\r\n]+$/)
  .refine((value) => value !== "." && value !== "..", "invalid bounded name");
const DigestSchema = z.string().regex(/^[A-Fa-f0-9]{64}$/);
const DecimalSchema = z.string().max(80).regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
const IsoDateSchema = z.string().max(ISO_DATE_MAX_LENGTH).refine(
  (value) => !Number.isNaN(Date.parse(value)),
  "invalid ISO-8601 date",
);
const MaskedLabelSchema = z.string().trim().min(1).max(80).regex(/[•*…]/u);
const BalanceSnapshotSchema = z.object({
  amount: DecimalSchema,
  currency: z.string().trim().min(1).max(12).regex(/^[A-Za-z0-9]+$/),
}).strict();
const OpenFinanceEvidenceSchema = z.discriminatedUnion("mode", [
  z.object({
    label: z.literal("Mastercard Open Finance · mock"),
    mode: z.literal("mock"),
    owner_name_hash: DigestSchema,
    masked_account_label: MaskedLabelSchema.optional(),
    balance_snapshot: BalanceSnapshotSchema.optional(),
  }).strict(),
  z.object({
    label: z.literal("Mastercard Open Finance · sandbox"),
    mode: z.literal("sandbox"),
    owner_name_hash: DigestSchema,
    masked_account_label: MaskedLabelSchema.optional(),
    balance_snapshot: BalanceSnapshotSchema.optional(),
  }).strict(),
]);
const MandateNoteSchema = z.object({
  type: z.literal("ap4m_mandate"),
  version: z.literal(1),
  mandate_id: MandateNameSchema,
  network: z.literal("testnet"),
  status: z.enum(["PENDING", "ACTIVE", "REVOKED", "EXPIRED"]),
  execution_type: z.literal("DEFERRED"),
  not_before: IsoDateSchema,
  expires_at: IsoDateSchema,
  constraints: z.object({
    currency: z.literal("USD"),
    per_payment_max: DecimalSchema,
    daily_max: DecimalSchema,
    total_max: DecimalSchema,
    payees: z.array(MandateNameSchema).min(1).max(64),
    skus: z.array(MandateNameSchema).max(64).optional(),
  }).strict(),
  evidence: z.object({
    l1_digest: DigestSchema,
    l2_digest: DigestSchema,
    setup_transactions: z.array(z.object({
      hash: DigestSchema,
      explorer: z.string().max(256),
    }).strict()).min(1).max(32),
    channels: z.array(z.object({
      merchant_id: MandateNameSchema,
      channel_id: DigestSchema,
      amount_drops: DecimalSchema,
      explorer: z.string().max(256),
    }).strict()).max(64),
  }).strict(),
  open_finance: OpenFinanceEvidenceSchema,
  recorded_at: IsoDateSchema,
}).strict().superRefine((note, context) => {
  if (Date.parse(note.not_before) >= Date.parse(note.expires_at)) {
    context.addIssue({ code: "custom", path: ["expires_at"], message: "mandate expiry must follow not-before" });
  }
  if (new Set(note.constraints.payees).size !== note.constraints.payees.length) {
    context.addIssue({ code: "custom", path: ["constraints", "payees"], message: "mandate payees must be unique" });
  }
  if (note.constraints.skus && new Set(note.constraints.skus).size !== note.constraints.skus.length) {
    context.addIssue({ code: "custom", path: ["constraints", "skus"], message: "mandate SKUs must be unique" });
  }
  for (const [index, transaction] of note.evidence.setup_transactions.entries()) {
    const expected = `https://testnet.xrpl.org/transactions/${transaction.hash.toUpperCase()}`;
    if (transaction.explorer !== expected) {
      context.addIssue({ code: "custom", path: ["evidence", "setup_transactions", index, "explorer"], message: "setup explorer does not match its transaction hash" });
    }
  }
  for (const [index, channel] of note.evidence.channels.entries()) {
    const expected = `https://test.bithomp.com/explorer/${channel.channel_id.toUpperCase()}`;
    if (channel.explorer !== expected) {
      context.addIssue({ code: "custom", path: ["evidence", "channels", index, "explorer"], message: "channel explorer does not match its channel id" });
    }
  }
});

export type Ap4mOpenFinanceEvidence = {
  label: "Mastercard Open Finance · mock" | "Mastercard Open Finance · sandbox";
  mode: "mock" | "sandbox";
  owner_name_hash: string;
  balance_snapshot?: {
    amount: string;
    currency: string;
  };
  masked_account_label?: string;
};

export type Ap4mMandateNoteInput = {
  mandate_id: string;
  network: "testnet";
  status: Mandate["status"];
  execution_type: "DEFERRED";
  not_before: string;
  expires_at: string;
  constraints: Mandate["constraints"];
  l1_digest: string;
  l2_digest: string;
  setup_tx_hashes: string[];
  channels: Array<{
    merchant_id: string;
    channel_id: string;
    amount_drops: string;
  }>;
  open_finance: Ap4mOpenFinanceEvidence;
  recorded_at: string;
};

export type Ap4mReceiptNoteInput = {
  receipt: Ap4mReceipt;
  intent: McIntent;
  explorer_url?: string;
  recorded_at: string;
};

function requireHash(value: string, label: string): string {
  if (!SHA256_HEX.test(value)) throw new Error(`${label} must be a 64-character hexadecimal digest`);
  return value.toUpperCase();
}

function requireObjectId(value: string, label: string): string {
  if (!XRPL_OBJECT_ID.test(value)) throw new Error(`${label} must be a 64-character XRPL object id`);
  return value.toUpperCase();
}

function requireDecimal(value: string, label: string): string {
  if (!DECIMAL.test(value)) throw new Error(`${label} must be a canonical non-negative decimal`);
  return value;
}

function requireIsoDate(value: string, label: string): string {
  if (value.length > ISO_DATE_MAX_LENGTH || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO-8601 date`);
  }
  return new Date(value).toISOString();
}

function requireBoundedText(value: string, label: string, maxLength = 160): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\r\n\0]/.test(normalized)) {
    throw new Error(`${label} must be a non-empty single-line value of at most ${maxLength} characters`);
  }
  return normalized;
}

function requireOwnerHash(value: string): string {
  // Open Finance owner identity is never persisted; only a SHA-256 digest is accepted.
  return requireHash(value, "Open Finance owner-name hash");
}

function requireMaskedAccountLabel(value: string): string {
  const label = requireBoundedText(value, "masked account label", 80);
  if (!/[•*…]/u.test(label)) {
    throw new Error("Open Finance account labels must contain an explicit masking marker");
  }
  return label;
}

function transactionExplorerUrl(hash: string): string {
  return `https://testnet.xrpl.org/transactions/${requireObjectId(hash, "transaction hash")}`;
}

function requireTestnetExplorerUrl(value: string | undefined, transactionHash?: string): string | undefined {
  if (!value) return transactionHash ? transactionExplorerUrl(transactionHash) : undefined;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "testnet.xrpl.org") {
    throw new Error("AP4M explorer URL must use the XRPL Testnet explorer");
  }
  const expected = transactionHash
    ? `/transactions/${requireObjectId(transactionHash, "transaction hash")}`
    : undefined;
  if (expected && url.pathname !== expected) {
    throw new Error("AP4M explorer URL must match the receipt transaction hash");
  }
  if (url.username || url.password || url.port || url.search || url.hash) {
    throw new Error("AP4M explorer URL cannot contain credentials, ports, query parameters, or fragments");
  }
  return url.toString();
}

function frontmatterOnly(data: Record<string, unknown>): string {
  const content = matter.stringify("", data);
  assertNoSensitiveContent(content);
  return content;
}

/**
 * Resolve one server-owned active mandate from an immutable wallet-scoped
 * snapshot. Browser input never supplies a mandate id. Every note in the
 * bounded Mandates subtree must be structurally valid; malformed or ambiguous
 * state fails closed instead of being skipped.
 */
export async function resolveActiveAp4mMandate(
  source: Ap4mMandateSnapshotSource,
  scope: VaultScope,
  now = new Date(),
): Promise<ActiveAp4mMandateReference | undefined> {
  if (scope.network !== "testnet") return undefined;
  if (Number.isNaN(now.getTime())) throw new Error("AP4M mandate resolution requires a valid time");

  const prefix = `${vaultScopePrefix(scope)}/Mandates`;
  const snapshot = await source.openReadSnapshot({
    prefix,
    maxEntries: MAX_MANDATE_NOTES + 1,
    maxScannedEntries: MAX_MANDATE_SCAN_ENTRIES,
    suffix: ".md",
  });
  const entries = (await snapshot.list(prefix)).sort((left, right) =>
    left.path.localeCompare(right.path));
  if (entries.length > MAX_MANDATE_NOTES) {
    throw new Error("AP4M mandate note limit exceeded");
  }

  const seen = new Set<string>();
  const active: ActiveAp4mMandateReference[] = [];
  for (const entry of entries) {
    if (
      !entry.path.startsWith(`${prefix}/`) ||
      entry.path.slice(prefix.length + 1).includes("/") ||
      !entry.path.endsWith(".md") ||
      entry.path.includes("\\") ||
      entry.path.includes("\0") ||
      seen.has(entry.path) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > MAX_MANDATE_NOTE_BYTES
    ) {
      throw new Error("AP4M mandate snapshot contains an invalid note entry");
    }
    seen.add(entry.path);
    const content = await snapshot.read(entry.path, MAX_MANDATE_NOTE_BYTES);
    if (content === null || Buffer.byteLength(content, "utf8") !== entry.size) {
      throw new Error("AP4M mandate snapshot changed or reported an invalid note size");
    }
    let parsed: ReturnType<typeof matter>;
    try {
      parsed = matter(content);
    } catch {
      throw new Error("AP4M mandate note frontmatter is malformed");
    }
    if (parsed.content.trim() !== "") {
      throw new Error("AP4M mandate notes must contain frontmatter only");
    }
    const note = MandateNoteSchema.parse(parsed.data);
    const pathMandateId = entry.path.slice(prefix.length + 1, -".md".length);
    if (note.mandate_id !== pathMandateId) {
      throw new Error("AP4M mandate note id does not match its scoped path");
    }
    const nowMs = now.getTime();
    if (
      note.status === "ACTIVE" &&
      Date.parse(note.not_before) <= nowMs &&
      nowMs < Date.parse(note.expires_at)
    ) {
      active.push({ mandate_id: note.mandate_id, owner: scope.owner });
    }
  }

  if (active.length > 1) throw new Error("AP4M mandate scope contains multiple active mandates");
  return active[0];
}

/**
 * Create the hash-only AP4M mandate record. This function deliberately has no
 * field for compact L1/L2 presentations, customer references, payment account
 * identifiers, keys, or Open Finance owner data.
 */
export function writeAp4mMandateNote(input: Ap4mMandateNoteInput): VaultNote {
  const mandateId = safeNoteName(input.mandate_id, "mandate id");
  if (input.network !== "testnet") throw new Error("AP4M mandate notes are Testnet-only");
  if (input.execution_type !== "DEFERRED") throw new Error("AP4M mandates must use DEFERRED execution");
  if (input.open_finance.label !== `Mastercard Open Finance · ${input.open_finance.mode}`) {
    throw new Error("Open Finance label must match its mode");
  }

  const payees = input.constraints.payees.map((payee) =>
    safeNoteName(payee, "mandate payee"),
  );
  if (new Set(payees).size !== payees.length) throw new Error("Mandate payees must be unique");
  const skus = input.constraints.skus?.map((sku) => safeNoteName(sku, "mandate SKU"));
  if (skus && new Set(skus).size !== skus.length) throw new Error("Mandate SKUs must be unique");

  const setupTxHashes = input.setup_tx_hashes.map((hash) =>
    requireObjectId(hash, "setup transaction hash"),
  );
  if (setupTxHashes.length === 0 || new Set(setupTxHashes).size !== setupTxHashes.length) {
    throw new Error("AP4M setup requires one or more unique transaction hashes");
  }

  const channels = input.channels.map((channel) => ({
    merchant_id: safeNoteName(channel.merchant_id, "channel merchant id"),
    channel_id: requireObjectId(channel.channel_id, "payment channel id"),
    amount_drops: requireDecimal(channel.amount_drops, "channel amount"),
    explorer: `https://test.bithomp.com/explorer/${requireObjectId(channel.channel_id, "payment channel id")}`,
  }));

  const data = {
    type: "ap4m_mandate",
    version: 1,
    mandate_id: mandateId,
    network: "testnet",
    status: input.status,
    execution_type: "DEFERRED",
    not_before: requireIsoDate(input.not_before, "mandate not-before"),
    expires_at: requireIsoDate(input.expires_at, "mandate expiry"),
    constraints: {
      currency: "USD",
      per_payment_max: requireDecimal(input.constraints.per_payment_max, "per-payment maximum"),
      daily_max: requireDecimal(input.constraints.daily_max, "daily maximum"),
      total_max: requireDecimal(input.constraints.total_max, "total maximum"),
      payees,
      ...(skus ? { skus } : {}),
    },
    evidence: {
      l1_digest: requireHash(input.l1_digest, "L1 digest"),
      l2_digest: requireHash(input.l2_digest, "L2 digest"),
      setup_transactions: setupTxHashes.map((hash) => ({
        hash,
        explorer: transactionExplorerUrl(hash),
      })),
      channels,
    },
    open_finance: {
      label: input.open_finance.label,
      mode: input.open_finance.mode,
      owner_name_hash: requireOwnerHash(input.open_finance.owner_name_hash),
      ...(input.open_finance.masked_account_label
        ? { masked_account_label: requireMaskedAccountLabel(input.open_finance.masked_account_label) }
        : {}),
      ...(input.open_finance.balance_snapshot
        ? {
            balance_snapshot: {
              amount: requireDecimal(input.open_finance.balance_snapshot.amount, "balance snapshot"),
              currency: requireBoundedText(
                input.open_finance.balance_snapshot.currency.toUpperCase(),
                "balance currency",
                12,
              ),
            },
          }
        : {}),
    },
    recorded_at: requireIsoDate(input.recorded_at, "recorded-at"),
  } satisfies Record<string, unknown>;

  return {
    path: `Pilot/Mandates/${mandateId}.md`,
    content: frontmatterOnly(data),
  };
}

/**
 * Create a receipt note from the strict shared contracts. Compact VI tokens,
 * presigned transaction blobs, credential ids, and merchant response bodies
 * are intentionally not accepted by this API.
 */
export function writeAp4mReceiptNote(input: Ap4mReceiptNoteInput): VaultNote {
  const receipt = Ap4mReceiptSchema.parse(input.receipt);
  const intent = McIntentSchema.parse(input.intent);
  if (intent.intentId !== receipt.intent_id) {
    throw new Error("Receipt and Mastercard intent ids must match");
  }
  const receiptId = safeNoteName(receipt.receipt_id, "receipt id");
  const txHash = receipt.proof.tx_hash
    ? requireObjectId(receipt.proof.tx_hash, "receipt transaction hash")
    : undefined;
  const channelId = receipt.proof.channel_id
    ? requireObjectId(receipt.proof.channel_id, "receipt payment channel id")
    : undefined;
  if (receipt.scheme === "exact" && !txHash) throw new Error("Exact receipts require a transaction hash");
  if (receipt.scheme === "xrpl-paychan" && !channelId) {
    throw new Error("Payment-channel receipts require a channel id");
  }

  const explorer = requireTestnetExplorerUrl(input.explorer_url, txHash);
  const content = frontmatterOnly({
    type: "ap4m_receipt",
    version: 1,
    receipt_id: receiptId,
    mandate_id: safeNoteName(receipt.mandate_id, "mandate id"),
    merchant_id: safeNoteName(receipt.merchant_id, "merchant id"),
    sku: safeNoteName(receipt.sku, "SKU"),
    intent,
    evidence: {
      l3a_digest: requireHash(receipt.l3a_digest, "L3a digest"),
      l3b_digest: requireHash(receipt.l3b_digest, "L3b digest"),
      proof: {
        ...(txHash ? { tx_hash: txHash } : {}),
        ...(channelId ? { channel_id: channelId } : {}),
        ...(receipt.proof.cumulative_drops
          ? { cumulative_drops: requireDecimal(receipt.proof.cumulative_drops, "cumulative drops") }
          : {}),
      },
      merchant_validation: receipt.merchant_validation,
      ...(explorer ? { explorer } : {}),
    },
    scheme: receipt.scheme,
    amount: receipt.amount,
    settlement: receipt.settlement,
    purchased_at: requireIsoDate(receipt.at, "receipt timestamp"),
    recorded_at: requireIsoDate(input.recorded_at, "recorded-at"),
  });

  return { path: `Pilot/Receipts/${receiptId}.md`, content };
}
