import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { Client, isValidClassicAddress } from "xrpl";
import { PILOT_ISOLATED_DEPLOYMENT_PROFILE } from "@pilot/wallet/isolation-profile";

import { authorizeDevFundingRequest } from "../authorize";
import {
  isLocalWalletProfile,
  resolvePilotRequestAuthority,
} from "../../../../lib/runtime-profile";
import {
  FileAcquisitionStateStore,
  type AcquisitionStateStore,
} from "../rlusd-acquisition/handler";

const NETWORKS = {
  testnet: {
    rpc: "wss://s.altnet.rippletest.net:51233",
    faucet: "https://faucet.altnet.rippletest.net/accounts",
  },
  devnet: {
    rpc: "wss://s.devnet.rippletest.net:51233",
    faucet: "https://faucet.devnet.rippletest.net/accounts",
  },
} as const;

const ACQUISITION_PURPOSE = "rlusd-acquisition";
const ACQUISITION_XRP_AMOUNT = "300";
export const ACQUISITION_REQUIRED_DROPS = 295_000_100n;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POLL_DELAYS_MS = [500, 1_000, 2_000, 4_000, 4_000, 4_000] as const;
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const MAX_RETRY_AFTER_SECONDS = 3_600;
const MAX_ACQUISITION_FAUCET_ATTEMPTS = 3;

type FaucetNetwork = keyof typeof NETWORKS;
type AccountClient = Pick<Client, "connect" | "disconnect" | "request">;
type FaucetPurpose = typeof ACQUISITION_PURPOSE;

type AcquisitionDispatchMarker = {
  version: 1;
  network: "testnet";
  owner: string;
  operation_id: string;
  attempt: number;
} & (
  | { state: "dispatched" }
  | { state: "rate_limited_until"; retry_at_ms: number }
);

export type FaucetDispatchClaim =
  | { status: "claimed"; attempt: number }
  | { status: "dispatched" }
  | { status: "exhausted" }
  | { status: "rate_limited"; retryAfterSeconds: number };

export interface FaucetDispatchStore {
  assertReady(): Promise<void>;
  /** Atomically claim the only dispatch permitted by the durable state. */
  claim(
    network: "testnet",
    owner: string,
    operationId: string,
    nowMs: number,
  ): Promise<FaucetDispatchClaim>;
  recordRateLimit(
    network: "testnet",
    owner: string,
    operationId: string,
    attempt: number,
    retryAtMs: number,
  ): Promise<void>;
}

export interface FaucetDependencies {
  acquisitionStateStore: Pick<
    AcquisitionStateStore,
    "assertReady" | "load" | "withOwnerLock"
  >;
  authorize(request: Request, address: string, network: FaucetNetwork): boolean;
  createClient(endpoint: string): AccountClient;
  dispatchStore: FaucetDispatchStore;
  environment: Readonly<Record<string, string | undefined>>;
  fetch: typeof fetch;
  isValidAddress(address: string): boolean;
  now(): number;
  sleep(delayMs: number): Promise<void>;
}

const defaults: Omit<FaucetDependencies, "acquisitionStateStore" | "dispatchStore"> = {
  authorize: authorizeDevFundingRequest,
  createClient: (endpoint) => new Client(endpoint),
  environment: process.env,
  fetch: globalThis.fetch,
  isValidAddress: isValidClassicAddress,
  now: Date.now,
  sleep: (delayMs) => new Promise((resolve) => globalThis.setTimeout(resolve, delayMs)),
};

function dispatchMarkerFileName(marker: AcquisitionDispatchMarker): string {
  return `${createHash("sha256")
    .update(
      `pilot.faucet.acquisition-dispatch.v1\0${marker.network}\0${marker.owner}\0${marker.operation_id}`,
      "utf8",
    )
    .digest("hex")}.faucet.json`;
}

class FileFaucetDispatchStore implements FaucetDispatchStore {
  constructor(
    private readonly directory: string | undefined,
    private readonly integritySecret: string | undefined,
    private readonly deploymentProfile?: typeof PILOT_ISOLATED_DEPLOYMENT_PROFILE,
  ) {}

