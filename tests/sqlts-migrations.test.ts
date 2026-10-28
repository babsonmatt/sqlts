import { expect, test } from "bun:test";
import { demoMigrations } from "../scripts/migrations/demo.ts";
test("dbmate migrations refresh unchanged SQLTS types, diagnostics and completion", async () => {
  const report = await demoMigrations();
  expect(report.facts).toHaveLength(6);
  expect(report.generatedQueryFiles).toBe(false);
}, 60000);

import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { refreshSchema, schemaSignal, schemaRevision } from "../src/sqlts/schema-refresh.ts";
test("schema refresh shares a signal across nested configs but isolates package roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "sqlts-schema-signal-"));
  try {
    await writeFile(join(root, "package.json"), "{}");
    await mkdir(join(root, "nested"));
    expect(schemaSignal(join(root, "nested"))).toBe(schemaSignal(root));
    expect(schemaRevision(schemaSignal(root))).toBe("");
    const file = refreshSchema(join(root, "nested"));
    const first = await readFile(file, "utf8");
    expect(first).toMatch(/^[a-f0-9-]{36}\n$/);
    refreshSchema(root);
    expect(schemaRevision(file)).not.toBe(first);
    await writeFile(join(root, "nested/package.json"), "{}");
    expect(schemaSignal(join(root, "nested"))).not.toBe(file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
