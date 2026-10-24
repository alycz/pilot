import { isValidClassicAddress } from 'xrpl';

import type { WrappedDelegateKey } from './keys';
import type { X402PayerRow, X402PayerStore } from './x402-payer-store';

const PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type X402ProvisioningState = 'ready' | 'funding-pending';

export interface X402ProvisioningResult {
	principal: string;
	owner: string;
	merchantPayTo: string;
	network: 'testnet';
	payer: string;
	publicKey: string;
	state: X402ProvisioningState;
	fundedLedgerIndex: number | null;
	fundedBalanceDrops: string | null;
}

export interface X402FundingObservation {
	ledgerIndex: number;
	balanceDrops: string;
}

type ProvisioningStore = Pick<
	X402PayerStore,
	'get' | 'insert' | 'markFaucetRequested' | 'markFundingPending' | 'markReadyFromFunding'
>;

export interface X402ProvisioningDependencies {
	store: ProvisioningStore;
	createWrappedKey: () => Promise<WrappedDelegateKey>;
	requestTestnetFaucet: (payer: string) => Promise<void>;
	readValidatedFunding: (payer: string) => Promise<X402FundingObservation | null>;
	now: () => Date;
	/** Additional public addresses the newly isolated payer must never reuse. */
	forbiddenPayerAddresses?: readonly string[];
}

export class X402ProvisioningError extends Error {
	constructor(
		readonly code:
			| 'INVALID_INPUT'
			| 'BINDING_SUSPENDED'
			| 'IDENTITY_CREATION_FAILED'
			| 'PERSISTENCE_FAILED'
			| 'FAUCET_REQUEST_FAILED'
			| 'FUNDING_READ_FAILED',
	) {
		super('Local x402 payer provisioning failed');
		this.name = 'X402ProvisioningError';
	}
}

function validateInput(principal: string, owner: string, merchantPayTo: string): void {
	if (
		!PRINCIPAL.test(principal) ||
		principal === 'local-dev' ||
		!isValidClassicAddress(owner) ||
		!isValidClassicAddress(merchantPayTo)
	) {
		throw new X402ProvisioningError('INVALID_INPUT');
	}
}

function validateForbiddenPayers(addresses: readonly string[] | undefined): readonly string[] {
	const values = addresses ?? [];
	if (values.some((value) => !isValidClassicAddress(value))) {
		throw new X402ProvisioningError('INVALID_INPUT');
	}
	return values;
}

function assertSeparatedPayer(
	payer: string,
	owner: string,
	merchantPayTo: string,
	forbidden: readonly string[],
): void {
	if (payer === owner || payer === merchantPayTo || forbidden.includes(payer)) {
		throw new X402ProvisioningError('BINDING_SUSPENDED');
	}
}

function publicResult(row: X402PayerRow, merchantPayTo: string): X402ProvisioningResult {
	return {
		principal: row.principal,
		owner: row.owner,
		merchantPayTo,
		network: row.network,
		payer: row.payer,
		publicKey: row.publicKey,
		state: row.status === 'ready' ? 'ready' : 'funding-pending',
		fundedLedgerIndex: row.fundedLedgerIndex,
		fundedBalanceDrops: row.fundedBalanceDrops,
	};
}

function isConflict(error: unknown): boolean {
	return typeof error === 'object' && error !== null &&
		'code' in error && error.code === 'CONFLICT';
}

function safeTime(now: () => Date): string {
	let value: string;
	try {
		value = now().toISOString();
	} catch {
		throw new X402ProvisioningError('PERSISTENCE_FAILED');
	}
	return value;
}

async function loadBinding(
	store: ProvisioningStore,
	owner: string,
): Promise<X402PayerRow | null> {
	try {
		return await store.get(owner, 'testnet');
	} catch {
		throw new X402ProvisioningError('PERSISTENCE_FAILED');
	}
}

/**
 * Provision, or safely resume provisioning, one durable local Testnet payer.
 * The faucet marker is committed before the external request. This deliberately
 * prefers an operator-visible, funding-pending row over a duplicate faucet call
 * after a crash with an unknowable request outcome.
 */
export async function provisionLocalX402Payer(
	principal: string,
	owner: string,
	merchantPayTo: string,
	dependencies: X402ProvisioningDependencies,
): Promise<X402ProvisioningResult> {
	validateInput(principal, owner, merchantPayTo);
	const forbiddenPayers = validateForbiddenPayers(dependencies.forbiddenPayerAddresses);
	let row = await loadBinding(dependencies.store, owner);

	if (row?.status === 'suspended') throw new X402ProvisioningError('BINDING_SUSPENDED');
	if (row !== null) assertSeparatedPayer(row.payer, owner, merchantPayTo, forbiddenPayers);
	if (row?.status === 'ready') return publicResult(row, merchantPayTo);

	if (row === null) {
		let wrapped: WrappedDelegateKey;
		try {
			wrapped = await dependencies.createWrappedKey();
		} catch {
			throw new X402ProvisioningError('IDENTITY_CREATION_FAILED');
		}
		assertSeparatedPayer(wrapped.address, owner, merchantPayTo, forbiddenPayers);
		const at = safeTime(dependencies.now);
		try {
			row = await dependencies.store.insert({
				owner,
				network: 'testnet',
				payer: wrapped.address,
				publicKey: wrapped.publicKey,
				ciphertext: wrapped.ciphertext,
				iv: wrapped.iv,
				status: 'disabled',
				fundedLedgerIndex: null,
				fundedBalanceDrops: null,
				createdAt: at,
				updatedAt: at,
			});
		} catch (error) {
			if (!isConflict(error)) throw new X402ProvisioningError('PERSISTENCE_FAILED');
			row = await loadBinding(dependencies.store, owner);
			if (row === null) throw new X402ProvisioningError('PERSISTENCE_FAILED');
			if (row.status === 'suspended') throw new X402ProvisioningError('BINDING_SUSPENDED');
			assertSeparatedPayer(row.payer, owner, merchantPayTo, forbiddenPayers);
			if (row.status === 'ready') return publicResult(row, merchantPayTo);
		}
	}

	let marker: Awaited<ReturnType<ProvisioningStore['markFaucetRequested']>>;
	try {
		marker = await dependencies.store.markFaucetRequested(owner, 'testnet', safeTime(dependencies.now));
	} catch {
		throw new X402ProvisioningError('PERSISTENCE_FAILED');
	}
	row = marker.row;
	if (marker.requested) {
		try {
			await dependencies.requestTestnetFaucet(row.payer);
		} catch {
			// The durable pre-request marker forbids an automatic retry. A future
			// invocation may only inspect the public ledger for this same payer.
			throw new X402ProvisioningError('FAUCET_REQUEST_FAILED');
		}
	}

	let funding: X402FundingObservation | null;
	try {
		funding = await dependencies.readValidatedFunding(row.payer);
	} catch {
		throw new X402ProvisioningError('FUNDING_READ_FAILED');
	}
	const checkedAt = safeTime(dependencies.now);
	try {
		if (funding === null || funding.balanceDrops === '0') {
			return publicResult(await dependencies.store.markFundingPending(owner, 'testnet', checkedAt), merchantPayTo);
		}
		return publicResult(await dependencies.store.markReadyFromFunding(owner, 'testnet', {
			ledgerIndex: funding.ledgerIndex,
			balanceDrops: funding.balanceDrops,
			checkedAt,
		}), merchantPayTo);
	} catch {
		throw new X402ProvisioningError('PERSISTENCE_FAILED');
	}
}
