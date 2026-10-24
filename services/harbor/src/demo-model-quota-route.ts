import { z } from "zod";

import {
	D1DemoQuotaStore,
	DemoQuotaError,
	readDemoQuotaConfig,
	type DemoQuotaConfig,
	type DemoQuotaReservation,
	type DemoQuotaSettlement,
	type DemoQuotaStatus,
} from "./demo-model-quota";

export const DEMO_QUOTA_ROUTE_PREFIX = "/internal/demo-model/v1";
export const DEMO_QUOTA_MAX_REQUEST_BYTES = 8_192;

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
const FREE_MODEL_PATTERN =
	/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}:free$/;

const reserveSchema = z.object({
	version: z.literal(1),
	requestId: z.string().regex(HEX_64_PATTERN),
	walletScopeId: z.string().regex(HEX_64_PATTERN),
	sessionScopeId: z.string().regex(HEX_64_PATTERN),
	network: z.enum(["testnet", "devnet"]),
	model: z.string().regex(FREE_MODEL_PATTERN),
	inputBytes: z.number().int().nonnegative().safe(),
}).strict();

const settleSchema = z.object({
	version: z.literal(1),
	outcome: z.enum(["completed", "uncertain"]),
	actualInputTokens: z.number().int().nonnegative().safe().optional(),
	actualOutputTokens: z.number().int().nonnegative().safe().optional(),
	integrityFailure: z.enum([
		"unexpected-model",
		"missing-cost",
		"nonzero-cost",
	]).optional(),
}).strict().superRefine((value, context) => {
	if (value.integrityFailure !== undefined && value.outcome !== "uncertain") {
		context.addIssue({
			code: "custom",
			message: "integrity failure requires an uncertain outcome",
		});
	}
});

const reservationResponseSchema = z.object({
	id: z.string().regex(UUID_PATTERN),
	timeoutMs: z.number().int().positive().safe(),
	maxOutputTokens: z.number().int().positive().safe(),
	maxSteps: z.number().int().positive().safe(),
	remainingGlobalDailyOutputTokens: z.number().int().nonnegative().safe(),
	remainingWalletDailyOutputTokens: z.number().int().nonnegative().safe(),
	remainingWalletDailyRequests: z.number().int().nonnegative().safe(),
	policyVersion: z.string().min(1).max(64),
}).strict();

const settlementResponseSchema = z.object({
	id: z.string().regex(UUID_PATTERN),
	outcome: z.enum(["completed", "uncertain"]),
	alreadySettled: z.boolean(),
}).strict();

const statusResponseSchema = z.object({
	available: z.literal(true),
	policyVersion: z.string().min(1).max(64),
	costPolicy: z.literal("free-only"),
	allowedModels: z.array(z.string().regex(FREE_MODEL_PATTERN)).min(1),
	globalDailyOutputTokens: z.number().int().positive().safe(),
	globalDailyRequests: z.number().int().positive().safe(),
	walletDailyOutputTokens: z.number().int().positive().safe(),
	walletDailyRequests: z.number().int().positive().safe(),
	rateWindowSeconds: z.number().int().positive().safe(),
	rateRequests: z.number().int().positive().safe(),
	maxGlobalConcurrency: z.number().int().positive().safe(),
	maxWalletConcurrency: z.number().int().positive().safe(),
	reservationTtlSeconds: z.number().int().positive().safe(),
	abortGraceSeconds: z.number().int().positive().safe(),
	maxInputBytes: z.number().int().positive().safe(),
	maxOutputTokens: z.number().int().positive().safe(),
	maxSteps: z.number().int().positive().safe(),
}).strict();

type DemoQuotaStore = Pick<
	D1DemoQuotaStore,
	"reserve" | "settle" | "status"
>;

export type DemoModelQuotaRouteOptions = Readonly<{
	principal: string;
	localDevRequest: boolean;
	database: D1Database;
	// The Worker Env also contains typed bindings such as DB and LOADER, so it
	// intentionally has no string index signature. The quota parser reads only
	// its exact nonsecret string settings.
	environment: object;
	storeFactory?: (
		database: D1Database,
		config: DemoQuotaConfig,
	) => DemoQuotaStore;
}>;

type RouteKind =
	| { kind: "reserve" }
	| { kind: "settle"; reservationId: string }
	| { kind: "status" };

class RouteInputError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "RouteInputError";
	}
}

const RESPONSE_HEADERS = Object.freeze({
	"cache-control": "no-store",
	"content-security-policy": "default-src 'none'",
	"x-content-type-options": "nosniff",
});

function responseHeaders(retryAfterSeconds?: number): Headers {
	const headers = new Headers(RESPONSE_HEADERS);
	if (
		retryAfterSeconds !== undefined &&
		Number.isSafeInteger(retryAfterSeconds) &&
		retryAfterSeconds > 0
	) {
		headers.set("retry-after", String(retryAfterSeconds));
	}
	return headers;
}

function success(
	key: "reservation" | "settlement" | "status",
	value: DemoQuotaReservation | DemoQuotaSettlement | DemoQuotaStatus,
): Response {
	const parsed = key === "reservation"
		? reservationResponseSchema.parse(value)
		: key === "settlement"
			? settlementResponseSchema.parse(value)
			: statusResponseSchema.parse(value);
	return Response.json(
		{ ok: true, [key]: parsed },
		{ status: 200, headers: responseHeaders() },
	);
}

function failure(
	status: number,
	code: string,
	message: string,
	retryAfterSeconds?: number,
): Response {
	return Response.json(
		{
			ok: false,
			error: {
				code,
				message,
				...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
			},
		},
		{ status, headers: responseHeaders(retryAfterSeconds) },
	);
}

