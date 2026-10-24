import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  chmod,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { inspectHermesPrivateMacAcl } from "./hermes-profile-gate";
import {
  HERMES_PROFILE_RUNTIME_INVARIANTS,
  type HermesProfileRuntimeInvariants,
} from "./hermes-profile-contract";
import { HERMES_PROPOSAL_SYSTEM_INSTRUCTIONS } from "@pilot/agent/hermes-transport";

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const LEASE_MODEL = /^pilot-hermes-lease-[A-Za-z0-9_-]{43}$/;
const DAY_MS = 86_400_000;
const MAX_TTL_MS = 60_000;
const MAX_RECORDS = 2_048;
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
const CONTROL_BODY_LIMIT = 8 * 1024;

export const HERMES_BRIDGE_PROFILE_INVARIANTS =
  HERMES_PROFILE_RUNTIME_INVARIANTS;

export type HermesBridgeMessage = Readonly<{
  role: "system" | "user" | "assistant";
  content: string;
}>;

export type HermesBridgeProfileInvariants = HermesProfileRuntimeInvariants;

export type HermesBridgeConfig = Readonly<{
  controlOrigin: string;
  ingressOrigin: string;
  controlBearer: string;
  controlResponseKey: string;
  ingressBearer: string;
  upstreamUrl: string;
  upstreamCredential: string;
  profile: string;
  provider: string;
  model: string;
  tokenParameter: "max_tokens" | "max_completion_tokens";
  outputTokens: number;
  maxInputBytes: number;
  maxMessages: number;
  maxResponseBytes: number;
  timeoutMs: number;
  framingTokenAllowance: number;
  inputMicrousdPerMillionTokens: number;
  outputMicrousdPerMillionTokens: number;
  maxCallMicrousd: number;
  maxDailyMicrousd: number;
  journalRoot: string;
  journalPath: string;
  profileInvariants: HermesBridgeProfileInvariants;
}>;

export type HermesBridgeLeaseInput = Readonly<{
  scopeDigest: string;
  userContent: string;
  messageDigest: string;
  sessionId: string;
  profile: string;
  provider: string;
  model: string;
  ttlMs?: number;
}>;

declare const HERMES_BRIDGE_AUTHORIZATION: unique symbol;
export type HermesBridgeAuthorization = Readonly<{
  readonly [HERMES_BRIDGE_AUTHORIZATION]: true;
  leaseModel: string;
  expiresAt: number;
  scopeDigest: string;
  userContentDigest: string;
  messageDigest: string;
  sessionId: string;
  profile: string;
  provider: string;
  model: string;
  profileInvariantsDigest: string;
  bridgeConfigDigest: string;
}>;

export type HermesBridgeCaller = Readonly<{ remoteAddress: string }>;

export type HermesBridgeUsage = Readonly<{
  attempts: number;
  completed: number;
  uncertain: number;
  reservedMicrousd: number;
  chargedMicrousd: number;
}>;

export type HermesBridgePublicContract = Readonly<{
  profile: string;
  provider: string;
  model: string;
  profileInvariantsDigest: string;
  bridgeConfigDigest: string;
}>;

export type HermesBridgeReadiness = HermesBridgePublicContract & Readonly<{
  status: "ready";
  singleProcessPortOwnershipRequired: true;
}>;

export type HermesBridgeService = Readonly<{
  contract: HermesBridgePublicContract;
  handleControl(request: Request, caller: HermesBridgeCaller): Promise<Response>;
  handleIngress(request: Request, caller: HermesBridgeCaller): Promise<Response>;
  usage(scopeDigest: string): Promise<HermesBridgeUsage>;
}>;

export type HermesBridgeClient = Readonly<{
  attestReady(signal?: AbortSignal): Promise<HermesBridgeReadiness>;
  authorize(input: HermesBridgeLeaseInput, signal?: AbortSignal): Promise<HermesBridgeAuthorization>;
}>;

export type HermesBridgeClientConfig = HermesBridgePublicContract & Readonly<{
  controlOrigin: string;
  controlBearer: string;
  controlResponseKey: string;
}>;

export type HermesBridgeClientDependencies = Readonly<{
  now?: () => number;
  controlTimeoutMs?: number;
}>;

export class HermesBridgeError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 400) {
    super(`Hermes bridge rejected the request (${code})`);
    this.name = "HermesBridgeError";
    this.code = code;
    this.status = status;
  }
}

type LeaseRecord = {
  leaseModel: string;
  scopeDigest: string;
  userContentDigest: string;
  messageDigest: string;
  sessionId: string;
  profile: string;
  provider: string;
  model: string;
  bridgeConfigDigest: string;
  profileInvariantsDigest: string;
  issuedAt: number;
  expiresAt: number;
  attemptedAt?: number;
  state: "armed" | "attempting" | "completed" | "uncertain" | "expired";
  receivedMessagesDigest?: string;
  reservedMicrousd: number;
  chargedMicrousd: number;
  completedAt?: number;
};

type Journal = { version: 1; records: LeaseRecord[] };

type Dependencies = Readonly<{
  fetch?: typeof fetch;
  now?: () => number;
  random?: (size: number) => Uint8Array;
  /** Test-only observation hook; production composition must omit it. */
  onJournalAccess?: () => void;
  /** Test-only ACL seam for portable ancestor-chain fixtures. */
  macAclInspectorForTest?: (target: string) => void;
}>;

type ValidConfig = HermesBridgeConfig & {
  controlOrigin: string;
  ingressOrigin: string;
  upstreamUrl: string;
  bridgeConfigDigest: string;
  profileInvariantsDigest: string;
};

