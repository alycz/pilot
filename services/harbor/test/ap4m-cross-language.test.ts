import { describe, expect, it } from "vitest";

import { McIntentSchema } from "../src/contracts";
import {
	buildAp4mCheckoutPayload,
	buildAp4mMerchantL2Presentation,
} from "../src/exec/ap4m-intent";
import { validateAp4mMerchantResponse } from "../src/exec/ap4m-response";
import {
	Ap4mX402Error,
	buildAp4mRetryHeaders,
	encodeAp4mT54PaymentSignature,
	validateAp4mX402Challenge,
} from "../src/exec/ap4m-x402";
import { verifyAp4mReferenceViChain, viDigest } from "../src/exec/mandate-vi";
import fixtureJson from "./fixtures/ap4m-mh4-mm2-v1.json";

type JsonObject = Record<string, unknown>;
type PublicJwk = { kty: string; crv: string; x: string; y: string };

const fixture = fixtureJson as unknown as {
	version: string;
	reference_commit: string;
	fixture_generation: string;
	generated_at: string;
	evidence_scope: string;
	reference_verification: {
		implementation: string;
		valid: boolean;
		errors: string[];
		l2_checkout_disclosed: boolean;
		l2_payment_disclosed: boolean;
		checks_performed: string[];
		checks_skipped: string[];
	};
	profile: {
		not_before: string;
		expires_at: string;
		mandate_id: string;
		audience: string;
		issuer: string;
		issuer_kid: string;
		owner: string;
		constraints: {
			currency: "USD";
			per_payment_max: string;
			daily_max: string;
			total_max: string;
			payees: string[];
			skus: string[];
		};
	};
	merchant: {
		id: string;
		sku: string;
		url: string;
		address: string;
		issuer: string;
		source_tag: number;
	};
	keys: {
		issuer_public_jwk: PublicJwk;
		device_public_jwk: PublicJwk;
		agent_public_jwk: PublicJwk;
		agent_kid: string;
	};
	vi: {
		l1: string;
		l2: string;
		l2_parts: {
			base_jwt: string;
			merchant: string;
			item: string;
			checkout: string;
			payment: string;
		};
		l2_presentations: { network: string; merchant: string };
		l3a: string;
		l3b: string;
		checkout_payload: string;
		checkout_hash: string;
		l3a_digest: string;
		l3b_digest: string;
	};
	intent: unknown;
	x402: {
		payment_required: string;
		validated_challenge: unknown;
		payment_signature: string;
		retry_headers: Record<string, string>;
		synthetic_payment: {
			stand_in: boolean;
			ledger_validated: boolean;
			label: string;
			signed_tx_blob: string;
			tx_hash: string;
		};
	};
};

