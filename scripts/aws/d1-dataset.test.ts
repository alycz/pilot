import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";

import {
  DATASET_URI,
  parseDatasetArgs,
  parseDatasetListing,
  publicListingUrl,
  runDatasetProbe,
} from "./d1-dataset";

const XML = `<?xml version="1.0"?>
<ListBucketResult>
  <Name>aws-public-blockchain</Name>
  <Prefix>v1.1/sonarx/xrp/</Prefix>
  <KeyCount>2</KeyCount>
  <MaxKeys>100</MaxKeys>
  <IsTruncated>false</IsTruncated>
  <Contents><Key>v1.1/sonarx/xrp/manifest.json</Key><Size>42</Size></Contents>
  <CommonPrefixes><Prefix>v1.1/sonarx/xrp/transactions/</Prefix></CommonPrefixes>
</ListBucketResult>`;

function response(xml = XML) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({
      "content-length": String(Buffer.byteLength(xml)),
      "content-type": "application/xml",
    }),
    text: vi.fn(async () => xml),
  };
}

describe("AWS-6 anonymous dataset probe", () => {
  it("defaults to the stand-in and gates the real anonymous read explicitly", () => {
    expect(parseDatasetArgs([])).toEqual({ mode: "standin", confirmAnonymousRead: false });
    expect(parseDatasetArgs(["--mode", "event", "--confirm-anonymous-read"])).toEqual({
      mode: "event",
      confirmAnonymousRead: true,
    });
    expect(() => parseDatasetArgs(["--mode=event"])).toThrow(/confirm-anonymous-read/);
    expect(() => parseDatasetArgs(["--confirm-anonymous-read"])).toThrow(/only in event mode/);
    expect(() => parseDatasetArgs(["--aws-access-key", "fixture"])).toThrow(/Unsupported argument/);
    expect(() => parseDatasetArgs(["--status", "evidence.md"])).toThrow(/directly inside status/);
    expect(() => parseDatasetArgs(["--status", "../status/outside.md"]))
      .toThrow(/directly inside status/);
  });

  it("parses only the exact approved bucket and bounded prefix", () => {
    expect(parseDatasetListing(XML)).toEqual({
      bucket: "aws-public-blockchain",
      prefix: "v1.1/sonarx/xrp/",
      keyCount: 2,
      maxKeys: 100,
      truncated: false,
      objects: [{ key: "v1.1/sonarx/xrp/manifest.json", size: 42 }],
      commonPrefixes: ["v1.1/sonarx/xrp/transactions/"],
    });
    expect(() => parseDatasetListing(XML.replace("aws-public-blockchain", "other-bucket")))
      .toThrow(/approved bucket and prefix/);
    expect(() => parseDatasetListing(XML.replace("v1.1/sonarx/xrp/manifest.json", "other/prefix")))
      .toThrow(/invalid object key/);
    expect(() => parseDatasetListing(XML.replace("<IsTruncated>false", "<IsTruncated>maybe")))
      .toThrow();
    expect(() => parseDatasetListing(XML
      .replace(/<Contents>[\s\S]*?<\/Contents>/, "")
      .replace(/<CommonPrefixes>[\s\S]*?<\/CommonPrefixes>/, "")))
      .toThrow(/no XRP dataset entries/);
  });

  it("runs stand-in mode without a network transport or AWS-7 live claim", async () => {
    const fetcher = vi.fn();
    const log = vi.fn();
    const listing = await runDatasetProbe(
      { mode: "standin", confirmAnonymousRead: false },
      { fetch: fetcher, log },
    );

    expect(fetcher).not.toHaveBeenCalled();
    expect(listing.objects).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(`PASS d1-dataset mode=standin uri=${DATASET_URI}`);
  });

  it("uses one unsigned, credential-free GET to the hard-allowlisted event endpoint", async () => {
    const fetcher = vi.fn(async (_input: string | URL, _init?: RequestInit) => response());
    const listing = await runDatasetProbe(
      { mode: "event", confirmAnonymousRead: true },
      { fetch: fetcher, log: vi.fn() },
    );

    expect(listing.keyCount).toBe(2);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe(publicListingUrl().toString());
    expect(init).toEqual({
      method: "GET",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { accept: "application/xml" },
    });
    expect(JSON.stringify(init)).not.toMatch(/authorization|cookie|credential=/i);
  });

  it("enforces event confirmation inside the exported action before any fetch", async () => {
    const fetcher = vi.fn(async () => response());

    await expect(runDatasetProbe(
      { mode: "event", confirmAnonymousRead: false },
      { fetch: fetcher, log: vi.fn() },
    )).rejects.toThrow(/confirm-anonymous-read/);
    await expect(runDatasetProbe(
      { mode: "standin", confirmAnonymousRead: true },
      { fetch: fetcher, log: vi.fn() },
    )).rejects.toThrow(/only in event mode/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("writes only bounded anonymous metadata to an explicit status path", async () => {
    const writeStatus = vi.fn(async () => undefined);
    await runDatasetProbe(
      {
        mode: "standin",
        confirmAnonymousRead: false,
        statusPath: "status/P-aws.md",
      },
      {
        writeStatus,
        now: () => new Date("2026-10-21T20:30:00.000Z"),
        log: vi.fn(),
      },
    );

    expect(writeStatus).toHaveBeenCalledWith(
      resolve("status/P-aws.md"),
      "| 2026-10-21T20:30:00.000Z | AWS-6 d1-dataset | pass | mode=standin; synthetic=true; bucket=aws-public-blockchain; prefix=v1.1/sonarx/xrp/; objects=1; common_prefixes=1; truncated=false |\n",
    );
  });

  it("fails closed on oversized or unsuccessful responses without consuming bodies", async () => {
    const body = vi.fn(async () => XML);
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({
        "content-length": "1048577",
        "content-type": "application/xml",
      }),
      text: body,
    }));
    await expect(runDatasetProbe(
      { mode: "event", confirmAnonymousRead: true },
      { fetch: fetcher, log: vi.fn() },
    )).rejects.toThrow(/content length/);
    expect(body).not.toHaveBeenCalled();

    await expect(runDatasetProbe(
      { mode: "event", confirmAnonymousRead: true },
      {
        fetch: vi.fn(async () => ({ ...response(), ok: false, status: 403 })),
        log: vi.fn(),
      },
    )).rejects.toThrow(/HTTP 403/);
  });
});