function classifyRoute(url: URL): RouteKind | undefined {
	if (url.pathname === `${DEMO_QUOTA_ROUTE_PREFIX}/reservations`) {
		return { kind: "reserve" };
	}
	if (url.pathname === `${DEMO_QUOTA_ROUTE_PREFIX}/status`) {
		return { kind: "status" };
	}
	const prefix = `${DEMO_QUOTA_ROUTE_PREFIX}/reservations/`;
	const suffix = "/settle";
	if (!url.pathname.startsWith(prefix) || !url.pathname.endsWith(suffix)) {
		return undefined;
	}
	const reservationId = url.pathname.slice(prefix.length, -suffix.length);
	if (!UUID_PATTERN.test(reservationId)) {
		throw new RouteInputError(
			400,
			"DEMO_INVALID_REQUEST",
			"The demo quota reservation identifier is invalid",
		);
	}
	return { kind: "settle", reservationId };
}

function assertMethod(request: Request, route: RouteKind): void {
	const expected = route.kind === "status" ? "GET" : "POST";
	if (request.method !== expected) {
		throw new RouteInputError(
			405,
			"DEMO_METHOD_NOT_ALLOWED",
			`The demo quota route requires ${expected}`,
		);
	}
}

function assertJsonContentType(request: Request): void {
	const contentType = request.headers.get("content-type") ?? "";
	if (contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
		throw new RouteInputError(
			415,
			"DEMO_UNSUPPORTED_MEDIA_TYPE",
			"The demo quota request must use application/json",
		);
	}
}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
	const declaredLength = request.headers.get("content-length");
	if (declaredLength !== null) {
		if (!/^(0|[1-9][0-9]*)$/.test(declaredLength)) {
			throw new RouteInputError(
				400,
				"DEMO_INVALID_REQUEST",
				"The demo quota content length is invalid",
			);
		}
		const parsedLength = Number(declaredLength);
		if (!Number.isSafeInteger(parsedLength) || parsedLength > DEMO_QUOTA_MAX_REQUEST_BYTES) {
			throw new RouteInputError(
				413,
				"DEMO_REQUEST_TOO_LARGE",
				"The demo quota request is too large",
			);
		}
	}

	if (!request.body) {
		throw new RouteInputError(
			400,
			"DEMO_INVALID_REQUEST",
			"The demo quota request body is required",
		);
	}

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > DEMO_QUOTA_MAX_REQUEST_BYTES) {
				await reader.cancel().catch(() => undefined);
				throw new RouteInputError(
					413,
					"DEMO_REQUEST_TOO_LARGE",
					"The demo quota request is too large",
				);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const body = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

async function readJson(request: Request): Promise<unknown> {
	assertJsonContentType(request);
	const bytes = await readBoundedBody(request);
	try {
		const text = new TextDecoder("utf-8", {
			fatal: true,
			ignoreBOM: true,
		}).decode(bytes);
		return JSON.parse(text) as unknown;
	} catch {
		throw new RouteInputError(
			400,
			"DEMO_INVALID_JSON",
			"The demo quota request body is invalid JSON",
		);
	}
}

/**
 * Dispatches the private Pilot-to-Harbor quota protocol after Harbor bearer
 * authentication. It returns undefined for unrelated routes so the Worker can
 * continue its normal REST/MCP dispatch.
 */
export async function handleDemoModelQuotaRoute(
	request: Request,
	options: DemoModelQuotaRouteOptions,
): Promise<Response | undefined> {
	let route: RouteKind | undefined;
	try {
		const url = new URL(request.url);
		route = classifyRoute(url);
		if (!route) return undefined;
		if (url.search !== "") {
			throw new RouteInputError(
				400,
				"DEMO_INVALID_REQUEST",
				"Demo quota routes do not accept query parameters",
			);
		}
		if (options.localDevRequest) {
			return failure(
				404,
				"DEMO_ROUTE_UNAVAILABLE",
				"The demo quota route is unavailable",
			);
		}
		assertMethod(request, route);

		const config = readDemoQuotaConfig(
			options.environment as Parameters<typeof readDemoQuotaConfig>[0],
		);
		if (!config) {
			return failure(
				503,
				"DEMO_DISABLED",
				"Shared demo quota access is disabled",
			);
		}
		if (options.principal !== config.allowedPrincipal) {
			return failure(
				403,
				"DEMO_UNAUTHORIZED",
				"This Harbor principal cannot access the shared demo quota",
			);
		}

		const store = options.storeFactory
			? options.storeFactory(options.database, config)
			: new D1DemoQuotaStore(options.database, config);

		if (route.kind === "status") {
			return success("status", await store.status(options.principal));
		}

		const body = await readJson(request);
		if (route.kind === "reserve") {
			const parsed = reserveSchema.safeParse(body);
			if (!parsed.success) {
				throw new RouteInputError(
					400,
					"DEMO_INVALID_REQUEST",
					"The demo quota reservation request is invalid",
				);
			}
			return success(
				"reservation",
				await store.reserve(options.principal, parsed.data),
			);
		}

		const parsed = settleSchema.safeParse(body);
		if (!parsed.success) {
			throw new RouteInputError(
				400,
				"DEMO_INVALID_REQUEST",
				"The demo quota settlement request is invalid",
			);
		}
		return success(
			"settlement",
			await store.settle(options.principal, {
				...parsed.data,
				reservationId: route.reservationId,
			}),
		);
	} catch (error) {
		if (error instanceof RouteInputError) {
			return failure(error.status, error.code, error.message);
		}
		if (error instanceof DemoQuotaError) {
			return failure(
				error.status,
				error.code,
				error.message,
				error.retryAfterSeconds,
			);
		}
		return failure(
			503,
			"DEMO_STATE_UNAVAILABLE",
			"Shared demo quota storage is unavailable",
		);
	}
}
