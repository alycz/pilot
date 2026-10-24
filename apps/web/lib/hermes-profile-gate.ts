import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import {
  lstat,
  open,
  realpath,
} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";
import { HermesProfileRuntimeInvariantsSchema } from "./hermes-profile-contract";

export const PINNED_HERMES_VERSION = "0.22.2" as const;
export const PINNED_HERMES_COMMIT =
  "d923a5eb487a17c0a68801bba9ef0f56c81040a8" as const;

const SHA256_HEX = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const MANIFEST_MAX_BYTES = 32 * 1024;
const PROFILE_CONFIG_MAX_BYTES = 256 * 1024;
const MAC_ACL_HELPER_SHA256 =
  "dfdb31f4f890056f661372b0d3430e8649b1bcf22997e5380fee5ae016224e60";
const MAC_ACL_HELPER_MAX_BYTES = 64 * 1024;

const DisabledCapabilitiesSchema = z
  .object({
    toolsets: z.literal("disabled"),
    memory: z.literal("disabled"),
    skills: z.literal("disabled"),
    mcp: z.literal("disabled"),
    background: z.literal("disabled"),
    lazyInstall: z.literal("disabled"),
  })
  .strict();

export const HermesProfileManifestSchema = z
  .object({
    schemaVersion: z.literal("pilot.hermes-profile-manifest.v1"),
    hermesVersion: z.literal(PINNED_HERMES_VERSION),
    hermesCommit: z.literal(PINNED_HERMES_COMMIT),
    profile: z
      .string()
      .min(1)
      .max(64)
      .regex(SAFE_ID)
      .refine((value) => value !== "default", "A dedicated Hermes profile is required"),
    hermesOrigin: z.string().max(256),
    egressOrigin: z.string().max(256),
    provider: z.string().min(1).max(64).regex(SAFE_ID),
    model: z.string().min(1).max(128).regex(SAFE_MODEL),
    retentionDays: z.number().int().min(1).max(30),
    profileConfigPath: z.string().min(1).max(2_048),
    profileConfigSha256: z.string().regex(SHA256_HEX),
    capabilities: DisabledCapabilitiesSchema,
    runtimeInvariants: HermesProfileRuntimeInvariantsSchema,
  })
  .strict();

export type HermesProfileManifest = z.infer<typeof HermesProfileManifestSchema>;

export type HermesProfileGateInput = Readonly<{
  privateRoot: string;
  manifestPath: string;
  manifestSha256: string;
  profileConfigPath: string;
  expected: Readonly<{
    profile: string;
    hermesOrigin: string;
    egressOrigin: string;
    provider: string;
    model: string;
    retentionDays: number;
  }>;
}>;

type HermesProfileFileSnapshot = Readonly<{
  path: string;
  device: string;
  inode: string;
  size: number;
  modifiedNanoseconds: string;
  sha256: string;
}>;

export type HermesProfileGateSnapshot = Readonly<{
  manifest: Readonly<HermesProfileManifest>;
  manifestFile: HermesProfileFileSnapshot;
  profileConfigFile: HermesProfileFileSnapshot;
  input: HermesProfileGateInput;
}>;

type HermesAclInspector = (target: string) => void;

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Resolves only the reviewed helper bytes. Next bundles `new URL(...,
 * import.meta.url)` as a web asset, so the server launcher may provide an
 * absolute path; local source checkouts use one of the two fixed layouts.
 */
function aclHelperCandidates(): readonly string[] {
  const configured = process.env.PILOT_HERMES_ACL_HELPER_PATH;
  return configured
    ? [configured]
    : [
        path.resolve(process.cwd(), "scripts/macos-acl-inspect.rb"),
        path.resolve(process.cwd(), "../../scripts/macos-acl-inspect.rb"),
      ];
}

