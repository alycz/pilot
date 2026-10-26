import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NEAR_CONNECT_CONSTRUCTION_POLICY,
  PILOT_NEAR_CONNECT_EXECUTOR_URL,
  PILOT_NEAR_CONNECT_MANIFEST,
  createPilotNearConnectAdapter,
  resolveNearConnectAdapterStatus,
  type NearConnectRuntimeLoader,
} from "./near-connect-adapter";

const NONCE = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
const PUBLIC_KEY = `ed25519:${"B".repeat(44)}`;
const SIGNATURE = `${"A".repeat(86)}==`;

afterEach(() => vi.unstubAllGlobals());

function runtime(input: Readonly<{
  accounts?: Array<{ accountId: string; publicKey?: string }>;
  signedAccountId?: string;
  injectedFirst?: boolean;
  omitPinned?: boolean;
  manifestPromise?: Promise<void>;
  accountsPromise?: Promise<Array<{ accountId: string; publicKey?: string }>>;
}> = {}) {
  const getAccounts = vi.fn(() =>
    input.accountsPromise ?? Promise.resolve(input.accounts ?? []));
  const signMessage = vi.fn(async () => ({
    accountId: input.signedAccountId ?? "alice.near",
    publicKey: PUBLIC_KEY,
    signature: SIGNATURE,
  }));
  const signInAndSignMessage = vi.fn(async (_input: unknown) => [{
    accountId: input.signedAccountId ?? "alice.near",
    publicKey: PUBLIC_KEY,
    signedMessage: {
      accountId: input.signedAccountId ?? "alice.near",
      publicKey: PUBLIC_KEY,
      signature: SIGNATURE,
    },
  }]);
  let capturedOptions: unknown;

  class SandboxWallet {
    manifest = structuredClone(PILOT_NEAR_CONNECT_MANIFEST.wallets[0]);
    getAccounts = getAccounts;
    signMessage = signMessage;
    signInAndSignMessage = signInAndSignMessage;
  }
  class NearConnector {
    whenManifestLoaded = input.manifestPromise ?? Promise.resolve();
    wallets: unknown[];

    constructor(options: unknown) {
      capturedOptions = options;
      const injected = {
        manifest: structuredClone(PILOT_NEAR_CONNECT_MANIFEST.wallets[0]),
        getAccounts: vi.fn(),
        signMessage: vi.fn(),
      };
      this.wallets = input.omitPinned
        ? [injected]
        : input.injectedFirst
          ? [injected, new SandboxWallet()]
          : [new SandboxWallet()];
    }
  }
  return {
    loader: (async () => ({ NearConnector, SandboxWallet })) as unknown as
      NearConnectRuntimeLoader,
    get capturedOptions() { return capturedOptions; },
    getAccounts,
    signMessage,
    signInAndSignMessage,
  };
}

