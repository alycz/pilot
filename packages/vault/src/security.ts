const SENSITIVE_FIELD = /(?:^|\n)\s*(?:[-*]\s*)?(?:seed|secret|private[_ -]?key|mnemonic)\s*[:=]/i;
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:EC |RSA )?PRIVATE KEY-----/i;
const XRPL_FAMILY_SEED = /\bs(?:Ed)?[1-9A-HJ-NP-Za-km-z]{20,}\b/;

/** Reject common credential forms before any vault backend can persist them. */
export function assertNoSensitiveContent(content: string): void {
  if (
    SENSITIVE_FIELD.test(content) ||
    PRIVATE_KEY_BLOCK.test(content) ||
    XRPL_FAMILY_SEED.test(content)
  ) {
    throw new Error("Vault content cannot contain seeds, secrets, private keys, or mnemonics");
  }
}
