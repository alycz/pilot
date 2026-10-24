import {
  PolicySchema,
  ProfileSchema,
  TradeSchema,
  type Asset,
  type Policy,
  type Profile,
  type Trade,
} from "@pilot/contracts";
import { createHash } from "node:crypto";
import matter from "gray-matter";

import { safeNoteName } from "./path";
import type {
  JournalEntry,
  PreferenceProposal,
  ReflectionNoteInput,
  TokenNoteInput,
  TradeNoteInput,
  VaultNote,
  VenueNoteInput,
  X402PaymentJournalInput,
  X402JournalReceiptState,
} from "./types";

function frontmatter(body: string, data: Record<string, unknown>): string {
  return matter.stringify(body.trimEnd() ? `${body.trimEnd()}\n` : "", data);
}

function wiki(value: string): string {
  return `[[${safeNoteName(value, "wikilink target")}]]`;
}

export function assetCode(asset: Asset): string {
  return safeNoteName(asset.currency.toUpperCase(), "asset code");
}

function assetWiki(asset: Asset): string {
  return wiki(assetCode(asset));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function x402OpaqueName(kind: "payment" | "receipt", value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200) {
    throw new Error(`Invalid x402 ${kind} id`);
  }
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  return `${kind}-${digest}`;
}

export function writeTradeNote(input: TradeNoteInput): VaultNote {
  const hash = safeNoteName(input.hash, "transaction hash");
  const venueId = safeNoteName(input.venue, "venue id");
  const trade: Trade = TradeSchema.parse({
    type: "trade",
    intent_id: input.intent_id,
    kind: input.kind,
    network: input.network,
    hash,
    venue: wiki(venueId),
    assets: input.assets.map(assetWiki),
    result: input.result,
    fill_price: input.fill_price,
    slippage_bps: input.slippage_bps,
    signed_by: input.signed_by,
    explorer: input.explorer,
    created: input.created,
  });
  const summary = input.summary ?? `${input.kind} completed with result ${input.result}.`;
  const body = `# Transaction ${hash}\n\n${summary}\n\nVenue: ${wiki(venueId)}\n\nAssets: ${input.assets.map(assetWiki).join(", ")}`;
  return { path: `Pilot/Trades/${hash}.md`, content: frontmatter(body, trade) };
}

export function appendJournalNote(
  current: string | null,
  entry: JournalEntry,
): VaultNote {
  const timestamp = new Date(entry.created);
  if (Number.isNaN(timestamp.getTime())) throw new Error("Journal entry created must be ISO-8601");
  const date = timestamp.toISOString().slice(0, 10);
  const parsed = current ? matter(current) : { data: {}, content: "" };
  const tradeHash = safeNoteName(entry.tradeHash, "transaction hash");
  if (current?.includes(wiki(tradeHash))) {
    return { path: `Pilot/Journal/${date}.md`, content: current };
  }
  const line = `- ${timestamp.toISOString()} — ${wiki(tradeHash)} — ${entry.result}${entry.summary ? ` — ${entry.summary}` : ""}`;
  const existingBody = parsed.content.trimEnd();
  const body = `${existingBody || `# Journal — ${date}`}\n\n${line}`;
  return {
    path: `Pilot/Journal/${date}.md`,
    content: frontmatter(body, {
      ...parsed.data,
      type: "journal",
      date,
      updated: timestamp.toISOString(),
    }),
  };
}

export function writeX402PaymentNote(input: X402PaymentJournalInput): VaultNote {
  const paymentName = x402OpaqueName("payment", input.paymentId);
  const timestamp = new Date(input.created);
  if (Number.isNaN(timestamp.getTime())) throw new Error("x402 payment created must be ISO-8601");
  const body = [
    `# x402 payment ${paymentName}`,
    "",
    "A local Testnet premium comparison was delivered after Harbor reported validated settlement.",
    "",
    `Transaction: \`${input.txHash}\``,
    `Amount: ${input.amountDrops} drops`,
    `Fee: ${input.feeDrops} drops`,
    `Merchant response: ${input.merchantStatus} ${input.merchantContentType}`,
  ].join("\n");
  return {
    path: `Pilot/X402/${paymentName}.md`,
    content: frontmatter(body, {
      type: "x402-payment",
      payment_id: input.paymentId,
      idempotency_key: input.idempotencyKey,
      owner: input.owner,
      network: input.network,
      resource: input.resource,
      invoice_id: input.invoiceId,
      amount_drops: input.amountDrops,
      fee_drops: input.feeDrops,
      payer: input.payer,
      pay_to: input.payTo,
      tx_hash: input.txHash,
      validated_ledger_index: input.validatedLedgerIndex,
      merchant_status: input.merchantStatus,
      merchant_content_type: input.merchantContentType,
      created: timestamp.toISOString(),
    }),
  };
}

