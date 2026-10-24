/**
 * Script for the landing page's animated learning-loop diagram.
 *
 * One synthetic message travels through Pilot's real path: chat → model →
 * the engine (Harbor) → XRPL → vault → learning → next turn. Learning and the
 * Hermes second opinion are shown switched on. Every step maps to code in
 * apps/web/app/api/chat/handler.ts, packages/agent and packages/vault.
 * Nothing here calls a server, wallet or ledger.
 */

export type LoopNodeId = "you" | "pilot" | "model" | "harbor" | "ledger" | "vault" | "hermes";

export type LoopNode = {
  id: LoopNodeId;
  label: string;
  role: string;
  /** Position inside the square diagram, in percent. */
  x: number;
  y: number;
  optional?: boolean;
};

/** Pilot sits in the middle: every hop between the other parts goes through it. */
export const loopNodes: readonly LoopNode[] = [
  { id: "pilot", label: "Workspace", role: "Runs the conversation", x: 50, y: 50 },
  { id: "you", label: "You", role: "Ask, sign, review", x: 13, y: 50 },
  { id: "model", label: "AI model", role: "Your chosen model", x: 50, y: 12 },
  { id: "harbor", label: "Engine", role: "Builds, checks limits", x: 87, y: 50 },
  { id: "ledger", label: "XRP Ledger", role: "Confirms trades", x: 70, y: 87 },
  { id: "vault", label: "Your vault", role: "Notes and memory", x: 30, y: 87 },
  { id: "hermes", label: "Hermes", role: "Second opinion", x: 84, y: 14 },
];

/** Links drawn in the diagram. */
export const loopLinks: readonly [LoopNodeId, LoopNodeId][] = [
  ["pilot", "you"],
  ["pilot", "model"],
  ["pilot", "harbor"],
  ["pilot", "ledger"],
  ["pilot", "vault"],
  ["harbor", "ledger"],
  ["pilot", "hermes"],
];

export type LoopBranch = "approval" | "auto" | "blocked";

export const branchOptions: readonly { id: LoopBranch; label: string; short: string; hint: string }[] = [
  { id: "approval", label: "Needs your signature", short: "You sign", hint: "$500 swap, over the $250 auto limit" },
  { id: "auto", label: "Runs automatically", short: "Automatic", hint: "$120 swap, under the $250 auto limit" },
  { id: "blocked", label: "Blocked", short: "Blocked", hint: "Swap into an unapproved token" },
];

export type ArtifactKind =
  | "ask"
  | "checks"
  | "tools"
  | "lookup"
  | "propose"
  | "policy"
  | "sign"
  | "auto"
  | "blocked"
  | "ledger"
  | "record"
  | "learn"
  | "review"
  | "next";

export type LoopScene = {
  id: string;
  label: string;
  title: string;
  caption: string;
  /** Nodes the message travels through, in order. One node = it stays there. */
  route: readonly LoopNodeId[];
  artifact: ArtifactKind;
  /** Total time on screen at normal speed. */
  ms: number;
};

const ask: LoopScene = {
  id: "ask",
  label: "Ask",
  title: "You send a message",
  caption: "You ask Pilot for a swap and mention how you like answers. That second part is what Pilot can learn from.",
  route: ["you", "pilot"],
  artifact: "ask",
  ms: 2800,
};

const checks: LoopScene = {
  id: "checks",
  label: "Check",
  title: "Pilot checks who's asking",
  caption: "Before anything else, Pilot confirms your session and wallet, picks the AI model you chose, and loads the preferences you've already approved.",
  route: ["pilot"],
  artifact: "checks",
  ms: 2800,
};

const tools: LoopScene = {
  id: "tools",
  label: "Think",
  title: "The AI model gets your request",
  caption: "Pilot hands the model your message, its safety rules and your approved preferences. The model can read data and propose things, but it has no way to sign or send money.",
  route: ["pilot", "model"],
  artifact: "tools",
  ms: 3600,
};

const lookup: LoopScene = {
  id: "lookup",
  label: "Look up",
  title: "It checks your notes",
  caption: "The model asks Pilot to search your vault. It only sees your own notes for this wallet and network.",
  route: ["model", "pilot", "vault", "pilot", "model"],
  artifact: "lookup",
  ms: 3600,
};

const propose = (amount: string, buy: string): LoopScene => ({
  id: "propose",
  label: "Propose",
  title: "It proposes a trade",
  caption: `The model can't trade. It proposes one: sell ${amount} RLUSD for ${buy}. The engine turns that into a real transaction and simulates it first.`,
  route: ["model", "pilot", "harbor"],
  artifact: "propose",
  ms: 3600,
});