const brandedAuthorizations = new WeakSet<object>();
const pendingActivations = new WeakMap<object, {
  controlOrigin: string;
  ingressOrigin: string;
  activate: () => Promise<void>;
  deactivate: () => void;
}>();

export function isHermesBridgeAuthorization(value: unknown): value is HermesBridgeAuthorization {
  return typeof value === "object" && value !== null && brandedAuthorizations.has(value);
}

function fail(code: string, status = 400): never {
  throw new HermesBridgeError(code, status);
}

function assertPrivateAcl(target: string, testInspector?: (target: string) => void): void {
  if (!testInspector && process.platform !== "darwin") return;
  try {
    (testInspector ?? inspectHermesPrivateMacAcl)(target);
  } catch {
    fail("unsafe_journal_acl", 500);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function digestHermesBridgeUserContent(content: string): string {
  if (typeof content !== "string" || content.length < 1 || content.length > 32_000 || content.includes("\0")) {
    fail("invalid_user_content");
  }
  return digest(content);
}

export function digestHermesBridgeMessages(messages: readonly HermesBridgeMessage[]): string {
  return digest(stableJson(messages));
}

function normalizedProviderMessages(userContent: string): readonly HermesBridgeMessage[] {
  return Object.freeze([
    Object.freeze({ role: "system" as const, content: HERMES_PROPOSAL_SYSTEM_INSTRUCTIONS }),
    Object.freeze({ role: "user" as const, content: userContent }),
  ]);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

function fixedOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { return fail("invalid_configuration", 500); }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username || url.password || url.search || url.hash ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.port === ""
  ) fail("invalid_configuration", 500);
  return url.origin;
}

function fixedUpstream(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { return fail("invalid_configuration", 500); }
  if (
    url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
    !url.pathname.endsWith("/chat/completions")
  ) fail("invalid_configuration", 500);
  return url.toString();
}

function sameInvariants(value: unknown): value is HermesBridgeProfileInvariants {
  return stableJson(value) === stableJson(HERMES_BRIDGE_PROFILE_INVARIANTS);
}

function validateConfig(input: HermesBridgeConfig): ValidConfig {
  const controlOrigin = fixedOrigin(input.controlOrigin);
  const ingressOrigin = fixedOrigin(input.ingressOrigin);
  const upstreamUrl = fixedUpstream(input.upstreamUrl);
  if (
    controlOrigin === ingressOrigin ||
    ![input.controlBearer, input.controlResponseKey, input.ingressBearer].every(
      (secret) => typeof secret === "string" && secret.length >= 32 && secret.length <= 512 && !/[\0\r\n]/.test(secret),
    ) ||
    typeof input.upstreamCredential !== "string" || input.upstreamCredential.length < 16 ||
    /[\0\r\n]/.test(input.upstreamCredential) ||
    new Set([input.controlBearer, input.controlResponseKey, input.ingressBearer, input.upstreamCredential]).size !== 4 ||
    ![input.profile, input.provider, input.model].every(
      (id) => typeof id === "string" && SAFE_ID.test(id) && id.length <= 128,
    ) ||
    !sameInvariants(input.profileInvariants) ||
    ![input.outputTokens, input.maxInputBytes, input.maxMessages, input.maxResponseBytes,
      input.timeoutMs, input.framingTokenAllowance, input.inputMicrousdPerMillionTokens,
      input.outputMicrousdPerMillionTokens, input.maxCallMicrousd, input.maxDailyMicrousd]
      .every(Number.isSafeInteger) ||
    !integer(input.outputTokens, 1, 2_048) ||
    !integer(input.maxInputBytes, 512, 128 * 1024) ||
    !integer(input.maxMessages, 1, 32) ||
    !integer(input.maxResponseBytes, 512, 256 * 1024) ||
    !integer(input.timeoutMs, 100, 60_000) ||
    !integer(input.framingTokenAllowance, 1, 4_096) ||
    !integer(input.inputMicrousdPerMillionTokens, 1, 1_000_000_000) ||
    !integer(input.outputMicrousdPerMillionTokens, 1, 1_000_000_000) ||
    !integer(input.maxCallMicrousd, 1, 1_000_000_000) ||
    !integer(input.maxDailyMicrousd, input.maxCallMicrousd, 1_000_000_000) ||
    !isAbsolute(input.journalRoot) || !isAbsolute(input.journalPath) ||
    resolve(input.journalPath) !== input.journalPath ||
    dirname(input.journalPath) !== input.journalRoot ||
    (input.tokenParameter !== "max_tokens" && input.tokenParameter !== "max_completion_tokens")
  ) fail("invalid_configuration", 500);
  const profileInvariantsDigest = digest(stableJson(input.profileInvariants));
  const bridgeConfigDigest = digest(stableJson({
    controlOrigin, ingressOrigin, upstreamUrl,
    profile: input.profile, provider: input.provider, model: input.model,
    tokenParameter: input.tokenParameter, outputTokens: input.outputTokens,
    maxInputBytes: input.maxInputBytes, maxMessages: input.maxMessages,
    maxResponseBytes: input.maxResponseBytes, timeoutMs: input.timeoutMs,
    framingTokenAllowance: input.framingTokenAllowance,
    inputMicrousdPerMillionTokens: input.inputMicrousdPerMillionTokens,
    outputMicrousdPerMillionTokens: input.outputMicrousdPerMillionTokens,
    maxCallMicrousd: input.maxCallMicrousd, maxDailyMicrousd: input.maxDailyMicrousd,
    profileInvariantsDigest,
  }));
  return { ...input, controlOrigin, ingressOrigin, upstreamUrl, profileInvariantsDigest, bridgeConfigDigest };
}

function constantBearer(header: string | null, expected: string): void {
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) fail("unauthorized", 401);
}

