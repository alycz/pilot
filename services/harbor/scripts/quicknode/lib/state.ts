import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type QuickNodeProvisionState = Readonly<{
	version: 1;
	run: string;
	network: 'testnet' | 'devnet';
	webhook: Readonly<{ id: string; name: string }>;
	stream: Readonly<{ id: string; name: string }>;
	kv_lists: readonly string[];
	updated_at: string;
}>;

function runTag(run: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(run)) throw new Error('QN_RUN_TAG_INVALID');
	return run;
}

export function defaultQuickNodeStatePath(run: string): string {
	return (process.env.HARBOR_PRIVATE_STATE_ROOT ? join(process.env.HARBOR_PRIVATE_STATE_ROOT, `qn-state.${runTag(run)}.json`) : '/dev/null/pilot-disabled/qn-state.json');
}

function state(value: unknown): QuickNodeProvisionState {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('QN_STATE_INVALID');
	const row = value as Record<string, unknown>;
	const webhook = row.webhook as Record<string, unknown> | undefined;
	const stream = row.stream as Record<string, unknown> | undefined;
	if (
		row.version !== 1 || typeof row.run !== 'string' ||
		(row.network !== 'testnet' && row.network !== 'devnet') ||
		!webhook || typeof webhook.id !== 'string' || typeof webhook.name !== 'string' ||
		!stream || typeof stream.id !== 'string' || typeof stream.name !== 'string' ||
		!Array.isArray(row.kv_lists) || row.kv_lists.some((item) => typeof item !== 'string') ||
		typeof row.updated_at !== 'string'
	) throw new Error('QN_STATE_INVALID');
	runTag(row.run);
	return row as unknown as QuickNodeProvisionState;
}

export async function readQuickNodeState(path: string): Promise<QuickNodeProvisionState | undefined> {
	try { return state(JSON.parse(await readFile(path, 'utf8')) as unknown); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	}
}

export async function writeQuickNodeState(path: string, value: QuickNodeProvisionState): Promise<void> {
	const checked = state(value);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.tmp-${process.pid}`;
	let handle;
	try {
		handle = await open(temporary, 'wx', 0o600);
		await handle.writeFile(`${JSON.stringify(checked, null, 2)}\n`, 'utf8');
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporary, path);
	} finally {
		await handle?.close();
		await rm(temporary, { force: true });
	}
}