const policy = (branch: LoopBranch): LoopScene => ({
  id: "policy",
  label: "Limits",
  title: "The engine checks your limits",
  caption:
    branch === "approval"
      ? "$500 is allowed, but it's over your $250 auto limit. So the engine won't sign it. It asks you."
      : branch === "auto"
        ? "$120 is under your $250 auto limit and passes every rule, so the engine can run it without asking."
        : "The token's issuer isn't on your allowlist. The engine blocks the trade, and Pilot won't try again.",
  route: ["harbor"],
  artifact: "policy",
  ms: 3800,
});

const sign: LoopScene = {
  id: "sign",
  label: "Sign",
  title: "You sign in your own wallet",
  caption: "Pilot shows you the exact transaction. You approve it in your own wallet, which only signs; it never sends anything itself.",
  route: ["harbor", "pilot", "you"],
  artifact: "sign",
  ms: 3600,
};

const auto: LoopScene = {
  id: "auto",
  label: "Execute",
  title: "The engine runs it for you",
  caption: "Because it's under your limit, the engine signs with the narrow permission you granted it and submits straight to the ledger.",
  route: ["harbor", "ledger"],
  artifact: "auto",
  ms: 3200,
};

const blocked: LoopScene = {
  id: "blocked",
  label: "Stop",
  title: "Nothing is sent",
  caption: "Pilot tells you which rule stopped it. No transaction reaches the ledger, and a blocked trade is never retried.",
  route: ["harbor", "pilot", "you"],
  artifact: "blocked",
  ms: 3200,
};

const ledger = (branch: LoopBranch): LoopScene => ({
  id: "ledger",
  label: "Confirm",
  title: "The XRP Ledger confirms it",
  caption:
    branch === "approval"
      ? "Pilot passes your signed transaction to the engine, which submits it. The trade is final once the ledger validates it."
      : "The trade is final once the ledger validates it. Pilot only calls a trade done at this point.",
  route: branch === "approval" ? ["you", "pilot", "harbor", "ledger"] : ["ledger", "pilot"],
  artifact: "ledger",
  ms: 3600,
});

const record: LoopScene = {
  id: "record",
  label: "Record",
  title: "Pilot writes it down",
  caption: "Pilot saves linked notes to your vault: the trade, today's journal, the venue, the token and a short reflection. They're plain Markdown you can open in Obsidian.",
  route: ["pilot", "vault"],
  artifact: "record",
  ms: 3400,
};

const learn: LoopScene = {
  id: "learn",
  label: "Learn",
  title: "Pilot suggests what to remember",
  caption: "You said “I prefer risk caveats first.” Pilot proposes remembering exactly that, using only your own words. Hermes adds a second opinion.",
  route: ["pilot", "hermes", "pilot", "you"],
  artifact: "learn",
  ms: 4200,
};

const review: LoopScene = {
  id: "review",
  label: "Review",
  title: "You decide",
  caption: "Nothing is remembered until you accept it. You can correct or forget it later, too.",
  route: ["you", "pilot", "vault"],
  artifact: "review",
  ms: 3400,
};

const next: LoopScene = {
  id: "next",
  label: "Next",
  title: "Next time, it already knows",
  caption: "Your next question, even to a different AI model, comes with your approved preference. Answers lead with risk caveats. Your limits and signing never change.",
  route: ["you", "pilot", "vault", "pilot", "model"],
  artifact: "next",
  ms: 4200,
};

/** The scene list for one branch of the story. */
export function loopScenes(branch: LoopBranch): LoopScene[] {
  const amount = branch === "auto" ? "120" : "500";
  const buy = branch === "blocked" ? "FREEMONEY" : "XRP";
  const head = [ask, checks, tools, lookup, propose(amount, buy), policy(branch)];
  const tail = [learn, review, next];
  if (branch === "blocked") return [...head, blocked, ...tail];
  return [...head, branch === "approval" ? sign : auto, ledger(branch), record, ...tail];
}

export const loopBoundaries = [
  "Only your own notes, for this wallet and network, are ever searched.",
  "Nothing is remembered until you accept it, and you can correct or forget it later.",
  "Preferences change how answers are written, never your limits, amounts, approvals or signing.",
  "The AI model never gets a way to sign or send money.",
  "Remembering helps answers fit you. It doesn't promise better returns.",
] as const;
