import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepare } from "../src/sqlts/transform.ts";
import { render } from "../src/parts.ts";
import { position } from "../src/preview.ts";
import { client } from "./lsp-client.ts";

await mkdir("work", { recursive: true });
const dir = await mkdtemp(resolve("work/sqlts-nested-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
const file = resolve(dir, "queries.sqlts");
const explicit = `export function explicit(orgId: number, search?: string, minId?: number, email = false) {
  return sql\`SELECT u.id, u.name, u.email FROM reylo_inline_demo.users u
    \${sql.where(
      sql.fragment\`u.org_id = \${orgId}\`,
      search && sql.or(sql.fragment\`u.name ILIKE \${search}\`, sql.fragment\`u.email ILIKE \${search}\`),
      minId != null && sql.fragment\`u.id >= \${minId}\`,
      email && sql.fragment\`u.email IS NOT NULL\`
    )} ORDER BY u.id\`;
}`;
const concise = explicit
  .replace("function explicit", "function concise")
  .replaceAll("sql.fragment`", "sql`");
const source =
  'import {sql} from "reylo-sqlts-experiment";\n// 🌍\n' +
  explicit +
  "\n" +
  concise +
  `
export function scalar(value: number) { return sql\`SELECT (\${sql\`SELECT \${value}::int\`}) AS answer\`; }
export function mixed(orgId: number, enabled: boolean) { return sql\`SELECT \${sql.fragment\`\${sql\`id\`}\`} FROM reylo_inline_demo.users WHERE org_id = \${orgId} \${enabled ? (sql\`AND email IS NOT NULL\`) : sql.empty} ORDER BY id\`; }
`;
const consumer = `import type {PostgresClient} from "reylo";
import {concise, scalar} from "./queries.sqlts";
export async function consume(db: PostgresClient) {
  const rows = await concise(10, undefined, 0, true).run(db);
  const userId = rows[0]?.id;
  return {rows, userId};
}
type Equal<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2) ? true:false;
type Assert<T extends true> = T;
type Row = Awaited<ReturnType<ReturnType<typeof concise>["run"]>>[number];
export type IdType = Assert<Equal<Row["id"], number>>;
export type EmailType = Assert<Equal<Row["email"], string | null>>;
export type ScalarType = Assert<Equal<Awaited<ReturnType<ReturnType<typeof scalar>["run"]>>[number]["answer"], number>>;
`;
async function run(command: string[]) {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: out + err };
}
const check = () =>
  run([
    Bun.which("node")!,
    "--env-file=.env",
    "node_modules/typescript/bin/tsc",
    "--noEmit",
    "--runExternalCode",
    "--pretty",
    "false",
    "-p",
    resolve(dir, "tsconfig.json"),
  ]);

test("nested sql tags match explicit fragment shapes and only outer queries receive identities", () => {
  const p = prepare(source, file);
  expect(p.queries).toHaveLength(4);
  expect(p.sites).toHaveLength(4);
  const sql = (index: number) => p.queries[index]!.variants.map((parts) => render(parts));
  expect(sql(1)).toEqual(sql(0));
  expect(sql(2)[0]!.named).toBe("SELECT (SELECT :p0::int) AS answer");
  expect(sql(3).some((v) => v.named.includes("AND email IS NOT NULL"))).toBe(true);
  const aliased = source
    .replace("import {sql}", "import {sql as q}")
    .replace(/\bsql(?=[.`(])/g, "q");
  expect(
    prepare(aliased, file).queries.map((q) => q.variants.map((parts) => render(parts).named)),
  ).toEqual(p.queries.map((q) => q.variants.map((parts) => render(parts).named)));
});

test("fragment inference recognizes helper arguments but not unrelated tags, callbacks or shadowed imports", () => {
  const preamble = 'import {sql} from "reylo-sqlts-experiment";';
  expect(
    prepare(
      preamble + "const f = sql.where(sql`id = ${1}`, ok ? sql`name = ${name}` : sql.empty);",
      file,
    ).sites,
  ).toHaveLength(0);
  expect(
    prepare(preamble + "function f(sql: unknown){ return sql`not our tag`; }", file).queries,
  ).toEqual([]);
  for (const body of [
    "sql`SELECT ${(() => sql`SELECT 1`)()}`;",
    "sql`SELECT ${wrap(sql`SELECT 1`)}`;",
    "other`value ${sql`SELECT 1`}`;",
  ])
    expect(() => prepare(preamble + body, file)).toThrow("composed directly");
  // Bare && in a query remains unsupported: false there is a bound value, not omission.
  expect(() =>
    prepare(preamble + "sql`SELECT id FROM users ${ok && sql`WHERE id = 1`}`;", file),
  ).toThrow("inside sql.where");
});

test("nested shorthand has checked parameters/results, mapped SQL errors, and identical Node/Bun execution", async () => {
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
        noUncheckedIndexedAccess: true,
        types: ["node"],
      },
      contentMappers: [{ package: "reylo-sqlts-experiment", extensions: [".sqlts"] }],
      files: ["queries.sqlts", "consumer.ts"],
    }),
  );
  await writeFile(file, source);
  await writeFile(resolve(dir, "consumer.ts"), consumer);
  let result = await check();
  expect(result.code, result.output).toBe(0);
  const badSql = source.replace("email && sql`u.email", "email && sql`u.id2");
  await writeFile(file, badSql);
  result = await check();
  const at = position(badSql, badSql.indexOf("id2"));
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("column u.id2 does not exist");
  expect(result.output).toContain(`queries.sqlts(${at.line + 1},${at.character + 1})`);
  await writeFile(file, source.replace("sql`u.id >= ${minId}`", 'sql`u.id >= ${"bad"}`'));
  result = await check();
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("invalidSqlParameters");
  await writeFile(file, source);
  await writeFile(
    resolve(dir, "consumer.ts"),
    consumer.replace("rows[0]?.id", "rows[0]?.nonexistent"),
  );
  result = await check();
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("nonexistent");
  await writeFile(resolve(dir, "consumer.ts"), consumer);
  expect((await check()).code).toBe(0);
  const runner = resolve(dir, "run.ts");
  await writeFile(
    runner,
    `import {Pool} from "pg";
import {deepEqual, equal} from "node:assert/strict";
import {explicit,concise,scalar,mixed} from "./queries.sqlts";
const db = new Pool({connectionString:process.env.DATABASE_URL});
try {
  for (const org of [10,20]) for (const search of [undefined, "", "%Alice%", "%team%", "' OR TRUE; --"]) for (const min of [undefined,0,3]) for (const email of [false,true]) {
    const a=explicit(org,search,min,email), b=concise(org,search,min,email);
    deepEqual(a.compile(),b.compile());
    deepEqual(await a.run(db),await b.run(db));
  }
  deepEqual((await concise(10, undefined, 0, true).run(db)).map(r=>r.id),[1,3]);
  deepEqual(await concise(10, "' OR TRUE; --").run(db),[]);
  deepEqual((await mixed(10,true).run(db)).map(r=>r.id),[1,3]);
  equal((await scalar(42).run(db))[0].answer,42);
  console.log("nested shorthand matches explicit fragments");
} finally { await db.end(); }
`,
  );
  for (const command of [
    [Bun.which("node")!, "--env-file=.env", "--import", "reylo-sqlts-experiment/register", runner],
    [process.execPath, "--preload", "reylo-sqlts-experiment/register", runner],
  ]) {
    const result = await run(command);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("nested shorthand matches explicit fragments");
  }
}, 20_000);

test("native SQLTS LSP infers shorthand results and previews nested SQL", async () => {
  const lsp = client([Bun.which("node")!, "node_modules/typescript/bin/tsc", "--lsp", "--stdio"], {
    DATABASE_URL: process.env.DATABASE_URL,
  });
  const uri = pathToFileURL(file).href;
  const caller = pathToFileURL(resolve(dir, "consumer.ts")).href;
  try {
    await lsp.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(dir).href,
      initializationOptions: { runExternalCode: true },
      capabilities: { textDocument: { hover: { contentFormat: ["markdown"] } } },
    });
    lsp.notify("initialized", {});
    for (const [documentUri, text] of [
      [uri, source],
      [caller, consumer],
    ])
      lsp.notify("textDocument/didOpen", {
        textDocument: { uri: documentUri, text, languageId: "typescript", version: 1 },
      });
    const hover = await lsp.request("textDocument/hover", {
      textDocument: { uri: caller },
      position: position(consumer, consumer.indexOf("userId =")),
    });
    expect(JSON.stringify(hover)).toContain("number | undefined");
    const at = source.indexOf("return sql`", source.indexOf("function concise")) + 7;
    const preview = await lsp.request("textDocument/hover", {
      textDocument: { uri },
      position: position(source, at),
    });
    expect(JSON.stringify(preview)).toContain("ILIKE");
    expect(JSON.stringify(preview)).toContain("u.org_id");
  } finally {
    await lsp.close();
  }
}, 15_000);
