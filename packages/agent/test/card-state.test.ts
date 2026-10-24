import { describe, expect, it } from "vitest";

import { CardStateMachine } from "../src/card-state.js";

const intent = {
  id: "intent-card-001",
  network: "testnet",
  kind: "swap",
  sell: {
    currency: "RLUSD",
    issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
  },
  buy: { currency: "XRP" },
  amount: "50",
  side: "sell",
  max_slippage_bps: 100,
} as const;

describe("CardStateMachine", () => {
  it("emits contract-valid events in order", async () => {
    const emitted: string[] = [];
    const machine = new CardStateMachine(intent, {
      emit: (event) => {
        emitted.push(event.state);
      },
      now: () => new Date("2026-10-18T00:00:00.000Z"),
    });

    await machine.drafting();
    await machine.planned();

    expect(machine.current).toBe("planned");
    expect(emitted).toEqual(["drafting", "planned"]);
    expect(machine.events[0]).toMatchObject({
      intent_id: intent.id,
      intent,
      at: "2026-10-18T00:00:00.000Z",
    });
  });

  it("rejects skipped and terminal transitions", async () => {
    const skipped = new CardStateMachine(intent);
    await expect(skipped.planned()).rejects.toThrow("start at drafting");

    const terminal = new CardStateMachine(intent);
    await terminal.drafting();
    await terminal.failed("blocked locally");
    await expect(terminal.planned()).rejects.toThrow(
      "Invalid card transition from failed to planned",
    );
  });
});
