import { createHash, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import {
  AGENTCORE_PUBLIC_MARKET_PAIR,
  AGENTCORE_PUBLIC_MARKET_VENUE,
} from "./contracts";
import type {
  AgentCoreLambdaMarketRead,
  AgentCoreLambdaMarketSource,
} from "./lambda-target";

export const AGENTCORE_XRPL_TESTNET_RPC = "https://s.altnet.rippletest.net:51234/" as const;
export const AGENTCORE_RLUSD_CURRENCY = "524C555344000000000000000000000000000000" as const;

const RIPPLE_EPOCH_UNIX_SECONDS = 946_684_800;
const MAX_OFFERS = 20;
const HASH = /^[A-F0-9]{64}$/;
const BASE58_ALPHABET = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";
const BASE58_INDEX = new Map([...BASE58_ALPHABET].map((character, index) => [character, BigInt(index)]));

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class AgentCorePublicMarketError extends Error {
  constructor(readonly code:
    | "configuration"
    | "invalid_request"
    | "transport"
    | "timeout"
    | "invalid_response"
    | "stale") {
    super(`AgentCore public market ${code.replaceAll("_", " ")}`);
    this.name = "AgentCorePublicMarketError";
  }
}

function decodeBase58(value: string): Uint8Array | undefined {
  let number = 0n;
  for (const character of value) {
    const digit = BASE58_INDEX.get(character);
    if (digit === undefined) return undefined;
    number = number * 58n + digit;
  }
  const bytes: number[] = [];
  while (number > 0n) {
    bytes.push(Number(number & 255n));
    number >>= 8n;
  }
  bytes.reverse();
  let leading = 0;
  while (value[leading] === BASE58_ALPHABET[0]) leading += 1;
  return Uint8Array.from([...new Array(leading).fill(0), ...bytes]);
}

export function isValidXrplClassicAddress(value: string): boolean {
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(value)) return false;
  const decoded = decodeBase58(value);
  if (!decoded || decoded.byteLength !== 25 || decoded[0] !== 0) return false;
  const payload = decoded.subarray(0, 21);
  const expected = decoded.subarray(21);
  const first = createHash("sha256").update(payload).digest();
  const actual = createHash("sha256").update(first).digest().subarray(0, 4);
  return timingSafeEqual(expected, actual);
}

const PairSchema = z
  .string()
  .trim()
  .regex(/^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}$/);
const CurrencySchema = z.union([
  z.literal("XRP"),
  z.string().regex(/^[A-Z0-9]{3}$/),
  z.string().regex(/^[A-F0-9]{40}$/),
]);

const AssetSchema = z
  .object({
    symbol: z.string().regex(/^[A-Z0-9]{2,12}$/),
    currency: CurrencySchema,
    issuer: z.string().optional(),
  })
  .strict()
  .superRefine((asset, context) => {
    if (asset.currency === "XRP") {
      if (asset.symbol !== "XRP" || asset.issuer !== undefined) {
        context.addIssue({ code: "custom", message: "XRP must not have an issuer" });
      }
      return;
    }
    if (!asset.issuer || !isValidXrplClassicAddress(asset.issuer)) {
      context.addIssue({ code: "custom", message: "Issued currency requires a valid classic issuer" });
    }
    if (asset.currency.length === 3 && asset.currency !== asset.symbol) {
      context.addIssue({ code: "custom", message: "Currency and symbol must match" });
    }
    if (asset.currency.length === 40) {
      const decoded = Buffer.from(asset.currency, "hex").toString("ascii").replace(/\0+$/u, "");
      if (decoded !== asset.symbol) {
        context.addIssue({ code: "custom", message: "Hex currency and symbol must match" });
      }
    }
  });

const ConfigSchema = z
  .object({
    endpoint: z.literal(AGENTCORE_XRPL_TESTNET_RPC),
    pair: PairSchema,
    venue: z.literal(AGENTCORE_PUBLIC_MARKET_VENUE),
    base: AssetSchema,
    quote: AssetSchema,
    timeoutMs: z.number().int().min(100).max(5_000).default(2_000),
    maxResponseBytes: z.number().int().min(1_024).max(512 * 1_024).default(128 * 1_024),
    maxLedgerAgeSeconds: z.number().int().min(15).max(300).default(120),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.pair !== `${config.base.symbol}/${config.quote.symbol}`) {
      context.addIssue({ code: "custom", message: "Pair and asset symbols must match" });
    }
    if (config.base.currency === config.quote.currency && config.base.issuer === config.quote.issuer) {
      context.addIssue({ code: "custom", message: "Pair assets must differ" });
    }
  });

export type AgentCorePublicMarketConfig = z.input<typeof ConfigSchema>;

