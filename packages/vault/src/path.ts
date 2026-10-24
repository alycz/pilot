import path from "node:path";

/** Normalize a user-facing vault path without allowing access outside the vault. */
export function normalizeVaultPath(value: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error("Vault path must be a string without null bytes");
  }

  const unix = value.replaceAll("\\", "/").trim();
  if (!unix || unix.startsWith("/") || /^[A-Za-z]:\//.test(unix)) {
    throw new Error("Vault path must be relative");
  }

  const normalized = path.posix.normalize(unix);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error("Vault path cannot leave the vault root");
  }
  return normalized.replace(/^\.\//, "");
}

export function safeNoteName(value: string, label = "note name"): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || /[\\/:\0]/.test(trimmed)) {
    throw new Error(`Invalid ${label}`);
  }
  return trimmed;
}
