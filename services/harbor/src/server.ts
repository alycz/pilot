import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { WorkerEntrypoint } from "cloudflare:workers";

import catalogManifest from "../catalog/manifest.json";
import generatedOps from "./ops/index.gen";
import { OpRegistry, type CatalogManifestInput } from "./catalog/registry";
import type { Network } from "./contracts";
import { scheduled as runScheduled } from "./cron";
import { createHarborProvider } from "./executor/providers";
import { createLocalX402Service } from "./exec/x402-runtime";
import {
	createLocalIssuedX402FixtureService,
	type LocalIssuedX402RuntimeAdapter,
} from "./exec/x402-issued-runtime";
import {
	createAp4mRuntimeServices,
	type Ap4mRuntimeAdapter,
} from "./exec/ap4m-runtime";
import type { Ap4mPurchaseServices } from "./ops/ap4m";
import { CAPABILITY_OPERATION_NAMES } from "./ops/capability";
import type { X402Service } from "./x402-contract";
import {
	LOCAL_HARBOR_ORIGIN,
	isLocalDevRequest,
	probeLocalX402,
} from "./local-x402";
import {
	isLocalX402IssuedFixtureRequest,
	localX402IssuedFixtureMarkersPresent,
} from "./local-x402-issued-fixture";
import {
	isLocalX402IsolatedV1Request,
	localX402IsolatedV1MarkersPresent,
} from "./local-x402-isolated-v1";
import {
	isLocalTradingIsolatedV1Request,
	localTradingIsolatedV1MarkersPresent,
} from "./local-trading-isolated-v1";
import {
	isLocalTradingIsolatedOnboardingV1Request,
	localTradingIsolatedOnboardingV1MarkersPresent,
} from "./local-trading-isolated-onboarding-v1";
import { localTradingSafetyMarkersPresent } from "./local-trading";
import { createMcpServer } from "./mcp/tools";
import {
	handleQuickNodeWatchdog,
	handleQuickNodeWalletWebhook,
	handleRestOperation,
	handleWbaDirectory,
} from "./rest";
import { createQuickNodeKvRegistryForRequest } from "./quicknode/kv-registry";
import type {
	WatchdogNetwork,
	WatchdogPayerAuthority,
} from "./quicknode/watchdog";
import { KmsKekError, validateKmsConfig } from "./aws/kms";
import { handleDemoModelQuotaRoute } from "./demo-model-quota-route";
import {
	OWNER_REVIEW_OPERATION_NAMES,
	handleOwnerReviewX402Route,
} from "./x402-owner-review-route";
import {
	WORK_AGREEMENT_OPERATION_NAMES,
	handleWorkAgreementRoute,
} from "./work-agreement-route";

