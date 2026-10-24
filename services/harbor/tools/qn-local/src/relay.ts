import type { QnLocalStore } from './store.ts';
import { postSignedDelivery } from './delivery.ts';
import { runQuickNodeFilter } from './filter.ts';

export interface XrplRelayClient {
	connect(): Promise<void>;
	disconnect(): Promise<void>;
	request(request: Record<string, unknown>): Promise<unknown>;
	on(event: 'transaction' | 'ledgerClosed', listener: (event: unknown) => void): void;
	off(event: 'transaction' | 'ledgerClosed', listener: (event: unknown) => void): void;
}

export type RelayDestination = { url: string; secret: string };

export type XrplRelayOptions = {
	client: XrplRelayClient;
	store: QnLocalStore;
	walletsListKey: string;
	network?: string;
	webhook?: RelayDestination;
	stream?: RelayDestination & { filterSource: string };
	fetchImpl?: typeof fetch;
	onRelayError?: (error: unknown) => void;
};

export function publicTestnetWebsocket(value: string): string {
	let url: URL;
	try { url = new URL(value); }
	catch { throw new Error('QN_LOCAL_XRPL_WS must be a public XRPL Testnet WSS URL'); }
	if (
		url.protocol !== 'wss:' ||
		url.username !== '' ||
		url.password !== '' ||
		!(url.hostname === 'altnet.rippletest.net' || url.hostname.endsWith('.altnet.rippletest.net'))
	) {
		throw new Error('QN_LOCAL_XRPL_WS must be a public XRPL Testnet WSS URL');
	}
	return url.toString();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function transactionPayload(event: unknown, network: string): unknown | undefined {
	const record = asRecord(event);
	if (!record) return undefined;
	const transaction = asRecord(record.transaction) ?? asRecord(record.tx) ?? record;
	const hash = transaction.hash ?? record.hash;
	if (typeof hash !== 'string') return undefined;
	return {
		data: [{ ...transaction, hash, metaData: record.meta ?? record.metaData }],
		metadata: { network, source: 'qn-local' },
	};
}

function ledgerIndex(event: unknown): number | undefined {
	const record = asRecord(event);
	const value = record?.ledger_index ?? record?.ledgerIndex;
	return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function ledgerData(response: unknown): unknown {
	const record = asRecord(response);
	return asRecord(record?.result)?.ledger ?? record?.result ?? response;
}

/**
 * Relay public XRPL testnet activity into QuickNode-shaped signed deliveries.
 * The caller must opt in with explicit URLs and secrets; no connection occurs
 * merely by starting the local REST stand-in.
 */
export async function startXrplRelay(options: XrplRelayOptions): Promise<() => Promise<void>> {
	const wallets = (await options.store.getList(options.walletsListKey)) ?? [];
	await options.client.connect();
	if (wallets.length > 0 && options.webhook) {
		await options.client.request({ command: 'subscribe', accounts: wallets });
	}
	if (options.stream) await options.client.request({ command: 'subscribe', streams: ['ledger'] });
	const pending = new Set<Promise<void>>();
	const track = (promise: Promise<unknown>) => {
		const tracked = promise.then(
			() => undefined,
			(error) => {
				try { options.onRelayError?.(error); }
				catch { /* A diagnostic callback must never create an unhandled rejection. */ }
			},
		);
		pending.add(tracked);
		void tracked.then(() => { pending.delete(tracked); });
	};
	const onTransaction = (event: unknown) => {
		if (!options.webhook) return;
		const body = transactionPayload(event, options.network ?? 'xrp-testnet');
		if (!body) return;
		track(postSignedDelivery({ ...options.webhook, body, fetchImpl: options.fetchImpl }));
	};
	const onLedger = (event: unknown) => {
		if (!options.stream) return;
		const index = ledgerIndex(event);
		if (index === undefined) return;
		track((async () => {
			const ledger = await options.client.request({
				command: 'ledger', ledger_index: index, transactions: true, expand: true, api_version: 1,
			});
			const body = await runQuickNodeFilter(
				options.stream!.filterSource,
				{ data: ledgerData(ledger), metadata: { network: options.network ?? 'xrp-testnet' } },
				options.store,
			);
			if (body !== null && body !== undefined) {
				await postSignedDelivery({ ...options.stream!, body, fetchImpl: options.fetchImpl });
			}
		})());
	};
	options.client.on('transaction', onTransaction);
	options.client.on('ledgerClosed', onLedger);
	return async () => {
		options.client.off('transaction', onTransaction);
		options.client.off('ledgerClosed', onLedger);
		await Promise.allSettled([...pending]);
		await options.client.disconnect();
	};
}

export { ledgerData, ledgerIndex, transactionPayload };
