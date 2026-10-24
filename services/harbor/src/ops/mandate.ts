import { hashes, isValidClassicAddress } from 'xrpl';
import { z } from 'zod';

import type { OpContext, OpDef } from '../catalog/registry';
import { MandateConstraintsSchema, MandateSchema, type Mandate, type Merchant } from '../contracts';
import { requestXrpl } from '../adapters/xrpl-rpc';
import { loadKmsKek, readKmsMode, type KmsEnv } from '../aws/kms';
import { buildMandateTransactions, type PreparedMandateTransactions } from '../exec/mandate-batch';
import {
	createWrappedMandateKeys,
	createWrappedMandateKeysWithCryptoKey,
	wrapMandateViChain,
	wrapMandateViChainWithCryptoKey,
	type WrappedMandateKeys,
} from '../exec/mandate-keys';
import { MandateStore, type InsertPreparedMandate, type StoredMandate } from '../exec/mandate-store';
import { verifyAp4mReferenceViChain, type VerifiedViChain } from '../exec/mandate-vi';
import { getCatalogMerchant } from './merchants';

type JsonObject = Record<string, unknown>;

const OwnerSchema = z.string().refine(isValidClassicAddress, 'owner must be a valid XRPL classic address');
const DecimalSchema = z.string().regex(/^(0|[1-9]\d*)(?:\.\d{1,2})?$/, 'must be a nonnegative USD amount in integer cents');
const ConstraintsInputSchema = MandateConstraintsSchema.extend({
	per_payment_max: DecimalSchema, total_max: DecimalSchema, daily_max: DecimalSchema,
}).strict();

