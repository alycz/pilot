import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { isValidClassicAddress } from "xrpl";
import { z } from "zod";

import {
  isEntrypoint,
  parseProbeArgs,
  probeMode,
  recordProbeResult,
  type ProbeIo,
} from "./q1-coverage.ts";

const HashSchema = z
  .string()
  .regex(/^[A-Fa-f0-9]{64}$/)
  .transform((value) => value.toUpperCase());
const AccountSchema = z.string().refine(isValidClassicAddress);
const TxTypeSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/);
const ResultSchema = z
  .string()
  .regex(/^(?:tes|tec|tef|tel|tem|ter)[A-Za-z0-9_]{0,61}$/);
const EvidenceIdentifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
// Keep the event-day probe runnable through Node's built-in TypeScript
// transform. Importing the Worker module would transitively load its
// extensionless production imports, which Node does not resolve. This strict
// projection intentionally mirrors Harbor's public webhook-evidence envelope
// without loading any Worker runtime code or provider payload fields.
const QuickNodeWebhookEvidenceSchema = z
  .object({
    hash: HashSchema,
    account: AccountSchema,
    delegate: AccountSchema.optional(),
    tx_type: TxTypeSchema,
    result: ResultSchema,
    ledger_index: z.number().int().nonnegative(),
    received_at: z.string().datetime(),
    execution: z
      .object({
        id: EvidenceIdentifierSchema,
        confirmed_by: z.literal("quicknode-webhook"),
        confirmed_at: z.string().datetime(),
        latency_ms: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
const CanonicalTransactionSchema = z
  .object({
    hash: HashSchema,
    Account: AccountSchema,
    Delegate: AccountSchema.optional(),
    TransactionType: TxTypeSchema,
    ledger_index: z.number().int().nonnegative(),
    metaData: z.object({ TransactionResult: ResultSchema }).strict(),
  })
  .strict();
const SanitizedPayloadSchema = z
  .object({
    data: z.array(CanonicalTransactionSchema).min(1).max(256),
    metadata: z.object({ network: z.literal("xrp-testnet") }).strict(),
  })
  .strict();
const ExecutionSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        status: z.literal("executed"),
        hash: HashSchema,
        confirmation: z
          .object({
            provider: z.enum(["quicknode-webhook", "quicknode-mock"]),
            at: z.string().datetime(),
            latency_ms: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .passthrough(),
  })
  .passthrough();
const RawDeliveryEnvelopeSchema = z
  .object({
    data: z.array(z.unknown()).min(1).max(256),
    metadata: z
      .object({ network: z.literal("xrp-testnet") })
      .passthrough(),
  })
  .strict();
const WebhookEvidenceEnvelopeSchema = z
  .object({ ok: z.literal(true), data: QuickNodeWebhookEvidenceSchema })
  .passthrough();

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Project an untrusted delivery to the same fixed fields Harbor persists. */
export function sanitizeWalletPayload(value: unknown): z.infer<typeof SanitizedPayloadSchema> {
  const envelope = RawDeliveryEnvelopeSchema.parse(value);
  const transactions = new Map<string, z.infer<typeof CanonicalTransactionSchema>>();
  const seen = new Set<object>();
  let visited = 0;

  const add = (candidate: unknown, wrapper?: Record<string, unknown>): void => {
    if (transactions.size >= 256) return;
    const tx = record(candidate);
    if (!tx) return;
    const meta = record(tx.metaData) ?? record(tx.meta) ?? record(wrapper?.metaData) ?? record(wrapper?.meta);
    const parsed = CanonicalTransactionSchema.safeParse({
      hash: tx.hash,
      Account: tx.Account,
      ...(typeof tx.Delegate === "string" ? { Delegate: tx.Delegate } : {}),
      TransactionType: tx.TransactionType,
      ledger_index:
        tx.ledger_index ?? tx.ledgerIndex ?? wrapper?.ledger_index ?? wrapper?.ledgerIndex,
      metaData: { TransactionResult: meta?.TransactionResult },
    });
    if (parsed.success && !transactions.has(parsed.data.hash)) {
      transactions.set(parsed.data.hash, parsed.data);
    }
  };

  const visit = (candidate: unknown, depth: number): void => {
    if (
      depth > 16 ||
      visited >= 10_000 ||
      transactions.size >= 256 ||
      !candidate ||
      typeof candidate !== "object"
    ) return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    visited += 1;
    if (Array.isArray(candidate)) {
      for (const child of candidate) visit(child, depth + 1);
      return;
    }
    const object = candidate as Record<string, unknown>;
    add(object.transaction, object);
    add(object, object);
    for (const child of Object.values(object)) visit(child, depth + 1);
  };

  visit(envelope.data, 0);
  return SanitizedPayloadSchema.parse({
    data: [...transactions.values()],
    metadata: { network: "xrp-testnet" },
  });
}

function shapeSignature(payload: z.infer<typeof SanitizedPayloadSchema>): string {
  return payload.data
    .map((transaction) =>
      [
        "Account",
        ...(transaction.Delegate ? ["Delegate"] : []),
        "TransactionType",
        "hash",
        "ledger_index",
        "metaData.TransactionResult",
      ].join(","),
    )
    .sort()
    .join(";");
}

export type Q3Dependencies = ProbeIo &
  Readonly<{
    readFile?: typeof readFile;
    writeFile?: typeof writeFile;
    mkdir?: typeof mkdir;
    fetcher?: typeof fetch;
    env?: NodeJS.ProcessEnv;
  }>;

function harborBase(value: string | undefined): string {
  if (!value || value.length > 2_048) throw new Error("HARBOR_PUBLIC_URL_MISSING");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("HARBOR_PUBLIC_URL_INVALID"); }
  if (
    url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    (url.protocol === "http:" && !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname))
  ) throw new Error("HARBOR_PUBLIC_URL_INVALID");
  return url.toString().replace(/\/$/, "");
}

function authorization(value: string | undefined): string {
  if (!value || value.length > 8_192 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("HARBOR_API_KEY_MISSING");
  }
  return value;
}

function payloadFromEvidence(
  evidence: z.infer<typeof QuickNodeWebhookEvidenceSchema>,
): z.infer<typeof SanitizedPayloadSchema> {
  return SanitizedPayloadSchema.parse({
    data: [{
      hash: evidence.hash,
      Account: evidence.account,
      ...(evidence.delegate ? { Delegate: evidence.delegate } : {}),
      TransactionType: evidence.tx_type,
      ledger_index: evidence.ledger_index,
      metaData: { TransactionResult: evidence.result },
    }],
    metadata: { network: "xrp-testnet" },
  });
}

async function fetchWebhookEvidence(
  hash: string,
  args: ReadonlyMap<string, string>,
  dependencies: Q3Dependencies,
): Promise<z.infer<typeof WebhookEvidenceEnvelopeSchema>> {
  const env = dependencies.env ?? process.env;
  const base = harborBase(args.get("--harbor-url") ?? env.HARBOR_PUBLIC_URL);
  const bearer = authorization(env.HARBOR_API_KEY);
  let response: Response;
  try {
    response = await (dependencies.fetcher ?? fetch)(
      `${base}/api/ops/quicknode.webhookEvidence`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ hash }),
      },
    );
  } catch {
    throw new Error("QN_WEBHOOK_EVIDENCE_TRANSPORT_FAILED");
  }
  if (!response.ok) throw new Error(`QN_WEBHOOK_EVIDENCE_HTTP_${response.status}`);
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > 65_536) {
    throw new Error("QN_WEBHOOK_EVIDENCE_RESPONSE_TOO_LARGE");
  }
  try {
    return WebhookEvidenceEnvelopeSchema.parse(JSON.parse(body));
  } catch {
    throw new Error("QN_WEBHOOK_EVIDENCE_INVALID");
  }
}

