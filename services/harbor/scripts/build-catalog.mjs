import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { parse as parseYaml } from "yaml";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootFlag = process.argv.indexOf("--root");
if (rootFlag >= 0 && !process.argv[rootFlag + 1]) {
  throw new Error("--root requires a directory");
}
const ROOT =
  rootFlag >= 0 ? resolve(process.cwd(), process.argv[rootFlag + 1]) : SCRIPT_ROOT;
const OPS_DIR = resolve(ROOT, "src/ops");
const VENUES_DIR = resolve(ROOT, "catalog/venues");
const SKILLS_DIR = resolve(ROOT, "ecosystem-skills");
const GENERATED_OPS = resolve(OPS_DIR, "index.gen.ts");
const GENERATED_MANIFEST = resolve(ROOT, "catalog/manifest.json");

// This generator deliberately parses TypeScript instead of importing it. Op
// modules contain handlers and may eventually initialize clients; executing
// those modules during a catalog build would make generation environment-
// dependent and unsafe. The one authoring constraint is therefore explicit:
// each src/ops/*.ts module exports one inline `ops` array (optionally wrapped
// in defineOps()) and keeps catalog metadata as literals. A dynamic metadata
// value fails the build rather than silently producing a stale catalog.

async function filesIn(directory, predicate) {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && predicate(entry.name))
      .map((entry) => resolve(directory, entry.name))
      .sort();
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

function unwrap(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function opsArray(initializer) {
  const expression = unwrap(initializer);
  if (ts.isArrayLiteralExpression(expression)) return expression;
  if (
    ts.isCallExpression(expression) &&
    expression.arguments.length === 1 &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "defineOps"
  ) {
    const argument = unwrap(expression.arguments[0]);
    if (ts.isArrayLiteralExpression(argument)) return argument;
  }
  return undefined;
}

function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  throw new Error("Computed op metadata keys are not supported");
}

function propertiesOf(object, label) {
  const properties = new Map();
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error(`${label} metadata must use property assignments`);
    }
    const name = propertyName(property.name);
    if (properties.has(name)) throw new Error(`${label} has duplicate property ${name}`);
    properties.set(name, property.initializer);
  }
  return properties;
}

function literalString(expression, label) {
  const value = unwrap(expression);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    return value.text;
  }
  throw new Error(`${label} must be a string literal`);
}

function literalStrings(expression, label) {
  const value = unwrap(expression);
  if (!ts.isArrayLiteralExpression(value)) {
    throw new Error(`${label} must be an array literal`);
  }
  return value.elements.map((element, index) =>
    literalString(element, `${label}[${index}]`),
  );
}

function objectFromElement(element, label) {
  let value = unwrap(element);
  if (
    ts.isCallExpression(value) &&
    value.arguments.length === 1 &&
    ts.isIdentifier(value.expression) &&
    value.expression.text === "defineOp"
  ) {
    value = unwrap(value.arguments[0]);
  }
  if (!ts.isObjectLiteralExpression(value)) {
    throw new Error(`${label} must contain an inline op definition`);
  }
  return value;
}

function callReceiverNamed(expression, name) {
  const value = unwrap(expression);
  return (
    ts.isCallExpression(value) &&
    ts.isPropertyAccessExpression(value.expression) &&
    value.expression.name.text === name
  );
}

function zodObjectLiteral(expression) {
  let value = unwrap(expression);
  while (callReceiverNamed(value, "strict") || callReceiverNamed(value, "passthrough")) {
    value = unwrap(value.expression.expression);
  }
  if (
    !ts.isCallExpression(value) ||
    !ts.isPropertyAccessExpression(value.expression) ||
    value.expression.name.text !== "object" ||
    value.arguments.length === 0
  ) {
    return undefined;
  }
  const shape = unwrap(value.arguments[0]);
  return ts.isObjectLiteralExpression(shape) ? shape : undefined;
}

function signatureFor(name, args, returns) {
  const shape = zodObjectLiteral(args);
  if (!shape) return `${name}(args) → ${returns}`;
  const fields = shape.properties.map((property) => {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error(`${name}.args must use property assignments`);
    }
    const optional = callReceiverNamed(property.initializer, "optional");
    return `${propertyName(property.name)}${optional ? "?" : ""}`;
  });
  return `${name}(${fields.length ? `{ ${fields.join(", ")} }` : ""}) → ${returns}`;
}

