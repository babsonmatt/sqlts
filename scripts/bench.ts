import { mkdir, writeFile } from "node:fs/promises";
import { searchUsers } from "../examples/queries.ts";
const rounds = 7,
  iterations = 10_000;
let sink = 0;
function bench(label: string, operation: (i: number) => void) {
  for (let i = 0; i < 2000; i++) operation(i);
  const samples = [];
  for (let r = 0; r < rounds; r++) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) operation(i);
    samples.push(((performance.now() - start) * 1000) / iterations);
  }
  samples.sort((a, b) => a - b);
  return {
    operation: label,
    medianMicroseconds: +samples[3]!.toFixed(3),
    minMicroseconds: +samples[0]!.toFixed(3),
    maxMicroseconds: +samples[6]!.toFixed(3),
  };
}
const existing = searchUsers(10, "Alice", true);
const results = [
  bench("Construct (all predicates)", (i) => {
    sink += searchUsers(10, `person-${i}`, true).compile().values.length;
  }),
  bench("Construct (optional predicates absent)", () => {
    sink += searchUsers(10, undefined, false).compile().values.length;
  }),
  bench("Compile an existing query", () => {
    sink += existing.compile().values.length;
  }),
];
console.table(results);
console.log(
  "Includes compile() and value copying. No database, network, generation, or schema freshness checks. Machine-local microbenchmark; not a throughput guarantee.",
);
await mkdir("work", { recursive: true });
await writeFile(
  "work/runtime-benchmark.json",
  JSON.stringify({ bun: Bun.version, rounds, iterations, results, sink }, null, 2),
);
