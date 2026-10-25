import {
	decode,
	deriveAddress,
	encodeForSigning,
	hashes,
	isValidClassicAddress,
	verifyKeypairSignature,
	type Payment,
	type Transaction,
} from "xrpl";

import {
	validateX402Challenge,
	type ValidatedX402Challenge,
} from "../adapters/x402";
import { LOCAL_X402_COMPARE_PRICE_DROPS } from "../local-x402";
import { LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO } from "../local-x402-isolated-v1";
import { X402PublicCompareBodySchema } from "../x402-contract";
import { X402_COMPARE_URL, X402_MAX_FEE_DROPS } from "./x402-pay";

/**
 * A separate owner-review state machine. It intentionally does not share the
 * dedicated-payer signer or persistence path used by x402-pay.ts.
 *
 * All network and ledger effects are injected. The in-memory store exported at
 * the bottom of this file is for offline tests/simulation only; a live caller
 * must supply durable compare-and-swap storage and explicitly enable the lane.
 */

export type OwnerReviewStatus =
	| "challenge"
	| "awaiting_approval"
	| "signed"
	| "relaying"
	| "settlement_unknown"
	| "settled"
	| "delivering"
	| "delivered"
	| "rejected"
	| "expired";

export type OwnerReviewTransaction = Readonly<Payment>;

export type OwnerReviewRecord = Readonly<{
	id: string;
	revision: number;
	status: OwnerReviewStatus;
	principal: string;
	idempotencyKey: string;
	requestFingerprint: string;
	approvalId: string;
	approvalDigest: string | null;
	owner: string;
	network: "testnet";
	resourceUrl: typeof X402_COMPARE_URL;
	payTo: typeof LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO;
	asset: "XRP";
	amountDrops: typeof LOCAL_X402_COMPARE_PRICE_DROPS;
	challenge: ValidatedX402Challenge | null;
	transaction: OwnerReviewTransaction | null;
	preparedLedgerIndex: number | null;
	quoteExpiresAt: string | null;
	signedBlob: string | null;
	txHash: string | null;
	reason: string | null;
	settlement: OwnerReviewSettlementProof | null;
	receipt: OwnerReviewReceipt | null;
	createdAt: string;
	updatedAt: string;
}>;

export type OwnerReviewSettlementProof = Readonly<{
	validated: true;
	hash: string;
	ledgerIndex: number;
	engineResult: string;
	transaction: Readonly<Record<string, unknown>>;
}>;

export type OwnerReviewReceipt = Readonly<{
	status: "delivered";
	approvalId: string;
	idempotencyKey: string;
	owner: string;
	network: "testnet";
	resourceUrl: typeof X402_COMPARE_URL;
	payTo: typeof LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO;
	asset: "XRP";
	amountDrops: typeof LOCAL_X402_COMPARE_PRICE_DROPS;
	txHash: string;
	validatedLedgerIndex: number;
	body: unknown;
	provenance: "validated-ledger-adapter" | "local-mock-simulated-settlement";
}>;

export type OwnerReviewClaimResult = Readonly<{
	outcome: "claimed" | "replay" | "mismatch";
	record: OwnerReviewRecord;
}>;

export type OwnerReviewTransitionResult = Readonly<{
	outcome: "transitioned" | "conflict";
	record: OwnerReviewRecord;
}>;

export interface OwnerReviewStore {
	getByIdempotencyKey(principal: string, idempotencyKey: string): Promise<OwnerReviewRecord | null>;
	getByApprovalId(approvalId: string): Promise<OwnerReviewRecord | null>;
	claim(record: OwnerReviewRecord): Promise<OwnerReviewClaimResult>;
	compareAndSwap(
		approvalId: string,
		expectedRevision: number,
		expectedStatus: OwnerReviewStatus,
		next: OwnerReviewRecord,
	): Promise<OwnerReviewTransitionResult>;
}

export type OwnerReviewLedgerPreparation = Readonly<{
	sequence: number;
	feeDrops: string;
	validatedLedgerIndex: number;
}>;

export type OwnerReviewMerchantAdapter = Readonly<{
	/** Fetch the fixed trusted resource without credentials. */
	challenge(): Promise<Readonly<{ status: 402; paymentRequired: string }>>;
	/** One allowed settlement-triggering dispatch for this signed payload. */
	dispatch(input: OwnerReviewMerchantRequest): Promise<void>;
	/** Read the resource with the same payload, only after validated settlement. */
	fetchAfterSettlement(input: OwnerReviewMerchantRequest): Promise<unknown>;
}>;