function decodeBase64Url(value: string): Uint8Array {
	const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat((4 - value.length % 4) % 4)}`;
	return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function encodeBase64Url(value: ArrayBuffer | Uint8Array): string {
	const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeJsonBase64Url(value: string): unknown {
	return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as unknown;
}

function compactJwt(presentation: string): string {
	return presentation.split("~", 1)[0]!;
}

function jwtClaims(presentation: string): JsonObject {
	const segments = compactJwt(presentation).split(".");
	if (segments.length !== 3) throw new TypeError("fixture JWT is malformed");
	return decodeJsonBase64Url(segments[1]!) as JsonObject;
}

function disclosures(presentation: string): Array<{ encoded: string; value: JsonObject }> {
	return presentation
		.split("~")
		.slice(1)
		.filter((entry) => entry.length > 0)
		.map((encoded) => {
			const disclosure = decodeJsonBase64Url(encoded);
			if (!Array.isArray(disclosure) || disclosure.length < 2) {
				throw new TypeError("fixture disclosure is malformed");
			}
			return { encoded, value: disclosure.at(-1) as JsonObject };
		});
}

async function sha256Base64Url(value: string): Promise<string> {
	return encodeBase64Url(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
	);
}

async function verifyCompactJwt(presentation: string, jwk: PublicJwk): Promise<boolean> {
	const segments = compactJwt(presentation).split(".");
	if (segments.length !== 3) return false;
	const key = await crypto.subtle.importKey(
		"jwk",
		jwk,
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["verify"],
	);
	return crypto.subtle.verify(
		{ name: "ECDSA", hash: "SHA-256" },
		key,
		decodeBase64Url(segments[2]!),
		new TextEncoder().encode(`${segments[0]}.${segments[1]}`),
	);
}

function challengeOptions() {
	return {
		requestUrl: fixture.merchant.url,
		network: "testnet" as const,
		merchantPayTo: fixture.merchant.address,
		expectedAsset: { currency: "RLUSD", issuer: fixture.merchant.issuer },
		maxAmount: "1",
		expectedSourceTag: fixture.merchant.source_tag,
	};
}

describe("MH4/MM2 v1 public cross-language fixture", () => {
	it("contains public-only keys and labels the XRPL payment as an offline stand-in", () => {
		expect(fixture.version).toBe("ap4m-mh4-mm2-v1");
		expect(fixture.reference_commit).toBe("1dc3d4189512041fb3d0f8348fe100dfe25ced91");
		expect(fixture.fixture_generation).toBe("deterministic-offline");
		expect(fixture.evidence_scope).toContain("no Testnet submission");
		expect(fixture.x402.synthetic_payment).toMatchObject({
			stand_in: true,
			ledger_validated: false,
			signed_tx_blob: "DEADBEEF",
		});
		expect(fixture.x402.synthetic_payment.label).toContain("invalid as a real signed");
		expect(fixture.x402.synthetic_payment.label).toContain("never submitted");
		expect(JSON.stringify(fixture)).not.toMatch(
			/"(?:d|seed|private|privateKey|mnemonic)"\s*:/i,
		);
	});

	it("matches the pinned v0.1 AP4M L1 and autonomous L2 profile", async () => {
		expect(fixture.reference_verification).toMatchObject({
			implementation: "verifiable-intent v0.1.0 verify_chain",
			valid: true,
			errors: [],
			l2_checkout_disclosed: true,
			l2_payment_disclosed: true,
		});
		expect(fixture.reference_verification.checks_performed).toContain("l2_reference_binding");
		expect(fixture.reference_verification.checks_skipped).not.toEqual(
			expect.arrayContaining([expect.stringContaining("l2_reference")]),
		);
		const l1 = jwtClaims(fixture.vi.l1);
		expect(l1).toMatchObject({
			iss: fixture.profile.issuer,
			pilot_issuer_name: fixture.profile.issuer,
			sub: fixture.profile.owner,
			vct: "https://credentials.mastercard.com/card",
			of_verified: true,
			budget_account: fixture.profile.owner,
		});
		expect(l1.of_owner_name_hash).toMatch(/^[a-f0-9]{64}$/i);
		expect(l1.of_customer_ref).toMatch(/^[a-f0-9]{64}$/i);

		const checkout = disclosures(fixture.vi.l2).find(
			(disclosure) => disclosure.value.vct === "mandate.checkout.open",
		)!;
		const payment = disclosures(fixture.vi.l2).find(
			(disclosure) => disclosure.value.vct === "mandate.payment.open",
		)!;
		const constraints = payment.value.constraints as JsonObject[];
		expect(constraints.map((constraint) => constraint.type)).toEqual([
			"payment.amount",
			"payment.budget",
			"payment.allowed_payee",
			"payment.agent_recurrence",
			"payment.reference",
		]);
		expect(constraints.find((constraint) => constraint.type === "payment.agent_recurrence")).toEqual({
			type: "payment.agent_recurrence",
			frequency: "ON_DEMAND",
			start_date: fixture.profile.not_before.slice(0, 10),
			end_date: fixture.profile.expires_at.slice(0, 10),
		});
		expect(constraints.find((constraint) => constraint.type === "payment.reference")).toEqual({
			type: "payment.reference",
			conditional_transaction_id: await sha256Base64Url(checkout.encoded),
		});

		const verified = await verifyAp4mReferenceViChain({
			l1: fixture.vi.l1,
			l2: fixture.vi.l2,
			trustedIssuerJwk: fixture.keys.issuer_public_jwk,
			expectedAgentPublicJwk: fixture.keys.agent_public_jwk,
			expectedConstraints: fixture.profile.constraints,
			expectedOwner: fixture.profile.owner,
			expectedIssuer: fixture.profile.issuer,
			expectedIssuerKid: fixture.profile.issuer_kid,
			expectedMandateId: fixture.profile.mandate_id,
			expectedAudience: fixture.profile.audience,
			notBefore: fixture.profile.not_before,
			expiresAt: fixture.profile.expires_at,
			now: new Date(fixture.generated_at),
		});
		expect(verified.agentPublicJwk).toEqual(fixture.keys.agent_public_jwk);
	});

	it("verifies the L1/L2/L3 signatures and every selective-disclosure binding", async () => {
		expect(await verifyCompactJwt(fixture.vi.l1, fixture.keys.issuer_public_jwk)).toBe(true);
		expect(await verifyCompactJwt(fixture.vi.l2, fixture.keys.device_public_jwk)).toBe(true);
		expect(await verifyCompactJwt(fixture.vi.l3a, fixture.keys.agent_public_jwk)).toBe(true);
		expect(await verifyCompactJwt(fixture.vi.l3b, fixture.keys.agent_public_jwk)).toBe(true);

		const l1Claims = jwtClaims(fixture.vi.l1);
		const l2Claims = jwtClaims(fixture.vi.l2);
		const l3aClaims = jwtClaims(fixture.vi.l3a);
		const l3bClaims = jwtClaims(fixture.vi.l3b);
		expect((l1Claims.cnf as JsonObject).jwk).toEqual(fixture.keys.device_public_jwk);
		expect(await sha256Base64Url(fixture.vi.l1)).toBe(l2Claims.sd_hash);

		for (const presentation of [fixture.vi.l2, fixture.vi.l3a, fixture.vi.l3b]) {
			const claims = jwtClaims(presentation);
			const allowed = new Set(claims._sd as string[]);
			for (const disclosure of disclosures(presentation)) {
				expect(allowed.has(await sha256Base64Url(disclosure.encoded))).toBe(true);
			}
		}

		const l2PaymentPresentation = fixture.vi.l2_presentations.network;
		const l2CheckoutPresentation = fixture.vi.l2_presentations.merchant;
		expect(await sha256Base64Url(l2PaymentPresentation)).toBe(l3aClaims.sd_hash);
		expect(await sha256Base64Url(l2CheckoutPresentation)).toBe(l3bClaims.sd_hash);

		const payment = disclosures(fixture.vi.l3a).find(
			(disclosure) => disclosure.value.vct === "mandate.payment",
		)?.value;
		const checkout = disclosures(fixture.vi.l3b).find(
			(disclosure) => disclosure.value.vct === "mandate.checkout",
		)?.value;
		expect(payment?.transaction_id).toBe(fixture.vi.checkout_hash);
		expect(checkout?.checkout_hash).toBe(fixture.vi.checkout_hash);
		expect(checkout?.checkout_jwt).toBe(fixture.vi.checkout_payload);
		expect(await viDigest(fixture.vi.l3a)).toBe(fixture.vi.l3a_digest);
		expect(await viDigest(fixture.vi.l3b)).toBe(fixture.vi.l3b_digest);
	});

	it("recomputes the intent checkout, exact IOU challenge, and bounded retry headers", async () => {
		const intent = McIntentSchema.parse(fixture.intent);
		const checkout = buildAp4mCheckoutPayload(intent, {
			scheme: "exact",
			network: "testnet",
			currency: "RLUSD",
			issuer: fixture.merchant.issuer,
			amount: "1",
			payTo: fixture.merchant.address,
		});
		expect(checkout).toBe(fixture.vi.checkout_payload);
		expect(await sha256Base64Url(checkout)).toBe(fixture.vi.checkout_hash);

		const challenge = validateAp4mX402Challenge(
			fixture.x402.payment_required,
			challengeOptions(),
		);
		expect(challenge).toEqual(fixture.x402.validated_challenge);
		expect(
			encodeAp4mT54PaymentSignature({
				challenge,
				signedTxBlob: fixture.x402.synthetic_payment.signed_tx_blob,
			}),
		).toBe(fixture.x402.payment_signature);

		const headers = buildAp4mRetryHeaders(
			{ accept: "application/json" },
			{
				paymentSignature: fixture.x402.payment_signature,
				mastercardIntent: intent,
				viL1: fixture.vi.l1,
				viL2: fixture.vi.l2_presentations.merchant,
				viL3b: fixture.vi.l3b,
			},
		);
		expect(Object.fromEntries(headers.entries())).toEqual(fixture.x402.retry_headers);
		expect(headers.get("x-vi-l1")).toBe(fixture.vi.l1);
		expect(headers.get("x-vi-l2")).toBe(fixture.vi.l2_presentations.merchant);
		expect(headers.get("x-vi-l2")).toBe(buildAp4mMerchantL2Presentation({
			baseJwt: fixture.vi.l2_parts.base_jwt,
			payment: fixture.vi.l2_parts.payment,
			merchant: fixture.vi.l2_parts.merchant,
			checkout: fixture.vi.l2_parts.checkout,
			item: fixture.vi.l2_parts.item,
		}));
		expect(headers.get("x-vi-l2")!.split("~")).toEqual([
			fixture.vi.l2_parts.base_jwt,
			fixture.vi.l2_parts.payment,
			fixture.vi.l2_parts.merchant,
			fixture.vi.l2_parts.checkout,
			fixture.vi.l2_parts.item,
			"",
		]);
		expect(headers.get("x-vi-l3b")).toBe(fixture.vi.l3b);
		expect(headers.has("x-vi-l3a")).toBe(false);
		expect(
			decodeJsonBase64Url(headers.get("x-mastercard-intent")!),
		).toEqual(intent);
		const paymentEnvelope = JSON.parse(
			new TextDecoder().decode(
				Uint8Array.from(atob(headers.get("payment-signature")!), (character) => character.charCodeAt(0)),
			),
		) as JsonObject;
		expect((paymentEnvelope.payload as JsonObject).signedTxBlob).toBe("DEADBEEF");
		expect(paymentEnvelope.accepted).toEqual(challenge.accepted);
	});

	it("validates typed merchant bytes without presenting the synthetic hash as ledger proof", () => {
		const result = validateAp4mMerchantResponse(
			{
				data: {
					schema_id: "yield_report_v1",
					venue: fixture.merchant.id,
					apr_percent: "4.25",
					tvl_usd: "1000000",
					risk: "low",
					as_of_basis: "offline fixture",
				},
				intent_validation: {
					intentId: (fixture.intent as { intentId: string }).intentId,
					validated: true,
					checks: { agent_identity: "pass", intent: "pass", payment: "pass", credential: "pass" },
					validation_errors: [],
				},
			},
			{
				receiptId: "receipt-mh4-mm2-v1",
				mandateId: "mandate-mh4-mm2-v1",
				merchant: {
					id: fixture.merchant.id,
					name: "Venue Yield Desk",
					network: "testnet",
					base_url: "https://merchant.example",
					xrpl_address: fixture.merchant.address,
					src_dpa_id: "demo-dpa-venue-yield-desk",
					schemes: ["exact"],
					settle_asset: { kind: "iou", currency: "RLUSD", issuer: fixture.merchant.issuer },
					required_credential: { issuer: fixture.merchant.issuer, credential_type_hex: "4150344D2D4167656E74" },
					products: [{
						sku: fixture.merchant.sku,
						name: "Venue yield report",
						description: "Offline fixture product",
						price: { asset: { kind: "iou", currency: "RLUSD", issuer: fixture.merchant.issuer }, value: "1" },
						response_schema_id: "yield_report_v1",
					}],
					wba_required: false,
				},
				sku: fixture.merchant.sku,
				intentId: (fixture.intent as { intentId: string }).intentId,
				l3aDigest: fixture.vi.l3a_digest,
				l3bDigest: fixture.vi.l3b_digest,
				paidAmount: {
					asset: { kind: "iou", currency: "RLUSD", issuer: fixture.merchant.issuer },
					value: "1",
				},
				settlement: {
					scheme: "exact",
					settlement: "settlement_unknown",
					proof: { tx_hash: fixture.x402.synthetic_payment.tx_hash },
				},
				at: fixture.generated_at,
			},
		);
		expect(result.receipt.settlement).toBe("settlement_unknown");
		expect(result.receipt.proof.tx_hash).toBe(fixture.x402.synthetic_payment.tx_hash);
	});

	it("rejects tampering in the intent, challenge, L3 signature, and retry envelope", async () => {
		const tamperedIntent = structuredClone(fixture.intent) as {
			orders: Array<{ orderTotalAmount: { amount: string } }>;
		};
		tamperedIntent.orders[0]!.orderTotalAmount.amount = "2.00";
		const tamperedCheckout = buildAp4mCheckoutPayload(
			McIntentSchema.parse(tamperedIntent),
			{
				scheme: "exact",
				network: "testnet",
				currency: "RLUSD",
				issuer: fixture.merchant.issuer,
				amount: "1",
				payTo: fixture.merchant.address,
			},
		);
		expect(await sha256Base64Url(tamperedCheckout)).not.toBe(fixture.vi.checkout_hash);

		const challenge = JSON.parse(atob(fixture.x402.payment_required)) as {
			accepts: Array<{ payTo: string }>;
		};
		challenge.accepts[0]!.payTo = "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY";
		const encodedChallenge = btoa(JSON.stringify(challenge));
		expect(() => validateAp4mX402Challenge(encodedChallenge, challengeOptions())).toThrowError(
			new Ap4mX402Error("PAY_TO_MISMATCH"),
		);

		const l3Segments = fixture.vi.l3b.split("~");
		const jwtSegments = l3Segments[0]!.split(".");
		jwtSegments[2] = `${jwtSegments[2]![0] === "A" ? "B" : "A"}${jwtSegments[2]!.slice(1)}`;
		l3Segments[0] = jwtSegments.join(".");
		expect(
			await verifyCompactJwt(l3Segments.join("~"), fixture.keys.agent_public_jwk),
		).toBe(false);

		expect(() => buildAp4mRetryHeaders(
			[["x-vi-l3b", fixture.vi.l3b]],
			{
				paymentSignature: fixture.x402.payment_signature,
				mastercardIntent: fixture.intent,
				viL1: fixture.vi.l1,
				viL2: fixture.vi.l2_presentations.merchant,
				viL3b: fixture.vi.l3b,
			},
		)).toThrowError(new Ap4mX402Error("RESERVED_HEADER_PRESENT"));
	});
});