export function writeX402ReceiptNote(input: X402JournalReceiptState): VaultNote {
  const paymentName = x402OpaqueName("payment", input.paymentId);
  const idempotencyName = x402OpaqueName("receipt", input.idempotencyKey);
  const timestamp = new Date(input.created);
  if (Number.isNaN(timestamp.getTime())) throw new Error("x402 payment created must be ISO-8601");
  return {
    path: `Pilot/X402/Receipts/${idempotencyName}.md`,
    content: frontmatter(
      `# x402 journal receipt ${paymentName}\n\nJournal reconciliation status: ${input.phase}.`,
      {
        type: "x402-journal-receipt",
        phase: input.phase,
        payment_id: input.paymentId,
        idempotency_key: input.idempotencyKey,
        owner: input.owner,
        network: input.network,
        resource: input.resource,
        invoice_id: input.invoiceId,
        amount_drops: input.amountDrops,
        fee_drops: input.feeDrops,
        payer: input.payer,
        pay_to: input.payTo,
        tx_hash: input.txHash,
        validated_ledger_index: input.validatedLedgerIndex,
        merchant_status: input.merchantStatus,
        merchant_content_type: input.merchantContentType,
        created: timestamp.toISOString(),
      },
    ),
  };
}

export function parseX402ReceiptNote(content: string): X402JournalReceiptState {
  const data = matter(content).data as Record<string, unknown>;
  if (
    data.type !== "x402-journal-receipt" ||
    (data.phase !== "pending" && data.phase !== "complete") ||
    typeof data.payment_id !== "string" ||
    typeof data.idempotency_key !== "string" ||
    typeof data.owner !== "string" ||
    data.network !== "testnet" ||
    data.resource !== "compare" ||
    typeof data.invoice_id !== "string" ||
    typeof data.amount_drops !== "string" ||
    typeof data.fee_drops !== "string" ||
    typeof data.payer !== "string" ||
    typeof data.pay_to !== "string" ||
    typeof data.tx_hash !== "string" ||
    typeof data.validated_ledger_index !== "number" ||
    !Number.isSafeInteger(data.validated_ledger_index) ||
    data.merchant_status !== 200 ||
    data.merchant_content_type !== "application/json" ||
    typeof data.created !== "string" ||
    !Number.isFinite(Date.parse(data.created))
  ) throw new Error("x402 journal receipt is invalid");
  return {
    phase: data.phase,
    paymentId: data.payment_id,
    idempotencyKey: data.idempotency_key,
    owner: data.owner,
    network: data.network,
    resource: data.resource,
    invoiceId: data.invoice_id,
    amountDrops: data.amount_drops,
    feeDrops: data.fee_drops,
    payer: data.payer,
    payTo: data.pay_to,
    txHash: data.tx_hash,
    validatedLedgerIndex: data.validated_ledger_index,
    merchantStatus: data.merchant_status,
    merchantContentType: data.merchant_content_type,
    created: new Date(data.created).toISOString(),
  };
}

export function appendX402JournalNote(
  current: string | null,
  input: X402PaymentJournalInput,
): VaultNote {
  const timestamp = new Date(input.created);
  if (Number.isNaN(timestamp.getTime())) throw new Error("x402 payment created must be ISO-8601");
  const date = timestamp.toISOString().slice(0, 10);
  const parsed = current ? matter(current) : { data: {}, content: "" };
  const paymentLink = wiki(x402OpaqueName("payment", input.paymentId));
  if (current?.includes(paymentLink)) {
    return { path: `Pilot/Journal/${date}.md`, content: current };
  }
  const line = `- ${timestamp.toISOString()} — ${paymentLink} — delivered — ${input.amountDrops} drops — validated ledger ${input.validatedLedgerIndex}`;
  const existingBody = parsed.content.trimEnd();
  return {
    path: `Pilot/Journal/${date}.md`,
    content: frontmatter(`${existingBody || `# Journal — ${date}`}\n\n${line}`, {
      ...parsed.data,
      type: "journal",
      date,
      updated: timestamp.toISOString(),
    }),
  };
}

export function writeVenueNote(input: VenueNoteInput): VaultNote {
  const id = safeNoteName(input.venue.id, "venue id");
  const assets = unique([
    ...(input.relatedAssetLinks ?? []).map(wiki),
    ...(input.relatedAssets ?? []).map(assetWiki),
  ]);
  const trades = unique((input.relatedTrades ?? []).map((hash) => wiki(hash)));
  const body = [
    `# ${input.venue.name}`,
    "",
    `Layer: ${input.venue.layer}`,
    `Categories: ${input.venue.category.join(", ")}`,
    ...(assets.length ? ["", `Assets: ${assets.join(", ")}`] : []),
    ...(trades.length ? ["", `Trades: ${trades.join(", ")}`] : []),
    ...(input.venue.risks.length
      ? ["", "## Risks", "", ...input.venue.risks.map((risk) => `- ${risk}`)]
      : []),
  ].join("\n");
  return {
    path: `Pilot/Venues/${id}.md`,
    content: frontmatter(body, {
      type: "venue",
      id,
      name: input.venue.name,
      kind: input.venue.kind,
      layer: input.venue.layer,
      category: input.venue.category,
      status: input.venue.status,
      ...(input.venue.execution ? { execution: input.venue.execution } : {}),
      reads: input.venue.reads,
      risks: input.venue.risks,
      links: input.venue.links,
      assets,
      trades,
      updated: input.updated,
    }),
  };
}

