import type {
  AccountWithSignedMessage,
  NearConnectorOptions,
  NearWalletBase,
  SignedMessage,
  WalletManifest,
} from "@hot-labs/near-connect";

export const NEAR_CONNECT_REQUIRED_PACKAGES = Object.freeze([
  "@hot-labs/near-connect@0.12.0",
] as const);
export const NEAR_CONNECT_MAX_WAIT_MS = 60_000;

export const PILOT_NEAR_CONNECT_WALLET_ID = "mynearwallet" as const;
export const PILOT_NEAR_CONNECT_EXECUTOR_COMMIT =
  "5385297f1ebd21af648c99fa347eac28ba55d462" as const;
export const PILOT_NEAR_CONNECT_EXECUTOR_URL =
  `https://raw.githubusercontent.com/azbang/near-connect/${PILOT_NEAR_CONNECT_EXECUTOR_COMMIT}/repository/mnw.js` as const;

const PILOT_WALLET_FEATURES = Object.freeze({
  signMessage: true,
  signTransaction: false,
  signAndSendTransaction: false,
  signAndSendTransactions: false,
  signInWithoutAddKey: true,
  signInAndSignMessage: true,
  signInWithFunctionCallKey: false,
  signDelegateActions: false,
  gasKeys: false,
  mainnet: true,
  testnet: false,
});

export const PILOT_NEAR_CONNECT_MANIFEST = Object.freeze({
  version: "pilot-near-connect-manifest-v1",
  wallets: Object.freeze([Object.freeze({
    id: PILOT_NEAR_CONNECT_WALLET_ID,
    platform: Object.freeze(["web"]),
    name: "MyNearWallet",
    icon: "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%3E%3Crect%20width%3D%2216%22%20height%3D%2216%22%20rx%3D%223%22%20fill%3D%22%23000%22%2F%3E%3Cpath%20d%3D%22M4%2012V4l8%208V4%22%20fill%3D%22none%22%20stroke%3D%22%23fff%22%20stroke-width%3D%221.5%22%2F%3E%3C%2Fsvg%3E",
    description: "Pinned MyNearWallet message-signing executor",
    website: "https://mynearwallet.com",
    version: `pilot-pinned-${PILOT_NEAR_CONNECT_EXECUTOR_COMMIT}`,
    executor: PILOT_NEAR_CONNECT_EXECUTOR_URL,
    type: "sandbox",
    permissions: Object.freeze({
      storage: true,
      allowsOpen: Object.freeze(["https://app.mynearwallet.com"]),
    }),
    features: PILOT_WALLET_FEATURES,
  })]),
});

export const NEAR_CONNECT_CONSTRUCTION_POLICY = Object.freeze({
  autoConnect: false as const,
  network: "mainnet" as const,
  maxWaitMs: NEAR_CONNECT_MAX_WAIT_MS,
  allowedWalletIds: Object.freeze([PILOT_NEAR_CONNECT_WALLET_ID] as const),
  omittedCapabilities: Object.freeze([
    "signIn",
    "addFunctionCallKey",
    "signTransaction",
    "signAndSendTransaction",
    "signAndSendTransactions",
    "signDelegateActions",
  ] as const),
  requiredFeatures: Object.freeze({
    signMessage: true as const,
    signInWithoutAddKey: true as const,
    signInAndSignMessage: true as const,
    mainnet: true as const,
  }),
  executorManifest: Object.freeze({
    source: "app-supplied-pinned-manifest" as const,
    mutableDefaultUrlsAllowed: false as const,
    wallet: PILOT_NEAR_CONNECT_WALLET_ID,
    repositoryCommit: PILOT_NEAR_CONNECT_EXECUTOR_COMMIT,
  }),
});

export type NearConnectAdapterStatus = Readonly<{
  state: "disabled" | "ready";
  canConstruct: boolean;
  canPrompt: boolean;
  requiredPackages: typeof NEAR_CONNECT_REQUIRED_PACKAGES;
  constructionPolicy: typeof NEAR_CONNECT_CONSTRUCTION_POLICY;
  notice: string;
}>;