function loopback(caller: HermesBridgeCaller): void {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(caller.remoteAddress)) {
    fail("non_loopback_peer", 403);
  }
}

function exactEndpoint(request: Request, origin: string, path: string, method: string): void {
  let url: URL;
  try { url = new URL(request.url); } catch { return fail("invalid_endpoint", 403); }
  if (
    request.method !== method || url.origin !== origin || url.pathname !== path || url.search || url.hash ||
    request.headers.get("host") !== new URL(origin).host
  ) fail("invalid_endpoint", 403);
}

async function boundedJson(request: Request, limit: number): Promise<{ value: unknown; bytes: number }> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) fail("request_too_large", 413);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    fail("invalid_content_type", 415);
  }
  const reader = request.body?.getReader();
  if (!reader) fail("missing_body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      fail("request_too_large", 413);
    }
    chunks.push(next.value);
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
  try { return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), bytes: total }; }
  catch { return fail("invalid_json"); }
}

function parseMessages(value: unknown, maximum: number): HermesBridgeMessage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) fail("invalid_messages");
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) fail("invalid_messages");
    const item = candidate as Record<string, unknown>;
    if (!exactKeys(item, ["content", "role"]) ||
      !["system", "user", "assistant"].includes(item.role as string) ||
      typeof item.content !== "string" || item.content.length < 1 || item.content.length > 32_000 || item.content.includes("\0")) {
      fail("invalid_messages");
    }
    return { role: item.role, content: item.content } as HermesBridgeMessage;
  });
}

function parseIngress(value: unknown, maxMessages: number): { leaseModel: string; messages: HermesBridgeMessage[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_request");
  const body = value as Record<string, unknown>;
  // Pinned Hermes v0.22.2's custom OpenAI transport omits the optional
  // false/empty tool fields and adds its fixed default reasoning marker. The
  // bridge accepts only that observed envelope and never forwards the marker;
  // the provider request below remains a fresh fixed four-field payload.
  const allowed = ["messages", "model", "reasoning_effort", "stream", "tool_choice", "tools"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) fail("unsupported_request_field");
  if (typeof body.model !== "string" || !LEASE_MODEL.test(body.model)) fail("invalid_lease");
  if (body.stream !== undefined && body.stream !== false) fail("streaming_not_allowed");
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length !== 0)) fail("tools_not_allowed");
  if (body.tool_choice !== undefined && body.tool_choice !== "none") fail("tools_not_allowed");
  if (body.reasoning_effort !== undefined && body.reasoning_effort !== "medium") {
    fail("unsupported_reasoning_effort");
  }
  return { leaseModel: body.model, messages: parseMessages(body.messages, maxMessages) };
}

function parseLeaseRequest(value: unknown): Omit<HermesBridgeLeaseInput, "userContent"> & { userContentDigest: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_lease_request");
  const body = value as Record<string, unknown>;
  const allowed = ["messageDigest", "model", "profile", "provider", "scopeDigest", "sessionId", "ttlMs", "userContentDigest"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) fail("invalid_lease_request");
  if (!exactKeys(body, body.ttlMs === undefined ? allowed.filter((key) => key !== "ttlMs") : allowed) ||
    !SHA256.test(body.scopeDigest as string) || !SHA256.test(body.userContentDigest as string) ||
    !SHA256.test(body.messageDigest as string) ||
    typeof body.profile !== "string" || typeof body.provider !== "string" || typeof body.model !== "string" ||
    typeof body.sessionId !== "string" || !SAFE_SESSION.test(body.sessionId) ||
    (body.ttlMs !== undefined && !integer(body.ttlMs, 1, MAX_TTL_MS))) fail("invalid_lease_request");
  return body as ReturnType<typeof parseLeaseRequest>;
}

function sign(key: string, value: unknown): string {
  return createHmac("sha256", key).update(stableJson(value), "utf8").digest("base64url");
}

function signedPayload(record: LeaseRecord, config: ValidConfig) {
  return {
    leaseModel: record.leaseModel,
    expiresAt: record.expiresAt,
    scopeDigest: record.scopeDigest,
    userContentDigest: record.userContentDigest,
    messageDigest: record.messageDigest,
    sessionId: record.sessionId,
    profile: record.profile,
    provider: record.provider,
    model: record.model,
    profileInvariantsDigest: config.profileInvariantsDigest,
    bridgeConfigDigest: config.bridgeConfigDigest,
  };
}

function parseAuthorizationResponse(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_control_response", 502);
  const body = value as Record<string, unknown>;
  const keys = ["attestation", "bridgeConfigDigest", "expiresAt", "leaseModel", "messageDigest", "model", "profile", "profileInvariantsDigest", "provider", "scopeDigest", "sessionId", "userContentDigest"];
  if (!exactKeys(body, keys)) fail("invalid_control_response", 502);
  return body;
}

function dayStart(timestamp: number): number {
  return Math.floor(timestamp / DAY_MS) * DAY_MS;
}

function costCeiling(config: ValidConfig, bytes: number): { inputTokens: number; microusd: number } {
  const inputTokens = bytes + config.framingTokenAllowance;
  const inputCost = Math.ceil((inputTokens * config.inputMicrousdPerMillionTokens) / 1_000_000);
  const outputCost = Math.ceil((config.outputTokens * config.outputMicrousdPerMillionTokens) / 1_000_000);
  const microusd = inputCost + outputCost;
  if (!Number.isSafeInteger(microusd) || microusd > config.maxCallMicrousd) fail("call_cost_cap_exceeded", 402);
  return { inputTokens, microusd };
}