export interface Env {
	DB: D1Database;
	LOADER?: WorkerLoader;
	HARBOR_API_KEYS?: string;
	HARBOR_DEMO_QUOTA_ENABLED?: string;
	HARBOR_DEMO_QUOTA_PRINCIPAL?: string;
	HARBOR_DEMO_COST_POLICY?: string;
	HARBOR_DEMO_POLICY_VERSION?: string;
	HARBOR_DEMO_ALLOWED_MODELS?: string;
	HARBOR_DEMO_GLOBAL_DAILY_OUTPUT_TOKENS?: string;
	HARBOR_DEMO_GLOBAL_DAILY_REQUESTS?: string;
	HARBOR_DEMO_WALLET_DAILY_OUTPUT_TOKENS?: string;
	HARBOR_DEMO_WALLET_DAILY_REQUESTS?: string;
	HARBOR_DEMO_RATE_WINDOW_SECONDS?: string;
	HARBOR_DEMO_RATE_REQUESTS?: string;
	HARBOR_DEMO_MAX_GLOBAL_CONCURRENCY?: string;
	HARBOR_DEMO_MAX_WALLET_CONCURRENCY?: string;
	HARBOR_DEMO_RESERVATION_TTL_SECONDS?: string;
	HARBOR_DEMO_ABORT_GRACE_SECONDS?: string;
	HARBOR_DEMO_MAX_INPUT_BYTES?: string;
	HARBOR_DEMO_MAX_OUTPUT_TOKENS?: string;
	HARBOR_DEMO_MAX_STEPS?: string;
	EXECUTOR?: "dynamic" | "quickjs";
	EXEC_NETWORK?: Network;
	MAINNET_EXECUTION?: string;
	HARBOR_LOCAL_DEV?: string;
	HARBOR_LOCAL_READ_ONLY?: string;
	HARBOR_LOCAL_AUTH_REQUIRED?: string;
	HARBOR_LOCAL_CRON_DISABLED?: string;
	HARBOR_LOCAL_CAPABILITY_RUNTIME_ENABLED?: string;
	HARBOR_LOCAL_WORK_AGREEMENT_ENABLED?: string;
	HARBOR_LOCAL_X402?: string;
	HARBOR_LOCAL_X402_MERCHANT_PAY_TO?: string;
	HARBOR_LOCAL_X402_RUNTIME_ENABLED?: string;
	HARBOR_LOCAL_X402_SIGNING_PROFILE?: string;
	HARBOR_LOCAL_X402_OWNER_REVIEW_ENABLED?: string;
	HARBOR_LOCAL_X402_ISOLATED_V1_RUNTIME_ENABLED?: string;
	HARBOR_LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE?: string;
	HARBOR_LOCAL_X402_ISSUED_FIXTURE_ENABLED?: string;
	HARBOR_LOCAL_X402_ISSUED_FIXTURE_PROFILE?: string;
	HARBOR_LOCAL_X402_ISSUED_RUNTIME_ADAPTER?: LocalIssuedX402RuntimeAdapter;
	HARBOR_LOCAL_AP4M_X402_COMBINED_V1_RUNTIME_ENABLED?: string;
	HARBOR_LOCAL_AP4M_X402_COMBINED_V1_SIGNING_PROFILE?: string;
	HARBOR_LOCAL_TRADING_RUNTIME_ENABLED?: string;
	HARBOR_LOCAL_TRADING_SIGNING_PROFILE?: string;
	HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED?: string;
	HARBOR_LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE?: string;
	HARBOR_LOCAL_TRADING_ISOLATED_V1_RUNTIME_ENABLED?: string;
	HARBOR_LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE?: string;
	HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_RUNTIME_ENABLED?: string;
	HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_SIGNING_PROFILE?: string;
	HARBOR_KEK?: string;
	HARBOR_SOURCE_TAG?: string;
	HARBOR_MOCK?: string;
	AP4M_DEMO_ENABLED?: string;
	AP4M_PURCHASE_MODE?: string;
	LIVE?: string;
	KMS_MODE?: string;
	HARBOR_KEK_CIPHERTEXT?: string;
	AWS_REGION?: string;
	AWS_ENDPOINT_OVERRIDE?: string;
	AWS_ACCESS_KEY_ID?: string;
	AWS_SECRET_ACCESS_KEY?: string;
	AWS_SESSION_TOKEN?: string;
	HARBOR_WBA_DIRECTORY_URL?: string;
	WBA_SIGNING_JWK?: string;
	AP4M_AGENT_ISSUER?: string;
	AP4M_NETWORK_AUDIENCE?: string;
	QN_MODE?: string;
	QN_RUN_TAG?: string;
	QN_WEBHOOK_SECURITY_TOKEN?: string;
	QN_STREAM_SECURITY_TOKEN?: string;
	QN_WATCHDOG_ACTION?: string;
	QN_API_BASE?: string;
	QN_API_KEY?: string;
	/** Public-only Web Bot Auth JWK and XRPL credential linkage JSON. */
	HARBOR_WBA_DIRECTORY_JSON?: string;
}

