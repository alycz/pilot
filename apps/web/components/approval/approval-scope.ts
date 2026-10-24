const ACCOUNT_SCOPE_CHANGED =
  "This approval was cancelled because the wallet account or session changed. Nothing was submitted.";

/**
 * Fail-closed boundary for owner submission. A keyed ChatView instance owns
 * one scope and invalidates it during account/session teardown, before wallet
 * cleanup. A wallet prompt that resolves late therefore cannot submit from an
 * unmounted account context.
 */
export class ApprovalSubmissionScope {
  private active = true;

  invalidate(): void {
    this.active = false;
  }

  assertActive(): void {
    if (!this.active) throw new Error(ACCOUNT_SCOPE_CHANGED);
  }

  async submit<T>(operation: () => Promise<T>): Promise<T> {
    this.assertActive();
    return operation();
  }
}

export async function signAndSubmitWithinScope<T>(input: {
  scope: ApprovalSubmissionScope;
  sign: () => Promise<string>;
  submit: (txBlob: string) => Promise<T>;
}): Promise<T> {
  const txBlob = await input.sign();
  return input.scope.submit(() => input.submit(txBlob));
}