function metadataFromArray(array, file) {
  return array.elements.map((element, index) => {
    const label = `${relative(ROOT, file)}[${index}]`;
    const properties = propertiesOf(objectFromElement(element, label), label);
    const allowed = new Set([
      "name",
      "family",
      "summary",
      "tags",
      "args",
      "returns",
      "caveats",
      "example",
      "handler",
    ]);
    for (const property of properties.keys()) {
      if (!allowed.has(property)) throw new Error(`${label} has unknown property ${property}`);
    }
    for (const required of [
      "name",
      "family",
      "summary",
      "args",
      "returns",
      "caveats",
      "example",
      "handler",
    ]) {
      if (!properties.has(required)) {
        throw new Error(`${label} is missing ${required}`);
      }
    }

    const name = literalString(properties.get("name"), `${label}.name`);
    const family = literalString(properties.get("family"), `${label}.family`);
    if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-zA-Z0-9-]*)+$/.test(name)) {
      throw new Error(`${label}.name is invalid`);
    }
    if (name.split(".", 1)[0] !== family) {
      throw new Error(`${label}: ${name} is not in family ${family}`);
    }
    const summary = literalString(
      properties.get("summary"),
      `${label}.summary`,
    );
    const returns = literalString(
      properties.get("returns"),
      `${label}.returns`,
    );
    const caveats = literalStrings(
      properties.get("caveats"),
      `${label}.caveats`,
    );
    const example = literalString(
      properties.get("example"),
      `${label}.example`,
    );
    const tags = properties.has("tags")
      ? literalStrings(properties.get("tags"), `${label}.tags`)
      : [];
    if (!summary.trim() || !returns.trim() || !example.trim()) {
      throw new Error(`${label} has incomplete metadata`);
    }
    const allowedCaveats = new Set([
      "no-rows",
      "unverified-match",
      "devnet-only",
      "off-ledger",
      "amendment-pending",
    ]);
    for (const caveat of caveats) {
      if (!allowedCaveats.has(caveat)) throw new Error(`${label}.caveats contains ${caveat}`);
    }
    return {
      name,
      family,
      summary,
      tags,
      returns,
      caveats,
      example,
      signature: signatureFor(name, properties.get("args"), returns),
    };
  });
}

async function discoverOps() {
  const files = await filesIn(
    OPS_DIR,
    (name) => extname(name) === ".ts" && name !== "index.gen.ts",
  );
  const modules = [];
  const metadata = [];
  const aliases = new Set();

  for (const file of files) {
    const sourceText = await readFile(file, "utf8");
    const source = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const exports = [];
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const isExported = statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      );
      if (!isExported) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "ops") continue;
        if (!(statement.declarationList.flags & ts.NodeFlags.Const)) {
          throw new Error(`${relative(ROOT, file)} export ops must be const`);
        }
        if (
          !declaration.type ||
          !ts.isArrayTypeNode(declaration.type) ||
          !ts.isTypeReferenceNode(declaration.type.elementType) ||
          !ts.isIdentifier(declaration.type.elementType.typeName) ||
          declaration.type.elementType.typeName.text !== "OpDef"
        ) {
          throw new Error(`${relative(ROOT, file)} export ops must be typed OpDef[]`);
        }
        if (!declaration.initializer) {
          throw new Error(`${relative(ROOT, file)} export ops needs an initializer`);
        }
        const array = opsArray(declaration.initializer);
        if (!array) {
          throw new Error(`${relative(ROOT, file)} export ops must be an inline array`);
        }
        exports.push(array);
      }
    }
    if (exports.length !== 1) {
      throw new Error(
        `${relative(ROOT, file)} must export exactly one inline ops array`,
      );
    }
    const stem = relative(OPS_DIR, file)
      .replace(/\\/g, "/")
      .replace(/\.ts$/, "");
    const alias = `${stem
      .split(/[^a-zA-Z0-9]+/)
      .filter(Boolean)
      .map((part, index) =>
        index === 0
          ? part.replace(/^[^a-zA-Z_$]+/, "")
          : part[0].toUpperCase() + part.slice(1),
      )
      .join("")}Ops`;
    if (!/^[$A-Z_a-z][$\w]*$/.test(alias)) {
      throw new Error(`${relative(ROOT, file)} cannot be assigned a safe import alias`);
    }
    if (aliases.has(alias)) {
      throw new Error(`${relative(ROOT, file)} produces duplicate import alias ${alias}`);
    }
    aliases.add(alias);
    modules.push({
      specifier: `./${stem}`,
      alias,
    });
    metadata.push(...metadataFromArray(exports[0], file));
  }

  const names = new Set();
  for (const op of metadata) {
    if (names.has(op.name)) throw new Error(`Duplicate operation: ${op.name}`);
    names.add(op.name);
  }
  return { modules, metadata: metadata.sort((a, b) => a.name.localeCompare(b.name)) };
}

function assertKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label} has unknown key ${key}`);
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertStringArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  value.forEach((entry, index) => assertString(entry, `${label}[${index}]`));
}

// This structural validator mirrors the fixed Venue contract. It lives here
// because importing src/contracts.ts would execute TypeScript in plain Node.
function validateVenue(value, file) {
  const label = relative(ROOT, file);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain a venue object`);
  }
  assertKeys(
    value,
    ["id", "name", "kind", "layer", "category", "status", "execution", "reads", "risks", "links"],
    label,
  );
  assertString(value.id, `${label}.id`);
  assertString(value.name, `${label}.name`);
  if (!["execution-primitive", "discovery-venue"].includes(value.kind)) {
    throw new Error(`${label}.kind is invalid`);
  }
  if (!["xrpl-l1", "xrpl-evm", "off-ledger"].includes(value.layer)) {
    throw new Error(`${label}.layer is invalid`);
  }
  assertStringArray(value.category, `${label}.category`);
  const categories = ["spot", "liquidity", "payments", "yield", "lending", "perps", "bridge", "analytics"];
  if (value.category.some((entry) => !categories.includes(entry))) {
    throw new Error(`${label}.category contains an invalid value`);
  }
  if (!value.status || typeof value.status !== "object" || Array.isArray(value.status)) {
    throw new Error(`${label}.status must be an object`);
  }
  assertKeys(value.status, ["mainnet", "testnet", "devnet", "lending-devnet"], `${label}.status`);
  const states = ["live", "voting", "devnet-only", "unavailable"];
  for (const [network, state] of Object.entries(value.status)) {
    if (!states.includes(state)) throw new Error(`${label}.status.${network} is invalid`);
  }
  if (value.execution !== undefined) {
    if (!value.execution || typeof value.execution !== "object" || Array.isArray(value.execution)) {
      throw new Error(`${label}.execution must be an object`);
    }
    assertKeys(value.execution, ["transactions", "builders"], `${label}.execution`);
    assertStringArray(value.execution.transactions, `${label}.execution.transactions`);
    assertStringArray(value.execution.builders, `${label}.execution.builders`);
  }
  assertStringArray(value.reads, `${label}.reads`);
  assertStringArray(value.risks, `${label}.risks`);
  if (!value.links || typeof value.links !== "object" || Array.isArray(value.links)) {
    throw new Error(`${label}.links must be an object`);
  }
  assertKeys(value.links, ["site", "docs", "api"], `${label}.links`);
  for (const [key, link] of Object.entries(value.links)) assertString(link, `${label}.links.${key}`);
  return value;
}

async function readVenues() {
  const files = await filesIn(VENUES_DIR, (name) => [".yaml", ".yml"].includes(extname(name)));
  const venues = [];
  const ids = new Set();
  for (const file of files) {
    const venue = validateVenue(parseYaml(await readFile(file, "utf8")), file);
    if (ids.has(venue.id)) throw new Error(`Duplicate venue: ${venue.id}`);
    ids.add(venue.id);
    venues.push(venue);
  }
  return venues.sort((a, b) => a.id.localeCompare(b.id));
}

function playbookMetadata(content, file) {
  const lines = content.split(/\r?\n/);
  const heading = lines.find((line) => /^#\s+/.test(line));
  const summary = lines.find(
    (line) => line.trim() && !line.startsWith("#") && !line.startsWith("---"),
  );
  const id = relative(resolve(SKILLS_DIR, "local"), file).replace(/\\/g, "/").replace(/\.md$/, "");
  return {
    id,
    name: heading ? heading.replace(/^#\s+/, "").trim() : id,
    summary: summary?.trim() ?? "",
    source: relative(ROOT, file).replace(/\\/g, "/"),
    content,
  };
}

async function readEcosystemSkills() {
  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(resolve(SKILLS_DIR, "MANIFEST.json"), "utf8"));
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  const playbookFiles = await filesIn(resolve(SKILLS_DIR, "local"), (name) => extname(name) === ".md");
  const playbooks = [];
  for (const file of playbookFiles) {
    playbooks.push(playbookMetadata(await readFile(file, "utf8"), file));
  }
  return { manifest, playbooks };
}

function generatedIndex(modules) {
  const imports = modules.map(
    ({ specifier, alias }) => `import { ops as ${alias} } from ${JSON.stringify(specifier)};`,
  );
  const spreads = modules.map(({ alias }) => `  ...${alias},`);
  return [
    "// Generated by scripts/build-catalog.mjs. Do not edit.",
    ...imports,
    "",
    "export const ops = [",
    ...spreads,
    "] as const;",
    "",
    "export default ops;",
    "",
  ].join("\n");
}

async function main() {
  const [{ modules, metadata: ops }, venues, ecosystemSkills] = await Promise.all([
    discoverOps(),
    readVenues(),
    readEcosystemSkills(),
  ]);
  const manifest = { version: 1, ops, venues, ecosystemSkills };

  await Promise.all([
    mkdir(OPS_DIR, { recursive: true }),
    mkdir(dirname(GENERATED_MANIFEST), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(GENERATED_OPS, generatedIndex(modules), "utf8"),
    writeFile(GENERATED_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
  ]);
  process.stdout.write(
    `Generated ${ops.length} ops, ${venues.length} venues, and ${ecosystemSkills.playbooks.length} local playbooks.\n`,
  );
}

await main();
