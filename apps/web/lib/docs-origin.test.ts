import { describe, expect, it } from "vitest";

import { DOCS_ENTRY_PATH, DOCS_PATH, docsRedirects, docsRewrites, resolveDocsOrigin } from "./docs-origin";

describe("resolveDocsOrigin", () => {
  it("is off when unset or blank", () => {
    expect(resolveDocsOrigin(undefined)).toBeUndefined();
    expect(resolveDocsOrigin("  ")).toBeUndefined();
  });

  it("accepts an exact HTTPS origin and normalizes a trailing slash", () => {
    expect(resolveDocsOrigin("https://pilot-docs.vercel.app")).toBe("https://pilot-docs.vercel.app");
    expect(resolveDocsOrigin("https://pilot-docs.vercel.app/")).toBe("https://pilot-docs.vercel.app");
  });

  it("allows http only on loopback", () => {
    expect(resolveDocsOrigin("http://127.0.0.1:5173")).toBe("http://127.0.0.1:5173");
    expect(() => resolveDocsOrigin("http://docs.example")).toThrow(/HTTPS/);
  });

  it("rejects paths, queries, fragments and credentials", () => {
    for (const bad of [
      "https://docs.example/docs",
      "https://docs.example/?x=1",
      "https://docs.example/#a",
      "https://user:pass@docs.example",
      "docs.example",
    ]) {
      expect(() => resolveDocsOrigin(bad), bad).toThrow();
    }
  });
});

describe("docs routing", () => {
  it("adds nothing when the docs origin is unset, so the fallback page renders", () => {
    expect(docsRewrites(undefined)).toEqual([]);
    expect(docsRedirects(undefined)).toEqual([]);
  });

  it("sends the bare /docs path to the first guide page", () => {
    expect(docsRedirects("https://d.example")).toEqual([
      { source: DOCS_PATH, destination: DOCS_ENTRY_PATH, permanent: false },
    ]);
  });

  it("proxies files directly and pages as their index.html", () => {
    expect(docsRewrites("https://d.example")).toEqual([
      { source: "/docs/:file(.*\\.[A-Za-z0-9]+)", destination: "https://d.example/:file" },
      { source: "/docs/:page+", destination: "https://d.example/:page+/index.html" },
    ]);
  });
});
