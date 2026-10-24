export type QuickNodeFetch = typeof fetch;

export type NamedResource = Readonly<{
	id: string;
	name: string;
	status?: string;
}>;

export type WebhookConfiguration = Readonly<{
	name: string;
	network: string;
	destination_url: string;
	compression: string;
	wallets_list_name: string;
}>;

export type StreamConfiguration = Readonly<{
	name: string;
	network: string;
	dataset: string;
	filter_function: string;
	region: string;
	dataset_batch_size: number;
	elastic_batch_enabled: boolean;
	end_range: number;
	destination: string;
	destination_url: string;
	compression: string;
	max_retry: number;
	retry_interval_sec: number;
	post_timeout_sec: number;
	status: string;
}>;

export class QuickNodeAdminError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = 'QuickNodeAdminError';
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function resource(value: unknown): NamedResource | undefined {
	const item = record(value);
	if (!item || typeof item.id !== 'string' || typeof item.name !== 'string') return undefined;
	if (item.id.length === 0 || item.id.length > 200 || item.name.length === 0 || item.name.length > 200) return undefined;
	return {
		id: item.id,
		name: item.name,
		...(typeof item.status === 'string' ? { status: item.status } : {}),
	};
}

function resources(value: unknown, keys: readonly string[]): NamedResource[] {
	const top = record(value);
	const data = record(top?.data);
	const candidates: unknown[] = [value];
	for (const key of keys) candidates.push(top?.[key], data?.[key]);
	candidates.push(top?.results, data?.results);
	const items = candidates.find(Array.isArray);
	if (!Array.isArray(items) || items.length > 10_000) {
		throw new QuickNodeAdminError('QN_ADMIN_MALFORMED_RESPONSE');
	}
	const parsed = items.map(resource);
	if (parsed.some((item) => item === undefined)) {
		throw new QuickNodeAdminError('QN_ADMIN_MALFORMED_RESPONSE');
	}
	return parsed as NamedResource[];
}

function identifier(value: unknown): string {
	const direct = record(value);
	const nested = record(direct?.data);
	const id = typeof direct?.id === 'string' ? direct.id : nested?.id;
	if (typeof id !== 'string' || id.length === 0 || id.length > 200) {
		throw new QuickNodeAdminError('QN_ADMIN_MALFORMED_RESPONSE');
	}
	return id;
}

function detail(value: unknown): Record<string, unknown> {
	const top = record(value);
	const result = record(top?.data) ?? top;
	if (!result) throw new QuickNodeAdminError('QN_ADMIN_MALFORMED_RESPONSE');
	return result;
}

function text(value: unknown): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > 100_000) {
		throw new QuickNodeAdminError('QN_ADMIN_MALFORMED_RESPONSE');
	}
	return value;
}

function integer(value: unknown): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
		throw new QuickNodeAdminError('QN_ADMIN_MALFORMED_RESPONSE');
	}
	return value;
}

function webhookConfiguration(value: unknown): WebhookConfiguration {
	const item = detail(value);
	const destination = record(item.destination_attributes);
	const args = record(item.templateArgs);
	if (!destination || !args) throw new QuickNodeAdminError('QN_ADMIN_MALFORMED_RESPONSE');
	return {
		name: text(item.name),
		network: text(item.network),
		destination_url: text(destination.url),
		compression: text(destination.compression),
		wallets_list_name: text(args.walletsListName),
	};
}

function streamConfiguration(value: unknown): StreamConfiguration {
	const item = detail(value);
	const destination = record(item.destination_attributes);
	if (!destination || typeof item.elastic_batch_enabled !== 'boolean') {
		throw new QuickNodeAdminError('QN_ADMIN_MALFORMED_RESPONSE');
	}
	return {
		name: text(item.name),
		network: text(item.network),
		dataset: text(item.dataset),
		filter_function: text(item.filter_function),
		region: text(item.region),
		dataset_batch_size: integer(item.dataset_batch_size),
		elastic_batch_enabled: item.elastic_batch_enabled,
		end_range: integer(item.end_range),
		destination: text(item.destination),
		destination_url: text(destination.url),
		compression: text(destination.compression),
		max_retry: integer(destination.max_retry),
		retry_interval_sec: integer(destination.retry_interval_sec),
		post_timeout_sec: integer(destination.post_timeout_sec),
		status: text(item.status),
	};
}

function safePath(path: string): boolean {
	if (!path.startsWith('/') || path.includes('\\') || path.includes('?') || path.includes('#')) return false;
	try {
		return !path.split('/').some((raw) => {
			const segment = decodeURIComponent(raw);
			return segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\');
		});
	} catch {
		return false;
	}
}

