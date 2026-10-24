import { resolveFixtureAppOrigin } from "./fixture-app-origin";

export const E2E_LANE_IDS = [
  "fixture",
  "hosted-read",
  "authenticated-live",
] as const;

export type E2ELaneId = (typeof E2E_LANE_IDS)[number];
export type EvidenceKind = "fixture" | "live";

export type E2ELane = Readonly<{
  id: E2ELaneId;
  evidenceKind: EvidenceKind;
  baseURL: string;
  authority: "none" | "read-only" | "authenticated";
  startsLocalServer: boolean;
  maySignOrFund: false;
}>;

const FIXTURE_BASE_URL = "http://127.0.0.1:3004";

const LIVE_LANE_BLOCKS = {
  "hosted-read":
    "BLOCKED: hosted-read has no implemented live assertion. The honest skipped spec is not evidence, so this lane cannot report success.",
  "authenticated-live":
    "BLOCKED: authenticated-live has no implemented live assertion. The honest skipped specs are not evidence, so this lane cannot report success.",
} as const;

function requiredBaseURL(environment: NodeJS.ProcessEnv, lane: E2ELaneId): string {
  const value = environment.PILOT_E2E_BASE_URL?.trim();
  if (!value) {
    throw new Error(
      `${lane} requires PILOT_E2E_BASE_URL for an already running Pilot deployment.`,
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PILOT_E2E_BASE_URL must be an absolute http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PILOT_E2E_BASE_URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("PILOT_E2E_BASE_URL must not contain credentials.");
  }
  if (url.search || url.hash) {
    throw new Error("PILOT_E2E_BASE_URL must not contain a query or fragment.");
  }
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if (!loopback || url.port !== "3004" || url.pathname !== "/") {
    throw new Error(
      "PILOT_E2E_BASE_URL must be the local Pilot origin on loopback port 3004.",
    );
  }
  return url.toString().replace(/\/$/, "");
}

export function resolveE2ELane(
  environment: NodeJS.ProcessEnv = process.env,
): E2ELane {
  const requested = environment.PILOT_E2E_LANE?.trim() || "fixture";
  if (!E2E_LANE_IDS.includes(requested as E2ELaneId)) {
    throw new Error(
      `PILOT_E2E_LANE must be one of ${E2E_LANE_IDS.join(", ")}.`,
    );
  }

  if (requested === "fixture") {
    const baseURL = resolveFixtureAppOrigin(
      environment.PILOT_E2E_FIXTURE_BASE_URL?.trim() || FIXTURE_BASE_URL,
    );
    return {
      id: "fixture",
      evidenceKind: "fixture",
      baseURL,
      authority: "none",
      startsLocalServer: true,
      maySignOrFund: false,
    };
  }

  if (requested === "hosted-read") {
    if (environment.PILOT_E2E_ALLOW_HOSTED_READ !== "1") {
      throw new Error(
        "hosted-read requires the explicit PILOT_E2E_ALLOW_HOSTED_READ=1 gate.",
      );
    }
    requiredBaseURL(environment, "hosted-read");
    throw new Error(LIVE_LANE_BLOCKS["hosted-read"]);
  }

  if (environment.PILOT_E2E_ALLOW_AUTHENTICATED_LIVE !== "1") {
    throw new Error(
      "authenticated-live requires the explicit PILOT_E2E_ALLOW_AUTHENTICATED_LIVE=1 gate.",
    );
  }
  const network = environment.PILOT_E2E_NETWORK?.trim();
  if (network !== "testnet" && network !== "devnet") {
    throw new Error(
      "authenticated-live requires PILOT_E2E_NETWORK=testnet or devnet; mainnet is never accepted.",
    );
  }
  requiredBaseURL(environment, "authenticated-live");
  throw new Error(LIVE_LANE_BLOCKS["authenticated-live"]);
}

export function laneTestMatch(lane: E2ELaneId): RegExp {
  switch (lane) {
    case "fixture":
      return /\.fixture\.spec\.ts$/;
    case "hosted-read":
      return /\.hosted-read\.spec\.ts$/;
    case "authenticated-live":
      return /\.authenticated-live\.spec\.ts$/;
  }
}