  private integrity(marker: AcquisitionDispatchMarker): string {
    if (!this.integritySecret || this.integritySecret.length < 32) {
      throw new Error("SESSION_SECRET is unavailable for faucet dispatch integrity");
    }
    return createHmac("sha256", this.integritySecret)
      .update(
        this.deploymentProfile === PILOT_ISOLATED_DEPLOYMENT_PROFILE
          ? `pilot.faucet.acquisition-dispatch.v2\0${PILOT_ISOLATED_DEPLOYMENT_PROFILE}\0`
          : "pilot.faucet.acquisition-dispatch.v1\0",
        "utf8",
      )
      .update(marker.network, "utf8")
      .update("\0", "utf8")
      .update(marker.owner, "utf8")
      .update("\0", "utf8")
      .update(marker.operation_id, "utf8")
      .update("\0", "utf8")
      .update(String(marker.attempt), "utf8")
      .update("\0", "utf8")
      .update(marker.state, "utf8")
      .update("\0", "utf8")
      .update(marker.state === "rate_limited_until" ? String(marker.retry_at_ms) : "", "utf8")
      .digest("hex");
  }

  private async resolvedDirectory(): Promise<string> {
    if (!this.directory || !isAbsolute(this.directory)) {
      throw new Error("A preexisting absolute acquisition state directory is required");
    }
    const configuredPath = resolve(this.directory);
    const configured = await lstat(configuredPath);
    if (configured.isSymbolicLink()) {
      throw new Error("The configured acquisition state directory must not be a symlink");
    }
    const resolved = await realpath(configuredPath);
    const info = await stat(resolved);
    const currentUid = typeof process.getuid === "function"
      ? process.getuid()
      : undefined;
    if (
      !info.isDirectory() ||
      (info.mode & 0o077) !== 0 ||
      (currentUid !== undefined && info.uid !== currentUid)
    ) {
      throw new Error("The acquisition state directory must be user-only");
    }
    return resolved;
  }

  async assertReady(): Promise<void> {
    await this.resolvedDirectory();
    this.integrity({
      version: 1,
      network: "testnet",
      owner: "readiness-check",
      operation_id: "00000000-0000-4000-8000-000000000000",
      attempt: 1,
      state: "dispatched",
    });
  }

