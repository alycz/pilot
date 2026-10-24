import { describe, expect, it, vi } from "vitest";

import {
  ApprovalSubmissionScope,
  signAndSubmitWithinScope,
} from "./approval-scope";

describe("ApprovalSubmissionScope", () => {
  it("submits while the owning account scope is active", async () => {
    const scope = new ApprovalSubmissionScope();
    const submit = vi.fn(async () => "validated");

    await expect(signAndSubmitWithinScope({
      scope,
      sign: async () => "signed-blob",
      submit,
    })).resolves.toBe("validated");
    expect(submit).toHaveBeenCalledWith("signed-blob");
  });

  it("does not submit when logout or account switch happens during signing", async () => {
    const scope = new ApprovalSubmissionScope();
    let finishSigning!: (txBlob: string) => void;
    const signing = new Promise<string>((resolve) => { finishSigning = resolve; });
    const submit = vi.fn(async () => "validated");
    const attempt = signAndSubmitWithinScope({
      scope,
      sign: () => signing,
      submit,
    });

    scope.invalidate();
    finishSigning("old-account-signed-blob");

    await expect(attempt).rejects.toThrow("wallet account or session changed");
    expect(submit).not.toHaveBeenCalled();
  });
});
