import { isIP } from "node:net";
import {
  PILOT_ISOLATED_BUILD_MARKER,
  PILOT_ISOLATED_DEPLOYMENT_PROFILE,
  PILOT_ISOLATED_HARBOR_ORIGIN,
  PILOT_ISOLATED_HOST,
  PILOT_ISOLATED_ORIGIN,
} from "@pilot/wallet/isolation-profile";
import {
  X402_ISOLATED_HARBOR_URL,
  isExactIsolatedLocalX402HarborUrl,
} from "@pilot/harbor-client";

export type LocalPilotDeploymentProfile =
  | "local-wallet"
  | typeof PILOT_ISOLATED_DEPLOYMENT_PROFILE;
export type PilotDeploymentProfile = LocalPilotDeploymentProfile | "hosted";

export type LedgerTransport = "webhid" | "virtual";

export type ProfileLedgerConfig = Readonly<{
  enabled: boolean;
  transports: LedgerTransport[];
  defaultAccountIndex: number;
  speculosUpstream?: string;
}>;

type ProfileEnvironment = Readonly<{
  EXEC_NETWORK?: string;
  HARBOR_API_KEY?: string;
  HARBOR_X402_API_KEY?: string;
  HARBOR_X402_URL?: string;
  HARBOR_URL?: string;
  LEDGER_DEFAULT_ACCOUNT_INDEX?: string;
  LEDGER_MODE?: string;
  LEDGER_SPECULOS_URL?: string;
  NEXT_PUBLIC_DEV_SIGNER?: string;
  NEXT_PUBLIC_PILOT_BUILD_MARKER?: string;
  PILOT_DEPLOYMENT_PROFILE?: string;
  PILOT_PUBLIC_ORIGIN?: string;
}>;

const NAMED_CREDENTIAL = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63}):([A-Za-z0-9_-]{32,128})$/;
const SPECULOS_LOCAL_ORIGIN = "http://127.0.0.1:5000";

const LOCAL_PROFILE_CONTRACTS = {
  "local-wallet": {
    buildMarker: undefined,
    harborUrl: "http://127.0.0.1:8791/",
    pilotHost: "127.0.0.1:3003",
    pilotHostname: "127.0.0.1",
    pilotOrigin: "http://127.0.0.1:3003",
  },
  [PILOT_ISOLATED_DEPLOYMENT_PROFILE]: {
    buildMarker: PILOT_ISOLATED_BUILD_MARKER,
    harborUrl: `${PILOT_ISOLATED_HARBOR_ORIGIN}/`,
    pilotHost: PILOT_ISOLATED_HOST,
    pilotHostname: "127.0.0.2",
    pilotOrigin: PILOT_ISOLATED_ORIGIN,
  },
} as const satisfies Record<LocalPilotDeploymentProfile, {
  buildMarker: string | undefined;
  harborUrl: string;
  pilotHost: string;
  pilotHostname: string;
  pilotOrigin: string;
}>;

export type PilotRequestAuthority = Readonly<{
  profile: PilotDeploymentProfile;
  origin: string;
}>;

export function isLocalWalletProfile(
  profile: PilotDeploymentProfile,
): profile is LocalPilotDeploymentProfile {
  return profile === "local-wallet" || profile === PILOT_ISOLATED_DEPLOYMENT_PROFILE;
}

function localProfileContract(profile: LocalPilotDeploymentProfile) {
  return LOCAL_PROFILE_CONTRACTS[profile];
}

function parsedUrl(value: string | undefined): URL {
  if (!value) throw new Error("PILOT_INVALID_HARBOR_URL");
  try {
    return new URL(value.trim());
  } catch {
    throw new Error("PILOT_INVALID_HARBOR_URL");
  }
}

function normalizedHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (isIP(normalized) === 4) return normalized.split(".")[0] === "127";
  if (isIP(normalized) === 6) {
    return normalized === "::1" || /^::ffff:7f[0-9a-f]{2}:/.test(normalized);
  }
  return false;
}

function hasSafeUrlShape(url: URL): boolean {
  return url.username === "" && url.password === "" && url.search === "" && url.hash === "";
}