  private async validateExisting(
    path: string,
    expected: Pick<AcquisitionDispatchMarker, "network" | "owner" | "operation_id">,
  ): Promise<AcquisitionDispatchMarker> {
    const handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o777) !== 0o600) {
        throw new Error("The faucet dispatch marker has unsafe permissions");
      }
      const persisted: unknown = JSON.parse(await handle.readFile("utf8"));
      if (!persisted || typeof persisted !== "object" || Array.isArray(persisted)) {
        throw new Error("The faucet dispatch marker is invalid");
      }
      const value = persisted as Record<string, unknown>;
      const marker = value.marker;
      if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
        throw new Error("The faucet dispatch marker is invalid");
      }
      const record = marker as Record<string, unknown>;
      const isolated = this.deploymentProfile === PILOT_ISOLATED_DEPLOYMENT_PROFILE;
      const allowedMarkerFields = record.state === "rate_limited_until"
        ? ["version", "network", "owner", "operation_id", "attempt", "state", "retry_at_ms"]
        : ["version", "network", "owner", "operation_id", "attempt", "state"];
      if (
        (isolated
          ? value.version !== 2 ||
            value.deployment_profile !== PILOT_ISOLATED_DEPLOYMENT_PROFILE
          : value.version !== 1 || "deployment_profile" in value) ||
        Object.keys(value).some((key) => ![
          "version",
          ...(isolated ? ["deployment_profile"] : []),
          "marker",
          "integrity",
        ].includes(key)) ||
        Object.keys(record).some((key) => !allowedMarkerFields.includes(key)) ||
        record.version !== 1 ||
        record.network !== expected.network ||
        record.owner !== expected.owner ||
        record.operation_id !== expected.operation_id ||
        !Number.isSafeInteger(record.attempt) || Number(record.attempt) < 1 ||
        (record.state !== "dispatched" && record.state !== "rate_limited_until") ||
        (record.state === "rate_limited_until" &&
          (!Number.isSafeInteger(record.retry_at_ms) || Number(record.retry_at_ms) < 0)) ||
        typeof value.integrity !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.integrity)
      ) {
        throw new Error("The faucet dispatch marker is invalid");
      }
      const validated = record as AcquisitionDispatchMarker;
      const expectedMac = Buffer.from(this.integrity(validated), "hex");
      const actualMac = Buffer.from(value.integrity, "hex");
      if (
        actualMac.length !== expectedMac.length ||
        !timingSafeEqual(actualMac, expectedMac)
      ) {
        throw new Error("The faucet dispatch marker integrity check failed");
      }
      return validated;
    } finally {
      await handle.close();
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }

  private async writeTemporary(
    temporary: string,
    marker: AcquisitionDispatchMarker,
  ): Promise<void> {
    const handle = await open(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify({
        version: this.deploymentProfile === PILOT_ISOLATED_DEPLOYMENT_PROFILE ? 2 : 1,
        ...(this.deploymentProfile === PILOT_ISOLATED_DEPLOYMENT_PROFILE ? {
          deployment_profile: PILOT_ISOLATED_DEPLOYMENT_PROFILE,
        } : {}),
        marker,
        integrity: this.integrity(marker),
      })}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async publishExclusive(
    directory: string,
    destination: string,
    marker: AcquisitionDispatchMarker,
  ): Promise<boolean> {
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await this.writeTemporary(temporary, marker);
      try {
        await link(temporary, destination);
      } catch (cause) {
        if (isFileSystemError(cause, "EEXIST")) return false;
        throw cause;
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    await this.syncDirectory(directory);
    return true;
  }

  private async replace(
    directory: string,
    destination: string,
    marker: AcquisitionDispatchMarker,
  ): Promise<void> {
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await this.writeTemporary(temporary, marker);
      await rename(temporary, destination);
      await this.syncDirectory(directory);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async claim(
    network: "testnet",
    owner: string,
    operationId: string,
    nowMs: number,
  ): Promise<FaucetDispatchClaim> {
    const identity = { network, owner, operation_id: operationId } as const;
    const directory = await this.resolvedDirectory();
    const destination = join(directory, dispatchMarkerFileName({
      version: 1,
      ...identity,
      attempt: 1,
      state: "dispatched",
    }));
    let existing: AcquisitionDispatchMarker | undefined;
    try {
      existing = await this.validateExisting(destination, identity);
    } catch (cause) {
      if (!isFileSystemError(cause, "ENOENT")) throw cause;
    }

    if (!existing) {
      const initial: AcquisitionDispatchMarker = {
        version: 1,
        ...identity,
        attempt: 1,
        state: "dispatched",
      };
      if (await this.publishExclusive(directory, destination, initial)) {
        return { status: "claimed", attempt: 1 };
      }
      existing = await this.validateExisting(destination, identity);
    }

    if (existing.state === "dispatched") return { status: "dispatched" };
    if (existing.retry_at_ms > nowMs) {
      return {
        status: "rate_limited",
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((existing.retry_at_ms - nowMs) / 1_000),
        ),
      };
    }
    if (existing.attempt >= MAX_ACQUISITION_FAUCET_ATTEMPTS) {
      return { status: "exhausted" };
    }

    const next: AcquisitionDispatchMarker = {
      version: 1,
      ...identity,
      attempt: existing.attempt + 1,
      state: "dispatched",
    };
    const retryClaim = `${destination}.retry-${next.attempt}`;
    if (!(await this.publishExclusive(directory, retryClaim, next))) {
      let winner: AcquisitionDispatchMarker;
      try {
        winner = await this.validateExisting(retryClaim, identity);
      } catch (cause) {
        if (!isFileSystemError(cause, "ENOENT")) throw cause;
        winner = await this.validateExisting(destination, identity);
      }
      if (winner.state !== "dispatched" || winner.attempt !== next.attempt) {
        throw new Error("The faucet retry claim is invalid");
      }
      return { status: "dispatched" };
    }

    await this.replace(directory, destination, next);
    // Keep the per-attempt claim permanently. It is the append-only witness
    // that prevents a delayed process with a stale rate-limit read from
    // recreating the same claim after the winner updates the main marker.
    await this.syncDirectory(directory);
    return { status: "claimed", attempt: next.attempt };
  }

  async recordRateLimit(
    network: "testnet",
    owner: string,
    operationId: string,
    attempt: number,
    retryAtMs: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(retryAtMs) || retryAtMs < 0) {
      throw new Error("The faucet retry time is invalid");
    }
    const identity = { network, owner, operation_id: operationId } as const;
    const directory = await this.resolvedDirectory();
    const dispatched: AcquisitionDispatchMarker = {
      version: 1,
      ...identity,
      attempt,
      state: "dispatched",
    };
    const destination = join(directory, dispatchMarkerFileName(dispatched));
    const existing = await this.validateExisting(destination, identity);
    if (existing.state !== "dispatched" || existing.attempt !== attempt) {
      throw new Error("The faucet dispatch attempt cannot be rate limited");
    }
    await this.replace(directory, destination, {
      version: 1,
      ...identity,
      attempt,
      state: "rate_limited_until",
      retry_at_ms: retryAtMs,
    });
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === code;
}

function error(
  code: string,
  message: string,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store", ...headers } },
  );
}

