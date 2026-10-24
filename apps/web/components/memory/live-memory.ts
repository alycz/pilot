import {
  WALLET_SESSION_CHANGED_EVENT,
  type PublicPilotConfig,
  type WalletSessionStatus,
} from "../../lib/harbor-browser";
import { PolicySchema, type Network } from "@pilot/contracts";
import type { HarborClient } from "@pilot/harbor-client";
import { z } from "zod";

import type {
  MemoryGraphEdge,
  MemoryGraphNode,
  MemoryNote,
  MemoryNoteKind,
  MemorySnapshot,
} from "./types";

export type VaultEntry = {
  path: string;
  content: string;
};

type ParsedMarkdown = {
  body: string;
  frontmatter: Record<string, string>;
};

type ParsedNote = MemoryNote & { linkTargets: string[] };

const VaultSnapshotSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        owner: z.string().regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/),
        network: z.enum(["testnet", "devnet"]),
        generatedAt: z.string().datetime(),
        notes: z.array(z.object({ path: z.string().min(1), content: z.string() }).strict()),
      })
      .strict(),
  })
  .strict();

export type MemoryReadiness =
  | { kind: "checking" }
  | { kind: "configuration-error" }
  | { kind: "mock" }
  | { kind: "personalization-fixture"; owner: string; network: "testnet" | "devnet" }
  | { kind: "session-error" }
  | { kind: "no-session" }
  | { kind: "session-expired" }
  | { kind: "network-mismatch"; configuredNetwork: "testnet" | "devnet"; sessionNetwork: "testnet" | "devnet" }
  | { kind: "live"; owner: string; network: "testnet" | "devnet" };

export type MemoryPresentation =
  | { kind: "checking" }
  | { kind: "live" }
  | { kind: "demo"; reason?: string };

/**
 * Chooses what Memory renders. Only a verified, unexpired, same-network
 * session loads owner-scoped vault data; every other state shows the local,
 * clearly labelled demo vault. Demo data never mixes with live data.
 */
export function memoryPresentation(readiness: MemoryReadiness): MemoryPresentation {
  switch (readiness.kind) {
    case "checking":
      return { kind: "checking" };
    case "live":
      return { kind: "live" };
    case "mock":
    case "no-session":
      return { kind: "demo" };
    case "configuration-error":
      return { kind: "demo", reason: "Pilot's public configuration is unavailable, so the demo vault is shown." };
    case "session-error":
      return { kind: "demo", reason: "Pilot could not verify a wallet session, so the demo vault is shown." };
    case "session-expired":
      return { kind: "demo", reason: "Your wallet session expired. Reconnect to load your own vault." };
    case "network-mismatch":
      return {
        kind: "demo",
        reason: `Your wallet session is on ${readiness.sessionNetwork}, but Pilot is configured for ${readiness.configuredNetwork}. Reconnect on ${readiness.configuredNetwork} to load your own vault.`,
      };
    case "personalization-fixture":
      return { kind: "demo" };
  }
}

const NOTE_FOLDERS: Array<{ prefix: string; kind: MemoryNoteKind }> = [
  { prefix: "Pilot/Journal/", kind: "journal" },
  { prefix: "Pilot/Trades/", kind: "trade" },
  { prefix: "Pilot/Venues/", kind: "venue" },
  { prefix: "Pilot/Tokens/", kind: "token" },
  { prefix: "Pilot/Reflections/", kind: "reflection" },
];

