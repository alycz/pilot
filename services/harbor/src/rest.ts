import type { OpContext } from "./catalog/registry";
import { OpRegistry } from "./catalog/registry";
import {
	buildWbaDirectory,
	type WbaXrplCredential,
} from "./exec/wba";
import { createHarborProvider } from "./executor/providers";
import { errorEnvelope } from "./guard";
import { D1QuickNodeNonceStore } from "./quicknode/d1-nonce-store";
import { verifyQuickNode } from "./quicknode/hmac";
import { processQuickNodeWalletWebhook } from "./quicknode/webhook";
import {
	parseWatchdogStreamPayload,
	processQuickNodeWatchdog,
	type WatchdogPayerAuthority,
	type WatchdogRegistry,
} from "./quicknode/watchdog";

export type RestContext = OpContext & {
	db?: D1Database;
	request?: Request;
};

export const REST_MAX_REQUEST_BYTES = 1024 * 1024;
export const REST_MAX_RESPONSE_BYTES = 1024 * 1024;

const encoder = new TextEncoder();

class RestBodyError extends Error {
	constructor(
		readonly code: "INVALID_JSON" | "REQUEST_TOO_LARGE",
		readonly status: 400 | 413,
		message: string,
	) {
		super(message);
		this.name = "RestBodyError";
	}
}

async function boundedJsonBody(request: Request): Promise<unknown> {
	const declared = request.headers.get("content-length");
	if (declared !== null) {
		if (!/^[0-9]+$/.test(declared)) {
			throw new RestBodyError("INVALID_JSON", 400, "Content-Length is invalid");
		}
		if (BigInt(declared) > BigInt(REST_MAX_REQUEST_BYTES)) {
			throw new RestBodyError("REQUEST_TOO_LARGE", 413, "Request body is too large");
		}
	}

	if (request.body === null) {
		throw new RestBodyError("INVALID_JSON", 400, "Request body must be valid JSON");
	}
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			length += next.value.byteLength;
			if (length > REST_MAX_REQUEST_BYTES) {
				await reader.cancel().catch(() => undefined);
				throw new RestBodyError("REQUEST_TOO_LARGE", 413, "Request body is too large");
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
		return JSON.parse(text) as unknown;
	} catch {
		throw new RestBodyError("INVALID_JSON", 400, "Request body must be valid JSON");
	}
}

function jsonResponse(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: {
			"cache-control": "no-store",
			"content-type": "application/json",
		},
	});
}

function json(value: unknown, status = 200): Response {
	return jsonResponse(JSON.stringify(value) ?? "null", status);
}

function boundedOperationJson(value: unknown, operationName: string): Response {
	const body = JSON.stringify(value) ?? "null";
	if (encoder.encode(body).byteLength <= REST_MAX_RESPONSE_BYTES) {
		return jsonResponse(body);
	}
	return json(
		errorEnvelope(
			operationName,
			new Error("Operation response is too large"),
			{ code: "RESPONSE_TOO_LARGE" },
		),
		500,
	);
}
export type QuickNodeWebhookContext = {
	db: D1Database;
	env: {
		QN_MODE?: string;
		QN_RUN_TAG?: string;
		QN_WEBHOOK_SECURITY_TOKEN?: string;
	};
	waitUntil(promise: Promise<unknown>): void;
	now?: Date;
};

export type QuickNodeWatchdogContext = {
	db: D1Database;
	env: {
		EXEC_NETWORK?: string;
		QN_MODE?: string;
		QN_RUN_TAG?: string;
		QN_STREAM_SECURITY_TOKEN?: string;
		QN_WATCHDOG_ACTION?: string;
	};
	waitUntil(promise: Promise<unknown>): void;
	now?: Date;
	registry: WatchdogRegistry;
	payer: WatchdogPayerAuthority;
};

const WBA_DIRECTORY_MAX_BYTES = 8_192;

type WbaDirectoryConfiguration = {
	public_jwk: JsonWebKey;
	xrpl_credential: WbaXrplCredential;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
): boolean {
	const actual = Object.keys(value).sort();
	return (
		actual.length === expected.length &&
		actual.every((key, index) => key === expected[index])
	);
}