function network(value: unknown): FaucetNetwork | undefined {
  return value === "testnet" || value === "devnet" ? value : undefined;
}

function localAcquisitionAllowed(
  request: Request,
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  try {
    const authority = resolvePilotRequestAuthority(environment, request);
    return isLocalWalletProfile(authority.profile) &&
      request.headers.get("origin") === authority.origin &&
      environment.HARBOR_MOCK === "0" &&
      environment.EXEC_NETWORK === "testnet" &&
      environment.NEXT_PUBLIC_DEV_SIGNER === "1";
  } catch {
    return false;
  }
}

function parseBalance(result: unknown, address: string): bigint | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const outer = result as Record<string, unknown>;
  const payload = outer.result;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const value = payload as Record<string, unknown>;
  const accountData = value.account_data;
  if (
    value.validated !== true ||
    !accountData || typeof accountData !== "object" || Array.isArray(accountData)
  ) return undefined;
  const data = accountData as Record<string, unknown>;
  if (data.Account !== address || typeof data.Balance !== "string" || !/^\d+$/.test(data.Balance)) {
    return undefined;
  }
  return BigInt(data.Balance);
}

async function accountBalance(
  dependencies: FaucetDependencies,
  selected: FaucetNetwork,
  address: string,
): Promise<bigint | undefined> {
  const client = dependencies.createClient(NETWORKS[selected].rpc);
  await client.connect();
  try {
    const response = await client.request({
      command: "account_info",
      account: address,
      ledger_index: "validated",
    });
    const balance = parseBalance(response, address);
    if (balance === undefined) throw new Error("INVALID_VALIDATED_ACCOUNT_INFO");
    return balance;
  } catch (cause) {
    const ledgerError = cause as { data?: { error?: unknown } };
    if (ledgerError.data?.error === "actNotFound") return undefined;
    throw cause;
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

type ParsedRetryAfter = {
  retryAtMs: number;
  seconds: number;
  exceedsLocalMaximum: boolean;
};

function retryAfter(response: Response, nowMs: number): ParsedRetryAfter {
  const raw = response.headers.get("retry-after");
  let seconds = DEFAULT_RETRY_AFTER_SECONDS;

  if (raw !== null && /^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (
      Number.isSafeInteger(parsed) && parsed >= 1 &&
      Number.isSafeInteger(nowMs + parsed * 1_000)
    ) {
      seconds = parsed;
    }
  } else if (raw !== null) {
    const retryAt = Date.parse(raw);
    const serverDate = Date.parse(response.headers.get("date") ?? "");
    const referenceTime = Number.isFinite(serverDate) ? serverDate : nowMs;
    const parsed = Math.ceil((retryAt - referenceTime) / 1_000);
    if (
      Number.isFinite(retryAt) && Number.isSafeInteger(parsed) && parsed >= 1 &&
      Number.isSafeInteger(nowMs + parsed * 1_000)
    ) {
      // Date is the server's clock reference, so a skewed local wall clock
      // cannot shorten an absolute Retry-After instruction.
      seconds = parsed;
    }
  }

  return {
    retryAtMs: nowMs + seconds * 1_000,
    seconds,
    exceedsLocalMaximum: seconds > MAX_RETRY_AFTER_SECONDS,
  };
}

/** Test-network-only XRP funding. It never receives or returns wallet secrets. */
export function createFaucetHandler(
  overrides: Partial<FaucetDependencies> = {},
): (request: Request) => Promise<Response> {
  const environment = overrides.environment ?? defaults.environment;
  const dependencies: FaucetDependencies = {
    ...defaults,
    ...overrides,
    environment,
    acquisitionStateStore: overrides.acquisitionStateStore ?? new FileAcquisitionStateStore(
      environment.P_LIVE_RLUSD_ACQUISITION_STATE_DIR,
      environment.SESSION_SECRET,
      {
        deploymentProfile: environment.PILOT_DEPLOYMENT_PROFILE === PILOT_ISOLATED_DEPLOYMENT_PROFILE
          ? PILOT_ISOLATED_DEPLOYMENT_PROFILE
          : undefined,
      },
    ),
    dispatchStore: overrides.dispatchStore ?? new FileFaucetDispatchStore(
      environment.P_LIVE_RLUSD_ACQUISITION_STATE_DIR,
      environment.SESSION_SECRET,
      environment.PILOT_DEPLOYMENT_PROFILE === PILOT_ISOLATED_DEPLOYMENT_PROFILE
        ? PILOT_ISOLATED_DEPLOYMENT_PROFILE
        : undefined,
    ),
  };
  const inFlight = new Set<string>();
  const cooldownUntil = new Map<string, number>();
  return async (request) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return error("INVALID_JSON", "A JSON request body is required.", 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return error("INVALID_REQUEST", "A test-network address and network are required.", 400);
    }
    const value = body as Record<string, unknown>;
    const selected = network(value.network);
    if (!selected) {
      return error("UNSUPPORTED_NETWORK", "Faucet funding is limited to testnet and devnet.", 400);
    }
    if (typeof value.address !== "string" || !dependencies.isValidAddress(value.address)) {
      return error("INVALID_ADDRESS", "A valid XRPL classic address is required.", 400);
    }
    const purpose = value.purpose as FaucetPurpose | undefined;
    const acquisition = purpose === ACQUISITION_PURPOSE;
    const allowed = acquisition
      ? new Set(["address", "network", "purpose", "operation_id"])
      : new Set(["address", "network"]);
    if (
      Object.keys(value).some((key) => !allowed.has(key)) ||
      (value.purpose !== undefined && !acquisition) ||
      (acquisition && (selected !== "testnet" || typeof value.operation_id !== "string" || !OPERATION_ID.test(value.operation_id)))
    ) {
      return error("INVALID_REQUEST", "Unsupported faucet request field or purpose.", 400);
    }
    let acquisitionAllowed = false;
    try {
      acquisitionAllowed = acquisition && localAcquisitionAllowed(request, dependencies.environment);
    } catch {
      acquisitionAllowed = false;
    }
    if (acquisition && !acquisitionAllowed) {
      return error("LOCAL_DEV_ONLY", "RLUSD acquisition funding is available only to the local Testnet development signer.", 403);
    }
    if (!dependencies.authorize(request, value.address, selected)) {
      return error(
        "UNAUTHORIZED",
        "Wallet authorization for this test-network account is required for faucet funding.",
        401,
      );
    }
    const address = value.address;
    const operationId = acquisition ? String(value.operation_id) : undefined;
    if (acquisition) {
      try {
        await Promise.all([
          dependencies.dispatchStore.assertReady(),
          dependencies.acquisitionStateStore.assertReady(),
        ]);
      } catch {
        return error(
          "ACQUISITION_STATE_UNAVAILABLE",
          "The durable local acquisition state is unavailable.",
          503,
        );
      }
    }

    const performFunding = async (): Promise<Response> => {
      const key = `${selected}:${address}:${purpose ?? "activation"}`;
      if (inFlight.has(key)) {
        return error("REQUEST_IN_PROGRESS", "Funding is already in progress for this address.", 409);
      }
      inFlight.add(key);
      try {
      const initialBalance = await accountBalance(dependencies, selected, address);
      const requiredDrops = acquisition ? ACQUISITION_REQUIRED_DROPS : 1n;
      if (initialBalance !== undefined && initialBalance >= requiredDrops) {
        return Response.json(
          {
            address,
            network: selected,
            funded: true,
            alreadySufficient: true,
            balanceDrops: initialBalance.toString(),
            requiredDrops: requiredDrops.toString(),
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      }

      const now = dependencies.now();
      const limitedUntil = cooldownUntil.get(key) ?? 0;
      if (limitedUntil > now) {
        const seconds = Math.max(1, Math.ceil((limitedUntil - now) / 1_000));
        return error("FAUCET_RATE_LIMITED", "Wait before requesting more test XRP for this account.", 429, {
          "Retry-After": String(seconds),
        });
      }

      let acquisitionAttempt: number | undefined;
      if (acquisition) {
        let claim: FaucetDispatchClaim;
        try {
          claim = await dependencies.dispatchStore.claim(
            "testnet",
            address,
            operationId!,
            now,
          );
        } catch {
          return error(
            "ACQUISITION_STATE_UNAVAILABLE",
            "The durable local acquisition state is unavailable.",
            503,
          );
        }
        if (claim.status === "rate_limited") {
          return error(
            "FAUCET_RATE_LIMITED",
            "The public Testnet faucet asked Pilot to wait before retrying.",
            429,
            { "Retry-After": String(claim.retryAfterSeconds) },
          );
        }
        if (claim.status === "exhausted") {
          return error(
            "FAUCET_RETRY_EXHAUSTED",
            "The bounded public Testnet faucet retry budget is exhausted for this acquisition.",
            409,
          );
        }
        if (claim.status === "dispatched") {
          return Response.json(
            {
              address,
              network: selected,
              funded: false,
              pending: true,
              requiredDrops: ACQUISITION_REQUIRED_DROPS.toString(),
              message: "The prior faucet request is still awaiting validated Testnet XRP headroom.",
            },
            { status: 202, headers: { "Cache-Control": "no-store", "Retry-After": "60" } },
          );
        }
        acquisitionAttempt = claim.attempt;
      }

      // For acquisition requests, the durable dispatched marker was published
      // before this point. Ambiguous outcomes therefore remain balance-only.
      const response = await dependencies.fetch(NETWORKS[selected].faucet, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          destination: address,
          ...(acquisition ? { xrpAmount: ACQUISITION_XRP_AMOUNT } : {}),
        }),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 429) {
        const retry = retryAfter(response, dependencies.now());
        if (acquisition) {
          try {
            await dependencies.dispatchStore.recordRateLimit(
              "testnet",
              address,
              operationId!,
              acquisitionAttempt!,
              retry.retryAtMs,
            );
          } catch {
            return error(
              "ACQUISITION_STATE_UNAVAILABLE",
              "The durable local acquisition state is unavailable.",
              503,
            );
          }
        } else {
          cooldownUntil.set(key, retry.retryAtMs);
        }
        const message = retry.exceedsLocalMaximum
          ? "The public Testnet faucet asked Pilot to wait beyond the local retry window."
          : "The public Testnet faucet asked Pilot to wait before retrying.";
        return error("FAUCET_RATE_LIMITED", message, 429, {
          "Retry-After": String(retry.seconds),
        });
      }
      if (!response.ok) {
        return error("FAUCET_UNAVAILABLE", "The public test-network faucet did not accept the request.", 502);
      }

      if (!acquisition) {
        return Response.json(
          { address, network: selected, funded: true, alreadySufficient: false },
          { headers: { "Cache-Control": "no-store" } },
        );
      }

      // The POST is deliberately never retried. After an accepted request, only
      // bounded validated-ledger reads are repeated.
      for (const delayMs of POLL_DELAYS_MS) {
        await dependencies.sleep(delayMs);
        const balance = await accountBalance(dependencies, selected, address);
        if (balance !== undefined && balance >= ACQUISITION_REQUIRED_DROPS) {
          return Response.json(
            {
              address,
              network: selected,
              funded: true,
              alreadySufficient: false,
              balanceDrops: balance.toString(),
              requiredDrops: ACQUISITION_REQUIRED_DROPS.toString(),
            },
            { headers: { "Cache-Control": "no-store" } },
          );
        }
      }
      return Response.json(
        {
          address,
          network: selected,
          funded: false,
          pending: true,
          requiredDrops: ACQUISITION_REQUIRED_DROPS.toString(),
          message: "The faucet accepted the request, but validated Testnet XRP headroom is not visible yet. Check status before retrying.",
        },
        { status: 202, headers: { "Cache-Control": "no-store", "Retry-After": "60" } },
      );
    } catch {
      return error(
        "FAUCET_OUTCOME_UNKNOWN",
        "The public test-network faucet outcome is unknown. Check the validated balance before retrying.",
        502,
      );
      } finally {
        inFlight.delete(key);
      }
    };

    if (!acquisition) return performFunding();
    try {
      return await dependencies.acquisitionStateStore.withOwnerLock(address, async () => {
        const state = await dependencies.acquisitionStateStore.load(address);
        if (
          !state || state.owner !== address || state.network !== "testnet" ||
          state.operation_id !== operationId || state.status !== "initializing"
        ) {
          return error(
            "ACQUISITION_OPERATION_NOT_AUTHORIZED",
            "The faucet operation is not the active server-owned initial RLUSD acquisition operation.",
            409,
          );
        }
        return performFunding();
      });
    } catch {
      return error(
        "ACQUISITION_STATE_UNAVAILABLE",
        "The durable local acquisition state is unavailable.",
        503,
      );
    }
  };
}