function parseMarkdown(content: string): ParsedMarkdown {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { body: normalized, frontmatter: {} };
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) return { body: normalized, frontmatter: {} };
  const frontmatter: Record<string, string> = {};
  for (const line of normalized.slice(4, closing).split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1 || /^\s/.test(line)) continue;
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    if (!key || !raw || raw === "|" || raw === ">") continue;
    frontmatter[key] = raw.replace(/^(['"])(.*)\1$/, "$2");
  }
  return { body: normalized.slice(closing + 5), frontmatter };
}

function kindForPath(path: string): MemoryNoteKind | undefined {
  if (path === "Pilot/Profile.md") return "profile";
  if (path === "Pilot/Policy.md") return "policy";
  return NOTE_FOLDERS.find(({ prefix }) => path.startsWith(prefix))?.kind;
}

function stem(path: string): string {
  return path.replace(/^Pilot\//, "").replace(/\.md$/i, "");
}

function normalizeAlias(value: string): string {
  return value
    .trim()
    .replace(/^Pilot\//, "")
    .replace(/\.md$/i, "")
    .toLocaleLowerCase();
}

function noteId(path: string): string {
  const bytes = new TextEncoder().encode(path);
  return `note-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function firstHeading(body: string): string | undefined {
  return body.split("\n").map((line) => line.trim()).find((line) => /^#\s+/.test(line))?.replace(/^#\s+/, "").trim();
}

function contentBlocks(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0 && !/^#\s+/.test(block));
}

function linksIn(content: string): string[] {
  return [...content.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
}

function supportedNetwork(value: string | undefined): Network | undefined {
  return value === "testnet" || value === "devnet" || value === "lending-devnet" || value === "mainnet"
    ? value
    : undefined;
}

function parseNote(entry: VaultEntry): ParsedNote | undefined {
  const kind = kindForPath(entry.path);
  if (!kind || !entry.path.endsWith(".md")) return undefined;
  const parsed = parseMarkdown(entry.content);
  const blocks = contentBlocks(parsed.body);
  const title = firstHeading(parsed.body) ?? stem(entry.path).split("/").at(-1);
  if (!title) return undefined;
  const updatedAt = parsed.frontmatter.updated ?? parsed.frontmatter.created;
  return {
    id: noteId(entry.path),
    path: entry.path,
    title,
    kind,
    summary: blocks[0] ?? "",
    body: blocks.slice(1),
    links: [],
    linkTargets: linksIn(entry.content),
    tags: [],
    ...(updatedAt && !Number.isNaN(Date.parse(updatedAt)) ? { updatedAt } : {}),
    ...(supportedNetwork(parsed.frontmatter.network)
      ? { network: supportedNetwork(parsed.frontmatter.network) }
      : {}),
  };
}

function aliases(note: MemoryNote): string[] {
  const pathStem = stem(note.path);
  return [pathStem, pathStem.split("/").at(-1) ?? pathStem, note.title]
    .map(normalizeAlias);
}

function graphNode(note: MemoryNote, index: number, count: number): MemoryGraphNode {
  const angle = -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(count, 1);
  return {
    id: note.id,
    noteId: note.id,
    label: note.title.length > 18 ? `${note.title.slice(0, 17)}…` : note.title,
    kind: note.kind,
    x: 250 + Math.cos(angle) * 170,
    y: 180 + Math.sin(angle) * 125,
  };
}

/** Converts only persisted Markdown into UI notes and wikilink edges. */
export function buildLiveMemoryGraph(entries: VaultEntry[]): {
  notes: MemoryNote[];
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
} {
  const parsed = entries
    .map(parseNote)
    .filter((note): note is ParsedNote => note !== undefined)
    .sort((left, right) => left.path.localeCompare(right.path));
  const byAlias = new Map<string, string>();
  for (const note of parsed) {
    for (const alias of aliases(note)) byAlias.set(alias, note.id);
  }
  const edgeKeys = new Set<string>();
  const edges: MemoryGraphEdge[] = [];
  const notes = parsed.map(({ linkTargets, ...note }) => {
    const links = linkTargets
      .map((target) => byAlias.get(normalizeAlias(target)))
      .filter((target): target is string => target !== undefined && target !== note.id)
      .filter((target, index, all) => all.indexOf(target) === index);
    for (const target of links) {
      const key = [note.id, target].sort().join("\u0000");
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        edges.push({ from: note.id, to: target });
      }
    }
    return { ...note, links };
  });
  return {
    notes,
    nodes: notes.map((note, index) => graphNode(note, index, notes.length)),
    edges,
  };
}

export function memoryContextKey(owner: string, network: "testnet" | "devnet"): string {
  return `${network}:${owner}`;
}

/** Forces live read-only policy fields to remount atomically with a new snapshot. */
export function livePolicyEditorKey(
  snapshot: Pick<MemorySnapshot, "owner" | "network" | "generatedAt" | "policy">,
): string {
  return `${memoryContextKey(snapshot.owner, snapshot.network)}:${snapshot.generatedAt}:${JSON.stringify(snapshot.policy)}`;
}

/** Never expose a cached vault snapshot while identity is unknown or changed. */
export function memorySnapshotMatchesContext(
  snapshot: Pick<MemorySnapshot, "owner" | "network"> | undefined,
  readiness: MemoryReadiness,
): boolean {
  return Boolean(
    snapshot &&
    readiness.kind === "live" &&
    snapshot.owner === readiness.owner &&
    snapshot.network === readiness.network,
  );
}

export function personalizationPanelScope(
  readiness: MemoryReadiness,
  snapshot?: Pick<MemorySnapshot, "owner" | "network">,
): { owner: string; network: "testnet" | "devnet" } | undefined {
  if (readiness.kind === "personalization-fixture") {
    return { owner: readiness.owner, network: readiness.network };
  }
  if (
    readiness.kind === "live" &&
    snapshot?.owner === readiness.owner &&
    snapshot.network === readiness.network
  ) {
    return { owner: snapshot.owner, network: snapshot.network };
  }
  return undefined;
}

const FixtureSessionSchema = z.discriminatedUnion("authenticated", [
  z.object({ enabled: z.literal(true), authenticated: z.literal(false) }).strict(),
  z.object({
    enabled: z.literal(true),
    authenticated: z.literal(true),
    account: z.string().regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/),
    network: z.enum(["testnet", "devnet"]),
    expiresAt: z.number().int().positive(),
  }).strict(),
]);

/**
 * Enables only the explicit development fixture identity. A disabled endpoint
 * is indistinguishable from an absent feature and never falls back to a client
 * supplied owner or network.
 */
export async function loadPersonalizationFixtureSession(
  fetchImpl: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<WalletSessionStatus | undefined> {
  const request = async (method: "GET" | "POST") => fetchImpl(
    "/api/dev/personalization-session",
    {
      method,
      headers: { accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
      signal,
    },
  );
  let response = await request("GET");
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error("Pilot's personalization fixture session is unavailable.");
  let parsed = FixtureSessionSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new Error("Pilot returned an invalid personalization fixture session.");
  if (!parsed.data.authenticated) {
    response = await request("POST");
    if (!response.ok) throw new Error("Pilot could not create the personalization fixture session.");
    parsed = FixtureSessionSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success || !parsed.data.authenticated) {
      throw new Error("Pilot did not confirm the personalization fixture session.");
    }
  }
  return {
    authenticated: true,
    account: parsed.data.account,
    network: parsed.data.network,
    expiresAt: parsed.data.expiresAt,
  };
}

export function resolveMemoryReadiness(
  config: PublicPilotConfig | null | undefined,
  session: WalletSessionStatus | null | undefined,
  now = Date.now(),
  personalizationFixtureEnabled = false,
): MemoryReadiness {
  if (config === undefined || session === undefined) return { kind: "checking" };
  if (config === null) return { kind: "configuration-error" };
  if (config.mockMode) {
    if (
      personalizationFixtureEnabled &&
      session?.authenticated &&
      session.network === config.network &&
      (session.expiresAt === undefined || session.expiresAt > now)
    ) {
      return {
        kind: "personalization-fixture",
        owner: session.account,
        network: session.network,
      };
    }
    return { kind: "mock" };
  }
  if (session === null) return { kind: "session-error" };
  if (!session.authenticated) return { kind: "no-session" };
  if (session.expiresAt !== undefined && session.expiresAt <= now) {
    return { kind: "session-expired" };
  }
  if (session.network !== config.network) {
    return {
      kind: "network-mismatch",
      configuredNetwork: config.network,
      sessionNetwork: session.network,
    };
  }
  return { kind: "live", owner: session.account, network: session.network };
}

export function memorySessionExpiryDelay(
  session: WalletSessionStatus | null | undefined,
  now = Date.now(),
): number | undefined {
  if (
    !session?.authenticated ||
    !Number.isSafeInteger(session.expiresAt) ||
    (session.expiresAt ?? 0) < 1
  ) return undefined;
  return Math.max(0, session.expiresAt! - now);
}

export const MEMORY_IDENTITY_REVALIDATION_MS = 30_000;

export function registerMemoryIdentityRefresh({
  onInvalidate,
  windowTarget,
  documentTarget,
  setIntervalImpl,
  clearIntervalImpl,
  intervalMilliseconds = MEMORY_IDENTITY_REVALIDATION_MS,
}: {
  onInvalidate: () => void;
  windowTarget: EventTarget;
  documentTarget: EventTarget & { visibilityState: DocumentVisibilityState };
  setIntervalImpl: (callback: () => void, milliseconds: number) => number;
  clearIntervalImpl: (handle: number) => void;
  intervalMilliseconds?: number;
}): () => void {
  const refreshWhenVisible = () => {
    if (documentTarget.visibilityState === "visible") onInvalidate();
  };
  windowTarget.addEventListener("focus", onInvalidate);
  windowTarget.addEventListener(WALLET_SESSION_CHANGED_EVENT, onInvalidate);
  documentTarget.addEventListener("visibilitychange", refreshWhenVisible);
  const interval = setIntervalImpl(refreshWhenVisible, intervalMilliseconds);
  return () => {
    clearIntervalImpl(interval);
    windowTarget.removeEventListener("focus", onInvalidate);
    windowTarget.removeEventListener(WALLET_SESSION_CHANGED_EVENT, onInvalidate);
    documentTarget.removeEventListener("visibilitychange", refreshWhenVisible);
  };
}

function abortError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
}

export async function fetchLiveMemorySnapshot(
  harbor: Pick<HarborClient, "op">,
  context: { owner: string; network: "testnet" | "devnet" },
  fetchImpl: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<MemorySnapshot> {
  let vaultResponse: Response;
  try {
    vaultResponse = await fetchImpl("/api/vault/snapshot", {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
      signal,
    });
  } catch (cause) {
    if (abortError(cause)) throw cause;
    throw new Error("Pilot's authenticated vault snapshot is unavailable.");
  }
  const vaultPayload = await vaultResponse.json().catch(() => undefined);
  if (!vaultResponse.ok) {
    throw new Error("Pilot's authenticated vault snapshot is unavailable.");
  }
  const vault = VaultSnapshotSchema.safeParse(vaultPayload);
  if (!vault.success) {
    throw new Error("Pilot's authenticated vault snapshot is invalid.");
  }
  if (vault.data.data.owner !== context.owner || vault.data.data.network !== context.network) {
    throw new Error("Pilot's vault snapshot does not match the authenticated wallet session.");
  }

  const policyEnvelope = await harbor.op("policy.get", context);
  if (!policyEnvelope.ok) {
    throw new Error(policyEnvelope.error.message || "Harbor policy.get did not return data.");
  }
  const graph = buildLiveMemoryGraph(vault.data.data.notes);
  return {
    mode: "live",
    owner: context.owner,
    network: context.network,
    generatedAt: vault.data.data.generatedAt,
    policy: PolicySchema.parse(policyEnvelope.data),
    ...graph,
  };
}