export type AuthResult =
	| { ok: true; principal: string }
	| { ok: false; response: Response };

const LOCAL_ONLY_OPERATION_NAMES = new Set([
	...CAPABILITY_OPERATION_NAMES,
	"quicknode.test.registerLink",
	"quicknode.test.deleteLink",
]);
const OWNER_REVIEW_ROUTE_PATHS = new Set(
	OWNER_REVIEW_OPERATION_NAMES.map((name) => `/api/ops/${name}`),
);
export const CAPABILITY_ROUTE_PATHS = Object.freeze(
	CAPABILITY_OPERATION_NAMES.map((name) => `/api/ops/${name}`),
);
export const WORK_AGREEMENT_ROUTE_PATHS = Object.freeze(
	WORK_AGREEMENT_OPERATION_NAMES.map((name) => `/api/ops/${name}`),
);
const LOCAL_BEARER_REQUIRED_ROUTE_PATHS = new Set([
	...OWNER_REVIEW_ROUTE_PATHS,
	...CAPABILITY_ROUTE_PATHS,
	...WORK_AGREEMENT_ROUTE_PATHS,
]);

const productionAppRegistry = new OpRegistry(
	generatedOps.filter(
		(operation) => !LOCAL_ONLY_OPERATION_NAMES.has(operation.name),
	),
).loadCatalogManifest(
	catalogManifest as CatalogManifestInput,
);
const localAppRegistry = new OpRegistry(generatedOps).loadCatalogManifest(
	catalogManifest as CatalogManifestInput,
);

export function selectRuntimeRegistry(
	env: Pick<Env, "HARBOR_LOCAL_DEV">,
	localDevRequest: boolean,
): OpRegistry {
	return env.HARBOR_LOCAL_DEV === "true" && localDevRequest
		? localAppRegistry
		: productionAppRegistry;
}

export type HarborRpcProps = {
	principal: string;
	localDevRequest: boolean;
};

// Dynamic Workers can receive only real Workers RPC bindings. A loopback
// entrypoint gives the sandbox the single principal-scoped capability it needs
// without exposing DB, secrets, or arbitrary fetch.
// https://developers.cloudflare.com/workers/runtime-apis/context/#exports
export class HarborRpc extends WorkerEntrypoint<Env, HarborRpcProps> {
	async invoke(operationName: string, args: unknown = {}): Promise<unknown> {
		let ap4mServices: Ap4mPurchaseServices | undefined;
		try {
			ap4mServices = createAp4mRuntimeServices(this.env);
		} catch {
			if (operationName.startsWith("ap4m.")) {
				return ap4mConfigurationEnvelope();
			}
		}
		const issuedFixtureService = await createLocalIssuedX402FixtureService(this.env);
		const provider = createHarborProvider(
			selectRuntimeRegistry(this.env, this.ctx.props.localDevRequest === true),
			{
				principal: this.ctx.props.principal,
				localDevRequest: this.ctx.props.localDevRequest === true,
				db: this.env.DB,
				env: this.env,
				x402Service: createLocalX402Service(this.env),
				...(issuedFixtureService === undefined
					? {}
					: { x402IssuedFixtureService: issuedFixtureService }),
				...(ap4mServices === undefined ? {} : { ap4mServices }),
			},
		);
		return provider.invoke(operationName, args);
	}
}

function equalCredential(left: string, right: string): boolean {
	const length = Math.max(left.length, right.length);
	let difference = left.length ^ right.length;
	for (let index = 0; index < length; index += 1) {
		difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
	}
	return difference === 0;
}

function configuredKeys(value: string | undefined): Map<string, string> {
	const keys = new Map<string, string>();
	for (const pair of value?.split(",") ?? []) {
		const separator = pair.indexOf(":");
		if (separator <= 0 || separator === pair.length - 1) continue;
		keys.set(pair.slice(0, separator), pair.slice(separator + 1));
	}
	return keys;
}