function validRecord(value: unknown): value is LeaseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as LeaseRecord;
  const required = ["bridgeConfigDigest", "chargedMicrousd", "expiresAt", "issuedAt", "leaseModel", "messageDigest", "model", "profile", "profileInvariantsDigest", "provider", "reservedMicrousd", "scopeDigest", "sessionId", "state", "userContentDigest"];
  const optional = ["attemptedAt", "completedAt", "receivedMessagesDigest"];
  if (Object.keys(r).some((key) => !required.includes(key) && !optional.includes(key)) || required.some((key) => !Object.hasOwn(r, key))) return false;
  if (!(LEASE_MODEL.test(r.leaseModel) && SHA256.test(r.scopeDigest) && SHA256.test(r.userContentDigest) && SHA256.test(r.messageDigest) &&
    SHA256.test(r.bridgeConfigDigest) && SHA256.test(r.profileInvariantsDigest) &&
    SAFE_ID.test(r.profile) && SAFE_ID.test(r.provider) && SAFE_ID.test(r.model) && SAFE_SESSION.test(r.sessionId) &&
    integer(r.issuedAt, 0, Number.MAX_SAFE_INTEGER) && integer(r.expiresAt, 0, Number.MAX_SAFE_INTEGER) &&
    r.expiresAt > r.issuedAt && r.expiresAt <= r.issuedAt + MAX_TTL_MS &&
    ["armed", "attempting", "completed", "uncertain", "expired"].includes(r.state) &&
    integer(r.reservedMicrousd, 0, 1_000_000_000) && integer(r.chargedMicrousd, 0, 1_000_000_000) &&
    (r.receivedMessagesDigest === undefined || SHA256.test(r.receivedMessagesDigest)) &&
    (r.attemptedAt === undefined || integer(r.attemptedAt, 0, Number.MAX_SAFE_INTEGER)) &&
    (r.completedAt === undefined || integer(r.completedAt, 0, Number.MAX_SAFE_INTEGER)))) return false;
  if (r.state === "armed" || r.state === "expired") {
    return r.receivedMessagesDigest === undefined && r.reservedMicrousd === 0 &&
      r.chargedMicrousd === 0 && r.attemptedAt === undefined && r.completedAt === undefined;
  }
  if (r.state === "attempting" || r.state === "uncertain") {
    return r.receivedMessagesDigest !== undefined && r.reservedMicrousd > 0 &&
      r.chargedMicrousd === 0 && r.attemptedAt !== undefined &&
      r.attemptedAt >= r.issuedAt && r.attemptedAt < r.expiresAt &&
      r.completedAt === undefined;
  }
  return r.receivedMessagesDigest !== undefined && r.reservedMicrousd === r.chargedMicrousd &&
    r.attemptedAt !== undefined && r.attemptedAt >= r.issuedAt && r.attemptedAt < r.expiresAt &&
    r.completedAt !== undefined && r.completedAt >= r.attemptedAt;
}

class DurableJournal {
  private tail: Promise<void> = Promise.resolve();
  constructor(
    private readonly config: ValidConfig,
    private readonly onAccess?: () => void,
    private readonly testAclInspector?: (target: string) => void,
  ) {}

