import { isValidClassicAddress } from 'xrpl';
import { z } from 'zod';

import { requestXrpl, XrplRpcError } from '../adapters/xrpl-rpc';
import type { OpContext, OpDef } from '../catalog/registry';
import { MandateSchema, type Mandate, type Merchant } from '../contracts';
import {
	D1ChannelClaimStore,
	type ChannelClaimRow,
	type ChannelClaimStore,
} from '../exec/channel-claim-store';
import { MandateStore, type StoredMandate } from '../exec/mandate-store';
import { getCatalogMerchant } from './merchants';

type JsonObject = Record<string, unknown>;

const ChannelIdSchema = z.string().regex(/^[A-Fa-f0-9]{64}$/).transform((value) => value.toUpperCase());
const MandateIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const ChannelStatusArgsSchema = z.object({ channel_id: ChannelIdSchema }).strict();
export const ChannelListArgsSchema = z.object({ mandate_id: MandateIdSchema }).strict();

export interface ChannelLedgerStatus {
	channel_id: string;
	account: string;
	destination: string;
	amount_drops: string;
	balance_drops: string;
	public_key: string;
	settle_delay_seconds: number;
	ledger_index: number;
	expiration_ripple?: number;
	cancel_after_ripple?: number;
}

export interface ChannelLocalStatus {
	highest_claim_drops: string;
	has_pending_claim: boolean;
	updated_at?: string;
}

export interface ChannelStatusResult {
	mandate_id: string;
	merchant_id: string;
	channel_id: string;
	amount_drops: string;
	ledger: ChannelLedgerStatus;
	local: ChannelLocalStatus;
}

export interface ChannelListItem {
	mandate_id: string;
	merchant_id: string;
	channel_id: string;
	amount_drops: string;
	local: ChannelLocalStatus;
}

type ClaimReader = Pick<ChannelClaimStore, 'get' | 'list'>;

export interface ChannelServices {
	store?: ClaimReader;
	getMandate?(ctx: OpContext, mandateId: string): Promise<StoredMandate | null>;
	findMandateByChannel?(ctx: OpContext, channelId: string): Promise<StoredMandate | null>;
	readLedgerChannel?(ctx: OpContext, channelId: string): Promise<ChannelLedgerStatus | null>;
	getMerchant?(merchantId: string): Merchant | undefined;
}

type ChannelContext = OpContext & {
	db?: D1Database;
	env?: unknown;
	channelServices?: ChannelServices;
};

function record(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function database(ctx: OpContext): D1Database {
	const typed = ctx as ChannelContext;
	const nested = record(typed.env) ? typed.env.DB : undefined;
	const db = typed.db ?? nested;
	if (!db || typeof db !== 'object') throw new Error('channel store is not configured');
	return db as D1Database;
}

function configured(ctx: OpContext): ChannelServices {
	return (ctx as ChannelContext).channelServices ?? {};
}

function claimStore(ctx: OpContext, services: ChannelServices): ClaimReader {
	return services.store ?? new D1ChannelClaimStore(database(ctx), ctx.principal);
}

async function localMandate(ctx: OpContext, id: string): Promise<StoredMandate | null> {
	return new MandateStore(database(ctx), ctx.principal).get(id);
}

async function localMandateByChannel(ctx: OpContext, channelId: string): Promise<StoredMandate | null> {
	const db = database(ctx);
	const result = await db.prepare(
		`SELECT id, channels_json FROM ap4m_mandates
		 WHERE principal = ? ORDER BY id LIMIT 257`,
	).bind(ctx.principal).all<{ id: string; channels_json: string }>();
	const rows = result.results ?? [];
	if (rows.length > 256) throw new Error('channel mandate lookup exceeded the bounded scan');
	const matches: string[] = [];
	for (const row of rows) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(row.channels_json);
		} catch {
			throw new Error('stored mandate channels are invalid');
		}
		const channels = MandateSchema.shape.channels.parse(parsed);
		if (channels.some((channel) => channel.channel_id.toUpperCase() === channelId)) matches.push(row.id);
	}
	if (matches.length > 1) throw new Error('channel is bound to multiple mandates');
	return matches.length === 0 ? null : new MandateStore(db, ctx.principal).get(matches[0]!);
}

function canonicalDrops(value: unknown, field: string, allowZero: boolean): string {
	if (typeof value !== 'string' || value.length > 18 || !/^(?:0|[1-9]\d*)$/.test(value)) {
		throw new Error(`validated payment channel ${field} is invalid`);
	}
	const drops = BigInt(value);
	if (drops > 100_000_000_000_000_000n || (!allowZero && drops === 0n)) {
		throw new Error(`validated payment channel ${field} is invalid`);
	}
	return value;
}

