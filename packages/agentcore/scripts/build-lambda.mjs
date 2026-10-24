import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build, version as esbuildVersion } from "esbuild";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(packageRoot, "dist/lambda");
const outputFile = resolve(outputDirectory, "lambda-entry.mjs");
const noticesFile = resolve(outputDirectory, "THIRD_PARTY_NOTICES.txt");

await rm(outputDirectory, { force: true, recursive: true });
await mkdir(outputDirectory, { recursive: true });
const buildResult = await build({
  bundle: true,
  charset: "ascii",
  entryPoints: [resolve(packageRoot, "src/lambda-entry.ts")],
  format: "esm",
  legalComments: "eof",
  logLevel: "warning",
  metafile: true,
  minify: false,
  outfile: outputFile,
  platform: "node",
  sourcemap: false,
  target: "node22",
  treeShaking: true,
});

const bundledPackages = [...new Set(Object.keys(buildResult.metafile.inputs).flatMap((input) => {
  const match = input.match(/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/u);
  return match?.[1] ? [match[1]] : [];
}))].sort();
if (JSON.stringify(bundledPackages) !== JSON.stringify(["zod"])) {
  throw new Error(`Review third-party notices for changed Lambda dependencies: ${bundledPackages.join(", ")}`);
}

const zodRoot = resolve(packageRoot, "node_modules/zod");
const zodPackage = JSON.parse(await readFile(resolve(zodRoot, "package.json"), "utf8"));
if (zodPackage.name !== "zod" || typeof zodPackage.version !== "string" || zodPackage.license !== "MIT") {
  throw new Error("The reviewed Zod notice metadata changed");
}
const zodLicense = await readFile(resolve(zodRoot, "LICENSE"), "utf8");
const notices = [
  "Pilot AgentCore Lambda third-party notices",
  "",
  `Package: zod ${zodPackage.version}`,
  "License: MIT",
  "Source: https://github.com/colinhacks/zod",
  "",
  zodLicense.trim(),
  "",
].join("\n");
await writeFile(noticesFile, notices, { encoding: "utf8", mode: 0o644 });

const bundle = await readFile(outputFile);
const noticeBytes = new TextEncoder().encode(notices);
const manifest = {
  artifactFormat: "pilot-agentcore-lambda-v1",
  bundledPackages: [{ license: "MIT", name: "zod", version: zodPackage.version }],
  bytes: bundle.byteLength,
  esbuildVersion,
  entrypoint: "lambda-entry.mjs",
  handler: "lambda-entry.handler",
  nodeTarget: "node22",
  sha256: createHash("sha256").update(bundle).digest("hex"),
  thirdPartyNotices: {
    bytes: noticeBytes.byteLength,
    entrypoint: "THIRD_PARTY_NOTICES.txt",
    sha256: createHash("sha256").update(noticeBytes).digest("hex"),
  },
};
await writeFile(
  resolve(outputDirectory, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { encoding: "utf8", mode: 0o644 },
);

process.stdout.write(`${JSON.stringify(manifest)}\n`);
