import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { D1WorkAgreementStore } from './exec/work-agreement-d1';
import { D1LocalMockWorkAgreementEffects } from './exec/work-agreement-mock-effects';
import {
	WORK_AGREEMENT_LOCAL_PROFILE,
	WorkAgreementRuntime,
	WorkAgreementRuntimeError,
	type WorkAgreementApproval,
	type WorkAgreementRecord,
	type WorkAgreementTerms,
} from './exec/work-agreement-runtime';
import { errorEnvelope, okEnvelope } from './guard';

export const WORK_AGREEMENT_OPERATION_NAMES = Object.freeze([
	'workAgreement.prepare',
	'workAgreement.submit',
	'workAgreement.recover',
	'workAgreement.reject',
	'workAgreement.status',
] as const);

type WorkAgreementOperationName = (typeof WORK_AGREEMENT_OPERATION_NAMES)[number];

export type WorkAgreementRouteEnvironment = Readonly<{
	HARBOR_LOCAL_DEV?: string;
	HARBOR_MOCK?: string;
	HARBOR_LOCAL_WORK_AGREEMENT_ENABLED?: string;
	EXEC_NETWORK?: string;
	MAINNET_EXECUTION?: string;
	HARBOR_SOURCE_TAG?: string;
}>;

export type WorkAgreementRouteContext = Readonly<{
	principal: string;
	localDevRequest: boolean;
	db: D1Database;
	env: WorkAgreementRouteEnvironment;
	workAgreementRuntime?: WorkAgreementRuntime;
}>;

const BODY_MAX_BYTES = 256 * 1024;
const MAX_APPROVAL_TTL_MS = 5 * 60_000;
const UINT32_MAX = 0xffff_ffff;
const IdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/);
const AddressSchema = z.string().regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/);
const HexBytesSchema = z.string().regex(/^(?:[A-Fa-f0-9]{2})+$/);
const BaseSchema = z.object({
	owner: AddressSchema,
	network: z.literal('testnet'),
	agreement_id: IdSchema,
}).strict();
const TermsSchema = z.object({
	counterparty: AddressSchema,
	amount_drops: z.string().regex(/^[1-9][0-9]{0,15}$/),
	finish_after: z.number().int().min(1).max(UINT32_MAX).optional(),
	cancel_after: z.number().int().min(1).max(UINT32_MAX).optional(),
	condition: HexBytesSchema.max(512).optional(),
}).strict().superRefine((terms, context) => {
	if (terms.finish_after === undefined && terms.cancel_after === undefined) {
		context.addIssue({ code: 'custom', message: 'At least one escrow time bound is required' });
	}
	if (terms.finish_after !== undefined && terms.cancel_after !== undefined &&
		terms.finish_after >= terms.cancel_after) {
		context.addIssue({ code: 'custom', message: 'finish_after must precede cancel_after' });
	}
	if (terms.condition !== undefined && terms.cancel_after === undefined) {
		context.addIssue({ code: 'custom', message: 'Conditioned escrow requires cancel_after' });
	}
});
const PrepareSchema = BaseSchema.extend({
	action: z.enum(['create', 'release', 'cancel']),
	idempotency_key: IdSchema,
	approval_expires_at: z.string().datetime(),
	terms: TermsSchema,
	fulfillment: HexBytesSchema.max(1_024).optional(),
}).strict();
const DecisionSchema = BaseSchema.extend({
	approval_id: IdSchema,
	idempotency_key: IdSchema,
}).strict();
const SubmitSchema = DecisionSchema.extend({
	attempt_id: IdSchema,
	signed_blob: z.string().min(2).max(20_000).regex(/^(?:[A-Fa-f0-9]{2})+$/),
}).strict();

const runtimeByDatabase = new WeakMap<object, Promise<WorkAgreementRuntime>>();

function enabled(context: WorkAgreementRouteContext): boolean {
	return context.localDevRequest === true && context.env.HARBOR_LOCAL_DEV === 'true' &&
		context.env.HARBOR_MOCK === '1' &&
		context.env.HARBOR_LOCAL_WORK_AGREEMENT_ENABLED === 'true' &&
		context.env.EXEC_NETWORK === 'testnet' && context.env.MAINNET_EXECUTION === 'false';
}

function hasExplicitPrincipal(context: WorkAgreementRouteContext): boolean {
	return context.principal !== 'local-dev' &&
		/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(context.principal);
}

