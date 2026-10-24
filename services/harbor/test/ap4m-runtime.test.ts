import { describe, expect, it, vi } from "vitest";
import { Wallet } from "xrpl";

import { OpRegistry } from "../src/catalog/registry";
import { XrplRpcError } from "../src/adapters/xrpl-rpc";
import {
	Ap4mRuntimeConfigurationError,
	createLiveAp4mPurchaseServices,
	createAp4mRuntimeServices,
	resolveAp4mRuntimeProfile,
} from "../src/exec/ap4m-runtime";
import {
	createAp4mRuntimeFactory,
	createWorker,
	type Env,
} from "../src/server";
import { ops as ap4mOps } from "../src/ops/ap4m";
import type { Ap4mPurchaseAttempt } from "../src/exec/ap4m-store";
import { PayerSequenceLeaseAuthority } from "../src/exec/payer-sequence-lease";

const MOCK_ENV = {
	AP4M_DEMO_ENABLED: "true",
	AP4M_PURCHASE_MODE: "mock",
	EXEC_NETWORK: "testnet",
	HARBOR_MOCK: "1",
	HARBOR_SOURCE_TAG: "2610240",
	MAINNET_EXECUTION: "false",
} as const;

const LIVE_ENV = {
	...MOCK_ENV,
	AP4M_PURCHASE_MODE: "live",
	HARBOR_MOCK: "0",
	LIVE: "1",
} as const;

const MANDATE_ID = "mandate-runtime-replay";
const IDEMPOTENCY_KEY = "runtime-replay-0001";
const NOW = "2026-10-21T12:00:00.000Z";

function deliveredAttempt(): Ap4mPurchaseAttempt {
	return {
		id: "ap4m-attempt-runtime-replay",
		principal: "runtime-test",
		mandateId: MANDATE_ID,
		idempotencyKey: IDEMPOTENCY_KEY,
		requestFingerprint: "A".repeat(64),
		merchantId: "venue-yield-desk",
		sku: "yield-report",
		status: "delivered",
		spendId: "ap4m-spend-runtime-replay",
		spendDay: "2026-10-21",
		amountUsd: "0.75",
		preparedContextWrapped: null,
		preparedContextBinding: null,
		leaseAcquiredAt: NOW,
		signingStartedAt: NOW,
		firstEligibleLedgerIndex: 100,
		signedBlob: null,
		txHash: "A".repeat(64),
		lastLedgerSequence: 120,
		settlementUnknownAt: null,
		settledAt: NOW,
		deliveredAt: NOW,
		failedAt: null,
		ledgerIndex: 110,
		deliveredAmount: "0.75",
		receiptId: "ap4m-receipt-runtime-replay",
		merchantResponse: null,
		merchantResponseAt: NOW,
		result: {
			receipt: {
				receipt_id: "ap4m-receipt-runtime-replay",
				mandate_id: MANDATE_ID,
				merchant_id: "venue-yield-desk",
				sku: "yield-report",
				intent_id: "demo-intent-runtime-replay",
				l3a_digest: "B".repeat(64),
				l3b_digest: "C".repeat(64),
				scheme: "exact",
				amount: {
					asset: {
						kind: "iou",
						currency: "RLUSD",
						issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
					},
					value: "0.75",
				},
				proof: { tx_hash: "A".repeat(64) },
				merchant_validation: {
					intentId: "demo-intent-runtime-replay",
					validated: true,
					checks: {
						agent_identity: "pass",
						intent: "pass",
						payment: "pass",
						credential: "pass",
					},
					validation_errors: [],
				},
				settlement: "validated",
				at: NOW,
			},
			data: {
				schema_id: "yield_report_v1",
				venue: "venue-yield-desk",
				apr_percent: "4.2",
				tvl_usd: "1000000",
				risk: "low",
				as_of_basis: "deterministic mock replay fixture",
			},
		},
		failure: null,
		createdAt: NOW,
		updatedAt: NOW,
	};
}

