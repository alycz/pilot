import type { Transaction } from 'xrpl';

import { requestXrpl, XrplRpcError, type XrplRpc } from '../adapters/xrpl-rpc';
import { loadKmsKek, readKmsMode, type KmsEnv } from '../aws/kms';
import type { OpContext } from '../catalog/registry';
import type { ExecutionContract, Network } from '../contracts';
import { validatePreparedTransaction, type PreparedTransaction } from './build';
import {
	NEVER_DELEGATED_PERMISSIONS,
	NON_DELEGABLE_PERMISSION_NAMES,
	NON_DELEGABLE_PERMISSION_PREFIXES,
} from './delegation';
import {
	DelegateKeyError,
	withDelegateSigner,
	withDelegateSignerWithCryptoKey,
	type DelegateIdentity,
	type DelegateSigner,
	type SignedTransaction,
	type StoredDelegateKey,
} from './keys';
import {
	createKmsDelegateClient,
	KmsDelegateSigner,
	readKmsDelegatePublicIdentity,
	type KmsKeyLifecycleClient,
	type KmsSigningClient,
} from './kms-signer';
import { createStore, type LinkRow } from './store';

const MAX_AUTOFILL_FEE_DROPS = 2_000_000n;
const UINT32_MAX = 0xffff_ffff;
const DROPS = /^[1-9][0-9]*$/;

const neverDelegated = new Set<string>(NEVER_DELEGATED_PERMISSIONS);
const nonDelegable = new Set<string>(NON_DELEGABLE_PERMISSION_NAMES);

export type DelegatedSigningLink = LinkRow;

/** The principal-scoped Store seam needed by delegated signing. */
export interface DelegatedSigningStore {
	getLink(owner: string, network: Network): Promise<DelegatedSigningLink | null>;
}

/** A stored-build-shaped input; key material is intentionally not part of it. */
export interface DelegatedSigningInput {
	network: Network;
	owner: string;
	txJson: PreparedTransaction;
	/** Omission retains legacy autofill behavior. V2 signs the immutable build exactly. */
	executionContract?: ExecutionContract;
}

export interface DelegatedSigningContext extends OpContext {
	db?: D1Database;
	env?: Record<string, unknown>;
	store?: DelegatedSigningStore;
	xrplRpc?: XrplRpc;
	signingServices?: DelegatedSigningServices;
}

/** Optional test seam; production always falls back to the hardened key helper. */
export interface DelegatedSigningServices {
	withDelegateSigner?: typeof withDelegateSigner;
	kmsClient?: KmsKeyLifecycleClient & KmsSigningClient;
}

export type DelegatedSigningErrorCode =
	| 'INVALID_REQUEST'
	| 'MAINNET_EXECUTION_DISABLED'
	| 'UNSUPPORTED_NETWORK'
	| 'LINK_NOT_FOUND'
	| 'LINK_NOT_ACTIVE'
	| 'PERMISSION_NOT_GRANTED'
	| 'PROTECTED_TRANSACTION_TYPE'
	| 'INVALID_LINK'
	| 'MISSING_KEK'
	| 'INVALID_IDENTITY'
	| 'INVALID_KEK'
	| 'KEY_GENERATION_FAILED'
	| 'KEY_WRAP_FAILED'
	| 'KEY_UNWRAP_FAILED'
	| 'KEY_MISMATCH'
	| 'XRPL_MALFORMED_RESPONSE'
	| 'EXECUTION_CONTRACT_UNSUPPORTED'
	| 'EXECUTION_SNAPSHOT_INVALID'
	| 'FEE_LOAD_UNSAFE'
	| 'ACCOUNT_SEQUENCE_CHANGED'
	| 'SIGNING_FAILED';