function decimalMicrousd(value: string): bigint {
	const [whole, fraction = ''] = value.split('.');
	return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

export const MandatePrepareArgsSchema = z.object({
	owner: OwnerSchema,
	network: z.literal('testnet'),
	constraints: ConstraintsInputSchema,
	payees: z.array(z.string().trim().min(1)).min(1).max(7),
	expires_at: z.string().datetime(),
}).strict().superRefine((value, issue) => {
	if (new Set(value.payees).size !== value.payees.length) issue.addIssue({ code: 'custom', path: ['payees'], message: 'payees must be unique' });
	if (JSON.stringify(value.constraints.payees) !== JSON.stringify(value.payees)) {
		issue.addIssue({ code: 'custom', path: ['constraints', 'payees'], message: 'constraints.payees must exactly match payees' });
	}
	if (decimalMicrousd(value.constraints.per_payment_max) > decimalMicrousd(value.constraints.daily_max)) issue.addIssue({ code: 'custom', path: ['constraints', 'per_payment_max'], message: 'per-payment maximum exceeds daily maximum' });
	if (decimalMicrousd(value.constraints.daily_max) > decimalMicrousd(value.constraints.total_max)) issue.addIssue({ code: 'custom', path: ['constraints', 'daily_max'], message: 'daily maximum exceeds total maximum' });
});

export const MandateRegisterArgsSchema = z.object({
	mandate_id: z.string().min(1), l1: z.string().min(1), l2: z.string().min(1),
	setup_tx_hash: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
}).strict();
export const MandateIdArgsSchema = z.object({ mandate_id: z.string().min(1) }).strict();

export interface MandateLedgerSnapshot {
	sequence: number;
	feeDrops: string;
	lastLedgerSequence: number;
}

export interface VerifiedMandateSetup {
	setupBatchHash: string;
	channels: Mandate['channels'];
}

export interface MandateServices {
	store?: Pick<MandateStore, 'insertPrepared' | 'get' | 'activate' | 'revoke'>;
	now?: () => Date;
	randomUUID?: () => string;
	getMerchant?: (id: string) => Merchant | undefined;
	generateKeys?: typeof createWrappedMandateKeys;
	ledgerSnapshot?: (ctx: OpContext, owner: string) => Promise<MandateLedgerSnapshot>;
	prepareTransactions?: typeof buildMandateTransactions;
	verifyVi?: typeof verifyAp4mReferenceViChain;
	channelAmountDrops?: (ctx: OpContext, totalUsd: string) => Promise<string>;
	trustedIssuerJwk?: JsonWebKey;
	expectedIssuer?: string;
	expectedIssuerKid?: string;
	expectedAudience?: string;
	verifySetup?: (ctx: OpContext, hash: string | string[], prepared: StoredMandate, l2Digest: string) => Promise<VerifiedMandateSetup>;
}

type MandateContext = OpContext & { db?: D1Database; env?: unknown; mandateServices?: MandateServices };

function record(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function configured(ctx: OpContext): MandateServices {
	return (ctx as MandateContext).mandateServices ?? {};
}

function storeFor(ctx: OpContext, services: MandateServices) {
	if (services.store) return services.store;
	const typed = ctx as MandateContext;
	const db = typed.db ?? (record(typed.env) ? typed.env.DB as D1Database | undefined : undefined);
	if (!db) throw new Error('mandate store is not configured');
	return new MandateStore(db, ctx.principal);
}

function envString(ctx: OpContext, name: string): string {
	const env = (ctx as MandateContext).env;
	const value = record(env) ? env[name] : undefined;
	if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is not configured`);
	return value;
}

function kmsEnv(ctx: OpContext): KmsEnv {
	const env = (ctx as MandateContext).env;
	return (record(env) ? env : {}) as KmsEnv;
}

function mockDollarsToDrops(value: string): string {
	const [whole, fraction = ''] = value.split('.');
	const normalized = `${whole}${fraction.padEnd(6, '0').slice(0, 6)}`.replace(/^0+(?=\d)/, '');
	return normalized || '0';
}

async function channelAmountDrops(ctx: OpContext, services: MandateServices, totalUsd: string): Promise<string> {
	if (services.channelAmountDrops) return services.channelAmountDrops(ctx, totalUsd);
	const env = (ctx as MandateContext).env;
	if (!record(env) || env.HARBOR_MOCK !== '1') {
		throw new Error('live USD-to-XRP channel valuation is not configured');
	}
	return mockDollarsToDrops(totalUsd);
}

async function defaultLedgerSnapshot(ctx: OpContext, owner: string): Promise<MandateLedgerSnapshot> {
	const [account, fee, ledger] = await Promise.all([
		requestXrpl(ctx, 'testnet', 'account_info', { account: owner, ledger_index: 'current' }),
		requestXrpl(ctx, 'testnet', 'fee'), requestXrpl(ctx, 'testnet', 'ledger_current'),
	]);
	const accountResult = record(account) && record(account.result) ? account.result : account;
	const feeResult = record(fee) && record(fee.result) ? fee.result : fee;
	const ledgerResult = record(ledger) && record(ledger.result) ? ledger.result : ledger;
	const accountData = record(accountResult) && record(accountResult.account_data) ? accountResult.account_data : undefined;
	const drops = record(feeResult) && record(feeResult.drops) ? feeResult.drops : undefined;
	const sequence = accountData?.Sequence;
	const baseFee = drops?.open_ledger_fee ?? drops?.base_fee;
	const ledgerIndex = record(ledgerResult) ? ledgerResult.ledger_current_index : undefined;
	if (typeof sequence !== 'number' || typeof baseFee !== 'string' || typeof ledgerIndex !== 'number') throw new Error('XRPL preparation response is invalid');
	return { sequence, feeDrops: baseFee, lastLedgerSequence: ledgerIndex + 20 };
}

function trustedKey(ctx: OpContext, services: MandateServices): JsonWebKey {
	if (services.trustedIssuerJwk) return services.trustedIssuerJwk;
	let parsed: unknown;
	try { parsed = JSON.parse(envString(ctx, 'AP4M_DEMO_NETWORK_VI_PUBLIC_JWK')); } catch { throw new Error('AP4M Demo Network VI public key is invalid'); }
	if (!record(parsed)) throw new Error('AP4M Demo Network VI public key is invalid');
	return parsed as unknown as JsonWebKey;
}

function mandateOnly(stored: StoredMandate): Mandate {
	return MandateSchema.parse(stored.mandate);
}

function memoDigest(transaction: JsonObject): string | undefined {
	const memos = transaction.Memos;
	if (!Array.isArray(memos)) return undefined;
	for (const entry of memos) {
		if (!record(entry) || !record(entry.Memo)) continue;
		const type = entry.Memo.MemoType;
		const data = entry.Memo.MemoData;
		if (type === '6170346D2F6C32' && typeof data === 'string') return data.toLowerCase();
	}
	return undefined;
}

async function validatedTransaction(ctx: OpContext, hash: string): Promise<JsonObject> {
	const response = await requestXrpl(ctx, 'testnet', 'tx', { transaction: hash, binary: false });
	const result = record(response) && record(response.result) ? response.result : response;
	if (!record(result) || result.validated !== true) throw new Error('mandate setup transaction is not validated');
	if (typeof result.hash !== 'string' || result.hash.toUpperCase() !== hash.toUpperCase()) throw new Error('mandate setup transaction hash does not match');
	const metadata = record(result.meta) ? result.meta : undefined;
	if (!metadata || metadata.TransactionResult !== 'tesSUCCESS') throw new Error('mandate setup transaction did not succeed');
	return record(result.tx_json) ? result.tx_json : result;
}

function compareSetupTransaction(actual: JsonObject, expected: JsonObject, requireInner: boolean): void {
	if (actual.TransactionType !== expected.TransactionType || actual.Account !== expected.Account || actual.Sequence !== expected.Sequence) {
		throw new Error('mandate setup transaction does not match prepared mandate');
	}
	for (const field of ['Issuer', 'CredentialType', 'Destination', 'Amount', 'SettleDelay', 'PublicKey', 'CancelAfter']) {
		if (actual[field] !== expected[field]) throw new Error(`mandate setup ${field} does not match prepared mandate`);
	}
	if (requireInner && (actual.Flags !== 0x40000000 || actual.Fee !== '0' || actual.SigningPubKey !== '')) {
		throw new Error('mandate setup inner Batch flags or signature placeholders are invalid');
	}
}

function channelFromTransaction(actual: JsonObject, prepared: StoredMandate): Mandate['channels'][number] | undefined {
	if (actual.TransactionType !== 'PaymentChannelCreate') return undefined;
	const merchantId = prepared.claimPublicKeys.find((key) => key.public_key === actual.PublicKey)?.merchant_id;
	if (!merchantId || typeof actual.Destination !== 'string' || typeof actual.Sequence !== 'number' || typeof actual.Amount !== 'string') {
		throw new Error('mandate setup payment channel does not map to a prepared merchant');
	}
	return { merchant_id: merchantId, channel_id: hashes.hashPaymentChannel(prepared.mandate.owner, actual.Destination, actual.Sequence), amount_drops: actual.Amount };
}

/** Verify a validated atomic Batch or every transaction in its sequential fallback. */
export async function verifySetupOnLedger(
	ctx: OpContext,
	hash: string | string[],
	prepared: StoredMandate,
	l2Digest: string,
): Promise<VerifiedMandateSetup> {
	if (Array.isArray(hash)) {
		const expected = prepared.prepared.unsigned_sequential;
		if (!expected || expected.length !== hash.length) throw new Error('sequential setup transaction count does not match');
		const transactions = await Promise.all(hash.map((item) => validatedTransaction(ctx, item)));
		const channels: Mandate['channels'] = [];
		for (let index = 0; index < transactions.length; index += 1) {
			const actual = transactions[index] as JsonObject;
			compareSetupTransaction(actual, expected[index] as JsonObject, false);
			if (memoDigest(actual) !== l2Digest.toLowerCase()) throw new Error('mandate setup L2 memo digest does not match');
			const channel = channelFromTransaction(actual, prepared);
			if (channel) channels.push(channel);
		}
		if (transactions[0]?.TransactionType !== 'CredentialAccept' || channels.length !== prepared.mandate.constraints.payees.length) {
			throw new Error('sequential mandate setup credential or payment channels are incomplete');
		}
		return { setupBatchHash: hash.join(','), channels };
	}

	const tx = await validatedTransaction(ctx, hash);
	if (tx.TransactionType !== 'Batch' || tx.Account !== prepared.mandate.owner || tx.Flags !== 0x00010000) {
		throw new Error('mandate setup is not the expected all-or-nothing Batch');
	}
	if (memoDigest(tx) !== l2Digest.toLowerCase()) throw new Error('mandate setup L2 memo digest does not match');
	const raw = tx.RawTransactions;
	if (!Array.isArray(raw)) throw new Error('mandate setup Batch has no inner transactions');
	const inners = raw.map((entry) => record(entry) && record(entry.RawTransaction) ? entry.RawTransaction : null);
	if (inners.some((entry) => entry === null)) throw new Error('mandate setup Batch contains malformed inner transactions');
	const expectedRaw = prepared.prepared.unsigned_batch.RawTransactions;
	if (!Array.isArray(expectedRaw) || expectedRaw.length !== inners.length) throw new Error('mandate setup Batch transaction count does not match');
	const channels: Mandate['channels'] = [];
	for (let index = 0; index < inners.length; index += 1) {
		const actual = inners[index] as JsonObject;
		const expectedEntry = expectedRaw[index];
		const expected = record(expectedEntry) && record(expectedEntry.RawTransaction) ? expectedEntry.RawTransaction : undefined;
		if (!expected) throw new Error('prepared mandate inner transaction is malformed');
		compareSetupTransaction(actual, expected, true);
		const channel = channelFromTransaction(actual, prepared);
		if (channel) channels.push(channel);
	}
	if (inners[0]?.TransactionType !== 'CredentialAccept' || channels.length !== prepared.mandate.constraints.payees.length) {
		throw new Error('mandate setup credential or payment channels are incomplete');
	}
	return { setupBatchHash: hash, channels };
}

export async function handleMandatePrepare(ctx: OpContext, rawArgs: z.infer<typeof MandatePrepareArgsSchema>) {
	const args = MandatePrepareArgsSchema.parse(rawArgs);
	const services = configured(ctx);
	const now = (services.now ?? (() => new Date()))();
	if (Date.parse(args.expires_at) <= now.getTime()) throw new Error('mandate expiry must be in the future');
	const merchants = args.payees.map((id) => (services.getMerchant ?? getCatalogMerchant)(id));
	if (merchants.some((merchant) => !merchant || merchant.network !== 'testnet')) throw new Error('every payee must be an allowlisted testnet merchant');
	const present = merchants as Merchant[];
	const credential = present[0]?.required_credential;
	if (!credential || present.some((merchant) => JSON.stringify(merchant.required_credential) !== JSON.stringify(credential))) {
		throw new Error('all mandate payees must require the same credential');
	}
	const mandateId = (services.randomUUID ?? (() => crypto.randomUUID()))();
	const identity = { principal: ctx.principal, owner: args.owner, network: 'testnet' as const, mandateId };
	let keys: WrappedMandateKeys;
	if (services.generateKeys) {
		keys = await services.generateKeys(identity, args.payees, envString(ctx, 'HARBOR_KEK'));
	} else {
		const env = kmsEnv(ctx);
		keys = readKmsMode(env) === 'kek'
			? await createWrappedMandateKeysWithCryptoKey(identity, args.payees, await loadKmsKek(env))
			: await createWrappedMandateKeys(identity, args.payees, envString(ctx, 'HARBOR_KEK'));
	}
	const snapshot = await (services.ledgerSnapshot ?? defaultLedgerSnapshot)(ctx, args.owner);
	const claimKeys = new Map(keys.claimPublicKeys.map((key) => [key.merchant_id, key.public_key]));
	const prepared: PreparedMandateTransactions = (services.prepareTransactions ?? buildMandateTransactions)({
		owner: args.owner, ...snapshot,
		credential: { issuer: credential.issuer, credentialTypeHex: credential.credential_type_hex },
		merchants: present.map((merchant) => ({ id: merchant.id, address: merchant.xrpl_address, claimPublicKey: claimKeys.get(merchant.id) ?? '' })),
		channelAmountDrops: await channelAmountDrops(ctx, services, args.constraints.total_max), expiresAt: args.expires_at,
	});
	const insert: InsertPreparedMandate = {
		id: mandateId, owner: args.owner, notBefore: now.toISOString(), expiresAt: args.expires_at,
		constraints: args.constraints, agentPublicJwk: keys.agentPublicJwk,
		agentKeyCiphertext: keys.agentKeyCiphertext, agentKeyIv: keys.agentKeyIv,
		claimKeysCiphertext: keys.claimKeysCiphertext, claimKeysIv: keys.claimKeysIv,
		claimPublicKeys: keys.claimPublicKeys, prepared, createdAt: now.toISOString(),
	};
	await storeFor(ctx, services).insertPrepared(insert);
	return { mandate_id: mandateId, agent_public_jwk: keys.agentPublicJwk, claim_public_keys: keys.claimPublicKeys, ...prepared };
}

export async function handleMandateRegister(ctx: OpContext, rawArgs: z.infer<typeof MandateRegisterArgsSchema>): Promise<Mandate> {
	const args = MandateRegisterArgsSchema.parse(rawArgs);
	const services = configured(ctx);
	const store = storeFor(ctx, services);
	const prepared = await store.get(args.mandate_id);
	if (!prepared) throw new Error('mandate not found');
	if (prepared.mandate.status !== 'PENDING') throw new Error('mandate is not pending');
	const now = (services.now ?? (() => new Date()))();
	const verified: VerifiedViChain = await (services.verifyVi ?? verifyAp4mReferenceViChain)({
		l1: args.l1, l2: args.l2, trustedIssuerJwk: trustedKey(ctx, services),
		expectedAgentPublicJwk: prepared.mandate.agent_public_jwk,
		expectedConstraints: prepared.mandate.constraints,
		expectedIssuer: services.expectedIssuer ?? "Demo Network (Mastercard's role in production)",
		expectedIssuerKid: services.expectedIssuerKid ?? envString(ctx, 'AP4M_DEMO_NETWORK_VI_KEY_ID'),
		expectedOwner: prepared.mandate.owner,
		expectedMandateId: prepared.mandate.id,
		expectedAudience: services.expectedAudience ?? envString(ctx, 'AP4M_HARBOR_AUDIENCE'),
		notBefore: prepared.mandate.not_before,
		expiresAt: prepared.mandate.expires_at,
		now,
	});
	const setup = await (services.verifySetup ?? verifySetupOnLedger)(ctx, args.setup_tx_hash, prepared, verified.l2Digest);
	const identity = { principal: ctx.principal, owner: prepared.mandate.owner, network: 'testnet' as const, mandateId: prepared.mandate.id };
	const presentation = { l1: args.l1, l2: args.l2 };
	const env = kmsEnv(ctx);
	const wrappedVi = readKmsMode(env) === 'kek'
		? await wrapMandateViChainWithCryptoKey(identity, presentation, await loadKmsKek(env))
		: await wrapMandateViChain(identity, presentation, envString(ctx, 'HARBOR_KEK'));
	return mandateOnly(await store.activate(args.mandate_id, {
		l1Digest: verified.l1Digest, l2Digest: verified.l2Digest,
		viChainCiphertext: wrappedVi.ciphertext, viChainIv: wrappedVi.iv,
		setupBatchHash: setup.setupBatchHash, channels: setup.channels, updatedAt: now.toISOString(),
	}));
}

export async function handleMandateStatus(ctx: OpContext, rawArgs: z.infer<typeof MandateIdArgsSchema>): Promise<Mandate> {
	const args = MandateIdArgsSchema.parse(rawArgs);
	const services = configured(ctx);
	const result = await storeFor(ctx, services).get(args.mandate_id);
	if (!result) throw new Error('mandate not found');
	const mandate = mandateOnly(result);
	if (mandate.status === 'ACTIVE' && (services.now ?? (() => new Date()))().getTime() >= Date.parse(mandate.expires_at)) return { ...mandate, status: 'EXPIRED' };
	return mandate;
}

export async function handleMandateRevoke(ctx: OpContext, rawArgs: z.infer<typeof MandateIdArgsSchema>): Promise<Mandate> {
	const args = MandateIdArgsSchema.parse(rawArgs);
	const services = configured(ctx);
	const now = (services.now ?? (() => new Date()))().toISOString();
	return mandateOnly(await storeFor(ctx, services).revoke(args.mandate_id, now));
}

export const ops: OpDef[] = [
	{ name: 'mandate.prepare', family: 'mandate', summary: 'Prepare an unsigned testnet AP4M mandate setup.', tags: ['ap4m', 'mandate'], args: MandatePrepareArgsSchema, returns: 'MandatePrepare', caveats: [], example: 'await harbor.mandate.prepare({ owner, network: "testnet", constraints, payees, expires_at })', handler: (ctx, args) => handleMandatePrepare(ctx, args as z.infer<typeof MandatePrepareArgsSchema>) },
	{ name: 'mandate.register', family: 'mandate', summary: 'Verify VI authorization and a validated mandate setup.', tags: ['ap4m', 'mandate'], args: MandateRegisterArgsSchema, returns: 'Mandate', caveats: [], example: 'await harbor.mandate.register({ mandate_id, l1, l2, setup_tx_hash })', handler: (ctx, args) => handleMandateRegister(ctx, args as z.infer<typeof MandateRegisterArgsSchema>) },
	{ name: 'mandate.status', family: 'mandate', summary: 'Read AP4M mandate status.', tags: ['ap4m', 'mandate'], args: MandateIdArgsSchema, returns: 'Mandate', caveats: [], example: 'await harbor.mandate.status({ mandate_id })', handler: (ctx, args) => handleMandateStatus(ctx, args as z.infer<typeof MandateIdArgsSchema>) },
	{ name: 'mandate.revoke', family: 'mandate', summary: 'Revoke an AP4M mandate and request channel closure.', tags: ['ap4m', 'mandate'], args: MandateIdArgsSchema, returns: 'Mandate', caveats: [], example: 'await harbor.mandate.revoke({ mandate_id })', handler: (ctx, args) => handleMandateRevoke(ctx, args as z.infer<typeof MandateIdArgsSchema>) },
];