function sourceTag(value: string | undefined): number {
	if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
		throw new WorkAgreementRuntimeError('INVALID_CONFIG', 'Work-agreement source tag is unavailable');
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > UINT32_MAX) {
		throw new WorkAgreementRuntimeError('INVALID_CONFIG', 'Work-agreement source tag is unavailable');
	}
	return parsed;
}

async function createLocalRuntime(context: WorkAgreementRouteContext): Promise<WorkAgreementRuntime> {
	const store = new D1WorkAgreementStore(context.db);
	const effects = new D1LocalMockWorkAgreementEffects(context.db);
	await Promise.all([store.initialize(), effects.initialize()]);
	return new WorkAgreementRuntime({ store, effects, enabled: true });
}

async function runtime(context: WorkAgreementRouteContext): Promise<WorkAgreementRuntime> {
	if (context.workAgreementRuntime) return context.workAgreementRuntime;
	const key = context.db as unknown as object;
	let current = runtimeByDatabase.get(key);
	if (!current) {
		current = createLocalRuntime(context);
		runtimeByDatabase.set(key, current);
	}
	return current;
}

function canonical(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	return `{${Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
		.join(',')}}`;
}

function approvalDigest(value: unknown): string {
	return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function memo(agreementId: string): readonly unknown[] {
	return [{ Memo: {
		MemoType: Buffer.from('pilot-work-agreement-v1', 'utf8').toString('hex').toUpperCase(),
		MemoData: Buffer.from(agreementId, 'utf8').toString('hex').toUpperCase(),
	} }];
}

function exactTerms(input: z.infer<typeof PrepareSchema>): WorkAgreementTerms {
	return {
		agreementId: input.agreement_id,
		owner: input.owner,
		counterparty: input.terms.counterparty,
		network: 'testnet',
		amountDrops: input.terms.amount_drops,
		...(input.terms.finish_after === undefined ? {} : { finishAfter: input.terms.finish_after }),
		...(input.terms.cancel_after === undefined ? {} : { cancelAfter: input.terms.cancel_after }),
		...(input.terms.condition === undefined ? {} : { condition: input.terms.condition.toUpperCase() }),
	};
}

function assertApprovalExpiry(value: string): void {
	const expiry = Date.parse(value);
	const now = Date.now();
	if (!Number.isFinite(expiry) || expiry <= now || expiry > now + MAX_APPROVAL_TTL_MS) {
		throw new WorkAgreementRuntimeError('INVALID_REQUEST', 'Approval expiry must be within five minutes');
	}
}

function prepareApproval(
	input: z.infer<typeof PrepareSchema>,
	terms: WorkAgreementTerms,
	tag: number,
	current: WorkAgreementRecord | null,
): WorkAgreementApproval {
	assertApprovalExpiry(input.approval_expires_at);
	if (input.action !== 'release' && input.fulfillment !== undefined) {
		throw new WorkAgreementRuntimeError('INVALID_REQUEST', `${input.action} cannot include a fulfillment`);
	}
	if (input.action === 'release') {
		if (terms.condition === undefined && input.fulfillment !== undefined) {
			throw new WorkAgreementRuntimeError('INVALID_REQUEST', 'Time-based release cannot include a fulfillment');
		}
		if (terms.condition !== undefined && input.fulfillment === undefined) {
			throw new WorkAgreementRuntimeError('INVALID_REQUEST', 'Conditioned release requires a fulfillment');
		}
	}
	const validatedLedgerIndex = input.action === 'create' ? 1_000 : 1_020;
	const validatedAccountSequence = input.action === 'create' ? 42 : 43;
	const common = {
		Account: terms.owner,
		Fee: '12',
		Sequence: validatedAccountSequence,
		LastLedgerSequence: validatedLedgerIndex + 30,
		SourceTag: tag,
		Memos: memo(terms.agreementId),
	};
	let txJson: Record<string, unknown>;
	if (input.action === 'create') {
		txJson = {
			TransactionType: 'EscrowCreate', ...common,
			Destination: terms.counterparty, Amount: terms.amountDrops,
			...(terms.finishAfter === undefined ? {} : { FinishAfter: terms.finishAfter }),
			...(terms.cancelAfter === undefined ? {} : { CancelAfter: terms.cancelAfter }),
			...(terms.condition === undefined ? {} : { Condition: terms.condition }),
		};
	} else {
		if (current?.status !== 'active' || current.offerSequence === undefined) {
			throw new WorkAgreementRuntimeError('INVALID_STATE', 'Agreement must be active before a terminal action');
		}
		txJson = input.action === 'release'
			? {
				TransactionType: 'EscrowFinish', ...common,
				Owner: terms.owner, OfferSequence: current.offerSequence,
				...(terms.condition === undefined ? {} : {
					Condition: terms.condition, Fulfillment: input.fulfillment!.toUpperCase(),
				}),
			}
			: {
				TransactionType: 'EscrowCancel', ...common,
				Owner: terms.owner, OfferSequence: current.offerSequence,
			};
	}
	const semantic = {
		version: 1, action: input.action, terms,
		idempotency_key: input.idempotency_key,
		approval_expires_at: input.approval_expires_at,
		...(input.fulfillment === undefined ? {} : { fulfillment: input.fulfillment.toUpperCase() }),
		tx_json: txJson,
	};
	const digest = approvalDigest(semantic);
	return {
		action: input.action,
		approvalId: `agreement-approval-${digest.slice(0, 40)}`,
		expiresAt: input.approval_expires_at,
		execution: {
			build_id: `agreement-build-${digest.slice(0, 40)}`,
			idempotency_key: input.idempotency_key,
			require_owner_approval: true,
		},
		validatedLedgerIndex,
		validatedAccountSequence,
		maxFeeDrops: '100',
		txJson,
	};
}

function publicEvidence(evidence: WorkAgreementRecord['createEvidence']): Record<string, unknown> | undefined {
	return evidence === undefined ? undefined : {
		approval_id: evidence.approvalId,
		tx_hash: evidence.hash,
		validated_ledger_index: evidence.ledgerIndex,
		validated: true,
		engine_result: evidence.engineResult,
		tx_json: evidence.txJson,
	};
}

function publicRecord(record: WorkAgreementRecord): Record<string, unknown> {
	const approval = record.approval === undefined ? undefined : {
		action: record.approval.action,
		approval_id: record.approval.approvalId,
		expires_at: record.approval.expiresAt,
		idempotency_key: record.approval.execution.idempotency_key,
		require_owner_approval: true,
		validated_ledger_index: record.approval.validatedLedgerIndex,
		validated_account_sequence: record.approval.validatedAccountSequence,
		max_fee_drops: record.approval.maxFeeDrops,
		tx_json: record.approval.txJson,
	};
	const createEvidence = publicEvidence(record.createEvidence);
	const terminalEvidence = publicEvidence(record.terminalEvidence);
	return {
		profile: record.profile,
		status: record.status,
		revision: record.revision,
		simulation: true,
		settlement_provenance: 'local-mock-simulated-settlement',
		live_validation_claimed: false,
		physical_device_inferred: false,
		speculos_conformance_claimed: false,
		owner_key_custody: false,
		network_requests_made: 0,
		agreement_id: record.terms.agreementId,
		owner: record.terms.owner,
		network: record.terms.network,
		terms: {
			counterparty: record.terms.counterparty,
			amount_drops: record.terms.amountDrops,
			...(record.terms.finishAfter === undefined ? {} : { finish_after: record.terms.finishAfter }),
			...(record.terms.cancelAfter === undefined ? {} : { cancel_after: record.terms.cancelAfter }),
			...(record.terms.condition === undefined ? {} : { condition: record.terms.condition }),
		},
		...(record.action === undefined ? {} : { action: record.action }),
		...(approval === undefined ? {} : { approval }),
		...(record.attemptId === undefined ? {} : { attempt_id: record.attemptId }),
		...(record.expectedHash === undefined ? {} : { tx_hash: record.expectedHash }),
		...(record.offerSequence === undefined ? {} : { offer_sequence: record.offerSequence }),
		...(createEvidence === undefined ? {} : { create_evidence: createEvidence }),
		...(terminalEvidence === undefined ? {} : { terminal_evidence: terminalEvidence }),
		...(record.lastResolution === undefined ? {} : {
			last_resolution: {
				approval_id: record.lastResolution.approvalId,
				idempotency_key: record.lastResolution.idempotencyKey,
				action: record.lastResolution.action,
				outcome: record.lastResolution.outcome,
			},
		}),
		created_at: record.createdAt,
		updated_at: record.updatedAt,
	};
}

async function boundedBody(request: Request): Promise<unknown> {
	const declared = request.headers.get('content-length');
	if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > BODY_MAX_BYTES)) {
		throw new WorkAgreementRuntimeError('INVALID_REQUEST', 'Work-agreement request body is too large');
	}
	const bytes = new Uint8Array(await request.arrayBuffer());
	if (bytes.byteLength > BODY_MAX_BYTES) {
		throw new WorkAgreementRuntimeError('INVALID_REQUEST', 'Work-agreement request body is too large');
	}
	return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown;
}

