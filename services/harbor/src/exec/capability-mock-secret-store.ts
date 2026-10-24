export interface CapabilitySecretResolver {
	readonly kind: 'mock';
	useSecret<T>(handle: string, use: (secret: string) => Promise<T>): Promise<T>;
}

const HANDLE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Test-only resolver. Values are provided once at construction and can only be
 * used through a callback, so the store has no public read/list/export path.
 */
export class MockCapabilitySecretStore implements CapabilitySecretResolver {
	readonly kind = 'mock' as const;
	readonly #values = new Map<string, string>();

	constructor(values: Readonly<Record<string, string>>) {
		for (const [handle, value] of Object.entries(values)) {
			if (!HANDLE.test(handle) || typeof value !== 'string' || value.length === 0 || value.length > 16_384) {
				throw new TypeError('Mock capability secret configuration is invalid');
			}
			this.#values.set(handle, value);
		}
	}

	async useSecret<T>(handle: string, use: (secret: string) => Promise<T>): Promise<T> {
		if (!HANDLE.test(handle)) throw new TypeError('Capability secret handle is invalid');
		const value = this.#values.get(handle);
		if (value === undefined) throw new Error('Capability secret is unavailable');
		return use(value);
	}
}
