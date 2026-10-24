import type { Metadata } from "next";
import React from "react";

import { WorkAgreementFixtureViewComponent } from "../../components/agreements/work-agreement-fixture-view";

export const metadata: Metadata = {
  title: "Offline escrow work agreement",
  description: "A default-off deterministic fixture for owner-reviewed XRPL escrow lifecycle states.",
};

export default function WorkAgreementFixturePage() {
  return <WorkAgreementFixtureViewComponent />;
}
