import type { Caveat, Network, Venue } from "@pilot/contracts";
import type { HarborClient } from "@pilot/harbor-client";

import type {
  PublicPilotConfig,
  WalletSessionStatus,
} from "@/lib/harbor-browser";

export type MapRuntimeContext = {
  canLoadCatalog: boolean;
  detail: string;
  key: string;
  kind:
    | "checking"
    | "configuration-error"
    | "public"
    | "session-error"
    | "session-mismatch"
    | "wallet";
  modeLabel: string;
  network: Network | null;
  owner: string | null;
};

export type VenueSnapshot<T> = {
  data: T;
  asOf: string;
  asOfBasis: string;
  caveats: Caveat[];
};

type MapHarborClient = Pick<HarborClient, "op">;

export type MapHarborClients = {
  live: MapHarborClient;
  mock: MapHarborClient;
};

/**
 * Select the catalog source only after the public config endpoint has returned
 * a schema-validated configuration. A missing/invalid configuration has no
 * client, and a live client failure must never fall back to mock fixtures.
 */
export function selectMapHarborClient(
  config: PublicPilotConfig | null | undefined,
  clients: MapHarborClients,
): MapHarborClient | null {
  if (!config || typeof (config as { mockMode?: unknown }).mockMode !== "boolean") return null;
  return config.mockMode ? clients.mock : clients.live;
}

function contextKey(
  config: PublicPilotConfig,
  owner: string | null,
  suffix: string,
): string {
  return [config.mockMode ? "mock" : "live", config.network, owner ?? "public", suffix].join(":");
}

export function resolveMapRuntimeContext(
  config: PublicPilotConfig | null | undefined,
  session: WalletSessionStatus | null | undefined,
): MapRuntimeContext {
  if (config === undefined || session === undefined) {
    return {
      canLoadCatalog: false,
      detail: "Checking Pilot's public configuration and wallet session.",
      key: "checking",
      kind: "checking",
      modeLabel: "Checking configuration",
      network: null,
      owner: null,
    };
  }

  if (config === null) {
    return {
      canLoadCatalog: false,
      detail: "Pilot's public test-network configuration is unavailable. No venue data was loaded.",
      key: "configuration-error",
      kind: "configuration-error",
      modeLabel: "Configuration unavailable",
      network: null,
      owner: null,
    };
  }

  const modeLabel = config.mockMode ? "Demo catalog · simulated Harbor" : "Live Harbor catalog";
  if (session === null) {
    return {
      canLoadCatalog: true,
      detail: "Wallet session status is unavailable. The public venue catalog has no account context.",
      key: contextKey(config, null, "session-error"),
      kind: "session-error",
      modeLabel,
      network: config.network,
      owner: null,
    };
  }

  if (!session.authenticated) {
    return {
      canLoadCatalog: true,
      detail: "No wallet session is connected. Showing the public catalog on Pilot's configured network.",
      key: contextKey(config, null, "public"),
      kind: "public",
      modeLabel,
      network: config.network,
      owner: null,
    };
  }

  if (session.network !== config.network) {
    return {
      canLoadCatalog: true,
      detail: "The wallet session is for a different network and was not used as account context.",
      key: contextKey(config, null, `mismatch-${session.network}`),
      kind: "session-mismatch",
      modeLabel,
      network: config.network,
      owner: null,
    };
  }

  return {
    canLoadCatalog: true,
    detail: `Connected wallet ${session.account} is UI context only; venue results remain public catalog metadata for ${session.network}.`,
    key: contextKey(config, session.account, "wallet"),
    kind: "wallet",
    modeLabel,
    network: session.network,
    owner: session.account,
  };
}

export async function fetchVenueCatalog(
  harbor: MapHarborClient,
): Promise<VenueSnapshot<Venue[]>> {
  const result = await harbor.op("venues.list", {});
  if (!result.ok) {
    throw new Error(result.error.message || "Harbor could not load the venue catalog.");
  }
  return {
    data: result.data,
    asOf: result.asOf,
    asOfBasis: result.asOfBasis,
    caveats: result.caveat ?? [],
  };
}

export async function fetchVenueDetail(
  harbor: MapHarborClient,
  id: string,
): Promise<VenueSnapshot<Venue>> {
  const result = await harbor.op("venues.get", { id });
  if (!result.ok) {
    throw new Error(result.error.message || "Harbor could not load this venue.");
  }
  if (result.data.id !== id) {
    throw new Error("Harbor returned a different venue than requested.");
  }
  return {
    data: result.data,
    asOf: result.asOf,
    asOfBasis: result.asOfBasis,
    caveats: result.caveat ?? [],
  };
}

export function createLatestRequestGuard() {
  let generation = 0;
  return {
    begin(): number {
      generation += 1;
      return generation;
    },
    invalidate(): void {
      generation += 1;
    },
    isCurrent(request: number): boolean {
      return request === generation;
    },
  };
}

export function mapErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export function safeVenueReferenceLinks(
  links: Readonly<Record<string, unknown>> | undefined,
): Array<[label: string, url: string]> {
  return Object.entries(links ?? {}).flatMap(([label, candidate]) => {
    if (typeof candidate !== "string") return [];
    try {
      const url = new URL(candidate);
      const host = canonicalReferenceHost(url.hostname);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        (url.port && url.port !== "443") ||
        !isPermittedReferenceHost(host)
      ) return [];
      url.hostname = host;
      return [[label, url.toString()]];
    } catch {
      return [];
    }
  });
}

function canonicalReferenceHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/g, "");
}

function isPermittedReferenceHost(host: string): boolean {
  // Harbor's generated venue catalog currently publishes XRPL documentation
  // references only. A strict domain boundary avoids maintaining a fragile
  // denylist for private, reserved, encoded, and alternate-literal addresses.
  return host === "xrpl.org" || host.endsWith(".xrpl.org");
}
