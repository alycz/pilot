import type { DelegateSet } from 'xrpl';

import type { Network } from '../contracts';

/** Permissions Harbor grants when an account link does not request a custom set. */
export const DEFAULT_DELEGATED_PERMISSIONS = [
	'OfferCreate',
	'OfferCancel',
	'TrustSet',
	'AMMDeposit',
	'AMMWithdraw',
	'EscrowFinish',
	'CheckCash',
] as const;

/** Harbor policy never delegates permissions that can move value to another account. */
export const NEVER_DELEGATED_PERMISSIONS = [
	'Payment',
	'EscrowCreate',
	'CheckCreate',
	'PaymentChannelCreate',
	'PaymentChannelFund',
	'NFTokenCreateOffer',
	'PaymentBurn',
	'PaymentMint',
] as const;

/** Transaction permissions the blueprint requires to remain owner-signed. */
export const NON_DELEGABLE_PERMISSION_NAMES = [
	'AccountSet',
	'SetRegularKey',
	'SignerListSet',
	'DelegateSet',
	'AccountDelete',
	'Batch',
	'ConfidentialMPTConvert',
	'EnableAmendment',
	'LedgerStateFix',
	'SetFee',
	'SponsorshipTransfer',
	'UNLModify',
] as const;

/** Prefix patterns from the blueprint's Vault*, Loan*, and LoanBroker* rules. */
export const NON_DELEGABLE_PERMISSION_PREFIXES = ['Vault', 'Loan', 'LoanBroker'] as const;

const MAX_PERMISSIONS = 10;
const PERMISSION_NAME = /^[A-Za-z][A-Za-z0-9]*$/;
const neverDelegated = new Set<string>(NEVER_DELEGATED_PERMISSIONS);
const nonDelegable = new Set<string>(NON_DELEGABLE_PERMISSION_NAMES);

export class DelegationValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DelegationValidationError';
	}
}

export class DelegationDataError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DelegationDataError';
	}
}

/**
 * The narrow seam account operations need before the XRPL path adapter lands.
 * Implementations can delegate preparation to xrpl.js `autofill` and perform a
 * filtered `account_objects`/`ledger_entry` read for the Delegate object.
 */
export interface DelegationLedgerAdapter {
	prepareTransaction(network: Network, transaction: DelegateSet): Promise<DelegateSet>;
	readDelegate(network: Network, owner: string, delegate: string): Promise<unknown | null>;
	isAccountFunded(network: Network, address: string): Promise<boolean>;
}

export interface ExpectedDelegateEntry {
	owner: string;
	delegate: string;
}

export function validatePermissions(permissions: readonly string[] = DEFAULT_DELEGATED_PERMISSIONS): string[] {
	if (!Array.isArray(permissions)) {
		throw new DelegationValidationError('Permissions must be an array');
	}
	if (permissions.length === 0) {
		throw new DelegationValidationError('At least one permission is required');
	}
	if (permissions.length > MAX_PERMISSIONS) {
		throw new DelegationValidationError(`Permissions cannot contain more than ${MAX_PERMISSIONS} entries`);
	}

	const validated: string[] = [];
	const seen = new Set<string>();
	for (const permission of permissions) {
		if (typeof permission !== 'string' || permission.length === 0 || permission.trim() !== permission || !PERMISSION_NAME.test(permission)) {
			throw new DelegationValidationError('Each permission must be a non-empty exact permission string');
		}
		if (seen.has(permission)) {
			throw new DelegationValidationError(`Duplicate permission: ${permission}`);
		}
		if (neverDelegated.has(permission)) {
			throw new DelegationValidationError(`Permission is never delegated by Harbor: ${permission}`);
		}
		if (nonDelegable.has(permission) || NON_DELEGABLE_PERMISSION_PREFIXES.some((prefix) => permission.startsWith(prefix))) {
			throw new DelegationValidationError(`Permission is non-delegable: ${permission}`);
		}
		seen.add(permission);
		validated.push(permission);
	}

	return validated;
}

export function buildDelegateSet(
	owner: string,
	delegate: string,
	permissions: readonly string[] = DEFAULT_DELEGATED_PERMISSIONS,
): DelegateSet {
	const validated = validatePermissions(permissions);
	return {
		// TransactionType: https://xrpl.org/docs/references/protocol/transactions/types/delegateset
		TransactionType: 'DelegateSet',
		// Account: https://xrpl.org/docs/references/protocol/transactions/types/delegateset
		Account: owner,
		// Authorize: https://xrpl.org/docs/references/protocol/transactions/types/delegateset
		Authorize: delegate,
		// Permissions: https://xrpl.org/docs/references/protocol/transactions/types/delegateset
		Permissions: validated.map((PermissionValue) => ({ Permission: { PermissionValue } })),
	};
}