export async function runQ3Webhook(
  argv = process.argv.slice(2),
  dependencies: Q3Dependencies = {},
): Promise<void> {
  const args = parseProbeArgs(argv);
  const mode = probeMode(args.get("--mode") ?? process.env.QN_MODE);
  const status = resolve(args.get("--status") ?? "status/H-qn.md");
  const payloadPath = args.get("--payload");
  const standinPath = args.get("--standin-payload");
  const executionPath = args.get("--execution");
  const requestedHash = args.get("--hash");
  const output = resolve(
    args.get("--output") ??
      "scripts/quicknode/fixtures/q3-wallet.sanitized.json",
  );
  const read = dependencies.readFile ?? readFile;

  try {
    if (!standinPath) throw new Error("q3 requires --standin-payload");
    let real: z.infer<typeof SanitizedPayloadSchema>;
    let execution: z.infer<typeof ExecutionSchema>;
    if (mode === "live") {
      const hash = HashSchema.parse(requestedHash);
      const evidence = await fetchWebhookEvidence(hash, args, dependencies);
      if (evidence.data.hash !== hash) {
        throw new Error("Webhook evidence hash does not match the requested hash");
      }
      real = payloadFromEvidence(evidence.data);
      execution = ExecutionSchema.parse({
        ok: true,
        data: {
          status: "executed",
          hash: evidence.data.hash,
          confirmation: {
            provider: evidence.data.execution.confirmed_by,
            at: evidence.data.execution.confirmed_at,
            latency_ms: evidence.data.execution.latency_ms,
          },
        },
      });
    } else {
      if (!payloadPath || !executionPath) {
        throw new Error("mock q3 requires --payload and --execution");
      }
      const rawPayload = await read(resolve(payloadPath), "utf8");
      if (Buffer.byteLength(rawPayload, "utf8") > 1_048_576) {
        throw new Error("Wallet delivery exceeds the one-megabyte probe limit");
      }
      real = sanitizeWalletPayload(JSON.parse(rawPayload));
      execution = ExecutionSchema.parse(
        JSON.parse(await read(resolve(executionPath), "utf8")),
      );
    }
    const standin = sanitizeWalletPayload(
      JSON.parse(await read(resolve(standinPath), "utf8")),
    );
    if (shapeSignature(real) !== shapeSignature(standin)) {
      throw new Error("Real and stand-in wallet payload shapes differ");
    }
    const expectedProvider = mode === "live"
      ? "quicknode-webhook"
      : "quicknode-mock";
    if (execution.data.confirmation.provider !== expectedProvider) {
      throw new Error(`Expected confirmation provider ${expectedProvider}`);
    }
    if (!real.data.some((transaction) => transaction.hash === execution.data.hash)) {
      throw new Error("Confirmed execution hash is absent from wallet payload");
    }

    await (dependencies.mkdir ?? mkdir)(dirname(output), { recursive: true });
    await (dependencies.writeFile ?? writeFile)(
      output,
      `${JSON.stringify(real, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await recordProbeResult(
      "q3-webhook",
      mode,
      true,
      mode === "live"
        ? `authenticated webhook evidence; provider=quicknode-webhook; hash=${execution.data.hash}; latency_ms=${execution.data.confirmation.latency_ms}; shape=match; sanitized_fixture=${output}`
        : `local stand-in webhook fixture; provider=quicknode-mock; shape=match; sanitized_fixture=${output}; mock-only`,
      status,
      dependencies,
    );
  } catch (error) {
    await recordProbeResult(
      "q3-webhook",
      mode,
      false,
      "wallet webhook proof failed; raw payload was not persisted",
      status,
      dependencies,
    );
    throw error;
  }
}

if (isEntrypoint(import.meta.url)) {
  runQ3Webhook().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "q3 webhook probe failed"}\n`,
    );
    process.exitCode = 1;
  });
}
