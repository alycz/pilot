import { describe, expect, it } from "vitest";

import {
  isAllowedLocalPilotRequest,
  resolvePilotRequestAuthority,
  resolveCredentialedHarborUpstream,
  resolveCredentialedX402HarborUpstream,
  resolveProfileDevSignerEnabled,
  resolveProfileHarborBaseUrl,
  resolveProfileWalletActionProofRequired,
} from "./runtime-profile";

const LOCAL = {
  HARBOR_API_KEY: "local-key",
  HARBOR_URL: "http://127.0.0.1:8791",
  NEXT_PUBLIC_DEV_SIGNER: "1",
  PILOT_DEPLOYMENT_PROFILE: "local-wallet",
} as const;

const ISOLATED = {
  HARBOR_API_KEY: "isolated-key",
  HARBOR_URL: "http://127.0.0.2:8791",
  NEXT_PUBLIC_DEV_SIGNER: "1",
  NEXT_PUBLIC_PILOT_BUILD_MARKER: "pilot-local-wallet-isolated-v1",
  PILOT_DEPLOYMENT_PROFILE: "local-wallet-isolated-v1",
} as const;

const ISOLATED_X402 = {
  ...ISOLATED,
  HARBOR_API_KEY: `isolated-trading:${"T".repeat(32)}`,
  HARBOR_X402_API_KEY: `isolated-x402:${"X".repeat(32)}`,
  HARBOR_X402_URL: "http://127.0.0.2:8792",
} as const;

function request(
  url = "http://127.0.0.1:3003/api/chat",
  headers: HeadersInit = {},
): Request {
  return new Request(url, {
    headers: { host: new URL(url).host, ...headers },
  });
}

