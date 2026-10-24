export type IntegrationSlug = "mastercard" | "aws" | "quicknode" | "ledger";

export type IntegrationTone = "success" | "approval" | "blocked" | "degraded";

export type IntegrationZone = {
  id: string;
  label: string;
  detail: string;
};

export type IntegrationNode = {
  id: string;
  label: string;
  shortLabel: string;
  zone: string;
  detail: string;
};

export type IntegrationStep = {
  nodeId: string;
  title: string;
  body: string;
  input: string;
  output: string;
  status: string;
  crossesBoundary?: string;
};

export type IntegrationScenario = {
  id: string;
  label: string;
  tone: IntegrationTone;
  summary: string;
  steps: readonly IntegrationStep[];
};

export type IntegrationBoundary = {
  title: string;
  body: string;
};

export type IntegrationSource = {
  label: string;
  path: string;
};

export type IntegrationExplainer = {
  slug: IntegrationSlug;
  name: string;
  eyebrow: string;
  headline: string;
  summary: string;
  status: string;
  truthLabel: string;
  what: string;
  why: string;
  accent: "coral" | "orange" | "blue" | "graphite";
  zones: readonly IntegrationZone[];
  nodes: readonly IntegrationNode[];
  scenarios: readonly IntegrationScenario[];
  boundaries: readonly IntegrationBoundary[];
  enhancements: readonly string[];
  demonstrates: readonly string[];
  doesNotDemonstrate: readonly string[];
  sources: readonly IntegrationSource[];
};
