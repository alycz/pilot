import { afterEach, describe, expect, it, vi } from "vitest";
import { BehaviorSubject, firstValueFrom, of, take } from "rxjs";
import { ECDSA, Wallet } from "xrpl";
import type { DiscoveredDevice } from "@ledgerhq/device-management-kit";

import {
  __discoverLedgerDeviceForTests,
  __ledgerFacadeCountForTests,
  __setLedgerSessionFactoryForTests,
} from "../src/ledger/device-manager.js";
import { createWallet } from "../src/index.js";

afterEach(() => {
  __setLedgerSessionFactoryForTests(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function discoveredDevice(id: string): DiscoveredDevice {
  return {
    id,
    name: `Ledger ${id}`,
    transport: "WEB-HID",
    deviceModel: {
      id: "nanoX",
      name: "Ledger Nano X",
    },
  } as unknown as DiscoveredDevice;
}

describe("Ledger WebHID discovery", () => {
  it("ignores the initial empty emission and reuses a granted device", async () => {
    const granted = discoveredDevice("granted");
    const picked = discoveredDevice("picked");
    const available = new BehaviorSubject<DiscoveredDevice[]>([]);
    const startDiscovering = vi.fn(() => of(picked));
    const dmk = {
      listenToAvailableDevices: vi.fn(() => available.asObservable()),
      startDiscovering,
    } as Parameters<typeof __discoverLedgerDeviceForTests>[0];

    const pending = __discoverLedgerDeviceForTests(
      dmk,
      "WEB-HID",
      { firstValueFrom, take },
      1_000,
    );
    available.next([granted]);

    await expect(pending).resolves.toBe(granted);
    expect(startDiscovering).not.toHaveBeenCalled();
  });

  it("falls back to the picker after the bounded granted-device wait", async () => {
    vi.useFakeTimers();
    const picked = discoveredDevice("picked");
    const available = new BehaviorSubject<DiscoveredDevice[]>([]);
    const startDiscovering = vi.fn(() => of(picked));
    const dmk = {
      listenToAvailableDevices: vi.fn(() => available.asObservable()),
      startDiscovering,
    } as Parameters<typeof __discoverLedgerDeviceForTests>[0];

    const pending = __discoverLedgerDeviceForTests(
      dmk,
      "WEB-HID",
      { firstValueFrom, take },
      25,
    );
    await vi.advanceTimersByTimeAsync(25);

    await expect(pending).resolves.toBe(picked);
    expect(startDiscovering).toHaveBeenCalledTimes(1);
  });
});

describe("Ledger device singleton", () => {
  it("shares one session across two facades and closes only on forget", async () => {
    const account = Wallet.generate(ECDSA.secp256k1);
    const close = vi.fn().mockResolvedValue(undefined);
    const factory = vi.fn(async () => ({
      configKey: "virtual:http://127.0.0.1:5000",
      getAppConfig: () => ({
        observable: of({ status: "completed" as const, output: { version: "2.8.2" } }),
      }),
      getAddress: () => ({
        observable: of({
          status: "completed" as const,
          output: { address: account.classicAddress, publicKey: account.publicKey },
        }),
      }),
      signTransaction: () => ({
        observable: of({ status: "completed" as const, output: new Uint8Array() }),
      }),
      close,
    }));
    __setLedgerSessionFactoryForTests(factory);
    const options = {
      provider: "ledger" as const,
      network: "testnet" as const,
      ledger: {
        transport: "virtual" as const,
        virtualBaseUrl: "http://127.0.0.1:5000",
      },
    };
    const first = createWallet(options);
    const second = createWallet(options);

    await Promise.all([first.connect(), second.connect()]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(__ledgerFacadeCountForTests()).toBe(2);

    await first.disconnect();
    expect(close).not.toHaveBeenCalled();
    expect(__ledgerFacadeCountForTests()).toBe(1);

    await second.forget();
    expect(close).toHaveBeenCalledTimes(1);
    expect(__ledgerFacadeCountForTests()).toBe(0);
  });

  it("can forget and close a session after a soft disconnect", async () => {
    const account = Wallet.generate(ECDSA.secp256k1);
    const close = vi.fn().mockResolvedValue(undefined);
    __setLedgerSessionFactoryForTests(async () => ({
      configKey: "virtual:http://127.0.0.1:5000",
      getAppConfig: () => ({
        observable: of({ status: "completed" as const, output: { version: "2.8.2" } }),
      }),
      getAddress: () => ({
        observable: of({
          status: "completed" as const,
          output: { address: account.classicAddress, publicKey: account.publicKey },
        }),
      }),
      signTransaction: () => ({
        observable: of({ status: "completed" as const, output: new Uint8Array() }),
      }),
      close,
    }));
    const wallet = createWallet({
      provider: "ledger",
      network: "testnet",
      ledger: {
        transport: "virtual",
        virtualBaseUrl: "http://127.0.0.1:5000",
      },
    });

    await wallet.connect();
    await wallet.disconnect();
    expect(close).not.toHaveBeenCalled();

    await wallet.forget();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
