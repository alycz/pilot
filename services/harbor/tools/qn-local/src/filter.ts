import vm from 'node:vm';

import type { QnLocalStore } from './store.ts';

export type StreamFilterInput = { data: unknown; metadata?: unknown };

export async function runQuickNodeFilter(
	source: string,
	stream: StreamFilterInput,
	store: QnLocalStore,
): Promise<unknown> {
	const qnLib = Object.freeze({
		qnContainsListItems: async (key: string, items: string[]) => {
			const list = new Set((await store.getList(key)) ?? []);
			return items.map((item) => list.has(item));
		},
		qnGetList: async (key: string) => (await store.getList(key)) ?? [],
		qnGetValue: async (key: string) => await store.getValue(key),
	});
	const context = vm.createContext({ qnLib, structuredClone });
	const script = new vm.Script(`"use strict";\n${source}\n;globalThis.__result = main(globalThis.__stream);`, {
		filename: 'quicknode-filter.js',
	});
	Object.defineProperty(context, '__stream', { value: structuredClone(stream), writable: false });
	script.runInContext(context, { timeout: 1_000 });
	return await (context as { __result: Promise<unknown> }).__result;
}
