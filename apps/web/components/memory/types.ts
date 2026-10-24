import type { Network, Policy } from "@pilot/contracts";

export type MemoryNoteKind =
  | "profile"
  | "policy"
  | "journal"
  | "trade"
  | "venue"
  | "token"
  | "reflection";

export type MemoryNote = {
  id: string;
  path: string;
  title: string;
  kind: MemoryNoteKind;
  summary: string;
  body: string[];
  links: string[];
  tags: string[];
  updatedAt?: string;
  network?: Network;
};

export type MemoryGraphNode = {
  id: string;
  noteId: string;
  label: string;
  kind: MemoryNoteKind;
  x: number;
  y: number;
};

export type MemoryGraphEdge = {
  from: string;
  to: string;
};

export type MemorySnapshot = {
  mode: "live";
  owner: string;
  network: Extract<Network, "testnet" | "devnet">;
  generatedAt: string;
  notes: MemoryNote[];
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  policy: Policy;
};

export type PolicyDraft = {
  max_per_tx_usd: string;
  daily_cap_usd: string;
  execute_under_usd: string;
  max_slippage_bps: string;
  allowed_tx_types: string[];
  issuer_allowlist: string;
  block_requireauth_issuers: boolean;
  networks: Network[];
  x402_max_per_call_drops: string;
  x402_daily_cap_drops: string;
};

export type PolicyValidation =
  | { ok: true; policy: Policy }
  | { ok: false; errors: Partial<Record<keyof PolicyDraft, string>> };
