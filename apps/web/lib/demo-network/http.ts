import { isValidClassicAddress } from "xrpl";

import { resolvePilotRequestAuthority } from "../runtime-profile";
import { authorizeWalletResource } from "../wallet-authorization";

import {
  DemoNetworkError,
  demoNetworkErrorResponse,
  requireDemoNetworkEnabled,
  requireTestnetSubject,
} from "./guard";
import {
  issueCredential,
  revokeCredential,
  type CredentialDependencies,
  type PublicCredentialResult,
} from "./credential";
import {
  issueViL1,
  parsePrivateIssuerJwk,
  publicIssuerJwk,
  type IssuedViL1,
  type ViL1Input,
} from "./vi";

type JsonRecord = Record<string, unknown>;

function strictRecord(value: unknown, keys: string[]): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DemoNetworkError("INVALID_REQUEST", 400, "Invalid request body.");
  }
  const record = value as JsonRecord;
  if (Object.keys(record).some((key) => !keys.includes(key))) {
    throw new DemoNetworkError("INVALID_REQUEST", 400, "Invalid request body.");
  }
  return record;
}

async function json(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new DemoNetworkError("INVALID_REQUEST", 400, "Invalid request body.");
  }
}

function ok(body: unknown): Response {
  return Response.json(body, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}

function requireSameOriginWallet(
  request: Request,
  account: string,
  env: NodeJS.ProcessEnv,
): void {
  let expectedOrigin: string;
  try {
    expectedOrigin = resolvePilotRequestAuthority(env, request).origin;
  } catch {
    throw new DemoNetworkError(
      "DEMO_NETWORK_FORBIDDEN_ORIGIN",
      403,
      "Same-origin demo network access is required.",
    );
  }
  if (request.headers.get("origin") !== expectedOrigin) {
    throw new DemoNetworkError(
      "DEMO_NETWORK_FORBIDDEN_ORIGIN",
      403,
      "Same-origin demo network access is required.",
    );
  }
  if (!authorizeWalletResource(request, account, "testnet", env)) {
    throw new DemoNetworkError(
      "DEMO_NETWORK_UNAUTHORIZED",
      401,
      "A wallet session bound to this Testnet account is required.",
    );
  }
}

export interface CredentialRouteDependencies {
  env: NodeJS.ProcessEnv;
  issue(
    input: { demoUrl: string; subject: string },
    overrides?: Partial<CredentialDependencies>,
  ): Promise<PublicCredentialResult>;
  revoke(
    subject: string,
    overrides?: Partial<CredentialDependencies>,
  ): Promise<PublicCredentialResult>;
  validateAddress(address: string): boolean;
}

const defaultCredentialDependencies: CredentialRouteDependencies = {
  env: process.env,
  issue: issueCredential,
  revoke: revokeCredential,
  validateAddress: isValidClassicAddress,
};

export function createCredentialIssueHandler(
  overrides: Partial<CredentialRouteDependencies> = {},
): (request: Request) => Promise<Response> {
  const dependencies = { ...defaultCredentialDependencies, ...overrides };
  return async (request) => {
    try {
      requireDemoNetworkEnabled(dependencies.env);
      const body = strictRecord(await json(request), ["subject"]);
      const subject = requireTestnetSubject(
        body.subject,
        dependencies.validateAddress,
      );
      requireSameOriginWallet(request, subject, dependencies.env);
      const demoUrl = new URL("/demo/ap4m", request.url).toString();
      return ok(
        await dependencies.issue(
          { demoUrl, subject },
          { env: dependencies.env },
        ),
      );
    } catch (error) {
      return demoNetworkErrorResponse(error);
    }
  };
}

export function createCredentialRevokeHandler(
  overrides: Partial<CredentialRouteDependencies> = {},
): (request: Request) => Promise<Response> {
  const dependencies = { ...defaultCredentialDependencies, ...overrides };
  return async (request) => {
    try {
      requireDemoNetworkEnabled(dependencies.env);
      const body = strictRecord(await json(request), ["subject"]);
      const subject = requireTestnetSubject(
        body.subject,
        dependencies.validateAddress,
      );
      requireSameOriginWallet(request, subject, dependencies.env);
      return ok(
        await dependencies.revoke(subject, { env: dependencies.env }),
      );
    } catch (error) {
      return demoNetworkErrorResponse(error);
    }
  };
}

export interface ViRouteDependencies {
  env: NodeJS.ProcessEnv;
  issue(
    input: ViL1Input,
    privateJwk: JsonWebKey,
    nowMilliseconds?: number,
  ): Promise<IssuedViL1>;
  now(): number;
  validateAddress(address: string): boolean;
}

const defaultViDependencies: ViRouteDependencies = {
  env: process.env,
  issue: issueViL1,
  now: Date.now,
  validateAddress: isValidClassicAddress,
};

function viInput(
  value: unknown,
  validateAddress: (address: string) => boolean,
): ViL1Input {
  const body = strictRecord(value, [
    "device_public_jwk",
    "budget_account",
    "of_verification",
  ]);
  const budgetAccount = requireTestnetSubject(
    body.budget_account,
    validateAddress,
  );
  const verification = strictRecord(body.of_verification, [
    "verified",
    "owner_name_hash",
    "customer_ref_hash",
  ]);
  return {
    budget_account: budgetAccount,
    device_public_jwk: body.device_public_jwk as JsonWebKey,
    of_verification: {
      customer_ref_hash: String(verification.customer_ref_hash ?? ""),
      owner_name_hash: String(verification.owner_name_hash ?? ""),
      verified: verification.verified as true,
    },
  };
}

export function createViL1Handler(
  overrides: Partial<ViRouteDependencies> = {},
): (request: Request) => Promise<Response> {
  const dependencies = { ...defaultViDependencies, ...overrides };
  return async (request) => {
    try {
      requireDemoNetworkEnabled(dependencies.env);
      const input = viInput(
        await json(request),
        dependencies.validateAddress,
      );
      requireSameOriginWallet(request, input.budget_account, dependencies.env);
      const privateJwk = parsePrivateIssuerJwk(
        dependencies.env.DEMO_NETWORK_VI_L1_JWK,
      );
      return ok(await dependencies.issue(input, privateJwk, dependencies.now()));
    } catch (error) {
      return demoNetworkErrorResponse(error);
    }
  };
}

export function createJwksHandler(
  env: NodeJS.ProcessEnv = process.env,
): () => Promise<Response> {
  return async () => {
    try {
      requireDemoNetworkEnabled(env);
      const privateJwk = parsePrivateIssuerJwk(env.DEMO_NETWORK_VI_L1_JWK);
      return ok({ keys: [publicIssuerJwk(privateJwk)] });
    } catch (error) {
      return demoNetworkErrorResponse(error);
    }
  };
}
