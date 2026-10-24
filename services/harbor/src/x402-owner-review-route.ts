import { Buffer } from "node:buffer";

import { decode, hashes } from "xrpl";
import { z } from "zod";

import { errorEnvelope, okEnvelope } from "./guard";
import { LOCAL_X402_COMPARE_PRICE_DROPS, LOCAL_X402_PROBE_URL } from "./local-x402";
import { LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO } from "./local-x402-isolated-v1";
import { D1OwnerReviewStore } from "./exec/x402-owner-review-d1";
import {
	OwnerReviewX402Error,
	createOwnerReviewedX402Engine,
	type OwnerReviewDecisionInput,
	type OwnerReviewRecord,
	type OwnerReviewSubmitInput,
} from "./exec/x402-owner-review";

export const OWNER_REVIEW_OPERATION_NAMES = Object.freeze([
	"x402.ownerReviewPrepare",
	"x402.ownerReviewReject",
	"x402.ownerReviewSubmit",
	"x402.ownerReviewRecover",
] as const);

type OwnerReviewOperationName = (typeof OWNER_REVIEW_OPERATION_NAMES)[number];
type OwnerReviewEngine = ReturnType<typeof createOwnerReviewedX402Engine>;

export type OwnerReviewRouteEnvironment = Readonly<{
	HARBOR_LOCAL_DEV?: string;
	HARBOR_MOCK?: string;
	HARBOR_LOCAL_X402_OWNER_REVIEW_ENABLED?: string;
	EXEC_NETWORK?: string;
	MAINNET_EXECUTION?: string;
	HARBOR_SOURCE_TAG?: string;
}>;

export type OwnerReviewRouteContext = Readonly<{
	principal: string;
	localDevRequest: boolean;
	db: D1Database;
	env: OwnerReviewRouteEnvironment;
	ownerReviewEngine?: OwnerReviewEngine;
}>;

const OWNER_REVIEW_BODY_MAX_BYTES = 256 * 1024;
const UINT32_MAX = 0xffff_ffff;
const IdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/);
const BaseSchema = z.object({
	owner: z.string().min(25).max(35),
	network: z.literal("testnet"),
	idempotency_key: IdSchema,
}).strict();
const PrepareSchema = BaseSchema.extend({
	max_price_drops: z.literal(LOCAL_X402_COMPARE_PRICE_DROPS),
}).strict();
const DecisionSchema = BaseSchema.extend({ approval_id: IdSchema }).strict();
const SubmitSchema = DecisionSchema.extend({
	approval_digest: z.string().regex(/^[A-F0-9]{64}$/),
	signed_blob: z.string().min(2).max(200_000).regex(/^[A-Fa-f0-9]+$/),
}).strict();

const runtimeByDatabase = new WeakMap<object, Promise<OwnerReviewEngine>>();

function sourceTag(value: string | undefined): number {
	if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
		throw new Error("Owner-review x402 source tag is unavailable");
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > UINT32_MAX) {
		throw new Error("Owner-review x402 source tag is unavailable");
	}
	return parsed;
}

function enabled(context: OwnerReviewRouteContext): boolean {
	return context.localDevRequest === true &&
		context.env.HARBOR_LOCAL_DEV === "true" &&
		context.env.HARBOR_MOCK === "1" &&
		context.env.HARBOR_LOCAL_X402_OWNER_REVIEW_ENABLED === "true" &&
		context.env.EXEC_NETWORK === "testnet" &&
		context.env.MAINNET_EXECUTION === "false";
}

function hasExplicitPrincipal(context: OwnerReviewRouteContext): boolean {
	return context.principal !== "local-dev" &&
		/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(context.principal);
}

