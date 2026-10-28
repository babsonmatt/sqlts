import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CallPreviewService } from "../src/call-preview.ts";
import { position } from "../src/preview.ts";

type Flag = boolean | null | undefined;
const conditions: { source: string; evaluate: (a: Flag, b: boolean) => unknown }[] = [
  { source: "a", evaluate: (a) => a },
  { source: "!a", evaluate: (a) => !a },
  { source: "a && b", evaluate: (a, b) => a && b },
  { source: "a || b", evaluate: (a, b) => a || b },
  { source: "!(a && b)", evaluate: (a, b) => !(a && b) },
  { source: "a === true", evaluate: (a) => a === true },
  { source: "a !== false", evaluate: (a) => a !== false },
  { source: "a ?? b", evaluate: (a, b) => a ?? b },
  { source: "(a ?? false) === false", evaluate: (a) => (a ?? false) === false },
  { source: "a === undefined", evaluate: (a) => a === undefined },
  { source: "a !== undefined", evaluate: (a) => a !== undefined },
  { source: "a == null", evaluate: (a) => a == null },
  { source: "(a ?? b) !== false", evaluate: (a, b) => (a ?? b) !== false },
  { source: "!(a ?? b)", evaluate: (a, b) => !(a ?? b) },
];
const literal = (v: Flag) => (v === undefined ? "undefined" : JSON.stringify(v));
const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

