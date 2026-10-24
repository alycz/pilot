import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decode,
  deriveAddress,
  encodeForSigning,
  verifyKeypairSignature,
} from "xrpl";

interface MockAdapter {
  id: string;
  options: unknown;
  isAvailable: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  sign: ReturnType<typeof vi.fn>;
  signAndSubmit: ReturnType<typeof vi.fn>;
}

const connector = vi.hoisted(() => ({
  instances: [] as MockAdapter[],
}));

vi.mock("xrpl-connect", () => {
  const account = {
    address: "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY",
    network: {
      id: "testnet",
      name: "Testnet",
      wss: "wss://example.invalid",
    },
  };

  function makeAdapter(id: string, options?: unknown): MockAdapter {
    const adapter: MockAdapter = {
      id,
      options,
      isAvailable: vi.fn().mockResolvedValue(true),
      connect: vi.fn().mockImplementation(async (connectOptions?: {
        network?: string | { id: string; name: string; wss: string; rpc?: string };
      }) => {
        const requested = connectOptions?.network;
        return {
          ...account,
          network: typeof requested === "string"
            ? { ...account.network, id: requested, name: requested }
            : requested ?? account.network,
        };
      }),
      disconnect: vi.fn().mockResolvedValue(undefined),
      sign: vi.fn().mockResolvedValue({ hash: "HASH", tx_blob: "SIGNED_BLOB" }),
      signAndSubmit: vi.fn().mockResolvedValue({ hash: "SUBMITTED" }),
    };
    connector.instances.push(adapter);
    return adapter;
  }

  return {
    GemWalletAdapter: vi.fn(function () {
      return makeAdapter("gemwallet");
    }),
    CrossmarkAdapter: vi.fn(function () {
      return makeAdapter("crossmark");
    }),
    XamanAdapter: vi.fn(function (options?: unknown) {
      return makeAdapter("xaman", options);
    }),
    WalletErrorCode: {
      WALLET_NOT_FOUND: "WALLET_NOT_FOUND",
      WALLET_NOT_INSTALLED: "WALLET_NOT_INSTALLED",
      WALLET_NOT_AVAILABLE: "WALLET_NOT_AVAILABLE",
      CONNECTION_REJECTED: "CONNECTION_REJECTED",
      NETWORK_NOT_SUPPORTED: "NETWORK_NOT_SUPPORTED",
      NETWORK_MISMATCH: "NETWORK_MISMATCH",
      SIGN_REJECTED: "SIGN_REJECTED",
    },
  };
});

import {
  PilotWalletError,
  WALLET_PROVIDERS,
  createWallet,
} from "../src/index.js";

const CONNECTED_ADDRESS = "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY";
const DESTINATION = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

function tx(account = CONNECTED_ADDRESS): Record<string, unknown> {
  return {
    TransactionType: "Payment",
    Account: account,
    Destination: DESTINATION,
    Amount: "1",
    Fee: "12",
    Sequence: 1,
    LastLedgerSequence: 100,
  };
}

function latestAdapter(): MockAdapter {
  const adapter = connector.instances.at(-1);
  if (adapter === undefined) throw new Error("Expected a mock adapter instance");
  return adapter;
}

function expectCode(code: string) {
  return expect.objectContaining({ name: "PilotWalletError", code });
}

class MemorySessionStorage implements Storage {
  readonly values = new Map<string, string>();
  lengthReads = 0;
  readonly setItem = vi.fn((key: string, value: string) => {
    this.values.set(key, value);
  });
  readonly getItem = vi.fn((key: string) => this.values.get(key) ?? null);
  readonly removeItem = vi.fn((key: string) => {
    this.values.delete(key);
  });
  readonly clear = vi.fn(() => this.values.clear());
  readonly key = vi.fn((index: number): string | null =>
    [...this.values.keys()][index] ?? null
  );

  get length(): number {
    this.lengthReads += 1;
    return this.values.size;
  }
}

function setBrowserLocation(url: string): void {
  const parsed = new URL(url);
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: {
      origin: parsed.origin,
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
    },
  });
}

function lifecycleKey(network: "testnet" | "devnet"): string {
  return `pilot.wallet.dev.lifecycle.v1.${network}`;
}

function lifecycleMarker(
  account: string,
  network: "testnet" | "devnet",
  status: "owner_present" | "revoked",
  contextBinding = "00000000-0000-4000-8000-000000000000",
): string {
  return JSON.stringify({
    version: 1,
    account,
    context_binding: contextBinding,
    network,
    status,
  });
}

function parsedLifecycleMarker(raw: string | undefined): Record<string, unknown> {
  expect(raw).toBeTypeOf("string");
  return JSON.parse(raw!) as Record<string, unknown>;
}

interface TestWebLocksControl {
  request: ReturnType<typeof vi.fn>;
  forceRelease(name: string): void;
}

function installImmediateWebLocks(): TestWebLocksControl {
  const held = new Set<string>();
  const request = vi.fn(
    (
      name: string,
      _options: LockOptions,
      callback: (lock: Lock | null) => unknown,
    ) => Promise.resolve().then(async () => {
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({ name, mode: "exclusive" } as Lock);
      } finally {
        held.delete(name);
      }
    }),
  );
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: { request } },
  });
  return {
    request,
    forceRelease(name: string) {
      held.delete(name);
    },
  };
}

