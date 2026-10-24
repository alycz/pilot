import MiniSearch from "minisearch";
import { z } from "zod";

import { CaveatSchema, type Caveat, type Venue } from "../contracts";

export type OpContext = {
  principal: string;
  [key: string]: unknown;
};

export type OpDef<
  TArgs extends z.ZodTypeAny = z.ZodTypeAny,
  TResult = unknown,
> = {
  name: string;
  family: string;
  summary: string;
  tags?: readonly string[];
  args: TArgs;
  returns: string;
  caveats: readonly Caveat[];
  example: string;
  handler: (
    ctx: OpContext,
    args: z.infer<TArgs>,
  ) => TResult | Promise<TResult>;
};

type AnyOpDef = OpDef<any, any>;

export type CatalogDocument = {
  id: string;
  kind: "venue" | "playbook";
  name: string;
  summary: string;
  family?: string;
  tags?: readonly string[];
  content?: string;
  signature: string;
  example: string;
};

export type CatalogManifestInput = {
  venues?: readonly Venue[];
  ecosystemSkills?: {
    playbooks?: readonly {
      id: string;
      name: string;
      summary: string;
      content: string;
    }[];
  };
};

export type CatalogSearchResult = {
  id: string;
  kind: "op" | CatalogDocument["kind"];
  name: string;
  family: string;
  summary: string;
  tags: string[];
  signature: string;
  example: string;
  score: number;
};

type SearchDocument = Omit<CatalogSearchResult, "score"> & { content: string };

const OP_NAME_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-zA-Z0-9-]*)+$/;

function schemaArgumentList(schema: z.ZodTypeAny): string {
  if (!(schema instanceof z.ZodObject)) {
    return "args";
  }

  return Object.entries(schema.shape)
    .map(([name, field]) => {
      const optional =
        typeof (field as z.ZodTypeAny).isOptional === "function" &&
        (field as z.ZodTypeAny).isOptional();
      return `${name}${optional ? "?" : ""}`;
    })
    .join(", ");
}

export function opSignature(op: AnyOpDef): string {
  const fields = schemaArgumentList(op.args);
  return `${op.name}(${fields ? `{ ${fields} }` : ""}) → ${op.returns}`;
}

function opToSearchDocument(op: AnyOpDef): SearchDocument {
  return {
    id: `op:${op.name}`,
    kind: "op",
    name: op.name,
    family: op.family,
    summary: op.summary,
    tags: [...(op.tags ?? [])],
    content: "",
    signature: opSignature(op),
    example: op.example,
  };
}

function catalogToSearchDocument(document: CatalogDocument): SearchDocument {
  return {
    id: `${document.kind}:${document.id}`,
    kind: document.kind,
    name: document.name,
    family: document.family ?? document.kind,
    summary: document.summary,
    tags: [...(document.tags ?? [])],
    content: document.content ?? "",
    signature: document.signature,
    example: document.example,
  };
}

function createSearchIndex(documents: readonly SearchDocument[]) {
  const index = new MiniSearch<SearchDocument>({
    fields: ["name", "family", "summary", "tags", "content"],
    storeFields: [
      "id",
      "kind",
      "name",
      "family",
      "summary",
      "tags",
      "signature",
      "example",
    ],
    searchOptions: {
      boost: { name: 8, family: 5, tags: 3, summary: 1 },
      prefix: true,
      fuzzy: 0.2,
    },
  });
  index.addAll([...documents]);
  return index;
}

export class OpRegistry {
  readonly #ops = new Map<string, AnyOpDef>();
  #catalogDocuments: CatalogDocument[] = [];
  #searchDocuments: SearchDocument[] = [];
  #searchIndex = createSearchIndex([]);

  constructor(ops: readonly AnyOpDef[] = []) {
    this.register(ops);
  }

  register(ops: AnyOpDef | readonly AnyOpDef[]): this {
    const definitions = Array.isArray(ops) ? ops : [ops];
    const pending = new Set<string>();

    for (const definition of definitions) {
      this.#assertDefinition(definition);
      if (this.#ops.has(definition.name) || pending.has(definition.name)) {
        throw new Error(`Operation already registered: ${definition.name}`);
      }
      pending.add(definition.name);
    }

    for (const definition of definitions) {
      this.#ops.set(definition.name, definition);
    }
    this.#rebuildSearchIndex();
    return this;
  }

  get(name: string): AnyOpDef | undefined {
    return this.#ops.get(name);
  }

  require(name: string): AnyOpDef {
    const op = this.get(name);
    if (!op) {
      throw new Error(`Unknown operation: ${name}`);
    }
    return op;
  }

