import type { Mandate, Merchant } from '../contracts';

export type SettlementRailId = 'xrpl-exact' | 'xrpl-paychan' | 'ap4m-sandbox';

export class SettlementRailError extends Error {
	constructor(
		message: string,
		readonly code: 'RAIL_NOT_CONNECTED' | 'RAIL_NOT_CONFIGURED' | 'RAIL_SELECTION_INVALID',
	) {
		super(message);
		this.name = 'SettlementRailError';
	}
}

/**
 * One injected settlement implementation. Concrete rails keep their quote,
 * payment and status contracts typed without widening the registry boundary.
 */
export interface SettlementRail<
	TQuoteInput = unknown,
	TQuote = unknown,
	TPayInput = unknown,
	TPayment = unknown,
	TStatusInput = unknown,
	TStatus = unknown,
> {
	readonly id: SettlementRailId;
	quote(input: TQuoteInput): Promise<TQuote>;
	pay(input: TPayInput): Promise<TPayment>;
	status(input: TStatusInput): Promise<TStatus>;
}

type AnySettlementRail = SettlementRail<any, any, any, any, any, any>;

export class SettlementRailRegistry {
	readonly #rails: ReadonlyMap<SettlementRailId, AnySettlementRail>;

	constructor(rails: readonly AnySettlementRail[]) {
		const byId = new Map<SettlementRailId, AnySettlementRail>();
		for (const rail of rails) {
			if (byId.has(rail.id)) {
				throw new SettlementRailError(`Duplicate settlement rail: ${rail.id}`, 'RAIL_SELECTION_INVALID');
			}
			byId.set(rail.id, rail);
		}
		this.#rails = byId;
	}

	list(): readonly SettlementRailId[] {
		return Object.freeze([...this.#rails.keys()].sort());
	}

	require<T extends AnySettlementRail = AnySettlementRail>(id: SettlementRailId): T {
		const rail = this.#rails.get(id);
		if (!rail) {
			throw new SettlementRailError(`Settlement rail is not configured: ${id}`, 'RAIL_NOT_CONFIGURED');
		}
		return rail as T;
	}
}

function disconnected(): never {
	throw new SettlementRailError(
		'Requires Mastercard AP4M early-access credentials',
		'RAIL_NOT_CONNECTED',
	);
}

/** A visible but permanently fail-closed placeholder for the future AP4M rail. */
export const ap4mSandboxRail: SettlementRail<unknown, never, unknown, never, unknown, never> = Object.freeze({
	id: 'ap4m-sandbox',
	async quote(): Promise<never> {
		return disconnected();
	},
	async pay(): Promise<never> {
		return disconnected();
	},
	async status(): Promise<never> {
		return disconnected();
	},
});

export type SelectAp4mSettlementRailInput = Readonly<{
	merchant: Pick<Merchant, 'id' | 'schemes'>;
	channels: Mandate['channels'];
}>;

/**
 * Prefer the channel only when both independently trusted inputs agree: the
 * catalog advertises it and the active mandate contains that merchant's exact
 * channel. Otherwise retain the existing exact rail. No network probing or
 * automatic fallback happens at this selection boundary.
 */
export function selectAp4mSettlementRailId(
	input: SelectAp4mSettlementRailInput,
): Extract<SettlementRailId, 'xrpl-exact' | 'xrpl-paychan'> {
	const matches = input.channels.filter((channel) => channel.merchant_id === input.merchant.id);
	if (matches.length > 1) {
		throw new SettlementRailError(
			'Mandate contains multiple channels for the merchant',
			'RAIL_SELECTION_INVALID',
		);
	}
	if (input.merchant.schemes.includes('xrpl-paychan') && matches.length === 1) {
		return 'xrpl-paychan';
	}
	if (input.merchant.schemes.includes('exact')) return 'xrpl-exact';
	throw new SettlementRailError(
		'Merchant has no configured settlement rail',
		'RAIL_NOT_CONFIGURED',
	);
}
