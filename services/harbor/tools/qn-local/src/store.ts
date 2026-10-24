import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

type PersistedStore = {
	lists: Record<string, string[]>;
	values: Record<string, unknown>;
};

export interface QnLocalStore {
	putList(key: string, items: string[]): Promise<string[]>;
	patchList(key: string, addItems: string[], removeItems: string[]): Promise<string[]>;
	getList(key: string): Promise<string[] | undefined>;
	deleteList(key: string): Promise<boolean>;
	putValue(key: string, value: unknown): Promise<void>;
	getValue(key: string): Promise<unknown>;
}

function cleanItems(items: unknown): string[] {
	if (!Array.isArray(items) || items.some((item) => typeof item !== 'string')) {
		throw new TypeError('items must be an array of strings');
	}
	return [...new Set(items)];
}

export class JsonQnLocalStore implements QnLocalStore {
	readonly path: string;
	#writeQueue: Promise<void> = Promise.resolve();

	constructor(path = (process.env.HARBOR_PRIVATE_STATE_ROOT ? join(process.env.HARBOR_PRIVATE_STATE_ROOT, 'qn-local', 'kv.json') : '/dev/null/pilot-disabled/qn-local-kv.json')) {
		this.path = path;
	}

	async #read(): Promise<PersistedStore> {
		try {
			const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<PersistedStore>;
			return {
				lists: parsed.lists && typeof parsed.lists === 'object' ? parsed.lists : {},
				values: parsed.values && typeof parsed.values === 'object' ? parsed.values : {},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { lists: {}, values: {} };
			throw error;
		}
	}

	async #mutate(change: (state: PersistedStore) => void): Promise<void> {
		this.#writeQueue = this.#writeQueue.then(async () => {
			const state = await this.#read();
			change(state);
			await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
			const temporary = `${this.path}.${process.pid}.tmp`;
			await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
			await rename(temporary, this.path);
		});
		return this.#writeQueue;
	}

	async putList(key: string, items: string[]): Promise<string[]> {
		const next = cleanItems(items);
		await this.#mutate((state) => { state.lists[key] = next; });
		return next;
	}

	async patchList(key: string, addItems: string[], removeItems: string[]): Promise<string[]> {
		const additions = cleanItems(addItems);
		const removals = new Set(cleanItems(removeItems));
		let next: string[] = [];
		await this.#mutate((state) => {
			next = [...new Set([...(state.lists[key] ?? []), ...additions])].filter((item) => !removals.has(item));
			state.lists[key] = next;
		});
		return next;
	}

	async getList(key: string): Promise<string[] | undefined> {
		return (await this.#read()).lists[key];
	}

	async deleteList(key: string): Promise<boolean> {
		let existed = false;
		await this.#mutate((state) => {
			existed = Object.hasOwn(state.lists, key);
			delete state.lists[key];
		});
		return existed;
	}

	async putValue(key: string, value: unknown): Promise<void> {
		await this.#mutate((state) => { state.values[key] = value; });
	}

	async getValue(key: string): Promise<unknown> {
		return (await this.#read()).values[key];
	}
}

export { cleanItems };
