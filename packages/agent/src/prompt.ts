import { readFile } from "node:fs/promises";

let promptPromise: Promise<string> | undefined;

/** Load the canonical server-side prompt shipped with the agent package. */
export function loadSystemPrompt(): Promise<string> {
  promptPromise ??= readFile(new URL("../prompt.md", import.meta.url), "utf8").then(
    (prompt) => prompt.trim(),
  );
  return promptPromise;
}
