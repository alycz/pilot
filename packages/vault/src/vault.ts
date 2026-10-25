import { TradeSchema, VenueSchema, type Trade, type Venue } from "@pilot/contracts";
import { createHash } from "node:crypto";
import matter from "gray-matter";

import {
  acceptPreference,
  appendX402JournalNote,
  appendJournalNote,
  assetCode,
  parsePolicyNote,
  parseProfileNote,
  parseX402ReceiptNote,
  writePolicyNote,
  writeProfileNote,
  writeReflectionNote,
  writeTokenNote,
  writeTradeNote,
  writeVenueNote,
  writeX402PaymentNote,
  writeX402ReceiptNote,
} from "./notes";
import { normalizeVaultPath } from "./path";
import {
  applyStructuredPreferenceCommand,
  assertStructuredPreferenceSnapshotScope,
  findStructuredPreferenceReceipt,
  parseStructuredPreferenceSnapshot,
  serializeStructuredPreferenceSnapshot,
  structuredPreferencePath,
  validateStructuredPreferenceScope,
  type StructuredPreferenceCommand,
  type StructuredPreferenceMutationResult,
  type StructuredPreferenceProposalInput,
  type StructuredPreferenceScope,
  type StructuredPreferenceSnapshot,
} from "./preferences";
import {
  applyWorkflowLessonCommand,
  assertWorkflowLessonSnapshotScope,
  findWorkflowLessonReceipt,
  findWorkflowLessonReplay,
  parseWorkflowLessonSnapshot,
  serializeWorkflowLessonSnapshot,
  workflowLessonPath,
  type WorkflowLessonCommand,
  type WorkflowLessonMutationResult,
  type WorkflowLessonMutationBinding,
  type WorkflowLessonProposalInput,
  type WorkflowLessonSnapshot,
} from "./workflow-lessons";
import { VaultSearchIndex } from "./search";
import { assertNoSensitiveContent } from "./security";
import type {
  PreferenceProposal,
  Profile,
  ValidatedTransactionInput,
  VaultBackend,
  VaultReadSnapshot,
  VaultReadSnapshotOptions,
  VaultScope,
  VaultSearchResult,
  VaultServiceOptions,
  X402PaymentJournalInput,
} from "./types";

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stripWiki(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.replace(/^\[\[/, "").replace(/\]\]$/, ""));
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function venueFromFrontmatter(data: Record<string, unknown>): Venue | undefined {
  const parsed = VenueSchema.safeParse({
    id: data.id,
    name: data.name,
    kind: data.kind,
    layer: data.layer,
    category: data.category,
    status: data.status,
    ...(data.execution === undefined ? {} : { execution: data.execution }),
    reads: data.reads,
    risks: data.risks,
    links: data.links,
  });
  return parsed.success ? parsed.data : undefined;
}

function explorerUrl(network: ValidatedTransactionInput["intent"]["network"], hash: string): string {
  const host = network === "mainnet" ? "livenet" : network === "lending-devnet" ? "devnet" : network;
  return `https://${host}.xrpl.org/transactions/${encodeURIComponent(hash)}`;
}

const CLASSIC_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const SCOPED_NETWORKS = new Set(["testnet", "devnet", "lending-devnet"]);
const MAX_SCOPED_NOTES = 256;
const MAX_SCOPED_BYTES = 1_048_576;

export type ValidatedTradeEvidence = {
  sourceRef: string;
  observedAt: string;
  transactionHash: string;
  experienceKind: "validated_outcome_reviewed";
};

export const MIN_REPEATED_TRADE_OBSERVATIONS = 2 as const;
const MAX_TRADE_ASSETS = 16;
const MAX_OBSERVATION_COUNTS = 32;
const SAFE_OBSERVATION_SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type TradeObservationCandidate = {
  kind: "frequent_asset_context" | "frequent_transaction_context";
  subject: string;
  supportCount: number;
  evidenceRefs: string[];
  /** Support ratio discounted until four validated transactions are present. */
  confidence: number;
};

export type TradeKindCount = {
  kind: Trade["kind"];
  count: number;
};

export type TradeAssetCount = {
  asset: string;
  count: number;
};

export type ScopedTradeObservationSummary = {
  status: "insufficient_evidence" | "summary";
  totalValidatedTransactions: number;
  minimumCandidateSupport: typeof MIN_REPEATED_TRADE_OBSERVATIONS;
  firstObservedAt?: string;
  lastObservedAt?: string;
  kindCounts: TradeKindCount[];
  assetCounts: TradeAssetCount[];
  cancellationCount: number;
  /** Trade notes do not encode approval or rejection feedback. */
  unavailableFeedback: readonly ["approval", "rejection"];
  candidate?: TradeObservationCandidate;
};

type ValidatedTradeRecord = {
  trade: Trade;
  evidenceRef: string;
  observationRef: string;
  assets: string[];
};

