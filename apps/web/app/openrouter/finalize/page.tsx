"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

export default function OpenRouterFinalizePage() {
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/auth/openrouter/finalize", {
      method: "POST",
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        const result = await response.json() as { returnTo?: string };
        if (!response.ok || !result.returnTo) {
          throw new Error("The wallet-bound OpenRouter session could not be finalized.");
        }
        window.location.replace(result.returnTo);
      })
      .catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) {
          setError("OpenRouter connected, but Pilot could not verify the original wallet session. Please reconnect from onboarding.");
        }
      });
    return () => controller.abort();
  }, []);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 px-6">
      <p className="label-mono">OpenRouter</p>
      <h1 className="text-2xl font-semibold font-display">Finalizing the wallet-bound session</h1>
      {error ? (
        <>
          <p role="alert" className="text-sm leading-6 text-destructive">{error}</p>
          <Link className="font-mono text-sm underline" href="/onboarding">Return to onboarding</Link>
        </>
      ) : (
        <p role="status" className="text-sm leading-6 text-muted-foreground">Verifying the same wallet without sending anything to the ledger…</p>
      )}
    </main>
  );
}
