import { appendFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DATASET_URI = "s3://aws-public-blockchain/v1.1/sonarx/xrp/";

const BUCKET = "aws-public-blockchain";
const PREFIX = "v1.1/sonarx/xrp/";
const PUBLIC_BUCKET_HOST = `${BUCKET}.s3.amazonaws.com`;
const MAX_KEYS = 100;
const MAX_RESPONSE_BYTES = 1_048_576;

const STANDIN_LISTING = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>aws-public-blockchain</Name>
  <Prefix>v1.1/sonarx/xrp/</Prefix>
  <KeyCount>2</KeyCount>
  <MaxKeys>100</MaxKeys>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>v1.1/sonarx/xrp/standin-manifest.json</Key>
    <Size>256</Size>
  </Contents>
  <CommonPrefixes><Prefix>v1.1/sonarx/xrp/transactions/</Prefix></CommonPrefixes>
</ListBucketResult>`;

export type DatasetMode = "standin" | "event";

export type DatasetArgs = {
  mode: DatasetMode;
  confirmAnonymousRead: boolean;
  statusPath?: string;
};

export type DatasetObject = {
  key: string;
  size: number;
};

export type DatasetListing = {
  bucket: typeof BUCKET;
  prefix: typeof PREFIX;
  keyCount: number;
  maxKeys: number;
  truncated: boolean;
  objects: DatasetObject[];
  commonPrefixes: string[];
};

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "headers" | "text">>;

export type DatasetDependencies = {
  fetch?: FetchLike;
  now?: () => Date;
  writeStatus?: (path: string, line: string) => Promise<void>;
  log?: (line: string) => void;
};

function checkedStatusPath(statusPath: string): string {
  if (isAbsolute(statusPath)) {
    throw new Error("--status must name a markdown file directly inside status/");
  }
  const statusRoot = resolve(process.cwd(), "status");
  const target = resolve(process.cwd(), statusPath);
  const child = relative(statusRoot, target);
  if (
    !child || child.startsWith("..") || isAbsolute(child) ||
    child.includes("/") || child.includes("\\") || !child.endsWith(".md")
  ) {
    throw new Error("--status must name a markdown file directly inside status/");
  }
  return target;
}

function valueAfter(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

export function parseDatasetArgs(argv: readonly string[]): DatasetArgs {
  let mode: DatasetMode = "standin";
  let confirmAnonymousRead = false;
  let statusPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode") {
      const value = valueAfter(argv, index, "--mode");
      index += 1;
      if (value !== "standin" && value !== "event") {
        throw new Error("--mode must be standin or event");
      }
      mode = value;
      continue;
    }
    if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length);
      if (value !== "standin" && value !== "event") {
        throw new Error("--mode must be standin or event");
      }
      mode = value;
      continue;
    }
    if (arg === "--confirm-anonymous-read") {
      confirmAnonymousRead = true;
      continue;
    }
    if (arg === "--status") {
      statusPath = valueAfter(argv, index, "--status");
      index += 1;
      continue;
    }
    if (arg.startsWith("--status=")) {
      statusPath = arg.slice("--status=".length);
      if (!statusPath) throw new Error("--status requires a value");
      continue;
    }
    throw new Error(`Unsupported argument: ${arg}`);
  }

  if (mode === "event" && !confirmAnonymousRead) {
    throw new Error("Event mode requires --confirm-anonymous-read");
  }
  if (mode === "standin" && confirmAnonymousRead) {
    throw new Error("--confirm-anonymous-read is valid only in event mode");
  }
  if (statusPath !== undefined) {
    statusPath = checkedStatusPath(statusPath);
  }
  return { mode, confirmAnonymousRead, ...(statusPath ? { statusPath } : {}) };
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function oneTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!match) throw new Error(`Public dataset listing is missing ${tag}`);
  return decodeXml(match[1].trim());
}

function tags(xml: string, tag: string): string[] {
  return Array.from(xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g")), (match) =>
    decodeXml(match[1].trim()),
  );
}

function boundedDatasetPath(value: string, field: string): string {
  if (
    value.length <= PREFIX.length ||
    value.length > 1_024 ||
    !value.startsWith(PREFIX) ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`Public dataset listing contains an invalid ${field}`);
  }
  return value;
}

function boundedInteger(value: string, field: string, maximum: number): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`Public dataset listing contains an invalid ${field}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`Public dataset listing contains an invalid ${field}`);
  }
  return parsed;
}

