import type { Metadata } from "next";
import React from "react";

import { WorkAgreementFixtureViewComponent } from "../../components/agreements/work-agreement-fixture-view";
import { WorkAgreementWorkspace } from "../../components/agreements/work-agreement-workspace";

export const metadata: Metadata = {
  title: "Ledger work agreements",
  description: "Durable, owner-reviewed XRPL Testnet escrow agreements with exact Ledger signing.",
};

type WorkAgreementPageProps = Readonly<{
  searchParams?: Promise<Readonly<{ demo?: string }>>;
}>;

export default async function WorkAgreementPage({ searchParams }: WorkAgreementPageProps = {}) {
  const params: Readonly<{ demo?: string }> = await (
    searchParams ?? Promise.resolve({} as Readonly<{ demo?: string }>)
  );
  return params.demo === "recorded"
    ? <WorkAgreementFixtureViewComponent />
    : <WorkAgreementWorkspace />;
}
