#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	FREE_QUICKJS_MIGRATION_DIRECTORY,
	FREE_QUICKJS_MIGRATIONS,
	validateIsolatedMigrationProfile,
} from "./isolated-migration-profiles.mjs";

const serviceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const result = await validateIsolatedMigrationProfile(serviceRoot, "free-quickjs");
if (
	result.profileDirectory !== FREE_QUICKJS_MIGRATION_DIRECTORY ||
	JSON.stringify(result.migrationNames) !== JSON.stringify(FREE_QUICKJS_MIGRATIONS)
) {
	throw new Error("Free/QuickJS migration profile is missing or stale");
}
process.stdout.write(
	`verified ${FREE_QUICKJS_MIGRATIONS.length} Free/QuickJS migrations through 0010\n`,
);
