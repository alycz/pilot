import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, resolve, sep } from "node:path";

export type AgentCoreIdentityApprovalClaim = Readonly<{
  runId: string;
  approvedAt: string;
}>;

export interface AgentCoreIdentityApprovalJournal {
  consume(claim: AgentCoreIdentityApprovalClaim): Promise<void>;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function currentUserId(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("AgentCore approval journal requires filesystem ownership checks");
  return uid;
}

function assertClaim(claim: AgentCoreIdentityApprovalClaim): void {
  if (!UUID_V4.test(claim.runId)) {
    throw new Error("AgentCore approval journal run ID must be a UUID v4");
  }
  const approvedAt = Date.parse(claim.approvedAt);
  if (!Number.isFinite(approvedAt) || new Date(approvedAt).toISOString() !== claim.approvedAt) {
    throw new Error("AgentCore approval journal timestamp must be canonical UTC");
  }
}

async function assertSafeDirectoryChain(root: string, uid: number, exactLeaf: boolean): Promise<void> {
  const parsed = parse(root);
  let current = parsed.root;
  const segments = root.slice(parsed.root.length).split(sep).filter(Boolean);
  const paths = [current];
  for (const segment of segments) {
    current = join(current, segment);
    paths.push(current);
  }

  for (const path of paths) {
    const stat = await lstat(path);
    const leaf = path === root;
    const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("AgentCore approval journal path is unsafe");
    }
    if (stat.uid !== 0 && stat.uid !== uid) {
      throw new Error("AgentCore approval journal path ownership is unsafe");
    }
    if (
      (leaf && exactLeaf && (stat.uid !== uid || mode !== 0o700)) ||
      ((!leaf || !exactLeaf) && (mode & 0o022) !== 0)
    ) {
      throw new Error("AgentCore approval journal path permissions are unsafe");
    }
  }
  if (await realpath(root) !== root) {
    throw new Error("AgentCore approval journal root must be canonical");
  }
}

async function prepareRoot(root: string): Promise<number> {
  const uid = currentUserId();
  const parent = resolve(root, "..");
  await assertSafeDirectoryChain(parent, uid, false);
  try {
    await mkdir(root, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  await assertSafeDirectoryChain(root, uid, true);
  return uid;
}

/**
 * Consume one approval capability before any live transport. The O_EXCL claim
 * file is the durable boundary: once creation succeeds it is never removed,
 * even if a later write or fsync is ambiguous.
 */
export function createFileAgentCoreIdentityApprovalJournal(input: Readonly<{
  root: string;
}>): AgentCoreIdentityApprovalJournal {
  if (!isAbsolute(input.root) || resolve(input.root) !== input.root || input.root === parse(input.root).root) {
    throw new Error("AgentCore approval journal root must be an exact absolute directory");
  }
  const root = input.root;
  return Object.freeze({
    async consume(claim: AgentCoreIdentityApprovalClaim): Promise<void> {
      assertClaim(claim);
      const uid = await prepareRoot(root);
      const canonicalRunId = claim.runId.toLowerCase();
      const claimPath = join(root, `${canonicalRunId}.claim.json`);
      let handle;
      try {
        handle = await open(
          claimPath,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          throw new Error("AgentCore identity acceptance approval was already consumed");
        }
        throw new Error("AgentCore identity acceptance approval could not be consumed");
      }

      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) {
          throw new Error("AgentCore approval claim file is unsafe");
        }
        const record = `${JSON.stringify({
          schemaVersion: 1,
          runId: canonicalRunId,
          approvedAt: claim.approvedAt,
          state: "consumed",
        })}\n`;
        if (Buffer.byteLength(record, "utf8") > 512) {
          throw new Error("AgentCore approval claim record is oversized");
        }
        await handle.writeFile(record, { encoding: "utf8" });
        await handle.sync();
      } finally {
        await handle.close().catch(() => undefined);
      }

      const directory = await open(
        root,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close().catch(() => undefined);
      }
    },
  });
}
