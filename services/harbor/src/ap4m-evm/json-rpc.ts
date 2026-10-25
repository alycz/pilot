import { getAddress, type Address, type Hex } from 'viem';

import {
	EvmReceiptEvidenceSchema,
	Hex32Schema,
	PreparedEvmTransactionSchema,
	type EvmReceiptEvidence,
	type PreparedEvmTransaction,
} from './contracts';
import { AP4M_EVM_EVENT_PROFILE } from './event-config';

const MAX_RPC_RESPONSE_BYTES = 256 * 1024;
const MAX_RPC_ERROR_LENGTH = 256;

export class Ap4mEvmRpcError extends Error {
	constructor(
		message: string,
		readonly code:
			| 'RPC_UNAVAILABLE'
			| 'RPC_INVALID_RESPONSE'
			| 'RPC_CHAIN_MISMATCH'
			| 'RPC_TRANSACTION_MISMATCH'
			| 'RPC_FEE_BOUND_EXCEEDED',
		readonly cause?: unknown,
	) {
		super(message);
		this.name = 'Ap4mEvmRpcError';
	}
}

type JsonRecord = Record<string, unknown>;

export type Ap4mEvmRpcDependencies = Readonly<{
	fetch: typeof fetch;
	timeoutMs?: number;
}>;

export type Ap4mEvmRpcTransaction = Readonly<{
	hash: Hex;
	from: Address;
	to: Address;
	input: Hex;
	value: bigint;
	gas: bigint;
	gasPrice: bigint;
	blockHash: Hex | null;
	blockNumber: number | null;
}>;

function record(value: unknown, field: string): JsonRecord {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Ap4mEvmRpcError(`${field} is invalid`, 'RPC_INVALID_RESPONSE');
	}
	return value as JsonRecord;
}

function quantity(value: unknown, field: string): bigint {
	if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
		throw new Ap4mEvmRpcError(`${field} is not a canonical hex quantity`, 'RPC_INVALID_RESPONSE');
	}
	return BigInt(value);
}

function safeNumber(value: bigint, field: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new Ap4mEvmRpcError(`${field} exceeds the safe integer range`, 'RPC_INVALID_RESPONSE');
	}
	return parsed;
}

function hex32(value: unknown, field: string): Hex {
	if (!Hex32Schema.safeParse(value).success) {
		throw new Ap4mEvmRpcError(`${field} is invalid`, 'RPC_INVALID_RESPONSE');
	}
	return value as Hex;
}

function address(value: unknown, field: string): Address {
	if (typeof value !== 'string') {
		throw new Ap4mEvmRpcError(`${field} is invalid`, 'RPC_INVALID_RESPONSE');
	}
	try {
		return getAddress(value);
	} catch {
		throw new Ap4mEvmRpcError(`${field} is invalid`, 'RPC_INVALID_RESPONSE');
	}
}

function data(value: unknown, field: string): Hex {
	if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
		throw new Ap4mEvmRpcError(`${field} is invalid`, 'RPC_INVALID_RESPONSE');
	}
	return value as Hex;
}

function exactKeys(value: JsonRecord, allowed: readonly string[], required: readonly string[], field: string): void {
	if (
		Object.keys(value).some((key) => !allowed.includes(key)) ||
		required.some((key) => !Object.hasOwn(value, key))
	) {
		throw new Ap4mEvmRpcError(`${field} has an unsupported shape`, 'RPC_INVALID_RESPONSE');
	}
}

function toRpcQuantity(value: bigint): Hex {
	return `0x${value.toString(16)}` as Hex;
}

function sameAddress(left: string, right: string): boolean {
	try {
		return getAddress(left) === getAddress(right);
	} catch {
		return false;
	}
}

export class Ap4mEvmJsonRpcClient {
	private nextId = 1;

	constructor(private readonly dependencies: Ap4mEvmRpcDependencies) {
		if (!Number.isSafeInteger(dependencies.timeoutMs ?? 8_000) || (dependencies.timeoutMs ?? 8_000) < 1) {
			throw new Ap4mEvmRpcError('RPC timeout is invalid', 'RPC_UNAVAILABLE');
		}
	}

