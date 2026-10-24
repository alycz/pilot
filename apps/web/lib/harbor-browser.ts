import { EnvelopeSchema, type Envelope } from "@pilot/contracts";
import {
  HarborArgsSchemas,
  HarborResultSchemas,
  MAX_HARBOR_RESPONSE_BYTES,
  MAX_X402_RESPONSE_BYTES,
  readBoundedResponseText,
  type ArgsFor,
  type HarborClient,
  type HarborOpName,
  type ResultFor,
} from "@pilot/harbor-client";
import { z } from "zod";
import { hashes } from "xrpl";
import { PILOT_ISOLATED_BUILD_MARKER } from "@pilot/wallet/isolation-profile";

export const LedgerPublicConfigSchema = z
  .object({
    enabled: z.boolean(),
    transports: z.array(z.enum(["webhid", "virtual"])).max(2),
    defaultAccountIndex: z.number().int().min(0).max(9),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.transports).size !== value.transports.length) {
      context.addIssue({ code: "custom", message: "Duplicate Ledger transport" });
    }
    if (value.enabled !== (value.transports.length > 0)) {
      context.addIssue({ code: "custom", message: "Ledger enabled state is inconsistent" });
    }
  });

export const PublicPilotConfigSchema = z
  .object({
    buildMarker: z.literal(PILOT_ISOLATED_BUILD_MARKER).optional(),
    network: z.enum(["testnet", "devnet"]),
    stableAsset: z
      .object({
        currency: z.string().trim().min(1).max(40),
        issuer: z.string().regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/),
      })
      .strict(),
    devSignerEnabled: z.boolean(),
    walletActionProofRequired: z.boolean(),
    walletActionProofConfigured: z.boolean(),
    mockMode: z.boolean(),
    ledger: LedgerPublicConfigSchema.optional(),
    structuredPreferencesEnabled: z.literal(true).optional(),
  })
  .strict();

export type PublicPilotConfig = z.infer<typeof PublicPilotConfigSchema>;

export const WalletSessionStatusSchema = z.discriminatedUnion("authenticated", [
  z.object({ authenticated: z.literal(false) }).strict(),
  z.object({
    authenticated: z.literal(true),
    account: z.string().regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/),
    network: z.enum(["testnet", "devnet"]),
    expiresAt: z.number().int().positive().optional(),
  }).strict(),
]);

export type WalletSessionStatus = z.infer<typeof WalletSessionStatusSchema>;
export const WALLET_SESSION_CHANGED_EVENT = "pilot:wallet-session-changed";
export const WALLET_ACTION_CHALLENGE_HEADER = "x-pilot-wallet-action-challenge";
export const WALLET_ACTION_PROOF_HEADER = "x-pilot-wallet-action-proof";

function notifyWalletSessionChanged(): void {
  if (typeof globalThis.dispatchEvent === "function" && typeof globalThis.Event === "function") {
    globalThis.dispatchEvent(new Event(WALLET_SESSION_CHANGED_EVENT));
  }
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
}

async function browserRequestDigest(body: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export async function createChatWalletActionProof(
  wallet: { signOnly(txJson: Record<string, unknown>): Promise<string> },
  account: string,
  network: "testnet" | "devnet",
  requestBody: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Record<string, string>> {
  const response = await fetchImpl("/api/auth/wallet/action-challenge", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      action: "chat",
      request_digest: await browserRequestDigest(requestBody),
    }),
    cache: "no-store",
    credentials: "same-origin",
  });
  const challenge = await response.json().catch(() => undefined) as
    | {
      account?: unknown;
      challenge?: unknown;
      error?: unknown;
      network?: unknown;
      tx_json?: unknown;
    }
    | undefined;
  if (
    !response.ok ||
    challenge?.account !== account ||
    challenge.network !== network ||
    typeof challenge.challenge !== "string" ||
    challenge.challenge.length === 0 ||
    !challenge.tx_json ||
    typeof challenge.tx_json !== "object" ||
    Array.isArray(challenge.tx_json)
  ) {
    throw new Error(
      typeof challenge?.error === "string"
        ? challenge.error
        : "Pilot could not create a fresh wallet action proof.",
    );
  }
  const txBlob = await wallet.signOnly(challenge.tx_json as Record<string, unknown>);
  return {
    [WALLET_ACTION_CHALLENGE_HEADER]: challenge.challenge,
    [WALLET_ACTION_PROOF_HEADER]: txBlob,
  };
}

export async function loadWalletSessionStatus(
  fetchImpl: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<WalletSessionStatus> {
  let response: Response;
  try {
    response = await fetchImpl("/api/auth/wallet/session", {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
      signal,
    });
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    throw new Error("Pilot's wallet session status is unavailable.");
  }

  if (!response.ok) {
    throw new Error("Pilot's wallet session status is unavailable.");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    payload = undefined;
  }
  const parsed = WalletSessionStatusSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Pilot's wallet session status is invalid.");
  }
  return parsed.data;
}

