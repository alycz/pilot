import { GuardError } from "./error";

const SENSITIVE_FRAGMENT = /seed|secret|private|mnemonic/i;

function rejectSensitiveText(value: string, location: string): void {
  if (SENSITIVE_FRAGMENT.test(value)) {
    throw new GuardError(
      `Sensitive material is not accepted (${location})`,
      "SENSITIVE_INPUT",
    );
  }
}

export function assertSafeCode(code: string): void {
  rejectSensitiveText(code, "code");
}

export function assertSafeArguments(value: unknown): void {
  const visited = new WeakSet<object>();

  function visit(candidate: unknown, path: string): void {
    if (typeof candidate === "string") {
      rejectSensitiveText(candidate, path);
      return;
    }
    if (candidate === null || typeof candidate !== "object") {
      return;
    }
    if (visited.has(candidate)) {
      return;
    }
    visited.add(candidate);

    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }

    for (const [key, entry] of Object.entries(candidate)) {
      rejectSensitiveText(key, `${path} key`);
      visit(entry, `${path}.${key}`);
    }
  }

  visit(value, "arguments");
}

export function containsSensitiveFragment(value: string): boolean {
  return SENSITIVE_FRAGMENT.test(value);
}
