#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = "integrity/manifest.json";
const manifestBytes = readFileSync(join(root, manifestPath));
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const requiredPaths = [".github/workflows/ci.yml",".github/workflows/harbor-ci.yml","AGENTS.md","apps/web/package.json","services/harbor/package.json","services/harbor/wrangler.jsonc","packages/contracts/CONTRACT_HASH","integrity/manifest.json","scripts/integrity/verify.mjs"];
const git = (args, encoding = "utf8") => execFileSync("git", args, {
  cwd: root, encoding, env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", TMPDIR: process.env.TMPDIR ?? "/tmp", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" }, maxBuffer: 256 * 1024 * 1024,
});
const fail = (message) => { throw new Error(message); };
if (manifest.schemaVersion !== 1 || manifest.digestAlgorithm !== "sha256-exact-blob-v1") fail("unsupported integrity manifest");
if (!Number.isSafeInteger(manifest.trackedPathCount) || manifest.trackedPathCount < 1) fail("invalid tracked path count");
if (!/^[a-f0-9]{64}$/.test(manifest.treeSha256)) fail("invalid tree digest");
if (JSON.stringify(manifest.digestExcludes) !== JSON.stringify([manifestPath])) fail("invalid digest exclusion");
if (JSON.stringify(manifest.requiredPaths) !== JSON.stringify(requiredPaths)) fail("invalid required path inventory");
if (new Set(requiredPaths).size !== requiredPaths.length || requiredPaths.some((path) => path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === ".."))) fail("unsafe or duplicate required path inventory");
const canonicalManifest = Buffer.from(`${JSON.stringify({ schemaVersion: manifest.schemaVersion, digestAlgorithm: manifest.digestAlgorithm, trackedPathCount: manifest.trackedPathCount, treeSha256: manifest.treeSha256, digestExcludes: manifest.digestExcludes, requiredPaths: manifest.requiredPaths }, null, 2)}
`);
if (!manifestBytes.equals(canonicalManifest)) fail("integrity manifest is not canonical");
const records = git(["ls-tree", "-r", "-z", "--full-tree", "HEAD"], "buffer").toString("utf8").split("\0").filter(Boolean).map((record) => {
  const match = /^(100644|100755) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
  if (!match) fail(`unsupported committed tree entry: ${record}`);
  const path = match[3];
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) fail(`unsafe committed path: ${path}`);
  return { mode: match[1], oid: match[2], path };
});
if (records.length !== manifest.trackedPathCount) fail("tracked path count mismatch");
const folded = new Set();
for (const record of records) {
  const key = record.path.normalize("NFC").toLocaleLowerCase("en-US");
  if (folded.has(key)) fail(`case/Unicode path collision: ${record.path}`);
  folded.add(key);
}
for (const required of requiredPaths) if (!records.some((record) => record.path === required)) fail(`missing required path: ${required}`);
const digest = createHash("sha256");
digest.update("pilot-integrity-v1\0");
for (const record of records.filter((entry) => entry.path !== manifestPath).sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)))) {
  const bytes = git(["cat-file", "blob", record.oid], "buffer");
  const blobSha256 = createHash("sha256").update(bytes).digest("hex");
  digest.update(record.mode); digest.update("\0"); digest.update(String(Buffer.byteLength(record.path))); digest.update("\0"); digest.update(record.path); digest.update("\0"); digest.update(String(bytes.length)); digest.update("\0"); digest.update(blobSha256); digest.update("\n");
}
if (digest.digest("hex") !== manifest.treeSha256) fail("committed tree digest mismatch");
process.stdout.write("verified committed application integrity\n");