  private async assertPrivatePath(): Promise<void> {
    const parsed = parsePath(this.config.journalRoot);
    const pieces = this.config.journalRoot.slice(parsed.root.length).split(sep).filter(Boolean);
    let ancestor = parsed.root;
    for (const piece of [undefined, ...pieces]) {
      if (piece !== undefined) ancestor = join(ancestor, piece);
      const ancestorInfo = await lstat(ancestor).catch(() => fail("unsafe_journal_root", 500));
      const currentUid = typeof process.getuid === "function" ? process.getuid() : ancestorInfo.uid;
      const ownerAllowed = ancestorInfo.uid === 0 || ancestorInfo.uid === currentUid;
      const writable = (ancestorInfo.mode & 0o022) !== 0;
      const safeStickyRoot = ancestorInfo.uid === 0 && (ancestorInfo.mode & 0o1000) !== 0;
      const canonical = await realpath(ancestor).catch(() => fail("unsafe_journal_root", 500));
      if (!ancestorInfo.isDirectory() || ancestorInfo.isSymbolicLink() || canonical !== ancestor ||
        !ownerAllowed || (writable && !safeStickyRoot)) {
        fail("unsafe_journal_ancestor", 500);
      }
      assertPrivateAcl(ancestor, this.testAclInspector);
    }
    const root = await realpath(this.config.journalRoot).catch(() => fail("unsafe_journal_root", 500));
    if (root !== this.config.journalRoot || relative(root, this.config.journalPath).startsWith("..")) fail("unsafe_journal_root", 500);
    const info = await lstat(root).catch(() => fail("unsafe_journal_root", 500));
    const uid = typeof process.getuid === "function" ? process.getuid() : info.uid;
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0) {
      fail("unsafe_journal_root", 500);
    }
  }

  private async load(): Promise<Journal> {
    this.onAccess?.();
    await this.assertPrivatePath();
    let stat;
    try { stat = await lstat(this.config.journalPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, records: [] };
      throw error;
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o077) !== 0 || stat.size > MAX_JOURNAL_BYTES) {
      fail("unsafe_journal_file", 500);
    }
    assertPrivateAcl(this.config.journalPath, this.testAclInspector);
    const raw = await readFile(this.config.journalPath, "utf8");
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return fail("corrupt_journal", 500); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("corrupt_journal", 500);
    const journal = parsed as Journal;
    if (!exactKeys(parsed as Record<string, unknown>, ["records", "version"]) || journal.version !== 1 || !Array.isArray(journal.records) || journal.records.length > MAX_RECORDS || !journal.records.every(validRecord)) {
      fail("corrupt_journal", 500);
    }
    if (new Set(journal.records.map((record) => record.leaseModel)).size !== journal.records.length ||
      new Set(journal.records.map((record) => record.sessionId)).size !== journal.records.length) {
      fail("corrupt_journal", 500);
    }
    return journal;
  }

  private async save(journal: Journal): Promise<void> {
    const name = `.hermes-bridge-${Buffer.from(randomBytes(12)).toString("hex")}.tmp`;
    const temporary = join(this.config.journalRoot, name);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${stableJson(journal)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      await chmod(temporary, 0o600);
      await rename(temporary, this.config.journalPath);
      const directory = await open(this.config.journalRoot, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async mutate<T>(operation: (journal: Journal) => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const previous = this.tail;
    this.tail = previous.then(() => current);
    await previous;
    try {
      const journal = await this.load();
      const result = await operation(journal);
      await this.save(journal);
      return result;
    } finally { release(); }
  }

  async read<T>(operation: (journal: Journal) => T): Promise<T> {
    await this.tail;
    return operation(await this.load());
  }
}

function prune(journal: Journal, now: number): void {
  for (const record of journal.records) {
    if (record.state === "armed" && record.expiresAt <= now) record.state = "expired";
  }
  // Records are deliberately not pruned automatically: they are the bounded
  // uniqueness and spend tombstones. At MAX_RECORDS the bridge fails closed
  // until an operator performs a separately reviewed journal rotation.
}

async function boundedResponse(response: Response, maximum: number): Promise<unknown> {
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    await response.body?.cancel().catch(() => undefined);
    fail("invalid_upstream_content_type", 502);
  }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    await response.body?.cancel().catch(() => undefined);
    fail("response_too_large", 502);
  }
  const reader = response.body?.getReader();
  if (!reader) fail("invalid_upstream_response", 502);
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximum) { await reader.cancel().catch(() => undefined); fail("response_too_large", 502); }
    chunks.push(next.value);
  }
  try { return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8")); }
  catch { return fail("invalid_upstream_response", 502); }
}

function parseCompletion(value: unknown, inputCap: number, outputCap: number) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_upstream_response", 502);
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.choices) || body.choices.length !== 1) fail("invalid_upstream_response", 502);
  const choice = body.choices[0] as Record<string, unknown>;
  const message = choice?.message as Record<string, unknown>;
  const usage = body.usage as Record<string, unknown>;
  if (!choice || typeof choice !== "object" || choice.finish_reason !== "stop" ||
    !message || message.role !== "assistant" || typeof message.content !== "string" ||
    message.content.length < 1 || message.content.length > 32_000 ||
    Object.hasOwn(message, "tool_calls") || Object.hasOwn(message, "function_call") ||
    !usage || !integer(usage.prompt_tokens, 0, inputCap) || !integer(usage.completion_tokens, 0, outputCap) ||
    !integer(usage.total_tokens, 0, inputCap + outputCap) || usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens) {
    fail("invalid_upstream_response", 502);
  }
  return {
    message: { role: "assistant", content: message.content },
    usage: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens },
  };
}

function linkSignals(requestSignal: AbortSignal, timeoutMs: number): { signal: AbortSignal; close(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort(requestSignal.reason);
  if (requestSignal.aborted) abort(); else requestSignal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("bridge_timeout")), timeoutMs);
  return {
    signal: controller.signal,
    close() { clearTimeout(timer); requestSignal.removeEventListener("abort", abort); },
  };
}

