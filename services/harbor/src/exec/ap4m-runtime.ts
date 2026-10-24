import { requestXrpl, XrplRpcError } from "../adapters/xrpl-rpc";
import type { OpContext } from "../catalog/registry";
import type { Merchant } from "../contracts";
import { loadKmsKek, readKmsMode, type KmsEnv } from "../aws/kms";
import { readCredentialLedgerStatus } from "./credential-ledger";
import {
	type StoredDelegateKey,
	withDelegateSigner,
	withDelegateSignerWithCryptoKey,
} from "./keys";
import {
	unwrapMandateViChain,
	unwrapMandateViChainWithCryptoKey,
} from "./mandate-keys";
import { MandateStore, type StoredMandate } from "./mandate-store";
import {
	selectAp4mL2Disclosures,
	withMandateAgentSigner,
} from "./ap4m-purchase";
import {
	classifyAbsentAp4mSettlement,
} from "./ap4m-settlement";
import { cryptoKeyWbaSigner, signWbaRequest } from "./wba";
import { X402PayerStore, type X402PayerRow } from "./x402-payer-store";
import { PayerSequenceLeaseAuthority } from "./payer-sequence-lease";
import {
	Ap4mPurchaseError,
	type Ap4mExecutionMaterial,
	type Ap4mPurchaseServices,
	type Ap4mSettlementResult,
} from "../ops/ap4m";

const UINT32_MAX = 0xffff_ffff;

export type Ap4mRuntimeMode = "mock" | "live";

export type Ap4mRuntimeEnv = {
	AP4M_DEMO_ENABLED?: string;
	AP4M_PURCHASE_MODE?: string;
	EXEC_NETWORK?: string;
	HARBOR_MOCK?: string;
	HARBOR_SOURCE_TAG?: string;
	LIVE?: string;
	MAINNET_EXECUTION?: string;
	HARBOR_KEK?: string;
	HARBOR_WBA_DIRECTORY_URL?: string;
	HARBOR_WBA_DIRECTORY_JSON?: string;
	WBA_SIGNING_JWK?: string;
	AP4M_AGENT_ISSUER?: string;
	AP4M_NETWORK_AUDIENCE?: string;
	KMS_MODE?: string;
	HARBOR_KEK_CIPHERTEXT?: string;
	AWS_REGION?: string;
	AWS_ENDPOINT_OVERRIDE?: string;
	AWS_ACCESS_KEY_ID?: string;
	AWS_SECRET_ACCESS_KEY?: string;
	AWS_SESSION_TOKEN?: string;
	HARBOR_LOCAL_DEV?: string;
	HARBOR_LOCAL_AP4M_X402_COMBINED_V1_RUNTIME_ENABLED?: string;
	HARBOR_LOCAL_AP4M_X402_COMBINED_V1_SIGNING_PROFILE?: string;
};

export type Ap4mRuntimeProfile = Readonly<{
	mode: Ap4mRuntimeMode;
	network: "testnet";
	expectedSourceTag: number;
	standIn: boolean;
}>;

export type Ap4mRuntimeAdapter = (
	profile: Ap4mRuntimeProfile,
	env: Ap4mRuntimeEnv,
) => Ap4mPurchaseServices;

export class Ap4mRuntimeConfigurationError extends Error {
	readonly code = "AP4M_RUNTIME_CONFIGURATION_INVALID";

	constructor(message: string) {
		super(message);
		this.name = "Ap4mRuntimeConfigurationError";
	}
}

function invalid(message: string): never {
	throw new Ap4mRuntimeConfigurationError(message);
}

function sourceTag(value: string | undefined): number {
	if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
		return invalid("HARBOR_SOURCE_TAG must be a canonical uint32");
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > UINT32_MAX) {
		return invalid("HARBOR_SOURCE_TAG must be a canonical uint32");
	}
	return parsed;
}

type JsonObject = Record<string, unknown>;

