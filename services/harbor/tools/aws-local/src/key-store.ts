import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type LocalKmsKeySpec = 'ECC_NIST_EDWARDS25519' | 'SYMMETRIC_DEFAULT';
export type LocalKmsKeyUsage = 'SIGN_VERIFY' | 'ENCRYPT_DECRYPT';

export type LocalKmsTag = {
	TagKey: string;
	TagValue: string;
};

export type StoredLocalKmsKey = {
	keyId: string;
	arn: string;
	keySpec: LocalKmsKeySpec;
	keyUsage: LocalKmsKeyUsage;
	material: string;
	createdAt: string;
	tags: LocalKmsTag[];
	deletionDate?: string;
};

export type LocalKmsState = {
	keys: Record<string, StoredLocalKmsKey>;
	aliases: Record<string, string>;
};

export interface LocalKmsStore {
	load(): Promise<LocalKmsState>;
	save(state: LocalKmsState): Promise<void>;
}

export const EMPTY_LOCAL_KMS_STATE: LocalKmsState = {
	keys: {},
	aliases: {},
};

function cloneState(state: LocalKmsState): LocalKmsState {
	return structuredClone(state);
}

export class MemoryKeyStore implements LocalKmsStore {
	private state: LocalKmsState;

	constructor(initialState: LocalKmsState = EMPTY_LOCAL_KMS_STATE) {
		this.state = cloneState(initialState);
	}

	async load(): Promise<LocalKmsState> {
		return cloneState(this.state);
	}

	async save(state: LocalKmsState): Promise<void> {
		this.state = cloneState(state);
	}
}

export function defaultKeyStorePath(): string {
	return (process.env.HARBOR_PRIVATE_STATE_ROOT ? join(process.env.HARBOR_PRIVATE_STATE_ROOT, 'aws-local', 'keys.json') : '/dev/null/pilot-disabled/aws-local-keys.json');
}

export class JsonKeyStore implements LocalKmsStore {
	constructor(readonly path: string = defaultKeyStorePath()) {}

	async load(): Promise<LocalKmsState> {
		try {
			const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<LocalKmsState>;
			return {
				keys: parsed.keys ?? {},
				aliases: parsed.aliases ?? {},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return cloneState(EMPTY_LOCAL_KMS_STATE);
			}
			throw error;
		}
	}

	async save(state: LocalKmsState): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const temporaryPath = `${this.path}.${process.pid}.tmp`;
		await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
			encoding: 'utf8',
			mode: 0o600,
		});
		await rename(temporaryPath, this.path);
	}
}
