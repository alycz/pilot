"use client";
import { useState } from "react";

const PATH = "44'/144'/0'/0/0";

export default function Page() {
  const [log, setLog] = useState<string[]>([]);
  const add = (s: string) => setLog((l) => [...l, s]);

  async function run() {
    // Lazy imports: DMK never enters the server bundle.
    const [{ DeviceManagementKitBuilder, DeviceActionStatus, DeviceModelId }, { speculosTransportFactory }, { SignerXrpBuilder }, xrpl, { firstValueFrom }] =
      await Promise.all([
        import("@ledgerhq/device-management-kit"),
        import("@ledgerhq/device-transport-kit-speculos"),
        import("@ledgerhq/device-signer-kit-xrp"),
        import("xrpl"),
        import("rxjs"),
      ]);
    const done = <T,>(obs: any): Promise<T> => new Promise((res, rej) => obs.subscribe({
      next: (s: any) => {
        if (s.status === DeviceActionStatus.Pending) add(`device: ${s.intermediateValue?.requiredUserInteraction}`);
        else if (s.status === DeviceActionStatus.Completed) res(s.output);
        else if (s.status === DeviceActionStatus.Error) rej(s.error);
      }, error: rej }));
    try {
      const dmk = new DeviceManagementKitBuilder()
        .addTransport(speculosTransportFactory(`${location.origin}/api/ledger-sim`, false, DeviceModelId.NANO_X))
        .build();
      const device = await firstValueFrom(dmk.startDiscovering({}));
      const sessionId = await dmk.connect({ device });
      add(`connected ${device.deviceModel.model}`);
      const signer = new SignerXrpBuilder({ dmk, sessionId }).build();
      const { address, publicKey } = await done<{ address: string; publicKey: string }>(signer.getAddress(PATH).observable);
      add(`address ${address}`);
      const unsigned = { TransactionType: "TrustSet", Account: address, Fee: "12", Sequence: 1, LastLedgerSequence: 99999999,
        LimitAmount: { currency: "524C555344000000000000000000000000000000", issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV", value: "1000" },
        SigningPubKey: publicKey.toUpperCase() };
      const bytes = Uint8Array.from(xrpl.encode(unsigned as never).match(/../g)!.map((h) => parseInt(h, 16)));
      const der = await done<Uint8Array>(signer.signTransaction(PATH, bytes).observable);
      const sig = Array.from(der, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
      const blob = xrpl.encode({ ...unsigned, TxnSignature: sig } as never);
      add(`RESULT verify=${xrpl.verifySignature(blob)} blob=${blob.slice(0, 24)}…`);
    } catch (e: any) { add(`ERROR ${e?._tag ?? e?.name} ${e?.errorCode ?? ""} ${e?.message ?? e}`); }
  }
  return (<main><button id="go" onClick={run}>Sign with virtual Ledger</button><pre id="log">{log.join("\n")}</pre></main>);
}
