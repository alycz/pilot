import { createHash } from "node:crypto";
import { constants as FS_CONSTANTS } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

export const TRADING_ISOLATED_V1_MIGRATION_DIRECTORY =
	"migrations-profile-trading-isolated-v1";
export const X402_ISOLATED_V1_MIGRATION_DIRECTORY =
	"migrations-profile-x402-isolated-v1";

export const TRADING_ISOLATED_V1_MIGRATIONS = Object.freeze([
	"0001_init.sql",
	"0002_build_capability_isolation.sql",
	"0002_quicknode.sql",
	"0003_execution_lifetime_v2.sql",
	"0004_v2_preflight_rejections.sql",
	"0005_v2_approval_recovery.sql",
	"0006_local_trading_isolated_onboarding_v1.sql",
	"0012_isolated_sequence_authority.sql",
	"0014_declarative_strategies.sql",
]);

export const X402_ISOLATED_V1_MIGRATIONS = Object.freeze([
	"0001_init.sql",
	"0002_x402_payments.sql",
	"0003_x402_payers.sql",
	"0004_x402_sequence_safety.sql",
	"0005_x402_durable_lease.sql",
	"0006_x402_budget_accounting.sql",
	"0007_x402_payer_provisioning.sql",
	"0009_isolated_sequence_authority.sql",
	"0010_issued_x402_authority.sql",
]);

const PROFILES = Object.freeze({
	"trading-isolated-v1": Object.freeze({
		sourceDirectory: "migrations",
		profileDirectory: TRADING_ISOLATED_V1_MIGRATION_DIRECTORY,
		migrationNames: TRADING_ISOLATED_V1_MIGRATIONS,
		sha256: Object.freeze({
			"0001_init.sql": "5d8ef181b9d30c0b33b0457c2911c2d3742777f14b1291f2b1479ea5f52e604c",
			"0002_build_capability_isolation.sql": "b7394bb6b7b135a9730655d85e29c1489461e0a769629af9efaad5e46261302c",
			"0002_quicknode.sql": "636baf9b62db702f94547216fe28f7796b66fa47f124b98d2f2c59e06440774c",
			"0003_execution_lifetime_v2.sql": "a0852ba68b34851d226aa88ccf992dbafc3ba3d6e3758de1886b96e1602e9155",
			"0004_v2_preflight_rejections.sql": "be6e3f538ceae8440a56c4fd0a0751ffc3fa9c240468e11ee22bd8ee7134e018",
			"0005_v2_approval_recovery.sql": "f761f8b889b13a553c0f3baec40b5738bb136a40c6b6389144cfc70c47e8dfda",
			"0006_local_trading_isolated_onboarding_v1.sql": "a2c8d06cc2eb763f9eb57ac33ecf4166463b0707e448f91186c2ec36296f4a48",
			"0012_isolated_sequence_authority.sql": "6bb35501d472ca3ec7215e7073fde77433a8152644819ed0bdca51e4c3a659b9",
			"0014_declarative_strategies.sql": "c6cea482f4ba8c31339695c7ee405fa898a4974d7c08d1a1f37e16ab232436ad",
		}),
	}),
	"x402-isolated-v1": Object.freeze({
		sourceDirectory: "migrations-local-x402",
		profileDirectory: X402_ISOLATED_V1_MIGRATION_DIRECTORY,
		migrationNames: X402_ISOLATED_V1_MIGRATIONS,
		sha256: Object.freeze({
			"0001_init.sql": "5d8ef181b9d30c0b33b0457c2911c2d3742777f14b1291f2b1479ea5f52e604c",
			"0002_x402_payments.sql": "5ed20ca4b49813bb17a976b76644e44a3590f4904aec28fb6e4dd80611cd93d9",
			"0003_x402_payers.sql": "2bb9c6124ea121ae17574fa82782dd947717f75dde17d7e4467583dde4da36f5",
			"0004_x402_sequence_safety.sql": "cd4469e9bb520a5ae1b0222d7634c925d7206a314ec6e8a9a724d0e10efb01a8",
			"0005_x402_durable_lease.sql": "21a9702d6ae68dba7c2c7355ee5d1414c2452ccc0dbcf93b3e695409d0503207",
			"0006_x402_budget_accounting.sql": "fc5cb8b7161c6b55390efff09e2a073fb260263b28747a22e5126ee718862626",
			"0007_x402_payer_provisioning.sql": "7cbd4eca4b4a8b9ab8d1d570a0aac92f4658543d1b3446b4be28d685ae5a3f6b",
			"0009_isolated_sequence_authority.sql": "05bd5e94572baa34fca5ebe3cac7e735b1d1b7fc205177b7a012cd02de07bae9",
			"0010_issued_x402_authority.sql": "40aea548d97d9b985bb92e21b07d2ff04d4087948b56d2ff0c3c8b7558f803de",
		}),
	}),
});