function base64Json(value: unknown): string {
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

async function createLocalMockRuntime(context: OwnerReviewRouteContext): Promise<OwnerReviewEngine> {
	const store = new D1OwnerReviewStore(context.db);
	await store.initialize();
	const tag = sourceTag(context.env.HARBOR_SOURCE_TAG);
	return createOwnerReviewedX402Engine({
		enabled: true,
		store,
		expectedSourceTag: tag,
		receiptProvenance: "local-mock-simulated-settlement",
		merchant: {
			challenge: async () => ({
				status: 402,
				paymentRequired: base64Json({
					x402Version: 2,
					resource: { url: LOCAL_X402_PROBE_URL },
					accepts: [{
						scheme: "exact",
						network: "xrpl:1",
						asset: "XRP",
						payTo: LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO,
						amount: LOCAL_X402_COMPARE_PRICE_DROPS,
						maxTimeoutSeconds: 60,
						extra: { invoiceId: `owner-review-${crypto.randomUUID()}`, sourceTag: tag },
					}],
				}),
			}),
			dispatch: async (request) => {
				const envelope = JSON.parse(Buffer.from(request.paymentSignature, "base64").toString("utf8")) as {
					payload?: { signedTxBlob?: unknown };
				};
				const signedBlob = envelope.payload?.signedTxBlob;
				if (typeof signedBlob !== "string" || hashes.hashSignedTx(signedBlob).toUpperCase() !== request.txHash) {
					throw new Error("Mock owner-review relay binding is invalid");
				}
				await store.markMockRelayDispatched(request.txHash);
			},
			fetchAfterSettlement: async (request) => {
				const entry = await store.getMockDispatchedByHash(request.txHash);
				const envelope = JSON.parse(Buffer.from(request.paymentSignature, "base64").toString("utf8")) as {
					payload?: { signedTxBlob?: unknown };
				};
				const signedBlob = envelope.payload?.signedTxBlob;
				if (entry === null || typeof signedBlob !== "string" ||
					hashes.hashSignedTx(signedBlob).toUpperCase() !== request.txHash) {
					throw new Error("Mock owner-review resource binding is invalid");
				}
				return { comparison: ["dex", "amm"] };
			},
		},
		settlement: {
			lookup: async (hash) => {
				const entry = await store.getMockDispatchedByHash(hash);
				if (entry?.signedBlob === null || entry?.signedBlob === undefined) return { status: "pending" } as const;
				const transaction = decode(entry.signedBlob) as Record<string, unknown>;
				const lastLedger = Number(transaction.LastLedgerSequence);
				return {
					status: "validated" as const,
					proof: {
						validated: true as const,
						hash,
						ledgerIndex: lastLedger - 1,
						engineResult: "tesSUCCESS",
						transaction,
					},
				};
			},
		},
		ledger: {
			prepare: async () => ({ sequence: 1, feeDrops: "12", validatedLedgerIndex: 1_000 }),
			validatedLedgerIndex: async () => 1_000,
		},
		encodePaymentSignature: ({ challenge, signedBlob }) => base64Json({
			x402Version: 2,
			resource: challenge.resource,
			accepted: {
				scheme: challenge.scheme,
				network: challenge.network,
				asset: challenge.asset,
				payTo: challenge.payTo,
				amount: challenge.amountDrops,
				maxTimeoutSeconds: challenge.maxTimeoutSeconds,
				extra: {
					invoiceId: challenge.invoiceId,
					sourceTag: challenge.sourceTag,
					...(challenge.destinationTag === undefined ? {} : { destinationTag: challenge.destinationTag }),
				},
			},
			payload: { signedTxBlob: signedBlob },
		}),
	});
}

async function runtime(context: OwnerReviewRouteContext): Promise<OwnerReviewEngine> {
	if (context.ownerReviewEngine) return context.ownerReviewEngine;
	const key = context.db as unknown as object;
	let current = runtimeByDatabase.get(key);
	if (!current) {
		current = createLocalMockRuntime(context);
		runtimeByDatabase.set(key, current);
	}
	return current;
}

function publicRecord(record: OwnerReviewRecord): Record<string, unknown> {
	const transaction = record.transaction;
	const challenge = record.challenge;
	if (
		transaction !== null &&
		(record.preparedLedgerIndex === null ||
			transaction.Sequence === undefined ||
			challenge === null ||
			transaction.SourceTag !== challenge.sourceTag)
	) throw new Error("Owner-review preparation metadata is invalid");
	const receipt = record.receipt === null ? undefined : {
		status: record.receipt.status,
		simulation: true,
		approval_id: record.receipt.approvalId,
		idempotency_key: record.receipt.idempotencyKey,
		owner: record.receipt.owner,
		network: record.receipt.network,
		resource_url: record.receipt.resourceUrl,
		pay_to: record.receipt.payTo,
		asset: record.receipt.asset,
		amount_drops: record.receipt.amountDrops,
		tx_hash: record.receipt.txHash,
		validated_ledger_index: record.receipt.validatedLedgerIndex,
		body: record.receipt.body,
		provenance: record.receipt.provenance,
	};
	return {
		status: record.status,
		approval_id: record.approvalId,
		approval_digest: record.approvalDigest,
		idempotency_key: record.idempotencyKey,
		owner: record.owner,
		network: record.network,
		resource_url: record.resourceUrl,
		pay_to: record.payTo,
		asset: record.asset,
		amount_drops: record.amountDrops,
		quote_expires_at: record.quoteExpiresAt,
		validated_ledger_index: record.preparedLedgerIndex,
		validated_account_sequence: transaction?.Sequence ?? null,
		expected_source_tag: challenge?.sourceTag ?? null,
		...(record.status === "awaiting_approval" && transaction !== null ? { tx_json: transaction } : {}),
		...(record.txHash === null ? {} : { tx_hash: record.txHash }),
		...(record.reason === null ? {} : { reason: record.reason }),
		...(receipt === undefined ? {} : { receipt }),
	};
}

async function boundedBody(request: Request): Promise<unknown> {
	const declared = request.headers.get("content-length");
	if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > OWNER_REVIEW_BODY_MAX_BYTES)) {
		throw new Error("Owner-review request body is too large");
	}
	const bytes = new Uint8Array(await request.arrayBuffer());
	if (bytes.byteLength > OWNER_REVIEW_BODY_MAX_BYTES) throw new Error("Owner-review request body is too large");
	return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown;
}

