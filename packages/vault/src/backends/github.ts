import { Buffer } from "node:buffer";

import { Octokit } from "octokit";

import { normalizeVaultPath } from "../path";
import { assertNoSensitiveContent } from "../security";
import type {
  VaultBackend,
  VaultReadEntry,
  VaultReadSnapshot,
  VaultReadSnapshotOptions,
} from "../types";

type GitHubResponse = { data: unknown };
export type GitHubRequester = {
  request(route: string, params: Record<string, unknown>): Promise<GitHubResponse>;
};

type Head = { commitSha: string; treeSha: string };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub returned an unexpected response");
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, field: string): string {
  const result = record(value)[field];
  if (typeof result !== "string" || !result) {
    throw new Error(`GitHub response is missing ${field}`);
  }
  return result;
}

function statusOf(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
}

function exactBlobSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("GitHub response is missing a valid blob size");
  }
  return value;
}

function decodeBoundedBase64(value: unknown, maxBytes: number): string {
  if (typeof value !== "string") throw new Error("GitHub response is missing content");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("Vault bounded read limit is invalid");
  }
  const maxEncodedLength = 4 * Math.ceil(maxBytes / 3);
  // GitHub wraps base64 at 60 characters. Bound the transport string before
  // removing line breaks so forged metadata cannot cause a large decode.
  const maxTransportLength = maxEncodedLength + Math.ceil(maxEncodedLength / 60) + 2;
  if (value.length > maxTransportLength) {
    throw new Error("Vault blob exceeds the bounded read limit");
  }
  const encoded = value.replaceAll("\n", "");
  if (encoded.length > maxEncodedLength || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error("GitHub returned invalid or oversized base64 content");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength > maxBytes) {
    throw new Error("Vault blob exceeds the bounded read limit");
  }
  return bytes.toString("utf8");
}

export type GitHubVaultBackendOptions = {
  repository: string;
  token?: string;
  branch?: string;
  client?: GitHubRequester;
};