function invalidProfile(profile) {
	return new Error(`Isolated ${profile} migration profile is missing or stale`);
}

function sameIdentity(left, right) {
	return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(left, right) {
	return (
		sameIdentity(left, right) &&
		left.mode === right.mode &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function sameStableDirectory(left, right) {
	return (
		sameIdentity(left, right) &&
		left.mode === right.mode &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

async function openStableDirectory(path, openFile) {
	if (
		typeof FS_CONSTANTS.O_NOFOLLOW !== "number" ||
		typeof FS_CONSTANTS.O_DIRECTORY !== "number"
	) {
		throw new Error();
	}
	const handle = await openFile(
		path,
		FS_CONSTANTS.O_RDONLY |
			FS_CONSTANTS.O_NOFOLLOW |
			FS_CONSTANTS.O_DIRECTORY,
	);
	try {
		const [opened, current, canonical] = await Promise.all([
			handle.stat({ bigint: true }),
			lstat(path, { bigint: true }),
			realpath(path),
		]);
		if (
			!opened.isDirectory() ||
			!current.isDirectory() ||
			current.isSymbolicLink() ||
			!sameStableDirectory(opened, current) ||
			canonical !== resolve(path)
		) {
			throw new Error();
		}
		return { handle, metadata: opened, path };
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw error;
	}
}

async function assertStableDirectory(directory) {
	const [current, canonical, opened] = await Promise.all([
		lstat(directory.path, { bigint: true }),
		realpath(directory.path),
		directory.handle.stat({ bigint: true }),
	]);
	if (
		!current.isDirectory() ||
		current.isSymbolicLink() ||
		!opened.isDirectory() ||
		!sameStableDirectory(directory.metadata, current) ||
		!sameStableDirectory(directory.metadata, opened) ||
		canonical !== resolve(directory.path)
	) {
		throw new Error();
	}
}

async function readStableRegularFile(path, directory, openFile) {
	await assertStableDirectory(directory);
	const handle = await openFile(
		path,
		FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW,
	);
	try {
		const before = await handle.stat({ bigint: true });
		const currentBefore = await lstat(path, { bigint: true });
		if (
			!before.isFile() ||
			before.isSymbolicLink() ||
			before.nlink !== 1n ||
			!currentBefore.isFile() ||
			currentBefore.isSymbolicLink() ||
			!sameStableFile(before, currentBefore)
		) {
			throw new Error();
		}
		const bytes = await handle.readFile();
		const [after, currentAfter] = await Promise.all([
			handle.stat({ bigint: true }),
			lstat(path, { bigint: true }),
		]);
		if (
			!sameStableFile(before, after) ||
			!currentAfter.isFile() ||
			currentAfter.isSymbolicLink() ||
			!sameStableFile(after, currentAfter) ||
			BigInt(bytes.byteLength) !== after.size
		) {
			throw new Error();
		}
		await assertStableDirectory(directory);
		return bytes;
	} finally {
		await handle.close().catch(() => undefined);
	}
}

export async function validateIsolatedMigrationProfile(
	repoRoot,
	profile,
	{ openFile = open } = {},
) {
	const contract = PROFILES[profile];
	if (contract === undefined) throw invalidProfile(profile);
	let sourceDirectory;
	let profileDirectory;
	try {
		const profileRoot = join(repoRoot, contract.profileDirectory);
		const sourceRoot = join(repoRoot, contract.sourceDirectory);
		sourceDirectory = await openStableDirectory(sourceRoot, openFile);
		profileDirectory = await openStableDirectory(profileRoot, openFile);
		const entries = await readdir(profileRoot, { withFileTypes: true });
		await assertStableDirectory(profileDirectory);
		const names = entries.map((entry) => entry.name).sort();
		const expected = [...contract.migrationNames].sort();
		if (
			JSON.stringify(names) !== JSON.stringify(expected) ||
			entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
		) {
			throw new Error();
		}
		for (const name of contract.migrationNames) {
			const source = join(sourceRoot, name);
			const frozen = join(profileRoot, name);
			const [sourceBytes, frozenBytes] = await Promise.all([
				readStableRegularFile(source, sourceDirectory, openFile),
				readStableRegularFile(frozen, profileDirectory, openFile),
			]);
			if (
				!sourceBytes.equals(frozenBytes) ||
				createHash("sha256").update(frozenBytes).digest("hex") !==
					contract.sha256[name]
			) {
				throw new Error();
			}
		}
		return Object.freeze({
			migrationNames: contract.migrationNames,
			profileDirectory: contract.profileDirectory,
		});
	} catch {
		throw invalidProfile(profile);
	} finally {
		await Promise.all([
			sourceDirectory?.handle.close().catch(() => undefined),
			profileDirectory?.handle.close().catch(() => undefined),
		]);
	}
}