function parseWbaDirectoryConfiguration(
	value: string | undefined,
): WbaDirectoryConfiguration {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		new TextEncoder().encode(value).byteLength > WBA_DIRECTORY_MAX_BYTES
	) {
		throw new Error("Web Bot Auth directory configuration is unavailable");
	}

	const parsed: unknown = JSON.parse(value);
	if (
		!isRecord(parsed) ||
		!hasExactKeys(parsed, ["public_jwk", "xrpl_credential"]) ||
		!isRecord(parsed.public_jwk) ||
		!hasExactKeys(parsed.public_jwk, ["crv", "kty", "x"]) ||
		!isRecord(parsed.xrpl_credential) ||
		!hasExactKeys(parsed.xrpl_credential, [
			"credential_type",
			"issuer",
			"subject",
		])
	) {
		throw new Error("Web Bot Auth directory configuration is invalid");
	}
	if (
		typeof parsed.public_jwk.kty !== "string" ||
		typeof parsed.public_jwk.crv !== "string" ||
		typeof parsed.public_jwk.x !== "string" ||
		typeof parsed.xrpl_credential.issuer !== "string" ||
		parsed.xrpl_credential.credential_type !== "AP4M-Agent" ||
		typeof parsed.xrpl_credential.subject !== "string"
	) {
		throw new Error("Web Bot Auth directory configuration is invalid");
	}

	return {
		public_jwk: {
			kty: parsed.public_jwk.kty,
			crv: parsed.public_jwk.crv,
			x: parsed.public_jwk.x,
		},
		xrpl_credential: {
			issuer: parsed.xrpl_credential.issuer,
			credential_type: parsed.xrpl_credential.credential_type,
			subject: parsed.xrpl_credential.subject,
		},
	};
}

const QUICKNODE_WEBHOOK_MAX_BYTES = 1_048_576;

/**
 * Receive one QuickNode wallet-filter delivery.
 *
 * Authentication and replay protection finish before the fast acknowledgement;
 * durable matching runs through waitUntil and never exposes the raw payload to
 * an operation result or model-facing envelope.
 */
export async function handleQuickNodeWalletWebhook(
	request: Request,
	context: QuickNodeWebhookContext,
): Promise<Response> {
	if (request.method !== "POST") {
		return new Response("Method Not Allowed", {
			status: 405,
			headers: { allow: "POST", "cache-control": "no-store" },
		});
	}
	if (new URL(request.url).search !== "") {
		return json({ ok: false, status: "rejected" }, 400);
	}
	const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (mediaType !== "application/json") {
		return json({ ok: false, status: "rejected" }, 415);
	}

	const mode = context.env.QN_MODE;
	const secret = context.env.QN_WEBHOOK_SECURITY_TOKEN;
	if ((mode !== "mock" && mode !== "live") || !secret) {
		return json({ ok: false, status: "unavailable" }, 503);
	}

	const declaredLength = request.headers.get("content-length");
	if (
		declaredLength !== null &&
		(!/^\d+$/.test(declaredLength) || Number(declaredLength) > QUICKNODE_WEBHOOK_MAX_BYTES)
	) {
		return json({ ok: false, status: "rejected" }, 413);
	}
	const rawBody = new Uint8Array(await request.arrayBuffer());
	if (rawBody.byteLength > QUICKNODE_WEBHOOK_MAX_BYTES) {
		return json({ ok: false, status: "rejected" }, 413);
	}
	// QN-6 provisions compression:"none". Reject gzip before the QN-0
	// verifier can decompress an unauthenticated, expansion-heavy body.
	if (rawBody[0] === 0x1f && rawBody[1] === 0x8b) {
		return json({ ok: false, status: "rejected" }, 415);
	}
	const verification = await verifyQuickNode(
		secret,
		rawBody,
		request.headers.get("x-qn-nonce") ?? "",
		request.headers.get("x-qn-timestamp") ?? "",
		request.headers.get("x-qn-signature") ?? "",
		{
			nonceStore: new D1QuickNodeNonceStore(context.db),
			now: context.now,
		},
	);
	if (verification.status === "rejected") {
		return json({ ok: false, status: "rejected" }, 401);
	}
	if (verification.status === "dup") {
		return json({ ok: true, status: "dup" });
	}
	if (verification.body.byteLength > QUICKNODE_WEBHOOK_MAX_BYTES) {
		return json({ ok: false, status: "rejected" }, 413);
	}

	let payload: unknown;
	try {
		payload = JSON.parse(verification.text) as unknown;
	} catch {
		return json({ ok: false, status: "rejected" }, 400);
	}

	const receivedAt = (context.now ?? new Date()).toISOString();
	const followUp = processQuickNodeWalletWebhook(context.db, payload, {
		provider: mode === "mock" ? "quicknode-mock" : "quicknode-webhook",
		receivedAt,
		runTag: context.env.QN_RUN_TAG ?? "run1",
	}).catch(() => {
		console.warn("qn_webhook_followup_failed", {
			evt: "qn_webhook_followup_failed",
			code: "QN_WEBHOOK_FOLLOWUP_FAILED",
		});
	});
	context.waitUntil(followUp);
	return json({ ok: true, status: "accepted" });
}

