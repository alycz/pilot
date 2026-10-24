import { z } from "zod";

import {
  createD1MastercardCache,
  createMastercardMcpAdapter,
  MASTERCARD_PAGE_PATH_MAX_LENGTH,
  MASTERCARD_QUERY_MAX_LENGTH,
  MASTERCARD_SERVICE_ID_MAX_LENGTH,
  mastercardMcp,
  type MastercardMcpAdapter,
} from "../adapters/mastercard-mcp";
import type { OpContext, OpDef } from "../catalog/registry";

const dbAdapters = new WeakMap<object, MastercardMcpAdapter>();
const serviceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(MASTERCARD_SERVICE_ID_MAX_LENGTH)
  .regex(/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i);
const pagePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(MASTERCARD_PAGE_PATH_MAX_LENGTH)
  .startsWith("/")
  .regex(/^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@/-]|%[0-9A-Fa-f]{2})+$/)
  .refine((path) => {
    try {
      const decoded = decodeURIComponent(path);
      return (
        !decoded.includes("\\") &&
        !decoded.split("/").some((part) => part === "." || part === "..")
      );
    } catch {
      return false;
    }
  }, "path must not contain traversal segments");

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function resolveAdapter(ctx: OpContext): MastercardMcpAdapter {
  const injected = ctx.mastercardMcp;
  const injectedRecord = object(injected);
  if (
    injectedRecord &&
    typeof injectedRecord.services === "function" &&
    typeof injectedRecord.docs === "function" &&
    typeof injectedRecord.page === "function" &&
    typeof injectedRecord.search === "function"
  ) {
    return injected as MastercardMcpAdapter;
  }

  const env = object(ctx.env);
  const db = (ctx.db ?? env?.DB) as D1Database | undefined;
  if (!db || (typeof db !== "object" && typeof db !== "function")) {
    return mastercardMcp;
  }
  const identity = db as unknown as object;
  const existing = dbAdapters.get(identity);
  if (existing) return existing;
  const adapter = createMastercardMcpAdapter({
    cache: createD1MastercardCache(db),
  });
  dbAdapters.set(identity, adapter);
  return adapter;
}

export const ops: OpDef[] = [
  {
    name: "mastercard.services",
    family: "mastercard",
    summary: "List public services in Mastercard Developers.",
    tags: ["mastercard", "docs", "reference"],
    args: z.object({}).strict(),
    returns: "MastercardServicesResult",
    caveats: [],
    example: "await harbor.mastercard.services()",
    handler: (ctx) => resolveAdapter(ctx).services(),
  },
  {
    name: "mastercard.docs",
    family: "mastercard",
    summary: "List public documentation pages for a Mastercard service.",
    tags: ["mastercard", "docs", "reference"],
    args: z
      .object({
        service_id: serviceIdSchema,
      })
      .strict(),
    returns: "MastercardDocsResult",
    caveats: [],
    example:
      'await harbor.mastercard.docs({ service_id: "open-finance-us" })',
    handler: (ctx, args) =>
      resolveAdapter(ctx).docs(args as { service_id: string }),
  },
  {
    name: "mastercard.page",
    family: "mastercard",
    summary: "Read one public Mastercard Developers documentation page.",
    tags: ["mastercard", "docs", "reference"],
    args: z
      .object({
        path: pagePathSchema,
      })
      .strict(),
    returns: "MastercardPageResult",
    caveats: [],
    example:
      'await harbor.mastercard.page({ path: "/open-finance-us/documentation/index.md" })',
    handler: (ctx, args) => resolveAdapter(ctx).page(args as { path: string }),
  },
  {
    name: "mastercard.search",
    family: "mastercard",
    summary: "Search public Mastercard services and documentation titles.",
    tags: ["mastercard", "docs", "search", "reference"],
    args: z
      .object({
        query: z.string().trim().min(1).max(MASTERCARD_QUERY_MAX_LENGTH),
      })
      .strict(),
    returns: "MastercardSearchResult",
    caveats: [],
    example: 'await harbor.mastercard.search({ query: "open finance" })',
    handler: (ctx, args) =>
      resolveAdapter(ctx).search(args as { query: string }),
  },
];
