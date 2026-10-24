import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  OpRegistry,
  type OpDef,
} from "../src/catalog/registry";
import {
  GuardError,
  assertSafeArguments,
  assertSafeCode,
  invokeOp,
  isEnvelope,
  MAX_OUTPUT_BYTES,
  truncateOutput,
  validateArguments,
} from "../src/guard";

const execFileAsync = promisify(execFile);
const FeeArgsSchema = z
  .object({ network: z.string().optional() })
  .strict();

function feeOp(
  name = "ledger.fee",
): OpDef<typeof FeeArgsSchema, { drops: string; network?: string }> {
  return {
    name,
    family: "ledger",
    summary: "Read the current XRPL transaction fee.",
    tags: ["fee", "ledger"],
    args: FeeArgsSchema,
    returns: "the fee in drops",
    caveats: [],
    example: `await harbor.${name}({})`,
    handler: (_ctx, args) => ({ drops: "12", network: args.network }),
  };
}

describe("operation catalog", () => {
  it("registers, looks up, lists, and searches the test-only fee op", () => {
    const registry = new OpRegistry([feeOp()]);

    expect(registry.get("ledger.fee")?.family).toBe("ledger");
    expect(registry.list().map((op) => op.name)).toEqual(["ledger.fee"]);

    const [result] = registry.search("fee");
    expect(result.name).toBe("ledger.fee");
    expect(result.signature).toContain("ledger.fee");
    expect(result.signature).toContain("network?");
    expect(result.example).toContain("harbor.ledger.fee");
  });

  it("boosts exact names and families, searches content, and caps results at eight", () => {
    const ops = [
      feeOp(),
      ...Array.from({ length: 10 }, (_, index) =>
        feeOp(`ledger.item${index}`),
      ),
    ];
    const registry = new OpRegistry(ops).setCatalogDocuments([
      {
        id: "xrpl-dex",
        kind: "venue",
        name: "XRPL DEX",
        summary: "A venue with transaction fee information.",
        tags: ["spot"],
        signature: 'venues.get({ id: "xrpl-dex" }) → venue details',
        example: 'await harbor.venues.get({ id: "xrpl-dex" })',
      },
      {
        id: "swap-safely",
        kind: "playbook",
        name: "Swap safely",
        summary: "A safe trading playbook.",
        tags: ["trading"],
        content: "Check price impact and impermanent loss before acting.",
        signature: 'skill.read({ id: "swap-safely" }) → playbook',
        example: 'await harbor.skill.read({ id: "swap-safely" })',
      },
    ]);

    expect(registry.search("ledger.fee")[0].name).toBe("ledger.fee");
    expect(registry.search("ledger")).toHaveLength(8);
    expect(registry.search("trading")[0]).toMatchObject({
      kind: "playbook",
      name: "Swap safely",
    });
    expect(registry.search("impermanent")[0]).toMatchObject({
      kind: "playbook",
      name: "Swap safely",
    });

    const fromManifest = new OpRegistry().loadCatalogManifest({
      ecosystemSkills: {
        playbooks: [
          {
            id: "link-account",
            name: "Link account",
            summary: "Prepare delegated permissions.",
            content: "Verify the on-ledger DelegateSet before continuing.",
          },
        ],
      },
    });
    expect(fromManifest.search("DelegateSet")[0]).toMatchObject({
      name: "Link account",
      signature: expect.stringContaining("skill.read"),
      example: expect.stringContaining("harbor.skill.read"),
    });
  });

  it("rejects duplicate or malformed operation registrations atomically", () => {
    const registry = new OpRegistry([feeOp()]);
    expect(() => registry.register([feeOp("ledger.other"), feeOp()])).toThrow(
      /already registered/i,
    );
    expect(registry.get("ledger.other")).toBeUndefined();
    expect(() =>
      new OpRegistry([{ ...feeOp(), name: "fee", family: "ledger" }]),
    ).toThrow(/invalid operation name/i);
    expect(() =>
      registry.register({
        ...feeOp("ledger.invalid"),
        caveats: ["not-a-caveat"],
      } as unknown as OpDef),
    ).toThrow(/invalid caveats/i);
    expect(registry.get("ledger.invalid")).toBeUndefined();
  });
});

describe("input guards", () => {
  it.each(["seed", "SECRET", "PrivateKey", "mnemonic phrase"])(
    "rejects code containing %s",
    (fragment) => {
      expect(() => assertSafeCode(`return ${JSON.stringify(fragment)}`)).toThrow(
        GuardError,
      );
    },
  );

  it("rejects sensitive argument keys and nested string values", () => {
    expect(() => assertSafeArguments({ privateNote: "x" })).toThrow(
      /sensitive material/i,
    );
    expect(() =>
      assertSafeArguments({ nested: [{ note: "my MNEMONIC is here" }] }),
    ).toThrow(/sensitive material/i);
    expect(() => assertSafeArguments({ public: "ordinary" })).not.toThrow();
  });

  it("validates arguments with zod before invoking a handler", async () => {
    const op = feeOp();
    expect(validateArguments(op.args, { network: "testnet" })).toEqual({
      network: "testnet",
    });
    expect(() => validateArguments(op.args, { network: 2 })).toThrow(
      /invalid operation arguments/i,
    );

    const result = await invokeOp(
      op,
      { principal: "test" },
      { network: "testnet" },
      { asOf: "2026-10-18T00:00:00.000Z", asOfBasis: "unit-test" },
    );
    expect(result).toEqual({
      ok: true,
      data: { drops: "12", network: "testnet" },
      asOf: "2026-10-18T00:00:00.000Z",
      asOfBasis: "unit-test",
    });
    expect(isEnvelope(result)).toBe(true);
    expect(isEnvelope({ ok: true })).toBe(false);
  });
});

