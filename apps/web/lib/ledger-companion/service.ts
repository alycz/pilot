import { randomBytes, timingSafeEqual } from "node:crypto";

import {
  ledgerRuntimeProvenance,
  verifyExactLedgerSignedBlob,
  type ExactLedgerActionExpectation,
  type PilotWallet,
} from "@pilot/wallet";

import {
  LedgerCompanionPairingRegistry,
  LedgerCompanionProtocolError,
  type CompanionPairing,
  type LocalPairingReview,
} from "./protocol";

export const LEDGER_COMPANION_HOST = "127.0.0.1";
export const LEDGER_COMPANION_PORT = 43659;
export const LEDGER_COMPANION_ORIGIN =
  `http://${LEDGER_COMPANION_HOST}:${LEDGER_COMPANION_PORT}`;
export const LEDGER_COMPANION_SPECULOS_ORIGIN = "http://127.0.0.1:5000";
export const LEDGER_COMPANION_PUBLIC_ACCOUNT = "ra7Zr8ddy9tB88RaXL8B87YkqhEJG2vkAJ";
export const LEDGER_COMPANION_XRP_APP_VERSION = "2.8.2";

const MAX_BODY_BYTES = 32 * 1024;
const MAX_PAIRING_TTL_MS = 5 * 60_000;
const TOKEN_BYTES = 32;
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;

type Caller = Readonly<{ remoteAddress: string }>;

export type CompanionSignerIdentity = Readonly<{
  account: string;
  generation: number;
  appVersion: string;
}>;

export interface LedgerCompanionSigner {
  identity(): Promise<CompanionSignerIdentity>;
  sign(transaction: Readonly<Record<string, unknown>>): Promise<string>;
  disconnect(): Promise<void>;
}

export interface LedgerCompanionEmulatorControls {
  screen(): Promise<Uint8Array>;
  press(button: "left" | "right" | "both"): Promise<void>;
}

export type LedgerCompanionService = Readonly<{
  handle(request: Request, caller: Caller): Promise<Response>;
}>;

type PendingApproval = {
  challenge: string;
  review: LocalPairingReview;
  settle: (approved: boolean) => void;
};

type PairingBinding = Readonly<{
  expectation: ExactLedgerActionExpectation;
  generation: number;
  expiresAtMs: number;
}>;

type SignedResult = Readonly<{
  requestId: string;
  signedBlob: string;
  hash: string;
}>;

export class LedgerCompanionServiceError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = "LedgerCompanionServiceError";
  }
}

function fail(code: string, status = 400): never {
  throw new LedgerCompanionServiceError(code, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function exactHostedOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("invalid_configuration", 500);
  }
  if (url.protocol !== "https:" || value !== url.origin || value.includes("*")) {
    fail("invalid_configuration", 500);
  }
  return url.origin;
}

function isLoopbackPeer(value: string): boolean {
  return value === "127.0.0.1" || value === "::ffff:127.0.0.1";
}

function containsForwardedHeaders(headers: Headers): boolean {
  return ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"]
    .some((name) => headers.has(name));
}

function constantBearer(header: string | null, expected: string): void {
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const left = Buffer.from(supplied, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length || !timingSafeEqual(left, right)) fail("unauthorized", 401);
}

async function boundedJson(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    fail("request_too_large", 413);
  }
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    fail("invalid_content_type", 415);
  }
  const reader = request.body?.getReader();
  if (reader === undefined) fail("missing_body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      fail("request_too_large", 413);
    }
    chunks.push(next.value);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length)));
  } catch {
    return fail("invalid_json");
  }
}

function json(status: number, value: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json", ...headers },
  });
}

function hostedCors(origin: string): HeadersInit {
  return { "access-control-allow-origin": origin, "vary": "Origin" };
}