function json(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

function operationName(pathname: string): WorkAgreementOperationName | undefined {
	if (!pathname.startsWith('/api/ops/')) return undefined;
	const name = pathname.slice('/api/ops/'.length);
	return (WORK_AGREEMENT_OPERATION_NAMES as readonly string[]).includes(name)
		? name as WorkAgreementOperationName
		: undefined;
}

/** Return undefined when the request is not a local work-agreement operation. */
export async function handleWorkAgreementRoute(
	request: Request,
	context: WorkAgreementRouteContext,
): Promise<Response | undefined> {
	const name = operationName(new URL(request.url).pathname);
	if (!name) return undefined;
	if (!hasExplicitPrincipal(context)) {
		return json(errorEnvelope(name, new Error('Work agreement requires authentication'), {
			code: 'UNAUTHORIZED',
		}), 401);
	}
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
	}
	if (!enabled(context)) {
		return json(errorEnvelope(name, new Error('Local work agreements are unavailable'), {
			code: 'WORK_AGREEMENT_DISABLED',
		}), 404);
	}
	try {
		const body = await boundedBody(request);
		// Validate the complete operation shape before initializing any durable
		// tables so malformed or widened requests remain side-effect free.
		if (name === 'workAgreement.prepare') PrepareSchema.parse(body);
		else if (name === 'workAgreement.submit') SubmitSchema.parse(body);
		else if (name === 'workAgreement.status') BaseSchema.parse(body);
		else DecisionSchema.parse(body);
		const service = await runtime(context);
		let record: WorkAgreementRecord;
		let outcome: string;
		if (name === 'workAgreement.prepare') {
			const input = PrepareSchema.parse(body);
			const terms = exactTerms(input);
			const current = await service.get({ principal: context.principal, agreementId: input.agreement_id });
			const approval = prepareApproval(input, terms, sourceTag(context.env.HARBOR_SOURCE_TAG), current);
			({ record, outcome } = await service.prepare({ principal: context.principal, terms, approval }));
		} else if (name === 'workAgreement.submit') {
			const input = SubmitSchema.parse(body);
			({ record, outcome } = await service.submit({
				principal: context.principal,
				agreementId: input.agreement_id,
				owner: input.owner,
				network: input.network,
				approvalId: input.approval_id,
				idempotencyKey: input.idempotency_key,
				attemptId: input.attempt_id,
				signedBlob: input.signed_blob,
			}));
		} else if (name === 'workAgreement.status') {
			const input = BaseSchema.parse(body);
			const found = await service.get({ principal: context.principal, agreementId: input.agreement_id });
			if (found === null || found.terms.owner !== input.owner || found.terms.network !== input.network) {
				throw new WorkAgreementRuntimeError('AGREEMENT_NOT_FOUND', 'Agreement was not found');
			}
			record = found;
			outcome = 'status';
		} else {
			const input = DecisionSchema.parse(body);
			const decision = {
				principal: context.principal,
				agreementId: input.agreement_id,
				owner: input.owner,
				network: input.network,
				approvalId: input.approval_id,
				idempotencyKey: input.idempotency_key,
			};
			({ record, outcome } = name === 'workAgreement.reject'
				? await service.reject(decision)
				: await service.recover(decision));
		}
		return json(okEnvelope({ ...publicRecord(record), outcome }, {
			asOf: record.updatedAt,
			asOfBasis: 'local-mock-work-agreement',
		}));
	} catch (error) {
		const code = error instanceof WorkAgreementRuntimeError
			? error.code
			: error instanceof z.ZodError || error instanceof SyntaxError
				? 'INVALID_INPUT'
				: 'WORK_AGREEMENT_OPERATION_FAILED';
		return json(errorEnvelope(name, new Error(code), { code }));
	}
}

export { WORK_AGREEMENT_LOCAL_PROFILE };