/** Receive one pre-authenticated QuickNode Streams watchdog delivery. */
export async function handleQuickNodeWatchdog(
	request: Request,
	context: QuickNodeWatchdogContext,
): Promise<Response> {
	if (request.method !== "POST") {
		return new Response("Method Not Allowed", {
			status: 405,
			headers: { allow: "POST", "cache-control": "no-store" },
		});
	}
	if (new URL(request.url).search !== "") {
		return json({ ok: false, status: "rejected" }, 400);
	}
	const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (mediaType !== "application/json") {
		return json({ ok: false, status: "rejected" }, 415);
	}

	const mode = context.env.QN_MODE;
	const secret = context.env.QN_STREAM_SECURITY_TOKEN;
	const network = context.env.EXEC_NETWORK;
	const action = context.env.QN_WATCHDOG_ACTION ?? "freeze";
	if (
		(mode !== "mock" && mode !== "live") ||
		!secret ||
		(network !== "testnet" && network !== "devnet") ||
		(action !== "freeze" && action !== "alert") ||
		!context.registry ||
		!context.payer
	) {
		return json({ ok: false, status: "unavailable" }, 503);
	}

	const declaredLength = request.headers.get("content-length");
	if (
		declaredLength !== null &&
		(!/^\d+$/.test(declaredLength) || Number(declaredLength) > QUICKNODE_WEBHOOK_MAX_BYTES)
	) {
		return json({ ok: false, status: "rejected" }, 413);
	}
	const rawBody = new Uint8Array(await request.arrayBuffer());
	if (rawBody.byteLength > QUICKNODE_WEBHOOK_MAX_BYTES) {
		return json({ ok: false, status: "rejected" }, 413);
	}
	if (rawBody[0] === 0x1f && rawBody[1] === 0x8b) {
		return json({ ok: false, status: "rejected" }, 415);
	}
	const verification = await verifyQuickNode(
		secret,
		rawBody,
		request.headers.get("x-qn-nonce") ?? "",
		request.headers.get("x-qn-timestamp") ?? "",
		request.headers.get("x-qn-signature") ?? "",
		{
			nonceStore: new D1QuickNodeNonceStore(context.db),
			now: context.now,
		},
	);
	if (verification.status === "rejected") {
		return json({ ok: false, status: "rejected" }, 401);
	}
	if (verification.status === "dup") {
		return json({ ok: true, status: "dup" });
	}

	let payload: unknown;
	try {
		payload = parseWatchdogStreamPayload(JSON.parse(verification.text) as unknown);
	} catch {
		return json({ ok: false, status: "rejected" }, 400);
	}
	const receivedAt = (context.now ?? new Date()).toISOString();
	const followUp = processQuickNodeWatchdog(context.db, payload, {
		receivedAt,
		network,
		action,
		runTag: context.env.QN_RUN_TAG ?? "run1",
		registry: context.registry,
		payer: context.payer,
	}).catch(() => {
		console.warn("qn_watchdog_followup_failed", {
			evt: "qn_watchdog_followup_failed",
			code: "QN_WATCHDOG_FOLLOWUP_FAILED",
		});
	});
	context.waitUntil(followUp);
	return json({ ok: true, status: "accepted" });
}

export async function handleWbaDirectory(
	request: Request,
	publicConfiguration: string | undefined,
): Promise<Response> {
	if (request.method !== "GET") {
		return new Response("Method Not Allowed", {
			status: 405,
			headers: { allow: "GET", "cache-control": "no-store" },
		});
	}
	if (new URL(request.url).search !== "") {
		return new Response("Bad Request", {
			status: 400,
			headers: { "cache-control": "no-store" },
		});
	}

	try {
		const configured = parseWbaDirectoryConfiguration(publicConfiguration);
		const directory = await buildWbaDirectory(
			configured.public_jwk,
			configured.xrpl_credential,
		);
		return new Response(JSON.stringify(directory), {
			status: 200,
			headers: {
				"cache-control": "public, max-age=300",
				"content-type":
					"application/http-message-signatures-directory+json",
			},
		});
	} catch {
		return Response.json(
			{
				ok: false,
				error: {
					service: "web-bot-auth",
					kind: "error",
					message: "Web Bot Auth directory is unavailable",
					code: "WBA_DIRECTORY_UNAVAILABLE",
				},
			},
			{ status: 503, headers: { "cache-control": "no-store" } },
		);
	}
}

export async function handleRestOperation(
	request: Request,
	opName: string,
	ctx: RestContext,
	registry: OpRegistry,
): Promise<Response> {
	if (request.method !== "POST") {
		return new Response("Method Not Allowed", {
			status: 405,
			headers: { allow: "POST" },
		});
	}
	const op = registry.get(opName);
	if (!op) {
		return json(
			errorEnvelope(opName, new Error(`Unknown operation: ${opName}`), {
				code: "UNKNOWN_OPERATION",
			}),
			404,
		);
	}

	let args: unknown;
	try {
		args = await boundedJsonBody(request);
	} catch (error) {
		const bodyError = error instanceof RestBodyError
			? error
			: new RestBodyError("INVALID_JSON", 400, "Request body must be valid JSON");
		return json(
			errorEnvelope(opName, new Error(bodyError.message), {
				code: bodyError.code,
			}),
			bodyError.status,
		);
	}

	try {
		const envelope = await createHarborProvider(registry, ctx).invoke(
			op.name,
			args,
		);
		return boundedOperationJson(envelope, op.name);
	} catch {
		return json(
			errorEnvelope(op.name, new Error("Operation failed"), {
				code: "OPERATION_FAILED",
			}),
		);
	}
}