export type OwnerReviewMerchantRequest = Readonly<{
	url: typeof X402_COMPARE_URL;
	paymentSignature: string;
	txHash: string;
}>;

export type OwnerReviewSettlementAdapter = Readonly<{
	lookup(hash: string): Promise<
		| Readonly<{ status: "pending" }>
		| Readonly<{ status: "validated"; proof: OwnerReviewSettlementProof }>
	>;
}>;

export type OwnerReviewDependencies = Readonly<{
	enabled?: boolean;
	store: OwnerReviewStore;
	merchant: OwnerReviewMerchantAdapter;
	settlement: OwnerReviewSettlementAdapter;
	ledger: Readonly<{
		prepare(owner: string): Promise<OwnerReviewLedgerPreparation>;
		validatedLedgerIndex(): Promise<number>;
	}>;
	expectedSourceTag: number;
	receiptProvenance?: OwnerReviewReceipt["provenance"];
	encodePaymentSignature(input: Readonly<{
		challenge: ValidatedX402Challenge;
		signedBlob: string;
	}>): string;
	now?: () => Date;
	newId?: () => string;
	networkTimeoutMs?: number;
}>;

export type OwnerReviewPrepareInput = Readonly<{
	principal: string;
	idempotencyKey: string;
	owner: string;
	network: "testnet";
	maxPriceDrops: typeof LOCAL_X402_COMPARE_PRICE_DROPS;
}>;

export type OwnerReviewSubmitInput = Readonly<{
	principal: string;
	idempotencyKey: string;
	approvalId: string;
	approvalDigest: string;
	owner: string;
	network: "testnet";
	signedBlob: string;
}>;

export type OwnerReviewDecisionInput = Readonly<{
	principal: string;
	idempotencyKey: string;
	approvalId: string;
	owner: string;
	network: "testnet";
}>;

export type OwnerReviewErrorCode =
	| "OWNER_REVIEW_DISABLED"
	| "INVALID_INPUT"
	| "IDEMPOTENCY_MISMATCH"
	| "APPROVAL_NOT_FOUND"
	| "APPROVAL_BINDING_MISMATCH"
	| "APPROVAL_NOT_PENDING"
	| "APPROVAL_EXPIRED"
	| "CHALLENGE_REJECTED"
	| "LEDGER_PREPARATION_REJECTED"
	| "SIGNED_TRANSACTION_INVALID"
	| "SIGNED_TRANSACTION_MISMATCH"
	| "SETTLEMENT_EVIDENCE_MISMATCH";

export class OwnerReviewX402Error extends Error {
	constructor(readonly code: OwnerReviewErrorCode) {
		super(code);
		this.name = "OwnerReviewX402Error";
	}
}

const UINT32_MAX = 0xffff_ffff;
const OWNER_REVIEW_MAX_TIMEOUT_SECONDS = 60;
const HASH = /^[A-F0-9]{64}$/;
const HEX = /^[A-F0-9]+$/;
const POSITIVE_DROPS = /^[1-9][0-9]*$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const SIGNED_KEYS = new Set([
	"TransactionType",
	"Account",
	"Destination",
	"Amount",
	"InvoiceID",
	"SourceTag",
	"DestinationTag",
	"Fee",
	"Sequence",
	"LastLedgerSequence",
	"SigningPubKey",
	"TxnSignature",
]);

function reject(code: OwnerReviewErrorCode): never {
	throw new OwnerReviewX402Error(code);
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

async function sha256(value: unknown): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(canonical(value)),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("").toUpperCase();
}

async function sha256Text(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("").toUpperCase();
}

function iso(date: Date): string {
	if (!Number.isFinite(date.getTime())) reject("INVALID_INPUT");
	return date.toISOString();
}

function validatePrepareInput(input: OwnerReviewPrepareInput): void {
	if (
		input.network !== "testnet" ||
		!isValidClassicAddress(input.owner) ||
		!ID.test(input.principal) ||
		!ID.test(input.idempotencyKey) ||
		input.maxPriceDrops !== LOCAL_X402_COMPARE_PRICE_DROPS
	) reject("INVALID_INPUT");
}

