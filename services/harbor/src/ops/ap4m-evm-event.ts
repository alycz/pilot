import { z } from 'zod';
import { hashTypedData, recoverTypedDataAddress } from 'viem';

import type { OpContext, OpDef } from '../catalog/registry';
import {
	EvmAddressSchema,
	EcdsaSignatureSchema,
	Hex32Schema,
	type PreparedEvmTransaction,
} from '../ap4m-evm/contracts';
import { AP4M_EVM_EVENT_PROFILE } from '../ap4m-evm/event-config';
import { validatePreparedVoucherRedemption } from '../ap4m-evm/prepare-validation';
import type {
	Ap4mEvmAttemptRow,
	Ap4mEvmChannelRow,
	ReserveAp4mEvmVoucherInput,
} from '../ap4m-evm/store';

const IdentifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const ApprovalIdentifierSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const CanonicalUintSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/).refine(
	(value) => BigInt(value) < (1n << 127n),
	'amount exceeds the durable event-rail range',
);
const PositiveUintSchema = CanonicalUintSchema.refine((value) => value !== '0', 'amount must be positive');
const LowerHexDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const IsoTimestampSchema = z.string().datetime({ offset: true }).refine(
	(value) => new Date(value).toISOString() === value,
	'timestamp must be canonical UTC ISO-8601',
);

const FixedProfileSchema = z.object({
	network: z.literal('XRPL EVM Testnet'),
	chain_id: z.literal(AP4M_EVM_EVENT_PROFILE.chainId),
	payment_ledger: z.literal(AP4M_EVM_EVENT_PROFILE.paymentLedger),
	pooled_escrow_vault: z.literal(AP4M_EVM_EVENT_PROFILE.pooledEscrowVault),
	token: z.literal(AP4M_EVM_EVENT_PROFILE.rlusdToken),
	token_decimals: z.literal(AP4M_EVM_EVENT_PROFILE.rlusdDecimals),
}).strict();

const VoucherTypedDataSchema = z.object({
	domain: z.object({
		name: z.literal('AP4M Payment Ledger'),
		version: z.literal('1'),
		chainId: z.literal(AP4M_EVM_EVENT_PROFILE.chainId),
		verifyingContract: z.literal(AP4M_EVM_EVENT_PROFILE.paymentLedger),
	}).strict(),
	primaryType: z.literal('Voucher'),
	types: z.object({
		Voucher: z.tuple([
			z.object({ name: z.literal('channelId'), type: z.literal('bytes32') }).strict(),
			z.object({ name: z.literal('cumulativeAmount'), type: z.literal('uint256') }).strict(),
		]),
	}).strict(),
	message: z.object({
		channelId: Hex32Schema,
		cumulativeAmount: CanonicalUintSchema,
	}).strict(),
}).strict();

const RoleBindingSchema = z.object({
	merchant_id: IdentifierSchema,
	agent_wallet: EvmAddressSchema,
	funding_wallet: EvmAddressSchema,
	merchant_payout: EvmAddressSchema,
}).strict().superRefine((value, issue) => {
	const payout = value.merchant_payout.toLowerCase();
	if (payout === value.agent_wallet.toLowerCase() || payout === value.funding_wallet.toLowerCase()) {
		issue.addIssue({
			code: 'custom',
			path: ['merchant_payout'],
			message: 'merchant payout must differ from agent and funding wallets',
		});
	}
});

