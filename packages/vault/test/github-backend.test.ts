import { describe, expect, it } from "vitest";

import {
  GitHubVaultBackend,
  type GitHubRequester,
} from "../src/backends/github";

type Call = { route: string; params: Record<string, unknown> };

class ExistingRepositoryClient implements GitHubRequester {
  readonly calls: Call[] = [];

  async request(route: string, params: Record<string, unknown>): Promise<{ data: unknown }> {
    this.calls.push({ route, params });
    switch (route) {
      case "GET /repos/{owner}/{repo}/git/ref/{ref}":
        return { data: { object: { sha: "commit-1" } } };
      case "GET /repos/{owner}/{repo}/git/commits/{commit_sha}":
        return { data: { tree: { sha: "tree-1" } } };
      case "GET /repos/{owner}/{repo}/git/trees/{tree_sha}":
        return {
          data: {
            tree: [
              { type: "blob", path: "Pilot/Profile.md", sha: "blob-profile" },
              { type: "blob", path: "Pilot/Tokens/XRP.md", sha: "blob-xrp" },
            ],
          },
        };
      case "GET /repos/{owner}/{repo}/git/blobs/{file_sha}":
        return {
          data: {
            encoding: "base64",
            content: Buffer.from("# XRP\n", "utf8").toString("base64"),
          },
        };
      case "POST /repos/{owner}/{repo}/git/blobs":
        return { data: { sha: "blob-new" } };
      case "POST /repos/{owner}/{repo}/git/trees":
        return { data: { sha: "tree-new" } };
      case "POST /repos/{owner}/{repo}/git/commits":
        return { data: { sha: "commit-new" } };
      case "PATCH /repos/{owner}/{repo}/git/refs/{ref}":
        return { data: { ref: "refs/heads/main" } };
      default:
        throw new Error(`Unexpected route: ${route}`);
    }
  }
}

