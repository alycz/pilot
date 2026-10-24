import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";
import { decode } from "xrpl";

import {
  isEntrypoint,
  parseProbeArgs,
  probeMode,
  recordProbeResult,
  type ProbeIo,
} from "./q1-coverage.ts";

const HashSchema = z.string().regex(/^[A-Fa-f0-9]{64}$/);
const PaymentRequestSchema = z
  .object({
    operation: z.literal("tx.submit"),
    network: z.literal("testnet"),
    transaction_type: z.literal("Payment"),
    args: z
      .object({
        tx_blob: z.string().regex(/^[A-Fa-f0-9]+$/).min(16).max(131_072),
        network: z.literal("testnet"),
      })
      .strict(),
  })
  .strict();

const SubmitEnvelopeSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        status: z.literal("executed"),
        hash: HashSchema,
      })
      .passthrough(),
    trust: z
      .object({
        rpc: z
          .object({
            route: z.enum(["quicknode", "quicknode-mock", "fallback"]),
            methods_quicknode: z.number().int().nonnegative(),
            methods_fallback: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .passthrough(),
  })
  .passthrough();

const FixtureSchema = z
  .object({ request: PaymentRequestSchema, response: SubmitEnvelopeSchema })
  .strict();

function harborBase(raw: string): URL {
  const url = new URL(raw);
  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]";
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
  ) {
    throw new Error("Harbor URL must be an HTTPS root or loopback HTTP root");
  }
  return url;
}

async function invokeSubmit(
  request: z.infer<typeof PaymentRequestSchema>,
  rawBase: string,
  fetcher: typeof fetch,
  bearer: string | undefined,
  decodeBlob: (txBlob: string) => Readonly<Record<string, unknown>>,
): Promise<unknown> {
  let transaction: Readonly<Record<string, unknown>>;
  try {
    transaction = decodeBlob(request.args.tx_blob);
  } catch {
    throw new Error("Signed transaction blob could not be decoded");
  }
  if (transaction.TransactionType !== request.transaction_type) {
    throw new Error("Signed transaction must be a Payment");
  }
  const endpoint = new URL("api/ops/tx.submit", harborBase(rawBase));
  const headers = new Headers({ "content-type": "application/json" });
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  const response = await fetcher(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(request.args),
  });
  if (!response.ok) throw new Error(`Harbor submit returned HTTP ${response.status}`);
  return response.json();
}

export type Q2Dependencies = ProbeIo &
  Readonly<{
    readFile?: typeof readFile;
    fetcher?: typeof fetch;
    decodeBlob?: (txBlob: string) => Readonly<Record<string, unknown>>;
  }>;

export async function runQ2Submit(
  argv = process.argv.slice(2),
  dependencies: Q2Dependencies = {},
): Promise<void> {
  const args = parseProbeArgs(argv);
  const mode = probeMode(args.get("--mode") ?? process.env.QN_MODE);
  const status = resolve(args.get("--status") ?? "status/H-qn.md");
  const read = dependencies.readFile ?? readFile;

  try {
    const fixturePath = args.get("--fixture");
    let proof: z.infer<typeof FixtureSchema>;
    if (fixturePath) {
      if (mode === "live") {
        throw new Error("Live q2 requires a direct Harbor submit, not --fixture");
      }
      proof = FixtureSchema.parse(
        JSON.parse(await read(resolve(fixturePath), "utf8")),
      );
    } else {
      const requestPath = args.get("--request");
      const base = args.get("--harbor-url") ?? process.env.HARBOR_PUBLIC_URL;
      if (!requestPath || !base) {
        throw new Error("q2 requires --fixture or --request with --harbor-url");
      }
      const request = PaymentRequestSchema.parse(
        JSON.parse(await read(resolve(requestPath), "utf8")),
      );
      proof = FixtureSchema.parse({
        request,
        response: await invokeSubmit(
          request,
          base,
          dependencies.fetcher ?? fetch,
          process.env.HARBOR_API_KEY,
          dependencies.decodeBlob ?? decode,
        ),
      });
    }

    const expectedRoute = mode === "mock" ? "quicknode-mock" : "quicknode";
    if (proof.response.trust.rpc.route !== expectedRoute) {
      throw new Error(`Expected XRPL route ${expectedRoute}`);
    }
    if (mode === "live" && proof.response.trust.rpc.methods_quicknode < 1) {
      throw new Error("Live q2 proof did not record a QuickNode RPC call");
    }
    await recordProbeResult(
      "q2-submit",
      mode,
      true,
      mode === "mock"
        ? `local stand-in fixture Payment proof; route=quicknode-mock; hash=${proof.response.data.hash.toUpperCase()}; mock-only`
        : `direct testnet Payment executed; route=quicknode; hash=${proof.response.data.hash.toUpperCase()}`,
      status,
      dependencies,
    );
  } catch (error) {
    await recordProbeResult(
      "q2-submit",
      mode,
      false,
      "testnet Payment proof failed; no live success recorded",
      status,
      dependencies,
    );
    throw error;
  }
}

if (isEntrypoint(import.meta.url)) {
  runQ2Submit().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "q2 submit probe failed"}\n`,
    );
    process.exitCode = 1;
  });
}
