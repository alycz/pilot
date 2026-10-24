import { describe, expect, it, vi } from 'vitest';
import { decode, Wallet } from 'xrpl';
import { DEFAULT_POLICY } from '../src/contracts';
import { Ap4mPurchaseError, handleAp4mPurchase, type Ap4mPurchaseServices } from '../src/ops/ap4m';
import { getCatalogMerchant } from '../src/ops/merchants';
import { xrplCurrencyCodeForAp4m, type ValidatedAp4mX402Challenge } from '../src/exec/ap4m-x402';
import fixture from './fixtures/ap4m-mh4-mm2-v1.json';

const NOW = new Date('2026-10-21T12:00:00.000Z');
const MANDATE = 'mandate-test-1';
const IDEM = 'purchase-request-0001';
const STATE = 'A'.repeat(43);
const KEK = btoa(String.fromCharCode(...new Uint8Array(32)));
const args = { mandate_id: MANDATE, merchant_id: 'venue-yield-desk', sku: 'yield-report', idempotency_key: IDEM };

function mandate(status: 'ACTIVE' | 'REVOKED', mandateId = MANDATE) {
	return { mandate: { id: mandateId, owner: 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY', network: 'testnet' as const,
		status, execution_type: 'DEFERRED' as const, not_before: '2026-10-21T00:00:00.000Z',
		expires_at: '2026-10-22T00:00:00.000Z', constraints: { currency: 'USD' as const,
			per_payment_max: '5', daily_max: '10', total_max: '25', payees: ['venue-yield-desk'], skus: ['yield-report'] },
		agent_public_jwk: fixture.keys.agent_public_jwk, l1_digest: 'a'.repeat(64), l2_digest: 'b'.repeat(64),
		channels: [], spent_usd: '0' }, agentKeyCiphertext: new ArrayBuffer(17), agentKeyIv: new ArrayBuffer(12),
		claimKeysCiphertext: new ArrayBuffer(17), claimKeysIv: new ArrayBuffer(12), claimPublicKeys: [],
		prepared: { unsigned_batch: {} }, closeRequested: false, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
}

function challenge(url: string, sourceTag: number | undefined = 2610240): ValidatedAp4mX402Challenge {
	const merchant = getCatalogMerchant('venue-yield-desk')!;
	const asset = merchant.settle_asset;
	if (asset.kind !== 'iou') throw new Error('fixture merchant asset changed');
	const currency = xrplCurrencyCodeForAp4m(asset.currency);
	return { x402Version: 2, resource: { url }, scheme: 'exact', network: 'xrpl:1', currency,
		issuer: asset.issuer, payTo: merchant.xrpl_address, amount: '0.75', maxTimeoutSeconds: 60,
		invoiceId: 'invoice-1', sourceTag: sourceTag as number,
		accepted: { scheme: 'exact', network: 'xrpl:1', asset: currency, payTo: merchant.xrpl_address,
			amount: '0.75', maxTimeoutSeconds: 60, extra: { areFeesSponsored: false,
				assetTransferMethod: 'sequence', invoiceId: 'invoice-1', issuer: asset.issuer,
				sourceTag: sourceTag as number } } };
}

function response(intentId: string) {
	return { data: { schema_id: 'yield_report_v1', venue: 'venue-yield-desk', apr_percent: '4.2',
		tvl_usd: '1000000', risk: 'low' }, intent_validation: { intentId, validated: true,
		checks: { agent_identity: 'pass', intent: 'pass', payment: 'pass', credential: 'pass' }, validation_errors: [] } };
}

function settlementEvidence(attempt: any, payment: any) {
	return { validated: true, hash: attempt.txHash, ledger_index: 119,
		tx_json: decode(attempt.signedBlob),
		meta: { TransactionResult: 'tesSUCCESS', DeliveredAmount: payment.Amount } };
}

function row() {
	return { id: 'attempt-1', principal: 'test-principal', mandateId: MANDATE, idempotencyKey: IDEM,
		requestFingerprint: '', merchantId: args.merchant_id, sku: args.sku, status: 'claimed', spendId: null,
		spendDay: null, amountUsd: null, preparedContextWrapped: null, preparedContextBinding: null,
		leaseAcquiredAt: NOW.toISOString(), signingStartedAt: null, firstEligibleLedgerIndex: null,
		signedBlob: null, txHash: null, lastLedgerSequence: null, settlementUnknownAt: null, settledAt: null,
		deliveredAt: null, failedAt: null, ledgerIndex: null, deliveredAmount: null, receiptId: null,
		merchantResponse: null, merchantResponseAt: null, result: null, failure: null,
		createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() } as any;
}

class FakeStore {
	row = row(); context: any; exists = false; releases = 0; reserves = 0; lastReserve: any;
	forceClaimBusy = false; forceLeaseBusy = false; signingToken: string | null = null;
	markSignedMode: 'normal' | 'throw-before' | 'write-then-throw' = 'normal';
	async get() { return this.exists ? this.row : null; }
	async claim(input: any) {
		if (this.exists || this.forceClaimBusy) return { outcome: 'replay' as const, row: this.row };
		this.exists = true; Object.assign(this.row, { id: input.id, mandateId: input.mandateId,
			idempotencyKey: input.idempotencyKey, requestFingerprint: input.requestFingerprint,
			merchantId: input.merchantId, sku: input.sku, leaseAcquiredAt: input.createdAt });
		return { outcome: 'claimed' as const, row: this.row };
	}
	async acquireClaimRecovery() { return { outcome: 'invalid-state' as const, row: this.row }; }
	async reserve(input: any) {
		this.reserves++; this.lastReserve = structuredClone(input); this.context = structuredClone(input.preparedContext);
		Object.assign(this.row, { status: 'prepared', spendId: input.spendId, spendDay: input.spendDay,
			amountUsd: input.amountUsd, receiptId: input.preparedContext.receiptId,
			preparedContextWrapped: { ciphertext: new ArrayBuffer(17), iv: new ArrayBuffer(12), digest: 'C'.repeat(64) } });
		return { outcome: 'reserved' as const, row: this.row };
	}
	async readPreparedContext() { return structuredClone(this.context); }
	async acquireSigningLease(_m: string, _i: string, value: any) {
		if (this.forceLeaseBusy) {
			return { outcome: 'busy' as const, row: this.row };
		}
		if (this.signingToken && this.signingToken !== value.token) {
			return { outcome: 'busy' as const, row: this.row };
		}
		this.signingToken = value.token; Object.assign(this.row, { signingStartedAt: value.at,
			firstEligibleLedgerIndex: value.firstEligibleLedgerIndex });
		return { outcome: 'acquired' as const, row: this.row };
	}
	async markSigned(_m: string, _i: string, token: string, value: any) {
		if (token !== this.signingToken) return { outcome: 'not-owner' as const, row: this.row };
		if (this.markSignedMode === 'throw-before') throw new Error('write uncertain before commit');
		Object.assign(this.row, { status: 'signed', txHash: value.hash, signedBlob: value.signedBlob,
			lastLedgerSequence: value.lastLedgerSequence });
		if (this.markSignedMode === 'write-then-throw') throw new Error('write committed, response lost');
		return { outcome: 'transitioned' as const, row: this.row };
	}
	async markSigningFailed(_m: string, _i: string, token: string) {
		if (token !== this.signingToken || this.row.status !== 'prepared') return { outcome: 'not-owner' as const, row: this.row };
		this.row.status = 'failed'; this.signingToken = null; this.releases++;
		return { outcome: 'transitioned' as const, row: this.row };
	}
	async markFailed() { if (this.row.status === 'prepared' && !this.signingToken) this.releases++;
		this.row.status = 'failed'; return { outcome: 'transitioned' as const, row: this.row }; }
	async markSettlementUnknown(_m: string, _i: string, at: string) { this.row.status = 'settlement_unknown';
		this.row.settlementUnknownAt = at; return { outcome: 'transitioned' as const, row: this.row }; }
	async cacheMerchantResponse(_m: string, _i: string, value: any) { this.row.merchantResponse = structuredClone(value.response);
		return { outcome: 'transitioned' as const, row: this.row }; }
	async markSettled(_m: string, _i: string, value: any) { Object.assign(this.row, { status: 'settled',
		ledgerIndex: value.ledgerIndex, deliveredAmount: value.deliveredAmount, settledAt: value.at });
		return { outcome: 'transitioned' as const, row: this.row }; }
	async markDelivered(_m: string, _i: string, value: any) { Object.assign(this.row, { status: 'delivered',
		result: structuredClone(value.result), deliveredAt: value.at }); return { outcome: 'transitioned' as const, row: this.row }; }
	async markExpiredAbsentFailed(_m: string, _i: string, value: any) {
		const range = Array.from({ length: this.row.lastLedgerSequence - this.row.firstEligibleLedgerIndex + 1 },
			(_, index) => this.row.firstEligibleLedgerIndex + index);
		if (value.lookupCode !== 'txnNotFound' || value.validatedLedgerIndex <= this.row.lastLedgerSequence ||
			JSON.stringify(value.inclusionLedgersChecked) !== JSON.stringify(range)) {
			return { outcome: 'invalid-evidence' as const, row: this.row };
		}
		if (this.row.status !== 'failed') this.releases++;
		Object.assign(this.row, { status: 'failed', failure: { code: 'expired_absent',
			validated_ledger_index: value.validatedLedgerIndex,
			checked_from: this.row.firstEligibleLedgerIndex, checked_through: this.row.lastLedgerSequence,
			hash: value.hash } });
		return { outcome: 'transitioned' as const, row: this.row };
	}
	async markValidatedFailed(_m: string, _i: string, value: any) {
		if (value.hash !== this.row.txHash || value.validated !== true || value.transactionFound !== true ||
			!/^tec[A-Z0-9_]{1,64}$/.test(value.transactionResult) ||
			value.validatedLedgerIndex < this.row.firstEligibleLedgerIndex ||
			value.validatedLedgerIndex > this.row.lastLedgerSequence) {
			return { outcome: 'invalid-evidence' as const, row: this.row };
		}
		if (this.row.status !== 'failed') this.releases++;
		Object.assign(this.row, { status: 'failed', failure: { code: 'validated_transaction_failure',
			validated_ledger_index: value.validatedLedgerIndex, hash: value.hash } });
		return { outcome: 'transitioned' as const, row: this.row };
	}
}

class FakeSequenceAuthority {
	lease: any = null;
	events: string[] = [];
	failNextRelease = false;
	private identity(input: any) {
		return this.lease && this.lease.network === input.network && this.lease.payer === input.payer &&
			this.lease.generation === input.generation && this.lease.token === input.token &&
			this.lease.rail === input.rail && this.lease.attemptId === input.attemptId;
	}
	async get({ network, payer }: any) {
		return this.lease?.network === network && this.lease?.payer === payer ? structuredClone(this.lease) : null;
	}
	async acquire(input: any) {
		if (this.lease && this.lease.state !== 'released') {
			return { outcome: this.lease.rail === input.rail && this.lease.attemptId === input.attemptId
				? 'replay' as const : 'blocked' as const, lease: structuredClone(this.lease) };
		}
		this.lease = { network: input.network, payer: input.payer,
			generation: (this.lease?.generation ?? 0) + 1, token: input.token, rail: input.rail,
			attemptId: input.attemptId, state: 'preparing', sequence: null,
			firstEligibleLedgerIndex: null, lastLedgerSequence: null, hash: null,
			acquiredAt: input.at, signingStartedAt: null, signedAt: null, updatedAt: input.at,
			releasedAt: null, releaseReason: null, resolutionLedgerIndex: null };
		this.events.push(`acquire:${input.attemptId}`);
		return { outcome: 'acquired' as const, lease: structuredClone(this.lease) };
	}
	async markSigningStarted(input: any) {
		if (!this.identity(input) || this.lease.state !== 'preparing') {
			return { outcome: 'blocked' as const, lease: structuredClone(this.lease) };
		}
		Object.assign(this.lease, { state: 'signing', sequence: input.sequence,
			firstEligibleLedgerIndex: input.firstEligibleLedgerIndex,
			lastLedgerSequence: input.lastLedgerSequence, signingStartedAt: input.at, updatedAt: input.at });
		this.events.push(`signing:${input.attemptId}`);
		return { outcome: 'transitioned' as const, lease: structuredClone(this.lease) };
	}
	async markSigned(input: any) {
		if (!this.identity(input) || (this.lease.state !== 'signing' &&
			!(['signed', 'settlement_unknown'].includes(this.lease.state) && this.lease.hash === input.hash))) {
			return { outcome: 'blocked' as const, lease: structuredClone(this.lease) };
		}
		const replay = this.lease.state !== 'signing';
		Object.assign(this.lease, { state: this.lease.state === 'settlement_unknown' ? 'settlement_unknown' : 'signed',
			hash: input.hash, signedAt: this.lease.signedAt ?? input.at, updatedAt: input.at });
		this.events.push(`signed:${input.attemptId}`);
		return { outcome: replay ? 'replay' as const : 'transitioned' as const, lease: structuredClone(this.lease) };
	}
	async markSettlementUnknown(input: any) {
		if (!this.identity(input) || !['signed', 'settlement_unknown'].includes(this.lease.state) ||
			this.lease.hash !== input.hash) return { outcome: 'blocked' as const, lease: structuredClone(this.lease) };
		const replay = this.lease.state === 'settlement_unknown';
		Object.assign(this.lease, { state: 'settlement_unknown', updatedAt: input.at });
		return { outcome: replay ? 'replay' as const : 'transitioned' as const, lease: structuredClone(this.lease) };
	}
	async releasePreSign(input: any) {
		if (!this.identity(input) || this.lease.state !== 'preparing') {
			return { outcome: 'blocked' as const, lease: structuredClone(this.lease) };
		}
		Object.assign(this.lease, { state: 'released', releasedAt: input.at,
			releaseReason: 'pre_sign', updatedAt: input.at });
		this.events.push(`release-pre:${input.attemptId}`);
		return { outcome: 'released' as const, lease: structuredClone(this.lease) };
	}
	private releaseTerminal(input: any, reason: string, resolution: number) {
		if (this.failNextRelease) { this.failNextRelease = false; throw new Error('release response lost'); }
		if (!this.identity(input) || !['signed', 'settlement_unknown'].includes(this.lease.state) ||
			this.lease.hash !== input.hash) return { outcome: 'blocked' as const, lease: structuredClone(this.lease) };
		Object.assign(this.lease, { state: 'released', releasedAt: input.at,
			releaseReason: reason, resolutionLedgerIndex: resolution, updatedAt: input.at });
		this.events.push(`release-${reason}:${input.attemptId}`);
		return { outcome: 'released' as const, lease: structuredClone(this.lease) };
	}
	async releaseValidatedTerminal(input: any) {
		return this.releaseTerminal(input, 'validated_terminal', input.evidence.ledgerIndex);
	}
	async releaseExpiredAbsent(input: any) {
		return this.releaseTerminal(input, 'expired_absent', input.evidence.validatedLedgerIndex);
	}
}

function setup(options: { status?: 'ACTIVE' | 'REVOKED'; ambiguous?: boolean; sourceTag?: number;
	store?: FakeStore; clock?: Date[]; payer?: Wallet; sequenceAuthority?: FakeSequenceAuthority;
	idStart?: number } = {}) {
	const payer = options.payer ?? Wallet.generate(); const store = options.store ?? new FakeStore();
	let status = options.status ?? 'ACTIVE';
	const sequenceAuthority = options.sequenceAuthority ?? new FakeSequenceAuthority();
	let merchant = getCatalogMerchant(args.merchant_id)!; let ids = options.idStart ?? 1; let tick = 0;
	const signPayment = vi.fn(async ({ payment }: any) => payer.sign(payment));
	const recoverMerchant = vi.fn(async ({ preparedContext }: any) => response(preparedContext.intent.intentId));
	const exchangeMerchant = vi.fn(async (input: any) => {
		const accepted = challenge(input.trustedRegistryUrl, options.sourceTag ?? 2610240);
		const paid = await input.preparePaidRequest(accepted, STATE);
		if (options.ambiguous) throw new Error('post-payment response lost');
		return { challenge: accepted, challengeState: STATE, txHash: paid.signedPayment.hash,
			merchantResponse: response(paid.mastercardIntent.intentId) };
	});
	const services: Ap4mPurchaseServices = { store: store as any,
		sequenceAuthority: () => sequenceAuthority as any, getMerchant: () => merchant,
		getMandate: async (_ctx, id) => mandate(status, id), getPolicy: async () => ({ ...DEFAULT_POLICY,
			ap4m_enabled: true, issuer_allowlist: ['RLUSD'] }), getDailySpentUsd: async () => '0',
		getBaseDailySpentUsd: async () => 0, getPayer: async () => payer.classicAddress,
		getRecoveryKek: async () => KEK, prepareExecution: async ({ payer: expectedPayer }) => ({
			l1: fixture.vi.l1, l2: fixture.vi.l2, payer: expectedPayer, credentialIds: ['B'.repeat(64)],
			preparation: { sequence: 1, validatedLedgerIndex: 100, feeDrops: '12' }, agentKid: fixture.keys.agent_kid,
			agentIssuer: 'https://harbor.example/ap4m/agent', networkAudience: 'https://harbor.example/ap4m/network',
			merchantAudience: 'https://merchant.example', recoveryKek: KEK,
			withAgentSigner: async () => { throw new Error('fixture VI is injected'); } }),
		mintVi: async ({ intent }) => ({ intent, checkoutPayload: fixture.vi.checkout_payload,
			checkoutHash: fixture.vi.checkout_hash, l3a: fixture.vi.l3a, l3b: fixture.vi.l3b,
			l3aDigest: fixture.vi.l3a_digest, l3bDigest: fixture.vi.l3b_digest }),
		signPayment, exchangeMerchant, recoverMerchant, expectedSourceTag: 2610240,
		reconcile: async ({ attempt, payment }) => ({ status: 'validated', evidence: settlementEvidence(attempt, payment) }),
		now: () => options.clock?.[Math.min(tick++, options.clock.length - 1)] ?? NOW,
		uuid: () => `00000000-0000-4000-8000-${String(ids++).padStart(12, '0')}` };
	return { store, sequenceAuthority, services, signPayment, exchangeMerchant, recoverMerchant, payer,
		setStatus: (next: 'ACTIVE' | 'REVOKED') => { status = next; },
		removeMerchant: () => { services.getMerchant = () => undefined; },
		mutateMerchant: () => { const changed = structuredClone(merchant); changed.base_url = 'https://changed.example';
			changed.xrpl_address = Wallet.generate().classicAddress; changed.products[0]!.price.value = '4.99'; merchant = changed; } };
}

const ctx = (services: Ap4mPurchaseServices) => ({ principal: 'test-principal', ap4mServices: services });

describe('ap4m.purchase operation', () => {
	it('binds discounted amount and replays delivered result after revoke/registry removal without effects', async () => {
		const test = setup(); const first = await handleAp4mPurchase(ctx(test.services), args);
		expect(first.receipt.amount.value).toBe('0.75');
		expect(test.store.context).toMatchObject({ challengeState: STATE, payer: test.payer.classicAddress });
		expect(test.store.context.vi.l2).not.toBe(fixture.vi.l2);
		test.setStatus('REVOKED'); test.removeMerchant();
		expect(await handleAp4mPurchase(ctx(test.services), args)).toEqual(first);
		expect(test.signPayment).toHaveBeenCalledTimes(1); expect(test.exchangeMerchant).toHaveBeenCalledTimes(1);
	});

	it('blocks a new revoked attempt before payer/network/signing', async () => {
		const test = setup({ status: 'REVOKED' }); const payer = vi.fn(test.services.getPayer!); test.services.getPayer = payer;
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({ code: 'MANDATE_NOT_ACTIVE' });
		expect(payer).not.toHaveBeenCalled(); expect(test.exchangeMerchant).not.toHaveBeenCalled();
		expect(test.signPayment).not.toHaveBeenCalled();
	});

	it('blocks a disabled payer as PAYER_FROZEN before reservation, preparation, or signing', async () => {
		const test = setup();
		const resolvePayer = vi.fn(async () => ({
			status: 'disabled' as const,
			payer: test.payer.classicAddress,
		}));
		const prepareExecution = vi.fn(test.services.prepareExecution!);
		test.services.resolvePayer = resolvePayer;
		test.services.prepareExecution = prepareExecution;

		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({
			code: 'PAYER_FROZEN',
			message: 'AP4M payer is frozen',
		});
		expect(resolvePayer).toHaveBeenCalledOnce();
		expect(prepareExecution).not.toHaveBeenCalled();
		expect(test.sequenceAuthority.lease).toBeNull();
		expect(test.exchangeMerchant).not.toHaveBeenCalled();
		expect(test.signPayment).not.toHaveBeenCalled();
	});

	it('does not sign or reacquire a challenge for a prepared attempt revoked after reserve', async () => {
		const test = setup();
		await handleAp4mPurchase(ctx(test.services), args);
		Object.assign(test.store.row, { status: 'prepared', signedBlob: null, txHash: null,
			merchantResponse: null, result: null, signingStartedAt: null, firstEligibleLedgerIndex: null });
		test.store.signingToken = null;
		test.setStatus('REVOKED'); test.removeMerchant();
		const priorSigns = test.signPayment.mock.calls.length;
		const priorExchanges = test.exchangeMerchant.mock.calls.length;
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({ code: 'MANDATE_NOT_ACTIVE' });
		expect(test.signPayment).toHaveBeenCalledTimes(priorSigns);
		expect(test.exchangeMerchant).toHaveBeenCalledTimes(priorExchanges);
	});

	it('blocks a prepared attempt when the payer is disabled without a second signature', async () => {
		const test = setup();
		await handleAp4mPurchase(ctx(test.services), args);
		Object.assign(test.store.row, {
			status: 'prepared',
			signedBlob: null,
			txHash: null,
			merchantResponse: null,
			result: null,
			signingStartedAt: null,
			firstEligibleLedgerIndex: null,
		});
		test.store.signingToken = null;
		const priorSigns = test.signPayment.mock.calls.length;
		const priorExchanges = test.exchangeMerchant.mock.calls.length;
		test.services.resolvePayer = async () => ({
			status: 'disabled',
			payer: test.payer.classicAddress,
		});

		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({
			code: 'PAYER_FROZEN',
		});
		expect(test.signPayment).toHaveBeenCalledTimes(priorSigns);
		expect(test.exchangeMerchant).toHaveBeenCalledTimes(priorExchanges);
	});

	it('rejects stored merchant mismatch before registry/network', async () => {
		const store = new FakeStore(); store.exists = true; store.row.merchantId = 'other'; const test = setup({ store });
		test.removeMerchant();
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
		expect(test.exchangeMerchant).not.toHaveBeenCalled();
	});

	it('recovers a revoked signed attempt from persisted state with no fresh challenge or re-sign', async () => {
		const test = setup({ ambiguous: true });
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({ code: 'SETTLEMENT_UNKNOWN' });
		test.setStatus('REVOKED'); test.removeMerchant();
		expect((await handleAp4mPurchase(ctx(test.services), args)).receipt.amount.value).toBe('0.75');
		expect(test.exchangeMerchant).toHaveBeenCalledTimes(1); expect(test.recoverMerchant).toHaveBeenCalledTimes(1);
		expect(test.signPayment).toHaveBeenCalledTimes(1);
	});

	it('reconciles an already-signed attempt even after its payer is disabled', async () => {
		const test = setup({ ambiguous: true });
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({ code: 'SETTLEMENT_UNKNOWN' });
		const resolvePayer = vi.fn(async () => ({
			status: 'disabled' as const,
			payer: test.payer.classicAddress,
		}));
		test.services.resolvePayer = resolvePayer;

		expect((await handleAp4mPurchase(ctx(test.services), args)).receipt.amount.value).toBe('0.75');
		expect(resolvePayer).not.toHaveBeenCalled();
		expect(test.signPayment).toHaveBeenCalledTimes(1);
		expect(test.exchangeMerchant).toHaveBeenCalledTimes(1);
		expect(test.recoverMerchant).toHaveBeenCalledTimes(1);
	});

	it('replays exact paid request once on pending, then reconciles before delivery', async () => {
		const test = setup({ ambiguous: true });
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({ code: 'SETTLEMENT_UNKNOWN' });
		let calls = 0; test.services.reconcile = async ({ attempt, payment }) => ++calls === 1 ? { status: 'pending' } :
			({ status: 'validated', evidence: settlementEvidence(attempt, payment) });
		await handleAp4mPurchase(ctx(test.services), args);
		expect(calls).toBe(2); expect(test.recoverMerchant).toHaveBeenCalledTimes(1);
		expect(test.exchangeMerchant).toHaveBeenCalledTimes(1); expect(test.signPayment).toHaveBeenCalledTimes(1);
	});

	it('recovers a durable settled row after shared-lease release response is lost', async () => {
		const test = setup();
		test.sequenceAuthority.failNextRelease = true;
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toThrow('release response lost');
		expect(test.store.row.status).toBe('settled');
		expect(test.sequenceAuthority.lease).toMatchObject({ state: 'signed' });
		const recovered = await handleAp4mPurchase(ctx(test.services), args);
		expect(recovered.receipt.settlement).toBe('validated');
		expect(test.sequenceAuthority.lease).toMatchObject({
			state: 'released', releaseReason: 'validated_terminal',
		});
		expect(test.signPayment).toHaveBeenCalledTimes(1);
		expect(test.exchangeMerchant).toHaveBeenCalledTimes(1);
	});

	it('does not cache a cross-binding-invalid merchant 200 and recovers with the exact paid retry', async () => {
		const test = setup();
		test.services.exchangeMerchant = vi.fn(async (input: any) => {
			const paid = await input.preparePaidRequest(challenge(input.trustedRegistryUrl), STATE);
			return { challenge: challenge(input.trustedRegistryUrl), challengeState: STATE,
				txHash: paid.signedPayment.hash, merchantResponse: response('wrong-intent') };
		});
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({ code: 'SETTLEMENT_UNKNOWN' });
		expect(test.store.row.merchantResponse).toBeNull();
		expect(test.signPayment).toHaveBeenCalledTimes(1);
		const recovered = await handleAp4mPurchase(ctx(test.services), args);
		expect(recovered.receipt.merchant_validation.intentId).toBe(test.store.context.intent.intentId);
		expect(test.recoverMerchant).toHaveBeenCalledTimes(1);
		expect(test.signPayment).toHaveBeenCalledTimes(1);
	});

	it('rejects asserted validated status when the raw ledger evidence hash is wrong', async () => {
		const test = setup({ ambiguous: true });
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({ code: 'SETTLEMENT_UNKNOWN' });
		test.services.reconcile = async ({ attempt, payment }) => ({ status: 'validated', evidence: {
			...settlementEvidence(attempt, payment), hash: 'F'.repeat(64),
		} });
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({ code: 'SETTLEMENT_UNKNOWN' });
		expect(test.store.row.status).toBe('settlement_unknown');
		expect(test.store.row.settledAt).toBeNull();
		expect(test.store.releases).toBe(0);
	});

	it('does not release an unvalidated tec lookup result', async () => {
		const test = setup({ ambiguous: true });
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({ code: 'SETTLEMENT_UNKNOWN' });
		test.services.reconcile = async ({ attempt, payment }) => {
			const evidence = settlementEvidence(attempt, payment);
			evidence.validated = false;
			(evidence.meta as any).TransactionResult = 'tecPATH_DRY';
			return { status: 'validated', evidence };
		};
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({ code: 'SETTLEMENT_UNKNOWN' });
		expect(test.store.releases).toBe(0);
		expect(test.store.row.status).toBe('settlement_unknown');
	});

	it('releases exactly once for an exact validated tec transaction result', async () => {
		const test = setup({ ambiguous: true });
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({ code: 'SETTLEMENT_UNKNOWN' });
		test.services.reconcile = async ({ attempt, payment }) => {
			const evidence = settlementEvidence(attempt, payment);
			(evidence.meta as any).TransactionResult = 'tecPATH_DRY';
			return { status: 'validated', evidence };
		};
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({ code: 'PURCHASE_FAILED' });
		expect(test.store.releases).toBe(1);
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({ code: 'PURCHASE_FAILED' });
		expect(test.store.releases).toBe(1);
	});

	it('recovers a durable validated-failure row after shared-lease release response is lost', async () => {
		const test = setup({ ambiguous: true });
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({ code: 'SETTLEMENT_UNKNOWN' });
		test.services.reconcile = async ({ attempt, payment }) => {
			const evidence = settlementEvidence(attempt, payment);
			(evidence.meta as any).TransactionResult = 'tecPATH_DRY';
			return { status: 'validated', evidence };
		};
		test.sequenceAuthority.failNextRelease = true;
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toThrow('release response lost');
		expect(test.store.row).toMatchObject({
			status: 'failed',
			failure: { code: 'validated_transaction_failure', validated_ledger_index: 119 },
		});
		expect(test.sequenceAuthority.lease).toMatchObject({ state: 'settlement_unknown' });
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({ code: 'PURCHASE_FAILED' });
		expect(test.sequenceAuthority.lease).toMatchObject({
			state: 'released', releaseReason: 'validated_terminal', resolutionLedgerIndex: 119,
		});
		expect(test.signPayment).toHaveBeenCalledTimes(1);
	});

	it('keeps pending/incomplete-absence attempts reserved and releases exhaustive absence exactly once', async () => {
		const test = setup({ ambiguous: true });
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({ code: 'SETTLEMENT_UNKNOWN' });
		test.services.reconcile = async () => ({ status: 'pending' });
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({ code: 'SETTLEMENT_UNKNOWN' });
		expect(test.store.releases).toBe(0);
		test.services.reconcile = async () => ({ status: 'expired_absent', lookupCode: 'txnNotFound',
			validatedLedgerIndex: 130, firstEligibleLedgerIndex: 101, inclusionLedgersChecked: [101] });
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({ code: 'SETTLEMENT_UNKNOWN' });
		expect(test.store.releases).toBe(0);
		const lls = test.store.row.lastLedgerSequence as number;
		test.services.reconcile = async () => ({ status: 'expired_absent', lookupCode: 'txnNotFound',
			validatedLedgerIndex: lls + 1, firstEligibleLedgerIndex: 101,
			inclusionLedgersChecked: Array.from({ length: lls - 100 }, (_, i) => 101 + i) });
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({ code: 'PURCHASE_FAILED' });
		expect(test.store.releases).toBe(1);
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({ code: 'PURCHASE_FAILED' });
		expect(test.store.releases).toBe(1);
	});

	it('recovers a durable expired-absence row after shared-lease release response is lost', async () => {
		const test = setup({ ambiguous: true });
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({ code: 'SETTLEMENT_UNKNOWN' });
		const lls = test.store.row.lastLedgerSequence as number;
		test.services.reconcile = async () => ({ status: 'expired_absent', lookupCode: 'txnNotFound',
			validatedLedgerIndex: lls + 1, firstEligibleLedgerIndex: 101,
			inclusionLedgersChecked: Array.from({ length: lls - 100 }, (_, i) => 101 + i) });
		test.sequenceAuthority.failNextRelease = true;
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toThrow('release response lost');
		expect(test.store.row).toMatchObject({
			status: 'failed',
			failure: {
				code: 'expired_absent', validated_ledger_index: lls + 1,
				checked_from: 101, checked_through: lls,
			},
		});
		expect(test.sequenceAuthority.lease).toMatchObject({ state: 'settlement_unknown' });
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({ code: 'PURCHASE_FAILED' });
		expect(test.sequenceAuthority.lease).toMatchObject({
			state: 'released', releaseReason: 'expired_absent', resolutionLedgerIndex: lls + 1,
		});
		expect(test.signPayment).toHaveBeenCalledTimes(1);
	});

	it.each([undefined, 2610241])('rejects missing/wrong SourceTag %s before reserve/sign', async (tag) => {
		const test = setup({ sourceTag: tag });
		if (tag === undefined) test.services.exchangeMerchant = vi.fn(async (input: any) => {
			const invalid = challenge(input.trustedRegistryUrl); delete (invalid as any).sourceTag;
			await input.preparePaidRequest(invalid, STATE); throw new Error('unreachable');
		});
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({ code: 'INVALID_PURCHASE' });
		expect(test.store.reserves).toBe(0); expect(test.signPayment).not.toHaveBeenCalled();
	});

	it('permanently fences a signer failure after signing began', async () => {
		const test = setup(); test.services.signPayment = vi.fn(async () => { throw new Error('sign failed'); });
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({ code: 'SETTLEMENT_UNKNOWN' });
		expect(test.store.row.txHash).toBeNull(); expect(test.store.releases).toBe(0);
		expect(test.sequenceAuthority.lease).toMatchObject({ state: 'signing', hash: null });
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({ code: 'SETTLEMENT_UNKNOWN' });
		expect(test.services.signPayment).toHaveBeenCalledTimes(1);
	});

	it('surfaces a payer freeze racing after preparation while permanently fencing the signing lease', async () => {
		const test = setup();
		test.services.signPayment = vi.fn(async () => {
			throw new Ap4mPurchaseError('AP4M payer is frozen', 'PAYER_FROZEN');
		});

		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({
			code: 'PAYER_FROZEN',
			message: 'AP4M payer is frozen',
		});
		expect(test.store.row).toMatchObject({ status: 'prepared', txHash: null });
		expect(test.store.releases).toBe(0);
		expect(test.sequenceAuthority.lease).toMatchObject({ state: 'signing', hash: null });

		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({
			code: 'SETTLEMENT_UNKNOWN',
		});
		expect(test.services.signPayment).toHaveBeenCalledTimes(1);
	});

	it('releases the shared payer lease only when preparation proves signing never began', async () => {
		const test = setup();
		test.services.prepareExecution = vi.fn(async () => { throw new Error('read-only preparation failed'); });
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toThrow('read-only preparation failed');
		expect(test.sequenceAuthority.lease).toMatchObject({
			state: 'released', releaseReason: 'pre_sign', signingStartedAt: null, hash: null,
		});
		expect(test.sequenceAuthority.events).toEqual([
			expect.stringMatching(/^acquire:/), expect.stringMatching(/^release-pre:/),
		]);
		expect(test.signPayment).not.toHaveBeenCalled();
	});

	it.each([false, true])('serializes distinct mandates and idempotencies sharing one payer (reverse=%s)', async (reverse) => {
		const sharedPayer = Wallet.generate();
		const sharedAuthority = new FakeSequenceAuthority();
		const first = setup({ payer: sharedPayer, sequenceAuthority: sharedAuthority, idStart: reverse ? 100 : 1 });
		const second = setup({ payer: sharedPayer, sequenceAuthority: sharedAuthority, idStart: reverse ? 1 : 100 });
		const otherArgs = { ...args, mandate_id: 'mandate-test-2', idempotency_key: 'purchase-request-0002' };
		const firstArgs = reverse ? otherArgs : args;
		const secondArgs = reverse ? args : otherArgs;
		const secondPrepare = vi.fn(second.services.prepareExecution!);
		second.services.prepareExecution = secondPrepare;
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => { release = resolve; });
		const signer = first.services.signPayment!;
		first.services.signPayment = vi.fn(async (input) => { await barrier; return signer(input); });
		const winner = handleAp4mPurchase(ctx(first.services), firstArgs);
		while (sharedAuthority.lease?.state !== 'signing') await new Promise((resolve) => setTimeout(resolve, 0));
		await expect(handleAp4mPurchase(ctx(second.services), secondArgs)).rejects.toMatchObject({
			code: 'PURCHASE_IN_PROGRESS',
		});
		expect(secondPrepare).not.toHaveBeenCalled();
		expect(second.signPayment).not.toHaveBeenCalled();
		release();
		expect((await winner).receipt.settlement).toBe('validated');
		expect(sharedAuthority.lease).toMatchObject({ state: 'released', releaseReason: 'validated_terminal' });
	});

	it('fences a concurrent non-owner while one delayed signer owns the lease', async () => {
		const test = setup(); let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; });
		const signer = test.services.signPayment!; test.services.signPayment = vi.fn(async (input) => { await wait; return signer(input); });
		const first = handleAp4mPurchase(ctx(test.services), args);
		while (!test.store.row.signingStartedAt) await new Promise((resolve) => setTimeout(resolve, 0));
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({ code: 'SETTLEMENT_UNKNOWN' });
		expect(test.services.signPayment).toHaveBeenCalledTimes(1); expect(test.store.releases).toBe(0);
		release(); expect((await first).receipt.settlement).toBe('validated');
	});

	it('permanently fences a stale sign-started attempt with no durable hash', async () => {
		const test = setup(); await handleAp4mPurchase(ctx(test.services), args);
		const oldToken = '00000000-0000-4000-8000-000000009999';
		Object.assign(test.store.row, { status: 'prepared', signedBlob: null, txHash: null,
			merchantResponse: null, result: null, signingStartedAt: '2026-10-21T11:00:00.000Z',
			firstEligibleLedgerIndex: 101 });
		test.store.signingToken = oldToken;
		const priorSigns = test.signPayment.mock.calls.length;
		const priorExchanges = test.exchangeMerchant.mock.calls.length;
		test.removeMerchant();
		await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({ code: 'SETTLEMENT_UNKNOWN' });
		expect(test.signPayment).toHaveBeenCalledTimes(priorSigns);
		expect(test.exchangeMerchant).toHaveBeenCalledTimes(priorExchanges);
		expect(test.store.signingToken).toBe(oldToken);
		expect(test.store.row).toMatchObject({ status: 'prepared', signingStartedAt: '2026-10-21T11:00:00.000Z',
			txHash: null, signedBlob: null });
	});

	it.each(['throw-before', 'write-then-throw'] as const)('classifies uncertain markSigned outcome: %s', async (mode) => {
		const store = new FakeStore(); store.markSignedMode = mode; const test = setup({ store });
		if (mode === 'throw-before') {
			await expect(handleAp4mPurchase(ctx(test.services), args)).rejects.toMatchObject({ code: 'SETTLEMENT_UNKNOWN' });
			expect(store.releases).toBe(0); expect(store.row.txHash).toBeNull();
			expect(test.sequenceAuthority.lease).toMatchObject({ state: 'signing', hash: null });
		} else {
			expect((await handleAp4mPurchase(ctx(test.services), args)).receipt.settlement).toBe('validated');
			expect(store.releases).toBe(0); expect(store.row.txHash).toMatch(/^[A-F0-9]{64}$/);
		}
	});

	it('resolves UTC day immediately before reserve across midnight', async () => {
		const before = new Date('2026-10-21T23:59:59.900Z'); const after = new Date('2026-10-22T00:00:00.100Z');
		const test = setup({ clock: [before, after, after, after, after, after] });
		await handleAp4mPurchase(ctx(test.services), args);
		expect(test.store.lastReserve).toMatchObject({ spendDay: '2026-10-22', preparedAt: after.toISOString() });
	});
});
