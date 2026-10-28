import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { analyze, tooling } from "../src/sqlts/analyze.ts";
import { clearPreparationCache, preparationStats } from "../src/sqlts/prepared-cache.ts";
import { analysisStats } from "../src/adapter/reylo.ts";
import { position } from "../src/preview.ts";
import { dependencyClient } from "../tests/dependency-watch-client.ts";

// Uses only the existing demo schema; query analysis and catalog reads do not mutate it.
const dir = await mkdtemp(resolve("work/sqlts-project-bench-"));
const config = resolve(dir, "tsconfig.json");
await writeFile(
  config,
  JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: "esnext",
      module: "preserve",
      moduleResolution: "bundler",
      allowImportingTsExtensions: true,
      skipLibCheck: true,
      noUncheckedIndexedAccess: true,
      types: ["node"],
    },
    contentMappers: [{ package: "@sqlts/core", extensions: [".sqlts"] }],
    include: ["*.ts", "*.sqlts", "helpers/**/*.sqlts"],
  }),
);
const predicate =
  'import {sql} from "@sqlts/core";export function filters(a=false,b=false){return sql.fragment`${sql.where(a&&sql.fragment`u.email IS NOT NULL`,b&&sql.fragment`u.id > 1`)}`;}';
for (let group = 0; group < 2; group++) {
  const folder = resolve(dir, `helpers/g${group}`);
  await mkdir(folder, { recursive: true });
  await writeFile(resolve(folder, "leaf.sqlts"), predicate);
  for (let depth = 3; depth >= 0; depth--)
    await writeFile(
      resolve(folder, `level${depth}.sqlts`),
      `import {filters as next} from "./${depth === 3 ? "leaf" : `level${depth + 1}`}.sqlts";export const filters=(a:boolean,b:boolean)=>next(a,b);`,
    );
}
const where = "${filters(a,b)}",
  table = "reylo_inline_demo.users";
const queries = [
  `SELECT u.id,u.email FROM ${table} u ${where} ORDER BY u.id`,
  `WITH scoped AS MATERIALIZED (SELECT id,email,name,org_id FROM ${table}) SELECT u.id,u.email FROM scoped u ${where} ORDER BY u.id`,
  `SELECT u.id,peer.name AS peer_name FROM ${table} u LEFT JOIN ${table} peer ON peer.id=u.id+1 ${where} ORDER BY u.id`,
  `SELECT u.id,x.label FROM ${table} u LEFT JOIN LATERAL (SELECT lower(u.name) AS label) x ON true ${where} ORDER BY u.id`,
  `SELECT u.org_id,count(*)::int AS people FROM ${table} u ${where} GROUP BY u.org_id ORDER BY u.org_id`,
  `SELECT u.id,row_number() OVER (PARTITION BY u.org_id ORDER BY u.id) AS position FROM ${table} u ${where} ORDER BY u.id`,
  `SELECT u.id,jsonb_build_object('name',u.name,'email',u.email) AS profile FROM ${table} u ${where} ORDER BY u.id`,
  `SELECT DISTINCT ON (u.org_id) u.id,u.email FROM ${table} u ${where} ORDER BY u.org_id,u.id`,
  `SELECT u.id,EXISTS(SELECT 1 FROM ${table} peer WHERE peer.org_id=u.org_id AND peer.id<>u.id) AS has_peer FROM ${table} u ${where} ORDER BY u.id`,
  `SELECT u.id,coalesce(u.email,u.name) AS contact FROM ${table} u ${where} ORDER BY u.id`,
  `SELECT u.id,CASE WHEN u.email IS NULL THEN false ELSE true END AS has_email FROM ${table} u ${where} ORDER BY u.id`,
  `WITH all_ids AS (SELECT id FROM ${table} UNION SELECT id FROM ${table}) SELECT u.id,u.email FROM ${table} u JOIN all_ids i ON i.id=u.id ${where} ORDER BY u.id`,
];
const files = Array.from({ length: 8 }, (_, index) => ({
  file: resolve(dir, `queries${index}.sqlts`),
  source:
    `import {sql} from "@sqlts/core";import {filters} from "./helpers/g${index % 2}/level0.sqlts";\n` +
    Array.from(
      { length: 3 },
      (_, q) =>
        `export const query${q}=(a=false,b=false)=>sql\`${queries[(index * 3 + q) % queries.length]}\`;`,
    ).join("\n"),
}));
for (const file of files) await writeFile(file.file, file.source);
const caller = resolve(dir, "caller.ts"),
  consumer =
    'import {query0} from "./queries0.sqlts";import type {PostgresClient} from "reylo";export async function demo(db:PostgresClient){const email=(await query0(true,false).run(db))[0]?.email;return email;}';
await writeFile(caller, consumer);
const summary = (samples: number[]) => {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    medianMs: +sorted[Math.floor(sorted.length / 2)]!.toFixed(2),
    p95Ms: +sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!.toFixed(2),
    samplesMs: samples.map((n) => +n.toFixed(3)),
  };
};
const handlers = tooling.mapperHandlers(),
  projectHandle = crypto.randomUUID();
