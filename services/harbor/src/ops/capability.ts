import { isValidClassicAddress } from 'xrpl';
import { z } from 'zod';

import type { OpContext, OpDef } from '../catalog/registry';
import {
	CapabilityAdapterRegistry,
	CapabilityBroker,
	type CapabilityBrokerOptions,
	type CapabilityGrantView,
	type CapabilityServiceAdapter,
} from '../exec/capability-broker';
import { MockCapabilitySecretStore } from '../exec/capability-mock-secret-store';
import { buildCapabilityOwnerReview, verifyCapabilityOwnerProof } from '../exec/capability-owner-proof';
import {
	D1CapabilitySnapshotStore,
	type CapabilitySnapshotStore,
} from '../exec/capability-snapshot-store';

const SERVICE = 'mock.catalog';
const OPERATION = 'read';
const DESTINATION = 'local-fixture-catalog';
const SECRET_HANDLE = 'public-default-fixture';
const PUBLIC_DEFAULT_SECRET = 'public-default-simulated-noncredential';
const PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REFERENCE = /^cap_v1_[A-Za-z0-9_-]{32,128}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{32,128}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export const CAPABILITY_OPERATION_NAMES = Object.freeze([
	'capability.activate',
	'capability.invoke',
	'capability.prepare',
	'capability.prepareRevoke',
	'capability.revoke',
	'capability.status',
] as const);

const AccountSchema = z.string().refine(isValidClassicAddress, 'account must be a valid XRPL classic address');
const ScopeSchema = z.object({ account: AccountSchema, network: z.literal('testnet') }).strict();
const AmountSchema = z.object({ unit: z.literal('request'), value: z.literal('1') }).strict();
const RateSchema = z.object({
	window_seconds: z.number().int().min(1).max(3_600),
	max_calls: z.number().int().min(1).max(100),
}).strict();
const ProofSchema = z.object({
	nonce: z.string().regex(NONCE),
	approved_at: z.string().datetime(),
	expires_at: z.string().datetime(),
	tx_blob: z.string().regex(/^[A-Fa-f0-9]+$/).max(16_384),
}).strict();

export const CapabilityPrepareArgsSchema = ScopeSchema.extend({
	service: z.literal(SERVICE),
	operation: z.literal(OPERATION),
	amount: AmountSchema,
	destination: z.literal(DESTINATION),
	not_before: z.string().datetime(),
	expires_at: z.string().datetime(),
	max_uses: z.number().int().min(1).max(100),
	rate_limit: RateSchema,
}).strict();

export const CapabilityActivateArgsSchema = ScopeSchema.extend({
	capability_ref: z.string().regex(REFERENCE),
	generation: z.literal(1),
	approval_digest: z.string().regex(DIGEST),
	owner_proof: ProofSchema,
}).strict();

export const CapabilityStatusArgsSchema = ScopeSchema.extend({
	capability_ref: z.string().regex(REFERENCE),
}).strict();

export const CapabilityPrepareRevokeArgsSchema = CapabilityStatusArgsSchema.extend({
	request_id: z.string().regex(REQUEST_ID),
}).strict();

export const CapabilityRevokeArgsSchema = ScopeSchema.extend({
	capability_ref: z.string().regex(REFERENCE),
	generation: z.number().int().min(2),
	approval_digest: z.string().regex(DIGEST),
	owner_proof: ProofSchema,
}).strict();

export const CapabilityInvokeArgsSchema = ScopeSchema.extend({
	capability_ref: z.string().regex(REFERENCE),
	generation: z.number().int().min(1),
	request_id: z.string().regex(REQUEST_ID),
	service: z.literal(SERVICE),
	operation: z.literal(OPERATION),
	amount: AmountSchema,
	destination: z.literal(DESTINATION),
	input: z.object({ resource: z.enum(['ledger-docs', 'market-fixture']) }).strict(),
}).strict();

export interface CapabilityOperationServices {
	enabled: boolean;
	store: CapabilitySnapshotStore;
	resolver?: CapabilityBrokerOptions['resolver'];
	registry?: CapabilityAdapterRegistry;
	now?: () => Date;
	randomReference?: () => string;
}

