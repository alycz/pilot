import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../memory/structured-preferences", async () => {
  const ReactModule = await import("react");
  return {
    StructuredPreferencesPanel: () => ReactModule.createElement("div", null, "Personal preferences"),
  };
});
vi.mock("../memory/workflow-lessons", async () => {
  const ReactModule = await import("react");
  return {
    WorkflowLessonsPanel: () => ReactModule.createElement("div", null, "Workflow lessons"),
  };
});

import { WhatPilotRemembers } from "./what-pilot-remembers";

const owner = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";

describe("WhatPilotRemembers isolation states", () => {
  it("renders editable panels only for an exact ready wallet scope", () => {
    const markup = renderToStaticMarkup(
      <WhatPilotRemembers state={{ kind: "ready", owner, network: "testnet" }} />,
    );
    expect(markup).toContain("What Pilot remembers");
    expect(markup).toContain("Personal preferences");
    expect(markup).toContain("Workflow lessons");
    expect(markup).toContain("testnet");
    expect(markup).toContain("r9cZA1mL…nfk59");
    expect(markup).toContain("cannot expand permissions");
  });

  it("does not render memory records while checking, signed out, or unavailable", () => {
    for (const state of [
      { kind: "checking" as const },
      { kind: "signed-out" as const },
      { kind: "unavailable" as const, reason: "Scope could not be verified." },
    ]) {
      const markup = renderToStaticMarkup(<WhatPilotRemembers state={state} />);
      expect(markup).not.toContain("Personal preferences");
      expect(markup).not.toContain("Workflow lessons");
      expect(markup).not.toContain(owner);
    }
  });
});
