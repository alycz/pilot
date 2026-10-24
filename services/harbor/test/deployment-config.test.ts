import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { buildFreeQuickJsConfig } from "../scripts/configure-deployment.mjs";

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
		expect(config.routes).toEqual([{ pattern: "replace.invalid", custom_domain: true }]);
		expect(config).not.toHaveProperty("worker_loaders");
		expect(config.triggers).toEqual({ crons: [] });
		expect(config.vars).toMatchObject({
			EXECUTOR: "quickjs",
			MAINNET_EXECUTION: "false",
			HARBOR_MCP_EXECUTION_ENABLED: "false",
			AUTONOMOUS_STRATEGY_RUNNER: "false",
			QN_MODE: "off",
			MASTERCARD_MCP_ENABLED: "false",
			KMS_MODE: "off",
			AP4M_DEMO_ENABLED: "false",
			HARBOR_DEMO_QUOTA_ENABLED: "0",
		});
	});

	it("generates only an explicitly targeted, no-loader, no-cron profile", () => {
		const config = buildFreeQuickJsConfig({
			workerName: "approved-harbor",
			databaseName: "approved-harbor-db",
			databaseId: "123e4567-e89b-42d3-a456-426614174000",
			origin: "https://harbor.example.com",
		});
		expect(config.name).toBe("approved-harbor");
		expect(config.routes).toEqual([{ pattern: "harbor.example.com", custom_domain: true }]);
		expect(config.d1_databases[0]).toMatchObject({
			database_name: "approved-harbor-db",
			database_id: "123e4567-e89b-42d3-a456-426614174000",
		});
		expect(config).not.toHaveProperty("worker_loaders");
		expect(config.triggers).toEqual({ crons: [] });
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

		const result = spawnSync(process.execPath, [join(serviceRoot, "scripts/configure-deployment.mjs")], {
			encoding: "utf8",
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("missing --profile");
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
	});

	it("keeps the provisioning bootstrap out of the Free profile", () => {
		const bootstrap = readFileSync(join(serviceRoot, "scripts/bootstrap.sh"), "utf8");
		expect(bootstrap).not.toContain("probe_quickjs");
		expect(bootstrap).toContain("will not silently select QuickJS");

		const result = spawnSync("bash", [join(serviceRoot, "scripts/bootstrap.sh")], {
			encoding: "utf8",
			env: { ...process.env, HARBOR_BOOTSTRAP_PROFILE: "free-quickjs" },
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("bootstrap is paid-dynamic only");
		expect(result.stderr).toContain("config:free:generate");
	});
});
