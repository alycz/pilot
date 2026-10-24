import { z } from "zod";

import {
  EnvelopeSchema,
  type Caveat,
  type Envelope,
  type Err,
  type Ok,
} from "../contracts";

export type EnvelopeMetadata = {
  asOf?: string | Date;
  asOfBasis: string;
  caveat?: readonly Caveat[];
};

function isoTimestamp(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (value !== undefined) return value;
  return new Date().toISOString();
}

export function okEnvelope<T>(data: T, metadata: EnvelopeMetadata): Ok<T> {
  return {
    ok: true,
    data,
    asOf: isoTimestamp(metadata.asOf),
    asOfBasis: metadata.asOfBasis,
    ...(metadata.caveat && metadata.caveat.length > 0
      ? { caveat: [...metadata.caveat] }
      : {}),
  };
}

export function errorEnvelope(
  service: string,
  error: unknown,
  options: {
    kind?: "error" | "soft-empty";
    code?: string;
    hint?: string;
  } = {},
): Err {
  const message = error instanceof Error ? error.message : "Unknown error";
  return {
    ok: false,
    error: {
      service,
      kind: options.kind ?? "error",
      message,
      ...(options.code ? { code: options.code } : {}),
      ...(options.hint ? { hint: options.hint } : {}),
    },
  };
}

export function isEnvelope(value: unknown): value is Envelope<unknown> {
  return EnvelopeSchema(z.unknown()).safeParse(value).success;
}