function uint32(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 0xffff_ffff) {
		throw new Error(`validated payment channel ${field} is invalid`);
	}
	return Number(value);
}

function normalizeLedgerStatus(response: JsonObject, expectedId: string): ChannelLedgerStatus {
	const node = response.node;
	const index = response.index;
	const ledgerIndex = response.ledger_index;
	if (
		response.validated !== true ||
		!record(node) ||
		node.LedgerEntryType !== 'PayChannel' ||
		typeof index !== 'string' ||
		index.toUpperCase() !== expectedId ||
		!Number.isSafeInteger(ledgerIndex) ||
		Number(ledgerIndex) < 1 ||
		typeof node.Account !== 'string' ||
		!isValidClassicAddress(node.Account) ||
		typeof node.Destination !== 'string' ||
		!isValidClassicAddress(node.Destination) ||
		typeof node.PublicKey !== 'string' ||
		!/^(?:ED|02|03)[A-Fa-f0-9]{64}$/.test(node.PublicKey)
	) {
		throw new Error('validated payment channel evidence is malformed');
	}
	const amount = canonicalDrops(node.Amount, 'amount', false);
	const balance = canonicalDrops(node.Balance, 'balance', true);
	if (BigInt(balance) > BigInt(amount)) {
		throw new Error('validated payment channel balance exceeds its amount');
	}
	const expiration = node.Expiration === undefined
		? undefined
		: uint32(node.Expiration, 'expiration');
	const cancelAfter = node.CancelAfter === undefined
		? undefined
		: uint32(node.CancelAfter, 'cancel-after');
	return {
		channel_id: expectedId,
		account: node.Account,
		destination: node.Destination,
		amount_drops: amount,
		balance_drops: balance,
		public_key: node.PublicKey.toUpperCase(),
		settle_delay_seconds: uint32(node.SettleDelay, 'settle delay'),
		ledger_index: Number(ledgerIndex),
		...(expiration === undefined ? {} : { expiration_ripple: expiration }),
		...(cancelAfter === undefined ? {} : { cancel_after_ripple: cancelAfter }),
	};
}

/**
 * Read a validated PaymentChannel ledger object by its exact index.
 * Selector and object fields follow:
 * https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/ledger-methods/ledger_entry#get-payment-channel-entry
 */
export async function readChannelLedgerStatus(
	ctx: OpContext,
	channelId: string,
): Promise<ChannelLedgerStatus | null> {
	try {
		const response = await requestXrpl(ctx, 'testnet', 'ledger_entry', {
			ledger_index: 'validated',
			payment_channel: channelId,
		});
		return normalizeLedgerStatus(response, channelId);
	} catch (error) {
		if (error instanceof XrplRpcError && error.kind === 'soft-empty') return null;
		throw error;
	}
}

function localStatus(row: ChannelClaimRow | null): ChannelLocalStatus {
	return {
		highest_claim_drops: row?.cumulativeDrops ?? '0',
		has_pending_claim: row?.pendingIdempotencyKey !== null && row?.pendingIdempotencyKey !== undefined,
		...(row ? { updated_at: row.updatedAt } : {}),
	};
}

function mandateChannel(mandate: Mandate, channelId: string): Mandate['channels'][number] {
	const matches = mandate.channels.filter((channel) => channel.channel_id.toUpperCase() === channelId);
	if (matches.length !== 1) throw new Error('channel is not uniquely bound to the mandate');
	return matches[0]!;
}

function claimPublicKey(mandate: StoredMandate, merchantId: string): string {
	const matches = mandate.claimPublicKeys.filter((key) => key.merchant_id === merchantId);
	if (matches.length !== 1 || !/^(?:ED|02|03)[A-Fa-f0-9]{64}$/.test(matches[0]!.public_key)) {
		throw new Error('mandate claim key is not uniquely configured for the merchant');
	}
	return matches[0]!.public_key.toUpperCase();
}

