import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  FsVaultBackend,
  parseProfileNote,
  VaultService,
  writeProfileNote,
  type VaultReadEntry,
} from "@pilot/vault";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { sealWalletSession, WALLET_SESSION_COOKIE } from "../../../../lib/wallet-session";
import { GET } from "./route";
import { getVaultService } from "../_lib/service";

vi.mock("../_lib/service", () => ({ getVaultService: vi.fn() }));

const SECRET = "vault-snapshot-test-secret-that-is-long-enough";
const OWNER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const OTHER_OWNER = "r3vi7mWxru9rJCxETCyA1CHvzL96eZWx5z";

function request(account = OWNER, network: "testnet" | "devnet" = "testnet"): Request {
  const cookie = sealWalletSession({ version: 1, account, network, expiresAt: Date.now() + 60_000 }, SECRET);
  return new Request("https://pilot.example/api/vault/snapshot", {
    headers: { cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(cookie)}` },
  });
}

function profile(account = OWNER, network: "testnet" | "devnet" = "testnet"): string {
  return writeProfileNote({
    main_account: account,
    budget_account: account,
    network,
    risk: "low",
    preferences: [],
  }).content;
}

function prefix(account = OWNER, network: "testnet" | "devnet" = "testnet"): string {
  return `Pilot/Scopes/${network}/${account}`;
}

function mockSnapshot(contents: Map<string, string>, sizes = new Map<string, number>()) {
  const read = vi.fn((path: string, _maxBytes: number) => Promise.resolve(contents.get(path) ?? null));
  const list = vi.fn((scope = "") => Promise.resolve(
    [...contents.keys()]
      .filter((path) => path === scope || path.startsWith(`${scope}/`))
      .map((path): VaultReadEntry => ({
        path,
        size: sizes.get(path) ?? Buffer.byteLength(contents.get(path)!, "utf8"),
      })),
  ));
  vi.mocked(getVaultService).mockReturnValue({
    openReadSnapshot: vi.fn().mockResolvedValue({ revision: "revision-1", list, read }),
  } as never);
  return { list, read };
}

describe("wallet-scoped vault snapshot", () => {
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    vi.mocked(getVaultService).mockReset();
  });

  it("requires a sealed wallet session before reading the vault", async () => {
    const response = await GET(new Request("https://pilot.example/api/vault/snapshot"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "VAULT_SESSION_REQUIRED", message: "A wallet-bound session is required." },
    });
    expect(getVaultService).not.toHaveBeenCalled();
  });

  it.each([
    [OTHER_OWNER, "testnet"],
    [OWNER, "devnet"],
  ] as const)("refuses a scoped profile whose contents do not match the wallet", async (account, network) => {
    const scope = prefix();
    mockSnapshot(new Map([[`${scope}/Profile.md`, profile(account, network)]]));
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "VAULT_SCOPE_MISMATCH" } });
  });

  it("returns only notes from the exact owner and network namespace", async () => {
    const ownerScope = prefix();
    const otherOwnerScope = prefix(OTHER_OWNER);
    const devnetScope = prefix(OWNER, "devnet");
    const contents = new Map<string, string>([
      [`${ownerScope}/Profile.md`, profile()],
      [`${ownerScope}/Policy.md`, "---\nmax_per_tx_usd: 2000\n---\n"],
      [`${ownerScope}/Trades/ABC.md`, "# Trade\n"],
      [`${ownerScope}/Tokens/ignore.json`, "{}"],
      [`${otherOwnerScope}/Profile.md`, profile(OTHER_OWNER)],
      [`${otherOwnerScope}/Private.md`, "# Other owner\n"],
      [`${devnetScope}/Profile.md`, profile(OWNER, "devnet")],
      [`${devnetScope}/Private.md`, "# Other network\n"],
      ["Pilot/Profile.md", profile()],
      ["Pilot/Legacy.md", "# Unbound legacy note\n"],
    ]);
    const { list } = mockSnapshot(contents);
    const response = await GET(request());
    const payload = await response.json() as Record<string, any>;
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith(ownerScope);
    expect(payload.data.owner).toBe(OWNER);
    expect(payload.data.network).toBe("testnet");
    expect(payload.data.notes).toEqual([
      { path: "Pilot/Policy.md", content: contents.get(`${ownerScope}/Policy.md`) },
      { path: "Pilot/Profile.md", content: contents.get(`${ownerScope}/Profile.md`) },
      { path: "Pilot/Trades/ABC.md", content: contents.get(`${ownerScope}/Trades/ABC.md`) },
    ]);
    expect(parseProfileNote(payload.data.notes[1].content).budget_account).toBe(OWNER);
  });

  it("does not expose owner A notes after the session changes to owner B", async () => {
    const ownerAScope = prefix();
    const ownerBScope = prefix(OTHER_OWNER);
    const contents = new Map<string, string>([
      [`${ownerAScope}/Profile.md`, profile()],
      [`${ownerAScope}/OnlyA.md`, "# Owner A private note\n"],
      [`${ownerBScope}/Profile.md`, profile(OTHER_OWNER)],
      [`${ownerBScope}/OnlyB.md`, "# Owner B private note\n"],
    ]);
    mockSnapshot(contents);

    const ownerAResponse = await GET(request());
    const ownerBResponse = await GET(request(OTHER_OWNER));
    const ownerAPayload = await ownerAResponse.json() as Record<string, any>;
    const ownerBPayload = await ownerBResponse.json() as Record<string, any>;

    expect(ownerAPayload.data.notes.map((note: { path: string }) => note.path)).toContain("Pilot/OnlyA.md");
    expect(ownerBPayload.data.notes.map((note: { path: string }) => note.path)).toEqual([
      "Pilot/OnlyB.md",
      "Pilot/Profile.md",
    ]);
    expect(JSON.stringify(ownerBPayload)).not.toContain("Owner A private note");
  });

  it("returns a newly written scoped validated transaction end to end", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pilot-scoped-snapshot-"));
    try {
      const vault = new VaultService(new FsVaultBackend(root));
      await vault.recordScopedValidatedTransaction(
        { owner: OWNER, network: "testnet", mainAccount: OWNER },
        {
          intent: {
            id: "snapshot-write-intent",
            network: "testnet",
            kind: "cancel",
            offer_sequence: 11,
          },
          hash: "ENDTOENDHASH",
          venue: "xrpl-dex-clob",
          assets: [],
          result: "success",
          fillPrice: "unavailable",
          slippageBps: 0,
          signedBy: "delegate",
          created: "2026-10-19T12:00:00.000Z",
        },
      );
      vi.mocked(getVaultService).mockReturnValue(vault);

      const response = await GET(request());
      const payload = await response.json() as Record<string, any>;

      expect(response.status).toBe(200);
      expect(payload.data.notes).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "Pilot/Profile.md" }),
        expect.objectContaining({ path: "Pilot/Trades/ENDTOENDHASH.md" }),
        expect.objectContaining({ path: "Pilot/Reflections/ENDTOENDHASH.md" }),
      ]));
      expect(JSON.stringify(payload)).toContain("snapshot-write-intent");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("switches namespaces when the network changes", async () => {
    const testnetScope = prefix();
    const devnetScope = prefix(OWNER, "devnet");
    const contents = new Map<string, string>([
      [`${testnetScope}/Profile.md`, profile()],
      [`${testnetScope}/OnlyTestnet.md`, "# Testnet\n"],
      [`${devnetScope}/Profile.md`, profile(OWNER, "devnet")],
      [`${devnetScope}/OnlyDevnet.md`, "# Devnet\n"],
    ]);
    const { list } = mockSnapshot(contents);
    const response = await GET(request(OWNER, "devnet"));
    const payload = await response.json() as Record<string, any>;
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith(devnetScope);
    expect(payload.data.notes.map((note: { path: string }) => note.path)).toEqual([
      "Pilot/OnlyDevnet.md",
      "Pilot/Profile.md",
    ]);
  });

  it("fails closed when only legacy unbound notes exist", async () => {
    const { read } = mockSnapshot(new Map([
      ["Pilot/Profile.md", profile()],
      ["Pilot/Journal/legacy.md", "# Legacy\n"],
    ]));
    const response = await GET(request());
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "VAULT_PROFILE_NOT_FOUND" } });
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects oversized metadata before fetching a blob", async () => {
    const scope = prefix();
    const contents = new Map([
      [`${scope}/Profile.md`, profile()],
      [`${scope}/Journal/large.md`, "small forged body"],
    ]);
    const { read } = mockSnapshot(contents, new Map([[`${scope}/Journal/large.md`, 1_048_577]]));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "VAULT_SNAPSHOT_TOO_LARGE" } });
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects more than 256 scoped notes before fetching a blob", async () => {
    const scope = prefix();
    const contents = new Map<string, string>([[`${scope}/Profile.md`, profile()]]);
    for (let index = 0; index < 256; index += 1) {
      contents.set(`${scope}/Journal/${String(index).padStart(3, "0")}.md`, "");
    }
    const { read } = mockSnapshot(contents);

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "VAULT_SNAPSHOT_TOO_LARGE" } });
    expect(read).not.toHaveBeenCalled();
  });

  it("counts UTF-8 bytes and stops sequential reads on understated cumulative overflow", async () => {
    const scope = prefix();
    const first = `${scope}/A.md`;
    const neverFetched = `${scope}/B.md`;
    const contents = new Map([
      [`${scope}/Profile.md`, profile()],
      [first, "é".repeat(525_000)],
      [neverFetched, "# must not fetch\n"],
    ]);
    const { read } = mockSnapshot(contents, new Map([[first, 1], [neverFetched, 1]]));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "VAULT_SNAPSHOT_TOO_LARGE" } });
    expect(read.mock.calls.map(([path]) => path)).toEqual([`${scope}/Profile.md`, first]);
    expect(read).not.toHaveBeenCalledWith(neverFetched, expect.anything());
  });

  it("sanitizes vault backend failures", async () => {
    vi.mocked(getVaultService).mockReturnValue({
      openReadSnapshot: vi.fn().mockRejectedValue(new Error("backend token must not escape")),
    } as never);
    const response = await GET(request());
    const body = JSON.stringify(await response.json());
    expect(response.status).toBe(503);
    expect(body).toContain("VAULT_SNAPSHOT_UNAVAILABLE");
    expect(body).not.toContain("backend token");
  });
});