export function parseDatasetListing(xml: string): DatasetListing {
  if (Buffer.byteLength(xml, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("Public dataset listing exceeds the response limit");
  }
  if (oneTag(xml, "Name") !== BUCKET || oneTag(xml, "Prefix") !== PREFIX) {
    throw new Error("Public dataset listing does not match the approved bucket and prefix");
  }
  const contents = tags(xml, "Contents");
  const commonPrefixBlocks = tags(xml, "CommonPrefixes");
  if (contents.length > MAX_KEYS || commonPrefixBlocks.length > MAX_KEYS) {
    throw new Error("Public dataset listing exceeds the item limit");
  }
  const objects = contents.map((entry) => ({
    key: boundedDatasetPath(oneTag(entry, "Key"), "object key"),
    size: boundedInteger(oneTag(entry, "Size"), "object size", Number.MAX_SAFE_INTEGER),
  }));
  const commonPrefixes = commonPrefixBlocks.map((entry) =>
    boundedDatasetPath(oneTag(entry, "Prefix"), "common prefix"),
  );
  if (objects.length === 0 && commonPrefixes.length === 0) {
    throw new Error("Public dataset listing contains no XRP dataset entries");
  }
  return {
    bucket: BUCKET,
    prefix: PREFIX,
    keyCount: boundedInteger(oneTag(xml, "KeyCount"), "key count", MAX_KEYS),
    maxKeys: boundedInteger(oneTag(xml, "MaxKeys"), "max keys", MAX_KEYS),
    truncated: oneTag(xml, "IsTruncated") === "true"
      ? true
      : oneTag(xml, "IsTruncated") === "false"
        ? false
        : (() => { throw new Error("Public dataset listing contains an invalid truncation flag"); })(),
    objects,
    commonPrefixes,
  };
}

export function publicListingUrl(): URL {
  const url = new URL(`https://${PUBLIC_BUCKET_HOST}/`);
  url.searchParams.set("list-type", "2");
  url.searchParams.set("prefix", PREFIX);
  url.searchParams.set("delimiter", "/");
  url.searchParams.set("max-keys", String(MAX_KEYS));
  return url;
}

async function eventListing(fetcher: FetchLike): Promise<string> {
  const url = publicListingUrl();
  if (url.protocol !== "https:" || url.hostname !== PUBLIC_BUCKET_HOST || url.pathname !== "/") {
    throw new Error("Public dataset endpoint is outside the approved anonymous read boundary");
  }
  const response = await fetcher(url, {
    method: "GET",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    headers: { accept: "application/xml" },
  });
  if (!response.ok) {
    throw new Error(`Public dataset listing failed with HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/xml" && contentType !== "text/xml") {
    throw new Error("Public dataset listing returned an unexpected content type");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && boundedInteger(declaredLength, "content length", MAX_RESPONSE_BYTES) > MAX_RESPONSE_BYTES) {
    throw new Error("Public dataset listing exceeds the response limit");
  }
  const xml = await response.text();
  if (Buffer.byteLength(xml, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("Public dataset listing exceeds the response limit");
  }
  return xml;
}

function evidenceLine(mode: DatasetMode, listing: DatasetListing, now: Date): string {
  const lane = mode === "standin" ? "synthetic=true" : "anonymous=true";
  return `| ${now.toISOString()} | AWS-6 d1-dataset | pass | mode=${mode}; ${lane}; bucket=${listing.bucket}; prefix=${listing.prefix}; objects=${listing.objects.length}; common_prefixes=${listing.commonPrefixes.length}; truncated=${listing.truncated} |\n`;
}

export async function runDatasetProbe(
  args: DatasetArgs,
  dependencies: DatasetDependencies = {},
): Promise<DatasetListing> {
  if (args.mode === "event" && !args.confirmAnonymousRead) {
    throw new Error("Event mode requires --confirm-anonymous-read");
  }
  if (args.mode === "standin" && args.confirmAnonymousRead) {
    throw new Error("--confirm-anonymous-read is valid only in event mode");
  }
  const xml = args.mode === "standin"
    ? STANDIN_LISTING
    : await eventListing(dependencies.fetch ?? fetch);
  const listing = parseDatasetListing(xml);
  const log = dependencies.log ?? console.log;
  log(`PASS d1-dataset mode=${args.mode} uri=${DATASET_URI}`);
  log(`objects=${listing.objects.length} common_prefixes=${listing.commonPrefixes.length} truncated=${listing.truncated}`);
  if (args.statusPath) {
    const writer = dependencies.writeStatus ?? (async (path, line) => appendFile(path, line, "utf8"));
    await writer(
      checkedStatusPath(relative(process.cwd(), args.statusPath)),
      evidenceLine(args.mode, listing, (dependencies.now ?? (() => new Date()))()),
    );
  }
  return listing;
}

async function main(): Promise<void> {
  try {
    await runDatasetProbe(parseDatasetArgs(process.argv.slice(2)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Public dataset probe failed";
    console.error(`FAIL d1-dataset: ${message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