const metrics: Record<string, number[]> = {
  uncachedPreparation: [],
  cachedPreparation: [],
  oneSqlFileEdit: [],
  oneSharedHelperEdit: [],
};
const work: Record<string, unknown>[] = [];
async function suite(reusePreparation = true, override?: string) {
  const before = preparationStats(),
    sqlBefore = analysisStats(),
    start = performance.now();
  for (const [i, file] of files.entries())
    await analyze(
      {
        projectHandle,
        fileName: file.file,
        content: i === 0 && override !== undefined ? override : file.source,
      },
      handlers,
      { reusePreparation },
    );
  const after = preparationStats(),
    sqlAfter = analysisStats();
  return {
    ms: performance.now() - start,
    hits: after.hits - before.hits,
    misses: after.misses - before.misses,
    validated: sqlAfter.validated - sqlBefore.validated,
    transformed: sqlAfter.transformed - sqlBefore.transformed,
  };
}
const leaf = resolve(dir, "helpers/g0/leaf.sqlts");
try {
  await handlers.openProject({ projectHandle, configFileName: config });
  clearPreparationCache();
  console.log(
    "Analyzing 24 sites, 12 SQL forms, four forwarding levels and two independent helper groups...",
  );
  work.push({ phase: "first pass", ...(await suite()) });
  for (let round = 0; round < 5; round++)
    for (const cached of round % 2 ? [true, false] : [false, true])
      metrics[cached ? "cachedPreparation" : "uncachedPreparation"]!.push((await suite(cached)).ms);
  for (let round = 0; round < 5; round++) {
    await suite();
    const changed = files[0]!.source.replace("SELECT u.id,u.email", "SELECT u.id,u.name AS email");
    const sqlEdit = await suite(true, changed);
    metrics.oneSqlFileEdit!.push(sqlEdit.ms);
    work.push({ phase: "one SQL file", round, ...sqlEdit });
    if (sqlEdit.hits !== 7 || sqlEdit.misses !== 1)
      throw Error("Unrelated SQL files were re-expanded");
    await suite();
    await writeFile(leaf, predicate.replace("u.email IS NOT NULL", "u.name IS NOT NULL"));
    const sharedEdit = await suite();
    metrics.oneSharedHelperEdit!.push(sharedEdit.ms);
    work.push({ phase: "one shared helper", round, ...sharedEdit });
    if (sharedEdit.hits !== 4 || sharedEdit.misses !== 4)
      throw Error("Shared helper invalidation crossed independent groups");
    await writeFile(leaf, predicate);
    await suite();
  }
} finally {
  await handlers.closeProject({ projectHandle });
  await tooling.releaseConnections();
}
const lsp = dependencyClient(),
  uri = pathToFileURL(caller).href;
const hover = () =>
  lsp.request("textDocument/hover", {
    textDocument: { uri },
    position: position(consumer, consumer.indexOf("email=")),
  });
const saved: number[] = [];
let firstHoverMs = 0;
try {
  await lsp.request("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(dir).href,
    initializationOptions: { runExternalCode: true },
    capabilities: {
      workspace: { didChangeWatchedFiles: { dynamicRegistration: true } },
      textDocument: { hover: { contentFormat: ["markdown"] } },
    },
  });
  lsp.notify("initialized", {});
  lsp.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "typescript", version: 1, text: consumer },
  });
  const start = performance.now();
  const initial = JSON.stringify(await hover());
  firstHoverMs = performance.now() - start;
  if (!initial.includes("string | undefined")) throw Error("Incorrect initial hover: " + initial);
  for (let i = 0; i < 6; i++) {
    const changed = i % 2 === 0,
      expected = changed ? "string | null | undefined" : "string | undefined",
      start = performance.now();
    await writeFile(
      leaf,
      changed ? predicate.replace("u.email IS NOT NULL", "u.name IS NOT NULL") : predicate,
    );
    let result = "";
    while (performance.now() - start < 5000) {
      result = JSON.stringify(await hover());
      if (result.includes(expected)) break;
      await Bun.sleep(10);
    }
    if (!result.includes(expected)) throw Error("Stale saved-helper hover: " + result);
    saved.push(performance.now() - start);
  }
} finally {
  await lsp.close();
  await writeFile(leaf, predicate);
}
const report = {
  date: new Date().toISOString(),
  fixture: {
    files: 8,
    querySites: 24,
    sqlForms: queries.length,
    branchSlots: 96,
    forwardingLevels: 4,
    helperGroups: 2,
    schema: "existing reylo_inline_demo.users; no DDL",
  },
  metrics: Object.fromEntries(
    Object.entries(metrics).map(([name, values]) => [name, summary(values)]),
  ),
  work,
  editor: { firstHoverMs: +firstHoverMs.toFixed(2), savedHelperToCorrectType: summary(saved) },
  cache: preparationStats(),
  methodology:
    "Local synthetic project using varied real PostgreSQL SQL forms, the existing demo schema and cached database/OS state. Warm preparations alternate cached/uncached execution. All paths still validate SQL through Reylo. Edit measurements include all eight module analysis calls, so compiler invalidation remains project-wide; counters distinguish preparation reuse. Saved-helper latency includes file watching, 40ms debounce, compiler rechecking, RPC and up to 10ms polling resolution. No user queries or migrations are executed by this benchmark.",
};
await writeFile(resolve(dir, "results.json"), JSON.stringify(report, null, 2));
console.table([
  ...Object.entries(report.metrics).map(([phase, value]) => ({
    phase,
    medianMs: value.medianMs,
    p95Ms: value.p95Ms,
  })),
  {
    phase: "saved helper → correct hover",
    medianMs: report.editor.savedHelperToCorrectType.medianMs,
    p95Ms: report.editor.savedHelperToCorrectType.p95Ms,
  },
]);
console.log("Full results:", resolve(dir, "results.json"));
