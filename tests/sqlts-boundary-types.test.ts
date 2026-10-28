import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { prepare } from "../src/sqlts/transform.ts";

test("all 64 projection combinations narrow independently at the supported shape boundary", async () => {
  const dir = await mkdtemp(resolve("work/sqlts-boundary-")),
    file = resolve(dir, "queries.sqlts");
  const source = (count: number) =>
    'import {sql} from "@sqlts/core";export function project(' +
    Array.from({ length: count }, (_, i) => `f${i}:boolean`).join(",") +
    "){return sql`SELECT " +
    Array.from(
      { length: count },
      (_, i) => "${f" + i + " ? sql`u.id` : sql`u.name`} AS c" + i,
    ).join(",") +
    " FROM reylo_inline_demo.users u ORDER BY u.id`;}";
  const calls = Array.from({ length: 64 }, (_, mask) =>
    Array.from({ length: 6 }, (_, i) => !!(mask & (1 << i))),
  );
  try {
    await writeFile(file, source(6));
    expect(prepare(source(6), file).queries[0]!.variants).toHaveLength(64);
    expect(() => prepare(source(7), file)).toThrow("64 SQL shapes");
    await writeFile(
      resolve(dir, "caller.ts"),
      'import {project} from "./queries.sqlts";import type {PostgresClient} from "reylo";export async function check(db:PostgresClient){\n' +
        calls
          .map(
            (flags, index) =>
              `const row${index}=(await project(${flags.join(",")}).run(db))[0]!;\n` +
              flags
                .map(
                  (flag, column) =>
                    `const value${index}_${column}:${flag ? "number" : "string"}=row${index}.c${column};`,
                )
                .join("\n") +
              `\n// @ts-expect-error selected c0 must not acquire the opposite SQL type\nconst wrong${index}:${flags[0] ? "string" : "number"}=row${index}.c0;`,
          )
          .join("\n") +
        "\n}",
    );
    await writeFile(
      resolve(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "esnext",
          module: "preserve",
          moduleResolution: "bundler",
          skipLibCheck: true,
          allowImportingTsExtensions: true,
          types: ["node"],
        },
        contentMappers: [{ package: "@sqlts/core", extensions: [".sqlts"] }],
        files: ["caller.ts"],
      }),
    );
    const run = async (args: string[]) => {
      const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([
        p.exited,
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
      ]);
      expect(code, out + err).toBe(0);
      return out;
    };
    const start = performance.now();
    await run([
      Bun.which("node")!,
      "--env-file=.env",
      "node_modules/typescript/bin/tsc",
      "--runExternalCode",
      "-p",
      resolve(dir, "tsconfig.json"),
    ]);
    const checkMs = performance.now() - start;
    const runner = resolve(dir, "run.ts");
    await writeFile(
      runner,
      'import {project} from "./queries.sqlts";import {Pool} from "pg";import {deepEqual,equal,ok} from "node:assert/strict";const db=new Pool({connectionString:process.env.DATABASE_URL});try{for(const flags of ' +
        JSON.stringify(calls) +
        '){const q=project(...flags),c=q.compile(),rows=await q.run(db);ok(rows.length);deepEqual(rows,(await db.query(c.text,c.values)).rows);for(const row of rows)flags.forEach((flag,i)=>equal(typeof row["c"+i],flag?"number":"string"));}console.log("64 combinations verified");}finally{await db.end();}',
    );
    for (const args of [
      [
        Bun.which("node")!,
        "--env-file=.env",
        "--import",
        "@sqlts/core/register",
        runner,
      ],
      [process.execPath, "--preload", "@sqlts/core/register", runner],
    ])
      expect(await run(args)).toContain("64 combinations verified");
    console.log(
      JSON.stringify({
        projectionShapes: 64,
        typedColumnAssertions: 384,
        negativeTypeAssertions: 64,
        checkMs: +checkMs.toFixed(2),
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