describe("xrpl-connect owner wallets", () => {
  beforeEach(() => {
    connector.instances.length = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("defaults to GemWallet on testnet", async () => {
    const wallet = createWallet();

    expect(wallet.provider).toBe("gemwallet");
    expect(wallet.network).toBe("testnet");
    expect(await wallet.connect()).toBe(CONNECTED_ADDRESS);
    expect(latestAdapter().id).toBe("gemwallet");
    expect(latestAdapter().isAvailable).toHaveBeenCalledTimes(1);
    expect(latestAdapter().connect).toHaveBeenCalledWith({ network: "testnet" });
  });

  it.each(["gemwallet", "crossmark"] as const)(
    "%s checks extension availability without connecting or signing",
    async (provider) => {
      const wallet = createWallet({ provider, network: "testnet" });
      const adapter = latestAdapter();

      expect(wallet.checkAvailability).toBeTypeOf("function");
      await expect(wallet.checkAvailability!()).resolves.toBeUndefined();
      expect(adapter.isAvailable).toHaveBeenCalledTimes(1);
      expect(adapter.connect).not.toHaveBeenCalled();
      expect(adapter.sign).not.toHaveBeenCalled();
      expect(adapter.signAndSubmit).not.toHaveBeenCalled();

      await expect(wallet.connect()).resolves.toBe(CONNECTED_ADDRESS);
      expect(adapter.isAvailable).toHaveBeenCalledTimes(1);
      expect(adapter.connect).toHaveBeenCalledTimes(1);
    },
  );

  it("fails an availability-only check without attempting account connection", async () => {
    const wallet = createWallet({ provider: "gemwallet", network: "testnet" });
    const adapter = latestAdapter();
    adapter.isAvailable.mockResolvedValueOnce(false);

    expect(wallet.checkAvailability).toBeTypeOf("function");
    await expect(wallet.checkAvailability!()).rejects.toEqual(
      expectCode("WALLET_NOT_INSTALLED"),
    );
    expect(adapter.connect).not.toHaveBeenCalled();
    expect(adapter.sign).not.toHaveBeenCalled();
  });

  it.each([
    ["gemwallet", "gemwallet"],
    ["crossmark", "crossmark"],
    ["xaman", "xaman"],
  ] as const)("selects the %s adapter", async (provider, expectedId) => {
    const wallet = createWallet({
      provider,
      network: "devnet",
      xamanApiKey: "public-xaman-app-id",
    });

    await wallet.connect();
    expect(latestAdapter().id).toBe(expectedId);
    expect(latestAdapter().connect).toHaveBeenCalledWith({ network: "devnet" });
    if (provider === "xaman") {
      expect(latestAdapter().options).toEqual({ apiKey: "public-xaman-app-id" });
    }
  });

  it("publishes the stable wallet selection order", () => {
    expect(WALLET_PROVIDERS).toEqual([
      "ledger",
      "gemwallet",
      "crossmark",
      "xaman",
      "dev",
    ]);
  });

  it("coalesces concurrent connects and makes later connects idempotent", async () => {
    const wallet = createWallet({ provider: "crossmark", network: "testnet" });
    const adapter = latestAdapter();

    const [first, second] = await Promise.all([wallet.connect(), wallet.connect()]);
    const third = await wallet.connect();

    expect([first, second, third]).toEqual([
      CONNECTED_ADDRESS,
      CONNECTED_ADDRESS,
      CONNECTED_ADDRESS,
    ]);
    expect(adapter.isAvailable).toHaveBeenCalledTimes(1);
    expect(adapter.connect).toHaveBeenCalledTimes(1);
    expect(wallet.address()).toBe(CONNECTED_ADDRESS);
  });

  it.each(["gemwallet", "crossmark"] as const)(
    "%s fails before connect when the extension is not installed",
    async (provider) => {
      const wallet = createWallet({ provider, network: "testnet" });
      const adapter = latestAdapter();
      adapter.isAvailable.mockResolvedValueOnce(false);

      await expect(wallet.connect()).rejects.toEqual(expectCode("WALLET_NOT_INSTALLED"));
      expect(adapter.connect).not.toHaveBeenCalled();
      expect(() => wallet.address()).toThrowError(expectCode("NOT_CONNECTED"));
    },
  );

  it("sanitizes extension availability failures without attempting to connect", async () => {
    const wallet = createWallet({ provider: "gemwallet", network: "testnet" });
    const adapter = latestAdapter();
    adapter.isAvailable.mockRejectedValueOnce(new Error("private extension state"));

    const error = await wallet.connect().catch((caught: unknown) => caught);
    expect(error).toEqual(expectCode("WALLET_UNAVAILABLE"));
    expect((error as Error).message).not.toContain("private extension state");
    expect(adapter.connect).not.toHaveBeenCalled();
  });

  it("rejects a returned wallet network mismatch before establishing identity", async () => {
    const wallet = createWallet({ provider: "gemwallet", network: "testnet" });
    const adapter = latestAdapter();
    adapter.connect.mockResolvedValueOnce({
      address: CONNECTED_ADDRESS,
      network: { id: "mainnet", name: "Mainnet", wss: "wss://example.invalid" },
    });

    const error = await wallet.connect().catch((caught: unknown) => caught);
    expect(error).toEqual(expectCode("WALLET_NETWORK_MISMATCH"));
    expect((error as Error).message).toContain("XRPL Testnet");
    expect(() => wallet.address()).toThrowError(expectCode("NOT_CONNECTED"));
    expect(adapter.sign).not.toHaveBeenCalled();
  });

  it.each([
    ["WALLET_NOT_INSTALLED", "WALLET_NOT_INSTALLED"],
    ["WALLET_NOT_AVAILABLE", "WALLET_UNAVAILABLE"],
    ["NETWORK_MISMATCH", "WALLET_NETWORK_MISMATCH"],
  ] as const)("maps structured %s connection errors to %s", async (providerCode, pilotCode) => {
    const wallet = createWallet({ provider: "crossmark", network: "testnet" });
    const adapter = latestAdapter();
    adapter.connect.mockRejectedValueOnce({ code: providerCode, detail: "private" });

    const error = await wallet.connect().catch((caught: unknown) => caught);
    expect(error).toEqual(expectCode(pilotCode));
    expect((error as Error).message).not.toContain("private");
  });

  it("can retry after a cancelled connection", async () => {
    const wallet = createWallet({ provider: "gemwallet", network: "testnet" });
    const adapter = latestAdapter();
    adapter.connect
      .mockRejectedValueOnce({ code: "CONNECTION_REJECTED", detail: "private" })
      .mockResolvedValueOnce({
        address: CONNECTED_ADDRESS,
        network: { id: "testnet", name: "Testnet", wss: "wss://example.invalid" },
      });

    await expect(wallet.connect()).rejects.toEqual(expectCode("CONNECT_CANCELLED"));
    await expect(wallet.connect()).resolves.toBe(CONNECTED_ADDRESS);
    expect(adapter.connect).toHaveBeenCalledTimes(2);
  });

  it("does not reconnect from a provider response that arrives after disconnect", async () => {
    const wallet = createWallet({ provider: "gemwallet", network: "testnet" });
    const adapter = latestAdapter();
    let resolveConnection: ((value: unknown) => void) | undefined;
    adapter.connect.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveConnection = resolve;
      }),
    );

    const pending = wallet.connect();
    await vi.waitFor(() => expect(adapter.connect).toHaveBeenCalledTimes(1));
    await wallet.disconnect();
    resolveConnection?.({
      address: CONNECTED_ADDRESS,
      network: { id: "testnet", name: "Testnet", wss: "wss://example.invalid" },
    });

    await expect(pending).rejects.toEqual(expectCode("CONNECT_CANCELLED"));
    expect(() => wallet.address()).toThrowError(expectCode("NOT_CONNECTED"));
  });

  it.each(["gemwallet", "crossmark"] as const)(
    "%s returns a signed blob while never reaching signAndSubmit",
    async (provider) => {
      const wallet = createWallet({ provider, network: "testnet" });
      const adapter = latestAdapter();
      await wallet.connect();

      await expect(wallet.signOnly(tx())).resolves.toBe("SIGNED_BLOB");
      expect(adapter.sign).toHaveBeenCalledWith(tx());
      expect(adapter.signAndSubmit).not.toHaveBeenCalled();
    },
  );

  it("serializes repeat signing requests without dropping either", async () => {
    const wallet = createWallet({ provider: "gemwallet", network: "testnet" });
    const adapter = latestAdapter();
    adapter.sign
      .mockResolvedValueOnce({ hash: "A", tx_blob: "BLOB_A" })
      .mockResolvedValueOnce({ hash: "B", tx_blob: "BLOB_B" });
    await wallet.connect();

    await expect(Promise.all([wallet.signOnly(tx()), wallet.signOnly(tx())])).resolves.toEqual([
      "BLOB_A",
      "BLOB_B",
    ]);
    expect(adapter.sign).toHaveBeenCalledTimes(2);
  });

  it("recovers after a cancelled signing prompt", async () => {
    const wallet = createWallet({ provider: "gemwallet", network: "testnet" });
    const adapter = latestAdapter();
    adapter.sign
      .mockRejectedValueOnce({ code: "SIGN_REJECTED", payload: "not surfaced" })
      .mockResolvedValueOnce({ hash: "HASH", tx_blob: "RETRY_BLOB" });
    await wallet.connect();

    await expect(wallet.signOnly(tx())).rejects.toEqual(expectCode("SIGN_CANCELLED"));
    await expect(wallet.signOnly(tx())).resolves.toBe("RETRY_BLOB");
  });

  it("discards a signed response that arrives after disconnect", async () => {
    const wallet = createWallet({ provider: "gemwallet", network: "testnet" });
    const adapter = latestAdapter();
    let resolveSignature: ((value: unknown) => void) | undefined;
    adapter.sign.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSignature = resolve;
      }),
    );
    await wallet.connect();

    const pending = wallet.signOnly(tx());
    await vi.waitFor(() => expect(adapter.sign).toHaveBeenCalledTimes(1));
    await wallet.disconnect();
    resolveSignature?.({ hash: "HASH", tx_blob: "LATE_BLOB" });

    await expect(pending).rejects.toEqual(expectCode("SIGN_CANCELLED"));
  });

  it("sanitizes unexpected provider errors", async () => {
    const wallet = createWallet({ provider: "crossmark", network: "testnet" });
    const adapter = latestAdapter();
    adapter.sign.mockRejectedValueOnce(new Error("provider internals"));
    await wallet.connect();

    const error = await wallet.signOnly(tx()).catch((caught: unknown) => caught);
    expect(error).toEqual(expectCode("SIGN_FAILED"));
    expect(error).toBeInstanceOf(PilotWalletError);
    expect((error as Error).message).not.toContain("provider internals");
  });

  it("refuses a response that has no signed transaction blob", async () => {
    const wallet = createWallet({ provider: "xaman", network: "testnet" });
    const adapter = latestAdapter();
    adapter.sign.mockResolvedValueOnce({ hash: "HASH", signature: "not-a-blob" });
    await wallet.connect();

    await expect(wallet.signOnly(tx())).rejects.toEqual(
      expectCode("MISSING_SIGNED_BLOB"),
    );
  });

  it("hard-refuses mainnet signing before prompting the wallet", async () => {
    const wallet = createWallet({ provider: "gemwallet", network: "mainnet" });
    const adapter = latestAdapter();
    await wallet.connect();

    await expect(wallet.signOnly(tx())).rejects.toEqual(
      expectCode("MAINNET_SIGNING_DISABLED"),
    );
    expect(adapter.sign).not.toHaveBeenCalled();
  });

  it("rejects invalid and wrong-account transactions before prompting", async () => {
    const wallet = createWallet({ provider: "gemwallet", network: "testnet" });
    const adapter = latestAdapter();
    await wallet.connect();

    await expect(wallet.signOnly({ Account: CONNECTED_ADDRESS })).rejects.toEqual(
      expectCode("INVALID_TRANSACTION"),
    );
    await expect(wallet.signOnly(tx(DESTINATION))).rejects.toEqual(
      expectCode("ACCOUNT_MISMATCH"),
    );
    expect(adapter.sign).not.toHaveBeenCalled();
  });

  it.each([
    ["TxnSignature", { TxnSignature: "DEADBEEF" }],
    ["Signers", { Signers: [] }],
    ["non-empty SigningPubKey", { SigningPubKey: "02".padEnd(66, "A") }],
  ])(
    "rejects a transaction carrying %s before prompting",
    async (_label, signedFields) => {
      const wallet = createWallet({ provider: "gemwallet", network: "testnet" });
      const adapter = latestAdapter();
      await wallet.connect();

      await expect(
        wallet.signOnly({ ...tx(), ...signedFields }),
      ).rejects.toEqual(expectCode("INVALID_TRANSACTION"));
      expect(adapter.sign).not.toHaveBeenCalled();
    },
  );

  it("allows an explicitly empty SigningPubKey for the wallet to populate", async () => {
    const wallet = createWallet({ provider: "gemwallet", network: "testnet" });
    const adapter = latestAdapter();
    await wallet.connect();

    await expect(
      wallet.signOnly({ ...tx(), SigningPubKey: "" }),
    ).resolves.toBe("SIGNED_BLOB");
    expect(adapter.sign).toHaveBeenCalledOnce();
  });

  it("uses the lending devnet network configuration", async () => {
    const wallet = createWallet({
      provider: "crossmark",
      network: "lending-devnet",
    });
    const adapter = latestAdapter();
    await wallet.connect();

    expect(adapter.connect).toHaveBeenCalledWith({
      network: expect.objectContaining({
        id: "lending-devnet",
        wss: "wss://lend.devnet.rippletest.net:51233",
      }),
    });
  });

  it("clears local connection state even if provider disconnect fails", async () => {
    const wallet = createWallet({ provider: "gemwallet", network: "testnet" });
    latestAdapter().disconnect.mockRejectedValueOnce(new Error("extension gone"));
    await wallet.connect();
    await wallet.disconnect();

    expect(() => wallet.address()).toThrowError(expectCode("NOT_CONNECTED"));
  });
});