export async function createHermesBridgeService(
  input: HermesBridgeConfig,
  dependencies: Dependencies = {},
): Promise<HermesBridgeService> {
  if (dependencies.macAclInspectorForTest && process.env.NODE_ENV !== "test") {
    fail("test_acl_inspector_not_allowed", 500);
  }
  const config = validateConfig(input);
  const journal = new DurableJournal(
    config,
    dependencies.onJournalAccess,
    dependencies.macAclInspectorForTest,
  );
  const now = dependencies.now ?? Date.now;
  const random = dependencies.random ?? randomBytes;
  const requestFetch = dependencies.fetch ?? globalThis.fetch;
  const contract = Object.freeze({
    profile: config.profile,
    provider: config.provider,
    model: config.model,
    profileInvariantsDigest: config.profileInvariantsDigest,
    bridgeConfigDigest: config.bridgeConfigDigest,
  });

  let ready = false;
  let activation: Promise<void> | undefined;
  const service: HermesBridgeService = Object.freeze({
    contract,
    async handleControl(request, caller) {
      if (!ready) fail("bridge_not_ready", 503);
      loopback(caller);
      constantBearer(request.headers.get("authorization"), config.controlBearer);
      const requestUrl = new URL(request.url);
      if (request.method === "GET" && requestUrl.pathname === "/v1/status") {
        exactEndpoint(request, config.controlOrigin, "/v1/status", "GET");
        const payload: HermesBridgeReadiness = Object.freeze({
          status: "ready",
          singleProcessPortOwnershipRequired: true,
          ...contract,
        });
        return Response.json({ ...payload, attestation: sign(config.controlResponseKey, payload) }, {
          headers: { "cache-control": "no-store", "content-type": "application/json" },
        });
      }
      exactEndpoint(request, config.controlOrigin, "/v1/leases", "POST");
      const parsed = parseLeaseRequest((await boundedJson(request, CONTROL_BODY_LIMIT)).value);
      if (parsed.profile !== config.profile || parsed.provider !== config.provider || parsed.model !== config.model) {
        fail("lease_configuration_mismatch", 403);
      }
      const timestamp = now();
      if (!integer(timestamp, 0, Number.MAX_SAFE_INTEGER)) fail("invalid_clock", 500);
      const ttlMs = parsed.ttlMs ?? 30_000;
      if (timestamp > Number.MAX_SAFE_INTEGER - ttlMs) fail("invalid_clock", 500);
      const record = await journal.mutate((state) => {
        prune(state, timestamp);
        if (state.records.length >= MAX_RECORDS) fail("journal_capacity_reached", 503);
        if (state.records.some((candidate) => candidate.sessionId === parsed.sessionId)) {
          fail("session_reuse_not_allowed", 409);
        }
        let leaseModel: string;
        do { leaseModel = `pilot-hermes-lease-${Buffer.from(random(32)).toString("base64url")}`; }
        while (state.records.some((candidate) => candidate.leaseModel === leaseModel));
        const created: LeaseRecord = {
          leaseModel, scopeDigest: parsed.scopeDigest, userContentDigest: parsed.userContentDigest,
          messageDigest: parsed.messageDigest,
          sessionId: parsed.sessionId,
          profile: parsed.profile, provider: parsed.provider, model: parsed.model,
          bridgeConfigDigest: config.bridgeConfigDigest,
          profileInvariantsDigest: config.profileInvariantsDigest,
          issuedAt: timestamp, expiresAt: timestamp + ttlMs, state: "armed",
          reservedMicrousd: 0, chargedMicrousd: 0,
        };
        state.records.push(created);
        return created;
      });
      const payload = signedPayload(record, config);
      return Response.json({ ...payload, attestation: sign(config.controlResponseKey, payload) }, {
        headers: { "cache-control": "no-store", "content-type": "application/json" },
      });
    },

    async handleIngress(request, caller) {
      if (!ready) fail("bridge_not_ready", 503);
      loopback(caller);
      exactEndpoint(request, config.ingressOrigin, "/v1/chat/completions", "POST");
      constantBearer(request.headers.get("authorization"), config.ingressBearer);
      const bounded = await boundedJson(request, config.maxInputBytes);
      const parsed = parseIngress(bounded.value, config.maxMessages);
      const timestamp = now();
      if (!integer(timestamp, 0, Number.MAX_SAFE_INTEGER)) fail("invalid_clock", 500);
      const receivedMessagesDigest = digestHermesBridgeMessages(parsed.messages);
      const userMessages = parsed.messages.filter((message) => message.role === "user");
      if (userMessages.length !== 1) fail("user_content_binding_mismatch", 403);
      const providerMessages = normalizedProviderMessages(userMessages[0]!.content);
      const providerMessageDigest = digestHermesBridgeMessages(providerMessages);
      const providerBody = JSON.stringify({
        model: config.model,
        messages: providerMessages,
        stream: false,
        [config.tokenParameter]: config.outputTokens,
      });
      const ceiling = costCeiling(config, Buffer.byteLength(providerBody, "utf8"));
      const decision = await journal.mutate((state):
        { ok: true; lease: LeaseRecord } |
        { ok: false; code: "expired_lease" | "lease_configuration_changed" } => {
        prune(state, timestamp);
        const record = state.records.find((candidate) => candidate.leaseModel === parsed.leaseModel);
        if (record?.state === "expired") return { ok: false, code: "expired_lease" };
        if (!record || record.state !== "armed") fail("invalid_or_spent_lease", 409);
        if (record.bridgeConfigDigest !== config.bridgeConfigDigest || record.profileInvariantsDigest !== config.profileInvariantsDigest) {
          record.state = "expired";
          return { ok: false, code: "lease_configuration_changed" };
        }
        if (
          digest(userMessages[0]!.content) !== record.userContentDigest ||
          providerMessageDigest !== record.messageDigest
        ) fail("message_binding_mismatch", 403);
        const attemptDay = dayStart(timestamp);
        const reservedToday = state.records
          .filter((candidate) => candidate.scopeDigest === record.scopeDigest &&
            candidate.attemptedAt !== undefined && dayStart(candidate.attemptedAt) === attemptDay)
          .reduce((sum, candidate) => sum + candidate.reservedMicrousd, 0);
        if (reservedToday + ceiling.microusd > config.maxDailyMicrousd) fail("daily_cost_cap_exceeded", 402);
        // Persist exact received-body binding and reservation before any provider call.
        record.receivedMessagesDigest = receivedMessagesDigest;
        record.attemptedAt = timestamp;
        record.reservedMicrousd = ceiling.microusd;
        record.state = "attempting";
        return { ok: true, lease: { ...record } };
      });
      if (!decision.ok) fail(decision.code, 409);
      const lease = decision.lease;

      const linked = linkSignals(request.signal, config.timeoutMs);
      let upstream: Response;
      try {
        upstream = await requestFetch(config.upstreamUrl, {
          method: "POST", redirect: "error", signal: linked.signal,
          headers: { accept: "application/json", authorization: `Bearer ${config.upstreamCredential}`, "content-type": "application/json" },
          body: providerBody,
        });
      } catch {
        await journal.mutate((state) => {
          const current = state.records.find((record) => record.leaseModel === lease.leaseModel);
          if (current?.state === "attempting") current.state = "uncertain";
        });
        return fail("upstream_outcome_uncertain", 502);
      } finally { linked.close(); }
      if (!upstream.ok || upstream.redirected) {
        await upstream.body?.cancel().catch(() => undefined);
        await journal.mutate((state) => {
          const current = state.records.find((record) => record.leaseModel === lease.leaseModel);
          if (current?.state === "attempting") current.state = "uncertain";
        });
        fail("upstream_outcome_uncertain", 502);
      }
      let completion: ReturnType<typeof parseCompletion>;
      try { completion = parseCompletion(await boundedResponse(upstream, config.maxResponseBytes), ceiling.inputTokens, config.outputTokens); }
      catch (error) {
        await journal.mutate((state) => {
          const current = state.records.find((record) => record.leaseModel === lease.leaseModel);
          if (current?.state === "attempting") current.state = "uncertain";
        });
        throw error;
      }
      const chargedMicrousd = Math.ceil((completion.usage.promptTokens * config.inputMicrousdPerMillionTokens) / 1_000_000) +
        Math.ceil((completion.usage.completionTokens * config.outputMicrousdPerMillionTokens) / 1_000_000);
      if (chargedMicrousd > ceiling.microusd || chargedMicrousd > config.maxCallMicrousd) {
        await journal.mutate((state) => {
          const current = state.records.find((record) => record.leaseModel === lease.leaseModel);
          if (current?.state === "attempting") current.state = "uncertain";
        });
        fail("upstream_cost_violation", 502);
      }
      await journal.mutate((state) => {
        const current = state.records.find((record) => record.leaseModel === lease.leaseModel);
        if (!current || current.state !== "attempting" || current.receivedMessagesDigest !== receivedMessagesDigest) {
          fail("journal_state_conflict", 500);
        }
        const completedAt = now();
        if (!integer(completedAt, 0, Number.MAX_SAFE_INTEGER)) fail("invalid_clock", 500);
        current.state = "completed";
        current.completedAt = completedAt;
        current.chargedMicrousd = chargedMicrousd;
        current.reservedMicrousd = chargedMicrousd;
      });
      return Response.json({
        object: "chat.completion", model: config.model,
        choices: [{ index: 0, message: completion.message, finish_reason: "stop" }],
        usage: {
          prompt_tokens: completion.usage.promptTokens,
          completion_tokens: completion.usage.completionTokens,
          total_tokens: completion.usage.totalTokens,
        },
      }, { headers: { "cache-control": "no-store", "content-type": "application/json" } });
    },

    async usage(scopeDigest) {
      if (!ready) fail("bridge_not_ready", 503);
      if (!SHA256.test(scopeDigest)) fail("invalid_scope");
      return journal.read((state) => {
        const relevant = state.records.filter((record) => record.scopeDigest === scopeDigest);
        return Object.freeze({
          attempts: relevant.filter((record) => record.state !== "armed" && record.state !== "expired").length,
          completed: relevant.filter((record) => record.state === "completed").length,
          uncertain: relevant.filter((record) => record.state === "uncertain" || record.state === "attempting").length,
          reservedMicrousd: relevant.reduce((sum, record) => sum + record.reservedMicrousd, 0),
          chargedMicrousd: relevant.reduce((sum, record) => sum + record.chargedMicrousd, 0),
        });
      });
    },
  });
  pendingActivations.set(service, {
    controlOrigin: config.controlOrigin,
    ingressOrigin: config.ingressOrigin,
    async activate() {
      if (ready) return;
      if (!activation) {
        activation = journal.mutate((state) => {
          for (const record of state.records) {
            if (record.state === "attempting") record.state = "uncertain";
          }
        }).then(() => { ready = true; });
      }
      await activation;
    },
    deactivate() { ready = false; },
  });
  return service;
}