function isLegacyLocalDevRequest(request: Request, env: Env): boolean {
	if (env.HARBOR_LOCAL_DEV !== "true") return false;
	try {
		const hostname = new URL(request.url).hostname;
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
	} catch {
		return false;
	}
}

function targetsLocalX402Origin(request: Request): boolean {
	try {
		return new URL(request.url).origin === LOCAL_HARBOR_ORIGIN;
	} catch {
		return false;
	}
}

function deriveLocalDevRequest(request: Request, env: Env): boolean {
	if (localX402IssuedFixtureMarkersPresent(env)) {
		return isLocalX402IssuedFixtureRequest(request, env);
	}
	if (localX402IsolatedV1MarkersPresent(env)) {
		return isLocalX402IsolatedV1Request(request, env);
	}
	if (localTradingIsolatedOnboardingV1MarkersPresent(env)) {
		return isLocalTradingIsolatedOnboardingV1Request(request, env);
	}
	if (localTradingIsolatedV1MarkersPresent(env)) {
		return isLocalTradingIsolatedV1Request(request, env);
	}
	return isLocalDevRequest(request, env);
}

function authenticateWithLocalCapability(
	request: Request,
	env: Env,
	localDevRequest: boolean,
): AuthResult {
	if (
		!LOCAL_BEARER_REQUIRED_ROUTE_PATHS.has(new URL(request.url).pathname) &&
		isLegacyLocalDevRequest(request, env) &&
		!localTradingSafetyMarkersPresent(env) &&
		!localX402IssuedFixtureMarkersPresent(env) &&
		(!targetsLocalX402Origin(request) ||
			(localDevRequest && env.HARBOR_LOCAL_X402_RUNTIME_ENABLED !== "true"))
	) {
		return { ok: true, principal: "local-dev" };
	}

	const authorization = request.headers.get("authorization") ?? "";
	if (!authorization.startsWith("Bearer ")) {
		return {
			ok: false,
			response: Response.json(
				{ ok: false, error: { service: "auth", kind: "error", message: "Unauthorized", code: "UNAUTHORIZED" } },
				{ status: 401, headers: { "www-authenticate": "Bearer" } },
			),
		};
	}

	const credential = authorization.slice("Bearer ".length);
	const separator = credential.indexOf(":");
	const principal = separator > 0 ? credential.slice(0, separator) : "";
	const token = separator > 0 ? credential.slice(separator + 1) : "";
	const expected = configuredKeys(env.HARBOR_API_KEYS).get(principal);
	if (!expected || !equalCredential(token, expected)) {
		return {
			ok: false,
			response: Response.json(
				{ ok: false, error: { service: "auth", kind: "error", message: "Unauthorized", code: "UNAUTHORIZED" } },
				{ status: 401, headers: { "www-authenticate": "Bearer" } },
			),
		};
	}

	return { ok: true, principal };
}

function kmsConfigurationFailure(error: unknown): Response {
	const known = error instanceof KmsKekError;
	return Response.json(
		{
			ok: false,
			error: {
				service: "kms",
				kind: "error",
				message: known ? error.message : "KMS configuration is invalid",
				code: known ? error.code : "KMS_CONFIGURATION_INVALID",
			},
		},
		{ status: 503 },
	);
}

function ap4mConfigurationEnvelope() {
	return {
		ok: false as const,
		error: {
			service: "ap4m",
			kind: "error" as const,
			message: "AP4M runtime configuration is invalid",
			code: "AP4M_RUNTIME_CONFIGURATION_INVALID",
		},
	};
}

function ap4mConfigurationFailure(): Response {
	return Response.json(
		ap4mConfigurationEnvelope(),
		{ status: 503, headers: { "cache-control": "no-store" } },
	);
}

export function authenticate(request: Request, env: Env): AuthResult {
	return authenticateWithLocalCapability(
		request,
		env,
		deriveLocalDevRequest(request, env),
	);
}

