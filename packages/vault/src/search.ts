import matter from "gray-matter";
import MiniSearch from "minisearch";

import type { VaultBackend, VaultSearchResult } from "./types";

type IndexedNote = {
  id: string;
  path: string;
  title: string;
  text: string;
  tags: string;
  frontmatter: Record<string, unknown>;
};

function titleFor(path: string, content: string, data: Record<string, unknown>): string {
  if (typeof data.name === "string" && data.name.trim()) return data.name;
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || path.split("/").at(-1)?.replace(/\.md$/i, "") || path;
}

function searchableMetadata(data: Record<string, unknown>): string {
  return Object.entries(data)
    .filter(([, value]) => typeof value !== "object" || value === null || Array.isArray(value))
    .map(([key, value]) => `${key} ${Array.isArray(value) ? value.join(" ") : String(value)}`)
    .join(" ");
}

function excerpt(text: string): string {
  return text
    .replace(/^#.+$/gm, "")
    .replace(/\[\[|\]\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

export class VaultSearchIndex {
  private index = this.newIndex();

  private newIndex(): MiniSearch<IndexedNote> {
    return new MiniSearch<IndexedNote>({
      fields: ["title", "path", "text", "tags"],
      storeFields: ["path", "title", "text", "frontmatter"],
      searchOptions: {
        boost: { title: 4, path: 2, tags: 2 },
        prefix: true,
        fuzzy: 0.2,
      },
    });
  }

  async rebuild(backend: VaultBackend): Promise<void> {
    const next = this.newIndex();
    const paths = (await backend.list("Pilot")).filter((path) => path.endsWith(".md"));
    const notes = await Promise.all(
      paths.map(async (path): Promise<IndexedNote | null> => {
        const raw = await backend.read(path);
        if (raw === null) return null;
        const parsed = matter(raw);
        const data = parsed.data as Record<string, unknown>;
        return {
          id: path,
          path,
          title: titleFor(path, parsed.content, data),
          text: parsed.content,
          tags: searchableMetadata(data),
          frontmatter: data,
        };
      }),
    );
    next.addAll(notes.filter((note): note is IndexedNote => note !== null));
    this.index = next;
  }

  search(query: string, limit = 10): VaultSearchResult[] {
    const normalized = query.trim();
    if (!normalized) return [];
    return this.index.search(normalized).slice(0, Math.max(0, limit)).map((hit) => ({
      path: String(hit.path),
      title: String(hit.title),
      excerpt: excerpt(String(hit.text)),
      score: hit.score,
      frontmatter: (hit.frontmatter ?? {}) as Record<string, unknown>,
    }));
  }
}