function sameRequest(record: OwnerReviewRecord, input: OwnerReviewPrepareInput): boolean {
	return record.principal === input.principal &&
		record.idempotencyKey === input.idempotencyKey &&
		record.owner === input.owner &&
		record.network === input.network &&
		record.resourceUrl === X402_COMPARE_URL &&
		record.payTo === LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO &&
		record.asset === "XRP" &&
		record.amountDrops === input.maxPriceDrops;
}

function assertDecisionBinding(
	record: OwnerReviewRecord,
	input: OwnerReviewDecisionInput,
): void {
	if (
		record.principal !== input.principal ||
		record.idempotencyKey !== input.idempotencyKey ||
		record.approvalId !== input.approvalId ||
		record.owner !== input.owner ||
		record.network !== input.network
	) reject("APPROVAL_BINDING_MISMATCH");
}

function ledgerPreparation(value: OwnerReviewLedgerPreparation): OwnerReviewLedgerPreparation {
	if (
		!Number.isInteger(value.sequence) || value.sequence < 1 || value.sequence > UINT32_MAX ||
		!Number.isInteger(value.validatedLedgerIndex) || value.validatedLedgerIndex < 1 ||
		value.validatedLedgerIndex > UINT32_MAX ||
		!POSITIVE_DROPS.test(value.feeDrops) ||
		BigInt(value.feeDrops) > BigInt(X402_MAX_FEE_DROPS)
	) reject("LEDGER_PREPARATION_REJECTED");
	return value;
}

function paymentFor(
	owner: string,
	challenge: ValidatedX402Challenge,
	preparation: OwnerReviewLedgerPreparation,
	invoiceId: string,
): Payment {
	const window = Math.min(20, Math.max(4, Math.ceil(challenge.maxTimeoutSeconds / 4)));
	const lastLedgerSequence = preparation.validatedLedgerIndex + window;
	if (lastLedgerSequence > UINT32_MAX) reject("LEDGER_PREPARATION_REJECTED");
	const payment: Payment = {
		TransactionType: "Payment",
		Account: owner,
		Destination: challenge.payTo,
		Amount: challenge.amountDrops,
		InvoiceID: invoiceId,
		SourceTag: challenge.sourceTag,
		Fee: preparation.feeDrops,
		Sequence: preparation.sequence,
		LastLedgerSequence: lastLedgerSequence,
	};
	if (challenge.destinationTag !== undefined) {
		payment.DestinationTag = challenge.destinationTag;
	}
	return payment;
}

function exactUnsigned(
	actual: Record<string, unknown>,
	expected: Record<string, unknown>,
): boolean {
	const actualKeys = Object.keys(actual).sort();
	const expectedKeys = Object.keys(expected).sort();
	return actualKeys.length === expectedKeys.length &&
		actualKeys.every((key, index) => key === expectedKeys[index]) &&
		actualKeys.every((key) => canonical(actual[key]) === canonical(expected[key]));
}

function verifySignedBlob(record: OwnerReviewRecord, signedBlob: string): {
	signedBlob: string;
	hash: string;
	transaction: Readonly<Record<string, unknown>>;
} {
	if (
		record.transaction === null ||
		typeof signedBlob !== "string" ||
		signedBlob.length === 0 ||
		signedBlob.length > 200_000 ||
		signedBlob.length % 2 !== 0 ||
		!HEX.test(signedBlob.toUpperCase())
	) reject("SIGNED_TRANSACTION_INVALID");
	let decoded: Record<string, unknown>;
	try {
		decoded = decode(signedBlob) as Record<string, unknown>;
	} catch {
		reject("SIGNED_TRANSACTION_INVALID");
	}
	if (Object.keys(decoded).some((key) => !SIGNED_KEYS.has(key))) {
		reject("SIGNED_TRANSACTION_MISMATCH");
	}
	const signature = decoded.TxnSignature;
	const publicKey = decoded.SigningPubKey;
	if (
		typeof signature !== "string" || !HEX.test(signature.toUpperCase()) ||
		typeof publicKey !== "string" || !HEX.test(publicKey.toUpperCase())
	) reject("SIGNED_TRANSACTION_INVALID");
	const unsigned = { ...decoded };
	delete unsigned.TxnSignature;
	delete unsigned.SigningPubKey;
	if (!exactUnsigned(unsigned, record.transaction as Record<string, unknown>)) {
		reject("SIGNED_TRANSACTION_MISMATCH");
	}
	try {
		if (
			deriveAddress(publicKey) !== record.owner ||
			!verifyKeypairSignature(
				encodeForSigning(decoded as Transaction),
				signature,
				publicKey,
			)
		) reject("SIGNED_TRANSACTION_INVALID");
	} catch (error) {
		if (error instanceof OwnerReviewX402Error) throw error;
		reject("SIGNED_TRANSACTION_INVALID");
	}
	let hash: string;
	try {
		hash = hashes.hashSignedTx(signedBlob).toUpperCase();
	} catch {
		reject("SIGNED_TRANSACTION_INVALID");
	}
	if (!HASH.test(hash)) reject("SIGNED_TRANSACTION_INVALID");
	return { signedBlob: signedBlob.toUpperCase(), hash, transaction: decoded };
}

