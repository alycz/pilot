import {
  NearApprovalBindingSchema,
  NearWalletConnectionSchema,
  NearWalletExecutionPolicySchema,
  computeNearApprovalDigest,
  type NearApprovalBinding,
  type NearWalletConnection,
  type NearWalletExecutionPolicy,
} from "@pilot/contracts";

const HashSchema = /^[A-F0-9]{64}$/;
const SafeOpaqueResult = /^.{1,8192}$/su;

/** Compatibility names for the wallet and UI boundary. */
export const NearIntentsApprovalEnvelopeSchema = NearApprovalBindingSchema;
export type NearIntentsApprovalEnvelope = NearApprovalBinding;
export const digestNearIntentsApproval = computeNearApprovalDigest;

export type NearWalletNetwork = NearWalletConnection["network"];
export type NearWalletSession = NearWalletConnection;

export type NearWalletApprovalRequest = Readonly<{
  envelope: NearApprovalBinding;
  approvalDigest: string;
}>;

export type NearWalletApprovalSignature = Readonly<{
  provider_id: string;
  account_id: string;
  network: NearWalletNetwork;
  /** Opaque provider result. Callers must never log or persist it as evidence. */
  signed_payload: string;
}>;

/**
 * Provider-neutral browser wallet boundary. Pilot supplies no network or SDK
 * implementation here; an explicitly configured adapter owns any wallet UI.
 */
export interface NearWalletAdapter {
  readonly providerId: string;
  isAvailable(): Promise<boolean>;
  connect(input: Readonly<{ network: NearWalletNetwork }>): Promise<NearWalletConnection>;
  disconnect(): Promise<void>;
  signApproval(request: NearWalletApprovalRequest): Promise<NearWalletApprovalSignature>;
}

export interface NearWallet {
  readonly providerId: string;
  readonly policy: NearWalletExecutionPolicy;
  connect(network: NearWalletNetwork): Promise<NearWalletConnection>;
  disconnect(): Promise<void>;
  session(): NearWalletConnection | undefined;
  signApproval(request: NearWalletApprovalRequest): Promise<NearWalletApprovalSignature>;
}

export type NearWalletErrorCode =
  | "NEAR_WALLET_UNAVAILABLE"
  | "NEAR_WALLET_SESSION_INVALID"
  | "NEAR_SIGNING_DISABLED"
  | "NEAR_APPROVAL_INVALID"
  | "NEAR_APPROVAL_DIGEST_MISMATCH"
  | "NEAR_APPROVAL_EXPIRED"
  | "NEAR_SIGNATURE_SCOPE_MISMATCH";

export class NearWalletError extends Error {
  constructor(readonly code: NearWalletErrorCode, message: string) {
    super(message);
    this.name = "NearWalletError";
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export async function verifyNearIntentsApproval(input: Readonly<{
  envelope: unknown;
  approvalDigest: unknown;
  now?: number;
}>): Promise<NearApprovalBinding> {
  const parsed = NearApprovalBindingSchema.safeParse(input.envelope);
  if (!parsed.success) {
    throw new NearWalletError(
      "NEAR_APPROVAL_INVALID",
      "The NEAR Intents approval binding is invalid.",
    );
  }
  if (typeof input.approvalDigest !== "string" || !HashSchema.test(input.approvalDigest)) {
    throw new NearWalletError(
      "NEAR_APPROVAL_DIGEST_MISMATCH",
      "The NEAR Intents approval digest is invalid.",
    );
  }
  const expected = await computeNearApprovalDigest(parsed.data);
  if (input.approvalDigest !== expected) {
    throw new NearWalletError(
      "NEAR_APPROVAL_DIGEST_MISMATCH",
      "The NEAR Intents approval digest does not commit to the reviewed quote.",
    );
  }
  const now = input.now ?? Date.now();
  if (
    Date.parse(parsed.data.approval_expires_at) <= now ||
    Date.parse(parsed.data.provider_deadline_at) <= now
  ) {
    throw new NearWalletError(
      "NEAR_APPROVAL_EXPIRED",
      "The Pilot approval expired or the provider refund deadline was reached.",
    );
  }
  return parsed.data;
}

/**
 * Create a guarded wallet facade. Connecting does not enable signing. Mainnet
 * signing requires the explicit owner-approval policy and a message-signing
 * capability reported by the exact connected wallet session.
 */
export function createNearWallet(
  adapter: NearWalletAdapter,
  options: Readonly<{ policy?: NearWalletExecutionPolicy }> = {},
): NearWallet {
  let connected: NearWalletConnection | undefined;
  const policy = NearWalletExecutionPolicySchema.parse(options.policy ?? {});

  return {
    providerId: adapter.providerId,
    policy,
    async connect(network) {
      if (!await adapter.isAvailable()) {
        throw new NearWalletError(
          "NEAR_WALLET_UNAVAILABLE",
          "The configured NEAR wallet provider is unavailable.",
        );
      }
      const parsed = NearWalletConnectionSchema.safeParse(
        await adapter.connect({ network }),
      );
      if (
        !parsed.success || parsed.data.provider_id !== adapter.providerId ||
        parsed.data.network !== network
      ) {
        throw new NearWalletError(
          "NEAR_WALLET_SESSION_INVALID",
          "The NEAR wallet session does not match the requested provider and network.",
        );
      }
      connected = Object.freeze(clone(parsed.data));
      return connected;
    },
    async disconnect() {
      try {
        await adapter.disconnect();
      } finally {
        connected = undefined;
      }
    },
    session() {
      return connected ? clone(connected) : undefined;
    },
    async signApproval(request) {
      if (policy.mode !== "owner-approval" || policy.mainnet_execution_enabled !== true) {
        throw new NearWalletError(
          "NEAR_SIGNING_DISABLED",
          "NEAR execution signing is disabled for this Pilot runtime.",
        );
      }
      if (!connected) {
        throw new NearWalletError(
          "NEAR_WALLET_SESSION_INVALID",
          "Connect the configured NEAR wallet before requesting a signature.",
        );
      }
      const envelope = await verifyNearIntentsApproval({
        envelope: request.envelope,
        approvalDigest: request.approvalDigest,
      });
      if (
        connected.network !== "near:mainnet" ||
        envelope.account_id !== connected.account_id ||
        connected.capabilities.sign_message !== true
      ) {
        throw new NearWalletError(
          "NEAR_SIGNATURE_SCOPE_MISMATCH",
          "This NEAR Intents approval requires its exact mainnet account and a message-signing wallet session.",
        );
      }
      const result = await adapter.signApproval({
        envelope: clone(envelope),
        approvalDigest: request.approvalDigest,
      });
      if (
        result.provider_id !== connected.provider_id ||
        result.account_id !== connected.account_id ||
        result.network !== connected.network ||
        !SafeOpaqueResult.test(result.signed_payload)
      ) {
        throw new NearWalletError(
          "NEAR_SIGNATURE_SCOPE_MISMATCH",
          "The NEAR wallet signature result does not match the connected session.",
        );
      }
      return Object.freeze(clone(result));
    },
  };
}

