import { decode, Wallet, type Transaction } from 'xrpl';
import { describe, expect, it, vi } from 'vitest';

import { MemoryWorkAgreementStore } from '../src/exec/work-agreement-d1';
import {
	WorkAgreementRuntime,
	WorkAgreementRuntimeError,
	type JsonObject,
	type WorkAgreementAction,
	type WorkAgreementApproval,
	type WorkAgreementEffects,
	type WorkAgreementLookupResult,
	type WorkAgreementTerms,
} from '../src/exec/work-agreement-runtime';

const PRINCIPAL = 'local-owner-session';
const START = new Date('2026-10-24T10:00:00.000Z');
const owner = Wallet.generate();
const counterparty = Wallet.generate();

function terms(id = 'agreement-a', overrides: Partial<WorkAgreementTerms> = {}): WorkAgreementTerms {
	return {
		agreementId: id, owner: owner.classicAddress, counterparty: counterparty.classicAddress,
		network: 'testnet', amountDrops: '1000', finishAfter: 800_000_000, cancelAfter: 800_000_100,
		...overrides,
	};
}

function transaction(action: WorkAgreementAction, sequence: number, lastLedger = 520, overrides: JsonObject = {}): JsonObject {
	const common = { Account: owner.classicAddress, Fee: '12', Sequence: sequence, LastLedgerSequence: lastLedger };
	if (action === 'create') return { TransactionType: 'EscrowCreate', ...common, Destination: counterparty.classicAddress,
		Amount: '1000', FinishAfter: 800_000_000, CancelAfter: 800_000_100, ...overrides };
	if (action === 'release') return { TransactionType: 'EscrowFinish', ...common, Owner: owner.classicAddress, OfferSequence: 7, ...overrides };
	return { TransactionType: 'EscrowCancel', ...common, Owner: owner.classicAddress, OfferSequence: 7, ...overrides };
}

function approval(action: WorkAgreementAction, suffix: string, sequence: number, overrides: Partial<WorkAgreementApproval> = {}): WorkAgreementApproval {
	return {
		action, approvalId: `approval-${suffix}`, expiresAt: '2026-10-24T10:05:00.000Z',
		execution: { build_id: `build-${suffix}`, idempotency_key: `idem-${suffix}`, require_owner_approval: true },
		validatedLedgerIndex: 500, validatedAccountSequence: sequence, maxFeeDrops: '20',
		txJson: transaction(action, sequence), ...overrides,
	};
}

function call(agreementId: string, suffix: string, blob: string, attempt = `attempt-${suffix}`) {
	return { principal: PRINCIPAL, agreementId, owner: owner.classicAddress, network: 'testnet' as const,
		approvalId: `approval-${suffix}`, idempotencyKey: `idem-${suffix}`, attemptId: attempt, signedBlob: blob };
}

function recovery(agreementId: string, suffix: string) {
	return { principal: PRINCIPAL, agreementId, owner: owner.classicAddress, network: 'testnet' as const,
		approvalId: `approval-${suffix}`, idempotencyKey: `idem-${suffix}` };
}

function harness(store = new MemoryWorkAgreementStore()) {
	let now = new Date(START);
	let lookup: WorkAgreementLookupResult = { status: 'pending', hash: 'A'.repeat(64) };
	const dispatch = vi.fn(async () => undefined);
	const effects: WorkAgreementEffects = { dispatch, async lookup() { return lookup; } };
	return {
		store, dispatch, setLookup(value: WorkAgreementLookupResult) { lookup = value; },
		setNow(value: string) { now = new Date(value); },
		runtime: new WorkAgreementRuntime({ store, effects, enabled: true, now: () => new Date(now) }),
		newRuntime: () => new WorkAgreementRuntime({ store, effects, enabled: true, now: () => new Date(now) }),
	};
}

async function prepareCreate(runtime: WorkAgreementRuntime, agreementId = 'agreement-a', suffix = 'create') {
	const prepared = approval('create', suffix, 7);
	await runtime.prepare({ principal: PRINCIPAL, terms: terms(agreementId), approval: prepared });
	return { prepared, blob: owner.sign(prepared.txJson as Transaction).tx_blob };
}