function settlementMatches(
	record: OwnerReviewRecord,
	proof: OwnerReviewSettlementProof,
): boolean {
	if (
		record.txHash === null || record.transaction === null || record.preparedLedgerIndex === null ||
		proof.validated !== true || proof.hash.toUpperCase() !== record.txHash ||
		!HASH.test(proof.hash.toUpperCase()) ||
		!Number.isInteger(proof.ledgerIndex) || proof.ledgerIndex <= record.preparedLedgerIndex ||
		proof.ledgerIndex > Number(record.transaction.LastLedgerSequence) ||
		proof.engineResult !== "tesSUCCESS"
	) return false;
	const transaction = { ...proof.transaction };
	delete transaction.SigningPubKey;
	delete transaction.TxnSignature;
	return exactUnsigned(transaction, record.transaction as Record<string, unknown>);
}

function paymentSignature(
	deps: OwnerReviewDependencies,
	record: OwnerReviewRecord,
): string {
	if (record.challenge === null || record.signedBlob === null || record.txHash === null) {
		reject("APPROVAL_NOT_PENDING");
	}
	const value = deps.encodePaymentSignature({
		challenge: record.challenge,
		signedBlob: record.signedBlob,
	});
	if (typeof value !== "string" || value.length === 0 || value.length > 24 * 1024 || /[\r\n]/.test(value)) {
		reject("SIGNED_TRANSACTION_INVALID");
	}
	return value;
}

async function transition(
	store: OwnerReviewStore,
	record: OwnerReviewRecord,
	status: OwnerReviewStatus,
	at: string,
	patch: Partial<OwnerReviewRecord> = {},
): Promise<OwnerReviewRecord> {
	const next: OwnerReviewRecord = {
		...record,
		...patch,
		revision: record.revision + 1,
		status,
		updatedAt: at,
	};
	const result = await store.compareAndSwap(
		record.approvalId,
		record.revision,
		record.status,
		next,
	);
	return result.record;
}

