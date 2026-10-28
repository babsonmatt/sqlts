import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { prepare } from "../src/sqlts/transform.ts";
import { analyze, tooling } from "../src/sqlts/analyze.ts";
import { analysisStats, resetAnalysisStats } from "../src/adapter/reylo.ts";
await mkdir("work", { recursive: true });
const dir = await mkdtemp(resolve("work/sqlts-scale-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
const file = resolve(dir, "queries.sqlts");
test("equivalent branches share analysis while distinct bindings and genuine shape limits are preserved", () => {
  const conditionals = Array.from(
    { length: 12 },
    (_, i) => `b${i} ? sql\`id >= \${value}\` : sql\`id >= \${value}\``,
  );
  const source =
    'import {sql} from "@sqlts/core"; export const q=sql`SELECT id FROM users ${sql.where(' +
    conditionals.join(",") +
    ")}`;";
  const p = prepare(source, file);
  expect(p.queries[0]!.variants).toHaveLength(1);
  expect(p.queries[0]!.alternatives[0]!.conditions.join(" ")).toContain("either");
  const distinct = source.replaceAll(": sql`id >= ${value}`", ": sql.empty");
  expect(() => prepare(distinct, file)).toThrow("64 SQL shapes");
  const bindings =
    'import {sql} from "@sqlts/core";sql`SELECT ${flag ? sql`${a}::int` : sql`${b}::int`} AS id`;';
  expect(prepare(bindings, file).queries[0]!.variants).toHaveLength(2);
});
test("identical SQL across query sites is analyzed once per transform, with schema validation on subsequent transforms", async () => {
  await writeFile(
    resolve(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true },
      contentMappers: [{ package: "@sqlts/core", extensions: [".sqlts"] }],
    }),
  );
  const content =
    'import {sql} from "@sqlts/core";\n' +
    Array.from(
      { length: 16 },
      (_, i) => `export const q${i}=()=>sql\`SELECT 42::int AS answer\`;`,
    ).join("\n");
  const handlers = tooling.mapperHandlers(),
    projectHandle = "scale-" + crypto.randomUUID();
  try {
    await handlers.openProject({ projectHandle, configFileName: resolve(dir, "tsconfig.json") });
    resetAnalysisStats();
    const start = performance.now();
    const first = await analyze({ projectHandle, fileName: file, content }, handlers);
    const firstMs = performance.now() - start,
      initial = analysisStats();
    expect(first.text).toContain("answer: number");
    expect(initial.validated).toBe(1);
    const warmStart = performance.now();
    await analyze({ projectHandle, fileName: file, content }, handlers);
    const warmMs = performance.now() - warmStart,
      after = analysisStats();
    expect(after.validated).toBe(2);
    expect(after.reused).toBeGreaterThanOrEqual(1);
    console.log(JSON.stringify({ sites: 16, distinctSql: 1, firstMs, warmMs, initial, after }));
  } finally {
    await handlers.closeProject({ projectHandle });
    await tooling.releaseConnections();
  }
});
