#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FREE_QUICKJS_PROFILE = "free-quickjs";

function fail(message) {
	throw new Error(`deployment config: ${message}`);
}

function resourceName(value, label) {
	if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(value ?? "")) {
		fail(`${label} must be an explicit Cloudflare resource name`);
	}
	if (value.startsWith("replace-with-") || value.endsWith("-disabled")) {
		fail(`${label} still contains a placeholder`);
	}
	return value;
}

function databaseId(value) {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value ?? "")) {
		fail("database id must be an explicit D1 UUID");
	}
	if (/^(0+|f+)-/i.test(value)) fail("database id still contains a placeholder");
	return value;
}

function publicOrigin(value) {
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		fail("origin must be an explicit HTTPS origin");
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		parsed.port ||
		parsed.pathname !== "/" ||
		parsed.search ||
		parsed.hash ||
		parsed.hostname.endsWith(".invalid")
	) {
		fail("origin must be a normalized HTTPS origin without credentials, port, path, query, fragment, or placeholder host");
	}
	return parsed.origin;
}

export function buildFreeQuickJsConfig(input) {
	const workerName = resourceName(input.workerName, "worker name");
	const d1Name = resourceName(input.databaseName, "database name");
	const d1Id = databaseId(input.databaseId);
	const origin = publicOrigin(input.origin);
	const hostname = new URL(origin).hostname;

	return {
		$schema: "node_modules/wrangler/config-schema.json",
		name: workerName,
		main: "src/server.ts",
		workers_dev: false,
		routes: [{ pattern: hostname, custom_domain: true }],
		compatibility_date: "2026-10-06",
		compatibility_flags: ["nodejs_compat"],
		d1_databases: [
			{ binding: "DB", database_name: d1Name, database_id: d1Id },
		],
		triggers: { crons: [] },
		observability: { enabled: false },
		upload_source_maps: false,
		vars: {
			HARBOR_SOURCE_TAG: "2610240",
			HARBOR_PUBLIC_URL: origin,
			EXEC_NETWORK: "testnet",
			MAINNET_EXECUTION: "false",
			EXECUTOR: "quickjs",
			HARBOR_MCP_EXECUTION_ENABLED: "false",
			AUTONOMOUS_STRATEGY_RUNNER: "false",
			QN_MODE: "off",
			MASTERCARD_MCP_ENABLED: "false",
			KMS_MODE: "off",
			AP4M_DEMO_ENABLED: "false",
			HARBOR_DEMO_QUOTA_ENABLED: "0",
		},
	};
}

function parseArguments(argv) {
	const values = {};
	for (let index = 0; index < argv.length; index += 1) {
		const name = argv[index];
		if (!name.startsWith("--") || index + 1 >= argv.length) fail(`unexpected argument: ${name}`);
		if (Object.hasOwn(values, name)) fail(`duplicate argument: ${name}`);
		values[name] = argv[index + 1];
		index += 1;
	}
	const allowed = new Set([
		"--profile",
		"--worker-name",
		"--database-name",
		"--database-id",
		"--origin",
		"--output",
	]);
	for (const name of Object.keys(values)) if (!allowed.has(name)) fail(`unexpected argument: ${name}`);
	for (const name of allowed) if (!values[name]) fail(`missing ${name}`);
	if (values["--profile"] !== FREE_QUICKJS_PROFILE) fail(`profile must be ${FREE_QUICKJS_PROFILE}`);
	return values;
}

export function writeFreeQuickJsConfig(argv) {
	const values = parseArguments(argv);
	const output = resolve(values["--output"]);
	const serviceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
	for (const protectedPath of ["wrangler.jsonc", "wrangler.free-quickjs.jsonc"]) {
		if (output === resolve(serviceRoot, protectedPath)) fail(`refusing to overwrite ${protectedPath}`);
	}
	const config = buildFreeQuickJsConfig({
		workerName: values["--worker-name"],
		databaseName: values["--database-name"],
		databaseId: values["--database-id"],
		origin: values["--origin"],
	});
	writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o644 });
	return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const output = writeFreeQuickJsConfig(process.argv.slice(2));
		process.stdout.write(`wrote local Free/QuickJS config: ${output}\n`);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
