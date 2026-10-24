#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serviceRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: serviceRoot, encoding: "utf8" }).trim();
const manifestPath = "services/harbor/integrity/manifest.json";
const manifestBytes = execFileSync("git", ["show", `HEAD:${manifestPath}`], { cwd: repositoryRoot });
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const requiredPaths = ["services/harbor/.node-version","services/harbor/package.json","services/harbor/package-lock.json","services/harbor/src/contracts.ts","services/harbor/wrangler.jsonc","services/harbor/integrity/manifest.json","services/harbor/scripts/integrity/verify.mjs","services/harbor/status/.gitignore"];
const canonical = Buffer.from(`${JSON.stringify({ schemaVersion: manifest.schemaVersion, digestAlgorithm: manifest.digestAlgorithm, servicePrefix: manifest.servicePrefix, trackedPathCount: manifest.trackedPathCount, treeSha256: manifest.treeSha256, digestExcludes: manifest.digestExcludes, requiredPaths: manifest.requiredPaths }, null, 2)}
`);
if (!manifestBytes.equals(canonical)) throw new Error("execution integrity manifest is not canonical");
if (manifest.schemaVersion !== 1 || manifest.digestAlgorithm !== "sha256-exact-service-subtree-v1" || manifest.servicePrefix !== "services/harbor/") throw new Error("invalid execution integrity manifest contract");
if (JSON.stringify(manifest.digestExcludes) !== JSON.stringify([manifestPath]) || JSON.stringify(manifest.requiredPaths) !== JSON.stringify(requiredPaths)) throw new Error("invalid execution integrity inventory");
if (new Set(requiredPaths).size !== requiredPaths.length || requiredPaths.some((path) => !path.startsWith("services/harbor/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === ".."))) throw new Error("unsafe execution integrity required path");

const raw = execFileSync("git", ["ls-tree", "-r", "-z", "--full-tree", "HEAD", "services/harbor"], { cwd: repositoryRoot });
const records = raw.toString("utf8").split("\0").filter(Boolean).map((record) => {
  const match = /^(100644|100755) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
  if (!match) throw new Error(`unsupported execution tree entry: ${record}`);
  return { mode: match[1], oid: match[2], destinationPath: match[3] };
});
for (const required of requiredPaths) if (!records.some((entry) => entry.destinationPath === required)) throw new Error(`missing execution integrity path: ${required}`);
const included = records.filter((entry) => entry.destinationPath !== manifestPath).map((entry) => ({ ...entry, targetBytes: execFileSync("git", ["cat-file", "blob", entry.oid], { cwd: repositoryRoot }) }));
const digest = createHash("sha256");
digest.update("pilot-execution-service-tree-v1\0");
for (const entry of included.sort((a, b) => a.destinationPath.localeCompare(b.destinationPath))) {
  digest.update(entry.mode); digest.update("\0"); digest.update(entry.destinationPath); digest.update("\0");
  digest.update(String(entry.targetBytes.length)); digest.update("\0"); digest.update(entry.targetBytes); digest.update("\0");
}
if (records.length !== manifest.trackedPathCount || digest.digest("hex") !== manifest.treeSha256) throw new Error("committed execution-service integrity mismatch");
process.stdout.write("verified committed execution-service integrity\n");
