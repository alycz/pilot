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
import type { WalletSession } from "./wallet-session";

export type WalletActionProofNamespace = "chat" | "wallet-auth";

export type WalletActionProofConsumerEnvironment = HostedStateEnvironment & Readonly<{
  P_LIVE_RLUSD_ACQUISITION_STATE_DIR?: string;
  SESSION_SECRET?: string;
}>;

const SCOPE_DOMAIN = "pilot.hosted-state.wallet-proof-scope.v1";

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
