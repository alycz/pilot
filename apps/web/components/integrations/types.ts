export type IntegrationSlug = "mastercard" | "aws" | "quicknode" | "ledger";
export type IntegrationLinkSlug = IntegrationSlug | "near-intents";

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

/** Icons the plain-language diagram can draw for an actor. */
export type StoryIcon =
  | "user"
  | "wallet"
  | "pilot"
  | "harbor"
  | "ledger"
  | "store"
  | "scan"
  | "cpu"
  | "key"
  | "radio"
  | "server"
  | "device";

export type StoryActor = {
  id: string;
  label: string;
  /** Two to four words under the label. */
  role: string;
  icon: StoryIcon;
  /** Position on the diagram, in percent of its width and height. */
  x: number;
  y: number;
};

export type StoryStep = {
  /** One or two words for the step bar. */
  label: string;
  title: string;
  /** One or two plain sentences. */
  caption: string;
  /** Actors the message travels through, in order. One actor = it stays there. */
  route: readonly string[];
  /** What is handed over at this step, in a few words. */
  carries?: string;
  outcome?: "ok" | "wait" | "stop";
};

export type StoryFlow = {
  id: string;
  label: string;
  tone: IntegrationTone;
  /** The value this outcome shows, in one sentence. */
  takeaway: string;
  steps: readonly StoryStep[];
};

/**
 * The plain-language layer each integration page leads with. The detailed
 * IntegrationExplainer stays as the technical reference below it.
 */
export type IntegrationStory = {
  title: string;
  lede: string;
  glance: { adds: string; control: string; status: string };
  idea: { without: string; with: string; never: string };
  actors: readonly StoryActor[];
  flows: readonly StoryFlow[];
};
