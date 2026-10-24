import { z } from 'zod';

export const EvmAddressSchema = z.string()
	.regex(/^0x[0-9A-Fa-f]{40}$/)
	.refine((value) => !/^0x0{40}$/i.test(value), 'address must not be zero');
export const HexDataSchema = z.string().regex(/^0x(?:[0-9A-Fa-f]{2})+$/);
export const Hex32Schema = z.string()
	.regex(/^0x[0-9A-Fa-f]{64}$/)
	.refine((value) => !/^0x0{64}$/i.test(value), 'hash must not be zero');
export const EcdsaSignatureSchema = z.string()
	.regex(/^0x[0-9A-Fa-f]{130}$/)
	.refine((value) => !/^0x0{130}$/i.test(value), 'signature must not be zero');
export const CanonicalUintSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/);
export const PositiveUintSchema = z.string().regex(/^[1-9][0-9]*$/);
export const UINT256_MAX = 2n ** 256n - 1n;

export const PreparedEvmTransactionSchema = z.object({
	chainId: z.number().int().positive(),
	from: EvmAddressSchema,
	to: EvmAddressSchema,
	data: HexDataSchema,
	value: CanonicalUintSchema,
	gasLimit: PositiveUintSchema,
}).strict();

export const Ap4mEvmChannelSchema = z.object({
	channelId: Hex32Schema,
	agent: EvmAddressSchema,
	fundingWallet: EvmAddressSchema,
	merchantPayout: EvmAddressSchema,
	token: EvmAddressSchema,
	cap: PositiveUintSchema,
	cumulativeAmount: CanonicalUintSchema,
	generation: z.number().int().nonnegative(),
	status: z.enum(['open', 'closing', 'closed']),
}).strict();

export const EvmReceiptLogSchema = z.object({
	address: EvmAddressSchema,
	topics: z.array(Hex32Schema).min(1).max(4),
	data: HexDataSchema,
	logIndex: z.number().int().nonnegative(),
	removed: z.boolean(),
}).strict();

export const EvmReceiptEvidenceSchema = z.object({
	transactionHash: Hex32Schema,
	blockHash: Hex32Schema,
	blockNumber: z.number().int().positive(),
	status: z.literal('success'),
	logs: z.array(EvmReceiptLogSchema).max(256),
}).strict();

export type PreparedEvmTransaction = z.infer<typeof PreparedEvmTransactionSchema>;
export type Ap4mEvmChannel = z.infer<typeof Ap4mEvmChannelSchema>;
export type EvmReceiptEvidence = z.infer<typeof EvmReceiptEvidenceSchema>;

export type Ap4mEvmValidationCode =
	| 'INVALID_PROFILE'
	| 'INVALID_PREPARED_CALL'
	| 'ROLE_COLLISION'
	| 'INVALID_TYPED_DATA'
	| 'VOUCHER_REPLAY'
	| 'VOUCHER_OVER_CAP'
	| 'INVALID_RECEIPT'
	| 'RECEIPT_PENDING'
	| 'RECEIPT_MISMATCH';

export class Ap4mEvmValidationError extends Error {
	constructor(message: string, readonly code: Ap4mEvmValidationCode) {
		super(message);
		this.name = 'Ap4mEvmValidationError';
	}
}

export function canonicalUint(
	value: string,
	field: string,
	code: Ap4mEvmValidationCode = 'INVALID_PREPARED_CALL',
): bigint {
	if (!CanonicalUintSchema.safeParse(value).success) {
		throw new Ap4mEvmValidationError(`${field} must be a canonical uint`, code);
	}
	const parsed = BigInt(value);
	if (parsed > UINT256_MAX) {
		throw new Ap4mEvmValidationError(`${field} exceeds uint256`, code);
	}
	return parsed;
}
