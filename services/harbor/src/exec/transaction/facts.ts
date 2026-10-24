import type { Network } from "../../contracts";

export type IssuedPolicyAsset = { currency: string; issuer: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Collect issued assets in encounter order from an unsigned transaction.
 * Native XRP amounts and incomplete issue-like objects are intentionally ignored.
 */
export function collectIssuedPolicyAssets(value: unknown): IssuedPolicyAsset[] {
  const found = new Map<string, IssuedPolicyAsset>();
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (!isRecord(candidate)) return;
    if (
      typeof candidate.currency === "string" &&
      typeof candidate.issuer === "string"
    ) {
      const asset = {
        currency: candidate.currency,
        issuer: candidate.issuer,
      };
      found.set(`${asset.currency}\u0000${asset.issuer}`, asset);
    }
    for (const child of Object.values(candidate)) visit(child);
  };
  visit(value);
  return [...found.values()];
}

/** Resolve the configured stable issue, falling back only on Testnet. */
export function configuredStablePolicyAsset(
  environment: Readonly<Record<string, unknown>> | undefined,
  network: Network,
  testnetFallback: IssuedPolicyAsset,
): IssuedPolicyAsset | undefined {
  const suffix = network.toUpperCase().replaceAll("-", "_");
  const code = environment?.STABLE_CODE;
  const issuer = environment?.[`STABLE_ISSUER_${suffix}`];
  if (typeof code === "string" && typeof issuer === "string") {
    return { currency: code, issuer };
  }
  return network === "testnet" ? { ...testnetFallback } : undefined;
}