function hasSafeAclHelperParentChain(candidate: string): boolean {
  const expectedOwner = expectedOwnerId();
  let current = path.dirname(candidate);
  while (true) {
    const info = lstatSync(current, { bigint: true });
    if (
      !info.isDirectory() || info.isSymbolicLink() ||
      (info.mode & 0o022n) !== 0n ||
      (info.uid !== 0n &&
        (expectedOwner === undefined || info.uid !== BigInt(expectedOwner))) ||
      realpathSync(current) !== current
    ) return false;
    const parent = path.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

function openVerifiedHermesMacAclHelper(): number {
  for (const candidate of aclHelperCandidates()) {
    let descriptor: number | undefined;
    try {
      if (!path.isAbsolute(candidate) || path.resolve(candidate) !== candidate) continue;
      if (!hasSafeAclHelperParentChain(candidate)) continue;
      descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(descriptor, { bigint: true });
      const pathInfo = lstatSync(candidate, { bigint: true });
      const expectedOwner = expectedOwnerId();
      if (
        !info.isFile() || pathInfo.isSymbolicLink() || info.nlink !== 1n ||
        info.size > BigInt(MAC_ACL_HELPER_MAX_BYTES) ||
        (info.mode & 0o022n) !== 0n ||
        (expectedOwner !== undefined && info.uid !== BigInt(expectedOwner)) ||
        realpathSync(candidate) !== candidate ||
        pathInfo.dev !== info.dev || pathInfo.ino !== info.ino
      ) continue;
      const bytes = Buffer.alloc(Number(info.size));
      if (readSync(descriptor, bytes, 0, bytes.byteLength, 0) !== bytes.byteLength) continue;
      const after = fstatSync(descriptor, { bigint: true });
      if (
        sha256(bytes) === MAC_ACL_HELPER_SHA256 &&
        after.dev === info.dev && after.ino === info.ino &&
        after.size === info.size && after.mtimeNs === info.mtimeNs
      ) {
        const accepted = descriptor;
        descriptor = undefined;
        return accepted;
      }
    } catch {
      // Try the next fixed local source layout, then fail closed.
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  throw invalidGate();
}

function invalidGate(): Error {
  return new Error("Hermes immutable profile verification failed");
}

function aclHelperEnvironment(): NodeJS.ProcessEnv {
  return Object.assign(Object.create(null), {
    LC_ALL: "C",
    LANG: "C",
  }) as NodeJS.ProcessEnv;
}

/** Test-only view of the exact environment supplied to the native helper. */
export function hermesAclHelperEnvironmentForTest(): NodeJS.ProcessEnv {
  return aclHelperEnvironment();
}

export function validatePrivateMacAclResult(result: string): void {
  if (result.replace(/\n$/u, "") !== "EMPTY") throw invalidGate();
}

export function inspectHermesPrivateMacAcl(target: string): void {
  if (process.platform !== "darwin") throw invalidGate();
  const descriptor = openVerifiedHermesMacAclHelper();
  try {
    const result = execFileSync("/usr/bin/ruby", ["/dev/fd/3", target], {
      encoding: "utf8",
      // Do not expose the server environment (credentials, RUBYOPT, RUBYLIB,
      // or loader settings) to the native ACL helper.
      env: aclHelperEnvironment(),
      stdio: ["ignore", "pipe", "ignore", descriptor],
      maxBuffer: 64,
    });
    validatePrivateMacAclResult(result);
  } catch {
    throw invalidGate();
  } finally {
    closeSync(descriptor);
  }
}

function validatedLoopbackOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidGate();
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.port === ""
  ) {
    throw invalidGate();
  }
  return url.origin;
}

function resolvedAbsolutePath(value: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw invalidGate();
  }
  const resolved = path.resolve(value);
  if (resolved !== value) throw invalidGate();
  return resolved;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

function expectedOwnerId(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

async function assertPrivatePathChain(
  privateRoot: string,
  target: string,
  inspectAcl: HermesAclInspector,
): Promise<void> {
  const rootReal = await realpath(privateRoot).catch(() => {
    throw invalidGate();
  });
  if (rootReal !== privateRoot || !isWithin(privateRoot, target)) throw invalidGate();

  const relative = path.relative(privateRoot, target);
  const segments = relative.split(path.sep);
  let current = privateRoot;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const metadata = await lstat(current, { bigint: true }).catch(() => {
      throw invalidGate();
    });
    const isLast = index === segments.length - 1;
    if (metadata.isSymbolicLink() || (isLast ? !metadata.isFile() : !metadata.isDirectory())) {
      throw invalidGate();
    }
    const expectedOwner = expectedOwnerId();
    if (
      (expectedOwner !== undefined && metadata.uid !== BigInt(expectedOwner)) ||
      (metadata.mode & 0o077n) !== 0n ||
      (isLast && metadata.nlink !== 1n)
    ) {
      throw invalidGate();
    }
    inspectAcl(current);
  }

  const rootMetadata = await lstat(privateRoot, { bigint: true }).catch(() => {
    throw invalidGate();
  });
  const expectedOwner = expectedOwnerId();
  if (
    !rootMetadata.isDirectory() ||
    rootMetadata.isSymbolicLink() ||
    (expectedOwner !== undefined && rootMetadata.uid !== BigInt(expectedOwner)) ||
    (rootMetadata.mode & 0o077n) !== 0n
  ) {
    throw invalidGate();
  }
  inspectAcl(privateRoot);
}

async function readVerifiedFile(
  privateRoot: string,
  filePath: string,
  maxBytes: number,
  inspectAcl: HermesAclInspector,
): Promise<{ bytes: Uint8Array; snapshot: HermesProfileFileSnapshot }> {
  await assertPrivatePathChain(privateRoot, filePath, inspectAcl);
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw invalidGate();
  });
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes)) {
      throw invalidGate();
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(filePath, { bigint: true }).catch(() => {
      throw invalidGate();
    });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      pathAfter.isSymbolicLink() ||
      pathAfter.dev !== after.dev ||
      pathAfter.ino !== after.ino ||
      BigInt(bytes.byteLength) !== after.size
    ) {
      throw invalidGate();
    }
    return {
      bytes,
      snapshot: Object.freeze({
        path: filePath,
        device: after.dev.toString(),
        inode: after.ino.toString(),
        size: Number(after.size),
        modifiedNanoseconds: after.mtimeNs.toString(),
        sha256: sha256(bytes),
      }),
    };
  } finally {
    await handle.close();
  }
}