export function createOwnerReviewedX402Engine(deps: OwnerReviewDependencies) {
	const now = deps.now ?? (() => new Date());
	const newId = deps.newId ?? (() => crypto.randomUUID());
	const networkTimeoutMs = deps.networkTimeoutMs ?? 8_000;
	if (!Number.isSafeInteger(networkTimeoutMs) || networkTimeoutMs < 1 || networkTimeoutMs > 60_000) {
		reject("INVALID_INPUT");
	}

	async function bounded<T>(promise: Promise<T>, code: OwnerReviewErrorCode): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				promise,
				new Promise<T>((_resolve, rejectPromise) => {
					timer = setTimeout(() => rejectPromise(new OwnerReviewX402Error(code)), networkTimeoutMs);
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	async function expireIfStale(record: OwnerReviewRecord): Promise<OwnerReviewRecord> {
		if (record.status !== "awaiting_approval") return record;
		if (record.transaction === null || record.quoteExpiresAt === null) {
			reject("APPROVAL_BINDING_MISMATCH");
		}
		const at = now();
		const ledgerIndex = await bounded(
			deps.ledger.validatedLedgerIndex(),
			"LEDGER_PREPARATION_REJECTED",
		);
		if (
			at.getTime() < new Date(record.quoteExpiresAt).getTime() &&
			ledgerIndex <= Number(record.transaction.LastLedgerSequence)
		) return record;
		return transition(deps.store, record, "expired", iso(at), {
			reason: "approval_expired",
		});
	}

	async function reconcile(record: OwnerReviewRecord): Promise<OwnerReviewRecord> {
		if (record.status !== "settlement_unknown" || record.txHash === null) return record;
		let lookup: Awaited<ReturnType<OwnerReviewSettlementAdapter["lookup"]>>;
		try {
			lookup = await bounded(deps.settlement.lookup(record.txHash), "SETTLEMENT_EVIDENCE_MISMATCH");
		} catch {
			return record;
		}
		if (lookup.status === "pending") return record;
		if (!settlementMatches(record, lookup.proof)) {
			reject("SETTLEMENT_EVIDENCE_MISMATCH");
		}
		const at = iso(now());
		return transition(deps.store, record, "settled", at, {
			settlement: { ...lookup.proof, hash: lookup.proof.hash.toUpperCase() },
		});
	}

	async function deliver(record: OwnerReviewRecord): Promise<OwnerReviewRecord> {
		if (record.status !== "settled") return record;
		if (record.txHash === null || record.settlement === null) {
			reject("SETTLEMENT_EVIDENCE_MISMATCH");
		}
		const txHash = record.txHash;
		const validatedLedgerIndex = record.settlement.ledgerIndex;
		const claimed = await deps.store.compareAndSwap(record.approvalId, record.revision, "settled", {
			...record,
			revision: record.revision + 1,
			status: "delivering",
			updatedAt: iso(now()),
		});
		if (claimed.outcome === "conflict") return claimed.record;
		record = claimed.record;
		let body: unknown;
		try {
			body = X402PublicCompareBodySchema.parse(await bounded(
				deps.merchant.fetchAfterSettlement({
					url: X402_COMPARE_URL,
					paymentSignature: paymentSignature(deps, record),
					txHash,
				}),
				"CHALLENGE_REJECTED",
			));
		} catch (error) {
			await transition(deps.store, record, "settled", iso(now()));
			throw error;
		}
		const receipt: OwnerReviewReceipt = {
			status: "delivered",
			approvalId: record.approvalId,
			idempotencyKey: record.idempotencyKey,
			owner: record.owner,
			network: "testnet",
			resourceUrl: X402_COMPARE_URL,
			payTo: LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO,
			asset: "XRP",
			amountDrops: LOCAL_X402_COMPARE_PRICE_DROPS,
			txHash,
			validatedLedgerIndex,
			body,
			provenance: deps.receiptProvenance ?? "validated-ledger-adapter",
		};
		return transition(deps.store, record, "delivered", iso(now()), { receipt });
	}

	async function recover(record: OwnerReviewRecord): Promise<OwnerReviewRecord> {
		if (record.status === "settlement_unknown") record = await reconcile(record);
		if (record.status === "settled") record = await deliver(record);
		return record;
	}

	return Object.freeze({
		async prepare(input: OwnerReviewPrepareInput): Promise<OwnerReviewRecord> {
			if (deps.enabled !== true) reject("OWNER_REVIEW_DISABLED");
			validatePrepareInput(input);
			const requestFingerprint = await sha256({
				principal: input.principal,
				idempotencyKey: input.idempotencyKey,
				owner: input.owner,
				network: input.network,
				resourceUrl: X402_COMPARE_URL,
				payTo: LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO,
				asset: "XRP",
				amountDrops: LOCAL_X402_COMPARE_PRICE_DROPS,
			});
			const at = iso(now());
			const candidate: OwnerReviewRecord = {
				id: newId(),
				revision: 0,
				status: "challenge",
				principal: input.principal,
				idempotencyKey: input.idempotencyKey,
				requestFingerprint,
				approvalId: newId(),
				approvalDigest: null,
				owner: input.owner,
				network: "testnet",
				resourceUrl: X402_COMPARE_URL,
				payTo: LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO,
				asset: "XRP",
				amountDrops: LOCAL_X402_COMPARE_PRICE_DROPS,
				challenge: null,
				transaction: null,
				preparedLedgerIndex: null,
				quoteExpiresAt: null,
				signedBlob: null,
				txHash: null,
				reason: null,
				settlement: null,
				receipt: null,
				createdAt: at,
				updatedAt: at,
			};
			const claimed = await deps.store.claim(candidate);
			if (claimed.outcome === "mismatch" || !sameRequest(claimed.record, input)) {
				reject("IDEMPOTENCY_MISMATCH");
			}
			if (claimed.outcome === "replay" && claimed.record.status !== "challenge") {
				return recover(await expireIfStale(claimed.record));
			}
			const working = claimed.record;

			let response: Readonly<{ status: 402; paymentRequired: string }>;
			try {
				response = await bounded(deps.merchant.challenge(), "CHALLENGE_REJECTED");
			} catch {
				reject("CHALLENGE_REJECTED");
			}
			if (response.status !== 402) reject("CHALLENGE_REJECTED");
			let challenge: ValidatedX402Challenge;
			try {
				challenge = validateX402Challenge(response.paymentRequired, {
					requestUrl: X402_COMPARE_URL,
					maxPriceDrops: LOCAL_X402_COMPARE_PRICE_DROPS,
					policyPerCallDrops: LOCAL_X402_COMPARE_PRICE_DROPS,
					network: "testnet",
					expectedSourceTag: deps.expectedSourceTag,
				});
			} catch {
				reject("CHALLENGE_REJECTED");
			}
			if (
				challenge.asset !== "XRP" ||
				challenge.amountDrops !== LOCAL_X402_COMPARE_PRICE_DROPS ||
				challenge.payTo !== LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO ||
				challenge.maxTimeoutSeconds > OWNER_REVIEW_MAX_TIMEOUT_SECONDS
			) reject("CHALLENGE_REJECTED");

			let preparation: OwnerReviewLedgerPreparation;
			try {
				preparation = ledgerPreparation(await bounded(
					deps.ledger.prepare(input.owner),
					"LEDGER_PREPARATION_REJECTED",
				));
			} catch {
				reject("LEDGER_PREPARATION_REJECTED");
			}
			const transaction = paymentFor(
				input.owner,
				challenge,
				preparation,
				await sha256Text(challenge.invoiceId),
			);
			const quoteExpiresAt = iso(new Date(
				now().getTime() + challenge.maxTimeoutSeconds * 1_000,
			));
			const approvalDigest = await sha256({
				approvalId: working.approvalId,
				requestFingerprint,
				quoteExpiresAt,
				challenge,
				transaction,
			});
			const prepared = await transition(deps.store, working, "awaiting_approval", iso(now()), {
				challenge,
				transaction,
				preparedLedgerIndex: preparation.validatedLedgerIndex,
				quoteExpiresAt,
				approvalDigest,
			});
			if (prepared.status !== "awaiting_approval") reject("APPROVAL_NOT_PENDING");
			return prepared;
		},

		async reject(input: OwnerReviewDecisionInput): Promise<OwnerReviewRecord> {
			if (deps.enabled !== true) reject("OWNER_REVIEW_DISABLED");
			const record = await deps.store.getByApprovalId(input.approvalId);
			if (record === null) reject("APPROVAL_NOT_FOUND");
			assertDecisionBinding(record, input);
			if (record.status === "rejected" || record.status === "expired") return record;
			if (record.status !== "awaiting_approval") reject("APPROVAL_NOT_PENDING");
			return transition(deps.store, record, "rejected", iso(now()), {
				reason: "owner_rejected",
			});
		},

		async expire(input: OwnerReviewDecisionInput): Promise<OwnerReviewRecord> {
			if (deps.enabled !== true) reject("OWNER_REVIEW_DISABLED");
			const record = await deps.store.getByApprovalId(input.approvalId);
			if (record === null) reject("APPROVAL_NOT_FOUND");
			assertDecisionBinding(record, input);
			const expired = await expireIfStale(record);
			if (expired.status !== "expired") reject("APPROVAL_NOT_PENDING");
			return expired;
		},

		async submit(input: OwnerReviewSubmitInput): Promise<OwnerReviewRecord> {
			if (deps.enabled !== true) reject("OWNER_REVIEW_DISABLED");
			const found = await deps.store.getByApprovalId(input.approvalId);
			if (found === null) reject("APPROVAL_NOT_FOUND");
			assertDecisionBinding(found, input);
			if (found.approvalDigest !== input.approvalDigest) {
				reject("APPROVAL_BINDING_MISMATCH");
			}
			let record = await expireIfStale(found);
			if (record.status === "expired") reject("APPROVAL_EXPIRED");
			if (record.status === "rejected") reject("APPROVAL_NOT_PENDING");
			const verified = verifySignedBlob(record, input.signedBlob);
			if (record.txHash !== null && record.txHash !== verified.hash) {
				reject("SIGNED_TRANSACTION_MISMATCH");
			}

			if (record.status === "awaiting_approval") {
				record = await transition(deps.store, record, "signed", iso(now()), {
					signedBlob: verified.signedBlob,
					txHash: verified.hash,
				});
			}
			if (record.status === "signed") {
				const relayAt = iso(now());
				const relayCandidate: OwnerReviewRecord = {
					...record,
					revision: record.revision + 1,
					status: "relaying",
					updatedAt: relayAt,
				};
				const relayClaim = await deps.store.compareAndSwap(
					record.approvalId,
					record.revision,
					"signed",
					relayCandidate,
				);
				if (relayClaim.outcome === "conflict") return recover(relayClaim.record);
				record = relayClaim.record;
				try {
					await bounded(deps.merchant.dispatch({
						url: X402_COMPARE_URL,
						paymentSignature: paymentSignature(deps, record),
						txHash: verified.hash,
					}), "CHALLENGE_REJECTED");
				} catch {
					// Dispatch may have reached the facilitator. Never dispatch again;
					// retain the signed hash and reconcile read-only on every replay.
				}
				record = await transition(deps.store, record, "settlement_unknown", iso(now()));
			}
			if (record.status === "relaying") return record;
			return recover(record);
		},

		async recover(input: OwnerReviewDecisionInput): Promise<OwnerReviewRecord> {
			if (deps.enabled !== true) reject("OWNER_REVIEW_DISABLED");
			let record = await deps.store.getByApprovalId(input.approvalId);
			if (record === null) reject("APPROVAL_NOT_FOUND");
			assertDecisionBinding(record, input);
			if (record.status === "relaying") {
				// A process may have stopped after claiming relay but before recording
				// its outcome. Treat that as possibly submitted and reconcile by hash;
				// never dispatch the signed payload a second time.
				record = await transition(
					deps.store,
					record,
					"settlement_unknown",
					iso(now()),
				);
			}
			if (record.status === "delivering") {
				const age = now().getTime() - Date.parse(record.updatedAt);
				if (age < networkTimeoutMs * 2) return record;
				record = await transition(deps.store, record, "settled", iso(now()));
			}
			return recover(record);
		},
	});
}

/** Offline/simulation store. It is deliberately not a production credential or durable payment store. */
export class InMemoryOwnerReviewStore implements OwnerReviewStore {
	private readonly byApproval = new Map<string, OwnerReviewRecord>();
	private readonly byIdempotency = new Map<string, string>();

	private key(principal: string, idempotencyKey: string): string {
		return `${principal}\0${idempotencyKey}`;
	}

	async getByIdempotencyKey(principal: string, idempotencyKey: string): Promise<OwnerReviewRecord | null> {
		const approval = this.byIdempotency.get(this.key(principal, idempotencyKey));
		const record = approval ? this.byApproval.get(approval) : undefined;
		return record ? structuredClone(record) : null;
	}

	async getByApprovalId(approvalId: string): Promise<OwnerReviewRecord | null> {
		const record = this.byApproval.get(approvalId);
		return record ? structuredClone(record) : null;
	}

	async claim(record: OwnerReviewRecord): Promise<OwnerReviewClaimResult> {
		const key = this.key(record.principal, record.idempotencyKey);
		const approval = this.byIdempotency.get(key);
		if (approval !== undefined) {
			const current = this.byApproval.get(approval)!;
			return {
				outcome: current.requestFingerprint === record.requestFingerprint ? "replay" : "mismatch",
				record: structuredClone(current),
			};
		}
		this.byIdempotency.set(key, record.approvalId);
		this.byApproval.set(record.approvalId, structuredClone(record));
		return { outcome: "claimed", record: structuredClone(record) };
	}

	async compareAndSwap(
		approvalId: string,
		expectedRevision: number,
		expectedStatus: OwnerReviewStatus,
		next: OwnerReviewRecord,
	): Promise<OwnerReviewTransitionResult> {
		const current = this.byApproval.get(approvalId);
		if (
			current === undefined ||
			current.revision !== expectedRevision ||
			current.status !== expectedStatus
		) {
			if (current === undefined) reject("APPROVAL_NOT_FOUND");
			return { outcome: "conflict", record: structuredClone(current) };
		}
		this.byApproval.set(approvalId, structuredClone(next));
		return { outcome: "transitioned", record: structuredClone(next) };
	}
}