export type NearConnectChallenge = Readonly<{
  accountId: string;
  message: string;
  nonce: string;
  recipient: string;
  expiresAt: string;
}>;

export type NearConnectMessageProof = Readonly<{
  account_id: string;
  public_key: string;
  signature: string;
}>;

type ConnectorLike = Readonly<{
  whenManifestLoaded: Promise<void>;
  wallets: NearWalletBase[];
}>;

type NearConnectRuntime = Readonly<{
  NearConnector: new (options: NearConnectorOptions) => ConnectorLike;
  SandboxWallet: abstract new (...args: never[]) => NearWalletBase;
}>;

export type NearConnectRuntimeLoader = () => Promise<NearConnectRuntime>;

export type PilotNearConnectAdapter = Readonly<{
  signChallenge: (
    challenge: NearConnectChallenge,
    signal?: AbortSignal,
  ) => Promise<NearConnectMessageProof>;
}>;

const defaultRuntimeLoader: NearConnectRuntimeLoader = async () => {
  const runtime = await import("@hot-labs/near-connect");
  return {
    NearConnector: runtime.NearConnector,
    SandboxWallet: runtime.SandboxWallet,
  };
};

export function resolveNearConnectAdapterStatus(
  featureEnabled: boolean,
): NearConnectAdapterStatus {
  return Object.freeze({
    state: featureEnabled ? "ready" : "disabled",
    canConstruct: featureEnabled,
    canPrompt: featureEnabled,
    requiredPackages: NEAR_CONNECT_REQUIRED_PACKAGES,
    constructionPolicy: NEAR_CONNECT_CONSTRUCTION_POLICY,
    notice: featureEnabled
      ? "Near Connect is available only after an explicit owner click and uses Pilot's commit-pinned sandbox executor manifest."
      : "The browser NEAR wallet adapter is disabled. No wallet prompt can open.",
  });
}

function connectorOptions(): NearConnectorOptions {
  return {
    autoConnect: false,
    network: "mainnet",
    features: { ...NEAR_CONNECT_CONSTRUCTION_POLICY.requiredFeatures },
    manifest: {
      version: PILOT_NEAR_CONNECT_MANIFEST.version,
      wallets: PILOT_NEAR_CONNECT_MANIFEST.wallets.map((wallet) => ({
        ...wallet,
        platform: [...wallet.platform],
        permissions: {
          ...wallet.permissions,
          allowsOpen: [...wallet.permissions.allowsOpen],
        },
        features: { ...wallet.features },
      })) as WalletManifest[],
    },
    footerBranding: null,
  };
}

function exactPinnedManifest(manifest: WalletManifest): boolean {
  const pinned = PILOT_NEAR_CONNECT_MANIFEST.wallets[0];
  return manifest.id === pinned.id
    && manifest.type === "sandbox"
    && manifest.executor === pinned.executor
    && manifest.version === pinned.version
    && manifest.features.signMessage === true
    && manifest.features.signInWithoutAddKey === true
    && manifest.features.signInAndSignMessage === true
    && manifest.features.mainnet === true
    && manifest.features.signTransaction === false
    && manifest.features.signAndSendTransaction === false
    && manifest.features.signAndSendTransactions === false
    && manifest.features.signInWithFunctionCallKey === false
    && manifest.features.signDelegateActions === false
    && manifest.features.testnet === false;
}

function decodeNonce(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error("The NEP-413 challenge nonce is invalid.");
  }
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = globalThis.atob(base64.padEnd(44, "="));
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    if (bytes.length !== 32) throw new Error("invalid nonce length");
    return bytes;
  } catch {
    throw new Error("The NEP-413 challenge nonce is invalid.");
  }
}

function proofFor(expectedAccountId: string, signed: SignedMessage): NearConnectMessageProof {
  if (
    signed.accountId !== expectedAccountId
    || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,45}$/.test(signed.publicKey)
    || !/^[A-Za-z0-9+/]{86}==$/.test(signed.signature)
  ) {
    throw new Error("The wallet returned a proof for a different or invalid NEAR account.");
  }
  return Object.freeze({
    account_id: signed.accountId,
    public_key: signed.publicKey,
    signature: signed.signature,
  });
}

