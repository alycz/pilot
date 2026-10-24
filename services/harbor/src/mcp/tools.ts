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

export type ToolRuntimeOptions = {
	ctx: OpContext;
	registry: OpRegistry;
	runtime?: "auto" | "dynamic" | "quickjs";
	loader?: WorkerLoader;
	rpc?: { invoke(op: string, args: unknown): Promise<unknown> };
};

export function createMcpServer(options: ToolRuntimeOptions): McpServer {
	const server = new McpServer(
		{ name: "harbor", version: "0.1.0" },
		{ instructions: SERVER_INSTRUCTIONS },
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
				const message = error instanceof Error ? error.message : "Execution failed";
				return {
					isError: true,
					content: [{ type: "text" as const, text: message }],
				};
			}
		},
	);

	return server;
}