function safeError(error: unknown): LedgerCompanionServiceError {
  if (error instanceof LedgerCompanionServiceError) return error;
  if (error instanceof LedgerCompanionProtocolError) {
    const status = error.code === "ORIGIN_DENIED" || error.code === "CAPABILITY_DENIED"
      ? 403
      : error.code === "PAIRING_REPLAY" || error.code === "REQUEST_NOT_RESERVED"
      ? 409
      : 400;
    return new LedgerCompanionServiceError(error.code.toLowerCase(), status);
  }
  return new LedgerCompanionServiceError("companion_unavailable", 503);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

function localPage(input: Readonly<{
  adminToken: string;
  pending?: PendingApproval;
  hasBinding: boolean;
  nonce: string;
}>): string {
  const review = input.pending?.review;
  const details = review === undefined
    ? `<p id="status" role="status">${input.hasBinding
      ? "A paired or recovery-held action remains. Revoke it before starting another."
      : "No hosted signing request is waiting for local review."}</p>
      ${input.hasBinding
        ? `<div class="actions"><button id="reset" class="secondary" type="button">Revoke held pairing</button></div>`
        : ""}`
    : `<div id="status" role="status">Review this exact software-emulator request.</div>
      <dl><dt>Hosted origin</dt><dd>${escapeHtml(review.approvedOrigin)}</dd>
      <dt>Network</dt><dd>${escapeHtml(review.expectation.network)}</dd>
      <dt>Account</dt><dd><code>${escapeHtml(review.expectation.account)}</code></dd>
      <dt>Action</dt><dd>${escapeHtml(review.review.action)}</dd>
      <dt>Review digest</dt><dd><code>${escapeHtml(review.review.digest)}</code></dd>
      <dt>Expires</dt><dd>${escapeHtml(review.pairingExpiresAt)}</dd></dl>
      <h2>Prepared transaction</h2><pre>${escapeHtml(JSON.stringify(review.transaction, null, 2))}</pre>
      <div class="actions"><button id="approve" type="button">Approve pairing</button>
      <button id="reject" class="secondary" type="button">Reject</button></div>
      <h2>Software emulator controls</h2><img id="device-screen" alt="Current Speculos screen" hidden>
      <div class="actions"><button class="secondary device" data-button="left" type="button">Left</button>
      <button class="secondary device" data-button="both" type="button">Both</button>
      <button class="secondary device" data-button="right" type="button">Right</button></div>`;
  const challenge = input.pending?.challenge ?? "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pilot local Ledger companion</title>
<style nonce="${input.nonce}">:root{color-scheme:light}body{margin:0;background:#f3f1eb;color:#17191f;font:15px Inter,system-ui,sans-serif}.shell{max-width:760px;margin:40px auto;padding:24px}.card{background:#fcfbf8;border:1px solid #e4e1da;border-radius:16px;padding:24px}h1{font-size:24px}h2{font-size:16px;margin-top:24px}p,dd{line-height:1.55}dl{display:grid;grid-template-columns:150px 1fr;gap:8px 16px}dt{color:#5d6470}dd{margin:0;overflow-wrap:anywhere}pre{overflow:auto;border:1px solid #e4e1da;border-radius:12px;background:#f5f3ee;padding:16px;font:12px Fragment Mono,monospace}.actions{display:flex;gap:12px;margin-top:24px}button{min-height:44px;border:0;border-radius:8px;background:#1f56c7;color:white;padding:0 18px;font-weight:600}button.secondary{background:#fff;color:#b42318;border:1px solid #d3cfc5}button:focus-visible{outline:3px solid #5a4fcf;outline-offset:2px}.notice{border-left:3px solid #3f5f8f;padding-left:12px;color:#475061}@media(max-width:600px){.shell{margin:0;padding:16px}.card{padding:18px}dl{grid-template-columns:1fr}}</style></head>
<body><main class="shell"><section class="card" aria-labelledby="title"><h1 id="title">Local Ledger companion</h1><p class="notice">Software emulator · public default test seed · Testnet only · signing only. A valid signature does not prove a physical Ledger or settlement.</p>${details}</section></main>
<script nonce="${input.nonce}">const token=${JSON.stringify(input.adminToken)};const challenge=${JSON.stringify(challenge)};const post=(path,value)=>fetch(path,{method:"POST",headers:{"authorization":"Bearer "+token,"content-type":"application/json"},body:JSON.stringify(value)});if(!challenge&&!${JSON.stringify(input.hasBinding)})setTimeout(()=>location.reload(),1000);for(const id of ["approve","reject"]){const button=document.getElementById(id);if(button)button.addEventListener("click",async()=>{button.disabled=true;const response=await post("/v1/local/review",{challenge,decision:id==="approve"?"approve":"reject"});document.getElementById("status").textContent=response.ok?(id==="approve"?"Pairing approved. Return to Pilot to continue.":"Pairing rejected."):"The local review could not be completed.";});}const reset=document.getElementById("reset");if(reset)reset.addEventListener("click",async()=>{reset.disabled=true;const response=await post("/v1/local/reset",{});document.getElementById("status").textContent=response.ok?"The held pairing was revoked.":"The held pairing could not be revoked.";});const image=document.getElementById("device-screen");async function screen(){if(!image)return;const response=await post("/v1/local/screen",{});if(response.ok){image.src=URL.createObjectURL(await response.blob());image.hidden=false;}}for(const button of document.querySelectorAll(".device")){button.addEventListener("click",async()=>{await post("/v1/local/button",{button:button.dataset.button});await screen();});}if(challenge)void screen();</script></body></html>`;
}

function parsePairRequest(value: unknown, sessionHeader: string | null): Readonly<{
  sessionId: string;
  network: "testnet";
  account: string;
  unsignedTxBlob: string;
  expectation: ExactLedgerActionExpectation;
  ttlMs: number;
}> {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "session_id", "network", "account", "unsigned_tx_blob", "expectation", "ttl_ms",
  ]) || value.version !== 1 || value.network !== "testnet" ||
    typeof value.session_id !== "string" || !SAFE_SESSION.test(value.session_id) ||
    value.session_id !== sessionHeader || typeof value.account !== "string" ||
    typeof value.unsigned_tx_blob !== "string" ||
    !/^(?:[A-Fa-f0-9]{2})+$/.test(value.unsigned_tx_blob) || value.unsigned_tx_blob.length > 20_000 ||
    !isRecord(value.expectation) || !Number.isSafeInteger(value.ttl_ms) ||
    Number(value.ttl_ms) < 1_000 || Number(value.ttl_ms) > MAX_PAIRING_TTL_MS) {
    fail("invalid_pairing_request");
  }
  const expectation = structuredClone(value.expectation) as Record<string, unknown>;
  const common = ["kind", "network", "account", "sequence", "validatedLedgerIndex", "maxLedgerWindow",
    "maxFeeDrops", "approvalExpiresAtMs", "quoteExpiresAtMs", "sourceTag", "memos"];
  const actionFields: Record<string, readonly string[]> = {
    payment: ["destination", "amountDrops", "destinationTag", "invoiceId"],
    "delegate-grant": ["delegate", "permissions", "blindSigning"],
    "delegate-revoke": ["delegate", "blindSigning"],
    "escrow-create": ["destination", "amountDrops", "finishAfter", "cancelAfter", "condition", "destinationTag"],
    "escrow-finish": ["escrowId", "condition", "fulfillment"],
    "escrow-cancel": ["escrowId"],
  };
  const action = typeof expectation.kind === "string" ? expectation.kind : "";
  if (actionFields[action] === undefined ||
    Object.keys(expectation).some((key) =>
      !common.includes(key) && !actionFields[action]!.includes(key))) {
    fail("invalid_pairing_expectation");
  }
  return Object.freeze({
    sessionId: value.session_id, network: "testnet", account: value.account,
    unsignedTxBlob: value.unsigned_tx_blob.toUpperCase(),
    expectation: expectation as ExactLedgerActionExpectation,
    ttlMs: Number(value.ttl_ms),
  });
}

function pairingResponse(pairing: CompanionPairing): unknown {
  return { capability: pairing.capability, scope: pairing.scope, provenance: ledgerRuntimeProvenance("speculos") };
}

/** Semantic signing service. No APDU, RPC, URL/header forwarding, screenshot, or button route exists. */
export function createLedgerCompanionService(input: Readonly<{
  approvedOrigin: string;
  signer: LedgerCompanionSigner;
  controls?: LedgerCompanionEmulatorControls;
  expectedAccount?: string;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
}>): LedgerCompanionService {
  const approvedOrigin = exactHostedOrigin(input.approvedOrigin);
  const expectedAccount = input.expectedAccount ?? LEDGER_COMPANION_PUBLIC_ACCOUNT;
  const now = input.now ?? Date.now;
  const entropy = input.randomBytes ?? ((size: number) => randomBytes(size));
  let adminToken = "";
  let adminTokenExpiresAt = 0;

  let pendingApproval: PendingApproval | undefined;
  let pairing = false;
  let signing = false;
  const bindings = new Map<string, PairingBinding>();
  const results = new Map<string, SignedResult>();
  const registry = new LedgerCompanionPairingRegistry({
    approvedOrigin, now, randomBytes: entropy,
    approveLocalPairing: (review) => {
      if (pendingApproval !== undefined) fail("review_in_progress", 409);
      const challenge = Buffer.from(entropy(TOKEN_BYTES)).toString("base64url");
      let timeout: ReturnType<typeof setTimeout> | undefined;
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const settle = (approved: boolean) => {
          if (settled) return;
          settled = true;
          if (timeout !== undefined) clearTimeout(timeout);
          resolve(approved);
        };
        pendingApproval = { challenge, review, settle };
        timeout = setTimeout(
          () => settle(false),
          Math.max(0, Date.parse(review.pairingExpiresAt) - now()),
        );
        timeout.unref?.();
      }).finally(() => { pendingApproval = undefined; });
    },
  });

  async function hosted(request: Request, path: string): Promise<Response> {
    if (request.headers.get("origin") !== approvedOrigin) fail("origin_denied", 403);
    const cors = hostedCors(approvedOrigin);
    if (request.method === "OPTIONS") {
      const requestedHeaders = (request.headers.get("access-control-request-headers") ?? "")
        .split(",").map((header) => header.trim().toLowerCase()).filter(Boolean);
      const allowed = new Set(["authorization", "content-type", "x-pilot-session"]);
      if (request.headers.get("access-control-request-method") !== "POST" ||
        requestedHeaders.some((header) => !allowed.has(header))) fail("preflight_denied", 403);
      const headers: Record<string, string> = {
        ...cors as Record<string, string>,
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "authorization, content-type, x-pilot-session",
        "access-control-max-age": "0",
        "vary": "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
      };
      if (request.headers.get("access-control-request-private-network") === "true") {
        headers["access-control-allow-private-network"] = "true";
      }
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "POST") fail("method_not_allowed", 405);
    const body = await boundedJson(request);
    const sessionHeader = request.headers.get("x-pilot-session");

    if (path === "/v1/pair") {
      if (request.headers.has("authorization")) fail("unexpected_authorization", 400);
      const parsed = parsePairRequest(body, sessionHeader);
      if (parsed.expectation.kind !== "payment") fail("unsupported_companion_action", 400);
      if (pairing || bindings.size > 0) fail("pairing_already_exists", 409);
      pairing = true;
      try {
        const identity = await input.signer.identity();
        if (identity.account !== parsed.account || identity.account !== expectedAccount) fail("account_mismatch", 409);
        if (identity.appVersion !== LEDGER_COMPANION_XRP_APP_VERSION) fail("unsupported_xrp_app", 409);
        const issued = await registry.issueFromLocalControl(parsed);
        if (bindings.size > 0) {
          registry.revoke(issued.scope.pairingId);
          fail("pairing_already_exists", 409);
        }
        bindings.set(issued.scope.pairingId, Object.freeze({
          expectation: parsed.expectation,
          generation: identity.generation,
          expiresAtMs: Date.parse(issued.scope.expiresAt),
        }));
        return json(200, pairingResponse(issued), cors);
      } finally {
        pairing = false;
      }
    }

    if (!isRecord(body)) fail("invalid_request");
    const authorization = request.headers.get("authorization");
    const capability = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    if (path === "/v1/sign") {
      if (signing) fail("signing_in_progress", 409);
      signing = true;
      let pairingId: string | undefined;
      let requestId: string | undefined;
      try {
        const authorized = await registry.authorizeSign({
          origin: request.headers.get("origin"), capability, request: body,
        });
        pairingId = authorized.request.pairing_id;
        requestId = authorized.request.request_id;
        if (authorized.request.session_id !== sessionHeader) fail("session_mismatch", 403);
        const binding = bindings.get(pairingId);
        if (binding === undefined) fail("pairing_binding_missing", 409);
        const identity = await input.signer.identity();
        if (identity.account !== authorized.request.account || identity.generation !== binding.generation) {
          registry.resolve({ pairingId, requestId, outcome: "unknown" });
          fail("device_session_changed", 409);
        }
        const remainingMs = binding.expiresAtMs - now();
        if (remainingMs <= 0) fail("pairing_expired", 409);
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const signedBlob = await Promise.race([
          input.signer.sign(authorized.transaction),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new LedgerCompanionServiceError("sign_deadline_exceeded", 409)),
              remainingMs,
            );
            timeout.unref?.();
          }),
        ]).finally(() => {
          if (timeout !== undefined) clearTimeout(timeout);
        });
        const verified = verifyExactLedgerSignedBlob({ signedBlob, expectation: binding.expectation, now: now() });
        registry.resolve({ pairingId, requestId, outcome: "signed" });
        results.set(pairingId, Object.freeze({
          requestId, signedBlob, hash: verified.hash,
        }));
        return json(200, {
          request_id: requestId, signed_blob: signedBlob, transaction_hash: verified.hash,
          provenance: ledgerRuntimeProvenance("speculos"), submitted: false,
        }, cors);
      } catch (error) {
        if (pairingId !== undefined && requestId !== undefined) {
          try {
            registry.resolve({ pairingId, requestId, outcome: "unknown" });
          } catch { /* The original terminal transition remains authoritative. */ }
          if (error instanceof LedgerCompanionServiceError && error.code === "sign_deadline_exceeded") {
            await input.signer.disconnect().catch(() => undefined);
          }
          fail("sign_outcome_unknown", 409);
        }
        throw error;
      } finally {
        signing = false;
      }
    }

    if (path === "/v1/status" || path === "/v1/disconnect") {
      if (!exactKeys(body, ["pairing_id", "session_id", "network", "account"]) ||
        body.session_id !== sessionHeader || body.network !== "testnet" ||
        typeof body.pairing_id !== "string" || typeof body.session_id !== "string" ||
        typeof body.account !== "string") fail("invalid_status_request");
      const status = registry.status({
        origin: request.headers.get("origin"), capability, pairingId: body.pairing_id,
        sessionId: body.session_id, network: "testnet", account: body.account,
      });
      if (path === "/v1/disconnect") {
        if (signing) fail("signing_in_progress", 409);
        registry.revoke(body.pairing_id);
        bindings.delete(body.pairing_id);
        results.delete(body.pairing_id);
        await input.signer.disconnect();
        return json(200, { status: "revoked" }, cors);
      }
      const result = results.get(body.pairing_id);
      return json(200, {
        status: status.status,
        ...(status.requestId === undefined ? {} : { request_id: status.requestId }),
        ...(result === undefined
          ? {} : { signed_blob: result.signedBlob, transaction_hash: result.hash }),
      }, cors);
    }
    fail("not_found", 404);
  }

  async function local(request: Request, path: string): Promise<Response> {
    if (path === "/ui" && request.method === "GET") {
      const nonce = Buffer.from(entropy(18)).toString("base64url");
      adminToken = Buffer.from(entropy(TOKEN_BYTES)).toString("base64url");
      if (!/^[A-Za-z0-9_-]{43}$/.test(adminToken)) fail("randomness_unavailable", 500);
      adminTokenExpiresAt = now() + 5 * 60_000;
      return new Response(localPage({
        adminToken,
        pending: pendingApproval,
        hasBinding: bindings.size > 0,
        nonce,
      }), {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'`,
          "content-type": "text/html; charset=utf-8", "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff", "x-frame-options": "DENY",
        },
      });
    }
    if (!["/v1/local/review", "/v1/local/screen", "/v1/local/button", "/v1/local/reset"].includes(path)) {
      fail("not_found", 404);
    }
    if (request.method !== "POST" || request.headers.get("origin") !== LEDGER_COMPANION_ORIGIN ||
      request.headers.get("sec-fetch-site") !== "same-origin") fail("local_control_denied", 403);
    if (adminTokenExpiresAt <= now()) fail("local_control_expired", 401);
    constantBearer(request.headers.get("authorization"), adminToken);
    const body = await boundedJson(request);
    if (path === "/v1/local/reset") {
      if (!isRecord(body) || !exactKeys(body, [])) fail("invalid_local_reset");
      if (signing) fail("signing_in_progress", 409);
      for (const pairingId of bindings.keys()) registry.revoke(pairingId);
      bindings.clear();
      results.clear();
      await input.signer.disconnect();
      return json(200, { status: "revoked" });
    }
    if (path === "/v1/local/screen") {
      if (!isRecord(body) || !exactKeys(body, []) || input.controls === undefined) fail("controls_unavailable", 503);
      const image = await input.controls.screen();
      if (image.byteLength < 1 || image.byteLength > 1024 * 1024) fail("invalid_screen", 502);
      return new Response(Buffer.from(image), {
        status: 200,
        headers: { "cache-control": "no-store", "content-type": "image/png", "x-content-type-options": "nosniff" },
      });
    }
    if (path === "/v1/local/button") {
      if (!isRecord(body) || !exactKeys(body, ["button"]) ||
        !["left", "right", "both"].includes(String(body.button)) || input.controls === undefined) {
        fail("controls_unavailable", 503);
      }
      await input.controls.press(body.button as "left" | "right" | "both");
      return json(200, { status: "pressed" });
    }
    if (!isRecord(body) || !exactKeys(body, ["challenge", "decision"]) ||
      typeof body.challenge !== "string" || (body.decision !== "approve" && body.decision !== "reject")) {
      fail("invalid_local_review");
    }
    const pending = pendingApproval;
    if (pending === undefined || body.challenge !== pending.challenge) fail("review_not_found", 409);
    pending.settle(body.decision === "approve");
    return json(200, { status: body.decision === "approve" ? "approved" : "rejected" });
  }

  return Object.freeze({
    async handle(request, caller) {
      const hasApprovedOrigin = request.headers.get("origin") === approvedOrigin;
      try {
        if (!isLoopbackPeer(caller.remoteAddress) ||
          request.headers.get("host") !== new URL(LEDGER_COMPANION_ORIGIN).host ||
          containsForwardedHeaders(request.headers)) fail("loopback_boundary_denied", 403);
        const url = new URL(request.url);
        if (url.origin !== LEDGER_COMPANION_ORIGIN || url.search || url.hash) fail("endpoint_denied", 403);
        if (url.pathname === "/ui" || url.pathname.startsWith("/v1/local/")) {
          return await local(request, url.pathname);
        }
        if (["/v1/pair", "/v1/sign", "/v1/status", "/v1/disconnect"].includes(url.pathname)) {
          return await hosted(request, url.pathname);
        }
        fail("not_found", 404);
      } catch (error) {
        const safe = safeError(error);
        return json(safe.status, { error: safe.code }, hasApprovedOrigin ? hostedCors(approvedOrigin) : {});
      }
    },
  });
}