function json(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function operationName(pathname: string): OwnerReviewOperationName | undefined {
	if (!pathname.startsWith("/api/ops/")) return undefined;
	const name = pathname.slice("/api/ops/".length);
	return (OWNER_REVIEW_OPERATION_NAMES as readonly string[]).includes(name)
		? name as OwnerReviewOperationName
		: undefined;
}

/** Return undefined when this is not one of the four owner-review operations. */
export async function handleOwnerReviewX402Route(
	request: Request,
	context: OwnerReviewRouteContext,
): Promise<Response | undefined> {
	const name = operationName(new URL(request.url).pathname);
	if (!name) return undefined;
	if (!hasExplicitPrincipal(context)) {
		return json(errorEnvelope(name, new Error("Owner-review x402 requires authentication"), {
			code: "UNAUTHORIZED",
		}), 401);
	}
	if (request.method !== "POST") {
		return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
	}
	if (!enabled(context)) {
		return json(errorEnvelope(name, new Error("Owner-review x402 is unavailable"), {
			code: "OWNER_REVIEW_DISABLED",
		}), 404);
	}
	try {
		const body = await boundedBody(request);
		const engine = await runtime(context);
		let record: OwnerReviewRecord;
		if (name === "x402.ownerReviewPrepare") {
			const input = PrepareSchema.parse(body);
			record = await engine.prepare({
				principal: context.principal,
				owner: input.owner,
				network: input.network,
				idempotencyKey: input.idempotency_key,
				maxPriceDrops: input.max_price_drops,
			});
		} else if (name === "x402.ownerReviewSubmit") {
			const input = SubmitSchema.parse(body);
			record = await engine.submit({
				principal: context.principal,
				owner: input.owner,
				network: input.network,
				idempotencyKey: input.idempotency_key,
				approvalId: input.approval_id,
				approvalDigest: input.approval_digest,
				signedBlob: input.signed_blob,
			} satisfies OwnerReviewSubmitInput);
		} else {
			const input = DecisionSchema.parse(body);
			const decision = {
				principal: context.principal,
				owner: input.owner,
				network: input.network,
				idempotencyKey: input.idempotency_key,
				approvalId: input.approval_id,
			} satisfies OwnerReviewDecisionInput;
			record = name === "x402.ownerReviewReject"
				? await engine.reject(decision)
				: await engine.recover(decision);
		}
		return json(okEnvelope(publicRecord(record), {
			asOf: record.updatedAt,
			asOfBasis: "local-mock-owner-review",
		}));
	} catch (error) {
		const code = error instanceof OwnerReviewX402Error
			? error.code
			: error instanceof z.ZodError
				? "INVALID_INPUT"
				: "OWNER_REVIEW_OPERATION_FAILED";
		return json(errorEnvelope(name, new Error(code), { code }));
	}
}