export function writeTokenNote(input: TokenNoteInput): VaultNote {
  const code = assetCode(input.asset);
  const venues = unique((input.venues ?? []).map(wiki));
  const trades = unique((input.trades ?? []).map(wiki));
  const body = [
    `# ${input.name ?? code}`,
    input.description ? `\n${input.description}` : "",
    input.asset.issuer ? `\nIssuer: \`${input.asset.issuer}\`` : "",
    ...(venues.length ? ["", `Venues: ${venues.join(", ")}`] : []),
    ...(trades.length ? ["", `Trades: ${trades.join(", ")}`] : []),
  ]
    .filter(Boolean)
    .join("\n");
  return {
    path: `Pilot/Tokens/${code}.md`,
    content: frontmatter(body, {
      type: "token",
      code,
      ...(input.asset.issuer ? { issuer: input.asset.issuer } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.description ? { description: input.description } : {}),
      issuer_flags: input.issuerFlags ?? [],
      venues,
      trades,
      updated: input.updated,
    }),
  };
}

export function writeReflectionNote(input: ReflectionNoteInput): VaultNote {
  const hash = safeNoteName(input.hash, "transaction hash");
  const tradeLink = wiki(hash);
  const observations = input.observations ?? [];
  const body = [
    `# Reflection — ${hash}`,
    "",
    `Trade: ${tradeLink}`,
    "",
    "## Expected vs actual",
    "",
    `- Fill price: ${input.expected.fillPrice ?? "not recorded"} → ${input.actual.fillPrice}`,
    `- Slippage: ${input.expected.slippageBps ?? "not recorded"} bps → ${input.actual.slippageBps} bps`,
    `- Result: ${input.expected.result ?? "not recorded"} → ${input.actual.result}`,
    ...(observations.length
      ? ["", "## Observations", "", ...observations.map((item) => `- ${item}`)]
      : []),
  ].join("\n");
  return {
    path: `Pilot/Reflections/${hash}.md`,
    content: frontmatter(body, {
      type: "reflection",
      trade: tradeLink,
      expected: input.expected,
      actual: input.actual,
      created: input.created,
    }),
  };
}

export function writeProfileNote(profile: Profile): VaultNote {
  const validated = ProfileSchema.parse(profile);
  return {
    path: "Pilot/Profile.md",
    content: frontmatter(
      "# Pilot profile\n\nPreferences are saved only after you explicitly accept a proposal.",
      validated,
    ),
  };
}

export function writePolicyNote(policy: Policy): VaultNote {
  const validated = PolicySchema.parse(policy);
  return {
    path: "Pilot/Policy.md",
    content: frontmatter(
      "# Execution policy\n\nSaving this note through Pilot synchronizes the policy with Harbor.",
      validated,
    ),
  };
}

export function parseProfileNote(content: string): Profile {
  return ProfileSchema.parse(matter(content).data);
}

export function parsePolicyNote(content: string): Policy {
  return PolicySchema.parse(matter(content).data);
}

/** Preference proposals are deliberately inert until `accepted` is literally true. */
export function acceptPreference(
  profile: Profile,
  proposal: PreferenceProposal,
  accepted: boolean,
): Profile {
  const validated = ProfileSchema.parse(profile);
  if (accepted !== true) return validated;
  const id = proposal.id.trim();
  const preference = proposal.preference.trim();
  const reason = proposal.reason?.trim();
  if (!id || id.length > 128) throw new Error("Preference proposal id is invalid");
  if (!preference || preference.length > 500) {
    throw new Error("Accepted preference must contain 1 to 500 characters");
  }
  if (proposal.reason !== undefined && (!reason || reason.length > 500)) {
    throw new Error("Preference proposal reason must contain 1 to 500 characters");
  }
  if (validated.preferences.some((entry) => !entry.trim() || entry.length > 500)) {
    throw new Error("Existing profile preferences exceed the supported bounds");
  }
  const preferences = unique([...validated.preferences, preference]);
  if (preferences.length > 256) {
    throw new Error("Profile cannot contain more than 256 accepted preferences");
  }
  return {
    ...validated,
    preferences,
  };
}