export function createSpeculosCompanionSigner(wallet: PilotWallet): LedgerCompanionSigner {
  if (wallet.provider !== "ledger" || wallet.network !== "testnet" ||
    wallet.ledgerTransport !== "virtual" || wallet.custody !== "software") {
    fail("invalid_speculos_signer", 500);
  }
  let generation = 1;
  let connectedAccount: string | undefined;
  return Object.freeze({
    async identity() {
      connectedAccount ??= await wallet.connect();
      if (connectedAccount !== LEDGER_COMPANION_PUBLIC_ACCOUNT) fail("unexpected_speculos_account", 409);
      const appVersion = await wallet.ledgerAppVersion?.();
      if (appVersion !== LEDGER_COMPANION_XRP_APP_VERSION) fail("unsupported_xrp_app", 409);
      return Object.freeze({ account: connectedAccount, generation, appVersion });
    },
    async sign(transaction: Readonly<Record<string, unknown>>) {
      if (connectedAccount === undefined || wallet.address() !== connectedAccount) fail("device_session_changed", 409);
      return wallet.signOnly({ ...transaction });
    },
    async disconnect() {
      generation += 1;
      connectedAccount = undefined;
      await wallet.disconnect();
    },
  });
}

export function createSpeculosEmulatorControls(fetcher: typeof fetch = fetch): LedgerCompanionEmulatorControls {
  const call = async (path: string, init: RequestInit): Promise<Response> => {
    const response = await fetcher(`${LEDGER_COMPANION_SPECULOS_ORIGIN}${path}`, {
      ...init,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok || response.redirected || response.url && !response.url.startsWith(LEDGER_COMPANION_SPECULOS_ORIGIN)) {
      fail("speculos_controls_unavailable", 503);
    }
    return response;
  };
  return Object.freeze({
    async screen() {
      const response = await call("/screenshot", { method: "GET" });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength < 1 || bytes.byteLength > 1024 * 1024) fail("invalid_screen", 502);
      return bytes;
    },
    async press(button: "left" | "right" | "both") {
      await call(`/button/${button}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "press-and-release" }),
      });
    },
  });
}