function resolveHostedPublicOrigin(environment: ProfileEnvironment): string {
  const configured = environment.PILOT_PUBLIC_ORIGIN;
  const raw = configured?.trim();
  if (!raw) throw new Error("PILOT_HOSTED_PUBLIC_ORIGIN_REQUIRED");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("PILOT_INVALID_HOSTED_PUBLIC_ORIGIN");
  }

  if (
    url.protocol !== "https:" ||
    !hasSafeUrlShape(url) ||
    url.pathname !== "/" ||
    isLoopbackHostname(normalizedHostname(url)) ||
    configured !== raw ||
    raw !== url.origin
  ) {
    throw new Error("PILOT_INVALID_HOSTED_PUBLIC_ORIGIN");
  }
  return url.origin;
}

export function resolvePilotDeploymentProfile(
  environment: ProfileEnvironment,
): PilotDeploymentProfile {
  const profile = environment.PILOT_DEPLOYMENT_PROFILE;
  if (
    profile !== "local-wallet" &&
    profile !== PILOT_ISOLATED_DEPLOYMENT_PROFILE &&
    profile !== "hosted"
  ) {
    throw new Error("PILOT_INVALID_DEPLOYMENT_PROFILE");
  }
  const expectedBuildMarker = isLocalWalletProfile(profile)
    ? localProfileContract(profile).buildMarker
    : undefined;
  if (environment.NEXT_PUBLIC_PILOT_BUILD_MARKER !== expectedBuildMarker) {
    throw new Error("PILOT_BUILD_MARKER_MISMATCH");
  }
  if (profile === "hosted" && environment.NEXT_PUBLIC_DEV_SIGNER === "1") {
    throw new Error("PILOT_HOSTED_DEV_SIGNER_FORBIDDEN");
  }
  if (profile === "hosted") resolveHostedPublicOrigin(environment);
  return profile;
}

function forwardedAuthorityIsConsistent(
  request: Request,
  expectedHost: string,
): boolean {
  const expectedHostname = expectedHost.slice(0, expectedHost.lastIndexOf(":"));
  const forwarded = request.headers.get("forwarded");
  if (forwarded !== null) {
    // A comma means more than one forwarding hop. Local profiles never trust a
    // forwarding chain, even if its first entry happens to look local.
    if (forwarded.includes(",")) return false;
    const parameters = new Map<string, string>();
    for (const part of forwarded.split(";")) {
      const separator = part.indexOf("=");
      if (separator < 1) return false;
      const key = part.slice(0, separator).trim().toLowerCase();
      let value = part.slice(separator + 1).trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (
        !key || !value || parameters.has(key) ||
        (key !== "for" && key !== "host" && key !== "proto")
      ) return false;
      parameters.set(key, value);
    }
    if (
      (parameters.has("for") && parameters.get("for") !== expectedHostname) ||
      (parameters.has("host") && parameters.get("host") !== expectedHost) ||
      (parameters.has("proto") && parameters.get("proto") !== "http")
    ) return false;
  }

  const forwardedFor = request.headers.get("x-forwarded-for");
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProtocol = request.headers.get("x-forwarded-proto");
  const forwardedPort = request.headers.get("x-forwarded-port");
  return (
    (forwardedFor === null || forwardedFor === expectedHostname) &&
    (forwardedHost === null || forwardedHost === expectedHost) &&
    (forwardedProtocol === null || forwardedProtocol === "http") &&
    (forwardedPort === null || forwardedPort === "3003") &&
    !forwardedFor?.includes(",") &&
    !forwardedHost?.includes(",") &&
    !forwardedProtocol?.includes(",") &&
    !forwardedPort?.includes(",")
  );
}

export function isAllowedLocalPilotRequest(
  request: Request,
  profile: LocalPilotDeploymentProfile = "local-wallet",
): boolean {
  try {
    const contract = localProfileContract(profile);
    const url = new URL(request.url);
    const host = request.headers.get("host");
    // NextRequest normalizes every 127/8 URL to localhost internally, so the
    // URL hostname may be either value. The raw Host header remains the exact
    // slot authority and therefore still rejects a literal localhost request.
    const urlHostIsLocal = url.hostname === contract.pilotHostname ||
      url.hostname === "localhost";
    return host === contract.pilotHost &&
      url.protocol === "http:" && url.port === "3003" && urlHostIsLocal &&
      url.username === "" && url.password === "" && url.hash === "" &&
      forwardedAuthorityIsConsistent(request, contract.pilotHost);
  } catch {
    return false;
  }
}

