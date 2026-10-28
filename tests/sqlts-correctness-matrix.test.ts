import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CallPreviewService } from "../src/call-preview.ts";
import { position } from "../src/preview.ts";

type Case = { args: string; filtered: boolean; narrow?: boolean };
const cases: {
  name: string;
  params: string;
  condition: string;
  setup?: string;
  calls: Case[];
  preview?: boolean;
}[] = [
  {
    name: "booleanFlag",
    params: "flag:boolean",
    condition: "flag",
    calls: [
      { args: "true", filtered: true },
      { args: "false", filtered: false },
    ],
  },
  {
    name: "stringFlag",
    params: "search:string",
    condition: "search",
    calls: [
      { args: '""', filtered: false },
      { args: '"hello"', filtered: true },
    ],
  },
  {
    name: "numberFlag",
    params: "count:number",
    condition: "count",
    calls: [
      { args: "0", filtered: false },
      { args: "-1", filtered: true },
      { args: "2", filtered: true },
      { args: "NaN", filtered: false, narrow: false },
    ],
  },
  {
    name: "presence",
    params: "input:string|null|undefined",
    condition: "input != null",
    calls: [
      { args: "null", filtered: false },
      { args: "undefined", filtered: false },
      { args: '""', filtered: true },
    ],
  },
  {
    name: "strictNull",
    params: "input:string|null|undefined",
    condition: "input !== null",
    calls: [
      { args: "null", filtered: false },
      { args: "undefined", filtered: true },
      { args: '""', filtered: true },
    ],
  },
  {
    name: "selector",
    params: 'mode:"email"|"id"',
    condition: 'mode === "email"',
    calls: [
      { args: '"email"', filtered: true },
      { args: '"id"', filtered: false },
    ],
  },
  {
    name: "compound",
    params: 'flag:boolean,mode:"email"|"id",force:boolean',
    condition: '(flag && mode === "email") || force',
    calls: [
      { args: 'true,"email",false', filtered: true },
      { args: 'true,"id",false', filtered: false },
      { args: 'false,"email",true', filtered: true },
    ],
  },
  {
    name: "defaulted",
    params: "flag=true",
    condition: "flag",
    calls: [
      { args: "", filtered: true },
      { args: "undefined", filtered: true },
      { args: "false", filtered: false },
    ],
  },
  {
    name: "alias",
    params: "flag:boolean",
    setup: "const chosen=flag;const twice=chosen;",
    condition: "twice",
    calls: [
      { args: "true", filtered: true },
      { args: "false", filtered: false },
    ],
  },
  {
    name: "dependentDefault",
    params: "a=false,b:boolean=a",
    condition: "b",
    calls: [
      { args: "true", filtered: true },
      { args: "false", filtered: false },
      { args: "false,true", filtered: true },
    ],
  },
  {
    name: "objectWrite",
    params: "flag:boolean",
    setup: "const ignored=(()=>{({flag}={flag:false});})();",
    condition: "flag",
    preview: false,
    calls: [{ args: "true", filtered: false, narrow: false }],
  },
  {
    name: "nestedObjectWrite",
    params: "flag:boolean",
    setup: "const ignored=(()=>{({inner:{flag}}={inner:{flag:false}});})();",
    condition: "flag",
    preview: false,
    calls: [{ args: "true", filtered: false, narrow: false }],
  },
  {
    name: "unannotatedDefault",
    params: "a=false,b=a",
    condition: "b",
    calls: [{ args: "false,true", filtered: true, narrow: false }],
  },
  {
    name: "logicalWrite",
    params: "flag:boolean",
    setup: "const ignored=(flag &&= false);",
    condition: "flag",
    preview: false,
    calls: [{ args: "true", filtered: false, narrow: false }],
  },
];
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

