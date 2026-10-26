import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { buildFreeQuickJsConfig } from "../scripts/configure-deployment.mjs";
import {
	FREE_QUICKJS_MIGRATION_DIRECTORY,
	FREE_QUICKJS_MIGRATIONS,
	validateIsolatedMigrationProfile,
} from "../scripts/isolated-migration-profiles.mjs";

const serviceRoot = fileURLToPath(new URL("..", import.meta.url));
const tempRoots: string[] = [];

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "harbor-deployment-config-"));
	tempRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Free/QuickJS deployment configuration", () => {
	it("keeps the checked-in profile inert and free of paid bindings", () => {
		const config = JSON.parse(readFileSync(join(serviceRoot, "wrangler.free-quickjs.jsonc"), "utf8"));
		expect(config.name).toBe("replace-with-approved-worker-name");
		expect(config.d1_databases[0].database_id).toBe("00000000-0000-0000-0000-000000000000");
		expect(config.d1_databases[0]).toMatchObject({
			database_name: "replace-with-approved-d1-name",
			migrations_dir: FREE_QUICKJS_MIGRATION_DIRECTORY,
		});
		expect(config.workers_dev).toBe(true);
		expect(config).not.toHaveProperty("routes");
		expect(config).not.toHaveProperty("worker_loaders");
		expect(config.triggers).toEqual({ crons: [] });
		expect(config.vars).toMatchObject({
			HARBOR_DEPLOYMENT_PROFILE: "free-quickjs",
			HARBOR_PUBLIC_URL: "https://replace-with-approved-worker-name.replace-with-account-subdomain.workers.dev",
			EXECUTOR: "quickjs",
			MAINNET_EXECUTION: "false",
			HARBOR_MOCK: "1",
			LIVE: "0",
			HARBOR_MCP_EXECUTION_ENABLED: "false",
			AUTONOMOUS_STRATEGY_RUNNER: "false",
			QN_MODE: "off",
			MASTERCARD_MCP_ENABLED: "false",
			KMS_MODE: "off",
			AP4M_DEMO_ENABLED: "false",
			AP4M_EVM_EVENT_ENABLED: "false",
			AP4M_EVM_EVENT_MODE: "off",
			GUARDRAILS_MODE: "off",
			HARBOR_DEMO_QUOTA_ENABLED: "0",
			HARBOR_HOSTED_STATE_ENABLED: "0",
		});
	});

	it("generates an exact workers.dev, no-loader, no-cron profile", () => {
		const config = buildFreeQuickJsConfig({
			workerName: "approved-harbor",
			databaseName: "approved-harbor-db",
			databaseId: "123e4567-e89b-42d3-a456-426614174000",
			origin: "https://approved-harbor.account-subdomain.workers.dev",
		});
		expect(config.name).toBe("approved-harbor");
		expect(config.workers_dev).toBe(true);
		expect(config).not.toHaveProperty("routes");
		expect(config.d1_databases[0]).toMatchObject({
			database_name: "approved-harbor-db",
			database_id: "123e4567-e89b-42d3-a456-426614174000",
			migrations_dir: FREE_QUICKJS_MIGRATION_DIRECTORY,
		});
		expect(config).not.toHaveProperty("worker_loaders");
		expect(config.triggers).toEqual({ crons: [] });
	});

	it("preserves an explicitly approved custom-domain profile", () => {
		const config = buildFreeQuickJsConfig({
			workerName: "approved-harbor",
			databaseName: "approved-harbor-db",
			databaseId: "123e4567-e89b-42d3-a456-426614174000",
			origin: "https://harbor.example.com",
		});
		expect(config.workers_dev).toBe(false);
		expect(config.routes).toEqual([{ pattern: "harbor.example.com", custom_domain: true }]);
	});

	it("rejects placeholders, non-HTTPS origins, and implicit profiles", () => {
		const valid = {
			workerName: "approved-harbor",
			databaseName: "approved-harbor-db",
			databaseId: "123e4567-e89b-42d3-a456-426614174000",
			origin: "https://harbor.example.com",
		};
		expect(() => buildFreeQuickJsConfig({ ...valid, workerName: "replace-with-worker" })).toThrow(/placeholder/);
		expect(() => buildFreeQuickJsConfig({ ...valid, databaseId: "00000000-0000-0000-0000-000000000000" })).toThrow(/D1 UUID|placeholder/);
		expect(() => buildFreeQuickJsConfig({ ...valid, origin: "http://harbor.example.com" })).toThrow(/normalized HTTPS origin/);
		expect(() => buildFreeQuickJsConfig({
			...valid,
			origin: "https://different-worker.account.workers.dev",
		})).toThrow(/exactly match the Worker name/);
		expect(() => buildFreeQuickJsConfig({
			...valid,
			origin: "https://approved-harbor.nested.account.workers.dev",
		})).toThrow(/one account subdomain/);

		const result = spawnSync(process.execPath, [join(serviceRoot, "scripts/configure-deployment.mjs")], {
			encoding: "utf8",
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("missing --profile");
	});

	it("pins the exact base migrations plus reviewed hosted state without enabling intervening features", async () => {
		expect(FREE_QUICKJS_MIGRATIONS).toEqual([
			"0001_init.sql",
			"0002_build_capability_isolation.sql",
			"0002_quicknode.sql",
			"0003_execution_lifetime_v2.sql",
			"0004_v2_preflight_rejections.sql",
			"0005_v2_approval_recovery.sql",
			"0006_local_trading_isolated_onboarding_v1.sql",
			"0007_ap4m_mandates.sql",
			"0008_ap4m_purchase_attempts.sql",
			"0008_quicknode_rpc_counters.sql",
			"0009_aws_kms_delegate_keys.sql",
			"0010_ap4m_channel_purchase.sql",
			"0017_hosted_pilot_state.sql",
			"0018_near_attempt_store.sql",
			"0019_near_wallet_proof_replay.sql",
			"0020_near_native_to_arbitrum_usdc_lifecycle.sql",
		]);
		expect(FREE_QUICKJS_MIGRATIONS.some((name) => /^001[1-6]_/.test(name))).toBe(false);
		await expect(validateIsolatedMigrationProfile(serviceRoot, "free-quickjs"))
			.resolves.toEqual({
				migrationNames: FREE_QUICKJS_MIGRATIONS,
				profileDirectory: FREE_QUICKJS_MIGRATION_DIRECTORY,
			});
	});

	it("writes one local file without invoking provisioning or network tools", () => {
		const source = readFileSync(join(serviceRoot, "scripts/configure-deployment.mjs"), "utf8");
		expect(source).not.toMatch(/child_process|\bfetch\s*\(|secret put|d1 (?:create|migrations)|faucet/i);

		const output = join(temporaryRoot(), "wrangler.generated.jsonc");
		execFileSync(process.execPath, [
			join(serviceRoot, "scripts/configure-deployment.mjs"),
			"--profile", "free-quickjs",
			"--worker-name", "approved-harbor",
			"--database-name", "approved-harbor-db",
			"--database-id", "123e4567-e89b-42d3-a456-426614174000",
			"--origin", "https://harbor.example.com",
			"--output", output,
		], { stdio: "pipe" });
		const config = JSON.parse(readFileSync(output, "utf8"));
		expect(config).not.toHaveProperty("worker_loaders");
		expect(config.vars.HARBOR_MCP_EXECUTION_ENABLED).toBe("false");
		expect(config.main).toBe(join(serviceRoot, "src/server.ts"));
		expect(config.d1_databases[0].migrations_dir).toBe(
			join(serviceRoot, FREE_QUICKJS_MIGRATION_DIRECTORY),
		);
	});

	it("refuses to write generated operator configuration into the checkout", () => {
		const result = spawnSync(process.execPath, [
			join(serviceRoot, "scripts/configure-deployment.mjs"),
			"--profile", "free-quickjs",
			"--worker-name", "approved-harbor",
			"--database-name", "approved-harbor-db",
			"--database-id", "123e4567-e89b-42d3-a456-426614174000",
			"--origin", "https://harbor.example.com",
			"--output", join(serviceRoot, "wrangler.generated.jsonc"),
		], { encoding: "utf8" });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("outside the repository checkout");
	});

	it("rejects an outside parent symlink that resolves back into the checkout", () => {
		const root = temporaryRoot();
		const linkedParent = join(root, "linked-checkout");
		const target = join(serviceRoot, "wrangler.generated-via-symlink.jsonc");
		symlinkSync(serviceRoot, linkedParent, "dir");
		const result = spawnSync(process.execPath, [
			join(serviceRoot, "scripts/configure-deployment.mjs"),
			"--profile", "free-quickjs",
			"--worker-name", "approved-harbor",
			"--database-name", "approved-harbor-db",
			"--database-id", "123e4567-e89b-42d3-a456-426614174000",
			"--origin", "https://harbor.example.com",
			"--output", join(linkedParent, "wrangler.generated-via-symlink.jsonc"),
		], { encoding: "utf8" });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("canonical directory without symlinks");
		expect(existsSync(target)).toBe(false);
	});

	it("keeps the provisioning bootstrap out of the Free profile", () => {
		const bootstrap = readFileSync(join(serviceRoot, "scripts/bootstrap.sh"), "utf8");
		expect(bootstrap).toContain("probe_quickjs");
		expect(bootstrap).toContain("Worker Loader and QuickJS fallback probes both failed");

		const result = spawnSync("bash", [join(serviceRoot, "scripts/bootstrap.sh")], {
			encoding: "utf8",
			env: { ...process.env, HARBOR_BOOTSTRAP_PROFILE: "free-quickjs" },
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("bootstrap is paid-dynamic only");
		expect(result.stderr).toContain("config:free:generate");
	});
});
