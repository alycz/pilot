import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
} from 'node:fs';
import { isValidClassicAddress } from 'xrpl';
import { dirname } from 'node:path';

import { assertMacAcl, assertMacPrivateParentChain } from './trading-local-secret-file.ts';
import { DEFAULT_DELEGATED_PERMISSIONS } from './delegation.ts';
import { X402ProvisioningError } from './x402-provisioner.ts';

export const TRADING_DELEGATE_EVIDENCE_FILE =
	(process.env.HARBOR_PRIVATE_EVIDENCE_ROOT ? `${process.env.HARBOR_PRIVATE_EVIDENCE_ROOT}/pilot-isolated-trading-delegate-v1.json` : "/dev/null/pilot-disabled/pilot-isolated-trading-delegate-v1.json");
export const TRADING_DELEGATE_EVIDENCE_MAX_BYTES = 64 * 1024;

const TOP_KEYS = new Set(['account_status', 'onboarding_readiness']);
const ACCOUNT_KEYS = new Set(['delegate', 'network', 'owner', 'permissions', 'status']);
const READINESS_KEYS = new Set(['checks', 'evidence', 'ready', 'scope']);
const CHECK_KEYS = new Set([
	'exact_active_link',
	'exact_persisted_policy',
	'reviewed_runtime',
	'usable_encrypted_delegate',
	'usable_trust_line',
	'validated_trust_set',
]);

function invalid(): never {
	throw new X402ProvisioningError('INVALID_INPUT');
}

function record(value: unknown, keys: ReadonlySet<string>): Record<string, unknown> {
	if (
		typeof value !== 'object' || value === null || Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		Object.keys(value).length !== keys.size || Object.keys(value).some((key) => !keys.has(key))
	) invalid();
	return value as Record<string, unknown>;
}

/** Validate concordant public results; operator review remains the trust source. */
export function validateTradingDelegateEvidence(
	value: unknown,
	expected: { owner: string; delegate: string },
): void {
	if (!isValidClassicAddress(expected.owner) || !isValidClassicAddress(expected.delegate)) invalid();
	const top = record(value, TOP_KEYS);
	const account = record(top.account_status, ACCOUNT_KEYS);
	if (
		account.owner !== expected.owner || account.delegate !== expected.delegate ||
		account.network !== 'testnet' || account.status !== 'active' ||
		!Array.isArray(account.permissions) ||
		JSON.stringify(account.permissions) !== JSON.stringify(DEFAULT_DELEGATED_PERMISSIONS)
	) invalid();

	const readiness = record(top.onboarding_readiness, READINESS_KEYS);
	const scope = record(readiness.scope, new Set(['network', 'owner']));
	const checks = record(readiness.checks, CHECK_KEYS);
	const evidence = record(
		readiness.evidence,
		new Set([
			'delegate', 'link_ledger_index', 'trust_line_ledger_index',
			'trust_set_hash', 'trust_set_ledger_index',
		]),
	);
	if (
		readiness.ready !== true || scope.owner !== expected.owner || scope.network !== 'testnet' ||
		Object.values(checks).some((result) => result !== true) ||
		evidence.delegate !== expected.delegate ||
		!Number.isSafeInteger(evidence.link_ledger_index) ||
		(evidence.link_ledger_index as number) < 1 ||
		typeof evidence.trust_set_hash !== 'string' ||
		!/^[A-F0-9]{64}$/u.test(evidence.trust_set_hash) ||
		!Number.isSafeInteger(evidence.trust_set_ledger_index) ||
		(evidence.trust_set_ledger_index as number) < 1 ||
		!Number.isSafeInteger(evidence.trust_line_ledger_index) ||
		(evidence.trust_line_ledger_index as number) < 1
	) invalid();
}

export function readTradingDelegateEvidence(
	expected: { owner: string; delegate: string },
	path = TRADING_DELEGATE_EVIDENCE_FILE,
): void {
	if (path !== TRADING_DELEGATE_EVIDENCE_FILE) invalid();
	let descriptor: number | undefined;
	try {
		assertMacPrivateParentChain(dirname(path), assertMacAcl);
		descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const before = fstatSync(descriptor);
		const named = lstatSync(path);
		if (
			!before.isFile() || named.isSymbolicLink() || before.dev !== named.dev || before.ino !== named.ino ||
			before.nlink !== 1 || before.size > TRADING_DELEGATE_EVIDENCE_MAX_BYTES ||
			(before.mode & 0o777) !== 0o600 ||
			(typeof process.getuid === 'function' && before.uid !== process.getuid())
		) invalid();
		assertMacAcl(path, 'private');
		const raw = readFileSync(descriptor, 'utf8');
		const after = fstatSync(descriptor);
		if (
			before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
			Buffer.byteLength(raw, 'utf8') > TRADING_DELEGATE_EVIDENCE_MAX_BYTES
		) invalid();
		validateTradingDelegateEvidence(JSON.parse(raw), expected);
	} catch (error) {
		if (error instanceof X402ProvisioningError) throw error;
		invalid();
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}