function validateInput(input: HermesProfileGateInput): HermesProfileGateInput {
  const privateRoot = resolvedAbsolutePath(input.privateRoot);
  const manifestPath = resolvedAbsolutePath(input.manifestPath);
  const profileConfigPath = resolvedAbsolutePath(input.profileConfigPath);
  if (
    !SHA256_HEX.test(input.manifestSha256) ||
    manifestPath === profileConfigPath ||
    !SAFE_ID.test(input.expected.profile) ||
    input.expected.profile === "default" ||
    !SAFE_ID.test(input.expected.provider) ||
    !SAFE_MODEL.test(input.expected.model) ||
    !Number.isInteger(input.expected.retentionDays) ||
    input.expected.retentionDays < 1 ||
    input.expected.retentionDays > 30
  ) {
    throw invalidGate();
  }
  validatedLoopbackOrigin(input.expected.hermesOrigin);
  validatedLoopbackOrigin(input.expected.egressOrigin);
  if (new URL(input.expected.hermesOrigin).port === new URL(input.expected.egressOrigin).port) {
    throw invalidGate();
  }
  return Object.freeze({
    privateRoot,
    manifestPath,
    manifestSha256: input.manifestSha256,
    profileConfigPath,
    expected: Object.freeze({ ...input.expected }),
  });
}

/**
 * Verifies the on-disk inputs for Pilot's dedicated Hermes profile.
 *
 * The returned snapshot supports a second comparison after a proposal. This
 * detects file replacement during a call, but it does not attest or freeze the
 * already-running Hermes process; activation still requires a dedicated
 * operationally immutable process and zero-tool runtime observation.
 */
