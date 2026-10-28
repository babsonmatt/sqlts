import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { stressFixture } from "./sqlts-stress-fixture.ts";
import { analyze, tooling } from "../src/sqlts/analyze.ts";
import { preparationStats, clearPreparationCache } from "../src/sqlts/prepared-cache.ts";
import { analysisStats } from "../src/adapter/reylo.ts";
const dir = await mkdtemp(resolve("work/sqlts-stress-bench-"));
const f = await stressFixture(dir),
  handlers = tooling.mapperHandlers(),
  projectHandle = crypto.randomUUID();
const phases: {
  phase: string;
  ms: number;
  hits: number;
  misses: number;
  validated: number;
  transformed: number;
  estimatedBytes: number;
}[] = [];
async function measure(phase: string, reuse = true) {
  const prep = preparationStats(),
    sql = analysisStats(),
    start = performance.now();
  for (const file of f.files)
    await analyze({ projectHandle, fileName: file.file, content: file.source }, handlers, {
      reusePreparation: reuse,
    });
  const after = preparationStats(),
    sqlAfter = analysisStats();
  phases.push({
    phase,
    ms: +(performance.now() - start).toFixed(2),
    hits: after.hits - prep.hits,
    misses: after.misses - prep.misses,
    validated: sqlAfter.validated - sql.validated,
    transformed: sqlAfter.transformed - sql.transformed,
    estimatedBytes: after.estimatedBytes,
  });
}
try {
  await handlers.openProject({ projectHandle, configFileName: f.config });
  clearPreparationCache();
  await measure("first pass");
  // Alternate warm measurements to reduce ordering bias. These are analysis calls,
  // not request execution, a large database catalog, or whole native tsc startup.
  for (let i = 0; i < 5; i++) {
    if (i % 2 === 0) {
      await measure("uncached preparation", false);
      await measure("cached preparation");
    } else {
      await measure("cached preparation");
      await measure("uncached preparation", false);
    }
  }
  await writeFile(f.leaves[0]!, f.leafSource.replace("u.email IS", "u.name  IS"));
  await measure("one shared leaf edited");
  const summary = [...new Set(phases.map((p) => p.phase))].map((phase) => {
    const rows = phases.filter((p) => p.phase === phase),
      sorted = rows.map((r) => r.ms).sort((a, b) => a - b);
    return {
      phase,
      medianMs: sorted[Math.floor(sorted.length / 2)],
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      hits: rows[0]!.hits,
      misses: rows[0]!.misses,
      validated: rows[0]!.validated,
    };
  });
  console.table(summary);
  const report = {
    workload: {
      consumerFiles: 48,
      querySites: 96,
      independentHelperGroups: 4,
      sharedShape: "diamond with four forwarding levels",
      database: "existing four-row demo, read-only analysis",
    },
    summary,
    samples: phases,
    cache: preparationStats(),
    limitations:
      "Not runtime throughput or end-to-end editor latency. Memory weight is an eviction estimate, not measured peak JS heap.",
  };
  const output = resolve("work/sqlts-stress-benchmark.json");
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log("Full results: " + output);
} finally {
  await handlers.closeProject({ projectHandle });
  await tooling.releaseConnections();
  clearPreparationCache();
  await rm(dir, { recursive: true, force: true });
}