type CapabilityContext = OpContext & {
	db?: D1Database;
	env?: Record<string, unknown>;
	localDevRequest?: boolean;
	capabilityServices?: CapabilityOperationServices;
};

function mockAdapter(): CapabilityServiceAdapter<{ resource: 'ledger-docs' | 'market-fixture' }> {
	return Object.freeze<CapabilityServiceAdapter<{ resource: 'ledger-docs' | 'market-fixture' }>>({
		service: SERVICE,
		operation: OPERATION,
		parseInput(value: unknown) {
			return CapabilityInvokeArgsSchema.shape.input.parse(value);
		},
		parseOutput(value: unknown) {
			return z.object({
				resource: z.enum(['ledger-docs', 'market-fixture']),
				entries: z.array(z.enum(['payments', 'escrow', 'dex', 'amm'])).max(2),
				simulated: z.literal(true),
			}).strict().parse(value);
		},
		async dispatch({ input }) {
			return {
				outcome: 'completed' as const,
				data: input.resource === 'ledger-docs'
					? { resource: input.resource, entries: ['payments', 'escrow'], simulated: true }
					: { resource: input.resource, entries: ['dex', 'amm'], simulated: true },
			};
		},
	});
}

function hasConfiguredPrincipal(value: unknown, principal: string): boolean {
	if (typeof value !== 'string') return false;
	return value.split(',').some((pair) => {
		const separator = pair.indexOf(':');
		return separator > 0 && separator < pair.length - 1 && pair.slice(0, separator) === principal;
	});
}

function localServices(ctx: OpContext): CapabilityOperationServices | undefined {
	const typed = ctx as CapabilityContext;
	if (typed.capabilityServices) return typed.capabilityServices;
	const env = typed.env;
	if (!env || typed.localDevRequest !== true || env.HARBOR_LOCAL_CAPABILITY_RUNTIME_ENABLED !== 'true' ||
		env.HARBOR_LOCAL_DEV !== 'true' || env.HARBOR_MOCK !== '1' || env.EXEC_NETWORK !== 'testnet' ||
		env.MAINNET_EXECUTION !== 'false' || !typed.db || !hasConfiguredPrincipal(env.HARBOR_API_KEYS, ctx.principal)) return undefined;
	return {
		enabled: true,
		store: new D1CapabilitySnapshotStore(typed.db),
		resolver: new MockCapabilitySecretStore({ [SECRET_HANDLE]: PUBLIC_DEFAULT_SECRET }),
		registry: new CapabilityAdapterRegistry([mockAdapter()]),
	};
}

function services(ctx: OpContext): CapabilityOperationServices {
	const configured = localServices(ctx);
	if (!configured?.enabled) throw new Error('Capability broker is disabled');
	if (!PRINCIPAL.test(ctx.principal) || ctx.principal === 'local-dev') {
		throw new Error('Capability principal must be explicitly authenticated');
	}
	return configured;
}

async function withBroker<T>(ctx: OpContext, operation: (
	broker: CapabilityBroker,
	service: CapabilityOperationServices,
) => Promise<T> | T): Promise<T> {
	const configured = services(ctx);
	return configured.store.transaction(ctx.principal, async (snapshot, checkpoint) => {
		let broker!: CapabilityBroker;
		broker = new CapabilityBroker({
			mode: 'mock',
			resolver: configured.resolver ?? new MockCapabilitySecretStore({ [SECRET_HANDLE]: PUBLIC_DEFAULT_SECRET }),
			registry: configured.registry ?? new CapabilityAdapterRegistry([mockAdapter()]),
			now: configured.now,
			randomReference: configured.randomReference,
			checkpoint: () => checkpoint(broker.snapshot()),
			...(snapshot === undefined ? {} : { snapshot }),
		});
		const result = await operation(broker, configured);
		return { snapshot: broker.snapshot(), result };
	});
}