function stableTradeEvidenceIdentity(scope: StructuredPreferenceScope, trade: Trade): string {
  return JSON.stringify({
    network: scope.network,
    owner: scope.owner,
    transactionHash: trade.hash,
    observedAt: trade.created,
    intentId: trade.intent_id,
    result: trade.result,
    signedBy: trade.signed_by,
  });
}

function stableTradeObservationIdentity(
  scope: StructuredPreferenceScope,
  trade: Trade,
  assets: readonly string[],
): string {
  return JSON.stringify({
    network: scope.network,
    owner: scope.owner,
    transactionHash: trade.hash,
    observedAt: trade.created,
    intentId: trade.intent_id,
    kind: trade.kind,
    assets,
    result: trade.result,
    signedBy: trade.signed_by,
  });
}

function validatedTradeRecords(
  scope: StructuredPreferenceScope,
  contents: Map<string, string>,
): ValidatedTradeRecord[] {
  const records: ValidatedTradeRecord[] = [];
  for (const [logicalPath, content] of contents) {
    const match = /^Pilot\/Trades\/([A-Fa-f0-9]{64})\.md$/.exec(logicalPath);
    if (!match) continue;
    let trade: Trade;
    try {
      trade = TradeSchema.parse(matter(content).data);
    } catch {
      throw new Error("Scoped validated trade evidence is malformed");
    }
    const assets = stripWiki(trade.assets);
    if (
      trade.hash !== match[1] ||
      trade.network !== scope.network ||
      !Number.isFinite(Date.parse(trade.created)) ||
      assets.length > MAX_TRADE_ASSETS ||
      assets.some((asset) => !SAFE_OBSERVATION_SUBJECT.test(asset))
    ) {
      throw new Error("Scoped validated trade evidence does not match its owner/network snapshot");
    }
    records.push({
      trade,
      assets,
      evidenceRef: createHash("sha256")
        .update(stableTradeEvidenceIdentity(scope, trade), "utf8")
        .digest("hex"),
      observationRef: createHash("sha256")
        .update(stableTradeObservationIdentity(scope, trade, assets), "utf8")
        .digest("hex"),
    });
  }
  return records.sort((left, right) => Date.parse(right.trade.created) - Date.parse(left.trade.created));
}

function tradeEvidence(scope: StructuredPreferenceScope, contents: Map<string, string>): ValidatedTradeEvidence[] {
  return validatedTradeRecords(scope, contents).map(({ trade, evidenceRef }) => ({
    sourceRef: evidenceRef,
    observedAt: trade.created,
    transactionHash: trade.hash,
    experienceKind: "validated_outcome_reviewed",
  }));
}