export const Ap4mEvmPrepareApprovalArgsSchema = z.object({
	profile: FixedProfileSchema,
	channel_id: Hex32Schema,
	roles: RoleBindingSchema,
	generation: z.number().int().nonnegative(),
	cap_base_units: PositiveUintSchema,
	previous_cumulative: CanonicalUintSchema,
	next_cumulative: PositiveUintSchema,
	idempotency_key: IdentifierSchema,
	channel_valid_after: IsoTimestampSchema,
	channel_valid_before: IsoTimestampSchema,
	approval_expires_at: IsoTimestampSchema,
	fee_model: z.literal('legacy'),
	max_gas_price: PositiveUintSchema,
	max_gas_limit: PositiveUintSchema,
	voucher_typed_data: VoucherTypedDataSchema,
}).strict().superRefine((value, issue) => {
	if (value.voucher_typed_data.message.channelId.toLowerCase() !== value.channel_id.toLowerCase()) {
		issue.addIssue({ code: 'custom', path: ['voucher_typed_data', 'message', 'channelId'], message: 'typed-data channel does not match' });
	}
	if (value.voucher_typed_data.message.cumulativeAmount !== value.next_cumulative) {
		issue.addIssue({ code: 'custom', path: ['voucher_typed_data', 'message', 'cumulativeAmount'], message: 'typed-data amount does not match' });
	}
	if (BigInt(value.next_cumulative) <= BigInt(value.previous_cumulative)) {
		issue.addIssue({ code: 'custom', path: ['next_cumulative'], message: 'cumulative amount must increase' });
	}
	if (BigInt(value.next_cumulative) > BigInt(value.cap_base_units)) {
		issue.addIssue({ code: 'custom', path: ['next_cumulative'], message: 'cumulative amount exceeds channel cap' });
	}
});

export const Ap4mEvmRecordSubmissionArgsSchema = z.object({
	approval_id: ApprovalIdentifierSchema,
	channel_id: Hex32Schema,
	idempotency_key: IdentifierSchema,
	tx_hash: Hex32Schema,
}).strict();

export const Ap4mEvmBindVoucherArgsSchema = z.object({
	approval_id: ApprovalIdentifierSchema,
	channel_id: Hex32Schema,
	idempotency_key: IdentifierSchema,
	voucher_signature: EcdsaSignatureSchema,
}).strict();

export const Ap4mEvmReconcileArgsSchema = Ap4mEvmRecordSubmissionArgsSchema;

export const Ap4mEvmStatusArgsSchema = z.object({
	channel_id: Hex32Schema,
	idempotency_key: IdentifierSchema.optional(),
}).strict();

export type Ap4mEvmPrepareApprovalArgs = z.infer<typeof Ap4mEvmPrepareApprovalArgsSchema>;
export type Ap4mEvmRecordSubmissionArgs = z.infer<typeof Ap4mEvmRecordSubmissionArgsSchema>;
export type Ap4mEvmBindVoucherArgs = z.infer<typeof Ap4mEvmBindVoucherArgsSchema>;
export type Ap4mEvmReconcileArgs = z.infer<typeof Ap4mEvmReconcileArgsSchema>;
export type Ap4mEvmStatusArgs = z.infer<typeof Ap4mEvmStatusArgsSchema>;

export type Ap4mEvmApprovalBinding = Readonly<{
	approvalId: string;
	expiresAt: string;
	channelValidAfter: string;
	channelValidBefore: string;
	requestFingerprint: string;
	attemptToken: string;
	typedDataDigest: `0x${string}`;
	reservation: ReserveAp4mEvmVoucherInput;
	channel: Ap4mEvmChannelRow;
	transactionExpectation: Readonly<{
		chainId: typeof AP4M_EVM_EVENT_PROFILE.chainId;
		from: string;
		to: typeof AP4M_EVM_EVENT_PROFILE.paymentLedger;
		value: '0';
		feeModel: 'legacy';
		maxGasPrice: string;
		maxGasLimit: string;
		functionName: 'redeemVoucher';
		channelId: string;
		cumulativeAmount: string;
	}>;
}>;

export type Ap4mEvmBoundRedemption = Readonly<{
	approvalId: string;
	expiresAt: string;
	typedDataDigest: `0x${string}`;
	recoveredSigner: string;
	requestFingerprint: string;
	attemptToken: string;
	channel: Ap4mEvmChannelRow;
	attempt: Ap4mEvmAttemptRow;
	transaction: PreparedEvmTransaction;
	feeModel: 'legacy';
	gasPrice: string;
	maxGasPrice: string;
	maxGasLimit: string;
}>;

