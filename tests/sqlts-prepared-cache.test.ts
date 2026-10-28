import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  prepareCached,
  preparationStats,
  clearPreparationCache,
} from "../src/sqlts/prepared-cache.ts";
import { analyze, tooling } from "../src/sqlts/analyze.ts";
import { analysisStats, resetAnalysisStats } from "../src/adapter/reylo.ts";

test("preparation reuse tracks transitive helper contents, errors and unrelated modules", async () => {
  const dir = await mkdtemp(resolve("work/prepared-cache-"));
  clearPreparationCache();
  const leaf = resolve(dir, "leaf.sqlts"),
    mid = resolve(dir, "mid.sqlts");
  const query =
    'import {sql} from "@sqlts/core";import {columns} from "./mid.sqlts";export const q=()=>sql`SELECT ${columns()} FROM reylo_inline_demo.users`;';
  const unrelated =
    'import {sql} from "@sqlts/core";export const q=()=>sql`SELECT id FROM reylo_inline_demo.users`;';
  try {
    await writeFile(
      leaf,
      'import {sql} from "@sqlts/core";export const columns=()=>sql.fragment`id,email`;',
    );
    await writeFile(
      mid,
      'import {columns as inner} from "./leaf.sqlts";export const columns=()=>inner();',
    );
    const a = prepareCached(query, resolve(dir, "query.sqlts")),
      b = prepareCached(unrelated, resolve(dir, "other.sqlts"));
    expect(prepareCached(query, resolve(dir, "query.sqlts"))).toBe(a);
    await writeFile(
      leaf,
      'import {sql} from "@sqlts/core";export const columns=()=>sql.fragment`id,name`;',
    );
    expect(prepareCached(query, resolve(dir, "query.sqlts"))).not.toBe(a);
    expect(prepareCached(unrelated, resolve(dir, "other.sqlts"))).toBe(b);
    await rm(leaf);
    expect(() => prepareCached(query, resolve(dir, "query.sqlts"))).toThrow();
    await writeFile(
      leaf,
      'import {sql} from "@sqlts/core";export const columns=()=>sql.fragment`id,email`;',
    );
    expect(prepareCached(query, resolve(dir, "query.sqlts")).queries).toEqual(a.queries);
    expect(prepareCached(unrelated + "\n", resolve(dir, "other.sqlts"))).not.toBe(b);
    for (let i = 0; i < 140; i++) prepareCached(unrelated, resolve(dir, `extra${i}.sqlts`));
    expect(preparationStats().entries).toBeLessThanOrEqual(128);
    expect(preparationStats().evictions).toBeGreaterThan(0);
  } finally {
    clearPreparationCache();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a preparation cache hit still validates SQL/schema and preserves emitted types/runtime", async () => {
  const dir = await mkdtemp(resolve("work/prepared-analysis-")),
    handlers = tooling.mapperHandlers(),
    projectHandle = crypto.randomUUID();
  const config = resolve(dir, "tsconfig.json"),
    file = resolve(dir, "query.sqlts"),
    content =
      'import {sql} from "@sqlts/core";export const q=()=>sql`SELECT id,email FROM reylo_inline_demo.users`;';
  await writeFile(config, JSON.stringify({ compilerOptions: { strict: true } }));
  clearPreparationCache();
  resetAnalysisStats();
  try {
    await handlers.openProject({ projectHandle, configFileName: config });
    const first = await analyze({ projectHandle, fileName: file, content }, handlers),
      before = analysisStats();
    const second = await analyze({ projectHandle, fileName: file, content }, handlers),
      after = analysisStats();
    expect(second).toEqual(first);
    expect(preparationStats().hits).toBe(1);
    expect(after.validated).toBeGreaterThan(before.validated);
    expect(after.transformed).toBe(before.transformed);
    const uncached = await analyze({ projectHandle, fileName: file, content }, handlers, {
      reusePreparation: false,
    });
    expect(uncached).toEqual(second);
  } finally {
    await handlers.closeProject({ projectHandle });
    await tooling.releaseConnections();
    clearPreparationCache();
    await rm(dir, { recursive: true, force: true });
  }
});
