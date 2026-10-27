import { createHash, createHmac } from "node:crypto";

import {
  createHarborHostedStateClientFromEnv,
  type HarborHostedStateClient,
  type HostedStateClientDependencies,
  type HostedStateEnvironment,
} from "./harbor-hosted-state-client";
import {
  FileWalletActionProofConsumer,
  type WalletActionProofConsumer,
} from "./wallet-action-proof";
import type { NearWalletProofReplayConsumer } from "./near-wallet-proof";
import type { WalletSession } from "./wallet-session";

export type WalletActionProofNamespace = "chat" | "wallet-auth";

export type WalletActionProofConsumerEnvironment = HostedStateEnvironment & Readonly<{
  P_LIVE_RLUSD_ACQUISITION_STATE_DIR?: string;
  SESSION_SECRET?: string;
}>;

const SCOPE_DOMAIN = "pilot.hosted-state.wallet-proof-scope.v1";
const NEAR_SCOPE_DOMAIN = "pilot.hosted-state.near-wallet-auth-scope.v1";
const NEAR_NAMESPACE = "near-wallet-auth" as const;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NEAR_ACCOUNT_ID = /^[a-z0-9._-]{2,64}$/;
const NEAR_NONCE = /^[A-Za-z0-9_-]{43}$/;

function sessionSecret(environment: WalletActionProofConsumerEnvironment): string {
  const secret = environment.SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error("Wallet action proof replay protection is unavailable.");
  }
  return secret;
}

export function deriveHostedWalletProofScopeId(
  session: WalletSession,
  namespace: WalletActionProofNamespace,
  secret: string,
): string {
  if (secret.trim().length < 32) {
    throw new Error("Wallet action proof replay protection is unavailable.");
  }
  return createHmac("sha256", secret)
    .update(SCOPE_DOMAIN, "utf8").update("\0", "utf8")
    .update(namespace, "utf8").update("\0", "utf8")
    .update(session.account, "utf8").update("\0", "utf8")
    .update(session.network, "utf8").update("\0", "utf8")
    .update(String(session.expiresAt), "utf8")
    .digest("hex");
}

export class HarborWalletActionProofConsumer implements WalletActionProofConsumer {
  constructor(
    private readonly client: Pick<HarborHostedStateClient, "consumeWalletProof">,
    private readonly namespace: WalletActionProofNamespace,
    private readonly scopeId: string,
  ) {}

  async consume(nonce: string, expiresAt: number, now: number): Promise<boolean> {
    if (!Number.isSafeInteger(now) || now < 1 ||
      !Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
    const nonceDigest = createHash("sha256").update(nonce, "utf8").digest("hex");
    const response = await this.client.consumeWalletProof({
      version: 1,
      namespace: this.namespace,
      scopeId: this.scopeId,
      nonceDigest,
      expiresAtMs: expiresAt,
    });
    return response.consumed;
  }
}

export type NearWalletProofReplayBinding = Readonly<{
  principalId: string;
  accountId: string;
  network: "near:mainnet";
  authorizationId: string;
  recipient: string;
}>;

function assertNearReplayBinding(binding: NearWalletProofReplayBinding): void {
  if (
    !SAFE_IDENTIFIER.test(binding.principalId) ||
    !SAFE_IDENTIFIER.test(binding.authorizationId) ||
    !NEAR_ACCOUNT_ID.test(binding.accountId) ||
    !NEAR_ACCOUNT_ID.test(binding.recipient) ||
    binding.network !== "near:mainnet"
  ) {
    throw new Error("NEAR wallet proof replay protection is unavailable.");
  }
}

export function deriveHostedNearWalletProofScopeId(
  binding: NearWalletProofReplayBinding,
  secret: string,
): string {
  assertNearReplayBinding(binding);
  if (secret.trim().length < 32) {
    throw new Error("NEAR wallet proof replay protection is unavailable.");
  }
  return createHmac("sha256", secret)
    .update(NEAR_SCOPE_DOMAIN, "utf8").update("\0", "utf8")
    .update(NEAR_NAMESPACE, "utf8").update("\0", "utf8")
    .update(binding.principalId, "utf8").update("\0", "utf8")
    .update(binding.accountId, "utf8").update("\0", "utf8")
    .update(binding.network, "utf8").update("\0", "utf8")
    .update(binding.authorizationId, "utf8").update("\0", "utf8")
    .update(binding.recipient, "utf8")
    .digest("hex");
}

function exactNearNonce(nonce: string): boolean {
  if (!NEAR_NONCE.test(nonce)) return false;
  try {
    const decoded = Buffer.from(nonce, "base64url");
    return decoded.length === 32 && decoded.toString("base64url") === nonce;
  } catch {
    return false;
  }
}

export class HarborNearWalletProofReplayConsumer implements NearWalletProofReplayConsumer {
  readonly #scopeId: string;
  readonly #binding: NearWalletProofReplayBinding;