export type Ap4mEvmSubmissionResult = Readonly<{
	status: 'reconciliation_required' | 'already_recorded';
	txHash: string;
	attempt: Ap4mEvmAttemptRow;
}>;

export type Ap4mEvmReconciliationResult = Readonly<{
	status: 'pending' | 'confirmed' | 'failed_absent';
	txHash: string;
	attempt: Ap4mEvmAttemptRow;
	channel: Ap4mEvmChannelRow;
	transaction?: PreparedEvmTransaction;
	settlementEvidence?: Readonly<{
		source: 'verified-on-chain';
		claimId: string;
		payoutTransactionHash: string;
		payoutBlockHash: string;
		payoutBlockNumber: number;
		confirmations: number;
		recipient: string;
		token: string;
		amountBaseUnits: string;
	}>;
}>;

export type Ap4mEvmStatusResult = Readonly<{
	channel: Ap4mEvmChannelRow | null;
	attempt: Ap4mEvmAttemptRow | null;
}>;

export interface Ap4mEvmOperationServices {
	/** Set only after the exact event profile and acceptance checklist are reviewed. */
	acceptance: 'reviewed-testnet-v1';
	now(): Date;
	prepareApproval(input: Readonly<{
		principal: string;
		args: Ap4mEvmPrepareApprovalArgs;
		requestFingerprint: string;
	}>): Promise<Ap4mEvmApprovalBinding>;
	bindVoucher(input: Readonly<{
		principal: string;
		args: Ap4mEvmBindVoucherArgs;
	}>): Promise<Ap4mEvmBoundRedemption>;
	recordSubmission(input: Readonly<{
		principal: string;
		args: Ap4mEvmRecordSubmissionArgs;
	}>): Promise<Ap4mEvmSubmissionResult>;
	reconcile(input: Readonly<{
		principal: string;
		args: Ap4mEvmReconcileArgs;
	}>): Promise<Ap4mEvmReconciliationResult>;
	status(input: Readonly<{
		principal: string;
		args: Ap4mEvmStatusArgs;
	}>): Promise<Ap4mEvmStatusResult>;
}

export class Ap4mEvmOperationError extends Error {
	constructor(
		message: string,
		readonly code:
			| 'AP4M_EVM_DISABLED'
			| 'AP4M_EVM_APPROVAL_EXPIRED'
			| 'AP4M_EVM_INVALID_BINDING'
			| 'AP4M_EVM_UNSUPPORTED_EVIDENCE',
	) {
		super(message);
		this.name = 'Ap4mEvmOperationError';
	}
}

function operationServices(services: Ap4mEvmOperationServices | undefined): Ap4mEvmOperationServices {
	if (services?.acceptance !== 'reviewed-testnet-v1') {
		throw new Ap4mEvmOperationError(
			'AP4M EVM operations are disabled until the reviewed Testnet acceptance profile is installed',
			'AP4M_EVM_DISABLED',
		);
	}
	return services;
}

