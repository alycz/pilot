import { createHash, createHmac } from "node:crypto";

import {
  createHarborHostedStateClientFromEnv,
  type HarborHostedStateClient,
  type HostedStateClientDependencies,
  type HostedStateEnvironment,
} from "./harbor-hosted-state-client";
import type {
  NearExecutableReviewNonceConsumer,
  NearExecutableReviewNonceConsumption,
} from "./near-executable-review-proof";
import type {
  NearExecutableReviewWalletControlConsumer,
  NearExecutableReviewWalletControlConsumption,
} from "./near-executable-review-wallet-control";

const SCOPE_DOMAIN =
  "pilot.hosted-state.near-executable-review-proof-scope.v1";
const WALLET_CONTROL_SCOPE_DOMAIN =
  "pilot.hosted-state.near-native-wallet-control-scope.v1";
const NAMESPACE = "near-wallet-auth" as const;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NEAR_ACCOUNT_ID = /^[a-z0-9._-]{2,64}$/;
const LOWER_HEX_64 = /^[a-f0-9]{64}$/;
const CANONICAL_NONCE = /^[A-Za-z0-9_-]{43}$/;

export type NearExecutableReviewReplayEnvironment = HostedStateEnvironment &
  Readonly<{ SESSION_SECRET?: string }>;

export type NearExecutableReviewReplayBinding = Readonly<{
  principalId: string;
  accountId: string;
  network: "near:mainnet";
  authorizationId: string;
  quoteDigest: string;
  recipient: string;
}>;

function exactBinding(binding: NearExecutableReviewReplayBinding): void {
  if (
    !SAFE_IDENTIFIER.test(binding.principalId) ||
    !SAFE_IDENTIFIER.test(binding.authorizationId) ||
    !NEAR_ACCOUNT_ID.test(binding.accountId) ||
    !NEAR_ACCOUNT_ID.test(binding.recipient) ||
    binding.network !== "near:mainnet" ||
    !LOWER_HEX_64.test(binding.quoteDigest)
  ) {
    throw new Error("Executable-review replay protection is unavailable.");
  }
}

function sessionSecret(environment: NearExecutableReviewReplayEnvironment): string {
  const value = environment.SESSION_SECRET?.trim();
  if (!value || value.length < 32) {
    throw new Error("Executable-review replay protection is unavailable.");
  }
  return value;
}

function canonicalNonce(value: string): boolean {
  if (!CANONICAL_NONCE.test(value)) return false;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === 32 && decoded.toString("base64url") === value;
  } catch {
    return false;
  }
}

export function deriveHostedNearExecutableReviewScopeId(
  binding: NearExecutableReviewReplayBinding,
  secret: string,
): string {
  exactBinding(binding);
  if (secret.trim().length < 32) {
    throw new Error("Executable-review replay protection is unavailable.");
  }
  return createHmac("sha256", secret)
    .update(SCOPE_DOMAIN, "utf8").update("\0", "utf8")
    .update(NAMESPACE, "utf8").update("\0", "utf8")
    .update(binding.principalId, "utf8").update("\0", "utf8")
    .update(binding.accountId, "utf8").update("\0", "utf8")
    .update(binding.network, "utf8").update("\0", "utf8")
    .update(binding.authorizationId, "utf8").update("\0", "utf8")
    .update(binding.quoteDigest, "utf8").update("\0", "utf8")
    .update(binding.recipient, "utf8")
    .digest("hex");
}

