import { describe, expect, it } from "vitest";

import { resolveFixtureAppOrigin } from "./fixture-app-origin";

describe("resolveFixtureAppOrigin", () => {
  it.each([
    "http://127.0.0.1:3004",
    "http://127.0.0.1:3015/",
  ])("accepts the active explicit loopback origin %s", (baseURL) => {
    expect(resolveFixtureAppOrigin(baseURL)).toBe(baseURL.replace(/\/$/, ""));
  });

  it.each([
    undefined,
    "",
    "http://localhost:3004",
    "http://127.0.0.2:3004",
    "https://127.0.0.1:3004",
    "http://user@127.0.0.1:3004",
    "http://127.0.0.1:3004/chat",
    "http://127.0.0.1:3004/?lane=fixture",
    "http://127.0.0.1:3004/#fixture",
    "http://127.0.0.1",
    "http://127.0.0.1:80",
  ])("rejects a broadened or ambiguous baseURL %s", (baseURL) => {
    expect(() => resolveFixtureAppOrigin(baseURL)).toThrow(
      /isolated fixture (?:requires|baseURL)/,
    );
  });
});
