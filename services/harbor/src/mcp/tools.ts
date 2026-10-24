import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { OpContext } from "../catalog/registry";
import { OpRegistry } from "../catalog/registry";
import { execute } from "../executor/run";

export const SERVER_INSTRUCTIONS = [
	"Use search to discover Harbor operations and their exact arguments.",
	"Use execute to call one or more operations through the harbor namespace.",
	"For transaction flows, build and simulate first, then call tx.execute.",
	"If tx.execute returns needs_approval, return the approval to the user and stop.",
	"If policy blocks an action, do not retry it.",
].join(" ");

export const SEARCH_ONLY_SERVER_INSTRUCTIONS = [
	"Use search to discover Harbor operations and their exact arguments.",
	"Code execution is disabled until the deployment profile passes its runtime acceptance gate.",
].join(" ");

export type ToolRuntimeOptions = {
	ctx: OpContext;
	registry: OpRegistry;
	runtime?: "auto" | "dynamic" | "quickjs";
	loader?: WorkerLoader;
	rpc?: { invoke(op: string, args: unknown): Promise<unknown> };
};

function mcpExecutionEnabled(ctx: OpContext): boolean {
	const env = ctx.env;
	if (!env || typeof env !== "object") return true;
	const configured = (env as Record<string, unknown>)
		.HARBOR_MCP_EXECUTION_ENABLED;
	if (configured === undefined) return true;
	return typeof configured === "string" && configured.trim() === "true";
}

export function createMcpServer(options: ToolRuntimeOptions): McpServer {
	const executionEnabled = mcpExecutionEnabled(options.ctx);
	const instructions = executionEnabled
		? SERVER_INSTRUCTIONS
		: SEARCH_ONLY_SERVER_INSTRUCTIONS;
	const server = new McpServer(
		{ name: "harbor", version: "0.1.0" },
		{ instructions },
	);

	server.registerTool(
		"search",
		{
			description: "Search Harbor operations, venues, and playbooks.",
			inputSchema: z.object({ query: z.string().min(1) }).strict(),
		},
		async ({ query }) => ({
			content: [
				{ type: "text", text: JSON.stringify(options.registry.search(query)) },
			],
		}),
	);

	if (executionEnabled) {
		server.registerTool(
			"execute",
			{
				description:
					"Execute a sandboxed script against Harbor's typed operation namespaces.",
				inputSchema: z.object({ code: z.string().min(1) }).strict(),
			},
			async ({ code }) => {
				try {
					const output = await execute(code, {
						ctx: options.ctx,
						registry: options.registry,
						runtime: options.runtime,
						loader: options.loader,
						rpc: options.rpc,
					});
					return { content: [{ type: "text" as const, text: output }] };
				} catch (error) {
					const message =
						error instanceof Error ? error.message : "Execution failed";
					return {
						isError: true,
						content: [{ type: "text" as const, text: message }],
					};
				}
			},
		);
	}

	return server;
}