function serverOwnsOrigin(server: Server, expectedOrigin: string): boolean {
  const address = server.address() as AddressInfo | null;
  const expected = new URL(expectedOrigin);
  return server.listening && address !== null && typeof address !== "string" &&
    address.address === "127.0.0.1" && address.port === Number(expected.port);
}

/** @internal Called only after the listener has exclusively claimed both ports. */
export async function activateHermesBridgeServiceAfterPortClaim(
  service: HermesBridgeService,
  controlServer: Server,
  ingressServer: Server,
): Promise<void> {
  const pending = pendingActivations.get(service);
  if (!pending) fail("invalid_bridge_service", 500);
  if (!serverOwnsOrigin(controlServer, pending.controlOrigin) || !serverOwnsOrigin(ingressServer, pending.ingressOrigin)) {
    fail("bridge_ports_not_owned", 500);
  }
  await pending.activate();
}

/** @internal Deactivates journal access while both exclusively owned ports remain bound. */
export function deactivateHermesBridgeServiceBeforePortRelease(
  service: HermesBridgeService,
  controlServer: Server,
  ingressServer: Server,
): void {
  const pending = pendingActivations.get(service);
  if (!pending) fail("invalid_bridge_service", 500);
  if (!serverOwnsOrigin(controlServer, pending.controlOrigin) || !serverOwnsOrigin(ingressServer, pending.ingressOrigin)) {
    fail("bridge_ports_not_owned", 500);
  }
  pending.deactivate();
}

