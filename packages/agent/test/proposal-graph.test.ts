import { describe, expect, it } from "vitest";

import { DeclarativeProcedureSchema } from "../src/proposal-provider.js";

const invariants = [
  "no_network",
  "no_execution",
  "no_runtime_rewrite",
  "no_policy_change",
  "no_automatic_promotion",
  "scope_isolation",
] as const;

function step(id: string, dependsOn: string[] = []) {
  return {
    id,
    operation: "read_context" as const,
    description: `Safe declarative step ${id}`,
    dependsOn,
  };
}

function procedure(steps: ReturnType<typeof step>[]) {
  return {
    id: "candidate-procedure",
    version: "1.0.0",
    title: "Candidate procedure",
    description: "A bounded declarative proposal for offline review.",
    steps,
    invariants,
  };
}

function messages(value: unknown): string[] {
  const parsed = DeclarativeProcedureSchema.safeParse(value);
  expect(parsed.success).toBe(false);
  return parsed.success ? [] : parsed.error.issues.map(({ message }) => message);
}

describe("DeclarativeProcedureSchema dependency graph", () => {
  it("accepts a valid branching DAG regardless of declaration order", () => {
    const parsed = DeclarativeProcedureSchema.parse(procedure([
      step("compose", ["research", "portfolio"]),
      step("validate", ["compose"]),
      step("research", ["context"]),
      step("context"),
      step("portfolio", ["context"]),
    ]));

    expect(parsed.steps.map(({ id, dependsOn }) => ({ id, dependsOn }))).toEqual([
      { id: "compose", dependsOn: ["research", "portfolio"] },
      { id: "validate", dependsOn: ["compose"] },
      { id: "research", dependsOn: ["context"] },
      { id: "context", dependsOn: [] },
      { id: "portfolio", dependsOn: ["context"] },
    ]);
  });

  it("rejects duplicate step ids", () => {
    expect(messages(procedure([step("context"), step("context")]))).toContain(
      "Step id duplicates steps[0].id",
    );
  });

  it("rejects dependencies that do not name a procedure step", () => {
    expect(messages(procedure([step("compose", ["missing"])]))).toContain(
      "Step dependency does not name a procedure step",
    );
  });

  it("rejects self-dependencies", () => {
    expect(messages(procedure([step("context", ["context"])]))).toContain(
      "A step cannot depend on itself",
    );
  });

  it("rejects duplicate dependencies", () => {
    expect(messages(procedure([
      step("context"),
      step("compose", ["context", "context"]),
    ]))).toContain("Step dependencies must not repeat");
  });

  it("rejects direct two-node cycles", () => {
    expect(messages(procedure([
      step("one", ["two"]),
      step("two", ["one"]),
    ]))).toContain("Procedure dependencies must form an acyclic graph");
  });

  it("rejects indirect cycles", () => {
    expect(messages(procedure([
      step("one", ["two"]),
      step("two", ["three"]),
      step("three", ["one"]),
    ]))).toContain("Procedure dependencies must form an acyclic graph");
  });
});