function approvalWindow(args: Ap4mEvmPrepareApprovalArgs, services: Ap4mEvmOperationServices): void {
	const now = services.now().getTime();
	const expiry = Date.parse(args.approval_expires_at);
	const validAfter = Date.parse(args.channel_valid_after);
	const validBefore = Date.parse(args.channel_valid_before);
	if (!Number.isFinite(now) || expiry <= now || expiry > now + 5 * 60_000) {
		throw new Ap4mEvmOperationError(
			'AP4M EVM approval expiry must be in the next five minutes',
			'AP4M_EVM_APPROVAL_EXPIRED',
		);
	}
	if (validAfter > now || validBefore <= validAfter || expiry > validBefore) {
		throw new Ap4mEvmOperationError(
			'AP4M EVM approval must be contained by the reviewed channel validity window',
			'AP4M_EVM_APPROVAL_EXPIRED',
		);
	}
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new Ap4mEvmOperationError('AP4M EVM request contains a non-finite number', 'AP4M_EVM_INVALID_BINDING');
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (typeof value === 'object') {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
			.join(',')}}`;
	}
	throw new Ap4mEvmOperationError('AP4M EVM request contains an unsupported value', 'AP4M_EVM_INVALID_BINDING');
}

async function requestFingerprint(principal: string, args: Ap4mEvmPrepareApprovalArgs): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(canonicalJson({ principal, request: args })),
	));
	return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function voucherTypedData(channelId: string, cumulativeAmount: string) {
	return {
		domain: {
			name: 'AP4M Payment Ledger' as const,
			version: '1' as const,
			chainId: AP4M_EVM_EVENT_PROFILE.chainId,
			verifyingContract: AP4M_EVM_EVENT_PROFILE.paymentLedger,
		},
		primaryType: 'Voucher' as const,
		types: { Voucher: [
			{ name: 'channelId', type: 'bytes32' },
			{ name: 'cumulativeAmount', type: 'uint256' },
		] } as const,
		message: {
			channelId: channelId as `0x${string}`,
			cumulativeAmount: BigInt(cumulativeAmount),
		},
	};
}

function exactReservation(binding: Ap4mEvmApprovalBinding, principal: string, args: Ap4mEvmPrepareApprovalArgs): boolean {
	const expected = {
		principal,
		channelId: args.channel_id.toLowerCase(),
		merchantId: args.roles.merchant_id,
		agentWallet: args.roles.agent_wallet.toLowerCase(),
		fundingWallet: args.roles.funding_wallet.toLowerCase(),
		payoutWallet: args.roles.merchant_payout.toLowerCase(),
		tokenAddress: AP4M_EVM_EVENT_PROFILE.rlusdToken.toLowerCase(),
		generation: args.generation,
		capBaseUnits: args.cap_base_units,
		nextCumulative: args.next_cumulative,
		idempotencyKey: args.idempotency_key,
	};
	const actual = binding.reservation;
	return Object.entries(expected).every(([key, value]) => {
		const selected = actual[key as keyof ReserveAp4mEvmVoucherInput];
		return typeof value === 'string' && typeof selected === 'string'
			? selected.toLowerCase() === value.toLowerCase()
			: selected === value;
	}) && actual.requestFingerprint === binding.requestFingerprint &&
		actual.attemptToken === binding.attemptToken &&
		LowerHexDigestSchema.safeParse(binding.requestFingerprint).success &&
		LowerHexDigestSchema.safeParse(binding.attemptToken).success;
}

function validateApprovalBinding(
	binding: Ap4mEvmApprovalBinding,
	principal: string,
	args: Ap4mEvmPrepareApprovalArgs,
	expectedFingerprint: string,
): Ap4mEvmApprovalBinding {
	const expected = binding.transactionExpectation;
	const typedDataDigest = hashTypedData(voucherTypedData(args.channel_id, args.next_cumulative));
	if (
		!ApprovalIdentifierSchema.safeParse(binding.approvalId).success ||
		binding.expiresAt !== args.approval_expires_at ||
		binding.channelValidAfter !== args.channel_valid_after ||
		binding.channelValidBefore !== args.channel_valid_before ||
		binding.typedDataDigest.toLowerCase() !== typedDataDigest.toLowerCase() ||
		binding.requestFingerprint !== expectedFingerprint ||
		!exactReservation(binding, principal, args) ||
		binding.channel.principal !== principal ||
		binding.channel.channelId.toLowerCase() !== args.channel_id.toLowerCase() ||
		binding.channel.merchantId !== args.roles.merchant_id ||
		binding.channel.agentWallet.toLowerCase() !== args.roles.agent_wallet.toLowerCase() ||
		binding.channel.fundingWallet.toLowerCase() !== args.roles.funding_wallet.toLowerCase() ||
		binding.channel.payoutWallet.toLowerCase() !== args.roles.merchant_payout.toLowerCase() ||
		binding.channel.tokenAddress.toLowerCase() !== AP4M_EVM_EVENT_PROFILE.rlusdToken.toLowerCase() ||
		binding.channel.capBaseUnits !== args.cap_base_units ||
		binding.channel.cumulativeBaseUnits !== args.previous_cumulative ||
		binding.channel.pendingIdempotencyKey !== args.idempotency_key ||
		binding.channel.pendingRequestFingerprint !== expectedFingerprint ||
		binding.channel.pendingNextCumulative !== args.next_cumulative ||
		binding.channel.pendingAttemptToken !== binding.attemptToken ||
		expected.chainId !== AP4M_EVM_EVENT_PROFILE.chainId ||
		expected.from.toLowerCase() !== args.roles.agent_wallet.toLowerCase() ||
		expected.to !== AP4M_EVM_EVENT_PROFILE.paymentLedger ||
		expected.value !== '0' ||
		expected.feeModel !== args.fee_model ||
		expected.maxGasPrice !== args.max_gas_price ||
		expected.maxGasLimit !== args.max_gas_limit ||
		expected.functionName !== 'redeemVoucher' ||
		expected.channelId.toLowerCase() !== args.channel_id.toLowerCase() ||
		expected.cumulativeAmount !== args.next_cumulative
	) {
		throw new Ap4mEvmOperationError(
			'AP4M EVM approval service returned a binding that does not match the reviewed request',
			'AP4M_EVM_INVALID_BINDING',
		);
	}
	return binding;
}

async function validateBoundRedemption(
	result: Ap4mEvmBoundRedemption,
	principal: string,
	args: Ap4mEvmBindVoucherArgs,
	services: Ap4mEvmOperationServices,
): Promise<Ap4mEvmBoundRedemption> {
	const now = services.now().getTime();
	const expiry = Date.parse(result.expiresAt);
	const channel = result.channel;
	const attempt = result.attempt;
	const typedDataDigest = hashTypedData(voucherTypedData(channel.channelId, attempt.nextCumulative));
	let recoveredSigner: string;
	try {
		recoveredSigner = await recoverTypedDataAddress({
			...voucherTypedData(channel.channelId, attempt.nextCumulative),
			signature: args.voucher_signature as `0x${string}`,
		});
	} catch {
		throw new Ap4mEvmOperationError(
			'AP4M EVM voucher signature is invalid for the reviewed typed data',
			'AP4M_EVM_INVALID_BINDING',
		);
	}
	if (
		result.approvalId !== args.approval_id || !Number.isFinite(now) || !IsoTimestampSchema.safeParse(result.expiresAt).success ||
		!Number.isFinite(expiry) || expiry <= now || expiry > now + 5 * 60_000 ||
		result.typedDataDigest.toLowerCase() !== typedDataDigest.toLowerCase() ||
		!LowerHexDigestSchema.safeParse(result.requestFingerprint).success ||
		!LowerHexDigestSchema.safeParse(result.attemptToken).success ||
		result.recoveredSigner.toLowerCase() !== recoveredSigner.toLowerCase() ||
		recoveredSigner.toLowerCase() !== channel.agentWallet.toLowerCase() ||
		channel.principal !== principal || attempt.principal !== principal ||
		channel.channelId.toLowerCase() !== args.channel_id.toLowerCase() ||
		attempt.channelId.toLowerCase() !== args.channel_id.toLowerCase() ||
		attempt.idempotencyKey !== args.idempotency_key || attempt.status !== 'prepared' ||
		attempt.requestFingerprint !== result.requestFingerprint || attempt.attemptToken !== result.attemptToken ||
		channel.pendingIdempotencyKey !== args.idempotency_key ||
		channel.pendingRequestFingerprint !== result.requestFingerprint ||
		channel.pendingNextCumulative !== attempt.nextCumulative ||
		channel.pendingAttemptToken !== result.attemptToken ||
		channel.payoutWallet.toLowerCase() === channel.agentWallet.toLowerCase() ||
		channel.payoutWallet.toLowerCase() === channel.fundingWallet.toLowerCase() ||
		channel.tokenAddress.toLowerCase() !== AP4M_EVM_EVENT_PROFILE.rlusdToken.toLowerCase() ||
		result.feeModel !== 'legacy' ||
		!PositiveUintSchema.safeParse(result.gasPrice).success ||
		!PositiveUintSchema.safeParse(result.maxGasPrice).success ||
		BigInt(result.gasPrice) > BigInt(result.maxGasPrice) ||
		!PositiveUintSchema.safeParse(result.maxGasLimit).success
	) {
		throw new Ap4mEvmOperationError(
			'AP4M EVM voucher signature or prepared redemption is not bound to the pending approval',
			'AP4M_EVM_INVALID_BINDING',
		);
	}
	validatePreparedVoucherRedemption(result.transaction, {
		from: channel.agentWallet as `0x${string}`,
		maxGasLimit: BigInt(result.maxGasLimit),
		maxGasPrice: BigInt(result.maxGasPrice),
		channelId: channel.channelId as `0x${string}`,
		cumulativeAmount: attempt.nextCumulative,
		signature: args.voucher_signature as `0x${string}`,
	});
	return result;
}

function validateReconciliation(
	result: Ap4mEvmReconciliationResult,
	principal: string,
	args: Ap4mEvmReconcileArgs,
): Ap4mEvmReconciliationResult {
	if (
		result.txHash.toLowerCase() !== args.tx_hash.toLowerCase() ||
		result.attempt.txHash?.toLowerCase() !== args.tx_hash.toLowerCase() ||
		result.attempt.principal !== principal || result.channel.principal !== principal ||
		result.attempt.channelId.toLowerCase() !== args.channel_id.toLowerCase() ||
		result.channel.channelId.toLowerCase() !== args.channel_id.toLowerCase() ||
		result.attempt.idempotencyKey !== args.idempotency_key
	) {
		throw new Ap4mEvmOperationError('AP4M EVM reconciliation hash does not match', 'AP4M_EVM_INVALID_BINDING');
	}
	if (result.status === 'confirmed') {
		const evidence = result.settlementEvidence;
		if (
			!evidence || evidence.source !== 'verified-on-chain' ||
			!Hex32Schema.safeParse(evidence.claimId).success ||
			!Hex32Schema.safeParse(evidence.payoutTransactionHash).success ||
			!Hex32Schema.safeParse(evidence.payoutBlockHash).success ||
			!Number.isSafeInteger(evidence.payoutBlockNumber) || evidence.payoutBlockNumber < 1 ||
			!Number.isSafeInteger(evidence.confirmations) || evidence.confirmations < 1 ||
			!EvmAddressSchema.safeParse(evidence.recipient).success ||
			!EvmAddressSchema.safeParse(evidence.token).success ||
			evidence.recipient.toLowerCase() !== result.channel.payoutWallet.toLowerCase() ||
			evidence.token.toLowerCase() !== AP4M_EVM_EVENT_PROFILE.rlusdToken.toLowerCase() ||
			!PositiveUintSchema.safeParse(evidence.amountBaseUnits).success ||
			BigInt(evidence.amountBaseUnits) !== BigInt(result.attempt.nextCumulative) - BigInt(result.attempt.previousCumulative)
		) {
			throw new Ap4mEvmOperationError(
				'Confirmed AP4M EVM reconciliation requires verified payout and recipient evidence',
				'AP4M_EVM_UNSUPPORTED_EVIDENCE',
			);
		}
	}
	return result;
}

function validateStatus(result: Ap4mEvmStatusResult, principal: string, args: Ap4mEvmStatusArgs): Ap4mEvmStatusResult {
	if (
		(result.channel !== null && (
			result.channel.principal !== principal ||
			result.channel.channelId.toLowerCase() !== args.channel_id.toLowerCase()
		)) ||
		(result.attempt !== null && (
			result.attempt.principal !== principal ||
			result.attempt.channelId.toLowerCase() !== args.channel_id.toLowerCase() ||
			args.idempotency_key === undefined ||
			result.attempt.idempotencyKey !== args.idempotency_key
		))
	) {
		throw new Ap4mEvmOperationError(
			'AP4M EVM status service returned state outside the requested principal binding',
			'AP4M_EVM_INVALID_BINDING',
		);
	}
	return result;
}

async function prepareHandler(
	configuredServices: Ap4mEvmOperationServices | undefined,
	ctx: OpContext,
	args: Ap4mEvmPrepareApprovalArgs,
) {
	const services = operationServices(configuredServices);
	approvalWindow(args, services);
	const fingerprint = await requestFingerprint(ctx.principal, args);
	return validateApprovalBinding(
		await services.prepareApproval({ principal: ctx.principal, args, requestFingerprint: fingerprint }),
		ctx.principal,
		args,
		fingerprint,
	);
}

async function bindVoucherHandler(
	configuredServices: Ap4mEvmOperationServices | undefined,
	ctx: OpContext,
	args: Ap4mEvmBindVoucherArgs,
) {
	const services = operationServices(configuredServices);
	return await validateBoundRedemption(
		await services.bindVoucher({ principal: ctx.principal, args }),
		ctx.principal,
		args,
		services,
	);
}

async function recordSubmissionHandler(
	configuredServices: Ap4mEvmOperationServices | undefined,
	ctx: OpContext,
	args: Ap4mEvmRecordSubmissionArgs,
) {
	const result = await operationServices(configuredServices).recordSubmission({ principal: ctx.principal, args });
	if (
		result.txHash.toLowerCase() !== args.tx_hash.toLowerCase() ||
		result.attempt.txHash?.toLowerCase() !== args.tx_hash.toLowerCase() ||
		result.attempt.principal !== ctx.principal ||
		result.attempt.channelId.toLowerCase() !== args.channel_id.toLowerCase() ||
		result.attempt.idempotencyKey !== args.idempotency_key
	) {
		throw new Ap4mEvmOperationError('Recorded AP4M EVM submission does not match the approved hash', 'AP4M_EVM_INVALID_BINDING');
	}
	return result;
}

async function reconcileHandler(
	configuredServices: Ap4mEvmOperationServices | undefined,
	ctx: OpContext,
	args: Ap4mEvmReconcileArgs,
) {
	return validateReconciliation(
		await operationServices(configuredServices).reconcile({ principal: ctx.principal, args }),
		ctx.principal,
		args,
	);
}

async function statusHandler(
	configuredServices: Ap4mEvmOperationServices | undefined,
	ctx: OpContext,
	args: Ap4mEvmStatusArgs,
) {
	return validateStatus(
		await operationServices(configuredServices).status({ principal: ctx.principal, args }),
		ctx.principal,
		args,
	);
}

/** The generated registry sees only this inert, fail-closed operation set. */
export const ops: OpDef[] = [
	{
		name: 'ap4m.evmPrepareApproval',
		family: 'ap4m',
		summary: 'Prepare a short-lived, exact owner-wallet approval for one XRPL EVM Testnet voucher redemption.',
		tags: ['ap4m', 'evm', 'approval', 'rlusd', 'testnet'],
		args: Ap4mEvmPrepareApprovalArgsSchema,
		returns: 'an exact typed-data and transaction expectation; never a signature or submitted transaction',
		caveats: [],
		example: 'await harbor.ap4m.evmPrepareApproval({ profile, channel_id, roles, generation, cap_base_units, previous_cumulative, next_cumulative, idempotency_key, channel_valid_after, channel_valid_before, approval_expires_at, fee_model, max_gas_price, max_gas_limit, voucher_typed_data })',
		handler: (ctx, rawArgs) => prepareHandler(undefined, ctx, rawArgs as Ap4mEvmPrepareApprovalArgs),
	},
	{
		name: 'ap4m.evmBindVoucher',
		family: 'ap4m',
		summary: 'Validate an explicit owner-wallet voucher signature and bind it to one exact prepared redemption.',
		tags: ['ap4m', 'evm', 'approval', 'signature', 'rlusd', 'testnet'],
		args: Ap4mEvmBindVoucherArgsSchema,
		returns: 'the exact decoded redemption transaction after signer recovery and fee-bound validation',
		caveats: [],
		example: 'await harbor.ap4m.evmBindVoucher({ approval_id, channel_id, idempotency_key, voucher_signature })',
		handler: (ctx, rawArgs) => bindVoucherHandler(undefined, ctx, rawArgs as Ap4mEvmBindVoucherArgs),
	},
	{
		name: 'ap4m.evmRecordSubmission',
		family: 'ap4m',
		summary: 'Record a wallet-submitted voucher transaction as outcome-unknown for hash-based reconciliation.',
		tags: ['ap4m', 'evm', 'approval', 'reconciliation', 'testnet'],
		args: Ap4mEvmRecordSubmissionArgsSchema,
		returns: 'a durable reconciliation-required state; this operation never submits or retries a transaction',
		caveats: [],
		example: 'await harbor.ap4m.evmRecordSubmission({ approval_id, channel_id, idempotency_key, tx_hash })',
		handler: (ctx, rawArgs) => recordSubmissionHandler(undefined, ctx, rawArgs as Ap4mEvmRecordSubmissionArgs),
	},
	{
		name: 'ap4m.evmReconcile',
		family: 'ap4m',
		summary: 'Read chain evidence for an already-recorded voucher transaction without resubmitting it.',
		tags: ['ap4m', 'evm', 'reconciliation', 'settlement', 'testnet', 'read'],
		args: Ap4mEvmReconcileArgsSchema,
		returns: 'pending, failed-absent, or confirmed only with verified voucher and merchant-payout evidence',
		caveats: [],
		example: 'await harbor.ap4m.evmReconcile({ approval_id, channel_id, idempotency_key, tx_hash })',
		handler: (ctx, rawArgs) => reconcileHandler(undefined, ctx, rawArgs as Ap4mEvmReconcileArgs),
	},
	{
		name: 'ap4m.evmStatus',
		family: 'ap4m',
		summary: 'Read durable AP4M EVM channel or voucher-attempt state without performing an effect.',
		tags: ['ap4m', 'evm', 'channel', 'status', 'testnet', 'read'],
		args: Ap4mEvmStatusArgsSchema,
		returns: 'the principal-scoped durable channel and optional attempt state',
		caveats: [],
		example: 'await harbor.ap4m.evmStatus({ channel_id, idempotency_key })',
		handler: (ctx, rawArgs) => statusHandler(undefined, ctx, rawArgs as Ap4mEvmStatusArgs),
	},
	];

/**
 * Build an operation set around one reviewed event service. The dependency is
 * captured by the factory rather than discovered through global or request
 * state. The generated `ops` export above therefore remains inert.
 */
export function createAp4mEvmEventOps(
	configuredServices?: Ap4mEvmOperationServices,
): OpDef[] {
	return ops.map((definition) => {
		switch (definition.name) {
			case 'ap4m.evmPrepareApproval':
				return { ...definition, handler: (ctx, args) => prepareHandler(configuredServices, ctx, args as Ap4mEvmPrepareApprovalArgs) };
			case 'ap4m.evmBindVoucher':
				return { ...definition, handler: (ctx, args) => bindVoucherHandler(configuredServices, ctx, args as Ap4mEvmBindVoucherArgs) };
			case 'ap4m.evmRecordSubmission':
				return { ...definition, handler: (ctx, args) => recordSubmissionHandler(configuredServices, ctx, args as Ap4mEvmRecordSubmissionArgs) };
			case 'ap4m.evmReconcile':
				return { ...definition, handler: (ctx, args) => reconcileHandler(configuredServices, ctx, args as Ap4mEvmReconcileArgs) };
			case 'ap4m.evmStatus':
				return { ...definition, handler: (ctx, args) => statusHandler(configuredServices, ctx, args as Ap4mEvmStatusArgs) };
			default:
				throw new Error(`Unsupported AP4M EVM operation: ${definition.name}`);
		}
	});
}