function observations(
  records: readonly ValidatedTradeRecord[],
  values: (record: ValidatedTradeRecord) => readonly string[],
): Array<{ value: string; count: number; sourceRefs: string[] }> {
  const observations = new Map<string, { count: number; sourceRefs: string[] }>();
  for (const record of records) {
    // A single transaction may mention the same asset twice. Count the fact
    // once per validated transaction so repetition always means independent
    // records, not duplicated frontmatter.
    for (const value of new Set(values(record))) {
      const current = observations.get(value) ?? { count: 0, sourceRefs: [] };
      current.count += 1;
      if (current.sourceRefs.length < 16) current.sourceRefs.push(record.observationRef);
      observations.set(value, current);
    }
  }
  return [...observations.entries()]
    .map(([value, observation]) => ({ value, ...observation }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
    .slice(0, MAX_OBSERVATION_COUNTS);
}

function tradeObservationSummary(records: readonly ValidatedTradeRecord[]): ScopedTradeObservationSummary {
  const kinds = observations(records, ({ trade }) => [trade.kind]);
  const assets = observations(records, (record) => record.assets);
  const repeated = [
    ...assets
      .filter(({ count }) => count >= MIN_REPEATED_TRADE_OBSERVATIONS)
      .map((item) => ({ ...item, kind: "frequent_asset_context" as const })),
    ...kinds
      .filter(({ count }) => count >= MIN_REPEATED_TRADE_OBSERVATIONS)
      .map((item) => ({ ...item, kind: "frequent_transaction_context" as const })),
  ].sort((left, right) =>
    right.count - left.count ||
    left.kind.localeCompare(right.kind) ||
    left.value.localeCompare(right.value));
  const winner = repeated[0];
  const first = records[records.length - 1];
  const last = records[0];
  return {
    status: winner ? "summary" : "insufficient_evidence",
    totalValidatedTransactions: records.length,
    minimumCandidateSupport: MIN_REPEATED_TRADE_OBSERVATIONS,
    ...(first && last ? {
      firstObservedAt: first.trade.created,
      lastObservedAt: last.trade.created,
    } : {}),
    kindCounts: kinds.map(({ value, count }) => ({ kind: value as Trade["kind"], count })),
    assetCounts: assets.map(({ value, count }) => ({ asset: value, count })),
    cancellationCount: kinds.find(({ value }) => value === "cancel")?.count ?? 0,
    unavailableFeedback: ["approval", "rejection"],
    ...(winner ? {
      candidate: {
        kind: winner.kind,
        subject: winner.value,
        supportCount: winner.count,
        evidenceRefs: [...winner.sourceRefs],
        confidence: (winner.count / records.length) * Math.min(1, records.length / 4),
      },
    } : {}),
  };
}

export function vaultScopePrefix(scope: VaultScope): string {
  if (!CLASSIC_ADDRESS.test(scope.owner)) {
    throw new Error("Vault scope owner must be an XRPL classic account address");
  }
  if (!SCOPED_NETWORKS.has(scope.network)) {
    throw new Error("Vault scope network must be a supported non-mainnet network");
  }
  return `Pilot/Scopes/${scope.network}/${scope.owner}`;
}

export function scopedVaultPath(scope: VaultScope, logicalPath: string): string {
  const normalized = normalizeVaultPath(logicalPath);
  if (!normalized.startsWith("Pilot/") || normalized.startsWith("Pilot/Scopes/")) {
    throw new Error("Scoped vault paths must be logical Pilot notes outside the scope namespace");
  }
  return `${vaultScopePrefix(scope)}/${normalized.slice("Pilot/".length)}`;
}

export class VaultService {
  private readonly searchIndex = new VaultSearchIndex();
  private initialized = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly backend: VaultBackend,
    private readonly options: VaultServiceOptions = {},
  ) {}

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async initialize(): Promise<void> {
    await this.exclusive(async () => {
      await this.searchIndex.rebuild(this.backend);
      this.initialized = true;
    });
  }

  async list(prefix = "Pilot"): Promise<string[]> {
    return this.backend.list(prefix ? normalizeVaultPath(prefix) : "");
  }

  async read(path: string): Promise<string | null> {
    return this.backend.read(normalizeVaultPath(path));
  }

  async openReadSnapshot(options?: VaultReadSnapshotOptions): Promise<VaultReadSnapshot> {
    if (!this.backend.openReadSnapshot) {
      throw new Error("Vault backend does not support bounded immutable reads");
    }
    return this.backend.openReadSnapshot(options);
  }

  private async scopedSnapshotContents(scope: VaultScope): Promise<Map<string, string>> {
    const prefix = vaultScopePrefix(scope);
    const snapshot = await this.openReadSnapshot({
      prefix,
      maxEntries: MAX_SCOPED_NOTES + 1,
      maxScannedEntries: 1_024,
      suffix: ".md",
    });
    const entries = (await snapshot.list(prefix))
      .sort((left, right) => left.path.localeCompare(right.path));
    if (entries.length > MAX_SCOPED_NOTES) {
      throw new Error("Scoped vault note limit exceeded");
    }
    const seen = new Set<string>();
    let declaredBytes = 0;
    for (const entry of entries) {
      if (
        !entry.path.startsWith(`${prefix}/`) ||
        !entry.path.endsWith(".md") ||
        entry.path.includes("..") ||
        entry.path.includes("\\") ||
        entry.path.includes("\0") ||
        seen.has(entry.path)
      ) {
        throw new Error("Scoped vault returned an invalid or duplicate note path");
      }
      seen.add(entry.path);
      declaredBytes += entry.size + Buffer.byteLength(entry.path, "utf8");
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || declaredBytes > MAX_SCOPED_BYTES) {
        throw new Error("Scoped vault byte limit exceeded");
      }
    }
    const profilePath = scopedVaultPath(scope, "Pilot/Profile.md");
    const profileEntry = entries.find((entry) => entry.path === profilePath);
    if (!profileEntry) throw new Error("A matching scoped Profile.md is required for reads");

    const profileContent = await snapshot.read(profilePath, MAX_SCOPED_BYTES);
    if (profileContent === null) throw new Error("Scoped vault snapshot changed during a pinned read");
    const profile = parseProfileNote(profileContent);
    if (profile.budget_account !== scope.owner || profile.network !== scope.network) {
      throw new Error("Scoped Profile.md does not match the requested owner and network");
    }
    const contents = new Map<string, string>([["Pilot/Profile.md", profileContent]]);
    let usedBytes = Buffer.byteLength(profileContent, "utf8");
    for (const entry of entries) {
      if (entry.path === profilePath) continue;
      const remaining = MAX_SCOPED_BYTES - usedBytes;
      const content = await snapshot.read(entry.path, remaining);
      if (content === null) throw new Error("Scoped vault snapshot changed during a pinned read");
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > remaining) throw new Error("Scoped vault byte limit exceeded");
      usedBytes += bytes;
      const logical = `Pilot/${entry.path.slice(prefix.length + 1)}`;
      contents.set(logical, content);
    }
    return contents;
  }

  async readScoped(scope: VaultScope, logicalPath: string): Promise<string | null> {
    const normalized = normalizeVaultPath(logicalPath);
    // Validate/map first so global, legacy, and another explicit scope cannot
    // be selected through this API.
    scopedVaultPath(scope, normalized);
    return (await this.scopedSnapshotContents(scope)).get(normalized) ?? null;
  }

  async searchScoped(
    scope: VaultScope,
    query: string,
    limit = 10,
  ): Promise<VaultSearchResult[]> {
    const contents = await this.scopedSnapshotContents(scope);
    const index = new VaultSearchIndex();
    const backend: VaultBackend = {
      list: async (prefix = "") => [...contents.keys()].filter(
        (path) => !prefix || path === prefix || path.startsWith(`${prefix}/`),
      ),
      read: async (path) => contents.get(path) ?? null,
      write: async () => {
        throw new Error("Scoped search snapshot is read-only");
      },
    };
    await index.rebuild(backend);
    return index.search(query, limit);
  }

  async latestScopedValidatedTradeEvidence(
    scope: StructuredPreferenceScope,
  ): Promise<ValidatedTradeEvidence | undefined> {
    validateStructuredPreferenceScope(scope);
    return tradeEvidence(scope, await this.scopedSnapshotContents(scope))[0];
  }

  async scopedTradeObservationSummary(
    scope: StructuredPreferenceScope,
  ): Promise<ScopedTradeObservationSummary> {
    validateStructuredPreferenceScope(scope);
    return tradeObservationSummary(
      validatedTradeRecords(scope, await this.scopedSnapshotContents(scope)),
    );
  }

  async verifyScopedValidatedTradeEvidence(
    scope: StructuredPreferenceScope,
    sourceRef: string,
  ): Promise<ValidatedTradeEvidence> {
    validateStructuredPreferenceScope(scope);
    if (!/^[0-9a-f]{64}$/.test(sourceRef)) {
      throw new Error("Validated trade evidence reference is invalid");
    }
    const proof = tradeEvidence(scope, await this.scopedSnapshotContents(scope))
      .find((candidate) => candidate.sourceRef === sourceRef);
    if (!proof) throw new Error("Validated trade evidence was not found in this owner/network scope");
    return proof;
  }

  private async writeInternal(path: string, content: string, message?: string): Promise<void> {
    assertNoSensitiveContent(content);
    await this.backend.write(normalizeVaultPath(path), content, message);
    await this.searchIndex.rebuild(this.backend);
    this.initialized = true;
  }

  async write(path: string, content: string, message?: string): Promise<void> {
    const normalized = normalizeVaultPath(path);
    if (normalized.startsWith("Pilot/Personalization/")) {
      throw new Error("Structured personalization state cannot be written through the Markdown vault API");
    }
    assertNoSensitiveContent(`${normalized}\n${message ?? ""}\n${content}`);
    await this.exclusive(async () => {
      let previousPolicy: ReturnType<typeof parsePolicyNote> | undefined;
      if (normalized === "Pilot/Profile.md") {
        const nextProfile = parseProfileNote(content);
        const currentRaw = await this.backend.read("Pilot/Profile.md");
        if (currentRaw) {
          const currentProfile = parseProfileNote(currentRaw);
          if (!sameStrings(currentProfile.preferences, nextProfile.preferences)) {
            throw new Error(
              "Profile preferences can change only through explicit preference acceptance",
            );
          }
        } else if (nextProfile.preferences.length > 0) {
          throw new Error("A new Profile.md must start without accepted preferences");
        }
      }
      if (normalized === "Pilot/Policy.md") {
        const policy = parsePolicyNote(content);
        const previousPolicyRaw = await this.backend.read("Pilot/Policy.md");
        previousPolicy = previousPolicyRaw ? parsePolicyNote(previousPolicyRaw) : undefined;
        const profileRaw = await this.backend.read("Pilot/Profile.md");
        if (!profileRaw) throw new Error("Profile.md is required before Policy.md can be synchronized");
        const profile = parseProfileNote(profileRaw);
        if (!this.options.policySync) {
          throw new Error("Policy.md writes require a Harbor policy sync adapter");
        }
        await this.options.policySync({
          owner: profile.budget_account,
          network: profile.network,
          policy,
        });
      }
      try {
        await this.writeInternal(normalized, content, message);
      } catch (error) {
        if (normalized === "Pilot/Policy.md" && previousPolicy && this.options.policySync) {
          const profileRaw = await this.backend.read("Pilot/Profile.md");
          if (profileRaw) {
            const profile = parseProfileNote(profileRaw);
            await this.options.policySync({
              owner: profile.budget_account,
              network: profile.network,
              policy: previousPolicy,
            });
          }
        }
        throw error;
      }
    });
  }

  async savePolicy(policy: Parameters<typeof writePolicyNote>[0]): Promise<void> {
    const note = writePolicyNote(policy);
    await this.write(note.path, note.content, "vault: synchronize Policy.md");
  }

  async syncPolicy(): Promise<void> {
    await this.exclusive(async () => {
      if (!this.options.policySync) throw new Error("Policy sync adapter is not configured");
      const [policyRaw, profileRaw] = await Promise.all([
        this.backend.read("Pilot/Policy.md"),
        this.backend.read("Pilot/Profile.md"),
      ]);
      if (!policyRaw || !profileRaw) throw new Error("Profile.md and Policy.md are required for sync");
      const policy = parsePolicyNote(policyRaw);
      const profile = parseProfileNote(profileRaw);
      await this.options.policySync({
        owner: profile.budget_account,
        network: profile.network,
        policy,
      });
    });
  }

  async search(query: string, limit = 10): Promise<VaultSearchResult[]> {
    // Rebuild on every search so warm serverless instances observe writes made
    // by another instance/backend client.
    await this.initialize();
    return this.searchIndex.search(query, limit);
  }

  async saveProfile(profile: Profile): Promise<void> {
    const note = writeProfileNote(profile);
    await this.write(note.path, note.content, "vault: update Profile.md");
  }

  private async requireScopedProfile(scope: VaultScope): Promise<Profile> {
    const raw = await this.backend.read(scopedVaultPath(scope, "Pilot/Profile.md"));
    if (!raw) throw new Error("A matching scoped Profile.md is required before writing notes");
    const profile = parseProfileNote(raw);
    if (profile.budget_account !== scope.owner || profile.network !== scope.network) {
      throw new Error("Scoped Profile.md does not match the requested owner and network");
    }
    return profile;
  }

  /**
   * Establish the empty identity anchor required by scoped personalization.
   * Callers must already have derived and authenticated the complete scope;
   * ordinary reads and writes deliberately never create this file implicitly.
   */
  async ensureScopedProfile(
    scope: VaultScope & { mainAccount: string },
    profile: Profile,
  ): Promise<Profile> {
    if (
      profile.main_account !== scope.mainAccount ||
      profile.budget_account !== scope.owner ||
      profile.network !== scope.network
    ) {
      throw new Error("Scoped profile must match its authenticated identity namespace");
    }
    if (profile.preferences.length !== 0) {
      throw new Error("A new scoped Profile.md must start without accepted preferences");
    }
    const note = writeProfileNote(profile);
    return this.exclusive(async () => {
      const profilePath = scopedVaultPath(scope, note.path);
      const existing = await this.backend.read(profilePath);
      if (existing) {
        const current = parseProfileNote(existing);
        if (
          current.main_account !== scope.mainAccount ||
          current.budget_account !== scope.owner ||
          current.network !== scope.network
        ) {
          throw new Error("Scoped Profile.md does not match the authenticated identity namespace");
        }
        return current;
      }
      await this.writeInternal(profilePath, note.content, "vault: initialize scoped Profile.md");
      return profile;
    });
  }

  async saveScopedProfile(scope: VaultScope, profile: Profile): Promise<void> {
    if (profile.budget_account !== scope.owner || profile.network !== scope.network) {
      throw new Error("Scoped profile must match its owner and network namespace");
    }
    const note = writeProfileNote(profile);
    await this.exclusive(async () => {
      const path = scopedVaultPath(scope, note.path);
      const current = await this.backend.read(path);
      if (current) {
        const previous = parseProfileNote(current);
        if (!sameStrings(previous.preferences, profile.preferences)) {
          throw new Error(
            "Profile preferences can change only through explicit preference acceptance",
          );
        }
      } else if (profile.preferences.length > 0) {
        throw new Error("A new scoped Profile.md must start without accepted preferences");
      }
      await this.writeInternal(path, note.content, "vault: update scoped Profile.md");
    });
  }

  async writeScoped(
    scope: VaultScope,
    logicalPath: string,
    content: string,
    message?: string,
  ): Promise<void> {
    const normalized = normalizeVaultPath(logicalPath);
    if (normalized.startsWith("Pilot/Personalization/")) {
      throw new Error("Structured personalization state cannot be written through the Markdown vault API");
    }
    if (normalized === "Pilot/Profile.md") {
      await this.saveScopedProfile(scope, parseProfileNote(content));
      return;
    }
    await this.exclusive(async () => {
      await this.requireScopedProfile(scope);
      await this.writeInternal(scopedVaultPath(scope, normalized), content, message);
    });
  }

  async applyPreference(
    proposal: PreferenceProposal,
    accepted: boolean,
  ): Promise<Profile> {
    return this.exclusive(async () => {
      const current = await this.backend.read("Pilot/Profile.md");
      if (!current) throw new Error("Profile.md is required before preferences can be accepted");
      const profile = parseProfileNote(current);
      const updated = acceptPreference(profile, proposal, accepted);
      if (accepted === true && !sameStrings(profile.preferences, updated.preferences)) {
        const note = writeProfileNote(updated);
        await this.writeInternal(note.path, note.content, "vault: accept preference");
      }
      return updated;
    });
  }

  async applyScopedPreference(
    scope: VaultScope,
    proposal: PreferenceProposal,
    accepted: boolean,
  ): Promise<Profile> {
    return this.exclusive(async () => {
      const current = await this.requireScopedProfile(scope);
      const updated = acceptPreference(current, proposal, accepted);
      if (accepted === true && !sameStrings(current.preferences, updated.preferences)) {
        const note = writeProfileNote(updated);
        await this.writeInternal(
          scopedVaultPath(scope, note.path),
          note.content,
          "vault: accept scoped preference",
        );
      }
      return updated;
    });
  }

  private personalizationStore() {
    const store = this.options.personalizationStore;
    if (!store || (store.privateStorage !== "local" && store.privateStorage !== "remote")) {
      throw new Error("Structured preferences require configured private storage");
    }
    return store;
  }

  async readStructuredPreferences(
    scope: StructuredPreferenceScope,
  ): Promise<StructuredPreferenceSnapshot> {
    const store = this.personalizationStore();
    await this.requireScopedProfile(scope);
    const snapshot = parseStructuredPreferenceSnapshot(
      await store.read(scope),
    );
    assertStructuredPreferenceSnapshotScope(snapshot, scope);
    return snapshot;
  }

  async proposeStructuredPreference(
    scope: StructuredPreferenceScope,
    proposal: StructuredPreferenceProposalInput,
    expectedRevision: number,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<StructuredPreferenceMutationResult> {
    return this.mutateStructuredPreference(scope, {
      action: "propose",
      proposal,
      expectedRevision,
      idempotencyKey,
    }, now);
  }

  async mutateStructuredPreference(
    scope: StructuredPreferenceScope,
    command: StructuredPreferenceCommand,
    now = new Date(),
  ): Promise<StructuredPreferenceMutationResult> {
    const store = this.personalizationStore();
    await this.requireScopedProfile(scope);
    structuredPreferencePath(scope);
    const currentRaw = await store.read(scope);
    const current = parseStructuredPreferenceSnapshot(currentRaw);
    assertStructuredPreferenceSnapshotScope(current, scope);
    const result = applyStructuredPreferenceCommand(current, scope, command, now);
    if (result.idempotent) return result;
    const nextRaw = serializeStructuredPreferenceSnapshot(result.snapshot);
    const swapped = await store.compareAndSwap(
      scope,
      currentRaw,
      nextRaw,
    );
    if (swapped) return result;

    // A concurrent writer may have completed the same idempotent mutation.
    // Re-read exactly once; otherwise force the caller to reload the revision.
    const latest = parseStructuredPreferenceSnapshot(await store.read(scope));
    assertStructuredPreferenceSnapshotScope(latest, scope);
    const replay = findStructuredPreferenceReceipt(latest, command);
    if (replay) return replay;
    throw new Error("Structured preference revision conflict");
  }

  async readWorkflowLessons(
    scope: StructuredPreferenceScope,
  ): Promise<WorkflowLessonSnapshot> {
    const store = this.personalizationStore();
    await this.requireScopedProfile(scope);
    const snapshot = parseWorkflowLessonSnapshot(await store.readWorkflowLessons(scope));
    assertWorkflowLessonSnapshotScope(snapshot, scope);
    return snapshot;
  }

  async proposeWorkflowLesson(
    scope: StructuredPreferenceScope,
    proposal: WorkflowLessonProposalInput,
    expectedRevision: number,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<WorkflowLessonMutationResult> {
    return this.mutateWorkflowLesson(scope, {
      action: "propose",
      proposal,
      expectedRevision,
      idempotencyKey,
    }, now);
  }

  async mutateWorkflowLesson(
    scope: StructuredPreferenceScope,
    command: WorkflowLessonCommand,
    now = new Date(),
  ): Promise<WorkflowLessonMutationResult> {
    const store = this.personalizationStore();
    await this.requireScopedProfile(scope);
    workflowLessonPath(scope);
    const currentRaw = await store.readWorkflowLessons(scope);
    const current = parseWorkflowLessonSnapshot(currentRaw);
    assertWorkflowLessonSnapshotScope(current, scope);
    const result = applyWorkflowLessonCommand(current, scope, command, now);
    if (result.idempotent) return result;
    const nextRaw = serializeWorkflowLessonSnapshot(result.snapshot);
    const swapped = await store.compareAndSwapWorkflowLessons(scope, currentRaw, nextRaw);
    if (swapped) return result;

    const latest = parseWorkflowLessonSnapshot(await store.readWorkflowLessons(scope));
    assertWorkflowLessonSnapshotScope(latest, scope);
    const replay = findWorkflowLessonReceipt(latest, command);
    if (replay) return replay;
    throw new Error("Workflow lesson revision conflict");
  }

  async replayWorkflowLessonMutation(
    scope: StructuredPreferenceScope,
    binding: WorkflowLessonMutationBinding,
  ): Promise<WorkflowLessonMutationResult | undefined> {
    const store = this.personalizationStore();
    await this.requireScopedProfile(scope);
    const snapshot = parseWorkflowLessonSnapshot(await store.readWorkflowLessons(scope));
    assertWorkflowLessonSnapshotScope(snapshot, scope);
    return findWorkflowLessonReplay(snapshot, binding);
  }

  async recordValidatedTransaction(input: ValidatedTransactionInput): Promise<string[]> {
    return this.exclusive(async () => {
      return this.recordValidatedTransactionInternal(input, (path) => path);
    });
  }

  async recordScopedValidatedTransaction(
    scope: VaultScope,
    input: ValidatedTransactionInput,
  ): Promise<string[]> {
    if (scope.network !== input.intent.network) {
      throw new Error("Validated transaction network does not match its vault scope");
    }
    return this.exclusive(async () => {
      const profilePath = scopedVaultPath(scope, "Pilot/Profile.md");
      const existingProfile = await this.backend.read(profilePath);
      if (existingProfile) {
        await this.requireScopedProfile(scope);
      } else {
        const profile = writeProfileNote({
          main_account: scope.mainAccount ?? scope.owner,
          budget_account: scope.owner,
          network: scope.network,
          risk: "low",
          preferences: [],
        });
        await this.writeInternal(profilePath, profile.content, "vault: create scoped Profile.md");
      }
      return this.recordValidatedTransactionInternal(
        input,
        (path) => scopedVaultPath(scope, path),
      );
    });
  }

  async recordScopedX402Payment(
    scope: VaultScope,
    input: X402PaymentJournalInput,
  ): Promise<string[]> {
    if (
      scope.network !== "testnet" ||
      input.network !== "testnet" ||
      input.owner !== scope.owner
    ) {
      throw new Error("x402 payment evidence does not match its Testnet vault scope");
    }
    return this.exclusive(async () => {
      const profilePath = scopedVaultPath(scope, "Pilot/Profile.md");
      const existingProfile = await this.backend.read(profilePath);
      if (existingProfile) {
        await this.requireScopedProfile(scope);
      } else {
        const profile = writeProfileNote({
          main_account: scope.mainAccount ?? scope.owner,
          budget_account: scope.owner,
          network: scope.network,
          risk: "low",
          preferences: [],
        });
        await this.writeInternal(profilePath, profile.content, "vault: create scoped Profile.md");
      }

      const written: string[] = [];
      const logicalReceipt = writeX402ReceiptNote({ ...input, phase: "pending" });
      const receiptPath = scopedVaultPath(scope, logicalReceipt.path);
      const existingReceiptRaw = await this.backend.read(receiptPath);
      let immutableInput = input;
      if (existingReceiptRaw) {
        const existingReceipt = parseX402ReceiptNote(existingReceiptRaw);
        if (
          existingReceipt.paymentId !== input.paymentId ||
          existingReceipt.idempotencyKey !== input.idempotencyKey ||
          existingReceipt.owner !== input.owner ||
          existingReceipt.network !== input.network ||
          existingReceipt.resource !== input.resource ||
          existingReceipt.invoiceId !== input.invoiceId ||
          existingReceipt.amountDrops !== input.amountDrops ||
          existingReceipt.feeDrops !== input.feeDrops ||
          existingReceipt.payer !== input.payer ||
          existingReceipt.payTo !== input.payTo ||
          existingReceipt.txHash !== input.txHash ||
          existingReceipt.validatedLedgerIndex !== input.validatedLedgerIndex ||
          existingReceipt.merchantStatus !== input.merchantStatus ||
          existingReceipt.merchantContentType !== input.merchantContentType
        ) throw new Error("x402 journal receipt does not match the delivered payment");
        const { phase: _phase, ...frozenInput } = existingReceipt;
        immutableInput = frozenInput;
        if (existingReceipt.phase === "complete") return [receiptPath];
      } else {
        await this.writeInternal(receiptPath, logicalReceipt.content, `vault: begin ${logicalReceipt.path}`);
        written.push(receiptPath);
      }

      const payment = writeX402PaymentNote(immutableInput);
      const paymentPath = scopedVaultPath(scope, payment.path);
      const existingPayment = await this.backend.read(paymentPath);
      if (existingPayment) {
        const paymentData = matter(existingPayment).data as Record<string, unknown>;
        if (
          paymentData.payment_id !== immutableInput.paymentId ||
          paymentData.idempotency_key !== immutableInput.idempotencyKey ||
          paymentData.owner !== immutableInput.owner
        ) throw new Error("x402 payment note is already bound to different evidence");
      } else {
        await this.writeInternal(paymentPath, payment.content, `vault: record ${payment.path}`);
        written.push(paymentPath);
      }

      const journalPath = `Pilot/Journal/${new Date(immutableInput.created).toISOString().slice(0, 10)}.md`;
      const resolvedJournalPath = scopedVaultPath(scope, journalPath);
      const currentJournal = await this.backend.read(resolvedJournalPath);
      const journal = appendX402JournalNote(currentJournal, immutableInput);
      if (journal.content !== currentJournal) {
        await this.writeInternal(resolvedJournalPath, journal.content, `vault: append ${payment.path}`);
        written.push(resolvedJournalPath);
      }

      const completeReceipt = writeX402ReceiptNote({ ...immutableInput, phase: "complete" });
      await this.writeInternal(receiptPath, completeReceipt.content, `vault: complete ${completeReceipt.path}`);
      written.push(receiptPath);
      const verified = parseX402ReceiptNote(await this.backend.read(receiptPath) ?? "");
      if (verified.phase !== "complete") throw new Error("x402 journal receipt did not reach complete state");
      return [...new Set(written)];
    });
  }

  private async recordValidatedTransactionInternal(
    input: ValidatedTransactionInput,
    resolvePath: (path: string) => string,
  ): Promise<string[]> {
      const written: string[] = [];
      const writeNote = async (note: { path: string; content: string }, message: string) => {
        const path = resolvePath(note.path);
        await this.writeInternal(path, note.content, message);
        written.push(path);
      };

      const trade = writeTradeNote({
        intent_id: input.intent.id,
        kind: input.intent.kind,
        network: input.intent.network,
        hash: input.hash,
        venue: input.venue,
        assets: input.assets,
        result: input.result,
        fill_price: input.fillPrice,
        slippage_bps: input.slippageBps,
        signed_by: input.signedBy,
        explorer: explorerUrl(input.intent.network, input.hash),
        created: input.created,
        summary: input.summary,
      });
      await writeNote(trade, `vault: record trade ${input.hash}`);

      const journalPath = `Pilot/Journal/${new Date(input.created).toISOString().slice(0, 10)}.md`;
      const journal = appendJournalNote(await this.backend.read(resolvePath(journalPath)), {
        created: input.created,
        tradeHash: input.hash,
        intentId: input.intent.id,
        result: input.result,
        summary: input.summary,
      });
      await writeNote(journal, `vault: append journal for ${input.hash}`);

      const currentVenue = await this.backend.read(resolvePath(`Pilot/Venues/${input.venue}.md`));
      const currentVenueData = currentVenue ? matter(currentVenue).data : {};
      const venue =
        input.venueDetails ??
        venueFromFrontmatter(currentVenueData) ??
        ({
          id: input.venue,
          name: input.venue,
          kind: "execution-primitive",
          layer: "xrpl-l1",
          category: [],
          status: { [input.intent.network]: "live" },
          reads: [],
          risks: [],
          links: {},
        } as const);
      await writeNote(
        writeVenueNote({
          venue,
          updated: input.created,
          relatedAssetLinks: stripWiki(currentVenueData.assets),
          relatedAssets: input.assets,
          relatedTrades: [...stripWiki(currentVenueData.trades), input.hash],
        }),
        `vault: upsert venue ${input.venue}`,
      );

      for (const asset of input.assets) {
        const code = assetCode(asset);
        const currentToken = await this.backend.read(resolvePath(`Pilot/Tokens/${code}.md`));
        const currentTokenData = currentToken ? matter(currentToken).data : {};
        const detail = input.tokenDetails?.find(
          (candidate) =>
            candidate.asset.currency.toUpperCase() === asset.currency.toUpperCase() &&
            candidate.asset.issuer === asset.issuer,
        );
        await writeNote(
          writeTokenNote({
            asset,
            updated: input.created,
            name:
              detail?.name ??
              (typeof currentTokenData.name === "string" ? currentTokenData.name : undefined),
            description:
              detail?.description ??
              (typeof currentTokenData.description === "string"
                ? currentTokenData.description
                : undefined),
            issuerFlags: detail?.issuerFlags ?? strings(currentTokenData.issuer_flags),
            venues: [...stripWiki(currentTokenData.venues), input.venue],
            trades: [...stripWiki(currentTokenData.trades), input.hash],
          }),
          `vault: upsert token ${code}`,
        );
      }

      await writeNote(
        writeReflectionNote({
          hash: input.hash,
          created: input.created,
          expected: input.expected ?? {},
          actual: {
            fillPrice: input.fillPrice,
            slippageBps: input.slippageBps,
            result: input.result,
          },
          observations: input.observations,
        }),
        `vault: reflect on ${input.hash}`,
      );
      return written;
  }
}
