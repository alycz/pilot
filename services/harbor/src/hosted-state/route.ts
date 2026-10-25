import { z } from "zod";

import {
	HOSTED_STATE_MAX_REQUEST_BYTES,
	HOSTED_STATE_ROUTE_PREFIX,
	HostedStateError,
	personalizationCompareAndSwapSchema,
	personalizationDeleteSchema,
	personalizationReadSchema,
	readHostedStateConfig,
	researchQuotaReservationSchema,
	walletProofConsumeSchema,
	type HostedStateConfig,
} from "./contracts";
import { D1HostedStateStore } from "./store";

type Store = Pick<D1HostedStateStore,
	"consumeWalletProof" | "readPersonalization" | "compareAndSwapPersonalization" |
	"deletePersonalization" | "reserveResearchQuota">;
export type HostedStateRouteOptions = Readonly<{
	principal: string;
	localDevRequest: boolean;
	database: D1Database;
	environment: object;
	storeFactory?: (database: D1Database, config: HostedStateConfig) => Store;
}>;
type RouteKind = "wallet-proof" | "personalization-read" | "personalization-cas" |
	"personalization-delete" | "research-quota";

const ROUTES: Readonly<Record<string, RouteKind>> = Object.freeze({
	[`${HOSTED_STATE_ROUTE_PREFIX}/wallet-proofs/consume`]: "wallet-proof",
	[`${HOSTED_STATE_ROUTE_PREFIX}/personalization/read`]: "personalization-read",
	[`${HOSTED_STATE_ROUTE_PREFIX}/personalization/compare-and-swap`]: "personalization-cas",
	[`${HOSTED_STATE_ROUTE_PREFIX}/personalization/delete`]: "personalization-delete",
	[`${HOSTED_STATE_ROUTE_PREFIX}/research/quota/reservations`]: "research-quota",
});
const HEADERS = Object.freeze({
	"cache-control": "no-store",
	"content-security-policy": "default-src 'none'",
	"x-content-type-options": "nosniff",
});

class RouteError extends Error {
	constructor(readonly status: number, readonly code: string, message: string) {
		super(message); this.name = "RouteError";
	}
}
function headers(retryAfterSeconds?: number): Headers {
	const value = new Headers(HEADERS);
	if (retryAfterSeconds !== undefined) value.set("retry-after", String(retryAfterSeconds));
	return value;
}
function success(value: unknown): Response {
	return Response.json(value, { status: 200, headers: headers() });
}
function failure(status: number, code: string, message: string, retryAfterSeconds?: number): Response {
	return Response.json({ error: { code, message,
		...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) } },
		{ status, headers: headers(retryAfterSeconds) });
}

async function readBody(request: Request): Promise<unknown> {
	const contentType = request.headers.get("content-type") ?? "";
	if (contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
		throw new RouteError(415, "HOSTED_STATE_INVALID_REQUEST", "The request must use application/json");
	}
	const declared = request.headers.get("content-length");
	if (declared !== null) {
		if (!/^(0|[1-9][0-9]*)$/u.test(declared))
			throw new RouteError(400, "HOSTED_STATE_INVALID_REQUEST", "The content length is invalid");
		const length = Number(declared);
		if (!Number.isSafeInteger(length) || length > HOSTED_STATE_MAX_REQUEST_BYTES)
			throw new RouteError(413, "HOSTED_STATE_INVALID_REQUEST", "The request is too large");
	}
	if (!request.body) throw new RouteError(400, "HOSTED_STATE_INVALID_REQUEST", "A request body is required");
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > HOSTED_STATE_MAX_REQUEST_BYTES) {
				await reader.cancel().catch(() => undefined);
				throw new RouteError(413, "HOSTED_STATE_INVALID_REQUEST", "The request is too large");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	if (size === 0) throw new RouteError(400, "HOSTED_STATE_INVALID_REQUEST", "A request body is required");
	const body = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
	} catch {
		throw new RouteError(400, "HOSTED_STATE_INVALID_REQUEST", "The request JSON is invalid");
	}
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
	const result = schema.safeParse(value);
	if (!result.success) throw new RouteError(400, "HOSTED_STATE_INVALID_REQUEST", "The request body is invalid");
	return result.data;
}

/** Handles only the authenticated internal hosted-state routes. */
export async function handleHostedStateRoute(
	request: Request,
	options: HostedStateRouteOptions,
): Promise<Response | undefined> {
	const url = new URL(request.url);
	const route = ROUTES[url.pathname];
	if (!route) return undefined;
	try {
		if (url.search !== "") throw new RouteError(400, "HOSTED_STATE_INVALID_REQUEST", "Query parameters are not accepted");
		if (options.localDevRequest) throw new RouteError(404, "HOSTED_STATE_DISABLED", "Not found");
		if (request.method !== "POST") throw new RouteError(405, "HOSTED_STATE_INVALID_REQUEST", "The route requires POST");
		const config = readHostedStateConfig(options.environment);
		if (!config) throw new HostedStateError("HOSTED_STATE_DISABLED", 503, "Hosted state is disabled");
		if (options.principal !== config.allowedPrincipal)
			throw new HostedStateError("HOSTED_STATE_UNAUTHORIZED", 403, "Hosted state access is denied");
		const body = await readBody(request);
		const store = options.storeFactory?.(options.database, config) ??
			new D1HostedStateStore(options.database, config);
		switch (route) {
			case "wallet-proof": return success(await store.consumeWalletProof(options.principal, parse(walletProofConsumeSchema, body)));
			case "personalization-read": return success(await store.readPersonalization(options.principal, parse(personalizationReadSchema, body)));
			case "personalization-cas": return success(await store.compareAndSwapPersonalization(options.principal, parse(personalizationCompareAndSwapSchema, body)));
			case "personalization-delete": return success(await store.deletePersonalization(options.principal, parse(personalizationDeleteSchema, body)));
			case "research-quota": return success(await store.reserveResearchQuota(options.principal, parse(researchQuotaReservationSchema, body)));
		}
	} catch (error) {
		if (error instanceof HostedStateError)
			return failure(error.status, error.code, error.message, error.retryAfterSeconds);
		if (error instanceof RouteError) return failure(error.status, error.code, error.message);
		return failure(503, "HOSTED_STATE_UNAVAILABLE", "Hosted state is temporarily unavailable");
	}
}