  list(): readonly AnyOpDef[] {
    return Object.freeze(
      [...this.#ops.values()].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    );
  }

  setCatalogDocuments(documents: readonly CatalogDocument[]): this {
    const ids = new Set<string>();
    for (const document of documents) {
      const id = `${document.kind}:${document.id}`;
      if (ids.has(id)) {
        throw new Error(`Catalog document already registered: ${id}`);
      }
      ids.add(id);
    }
    this.#catalogDocuments = [...documents];
    this.#rebuildSearchIndex();
    return this;
  }

  loadCatalogManifest(manifest: CatalogManifestInput): this {
    return this.setCatalogDocuments(catalogDocumentsFromManifest(manifest));
  }

  search(query: string, limit = 8): CatalogSearchResult[] {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery || limit <= 0) {
      return [];
    }

    const ranked = new Map<string, CatalogSearchResult>();
    for (const hit of this.#searchIndex.search(query)) {
      const document = this.#searchDocuments.find(({ id }) => id === hit.id);
      if (!document) continue;
      const { content: _content, ...result } = document;
      ranked.set(document.id, { ...result, score: hit.score });
    }

    // MiniSearch tokenizes dotted names. Add exact matches explicitly so an
    // operation name or family always outranks a merely relevant description.
    for (const document of this.#searchDocuments) {
      const exactName = document.name.toLocaleLowerCase() === normalizedQuery;
      const exactFamily =
        document.family.toLocaleLowerCase() === normalizedQuery;
      if (!exactName && !exactFamily) continue;

      const current = ranked.get(document.id);
      const { content: _content, ...result } = document;
      ranked.set(document.id, {
        ...result,
        score: (current?.score ?? 0) + (exactName ? 10_000 : 5_000),
      });
    }

    return [...ranked.values()]
      .sort(
        (left, right) =>
          right.score - left.score || left.name.localeCompare(right.name),
      )
      .slice(0, Math.min(8, limit));
  }

  #assertDefinition(definition: AnyOpDef): void {
    if (
      typeof definition.name !== "string" ||
      typeof definition.family !== "string"
    ) {
      throw new Error("Operation name and family must be strings");
    }
    if (!OP_NAME_PATTERN.test(definition.name)) {
      throw new Error(`Invalid operation name: ${definition.name}`);
    }
    if (definition.name.split(".", 1)[0] !== definition.family) {
      throw new Error(
        `Operation ${definition.name} does not belong to family ${definition.family}`,
      );
    }
    if (
      typeof definition.summary !== "string" ||
      typeof definition.returns !== "string" ||
      !definition.summary.trim() ||
      !definition.returns.trim()
    ) {
      throw new Error(`Operation ${definition.name} has incomplete metadata`);
    }
    if (typeof definition.example !== "string" || !definition.example.trim()) {
      throw new Error(`Operation ${definition.name} needs an example`);
    }
    if (
      definition.tags !== undefined &&
      (!Array.isArray(definition.tags) ||
        !definition.tags.every((tag: unknown) => typeof tag === "string"))
    ) {
      throw new Error(`Operation ${definition.name} has invalid tags`);
    }
    if (
      !Array.isArray(definition.caveats) ||
      !definition.caveats.every((caveat: unknown) =>
        CaveatSchema.safeParse(caveat).success,
      )
    ) {
      throw new Error(`Operation ${definition.name} has invalid caveats`);
    }
    if (
      definition.args === null ||
      typeof definition.args !== "object" ||
      typeof definition.args.safeParse !== "function"
    ) {
      throw new Error(`Operation ${definition.name} has an invalid args schema`);
    }
    if (typeof definition.handler !== "function") {
      throw new Error(`Operation ${definition.name} has an invalid handler`);
    }
  }

  #rebuildSearchIndex(): void {
    this.#searchDocuments = [
      ...[...this.#ops.values()].map(opToSearchDocument),
      ...this.#catalogDocuments.map(catalogToSearchDocument),
    ];
    this.#searchIndex = createSearchIndex(this.#searchDocuments);
  }
}

export function catalogDocumentsFromManifest(
  manifest: CatalogManifestInput,
): CatalogDocument[] {
  const venues = (manifest.venues ?? []).map((venue): CatalogDocument => ({
    id: venue.id,
    kind: "venue",
    name: venue.name,
    family: "venues",
    summary: `${venue.layer} ${venue.kind}: ${venue.category.join(", ")}`,
    tags: [venue.layer, venue.kind, ...venue.category],
    content: [
      ...venue.reads,
      ...venue.risks,
      ...Object.entries(venue.status).map(
        ([network, status]) => `${network} ${status}`,
      ),
    ].join(" "),
    signature: `venues.get({ id: "${venue.id}" }) → venue details`,
    example: `await harbor.venues.get({ id: "${venue.id}" })`,
  }));
  const playbooks = (manifest.ecosystemSkills?.playbooks ?? []).map(
    (playbook): CatalogDocument => ({
      id: playbook.id,
      kind: "playbook",
      name: playbook.name,
      family: "skill",
      summary: playbook.summary,
      tags: ["playbook"],
      content: playbook.content,
      signature: `skill.read({ id: "${playbook.id}" }) → playbook`,
      example: `await harbor.skill.read({ id: "${playbook.id}" })`,
    }),
  );
  return [...venues, ...playbooks];
}

export const registry = new OpRegistry();

export function registerOps(ops: readonly AnyOpDef[]): void {
  registry.register(ops);
}

export function getOp(name: string): AnyOpDef | undefined {
  return registry.get(name);
}

export function listOps(): readonly AnyOpDef[] {
  return registry.list();
}

export function search(query: string): CatalogSearchResult[] {
  return registry.search(query);
}
