import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { WorkerEntrypoint } from "cloudflare:workers";

import catalogManifest from "../catalog/manifest.json";
import generatedOps from "./ops/index.gen";
import { OpRegistry, type CatalogManifestInput } from "./catalog/registry";
import { createHarborProvider } from "./executor/providers";
import { createMcpServer } from "./mcp/tools";
import { handleRestOperation } from "./rest";

export interface Env {
	DB: D1Database;
	LOADER?: WorkerLoader;
	HARBOR_API_KEYS?: string;
	EXECUTOR?: "dynamic" | "quickjs";
	EXEC_NETWORK?: string;
	MAINNET_EXECUTION?: string;
	HARBOR_LOCAL_DEV?: string;
}

export type AuthResult =
	| { ok: true; principal: string }
	| { ok: false; response: Response };

const appRegistry = new OpRegistry(generatedOps).loadCatalogManifest(
	catalogManifest as CatalogManifestInput,
);

type HarborRpcProps = { principal: string };

// Dynamic Workers can receive only real Workers RPC bindings. A loopback
// entrypoint gives the sandbox the single principal-scoped capability it needs
// without exposing DB, secrets, or arbitrary fetch.
// https://developers.cloudflare.com/workers/runtime-apis/context/#exports
export class HarborRpc extends WorkerEntrypoint<Env, HarborRpcProps> {
	async invoke(operationName: string, args: unknown = {}): Promise<unknown> {
		const provider = createHarborProvider(appRegistry, {
			principal: this.ctx.props.principal,
			db: this.env.DB,
			env: this.env,
		});
		return provider.invoke(operationName, args);
	}
}

function isLoopback(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
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

export function authenticate(request: Request, env: Env): AuthResult {
	const url = new URL(request.url);
	if (env.HARBOR_LOCAL_DEV === "true" && isLoopback(url.hostname)) {
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

export function createWorker(registry = appRegistry): ExportedHandler<Env> {
	return {
		async fetch(request, env, executionContext): Promise<Response> {
			const url = new URL(request.url);
			if (url.pathname === "/health") {
				return Response.json({ ok: true, service: "harbor" });
			}

			const auth = authenticate(request, env);
			if (!auth.ok) return auth.response;

			const ctx = { principal: auth.principal, db: env.DB, env, request };
			if (url.pathname.startsWith("/api/ops/")) {
				const opName = url.pathname.slice("/api/ops/".length);
				return handleRestOperation(request, opName, ctx, registry);
			}

			if (url.pathname === "/mcp") {
				const provider = createHarborProvider(registry, ctx);
				const exports = (executionContext.exports ?? {}) as unknown as {
					HarborRpc?: (options: { props: HarborRpcProps }) => {
						invoke(operationName: string, args?: unknown): Promise<unknown>;
					};
				};
				const rpc =
					env.LOADER && env.EXECUTOR !== "quickjs" && exports.HarborRpc
						? exports.HarborRpc({ props: { principal: auth.principal } })
						: { invoke: provider.invoke };
				const server = createMcpServer({
					ctx,
					registry,
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
