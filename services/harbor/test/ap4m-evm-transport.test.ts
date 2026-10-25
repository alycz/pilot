import { describe, expect, it, vi } from 'vitest';

import { AP4M_EVM_EVENT_PROFILE } from '../src/ap4m-evm/event-config';
import { Ap4mEvmJsonRpcClient } from '../src/ap4m-evm/json-rpc';
import {
	AP4M_EVENT_SERVICE_ORIGIN,
	Ap4mEvmServiceTransport,
} from '../src/ap4m-evm/service-transport';

const TX = `0x${'1'.repeat(64)}` as const;
const CLAIM = `0x${'2'.repeat(64)}` as const;
const CHANNEL = `0x${'3'.repeat(64)}` as const;
const PAYOUT_TX = `0x${'4'.repeat(64)}` as const;
const SETTLEMENT_TX = `0x${'5'.repeat(64)}` as const;
const AGENT = `0x${'1'.repeat(40)}` as const;
const PAYOUT = `0x${'2'.repeat(40)}` as const;

function rpcFetch(results: Record<string, unknown>) {
	return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		expect(String(url)).toBe(AP4M_EVM_EVENT_PROFILE.rpcUrl);
		const request = JSON.parse(String(init?.body)) as { id: number; method: string };
		return new Response(JSON.stringify({
			jsonrpc: '2.0', id: request.id, result: results[request.method],
		}), { status: 200, headers: { 'content-type': 'application/json' } });
	});
}

const prepared = {
	chainId: AP4M_EVM_EVENT_PROFILE.chainId,
	from: AGENT,
	to: AP4M_EVM_EVENT_PROFILE.paymentLedger,
	data: '0x1234',
	value: '0',
	gasLimit: '250000',
	feeModel: 'legacy' as const,
	gasPrice: '1000000000',
};