/** Secret-safe execution error: it never retains the transaction, link, or signer error. */
export class DelegatedSigningError extends Error {
	constructor(
		message: string,
		readonly code: DelegatedSigningErrorCode,
	) {
		super(message);
		this.name = 'DelegatedSigningError';
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function executionNetwork(network: Network): asserts network is 'testnet' | 'devnet' {
	if (network === 'mainnet') {
		throw new DelegatedSigningError('Delegated signing is disabled on mainnet', 'MAINNET_EXECUTION_DISABLED');
	}
	if (network !== 'testnet' && network !== 'devnet') {
		throw new DelegatedSigningError('Delegated signing is allowed only on testnet or devnet', 'UNSUPPORTED_NETWORK');
	}
}

function storeFor(ctx: DelegatedSigningContext): DelegatedSigningStore {
	if (ctx.store !== undefined) return ctx.store;
	if (ctx.db !== undefined) return createStore(ctx.db, ctx.principal);
	if (isRecord(ctx.env) && ctx.env.DB !== undefined) {
		return createStore(ctx.env.DB as D1Database, ctx.principal);
	}
	throw new DelegatedSigningError('A principal-scoped link store is required', 'INVALID_REQUEST');
}

function kekFor(ctx: DelegatedSigningContext): string {
	const value = isRecord(ctx.env) ? ctx.env.HARBOR_KEK : undefined;
	if (typeof value !== 'string' || value.length === 0) {
		throw new DelegatedSigningError('Delegated signing key encryption is not configured', 'MISSING_KEK');
	}
	return value;
}

function transactionType(txJson: PreparedTransaction): string {
	const value = txJson.TransactionType;
	if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(value)) {
		throw new DelegatedSigningError('TransactionType is invalid', 'INVALID_REQUEST');
	}
	return value;
}

function isProtectedTransactionType(type: string): boolean {
	return (
		neverDelegated.has(type) ||
		nonDelegable.has(type) ||
		NON_DELEGABLE_PERMISSION_PREFIXES.some((prefix) => type.startsWith(prefix))
	);
}

function validateDelegationCompatibleFields(txJson: PreparedTransaction): void {
	// Harbor uses the owner's AccountRoot sequence and the delegate's fee balance.
	// Tickets and AccountTxnID would instead couple signing to caller-selected
	// sequence state; sponsorship would violate the delegate-pays-fee invariant.
	for (const field of ['TicketSequence', 'AccountTxnID', 'Sponsor', 'SponsorFlags', 'SponsorSignature']) {
		if (Object.hasOwn(txJson, field)) {
			throw new DelegatedSigningError(`${field} is not supported for delegated signing`, 'INVALID_REQUEST');
		}
	}
}

function validateUnsignedDelegatedTransaction(
	txJson: PreparedTransaction,
	owner: string,
	delegate: string,
): void {
	if (txJson.Delegate !== delegate) {
		throw new DelegatedSigningError('Delegated transaction does not match the active link', 'INVALID_LINK');
	}
	const withoutDelegate = { ...txJson };
	delete withoutDelegate.Delegate;
	validatePreparedTransaction(withoutDelegate, owner);
}

function ownerSequence(result: Record<string, unknown>, owner: string): number {
	if (!isRecord(result.account_data)) throw malformedResponse('account_info');
	const sequence = result.account_data.Sequence;
	if (
		result.account_data.Account !== owner ||
		!Number.isSafeInteger(sequence) ||
		(sequence as number) < 1 ||
		(sequence as number) > UINT32_MAX
	) {
		throw malformedResponse('account_info');
	}
	return sequence as number;
}

function openLedgerFee(result: Record<string, unknown>): string {
	if (!isRecord(result.drops)) throw malformedResponse('fee');
	const fee = result.drops.open_ledger_fee;
	if (typeof fee !== 'string' || !DROPS.test(fee) || BigInt(fee) > MAX_AUTOFILL_FEE_DROPS) {
		throw malformedResponse('fee');
	}
	return fee;
}

function canonicalNonnegativeInteger(value: unknown): string | undefined {
	if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) return undefined;
	return value;
}