test("direct/shared conditional truth tables and dependent defaults agree with checked types and runtime", async () => {
  const dir = await mkdtemp(resolve("work/sqlts-truth-tables-"));
  const callCases: {
    name: string;
    args: string;
    filtered: boolean;
    precise: boolean;
    preview: boolean;
  }[] = [];
  const functions: string[] = [],
    helpers: string[] = [];
  for (const [i, c] of conditions.entries()) {
    helpers.push(
      `export function gate${i}(a:boolean|null|undefined,b:boolean){return sql.fragment\`\${(${c.source}) ? sql.fragment\`email IS NOT NULL\` : sql.empty}\`;}`,
    );
    for (const form of ["direct", "shared"]) {
      const name = `${form}${i}`;
      const predicate =
        form === "direct" ? `(${c.source}) && sql\`email IS NOT NULL\`` : `gate${i}(a,b)`;
      functions.push(
        `export function ${name}(a:boolean|null|undefined,b:boolean){return sql\`SELECT id,email FROM reylo_inline_demo.users \${sql.where(${predicate})} ORDER BY id\`;}`,
      );
      for (const a of [true, false, null, undefined])
        for (const b of [true, false])
          callCases.push({
            name,
            args: `${literal(a)},${b}`,
            filtered: !!c.evaluate(a, b),
            precise: true,
            preview: true,
          });
    }
  }
  functions.push(
    "export function defaults(a=false,b:boolean=a,c:boolean=b){return sql`SELECT id,email FROM reylo_inline_demo.users ${sql.where(c && sql`email IS NOT NULL`)} ORDER BY id`;}",
  );
  functions.push("export function wrapper(a=false,b:boolean=a){return defaults(a,b,b);}");
  functions.push(
    "export function sharedDefaults(a=false,b:boolean=a){return sql`SELECT id,email FROM reylo_inline_demo.users ${sql.where(defaultGate(a,b))} ORDER BY id`;}",
  );
  helpers.push(
    "export function defaultGate(a=false,b:boolean=a,c:boolean=b){return sql.fragment`${c ? sql.fragment`email IS NOT NULL` : sql.empty}`;}",
  );
  for (const name of ["defaults", "wrapper", "sharedDefaults"])
    for (const [args, filtered] of [
      ["", false],
      ["true", true],
      ["true,undefined", true],
      ["false,true", true],
      ["true,false", false],
    ] as const)
      callCases.push({ name, args, filtered, precise: true, preview: true });
  // Keep logical *values* distinct from their truthiness; NaN must stay possible for number.
  const edgeFunctions = `
export function logicalValue(a:number){return sql\`SELECT id,email FROM reylo_inline_demo.users \${sql.where(((a && 1) === 0) && sql\`email IS NOT NULL\`)} ORDER BY id\`;}
export function coalescedNumber(a:number|null){return sql\`SELECT id,email FROM reylo_inline_demo.users \${sql.where((a ?? 0) && sql\`email IS NOT NULL\`)} ORDER BY id\`;}
export function shadowedUndefined(undefined:boolean,a:boolean){return sql\`SELECT id,email FROM reylo_inline_demo.users \${sql.where((a === undefined) && sql\`email IS NOT NULL\`)} ORDER BY id\`;}
export function defaultWrite(a=false,b:boolean=(a=false)){return sql\`SELECT id,email FROM reylo_inline_demo.users \${sql.where(a && sql\`email IS NOT NULL\`)} ORDER BY id\`;}
export function unannotated(a=false,b=a){return sql\`SELECT id,email FROM reylo_inline_demo.users \${sql.where(b && sql\`email IS NOT NULL\`)} ORDER BY id\`;}
`;
  callCases.push(
    { name: "logicalValue", args: "NaN", filtered: false, precise: false, preview: false },
    { name: "logicalValue", args: "0", filtered: true, precise: false, preview: true },
    { name: "logicalValue", args: "1", filtered: false, precise: false, preview: true },
    { name: "coalescedNumber", args: "NaN", filtered: false, precise: false, preview: false },
    { name: "coalescedNumber", args: "0", filtered: false, precise: true, preview: true },
    { name: "coalescedNumber", args: "1", filtered: true, precise: true, preview: true },
    { name: "coalescedNumber", args: "null", filtered: false, precise: true, preview: true },
    {
      name: "shadowedUndefined",
      args: "true,false",
      filtered: false,
      precise: false,
      preview: true,
    },
    {
      name: "shadowedUndefined",
      args: "false,false",
      filtered: true,
      precise: false,
      preview: true,
    },
    { name: "defaultWrite", args: "true", filtered: false, precise: false, preview: false },
    { name: "unannotated", args: "true", filtered: true, precise: false, preview: true },
  );
  const sharedNames = [...conditions.map((_, i) => `gate${i}`), "defaultGate"];
  const queryFile = resolve(dir, "queries.sqlts"),
    callerFile = resolve(dir, "caller.ts");
  await writeFile(
    resolve(dir, "helpers.sqlts"),
    'import {sql} from "reylo-sqlts-experiment";\n' + helpers.join("\n"),
  );
  await writeFile(
    queryFile,
    'import {sql} from "reylo-sqlts-experiment";import {' +
      sharedNames.join(",") +
      '} from "./helpers.sqlts";\n' +
      functions.join("\n"),
  );
  await writeFile(
    resolve(dir, "edges.sqlts"),
    'import {sql} from "reylo-sqlts-experiment";\n' + edgeFunctions,
  );
  const names = new Set(functions.map((f) => /export function (\w+)/.exec(f)![1]));
  const invoke = (c: (typeof callCases)[number]) =>
    `${names.has(c.name) ? "q" : "edge"}.${c.name}(${c.args})`;
  const imports = 'import * as q from "./queries.sqlts";import * as edge from "./edges.sqlts";';
  await writeFile(
    callerFile,
    imports +
      'import type {PostgresClient} from "reylo";export async function check(db:PostgresClient){\n' +
      callCases
        .map(
          (c, i) =>
            `${c.filtered && c.precise ? "" : "// @ts-expect-error nullable or unproven result must stay broad\n"}const email${i}:string|undefined=(await ${invoke(c)}.run(db))[0]?.email;`,
        )
        .join("\n") +
      "\n}",
  );
  const config = resolve(dir, "tsconfig.json");
  await writeFile(
    config,
    JSON.stringify({
      compilerOptions: {
        target: "esnext",
        module: "preserve",
        moduleResolution: "bundler",
        types: ["node"],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        noUncheckedIndexedAccess: true,
      },
      contentMappers: [{ package: "reylo-sqlts-experiment", extensions: [".sqlts"] }],
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
  try {
    await run([
      Bun.which("node")!,
      "--env-file=.env",
      "node_modules/typescript/bin/tsc",
      "--runExternalCode",
      "--pretty",
      "false",
      "-p",
      config,
    ]);
    const runner = resolve(dir, "run.ts");
    await writeFile(
      runner,
      imports +
        'import {Pool} from "pg";import {deepEqual} from "node:assert/strict";const db=new Pool({connectionString:process.env.DATABASE_URL});const queries=[' +
        callCases.map(invoke).join(",") +
        "];try{const results=[];for(const query of queries){const compiled=query.compile();const rows=await query.run(db);deepEqual(rows,(await db.query(compiled.text,compiled.values)).rows);results.push({compiled,rows});}console.log(JSON.stringify(results));}finally{await db.end();}",
    );
    let reference: { compiled: { text: string }; rows: { email: string | null }[] }[] | undefined;
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
        compiled: { text: string };
        rows: { email: string | null }[];
      }[];
      if (reference) expect(results).toEqual(reference);
      reference = results;
      for (const [i, c] of callCases.entries()) {
        const result = results[i]!;
        expect(result.rows.length).toBeGreaterThan(0);
        expect(
          result.rows.some((row) => row.email === null),
          `${c.name}(${c.args})`,
        ).toBe(!c.filtered);
        if (command[0] === process.execPath || !c.preview) continue;
        const source = `import {${c.name}} from "./${names.has(c.name) ? "queries" : "edges"}.sqlts";${c.name}(${c.args});`;
        const uri = pathToFileURL(callerFile).href;
        const preview =
          new CallPreviewService().hover(
            uri,
            position(source, source.lastIndexOf(c.name)),
            new Map([[uri, source]]),
          )?.contents.value ?? "";
        expect(preview, c.name).toContain("one path");
        expect(normalize(/```sql\n([\s\S]*?)\n```/.exec(preview)?.[1] ?? ""), c.name).toBe(
          normalize(result.compiled.text.replace(/ \/\*file='[^']*'\*\/$/, "")),
        );
      }
    }
    console.log(
      JSON.stringify({
        conditionalCalls: callCases.length,
        forms: ["direct", "shared", "defaults", "wrappers"],
        runtimes: ["Node", "Bun"],
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 45000);
