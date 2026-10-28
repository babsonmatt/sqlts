import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rename, rm, stat, utimes } from "node:fs/promises";
import { resolve } from "node:path";
import { stressFixture } from "../scripts/sqlts-stress-fixture.ts";
import { prepare } from "../src/sqlts/transform.ts";
import {
  prepareCached,
  clearPreparationCache,
  preparationStats,
} from "../src/sqlts/prepared-cache.ts";

test("48-consumer diamond graph reuses warm preparation and invalidates only affected saved content", async () => {
  const dir = await mkdtemp(resolve("work/sqlts-graph-"));
  clearPreparationCache();
  try {
    const f = await stressFixture(dir);
    for (const file of f.files) prepareCached(file.source, file.file);
    const first = preparationStats();
    for (const file of f.files) prepareCached(file.source, file.file);
    const warm = preparationStats();
    expect(warm.hits - first.hits).toBe(48);
    expect(warm.misses - first.misses).toBe(0);
    const check = async () => {
      const p = Bun.spawn(
        [
          Bun.which("node")!,
          "--env-file=.env",
          "node_modules/typescript/bin/tsc",
          "--runExternalCode",
          "--pretty",
          "false",
          "-p",
          f.config,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [code, out, err] = await Promise.all([
        p.exited,
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
      ]);
      return { code, text: out + err };
    };
    const good = await check();
    expect(good.code, good.text).toBe(0);
    const stamp = await stat(f.leaves[0]!);
    const changed = f.leafSource.replace("u.email IS", "u.name  IS");
    expect(changed.length).toBe(f.leafSource.length);
    await writeFile(f.leaves[0]! + ".tmp", changed);
    await rename(f.leaves[0]! + ".tmp", f.leaves[0]!);
    await utimes(f.leaves[0]!, stamp.atime, stamp.mtime);
    for (const file of f.files) prepareCached(file.source, file.file);
    const edited = preparationStats();
    expect(edited.hits - warm.hits).toBe(36);
    expect(edited.misses - warm.misses).toBe(12);
    const invalid = await check();
    expect(invalid.code).not.toBe(0);
    expect(invalid.text).toContain("null");
    await writeFile(f.leaves[0]!, f.leafSource);
    const restored = await check();
    expect(restored.code, restored.text).toBe(0);
    expect(edited.characters).toBeLessThanOrEqual(2_000_000);
    expect(edited.estimatedBytes).toBeLessThanOrEqual(16_000_000);
  } finally {
    clearPreparationCache();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

test("expanded SQL/source maps affect cache eviction and oversized mappings fail before allocation", async () => {
  const dir = await mkdtemp(resolve("work/sqlts-map-budget-"));
  clearPreparationCache();
  const source = (padding: number) =>
    'import {sql} from "@sqlts/core";export function q(' +
    Array.from({ length: 6 }, (_, i) => `f${i}:boolean`).join(",") +
    "){return sql`SELECT id FROM users /*" +
    "x".repeat(padding) +
    "*/ ${sql.where(" +
    Array.from({ length: 6 }, (_, i) => `f${i}&&sql\`id>${i}\``).join(",") +
    ")}`;}";
  try {
    for (let i = 0; i < 3; i++) prepareCached(source(22000), resolve(dir, `query${i}.sqlts`));
    const stats = preparationStats();
    expect(stats.entries).toBeLessThan(3);
    expect(stats.evictions).toBeGreaterThan(0);
    expect(stats.estimatedBytes).toBeLessThanOrEqual(16_000_000);
    expect(() => prepare(source(40000), resolve(dir, "too-large.sqlts"))).toThrow(
      "SQL source-map budget exceeded",
    );
  } finally {
    clearPreparationCache();
    await rm(dir, { recursive: true, force: true });
  }
});

test("recursive and excessively wide helper graphs fail explicitly", async () => {
  const dir = await mkdtemp(resolve("work/sqlts-graph-limits-"));
  try {
    await writeFile(
      resolve(dir, "cycle.sqlts"),
      'import {sql} from "@sqlts/core";export function gate(a:boolean){return a?sql.fragment`TRUE`:gate(a);}',
    );
    const source =
      'import {sql} from "@sqlts/core";import {gate} from "./cycle.sqlts";export const q=(a:boolean)=>sql`SELECT 1 ${sql.where(gate(a))}`;';
    expect(() => prepare(source, resolve(dir, "query.sqlts"))).toThrow("Recursive fragment");
    for (let i = 0; i < 64; i++)
      await writeFile(
        resolve(dir, `leaf${i}.sqlts`),
        'import {sql} from "@sqlts/core";export const piece=sql.fragment`TRUE`;',
      );
    const wide =
      'import {sql} from "@sqlts/core";' +
      Array.from({ length: 64 }, (_, i) => `import {piece as p${i}} from "./leaf${i}.sqlts";`).join(
        "\n",
      ) +
      "export const q=sql`SELECT 1 ${sql.where(" +
      Array.from({ length: 64 }, (_, i) => `p${i}`).join(",") +
      ")}`;";
    expect(() => prepare(wide, resolve(dir, "wide.sqlts"))).toThrow("64 source files");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
