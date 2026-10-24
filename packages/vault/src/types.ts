import type {
  Asset,
  Intent,
  Network,
  Policy,
  Profile,
  Trade,
  Venue,
} from "@pilot/contracts";

export interface VaultBackend {
  read(path: string): Promise<string | null>;
  list(prefix?: string): Promise<string[]>;
  write(path: string, content: string, message?: string): Promise<void>;
  openReadSnapshot?(options?: VaultReadSnapshotOptions): Promise<VaultReadSnapshot>;
}

export type VaultReadSnapshotOptions = {
  /** Restrict metadata discovery to this subtree. */
  prefix?: string;
  /** Stop discovery once this many entries have been found. */
  maxEntries?: number;
  /** Fail closed after scanning this many files/directories, including ignored entries. */
  maxScannedEntries?: number;
  /** Count and retain only entries with this suffix while discovering metadata. */
  suffix?: string;
};

export type VaultReadEntry = {
  path: string;
  /** Exact blob size in bytes at the pinned revision. */
  size: number;
};

/**
 * An immutable view of a backend revision. `read` must reject before decoding a
 * blob whose encoded or decoded bytes can exceed `maxBytes`.
 */
export interface VaultReadSnapshot {
  readonly revision: string | null;
  list(prefix?: string): Promise<VaultReadEntry[]>;
  read(path: string, maxBytes: number): Promise<string | null>;
}

export type VaultNote = {
  path: string;
  content: string;
};

export type VaultSearchResult = {
  path: string;
  title: string;
  excerpt: string;
  score: number;
  frontmatter: Record<string, unknown>;
};

export type TradeNoteInput = Omit<Trade, "type" | "venue" | "assets"> & {
  venue: string;
  assets: Asset[];
  summary?: string;
};

export type JournalEntry = {
  created: string;
  tradeHash: string;
  intentId: string;
  result: Trade["result"];
  summary?: string;
};

export type X402PaymentJournalInput = {
  paymentId: string;
  idempotencyKey: string;
  owner: string;
  network: "testnet";
  resource: "compare";
  invoiceId: string;
  amountDrops: string;
  feeDrops: string;
  payer: string;
  payTo: string;
  txHash: string;
  validatedLedgerIndex: number;
  merchantStatus: 200;
  merchantContentType: "application/json";
  created: string;
};

export type X402JournalReceiptState = X402PaymentJournalInput & {
  phase: "pending" | "complete";
};

export type VenueNoteInput = {
  venue: Venue;
  updated: string;
  relatedAssets?: Asset[];
  relatedAssetLinks?: string[];
  relatedTrades?: string[];
};

export type TokenNoteInput = {
  asset: Asset;
  updated: string;
  name?: string;
  description?: string;
  issuerFlags?: string[];
  venues?: string[];
  trades?: string[];
};

export type ReflectionNoteInput = {
  hash: string;
  created: string;
  expected: {
    fillPrice?: string;
    slippageBps?: number;
    result?: string;
  };
  actual: {
    fillPrice: string;
    slippageBps: number;
    result: Trade["result"];
  };
  observations?: string[];
};

export type PreferenceProposal = {
  id: string;
  preference: string;
  reason?: string;
};

export type ValidatedTransactionInput = {
  intent: Intent;
  hash: string;
  venue: string;
  assets: Asset[];
  result: Trade["result"];
  fillPrice: string;
  slippageBps: number;
  signedBy: Trade["signed_by"];
  created: string;
  expected?: ReflectionNoteInput["expected"];
  observations?: string[];
  summary?: string;
  venueDetails?: Venue;
  tokenDetails?: (Omit<TokenNoteInput, "updated" | "trades"> & { asset: Asset })[];
};

export type PolicySync = (input: {
  owner: string;
  network: Network;
  policy: Policy;
}) => Promise<void>;

export type VaultServiceOptions = {
  policySync?: PolicySync;
  personalizationStore?: import("./preference-store").StructuredPreferenceStore;
};

export type VaultScope = {
  owner: string;
  network: Network;
  mainAccount?: string;
};

export type VaultEnvironment = {
  VAULT_BACKEND?: string;
  VAULT_PATH?: string;
  VAULT_GITHUB_TOKEN?: string;
  VAULT_REPO?: string;
  PILOT_PERSONALIZATION_STATE_DIR?: string;
  PILOT_STRUCTURED_PREFERENCES?: string;
};

export type { Policy, Profile };
