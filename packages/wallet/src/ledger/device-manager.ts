import type { LedgerDeviceState } from "../index.js";
import type { DiscoveredDevice } from "@ledgerhq/device-management-kit";
import { LedgerManagerError } from "./errors.js";
import {
  runLedgerDeviceAction,
  type LedgerDeviceAction,
} from "./xrp.js";

export type LedgerTransport = "webhid" | "virtual";

export type LedgerDeviceConfig = Readonly<{
  transport: LedgerTransport;
  virtualBaseUrl?: string;
}>;

type LedgerAddress = Readonly<{ address: string; publicKey: string }>;
type LedgerAppConfig = Readonly<{ version: string }>;

export interface LedgerDeviceLease {
  getAppConfig(onState: (state: LedgerDeviceState) => void): Promise<LedgerAppConfig>;
  getAddress(
    path: string,
    options: { checkOnDevice?: boolean },
    onState: (state: LedgerDeviceState) => void,
  ): Promise<LedgerAddress>;
  signTransaction(
    path: string,
    bytes: Uint8Array,
    onState: (state: LedgerDeviceState) => void,
  ): Promise<Uint8Array>;
  release(): void;
  forget(): Promise<void>;
}

type SharedLedgerSession = Readonly<{
  configKey: string;
  getAppConfig(): LedgerDeviceAction<LedgerAppConfig>;
  getAddress(
    path: string,
    options?: { checkOnDevice?: boolean },
  ): LedgerDeviceAction<LedgerAddress>;
  signTransaction(path: string, bytes: Uint8Array): LedgerDeviceAction<Uint8Array>;
  close(): Promise<void>;
}>;

type SessionFactory = (
  config: LedgerDeviceConfig,
) => Promise<SharedLedgerSession>;

type DiscoveryKit = Pick<
  import("@ledgerhq/device-management-kit").DeviceManagementKit,
  "listenToAvailableDevices" | "startDiscovering"
>;

type DiscoveryRuntime = Pick<
  typeof import("rxjs"),
  "firstValueFrom" | "take"
>;

const GRANTED_DEVICE_WAIT_MS = 100;

let sharedSession: Promise<SharedLedgerSession> | undefined;
let sharedConfigKey: string | undefined;
let facadeCount = 0;
let sessionFactory: SessionFactory = createDmkSession;

function configKey(config: LedgerDeviceConfig): string {
  return `${config.transport}:${config.virtualBaseUrl ?? ""}`;
}

function assertWebHidAvailable(): void {
  let navigatorValue: Navigator | undefined;
  try {
    navigatorValue = globalThis.navigator;
  } catch {
    // Handled by the sanitized error below.
  }
  if (navigatorValue === undefined || !("hid" in navigatorValue)) {
    throw new LedgerManagerError("unsupported");
  }
}

/**
 * WebHID's available-device stream is a BehaviorSubject whose first value is
 * an empty list while navigator.hid.getDevices() resolves. Ignore that seed,
 * but bound the wait so the click-handler path can still open the picker.
 */
function previouslyGrantedLedgerDevice(
  dmk: DiscoveryKit,
  transportIdentifier: string,
  waitMs = GRANTED_DEVICE_WAIT_MS,
): Promise<DiscoveredDevice | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let subscription: { unsubscribe(): void } | undefined;
    const finish = (device: DiscoveredDevice | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      subscription?.unsubscribe();
      resolve(device);
    };
    const timeout = setTimeout(() => finish(undefined), waitMs);
    subscription = dmk.listenToAvailableDevices({
      transport: transportIdentifier,
    }).subscribe({
      next(devices) {
        if (devices.length > 0) finish(devices[0]);
      },
      error() {
        finish(undefined);
      },
      complete() {
        finish(undefined);
      },
    });
  });
}

export async function __discoverLedgerDeviceForTests(
  dmk: DiscoveryKit,
  transportIdentifier: string,
  rxjs: DiscoveryRuntime,
  waitMs = GRANTED_DEVICE_WAIT_MS,
): Promise<DiscoveredDevice> {
  const known = await previouslyGrantedLedgerDevice(
    dmk,
    transportIdentifier,
    waitMs,
  );
  if (known !== undefined) return known;
  return rxjs.firstValueFrom(
    dmk.startDiscovering({ transport: transportIdentifier }).pipe(rxjs.take(1)),
  );
}