describe("GitHubVaultBackend", () => {
  it("reads and lists notes through Git data without network access", async () => {
    const client = new ExistingRepositoryClient();
    const backend = new GitHubVaultBackend({ repository: "owner/vault", client });
    expect(await backend.list("Pilot/Tokens")).toEqual(["Pilot/Tokens/XRP.md"]);
    expect(await backend.read("Pilot/Tokens/XRP.md")).toBe("# XRP\n");
    expect(await backend.read("Pilot/Tokens/MISSING.md")).toBeNull();
  });

  it("creates one commit and advances the branch once for each write", async () => {
    const client = new ExistingRepositoryClient();
    const backend = new GitHubVaultBackend({ repository: "owner/vault", client });
    await backend.write("Pilot/Profile.md", "# Profile\n", "Update profile");

    expect(
      client.calls.filter((call) => call.route === "POST /repos/{owner}/{repo}/git/commits"),
    ).toHaveLength(1);
    expect(
      client.calls.filter((call) => call.route === "PATCH /repos/{owner}/{repo}/git/refs/{ref}"),
    ).toHaveLength(1);
    const treeCall = client.calls.find(
      (call) => call.route === "POST /repos/{owner}/{repo}/git/trees",
    );
    expect(treeCall?.params).toMatchObject({
      base_tree: "tree-1",
      tree: [{ path: "Pilot/Profile.md", mode: "100644", type: "blob", sha: "blob-new" }],
    });
  });

  it("creates a root commit for an empty repository", async () => {
    const calls: Call[] = [];
    const client: GitHubRequester = {
      async request(route, params) {
        calls.push({ route, params });
        if (route.startsWith("GET ")) throw Object.assign(new Error("empty"), { status: 409 });
        if (route === "PUT /repos/{owner}/{repo}/contents/{path}") {
          return { data: { commit: { sha: "commit-1" } } };
        }
        throw new Error(`Unexpected route: ${route}`);
      },
    };
    const backend = new GitHubVaultBackend({ repository: "owner/vault", client });
    await backend.write("Pilot/Profile.md", "# Profile\n");
    expect(calls.filter((call) => call.route === "PUT /repos/{owner}/{repo}/contents/{path}"))
      .toHaveLength(1);
    expect(calls.at(-1)).toMatchObject({
      route: "PUT /repos/{owner}/{repo}/contents/{path}",
      params: { path: "Pilot/Profile.md", message: "vault: update Pilot/Profile.md" },
    });
  });

  it("rejects traversal before any GitHub request", async () => {
    const client = new ExistingRepositoryClient();
    const backend = new GitHubVaultBackend({ repository: "owner/vault", client });
    await expect(backend.write("../outside.md", "nope")).rejects.toThrow(/cannot leave/i);
    expect(client.calls).toEqual([]);
  });

  it("pins list and blob reads to one tree when the branch head advances", async () => {
    const calls: Call[] = [];
    let refReads = 0;
    const client: GitHubRequester = {
      async request(route, params) {
        calls.push({ route, params });
        if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
          refReads += 1;
          return { data: { object: { sha: refReads === 1 ? "commit-1" : "commit-2" } } };
        }
        if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") {
          return { data: { tree: { sha: params.commit_sha === "commit-1" ? "tree-1" : "tree-2" } } };
        }
        if (route === "GET /repos/{owner}/{repo}/git/trees/{tree_sha}") {
          return { data: { tree: [
            { type: "blob", path: "Pilot/Scopes/testnet/rOwner/Profile.md", sha: "blob-1", size: 10 },
          ] } };
        }
        if (route === "GET /repos/{owner}/{repo}/git/blobs/{file_sha}") {
          return { data: { encoding: "base64", size: 10, content: Buffer.from("1234567890").toString("base64") } };
        }
        throw new Error(`Unexpected route: ${route}`);
      },
    };
    const backend = new GitHubVaultBackend({ repository: "owner/vault", client });
    const snapshot = await backend.openReadSnapshot();

    expect(snapshot.revision).toBe("commit-1");
    expect(await snapshot.list("Pilot/Scopes/testnet/rOwner")).toEqual([
      { path: "Pilot/Scopes/testnet/rOwner/Profile.md", size: 10 },
    ]);
    expect(await snapshot.read("Pilot/Scopes/testnet/rOwner/Profile.md", 10)).toBe("1234567890");
    expect(refReads).toBe(1);
    expect(calls.find((call) => call.route.includes("git/trees"))?.params.tree_sha).toBe("tree-1");
    expect(calls.find((call) => call.route.includes("git/blobs"))?.params.file_sha).toBe("blob-1");
  });

  it("rejects oversized encoded content before decode when upstream metadata is understated", async () => {
    const client: GitHubRequester = {
      async request(route) {
        if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
          return { data: { object: { sha: "commit-1" } } };
        }
        if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") {
          return { data: { tree: { sha: "tree-1" } } };
        }
        if (route === "GET /repos/{owner}/{repo}/git/trees/{tree_sha}") {
          return { data: { tree: [
            { type: "blob", path: "Pilot/Scopes/testnet/rOwner/Profile.md", sha: "blob-1", size: 1 },
          ] } };
        }
        if (route === "GET /repos/{owner}/{repo}/git/blobs/{file_sha}") {
          return {
            data: {
              encoding: "base64",
              size: 1,
              content: Buffer.from("x".repeat(128), "utf8").toString("base64"),
            },
          };
        }
        throw new Error(`Unexpected route: ${route}`);
      },
    };
    const backend = new GitHubVaultBackend({ repository: "owner/vault", client });
    const snapshot = await backend.openReadSnapshot();

    await expect(snapshot.read("Pilot/Scopes/testnet/rOwner/Profile.md", 8))
      .rejects.toThrow(/oversized|exceeds/i);
  });

  it("traverses only the requested owner subtree and stops at the backend entry cap", async () => {
    const calls: Call[] = [];
    const owner = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
    const client: GitHubRequester = {
      async request(route, params) {
        calls.push({ route, params });
        if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
          return { data: { object: { sha: "commit-1" } } };
        }
        if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") {
          return { data: { tree: { sha: "root-tree" } } };
        }
        if (route !== "GET /repos/{owner}/{repo}/contents/{path}") {
          throw new Error(`Unexpected route: ${route}`);
        }
        const directories: Record<string, unknown[]> = {
          [`Pilot/Scopes/testnet/${owner}`]: [
            ...Array.from({ length: 4 }, (_, index) => ({
              type: "file",
              path: `Pilot/Scopes/testnet/${owner}/junk-${index}.json`,
              sha: `junk-${index}`,
              size: 2,
            })),
            ...Array.from({ length: 300 }, (_, index) => ({
              type: "file",
              path: `Pilot/Scopes/testnet/${owner}/note-${String(index).padStart(3, "0")}.md`,
              sha: `blob-${index}`,
              size: 1,
            })),
            { type: "dir", path: `Pilot/Scopes/testnet/${owner}/never-visited`, sha: "queued-tree" },
          ],
          [`Pilot/Scopes/testnet/${owner}/never-visited`]: [
            { type: "file", path: `Pilot/Scopes/testnet/${owner}/never-visited/later.md`, sha: "later", size: 1 },
          ],
        };
        return { data: directories[String(params.path)] ?? [] };
      },
    };
    const backend = new GitHubVaultBackend({ repository: "owner/vault", client });
    const prefix = `Pilot/Scopes/testnet/${owner}`;
    const snapshot = await backend.openReadSnapshot({ prefix, maxEntries: 3 });

    expect(await snapshot.list(prefix)).toHaveLength(3);
    const requestedPaths = calls
      .filter((call) => call.route === "GET /repos/{owner}/{repo}/contents/{path}")
      .map((call) => call.params.path);
    expect(requestedPaths).toEqual([prefix]);
    expect(calls.find((call) => call.route.includes("contents"))?.params.ref).toBe("commit-1");
    await expect(backend.openReadSnapshot({
      prefix,
      maxEntries: 3,
      maxScannedEntries: 3,
      suffix: ".md",
    })).rejects.toThrow(/scan limit/i);
  });
});