const SourceInputSchema = z
  .object({
    requestId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    scopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const LedgerResultSchema = z
  .object({
    ledger_hash: z.string().regex(HASH),
    ledger_index: z.number().int().positive(),
    validated: z.literal(true),
    ledger: z.object({
      ledger_hash: z.string().regex(HASH),
      ledger_index: z.number().int().positive(),
      close_time: z.number().int().nonnegative(),
      close_time_resolution: z.number().int().min(1).max(120),
      closed: z.literal(true),
    }).passthrough(),
  })
  .passthrough();

const BookResultSchema = z
  .object({
    ledger_hash: z.string().regex(HASH),
    ledger_index: z.number().int().positive(),
    offers: z.array(z.unknown()).max(MAX_OFFERS),
  })
  .passthrough();

function asRpcAsset(asset: z.output<typeof AssetSchema>): Readonly<Record<string, string>> {
  return asset.currency === "XRP"
    ? { currency: "XRP" }
    : { currency: asset.currency, issuer: asset.issuer! };
}

async function boundedJson(response: Response, maximum: number, signal: AbortSignal): Promise<unknown> {
  if (response.redirected || response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new AgentCorePublicMarketError("transport");
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    await response.body?.cancel().catch(() => undefined);
    throw new AgentCorePublicMarketError("invalid_response");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel().catch(() => undefined);
    throw new AgentCorePublicMarketError("invalid_response");
  }
  if (!response.body) throw new AgentCorePublicMarketError("invalid_response");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    // Abort may race listener registration. Re-check only after registration,
    // while the reader is covered by the finally block below.
    if (signal.aborted) {
      cancel();
      throw new AgentCorePublicMarketError("timeout");
    }
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new AgentCorePublicMarketError("invalid_response");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof AgentCorePublicMarketError) throw error;
    throw new AgentCorePublicMarketError("invalid_response");
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new AgentCorePublicMarketError("invalid_response");
  }
}

async function beforeDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([parent, timeout]);
  if (signal.aborted) throw new AgentCorePublicMarketError("timeout");
  const pending = Promise.resolve().then(() => work(signal));
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new AgentCorePublicMarketError("timeout"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    void pending.catch(() => undefined);
  }
}

function rpcFailure(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return true;
  const response = value as Readonly<Record<string, unknown>>;
  if (response.error !== undefined || response.status === "error") return true;
  const result = response.result;
  return typeof result !== "object" || result === null || Array.isArray(result) ||
    (result as Readonly<Record<string, unknown>>).error !== undefined;
}

export function createXrplPublicMarketSource(input: Readonly<{
  config: AgentCorePublicMarketConfig;
  fetch?: FetchLike;
  now?: () => number;
}>): AgentCoreLambdaMarketSource {
  const parsed = ConfigSchema.safeParse(input.config);
  if (!parsed.success) throw new AgentCorePublicMarketError("configuration");
  const config = parsed.data;
  const transport = input.fetch ?? globalThis.fetch;
  const now = input.now ?? Date.now;

  async function rpc(method: "ledger" | "book_offers", params: Readonly<Record<string, unknown>>, signal: AbortSignal) {
    let response: Response;
    try {
      response = await transport(config.endpoint, {
        method: "POST",
        redirect: "error",
        signal,
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ method, params: [{ ...params, api_version: 2 }] }),
      });
    } catch (error) {
      if (signal.aborted) throw new AgentCorePublicMarketError("timeout");
      if (error instanceof AgentCorePublicMarketError) throw error;
      throw new AgentCorePublicMarketError("transport");
    }
    const body = await boundedJson(response, config.maxResponseBytes, signal);
    if (rpcFailure(body)) throw new AgentCorePublicMarketError("invalid_response");
    return (body as Readonly<{ result: unknown }>).result;
  }

  return Object.freeze({
    async read(raw: AgentCoreLambdaMarketRead, options: Readonly<{ signal: AbortSignal }>) {
      const request = SourceInputSchema.safeParse(raw);
      if (!request.success) {
        throw new AgentCorePublicMarketError("invalid_request");
      }
      return beforeDeadline(async (signal) => {
        const ledgerRaw = await rpc("ledger", {
          ledger_index: "validated",
          transactions: false,
          expand: false,
          owner_funds: false,
        }, signal);
        const ledger = LedgerResultSchema.safeParse(ledgerRaw);
        if (!ledger.success || ledger.data.ledger_hash !== ledger.data.ledger.ledger_hash || ledger.data.ledger_index !== ledger.data.ledger.ledger_index) {
          throw new AgentCorePublicMarketError("invalid_response");
        }
        const closeTimeMs = (ledger.data.ledger.close_time + RIPPLE_EPOCH_UNIX_SECONDS) * 1_000;
        const assertFresh = () => {
          const observedAt = now();
          if (!Number.isSafeInteger(observedAt) || closeTimeMs > observedAt + ledger.data.ledger.close_time_resolution * 1_000 || observedAt - closeTimeMs > config.maxLedgerAgeSeconds * 1_000) {
            throw new AgentCorePublicMarketError("stale");
          }
        };
        assertFresh();
        const bookRaw = await rpc("book_offers", {
          ledger_hash: ledger.data.ledger_hash,
          taker_gets: asRpcAsset(config.base),
          taker_pays: asRpcAsset(config.quote),
          limit: MAX_OFFERS,
        }, signal);
        const book = BookResultSchema.safeParse(bookRaw);
        if (!book.success || book.data.ledger_hash !== ledger.data.ledger_hash || book.data.ledger_index !== ledger.data.ledger_index) {
          throw new AgentCorePublicMarketError("invalid_response");
        }
        assertFresh();
        return {
          summary: `Validated XRPL Testnet ledger ${ledger.data.ledger_index} exposed ${book.data.offers.length} ask-side ${config.pair} offers in the bounded sample.`,
          evidence: [{
            source: AGENTCORE_PUBLIC_MARKET_VENUE,
            claim: `Read the exact configured ${config.pair} order book at one validated ledger, capped at ${MAX_OFFERS} offers.`,
            freshness: new Date(closeTimeMs).toISOString(),
          }],
          caveats: [
            "Read-only Testnet observation; no transaction was signed, submitted, or simulated.",
            `The sample is capped at ${MAX_OFFERS} ask-side offers and is not an executable price or full-depth guarantee.`,
            "Public XRPL RPC data is external evidence and never transaction authority.",
          ],
        };
      }, options.signal, config.timeoutMs);
    },
  });
}