export type LocalX402ServiceFactory = (env: Env) => X402Service;
export type LocalX402Probe = typeof probeLocalX402;
export type Ap4mRuntimeFactory = (env: Env) => Ap4mPurchaseServices | undefined;

function changed(result: D1Result): number {
	return Number(result.meta.changes ?? 0);
}

/** D1-backed payer boundary injected into the pre-authenticated watchdog route. */
export function createWatchdogPayerAuthority(
	db: D1Database,
	network: string | undefined,
): WatchdogPayerAuthority {
	return {
		async activationFloor(account, selectedNetwork) {
			const row = await db
				.prepare(
					`SELECT funded_ledger_index, created_at FROM x402_payers
					  WHERE network = ? AND payer = ? LIMIT 1`,
				)
				.bind(selectedNetwork, account)
				.first<{ funded_ledger_index: number | null; created_at: string }>();
			if (!row || !Number.isFinite(Date.parse(row.created_at))) return undefined;
			if (
				row.funded_ledger_index !== null &&
				(!Number.isSafeInteger(row.funded_ledger_index) || row.funded_ledger_index < 0)
			) return undefined;
			return {
				ledgerIndex: row.funded_ledger_index,
				activatedAt: row.created_at,
			};
		},
		async ownsTransaction(hash) {
			return (await db
				.prepare(
					`SELECT 1 AS present FROM (
					  SELECT hash AS tx_hash FROM x402_payments WHERE hash = ?
					  UNION ALL
					  SELECT tx_hash FROM ap4m_purchase_attempts WHERE tx_hash = ?
					) LIMIT 1`,
				)
				.bind(hash, hash)
				.first<{ present: number }>())?.present === 1;
		},
		async disable(account, _reason, at) {
			if (network !== "testnet" && network !== "devnet") return false;
			const selectedNetwork: WatchdogNetwork = network;
			const result = await db
				.prepare(
					`UPDATE x402_payers SET status = 'disabled', updated_at = ?
					  WHERE network = ? AND payer = ? AND status <> 'disabled'`,
				)
				.bind(at, selectedNetwork, account)
				.run();
			return changed(result) === 1;
		},
	};
}

export function createAp4mRuntimeFactory(
	adapters: Readonly<{
		mock?: Ap4mRuntimeAdapter;
		live?: Ap4mRuntimeAdapter;
	}> = {},
): Ap4mRuntimeFactory {
	return (env) => createAp4mRuntimeServices(env, adapters);
}

