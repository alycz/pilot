import { describe, expect, it } from "vitest";

import { buildWbaDirectory } from "../src/exec/wba";
import fixture from "./fixtures/wba-mh6-mm2-v1.json";

describe("MH6/MM2 public interop fixture", () => {
	it("matches the canonical directory JWK thumbprint and XRPL linkage", async () => {
		const expected = fixture.directory.body;
		const publicKey = expected.keys[0];
		const directory = await buildWbaDirectory(
			{ kty: publicKey.kty, crv: publicKey.crv, x: publicKey.x },
			{
				issuer: expected.xrpl_credential.issuer,
				credential_type: "AP4M-Agent",
				subject: expected.xrpl_credential.subject,
			},
		);

		expect(directory).toEqual(expected);
		expect(directory.keys[0]?.kid).toBe(
			"hMpqJ0RLXpBl0y-lbewzCqQ7jgh5SsU7Hulc-r0spg4",
		);
		expect(fixture.request.headers["Signature-Input"]).toContain(
			'tag="web-bot-auth"',
		);
		expect(JSON.stringify(fixture)).not.toMatch(
			/"(?:d|seed|privateKey|mnemonic|credential)"\s*:/i,
		);
	});
});