function challenge(accountId = "alice.near") {
  return {
    accountId,
    message: "pilot quote-bound challenge",
    nonce: NONCE,
    recipient: "pilot.near",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

describe("Near Connect browser adapter", () => {
  it("is default-off and constructs nothing when disabled", async () => {
    const fake = runtime();
    await expect(createPilotNearConnectAdapter({
      enabled: false,
      runtimeLoader: fake.loader,
    })).rejects.toThrow("disabled");
    expect(fake.capturedOptions).toBeUndefined();
    expect(resolveNearConnectAdapterStatus(false)).toMatchObject({
      state: "disabled",
      canConstruct: false,
      canPrompt: false,
    });
  });

  it("constructs with only the inline pinned mainnet message-signing manifest", async () => {
    vi.stubGlobal("window", {});
    const fake = runtime({ accounts: [{ accountId: "alice.near" }] });
    const adapter = await createPilotNearConnectAdapter({
      enabled: true,
      runtimeLoader: fake.loader,
    });
    const options = fake.capturedOptions as Record<string, any>;

    expect(options).toMatchObject({
      autoConnect: false,
      network: "mainnet",
      footerBranding: null,
      features: {
        signMessage: true,
        signInWithoutAddKey: true,
        signInAndSignMessage: true,
        mainnet: true,
      },
    });
    expect(options).not.toHaveProperty("signIn");
    expect(options.manifest.wallets).toHaveLength(1);
    expect(options.manifest.wallets[0]).toMatchObject({
      id: "mynearwallet",
      type: "sandbox",
      executor: PILOT_NEAR_CONNECT_EXECUTOR_URL,
      features: {
        signMessage: true,
        signInWithoutAddKey: true,
        signInAndSignMessage: true,
        mainnet: true,
        signTransaction: false,
        signAndSendTransaction: false,
        signAndSendTransactions: false,
        signInWithFunctionCallKey: false,
        signDelegateActions: false,
      },
    });

    await expect(adapter.signChallenge(challenge())).resolves.toEqual({
      account_id: "alice.near",
      public_key: PUBLIC_KEY,
      signature: SIGNATURE,
    });
    expect(fake.signMessage).toHaveBeenCalledWith(expect.objectContaining({
      network: "mainnet",
      signerId: "alice.near",
      message: "pilot quote-bound challenge",
      recipient: "pilot.near",
      nonce: expect.any(Uint8Array),
    }));
    expect(fake.signInAndSignMessage).not.toHaveBeenCalled();
  });

  it("uses signInAndSignMessage without an access key for an unconnected exact account", async () => {
    vi.stubGlobal("window", {});
    const fake = runtime();
    const adapter = await createPilotNearConnectAdapter({
      enabled: true,
      runtimeLoader: fake.loader,
    });

    await adapter.signChallenge(challenge());
    expect(fake.signInAndSignMessage).toHaveBeenCalledWith({
      network: "mainnet",
      messageParams: {
        message: "pilot quote-bound challenge",
        recipient: "pilot.near",
        nonce: expect.any(Uint8Array),
      },
    });
    expect(fake.signInAndSignMessage.mock.calls[0]?.[0]).not.toHaveProperty(
      "addFunctionCallKey",
    );
    expect(fake.signMessage).not.toHaveBeenCalled();
  });

  it("ignores an injected lookalike and rejects cross-account proofs", async () => {
    vi.stubGlobal("window", {});
    const fake = runtime({
      injectedFirst: true,
      accounts: [{ accountId: "alice.near" }],
      signedAccountId: "mallory.near",
    });
    const adapter = await createPilotNearConnectAdapter({
      enabled: true,
      runtimeLoader: fake.loader,
    });

    await expect(adapter.signChallenge(challenge())).rejects.toThrow(
      "different or invalid NEAR account",
    );
    expect(fake.signMessage).toHaveBeenCalledOnce();
  });

  it("rejects injected/parent-frame lookalikes and stale challenge material", async () => {
    vi.stubGlobal("window", {});
    const injectedOnly = runtime({ omitPinned: true });
    const unavailable = await createPilotNearConnectAdapter({
      enabled: true,
      runtimeLoader: injectedOnly.loader,
    });
    await expect(unavailable.signChallenge(challenge())).rejects.toThrow(
      "pinned NEAR wallet executor is unavailable",
    );

    const pinned = runtime({ accounts: [{ accountId: "alice.near" }] });
    const adapter = await createPilotNearConnectAdapter({
      enabled: true,
      runtimeLoader: pinned.loader,
    });
    await expect(adapter.signChallenge({
      ...challenge(),
      expiresAt: new Date(Date.now() - 1).toISOString(),
    })).rejects.toThrow("invalid or expired");
    await expect(adapter.signChallenge({
      ...challenge(),
      nonce: "short",
    })).rejects.toThrow("nonce is invalid");
    expect(pinned.getAccounts).not.toHaveBeenCalled();
    expect(Object.keys(adapter)).toEqual(["signChallenge"]);
  });

  it("publishes the exact allowlist and omitted transaction surfaces", () => {
    expect(resolveNearConnectAdapterStatus(true)).toMatchObject({
      state: "ready",
      canConstruct: true,
      canPrompt: true,
    });
    expect(NEAR_CONNECT_CONSTRUCTION_POLICY.allowedWalletIds).toEqual([
      "mynearwallet",
    ]);
    expect(NEAR_CONNECT_CONSTRUCTION_POLICY.omittedCapabilities).toEqual([
      "signIn",
      "addFunctionCallKey",
      "signTransaction",
      "signAndSendTransaction",
      "signAndSendTransactions",
      "signDelegateActions",
    ]);
  });

  it("bounds manifest and wallet calls and accepts caller cancellation", async () => {
    vi.stubGlobal("window", {});
    const pending = new Promise<void>(() => undefined);
    await expect(createPilotNearConnectAdapter({
      enabled: true,
      runtimeLoader: runtime({ manifestPromise: pending }).loader,
      timeoutMs: 5,
    })).rejects.toThrow("pinned manifest load timed out");

    const controller = new AbortController();
    const creating = createPilotNearConnectAdapter({
      enabled: true,
      runtimeLoader: runtime({ manifestPromise: pending }).loader,
      signal: controller.signal,
    });
    controller.abort();
    await expect(creating).rejects.toMatchObject({ name: "AbortError" });

    const walletPending = new Promise<Array<{ accountId: string }>>(() => undefined);
    const adapter = await createPilotNearConnectAdapter({
      enabled: true,
      runtimeLoader: runtime({ accountsPromise: walletPending }).loader,
      timeoutMs: 5,
    });
    await expect(adapter.signChallenge(challenge())).rejects.toThrow(
      "wallet account read timed out",
    );
  });
});
