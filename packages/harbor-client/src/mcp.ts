import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { tool } from "ai";
import type { Tool, ToolExecuteFunction } from "ai";
import { z } from "zod";

import mcpFixtures from "../fixtures/mcp.json" with { type: "json" };
import {
  createHarborRestClient,
  type HarborRestClient,
} from "./rest.js";

const MAX_MOCK_CODE_LENGTH = 24 * 1024;
const MAX_LITERAL_DEPTH = 64;
const FORBIDDEN_CODE = /seed|secret|private|mnemonic/i;
const MOCK_CALL_PATTERN =
  /^\s*return\s+await\s+harbor\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(\s*(\{[\s\S]*\})\s*\)\s*;?\s*$/;

const SearchInputSchema = z
  .object({
    query: z.string().describe("Harbor operation, family, or capability to find."),
  })
  .strict();

const ExecuteInputSchema = z
  .object({
    code: z
      .string()
      .describe("A short code-mode script that calls the typed harbor API."),
  })
  .strict();

export type HarborSearchInput = z.infer<typeof SearchInputSchema>;
export type HarborExecuteInput = z.infer<typeof ExecuteInputSchema>;

export type HarborAiTool<Input, Output = unknown> = Tool<Input, Output> & {
  execute: ToolExecuteFunction<Input, Output>;
};

export interface HarborMcpTools {
  harbor_search: HarborAiTool<HarborSearchInput>;
  harbor_execute: HarborAiTool<HarborExecuteInput>;
}

export interface HarborMcpClientConfig {
  mcpUrl?: string;
  baseUrl?: string;
  apiKey?: string;
  mock?: boolean;
  restClient?: HarborRestClient;
}

type McpCallResult = Awaited<ReturnType<Client["callTool"]>>;

type CatalogEntry = {
  name: string;
  family: string;
  summary: string;
  signature: string;
  example: string;
};

type SearchEnvelope =
  | {
      ok: true;
      data: CatalogEntry[];
      asOf: string;
      asOfBasis: string;
      caveat?: string[];
    }
  | {
      ok: false;
      error: unknown;
    };

function environment(name: string): string | undefined {
  return typeof window !== "undefined" || typeof process === "undefined"
    ? undefined
    : process.env[name];
}

function resolveMock(config: HarborMcpClientConfig): boolean {
  if (config.mock !== undefined) return config.mock;

  const configuredMode = environment("HARBOR_MOCK");
  if (configuredMode === "1") return true;
  if (configuredMode === "0") return false;

  return (
    config.mcpUrl === undefined &&
    config.baseUrl === undefined &&
    environment("HARBOR_URL") === undefined
  );
}

function resolveMcpUrl(config: HarborMcpClientConfig): string | undefined {
  if (config.mcpUrl) return config.mcpUrl;

  const baseUrl = config.baseUrl ?? environment("HARBOR_URL");
  return baseUrl ? `${baseUrl.replace(/\/+$/, "")}/mcp` : undefined;
}

function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Parses only data literals used by Harbor code-mode examples. This is not a
 * JavaScript parser: expressions, calls, property access, template strings,
 * computed keys, spreads, and identifier values are deliberately rejected.
 */
class DataLiteralParser {
  private position = 0;

  constructor(private readonly source: string) {}