describe("output guard and catalog generation", () => {
  it("truncates UTF-8 output to the 24 KB byte ceiling", () => {
    const output = truncateOutput("💧".repeat(MAX_OUTPUT_BYTES));
    expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(
      MAX_OUTPUT_BYTES,
    );
    expect(output).toContain("output truncated");
    expect(truncateOutput({ ok: true }, MAX_OUTPUT_BYTES)).toBe('{"ok":true}');
  });

  it(
    "discovers an exported ops array without importing its TypeScript module",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "harbor-catalog-"));
      try {
        await mkdir(join(root, "src/ops"), { recursive: true });
        await mkdir(join(root, "catalog/venues"), { recursive: true });
        await mkdir(join(root, "ecosystem-skills/local"), { recursive: true });
        const opFile = join(root, "src/ops/ledger.ts");
        const opSource = `
          import { z } from "zod";
          import type { OpDef } from "../catalog/registry";

          throw new Error("the catalog builder must not execute op modules");

          export const ops: OpDef[] = [{
            name: "ledger.fee",
            family: "ledger",
            summary: "Read the current XRPL transaction fee.",
            tags: ["fee"],
            args: z.object({ network: z.string().optional() }).strict(),
            returns: "the fee in drops",
            caveats: [],
            example: "await harbor.ledger.fee({})",
            handler: async (_ctx, args) => ({ drops: \`fee,\${args.network}\` }),
          }];
        `;
        await writeFile(
          opFile,
          opSource,
          "utf8",
        );
        await writeFile(
          join(root, "src/ops/tx-exec.ts"),
          `
            import { z } from "zod";
            import type { OpDef } from "../catalog/registry";
            export const ops: OpDef[] = [{
              name: "tx.execute",
              family: "tx",
              summary: "Execute a prepared transaction.",
              args: z.object({ build_id: z.string() }).strict(),
              returns: "an execution result",
              caveats: [],
              example: "await harbor.tx.execute({ build_id: 'build' })",
              handler: async () => ({ status: "executed" }),
            }];
          `,
          "utf8",
        );
        await writeFile(
          join(root, "catalog/venues/xrpl-dex.yaml"),
          `
            id: xrpl-dex
            name: XRPL DEX
            kind: execution-primitive
            layer: xrpl-l1
            category: [spot]
            status:
              testnet: live
            reads: [book_offers]
            risks: [slippage]
            links:
              docs: https://xrpl.org/
          `,
          "utf8",
        );
        await writeFile(
          join(root, "ecosystem-skills/MANIFEST.json"),
          '{"skills":[{"id":"xrpl-trading"}]}\n',
          "utf8",
        );
        await writeFile(
          join(root, "ecosystem-skills/local/swap-safely.md"),
          "# Swap safely\n\nCheck price impact before submitting.\n",
          "utf8",
        );

        await execFileAsync(
          "node",
          ["scripts/build-catalog.mjs", "--root", root],
          {
            cwd: process.cwd(),
            // Do not leak Vitest/workerd loader flags into the nested plain-Node
            // generator process.
            env: { PATH: process.env.PATH },
          },
        );
        const generatedIndex = await readFile(
          join(root, "src/ops/index.gen.ts"),
          "utf8",
        );
        const manifest = JSON.parse(
          await readFile(join(root, "catalog/manifest.json"), "utf8"),
        );

        expect(generatedIndex).toContain(
          'import { ops as ledgerOps } from "./ledger";',
        );
        expect(generatedIndex).toContain("...ledgerOps,");
        expect(generatedIndex).toContain(
          'import { ops as txExecOps } from "./tx-exec";',
        );
        expect(generatedIndex).toContain("...txExecOps,");
        expect(manifest).toMatchObject({
          version: 1,
          ops: [
            {
              name: "ledger.fee",
              family: "ledger",
              signature: "ledger.fee({ network? }) → the fee in drops",
            },
            {
              name: "tx.execute",
              family: "tx",
              signature: "tx.execute({ build_id }) → an execution result",
            },
          ],
          venues: [{ id: "xrpl-dex", name: "XRPL DEX" }],
          ecosystemSkills: {
            manifest: { skills: [{ id: "xrpl-trading" }] },
            playbooks: [
              {
                id: "swap-safely",
                name: "Swap safely",
                content: expect.stringContaining("price impact"),
              },
            ],
          },
        });

        await writeFile(
          opFile,
          opSource.replace(
            'name: "ledger.fee",',
            'name: "ledger.fee" + dynamicName,',
          ),
          "utf8",
        );
        await expect(
          execFileAsync(
            "node",
            ["scripts/build-catalog.mjs", "--root", root],
            { cwd: process.cwd(), env: { PATH: process.env.PATH } },
          ),
        ).rejects.toThrow(/must be a string literal/i);

        await writeFile(opFile, opSource, "utf8");
        await writeFile(
          join(root, "catalog/venues/xrpl-dex.yaml"),
          "id: xrpl-dex\nname: XRPL DEX\nkind: invalid\n",
          "utf8",
        );
        await expect(
          execFileAsync(
            "node",
            ["scripts/build-catalog.mjs", "--root", root],
            { cwd: process.cwd(), env: { PATH: process.env.PATH } },
          ),
        ).rejects.toThrow(/kind is invalid/i);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
