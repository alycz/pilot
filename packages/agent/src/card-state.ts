import { CardEventSchema } from "@pilot/contracts";
import type {
  CardEvent,
  CardState,
  CardTrust,
  ExecResult,
  Intent,
  PolicyResult,
  TxBuild,
} from "@pilot/contracts";

const TERMINAL_STATES = new Set<CardState>(["blocked", "validated", "failed"]);

const TRANSITIONS: Readonly<Record<CardState, readonly CardState[]>> = {
  drafting: ["planned", "failed"],
  planned: ["simulated", "failed"],
  simulated: ["policy_checked", "failed"],
  policy_checked: ["executing", "awaiting_approval", "blocked", "failed"],
  executing: ["submitted", "validated", "failed"],
  awaiting_approval: ["submitted", "failed"],
  blocked: [],
  submitted: ["validated", "failed"],
  validated: [],
  failed: [],
};

export type CardEventInput = Omit<CardEvent, "intent_id" | "intent" | "at"> & {
  at?: string;
};

export type CardEventSink = (event: CardEvent) => void | Promise<void>;

export interface CardStateMachineOptions {
  now?: () => Date;
  emit?: CardEventSink;
}

/**
 * Creates contract-valid card events and rejects skipped, repeated, or
 * backwards transitions. Each intent gets its own machine.
 */
export class CardStateMachine {
  readonly events: CardEvent[] = [];

  private readonly emit?: CardEventSink;
  private readonly now: () => Date;
  private state?: CardState;

  constructor(
    readonly intent: Intent,
    options: CardStateMachineOptions = {},
  ) {
    this.emit = options.emit;
    this.now = options.now ?? (() => new Date());
  }

  get current(): CardState | undefined {
    return this.state;
  }

  get terminal(): boolean {
    return this.state !== undefined && TERMINAL_STATES.has(this.state);
  }

  async transition(input: CardEventInput): Promise<CardEvent> {
    this.assertTransition(input.state);

    const event = CardEventSchema.parse({
      intent_id: this.intent.id,
      intent: this.intent,
      at: input.at ?? this.now().toISOString(),
      ...input,
    });

    this.state = event.state;
    this.events.push(event);
    await this.emit?.(event);
    return event;
  }

  async drafting(): Promise<CardEvent> {
    return this.transition({ state: "drafting" });
  }

  async planned(): Promise<CardEvent> {
    return this.transition({ state: "planned" });
  }

  async simulated(build: TxBuild, trust?: CardTrust): Promise<CardEvent> {
    return this.transition({ state: "simulated", build, ...(trust ? { trust } : {}) });
  }

  async policyChecked(options: {
    build: TxBuild;
    policy?: PolicyResult;
    trust?: CardTrust;
  }): Promise<CardEvent> {
    return this.transition({ state: "policy_checked", ...options });
  }

  async executing(build: TxBuild, trust?: CardTrust): Promise<CardEvent> {
    return this.transition({ state: "executing", build, ...(trust ? { trust } : {}) });
  }

  async submitted(build: TxBuild, hash: string, trust?: CardTrust): Promise<CardEvent> {
    return this.transition({ state: "submitted", build, hash, ...(trust ? { trust } : {}) });
  }

  async validated(
    build: TxBuild,
    exec: ExecResult,
    hash: string,
    trust?: CardTrust,
  ): Promise<CardEvent> {
    return this.transition({ state: "validated", build, exec, hash, ...(trust ? { trust } : {}) });
  }

  async awaitingApproval(
    build: TxBuild,
    exec: Extract<ExecResult, { status: "needs_approval" }>,
    trust?: CardTrust,
  ): Promise<CardEvent> {
    return this.transition({
      state: "awaiting_approval",
      build,
      exec,
      policy: exec.policy,
      ...(trust ? { trust } : {}),
    });
  }

  async blocked(
    build: TxBuild,
    exec: Extract<ExecResult, { status: "blocked" }>,
    trust?: CardTrust,
  ): Promise<CardEvent> {
    return this.transition({
      state: "blocked",
      build,
      exec,
      policy: exec.policy,
      ...(trust ? { trust } : {}),
    });
  }

  async failed(
    error: unknown,
    details: { build?: TxBuild; exec?: ExecResult; trust?: CardTrust } = {},
  ): Promise<CardEvent> {
    return this.transition({
      state: "failed",
      ...details,
      error: safeErrorMessage(error),
    });
  }

  private assertTransition(next: CardState): void {
    if (this.state === undefined) {
      if (next !== "drafting") {
        throw new Error(`Card must start at drafting, not ${next}.`);
      }
      return;
    }

    if (!TRANSITIONS[this.state].includes(next)) {
      throw new Error(`Invalid card transition from ${this.state} to ${next}.`);
    }
  }
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  if (typeof error === "string") return error.slice(0, 500);
  return "The operation failed.";
}
