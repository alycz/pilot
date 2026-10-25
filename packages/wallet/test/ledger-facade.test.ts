import { afterEach, describe, expect, it, vi } from "vitest";
import { decode, ECDSA, encode, Wallet } from "xrpl";

import {
  PilotWalletError,
  createWallet,
  type LedgerDeviceState,
} from "../src/index.js";
import {
  assertLedgerSignedFields,
  createLedgerWallet,
} from "../src/ledger/facade.js";
import type { LedgerDeviceLease } from "../src/ledger/device-manager.js";
import { bytesFromHex, hexFromBytes } from "../src/ledger/xrp.js";

function expectCode(code: string) {
  return expect.objectContaining({ name: "PilotWalletError", code });
}

function fixture() {
  const signer = Wallet.generate(ECDSA.secp256k1);
  let released = 0;
  let forgotten = 0;
  let signCalls = 0;
  const states: LedgerDeviceState[] = [];
  const lease: LedgerDeviceLease = {
    async getAppConfig(onState) {
      onState({ interaction: "confirm-open-app", busy: true });
      onState({ interaction: "none", busy: false });
      return { version: "2.8.2" };
    },
    async getAddress(_path, options, onState) {
      if (options.checkOnDevice) {
        onState({ interaction: "verify-address", busy: true });
        onState({ interaction: "none", busy: false });
      }
      return {
        address: signer.classicAddress,
        publicKey: signer.publicKey,
      };
    },
    async signTransaction(_path, bytes, onState) {
      signCalls += 1;
      onState({ interaction: "sign-transaction", busy: true });
      const unsigned = decode(hexFromBytes(bytes)) as Record<string, unknown>;
      const signed = signer.sign(unsigned as never);
      const decoded = decode(signed.tx_blob) as Record<string, unknown>;
      onState({ interaction: "none", busy: false });
      return bytesFromHex(String(decoded.TxnSignature));
    },
    release() {
      released += 1;
    },
    async forget() {
      forgotten += 1;
    },
  };
  const acquireDevice = vi.fn(async () => lease);
  return {
    signer,
    lease,
    acquireDevice,
    states,
    counts: () => ({ released, forgotten, signCalls }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Ledger wallet facade", () => {
  it("signs a wallet challenge accepted by the server verifier", async () => {
    const sessionModulePath = "../../../apps/web/lib/wallet-session.js";
    const { issueWalletChallenge, verifyWalletChallenge } = await import(
      sessionModulePath
    );
    const fake = fixture();
    const wallet = createLedgerWallet(
      "testnet",
      { transport: "virtual", accountIndex: 0 },
      { acquireDevice: fake.acquireDevice },
    );
    const seen: LedgerDeviceState[] = [];
    wallet.onDeviceState?.((state) => seen.push(state));

    const account = await wallet.connect();
    const challenge = issueWalletChallenge(account, "testnet", {
      now: 1_000,
      nonce: "A".repeat(43),
      secret: "s".repeat(32),
    });
    const blob = await wallet.signOnly(challenge.txJson);

    expect(
      verifyWalletChallenge(challenge.cookie, blob, {
        now: 2_000,
        secret: "s".repeat(32),
      }),
    ).toMatchObject({ account, network: "testnet" });
    expect(fake.counts().signCalls).toBe(1);
    expect(seen).toContainEqual({ interaction: "sign-transaction", busy: true });
    expect(wallet.ledgerTransport).toBe("virtual");
    expect(wallet.custody).toBe("software");
    await expect(wallet.ledgerAppVersion?.()).resolves.toBe("2.8.2");
  });

  it("verifies the same address on the device", async () => {
    const fake = fixture();
    const wallet = createLedgerWallet(
      "devnet",
      { transport: "webhid", accountIndex: 9 },
      { acquireDevice: fake.acquireDevice },
    );
    await wallet.connect();
    expect(wallet.ledgerTransport).toBe("webhid");
    expect(wallet.custody).toBe("hardware");
    await expect(wallet.verifyAddressOnDevice?.()).resolves.toBeUndefined();
  });

  it("rejects account mismatch before calling the signer", async () => {
    const fake = fixture();
    const wallet = createLedgerWallet(
      "testnet",
      { transport: "virtual" },
      { acquireDevice: fake.acquireDevice },
    );
    await wallet.connect();
    await expect(
      wallet.signOnly({
        TransactionType: "Payment",
        Account: "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY",
        Destination: fake.signer.classicAddress,
        Amount: "1",
      }),
    ).rejects.toEqual(expectCode("ACCOUNT_MISMATCH"));
    expect(fake.counts().signCalls).toBe(0);
  });

  it.each(["mainnet", "lending-devnet"] as const)(
    "refuses signing on %s before acquiring a device",
    async (network) => {
      const fake = fixture();
      const wallet = createLedgerWallet(
        network,
        { transport: "webhid" },
        { acquireDevice: fake.acquireDevice },
      );
      await expect(wallet.connect()).rejects.toEqual(
        expectCode("MAINNET_SIGNING_DISABLED"),
      );
      expect(fake.acquireDevice).not.toHaveBeenCalled();
    },
  );

  it("rejects any final blob whose non-signature fields changed", () => {
    const fake = fixture();
    const original = {
      TransactionType: "Payment",
      Account: fake.signer.classicAddress,
      Destination: "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY",
      Amount: "1",
      Fee: "12",
      Sequence: 1,
      LastLedgerSequence: 100,
    };
    const changed = fake.signer.sign({ ...original, Amount: "2" } as never);
    expect(() => assertLedgerSignedFields(original, changed.tx_blob)).toThrowError(
      expectCode("SIGN_FAILED"),
    );
  });

  it("serializes signing and recovers after a rejected request", async () => {
    const fake = fixture();
    let active = 0;
    let peak = 0;
    let calls = 0;
    const original = fake.lease.signTransaction;
    fake.lease.signTransaction = async (...args) => {
      calls += 1;
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      if (calls === 1) throw { errorCode: "6985" };
      return original(...args);
    };
    const wallet = createLedgerWallet(
      "testnet",
      { transport: "virtual" },
      { acquireDevice: fake.acquireDevice },
    );
    const account = await wallet.connect();
    const tx = {
      TransactionType: "TrustSet",
      Account: account,
      LimitAmount: {
        currency: "USD",
        issuer: "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY",
        value: "10",
      },
      Fee: "12",
      Sequence: 1,
    };
    await expect(wallet.signOnly(tx)).rejects.toEqual(expectCode("SIGN_CANCELLED"));
    await expect(wallet.signOnly(tx)).resolves.toMatch(/^[A-F0-9]+$/);
    expect(peak).toBe(1);
  });

  it("does not run stale queued work against a reconnected session", async () => {
    const fake = fixture();
    const original = fake.lease.signTransaction;
    let releaseFirst: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let calls = 0;
    fake.lease.signTransaction = async (...args) => {
      calls += 1;
      if (calls === 1) {
        markStarted?.();
        await firstCanFinish;
      }
      return original(...args);
    };
    const wallet = createLedgerWallet(
      "testnet",
      { transport: "virtual" },
      { acquireDevice: fake.acquireDevice },
    );
    const account = await wallet.connect();
    const tx = {
      TransactionType: "Payment",
      Account: account,
      Destination: "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY",
      Amount: "1",
      Fee: "12",
      Sequence: 1,
    };

    const first = wallet.signOnly(tx);
    await firstStarted;
    const staleQueued = wallet.signOnly(tx);
    await wallet.disconnect();
    await wallet.connect();
    releaseFirst?.();

    await expect(first).rejects.toEqual(expectCode("SIGN_CANCELLED"));
    await expect(staleQueued).rejects.toEqual(expectCode("SIGN_CANCELLED"));
    expect(calls).toBe(1);
  });

  it("releases only its facade on disconnect and closes globally on forget", async () => {
    const fake = fixture();
    const wallet = createLedgerWallet(
      "testnet",
      { transport: "virtual" },
      { acquireDevice: fake.acquireDevice },
    );
    await wallet.connect();
    await wallet.disconnect();
    expect(fake.counts()).toMatchObject({ released: 1, forgotten: 0 });

    await wallet.connect();
    await wallet.forget();
    expect(fake.counts()).toMatchObject({ released: 1, forgotten: 1 });
  });

  it("exposes Ledger in the stable provider list through createWallet", () => {
    const wallet = createWallet({
      provider: "ledger",
      network: "testnet",
      ledger: { transport: "virtual", accountIndex: 0 },
    });
    expect(wallet.provider).toBe("ledger");
    expect(wallet.ledgerTransport).toBe("virtual");
    expect(wallet.custody).toBe("software");
  });
});