describe('WorkAgreementRuntime', () => {
	it('is default-off and performs real owner signature and exact transaction verification', async () => {
		const store = new MemoryWorkAgreementStore();
		const disabled = new WorkAgreementRuntime({ store });
		await expect(disabled.prepare({ principal: PRINCIPAL, terms: terms(), approval: approval('create', 'disabled', 7) }))
			.rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
		const h = harness(store); const { prepared } = await prepareCreate(h.runtime);
		const impostor = Wallet.generate().sign(prepared.txJson as Transaction).tx_blob;
		await expect(h.runtime.submit(call('agreement-a', 'create', impostor))).rejects.toMatchObject({ code: 'SIGNED_TRANSACTION_INVALID' });
		const changed = owner.sign({ ...prepared.txJson, Amount: '1001' } as Transaction).tx_blob;
		await expect(h.runtime.submit(call('agreement-a', 'create', changed))).rejects.toMatchObject({ code: 'SIGNED_TRANSACTION_BINDING_MISMATCH' });
		expect(h.dispatch).not.toHaveBeenCalled();
	});

	it('claims dispatch once under double click and never persists the signed blob', async () => {
		const h = harness(); const { blob } = await prepareCreate(h.runtime);
		const [first, second] = await Promise.all([
			h.runtime.submit(call('agreement-a', 'create', blob)),
			h.runtime.submit(call('agreement-a', 'create', blob)),
		]);
		expect([first.outcome, second.outcome].sort()).toEqual(['replay', 'submitted']);
		expect(h.dispatch).toHaveBeenCalledTimes(1);
		const persisted = await h.store.get(PRINCIPAL, 'agreement-a');
		expect(persisted).toMatchObject({ status: 'unknown', attemptId: 'attempt-create' });
		expect(JSON.stringify(persisted)).not.toContain(blob);
	});

	it('freezes ambiguous dispatch and recovers read-only after restart with exact validated evidence', async () => {
		const h = harness(); const { blob } = await prepareCreate(h.runtime);
		h.dispatch.mockRejectedValueOnce(new Error('connection lost after send'));
		const submitted = await h.runtime.submit(call('agreement-a', 'create', blob));
		expect(submitted).toMatchObject({ outcome: 'unknown', record: { status: 'unknown' } });
		const signedTx = decode(blob) as JsonObject;
		h.setLookup({ status: 'validated', validated: true, hash: submitted.record.expectedHash!, ledgerIndex: 510,
			engineResult: 'tesSUCCESS', txJson: signedTx });
		const recovered = await h.newRuntime().recover(recovery('agreement-a', 'create'));
		expect(recovered).toMatchObject({ outcome: 'validated', record: { status: 'active', offerSequence: 7 } });
		expect(h.dispatch).toHaveBeenCalledTimes(1);
		expect(recovered.record.createEvidence?.txJson).not.toHaveProperty('TxnSignature');
		expect(await h.newRuntime().recover(recovery('agreement-a', 'create')))
			.toMatchObject({ outcome: 'validated', record: { status: 'active' } });
		expect(await h.newRuntime().submit(call('agreement-a', 'create', blob)))
			.toMatchObject({ outcome: 'replay', record: { status: 'active' } });
		const changedReplay = owner.sign({ ...recovered.record.createEvidence!.txJson, Fee: '13' } as Transaction).tx_blob;
		await expect(h.newRuntime().submit(call('agreement-a', 'create', changedReplay)))
			.rejects.toMatchObject({ code: 'REPLAY_DETECTED' });
		expect(h.dispatch).toHaveBeenCalledTimes(1);
	});

	it('accepts only complete post-expiry non-inclusion and retains tombstones for a fresh retry', async () => {
		const h = harness(); const { blob } = await prepareCreate(h.runtime);
		const submitted = await h.runtime.submit(call('agreement-a', 'create', blob));
		h.setNow('2026-10-24T10:06:00.000Z');
		h.setLookup({ status: 'not_included', hash: submitted.record.expectedHash!, searchedAll: true,
			validatedLedgerIndex: 521, checkedThroughLedger: 519 });
		await expect(h.runtime.recover(recovery('agreement-a', 'create'))).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' });
		h.setLookup({ status: 'not_included', hash: submitted.record.expectedHash!, searchedAll: true,
			validatedLedgerIndex: 521, checkedThroughLedger: 520 });
		expect((await h.runtime.recover(recovery('agreement-a', 'create'))).record.status).toBe('expired');
		h.setNow('2026-10-24T10:01:00.000Z');
		const retry = approval('create', 'retry', 8, { txJson: transaction('create', 8, 530) });
		const next = await h.runtime.prepare({ principal: PRINCIPAL, terms: terms(), approval: retry });
		expect(next.record.history).toMatchObject({ approvalIds: ['approval-create', 'approval-retry'],
			idempotencyKeys: ['idem-create', 'idem-retry'], attemptIds: ['attempt-create'] });
	});

	it('returns rejected release to active and makes release/cancel terminally exclusive', async () => {
		const h = harness(); const { blob } = await prepareCreate(h.runtime);
		const submitted = await h.runtime.submit(call('agreement-a', 'create', blob));
		h.setLookup({ status: 'validated', validated: true, hash: submitted.record.expectedHash!, ledgerIndex: 510,
			engineResult: 'tesSUCCESS', txJson: decode(blob) as JsonObject });
		await h.runtime.recover(recovery('agreement-a', 'create'));
		await expect(h.runtime.prepare({ principal: PRINCIPAL, terms: terms(), approval: approval('release', 'unsafe-time-release', 8,
			{ txJson: transaction('release', 8, 530, { Fulfillment: 'BB' }) }) })).rejects.toMatchObject({ code: 'UNSUPPORTED_TRANSACTION_FIELD' });
		const releaseRejected = approval('release', 'release-rejected', 8, { txJson: transaction('release', 8, 530) });
		await h.runtime.prepare({ principal: PRINCIPAL, terms: terms(), approval: releaseRejected });
		await expect(h.runtime.reject({ ...recovery('agreement-a', 'release-rejected'), owner: counterparty.classicAddress }))
			.rejects.toMatchObject({ code: 'AUTH_BINDING_MISMATCH' });
		expect((await h.runtime.reject({ ...recovery('agreement-a', 'release-rejected') })).record.status).toBe('active');
		await expect(h.runtime.reject({ ...recovery('agreement-a', 'release-rejected'), owner: counterparty.classicAddress }))
			.rejects.toMatchObject({ code: 'AUTH_BINDING_MISMATCH' });
		const release = approval('release', 'release', 9, { txJson: transaction('release', 9, 540) });
		await h.runtime.prepare({ principal: PRINCIPAL, terms: terms(), approval: release });
		const releaseBlob = owner.sign(release.txJson as Transaction).tx_blob;
		const releaseSubmitted = await h.runtime.submit(call('agreement-a', 'release', releaseBlob));
		h.setLookup({ status: 'validated', validated: true, hash: releaseSubmitted.record.expectedHash!, ledgerIndex: 535,
			engineResult: 'tesSUCCESS', txJson: decode(releaseBlob) as JsonObject });
		expect((await h.runtime.recover(recovery('agreement-a', 'release'))).record.status).toBe('released');
		await expect(h.runtime.prepare({ principal: PRINCIPAL, terms: terms(), approval: approval('cancel', 'cancel', 10,
			{ txJson: transaction('cancel', 10, 550) }) })).rejects.toMatchObject({ code: 'INVALID_STATE' });
	});

	it('fails closed on account, network, approval, and idempotency changes and on unsafe condition flows', async () => {
		const h = harness(); const { blob } = await prepareCreate(h.runtime);
		for (const changed of [
			{ ...call('agreement-a', 'create', blob), owner: counterparty.classicAddress },
			{ ...call('agreement-a', 'create', blob), approvalId: 'approval-other' },
			{ ...call('agreement-a', 'create', blob), idempotencyKey: 'idem-other' },
		]) await expect(h.runtime.submit(changed)).rejects.toBeInstanceOf(WorkAgreementRuntimeError);
		await expect(h.runtime.prepare({ principal: PRINCIPAL, terms: terms('condition-no-cancel', { condition: 'A0', cancelAfter: undefined }),
			approval: approval('create', 'bad-condition', 7) })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		await expect(h.runtime.prepare({ principal: PRINCIPAL, terms: terms('condition-missing-fulfillment', { condition: 'AA' }),
			approval: approval('release', 'missing-fulfillment', 8,
				{ txJson: transaction('release', 8, 530, { Condition: 'AA' }) }) })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
	});
});