export async function bindWalletSession(
  wallet: { signOnly(txJson: Record<string, unknown>): Promise<string> },
  account: string,
  network: "testnet" | "devnet",
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
  const challengeResponse = await fetchImpl("/api/auth/wallet/challenge", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ account, network }),
    cache: "no-store",
    credentials: "same-origin",
  });
  const challenge = await challengeResponse.json().catch(() => undefined) as
    | { error?: string; tx_json?: Record<string, unknown> }
    | undefined;
  if (!challengeResponse.ok || !challenge?.tx_json) {
    throw new Error(challenge?.error || "Pilot could not create a wallet authorization challenge.");
  }
  const txBlob = await wallet.signOnly(challenge.tx_json);
  const sessionResponse = await fetchImpl("/api/auth/wallet/session", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ tx_blob: txBlob }),
    cache: "no-store",
    credentials: "same-origin",
  });
  const session = await sessionResponse.json().catch(() => undefined) as
    | { account?: string; authenticated?: boolean; error?: string; network?: string }
    | undefined;
  if (
    !sessionResponse.ok ||
    session?.authenticated !== true ||
    session.account !== account ||
    session.network !== network
  ) {
    throw new Error(session?.error || "Pilot could not verify wallet control.");
  }
  notifyWalletSessionChanged();
}

export async function clearWalletSession(
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
  const response = await fetchImpl("/api/auth/wallet/session", {
    method: "DELETE",
    headers: { accept: "application/json" },
    cache: "no-store",
    credentials: "same-origin",
  });
  const parsed = WalletSessionStatusSchema.safeParse(
    await response.json().catch(() => undefined),
  );
  if (!response.ok || !parsed.success || parsed.data.authenticated !== false) {
    throw new Error("Pilot could not clear the wallet authorization session.");
  }
  notifyWalletSessionChanged();
}

export class HarborBrowserError extends Error {
  constructor(
    message: string,
    readonly operation?: HarborOpName,
  ) {
    super(message);
    this.name = "HarborBrowserError";
  }
}

/**
 * Browser Harbor transport. The fixed relative URL is the credential boundary:
 * browsers can call only Pilot's same-origin proxy and can never configure or
 * receive a Harbor API key.
 */
export function createBrowserHarborClient(
  fetchImpl: typeof fetch = globalThis.fetch,
): HarborClient {
  return {
    async op<K extends HarborOpName>(
      name: K,
      args: ArgsFor<K>,
    ): Promise<Envelope<ResultFor<K>>> {
      const argsSchema = HarborArgsSchemas[name] as z.ZodType<ArgsFor<K>>;
      const validatedArgs = argsSchema.safeParse(args);
      if (!validatedArgs.success) {
        throw new HarborBrowserError("The Harbor request arguments are invalid.", name);
      }
      if (name === "x402.pay") {
        throw new HarborBrowserError(
          "x402 payment requires a fresh wallet action proof through Pilot chat.",
          name,
        );
      }

      let response: Response;
      try {
        response = await fetchImpl(`/api/harbor/${encodeURIComponent(name)}`, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify(validatedArgs.data),
          cache: "no-store",
          credentials: "same-origin",
        });
      } catch {
        throw new HarborBrowserError("Pilot could not reach the Harbor proxy.", name);
      }

      let payload: unknown;
      try {
        const text = await readBoundedResponseText(
          response,
          name === "x402.pay" ? MAX_X402_RESPONSE_BYTES : MAX_HARBOR_RESPONSE_BYTES,
        );
        payload = JSON.parse(text);
      } catch {
        throw new HarborBrowserError(
          "The Harbor proxy returned invalid or oversized JSON.",
          name,
        );
      }

      const envelope = EnvelopeSchema(HarborResultSchemas[name]).safeParse(payload);
      if (!envelope.success) {
        throw new HarborBrowserError("The Harbor proxy returned an invalid response.", name);
      }
      if (envelope.data.ok) {
        const result = envelope.data.data as { hash?: unknown; status?: unknown };
        if (
          name === "tx.status" &&
          typeof result.hash === "string" &&
          result.hash.toUpperCase() !== String((args as { hash: string }).hash).toUpperCase()
        ) {
          throw new HarborBrowserError("The Harbor proxy returned a mismatched transaction hash.", name);
        }
        if (name === "tx.submit" && typeof result.hash === "string") {
          let expectedHash: string;
          try {
            expectedHash = hashes.hashSignedTx((args as { tx_blob: string }).tx_blob).toUpperCase();
          } catch {
            throw new HarborBrowserError("The signed transaction blob is invalid.", name);
          }
          if (typeof result.hash !== "string" || result.hash.toUpperCase() !== expectedHash) {
            throw new HarborBrowserError("The Harbor proxy returned a mismatched transaction hash.", name);
          }
        }
      }

      return envelope.data as Envelope<ResultFor<K>>;
    },
  };
}

export async function loadPublicPilotConfig(
  fetchImpl: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<PublicPilotConfig> {
  let response: Response;
  try {
    response = await fetchImpl("/api/config/public", {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
      signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new Error("Pilot's public test-network configuration is unavailable.");
  }

  if (!response.ok) {
    throw new Error("Pilot's public test-network configuration is unavailable.");
  }

  const parsed = PublicPilotConfigSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) {
    throw new Error("Pilot's public test-network configuration is invalid.");
  }
  return parsed.data;
}
