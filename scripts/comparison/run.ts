import { Pool } from "pg";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cpus, platform, arch } from "node:os";
import { fixture } from "./fixture.ts";
import { kinds, rotate, stats, tableName, type Kind } from "./shared.ts";

const root = resolve(import.meta.dir, "../.."),
  worker = resolve(import.meta.dir, "worker.ts");
const runtimeArg = process.argv.find((a) => a.startsWith("--runtime="))?.split("=")[1] ?? "both";
if (!["node", "bun", "both"].includes(runtimeArg)) throw Error("Use --runtime=node, bun, or both");
const runtimes = runtimeArg === "both" ? ["node", "bun"] : [runtimeArg];
const skipStartup = process.argv.includes("--skip-startup");
const startupTrials = skipStartup ? 0 : Number(process.env.BENCH_STARTUPS ?? 4);
if (!skipStartup && (!Number.isInteger(startupTrials) || startupTrials < 1 || startupTrials > 20))
  throw Error("BENCH_STARTUPS must be 1..20");
await mkdir(resolve(root, "work/comparison"), { recursive: true });
const directory = await mkdtemp(resolve(root, "work/comparison/run-"));
const schema = "reylo_bench_" + crypto.randomUUID().replaceAll("-", "");
const table = tableName(schema);
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  application_name: "reylo-comparison-setup",
});
let created = false;
interface Distribution {
  n: number;
  median: number;
  p95: number;
  min: number;
  max: number;
}
interface Steady {
  runtime: string;
  bun?: string;
  results: {
    scenario: string;
    provider: Kind;
    constructionUs: Distribution;
    latencyMs: Distribution;
    throughputQps: Distribution;
    prebuiltLatencyMs: Distribution;
    prebuiltThroughputQps: Distribution;
    roundLatencyDeltaUs: Distribution;
  }[];
}
const report: { environment: Record<string, unknown>; runs: unknown[]; methodology: string[] } = {
  environment: {
    measuredAt: new Date().toISOString(),
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    fixtureRows: 20_000,
    poolMax: 4,
  },
  runs: [],
  methodology: [
    "Same pg driver, 20,000-row isolated fixture, four SQL shapes, int4/text/nullable text results.",
    "No named server-prepared statements. Build+run uses Drizzle normal execute; prebuilt uses prepare(empty name) to compile client-side once, verified at the driver boundary.",
    "Construction includes SQL/parameter materialization via compile()/toSQL(); plain Reylo selects a static shape and binds params.",
    "Build+run latency constructs a fresh query; prebuilt latency executes an already constructed query with fixed parameters. Both include binding/copying, driver, database and row decoding. Neither includes module startup or analysis. Throughput uses four workers and four warm connections.",
    "Provider order rotates and build/prebuilt mode order alternates each round. Both modes are warmed. p95 latency is per request; construction, QPS, and signed median differences are per round. Differences include measurement noise and are not exact profiles.",
    "Rows and structural EXPLAIN plans must agree before timing. SQL text can differ in quoting/parentheses but plans, values and outputs are checked.",
    "Native Reylo freshness checks and decoding remain enabled. No mock database or parser substitution.",
    "Startup wall time includes process launch, imports/analysis, first 20-row query, pool close and output write. Internal import/query timings exclude process/loader startup.",
    "Fresh startup uses a newly created project directory; cached startup repeats it in a fresh process. OS/PostgreSQL caches are not flushed.",
    "Local synthetic read benchmark, not an ORM ranking or production SLA. Does not measure complex type decoding, writes, joins, named prepared APIs, or editor latency.",
  ],
};
async function child(runtime: string, mode: string, dir: string, output: string) {
  const command = [Bun.which(runtime)!];
  if (!command[0]) throw Error(`${runtime} is unavailable`);
  command.push(runtime === "node" ? "--env-file=.env" : "--no-env-file");
  const preload = runtime === "node" ? "--import" : "--preload";
  if (mode === "steady" || mode === "reylo") command.push(preload, "reylo/register");
  if (mode === "steady" || mode === "inline")
    command.push(preload, "@sqlts/core/register");
  command.push(worker, mode, dir, schema, output);
  const entries = () =>
    readdir(resolve(dir, ".reylo/queries"))
      .then((v) => v.length)
      .catch(() => 0);
  const cacheEntriesBefore = await entries();
  const start = performance.now();
  const process = Bun.spawn(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  const wallMs = performance.now() - start;
  if (code !== 0) throw Error(`${runtime}/${mode} failed: ${stdout}\n${stderr}`);
  return {
    cacheEntriesBefore,
    cacheEntriesAfter: await entries(),
    wallMs,
    data: JSON.parse(await readFile(output, "utf8")) as Record<string, unknown>,
  };
}
try {
  const version = await db.query("SHOW server_version");
  report.environment.postgres = version.rows[0].server_version;
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  report.environment.dependencies = {
    pg: manifest.devDependencies.pg,
    reylo: manifest.dependencies.reylo,
    drizzle: manifest.devDependencies["drizzle-orm"],
  };
  await db.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  await db.query(`CREATE TABLE ${table} (id integer PRIMARY KEY, org_id integer NOT NULL, name text NOT NULL, email text);
    INSERT INTO ${table} SELECT i, CASE WHEN i % 2 = 0 THEN 10 ELSE 20 END, 'User ' || i, CASE WHEN i % 5 = 0 THEN NULL ELSE 'user' || i || '@example.test' END FROM generate_series(1,20000) i;
    CREATE INDEX ON ${table} (org_id,id); ANALYZE ${table};`);
  const steadyDir = resolve(directory, "steady");
  await fixture(steadyDir, schema);
  for (const runtime of runtimes) {
    console.log(
      `Measuring ${runtime}: validating rows/plans, then warm construction and execution...`,
    );
    const result = await child(
      runtime,
      "steady",
      steadyDir,
      resolve(directory, `${runtime}-steady.json`),
    );
    const steady = result.data as unknown as Steady;
    console.log("Build a fresh query + execute:");
    console.table(
      steady.results.map((r) => ({
        scenario: r.scenario,
        provider: r.provider,
        buildUs: +r.constructionUs.median.toFixed(2),
        medianMs: +r.latencyMs.median.toFixed(3),
        p95Ms: +r.latencyMs.p95.toFixed(3),
        qpsAt4: Math.round(r.throughputQps.median),
      })),
    );
    console.log("Execute prebuilt query (fixed bindings, no named server prepare):");
    console.table(
      steady.results.map((r) => ({
        scenario: r.scenario,
        provider: r.provider,
        medianMs: +r.prebuiltLatencyMs.median.toFixed(3),
        p95Ms: +r.prebuiltLatencyMs.p95.toFixed(3),
        qpsAt4: Math.round(r.prebuiltThroughputQps.median),
        pairedDeltaUs: +r.roundLatencyDeltaUs.median.toFixed(2),
      })),
    );
    const startups: {
      provider: Kind;
      cache: string;
      trial: number;
      wallMs: number;
      data: Record<string, unknown>;
    }[] = [];
    for (let trial = 0; trial < startupTrials; trial++) {
      console.log(
        `Measuring ${runtime} startup ${trial + 1}/${startupTrials} (fresh and cached projects)...`,
      );
      for (const kind of rotate(kinds, trial)) {
        const dir = resolve(directory, `${runtime}-${kind}-${trial}`);
        await fixture(dir, schema);
        for (const cache of ["fresh-project", "cached-project"]) {
          const measured = await child(
            runtime,
            kind,
            dir,
            resolve(directory, `${runtime}-${kind}-${trial}-${cache}.json`),
          );
          if (kind === "reylo" || kind === "inline") {
            if (
              measured.cacheEntriesAfter < 4 ||
              (cache === "fresh-project"
                ? measured.cacheEntriesBefore !== 0
                : measured.cacheEntriesBefore < 4)
            )
              throw Error("Startup cache isolation failed");
          }
          startups.push({ provider: kind, cache, trial, ...measured });
        }
      }
    }
    const startupSummary = (skipStartup ? [] : kinds).flatMap((provider) =>
      ["fresh-project", "cached-project"].map((cache) => ({
        provider,
        cache,
        wallMs: stats(
          startups.filter((r) => r.provider === provider && r.cache === cache).map((r) => r.wallMs),
        ),
      })),
    );
    if (!skipStartup)
      console.table(
        startupSummary.map((r) => ({
          provider: r.provider,
          cache: r.cache,
          medianWallMs: +r.wallMs.median.toFixed(1),
          min: +r.wallMs.min.toFixed(1),
          max: +r.wallMs.max.toFixed(1),
        })),
      );
    report.runs.push({ runtime, steady: result.data, startups, startupSummary });
    await writeFile(resolve(directory, "results.json"), JSON.stringify(report, null, 2));
  }
  await writeFile(resolve(root, "work/comparison/latest.json"), JSON.stringify(report, null, 2));
  console.log(`Full samples, SQL, plans, and methodology: ${resolve(directory, "results.json")}`);
} finally {
  try {
    if (created) await db.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    await db.end();
  }
}