describe("AP4M runtime profile", () => {
	it("is absent unless the deployment opts in", () => {
		expect(resolveAp4mRuntimeProfile({})).toBeUndefined();
		expect(createAp4mRuntimeServices({})).toBeUndefined();
		expect(resolveAp4mRuntimeProfile({
			AP4M_DEMO_ENABLED: "false",
			HARBOR_MOCK: "1",
			LIVE: "0",
		})).toBeUndefined();
	});

	it("accepts only the explicit mock-first Testnet profile", () => {
		expect(resolveAp4mRuntimeProfile(MOCK_ENV)).toEqual({
			mode: "mock",
			network: "testnet",
			expectedSourceTag: 2610240,
			standIn: true,
		});

		for (const override of [
			{ HARBOR_MOCK: "0" },
			{ LIVE: "1" },
			{ EXEC_NETWORK: "mainnet" },
			{ MAINNET_EXECUTION: "true" },
			{ AP4M_DEMO_ENABLED: "false" },
			{ AP4M_PURCHASE_MODE: "sandbox" },
			{ HARBOR_SOURCE_TAG: "02610240" },
			{ HARBOR_SOURCE_TAG: "4294967296" },
			{ HARBOR_SOURCE_TAG: "" },
		] as const) {
			expect(() => resolveAp4mRuntimeProfile({ ...MOCK_ENV, ...override }))
				.toThrow(Ap4mRuntimeConfigurationError);
		}
	});

	it("keeps live adapters behind every explicit Testnet gate", () => {
		expect(resolveAp4mRuntimeProfile(LIVE_ENV)).toEqual({
			mode: "live",
			network: "testnet",
			expectedSourceTag: 2610240,
			standIn: false,
		});
		for (const override of [
			{ LIVE: "0" },
			{ HARBOR_MOCK: "1" },
			{ EXEC_NETWORK: "mainnet" },
			{ MAINNET_EXECUTION: "true" },
		] as const) {
			expect(() => resolveAp4mRuntimeProfile({ ...LIVE_ENV, ...override }))
				.toThrow(Ap4mRuntimeConfigurationError);
		}
	});

	it("never selects the live adapter from the mock profile", () => {
		const mock = vi.fn(() => ({}));
		const live = vi.fn(() => ({}));
		const services = createAp4mRuntimeServices(MOCK_ENV, { mock, live });
		expect(mock).toHaveBeenCalledOnce();
		expect(live).not.toHaveBeenCalled();
		expect(services).toMatchObject({ expectedSourceTag: 2610240 });
	});

	it("leaves the checked-in mock profile without an implicit effect adapter", () => {
		const services = createAp4mRuntimeServices(MOCK_ENV);
		expect(services).toMatchObject({ expectedSourceTag: 2610240 });
		expect(services?.getMerchant?.("venue-yield-desk")).toBeUndefined();
		expect(services).not.toHaveProperty("signPayment");
		expect(services).not.toHaveProperty("reconcile");
		expect(services).not.toHaveProperty("exchangeMerchant");
	});

	it("installs the live adapter only after the explicit gate and keeps construction inert", () => {
		const profile = resolveAp4mRuntimeProfile(LIVE_ENV)!;
		const request = vi.fn();
		const loadKek = vi.fn();
		const readCredential = vi.fn();
		const fetchImpl = vi.fn();
		const services = createLiveAp4mPurchaseServices(profile, LIVE_ENV, {
			requestXrpl: request as never,
			loadKek: loadKek as never,
			readCredential: readCredential as never,
			fetch: fetchImpl as never,
		});

		expect(services).toMatchObject({
			getRecoveryKek: expect.any(Function),
			prepareExecution: expect.any(Function),
			signPayment: expect.any(Function),
			reconcile: expect.any(Function),
			merchantHttp: {
				fetch: fetchImpl,
				signWba: expect.any(Function),
			},
		});
		expect(request).not.toHaveBeenCalled();
		expect(loadKek).not.toHaveBeenCalled();
		expect(readCredential).not.toHaveBeenCalled();
		expect(fetchImpl).not.toHaveBeenCalled();

		const builtIn = createAp4mRuntimeServices(LIVE_ENV);
		expect(builtIn).toMatchObject({
			expectedSourceTag: 2610240,
			prepareExecution: expect.any(Function),
			signPayment: expect.any(Function),
			reconcile: expect.any(Function),
		});
	});

	it("injects the shared sequence authority only for the exact reviewed combined profile", () => {
		const profile = resolveAp4mRuntimeProfile(LIVE_ENV)!;
		const context = { principal: "runtime-test", db: {} as D1Database };
		const plain = createLiveAp4mPurchaseServices(profile, LIVE_ENV);
		expect(() => plain.sequenceAuthority?.(context)).toThrowError(
			"AP4M shared payer-sequence authority requires the reviewed combined profile",
		);
		const combined = createLiveAp4mPurchaseServices(profile, {
			...LIVE_ENV,
			HARBOR_LOCAL_AP4M_X402_COMBINED_V1_RUNTIME_ENABLED: "true",
			HARBOR_LOCAL_AP4M_X402_COMBINED_V1_SIGNING_PROFILE:
				"reviewed-testnet-ap4m-x402-combined-v1",
		});
		expect(combined.sequenceAuthority?.(context)).toBeInstanceOf(PayerSequenceLeaseAuthority);
	});

	it("distinguishes a watchdog-disabled payer through the live D1 resolver", async () => {
		const owner = Wallet.generate();
		const payer = Wallet.generate();
		const first = vi.fn(async () => ({
			principal: "runtime-test",
			owner: owner.classicAddress,
			network: "testnet",
			payer: payer.classicAddress,
			public_key: payer.publicKey,
			ciphertext_hex: "AA".repeat(17),
			iv_hex: "BB".repeat(12),
			status: "disabled",
			funded_ledger_index: null,
			funded_balance_drops: null,
			faucet_requested_at: null,
			funding_checked_at: null,
			created_at: NOW,
			updated_at: NOW,
		}));
		const bind = vi.fn(() => ({ first }));
		const prepare = vi.fn(() => ({ bind }));
		const services = createLiveAp4mPurchaseServices(
			resolveAp4mRuntimeProfile(LIVE_ENV)!,
			LIVE_ENV,
		);

		const context = {
			principal: "runtime-test",
			db: { prepare } as unknown as D1Database,
		};
		await expect(services.resolvePayer?.(
			context,
			owner.classicAddress,
		)).resolves.toEqual({ status: "disabled", payer: payer.classicAddress });
		await expect(services.prepareExecution?.({
			ctx: context,
			mandate: { mandate: { owner: owner.classicAddress } } as never,
			merchant: {} as never,
			sku: "yield-report",
			payer: payer.classicAddress,
		})).rejects.toMatchObject({ code: "PAYER_FROZEN" });
		expect(prepare).toHaveBeenCalledTimes(2);
		expect(bind).toHaveBeenCalledWith("runtime-test", owner.classicAddress, "testnet");
	});

	it("fails closed for KMS sign mode rather than falling back to a plaintext KEK", async () => {
		const profile = resolveAp4mRuntimeProfile(LIVE_ENV)!;
		const loadKek = vi.fn();
		const services = createLiveAp4mPurchaseServices(profile, {
			...LIVE_ENV,
			KMS_MODE: "sign",
			HARBOR_KEK: "A".repeat(43) + "=",
		}, { loadKek: loadKek as never });

		await expect(services.getRecoveryKek!({
			ctx: { principal: "runtime-test" },
			mandate: {} as never,
		})).rejects.toThrow("KMS_MODE=sign");
		expect(loadKek).not.toHaveBeenCalled();
	});

	it("uses the AWS-3 non-extractable CryptoKey path in KMS KEK mode", async () => {
		const key = { type: "secret", extractable: false } as CryptoKey;
		const loadKek = vi.fn(async () => key);
		const services = createLiveAp4mPurchaseServices(
			resolveAp4mRuntimeProfile(LIVE_ENV)!,
			{ ...LIVE_ENV, KMS_MODE: "kek", HARBOR_KEK_CIPHERTEXT: "QUJDRA==" },
			{ loadKek: loadKek as never },
		);

		await expect(services.getRecoveryKek!({
			ctx: { principal: "runtime-test" },
			mandate: {} as never,
		})).resolves.toBe(key);
		expect(loadKek).toHaveBeenCalledOnce();
	});

	it("returns raw validated tx evidence through read-only reconciliation", async () => {
		const evidence = { validated: true, hash: "A".repeat(64), marker: "raw-xrpl" };
		const request = vi.fn(async () => evidence);
		const services = createLiveAp4mPurchaseServices(
			resolveAp4mRuntimeProfile(LIVE_ENV)!,
			LIVE_ENV,
			{ requestXrpl: request as never },
		);
		const attempt = {
			...deliveredAttempt(),
			status: "signed" as const,
			signedBlob: "DEADBEEF",
		};

		await expect(services.reconcile!({
			ctx: { principal: "runtime-test" },
			attempt,
		})).resolves.toEqual({ status: "validated", evidence });
		expect(request).toHaveBeenCalledWith(
			expect.anything(),
			"testnet",
			"tx",
			{ transaction: "A".repeat(64), binary: false, api_version: 1 },
			{ intent: "read" },
		);
		expect(request.mock.calls.every((call) => call[4]?.intent === "read")).toBe(true);
	});

	it("proves expiry only after scanning the exact eligible ledger window", async () => {
		const request = vi.fn(async (_ctx, _network, command, params) => {
			if (command === "tx") {
				throw new XrplRpcError("not found", "txnNotFound", "soft-empty");
			}
			const index = (params as { ledger_index: number | "validated" }).ledger_index;
			if (index === "validated") {
				return { validated: true, ledger: { ledger_index: 102, transactions: [] } };
			}
			return { validated: true, ledger: { ledger_index: index, transactions: [] } };
		});
		const services = createLiveAp4mPurchaseServices(
			resolveAp4mRuntimeProfile(LIVE_ENV)!,
			LIVE_ENV,
			{ requestXrpl: request as never },
		);
		const attempt = {
			...deliveredAttempt(),
			status: "settlement_unknown" as const,
			signedBlob: "DEADBEEF",
			firstEligibleLedgerIndex: 100,
			lastLedgerSequence: 101,
		};

		await expect(services.reconcile!({
			ctx: { principal: "runtime-test" },
			attempt,
		})).resolves.toEqual({
			status: "expired_absent",
			lookupCode: "txnNotFound",
			validatedLedgerIndex: 102,
			firstEligibleLedgerIndex: 100,
			inclusionLedgersChecked: [100, 101],
		});
		expect(request.mock.calls.map((call) => call[2])).toEqual(["tx", "ledger", "ledger", "ledger"]);
		expect(request.mock.calls.every((call) => call[4]?.intent === "read")).toBe(true);
	});

	it("fails a default mock purchase before any durable or external mutation", async () => {
		const first = vi.fn(async () => null);
		const run = vi.fn(async () => {
			throw new Error("durable mutation must not run");
		});
		const prepare = vi.fn(() => ({
			bind: () => ({ first, run }),
		}));
		const response = await createWorker(new OpRegistry(ap4mOps)).fetch!(
			new Request("https://harbor.example/api/ops/ap4m.purchase", {
				method: "POST",
				headers: { authorization: "Bearer runtime-test:token" },
				body: JSON.stringify({
					mandate_id: MANDATE_ID,
					merchant_id: "venue-yield-desk",
					sku: "yield-report",
					idempotency_key: "runtime-default-fail-closed",
				}),
			}),
			{
				DB: { prepare } as unknown as D1Database,
				HARBOR_API_KEYS: "runtime-test:token",
				EXECUTOR: "quickjs",
				...MOCK_ENV,
			},
			{} as ExecutionContext,
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			ok: false,
			error: { code: "OPERATION_FAILED" },
		});
		expect(first.mock.calls.length).toBeGreaterThan(0);
		expect(run).not.toHaveBeenCalled();
	});

	it("executes the registered purchase replay through the real REST/provider path without effects", async () => {
		const forbiddenLiveAdapter = vi.fn(() => ({}));
		const forbiddenSigner = vi.fn();
		const forbiddenRpcMutation = vi.fn();
		const forbiddenMerchant = vi.fn();
		const forbiddenMandateRead = vi.fn();
		const row = deliveredAttempt();
		const get = vi.fn(async () => row);
		const claim = vi.fn(async () => ({ outcome: "replay" as const, row }));
		const runtime = createAp4mRuntimeFactory({
			mock: () => ({
				store: {
					get,
					claim,
				} as never,
				// This exact-only replay fixture explicitly models a fully migrated
				// database with no pay-channel row. Production adapters must probe
				// the versioned channel schema and fail closed when it is absent.
				channelStore: { read: vi.fn(async () => ({ outcome: "absent" as const })) },
				getMandate: forbiddenMandateRead,
				signPayment: forbiddenSigner,
				exchangeMerchant: forbiddenMerchant,
				reconcile: forbiddenRpcMutation,
				now: () => new Date(NOW),
				uuid: () => "00000000-0000-4000-8000-000000000001",
			}),
			live: forbiddenLiveAdapter,
		});
		const env: Env = {
			DB: {} as D1Database,
			HARBOR_API_KEYS: "runtime-test:token",
			EXECUTOR: "quickjs",
			...MOCK_ENV,
		};
		const response = await createWorker(
			new OpRegistry(ap4mOps),
			undefined,
			undefined,
			runtime,
		).fetch!(
			new Request("https://harbor.example/api/ops/ap4m.purchase", {
				method: "POST",
				headers: { authorization: "Bearer runtime-test:token" },
				body: JSON.stringify({
					mandate_id: MANDATE_ID,
					merchant_id: "venue-yield-desk",
					sku: "yield-report",
					idempotency_key: IDEMPOTENCY_KEY,
				}),
			}),
			env,
			{} as ExecutionContext,
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			ok: true,
			data: {
				receipt: {
					receipt_id: "ap4m-receipt-runtime-replay",
					settlement: "validated",
				},
				data: { schema_id: "yield_report_v1" },
			},
		});
		expect(forbiddenLiveAdapter).not.toHaveBeenCalled();
		expect(forbiddenSigner).not.toHaveBeenCalled();
		expect(forbiddenRpcMutation).not.toHaveBeenCalled();
		expect(forbiddenMerchant).not.toHaveBeenCalled();
		expect(forbiddenMandateRead).not.toHaveBeenCalled();
		expect(get.mock.calls.length + claim.mock.calls.length).toBeGreaterThan(0);
	});

	it("returns a secret-safe failure before dispatch for an invalid live gate", async () => {
		const forbiddenAdapter = vi.fn(() => ({}));
		const worker = createWorker(
			new OpRegistry(ap4mOps),
			undefined,
			undefined,
			createAp4mRuntimeFactory({ live: forbiddenAdapter }),
		);
		const invalidEnv = {
			DB: {} as D1Database,
			HARBOR_API_KEYS: "runtime-test:token",
			EXECUTOR: "quickjs",
			...MOCK_ENV,
			AP4M_PURCHASE_MODE: "live",
		} as Env;
		const response = await worker.fetch!(
			new Request("https://harbor.example/api/ops/ap4m.purchase", {
				method: "POST",
				headers: { authorization: "Bearer runtime-test:token" },
				body: "{}",
			}),
			invalidEnv,
			{} as ExecutionContext,
		);

		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			error: {
				service: "ap4m",
				kind: "error",
				message: "AP4M runtime configuration is invalid",
				code: "AP4M_RUNTIME_CONFIGURATION_INVALID",
			},
		});
		expect(forbiddenAdapter).not.toHaveBeenCalled();

		const unrelated = await worker.fetch!(
			new Request("https://harbor.example/api/ops/unknown.operation", {
				method: "POST",
				headers: { authorization: "Bearer runtime-test:token" },
				body: "{}",
			}),
			invalidEnv,
			{} as ExecutionContext,
		);
		expect(unrelated.status).toBe(404);
	});
});