function ownerReview(review: ReturnType<typeof buildCapabilityOwnerReview>) {
	return {
		action: review.action,
		capability_ref: review.capabilityRef,
		network: review.network,
		generation: review.generation,
		approval_digest: review.approvalDigest,
		nonce: review.nonce,
		approved_at: review.approvedAt,
		expires_at: review.expiresAt,
		tx_json: review.txJson,
		verification_boundary: {
			signature_proves: 'owner-key-control-only',
			runtime_provenance: 'not-authenticated-by-signed-blob',
			physical_device_inferred: false,
		},
	};
}

function reviewTtl(grant: CapabilityGrantView, now: Date): number {
	return Math.max(1, Math.min(60_000, Date.parse(grant.expiresAt) - now.getTime()));
}

export async function handleCapabilityPrepare(ctx: OpContext, raw: z.infer<typeof CapabilityPrepareArgsSchema>) {
	const args = CapabilityPrepareArgsSchema.parse(raw);
	return withBroker(ctx, async (broker, configured) => {
		const grant = await broker.prepareGrant({
			principal: ctx.principal,
			account: args.account,
			network: args.network,
			service: args.service,
			operation: args.operation,
			amount: args.amount,
			destination: args.destination,
			notBefore: args.not_before,
			expiresAt: args.expires_at,
			maxUses: args.max_uses,
			rateLimit: { windowSeconds: args.rate_limit.window_seconds, maxCalls: args.rate_limit.max_calls },
		}, SECRET_HANDLE);
		const now = configured.now?.() ?? new Date();
		return {
			grant,
			owner_review: ownerReview(buildCapabilityOwnerReview({
				action: 'activate', account: args.account, network: args.network, capabilityRef: grant.capabilityRef,
				generation: grant.generation, approvalDigest: grant.approvalDigest,
			}, { now, ttlMs: reviewTtl(grant, now) })),
		};
	});
}

export async function handleCapabilityActivate(ctx: OpContext, raw: z.infer<typeof CapabilityActivateArgsSchema>) {
	const args = CapabilityActivateArgsSchema.parse(raw);
	return withBroker(ctx, async (broker, configured) => {
		const proof = args.owner_proof;
		const approval = await verifyCapabilityOwnerProof({
			action: 'activate', account: args.account, network: args.network, capabilityRef: args.capability_ref,
			generation: args.generation, approvalDigest: args.approval_digest,
			nonce: proof.nonce, approvedAt: proof.approved_at, expiresAt: proof.expires_at,
		}, proof.tx_blob, configured.now?.() ?? new Date());
		return broker.activateGrant(args.capability_ref, approval);
	});
}

export async function handleCapabilityStatus(ctx: OpContext, raw: z.infer<typeof CapabilityStatusArgsSchema>) {
	const args = CapabilityStatusArgsSchema.parse(raw);
	return withBroker(ctx, (broker) => broker.status(args.capability_ref, ctx.principal, args.account));
}

export async function handleCapabilityPrepareRevoke(ctx: OpContext, raw: z.infer<typeof CapabilityPrepareRevokeArgsSchema>) {
	const args = CapabilityPrepareRevokeArgsSchema.parse(raw);
	return withBroker(ctx, async (broker, configured) => {
		const grant = broker.status(args.capability_ref, ctx.principal, args.account);
		const prepared = await broker.prepareRevocation(args.capability_ref, ctx.principal, args.account);
		const now = configured.now?.() ?? new Date();
		return {
			request_id: args.request_id,
			owner_review: ownerReview(buildCapabilityOwnerReview({
				action: 'revoke', account: args.account, network: args.network, capabilityRef: args.capability_ref,
				generation: prepared.generation, approvalDigest: prepared.approvalDigest,
			}, { now, ttlMs: reviewTtl(grant, now) })),
		};
	});
}

export async function handleCapabilityRevoke(ctx: OpContext, raw: z.infer<typeof CapabilityRevokeArgsSchema>) {
	const args = CapabilityRevokeArgsSchema.parse(raw);
	return withBroker(ctx, async (broker, configured) => {
		const proof = args.owner_proof;
		const approval = await verifyCapabilityOwnerProof({
			action: 'revoke', account: args.account, network: args.network, capabilityRef: args.capability_ref,
			generation: args.generation, approvalDigest: args.approval_digest,
			nonce: proof.nonce, approvedAt: proof.approved_at, expiresAt: proof.expires_at,
		}, proof.tx_blob, configured.now?.() ?? new Date());
		return broker.revoke({
			capabilityRef: args.capability_ref, principal: ctx.principal, account: args.account,
			generation: args.generation, approvalDigest: args.approval_digest, approval,
		});
	});
}