async function verifyHermesProfileGateUsing(
  rawInput: HermesProfileGateInput,
  inspectAcl: HermesAclInspector,
): Promise<HermesProfileGateSnapshot> {
  const input = validateInput(rawInput);
  const manifestFile = await readVerifiedFile(
    input.privateRoot,
    input.manifestPath,
    MANIFEST_MAX_BYTES,
    inspectAcl,
  );
  if (manifestFile.snapshot.sha256 !== input.manifestSha256) throw invalidGate();

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestFile.bytes));
  } catch {
    throw invalidGate();
  }
  const parsed = HermesProfileManifestSchema.safeParse(manifestJson);
  if (!parsed.success) throw invalidGate();
  const manifest = parsed.data;

  if (
    manifest.profileConfigPath !== input.profileConfigPath ||
    manifest.profile !== input.expected.profile ||
    validatedLoopbackOrigin(manifest.hermesOrigin) !==
      validatedLoopbackOrigin(input.expected.hermesOrigin) ||
    validatedLoopbackOrigin(manifest.egressOrigin) !==
      validatedLoopbackOrigin(input.expected.egressOrigin) ||
    manifest.provider !== input.expected.provider ||
    manifest.model !== input.expected.model ||
    manifest.retentionDays !== input.expected.retentionDays
  ) {
    throw invalidGate();
  }

  const profileConfigFile = await readVerifiedFile(
    input.privateRoot,
    input.profileConfigPath,
    PROFILE_CONFIG_MAX_BYTES,
    inspectAcl,
  );
  if (profileConfigFile.snapshot.sha256 !== manifest.profileConfigSha256) throw invalidGate();

  return Object.freeze({
    manifest: Object.freeze({
      ...manifest,
      capabilities: Object.freeze({ ...manifest.capabilities }),
      runtimeInvariants: Object.freeze({ ...manifest.runtimeInvariants }),
    }),
    manifestFile: manifestFile.snapshot,
    profileConfigFile: profileConfigFile.snapshot,
    input,
  });
}

export async function verifyHermesProfileGate(
  rawInput: HermesProfileGateInput,
): Promise<HermesProfileGateSnapshot> {
  return verifyHermesProfileGateUsing(rawInput, inspectHermesPrivateMacAcl);
}

/** Test-only structural verifier. Runtime code must call verifyHermesProfileGate. */
export async function verifyHermesProfileGateWithAclInspectorForTest(
  rawInput: HermesProfileGateInput,
  inspectAcl: HermesAclInspector,
): Promise<HermesProfileGateSnapshot> {
  return verifyHermesProfileGateUsing(rawInput, inspectAcl);
}

function sameFileSnapshot(
  left: HermesProfileFileSnapshot,
  right: HermesProfileFileSnapshot,
): boolean {
  return left.path === right.path &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedNanoseconds === right.modifiedNanoseconds &&
    left.sha256 === right.sha256;
}

export async function assertHermesProfileGateUnchanged(
  snapshot: HermesProfileGateSnapshot,
): Promise<void> {
  const current = await verifyHermesProfileGate(snapshot.input);
  if (
    !sameFileSnapshot(snapshot.manifestFile, current.manifestFile) ||
    !sameFileSnapshot(snapshot.profileConfigFile, current.profileConfigFile)
  ) {
    throw invalidGate();
  }
}

/** Test-only structural revalidation. Runtime code must use assertHermesProfileGateUnchanged. */
export async function assertHermesProfileGateUnchangedWithAclInspectorForTest(
  snapshot: HermesProfileGateSnapshot,
  inspectAcl: HermesAclInspector,
): Promise<void> {
  const current = await verifyHermesProfileGateUsing(snapshot.input, inspectAcl);
  if (
    !sameFileSnapshot(snapshot.manifestFile, current.manifestFile) ||
    !sameFileSnapshot(snapshot.profileConfigFile, current.profileConfigFile)
  ) {
    throw invalidGate();
  }
}
