import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DeviceFrame } from "./device-frame";
import { VirtualDevicePanel, VIRTUAL_LEDGER_LABEL } from "./virtual-device-panel";
import {
  LEDGER_EVENTS_PATH,
  LEDGER_POLL_INTERVAL_MS,
  LEDGER_SCREENSHOT_PATH,
  createLedgerScreenRefreshController,
  ledgerButtonForKey,
  virtualLedgerButtonRequest,
} from "./use-ledger-device";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("Virtual Ledger frame", () => {
  it("renders the 3x screen and exact controls in a light device frame", () => {
    const markup = renderToStaticMarkup(
      <DeviceFrame screenSrc={LEDGER_SCREENSHOT_PATH} onButton={vi.fn()} />,
    );
    expect(markup).toContain('src="/api/ledger-sim/screenshot"');
    expect(markup).toContain('width="384"');
    expect(markup).toContain('height="192"');
    expect(markup).toContain("image-rendering:pixelated");
    expect(markup).toContain("◀");
    expect(markup).toContain("●");
    expect(markup).toContain("▶");
    expect(markup).toContain("Keyboard: ← · Enter/↓ · →");
    expect(markup).toContain('aria-label="Virtual Ledger Nano X controls"');
    expect(markup).toContain('alt="Virtual Ledger screen"');
  });

  it("accepts explicit accessible labels for a simulated replay", () => {
    const markup = renderToStaticMarkup(
      <DeviceFrame
        screenSrc="data:image/svg+xml,fixture"
        onButton={vi.fn()}
        controlsLabel="Simulated Ledger controls"
        screenAlt="Recorded Simulated Ledger screen"
      />,
    );
    expect(markup).toContain('aria-label="Simulated Ledger controls"');
    expect(markup).toContain('alt="Recorded Simulated Ledger screen"');
    expect(markup).not.toContain('aria-label="Virtual Ledger Nano X controls"');
    expect(markup).not.toContain('alt="Virtual Ledger screen"');
  });

  it.each([
    ["ArrowLeft", "left"],
    ["ArrowRight", "right"],
    ["ArrowDown", "both"],
    ["Enter", "both"],
    ["Escape", undefined],
  ] as const)("maps keyboard key %s to %s", (key, expected) => {
    expect(ledgerButtonForKey(key)).toBe(expected);
  });

  it("publishes the fixed same-origin endpoints and 300 ms fallback", () => {
    expect(LEDGER_SCREENSHOT_PATH).toBe("/api/ledger-sim/screenshot");
    expect(LEDGER_EVENTS_PATH).toBe("/api/ledger-sim/events?stream=true");
    expect(LEDGER_POLL_INTERVAL_MS).toBe(300);
  });

  it("sends the exact Speculos press-and-release button command", () => {
    expect(virtualLedgerButtonRequest("both")).toEqual([
      "/api/ledger-sim/button/both",
      {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: '{"action":"press-and-release"}',
      },
    ]);
  });

  it("renders the exact emulator label", () => {
    const markup = renderToStaticMarkup(<VirtualDevicePanel />);
    expect(VIRTUAL_LEDGER_LABEL).toBe(
      "Virtual Ledger · Ledger's XRP app 2.8.2 running in an emulator",
    );
    expect(markup).toContain(
      "Virtual Ledger · Ledger&#x27;s XRP app 2.8.2 running in an emulator",
    );
  });

  it("ignores stale and disposed screenshot completions", async () => {
    const first = deferred<{ ok: true; blob(): Promise<Blob> }>();
    const second = deferred<{ ok: true; blob(): Promise<Blob> }>();
    const afterDispose = deferred<{ ok: true; blob(): Promise<Blob> }>();
    const fetchScreen = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(afterDispose.promise);
    const commit = vi.fn();
    const revokeObjectUrl = vi.fn();
    const controller = createLedgerScreenRefreshController({
      fetchScreen,
      createObjectUrl: (blob) => `blob:${(blob as Blob & { id: string }).id}`,
      revokeObjectUrl,
      commit,
    });

    const firstRefresh = controller.refresh();
    const secondRefresh = controller.refresh();
    second.resolve({
      ok: true,
      blob: async () => ({ id: "new" }) as unknown as Blob,
    });
    await secondRefresh;
    first.resolve({
      ok: true,
      blob: async () => ({ id: "old" }) as unknown as Blob,
    });
    await firstRefresh;

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith("blob:new");
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:old");

    const disposedRefresh = controller.refresh();
    controller.dispose();
    afterDispose.resolve({
      ok: true,
      blob: async () => ({ id: "disposed" }) as unknown as Blob,
    });
    await disposedRefresh;

    expect(commit).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:new");
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:disposed");
  });
});