  parseObject(): Record<string, unknown> {
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.position !== this.source.length) this.fail();
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      this.fail();
    }
    return value as Record<string, unknown>;
  }

  private parseValue(depth: number): unknown {
    if (depth > MAX_LITERAL_DEPTH) this.fail("nesting limit exceeded");
    this.skipWhitespace();

    const next = this.source[this.position];
    if (next === "{") return this.parseObjectLiteral(depth);
    if (next === "[") return this.parseArrayLiteral(depth);
    if (next === '"' || next === "'") return this.parseString();
    if (next === "-" || this.isDigit(next)) return this.parseNumber();
    if (this.consumeKeyword("true")) return true;
    if (this.consumeKeyword("false")) return false;
    if (this.consumeKeyword("null")) return null;
    this.fail();
  }

  private parseObjectLiteral(depth: number): Record<string, unknown> {
    this.expect("{");
    const result = Object.create(null) as Record<string, unknown>;
    this.skipWhitespace();
    if (this.consume("}")) return result;

    while (true) {
      const key = this.parseKey();
      this.skipWhitespace();
      this.expect(":");
      result[key] = this.parseValue(depth + 1);
      this.skipWhitespace();
      if (this.consume("}")) return result;
      this.expect(",");
      this.skipWhitespace();
      if (this.consume("}")) return result;
    }
  }

  private parseArrayLiteral(depth: number): unknown[] {
    this.expect("[");
    const result: unknown[] = [];
    this.skipWhitespace();
    if (this.consume("]")) return result;

    while (true) {
      result.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      if (this.consume("]")) return result;
      this.expect(",");
      this.skipWhitespace();
      if (this.consume("]")) return result;
    }
  }

  private parseKey(): string {
    this.skipWhitespace();
    const next = this.source[this.position];
    if (next === '"' || next === "'") return this.parseString();

    if (!this.isIdentifierStart(next)) this.fail();
    const start = this.position++;
    while (this.isIdentifierPart(this.source[this.position])) this.position++;
    return this.source.slice(start, this.position);
  }

  private parseString(): string {
    const quote = this.source[this.position++];
    let value = "";

    while (this.position < this.source.length) {
      const character = this.source[this.position++];
      if (character === quote) return value;
      if (character === "\\") {
        value += this.parseEscape();
        continue;
      }
      if (character.charCodeAt(0) < 0x20) this.fail();
      value += character;
    }

    this.fail("unterminated string");
  }

  private parseEscape(): string {
    const escape = this.source[this.position++];
    const simpleEscapes: Record<string, string> = {
      '"': '"',
      "'": "'",
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      0: "\0",
    };
    if (escape in simpleEscapes) return simpleEscapes[escape]!;
    if (escape === "u") return this.parseHexEscape(4);
    if (escape === "x") return this.parseHexEscape(2);
    this.fail("unsupported string escape");
  }

  private parseHexEscape(length: number): string {
    const encoded = this.source.slice(this.position, this.position + length);
    if (encoded.length !== length || !/^[0-9A-Fa-f]+$/.test(encoded)) {
      this.fail("invalid hexadecimal escape");
    }
    this.position += length;
    return String.fromCharCode(Number.parseInt(encoded, 16));
  }

  private parseNumber(): number {
    const remaining = this.source.slice(this.position);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(remaining);
    if (!match) this.fail("invalid number");
    this.position += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail("number must be finite");
    return value;
  }

  private consumeKeyword(keyword: string): boolean {
    if (!this.source.startsWith(keyword, this.position)) return false;
    const following = this.source[this.position + keyword.length];
    if (this.isIdentifierPart(following)) return false;
    this.position += keyword.length;
    return true;
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.source[this.position] ?? "")) this.position++;
  }

  private expect(character: string): void {
    if (!this.consume(character)) this.fail();
  }

  private consume(character: string): boolean {
    if (this.source[this.position] !== character) return false;
    this.position++;
    return true;
  }

  private isDigit(character: string | undefined): boolean {
    return character !== undefined && character >= "0" && character <= "9";
  }

  private isIdentifierStart(character: string | undefined): boolean {
    return (
      character !== undefined &&
      ((character >= "A" && character <= "Z") ||
        (character >= "a" && character <= "z") ||
        character === "_" ||
        character === "$")
    );
  }

  private isIdentifierPart(character: string | undefined): boolean {
    return this.isIdentifierStart(character) || this.isDigit(character);
  }

  private fail(detail?: string): never {
    const suffix = detail ? `: ${detail}` : "";
    throw new Error(
      `Invalid mock Harbor argument literal at offset ${this.position}${suffix}.`,
    );
  }
}

function parseCallArguments(rawArgs: string): Record<string, unknown> {
  const json = parseJson(rawArgs);
  if (json !== undefined) {
    if (json === null || typeof json !== "object" || Array.isArray(json)) {
      throw new Error("Mock Harbor call arguments must be an object literal.");
    }
    return json as Record<string, unknown>;
  }

  return new DataLiteralParser(rawArgs).parseObject();
}