export function resolveProfileHarborBaseUrl(
  environment: ProfileEnvironment,
): string {
  const profile = resolvePilotDeploymentProfile(environment);
  const url = parsedUrl(environment.HARBOR_URL);
  if (!hasSafeUrlShape(url)) throw new Error("PILOT_INVALID_HARBOR_URL");

  if (isLocalWalletProfile(profile)) {
    const expected = localProfileContract(profile).harborUrl;
    if (
      profile === PILOT_ISOLATED_DEPLOYMENT_PROFILE &&
      environment.HARBOR_URL !== PILOT_ISOLATED_HARBOR_ORIGIN
    ) {
      throw new Error("PILOT_INVALID_LOCAL_HARBOR_URL");
    }
    if (url.href !== expected) throw new Error("PILOT_INVALID_LOCAL_HARBOR_URL");
    return expected.slice(0, -1);
  }

  if (url.protocol !== "https:" || isLoopbackHostname(normalizedHostname(url))) {
    throw new Error("PILOT_INVALID_HOSTED_HARBOR_URL");
  }
  return url.toString().replace(/\/+$/, "");
}

export function resolvePilotRequestAuthority(
  environment: ProfileEnvironment,
  request: Request,
): PilotRequestAuthority {
  const profile = resolvePilotDeploymentProfile(environment);
  if (isLocalWalletProfile(profile)) {
    const contract = localProfileContract(profile);
    if (!isAllowedLocalPilotRequest(request, profile)) {
      throw new Error("PILOT_LOCAL_REQUEST_REQUIRED");
    }
    return { profile, origin: contract.pilotOrigin };
  }
  // In hosted deployments request.url is commonly an internal reverse-proxy
  // URL. Forwarded headers are client-controlled unless a platform-specific
  // trust boundary validates them, so neither is an authority source here.
  return { profile, origin: resolveHostedPublicOrigin(environment) };
}

export function assertProfileRequestBoundary(
  environment: ProfileEnvironment,
  request: Request,
): PilotDeploymentProfile {
  return resolvePilotRequestAuthority(environment, request).profile;
}

export function resolveCredentialedHarborUpstream(
  environment: ProfileEnvironment,
  request: Request,
): { apiKey: string; baseUrl: string } {
  assertProfileRequestBoundary(environment, request);
  const baseUrl = resolveProfileHarborBaseUrl(environment);
  const apiKey = environment.HARBOR_API_KEY?.trim();
  if (!apiKey) throw new Error("PILOT_HARBOR_API_KEY_REQUIRED");
  return { apiKey, baseUrl };
}

/** Resolve the dedicated x402 upstream without widening ordinary Harbor. */
export function resolveCredentialedX402HarborUpstream(
  environment: ProfileEnvironment,
  request: Request,
): { apiKey: string; baseUrl: string } {
  const profile = assertProfileRequestBoundary(environment, request);
  resolveProfileHarborBaseUrl(environment);

  if (profile === "local-wallet") {
    if (
      environment.HARBOR_X402_URL !== undefined ||
      environment.HARBOR_X402_API_KEY !== undefined
    ) {
      throw new Error("PILOT_X402_CROSS_PROFILE_CONFIG");
    }
    const apiKey = environment.HARBOR_API_KEY?.trim();
    if (!apiKey) throw new Error("PILOT_HARBOR_API_KEY_REQUIRED");
    return { apiKey, baseUrl: "http://127.0.0.1:8791" };
  }

  if (
    profile !== PILOT_ISOLATED_DEPLOYMENT_PROFILE ||
    !isExactIsolatedLocalX402HarborUrl(environment.HARBOR_X402_URL)
  ) {
    throw new Error("PILOT_INVALID_ISOLATED_X402_URL");
  }

  const primary = environment.HARBOR_API_KEY?.trim();
  const x402 = environment.HARBOR_X402_API_KEY?.trim();
  const primaryMatch = primary?.match(NAMED_CREDENTIAL);
  const x402Match = x402?.match(NAMED_CREDENTIAL);
  if (
    !primaryMatch || !x402Match ||
    primaryMatch[1] === x402Match[1] || primaryMatch[2] === x402Match[2]
  ) {
    throw new Error("PILOT_ISOLATED_X402_CREDENTIAL_REQUIRED");
  }
  return { apiKey: x402!, baseUrl: X402_ISOLATED_HARBOR_URL };
}