  constructor(
    private readonly client: Pick<HarborHostedStateClient, "consumeWalletProof">,
    binding: NearWalletProofReplayBinding,
    secret: string,
  ) {
    this.#binding = Object.freeze({ ...binding });
    this.#scopeId = deriveHostedNearWalletProofScopeId(this.#binding, secret);
  }

  async consume(input: Readonly<{
    principalId: string;
    accountId: string;
    network: "near:mainnet";
    authorizationId: string;
    recipient: string;
    nonce: string;
    expiresAt: number;
    now: number;
  }>): Promise<boolean> {
    if (
      input.principalId !== this.#binding.principalId ||
      input.accountId !== this.#binding.accountId ||
      input.network !== this.#binding.network ||
      input.authorizationId !== this.#binding.authorizationId ||
      input.recipient !== this.#binding.recipient ||
      !exactNearNonce(input.nonce) ||
      !Number.isSafeInteger(input.now) ||
      input.now < 1 ||
      !Number.isSafeInteger(input.expiresAt) ||
      input.expiresAt <= input.now
    ) {
      return false;
    }
    const nonceDigest = createHash("sha256").update(input.nonce, "utf8").digest("hex");
    const response = await this.client.consumeWalletProof({
      version: 1,
      namespace: NEAR_NAMESPACE,
      scopeId: this.#scopeId,
      nonceDigest,
      expiresAtMs: input.expiresAt,
    });
    return response.consumed;
  }
}

export function createHostedNearWalletProofReplayConsumer(
  binding: NearWalletProofReplayBinding,
  environment: WalletActionProofConsumerEnvironment = process.env,
  dependencies: HostedStateClientDependencies = {},
): NearWalletProofReplayConsumer {
  if (environment.PILOT_DEPLOYMENT_PROFILE !== "hosted") {
    throw new Error("NEAR wallet proof replay protection is unavailable.");
  }
  return new HarborNearWalletProofReplayConsumer(
    createHarborHostedStateClientFromEnv(environment, dependencies),
    binding,
    sessionSecret(environment),
  );
}

class NamespacedFileWalletActionProofConsumer implements WalletActionProofConsumer {
  private readonly consumer: FileWalletActionProofConsumer;

  constructor(
    directory: string | undefined,
    private readonly namespace: WalletActionProofNamespace,
  ) {
    this.consumer = new FileWalletActionProofConsumer(
      directory,
      namespace === "wallet-auth" ? "wallet-auth-proofs-v1" : undefined,
    );
  }

  consume(nonce: string, expiresAt: number, now: number): Promise<boolean> {
    const localNonce = this.namespace === "wallet-auth" ? `wallet-auth:${nonce}` : nonce;
    return this.consumer.consume(localNonce, expiresAt, now);
  }
}

export function createWalletActionProofConsumer(
  session: WalletSession,
  namespace: WalletActionProofNamespace,
  environment: WalletActionProofConsumerEnvironment = process.env,
  dependencies: HostedStateClientDependencies = {},
): WalletActionProofConsumer {
  if (environment.PILOT_DEPLOYMENT_PROFILE === "hosted") {
    const secret = sessionSecret(environment);
    return new HarborWalletActionProofConsumer(
      createHarborHostedStateClientFromEnv(environment, dependencies),
      namespace,
      deriveHostedWalletProofScopeId(session, namespace, secret),
    );
  }
  if (
    environment.PILOT_DEPLOYMENT_PROFILE !== "local-wallet" &&
    environment.PILOT_DEPLOYMENT_PROFILE !== "local-wallet-isolated-v1"
  ) {
    throw new Error("Wallet action proof replay protection is unavailable.");
  }
  return new NamespacedFileWalletActionProofConsumer(
    environment.P_LIVE_RLUSD_ACQUISITION_STATE_DIR,
    namespace,
  );
}
