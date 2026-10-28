import { Pool } from "pg";
import { deepStrictEqual, ok } from "node:assert";
import { writeFile } from "node:fs/promises";
import { provider, type Provider, type Built } from "./providers.ts";
import { kinds, rotate, scenarios, stats, type Kind, type Row, type Compiled } from "./shared.ts";
const [mode, directory, schema, output] = process.argv.slice(2);
if (!directory || !schema || !output)
  throw Error("Expected mode, fixture directory, schema, output");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 4,
  application_name: "reylo-comparison",
});
let sink = 0;
try {
  if (mode !== "steady") {
    if (!kinds.includes(mode as Kind)) throw Error("Unknown provider");
    const start = performance.now();
    const impl = await provider(mode as Kind, pool, directory, schema);
    const loaded = performance.now();
    const rows = await impl.build(scenarios[0]!.options).run();
    ok(rows.length === 20);
    await writeFile(
      output,
      JSON.stringify({
        importAndAnalysisMs: loaded - start,
        firstQueryMs: performance.now() - loaded,
        rows: rows.length,
      }),
    );
  } else {
    const rounds = Number(process.env.BENCH_ROUNDS ?? 8);
    const iterations = Number(process.env.BENCH_ITERATIONS ?? 100);
    const builds = Number(process.env.BENCH_BUILDS ?? 5000);
    for (const n of [rounds, iterations, builds])
      if (!Number.isSafeInteger(n) || n < 1 || n > 100_000)
        throw Error("Invalid benchmark sample count");
    const providers = new Map<Kind, Provider>();
    for (const kind of kinds) providers.set(kind, await provider(kind, pool, directory, schema));
    // Establish all four connections before any timed request.
    const clients = await Promise.all(Array.from({ length: 4 }, () => pool.connect()));
    for (const c of clients) {
      await c.query("SELECT 1");
      c.release();
    }
    // Audit driver calls outside timing. A Proxy leaves the real pool untouched.
    let calls: string[] = [];
    const query = new Proxy(pool.query.bind(pool), {
      apply(target, _receiver, args: unknown[]) {
        const first = args[0];
        if (typeof first === "object" && first !== null && "name" in first)
          ok(!first.name, "Named server-prepared statements would change this comparison");
        calls.push(
          typeof first === "string"
            ? first
            : typeof first === "object" && first !== null && "text" in first
              ? String(first.text)
              : "unknown",
        );
        return Reflect.apply(target, pool, args);
      },
    });
    const observed = new Proxy(pool, {
      get(target, key, receiver) {
        return key === "query" ? query : Reflect.get(target, key, receiver);
      },
    });
    const driverAudit = [];
    for (const kind of kinds) {
      const impl = await provider(kind, observed, directory, schema);
      await impl.build(scenarios[0]!.options).run();
      calls = [];
      for (let i = 0; i < 3; i++) await impl.build(scenarios[0]!.options).run();
      const freshBuildCalls = [...calls];
      const reused = impl.prebuild?.(scenarios[0]!.options) ?? impl.build(scenarios[0]!.options);
      await reused.run();
      calls = [];
      for (let i = 0; i < 3; i++) await reused.run();
      driverAudit.push({ provider: kind, executions: 3, freshBuildCalls, reusedCalls: [...calls] });
    }
    const verification = [];
    const results = [];
    for (const scenario of scenarios) {
      const prebuilt = new Map<Kind, Built>();
      let expected: Row[] | undefined, plan: unknown, parameters: unknown[] | undefined;
      for (const kind of kinds) {
        const q = providers.get(kind)!.build(scenario.options),
          compiled = q.compile();
        if (parameters) deepStrictEqual(compiled.values, parameters);
        else parameters = compiled.values;
        const impl = providers.get(kind)!;
        const reused = impl.prebuild?.(scenario.options) ?? impl.build(scenario.options);
        prebuilt.set(kind, reused);
        deepStrictEqual(reused.compile(), compiled);
        const rows = await q.run();
        deepStrictEqual(await reused.run(), rows);
        ok(rows.length === scenario.rows, `${scenario.name}: unexpected row count`);
        if (expected) deepStrictEqual(rows, expected);
        else expected = rows;
        const explained = await pool.query(
          `EXPLAIN (FORMAT JSON, COSTS OFF) ${compiled.text}`,
          compiled.values,
        );
        const thisPlan: unknown = explained.rows[0]["QUERY PLAN"][0].Plan;
        if (plan) deepStrictEqual(thisPlan, plan, "Different PostgreSQL plans");
        else plan = thisPlan;
        verification.push({
          scenario: scenario.name,
          provider: kind,
          compiled,
          plan: thisPlan,
          rows: rows.length,
        });
      }
      // Validate the omitted and present branches, and SQL-looking input, outside timing.
      for (const search of [undefined, "", "User 1%", "' OR TRUE; --"])
        for (const email of [false, true]) {
          const options = { ...scenario.options, search, email };
          const reference = await providers.get("pg")!.build(options).run();
          for (const kind of kinds.slice(1)) {
            const impl = providers.get(kind)!;
            deepStrictEqual(await impl.build(options).run(), reference);
            deepStrictEqual(
              await (impl.prebuild?.(options) ?? impl.build(options)).run(),
              reference,
            );
          }
        }
      for (const kind of kinds) {
        const impl = providers.get(kind)!;
        for (let i = 0; i < 1000; i++) sink += impl.build(scenario.options).compile().values.length;
        for (let i = 0; i < 30; i++) {
          sink += (await impl.build(scenario.options).run()).length;
          sink += (await prebuilt.get(kind)!.run()).length;
        }
      }
      // Keep compiled objects observable; do not let a JIT reduce the benchmark
      // to reading a constant parameter-count. Vary inputs without changing shapes.
      const inputs = Array.from({ length: 64 }, (_, i) => ({
        ...scenario.options,
        org: i % 2 ? 10 : 20,
      }));
      const retained: Compiled[] = [];
      const records = Object.fromEntries(
        kinds.map((kind) => [
          kind,
          {
            construct: [] as number[],
            latency: [] as number[],
            throughput: [] as number[],
            prebuiltLatency: [] as number[],
            prebuiltThroughput: [] as number[],
            roundLatencyDeltaUs: [] as number[],
          },
        ]),
      ) as Record<
        Kind,
        {
          construct: number[];
          latency: number[];
          throughput: number[];
          prebuiltLatency: number[];
          prebuiltThroughput: number[];
          roundLatencyDeltaUs: number[];
        }
      >;
      for (let round = 0; round < rounds; round++) {
        for (const kind of rotate(kinds, round)) {
          const impl = providers.get(kind)!,
            record = records[kind];
          let start = performance.now();
          for (let i = 0; i < builds; i++) retained[i & 63] = impl.build(inputs[i & 63]!).compile();
          record.construct.push(((performance.now() - start) * 1000) / builds);
          for (const compiled of retained)
            sink += compiled.text.length + Number(compiled.values[0]);
          const roundMedians = { build: 0, prebuilt: 0 };
          // Alternate the mode measured first; each provider sees both orders equally.
          for (const mode of rotate(["build", "prebuilt"] as const, round + kinds.indexOf(kind))) {
            const latencies = mode === "build" ? record.latency : record.prebuiltLatency;
            const throughput = mode === "build" ? record.throughput : record.prebuiltThroughput;
            const reused = prebuilt.get(kind)!;
            const run =
              mode === "build" ? () => impl.build(scenario.options).run() : () => reused.run();
            const local: number[] = [];
            for (let i = 0; i < iterations; i++) {
              start = performance.now();
              sink += (await run()).length;
              const elapsed = performance.now() - start;
              latencies.push(elapsed);
              local.push(elapsed);
            }
            roundMedians[mode] = stats(local).median;
            // Four workers use identical execution behavior for the selected mode.
            start = performance.now();
            await Promise.all(
              Array.from({ length: 4 }, async () => {
                for (let i = 0; i < iterations; i++) sink += (await run()).length;
              }),
            );
            throughput.push((4 * iterations * 1000) / (performance.now() - start));
          }
          // Signed differences are observations, not exact profiler attribution.
          record.roundLatencyDeltaUs.push((roundMedians.build - roundMedians.prebuilt) * 1000);
        }
      }
      for (const kind of kinds) {
        const r = records[kind];
        results.push({
          scenario: scenario.name,
          provider: kind,
          constructionUs: stats(r.construct),
          latencyMs: stats(r.latency),
          throughputQps: stats(r.throughput),
          prebuiltLatencyMs: stats(r.prebuiltLatency),
          prebuiltThroughputQps: stats(r.prebuiltThroughput),
          roundLatencyDeltaUs: stats(r.roundLatencyDeltaUs),
          samples: r,
        });
      }
    }
    await writeFile(
      output,
      JSON.stringify(
        {
          runtime: process.version,
          bun: process.versions.bun,
          rounds,
          iterations,
          builds,
          sink,
          driverAudit,
          verification,
          results,
        },
        null,
        2,
      ),
    );
  }
} finally {
  await pool.end();
}
