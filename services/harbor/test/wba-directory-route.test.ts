import { describe, expect, it } from "vitest";

import { OpRegistry } from "../src/catalog/registry";
import { createWorker, type Env } from "../src/server";

const DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";
const ISSUER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const SUBJECT = "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY";
const PUBLIC_X = "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs";

function configuration(
	publicJwk: Record<string, unknown> = {
		kty: "OKP",
		crv: "Ed25519",
		x: PUBLIC_X,
	},
): string {
	return JSON.stringify({
		public_jwk: publicJwk,
		xrpl_credential: {
			issuer: ISSUER,
			credential_type: "AP4M-Agent",
			subject: SUBJECT,
		},
	});
}

function env(overrides: Partial<Env> = {}): Env {
	return {
		DB: {} as D1Database,
		HARBOR_API_KEYS: "austin:alpha",
		EXECUTOR: "quickjs",
		HARBOR_WBA_DIRECTORY_JSON: configuration(),
		...overrides,
	};
}

async function dispatch(
	overrides: Partial<Env> = {},
	request: Request = new Request(`https://harbor.example${DIRECTORY_PATH}`),
): Promise<Response> {
	return createWorker(new OpRegistry()).fetch!(
		request,
		env(overrides),
		{} as ExecutionContext,
	);
}

describe("Web Bot Auth public directory route", () => {
	it("serves the public JWK and XRPL payer linkage without authentication", async () => {
		const response = await dispatch();

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe(
			"application/http-message-signatures-directory+json",
		);
		expect(response.headers.get("cache-control")).toBe("public, max-age=300");
		await expect(response.json()).resolves.toEqual({
			keys: [
				{
					kty: "OKP",
					crv: "Ed25519",
					x: PUBLIC_X,
					kid: "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U",
					use: "sig",
				},
			],
			xrpl_credential: {
				issuer: ISSUER,
				credential_type: "AP4M-Agent",
				subject: SUBJECT,
			},
		});
	});

	it.each(["POST", "HEAD", "OPTIONS"])(
		"rejects %s without authentication or configuration parsing",
		async (method) => {
			const response = await dispatch(
				{ HARBOR_WBA_DIRECTORY_JSON: "private-config-sentinel" },
				new Request(`https://harbor.example${DIRECTORY_PATH}`, { method }),
			);

			expect(response.status).toBe(405);
			expect(response.headers.get("allow")).toBe("GET");
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(await response.text()).toBe("Method Not Allowed");
		},
	);

	it.each([
		["missing", undefined],
		["malformed", "not-json"],
		[
			"invalid credential",
			JSON.stringify({
				public_jwk: { kty: "OKP", crv: "Ed25519", x: PUBLIC_X },
				xrpl_credential: {
					issuer: ISSUER,
					credential_type: "AP4M-Agent",
					subject: "not-an-address",
				},
			}),
		],
	] as const)("fails closed for %s public configuration", async (_name, value) => {
		const response = await dispatch({ HARBOR_WBA_DIRECTORY_JSON: value });

		expect(response.status).toBe(503);
		expect(response.headers.get("cache-control")).toBe("no-store");
		await expect(response.json()).resolves.toEqual({
			ok: false,
			error: {
				service: "web-bot-auth",
				kind: "error",
				message: "Web Bot Auth directory is unavailable",
				code: "WBA_DIRECTORY_UNAVAILABLE",
			},
		});
	});

	it.each(["d", "seed", "privateKey"])(
		"rejects secret-shaped JWK member %s without disclosing it",
		async (member) => {
			const sentinel = `${member}-material-sentinel`;
			const response = await dispatch({
				HARBOR_WBA_DIRECTORY_JSON: configuration({
					kty: "OKP",
					crv: "Ed25519",
					x: PUBLIC_X,
					[member]: sentinel,
				}),
			});
			const body = await response.text();

			expect(response.status).toBe(503);
			expect(body).not.toContain(sentinel);
			expect(body).not.toContain(`"${member}"`);
		},
	);

	it("rejects query-bearing directory requests before parsing configuration", async () => {
		const response = await dispatch(
			{ HARBOR_WBA_DIRECTORY_JSON: "private-config-sentinel" },
			new Request(`https://harbor.example${DIRECTORY_PATH}?cache=alternate`),
		);

		expect(response.status).toBe(400);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.text()).toBe("Bad Request");
	});

	it("keeps near-match and authenticated routes behind authentication", async () => {
		const worker = createWorker(new OpRegistry());
		for (const url of [
			`https://harbor.example${DIRECTORY_PATH}/`,
			"https://harbor.example/mcp",
		]) {
			const response = await worker.fetch!(
				new Request(url, { method: "POST" }),
				env(),
				{} as ExecutionContext,
			);
			expect(response.status).toBe(401);
			expect(response.headers.get("www-authenticate")).toBe("Bearer");
		}
	});

	it("does not bypass KMS startup validation", async () => {
		const response = await dispatch({
			KMS_MODE: "kek",
			HARBOR_KEK_CIPHERTEXT: undefined,
		});

		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toMatchObject({
			error: { service: "kms", code: "KMS_CIPHERTEXT_MISSING" },
		});
	});
});