export function resolveProfileDevSignerEnabled(
  environment: ProfileEnvironment,
  request: Request,
): boolean {
  const profile = assertProfileRequestBoundary(environment, request);
  resolveProfileHarborBaseUrl(environment);
  return isLocalWalletProfile(profile) && environment.NEXT_PUBLIC_DEV_SIGNER === "1";
}

export function resolveProfileWalletActionProofRequired(
  environment: ProfileEnvironment,
  request: Request,
): boolean {
  return isLocalWalletProfile(assertProfileRequestBoundary(environment, request));
}

export function resolveProfilePublicBuildMarker(
  environment: ProfileEnvironment,
): typeof PILOT_ISOLATED_BUILD_MARKER | undefined {
  const profile = resolvePilotDeploymentProfile(environment);
  return profile === PILOT_ISOLATED_DEPLOYMENT_PROFILE
    ? PILOT_ISOLATED_BUILD_MARKER
    : undefined;
}

function resolveDefaultAccountIndex(value: string | undefined): number {
  if (value === undefined || value === "") return 0;
  if (!/^[0-9]$/.test(value)) {
    throw new Error("PILOT_INVALID_LEDGER_ACCOUNT_INDEX");
  }
  return Number(value);
}

function assertLocalLedgerRequest(request: Request): void {
  const url = new URL(request.url);
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "127.0.0.2")
  ) {
    throw new Error("PILOT_LOCAL_REQUEST_REQUIRED");
  }
}

/**
 * Resolves server-only Ledger settings for the public-config route. The caller
 * must omit `speculosUpstream` from its response; it is never browser config.
 */
export function resolveProfileLedgerConfig(
  environment: ProfileEnvironment,
  request: Request,
): ProfileLedgerConfig {
  const profile = resolvePilotDeploymentProfile(environment);
  const mode = environment.LEDGER_MODE?.trim() || "webhid";
  if (mode !== "off" && mode !== "webhid" && mode !== "webhid+virtual") {
    throw new Error("PILOT_INVALID_LEDGER_MODE");
  }

  const defaultAccountIndex = resolveDefaultAccountIndex(
    environment.LEDGER_DEFAULT_ACCOUNT_INDEX?.trim(),
  );
  const speculosUpstream = environment.LEDGER_SPECULOS_URL?.trim();

  if (profile === "hosted") {
    if (speculosUpstream) {
      throw new Error("PILOT_HOSTED_LEDGER_SPECULOS_FORBIDDEN");
    }
    return { enabled: false, transports: [], defaultAccountIndex };
  }

  assertLocalLedgerRequest(request);
  const network = environment.EXEC_NETWORK?.trim() || "testnet";
  if (network !== "testnet" && network !== "devnet") {
    throw new Error("PILOT_LEDGER_TEST_NETWORK_REQUIRED");
  }

  if (speculosUpstream && speculosUpstream !== SPECULOS_LOCAL_ORIGIN) {
    throw new Error("PILOT_INVALID_LEDGER_SPECULOS_URL");
  }

  if (mode === "off") {
    return { enabled: false, transports: [], defaultAccountIndex };
  }

  const transports: LedgerTransport[] = ["webhid"];
  if (mode === "webhid+virtual" && speculosUpstream) transports.push("virtual");
  return {
    enabled: true,
    transports,
    defaultAccountIndex,
    ...(transports.includes("virtual") ? { speculosUpstream } : {}),
  };
}
