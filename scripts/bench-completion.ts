import { mkdir } from "node:fs/promises";
import { CompletionService } from "../src/completion.ts";
import { CatalogService } from "../src/catalog-service.ts";
import { SqlSemanticTokens } from "../src/semantic-tokens.ts";
import { position } from "../src/preview.ts";
import type { Catalog } from "../src/catalog.ts";
const cache = new CatalogService();
const start = performance.now();
const catalog = await cache.get();
const catalogColdMs = performance.now() - start;
if (!catalog.relations.length) throw Error("Start the development database before benchmarking");
const large: Catalog = {
  ...catalog,
  relations: Array.from({ length: 1000 }, (_, i) => ({
    schema: "large",
    name: `table_${i}`,
    visible: false,
    columns: Array.from({ length: 50 }, (_, c) => ({
      name: `column_${c}`,
      type: "integer",
      nullable: false,
    })),
  })),
};
const manyFunctions: Catalog = {
  ...large,
  functions: Array.from({ length: 10000 }, (_, i) => ({
    ...catalog.functions![0]!,
    name: `function_${i}`,
    visible: true,
  })),
};
const source = (sql: string) =>
  'import {sql} from "../.inline/sql.ts"; sql.query("bench")`' + sql + "`;";
const cases = [
  { name: "direct alias", schema: catalog, sql: "SELECT u.▌ FROM reylo_inline_demo.users u" },
  {
    name: "CTE + lateral",
    schema: catalog,
    sql: "WITH a AS (SELECT id, name FROM reylo_inline_demo.users) SELECT r.▌ FROM a JOIN LATERAL (SELECT a.id, lower(a.name) AS display_name) r ON true",
  },
  { name: "50k columns", schema: large, sql: "SELECT t.column_▌ FROM large.table_999 t" },
  { name: "1k tables", schema: large, sql: "SELECT * FROM large.▌" },
  { name: "10k functions", schema: manyFunctions, sql: "SELECT function_99▌" },
  {
    name: "64 alternatives",
    schema: catalog,
    sql:
      "SELECT u.▌ FROM reylo_inline_demo.users u " +
      Array.from(
        { length: 6 },
        (_, i) => "${flag" + i + " ? sql` /* on" + i + " */` : sql.empty}",
      ).join(" "),
  },
];
const metrics: Record<string, string | number>[] = [];
const percentile = (values: number[], p: number) =>
  +values
    .toSorted((a, b) => a - b)
    [Math.min(values.length - 1, Math.floor(values.length * p))]!.toFixed(3);
for (const entry of cases) {
  const marked = source(entry.sql),
    at = marked.indexOf("▌"),
    text = marked.replace("▌", "");
  const cursor = position(text, at),
    cold: number[] = [],
    warm: number[] = [],
    edits: number[] = [];
  for (let i = 0; i < 15; i++) {
    const service = new CompletionService(),
      begin = performance.now();
    const result = service.complete(text, "/bench.ts", cursor, entry.schema);
    cold.push(performance.now() - begin);
    if (!result.items.length) throw Error("Missing benchmark completions: " + entry.name);
  }
  const service = new CompletionService();
  service.complete(text, "/bench.ts", cursor, entry.schema);
  for (let i = 0; i < 200; i++) {
    const begin = performance.now();
    service.complete(text, "/bench.ts", cursor, entry.schema);
    warm.push(performance.now() - begin);
  }
  for (let i = 0; i < 30; i++) {
    const begin = performance.now();
    service.complete(text + `\n// edit ${i}`, "/bench.ts", cursor, entry.schema);
    edits.push(performance.now() - begin);
  }
  metrics.push({
    case: entry.name,
    coldP50Ms: percentile(cold, 0.5),
    coldP95Ms: percentile(cold, 0.95),
    warmP50Ms: percentile(warm, 0.5),
    warmP95Ms: percentile(warm, 0.95),
    editP95Ms: percentile(edits, 0.95),
  });
}
const colors = new SqlSemanticTokens(),
  demo = await Bun.file("examples/completion/queries.ts").text();
const colorStart = performance.now();
colors.full(demo, "/colors.ts");
const colorColdMs = performance.now() - colorStart;
const warmColorStart = performance.now();
for (let i = 0; i < 1000; i++) colors.full(demo, "/colors.ts");
const report = {
  bun: Bun.version,
  platform: process.platform,
  arch: process.arch,
  catalogColdMs: +catalogColdMs.toFixed(2),
  relations: catalog.relations.length,
  functions: catalog.functions?.length,
  types: catalog.types?.length,
  colorColdMs: +colorColdMs.toFixed(3),
  colorCachedMeanMs: +((performance.now() - warmColorStart) / 1000).toFixed(4),
  metrics,
};
console.table(metrics);
console.log({ ...report, metrics: undefined });
await mkdir("work", { recursive: true });
await Bun.write("work/completion-bench.json", JSON.stringify(report, null, 2) + "\n");
cache.stop();