function validatedVirtualBaseUrl(value: string | undefined): string {
  let browserOrigin: string | undefined;
  try {
    browserOrigin = globalThis.location?.origin;
  } catch {
    // A direct loopback URL remains available only to the opt-in node check.
  }
  const fallback = browserOrigin === undefined
    ? undefined
    : `${browserOrigin}/api/ledger-sim`;
  let url: URL;
  try {
    url = new URL(value ?? fallback ?? "invalid:");
  } catch {
    throw new LedgerManagerError("virtual-unavailable");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new LedgerManagerError("virtual-unavailable");
  }
  if (browserOrigin !== undefined) {
    if (url.origin !== browserOrigin || url.pathname !== "/api/ledger-sim") {
      throw new LedgerManagerError("virtual-unavailable");
    }
  } else {
    const optIn =
      typeof process !== "undefined" && process.env.TEST_LEDGER_SPECULOS === "1";
    if (
      !optIn || url.protocol !== "http:" ||
      (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    ) {
      throw new LedgerManagerError("virtual-unavailable");
    }
  }
  return url.toString().replace(/\/$/u, "");
}

async function createDmkSession(
  config: LedgerDeviceConfig,
): Promise<SharedLedgerSession> {
  if (config.transport === "webhid") assertWebHidAvailable();

  const [management, signerKit, rxjs] = await Promise.all([
    import("@ledgerhq/device-management-kit"),
    import("@ledgerhq/device-signer-kit-xrp"),
    import("rxjs"),
  ]);

  const builder = new management.DeviceManagementKitBuilder();
  let transportIdentifier;
  if (config.transport === "webhid") {
    const transport = await import("@ledgerhq/device-transport-kit-web-hid");
    transportIdentifier = transport.webHidIdentifier;
    builder.addTransport(transport.webHidTransportFactory);
  } else {
    const transport = await import("@ledgerhq/device-transport-kit-speculos");
    transportIdentifier = transport.speculosIdentifier;
    builder.addTransport(
      transport.speculosTransportFactory(
        validatedVirtualBaseUrl(config.virtualBaseUrl),
        false,
        management.DeviceModelId.NANO_X,
      ),
    );
  }
  const dmk = builder.build();

  try {
    let device: DiscoveredDevice | undefined;
    if (config.transport === "webhid") {
      device = await __discoverLedgerDeviceForTests(
        dmk,
        transportIdentifier,
        rxjs,
      );
    } else {
      device = await rxjs.firstValueFrom(
        dmk.startDiscovering({ transport: transportIdentifier }).pipe(
          rxjs.take(1),
        ),
      );
    }
    if (device === undefined || Array.isArray(device)) {
      throw new LedgerManagerError("cancelled");
    }
    const sessionId = await dmk.connect({ device });
    const signer = new signerKit.SignerXrpBuilder({ dmk, sessionId }).build();
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      try {
        await dmk.disconnect({ sessionId });
      } catch {
        // The local session is closed even if the transport already vanished.
      }
      dmk.close();
    };
    const onPageHide = () => {
      void close();
    };
    globalThis.addEventListener?.("pagehide", onPageHide, { once: true });

    return {
      configKey: configKey(config),
      getAppConfig: () => signer.getAppConfig(),
      getAddress: (path, options) => signer.getAddress(path, options),
      signTransaction: (path, bytes) => signer.signTransaction(path, bytes),
      async close() {
        globalThis.removeEventListener?.("pagehide", onPageHide);
        await close();
      },
    };
  } catch (error) {
    dmk.close();
    if (config.transport === "virtual") {
      throw error instanceof LedgerManagerError
        ? error
        : new LedgerManagerError("virtual-unavailable");
    }
    throw error;
  }
}

export async function acquireLedgerDevice(
  config: LedgerDeviceConfig,
): Promise<LedgerDeviceLease> {
  const key = configKey(config);
  if (sharedSession === undefined) {
    sharedConfigKey = key;
    sharedSession = sessionFactory(config).catch((error) => {
      sharedSession = undefined;
      sharedConfigKey = undefined;
      throw error;
    });
  } else if (sharedConfigKey !== key) {
    throw new LedgerManagerError(
      config.transport === "virtual" ? "virtual-unavailable" : "unsupported",
    );
  }

  const acquiredSession = sharedSession;
  const session = await acquiredSession;
  facadeCount += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    facadeCount = Math.max(0, facadeCount - 1);
  };
  return {
    getAppConfig: (onState) =>
      runLedgerDeviceAction(session.getAppConfig(), onState),
    getAddress: (path, options, onState) =>
      runLedgerDeviceAction(session.getAddress(path, options), onState),
    signTransaction: (path, bytes, onState) =>
      runLedgerDeviceAction(session.signTransaction(path, bytes), onState),
    release,
    async forget() {
      release();
      if (sharedSession === acquiredSession) {
        sharedSession = undefined;
        sharedConfigKey = undefined;
        facadeCount = 0;
        await session.close();
      }
    },
  };
}

export function __setLedgerSessionFactoryForTests(
  factory: SessionFactory | undefined,
): void {
  sharedSession = undefined;
  sharedConfigKey = undefined;
  facadeCount = 0;
  sessionFactory = factory ?? createDmkSession;
}

export function __ledgerFacadeCountForTests(): number {
  return facadeCount;
}
