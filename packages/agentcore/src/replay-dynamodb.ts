import { randomUUID } from "node:crypto";

import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
  type DynamoDBClientConfig,
  type GetItemCommandInput,
  type UpdateItemCommandInput,
} from "@aws-sdk/client-dynamodb";

import { AgentCoreRuntimeResponseSchema } from "./contracts";
import {
  AgentCoreReplayError,
  validateAgentCoreReplayDurations,
  type AgentCoreReplayStore,
} from "./replay";
import type { AgentCoreAwsRegion } from "./regions";

type AttributeValue = Readonly<{ S?: string; N?: string }>;
type Item = Readonly<Record<string, AttributeValue>>;

export type DynamoReplayUpdateInput = Readonly<{
  TableName: string;
  Key: Item;
  ConditionExpression: string;
  UpdateExpression: string;
  ExpressionAttributeNames: Readonly<Record<string, string>>;
  ExpressionAttributeValues: Item;
  ReturnValues?: "ALL_NEW" | "NONE";
}>;

export type DynamoReplayGetInput = Readonly<{
  TableName: string;
  Key: Item;
  ConsistentRead: true;
}>;

/** Thin transport seam implemented by @aws-sdk/client-dynamodb in production. */
export interface DynamoDbReplayClient {
  updateItem(input: DynamoReplayUpdateInput, options?: Readonly<{ signal?: AbortSignal }>): Promise<Readonly<{ Attributes?: Item }>>;
  getItem(input: DynamoReplayGetInput, options?: Readonly<{ signal?: AbortSignal }>): Promise<Readonly<{ Item?: Item }>>;
  isConditionalFailure(error: unknown): boolean;
  destroy?(): void;
}

export type DynamoDbReplayConfig = Readonly<{
  tableName: string;
  client: DynamoDbReplayClient;
  nextLeaseId?: () => string;
  timeoutMs?: number;
}>;

export type AwsSdkDynamoDbReplayClientConfig = Readonly<{
  region: AgentCoreAwsRegion;
  /** Test seam only. Production uses the SDK's default short-lived credential chain. */
  client?: DynamoDBClient;
}>;

export function createAwsSdkDynamoDbClientConfig(
  region: AgentCoreAwsRegion,
): DynamoDBClientConfig {
  return Object.freeze({
    region,
    maxAttempts: 1,
    ignoreConfiguredEndpointUrls: true,
  });
}

/**
 * Compose the narrow replay transport with the official DynamoDB SDK. The SDK
 * client is deliberately configured with no static credentials and no retries:
 * an ambiguous write must surface as `uncertain`, never be replayed by a hidden
 * transport retry.
 */
export function createAwsSdkDynamoDbReplayClient(
  config: AwsSdkDynamoDbReplayClientConfig,
): DynamoDbReplayClient {
  const client = config.client ?? new DynamoDBClient(
    createAwsSdkDynamoDbClientConfig(config.region),
  );
  const transport: DynamoDbReplayClient = {
    async updateItem(input, options) {
      const output = await client.send(
        new UpdateItemCommand(input as UpdateItemCommandInput),
        options?.signal ? { abortSignal: options.signal } : undefined,
      );
      return output.Attributes ? { Attributes: output.Attributes } : {};
    },
    async getItem(input, options) {
      const output = await client.send(
        new GetItemCommand(input as GetItemCommandInput),
        options?.signal ? { abortSignal: options.signal } : undefined,
      );
      return output.Item ? { Item: output.Item } : {};
    },
    isConditionalFailure(error) {
      return error instanceof ConditionalCheckFailedException ||
        (error instanceof Error && error.name === "ConditionalCheckFailedException");
    },
    destroy() {
      client.destroy();
    },
  };
  return Object.freeze(transport);
}

export type AwsSdkDynamoDbReplayResources = Readonly<{
  replayStore: AgentCoreReplayStore;
  destroy(): void;
}>;

/** Compose the production SDK transport and durable replay state machine. */
export function createAwsSdkDynamoDbAgentCoreReplayStore(config: Readonly<{
  region: AgentCoreAwsRegion;
  tableName: string;
  client?: DynamoDBClient;
  timeoutMs?: number;
}>): AwsSdkDynamoDbReplayResources {
  const transport = createAwsSdkDynamoDbReplayClient({
    region: config.region,
    ...(config.client ? { client: config.client } : {}),
  });
  const replayStore = createDynamoDbAgentCoreReplayStore({
    tableName: config.tableName,
    client: transport,
    ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
  });
  return Object.freeze({
    replayStore,
    destroy() {
      transport.destroy?.();
    },
  });
}