export async function handleCapabilityInvoke(ctx: OpContext, raw: z.infer<typeof CapabilityInvokeArgsSchema>) {
	const args = CapabilityInvokeArgsSchema.parse(raw);
	return withBroker(ctx, (broker) => broker.invoke({
		capabilityRef: args.capability_ref,
		requestId: args.request_id,
		principal: ctx.principal,
		account: args.account,
		network: args.network,
		service: args.service,
		operation: args.operation,
		amount: args.amount,
		destination: args.destination,
		generation: args.generation,
		input: args.input,
	}));
}

export const ops: OpDef[] = [
	{ name: 'capability.prepare', family: 'capability', summary: 'Prepare a default-off local mock capability and exact owner review.', tags: ['capability', 'mock', 'local'], args: CapabilityPrepareArgsSchema, returns: 'a prepared capability and owner review payload', caveats: [], example: 'await harbor.capability.prepare({ account, network: "testnet", service: "mock.catalog", operation: "read", amount: { unit: "request", value: "1" }, destination: "local-fixture-catalog", not_before, expires_at, max_uses: 2, rate_limit: { window_seconds: 60, max_calls: 1 } })', handler: (ctx, args) => handleCapabilityPrepare(ctx, args as never) },
	{ name: 'capability.activate', family: 'capability', summary: 'Activate an exact local mock capability after owner signature verification.', tags: ['capability', 'approval', 'local'], args: CapabilityActivateArgsSchema, returns: 'the active capability view', caveats: [], example: 'await harbor.capability.activate({ account, network: "testnet", capability_ref, generation: 1, approval_digest, owner_proof })', handler: (ctx, args) => handleCapabilityActivate(ctx, args as never) },
	{ name: 'capability.status', family: 'capability', summary: 'Read one account-bound local mock capability.', tags: ['capability', 'read', 'local'], args: CapabilityStatusArgsSchema, returns: 'the safe capability view', caveats: [], example: 'await harbor.capability.status({ account, network: "testnet", capability_ref })', handler: (ctx, args) => handleCapabilityStatus(ctx, args as never) },
	{ name: 'capability.prepareRevoke', family: 'capability', summary: 'Prepare an exact owner-reviewed local capability revocation.', tags: ['capability', 'revoke', 'local'], args: CapabilityPrepareRevokeArgsSchema, returns: 'an exact owner review payload', caveats: [], example: 'await harbor.capability.prepareRevoke({ account, network: "testnet", capability_ref, request_id })', handler: (ctx, args) => handleCapabilityPrepareRevoke(ctx, args as never) },
	{ name: 'capability.revoke', family: 'capability', summary: 'Revoke an exact local capability after owner signature verification.', tags: ['capability', 'revoke', 'local'], args: CapabilityRevokeArgsSchema, returns: 'the revoked capability view', caveats: [], example: 'await harbor.capability.revoke({ account, network: "testnet", capability_ref, generation, approval_digest, owner_proof })', handler: (ctx, args) => handleCapabilityRevoke(ctx, args as never) },
	{ name: 'capability.invoke', family: 'capability', summary: 'Invoke one fixed local fixture adapter through an opaque scoped capability.', tags: ['capability', 'mock', 'local'], args: CapabilityInvokeArgsSchema, returns: 'an idempotent completed or unknown result', caveats: [], example: 'await harbor.capability.invoke({ account, network: "testnet", capability_ref, generation, request_id, service: "mock.catalog", operation: "read", amount: { unit: "request", value: "1" }, destination: "local-fixture-catalog", input: { resource: "ledger-docs" } })', handler: (ctx, args) => handleCapabilityInvoke(ctx, args as never) },
];