async function boundedWalletCall<T>(
  promise: Promise<T>,
  input: Readonly<{
    signal?: AbortSignal;
    timeoutMs: number;
    label: string;
  }>,
): Promise<T> {
  const timeoutMs = Math.min(
    Math.max(1, input.timeoutMs),
    NEAR_CONNECT_MAX_WAIT_MS,
  );
  if (input.signal?.aborted) {
    throw new DOMException(`${input.label} was cancelled.`, "AbortError");
  }
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(
      new DOMException(`${input.label} was cancelled.`, "AbortError"),
    ));
    const timeout = setTimeout(() => finish(() => reject(
      new Error(`${input.label} timed out.`),
    )), timeoutMs);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (cause) => finish(() => reject(cause)),
    );
  });
}

/** Constructed only after an explicit caller action; exposes message signing only. */
export async function createPilotNearConnectAdapter(input: Readonly<{
  enabled: boolean;
  runtimeLoader?: NearConnectRuntimeLoader;
  signal?: AbortSignal;
  timeoutMs?: number;
}>): Promise<PilotNearConnectAdapter> {
  if (!input.enabled) {
    throw new Error("The browser NEAR wallet adapter is disabled.");
  }
  if (typeof window === "undefined") {
    throw new Error("The browser NEAR wallet adapter is unavailable outside a browser.");
  }
  const timeoutMs = input.timeoutMs ?? NEAR_CONNECT_MAX_WAIT_MS;
  const runtime = await boundedWalletCall(
    (input.runtimeLoader ?? defaultRuntimeLoader)(),
    { signal: input.signal, timeoutMs, label: "Near Connect initialization" },
  );
  const connector = new runtime.NearConnector(connectorOptions());
  await boundedWalletCall(connector.whenManifestLoaded, {
    signal: input.signal,
    timeoutMs,
    label: "Near Connect pinned manifest load",
  });

  async function pinnedWallet(): Promise<NearWalletBase> {
    const wallets = connector.wallets.filter((wallet) =>
      wallet instanceof runtime.SandboxWallet
      && exactPinnedManifest(wallet.manifest)
      && wallet.manifest.id === PILOT_NEAR_CONNECT_WALLET_ID);
    if (wallets.length !== 1) {
      throw new Error("The pinned NEAR wallet executor is unavailable or ambiguous.");
    }
    return wallets[0];
  }

  return Object.freeze({
    async signChallenge(challenge, signal): Promise<NearConnectMessageProof> {
      if (
        !/^[a-z0-9._-]{2,64}$/.test(challenge.accountId)
        || !/^[a-z0-9._-]{2,64}$/.test(challenge.recipient)
        || !challenge.message
        || Date.parse(challenge.expiresAt) <= Date.now()
      ) {
        throw new Error("The NEP-413 challenge is invalid or expired.");
      }
      const nonce = decodeNonce(challenge.nonce);
      const wallet = await pinnedWallet();
      const accounts = await boundedWalletCall(
        wallet.getAccounts({ network: "mainnet" }),
        { signal, timeoutMs, label: "NEAR wallet account read" },
      );
      if (accounts.some(({ accountId }) => accountId === challenge.accountId)) {
        return proofFor(challenge.accountId, await boundedWalletCall(
          wallet.signMessage({
            message: challenge.message,
            recipient: challenge.recipient,
            nonce,
            network: "mainnet",
            signerId: challenge.accountId,
          }),
          { signal, timeoutMs, label: "NEP-413 wallet signature" },
        ));
      }

      const signedAccounts: AccountWithSignedMessage[] =
        await boundedWalletCall(wallet.signInAndSignMessage({
            network: "mainnet",
            messageParams: {
              message: challenge.message,
              recipient: challenge.recipient,
              nonce,
            },
          }),
          { signal, timeoutMs, label: "NEP-413 wallet sign-in proof" },
        );
      const exact = signedAccounts.find(({ accountId }) =>
        accountId === challenge.accountId);
      if (!exact) {
        throw new Error("The wallet did not authorize the expected NEAR account.");
      }
      return proofFor(challenge.accountId, exact.signedMessage);
    },
  });
}
