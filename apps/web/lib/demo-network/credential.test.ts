import { describe, expect, it, vi } from "vitest";
import type {
  CredentialCreate,
  CredentialDelete,
  ServerInfoResponse,
} from "xrpl";

import {
  issueCredential,
  revokeCredential,
  type CredentialDependencies,
} from "./credential";

const SUBJECT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const ISSUER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const ENV = {
  NODE_ENV: "test",
  AP4M_CREDENTIAL_TYPE: "AP4M-Agent",
  DEMO_NETWORK_ISSUER_SEED: "fixture-seed-not-a-real-secret",
  XRPL_TESTNET_URL: "wss://testnet.example",
} as const;

function harness(networkId = 1) {
  const transactions: Array<CredentialCreate | CredentialDelete> = [];
  let signCalls = 0;
  let endpoint: string | undefined;
  const dependencies: Partial<CredentialDependencies> = {
    env: ENV,
    now: () => Date.UTC(2026, 9, 21),
    walletFromSeed: () => ({
      classicAddress: ISSUER,
      sign: (transaction) => {
        signCalls += 1;
        transactions.push(transaction);
        return { hash: "SIGNED", tx_blob: "BLOB" };
      },
    }),
    createClient: (value) => {
      endpoint = value;
      return {
        connect: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => undefined),
        request: vi.fn(async () => ({
          result: { info: { network_id: networkId } },
        }) as ServerInfoResponse),
        autofill: vi.fn(async (transaction) => transaction),
        submitAndWait: vi.fn(async () => ({
          result: {
            hash: "VALIDATED_HASH",
            ledger_index: 123,
            meta: { TransactionResult: "tesSUCCESS" },
            validated: true,
          },
        })),
      };
    },
  };
  return {
    dependencies,
    get endpoint() {
      return endpoint;
    },
    get signCalls() {
      return signCalls;
    },
    transactions,
  };
}

describe("demo-network credential transactions", () => {
  it("builds and submits a seven-day AP4M-Agent CredentialCreate", async () => {
    const test = harness();
    const result = await issueCredential(
      { demoUrl: "https://pilot.example/demo/ap4m", subject: SUBJECT },
      test.dependencies,
    );

    expect(test.endpoint).toBe("wss://testnet.example");
    expect(test.transactions).toEqual([
      {
        TransactionType: "CredentialCreate",
        Account: ISSUER,
        Subject: SUBJECT,
        CredentialType: "4150344D2D4167656E74",
        Expiration: 846_460_800,
        URI: Buffer.from("https://pilot.example/demo/ap4m", "utf8")
          .toString("hex")
          .toUpperCase(),
      },
    ]);
    expect(result).toEqual({
      action: "issued",
      credential_type_hex: "4150344D2D4167656E74",
      expiration: 846_460_800,
      issuer: ISSUER,
      ledger_index: 123,
      network: "testnet",
      subject: SUBJECT,
      tx_hash: "VALIDATED_HASH",
      uri: Buffer.from("https://pilot.example/demo/ap4m", "utf8")
        .toString("hex")
        .toUpperCase(),
    });
    expect(JSON.stringify(result)).not.toContain(ENV.DEMO_NETWORK_ISSUER_SEED);
  });

  it("builds issuer-side CredentialDelete for the same type", async () => {
    const test = harness();
    const result = await revokeCredential(SUBJECT, test.dependencies);

    expect(test.transactions).toEqual([
      {
        TransactionType: "CredentialDelete",
        Account: ISSUER,
        Subject: SUBJECT,
        CredentialType: "4150344D2D4167656E74",
      },
    ]);
    expect(result.action).toBe("revoked");
    expect(result.network).toBe("testnet");
  });

  it("refuses a non-Testnet endpoint before signing", async () => {
    const test = harness(0);
    await expect(
      issueCredential(
        { demoUrl: "https://pilot.example/demo/ap4m", subject: SUBJECT },
        test.dependencies,
      ),
    ).rejects.toMatchObject({ code: "LEDGER_NETWORK_MISMATCH" });
    expect(test.signCalls).toBe(0);
  });

  it("refuses to replace the exact AP4M-Agent credential type", async () => {
    const test = harness();
    await expect(
      revokeCredential(SUBJECT, {
        ...test.dependencies,
        env: { ...ENV, AP4M_CREDENTIAL_TYPE: "Different-Type" },
      }),
    ).rejects.toMatchObject({ code: "DEMO_NETWORK_NOT_CONFIGURED" });
    expect(test.signCalls).toBe(0);
  });

  it("does not leak an invalid configured seed", async () => {
    const badSeed = "fixture-invalid-seed-never-return";
    await expect(
      revokeCredential(SUBJECT, {
        env: { ...ENV, DEMO_NETWORK_ISSUER_SEED: badSeed },
        walletFromSeed: () => {
          throw new Error(badSeed);
        },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error && !error.message.includes(badSeed),
    );
  });
});
