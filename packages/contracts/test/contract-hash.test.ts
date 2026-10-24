import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const contractSourcePath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const contractHashPath = fileURLToPath(new URL("../CONTRACT_HASH", import.meta.url));
it("matches the byte-for-byte Harbor contract source", async () => {
  const [contractSource, recordedHashFile] = await Promise.all([
    readFile(contractSourcePath),
    readFile(contractHashPath, "utf8"),
  ]);
  const recordedHash = recordedHashFile.trim();

  expect(recordedHash).toMatch(/^[a-f0-9]{64}$/);
  expect(createHash("sha256").update(contractSource).digest("hex")).toBe(recordedHash);
});
