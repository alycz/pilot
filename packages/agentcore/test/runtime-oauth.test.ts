import { describe, expect, it, vi } from "vitest";

import {
  createAgentCoreRuntimeOAuthJwtResolver,
  createMountedFileAgentCoreSecretProvider,
  readAgentCoreRuntimeOAuthConfig,
  type AgentCoreSecretProvider,
} from "../src/runtime-oauth";

const env = Object.freeze({
  AGENTCORE_RUNTIME_OAUTH_GRANT_TYPE: "client_credentials",
  AGENTCORE_RUNTIME_OAUTH_TOKEN_AUTH_METHOD: "client_secret_basic",
  AGENTCORE_RUNTIME_OAUTH_TOKEN_URL: "https://identity.example.test/oauth2/token",
  AGENTCORE_RUNTIME_OAUTH_CLIENT_ID: "pilot-runtime-caller",
  AGENTCORE_RUNTIME_OAUTH_CLIENT_SECRET_REF: "pilot-agentcore-runtime-client",
  AGENTCORE_RUNTIME_OAUTH_TIMEOUT_MS: "1000",
  AGENTCORE_RUNTIME_OAUTH_MAX_RESPONSE_BYTES: "4096",
  AGENTCORE_RUNTIME_JWT_TENANT_ID: "pilot-deployment",
  AGENTCORE_RUNTIME_JWT_AUDIENCES_JSON: '["pilot-agentcore-runtime"]',
  AGENTCORE_RUNTIME_JWT_REQUIRED_SCOPES_JSON: '["pilot.invoke_research"]',
  AGENTCORE_RUNTIME_JWT_ALLOWED_CLIENTS_JSON: '["pilot-runtime-caller"]',
  AGENTCORE_RUNTIME_JWT_CLIENT_CLAIM: "client_id",
});

function request() {
  return {
    tenantId: "pilot-deployment",
    audiences: ["pilot-agentcore-runtime"],
    requiredScopes: ["pilot.invoke_research"],
  } as const;
}

function provider(value = "fixture-client-secret"): AgentCoreSecretProvider {
  return { async resolveSecret() { return value; } };
}

describe("AgentCore Runtime OAuth resolver", () => {
  it("acquires one bounded client-credentials token without exposing the secret in the body", async () => {
    const secretProvider = { resolveSecret: vi.fn(async () => "fixture-client-secret") };
    const oauthFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(String(init?.body)).toBe("grant_type=client_credentials&scope=pilot.invoke_research");
      expect(String(init?.body)).not.toContain("fixture-client-secret");
      expect(new Headers(init?.headers).get("authorization")).toMatch(/^Basic /);
      return new Response(JSON.stringify({
        access_token: "header.payload.signature",
        token_type: "Bearer",
        expires_in: 300,
        scope: "pilot.invoke_research",
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const resolver = createAgentCoreRuntimeOAuthJwtResolver(
      readAgentCoreRuntimeOAuthConfig(env),
      { secretProvider, fetch: oauthFetch },
    );
    await expect(resolver.resolveAuthorization(request())).resolves.toBe("Bearer header.payload.signature");
    expect(secretProvider.resolveSecret).toHaveBeenCalledWith(
      "pilot-agentcore-runtime-client",
      { signal: expect.any(AbortSignal) },
    );
    expect(oauthFetch).toHaveBeenCalledTimes(1);
  });

  it("fails before secret access when tenant, audience, or scope bindings differ", async () => {
    const secretProvider = { resolveSecret: vi.fn(async () => "fixture-client-secret") };
    const oauthFetch = vi.fn();
    const resolver = createAgentCoreRuntimeOAuthJwtResolver(
      readAgentCoreRuntimeOAuthConfig(env),
      { secretProvider, fetch: oauthFetch },
    );
    await expect(resolver.resolveAuthorization({ ...request(), tenantId: "other" })).rejects.toThrow("binding");
    await expect(resolver.resolveAuthorization({ ...request(), audiences: ["other"] })).rejects.toThrow("binding");
    await expect(resolver.resolveAuthorization({ ...request(), requiredScopes: ["extra"] })).rejects.toThrow("binding");
    expect(secretProvider.resolveSecret).not.toHaveBeenCalled();
    expect(oauthFetch).not.toHaveBeenCalled();
  });

  it("rejects static secrets, non-client_id policy, and client allowlist drift", () => {
    expect(() => readAgentCoreRuntimeOAuthConfig({
      ...env,
      AGENTCORE_RUNTIME_OAUTH_CLIENT_SECRET: "must-not-be-read",
    })).toThrow("server-only secret provider");
    expect(() => readAgentCoreRuntimeOAuthConfig({
      ...env,
      AGENTCORE_RUNTIME_JWT_CLIENT_CLAIM: "azp",
    })).toThrow("client_id");
    expect(() => readAgentCoreRuntimeOAuthConfig({
      ...env,
      AGENTCORE_RUNTIME_JWT_ALLOWED_CLIENTS_JSON: '["another-client"]',
    })).toThrow("allowed JWT client_id");
  });

  it("rejects redirects, token-bearing extensions, and malformed token responses without echoing values", async () => {
    const cases = [
      new Response(null, { status: 302, headers: { location: "https://other.example.test" } }),
      new Response(JSON.stringify({
        access_token: "header.payload.signature",
        token_type: "Bearer",
        refresh_token: "must-not-survive",
      }), { status: 200, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify({ access_token: "with whitespace", token_type: "Bearer" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ];
    for (const response of cases) {
      const resolver = createAgentCoreRuntimeOAuthJwtResolver(
        readAgentCoreRuntimeOAuthConfig(env),
        { secretProvider: provider(), fetch: vi.fn(async () => response.clone()) },
      );
      const error = await resolver.resolveAuthorization(request()).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toBe("Error: AgentCore Runtime OAuth authorization is unavailable");
      expect(String(error)).not.toContain("must-not-survive");
      expect(String(error)).not.toContain("fixture-client-secret");
    }
  });

  it("releases the caller deadline when a secret provider ignores cancellation", async () => {
    const resolver = createAgentCoreRuntimeOAuthJwtResolver(
      readAgentCoreRuntimeOAuthConfig({ ...env, AGENTCORE_RUNTIME_OAUTH_TIMEOUT_MS: "100" }),
      {
        secretProvider: { resolveSecret: async () => new Promise<string>(() => undefined) },
        fetch: vi.fn(),
      },
    );
    await expect(resolver.resolveAuthorization(request())).rejects.toThrow("authorization is unavailable");
  });

  it("permits only a logical mounted-secret reference under /run/secrets", () => {
    expect(() => createMountedFileAgentCoreSecretProvider({ root: "/tmp/secrets" }))
      .toThrow("under /run/secrets");
    expect(() => createMountedFileAgentCoreSecretProvider({ root: "/run/secrets/pilot" }))
      .not.toThrow();
  });
});