export class GitHubVaultBackend implements VaultBackend {
  private readonly owner: string;
  private readonly repo: string;
  private readonly branch: string;
  private readonly client: GitHubRequester;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: GitHubVaultBackendOptions) {
    const parts = options.repository.split("/");
    if (parts.length !== 2 || parts.some((part) => !part.trim())) {
      throw new Error("VAULT_REPO must use the owner/repository form");
    }
    this.owner = parts[0]!;
    this.repo = parts[1]!;
    this.branch = options.branch?.trim() || "main";
    this.client = options.client ?? new Octokit({ auth: options.token });
  }

  private params(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { owner: this.owner, repo: this.repo, ...extra };
  }

  private async head(): Promise<Head | null> {
    let reference: GitHubResponse;
    try {
      reference = await this.client.request("GET /repos/{owner}/{repo}/git/ref/{ref}",
        this.params({ ref: `heads/${this.branch}` }),
      );
    } catch (error) {
      if (statusOf(error) === 404 || statusOf(error) === 409) return null;
      throw error;
    }
    const commitSha = stringField(record(reference.data).object, "sha");
    const commit = await this.client.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
      this.params({ commit_sha: commitSha }),
    );
    return { commitSha, treeSha: stringField(record(commit.data).tree, "sha") };
  }

  async list(prefix = ""): Promise<string[]> {
    const normalizedPrefix = prefix ? normalizeVaultPath(prefix) : "";
    const head = await this.head();
    if (!head) return [];
    const response = await this.client.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
      this.params({ tree_sha: head.treeSha, recursive: "1" }),
    );
    const entries = record(response.data).tree;
    if (!Array.isArray(entries)) throw new Error("GitHub response is missing tree entries");
    return entries
      .map(record)
      .filter((entry) => entry.type === "blob" && typeof entry.path === "string")
      .map((entry) => entry.path as string)
      .filter((path) => !normalizedPrefix || path === normalizedPrefix || path.startsWith(`${normalizedPrefix}/`))
      .sort();
  }

  async read(path: string): Promise<string | null> {
    const normalized = normalizeVaultPath(path);
    const head = await this.head();
    if (!head) return null;
    const treeResponse = await this.client.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
      this.params({ tree_sha: head.treeSha, recursive: "1" }),
    );
    const entries = record(treeResponse.data).tree;
    if (!Array.isArray(entries)) throw new Error("GitHub response is missing tree entries");
    const match = entries.map(record).find((entry) => entry.type === "blob" && entry.path === normalized);
    if (!match) return null;
    const blob = await this.client.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
      this.params({ file_sha: stringField(match, "sha") }),
    );
    const blobData = record(blob.data);
    if (blobData.encoding !== "base64") throw new Error("GitHub returned an unsupported blob encoding");
    const content = Buffer.from(
      stringField(blobData, "content").replaceAll("\n", ""),
      "base64",
    ).toString("utf8");
    assertNoSensitiveContent(content);
    return content;
  }

  async openReadSnapshot(options: VaultReadSnapshotOptions = {}): Promise<VaultReadSnapshot> {
    const head = await this.head();
    if (!head) {
      return {
        revision: null,
        list: async () => [],
        read: async () => null,
      };
    }

    const requestedPrefix = options.prefix ? normalizeVaultPath(options.prefix) : "";
    const maxEntries = options.maxEntries ?? Number.MAX_SAFE_INTEGER;
    const maxScannedEntries = options.maxScannedEntries ?? Number.MAX_SAFE_INTEGER;
    const suffix = options.suffix;
    if (
      !Number.isSafeInteger(maxEntries) || maxEntries < 1 ||
      !Number.isSafeInteger(maxScannedEntries) || maxScannedEntries < maxEntries
    ) {
      throw new Error("Vault snapshot entry limit is invalid");
    }
    const entries = new Map<string, VaultReadEntry & { sha: string }>();

    const fetchTree = async (treeSha: string, recursive = false): Promise<Record<string, unknown>[]> => {
      const response = await this.client.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
        this.params({ tree_sha: treeSha, ...(recursive ? { recursive: "1" } : {}) }),
      );
      const treeData = record(response.data);
      if (treeData.truncated === true) throw new Error("GitHub returned a truncated vault tree");
      const tree = treeData.tree;
      if (!Array.isArray(tree)) throw new Error("GitHub response is missing tree entries");
      return tree.map(record);
    };

    if (!requestedPrefix) {
      const rawEntries = await fetchTree(head.treeSha, true);
      for (const entry of rawEntries) {
        if (entry.type !== "blob" || typeof entry.path !== "string") continue;
        if (suffix && !entry.path.endsWith(suffix)) continue;
        entries.set(entry.path, {
          path: entry.path,
          sha: stringField(entry, "sha"),
          size: exactBlobSize(entry.size),
        });
        if (entries.size >= maxEntries) break;
      }
    } else {
      // The Contents endpoint can address the exact owner directory at a
      // pinned commit. This avoids materializing the root or sibling-owner
      // trees merely to resolve the requested namespace.
      const pending = [requestedPrefix];
      let scannedEntries = 0;
      while (pending.length > 0 && entries.size < maxEntries) {
        const current = pending.shift()!;
        let response: GitHubResponse;
        try {
          response = await this.client.request("GET /repos/{owner}/{repo}/contents/{path}",
            this.params({ path: current, ref: head.commitSha }),
          );
        } catch (error) {
          if (statusOf(error) === 404 && current === requestedPrefix) break;
          throw error;
        }
        if (!Array.isArray(response.data)) {
          throw new Error("GitHub returned an unexpected scoped directory response");
        }
        const children = response.data.map(record);
        for (const child of children) {
          if (scannedEntries >= maxScannedEntries) {
            throw new Error("Vault snapshot metadata scan limit exceeded");
          }
          scannedEntries += 1;
          if (
            typeof child.path !== "string" ||
            !child.path.startsWith(`${current}/`) ||
            child.path.slice(current.length + 1).includes("/")
          ) {
            throw new Error("GitHub returned an invalid scoped tree entry");
          }
          if (child.type === "dir") {
            pending.push(child.path);
          } else if (child.type === "file") {
            if (suffix && !child.path.endsWith(suffix)) continue;
            entries.set(child.path, {
              path: child.path,
              sha: stringField(child, "sha"),
              size: exactBlobSize(child.size),
            });
            if (entries.size >= maxEntries) break;
          }
        }
        // GitHub's Contents API caps directory listings at 1,000 entries. If
        // the note cap has not already proved the snapshot too large, a full
        // page is ambiguous and must fail closed rather than omit entries.
        if (children.length >= 1_000 && entries.size < maxEntries) {
          throw new Error("GitHub scoped directory exceeds the reliable listing limit");
        }
      }
    }

    return {
      revision: head.commitSha,
      list: async (prefix = "") => {
        const normalized = prefix ? normalizeVaultPath(prefix) : "";
        return [...entries.values()]
          .filter((entry) => !normalized || entry.path === normalized || entry.path.startsWith(`${normalized}/`))
          .map(({ path, size }) => ({ path, size }))
          .sort((left, right) => left.path.localeCompare(right.path));
      },
      read: async (vaultPath, maxBytes) => {
        const normalized = normalizeVaultPath(vaultPath);
        const entry = entries.get(normalized);
        if (!entry) return null;
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || entry.size > maxBytes) {
          throw new Error("Vault blob exceeds the bounded read limit");
        }
        const blob = await this.client.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
          this.params({ file_sha: entry.sha }),
        );
        const blobData = record(blob.data);
        if (blobData.encoding !== "base64") throw new Error("GitHub returned an unsupported blob encoding");
        if (exactBlobSize(blobData.size) > maxBytes) {
          throw new Error("Vault blob exceeds the bounded read limit");
        }
        const content = decodeBoundedBase64(blobData.content, maxBytes);
        assertNoSensitiveContent(content);
        return content;
      },
    };
  }

  write(path: string, content: string, message?: string): Promise<void> {
    const operation = this.writeQueue.then(() => this.performWrite(path, content, message));
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  private async performWrite(path: string, content: string, message?: string): Promise<void> {
    const normalized = normalizeVaultPath(path);
    const commitMessage = message?.trim() || `vault: update ${normalized}`;
    assertNoSensitiveContent(`${normalized}\n${commitMessage}\n${content}`);
    const head = await this.head();
    if (!head) {
      // Git refs cannot be created in a completely empty GitHub repository.
      // The Contents API creates the initial branch and exactly one root commit.
      await this.client.request("PUT /repos/{owner}/{repo}/contents/{path}",
        this.params({
          path: normalized,
          message: commitMessage,
          content: Buffer.from(content, "utf8").toString("base64"),
        }),
      );
      return;
    }
    const blob = await this.client.request("POST /repos/{owner}/{repo}/git/blobs",
      this.params({ content: Buffer.from(content, "utf8").toString("base64"), encoding: "base64" }),
    );
    const tree = await this.client.request("POST /repos/{owner}/{repo}/git/trees",
      this.params({
        ...(head ? { base_tree: head.treeSha } : {}),
        tree: [{ path: normalized, mode: "100644", type: "blob", sha: stringField(blob.data, "sha") }],
      }),
    );
    const commit = await this.client.request("POST /repos/{owner}/{repo}/git/commits",
      this.params({
        message: commitMessage,
        tree: stringField(tree.data, "sha"),
        parents: head ? [head.commitSha] : [],
      }),
    );
    const commitSha = stringField(commit.data, "sha");
    if (head) {
      await this.client.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}",
        this.params({ ref: `heads/${this.branch}`, sha: commitSha, force: false }),
      );
    }
  }
}