/** Explicit unit-test hook. Production composition must deactivate through the listener. */
export function deactivateHermesBridgeServiceForTest(service: HermesBridgeService): void {
  if (process.env.NODE_ENV !== "test") fail("test_activation_not_allowed", 500);
  const pending = pendingActivations.get(service);
  if (!pending) fail("invalid_bridge_service", 500);
  pending.deactivate();
}

/** Explicit unit-test hook. Production composition must activate through the listener. */
export async function activateHermesBridgeServiceForTest(
  service: HermesBridgeService,
): Promise<void> {
  if (process.env.NODE_ENV !== "test") fail("test_activation_not_allowed", 500);
  const pending = pendingActivations.get(service);
  if (!pending) fail("invalid_bridge_service", 500);
  await pending.activate();
}

export function createHermesBridgeClient(
  config: HermesBridgeClientConfig,
  requestFetch: typeof fetch = globalThis.fetch,
  dependencies: HermesBridgeClientDependencies = {},
): HermesBridgeClient {
  const controlOrigin = fixedOrigin(config.controlOrigin);
  const now = dependencies.now ?? Date.now;
  const controlTimeoutMs = dependencies.controlTimeoutMs ?? 5_000;
  if (!integer(controlTimeoutMs, 100, 10_000)) fail("invalid_client_configuration", 500);
  const boundedSignal = (caller?: AbortSignal): AbortSignal => {
    const timeout = AbortSignal.timeout(controlTimeoutMs);
    return caller ? AbortSignal.any([caller, timeout]) : timeout;
  };
  return Object.freeze({
    async attestReady(signal) {
      const response = await requestFetch(`${controlOrigin}/v1/status`, {
        method: "GET", redirect: "error", signal: boundedSignal(signal),
        headers: { accept: "application/json", authorization: `Bearer ${config.controlBearer}`, host: new URL(controlOrigin).host },
      });
      if (!response.ok || response.redirected) { await response.body?.cancel().catch(() => undefined); fail("control_rejected", 502); }
      const value = await boundedResponse(response, CONTROL_BODY_LIMIT);
      if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_control_response", 502);
      const body = value as Record<string, unknown>;
      const keys = ["attestation", "bridgeConfigDigest", "model", "profile", "profileInvariantsDigest", "provider", "singleProcessPortOwnershipRequired", "status"];
      if (!exactKeys(body, keys)) fail("invalid_control_response", 502);
      const { attestation, ...payload } = body;
      const expected = sign(config.controlResponseKey, payload);
      const a = Buffer.from(typeof attestation === "string" ? attestation : "");
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b) || payload.status !== "ready" ||
        payload.singleProcessPortOwnershipRequired !== true || payload.profile !== config.profile ||
        payload.provider !== config.provider || payload.model !== config.model ||
        payload.profileInvariantsDigest !== config.profileInvariantsDigest || payload.bridgeConfigDigest !== config.bridgeConfigDigest) {
        fail("invalid_control_attestation", 502);
      }
      return Object.freeze(payload) as HermesBridgeReadiness;
    },
    async authorize(input, signal) {
      if (input.profile !== config.profile || input.provider !== config.provider || input.model !== config.model ||
        !SHA256.test(input.scopeDigest) || !SHA256.test(input.messageDigest)) {
        fail("authorization_binding_mismatch");
      }
      const userContentDigest = digestHermesBridgeUserContent(input.userContent);
      if (digestHermesBridgeMessages(normalizedProviderMessages(input.userContent)) !== input.messageDigest) {
        fail("authorization_binding_mismatch");
      }
      const response = await requestFetch(`${controlOrigin}/v1/leases`, {
        method: "POST", redirect: "error", signal: boundedSignal(signal),
        headers: { accept: "application/json", authorization: `Bearer ${config.controlBearer}`, "content-type": "application/json", host: new URL(controlOrigin).host },
        body: JSON.stringify({
          scopeDigest: input.scopeDigest, userContentDigest, messageDigest: input.messageDigest,
          sessionId: input.sessionId,
          profile: input.profile, provider: input.provider, model: input.model,
          ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
        }),
      });
      if (!response.ok || response.redirected) { await response.body?.cancel().catch(() => undefined); fail("control_rejected", 502); }
      const body = parseAuthorizationResponse(await boundedResponse(response, CONTROL_BODY_LIMIT));
      const { attestation, ...payload } = body;
      const expected = sign(config.controlResponseKey, payload);
      const a = Buffer.from(typeof attestation === "string" ? attestation : "");
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b) ||
        payload.scopeDigest !== input.scopeDigest || payload.userContentDigest !== userContentDigest ||
        payload.messageDigest !== input.messageDigest ||
        payload.sessionId !== input.sessionId ||
        payload.profile !== input.profile || payload.provider !== input.provider || payload.model !== input.model ||
        payload.profileInvariantsDigest !== config.profileInvariantsDigest || payload.bridgeConfigDigest !== config.bridgeConfigDigest ||
        typeof payload.leaseModel !== "string" || !LEASE_MODEL.test(payload.leaseModel) ||
        !integer(payload.expiresAt, 0, Number.MAX_SAFE_INTEGER)) fail("invalid_control_attestation", 502);
      const receivedAt = now();
      if (!integer(receivedAt, 0, Number.MAX_SAFE_INTEGER) ||
        (payload.expiresAt as number) <= receivedAt ||
        (payload.expiresAt as number) > receivedAt + MAX_TTL_MS) {
        fail("invalid_control_expiry", 502);
      }
      const authorization = Object.freeze(payload) as HermesBridgeAuthorization;
      brandedAuthorizations.add(authorization);
      return authorization;
    },
  });
}