describe('AP4M EVM injected transports', () => {
	it('pins the RPC and enforces the reviewed legacy gas and fee ceilings', async () => {
		const fetch = rpcFetch({ eth_chainId: '0x161c28', eth_estimateGas: '0x30d40', eth_gasPrice: '0x3b9aca00' });
		const client = new Ap4mEvmJsonRpcClient({ fetch: fetch as unknown as typeof globalThis.fetch });
		await expect(client.inspectFees({
			transaction: prepared,
			feeModel: 'legacy',
			maxGasLimit: 300_000n,
			maxFeePerGasWei: 2_000_000_000n,
			maxTotalFeeWei: 500_000_000_000_000n,
		})).resolves.toEqual({
			estimatedGas: 200_000n,
			gasPriceWei: 1_000_000_000n,
			maximumFeeWei: 250_000_000_000_000n,
		});
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it('rejects a wrong chain, fee overruns, and unsupported fee models', async () => {
		const wrongChain = new Ap4mEvmJsonRpcClient({
			fetch: rpcFetch({ eth_chainId: '0x1' }) as unknown as typeof globalThis.fetch,
		});
		await expect(wrongChain.verifyChain()).rejects.toMatchObject({ code: 'RPC_CHAIN_MISMATCH' });

		const expensive = new Ap4mEvmJsonRpcClient({
			fetch: rpcFetch({ eth_chainId: '0x161c28', eth_estimateGas: '0x30d40', eth_gasPrice: '0x77359400' }) as unknown as typeof globalThis.fetch,
		});
		await expect(expensive.inspectFees({
			transaction: prepared, feeModel: 'legacy', maxGasLimit: 300_000n,
			maxFeePerGasWei: 1_000_000_000n, maxTotalFeeWei: 500_000_000_000_000n,
		})).rejects.toMatchObject({ code: 'RPC_FEE_BOUND_EXCEEDED' });

		await expect(expensive.inspectFees({
			transaction: prepared,
			feeModel: 'eip1559',
			maxGasLimit: 300_000n,
			maxFeePerGasWei: 1_000_000_000n,
			maxTotalFeeWei: 500_000_000_000_000n,
		} as never)).rejects.toMatchObject({ code: 'RPC_FEE_BOUND_EXCEEDED' });
	});

	it('binds the submitted transaction to the exact reviewed legacy gas price', async () => {
		const rpcTransaction = {
			hash: TX, from: AGENT, to: AP4M_EVM_EVENT_PROFILE.paymentLedger,
			input: prepared.data, value: '0x0', gas: '0x3d090', gasPrice: '0x3b9aca00',
			blockHash: null, blockNumber: null, type: '0x0',
		};
		const client = new Ap4mEvmJsonRpcClient({
			fetch: rpcFetch({ eth_chainId: '0x161c28', eth_getTransactionByHash: rpcTransaction }) as unknown as typeof globalThis.fetch,
		});
		const actual = await client.transactionByHash(TX);
		expect(actual).toMatchObject({ gasPrice: 1_000_000_000n });
		expect(() => client.assertExactTransaction(actual!, prepared)).not.toThrow();
		expect(() => client.assertExactTransaction(actual!, { ...prepared, gasPrice: '1000000001' }))
			.toThrowError(expect.objectContaining({ code: 'RPC_TRANSACTION_MISMATCH' }));

		const eip1559 = new Ap4mEvmJsonRpcClient({
			fetch: rpcFetch({ eth_chainId: '0x161c28', eth_getTransactionByHash: {
				...rpcTransaction, type: '0x2', maxFeePerGas: '0x3b9aca00', maxPriorityFeePerGas: '0x1',
			} }) as unknown as typeof globalThis.fetch,
		});
		await expect(eip1559.transactionByHash(TX)).rejects.toMatchObject({ code: 'RPC_TRANSACTION_MISMATCH' });
	});

	it('reports only an already-submitted hash to the pinned service endpoint', async () => {
		const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			expect(String(url)).toBe(`${AP4M_EVENT_SERVICE_ORIGIN}/public/participant/record-redemption`);
			expect(init?.method).toBe('POST');
			expect(JSON.parse(String(init?.body))).toEqual({ tx_hash: TX });
			expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-session-token-123');
			return new Response(JSON.stringify({ claim_id: CLAIM }), { status: 200 });
		});
		const transport = new Ap4mEvmServiceTransport({ fetch: fetch as unknown as typeof globalThis.fetch });
		await expect(transport.reportRedemption('test-session-token-123', TX)).resolves.toEqual({ claimId: CLAIM });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('binds settlement to the reviewed channel, claim, and recipient without polling', async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify({
			settlement_tx: SETTLEMENT_TX,
			payout_tx: PAYOUT_TX,
			amount_rlusd: '1.000000000000000000',
			recipient: PAYOUT,
			claim_id: CLAIM,
			channel_id: CHANNEL,
			claims_settled: 1,
			receipt_url: '/public/receipts/claim-1',
			receipts: [{
				claim_id: CLAIM,
				amount_rlusd: '1.000000000000000000',
				receipt_url: '/public/receipts/claim-1',
			}],
		}), { status: 200 }));
		const transport = new Ap4mEvmServiceTransport({ fetch: fetch as unknown as typeof globalThis.fetch });
		await expect(transport.requestSettlement({
			token: 'test-session-token-123', channelId: CHANNEL, claimId: CLAIM, expectedRecipient: PAYOUT,
		})).resolves.toMatchObject({
			status: 'reported', channelId: CHANNEL, claimId: CLAIM,
			payoutTransactionHash: PAYOUT_TX, recipient: PAYOUT,
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('fails closed for recipient mismatches and undocumented response fields', async () => {
		for (const response of [
			{
				settlement_tx: SETTLEMENT_TX, payout_tx: PAYOUT_TX, amount_rlusd: '1', recipient: AGENT,
				claim_id: CLAIM, channel_id: CHANNEL, claims_settled: 1, receipt_url: null,
				receipts: [{ claim_id: CLAIM, amount_rlusd: '1', receipt_url: null }],
			},
			{
				settlement_tx: SETTLEMENT_TX, payout_tx: PAYOUT_TX, amount_rlusd: '1', recipient: PAYOUT,
				claim_id: CLAIM, channel_id: CHANNEL, claims_settled: 1, receipt_url: null,
				receipts: [{ claim_id: CLAIM, amount_rlusd: '1', receipt_url: null }], compatibility: true,
			},
		]) {
			const transport = new Ap4mEvmServiceTransport({
				fetch: vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })) as unknown as typeof globalThis.fetch,
			});
			await expect(transport.requestSettlement({
				token: 'test-session-token-123', channelId: CHANNEL, claimId: CLAIM, expectedRecipient: PAYOUT,
			})).rejects.toMatchObject({
				code: expect.stringMatching(/^SERVICE_(?:BINDING_MISMATCH|INVALID_RESPONSE)$/),
			});
		}
	});
});
