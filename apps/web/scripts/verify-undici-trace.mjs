import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_UNDICI_VERSION = "6.29.1";
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tracePath = resolve(webRoot, ".next/server/app/api/chat/route.js.nft.json");
const traceDirectory = dirname(tracePath);

const trace = JSON.parse(await readFile(tracePath, "utf8"));
if (!Array.isArray(trace.files)) {
  throw new Error(`Invalid Next output trace: ${tracePath}`);
}

const tracedFiles = trace.files.map((file) => resolve(traceDirectory, file));
const packageSuffix = `${sep}node_modules${sep}undici${sep}package.json`;
const tracedPackages = tracedFiles.filter((file) => file.endsWith(packageSuffix));
if (tracedPackages.length === 0) {
  throw new Error("The /api/chat output trace does not include undici/package.json");
}

const requireFromRoute = createRequire(resolve(traceDirectory, "route.js"));
const resolvedPackagePath = requireFromRoute.resolve("undici/package.json");
const resolvedPackage = JSON.parse(await readFile(resolvedPackagePath, "utf8"));
if (resolvedPackage.version !== EXPECTED_UNDICI_VERSION) {
  throw new Error(
    `The /api/chat runtime resolves undici ${String(resolvedPackage.version)}, expected ${EXPECTED_UNDICI_VERSION}`,
  );
}

const tracedVersions = await Promise.all(tracedPackages.map(async (packagePath) => {
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  return packageJson.version;
}));
const expectedIndex = tracedVersions.indexOf(EXPECTED_UNDICI_VERSION);
if (expectedIndex === -1) {
  throw new Error(
    `The /api/chat trace does not contain undici ${EXPECTED_UNDICI_VERSION}; found ${tracedVersions.join(", ")}`,
  );
}

const tracedRuntimeRoot = dirname(tracedPackages[expectedIndex]);
const tracedRuntimeFiles = tracedFiles.filter(
  (file) => file.startsWith(`${tracedRuntimeRoot}${sep}`) && file !== resolve(tracedRuntimeRoot, "package.json"),
);
if (tracedRuntimeFiles.length === 0) {
  throw new Error("The /api/chat trace contains the Undici manifest but no runtime files");
}

console.log(
  `Verified /api/chat trace contains and resolves undici ${EXPECTED_UNDICI_VERSION} (${relative(webRoot, tracedRuntimeRoot)})`,
);
