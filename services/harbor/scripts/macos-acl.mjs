import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAC_ACL_HELPER_SOURCE = fileURLToPath(
  new URL("./macos-acl-inspect.rb", import.meta.url),
);

export function validateMacAclResult(result, policy) {
  const normalized = result.replace(/\n$/u, "");
  if (!["EMPTY", "DENY_ONLY", "ACCESS_GRANTING"].includes(normalized)) {
    throw new Error("UNSAFE_ACL");
  }
  if (
    normalized === "ACCESS_GRANTING" ||
    (policy === "private" && normalized !== "EMPTY")
  ) {
    throw new Error("UNSAFE_ACL");
  }
}

/** Shared native fd-based ACL inspector for every local private-file flow. */
export function assertMacAcl(path, policy) {
  if (process.platform !== "darwin") throw new Error("UNSUPPORTED_PLATFORM");
  const result = execFileSync("/usr/bin/ruby", [MAC_ACL_HELPER_SOURCE, path], {
    encoding: "utf8",
    env: { LC_ALL: "C", LANG: "C" },
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64,
  });
  validateMacAclResult(result, policy);
}

/** Inspect an already-open inode, including a mode-000 prepublication file. */
export function assertMacAclFd(descriptor, policy) {
  if (process.platform !== "darwin") throw new Error("UNSUPPORTED_PLATFORM");
  const result = execFileSync("/usr/bin/ruby", [MAC_ACL_HELPER_SOURCE, "--fd"], {
    encoding: "utf8",
    env: { LC_ALL: "C", LANG: "C" },
    stdio: ["ignore", "pipe", "ignore", descriptor],
    maxBuffer: 64,
  });
  validateMacAclResult(result, policy);
}
