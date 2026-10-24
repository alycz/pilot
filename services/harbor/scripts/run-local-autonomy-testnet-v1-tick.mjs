#!/usr/bin/env node

import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isValidClassicAddress } from "xrpl";

import {
	LOCAL_AUTONOMY_TESTNET_V1_ORIGIN,
	LOCAL_AUTONOMY_TESTNET_V1_SCHEDULED_URL,
	LOCAL_AUTONOMY_TESTNET_V1_STATE_ROOT,
	ensureAutonomyStateDirectory,
	validateAutonomySecretFile,
} from "./dev-local-autonomy-testnet-v1.mjs";

const MAX_RESPONSE_BYTES = 1_048_576;
const EVIDENCE_DIRECTORY = join(LOCAL_AUTONOMY_TESTNET_V1_STATE_ROOT, "evidence");
const SENSITIVE_FIELD = /(?:authorization|credential|mnemonic|passphrase|private|secret|seed|signature|token|tx_blob|(?:^|_)key(?:$|_))/i;

export function parseTickArguments(args) {
	if (args.some((argument) => /^(?:--?)?(?:deploy|publish|remote|tunnel)(?:$|[=:-])/i.test(argument))) {
		throw new Error("Autonomy tick evidence harness is local-only");
	}
	const values = Object.create(null);
	for (const argument of args) {
		const match = /^--(acceptance-id|owner|strategy-id)=(.+)$/.exec(argument);
		if (!match || Object.prototype.hasOwnProperty.call(values, match[1])) {
			throw new Error("Autonomy tick evidence arguments are invalid");
		}
		values[match[1]] = match[2];
	}
	if (
		Object.keys(values).length !== 3 ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(values["acceptance-id"] ?? "") ||
		!isValidClassicAddress(values.owner ?? "") ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(values["strategy-id"] ?? "")
	) throw new Error("Autonomy tick evidence arguments are invalid");
	return {
		acceptanceId: values["acceptance-id"],
		owner: values.owner,
		strategyId: values["strategy-id"],
	};
}

export function scrubEvidence(value, sensitiveValues = []) {
	if (typeof value === "string") {
		return sensitiveValues.some((secret) => typeof secret === "string" && secret.length > 0 && value.includes(secret))
			? "[REDACTED]"
			: value;
	}
	if (Array.isArray(value)) return value.map((item) => scrubEvidence(item, sensitiveValues));
	if (typeof value !== "object" || value === null) return value;
	const sanitized = {};
	for (const [key, item] of Object.entries(value)) {
		if (SENSITIVE_FIELD.test(key)) continue;
		sanitized[key] = scrubEvidence(item, sensitiveValues);
	}
	return sanitized;
}

async function boundedResponse(response) {
	const contentLength = Number(response.headers.get("content-length") ?? "0");
	if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
		throw new Error("Autonomy tick response exceeded the evidence bound");
	}
	const text = await response.text();
	if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
		throw new Error("Autonomy tick response exceeded the evidence bound");
	}
	let body = text;
	try {
		body = JSON.parse(text);
	} catch {
		// Wrangler's local scheduled endpoint may return bounded plain text.
	}
	return { status: response.status, body };
}

async function invokeOperation(fetchImpl, authorization, name, args) {
	return boundedResponse(await fetchImpl(`${LOCAL_AUTONOMY_TESTNET_V1_ORIGIN}/api/ops/${name}`, {
		method: "POST",
		redirect: "error",
		headers: {
			authorization: `Bearer ${authorization}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(args),
		signal: AbortSignal.timeout(15_000),
	}));
}

export async function collectTickEvidence(
	options,
	{
		fetchImpl = globalThis.fetch,
		readCredentials = validateAutonomySecretFile,
		now = () => new Date(),
	} = {},
) {
	const credentials = await readCredentials();
	const authorization = credentials.HARBOR_API_KEYS;
	const scoped = {
		strategy_id: options.strategyId,
		owner: options.owner,
		network: "testnet",
	};
	const before = {
		strategy: await invokeOperation(fetchImpl, authorization, "strategy.get", scoped),
		audit: await invokeOperation(fetchImpl, authorization, "strategy.audit", { ...scoped, limit: 200 }),
		account: await invokeOperation(fetchImpl, authorization, "account.status", {
			owner: options.owner,
			network: "testnet",
		}),
	};
	const scheduled = await boundedResponse(await fetchImpl(LOCAL_AUTONOMY_TESTNET_V1_SCHEDULED_URL, {
		method: "GET",
		redirect: "error",
		signal: AbortSignal.timeout(30_000),
	}));
	const after = {
		strategy: await invokeOperation(fetchImpl, authorization, "strategy.get", scoped),
		audit: await invokeOperation(fetchImpl, authorization, "strategy.audit", { ...scoped, limit: 200 }),
		account: await invokeOperation(fetchImpl, authorization, "account.status", {
			owner: options.owner,
			network: "testnet",
		}),
	};
	const raw = {
		schema: "harbor.local-autonomy-testnet.tick-evidence.v1",
		acceptance_id: options.acceptanceId,
		captured_at: now().toISOString(),
		profile: {
			origin: LOCAL_AUTONOMY_TESTNET_V1_ORIGIN,
			network: "testnet",
			mainnet: false,
			scheduled_path: "/__scheduled",
		},
		scope: { owner: options.owner, strategy_id: options.strategyId },
		before,
		scheduled,
		after,
	};
	return scrubEvidence(raw, [authorization, credentials.HARBOR_KEK]);
}

export async function ensureEvidenceDirectory(
	{
		statPath = lstat,
		realPath = realpath,
		makeDirectory = mkdir,
	} = {},
) {
	try {
		const metadata = await statPath(EVIDENCE_DIRECTORY);
		if (
			metadata.isSymbolicLink() || !metadata.isDirectory() ||
			(await realPath(EVIDENCE_DIRECTORY)) !== EVIDENCE_DIRECTORY ||
			(metadata.mode & 0o777) !== 0o700 ||
			(typeof process.getuid === "function" && metadata.uid !== process.getuid())
		) throw new Error();
	} catch (error) {
		if (error?.code !== "ENOENT") throw new Error("Autonomy evidence directory is unsafe");
		await makeDirectory(EVIDENCE_DIRECTORY, { mode: 0o700 });
	}
}

export async function main(
	args = process.argv.slice(2),
	{
		collect = collectTickEvidence,
		ensureState = ensureAutonomyStateDirectory,
		ensureEvidence = ensureEvidenceDirectory,
		writeEvidence = writeFile,
	} = {},
) {
	const options = parseTickArguments(args);
	await ensureState();
	await ensureEvidence();
	const evidence = await collect(options);
	const target = join(EVIDENCE_DIRECTORY, `${options.acceptanceId}.json`);
	await writeEvidence(target, `${JSON.stringify(evidence, null, 2)}\n`, {
		encoding: "utf8", flag: "wx", mode: 0o600,
	});
	console.log(`Autonomy tick evidence written: ${target}`);
}

export function runCli() {
	main().catch((error) => {
		console.error(`harbor-local-autonomy-testnet-v1-tick: ${error instanceof Error ? error.message : "capture failed"}`);
		process.exitCode = 1;
	});
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) runCli();