export class QuickNodeAdminClient {
	readonly #base: URL;
	readonly #apiKey: string;
	readonly #fetch: QuickNodeFetch;

	constructor(options: Readonly<{ base: string; apiKey: string; fetcher?: QuickNodeFetch }>) {
		let base: URL;
		try { base = new URL(options.base); } catch { throw new QuickNodeAdminError('QN_ADMIN_BASE_INVALID'); }
		if (
			base.username || base.password || base.pathname !== '/' || base.search || base.hash ||
			(base.protocol !== 'https:' && base.protocol !== 'http:')
		) {
			throw new QuickNodeAdminError('QN_ADMIN_BASE_INVALID');
		}
		if (base.protocol === 'http:' && base.hostname !== '127.0.0.1' && base.hostname !== 'localhost' && base.hostname !== '::1' && base.hostname !== '[::1]') {
			throw new QuickNodeAdminError('QN_ADMIN_BASE_INVALID');
		}
		if (!options.apiKey || options.apiKey.length > 4_096) {
			throw new QuickNodeAdminError('QN_ADMIN_API_KEY_MISSING');
		}
		this.#base = base;
		this.#apiKey = options.apiKey;
		this.#fetch = options.fetcher ?? fetch;
	}

	async #request(method: string, path: string, body?: Readonly<Record<string, unknown>>): Promise<unknown> {
		if (!safePath(path)) throw new QuickNodeAdminError('QN_ADMIN_PATH_INVALID');
		const base = this.#base.toString().endsWith('/') ? this.#base : new URL(`${this.#base.toString()}/`);
		const url = new URL(path.slice(1), base);
		if (url.origin !== this.#base.origin) throw new QuickNodeAdminError('QN_ADMIN_PATH_INVALID');
		let response: Response;
		try {
			response = await this.#fetch(url, {
				method,
				headers: {
					accept: 'application/json',
					'x-api-key': this.#apiKey,
					...(body ? { 'content-type': 'application/json' } : {}),
				},
				...(body ? { body: JSON.stringify(body) } : {}),
			});
		} catch {
			throw new QuickNodeAdminError('QN_ADMIN_TRANSPORT_ERROR');
		}
		if (!response.ok) throw new QuickNodeAdminError(`QN_ADMIN_HTTP_${response.status}`);
		if (response.status === 204) return null;
		try { return await response.json(); }
		catch { throw new QuickNodeAdminError('QN_ADMIN_MALFORMED_RESPONSE'); }
	}

	async listWebhooks(): Promise<NamedResource[]> {
		return resources(await this.#request('GET', '/webhooks/rest/v1/webhooks'), ['webhooks', 'data', 'results']);
	}

	async createWalletWebhook(body: Readonly<Record<string, unknown>>): Promise<string> {
		return identifier(await this.#request('POST', '/webhooks/rest/v1/webhooks/template/xrplWalletFilter', body));
	}

	async getWebhookConfiguration(id: string): Promise<WebhookConfiguration> {
		return webhookConfiguration(await this.#request('GET', `/webhooks/rest/v1/webhooks/${encodeURIComponent(id)}`));
	}

	async deleteWebhook(path: string): Promise<void> {
		await this.#request('DELETE', path);
	}

	async listStreams(): Promise<NamedResource[]> {
		return resources(await this.#request('GET', '/streams/rest/v1/streams'), ['streams', 'data', 'results']);
	}

	async createStream(body: Readonly<Record<string, unknown>>): Promise<string> {
		return identifier(await this.#request('POST', '/streams/rest/v1/streams', body));
	}

	async getStreamConfiguration(id: string): Promise<StreamConfiguration> {
		return streamConfiguration(await this.#request('GET', `/streams/rest/v1/streams/${encodeURIComponent(id)}`));
	}

	async pauseStream(id: string): Promise<void> {
		await this.#request('POST', `/streams/rest/v1/streams/${encodeURIComponent(id)}/pause`);
	}

	async deleteStream(id: string): Promise<void> {
		await this.#request('DELETE', `/streams/rest/v1/streams/${encodeURIComponent(id)}`);
	}

	async getKvList(key: string): Promise<unknown> {
		return this.#request('GET', `/kv/rest/v1/lists/${encodeURIComponent(key)}`);
	}

	async deleteKvList(key: string): Promise<void> {
		await this.#request('DELETE', `/kv/rest/v1/lists/${encodeURIComponent(key)}`);
	}

	async testFilter(body: Readonly<Record<string, unknown>>): Promise<unknown> {
		return this.#request('POST', '/streams/rest/v1/streams/test_filter', body);
	}
}