test("conditional matrix checks inferred types and previews against PostgreSQL on Node/Bun", async () => {
  const dir = await mkdtemp(resolve("work/sqlts-matrix-")),
    query = resolve(dir, "queries.sqlts"),
    caller = resolve(dir, "caller.ts");
  const ordinary = cases
    .map(
      (c) =>
        `export function ${c.name}(${c.params}){${c.setup ?? ""}return sql\`SELECT id,email FROM reylo_inline_demo.users \${sql.where((${c.condition}) && sql\`email IS NOT NULL\`)} ORDER BY id\`;}`,
    )
    .join("\n");
  const source =
    'import {sql} from "reylo-sqlts-experiment";import {nested} from "./helpers.sqlts";\n' +
    ordinary +
    `
 export function shared(flag:boolean){return sql\`SELECT id,email FROM reylo_inline_demo.users \${sql.where(nested(flag))} ORDER BY id\`;}
 export function forwarded(flag=true){return shared(flag);}
 export function projection(mode:"id"|"email"){return sql\`SELECT \${mode==="id"?sql\`id\`:sql\`email\`} FROM reylo_inline_demo.users ORDER BY id\`;}
 `;
  const sharedCases = [
    ...cases,
    {
      name: "shared",
      params: "",
      condition: "",
      calls: [
        { args: "true", filtered: true },
        { args: "false", filtered: false },
      ],
    },
    {
      name: "forwarded",
      params: "",
      condition: "",
      calls: [
        { args: "", filtered: true },
        { args: "undefined", filtered: true },
        { args: "false", filtered: false },
      ],
    },
  ];
  const flat = sharedCases.flatMap((c) =>
    c.calls.map((call) => ({ ...call, name: c.name, preview: c.preview !== false })),
  );
  const consumer =
    `import * as q from "./queries.sqlts";import type {PostgresClient} from "reylo";export async function types(db:PostgresClient){\n` +
    flat
      .map(
        (c, i) =>
          `${(c.narrow ?? c.filtered) ? "" : "// @ts-expect-error nullable or unproven outcomes must not narrow\n"}const email${i}:string|undefined=(await q.${c.name}(${c.args}).run(db))[0]?.email;`,
      )
      .join("\n") +
    `
 const selected=(await q.projection("id").run(db))[0];const id:number|undefined=selected?.id;
 // @ts-expect-error selected projection has no email
 selected?.email;
 const other=(await q.projection("email").run(db))[0];const email:string|null|undefined=other?.email;
 // @ts-expect-error selected projection has no id
 other?.id;
 }`;
  await writeFile(query, source);
  await writeFile(
    resolve(dir, "helpers.sqlts"),
    'import {inner} from "./leaf.sqlts";export const nested=(flag:boolean)=>inner(flag);',
  );
  await writeFile(
    resolve(dir, "leaf.sqlts"),
    'import {sql} from "reylo-sqlts-experiment";export function inner(flag=true){const local=flag;return sql.fragment`${local?sql.fragment`email IS NOT NULL`:sql.empty}`;}',
  );
  await writeFile(caller, consumer);

  await writeFile(
    resolve(dir, "tsconfig.json"),
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
      contentMappers: [{ package: "reylo-sqlts-experiment", extensions: [".sqlts"] }],
      files: ["caller.ts"],
    }),
  );
  const run = async (args: string[]) => {
    const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const [code, a, b] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    expect(code, a + b).toBe(0);
    return a;
  };
  try {
    await run([
      Bun.which("node")!,
      "--env-file=.env",
      "node_modules/typescript/bin/tsc",
      "--runExternalCode",
      "--pretty",
      "false",
      "-p",
      resolve(dir, "tsconfig.json"),
    ]);
    const runner = resolve(dir, "run.ts");
    await writeFile(
      runner,
      `import * as q from "./queries.sqlts";import {Pool} from "pg";import {deepEqual} from "node:assert/strict";const db=new Pool({connectionString:process.env.DATABASE_URL});const queries=[${flat.map((c) => `q.${c.name}(${c.args})`).join(",")}];try{const results=[];for(const query of queries){const compiled=query.compile();const rows=await query.run(db);deepEqual(rows,(await db.query(compiled.text,compiled.values)).rows);results.push({compiled,rows});}for(const mode of ["id","email"]){const rows=await q.projection(mode).run(db);deepEqual(Object.keys(rows[0]),[mode]);}console.log(JSON.stringify(results));}finally{await db.end();}`,
    );
    let reference:
      | { compiled: { text: string; values: unknown[] }; rows: { email: string | null }[] }[]
      | undefined;
    for (const command of [
      [
        Bun.which("node")!,
        "--env-file=.env",
        "--import",
        "reylo-sqlts-experiment/register",
        runner,
      ],
      [process.execPath, "--preload", "reylo-sqlts-experiment/register", runner],
    ]) {
      const results = JSON.parse(await run(command)) as {
        compiled: { text: string; values: unknown[] };
        rows: { email: string | null }[];
      }[];
      if (reference) expect(results).toEqual(reference);
      reference = results;
      for (const [i, c] of flat.entries()) {
        const result = results[i]!;
        expect(result.rows.length).toBeGreaterThan(0);
        expect(
          result.rows.some((r) => r.email === null),
          c.name + "(" + c.args + ")",
        ).toBe(!c.filtered);
        if (command[0] === process.execPath) continue;
        const text = `import {${c.name}} from "./queries.sqlts";${c.name}(${c.args});`,
          uri = pathToFileURL(caller).href;
        const preview =
          new CallPreviewService().hover(
            uri,
            position(text, text.lastIndexOf(c.name)),
            new Map([[uri, text]]),
          )?.contents.value ?? "";
        // NaN is a runtime expression in the bounded preview interpreter.
        if (c.args === "NaN") {
          expect(preview).toContain("possible paths");
          continue;
        }
        if (!c.preview) {
          expect(preview).toContain("Mutated parameters remain unresolved");
          continue;
        }
        expect(preview, c.name).toContain("one path");
        expect(normalize(/```sql\n([\s\S]*?)\n```/.exec(preview)?.[1] ?? ""), c.name).toBe(
          normalize(result.compiled.text.replace(/ \/\*file='[^']*'\*\/$/, "")),
        );
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