export async function handleChannelStatus(
	ctx: OpContext,
	raw: z.input<typeof ChannelStatusArgsSchema>,
): Promise<ChannelStatusResult> {
	const { channel_id: channelId } = ChannelStatusArgsSchema.parse(raw);
	const services = configured(ctx);
	const [stored, ledger, mandate] = await Promise.all([
		claimStore(ctx, services).get(channelId),
		(services.readLedgerChannel ?? readChannelLedgerStatus)(ctx, channelId),
		(services.findMandateByChannel ?? localMandateByChannel)(ctx, channelId),
	]);
	if (!mandate) throw new Error('payment channel is not bound to this principal');
	const channel = mandateChannel(mandate.mandate, channelId);
	if (!ledger) throw new Error('payment channel is not present in the validated ledger');
	const merchant = (services.getMerchant ?? getCatalogMerchant)(channel.merchant_id);
	if (!merchant || merchant.id !== channel.merchant_id || merchant.network !== 'testnet') {
		throw new Error('payment channel merchant is not configured for Testnet');
	}
	const expectedPublicKey = claimPublicKey(mandate, merchant.id);
	if (
		ledger.channel_id !== channelId ||
		ledger.account !== mandate.mandate.owner ||
		ledger.destination !== merchant.xrpl_address ||
		ledger.amount_drops !== channel.amount_drops ||
		ledger.public_key !== expectedPublicKey ||
		ledger.settle_delay_seconds < 1 ||
		BigInt(ledger.balance_drops) > BigInt(stored?.cumulativeDrops ?? '0') ||
		(stored !== null && (
			stored.mandateId !== mandate.mandate.id ||
			stored.merchantId !== merchant.id ||
			stored.channelAmountDrops !== channel.amount_drops ||
			stored.channelId !== channelId ||
			stored.payer !== mandate.mandate.owner ||
			stored.publicKey !== expectedPublicKey
		))
	) {
		throw new Error('payment channel evidence conflicts with durable mandate state');
	}
	return {
		mandate_id: mandate.mandate.id,
		merchant_id: merchant.id,
		channel_id: channelId,
		amount_drops: channel.amount_drops,
		ledger,
		local: localStatus(stored),
	};
}

export async function handleChannelList(
	ctx: OpContext,
	raw: z.input<typeof ChannelListArgsSchema>,
): Promise<ChannelListItem[]> {
	const { mandate_id: mandateId } = ChannelListArgsSchema.parse(raw);
	const services = configured(ctx);
	const [mandate, claims] = await Promise.all([
		(services.getMandate ?? localMandate)(ctx, mandateId),
		claimStore(ctx, services).list(mandateId),
	]);
	if (!mandate) throw new Error('mandate not found');
	const byChannel = new Map(claims.map((row) => [row.channelId, row]));
	if (byChannel.size !== claims.length) throw new Error('duplicate local channel claim state');
	const seenChannels = new Set<string>();
	const seenMerchants = new Set<string>();
	const items = mandate.mandate.channels.map((channel): ChannelListItem => {
		const id = ChannelIdSchema.parse(channel.channel_id);
		const merchant = (services.getMerchant ?? getCatalogMerchant)(channel.merchant_id);
		const channelAmount = canonicalDrops(channel.amount_drops, 'amount', false);
		if (
			!merchant || merchant.id !== channel.merchant_id || merchant.network !== 'testnet' ||
			seenChannels.has(id) || seenMerchants.has(merchant.id)
		) {
			throw new Error('mandate channel binding is invalid');
		}
		seenChannels.add(id);
		seenMerchants.add(merchant.id);
		const row = byChannel.get(id) ?? null;
		const expectedPublicKey = claimPublicKey(mandate, merchant.id);
		if (row && (
			row.mandateId !== mandateId ||
			row.merchantId !== merchant.id ||
			row.channelAmountDrops !== channelAmount ||
			row.payer !== mandate.mandate.owner ||
			row.publicKey !== expectedPublicKey
		)) {
			throw new Error('local channel claim conflicts with durable mandate state');
		}
		byChannel.delete(id);
		return {
			mandate_id: mandateId,
			merchant_id: merchant.id,
			channel_id: id,
			amount_drops: channelAmount,
			local: localStatus(row),
		};
	});
	if (byChannel.size !== 0) throw new Error('local claim references a channel outside the mandate');
	return items;
}

export const ops: OpDef[] = [
	{
		name: 'channel.status',
		family: 'channel',
		summary: 'Read one mandate payment channel with validated ledger and local highest-claim state.',
		tags: ['ap4m', 'payment-channel', 'settlement', 'testnet'],
		args: ChannelStatusArgsSchema,
		returns: 'ChannelStatus',
		caveats: [],
		example: 'await harbor.channel.status({ channel_id: "..." })',
		handler: (ctx, args) => handleChannelStatus(ctx, args as z.input<typeof ChannelStatusArgsSchema>),
	},
	{
		name: 'channel.list',
		family: 'channel',
		summary: 'List a mandate\'s payment channels with local highest-claim state.',
		tags: ['ap4m', 'payment-channel', 'settlement', 'testnet'],
		args: ChannelListArgsSchema,
		returns: 'ChannelListItem[]',
		caveats: [],
		example: 'await harbor.channel.list({ mandate_id: "..." })',
		handler: (ctx, args) => handleChannelList(ctx, args as z.input<typeof ChannelListArgsSchema>),
	},
];