const allNames = Object.freeze({
  "#namespace": "namespace",
  "#request": "requestDigest",
  "#binding": "bindingDigest",
  "#state": "state",
  "#lease": "leaseId",
  "#fence": "fence",
  "#leaseUntil": "leaseUntil",
  "#expiresAt": "expiresAt",
  "#response": "responseJson",
});

function expressionNames(...names: (keyof typeof allNames)[]): Readonly<Record<string, string>> {
  return Object.fromEntries(names.map((name) => [name, allNames[name]]));
}

function text(item: Item, name: string): string | undefined {
  return item[name]?.S;
}

function integer(item: Item, name: string): number | undefined {
  const raw = item[name]?.N;
  if (!raw || !/^(?:0|[1-9]\d*)$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

function key(namespaceDigest: string, requestDigest: string): Item {
  return { namespace: { S: namespaceDigest }, requestDigest: { S: requestDigest } };
}

function conditional(error: unknown, client: DynamoDbReplayClient): boolean {
  try {
    return client.isConditionalFailure(error);
  } catch {
    return false;
  }
}

function ownedValues(input: Readonly<{
  bindingDigest: string;
  leaseId: string;
  fence: number;
  nowMs: number;
  retentionMs: number;
}>): Item {
  return {
    ":binding": { S: input.bindingDigest },
    ":lease": { S: input.leaseId },
    ":fence": { N: String(input.fence) },
    ":now": { N: String(input.nowMs) },
    ":expiresAt": { N: String(Math.ceil((input.nowMs + input.retentionMs) / 1_000)) },
  };
}

export function createDynamoDbAgentCoreReplayStore(config: DynamoDbReplayConfig): AgentCoreReplayStore {
  if (!/^[A-Za-z0-9_.-]{3,255}$/.test(config.tableName)) throw new AgentCoreReplayError("invalid");
  const timeoutMs = config.timeoutMs ?? 3_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) throw new AgentCoreReplayError("invalid");
  const nextLeaseId = config.nextLeaseId ?? randomUUID;
  const call = async <T>(work: (signal: AbortSignal) => Promise<T>, caller?: AbortSignal): Promise<T> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
    if (signal.aborted) throw new AgentCoreReplayError("uncertain");
    const pending = Promise.resolve().then(() => work(signal));
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new AgentCoreReplayError("uncertain"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      return await Promise.race([pending, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
      void pending.catch(() => undefined);
    }
  };
  const get = (namespaceDigest: string, requestDigest: string, caller?: AbortSignal) => call(
    (signal) => config.client.getItem({ TableName: config.tableName, Key: key(namespaceDigest, requestDigest), ConsistentRead: true }, { signal }),
    caller,
  );

  const store: AgentCoreReplayStore = {
    async claim(input) {
      validateAgentCoreReplayDurations(input);
      if (![input.namespaceDigest, input.requestDigest, input.bindingDigest].every((value) => /^[a-f0-9]{64}$/.test(value))) {
        throw new AgentCoreReplayError("invalid");
      }
      const leaseId = nextLeaseId();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(leaseId)) {
        throw new AgentCoreReplayError("invalid");
      }
      const values: Item = {
        ":binding": { S: input.bindingDigest },
        ":claimed": { S: "claimed" },
        ":released": { S: "released" },
        ":lease": { S: leaseId },
        ":zero": { N: "0" },
        ":one": { N: "1" },
        ":now": { N: String(input.nowMs) },
        ":leaseUntil": { N: String(input.nowMs + input.leaseMs) },
        ":expiresAt": { N: String(Math.ceil((input.nowMs + input.retentionMs) / 1_000)) },
      };
      try {
        const result = await call((signal) => config.client.updateItem({
          TableName: config.tableName,
          Key: key(input.namespaceDigest, input.requestDigest),
          ConditionExpression: "attribute_not_exists(#namespace) OR (#binding = :binding AND (#state = :released OR (#state = :claimed AND #leaseUntil <= :now)))",
          UpdateExpression: "SET #binding = :binding, #state = :claimed, #lease = :lease, #fence = if_not_exists(#fence, :zero) + :one, #leaseUntil = :leaseUntil, #expiresAt = :expiresAt REMOVE #response",
          ExpressionAttributeNames: expressionNames(
            "#namespace", "#binding", "#state", "#lease", "#fence",
            "#leaseUntil", "#expiresAt", "#response",
          ),
          ExpressionAttributeValues: values,
          ReturnValues: "ALL_NEW",
        }, { signal }), input.signal);
        const fence = result.Attributes && integer(result.Attributes, "fence");
        if (!fence) throw new AgentCoreReplayError("uncertain");
        return { status: "claimed", leaseId, fence, leaseUntil: input.nowMs + input.leaseMs };
      } catch (error) {
        if (!conditional(error, config.client)) {
          if (error instanceof AgentCoreReplayError) throw error;
          throw new AgentCoreReplayError("uncertain");
        }
      }
      let current: Item | undefined;
      try {
        current = (await get(input.namespaceDigest, input.requestDigest, input.signal)).Item;
      } catch {
        throw new AgentCoreReplayError("uncertain");
      }
      if (!current) throw new AgentCoreReplayError("uncertain");
      if (text(current, "bindingDigest") !== input.bindingDigest) throw new AgentCoreReplayError("binding");
      const state = text(current, "state");
      if (state === "dispatched") return { status: "uncertain" };
      if (state === "completed") {
        const expiresAt = integer(current, "expiresAt");
        if (!expiresAt || expiresAt <= Math.floor(input.nowMs / 1_000)) return { status: "uncertain" };
        const serialized = text(current, "responseJson");
        if (!serialized || Buffer.byteLength(serialized, "utf8") > 262_144) throw new AgentCoreReplayError("uncertain");
        try {
          return { status: "completed", response: AgentCoreRuntimeResponseSchema.parse(JSON.parse(serialized)) };
        } catch {
          throw new AgentCoreReplayError("uncertain");
        }
      }
      const leaseUntil = integer(current, "leaseUntil");
      if (state === "claimed" && leaseUntil && leaseUntil > input.nowMs) {
        return { status: "busy", retryAfterMs: Math.max(1, leaseUntil - input.nowMs) };
      }
      throw new AgentCoreReplayError("uncertain");
    },
    async markDispatched(input) {
      const values = { ...ownedValues(input) } as Record<string, AttributeValue>;
      delete values[":expiresAt"];
      try {
        await call((signal) => config.client.updateItem({
          TableName: config.tableName,
          Key: key(input.namespaceDigest, input.requestDigest),
          ConditionExpression: "#binding = :binding AND #state = :claimed AND #lease = :lease AND #fence = :fence AND #leaseUntil > :now",
          UpdateExpression: "SET #state = :dispatched REMOVE #expiresAt",
          ExpressionAttributeNames: expressionNames(
            "#binding", "#state", "#lease", "#fence", "#leaseUntil", "#expiresAt",
          ),
          ExpressionAttributeValues: {
            ...values,
            ":claimed": { S: "claimed" },
            ":dispatched": { S: "dispatched" },
          },
          ReturnValues: "NONE",
        }, { signal }), input.signal);
      } catch (error) {
        if (conditional(error, config.client)) throw new AgentCoreReplayError("fenced");
        throw new AgentCoreReplayError("uncertain");
      }
    },
    async complete(input) {
      const responseJson = JSON.stringify(AgentCoreRuntimeResponseSchema.parse(input.response));
      if (Buffer.byteLength(responseJson, "utf8") > 262_144) throw new AgentCoreReplayError("invalid");
      const values = { ...ownedValues(input) } as Record<string, AttributeValue>;
      delete values[":now"];
      try {
        await call((signal) => config.client.updateItem({
          TableName: config.tableName,
          Key: key(input.namespaceDigest, input.requestDigest),
          ConditionExpression: "#binding = :binding AND #state = :dispatched AND #lease = :lease AND #fence = :fence",
          UpdateExpression: "SET #state = :completed, #response = :response, #expiresAt = :expiresAt REMOVE #leaseUntil",
          ExpressionAttributeNames: expressionNames(
            "#binding", "#state", "#lease", "#fence", "#response", "#expiresAt", "#leaseUntil",
          ),
          ExpressionAttributeValues: {
            ...values,
            ":dispatched": { S: "dispatched" },
            ":completed": { S: "completed" },
            ":response": { S: responseJson },
          },
          ReturnValues: "NONE",
        }, { signal }), input.signal);
      } catch (error) {
        if (conditional(error, config.client)) throw new AgentCoreReplayError("fenced");
        throw new AgentCoreReplayError("uncertain");
      }
    },
    async releaseClaim(input) {
      try {
        await call((signal) => config.client.updateItem({
          TableName: config.tableName,
          Key: key(input.namespaceDigest, input.requestDigest),
          ConditionExpression: "#binding = :binding AND #state = :claimed AND #lease = :lease AND #fence = :fence",
          UpdateExpression: "SET #state = :released, #leaseUntil = :now, #expiresAt = :expiresAt",
          ExpressionAttributeNames: expressionNames(
            "#binding", "#state", "#lease", "#fence", "#leaseUntil", "#expiresAt",
          ),
          ExpressionAttributeValues: {
            ...ownedValues(input),
            ":claimed": { S: "claimed" },
            ":released": { S: "released" },
          },
          ReturnValues: "NONE",
        }, { signal }), input.signal);
      } catch (error) {
        if (conditional(error, config.client)) throw new AgentCoreReplayError("fenced");
        throw new AgentCoreReplayError("uncertain");
      }
    },
  };
  return Object.freeze(store);
}