describe("development signer", () => {
  let session: MemorySessionStorage;
  let local: MemorySessionStorage;
  let webLocks: TestWebLocksControl;

  beforeEach(() => {
    connector.instances.length = 0;
    session = new MemorySessionStorage();
    local = new MemorySessionStorage();
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: session,
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: local,
    });
    webLocks = installImmediateWebLocks();
    setBrowserLocation("http://127.0.0.1:3003");
    vi.stubEnv("NEXT_PUBLIC_DEV_SIGNER", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "sessionStorage");
    Reflect.deleteProperty(globalThis, "localStorage");
    Reflect.deleteProperty(globalThis, "location");
    Reflect.deleteProperty(globalThis, "navigator");
  });

  it("is inaccessible unless NEXT_PUBLIC_DEV_SIGNER is exactly 1", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEV_SIGNER", "0");
    const wallet = createWallet({ provider: "dev", network: "testnet" });

    await expect(wallet.connect()).rejects.toEqual(expectCode("DEV_SIGNER_DISABLED"));
    expect(session.setItem).not.toHaveBeenCalled();
  });

  it("hard-refuses mainnet before generating or reading a key", async () => {
    const wallet = createWallet({ provider: "dev", network: "mainnet" });

    await expect(wallet.connect()).rejects.toEqual(
      expectCode("MAINNET_SIGNING_DISABLED"),
    );
    expect(session.getItem).not.toHaveBeenCalled();
    expect(session.setItem).not.toHaveBeenCalled();
  });

  it("rejects lending devnet before touching browser storage", async () => {
    const wallet = createWallet({ provider: "dev", network: "lending-devnet" });

    await expect(wallet.connect()).rejects.toEqual(
      expectCode("DEV_SIGNER_UNSUPPORTED_NETWORK"),
    );
    expect(session.getItem).not.toHaveBeenCalled();
    expect(session.setItem).not.toHaveBeenCalled();
    expect(session.removeItem).not.toHaveBeenCalled();
  });

  it.each([
    "http://localhost:3003",
    "http://[::1]:3003",
    "http://127.0.0.1:3004",
    "https://127.0.0.1:3003",
    "http://pilot.example:3003",
  ])("rejects the untrusted browser origin %s before storage access", async (origin) => {
    setBrowserLocation(origin);
    const wallet = createWallet({ provider: "dev", network: "testnet" });

    await expect(wallet.connect()).rejects.toEqual(
      expectCode("DEV_SIGNER_UNTRUSTED_LOCATION"),
    );
    expect(session.lengthReads).toBe(0);
    expect(session.key).not.toHaveBeenCalled();
    expect(session.getItem).not.toHaveBeenCalled();
    expect(session.setItem).not.toHaveBeenCalled();
    expect(session.removeItem).not.toHaveBeenCalled();
  });

  it("rejects a missing browser location before storage access", async () => {
    Reflect.deleteProperty(globalThis, "location");
    const wallet = createWallet({ provider: "dev", network: "testnet" });

    await expect(wallet.connect()).rejects.toEqual(
      expectCode("DEV_SIGNER_UNTRUSTED_LOCATION"),
    );
    expect(session.lengthReads).toBe(0);
    expect(session.key).not.toHaveBeenCalled();
    expect(session.getItem).not.toHaveBeenCalled();
    expect(session.setItem).not.toHaveBeenCalled();
    expect(session.removeItem).not.toHaveBeenCalled();
  });

  it("cancels a queued connection without touching session storage", async () => {
    const wallet = createWallet({ provider: "dev", network: "testnet" });
    const pending = wallet.connect();
    await wallet.disconnect();

    await expect(pending).rejects.toEqual(expectCode("CONNECT_CANCELLED"));
    expect(session.getItem).not.toHaveBeenCalled();
    expect(session.setItem).not.toHaveBeenCalled();
  });

  it.each(["testnet", "devnet"] as const)(
    "connects and signs offline on %s",
    async (network) => {
      const wallet = createWallet({ provider: "dev", network });
      const address = await wallet.connect();
      const blob = await wallet.signOnly(tx(address));

      expect(address).toMatch(/^r/);
      expect(blob).toMatch(/^[A-F0-9]+$/);
      expect(session.setItem).toHaveBeenCalledTimes(1);
      expect(session.setItem).toHaveBeenCalledWith(
        `pilot.wallet.dev.v2.${network}`,
        expect.any(String),
      );
    },
  );

  it("signs a non-submittable action proof whose XRPL signature verifies", async () => {
    const wallet = createWallet({ provider: "dev", network: "testnet" });
    const address = await wallet.connect();
    const txBlob = await wallet.signOnly({
      TransactionType: "AccountSet",
      Account: address,
      Sequence: 0,
      Fee: "0",
      LastLedgerSequence: 0,
      Memos: [{ Memo: { MemoType: "70696C6F742D77616C6C65742D616374696F6E2D7631", MemoData: "AB" } }],
    });
    const decoded = decode(txBlob) as Record<string, unknown>;
    const publicKey = decoded.SigningPubKey;
    const signature = decoded.TxnSignature;

    expect(typeof publicKey).toBe("string");
    expect(typeof signature).toBe("string");
    expect(deriveAddress(String(publicKey))).toBe(address);
    expect(verifyKeypairSignature(
      encodeForSigning(decoded as never),
      String(signature),
      String(publicKey),
    )).toBe(true);
  });

  it("allows only Pilot's exact local browser origin", async () => {
    setBrowserLocation("http://127.0.0.1:3003");
    const wallet = createWallet({ provider: "dev", network: "testnet" });

    await expect(wallet.connect()).resolves.toMatch(/^r/);
  });

  it("allows the exact isolated build marker only on its fixed browser origin", async () => {
    vi.stubEnv("NEXT_PUBLIC_PILOT_BUILD_MARKER", "pilot-local-wallet-isolated-v1");
    setBrowserLocation("http://127.0.0.2:3003");
    const wallet = createWallet({ provider: "dev", network: "testnet" });

    await expect(wallet.connect()).resolves.toMatch(/^r/);
    expect(session.setItem).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["isolated marker on the legacy slot", "pilot-local-wallet-isolated-v1", "http://127.0.0.1:3003"],
    ["missing marker on the isolated slot", undefined, "http://127.0.0.2:3003"],
    ["unknown marker on the isolated slot", "pilot-other", "http://127.0.0.2:3003"],
    ["localhost alias", "pilot-local-wallet-isolated-v1", "http://localhost:3003"],
    ["IPv6 alias", "pilot-local-wallet-isolated-v1", "http://[::1]:3003"],
    ["legacy address", "pilot-local-wallet-isolated-v1", "http://127.0.0.1:3003"],
    ["other loopback address", "pilot-local-wallet-isolated-v1", "http://127.0.0.3:3003"],
    ["wrong port", "pilot-local-wallet-isolated-v1", "http://127.0.0.2:3004"],
    ["HTTPS", "pilot-local-wallet-isolated-v1", "https://127.0.0.2:3003"],
  ] as const)("rejects %s before isolated signer storage access", async (
    _name,
    marker,
    origin,
  ) => {
    if (marker === undefined) vi.stubEnv("NEXT_PUBLIC_PILOT_BUILD_MARKER", undefined);
    else vi.stubEnv("NEXT_PUBLIC_PILOT_BUILD_MARKER", marker);
    setBrowserLocation(origin);
    const wallet = createWallet({ provider: "dev", network: "testnet" });

    await expect(wallet.connect()).rejects.toEqual(
      expectCode("DEV_SIGNER_UNTRUSTED_LOCATION"),
    );
    expect(session.lengthReads).toBe(0);
    expect(session.getItem).not.toHaveBeenCalled();
    expect(session.setItem).not.toHaveBeenCalled();
    expect(session.removeItem).not.toHaveBeenCalled();
  });

  it("rechecks browser location before every signature", async () => {
    const wallet = createWallet({ provider: "dev", network: "testnet" });
    const address = await wallet.connect();

    setBrowserLocation("http://pilot.example:3003");
    await expect(wallet.signOnly(tx(address))).rejects.toEqual(
      expectCode("DEV_SIGNER_UNTRUSTED_LOCATION"),
    );

    setBrowserLocation("http://127.0.0.1:3003");
    await expect(wallet.signOnly(tx(address))).resolves.toMatch(/^[A-F0-9]+$/);
  });

  it("rechecks the isolated marker and browser slot before every signature", async () => {
    vi.stubEnv("NEXT_PUBLIC_PILOT_BUILD_MARKER", "pilot-local-wallet-isolated-v1");
    setBrowserLocation("http://127.0.0.2:3003");
    const wallet = createWallet({ provider: "dev", network: "testnet" });
    const address = await wallet.connect();

    setBrowserLocation("http://127.0.0.1:3003");
    await expect(wallet.signOnly(tx(address))).rejects.toEqual(
      expectCode("DEV_SIGNER_UNTRUSTED_LOCATION"),
    );

    setBrowserLocation("http://127.0.0.2:3003");
    await expect(wallet.signOnly(tx(address))).resolves.toMatch(/^[A-F0-9]+$/);
  });

  it("reuses the same account across wrapper instances in one tab session", async () => {
    const first = createWallet({ provider: "dev", network: "testnet" });
    const firstAddress = await first.connect();
    const persistedValue = [...session.values.values()][0];
    expect(persistedValue).toBeTypeOf("string");
    expect(firstAddress).not.toBe(persistedValue);
    expect(JSON.stringify(first)).not.toContain(persistedValue);
    expect((first as unknown as { wallet?: unknown }).wallet).toBeUndefined();

    await first.disconnect();
    const second = createWallet({ provider: "dev", network: "testnet" });
    const secondAddress = await second.connect();

    expect(secondAddress).toBe(firstAddress);
    expect(session.setItem).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent facades and creates only one signer in a tab", async () => {
    const first = createWallet({ provider: "dev", network: "testnet" });
    const second = createWallet({ provider: "dev", network: "testnet" });

    const [firstAddress, secondAddress] = await Promise.all([
      first.connect(),
      second.connect(),
    ]);

    expect(secondAddress).toBe(firstAddress);
    expect(session.setItem).toHaveBeenCalledTimes(1);
    expect(local.setItem).toHaveBeenCalledTimes(1);
  });

  it("denies a copied child after lifetime lock loss without replacing authority", async () => {
    const firstTab = new MemorySessionStorage();
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: firstTab,
    });
    const first = createWallet({ provider: "dev", network: "testnet" });
    const address = await first.connect();
    const seed = firstTab.values.get("pilot.wallet.dev.v2.testnet");
    expect(seed).toBeTypeOf("string");

    const childTab = new MemorySessionStorage();
    childTab.values.set("pilot.wallet.dev.v2.testnet", seed!);
    expect(childTab.values.get("pilot.wallet.dev.v2.testnet")).toBe(
      firstTab.values.get("pilot.wallet.dev.v2.testnet"),
    );
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: childTab,
    });
    vi.resetModules();
    const childModule = await import("../src/index.js");
    const child = childModule.createWallet({
      provider: "dev",
      network: "testnet",
    });

    await expect(child.connect()).rejects.toEqual(
      expectCode("DEV_SIGNER_CLAIM_UNAVAILABLE"),
    );
    await expect(child.signOnly(tx(address))).rejects.toEqual(
      expectCode("DEV_SIGNER_CLAIM_UNAVAILABLE"),
    );
    await expect(first.signOnly(tx(address))).resolves.toMatch(/^[A-F0-9]+$/);
    expect(childTab.values.get("pilot.wallet.dev.v2.testnet")).toBe(seed);

    // Soft disconnect retains the lifetime claim, while the original tab can
    // reconnect through its same-realm claim without rotating authority.
    await first.disconnect();
    await expect(child.connect()).rejects.toEqual(
      expectCode("DEV_SIGNER_CLAIM_UNAVAILABLE"),
    );
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: firstTab,
    });
    await expect(first.connect()).resolves.toBe(address);

    const ownerMarker = local.values.get(lifecycleKey("testnet"));
    webLocks.forceRelease("pilot.wallet.dev.claim.v1.testnet");
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: childTab,
    });

    // Simulate close/crash releasing the browser lock without verified
    // revocation. The copied tab can acquire the lock, but its independent
    // module-realm binding cannot restore or use the cloned seed.
    await expect(child.connect()).rejects.toEqual(
      expectCode("DEV_SIGNER_RECOVERY_REQUIRED"),
    );
    await expect(child.signOnly(tx(address))).rejects.toEqual(
      expectCode("DEV_SIGNER_CLAIM_UNAVAILABLE"),
    );
    expect(local.values.get(lifecycleKey("testnet"))).toBe(ownerMarker);
    expect(childTab.values.get("pilot.wallet.dev.v2.testnet")).toBe(seed);
    expect(childTab.setItem).not.toHaveBeenCalled();
    expect(childTab.removeItem).not.toHaveBeenCalled();

    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: firstTab,
    });
    await first.markRevocationVerified!();
    await first.forget();
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: childTab,
    });

    // The child can acquire only after verified cleanup, but its copied seed
    // has no lifecycle owner and is refused without deletion or replacement.
    await expect(child.connect()).rejects.toEqual(
      expectCode("DEV_SIGNER_RECOVERY_REQUIRED"),
    );
    expect(childTab.values.get("pilot.wallet.dev.v2.testnet")).toBe(seed);
    expect(childTab.setItem).not.toHaveBeenCalled();
    expect(childTab.removeItem).not.toHaveBeenCalled();
  });

  it("fails closed without touching storage when the lifecycle claim is held", async () => {
    const request = vi.fn(
      (
        _name: string,
        _options: LockOptions,
        callback: (lock: Lock | null) => unknown,
      ) => Promise.resolve().then(() => callback(null)),
    );
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { locks: { request } },
    });
    const wallet = createWallet({ provider: "dev", network: "testnet" });

    await expect(wallet.connect()).rejects.toEqual(
      expectCode("DEV_SIGNER_CLAIM_UNAVAILABLE"),
    );
    expect(request).toHaveBeenCalledWith(
      "pilot.wallet.dev.claim.v1.testnet",
      { mode: "exclusive", ifAvailable: true },
      expect.any(Function),
    );
    expect(session.lengthReads).toBe(0);
    expect(session.getItem).not.toHaveBeenCalled();
    expect(session.setItem).not.toHaveBeenCalled();
    expect(local.getItem).not.toHaveBeenCalled();
    expect(local.setItem).not.toHaveBeenCalled();
  });

  it("fails closed without touching storage when Web Locks are unavailable", async () => {
    Reflect.deleteProperty(globalThis, "navigator");
    const wallet = createWallet({ provider: "dev", network: "testnet" });

    await expect(wallet.connect()).rejects.toEqual(
      expectCode("DEV_SIGNER_CLAIM_UNAVAILABLE"),
    );
    expect(session.lengthReads).toBe(0);
    expect(session.getItem).not.toHaveBeenCalled();
    expect(session.setItem).not.toHaveBeenCalled();
    expect(local.getItem).not.toHaveBeenCalled();
    expect(local.setItem).not.toHaveBeenCalled();
  });

  it("blocks a fresh tab from generating a replacement owner after session loss", async () => {
    const first = createWallet({ provider: "dev", network: "testnet" });
    const firstAddress = await first.connect();
    session.values.delete("pilot.wallet.dev.v2.testnet");
    session.setItem.mockClear();

    const freshTab = createWallet({ provider: "dev", network: "testnet" });
    await expect(freshTab.connect()).rejects.toEqual(
      expectCode("DEV_SIGNER_RECOVERY_REQUIRED"),
    );

    expect(session.setItem).not.toHaveBeenCalled();
    expect(session.values.has("pilot.wallet.dev.v2.testnet")).toBe(false);
    expect(parsedLifecycleMarker(local.values.get(lifecycleKey("testnet")))).toMatchObject({
      version: 1,
      account: firstAddress,
      network: "testnet",
      status: "owner_present",
      context_binding: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
  });

  it("rejects a restored seed that does not match the public lifecycle owner", async () => {
    const first = createWallet({ provider: "dev", network: "testnet" });
    await first.connect();
    await first.disconnect();
    local.values.set(
      lifecycleKey("testnet"),
      lifecycleMarker(DESTINATION, "testnet", "owner_present"),
    );

    const restored = createWallet({ provider: "dev", network: "testnet" });
    await expect(restored.connect()).rejects.toEqual(
      expectCode("DEV_SIGNER_RECOVERY_REQUIRED"),
    );
    expect(session.setItem).toHaveBeenCalledTimes(1);
  });

  it("rolls back a newly generated seed when lifecycle persistence fails", async () => {
    local.setItem.mockImplementationOnce(() => {
      throw new Error("local storage denied");
    });
    const wallet = createWallet({ provider: "dev", network: "testnet" });

    await expect(wallet.connect()).rejects.toEqual(
      expectCode("LIFECYCLE_STORAGE_UNAVAILABLE"),
    );
    expect(session.setItem).toHaveBeenCalledTimes(1);
    expect(session.removeItem).toHaveBeenCalledWith("pilot.wallet.dev.v2.testnet");
    expect(session.values.has("pilot.wallet.dev.v2.testnet")).toBe(false);
    expect(local.values.has(lifecycleKey("testnet"))).toBe(false);
  });

  it("fails closed for malformed or unavailable lifecycle storage", async () => {
    local.values.set(lifecycleKey("testnet"), "not-json");
    const malformed = createWallet({ provider: "dev", network: "testnet" });
    await expect(malformed.connect()).rejects.toEqual(
      expectCode("DEV_SIGNER_RECOVERY_REQUIRED"),
    );
    expect(session.setItem).not.toHaveBeenCalled();

    local.values.clear();
    local.getItem.mockImplementationOnce(() => {
      throw new Error("local storage denied");
    });
    const unavailable = createWallet({ provider: "dev", network: "testnet" });
    await expect(unavailable.connect()).rejects.toEqual(
      expectCode("LIFECYCLE_STORAGE_UNAVAILABLE"),
    );
    expect(session.setItem).not.toHaveBeenCalled();
  });

  it("fails closed without reading, migrating, deleting, or replacing a legacy v1 session", async () => {
    const legacyKey = "pilot.wallet.dev.v1.testnet";
    const legacyValue = "legacy-private-material-that-must-not-be-read";
    session.values.set(legacyKey, legacyValue);
    const wallet = createWallet({ provider: "dev", network: "testnet" });

    await expect(wallet.connect()).rejects.toEqual(
      expectCode("LEGACY_DEV_SIGNER_RECOVERY_REQUIRED"),
    );
    await expect(wallet.connect()).rejects.toEqual(
      expectCode("LEGACY_DEV_SIGNER_RECOVERY_REQUIRED"),
    );
    await expect(wallet.forget()).rejects.toEqual(
      expectCode("DEV_SIGNER_RECOVERY_REQUIRED"),
    );
    await expect(wallet.connect()).rejects.toEqual(
      expectCode("LEGACY_DEV_SIGNER_RECOVERY_REQUIRED"),
    );

    expect(session.getItem).not.toHaveBeenCalled();
    expect(session.setItem).not.toHaveBeenCalled();
    expect(session.removeItem).not.toHaveBeenCalledWith(legacyKey);
    expect(session.removeItem).not.toHaveBeenCalled();
    expect(session.values.get(legacyKey)).toBe(legacyValue);
    expect(session.values.has("pilot.wallet.dev.v2.testnet")).toBe(false);
  });

  it("refuses a legacy v1 session before reading an existing v2 session key", async () => {
    const first = createWallet({ provider: "dev", network: "testnet" });
    await first.connect();
    await first.disconnect();
    const legacyKey = "pilot.wallet.dev.v1.testnet";
    const legacyValue = "legacy-private-material";
    session.values.set(legacyKey, legacyValue);
    session.getItem.mockClear();
    session.removeItem.mockClear();

    const second = createWallet({ provider: "dev", network: "testnet" });
    await expect(second.connect()).rejects.toEqual(
      expectCode("LEGACY_DEV_SIGNER_RECOVERY_REQUIRED"),
    );

    expect(session.getItem).not.toHaveBeenCalled();
    expect(session.removeItem).not.toHaveBeenCalled();
    expect(session.values.get(legacyKey)).toBe(legacyValue);
    expect(session.values.has("pilot.wallet.dev.v2.testnet")).toBe(true);
  });

  it("isolates accounts by test network", async () => {
    const testnet = createWallet({ provider: "dev", network: "testnet" });
    const devnet = createWallet({ provider: "dev", network: "devnet" });

    expect(await testnet.connect()).not.toBe(await devnet.connect());
    expect(session.values.size).toBe(2);
  });

  it("fails closed without replacing a corrupt v2 session entry", async () => {
    session.values.set("pilot.wallet.dev.v2.testnet", "corrupt-private-value");
    local.values.set(
      lifecycleKey("testnet"),
      lifecycleMarker(CONNECTED_ADDRESS, "testnet", "owner_present"),
    );
    const wallet = createWallet({ provider: "dev", network: "testnet" });

    await expect(wallet.connect()).rejects.toEqual(
      expectCode("DEV_SIGNER_RECOVERY_REQUIRED"),
    );
    expect(session.removeItem).not.toHaveBeenCalled();
    expect(session.setItem).not.toHaveBeenCalled();
    expect(session.values.get("pilot.wallet.dev.v2.testnet")).toBe("corrupt-private-value");
  });

  it("refuses hard forget before verified revocation and preserves authority", async () => {
    const wallet = createWallet({ provider: "dev", network: "testnet" });
    const address = await wallet.connect();
    const seed = session.values.get("pilot.wallet.dev.v2.testnet");
    const marker = local.values.get(lifecycleKey("testnet"));

    await expect(wallet.forget()).rejects.toEqual(
      expectCode("DEV_SIGNER_REVOCATION_REQUIRED"),
    );

    expect(wallet.address()).toBe(address);
    expect(session.values.get("pilot.wallet.dev.v2.testnet")).toBe(seed);
    expect(local.values.get(lifecycleKey("testnet"))).toBe(marker);
    expect(session.removeItem).not.toHaveBeenCalled();
    expect(local.removeItem).not.toHaveBeenCalled();
  });

  it("cleans up v2 and the public marker only after exact-owner revocation proof", async () => {
    const wallet = createWallet({ provider: "dev", network: "testnet" });
    const address = await wallet.connect();
    const contextBinding = parsedLifecycleMarker(
      local.values.get(lifecycleKey("testnet")),
    ).context_binding;

    await wallet.markRevocationVerified!();
    expect(local.values.get(lifecycleKey("testnet"))).toBe(
      lifecycleMarker(address, "testnet", "revoked", String(contextBinding)),
    );

    await wallet.forget();
    expect(session.values.has("pilot.wallet.dev.v2.testnet")).toBe(false);
    expect(local.values.has(lifecycleKey("testnet"))).toBe(false);
    expect(() => wallet.address()).toThrowError(expectCode("NOT_CONNECTED"));
  });

  it("keeps disconnect soft but rotates the signer after hard forget", async () => {
    const wallet = createWallet({ provider: "dev", network: "testnet" });
    const firstAddress = await wallet.connect();

    await wallet.disconnect();
    await expect(wallet.connect()).resolves.toBe(firstAddress);

    await wallet.markRevocationVerified!();
    await wallet.forget();
    expect(() => wallet.address()).toThrowError(expectCode("NOT_CONNECTED"));
    expect(session.removeItem).not.toHaveBeenCalledWith(
      "pilot.wallet.dev.v1.testnet",
    );
    expect(session.removeItem).toHaveBeenCalledWith(
      "pilot.wallet.dev.v2.testnet",
    );
    await expect(wallet.connect()).resolves.not.toBe(firstAddress);
  });

  it("cancels signing work queued before hard forget", async () => {
    const wallet = createWallet({ provider: "dev", network: "testnet" });
    const address = await wallet.connect();
    await wallet.markRevocationVerified!();
    const first = wallet.signOnly(tx(address));
    const second = wallet.signOnly(tx(address));
    const firstExpectation = expect(first).rejects.toEqual(
      expectCode("SIGN_CANCELLED"),
    );
    const secondExpectation = expect(second).rejects.toEqual(
      expectCode("SIGN_CANCELLED"),
    );

    await wallet.forget();

    await firstExpectation;
    await secondExpectation;
    expect(session.values.has("pilot.wallet.dev.v2.testnet")).toBe(false);
  });

  it("hard forget cancels queued work, clears v2, and preserves opaque v1 material", async () => {
    const legacyKey = "pilot.wallet.dev.v1.devnet";
    const legacyValue = "legacy-private-material";
    const wallet = createWallet({ provider: "dev", network: "devnet" });
    await wallet.connect();
    await wallet.markRevocationVerified!();
    session.values.set(legacyKey, legacyValue);
    await wallet.disconnect();
    const pending = wallet.connect();
    const pendingExpectation = expect(pending).rejects.toEqual(
      expectCode("CONNECT_CANCELLED"),
    );

    await wallet.forget();

    await pendingExpectation;
    expect(session.values.get(legacyKey)).toBe(legacyValue);
    expect(session.values.has("pilot.wallet.dev.v2.devnet")).toBe(false);
    expect(session.getItem).not.toHaveBeenCalledWith(legacyKey);
    expect(session.removeItem).not.toHaveBeenCalledWith(legacyKey);
    expect(session.setItem).toHaveBeenCalledTimes(1);

    await expect(wallet.connect()).rejects.toEqual(
      expectCode("LEGACY_DEV_SIGNER_RECOVERY_REQUIRED"),
    );
    expect(session.values.get(legacyKey)).toBe(legacyValue);
    expect(session.values.has("pilot.wallet.dev.v2.devnet")).toBe(false);
  });

  it("persists only a strict public lifecycle marker and never logs stored values", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const wallet = createWallet({ provider: "dev", network: "testnet" });

    const address = await wallet.connect();
    const seed = session.values.get("pilot.wallet.dev.v2.testnet");
    const marker = local.values.get(lifecycleKey("testnet"));
    expect(parsedLifecycleMarker(marker)).toMatchObject({
      version: 1,
      account: address,
      network: "testnet",
      status: "owner_present",
      context_binding: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
    expect(marker).not.toContain(seed!);
    expect(marker).not.toContain("SIGNED_BLOB");
    await wallet.markRevocationVerified!();
    await wallet.forget();

    expect(local.getItem).toHaveBeenCalledWith(lifecycleKey("testnet"));
    expect(local.setItem).toHaveBeenCalled();
    expect(local.removeItem).toHaveBeenCalledWith(lifecycleKey("testnet"));
    expect(local.clear).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("fails closed when sessionStorage is unavailable", async () => {
    Reflect.deleteProperty(globalThis, "sessionStorage");
    const wallet = createWallet({ provider: "dev", network: "testnet" });

    await expect(wallet.connect()).rejects.toEqual(
      expectCode("SESSION_STORAGE_UNAVAILABLE"),
    );
  });

  it("fails closed when sessionStorage denies writes", async () => {
    session.setItem.mockImplementationOnce(() => {
      throw new Error("quota or privacy mode");
    });
    const wallet = createWallet({ provider: "dev", network: "testnet" });

    await expect(wallet.connect()).rejects.toEqual(
      expectCode("SESSION_STORAGE_UNAVAILABLE"),
    );
  });
});