function compareCanonicalIntegers(left: string, right: string): number {
	if (left.length !== right.length) return left.length - right.length;
	return left === right ? 0 : left < right ? -1 : 1;
}

function validateExactV2SigningEvidence(
	txJson: PreparedTransaction,
	accountInfo: Record<string, unknown>,
	feeResult: Record<string, unknown>,
	owner: string,
): void {
	const immutableSequence = txJson.Sequence;
	const immutableFee = txJson.Fee;
	if (
		!Number.isSafeInteger(immutableSequence) ||
		(immutableSequence as number) < 1 ||
		(immutableSequence as number) > UINT32_MAX ||
		typeof immutableFee !== 'string' ||
		!DROPS.test(immutableFee)
	) {
		throw new DelegatedSigningError(
			'V2 transaction is missing immutable Fee or Sequence evidence',
			'EXECUTION_SNAPSHOT_INVALID',
		);
	}

	if (ownerSequence(accountInfo, owner) !== immutableSequence) {
		throw new DelegatedSigningError(
			'Owner account sequence changed before signing',
			'ACCOUNT_SEQUENCE_CHANGED',
		);
	}
	if (!isRecord(feeResult.drops)) throw malformedResponse('fee');
	const openFee = canonicalNonnegativeInteger(feeResult.drops.open_ledger_fee);
	const currentQueueSize = canonicalNonnegativeInteger(feeResult.current_queue_size);
	const maxQueueSize = canonicalNonnegativeInteger(feeResult.max_queue_size);
	if (
		openFee === undefined ||
		openFee === '0' ||
		currentQueueSize === undefined ||
		maxQueueSize === undefined ||
		maxQueueSize === '0'
	) {
		throw malformedResponse('fee');
	}
	if (
		compareCanonicalIntegers(openFee, immutableFee) > 0 ||
		compareCanonicalIntegers(currentQueueSize, maxQueueSize) >= 0
	) {
		throw new DelegatedSigningError(
			'Current fee or queue load is unsafe for the immutable transaction',
			'FEE_LOAD_UNSAFE',
		);
	}
}

function malformedResponse(command: string): DelegatedSigningError {
	return new DelegatedSigningError(`XRPL ${command} returned a malformed response`, 'XRPL_MALFORMED_RESPONSE');
}

function publicSigningResult(value: unknown): SignedTransaction {
	if (
		!isRecord(value) ||
		typeof value.tx_blob !== 'string' ||
		value.tx_blob.length === 0 ||
		typeof value.hash !== 'string' ||
		value.hash.length === 0
	) {
		throw new DelegatedSigningError('Delegate signer returned an invalid result', 'SIGNING_FAILED');
	}
	// Copy only the two public outputs even if an injected provider returns
	// additional wallet properties at runtime.
	return Object.freeze({ tx_blob: value.tx_blob, hash: value.hash });
}

function validateLink(link: DelegatedSigningLink, input: DelegatedSigningInput): void {
	if (
		link.owner !== input.owner ||
		link.network !== input.network ||
		typeof link.delegate !== 'string' ||
		link.delegate.length === 0 ||
		!Array.isArray(link.permissions) ||
		!link.permissions.every((permission) => typeof permission === 'string')
	) {
		throw new DelegatedSigningError('Stored account link is invalid', 'INVALID_LINK');
	}
	if (link.delegate === input.owner) {
		throw new DelegatedSigningError('Delegate must be different from the budget owner', 'INVALID_LINK');
	}
	if (
		link.keyBackend === 'kms'
			? (
				link.delegateSeedEnc !== null ||
				link.iv !== null ||
				typeof link.kmsKeyId !== 'string' ||
				link.kmsKeyId.length === 0 ||
				typeof link.kmsAlias !== 'string' ||
				link.kmsAlias !== `alias/harbor/${link.network}/${link.id}`
			)
			: (!(link.delegateSeedEnc instanceof ArrayBuffer) || !(link.iv instanceof ArrayBuffer))
	) {
		throw new DelegatedSigningError('Stored delegate key is invalid', 'INVALID_LINK');
	}
}