function record(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function database(ctx: OpContext): D1Database {
	const direct = ctx.db;
	const nested = record(ctx.env) ? ctx.env.DB : undefined;
	const db = direct ?? nested;
	if (!db || typeof db !== "object") return invalid("AP4M D1 binding is required");
	return db as D1Database;
}

function positiveInteger(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > UINT32_MAX) {
		return invalid(`${field} is invalid`);
	}
	return Number(value);
}

function canonicalDrops(value: unknown, field: string): string {
	if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
		return invalid(`${field} is invalid`);
	}
	const amount = BigInt(value);
	if (amount < 1n || amount > 100n) return invalid(`${field} is invalid`);
	return value;
}

function strictHttpsUrl(value: string | undefined, field: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(value ?? "");
	} catch {
		return invalid(`${field} must be a canonical HTTPS URL`);
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.search !== "" ||
		parsed.hash !== "" ||
		parsed.href !== value
	) {
		return invalid(`${field} must be a canonical HTTPS URL`);
	}
	return parsed;
}

function directoryOrigin(env: Ap4mRuntimeEnv): string {
	const parsed = strictHttpsUrl(env.HARBOR_WBA_DIRECTORY_URL, "HARBOR_WBA_DIRECTORY_URL");
	if (parsed.pathname !== "/.well-known/http-message-signatures-directory") {
		return invalid("HARBOR_WBA_DIRECTORY_URL must name the well-known directory");
	}
	return parsed.origin;
}

function boundedJson(value: string | undefined, field: string): unknown {
	if (!value || new TextEncoder().encode(value).byteLength > 16 * 1_024) {
		return invalid(`${field} is missing or too large`);
	}
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return invalid(`${field} is invalid JSON`);
	}
}