describe("Pilot runtime profile", () => {
  it("accepts the exact reviewed local Pilot request", () => {
    const localRequest = request();
    expect(isAllowedLocalPilotRequest(localRequest)).toBe(true);
    expect(resolvePilotRequestAuthority(LOCAL, localRequest)).toEqual({
      profile: "local-wallet",
      origin: "http://127.0.0.1:3003",
    });
    expect(resolveCredentialedHarborUpstream(LOCAL, localRequest)).toEqual({
      apiKey: "local-key",
      baseUrl: "http://127.0.0.1:8791",
    });
    expect(resolveProfileDevSignerEnabled(LOCAL, localRequest)).toBe(true);
    expect(resolveProfileWalletActionProofRequired(LOCAL, localRequest)).toBe(true);
  });

  it("accepts only the exact isolated Pilot/Harbor/build-marker tuple", () => {
    const isolatedRequest = request("http://127.0.0.2:3003/api/chat");
    expect(isAllowedLocalPilotRequest(
      isolatedRequest,
      "local-wallet-isolated-v1",
    )).toBe(true);
    expect(resolvePilotRequestAuthority(ISOLATED, isolatedRequest)).toEqual({
      profile: "local-wallet-isolated-v1",
      origin: "http://127.0.0.2:3003",
    });
    expect(resolveCredentialedHarborUpstream(ISOLATED, isolatedRequest)).toEqual({
      apiKey: "isolated-key",
      baseUrl: "http://127.0.0.2:8791",
    });
    expect(resolveProfileDevSignerEnabled(ISOLATED, isolatedRequest)).toBe(true);
    expect(resolveProfileWalletActionProofRequired(ISOLATED, isolatedRequest)).toBe(true);
  });

  it("resolves a separate server-only x402 principal for the isolated slot", () => {
    const isolatedRequest = request("http://127.0.0.2:3003/api/harbor/x402.pay");
    expect(resolveCredentialedX402HarborUpstream(ISOLATED_X402, isolatedRequest)).toEqual({
      apiKey: ISOLATED_X402.HARBOR_X402_API_KEY,
      baseUrl: "http://127.0.0.2:8792",
    });
    expect(resolveCredentialedHarborUpstream(ISOLATED_X402, isolatedRequest)).toEqual({
      apiKey: ISOLATED_X402.HARBOR_API_KEY,
      baseUrl: "http://127.0.0.2:8791",
    });
  });

  it.each([
    ["missing x402 key", { ...ISOLATED_X402, HARBOR_X402_API_KEY: undefined }],
    ["same principal", { ...ISOLATED_X402, HARBOR_X402_API_KEY: `isolated-trading:${"X".repeat(32)}` }],
    ["same bearer token", { ...ISOLATED_X402, HARBOR_X402_API_KEY: `isolated-x402:${"T".repeat(32)}` }],
    ["legacy Harbor", { ...ISOLATED_X402, HARBOR_X402_URL: "http://127.0.0.1:8791" }],
    ["trading Harbor", { ...ISOLATED_X402, HARBOR_X402_URL: "http://127.0.0.2:8791" }],
    ["trailing slash", { ...ISOLATED_X402, HARBOR_X402_URL: "http://127.0.0.2:8792/" }],
    ["hosted target", { ...ISOLATED_X402, HARBOR_X402_URL: "https://harbor.example" }],
  ] as const)("rejects isolated x402 cross-profile configuration: %s", (_label, environment) => {
    expect(() => resolveCredentialedX402HarborUpstream(
      environment,
      request("http://127.0.0.2:3003/api/harbor/x402.pay"),
    )).toThrow();
  });

  it("preserves legacy .1 x402 but rejects isolated credential fields there", () => {
    const localRequest = request("http://127.0.0.1:3003/api/harbor/x402.pay");
    expect(resolveCredentialedX402HarborUpstream(LOCAL, localRequest)).toEqual({
      apiKey: "local-key",
      baseUrl: "http://127.0.0.1:8791",
    });
    expect(() => resolveCredentialedX402HarborUpstream({
      ...LOCAL,
      HARBOR_X402_URL: "http://127.0.0.2:8792",
      HARBOR_X402_API_KEY: ISOLATED_X402.HARBOR_X402_API_KEY,
    }, localRequest)).toThrow("PILOT_X402_CROSS_PROFILE_CONFIG");
  });

  it.each([
    ["legacy request in isolated profile", ISOLATED, "http://127.0.0.1:3003/api/chat"],
    ["isolated request in legacy profile", LOCAL, "http://127.0.0.2:3003/api/chat"],
    ["legacy Harbor in isolated profile", { ...ISOLATED, HARBOR_URL: "http://127.0.0.1:8791" }, "http://127.0.0.2:3003/api/chat"],
    ["isolated Harbor in legacy profile", { ...LOCAL, HARBOR_URL: "http://127.0.0.2:8791" }, "http://127.0.0.1:3003/api/chat"],
    ["missing isolated marker", { ...ISOLATED, NEXT_PUBLIC_PILOT_BUILD_MARKER: undefined }, "http://127.0.0.2:3003/api/chat"],
    ["wrong isolated marker", { ...ISOLATED, NEXT_PUBLIC_PILOT_BUILD_MARKER: "pilot-other" }, "http://127.0.0.2:3003/api/chat"],
    ["isolated marker in legacy profile", { ...LOCAL, NEXT_PUBLIC_PILOT_BUILD_MARKER: "pilot-local-wallet-isolated-v1" }, "http://127.0.0.1:3003/api/chat"],
    ["isolated marker in hosted profile", {
      HARBOR_URL: "https://harbor.example",
      NEXT_PUBLIC_DEV_SIGNER: "0",
      NEXT_PUBLIC_PILOT_BUILD_MARKER: "pilot-local-wallet-isolated-v1",
      PILOT_DEPLOYMENT_PROFILE: "hosted",
      PILOT_PUBLIC_ORIGIN: "https://pilot.example",
    }, "http://next-internal:3000/api/chat"],
  ] as const)("rejects cross-slot configuration: %s", (_label, environment, url) => {
    expect(() => resolveCredentialedHarborUpstream(environment, request(url))).toThrow();
  });

  it.each([
    "http://localhost:3003/api/chat",
    "http://[::1]:3003/api/chat",
    "http://127.0.0.2:3002/api/chat",
    "http://127.0.0.2:3004/api/chat",
    "http://127.0.0.3:3003/api/chat",
    "https://127.0.0.2:3003/api/chat",
  ])("rejects an unreviewed isolated Pilot request: %s", (url) => {
    expect(() => resolveCredentialedHarborUpstream(ISOLATED, request(url))).toThrow();
  });

  it.each(["0177.0.0.2:3003", "2130706434:3003", "127.000.000.002:3003"])(
    "rejects alternate isolated Host spelling: %s",
    (host) => {
      const isolatedRequest = new Request("http://127.0.0.2:3003/api/chat", {
        headers: { host },
      });
      expect(() => resolveCredentialedHarborUpstream(ISOLATED, isolatedRequest)).toThrow();
    },
  );

  it.each([
    "http://localhost:8791",
    "http://[::1]:8791",
    "https://127.0.0.2:8791",
    "http://127.0.0.2:8792",
    "http://127.0.0.1:8791",
    "http://127.0.0.3:8791",
    "http://0177.0.0.2:8791",
    "http://2130706434:8791",
    "http://127.000.000.002:8791",
    "http://127.0.0.2:8791/",
    "http://127.0.0.2:8791/api",
    "http://127.0.0.2:8791?query=1",
    "http://127.0.0.2:8791/#fragment",
    "http://user:pass@127.0.0.2:8791",
  ])("rejects an unreviewed isolated Harbor target: %s", (url) => {
    expect(() => resolveProfileHarborBaseUrl({ ...ISOLATED, HARBOR_URL: url })).toThrow();
  });

  it("accepts only exact single-hop isolated forwarding confirmation", () => {
    const exact = request("http://127.0.0.2:3003/api/chat", {
      forwarded: 'for=127.0.0.2;proto="http";host="127.0.0.2:3003"',
      "x-forwarded-for": "127.0.0.2",
      "x-forwarded-host": "127.0.0.2:3003",
      "x-forwarded-proto": "http",
      "x-forwarded-port": "3003",
    });
    expect(resolvePilotRequestAuthority(ISOLATED, exact).origin).toBe(
      "http://127.0.0.2:3003",
    );
  });

  it.each<Record<string, string>>([
    { forwarded: "for=127.0.0.1;proto=http;host=127.0.0.2:3003" },
    { forwarded: "for=127.0.0.2;proto=http;host=127.0.0.1:3003" },
    { forwarded: "for=127.0.0.2;proto=http;host=127.0.0.2:3003;by=proxy" },
    { forwarded: "for=127.0.0.2,for=127.0.0.2" },
    { "x-forwarded-for": "127.0.0.1" },
    { "x-forwarded-for": "127.0.0.2,127.0.0.2" },
    { "x-forwarded-host": "127.0.0.1:3003" },
    { "x-forwarded-host": "127.0.0.2:3003,127.0.0.2:3003" },
    { "x-forwarded-proto": "https" },
    { "x-forwarded-port": "3004" },
  ])("rejects isolated forwarding mismatch before authority: %o", (headers) => {
    const isolatedRequest = request("http://127.0.0.2:3003/api/chat", headers);
    expect(() => resolvePilotRequestAuthority(ISOLATED, isolatedRequest)).toThrow();
  });

  it.each([
    "http://127.0.0.1:3002/api/chat",
    "http://127.0.0.1:3004/api/chat",
    "http://127.0.0.1:3005/api/chat",
    "http://localhost:3003/api/chat",
    "http://[::1]:3003/api/chat",
    "https://127.0.0.1:3003/api/chat",
    "https://pilot.example/api/chat",
  ])("rejects an unreviewed local Pilot request: %s", (url) => {
    const localRequest = request(url);
    expect(isAllowedLocalPilotRequest(localRequest)).toBe(false);
    expect(() => resolveCredentialedHarborUpstream(LOCAL, localRequest)).toThrow();
  });

  it.each([
    ["missing Host", {}],
    ["wrong Host", { host: "pilot.example:3003" }],
    ["inconsistent Forwarded", { forwarded: "for=127.0.0.1;proto=https;host=pilot.example" }],
    ["multi-value Forwarded", { forwarded: "for=127.0.0.1, for=203.0.113.7" }],
    ["inconsistent X-Forwarded-Host", { "x-forwarded-host": "pilot.example" }],
    ["multi-value X-Forwarded-Host", { "x-forwarded-host": "127.0.0.1:3003,pilot.example" }],
    ["inconsistent X-Forwarded-Proto", { "x-forwarded-proto": "https" }],
    ["multi-value X-Forwarded-Proto", { "x-forwarded-proto": "http,https" }],
    ["inconsistent X-Forwarded-Port", { "x-forwarded-port": "443" }],
    ["multi-value X-Forwarded-Port", { "x-forwarded-port": "3003,443" }],
  ] as const)("rejects %s without consulting forwarded authority", (_name, headers) => {
    const localRequest = new Request("http://127.0.0.1:3003/api/chat", { headers });
    expect(isAllowedLocalPilotRequest(localRequest)).toBe(false);
    expect(() => resolveCredentialedHarborUpstream(LOCAL, localRequest)).toThrow();
  });

  it("allows only single forwarding fields that exactly confirm the raw authority", () => {
    const localRequest = request(undefined, {
      forwarded: 'for=127.0.0.1;proto="http";host="127.0.0.1:3003"',
      "x-forwarded-host": "127.0.0.1:3003",
      "x-forwarded-proto": "http",
      "x-forwarded-port": "3003",
    });
    expect(isAllowedLocalPilotRequest(localRequest)).toBe(true);
  });

  it.each([
    "http://localhost:8791",
    "http://[::1]:8791",
    "https://127.0.0.1:8791",
    "http://127.0.0.1:8792",
    "http://127.0.0.1:8791/api",
    "http://127.0.0.1:8791?query=1",
    "http://127.0.0.1:8791/#fragment",
    "http://user:pass@127.0.0.1:8791",
  ])("rejects an unreviewed local Harbor target: %s", (url) => {
    expect(() => resolveProfileHarborBaseUrl({ ...LOCAL, HARBOR_URL: url })).toThrow();
  });

  it("preserves explicit hosted HTTPS while forbidding loopback and the dev signer", () => {
    expect(resolveCredentialedHarborUpstream({
      HARBOR_API_KEY: "hosted-key",
      HARBOR_URL: "https://harbor.example/base/",
      NEXT_PUBLIC_DEV_SIGNER: "0",
      PILOT_DEPLOYMENT_PROFILE: "hosted",
      PILOT_PUBLIC_ORIGIN: "https://pilot.example",
    }, request("http://next-internal:3000/api/chat", {
      forwarded: "for=203.0.113.7;proto=http;host=attacker.example",
      "x-forwarded-host": "attacker.example",
      "x-forwarded-proto": "http",
    }))).toEqual({
      apiKey: "hosted-key",
      baseUrl: "https://harbor.example/base",
    });
    expect(resolvePilotRequestAuthority({
      HARBOR_URL: "https://harbor.example/base/",
      NEXT_PUBLIC_DEV_SIGNER: "0",
      PILOT_DEPLOYMENT_PROFILE: "hosted",
      PILOT_PUBLIC_ORIGIN: "https://pilot.example",
    }, request("http://next-internal:3000/api/chat", {
      forwarded: "for=203.0.113.7;proto=http;host=attacker.example",
      "x-forwarded-host": "attacker.example",
      "x-forwarded-proto": "http",
    }))).toEqual({
      profile: "hosted",
      origin: "https://pilot.example",
    });
    expect(resolveProfileWalletActionProofRequired({
      HARBOR_URL: "https://harbor.example/base/",
      NEXT_PUBLIC_DEV_SIGNER: "0",
      PILOT_DEPLOYMENT_PROFILE: "hosted",
      PILOT_PUBLIC_ORIGIN: "https://pilot.example",
    }, request("http://next-internal:3000/api/chat"))).toBe(false);
    expect(() => resolveProfileHarborBaseUrl({
      HARBOR_URL: "https://127.0.0.1:8791",
      NEXT_PUBLIC_DEV_SIGNER: "0",
      PILOT_DEPLOYMENT_PROFILE: "hosted",
      PILOT_PUBLIC_ORIGIN: "https://pilot.example",
    })).toThrow();
    expect(() => resolveProfileHarborBaseUrl({
      HARBOR_URL: "https://harbor.example",
      NEXT_PUBLIC_DEV_SIGNER: "1",
      PILOT_DEPLOYMENT_PROFILE: "hosted",
      PILOT_PUBLIC_ORIGIN: "https://pilot.example",
    })).toThrow();
  });

  it.each([
    undefined,
    "",
    "http://pilot.example",
    "https://127.0.0.1",
    "https://localhost",
    "https://localhost.",
    "https://pilot.localhost.",
    "https://user@pilot.example",
    "https://pilot.example/path",
    "https://pilot.example?query=1",
    "https://pilot.example#fragment",
    "https://pilot.example/",
    "https://PILOT.example",
    "https://pilot.example:443",
    " https://pilot.example",
    "https://pilot.example ",
  ])("rejects a missing or unsafe hosted public origin: %s", (publicOrigin) => {
    expect(() => resolvePilotRequestAuthority({
      HARBOR_URL: "https://harbor.example",
      NEXT_PUBLIC_DEV_SIGNER: "0",
      PILOT_DEPLOYMENT_PROFILE: "hosted",
      PILOT_PUBLIC_ORIGIN: publicOrigin,
    }, request("http://next-internal:3000/api/chat"))).toThrow();
  });

  it.each([
    "https://localhost.:8791",
    "https://harbor.localhost.:8791",
  ])("rejects a trailing-dot hosted Harbor loopback: %s", (harborUrl) => {
    expect(() => resolveProfileHarborBaseUrl({
      HARBOR_URL: harborUrl,
      NEXT_PUBLIC_DEV_SIGNER: "0",
      PILOT_DEPLOYMENT_PROFILE: "hosted",
      PILOT_PUBLIC_ORIGIN: "https://pilot.example",
    })).toThrow();
  });
});
