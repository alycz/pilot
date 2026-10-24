import type { Metadata } from "next";

import { SimulatedDeviceDemo } from "@/components/ledger/simulated-device-demo";

export const metadata: Metadata = {
  title: "Simulated Ledger demo",
  description: "A local replay of recorded Ledger XRP app screens with no device or signing capability.",
};

export default function SimulatedLedgerDemoPage() {
  return <SimulatedDeviceDemo />;
}