export class HarborNearExecutableReviewNonceConsumer
  implements NearExecutableReviewNonceConsumer {
  readonly #binding: NearExecutableReviewReplayBinding;
  readonly #scopeId: string;

  constructor(
    private readonly client: Pick<HarborHostedStateClient, "consumeWalletProof">,
    binding: NearExecutableReviewReplayBinding,
    secret: string,
  ) {
    this.#binding = Object.freeze({ ...binding });
    this.#scopeId = deriveHostedNearExecutableReviewScopeId(binding, secret);
  }

  async consume(input: NearExecutableReviewNonceConsumption): Promise<boolean> {
    if (
      input.version !== "pilot-near-executable-review-nonce-v1" ||
      input.principalId !== this.#binding.principalId ||
      input.accountId !== this.#binding.accountId ||
      input.network !== this.#binding.network ||
      input.authorizationId !== this.#binding.authorizationId ||
      input.operation !== "near.intents.executable-quote.review" ||
      input.quoteDigest !== this.#binding.quoteDigest ||
      input.recipient !== this.#binding.recipient ||
      !canonicalNonce(input.nonce) ||
      !Number.isSafeInteger(input.now) || input.now < 1 ||
      !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= input.now
    ) {
      return false;
    }
    const response = await this.client.consumeWalletProof({
      version: 1,
      namespace: NAMESPACE,
      scopeId: this.#scopeId,
      nonceDigest: createHash("sha256")
        .update(input.nonce, "utf8")
        .digest("hex"),
      expiresAtMs: input.expiresAt,
    });
    return response.consumed;
  }
}

export function createHostedNearExecutableReviewNonceConsumer(
  binding: NearExecutableReviewReplayBinding,
  environment: NearExecutableReviewReplayEnvironment = process.env,
  dependencies: HostedStateClientDependencies = {},
): NearExecutableReviewNonceConsumer {
  if (environment.PILOT_DEPLOYMENT_PROFILE !== "hosted") {
    throw new Error("Executable-review replay protection is unavailable.");
  }
  return new HarborNearExecutableReviewNonceConsumer(
    createHarborHostedStateClientFromEnv(environment, dependencies),
    binding,
    sessionSecret(environment),
  );
}

export class HarborNearExecutableReviewWalletControlConsumer
  implements NearExecutableReviewWalletControlConsumer {
  readonly #binding: NearExecutableReviewReplayBinding;
  readonly #scopeId: string;

  constructor(
    private readonly client: Pick<HarborHostedStateClient, "consumeWalletProof">,
    binding: NearExecutableReviewReplayBinding,
    secret: string,
  ) {
    this.#binding = Object.freeze({ ...binding });
    exactBinding(binding);
    this.#scopeId = createHmac("sha256", secret)
      .update(WALLET_CONTROL_SCOPE_DOMAIN, "utf8").update("\0", "utf8")
      .update(NAMESPACE, "utf8").update("\0", "utf8")
      .update(binding.principalId, "utf8").update("\0", "utf8")
      .update(binding.accountId, "utf8").update("\0", "utf8")
      .update(binding.network, "utf8").update("\0", "utf8")
      .update(binding.authorizationId, "utf8").update("\0", "utf8")
      .update(binding.quoteDigest, "utf8")
      .digest("hex");
  }

  async consume(
    input: NearExecutableReviewWalletControlConsumption,
  ): Promise<boolean> {
    if (
      input.version !== "pilot-near-native-wallet-control-consumption-v1" ||
      input.principalId !== this.#binding.principalId ||
      input.accountId !== this.#binding.accountId ||
      input.network !== this.#binding.network ||
      input.authorizationId !== this.#binding.authorizationId ||
      input.quoteDigest !== this.#binding.quoteDigest ||
      !canonicalNonce(input.oneTimeNonce) ||
      !Number.isSafeInteger(input.now) || input.now < 1 ||
      !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= input.now
    ) return false;
    const response = await this.client.consumeWalletProof({
      version: 1,
      namespace: NAMESPACE,
      scopeId: this.#scopeId,
      nonceDigest: createHash("sha256")
        .update(input.oneTimeNonce, "utf8")
        .digest("hex"),
      expiresAtMs: input.expiresAt,
    });
    return response.consumed;
  }
}

export function createHostedNearExecutableReviewWalletControlConsumer(
  binding: NearExecutableReviewReplayBinding,
  environment: NearExecutableReviewReplayEnvironment = process.env,
  dependencies: HostedStateClientDependencies = {},
): NearExecutableReviewWalletControlConsumer {
  if (environment.PILOT_DEPLOYMENT_PROFILE !== "hosted") {
    throw new Error("Executable-review wallet-control consumption is unavailable.");
  }
  return new HarborNearExecutableReviewWalletControlConsumer(
    createHarborHostedStateClientFromEnv(environment, dependencies),
    binding,
    sessionSecret(environment),
  );
}
