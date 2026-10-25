export type RememberedContextNetwork = "testnet" | "devnet";

export type RememberedContextState =
  | { kind: "checking" }
  | { kind: "signed-out" }
  | { kind: "unavailable"; reason?: string }
  | {
      kind: "ready";
      owner: string;
      network: RememberedContextNetwork;
      /** Display-only. Model choice is deliberately excluded from wallet scope. */
      modelId?: string;
    };

export type RememberedContextScope = Readonly<{
  owner: string;
  network: RememberedContextNetwork;
  scopeKey: string;
}>;

export const REMEMBERED_CONTEXT_BOUNDARY = Object.freeze({
  title: "What Pilot remembers",
  persistence:
    "Accepted memory stays with this wallet and network when you switch models.",
  authority:
    "Memory can shape explanations and workflow only. It cannot expand permissions, spending limits, risk limits, signing, approvals, or execution policy.",
});

/**
 * Adapt the presentation state to the scope already used by the reviewed
 * preference and workflow-lesson APIs. Model identity is intentionally not a
 * scoping input: changing models must not fork or discard accepted memory.
 */
export function rememberedContextScope(
  state: RememberedContextState,
): RememberedContextScope | undefined {
  if (state.kind !== "ready") return undefined;
  return Object.freeze({
    owner: state.owner,
    network: state.network,
    scopeKey: `${state.network}:${state.owner}`,
  });
}

export function abbreviatedRememberedOwner(owner: string): string {
  if (owner.length <= 15) return owner;
  return `${owner.slice(0, 8)}…${owner.slice(-5)}`;
}
