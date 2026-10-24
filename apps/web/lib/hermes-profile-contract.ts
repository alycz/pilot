import { z } from "zod";

/**
 * Exact pinned Hermes v0.22.2 profile behavior required by the bounded bridge.
 * This is configuration evidence, not an attestation of a running process.
 */
export const HERMES_PROFILE_RUNTIME_INVARIANTS = Object.freeze({
  directModelRequests: true,
  maxTurns: 1,
  apiMaxRetries: 1,
  autoRecoveryCycles: 0,
  fallbackModels: false,
  compression: false,
  titleGeneration: false,
  titleModelUpgrade: false,
  backgroundReview: false,
  memory: false,
  profileAccess: false,
  externalProviders: false,
  mcp: false,
  plugins: false,
  relay: false,
  contextEngine: false,
  nativeToolsets: false,
  zeroTools: true,
  fixedTemperature: null,
  uniqueSessionPerRequest: true,
  storedModelOverride: false,
} as const);

export const HermesProfileRuntimeInvariantsSchema = z.object({
  directModelRequests: z.literal(true),
  maxTurns: z.literal(1),
  apiMaxRetries: z.literal(1),
  autoRecoveryCycles: z.literal(0),
  fallbackModels: z.literal(false),
  compression: z.literal(false),
  titleGeneration: z.literal(false),
  titleModelUpgrade: z.literal(false),
  backgroundReview: z.literal(false),
  memory: z.literal(false),
  profileAccess: z.literal(false),
  externalProviders: z.literal(false),
  mcp: z.literal(false),
  plugins: z.literal(false),
  relay: z.literal(false),
  contextEngine: z.literal(false),
  nativeToolsets: z.literal(false),
  zeroTools: z.literal(true),
  fixedTemperature: z.null(),
  uniqueSessionPerRequest: z.literal(true),
  storedModelOverride: z.literal(false),
}).strict();

export type HermesProfileRuntimeInvariants =
  typeof HERMES_PROFILE_RUNTIME_INVARIANTS;
