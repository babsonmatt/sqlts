import { SQL } from "bun";
import type { Sql } from "../src/runtime.ts";
import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generate } from "../scripts/generate.ts";
import { rejects } from "node:assert/strict";

await mkdir("work", { recursive: true });
const dir = await mkdtemp(resolve("work/generator-test-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
const source = resolve(dir, "queries.ts");
const output = resolve(dir, "generated.ts");
async function attempt(code: string) {
  await writeFile(source, 'import { sql } from "../../.inline/sql.ts";\n' + code);
  return generate([source], output);
}

test("generator validates SQL without executing application code", async () => {
  const stats = await attempt(
    'throw new Error("Must never execute"); function q(flag: boolean) { return sql.query("good")`SELECT id FROM reylo_inline_demo.users ${sql.where(flag ? sql`email IS NOT NULL` : undefined)}`; }',
  );
  expect(stats.shapes).toBe(2);
  expect(await readFile(output, "utf8")).toContain("id: number");
});
test("invalid column fails and preserves last generated artifact", async () => {
  const before = await readFile(output, "utf8");
  await rejects(() =>
    attempt('sql.query("bad")`SELECT missing_column FROM reylo_inline_demo.users`'),
  );
  expect(await readFile(output, "utf8")).toBe(before);
});
test("misplaced WHERE fails during generation", async () => {
  await rejects(() =>
    attempt(
      'sql.query("bad")`SELECT id FROM reylo_inline_demo.users ORDER BY id ${sql.where(sql`id = ${value}`)}`',
    ),
  );
});
test("input types cannot silently match the wrong conditional shape", async () => {
  await rejects(
    () =>
      attempt(
        'sql.query("bad")`SELECT id FROM reylo_inline_demo.users ${sql.where(flag ? sql`id = ${id}` : sql`name = ${name}`)}`',
      ),
    /Ambiguous input types/,
  );
});
test("duplicate IDs are rejected", async () => {
  await rejects(
    () => attempt('sql.query("same")`SELECT 1`; sql.query("same")`SELECT 2`;'),
    /Duplicate query ID/,
  );
});

test("nullable JSON emits unknown and still decodes JSON null", async () => {
  await attempt('sql.query("json")`SELECT value FROM jsonb_each(\'{"a":null}\'::jsonb)`');
  const code = await readFile(output, "utf8");
  expect(code).toContain("value: unknown");
  expect(code).not.toContain("unknown | null");
  const { sql } = (await import(output)) as {
    sql: Sql<{ json: { inputs: readonly []; row: { value: unknown } } }>;
  };
  const db = new SQL(process.env.DATABASE_URL!);
  try {
    expect(
      await sql.query("json")`SELECT value FROM jsonb_each('{"a":null}'::jsonb)`.run(db),
    ).toEqual([{ value: null }]);
  } finally {
    await db.close();
  }
});