export function buildDelegateRevoke(owner: string, delegate: string): DelegateSet {
	return {
		// TransactionType: https://xrpl.org/docs/references/protocol/transactions/types/delegateset
		TransactionType: 'DelegateSet',
		// Account: https://xrpl.org/docs/references/protocol/transactions/types/delegateset
		Account: owner,
		// Authorize: https://xrpl.org/docs/references/protocol/transactions/types/delegateset
		Authorize: delegate,
		// Permissions: https://xrpl.org/docs/references/protocol/transactions/types/delegateset
		Permissions: [],
	};
}

export async function prepareDelegateSet(
	adapter: DelegationLedgerAdapter,
	network: Network,
	owner: string,
	delegate: string,
	permissions: readonly string[] = DEFAULT_DELEGATED_PERMISSIONS,
): Promise<DelegateSet> {
	const transaction = buildDelegateSet(owner, delegate, permissions);
	return validatePreparedDelegateSet(transaction, await adapter.prepareTransaction(network, transaction));
}

export async function prepareDelegateRevoke(
	adapter: DelegationLedgerAdapter,
	network: Network,
	owner: string,
	delegate: string,
): Promise<DelegateSet> {
	const transaction = buildDelegateRevoke(owner, delegate);
	return validatePreparedDelegateSet(transaction, await adapter.prepareTransaction(network, transaction));
}

/**
 * Validate and copy the permissions in a raw Delegate ledger entry. Known
 * values are normally returned as names; a valid numeric fallback is rendered
 * canonically as a decimal string, as documented by XRPL:
 * https://xrpl.org/docs/references/protocol/data-types/permission-values
 */
export function normalizeDelegatePermissions(entry: unknown, expected?: ExpectedDelegateEntry): string[] {
	if (!isRecord(entry)) {
		throw new DelegationDataError('Delegate ledger entry must be an object');
	}
	if (entry.LedgerEntryType !== 'Delegate') {
		throw new DelegationDataError('Ledger entry is not a Delegate entry');
	}
	if (typeof entry.Account !== 'string' || entry.Account.length === 0) {
		throw new DelegationDataError('Delegate ledger entry has an invalid Account');
	}
	if (typeof entry.Authorize !== 'string' || entry.Authorize.length === 0) {
		throw new DelegationDataError('Delegate ledger entry has an invalid Authorize');
	}
	if (expected !== undefined && (entry.Account !== expected.owner || entry.Authorize !== expected.delegate)) {
		throw new DelegationDataError('Delegate ledger entry does not match the requested owner and delegate');
	}
	if (!Array.isArray(entry.Permissions) || entry.Permissions.length === 0 || entry.Permissions.length > MAX_PERMISSIONS) {
		throw new DelegationDataError('Delegate ledger entry must contain between 1 and 10 permissions');
	}

	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const candidate of entry.Permissions) {
		if (!hasOnlyKey(candidate, 'Permission') || !hasOnlyKey(candidate.Permission, 'PermissionValue')) {
			throw new DelegationDataError('Delegate ledger entry contains a malformed permission object');
		}
		const value = normalizeOnLedgerPermissionValue(candidate.Permission.PermissionValue);
		if (seen.has(value)) {
			throw new DelegationDataError(`Delegate ledger entry contains a duplicate permission: ${value}`);
		}
		seen.add(value);
		normalized.push(value);
	}
	return normalized;
}

export async function readDelegatePermissions(
	adapter: DelegationLedgerAdapter,
	network: Network,
	owner: string,
	delegate: string,
): Promise<string[] | null> {
	const entry = await adapter.readDelegate(network, owner, delegate);
	return entry === null ? null : normalizeDelegatePermissions(entry, { owner, delegate });
}

function validatePreparedDelegateSet(expected: DelegateSet, prepared: DelegateSet): DelegateSet {
	if (!isRecord(prepared)) {
		throw new DelegationDataError('Prepared DelegateSet must be an object');
	}
	if (
		prepared.TransactionType !== expected.TransactionType ||
		prepared.Account !== expected.Account ||
		prepared.Authorize !== expected.Authorize ||
		JSON.stringify(prepared.Permissions) !== JSON.stringify(expected.Permissions)
	) {
		throw new DelegationDataError('Prepared DelegateSet changed protected delegation fields');
	}
	if (
		Object.hasOwn(prepared, 'TxnSignature') ||
		Object.hasOwn(prepared, 'Signers') ||
		(typeof prepared.SigningPubKey === 'string' && prepared.SigningPubKey.length > 0)
	) {
		throw new DelegationDataError('Prepared DelegateSet must remain unsigned');
	}
	return prepared;
}

function normalizeOnLedgerPermissionValue(value: unknown): string {
	if (typeof value === 'string') {
		if (value.length === 0 || value.trim() !== value || !PERMISSION_NAME.test(value)) {
			throw new DelegationDataError('Delegate ledger entry contains an invalid PermissionValue string');
		}
		return value;
	}
	if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 0xffff_ffff) {
		return String(value);
	}
	throw new DelegationDataError('Delegate ledger entry contains an invalid PermissionValue');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKey(value: unknown, key: string): value is Record<string, unknown> {
	return isRecord(value) && Object.keys(value).length === 1 && Object.hasOwn(value, key);
}