	private async request(method: string, params: readonly unknown[]): Promise<unknown> {
		const id = this.nextId++;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.dependencies.timeoutMs ?? 8_000);
		let response: Response;
		try {
			response = await this.dependencies.fetch(AP4M_EVM_EVENT_PROFILE.rpcUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
				signal: controller.signal,
			});
		} catch (error) {
			throw new Ap4mEvmRpcError('AP4M EVM RPC request failed', 'RPC_UNAVAILABLE', error);
		} finally {
			clearTimeout(timer);
		}
		if (!response.ok) {
			throw new Ap4mEvmRpcError(`AP4M EVM RPC returned HTTP ${response.status}`, 'RPC_UNAVAILABLE');
		}
		const text = await response.text();
		if (new TextEncoder().encode(text).byteLength > MAX_RPC_RESPONSE_BYTES) {
			throw new Ap4mEvmRpcError('AP4M EVM RPC response is too large', 'RPC_INVALID_RESPONSE');
		}
		let decoded: unknown;
		try {
			decoded = JSON.parse(text) as unknown;
		} catch (error) {
			throw new Ap4mEvmRpcError('AP4M EVM RPC response is not JSON', 'RPC_INVALID_RESPONSE', error);
		}
		const envelope = record(decoded, 'RPC response');
		exactKeys(envelope, ['jsonrpc', 'id', 'result', 'error'], ['jsonrpc', 'id'], 'RPC response');
		if (envelope.jsonrpc !== '2.0' || envelope.id !== id || Object.hasOwn(envelope, 'result') === Object.hasOwn(envelope, 'error')) {
			throw new Ap4mEvmRpcError('AP4M EVM RPC response binding is invalid', 'RPC_INVALID_RESPONSE');
		}
		if (Object.hasOwn(envelope, 'error')) {
			const error = record(envelope.error, 'RPC error');
			const message = typeof error.message === 'string'
				? error.message.slice(0, MAX_RPC_ERROR_LENGTH)
				: 'unknown RPC error';
			throw new Ap4mEvmRpcError(`AP4M EVM RPC rejected ${method}: ${message}`, 'RPC_UNAVAILABLE');
		}
		return envelope.result;
	}

	async verifyChain(): Promise<void> {
		const chainId = quantity(await this.request('eth_chainId', []), 'RPC chain id');
		if (chainId !== BigInt(AP4M_EVM_EVENT_PROFILE.chainId)) {
			throw new Ap4mEvmRpcError('AP4M EVM RPC chain does not match the event allowlist', 'RPC_CHAIN_MISMATCH');
		}
	}

	async blockNumber(): Promise<number> {
		await this.verifyChain();
		return safeNumber(quantity(await this.request('eth_blockNumber', []), 'RPC block number'), 'RPC block number');
	}

	async transactionByHash(txHash: Hex): Promise<Ap4mEvmRpcTransaction | null> {
		hex32(txHash, 'transaction hash');
		await this.verifyChain();
		const result = await this.request('eth_getTransactionByHash', [txHash]);
		if (result === null) return null;
		const value = record(result, 'RPC transaction');
		exactKeys(
			value,
			['hash', 'from', 'to', 'input', 'value', 'gas', 'blockHash', 'blockNumber', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas', 'nonce', 'transactionIndex', 'type', 'chainId', 'v', 'r', 's', 'accessList', 'yParity'],
			['hash', 'from', 'to', 'input', 'value', 'gas', 'gasPrice', 'blockHash', 'blockNumber'],
			'RPC transaction',
		);
		if (value.to === null) throw new Ap4mEvmRpcError('Contract creation is not an AP4M redemption', 'RPC_TRANSACTION_MISMATCH');
		if ((value.type !== undefined && value.type !== '0x0') || value.maxFeePerGas != null || value.maxPriorityFeePerGas != null) {
			throw new Ap4mEvmRpcError('Submitted transaction does not use the reviewed legacy fee model', 'RPC_TRANSACTION_MISMATCH');
		}
		const blockHash = value.blockHash === null ? null : hex32(value.blockHash, 'transaction block hash');
		const blockNumber = value.blockNumber === null
			? null
			: safeNumber(quantity(value.blockNumber, 'transaction block number'), 'transaction block number');
		const parsed = {
			hash: hex32(value.hash, 'transaction hash'),
			from: address(value.from, 'transaction sender'),
			to: address(value.to, 'transaction target'),
			input: data(value.input, 'transaction input'),
			value: quantity(value.value, 'transaction value'),
			gas: quantity(value.gas, 'transaction gas'),
			gasPrice: quantity(value.gasPrice, 'transaction gas price'),
			blockHash,
			blockNumber,
		};
		if (parsed.hash.toLowerCase() !== txHash.toLowerCase()) {
			throw new Ap4mEvmRpcError('RPC transaction hash does not match the lookup', 'RPC_TRANSACTION_MISMATCH');
		}
		return parsed;
	}

	async receiptByHash(txHash: Hex): Promise<EvmReceiptEvidence | null> {
		hex32(txHash, 'transaction hash');
		await this.verifyChain();
		const result = await this.request('eth_getTransactionReceipt', [txHash]);
		if (result === null) return null;
		const value = record(result, 'RPC receipt');
		exactKeys(
			value,
			['transactionHash', 'transactionIndex', 'blockHash', 'blockNumber', 'from', 'to', 'cumulativeGasUsed', 'gasUsed', 'contractAddress', 'logs', 'logsBloom', 'status', 'effectiveGasPrice', 'type', 'root', 'blobGasPrice', 'blobGasUsed'],
			['transactionHash', 'blockHash', 'blockNumber', 'status', 'logs'],
			'RPC receipt',
		);
		if (quantity(value.status, 'receipt status') !== 1n || !Array.isArray(value.logs)) {
			throw new Ap4mEvmRpcError('AP4M EVM transaction did not succeed', 'RPC_TRANSACTION_MISMATCH');
		}
		const receipt = {
			transactionHash: hex32(value.transactionHash, 'receipt transaction hash'),
			blockHash: hex32(value.blockHash, 'receipt block hash'),
			blockNumber: safeNumber(quantity(value.blockNumber, 'receipt block number'), 'receipt block number'),
			status: 'success' as const,
			logs: value.logs.map((entry, index) => {
				const log = record(entry, `receipt log ${index}`);
				exactKeys(
					log,
					['address', 'topics', 'data', 'blockNumber', 'transactionHash', 'transactionIndex', 'blockHash', 'logIndex', 'removed'],
					['address', 'topics', 'data', 'logIndex', 'removed'],
					`receipt log ${index}`,
				);
				if (!Array.isArray(log.topics) || log.removed !== false) {
					throw new Ap4mEvmRpcError(`receipt log ${index} is invalid`, 'RPC_INVALID_RESPONSE');
				}
				return {
					address: address(log.address, `receipt log ${index} address`),
					topics: log.topics.map((topic) => hex32(topic, `receipt log ${index} topic`)),
					data: data(log.data, `receipt log ${index} data`),
					logIndex: safeNumber(quantity(log.logIndex, `receipt log ${index} index`), `receipt log ${index} index`),
					removed: false,
				};
			}),
		};
		if (receipt.transactionHash.toLowerCase() !== txHash.toLowerCase()) {
			throw new Ap4mEvmRpcError('RPC receipt hash does not match the lookup', 'RPC_TRANSACTION_MISMATCH');
		}
		try {
			return EvmReceiptEvidenceSchema.parse(receipt);
		} catch (error) {
			throw new Ap4mEvmRpcError('RPC receipt evidence is invalid', 'RPC_INVALID_RESPONSE', error);
		}
	}

	async inspectFees(input: Readonly<{
		transaction: PreparedEvmTransaction;
		feeModel: 'legacy';
		maxGasLimit: bigint;
		maxFeePerGasWei: bigint;
		maxTotalFeeWei: bigint;
	}>): Promise<Readonly<{ estimatedGas: bigint; gasPriceWei: bigint; maximumFeeWei: bigint }>> {
		let transaction: PreparedEvmTransaction;
		try {
			transaction = PreparedEvmTransactionSchema.parse(input.transaction);
		} catch (error) {
			throw new Ap4mEvmRpcError('Prepared fee inspection transaction is invalid', 'RPC_TRANSACTION_MISMATCH', error);
		}
		if (
			input.feeModel !== 'legacy' ||
			transaction.chainId !== AP4M_EVM_EVENT_PROFILE.chainId || input.maxGasLimit < 1n ||
			input.maxFeePerGasWei < 1n || input.maxTotalFeeWei < 1n
		) {
			throw new Ap4mEvmRpcError('Fee inspection bounds are invalid', 'RPC_FEE_BOUND_EXCEEDED');
		}
		await this.verifyChain();
		const rpcTransaction = {
			from: transaction.from,
			to: transaction.to,
			data: transaction.data,
			value: toRpcQuantity(BigInt(transaction.value)),
		};
		const [estimateResult, priceResult] = await Promise.all([
			this.request('eth_estimateGas', [rpcTransaction, 'latest']),
			this.request('eth_gasPrice', []),
		]);
		const estimatedGas = quantity(estimateResult, 'estimated gas');
		const gasPriceWei = quantity(priceResult, 'gas price');
		const gasLimit = BigInt(transaction.gasLimit);
		const preparedGasPriceWei = BigInt(transaction.gasPrice);
		const maximumFeeWei = gasLimit * preparedGasPriceWei;
		if (
			gasLimit > input.maxGasLimit || estimatedGas > gasLimit ||
			preparedGasPriceWei > input.maxFeePerGasWei || gasPriceWei > input.maxFeePerGasWei ||
			maximumFeeWei > input.maxTotalFeeWei
		) {
			throw new Ap4mEvmRpcError('AP4M EVM fee or gas bound exceeded', 'RPC_FEE_BOUND_EXCEEDED');
		}
		return { estimatedGas, gasPriceWei, maximumFeeWei };
	}

	assertExactTransaction(
		actual: Ap4mEvmRpcTransaction,
		expected: PreparedEvmTransaction,
	): void {
		if (
			actual.hash.length !== 66 || !sameAddress(actual.from, expected.from) ||
			!sameAddress(actual.to, expected.to) || actual.input.toLowerCase() !== expected.data.toLowerCase() ||
			actual.value !== BigInt(expected.value) || actual.gas > BigInt(expected.gasLimit) ||
			expected.feeModel !== 'legacy' || actual.gasPrice !== BigInt(expected.gasPrice)
		) {
			throw new Ap4mEvmRpcError('Submitted transaction does not match the reviewed call', 'RPC_TRANSACTION_MISMATCH');
		}
	}
}
