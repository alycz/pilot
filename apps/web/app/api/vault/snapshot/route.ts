import { parseProfileNote } from "@pilot/vault";

import { readWalletSession } from "../../../../lib/wallet-session";
import { getVaultService } from "../_lib/service";

export const runtime = "nodejs";

const MAX_NOTES = 256;
const MAX_SNAPSHOT_BYTES = 1_048_576;

function isSafeScopedNotePath(path: string, scopePrefix: string): boolean {
  return path.startsWith(`${scopePrefix}/`) &&
    path.slice(scopePrefix.length + 1).length > 0 &&
    path.endsWith(".md") &&
    !path.includes("..") &&
    !path.includes("\\") &&
    !path.includes("\0");
}

function scopePrefix(account: string, network: "testnet" | "devnet"): string {
  if (!/^[A-Za-z0-9]+$/.test(account)) {
    throw new Error("Wallet session account cannot be used as a vault scope");
  }
  return `Pilot/Scopes/${network}/${account}`;
}

function logicalPath(path: string, prefix: string): string {
  return `Pilot/${path.slice(prefix.length + 1)}`;
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json(
    { ok: false, error: { code, message } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export async function GET(request: Request): Promise<Response> {
  let session;
  try {
    session = readWalletSession(request);
  } catch {
    return errorResponse(503, "VAULT_SESSION_UNAVAILABLE", "Wallet session status is unavailable.");
  }
  if (!session) {
    return errorResponse(401, "VAULT_SESSION_REQUIRED", "A wallet-bound session is required.");
  }

  try {
    const vault = getVaultService();
    const prefix = scopePrefix(session.account, session.network);
    const snapshot = await vault.openReadSnapshot({
      prefix,
      maxEntries: MAX_NOTES + 1,
      maxScannedEntries: 1_024,
      suffix: ".md",
    });
    const entries = (await snapshot.list(prefix))
      .filter((entry) => isSafeScopedNotePath(entry.path, prefix))
      .sort((left, right) => left.path.localeCompare(right.path));
    if (entries.length > MAX_NOTES) {
      return errorResponse(503, "VAULT_SNAPSHOT_TOO_LARGE", "The wallet-scoped vault snapshot is too large.");
    }

    const seen = new Set<string>();
    let declaredBytes = 0;
    for (const entry of entries) {
      if (
        seen.has(entry.path) ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0
      ) {
        throw new Error("Vault snapshot metadata is invalid");
      }
      seen.add(entry.path);
      declaredBytes += Buffer.byteLength(logicalPath(entry.path, prefix), "utf8") + entry.size;
      if (!Number.isSafeInteger(declaredBytes) || declaredBytes > MAX_SNAPSHOT_BYTES) {
        return errorResponse(503, "VAULT_SNAPSHOT_TOO_LARGE", "The wallet-scoped vault snapshot is too large.");
      }
    }

    const profilePath = `${prefix}/Profile.md`;
    const profileEntry = entries.find((entry) => entry.path === profilePath);
    if (!profileEntry) {
      // Legacy global notes are deliberately not treated as belonging to the
      // current wallet. A scoped profile must already exist in this namespace.
      return errorResponse(404, "VAULT_PROFILE_NOT_FOUND", "The wallet-scoped vault profile is unavailable.");
    }
    const profileLogicalPath = logicalPath(profilePath, prefix);
    const profilePathBytes = Buffer.byteLength(profileLogicalPath, "utf8");
    const profileContent = await snapshot.read(profilePath, MAX_SNAPSHOT_BYTES - profilePathBytes);
    if (!profileContent) {
      return errorResponse(404, "VAULT_PROFILE_NOT_FOUND", "The wallet-scoped vault profile is unavailable.");
    }
    const profile = parseProfileNote(profileContent);
    if (
      profile.budget_account !== session.account ||
      profile.network !== session.network
    ) {
      return errorResponse(403, "VAULT_SCOPE_MISMATCH", "The vault profile does not match this wallet session.");
    }

    const notes = [{ path: profileLogicalPath, content: profileContent }];
    let snapshotBytes = profilePathBytes + Buffer.byteLength(profileContent, "utf8");
    if (snapshotBytes > MAX_SNAPSHOT_BYTES) {
      return errorResponse(503, "VAULT_SNAPSHOT_TOO_LARGE", "The wallet-scoped vault snapshot is too large.");
    }
    for (const entry of entries) {
      if (entry.path === profilePath) continue;
      const path = logicalPath(entry.path, prefix);
      const pathBytes = Buffer.byteLength(path, "utf8");
      const remaining = MAX_SNAPSHOT_BYTES - snapshotBytes - pathBytes;
      if (remaining < 0) {
        return errorResponse(503, "VAULT_SNAPSHOT_TOO_LARGE", "The wallet-scoped vault snapshot is too large.");
      }
      // Sequential bounded reads ensure an understated metadata size cannot
      // fan out into concurrent large allocations or fetches.
      const content = await snapshot.read(entry.path, remaining);
      if (content === null) throw new Error("Vault snapshot changed during a pinned read");
      const contentBytes = Buffer.byteLength(content, "utf8");
      if (contentBytes > remaining) {
        return errorResponse(503, "VAULT_SNAPSHOT_TOO_LARGE", "The wallet-scoped vault snapshot is too large.");
      }
      snapshotBytes += pathBytes + contentBytes;
      notes.push({ path, content });
    }
    notes.sort((left, right) => left.path.localeCompare(right.path));

    return Response.json(
      {
        ok: true,
        data: {
          owner: session.account,
          network: session.network,
          generatedAt: new Date().toISOString(),
          notes,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return errorResponse(503, "VAULT_SNAPSHOT_UNAVAILABLE", "The wallet-scoped vault snapshot is unavailable.");
  }
}