function normalizeMcpResult(result: McpCallResult): unknown {
  if ("toolResult" in result) return result.toolResult;

  const textParts = result.content
    .filter(
      (part): part is Extract<(typeof result.content)[number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text);

  if (result.isError) {
    throw new Error(textParts.join("\n") || "Harbor MCP tool call failed.");
  }

  if (result.structuredContent !== undefined) {
    const structured = result.structuredContent;
    return "result" in structured ? structured.result : structured;
  }

  for (const text of textParts) {
    const parsed = parseJson(text);
    if (parsed !== undefined) return parsed;
  }

  const combinedText = textParts.join("\n");
  const combinedJson = parseJson(combinedText);
  if (combinedJson !== undefined) return combinedJson;

  throw new Error("Harbor MCP tool returned no JSON result.");
}

function searchMockCatalog(query: string): SearchEnvelope {
  const fixture = mcpFixtures.harbor_search as SearchEnvelope;
  if (!fixture.ok) return fixture;

  const normalizedQuery = query.trim().toLowerCase();
  const ranked = fixture.data
    .map((entry, position) => {
      const name = entry.name.toLowerCase();
      const family = entry.family.toLowerCase();
      const searchable = [
        name,
        family,
        entry.summary,
        entry.signature,
        entry.example,
      ]
        .join(" ")
        .toLowerCase();
      const score =
        normalizedQuery.length === 0
          ? 0
          : name === normalizedQuery
            ? 4
            : family === normalizedQuery
              ? 3
              : name.startsWith(normalizedQuery)
                ? 2
                : searchable.includes(normalizedQuery)
                  ? 1
                  : -1;
      return { entry, position, score };
    })
    .filter(({ score }) => score >= 0)
    .sort((left, right) => right.score - left.score || left.position - right.position)
    .slice(0, 8)
    .map(({ entry }) => entry);

  return { ...fixture, data: ranked };
}

function parseMockCall(code: string): {
  op: string;
  args: Record<string, unknown>;
} {
  if (code.length > MAX_MOCK_CODE_LENGTH) {
    throw new Error(
      `Mock Harbor code is limited to ${MAX_MOCK_CODE_LENGTH} characters.`,
    );
  }

  if (FORBIDDEN_CODE.test(code)) {
    throw new Error(
      "Mock Harbor code contains a forbidden credential-related term.",
    );
  }

  const match = MOCK_CALL_PATTERN.exec(code);
  if (!match) {
    throw new Error(
      "Mock Harbor only accepts one `return await harbor.<op>({...})` data-literal call.",
    );
  }

  const [, op, rawArgs] = match;
  const args = parseCallArguments(rawArgs);

  return { op, args };
}

export class HarborMcpClient {
  readonly tools: HarborMcpTools;
  readonly harbor_search: HarborMcpTools["harbor_search"];
  readonly harbor_execute: HarborMcpTools["harbor_execute"];

  private readonly config: HarborMcpClientConfig;
  private readonly mock: boolean;
  private readonly restClient?: HarborRestClient;
  private client?: Client;
  private connecting?: Promise<Client>;

  constructor(config: HarborMcpClientConfig = {}) {
    this.config = config;
    this.mock = resolveMock(config);
    this.restClient = config.restClient;
    if (this.mock && !this.restClient) {
      this.restClient = createHarborRestClient({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        mock: true,
      });
    }

    this.harbor_search = tool({
      description:
        "Search Harbor's operation catalog before selecting an operation or writing code-mode calls.",
      inputSchema: SearchInputSchema,
      execute: ({ query }, options) =>
        this.search(query, { signal: options.abortSignal }),
    }) as HarborMcpTools["harbor_search"];

    this.harbor_execute = tool({
      description:
        "Execute a short script against Harbor's typed, policy-aware XRPL operation API.",
      inputSchema: ExecuteInputSchema,
      execute: ({ code }, options) =>
        this.execute(code, { signal: options.abortSignal }),
    }) as HarborMcpTools["harbor_execute"];

    this.tools = {
      harbor_search: this.harbor_search,
      harbor_execute: this.harbor_execute,
    };
  }

  async search(
    query: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<unknown> {
    if (this.mock) return searchMockCatalog(query);
    return this.callLiveTool("search", { query }, options.signal);
  }

  async execute(
    code: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<unknown> {
    if (!this.mock) {
      return this.callLiveTool("execute", { code }, options.signal);
    }

    const { op, args } = parseMockCall(code);
    const restClient = this.restClient;
    if (!restClient) {
      throw new Error("Mock Harbor REST client is not configured.");
    }

    const callOp = restClient.op as unknown as (
      name: string,
      input: Record<string, unknown>,
    ) => Promise<unknown>;
    return callOp.call(restClient, op, args);
  }

  async close(): Promise<void> {
    if (this.mock) return;

    if (this.connecting) {
      try {
        await this.connecting;
      } catch {
        // A failed lazy connection has no live session left to close.
      }
    }

    const client = this.client;
    this.client = undefined;
    this.connecting = undefined;
    if (client) await client.close();
  }

  private async callLiveTool(
    name: "search" | "execute",
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const client = await this.getConnectedClient();
    const result = await client.callTool(
      { name, arguments: args },
      undefined,
      signal ? { signal } : undefined,
    );
    return normalizeMcpResult(result);
  }

  private async getConnectedClient(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = this.connectLive();
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private async connectLive(): Promise<Client> {
    const mcpUrl = resolveMcpUrl(this.config);
    if (!mcpUrl) {
      throw new Error(
        "Harbor MCP URL is required in live mode (mcpUrl, baseUrl, or HARBOR_URL).",
      );
    }

    const apiKey = this.config.apiKey ?? environment("HARBOR_API_KEY");
    if (!apiKey) {
      throw new Error(
        "Harbor MCP live mode requires an apiKey or the server-side HARBOR_API_KEY environment variable.",
      );
    }
    const headers = new Headers();
    headers.set("Authorization", `Bearer ${apiKey}`);

    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers },
    });
    const client = new Client({ name: "pilot-harbor-client", version: "0.0.0" });

    try {
      await client.connect(transport);
      this.client = client;
      return client;
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  }
}

export function createHarborMcpClient(
  config: HarborMcpClientConfig = {},
): HarborMcpClient {
  return new HarborMcpClient(config);
}