function decodeDisclosure(value: string): JsonObject {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return invalid("AP4M L2 disclosure is invalid");
	try {
		const base64 = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat((4 - value.length % 4) % 4)}`;
		const decoded = JSON.parse(new TextDecoder().decode(
			Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)),
		)) as unknown;
		if (!Array.isArray(decoded) || decoded.length !== 2 || !record(decoded[1])) {
			return invalid("AP4M L2 disclosure is invalid");
		}
		return decoded[1];
	} catch (error) {
		if (error instanceof Ap4mRuntimeConfigurationError) throw error;
		return invalid("AP4M L2 disclosure is invalid");
	}
}

function agentKid(l2: string, merchant: Merchant, sku: string, mandate: StoredMandate): string {
	const selected = selectAp4mL2Disclosures({ l2, merchantId: merchant.id, sku });
	const values = [decodeDisclosure(selected.checkout), decodeDisclosure(selected.payment)];
	const publicJwk = mandate.mandate.agent_public_jwk;
	let kid: string | undefined;
	for (const value of values) {
		const cnf = record(value.cnf) ? value.cnf : undefined;
		const jwk = cnf && record(cnf.jwk) ? cnf.jwk : undefined;
		if (
			!cnf || !jwk || typeof cnf.kid !== "string" || !cnf.kid || cnf.kid.length > 256 ||
			jwk.kty !== "EC" || jwk.crv !== "P-256" || jwk.x !== publicJwk.x || jwk.y !== publicJwk.y ||
			jwk.d !== undefined || (kid !== undefined && kid !== cnf.kid)
		) {
			return invalid("AP4M L2 agent binding is invalid");
		}
		kid = cnf.kid;
	}
	return kid!;
}

function legacyKek(env: Ap4mRuntimeEnv): string {
	if (typeof env.HARBOR_KEK !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(env.HARBOR_KEK)) {
		return invalid("HARBOR_KEK is required for legacy wrapped AP4M keys");
	}
	return env.HARBOR_KEK;
}

function equalBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
	const a = new Uint8Array(left);
	const b = new Uint8Array(right);
	if (a.byteLength !== b.byteLength) return false;
	let difference = 0;
	for (let index = 0; index < a.byteLength; index += 1) difference |= a[index]! ^ b[index]!;
	return difference === 0;
}

export type LiveAp4mRuntimeDependencies = Readonly<{
	loadKek: typeof loadKmsKek;
	requestXrpl: typeof requestXrpl;
	readCredential: typeof readCredentialLedgerStatus;
	fetch: typeof fetch;
	crypto: Crypto;
}>;

function liveDependencies(
	overrides: Partial<LiveAp4mRuntimeDependencies>,
): LiveAp4mRuntimeDependencies {
	return {
		loadKek: overrides.loadKek ?? loadKmsKek,
		requestXrpl: overrides.requestXrpl ?? requestXrpl,
		readCredential: overrides.readCredential ?? readCredentialLedgerStatus,
		fetch: overrides.fetch ?? globalThis.fetch,
		crypto: overrides.crypto ?? crypto,
	};
}

function unwrapError(error: unknown): never {
	if (error instanceof Ap4mRuntimeConfigurationError) throw error;
	throw error;
}

function publicWbaBinding(env: Ap4mRuntimeEnv, privateJwk: JsonObject): JsonWebKey {
	const directory = boundedJson(env.HARBOR_WBA_DIRECTORY_JSON, "HARBOR_WBA_DIRECTORY_JSON");
	if (!record(directory) || !Array.isArray(directory.keys)) {
		return invalid("HARBOR_WBA_DIRECTORY_JSON is invalid");
	}
	const matches = directory.keys.filter((candidate) =>
		record(candidate) && candidate.kty === "OKP" && candidate.crv === "Ed25519" &&
		candidate.x === privateJwk.x && candidate.d === undefined,
	);
	if (matches.length !== 1) return invalid("WBA signing key does not match the public directory");
	return { kty: "OKP", crv: "Ed25519", x: String(privateJwk.x) };
}

async function importWbaSigner(env: Ap4mRuntimeEnv, cryptoImpl: Crypto) {
	const parsed = boundedJson(env.WBA_SIGNING_JWK, "WBA_SIGNING_JWK");
	if (
		!record(parsed) || parsed.kty !== "OKP" || parsed.crv !== "Ed25519" ||
		typeof parsed.x !== "string" || typeof parsed.d !== "string"
	) {
		return invalid("WBA_SIGNING_JWK is not an Ed25519 private JWK");
	}
	const publicJwk = publicWbaBinding(env, parsed);
	let privateKey: CryptoKey;
	try {
		privateKey = await cryptoImpl.subtle.importKey(
			"jwk",
			parsed as unknown as JsonWebKey,
			{ name: "Ed25519" },
			false,
			["sign"],
		);
	} catch {
		return invalid("WBA_SIGNING_JWK could not be imported");
	}
	return cryptoKeyWbaSigner(privateKey, publicJwk, cryptoImpl);
}

function identityFor(mandate: StoredMandate, principal: string) {
	return {
		principal,
		owner: mandate.mandate.owner,
		network: "testnet" as const,
		mandateId: mandate.mandate.id,
	};
}

function configuredAudience(value: string | undefined, field: string): string {
	const parsed = strictHttpsUrl(value, field);
	return parsed.href;
}

function liveKek(
	env: Ap4mRuntimeEnv,
	deps: LiveAp4mRuntimeDependencies,
): Promise<CryptoKey | string> {
	const mode = readKmsMode(env);
	if (mode === "kek") return deps.loadKek(env as KmsEnv);
	if (mode === "off") return Promise.resolve(legacyKek(env));
	return invalid("KMS_MODE=sign cannot decrypt existing AP4M wrapped keys");
}

function ledgerRecord(value: unknown, field: string): JsonObject {
	if (!record(value)) return invalid(`${field} is invalid`);
	return value;
}

async function preparation(
	ctx: OpContext,
	payer: string,
	deps: LiveAp4mRuntimeDependencies,
) {
	const server = await deps.requestXrpl(ctx, "testnet", "server_info", {}, { intent: "read" });
	const info = ledgerRecord(server.info, "server_info.info");
	const validated = ledgerRecord(info.validated_ledger, "server_info validated ledger");
	const validatedLedgerIndex = positiveInteger(validated.seq, "validated ledger index");
	const [account, fee] = await Promise.all([
		deps.requestXrpl(ctx, "testnet", "account_info", {
			account: payer,
			ledger_index: validatedLedgerIndex,
		}, { intent: "read" }),
		deps.requestXrpl(ctx, "testnet", "fee", {}, { intent: "read" }),
	]);
	if (account.validated !== true || account.ledger_index !== validatedLedgerIndex) {
		return invalid("payer account_info is not pinned to the validated ledger");
	}
	const accountData = ledgerRecord(account.account_data, "payer account_info");
	if (accountData.Account !== payer) return invalid("payer account_info does not match the payer");
	const sequence = positiveInteger(accountData.Sequence, "payer sequence");
	const drops = ledgerRecord(fee.drops, "fee drops");
	const feeDrops = canonicalDrops(drops.open_ledger_fee, "open ledger fee");
	return { sequence, validatedLedgerIndex, feeDrops };
}

function publicKeyFor(row: X402PayerRow): StoredDelegateKey {
	return {
		address: row.payer,
		publicKey: row.publicKey,
		ciphertext: row.ciphertext,
		iv: row.iv,
	};
}

function unchangedPayer(expected: X402PayerRow, actual: X402PayerRow | null): actual is X402PayerRow {
	return actual !== null && actual.status === "ready" && actual.payer === expected.payer &&
		actual.publicKey === expected.publicKey && equalBytes(actual.ciphertext, expected.ciphertext) &&
		equalBytes(actual.iv, expected.iv);
}

function ledgerTransactions(value: unknown, ledgerIndex: number): readonly string[] {
	const result = ledgerRecord(value, "ledger response");
	const ledger = ledgerRecord(result.ledger, "ledger response ledger");
	if (
		result.validated !== true || ledger.ledger_index !== ledgerIndex ||
		!Array.isArray(ledger.transactions) ||
		ledger.transactions.some((transaction) => typeof transaction !== "string" || !/^[A-Fa-f0-9]{64}$/.test(transaction))
	) {
		return invalid("ledger inclusion evidence is invalid");
	}
	return ledger.transactions.map((transaction) => String(transaction).toUpperCase());
}

function validatedHead(value: unknown): number {
	const result = ledgerRecord(value, "validated ledger response");
	const ledger = ledgerRecord(result.ledger, "validated ledger");
	if (result.validated !== true) return invalid("validated ledger response is not validated");
	return positiveInteger(ledger.ledger_index, "validated ledger index");
}

/**
 * Fully coded live-Testnet binding. Construction is intentionally inert: KMS,
 * D1, WBA private-key import, merchant fetch, and XRPL reads happen only after
 * the explicit live profile selects and invokes the corresponding capability.
 * The adapter never submits an XRPL transaction; the paid merchant retry owns
 * submission and reconciliation uses read-only RPC calls.
 */
export function createLiveAp4mPurchaseServices(
	profile: Ap4mRuntimeProfile,
	env: Ap4mRuntimeEnv,
	overrides: Partial<LiveAp4mRuntimeDependencies> = {},
): Ap4mPurchaseServices {
	if (profile.mode !== "live" || profile.network !== "testnet" || profile.standIn) {
		return invalid("The live AP4M adapter requires the reviewed live Testnet profile");
	}
	const deps = liveDependencies(overrides);
	const preparedPayers = new Map<string, X402PayerRow>();
	let wbaSigner: ReturnType<typeof importWbaSigner> | undefined;
	const wbaOrigin = () => directoryOrigin(env);

	const getRecoveryKek: NonNullable<Ap4mPurchaseServices["getRecoveryKek"]> = async () =>
		liveKek(env, deps);

	const resolvePayer: NonNullable<Ap4mPurchaseServices["resolvePayer"]> = async (ctx, owner) => {
		const row = await new X402PayerStore(database(ctx), ctx.principal).get(owner, "testnet");
		if (row?.status === "ready") return { status: "ready", payer: row.payer };
		if (row?.status === "disabled") return { status: "disabled", payer: row.payer };
		return { status: "unavailable" };
	};

	const prepareExecution: NonNullable<Ap4mPurchaseServices["prepareExecution"]> = async ({
		ctx,
		mandate,
		merchant,
		sku,
		payer,
	}): Promise<Ap4mExecutionMaterial> => {
		const db = database(ctx);
		const payerStore = new X402PayerStore(db, ctx.principal);
		const payerRow = await payerStore.get(mandate.mandate.owner, "testnet");
		if (payerRow?.status === "disabled" && payerRow.payer === payer) {
			throw new Ap4mPurchaseError("AP4M payer is frozen", "PAYER_FROZEN");
		}
		if (payerRow === null || payerRow.status !== "ready" || payerRow.payer !== payer) {
			return invalid("AP4M payer record is not ready or does not match");
		}
		const wrappedVi = await new MandateStore(db, ctx.principal).getWrappedViChain(mandate.mandate.id);
		if (wrappedVi === null || wrappedVi.owner !== mandate.mandate.owner) {
			return invalid("AP4M mandate VI chain is unavailable");
		}
		const kek = await liveKek(env, deps);
		let vi: { l1: string; l2: string };
		try {
			vi = typeof kek === "string"
				? await unwrapMandateViChain(identityFor(mandate, ctx.principal), wrappedVi, kek, deps.crypto)
				: await unwrapMandateViChainWithCryptoKey(identityFor(mandate, ctx.principal), wrappedVi, kek, deps.crypto);
		} catch (error) {
			return unwrapError(error);
		}
		const requiredCredential = {
			issuer: merchant.required_credential.issuer,
			credentialTypeHex: merchant.required_credential.credential_type_hex,
		};
		const credential = await deps.readCredential(ctx, payer, requiredCredential);
		if (credential === null || !credential.accepted || credential.expired) {
			return invalid("The AP4M payer credential is not accepted and current");
		}
		const ledgerPreparation = await preparation(ctx, payer, deps);
		const kid = agentKid(vi.l2, merchant, sku, mandate);
		const issuer = configuredAudience(env.AP4M_AGENT_ISSUER, "AP4M_AGENT_ISSUER");
		const networkAudience = configuredAudience(env.AP4M_NETWORK_AUDIENCE, "AP4M_NETWORK_AUDIENCE");
		const merchantAudience = new URL(merchant.base_url).origin;
		preparedPayers.set(payer, payerRow);
		return {
			l1: vi.l1,
			l2: vi.l2,
			payer,
			credentialIds: [credential.credentialId],
			preparation: ledgerPreparation,
			agentKid: kid,
			agentIssuer: issuer,
			networkAudience,
			merchantAudience,
			recoveryKek: kek,
			withAgentSigner: (callback) => withMandateAgentSigner(
				identityFor(mandate, ctx.principal),
				{
					ciphertext: mandate.agentKeyCiphertext,
					iv: mandate.agentKeyIv,
					publicJwk: mandate.mandate.agent_public_jwk as unknown as JsonWebKey,
				},
				kek,
				callback,
			),
		};
	};

	const signPayment: NonNullable<Ap4mPurchaseServices["signPayment"]> = async ({ ctx, payment, payer }) => {
		const expected = preparedPayers.get(payer);
		if (!expected || payment.Account !== payer) return invalid("AP4M payer was not prepared for signing");
		const current = await new X402PayerStore(database(ctx), ctx.principal).get(expected.owner, "testnet");
		if (current?.status === "disabled" && current.payer === payer) {
			throw new Ap4mPurchaseError("AP4M payer is frozen", "PAYER_FROZEN");
		}
		if (!unchangedPayer(expected, current)) return invalid("AP4M payer changed after preparation");
		const identity = { principal: ctx.principal, owner: expected.owner, network: "testnet" as const };
		const wrapped = publicKeyFor(current);
		const mode = readKmsMode(env);
		if (mode === "kek") {
			return withDelegateSignerWithCryptoKey(
				identity, wrapped, await deps.loadKek(env as KmsEnv), (signer) => signer.sign(payment),
				{ crypto: deps.crypto },
			);
		}
		if (mode === "off") {
			return withDelegateSigner(
				identity, wrapped, legacyKek(env), (signer) => signer.sign(payment),
				{ crypto: deps.crypto },
			);
		}
		return invalid("KMS_MODE=sign cannot decrypt the AP4M payer key");
	};

	const reconcile: NonNullable<Ap4mPurchaseServices["reconcile"]> = async ({
		ctx,
		attempt,
	}): Promise<Ap4mSettlementResult> => {
		if (!attempt.txHash || !attempt.signedBlob || !/^[A-F0-9]{64}$/.test(attempt.txHash)) {
			return invalid("AP4M signed recovery state is incomplete");
		}
		try {
			const evidence = await deps.requestXrpl(ctx, "testnet", "tx", {
				transaction: attempt.txHash,
				binary: false,
				api_version: 1,
			}, { intent: "read" });
			if (evidence.validated !== true) return { status: "pending" };
			return { status: "validated", evidence };
		} catch (error) {
			if (!(error instanceof XrplRpcError) || error.kind !== "soft-empty" ||
				(error.code !== "txnNotFound" && error.code !== "transactionNotFound")) {
				throw error;
			}
		}
		if (attempt.firstEligibleLedgerIndex === null || attempt.lastLedgerSequence === null) {
			return invalid("AP4M settlement ledger window is unavailable");
		}
		if (
			attempt.firstEligibleLedgerIndex > attempt.lastLedgerSequence ||
			attempt.lastLedgerSequence - attempt.firstEligibleLedgerIndex > 20
		) {
			return invalid("AP4M settlement ledger window is invalid");
		}
		const head = validatedHead(await deps.requestXrpl(ctx, "testnet", "ledger", {
			ledger_index: "validated",
			transactions: false,
			expand: false,
		}, { intent: "read" }));
		if (head <= attempt.lastLedgerSequence) return { status: "pending" };
		const checked: number[] = [];
		for (let index = attempt.firstEligibleLedgerIndex; index <= attempt.lastLedgerSequence; index += 1) {
			const transactions = ledgerTransactions(await deps.requestXrpl(ctx, "testnet", "ledger", {
				ledger_index: index,
				transactions: true,
				expand: false,
			}, { intent: "read" }), index);
			if (transactions.includes(attempt.txHash)) return { status: "pending" };
			checked.push(index);
		}
		const absence = classifyAbsentAp4mSettlement({
			lookupCode: "txnNotFound",
			validatedLedgerIndex: head,
			firstEligibleLedgerIndex: attempt.firstEligibleLedgerIndex,
			lastLedgerSequence: attempt.lastLedgerSequence,
			inclusionLedgersChecked: checked,
		});
		if (absence.status !== "expired-absent") return { status: "pending" };
		return {
			status: "expired_absent",
			lookupCode: "txnNotFound",
			validatedLedgerIndex: head,
			firstEligibleLedgerIndex: attempt.firstEligibleLedgerIndex,
			inclusionLedgersChecked: checked,
		};
	};

	return {
		getRecoveryKek,
		resolvePayer,
		sequenceAuthority(ctx) {
			if (
				env.HARBOR_LOCAL_AP4M_X402_COMBINED_V1_RUNTIME_ENABLED !== "true" ||
				env.HARBOR_LOCAL_AP4M_X402_COMBINED_V1_SIGNING_PROFILE !==
					"reviewed-testnet-ap4m-x402-combined-v1"
			) {
				return invalid("AP4M shared payer-sequence authority requires the reviewed combined profile");
			}
			return new PayerSequenceLeaseAuthority(database(ctx));
		},
		prepareExecution,
		signPayment,
		reconcile,
		merchantHttp: {
			fetch: deps.fetch,
			async signWba(request) {
				wbaSigner ??= importWbaSigner(env, deps.crypto);
				return signWbaRequest(request, await wbaSigner, {
					directoryOrigin: wbaOrigin(),
					crypto: deps.crypto,
				});
			},
		},
	};
}

/**
 * Resolve the AP4M execution boundary without reading any credential value.
 * Mock and live are deliberately mutually exclusive: a mock profile can never
 * inherit a signing/submission adapter, while live must opt in to Testnet at
 * every gate named by the addendum.
 */
export function resolveAp4mRuntimeProfile(
	env: Ap4mRuntimeEnv,
): Ap4mRuntimeProfile | undefined {
	// AP4M_DEMO_ENABLED also gates other AP4M operations. Only the dedicated
	// purchase-mode marker opts this effectful runtime into configuration checks.
	if (env.AP4M_PURCHASE_MODE === undefined) return undefined;
	if (env.AP4M_DEMO_ENABLED !== "true") {
		return invalid("AP4M_DEMO_ENABLED=true is required");
	}
	if (env.EXEC_NETWORK !== "testnet" || env.MAINNET_EXECUTION !== "false") {
		return invalid("AP4M purchases require an explicit Testnet-only profile");
	}

	const expectedSourceTag = sourceTag(env.HARBOR_SOURCE_TAG);
	if (env.AP4M_PURCHASE_MODE === "mock") {
		if (env.HARBOR_MOCK !== "1" || env.LIVE === "1") {
			return invalid("AP4M mock mode requires HARBOR_MOCK=1 and LIVE disabled");
		}
		return Object.freeze({
			mode: "mock",
			network: "testnet",
			expectedSourceTag,
			standIn: true,
		});
	}

	if (env.AP4M_PURCHASE_MODE === "live") {
		if (env.LIVE !== "1" || env.HARBOR_MOCK === "1") {
			return invalid("AP4M live mode requires LIVE=1 and mock mode disabled");
		}
		return Object.freeze({
			mode: "live",
			network: "testnet",
			expectedSourceTag,
			standIn: false,
		});
	}

	return invalid("AP4M_PURCHASE_MODE must be mock or live");
}

/**
 * Bind a reviewed runtime adapter to the operation context. Mock has no
 * built-in effect adapter and therefore cannot fall through to signing. The
 * live adapter exists only behind the explicit live-Testnet profile above and
 * remains inert until the purchase operation invokes one of its capabilities.
 */
export function createAp4mRuntimeServices(
	env: Ap4mRuntimeEnv,
	adapters: Readonly<{
		mock?: Ap4mRuntimeAdapter;
		live?: Ap4mRuntimeAdapter;
	}> = {},
): Ap4mPurchaseServices | undefined {
	const profile = resolveAp4mRuntimeProfile(env);
	if (profile === undefined) return undefined;
	const adapter = profile.mode === "mock"
		? adapters.mock
		: (adapters.live ?? createLiveAp4mPurchaseServices);
	if (adapter === undefined) {
		return Object.freeze({
			expectedSourceTag: profile.expectedSourceTag,
			// Stop before creating a new attempt when no reviewed effect adapter
			// is installed. Existing delivered rows may still replay safely.
			getMerchant: () => undefined,
		});
	}
	const services = adapter(profile, env);
	if (!services || typeof services !== "object") {
		return invalid("AP4M runtime adapter returned an invalid service binding");
	}
	return Object.freeze({
		...services,
		expectedSourceTag: profile.expectedSourceTag,
	});
}
