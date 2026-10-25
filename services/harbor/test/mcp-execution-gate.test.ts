import { describe, expect, it } from "vitest";

import { OpRegistry } from "../src/catalog/registry";
import {
	createMcpServer,
	SEARCH_ONLY_SERVER_INSTRUCTIONS,
	SERVER_INSTRUCTIONS,
} from "../src/mcp/tools";

type InspectableMcpServer = {
	_registeredTools: Record<string, unknown>;
	server: { _instructions?: string };
};

function inspect(flag?: string): InspectableMcpServer {
	const env = flag === undefined ? {} : { HARBOR_MCP_EXECUTION_ENABLED: flag };
	return createMcpServer({
		ctx: { principal: "test", env },
		registry: new OpRegistry(),
	}) as unknown as InspectableMcpServer;
}

describe("MCP execution deployment gate", () => {
	it("preserves existing profiles when the flag is absent", () => {
		const server = inspect();
		expect(Object.keys(server._registeredTools)).toEqual(["search", "execute"]);
		expect(server.server._instructions).toBe(SERVER_INSTRUCTIONS);
	});

	it("removes code execution from the Free profile", () => {
		const server = inspect("false");
		expect(Object.keys(server._registeredTools)).toEqual(["search"]);
		expect(server.server._instructions).toBe(SEARCH_ONLY_SERVER_INSTRUCTIONS);
	});

	it("fails closed for malformed explicit values", () => {
		expect(Object.keys(inspect("False")._registeredTools)).toEqual(["search"]);
		expect(Object.keys(inspect("1")._registeredTools)).toEqual(["search"]);
		expect(Object.keys(inspect("true")._registeredTools)).toEqual(["search", "execute"]);
	});
});