export function createWorker(
	registry?: OpRegistry,
	localX402Service: LocalX402ServiceFactory = createLocalX402Service,
	localX402Probe: LocalX402Probe = probeLocalX402,
	ap4mRuntime: Ap4mRuntimeFactory = createAp4mRuntimeFactory(),
): ExportedHandler<Env> {
	return {
		scheduled(controller, env, executionContext): Promise<void> {
			if (
				env.HARBOR_LOCAL_READ_ONLY === "true" ||
				localTradingSafetyMarkersPresent(env)
			) {
				return Promise.resolve();
			}
			return runScheduled(controller, env, executionContext);
		},
		async fetch(request, env, executionContext): Promise<Response> {
			try {
				validateKmsConfig(env);
			} catch (error) {
				return kmsConfigurationFailure(error);
			}
			const url = new URL(request.url);
			const localDevRequest = deriveLocalDevRequest(request, env);
			const requestRegistry =
				registry ?? selectRuntimeRegistry(env, localDevRequest);
			if (url.pathname === "/health") {
				return Response.json({
					ok: true,
					service: "harbor",
					health: "process",
					handoff_readiness: "not_evaluated",
				});
			}
			if (url.pathname === "/local/x402/probe") {
				if (
					!localDevRequest ||
					env.HARBOR_LOCAL_X402 !== "true" ||
					localTradingSafetyMarkersPresent(env)
				) {
					return new Response("Not Found", { status: 404 });
				}
				if (request.method !== "GET") {
					return new Response("Method Not Allowed", {
						status: 405,
						headers: { allow: "GET" },
					});
				}
				return Response.json(await localX402Probe(localDevRequest), {
					headers: { "cache-control": "no-store" },
				});
			}
			if (
				url.pathname ===
				"/.well-known/http-message-signatures-directory"
			) {
				return handleWbaDirectory(request, env.HARBOR_WBA_DIRECTORY_JSON);
			}
			if (url.pathname === "/hooks/quicknode/wallet") {
				return handleQuickNodeWalletWebhook(request, {
					db: env.DB,
					env,
					waitUntil: (promise) => executionContext.waitUntil(promise),
				});
			}
			if (url.pathname === "/hooks/quicknode/watchdog") {
				return handleQuickNodeWatchdog(request, {
					db: env.DB,
					env,
					waitUntil: (promise) => executionContext.waitUntil(promise),
					registry: createQuickNodeKvRegistryForRequest({ env, request }),
					payer: createWatchdogPayerAuthority(env.DB, env.EXEC_NETWORK),
				});
			}

			const auth = authenticateWithLocalCapability(
				request,
				env,
				localDevRequest,
			);
			if (!auth.ok) return auth.response;

			const demoQuotaResponse = await handleDemoModelQuotaRoute(request, {
				principal: auth.principal,
				localDevRequest,
				database: env.DB,
				environment: env,
			});
			if (demoQuotaResponse) return demoQuotaResponse;

			const ownerReviewResponse = await handleOwnerReviewX402Route(request, {
				principal: auth.principal,
				localDevRequest,
				db: env.DB,
				env,
			});
			if (ownerReviewResponse) return ownerReviewResponse;

			const workAgreementResponse = await handleWorkAgreementRoute(request, {
				principal: auth.principal,
				localDevRequest,
				db: env.DB,
				env,
			});
			if (workAgreementResponse) return workAgreementResponse;

			let ap4mServices: Ap4mPurchaseServices | undefined;
			try {
				ap4mServices = ap4mRuntime(env);
			} catch {
				if (url.pathname.startsWith("/api/ops/ap4m.")) {
					return ap4mConfigurationFailure();
				}
			}
			const issuedFixtureService = await createLocalIssuedX402FixtureService(env);
			const ctx = {
				principal: auth.principal,
				localDevRequest,
				db: env.DB,
				env,
				request,
				x402Service: localX402Service(env),
				...(issuedFixtureService === undefined
					? {}
					: { x402IssuedFixtureService: issuedFixtureService }),
				...(ap4mServices === undefined ? {} : { ap4mServices }),
			};
			if (url.pathname.startsWith("/api/ops/")) {
				const opName = url.pathname.slice("/api/ops/".length);
				return handleRestOperation(request, opName, ctx, requestRegistry);
			}

			if (url.pathname === "/mcp") {
				const provider = createHarborProvider(requestRegistry, ctx);
				const exports = (executionContext.exports ?? {}) as unknown as {
					HarborRpc?: (options: { props: HarborRpcProps }) => {
						invoke(operationName: string, args?: unknown): Promise<unknown>;
					};
				};
				const rpc =
					env.LOADER && env.EXECUTOR !== "quickjs" && exports.HarborRpc
						? exports.HarborRpc({
								props: { principal: auth.principal, localDevRequest },
							})
						: { invoke: provider.invoke };
				const server = createMcpServer({
					ctx,
					registry: requestRegistry,
					runtime: env.EXECUTOR ?? "auto",
					loader: env.LOADER,
					rpc,
				});
				const transport = new WebStandardStreamableHTTPServerTransport({
					enableJsonResponse: true,
				});
				await server.connect(transport);
				return transport.handleRequest(request);
			}

			return new Response("Not Found", { status: 404 });
		},
	};
}

export default createWorker();