function copyUnsignedTransaction(txJson: PreparedTransaction, owner: string): PreparedTransaction {
	validatePreparedTransaction(txJson, owner);
	validateDelegationCompatibleFields(txJson);
	try {
		return structuredClone(txJson);
	} catch {
		throw new DelegatedSigningError('Transaction must be cloneable JSON data', 'INVALID_REQUEST');
	}
}

/**
 * Sign one transaction through an active permission-delegation link.
 *
 * The delegate key is unwrapped only inside `withDelegateSigner`; this API
 * accepts no owner/delegate secret and returns only the signed blob and hash.
 */
export async function signDelegatedTransaction(
	ctx: DelegatedSigningContext,
	input: DelegatedSigningInput,
): Promise<SignedTransaction> {
	if (!ctx.principal?.trim() || !isRecord(input) || typeof input.owner !== 'string' || input.owner.length === 0) {
		throw new DelegatedSigningError('A principal, owner, network, and unsigned transaction are required', 'INVALID_REQUEST');
	}
	executionNetwork(input.network);
	if (
		input.executionContract !== undefined &&
		input.executionContract !== 'xrpl_execution_v1' &&
		input.executionContract !== 'xrpl_execution_v2'
	) {
		throw new DelegatedSigningError('Execution contract is unsupported', 'EXECUTION_CONTRACT_UNSUPPORTED');
	}
	const exactV2 = input.executionContract === 'xrpl_execution_v2';

	const unsigned = copyUnsignedTransaction(input.txJson, input.owner);
	const type = transactionType(unsigned);
	if (isProtectedTransactionType(type)) {
		throw new DelegatedSigningError(`${type} cannot be signed by a delegate`, 'PROTECTED_TRANSACTION_TYPE');
	}

	const store = storeFor(ctx);
	const link = await store.getLink(input.owner, input.network);
	if (link === null) {
		throw new DelegatedSigningError('No account link exists for delegated signing', 'LINK_NOT_FOUND');
	}
	validateLink(link, input);
	if (link.status !== 'active') {
		throw new DelegatedSigningError('Account link is not active', 'LINK_NOT_ACTIVE');
	}
	if (!link.permissions.includes(type)) {
		throw new DelegatedSigningError(`${type} is not granted by the active link`, 'PERMISSION_NOT_GRANTED');
	}

	let accountInfo: Record<string, unknown>;
	let feeResult: Record<string, unknown>;
	try {
		[accountInfo, feeResult] = await Promise.all([
			requestXrpl(ctx, input.network, 'account_info', {
				account: input.owner,
				ledger_index: 'current',
			}),
			requestXrpl(ctx, input.network, 'fee'),
		]);
	} catch (error) {
		// The shared adapter's errors are already request- and secret-safe.
		if (error instanceof XrplRpcError) throw error;
		throw new DelegatedSigningError('XRPL signing inputs could not be read', 'SIGNING_FAILED');
	}

	if (exactV2) {
		validateExactV2SigningEvidence(unsigned, accountInfo, feeResult, input.owner);
	}

	const delegatedTransaction: PreparedTransaction = exactV2
		? {
				...unsigned,
				// Delegate is the sole field added to an immutable v2 prepared transaction:
				// https://xrpl.org/docs/references/protocol/transactions/common-fields#delegate
				Delegate: link.delegate,
			}
		: {
				...unsigned,
				// Account is the delegating budget owner:
				// https://xrpl.org/docs/references/protocol/transactions/common-fields#delegate
				Account: input.owner,
				// Delegate identifies the active delegate that authorizes this transaction:
				// https://xrpl.org/docs/references/protocol/transactions/common-fields#delegate
				Delegate: link.delegate,
				// Fee is paid from the delegate account for a delegated transaction:
				// https://xrpl.org/docs/references/protocol/transactions/common-fields#delegate
				Fee: openLedgerFee(feeResult),
				// A delegated transaction functions as if sent by Account; only signature
				// validation and Fee payment move to Delegate. Sequence therefore belongs
				// to the delegating owner, not the signing delegate:
				// https://xrpl.org/docs/references/protocol/transactions/common-fields#delegate
				Sequence: ownerSequence(accountInfo, input.owner),
			};

	const identity: DelegateIdentity = {
		principal: ctx.principal,
		owner: input.owner,
		network: input.network,
	};
	const signWithDelegate = async (signer: DelegateSigner) => {
		if (signer.address !== link.delegate) {
			throw new DelegatedSigningError('Unwrapped signer does not match the active link', 'INVALID_LINK');
		}
		// Re-check immediately before the signature. The execution layer's
		// atomic reservation also requires an active link, so a suspension that
		// wins either check prevents this authorization from being used.
		const current = await store.getLink(input.owner, input.network);
		if (
			current === null ||
			current.id !== link.id ||
			current.owner !== input.owner ||
			current.network !== input.network ||
			current.status !== 'active' ||
			current.delegate !== link.delegate ||
			!current.permissions.includes(type)
		) {
			throw new DelegatedSigningError('Account link stopped being active before signing', 'LINK_NOT_ACTIVE');
		}
		// Revalidate inside the signer lifetime, immediately before signing. The
		// caller's object was cloned, so it cannot race this unsignedness check.
		validateUnsignedDelegatedTransaction(delegatedTransaction, input.owner, link.delegate);
		return signer.sign(delegatedTransaction as Transaction);
	};

	try {
		const env = (isRecord(ctx.env) ? ctx.env : {}) as KmsEnv;
		const mode = readKmsMode(env);
		let signed: SignedTransaction;
		if (link.keyBackend === 'kms') {
			if (mode !== 'sign') {
				throw new DelegatedSigningError('KMS delegate signing is not enabled', 'INVALID_LINK');
			}
			const client = ctx.signingServices?.kmsClient ?? createKmsDelegateClient(env);
			const publicIdentity = await readKmsDelegatePublicIdentity(client, link.kmsAlias);
			if (publicIdentity.address !== link.delegate) {
				throw new DelegatedSigningError('KMS signer does not match the active link', 'INVALID_LINK');
			}
			signed = await signWithDelegate(new KmsDelegateSigner({
				keyId: link.kmsKeyId,
				keyAlias: link.kmsAlias,
				publicKey: publicIdentity.publicKey,
				client,
			}));
		} else {
			if (mode === 'sign') {
				throw new DelegatedSigningError('KMS sign mode requires a KMS-backed delegate link', 'INVALID_LINK');
			}
			const wrapped: StoredDelegateKey = {
				address: link.delegate,
				ciphertext: link.delegateSeedEnc,
				iv: link.iv,
			};
			const injected = ctx.signingServices?.withDelegateSigner;
			signed = injected
				? await injected(identity, wrapped, kekFor(ctx), signWithDelegate)
				: mode === 'kek'
					? await withDelegateSignerWithCryptoKey(identity, wrapped, await loadKmsKek(env), signWithDelegate)
					: await withDelegateSigner(identity, wrapped, kekFor(ctx), signWithDelegate);
		}
		return publicSigningResult(signed);
	} catch (error) {
		if (error instanceof DelegatedSigningError) throw error;
		if (error instanceof DelegateKeyError) {
			throw new DelegatedSigningError('Delegated signing key is unavailable', error.code);
		}
		// Never retain or surface an SDK/provider exception: such errors may carry
		// transaction or wallet internals even though Harbor itself logs nothing.
		throw new DelegatedSigningError('Delegated transaction signing failed', 'SIGNING_FAILED');
	}
}
