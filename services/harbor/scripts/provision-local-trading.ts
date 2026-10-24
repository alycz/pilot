#!/usr/bin/env -S node --experimental-transform-types

import { pathToFileURL } from 'node:url';

import {
	LocalTradingSecretProvisionError,
	provisionLocalTradingSecretFile,
} from '../src/exec/trading-local-secret-file.ts';

export function parseTradingProvisionerArguments(args: readonly string[]): string {
	if (args.length !== 2 || args[0] !== '--principal' || args[1] === undefined) {
		throw new LocalTradingSecretProvisionError('INVALID_PRINCIPAL');
	}
	return args[1];
}

export function runTradingProvisioner(args: readonly string[]): { path: string; principal: string } {
	return provisionLocalTradingSecretFile(parseTradingProvisionerArguments(args));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const result = runTradingProvisioner(process.argv.slice(2));
		process.stdout.write(`${JSON.stringify({ created: true, path: result.path, principal: result.principal })}\n`);
	} catch (error) {
		const code = error instanceof LocalTradingSecretProvisionError ? error.code : 'PROVISION_FAILED';
		process.stderr.write(`local-trading-provisioner: ${code}\n`);
		process.exitCode = 1;
	}
}
